/**
 * A mockup previewed from a questions form (an option's Preview link): which question it belongs to, flipping
 * through that question's mockups, and picking the shown one into the form's saved progress (the same store the
 * form loads from when the chat shows again). No React or DOM, so it can be unit tested.
 */
import { forget, loadSaved, save, type Store } from "../../lib/drafts";
import { type Answer, fresh, type Progress, startProgress } from "./questionForms";

// Only the fields used here (structurally the same as api.ts's), so the root typecheck and bun tests can load this file.
interface Question {
  question: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; recommended?: boolean; mockup?: string }[];
}

/** Where a preview came from: the form's saved-progress key, its questions, and the question the Preview was on. */
export interface FormPreview {
  key: string;
  questions: Question[];
  step: number;
}

/** Path of an option's mockup in the outputs folder. */
export const mockupPath = (mockup: string) => `mockups/${mockup}`;

/** The question's options that have a mockup (others are skipped), in order, with their file path. */
export function previewOptions(from: FormPreview, files?: ReadonlySet<string>): { label: string; file: string }[] {
  const q = from.questions[from.step];
  if (!q) return [];
  return q.options.filter((o) => o.mockup && (!files || files.has(mockupPath(o.mockup))))
    .map((o) => ({ label: o.label, file: mockupPath(o.mockup!) }));
}

/** The file `by` steps from `file` among `list`, wrapping round; `file` itself when it isn't in the list. */
export function flipTo(list: { file: string }[], file: string, by: number): string {
  const at = list.findIndex((o) => o.file === file);
  if (at < 0 || !list.length) return file;
  return list[(at + by + list.length * Math.abs(by)) % list.length].file;
}

/** One option picked as the form's own option buttons do it: one-answer questions take only it, many-answer ones toggle it. */
export function pickAnswer(a: Answer, label: string, multiSelect?: boolean): Answer {
  if (multiSelect) return { ...a, picked: a.picked.includes(label) ? a.picked.filter((l) => l !== label) : [...a.picked, label] };
  return { ...a, picked: [label], otherOn: false };
}

/** The form's progress as it would show now: saved, or where a new form starts. */
export function loadProgress(store: Store | null, from: FormPreview): Progress {
  return startProgress(from.questions, loadSaved<Progress>(store, from.key));
}

/** Whether `label` is picked on the preview's question. */
export function isPicked(store: Store | null, from: FormPreview, label: string): boolean {
  return !!loadProgress(store, from).answers[from.step]?.picked.includes(label);
}

/**
 * Picks `label` on the preview's question and saves it where the form reads it, on that question. Kept or removed
 * the way the form's own saving does (progress equal to a new form's is not kept).
 */
export function pickFromPreview(store: Store | null, from: FormPreview, label: string): Progress {
  const p = loadProgress(store, from);
  const q = from.questions[from.step];
  if (!q || !p.answers[from.step]) return p;
  const next: Progress = { ...p, step: from.step, answers: p.answers.map((a, i) => (i === from.step ? pickAnswer(a, label, q.multiSelect) : a)) };
  if (JSON.stringify(next) === JSON.stringify(fresh(from.questions))) forget(store, from.key);
  else save(store, from.key, next);
  return next;
}

/** The ticket panel's Outputs state: the tab, the file asked for, and the form it was previewed from (null: not from a form). */
export interface OutputOpen { tab: string; file: string | null; form: FormPreview | null }

/** A file link in the chat (a form option's Preview passes its form): Outputs opens on that file. */
export const openOutput = (name: string, form: FormPreview | null = null): OutputOpen => ({ tab: "outputs", file: name, form });

/**
 * Closing the reader (Back, its back button, Esc): one opened from a form goes back to the Chat tab, where the chat
 * lands on that open form with its picks; otherwise it stays in Outputs, back on the list.
 */
export const closeOutput = (s: OutputOpen): OutputOpen => (s.form ? { tab: "chat", file: null, form: null } : { ...s, file: null });
