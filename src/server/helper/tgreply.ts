// A Telegram reply to an alert goes into that ticket's chat, as if the user typed it there. Typed text reaches a
// session that runs with full permissions, so (see the rules in route()):
// - an answer to the ticket's current open question: an echo with [Send] [Cancel] first (Settings can turn it off);
// - anything else (a ticket in Review, failed, blocked or stalled, or text that isn't an answer): [Confirm] [Cancel];
// - a usage limit, a proposal card or a huddle: "This needs the board.", nothing is sent;
// - an old alert (its question was answered, or it is over a day old, or the ticket is done, moved or deleted):
//   nothing is sent; an answered one offers "Send anyway", which goes through the Confirm above;
// - a summary about several tickets: "Which one?" buttons, one per ticket.
// Buttons are PendingActions (single-use, ~10 minutes); every tap checks the ticket again before acting.
// When a ticket that got a message from Telegram ends its turn, its reply goes back as an answer to that message.
import type { SessionSummary } from "../session";
import type { Store } from "../store";
import type { Ticket } from "../types";
import type { WaitStore, WaitRecord } from "./waits";
import { TELEGRAM_MAX } from "./telegram";
import type { LinkItem, PendingAction, PendingActions, TelegramLinks } from "./tgstores";

/** A reply to an alert older than this is refused. */
export const STALE_REPLY_MS = 24 * 3600_000;
/** A ticket's reply goes back to Telegram only this long after the message that asked. */
export const REPORT_MS = 24 * 3600_000;
/** Longest report back: split into at most this many Telegram messages. */
export const REPORT_PARTS = 3;

/** Wait kinds a typed answer is meant for (the ticket asked something). */
const ANSWER_KINDS = new Set(["questions", "message"]);
/** Wait kinds Telegram can't settle: they need the board's own buttons. */
const BOARD_KINDS = new Set(["limit", "proposal", "huddle"]);

export const NEEDS_BOARD = "This needs the board.";
export const FORM_ON_BOARD = "This question has a form; answer it on the board for now.";

/** One button: data is the full callback_data. */
export interface TgButton {
  text: string;
  data?: string;
  url?: string;
}

/** How the router talks back (TelegramBot implements it). Every send is silent. */
export interface Responder {
  /** Sends a message (a reply to replyTo when given); returns Telegram's message_id, or null when it failed. */
  say(text: string, o?: { replyTo?: number; buttons?: TgButton[][]; link?: LinkItem[] }): Promise<number | null>;
  /** Changes a message's text and buttons (none: the buttons go). */
  edit(messageId: number, text: string, buttons?: TgButton[][]): Promise<void>;
}

/** A message the user sent as a reply to one of the board's messages. */
export interface IncomingReply {
  chatId: number;
  updateId: number;
  /** The user's message. */
  tg: number;
  /** The board's message it replies to. */
  replyTo: number;
  text: string;
}

/** Where a reply goes: one ticket, the wait it answers (null: none named) and when the alert went out. */
interface Target extends LinkItem {
  linkAt: string;
}

/** What a button does; kept in PendingActions under a short id. */
interface SendData {
  r: IncomingReply;
  t: Target;
  /** answer: it answers the open wait (re-checked on the tap). steer: anything else, confirmed. */
  mode: "answer" | "steer";
}
interface PickData {
  r: IncomingReply;
  items: Target[];
}

export interface ReplyDeps {
  store: Store;
  waits: WaitStore;
  links: TelegramLinks;
  pending: PendingActions;
  session: (sessionId: string) => SessionSummary | null;
  isRunning: (board: string, id: string) => boolean;
  /** Board.chatFromTelegram (null until the board is plugged in): false when the update was already sent. */
  chat: () => ((board: string, id: string, text: string, from: { updateId: number; tg: number; chatId: number; key?: string | null }) => Promise<boolean>) | null;
  /** Board.patchTelegram. */
  patch: (board: string, id: string, patch: Pick<Partial<Ticket>, "telegramOut" | "telegramReport">) => void;
  /** The echo before a typed answer (Settings: "Ask before sending typed answers"). */
  askTyped: () => boolean;
  /** The ticket's address on the board when phone access is on (an Open button), else null. */
  ticketUrl: (board: string, id: string) => string | null;
  now?: () => number;
}

/** "Fix the login" (Kanban). */
const named = (t: Ticket, boardName: string) => `"${t.title}" (${boardName})`;

/** Up to max characters on one line, for buttons and quotes. */
const short = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** A ticket's reply in Telegram-sized parts: the result line dropped, split at line breaks, at most `parts` parts. */
export function reportParts(head: string, text: string, parts = REPORT_PARTS, max = TELEGRAM_MAX): string[] {
  const body = text.split("\n").filter((l) => !/^\s*CKANBAN_RESULT:/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) return [];
  const out: string[] = [];
  let cur = head ? `${head}\n\n` : "";
  const push = () => {
    if (cur.trim()) out.push(cur.trimEnd());
    cur = "";
  };
  for (let line of body.split("\n")) {
    while (line.length > max - 1) {
      // A line longer than a whole message: cut it.
      push();
      out.push(line.slice(0, max - 1));
      line = line.slice(max - 1);
    }
    if (cur.length + line.length + 1 > max) push();
    cur += `${line}\n`;
  }
  push();
  if (out.length <= parts) return out;
  const kept = out.slice(0, parts);
  const tail = "\n\n… (cut: read the rest on the board)";
  kept[parts - 1] = `${kept[parts - 1].slice(0, max - tail.length)}${tail}`;
  return kept;
}

export class TelegramReplies {
  private now: () => number;

  constructor(private d: ReplyDeps) {
    this.now = d.now ?? Date.now;
  }

  /** A reply to one of the board's messages. Not a reply to the board, or about no ticket: the fixed answer (false). */
  async onReply(r: IncomingReply, out: Responder): Promise<boolean> {
    const link = this.d.links.get(r.chatId, r.replyTo);
    if (!link) return false;
    const seen = new Set<string>();
    const items: Target[] = link.items
      .filter((i) => (seen.has(`${i.board}/${i.ticketId}`) ? false : (seen.add(`${i.board}/${i.ticketId}`), true)))
      .map((i) => ({ ...i, linkAt: link.at }));
    if (!items.length) return false;
    // Handled before a restart (sent, or its question already shown): nothing again.
    if (items.some((i) => this.sentAlready(i, r.updateId))) return true;
    if (this.d.pending.find<{ r?: IncomingReply }>((a) => a.data?.r?.updateId === r.updateId && a.data?.r?.chatId === r.chatId)) return true;
    if (items.length > 1) {
      await this.pick(r, items, out);
      return true;
    }
    await this.route(r, items[0], out);
    return true;
  }

  private sentAlready(i: LinkItem, updateId: number): boolean {
    const t = this.d.store.getTicket(i.board, i.ticketId);
    return !!t && (!!t.telegramIn?.some((m) => m.updateId === updateId) || !!t.queued?.some((m) => m.telegram?.updateId === updateId));
  }

  /** A summary about several tickets: one button per ticket, naming its board. */
  private async pick(r: IncomingReply, items: Target[], out: Responder): Promise<void> {
    const live = items.filter((i) => this.d.store.getTicket(i.board, i.ticketId)).slice(0, 8);
    if (!live.length) {
      await out.say("Those tickets are gone, so I didn't send this.", { replyTo: r.tg });
      return;
    }
    const a = this.d.pending.create<PickData>("pick", { r, items: live });
    const rows = live.map((i, n) => {
      const t = this.d.store.getTicket(i.board, i.ticketId)!;
      const board = this.d.store.getProfile(i.board)?.name ?? i.board;
      return [{ text: short(`${t.title} (${board})`, 60), data: `p:${a.id}:${n}` }];
    });
    rows.push([{ text: "Cancel", data: `p:${a.id}:x` }]);
    await out.say("That message was about several tickets. Which one is this for?", { replyTo: r.tg, buttons: rows });
  }

  /**
   * What a reply to one ticket may do now: stop (with the answer to give), an answer to its open wait, steering, or
   * stale (the wait it answered is closed; answer: what was sent, when known).
   */
  private check(t: Target, r: IncomingReply): { stop: string; url?: string | null } | { mode: "answer" | "steer"; key: string | null } | { stale: string | null } {
    const p = this.d.store.getProfile(t.board);
    const ticket = this.d.store.getTicket(t.board, t.ticketId);
    if (!p || !ticket) return { stop: "That ticket was deleted or moved to another board, so I didn't send this." };
    if (ticket.status === "done") return { stop: `${named(ticket, p.name)} is done, so I didn't send this. Open it on the board to pick it up again.` };
    if (this.now() - Date.parse(t.linkAt) > STALE_REPLY_MS) return { stop: "That message is more than a day old, so I didn't send this. Answer on the board, or reply to a newer alert." };
    if (r.text.startsWith("/")) return { stop: "Commands only work on the board, so I didn't send this." };
    const url = this.d.ticketUrl(t.board, t.ticketId);
    let rec: WaitRecord | undefined = t.key ? this.d.waits.get(t.key) : undefined;
    if (rec && BOARD_KINDS.has(rec.kind)) return { stop: NEEDS_BOARD, url };
    if (t.key && (!rec || rec.closedAt)) {
      if (rec?.closedWhy === "deleted") return { stop: "That ticket was deleted, so I didn't send this." };
      // Answered or cleared: the answer we know of is the last one sent from Telegram for this wait.
      return { stale: ticket.telegramIn?.findLast((m) => m.key === t.key)?.text ?? null };
    }
    const open = this.d.waits.openFor(t.board, t.ticketId);
    // No wait named (a reply to the ticket's own reply): what it asks now, if anything.
    if (!rec) rec = open.find((w) => ANSWER_KINDS.has(w.kind)) ?? open.find((w) => BOARD_KINDS.has(w.kind));
    if (rec && BOARD_KINDS.has(rec.kind)) return { stop: NEEDS_BOARD, url };
    if (rec && ANSWER_KINDS.has(rec.kind)) {
      if (rec.kind === "questions") {
        const form = ticket.sessionId ? this.d.session(ticket.sessionId)?.openForm ?? [] : [];
        // A form with several questions (or several choices at once) is answered on the board for now.
        if (form.length > 1 || form.some((q) => q.multiSelect)) return { stop: FORM_ON_BOARD, url };
      }
      return { mode: "answer", key: rec.key };
    }
    return { mode: "steer", key: rec?.key ?? null };
  }

  /** Why a steer needs a Confirm, in plain words. */
  private stateLine(t: Target): string {
    const ticket = this.d.store.getTicket(t.board, t.ticketId)!;
    const kind = t.key ? this.d.waits.get(t.key)?.kind : this.d.waits.openFor(t.board, t.ticketId)[0]?.kind;
    if (this.d.isRunning(t.board, t.ticketId)) return "It is working now: this changes what it does.";
    if (kind === "failed" || ticket.outcome === "failed") return "Its run failed: this starts it again.";
    if (kind === "blocked" || ticket.outcome === "blocked") return "It is blocked: this starts it again.";
    if (kind === "stalled") return "It looks stuck: this goes to it as a new message.";
    if (ticket.status === "review") return "It is in Review: this starts it working again.";
    return "This isn't an answer to its question: it starts the ticket working.";
  }

  /** One ticket: stop, echo (answer), Confirm (steer) or "already answered" with Send anyway. */
  private async route(r: IncomingReply, t: Target, out: Responder): Promise<void> {
    const c = this.check(t, r);
    if ("stop" in c) {
      await out.say(c.stop, { replyTo: r.tg, ...(c.url ? { buttons: [[{ text: "Open", url: c.url }]] } : {}) });
      return;
    }
    const ticket = this.d.store.getTicket(t.board, t.ticketId)!;
    const board = this.d.store.getProfile(t.board)?.name ?? t.board;
    if ("stale" in c) {
      const a = this.d.pending.create<SendData>("anyway", { r, t: { ...t, key: null }, mode: "steer" });
      const said = c.stale ? ` You answered: "${short(c.stale, 300)}"` : "";
      await out.say(`${named(ticket, board)}: that question was already answered.${said}\n\nI didn't send this.`, {
        replyTo: r.tg, buttons: [[{ text: "Send anyway", data: `p:${a.id}:y` }, { text: "Cancel", data: `p:${a.id}:x` }]],
      });
      return;
    }
    const target = { ...t, key: c.key };
    if (c.mode === "answer" && !this.d.askTyped()) {
      await this.deliver(r, target, out, null);
      return;
    }
    await this.ask(r, target, c.mode, out);
  }

  /** The echo (answer) or Confirm (steer) card. */
  private async ask(r: IncomingReply, t: Target, mode: "answer" | "steer", out: Responder, editId?: number): Promise<void> {
    const ticket = this.d.store.getTicket(t.board, t.ticketId)!;
    const board = this.d.store.getProfile(t.board)?.name ?? t.board;
    const a = this.d.pending.create<SendData>("send", { r, t, mode });
    const text = mode === "answer"
      ? `Send this to ${named(ticket, board)}?\n\n"${short(r.text, 3000)}"`
      : `Confirm: send this to ${named(ticket, board)}?\n${this.stateLine(t)}\n\n"${short(r.text.split("\n").find((l) => l.trim()) ?? r.text, 300)}"`;
    const buttons = [[{ text: mode === "answer" ? "Send" : "Confirm", data: `p:${a.id}:y` }, { text: "Cancel", data: `p:${a.id}:x` }]];
    if (editId !== undefined) await out.edit(editId, text, buttons);
    else await out.say(text, { replyTo: r.tg, buttons });
  }

  /** Into the ticket's chat. edit: the card to change into the outcome (else a new message). Returns the tap's short answer. */
  private async deliver(r: IncomingReply, t: Target, out: Responder, edit: number | null): Promise<string> {
    const tell = async (text: string) => (edit !== null ? out.edit(edit, text) : void (await out.say(text, { replyTo: r.tg })));
    const chat = this.d.chat();
    if (!chat) {
      await tell("The board isn't ready yet. Try again in a minute.");
      return "Not sent";
    }
    const ticket = this.d.store.getTicket(t.board, t.ticketId)!;
    try {
      const sent = await chat(t.board, t.ticketId, r.text, { updateId: r.updateId, tg: r.tg, chatId: r.chatId, key: t.key });
      if (!sent) {
        await tell(`Already sent to "${ticket.title}".`);
        return "Already sent";
      }
    } catch (e) {
      await tell(`Couldn't send this to "${ticket.title}": ${(e as Error).message}`);
      return "Not sent";
    }
    await tell(`✓ Sent to "${ticket.title}". I'll reply here when it has news.`);
    return "Sent";
  }

  /** A tap on one of the router's buttons ("p:<id>:<choice>"). Returns the short answer for answerCallbackQuery. */
  async onTap(id: string, choice: string, chatId: number, messageId: number, out: Responder): Promise<string> {
    const got = this.d.pending.take<SendData | PickData>(id);
    if ("gone" in got) {
      if (messageId) await out.edit(messageId, got.gone === "expired" ? "This expired. Reply to the alert again to send it." : "This was already handled.");
      return got.gone === "expired" ? "This button expired." : "This button was already used.";
    }
    const a = got.action as PendingAction<any>;
    if (a.data?.r?.chatId !== chatId) return "That button no longer works.";
    if (choice === "x") {
      await out.edit(messageId, "Cancelled. Nothing was sent.");
      return "Cancelled";
    }
    if (a.kind === "pick") {
      const d = a.data as PickData;
      const t = d.items[Number(choice)];
      if (!t || !/^\d+$/.test(choice)) return "That button no longer works.";
      const ticket = this.d.store.getTicket(t.board, t.ticketId);
      await out.edit(messageId, ticket ? `For "${ticket.title}" (${this.d.store.getProfile(t.board)?.name ?? t.board}).` : "That ticket is gone.");
      if (ticket) await this.route(d.r, t, out);
      return ticket ? "OK" : "Gone";
    }
    const d = a.data as SendData;
    if (choice !== "y") return "That button no longer works.";
    if (this.sentAlready(d.t, d.r.updateId)) {
      await out.edit(messageId, "Already sent.");
      return "Already sent";
    }
    // The state may have changed since the card was shown: check again (a steer only needs the ticket still open).
    const c = this.check(d.mode === "steer" ? { ...d.t, key: null } : d.t, d.r);
    if ("stop" in c) {
      await out.edit(messageId, c.stop);
      return "Not sent";
    }
    if (a.kind === "anyway") {
      // "Send anyway" on an answered question: the steering Confirm, in the same message.
      await this.ask(d.r, { ...d.t, key: "key" in c ? c.key : null }, "steer", out, messageId);
      return "Confirm to send";
    }
    if (d.mode === "answer" && !("mode" in c && c.mode === "answer" && c.key === d.t.key)) {
      await out.edit(messageId, "That question was answered or changed meanwhile, so I didn't send this. Reply to the newest alert.");
      return "Not sent";
    }
    return this.deliver(d.r, d.t, out, messageId);
  }

  /**
   * A ticket's run ended (Board turnEnded): if a Telegram message waits for its reply, the reply goes back as an
   * answer to it (plain text, split at line breaks), and the board marks it "sent to Telegram". One per turn.
   */
  async turnEnded(board: string, id: string, text: string, out: (chatId: number) => Responder | null): Promise<void> {
    const t = this.d.store.getTicket(board, id);
    const rep = t?.telegramReport;
    if (!t || !rep) return;
    if (this.now() - Date.parse(rep.at) > REPORT_MS) {
      this.d.patch(board, id, { telegramReport: null });
      return;
    }
    const boardName = this.d.store.getProfile(board)?.name ?? board;
    const parts = reportParts(`${t.title} (${boardName}):`, text);
    // No text (a stop or an error): the next turn reports; the helper tells about failures.
    if (!parts.length) return;
    const o = out(rep.chatId);
    if (!o) {
      this.d.patch(board, id, { telegramReport: null });
      return;
    }
    // Cleared first: a second turn end meanwhile doesn't send it again.
    this.d.patch(board, id, { telegramReport: null });
    let sent = 0;
    for (const p of parts) {
      const tg = await o.say(p, { replyTo: rep.tg, link: [{ board, ticketId: id, key: null }] });
      if (tg !== null) sent++;
    }
    if (!sent) return;
    const after = this.d.store.getTicket(board, id);
    const body = parts.join("\n").slice(`${t.title} (${boardName}):`.length).trim();
    this.d.patch(board, id, { telegramOut: [...(after?.telegramOut ?? []), { at: new Date(this.now()).toISOString(), text: body.slice(0, 300), replyTo: rep.tg }].slice(-30) });
  }
}
