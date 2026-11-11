/** Questions forms in a chat: which are open, answered or asked again, and the progress that carries between them (no React, so it can be unit tested). */
// Only the fields used here (structurally the same as api.ts's), so server tests can import this file.
interface Question {
  question: string;
  context?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; recommended?: boolean }[];
}
interface SessionEntry {
  uuid: string;
  role: "user" | "assistant";
  kind: string;
  huddleId?: string;
  questions?: Question[];
}

export interface Answer {
  picked: string[];
  otherOn: boolean;
  other: string;
}

/** Progress saved while answering; `sig` ties it to these exact questions. */
export interface Progress {
  sig: string;
  answers: Answer[];
  step: number;
  note: string;
}

const questionSig = (q: Question) => [q.question, q.options.map((o) => o.label)] as const;
export const signature = (questions: Question[]) => JSON.stringify(questions.map(questionSig));

export function initial(q: Question): Answer {
  const rec = q.options.find((o) => o.recommended) ?? (q.multiSelect ? undefined : q.options[0]);
  return { picked: rec ? [rec.label] : [], otherOn: false, other: "" };
}

export function fresh(questions: Question[]): Progress {
  return { sig: signature(questions), answers: questions.map(initial), step: 0, note: "" };
}

const validAnswer = (a: unknown): a is Answer =>
  !!a && typeof a === "object" && Array.isArray((a as Answer).picked) && typeof (a as Answer).other === "string";

/**
 * Where a form starts: its saved progress when it is for these exact questions; otherwise, progress saved for an
 * earlier form it replaced (asked again after a board update) carries over question by question (same question and
 * options), with the note; anything else starts fresh.
 */
export function startProgress(questions: Question[], saved: Progress | null | undefined): Progress {
  const sig = signature(questions);
  if (saved && saved.sig === sig && Array.isArray(saved.answers) && saved.answers.length === questions.length && saved.answers.every(validAnswer)) return saved;
  const base = fresh(questions);
  if (!saved || typeof saved.sig !== "string" || !Array.isArray(saved.answers)) return base;
  let old: string[] = [];
  try {
    const parsed = JSON.parse(saved.sig);
    if (Array.isArray(parsed)) old = parsed.map((x) => JSON.stringify(x));
  } catch {}
  const answers = questions.map((q, i) => {
    const j = old.indexOf(JSON.stringify(questionSig(q)));
    const a = j >= 0 ? saved.answers[j] : undefined;
    return validAnswer(a) ? a : base.answers[i];
  });
  return { ...base, answers, note: typeof saved.note === "string" ? saved.note : "" };
}

export type FormState =
  /** Waiting for the user's answers. */
  | { state: "open"; key: string }
  /** by: the index of the user's message that answered it, when it is in the chat (not while the answer is on its way). */
  | { state: "answered"; by?: number }
  /** The user closed it without answering (Close question), or it closed by itself when they answered in its task's chat. */
  | { state: "closed" }
  /** Asked again further down (a board update came in before the user answered): same says whether the questions match. */
  | { state: "replaced"; same: boolean };

/** A user message that answers forms above it; board updates (kind "board") and huddle messages don't. */
const answers = (e: SessionEntry) => e.role === "user" && e.kind === "text" && !e.huddleId;

/**
 * The state of every questions form in the chat, by entry index. A form followed by another one before the user
 * answered is replaced by it; a chain of such forms shares one saved-progress key (the first form's uuid), so what the
 * user typed into the old form shows up in the new one. replying: the user's answer is on its way.
 * closed: the uuids of forms the user closed (Ticket.closedForms); closeLatest: the newest open form counts as closed
 * too (askClosed: closed after the last run ended, also when the board only knows that it closed, not which form).
 */
export function formStates(entries: SessionEntry[], replying = false, closed: ReadonlySet<string> = new Set(), closeLatest = false): Map<number, FormState> {
  const out = new Map<number, FormState>();
  let chain = null as { key: string; last: number } | null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (answers(e)) {
      if (chain) out.set(chain.last, { state: "answered", by: i });
      chain = null;
      continue;
    }
    if (!e.questions) continue;
    if (chain) out.set(chain.last, { state: "replaced", same: signature(entries[chain.last].questions!) === signature(e.questions) });
    const key: string = chain?.key ?? e.uuid;
    chain = { key, last: i };
    out.set(i, { state: "open", key: chain.key });
    // A closed form ends its chain: a later form starts fresh, and nothing answers the closed one.
    if (closed.has(e.uuid)) {
      out.set(i, { state: "closed" });
      chain = null;
    }
  }
  if (chain && replying) out.set(chain.last, { state: "answered" });
  else if (chain && closeLatest) out.set(chain.last, { state: "closed" });
  return out;
}

/**
 * The answers in the message a form sent (answersMessage), paired with its questions by their text: one per question
 * (null when the message doesn't answer it, e.g. the user typed their own message), plus the note after the list.
 */
export function parseAnswers(text: string, questions: Pick<Question, "question">[]): { answers: (string | null)[]; note: string } {
  const none = { answers: questions.map(() => null), note: "" };
  const m = /^\s*My answers:\n/.exec(text);
  if (!m) return none;
  const items: string[] = [];
  const lines = text.slice(m[0].length).split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("- ")) items.push(l.slice(2));
    else if (l.startsWith("  ") && items.length) items[items.length - 1] += `\n${l.slice(2)}`;
    else break;
  }
  const note = lines.slice(i).join("\n").trim();
  const used = new Set<number>();
  const answers = questions.map((q) => {
    const head = `${q.question} → `;
    const j = items.findIndex((it, k) => !used.has(k) && it.startsWith(head));
    if (j < 0) return null;
    used.add(j);
    return items[j].slice(head.length).trim();
  });
  return { answers, note };
}

/** One answer as the sent message shows it: the picked options, then the typed text, joined with "; ". */
export function answerText(a: Answer): string {
  const parts = [...a.picked, ...(a.otherOn && a.other.trim() ? [a.other.trim()] : [])];
  // Indent extra lines so a multi-line answer stays inside its list item.
  return parts.length ? parts.join("; ").replace(/\n/g, "\n  ") : "(no preference)";
}

/** The one chat message a form sends (the board's form and Telegram's both use this). */
export function answersMessage(questions: Pick<Question, "question">[], answers: Answer[], note = ""): string {
  const lines = questions.map((q, i) => `- ${q.question} → ${answerText(answers[i] ?? { picked: [], otherOn: false, other: "" })}`);
  return `My answers:\n${lines.join("\n")}${note.trim() ? `\n\n${note.trim()}` : ""}`;
}

/** Words only: lower case, no marks, punctuation or extra spaces (so "**Pick one?**" matches "pick one"). */
const words = (s: string) => s.toLowerCase().replace(/\]\([^)\s]*\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Whether a reply only repeats a questions form it follows (its questions, context or options): the chat then
 * shows the form alone, not the same report twice. Each line (or sentence) of the reply counts as repeated when the
 * form says it too; the reply repeats the form when it repeats a question or context and at least 80% of its text is
 * in such lines.
 */
export function repeatsForm(text: string, questions: Question[]): boolean {
  const form = ` ${words(questions.flatMap((q) => [q.question, q.context ?? "", ...q.options.flatMap((o) => [o.label, o.description ?? ""])]).join("\n"))} `;
  const parts = text.split(/\n+|(?<=[.!?:])\s+/).map(words).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length, 0);
  if (!total) return false;
  const repeated = parts.filter((p) => form.includes(` ${p} `));
  // It must repeat a question or its context, not only an option label like "Yes".
  const asked = ` ${words(questions.flatMap((q) => [q.question, q.context ?? ""]).join("\n"))} `;
  if (!repeated.some((p) => p.includes(" ") && asked.includes(` ${p} `))) return false;
  return repeated.reduce((n, p) => n + p.length, 0) / total >= 0.8;
}
