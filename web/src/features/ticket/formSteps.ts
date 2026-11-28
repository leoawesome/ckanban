/** The phone's one-question-at-a-time form and the chat's "Answer N questions" chip: step rules only (no React, so they can be unit tested). */
import type { Answer } from "./questionForms";

/** Wait after a pick-one tap before moving on, so the user sees their pick land. */
export const AUTO_NEXT_MS = 250;

/** Whether a form shows one question per step with a progress bar (phone, two or more questions). */
export const stepped = (phone: boolean, total: number) => phone && total > 1;

/** Nothing picked or typed: the step's main button says Skip, not Next. */
export const isEmpty = (a: Answer) => !a.picked.length && !(a.otherOn && a.other.trim());

/** The main button's label on a question step. */
export const nextLabel = (a: Answer) => (isEmpty(a) ? "Skip" : "Next");

/**
 * The step to move to on its own after a tap on an option, or null to stay. Only a pick-one question moves on, and
 * only when the tap picked the option (not on a multi-select, where the user may pick more). The last question moves to
 * the "Check your answers" step (step === total).
 */
export function autoNext(step: number, total: number, multi: boolean | undefined, after: Answer, label: string): number | null {
  if (multi || step >= total || !after.picked.includes(label)) return null;
  return step + 1;
}

/** Next or Skip: on to the next question, then to "Check your answers". */
export const nextStep = (step: number, total: number) => Math.min(step + 1, total);

/** Back: the question before (none before the first). */
export const backStep = (step: number) => Math.max(step - 1, 0);

/** The progress bar: one segment per question, "done" before the current step (all of them on Check your answers). */
export function segments(step: number, total: number): ("done" | "cur" | "todo")[] {
  return Array.from({ length: total }, (_, i) => (i < step ? "done" : i === step ? "cur" : "todo"));
}

/** The words beside the bar: "2 of 3", or "Check" on the last step. */
export const progressText = (step: number, total: number) => (step >= total ? "Check" : `${step + 1} of ${total}`);

/**
 * The chip over the message box: its label while an open form waits out of view, else null (hidden). barForForm: the
 * phone's "Your turn" bar shows for that form, and its button already leads there, so the chip stays hidden (one control).
 */
export function waitingChip(questions: number | null, formOnScreen: boolean, barForForm = false): string | null {
  if (!questions || formOnScreen || barForForm) return null;
  return `Answer ${questions} question${questions > 1 ? "s" : ""}`;
}
