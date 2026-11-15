// A main ticket's chat while tasks wait on the user: short task cards, the "N waiting on you" list and the grey notes
// before the cards. No React and no api.ts, so tests can import it.
import { plainMarkdown } from "./miniMarkdown";
import { answersMessage, type Answer } from "./questionForms";

// Only the fields used here (structurally the same as api.ts's).
interface Question {
  question: string;
  multiSelect?: boolean;
  options: { label: string; recommended?: boolean }[];
}
interface Msg {
  role: "reply" | "user";
  text: string;
  questions?: Question[];
  form?: { open: boolean; key: string };
}

/** About one line in the waiting list and on a card. */
export const SHORT_MAX = 140;

/** One line, cut with "…" when longer than max. */
export function oneLine(text: string, max = SHORT_MAX): string {
  const lines = text.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).filter(Boolean);
  // "Call 4 results:" says little alone: a line ending in ":" keeps the line after it.
  const first = (lines[0]?.endsWith(":") && lines[1] ? `${lines[0]} ${lines[1]}` : lines[0]) ?? "";
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/**
 * The grey note the board adds before a task's card ("<task> needs you: Call 3 results:"), without the task's name the
 * card already shows: "Call 3 results". Notes about something else stay as they are.
 */
export function shortNote(text: string, title: string | undefined): string {
  const at = text.indexOf(" needs you");
  if (at < 0 || !title || !text.slice(0, at).endsWith(title)) return text;
  const rest = text.slice(at + " needs you".length).replace(/^:\s*/, "").replace(/:\s*$/, "").trim();
  return rest || "Needs you";
}

/** The newest form still waiting for answers in a task's messages, if any. */
export function openForm<M extends Msg>(msgs: M[]): M | undefined {
  return msgs.findLast((m) => m.role === "reply" && !!m.questions?.length && !!m.form?.open);
}

/** The short question a task's card shows: its open form's first question, else its last message's first line. */
export function cardQuestion(msgs: Msg[]): string {
  const form = openForm(msgs);
  if (form) {
    const qs = form.questions!;
    const q = oneLine(plainMarkdown(qs[0].question));
    return qs.length > 1 ? `${q} (+${qs.length - 1} more)` : q;
  }
  const last = msgs.findLast((m) => m.role === "reply" && !!m.text.trim());
  return last ? oneLine(plainMarkdown(last.text)) : "";
}

/**
 * The one-click answer on a task's card: every question of the open form has a recommended option (and picks just one),
 * so a click sends the same message the form would with those picked. null when the form needs the user to choose.
 */
export function oneClick(questions: Question[] | undefined): { label: string; title: string; text: string } | null {
  if (!questions?.length || questions.some((q) => q.multiSelect)) return null;
  const picks = questions.map((q) => q.options.find((o) => o.recommended));
  if (picks.some((p) => !p)) return null;
  const answers: Answer[] = picks.map((p) => ({ picked: [p!.label], otherOn: false, other: "" }));
  const labels = picks.map((p) => plainMarkdown(p!.label));
  return {
    label: questions.length === 1 ? `${oneLine(labels[0], 60)} (recommended)` : `Use the ${questions.length} recommended answers`,
    title: questions.map((q, i) => `${plainMarkdown(q.question)} → ${labels[i]}`).join("\n"),
    text: answersMessage(questions, answers),
  };
}

/** One row of the "N waiting on you" list. task: opens that task in the side sheet; form: this chat's own open form. */
export interface WaitingItem {
  kind: "task" | "form" | "status";
  /** The task's id (task), "" otherwise. */
  id: string;
  title: string;
  question: string;
}

/**
 * What waits on the user in a main ticket's chat, one row each: tasks that ended asking the user (with the short
 * question of their open form), other tasks the feature status says need the user, then this chat's own open form.
 * Claude's own "waiting on you" sentence from the status only shows when nothing else does, so it is never said twice.
 */
export function waitingItems(input: {
  steps: { id: string; title: string; waiting: boolean }[];
  messages: (Msg & { stepId: string })[];
  needsYou: { id: string; title: string; why?: string | null }[];
  selfForm: { question: string } | null;
  statusWaiting?: string | null;
}): WaitingItem[] {
  const out: WaitingItem[] = [];
  for (const s of input.steps) {
    if (!s.waiting) continue;
    out.push({ kind: "task", id: s.id, title: s.title, question: cardQuestion(input.messages.filter((m) => m.stepId === s.id)) });
  }
  for (const n of input.needsYou) {
    if (out.some((o) => o.id === n.id)) continue;
    out.push({ kind: "task", id: n.id, title: n.title, question: n.why ? oneLine(n.why) : "" });
  }
  if (input.selfForm) out.push({ kind: "form", id: "", title: "This chat", question: oneLine(plainMarkdown(input.selfForm.question)) });
  const w = input.statusWaiting?.replace(/\s+/g, " ").trim();
  if (!out.length && w) out.push({ kind: "status", id: "", title: "Status", question: oneLine(w) });
  return out;
}

/** The button above the message box: "3 waiting on you". */
export function waitingLabel(n: number): string {
  return `${n} waiting on you`;
}

/** The URL hash with the side sheet open on task id (null: closed): #/board/ticket?sheet=<id>. */
export function sheetHash(hash: string, id: string | null): string {
  const [path, query = ""] = hash.split("?");
  const params = new URLSearchParams(query);
  if (id) params.set("sheet", id);
  else params.delete("sheet");
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

/** The task the URL hash opens in the side sheet, if any. */
export function sheetFromHash(hash: string): string | null {
  const query = hash.split("?")[1];
  return query ? new URLSearchParams(query).get("sheet") || null : null;
}
