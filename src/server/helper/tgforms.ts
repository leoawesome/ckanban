// A ticket's question form (ask_questions) answered from Telegram. Any text a ticket gets closes its form
// (session.ts pendingSince), so the answers are collected first and go in as ONE message, in exactly the board's
// format (web/src/questionForms.ts answersMessage):
// - when an alert names a ticket waiting on a form, one message per question follows it: "(1 of 2) <question>", the
//   options as a numbered list in the text, numbered buttons (up to 8) and "Type my own";
// - single choice: a tap marks it ✓; multi-select: taps toggle ✓, and the last question has "Done, send my answers";
// - "Type my own" asks for a reply (force_reply); the reply is that question's answer, no Send/Cancel echo;
// - once every question has an answer (or Done is tapped), the answers go to the ticket once ("via Telegram");
// - other text for that ticket while the form is half answered: the answers go first, then the text (flushBefore);
// - answered on the board first: the taps are dropped and the messages say "✓ Answered on the Mac <time>" (sync).
// A form is a PendingAction (kind "form", tgstores.ts) kept on disk, so taps survive a restart; its final send takes
// it with the update that finished it, so a send a restart cut off is finished once (Board dedups by update id).
// Form messages and their edits are paced about one a second (TelegramBot.paced, with 429 retry_after).
import { answersMessage, answerText } from "../../../web/src/questionForms";
import type { Question, SessionSummary } from "../session";
import type { Store } from "../store";
import type { Responder, TgButton } from "./tgreply";
import type { LinkItem, PendingAction, PendingActions, TelegramLinks } from "./tgstores";
import { normalizeQuestion, type WaitStore } from "./waits";

/** A form shown on Telegram can be answered this long (then it is answered on the board). */
export const FORM_TTL_MS = 24 * 3600_000;
/** Numbered buttons per question; more options are still listed and can be typed. */
export const MAX_BUTTONS = 8;
/** Tickets per alert whose forms are shown (a summary about many tickets doesn't flood the chat). */
export const FORMS_PER_ALERT = 3;

export const TYPE_OWN = "Type my own";
export const DONE = "Done, send my answers";

interface FormAnswer {
  picked: string[];
  /** Typed with "Type my own" (or a reply to the question). */
  other: string;
}

export interface FormData {
  chatId: number;
  board: string;
  ticketId: string;
  /** The wait record the form answers. */
  key: string;
  /** The form's questions, as asked (answersMessage needs them word for word). */
  questions: Question[];
  answers: FormAnswer[];
  /** Telegram message per question (null: not sent yet). */
  msgs: (number | null)[];
  /** "Type my own" prompts: a reply to one is that question's answer. */
  prompts: { tg: number; q: number }[];
  /** The alert the form follows. */
  alertTg: number | null;
  /** Why it closed: sent from Telegram, answered on the board, closed by other text, or no longer asked. */
  closed?: "sent" | "board" | "typed" | "gone";
}

export interface FormDeps {
  store: Store;
  waits: WaitStore;
  links: TelegramLinks;
  pending: PendingActions;
  session: (sessionId: string) => SessionSummary | null;
  bot: () => string;
  /** The paired chat's responder, paced (null: Telegram off or not paired). */
  out: (chatId: number) => Responder | null;
  chat: () => ((board: string, id: string, text: string, from: { updateId: number; tg: number; chatId: number; key?: string | null; still?: () => boolean }) => Promise<boolean>) | null;
  taking: () => boolean;
  isRunning: (board: string, id: string) => boolean;
  now?: () => number;
}

type Form = PendingAction<FormData> & { used?: string; usedBy?: number };

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const short = (s: string, max: number) => (flat(s).length <= max ? flat(s) : `${flat(s).slice(0, max - 1).trimEnd()}…`);

/** "14:02" in the Mac's time zone. */
export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** n buttons in rows of 3-4: 5 → 3+2, 6 → 3+3, 7 → 4+3, 8 → 4+4. */
export function rowsOf<T>(items: T[]): T[][] {
  if (!items.length) return [];
  const rows = Math.ceil(items.length / 4);
  const per = Math.ceil(items.length / rows);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += per) out.push(items.slice(i, i + per));
  return out;
}

const hasMulti = (d: FormData) => d.questions.some((q) => q.multiSelect);
const answered = (a: FormAnswer) => a.picked.length > 0 || !!a.other.trim();

/** The text of one question's message. */
export function questionText(d: FormData, i: number, head: string): string {
  const q = d.questions[i];
  const n = d.questions.length;
  const last = i === n - 1;
  const pick = q.multiSelect ? (last ? " Pick any, then Done." : " Pick any.") : "";
  const top = i === 0 ? `${head} (1 of ${n})\n\n${q.question}${pick}` : `(${i + 1} of ${n}) ${q.question}${pick}`;
  const opts = q.options.map((o, k) => `${k + 1}. ${o.label}${o.description ? `: ${flat(o.description)}` : ""}${o.recommended ? " (suggested)" : ""}`);
  const other = d.answers[i]?.other.trim();
  return `${top}${opts.length ? `\n${opts.join("\n")}` : ""}${other ? `\n\nYour answer: ${short(other, 500)}` : ""}`;
}

/** The answers in the board's format ("My answers:\n- <question> → <answer>"). */
const boardAnswer = (a: FormAnswer) => ({ picked: a.picked, other: a.other, otherOn: !!a.other.trim() });

export function formMessage(d: FormData): string {
  return answersMessage(d.questions, d.answers.map(boardAnswer));
}

export class TelegramForms {
  private now: () => number;

  constructor(private d: FormDeps) {
    this.now = d.now ?? Date.now;
  }

  /** The form the ticket asks now, if it is the one this wait record is about (open, kind questions). */
  private openForm(board: string, ticketId: string, key?: string): Question[] | null {
    const t = this.d.store.getTicket(board, ticketId);
    // Answered on the board (its reply is on its way, or the ticket works on it): no longer asked.
    if (!t || t.status === "done" || t.status === "in_progress" || this.d.isRunning(board, ticketId)) return null;
    const form = t?.sessionId ? this.d.session(t.sessionId)?.openForm ?? [] : [];
    if (!form.length) return null;
    if (key) {
      const rec = this.d.waits.get(key);
      if (!rec || rec.closedAt || rec.kind !== "questions") return null;
      if (normalizeQuestion(rec.question) !== normalizeQuestion(form.map((q) => q.question).join("\n"))) return null;
    }
    return form;
  }

  private sig = (qs: Question[]) => JSON.stringify(qs.map((q) => [q.question, q.multiSelect, q.options.map((o) => o.label)]));

  /** Open forms (not sent, dropped or expired), newest last. */
  private open(fn: (d: FormData) => boolean): Form[] {
    const now = this.now();
    return (this.d.pending.all<FormData>("form") as Form[])
      .filter((a) => !a.used && Date.parse(a.expiresAt) > now && a.data && fn(a.data))
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  private head(d: FormData): string {
    const t = this.d.store.getTicket(d.board, d.ticketId);
    const board = this.d.store.getProfile(d.board)?.name ?? d.board;
    const n = d.questions.length;
    return `❓ ${board}: "${t?.title ?? d.ticketId}" asks ${n === 1 ? "a question" : `${n} questions`}`;
  }

  /** The buttons of question i: numbers (✓ when picked), Type my own, and Done on the last one of a form with a multi-select. */
  private buttons(a: Form, i: number): TgButton[][] {
    const d = a.data;
    const q = d.questions[i];
    const nums = q.options.slice(0, MAX_BUTTONS).map((o, k) => ({ text: d.answers[i].picked.includes(o.label) ? `${k + 1} ✓` : `${k + 1}`, data: `p:${a.id}:${i}${k}` }));
    const rows = rowsOf(nums);
    rows.push([{ text: TYPE_OWN, data: `p:${a.id}:${i}o` }]);
    if (i === d.questions.length - 1 && hasMulti(d)) rows.push([{ text: DONE, data: `p:${a.id}:d` }]);
    return rows;
  }

  /** An alert went out: forms of the tickets it names (at most FORMS_PER_ALERT) follow it, once per form. */
  async show(items: LinkItem[], alertTg: number, chatId: number): Promise<void> {
    const seen = new Set<string>();
    let shown = 0;
    for (const i of items) {
      if (!i.key || seen.has(`${i.board}/${i.ticketId}`) || shown >= FORMS_PER_ALERT) continue;
      seen.add(`${i.board}/${i.ticketId}`);
      const form = this.openForm(i.board, i.ticketId, i.key);
      if (!form) continue;
      shown++;
      await this.showForm(i.board, i.ticketId, i.key, form, alertTg, chatId);
    }
  }

  private async showForm(board: string, ticketId: string, key: string, questions: Question[], alertTg: number, chatId: number): Promise<void> {
    const out = this.d.out(chatId);
    if (!out) return;
    const sig = this.sig(questions);
    // Shown already (a reminder about the same wait): not again, but messages a restart cut off are sent now.
    let a = this.open((d) => d.chatId === chatId && d.board === board && d.ticketId === ticketId && d.key === key && this.sig(d.questions) === sig).at(-1);
    if (!a) {
      const data: FormData = {
        chatId, board, ticketId, key, questions, alertTg,
        answers: questions.map(() => ({ picked: [], other: "" })), msgs: questions.map(() => null), prompts: [],
      };
      a = this.d.pending.create<FormData>("form", data, FORM_TTL_MS) as Form;
    }
    const head = this.head(a.data);
    for (let i = 0; i < questions.length; i++) {
      if (a.data.msgs[i] !== null) continue;
      const tg = await out.say(questionText(a.data, i, head), {
        replyTo: i === 0 ? alertTg : a.data.msgs[0] ?? alertTg, buttons: this.buttons(a, i), link: [{ board, ticketId, key }], level: "form",
      });
      if (tg === null) return;
      // Read again: a tap may have changed it meanwhile.
      const now = this.d.pending.peek<FormData>(a.id)?.action as Form | undefined;
      if (!now) return;
      now.data.msgs[i] = tg;
      this.d.pending.update(a.id, now.data);
      a = now;
    }
  }

  /** The form a Telegram message (a question or a "Type my own" prompt) belongs to, open or not. */
  private byMessage(chatId: number, tg: number): { form: Form; q: number; prompt: boolean } | null {
    for (const a of (this.d.pending.all<FormData>("form") as Form[]).reverse()) {
      const d = a.data;
      if (!d || d.chatId !== chatId) continue;
      const q = d.msgs.indexOf(tg);
      if (q >= 0) return { form: a, q, prompt: false };
      const p = d.prompts.find((x) => x.tg === tg);
      if (p) return { form: a, q: p.q, prompt: true };
    }
    return null;
  }

  /** Whether the form still asks what the ticket asks; if not, it is closed (and its messages say why). */
  private async stillAsked(a: Form): Promise<boolean> {
    const form = this.openForm(a.data.board, a.data.ticketId, a.data.key);
    if (form && this.sig(form) === this.sig(a.data.questions)) return true;
    await this.drop(a, this.d.store.getTicket(a.data.board, a.data.ticketId) && !form ? "board" : "gone");
    return false;
  }

  /** A tap on a form's button (choice "<q><k>", "<q>o" or "d"). Returns the short answer for answerCallbackQuery. */
  async onTap(id: string, choice: string, chatId: number, messageId: number, out: Responder, updateId?: number): Promise<string> {
    const got = this.d.pending.peek<FormData>(id);
    if (!got || got.action.data?.chatId !== chatId) return "That button no longer works.";
    const a = got.action as Form;
    if (got.state === "used") {
      // The tap that finished the form, handled again after a restart: finish the send (Board drops a double).
      if (updateId !== undefined && got.usedBy === updateId && a.data.closed === "sent") return this.finish(a, updateId, messageId, true);
      return a.data.closed === "sent" ? "Already sent" : "This form is closed.";
    }
    if (got.state === "expired") {
      if (messageId) await out.edit(messageId, `${questionText(a.data, Math.max(0, a.data.msgs.indexOf(messageId)), this.head(a.data))}\n\nThis expired. Answer on the board.`);
      return "This form expired.";
    }
    if (!(await this.stillAsked(a))) return "Already answered";
    if (choice === "d") return this.finish(a, updateId ?? 0, messageId);
    const m = /^(\d)(\d|o)$/.exec(choice);
    const q = m ? Number(m[1]) : -1;
    const question = a.data.questions[q];
    if (!m || !question) return "That button no longer works.";
    if (m[2] === "o") {
      const head = q === 0 ? "(1 of " + a.data.questions.length + ")" : `(${q + 1} of ${a.data.questions.length})`;
      const tg = await this.d.out(chatId)?.say(`Type your answer to ${head} ${short(question.question, 200)} as a reply to this message.`, {
        replyTo: a.data.msgs[q] ?? undefined, forceReply: "Your answer", link: [{ board: a.data.board, ticketId: a.data.ticketId, key: a.data.key }], level: "form",
      });
      if (tg === null || tg === undefined) return "Couldn't ask. Try again.";
      const now = this.d.pending.peek<FormData>(id)!.action as Form;
      now.data.prompts = [...now.data.prompts, { tg, q }].slice(-20);
      this.d.pending.update(id, now.data);
      return "Type your answer";
    }
    const opt = question.options[Number(m[2])];
    if (!opt) return "That button no longer works.";
    const ans = a.data.answers[q];
    if (question.multiSelect) ans.picked = ans.picked.includes(opt.label) ? ans.picked.filter((l) => l !== opt.label) : [...ans.picked, opt.label];
    else {
      ans.picked = [opt.label];
      ans.other = "";
    }
    this.d.pending.update(id, a.data);
    if (this.complete(a.data)) return this.finish(a, updateId ?? 0, messageId);
    await this.redraw(a, q);
    return question.multiSelect ? (ans.picked.includes(opt.label) ? `✓ ${short(opt.label, 60)}` : `Unticked ${short(opt.label, 60)}`) : `✓ ${short(opt.label, 60)}`;
  }

  /** Every question answered and none is multi-select (those wait for Done). */
  private complete(d: FormData): boolean {
    return !hasMulti(d) && d.answers.every(answered);
  }

  private async redraw(a: Form, q: number): Promise<void> {
    const tg = a.data.msgs[q];
    const out = this.d.out(a.data.chatId);
    if (tg === null || !out) return;
    await out.edit(tg, questionText(a.data, q, this.head(a.data)), this.buttons(a, q));
  }

  /**
   * A reply to a form's question or its "Type my own" prompt: that question's answer, no echo. True when it was for
   * a form (handled), false otherwise.
   */
  async onReply(r: { chatId: number; updateId: number; tg: number; replyTo: number; text: string }, out: Responder): Promise<boolean> {
    const hit = this.byMessage(r.chatId, r.replyTo);
    if (!hit) return false;
    const got = this.d.pending.peek<FormData>(hit.form.id)!;
    const a = got.action as Form;
    if (got.state === "used") {
      if (got.usedBy === r.updateId && a.data.closed === "sent") {
        await this.finish(a, r.updateId, r.tg, true);
        return true;
      }
      await out.say(a.data.closed === "sent" ? "That form was already sent, so I didn't send this." : "That form was already answered, so I didn't send this.", { replyTo: r.tg });
      return true;
    }
    if (got.state === "expired") {
      await out.say("That form expired, so I didn't send this. Answer on the board.", { replyTo: r.tg });
      return true;
    }
    if (!(await this.stillAsked(a))) {
      await out.say("That question was already answered, so I didn't send this.", { replyTo: r.tg });
      return true;
    }
    if (r.text.startsWith("/")) {
      await out.say("Commands only work on the board, so I didn't take this as an answer.", { replyTo: r.tg });
      return true;
    }
    const q = a.data.questions[hit.q];
    const ans = a.data.answers[hit.q];
    ans.other = r.text;
    if (!q.multiSelect) ans.picked = [];
    this.d.pending.update(a.id, a.data);
    if (this.complete(a.data)) {
      await this.finish(a, r.updateId, r.tg);
      return true;
    }
    await this.redraw(a, hit.q);
    const prompt = hit.prompt ? r.replyTo : null;
    const n = a.data.questions.length;
    const left = a.data.answers.filter((x) => !answered(x)).length;
    const note = `✓ Noted your answer to (${hit.q + 1} of ${n}).${hasMulti(a.data) ? " Tap Done when you're ready." : left ? ` ${left} to go.` : ""}`;
    if (prompt !== null) await this.d.out(a.data.chatId)?.edit(prompt, note);
    else await out.say(note, { replyTo: r.tg });
    return true;
  }

  /** "both answers", "your answer", "all 3 answers". */
  private sentLine(d: FormData): string {
    const t = this.d.store.getTicket(d.board, d.ticketId);
    const n = d.questions.length;
    const what = n === 1 ? "your answer" : n === 2 ? "both answers" : `all ${n} answers`;
    return `✓ Sent ${what} to "${t?.title ?? d.ticketId}".`;
  }

  /**
   * Sends the form's answers to the ticket as one message. The form is taken first (with the update that finished
   * it), so a second tap can't send it again and a restart finishes it once. replay: the same update after a restart.
   */
  private async finish(a: Form, updateId: number, tg: number, replay = false): Promise<string> {
    const d = a.data;
    const out = this.d.out(d.chatId);
    if (!replay) {
      d.closed = "sent";
      this.d.pending.update(a.id, d);
      const took = this.d.pending.take<FormData>(a.id, updateId);
      if ("gone" in took) return "Already sent";
    }
    const r = await this.send(d, updateId, tg);
    if (r !== "sent") {
      if (r !== "already" && out) await out.say(r, { replyTo: d.msgs.at(-1) ?? d.alertTg ?? undefined });
      return r === "already" ? "Already sent" : "Not sent";
    }
    await this.closeMessages(d, (i) => `${questionText(d, i, this.head(d))}\n\n✓ ${short(answerText(boardAnswer(d.answers[i])), 300)}`);
    if (out) await out.say(this.sentLine(d), { replyTo: d.msgs.at(-1) ?? d.alertTg ?? undefined });
    return "Sent";
  }

  /** Into the ticket's chat ("via Telegram"). "sent", "already", or what to tell the user. */
  private async send(d: FormData, updateId: number, tg: number): Promise<"sent" | "already" | string> {
    if (!this.d.taking()) return "I'm not taking messages right now. Turn it back on in Settings on the Mac.";
    const chat = this.d.chat();
    if (!chat) return "The board isn't ready yet, so I couldn't send your answers. Answer on the board.";
    const title = this.d.store.getTicket(d.board, d.ticketId)?.title ?? "the ticket";
    try {
      const sent = await chat(d.board, d.ticketId, formMessage(d), { updateId, tg, chatId: d.chatId, key: d.key, still: () => this.d.taking() });
      return sent ? "sent" : "already";
    } catch (e) {
      if ((e as Error).name === "StillRefused") return "I'm not taking messages right now. Turn it back on in Settings on the Mac.";
      return `Couldn't send your answers to "${title}": ${(e as Error).message}`;
    }
  }

  /** Each question's message changes to its closing line, without buttons. */
  private async closeMessages(d: FormData, text: (i: number) => string): Promise<void> {
    const out = this.d.out(d.chatId);
    if (!out) return;
    for (let i = 0; i < d.msgs.length; i++) {
      const tg = d.msgs[i];
      if (tg !== null) await out.edit(tg, text(i));
    }
  }

  /** Closes an open form: its taps are dropped and its messages say why. */
  private async drop(a: Form, why: "board" | "typed" | "gone"): Promise<void> {
    a.data.closed = why;
    this.d.pending.update(a.id, a.data);
    if ("gone" in this.d.pending.take(a.id)) return;
    const d = a.data;
    const n = d.questions.length;
    const q = (i: number) => (i === 0 ? `(1 of ${n}) ${d.questions[0].question}` : `(${i + 1} of ${n}) ${d.questions[i].question}`);
    const line = why === "board" ? `✓ Answered on the Mac ${clockTime(this.now())}` : why === "typed" ? "✓ Answered by your message" : "This question is no longer open.";
    await this.closeMessages(d, (i) => `${q(i)}\n\n${line}`);
  }

  /**
   * Other text is about to reach this ticket from Telegram: a half-answered form's answers go first (one message),
   * so the text doesn't close the form and lose them. updateId: the text's update (the answers use its negative, so a
   * restart sends them once). Returns false when they couldn't be sent (the text then waits too).
   */
  async flushBefore(board: string, ticketId: string, updateId: number, tg: number): Promise<boolean> {
    // After a restart: the answers already went (the form is used by this update).
    const done = (this.d.pending.all<FormData>("form") as Form[]).find((a) => a.used && a.usedBy === -updateId && a.data?.board === board && a.data.ticketId === ticketId);
    if (done) {
      const r = await this.send(done.data, -updateId, tg);
      return r === "sent" || r === "already";
    }
    for (const a of this.open((d) => d.board === board && d.ticketId === ticketId)) {
      if (!a.data.answers.some(answered) || !(await this.stillAsked(a))) continue;
      a.data.closed = "sent";
      this.d.pending.update(a.id, a.data);
      if ("gone" in this.d.pending.take(a.id, -updateId)) continue;
      const r = await this.send(a.data, -updateId, tg);
      if (r !== "sent" && r !== "already") return false;
      const d = a.data;
      await this.closeMessages(d, (i) => `${questionText(d, i, this.head(d))}\n\n✓ Sent with your message`);
    }
    return true;
  }

  /** Text reached the ticket from Telegram: forms still open for it (nothing picked) are closed by it. */
  async closedByText(board: string, ticketId: string): Promise<void> {
    for (const a of this.open((d) => d.board === board && d.ticketId === ticketId)) await this.drop(a, "typed");
  }

  /**
   * The ticket changed (Notifier tick): an open form it no longer asks was answered on the board (or replaced): the
   * taps are dropped and its messages say so.
   */
  async sync(board: string, ticketId: string): Promise<void> {
    for (const a of this.open((d) => d.board === board && d.ticketId === ticketId)) await this.stillAsked(a);
  }
}
