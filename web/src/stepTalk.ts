// What a "with you" step showed the user, for its main ticket's chat (StepMessages.tsx). No React and no api.ts, so
// tests can import it.
import { formStates, repeatsForm } from "./questionForms";
import { replyText } from "./simplifyText";

// Only the fields used here (structurally the same as api.ts's).
interface Question {
  question: string;
  context?: string;
  multiSelect?: boolean;
  options: { label: string; recommended?: boolean; description?: string; mockup?: string }[];
}
export interface StepEntry {
  uuid: string;
  at: string;
  role: "user" | "assistant";
  kind: string;
  text: string;
  huddleId?: string;
  peer?: unknown;
  questions?: Question[];
}

/** One thing a step showed the user (or the user's answer to it). */
export interface StepMsg {
  stepId: string;
  uuid: string;
  at: string;
  /** reply: the step's last message of a turn; user: what the user answered. */
  role: "reply" | "user";
  text: string;
  questions?: Question[];
  /** The form's state: answered, or open with the key its progress is saved under (shared with the step's own chat). */
  form?: { open: boolean; key: string };
}

const userTyped = (e: StepEntry) => e.role === "user" && e.kind === "text" && !e.huddleId && !e.peer;

/**
 * What a step's conversation showed the user: the last reply of each finished turn (its narration in between stays in
 * the step's own chat), its question forms, and the user's own messages. Pure, so it is easy to test.
 */
export function stepMessages(stepId: string, entries: StepEntry[], running: boolean): StepMsg[] {
  const forms = formStates(entries, false);
  const out: StepMsg[] = [];
  let last: number | null = null;
  const flush = () => {
    if (last === null) return;
    const e = entries[last];
    const st = forms.get(last);
    out.push({
      stepId, uuid: e.uuid, at: e.at, role: "reply", text: replyText(e.text), ...(e.questions ? { questions: e.questions } : {}),
      ...(e.questions ? { form: { open: st?.state === "open", key: st?.state === "open" ? st.key : e.uuid } } : {}),
    });
    last = null;
  };
  let form: Question[] | undefined;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.questions) form = e.questions;
    // A last word that only repeats the form above it in this turn: the form already says it.
    else if (form && e.role === "assistant" && e.kind === "text" && repeatsForm(replyText(e.text), form)) continue;
    if (e.role === "assistant" && e.kind === "text" && (e.questions || replyText(e.text))) {
      // A form always shows; plain text only as the turn's last word.
      if (last !== null && entries[last].questions) flush();
      last = i;
      continue;
    }
    if (e.role === "user" && (e.kind === "text" || e.kind === "board")) {
      form = undefined;
      flush();
      if (userTyped(e) && e.text.trim()) out.push({ stepId, uuid: e.uuid, at: e.at, role: "user", text: e.text.trim() });
    }
  }
  // The turn going on now shows once it ends (its last message may still change).
  if (!running) flush();
  return out;
}

