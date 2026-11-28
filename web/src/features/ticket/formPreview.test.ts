// A mockup previewed from a questions form (web/src/features/ticket/formPreview.ts): Back returns to the chat, the
// preview flips through that question's mockups, and "Use this design" picks into the form's saved progress.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { formKey, loadSaved, save, type Store } from "../../lib/drafts";
import { layersOf, openBackEntry, resetBackEntries } from "../../app/backEntry";
import { closeOutput, flipTo, isPicked, loadProgress, openOutput, pickFromPreview, previewOptions, type FormPreview } from "./formPreview";
import type { Progress } from "./questionForms";

function memStore(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
    key: (i) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
}

const questions: FormPreview["questions"] = [
  { question: "Which landing page?", options: [
    { label: "a: warm", mockup: "a.html" }, { label: "b: grid" }, { label: "c: dark", mockup: "c.html" }, { label: "d: plain", mockup: "d.html" },
  ] },
  { question: "Which extras?", multiSelect: true, options: [{ label: "FAQ", mockup: "faq.html" }, { label: "Prices", mockup: "prices.html" }] },
];
const key = formKey("b", "t1", "u1");
const from = (step: number): FormPreview => ({ key, questions, step });

test("flip: only that question's options with a mockup, wrapping both ways", () => {
  const list = previewOptions(from(0));
  expect(list.map((o) => o.file)).toEqual(["mockups/a.html", "mockups/c.html", "mockups/d.html"]); // b has none: skipped
  expect(flipTo(list, "mockups/a.html", 1)).toBe("mockups/c.html");
  expect(flipTo(list, "mockups/d.html", 1)).toBe("mockups/a.html");
  expect(flipTo(list, "mockups/a.html", -1)).toBe("mockups/d.html");
  expect(flipTo(list, "mockups/x.html", 1)).toBe("mockups/x.html");
  // A mockup missing from the outputs folder is skipped too.
  expect(previewOptions(from(0), new Set(["mockups/a.html", "mockups/d.html"])).map((o) => o.label)).toEqual(["a: warm", "d: plain"]);
  expect(previewOptions(from(1)).map((o) => o.label)).toEqual(["FAQ", "Prices"]);
});

test("flip: a mockup saved at the outputs root is used where it is", () => {
  expect(previewOptions(from(0), new Set(["a.html", "mockups/c.html"])).map((o) => o.file)).toEqual(["a.html", "mockups/c.html"]);
});

test("Use this design: picks the option in the form's saved progress, on that question", () => {
  const store = memStore();
  // A new form starts on its first option; the user had typed a note and moved to question 2.
  save(store, key, { ...loadProgress(store, from(0)), step: 1, note: "hi" } satisfies Progress);
  expect(isPicked(store, from(0), "a: warm")).toBe(true);
  expect(isPicked(store, from(0), "c: dark")).toBe(false);
  pickFromPreview(store, from(0), "c: dark");
  const p = loadSaved<Progress>(store, key)!;
  expect(p.answers[0].picked).toEqual(["c: dark"]);
  expect(p.step).toBe(0); // the chat shows the question the preview was for
  expect(p.note).toBe("hi"); // nothing else lost
  expect(isPicked(store, from(0), "c: dark")).toBe(true);
});

test("Use this design: one-answer questions drop typed text; many-answer questions toggle", () => {
  const store = memStore();
  const start = loadProgress(store, from(0));
  save(store, key, { ...start, answers: [{ picked: [], otherOn: true, other: "my own" }, start.answers[1]] });
  pickFromPreview(store, from(0), "d: plain");
  expect(loadSaved<Progress>(store, key)!.answers[0]).toEqual({ picked: ["d: plain"], otherOn: false, other: "my own" });

  pickFromPreview(store, from(1), "Prices");
  pickFromPreview(store, from(1), "FAQ");
  expect(loadSaved<Progress>(store, key)!.answers[1].picked).toEqual(["Prices", "FAQ"]);
  pickFromPreview(store, from(1), "Prices");
  expect(loadSaved<Progress>(store, key)!.answers[1].picked).toEqual(["FAQ"]);
});

test("Use this design: a pick that leaves the form as new keeps nothing saved, as the form itself does", () => {
  const store = memStore();
  pickFromPreview(store, from(0), "a: warm"); // already the starting pick
  expect(store.data.has(key)).toBe(false);
});

// Back to the chat: the ticket panel's Outputs state and the reader's history entry together.
function fakeHistory() {
  const entries: unknown[] = [{ ckDepth: 1 }];
  let at = 0;
  const pops: (() => void)[] = [];
  const h = {
    get state() { return entries[at]; },
    pushState(state: unknown) { entries.splice(at + 1); entries.push(structuredClone(state)); at++; },
    replaceState(state: unknown) { entries[at] = structuredClone(state); },
    go(n: number) { setTimeout(() => { at = Math.max(0, Math.min(entries.length - 1, at + n)); pops.forEach((f) => f()); }, 0); },
    back() { h.go(-1); },
    get length() { return entries.length; },
  };
  return { h, win: { addEventListener: (t: string, f: () => void) => { if (t === "popstate") pops.push(f); } } };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const g = globalThis as any;
const saved = { history: g.history, window: g.window };
let env: ReturnType<typeof fakeHistory>;
beforeEach(() => {
  env = fakeHistory();
  g.history = env.h;
  g.window = env.win;
  resetBackEntries();
});
afterEach(() => {
  g.history = saved.history;
  g.window = saved.window;
});

/** The panel as TicketDrawer drives it: the open reader holds one Back entry; closing it applies closeOutput. */
function panel() {
  let s = { tab: "chat", file: null as string | null, form: null as FormPreview | null };
  let closeEntry: (() => void) | null = null;
  const close = () => { s = closeOutput(s); };
  return {
    get state() { return s; },
    open(name: string, form: FormPreview | null) {
      s = openOutput(name, form);
      closeEntry = openBackEntry(close);
    },
    /** The reader's back button or Esc: closes, and its entry is gone right after. */
    backButton() { close(); closeEntry?.(); },
  };
}

test("Back from a preview opened from a form returns to the Chat tab and leaves no history entry behind", async () => {
  const p = panel();
  p.open("mockups/a.html", from(0));
  expect(p.state.tab).toBe("outputs");
  expect(env.h.length).toBe(2); // one entry: the reader's
  env.h.back(); // phone swipe or browser Back
  await tick();
  expect(p.state).toEqual({ tab: "chat", file: null, form: null });
  expect(layersOf(env.h.state)).toEqual([]);

  // The back button (or Esc) does the same and goes back over the entry itself.
  p.open("mockups/a.html", from(0));
  p.backButton();
  await tick();
  expect(p.state.tab).toBe("chat");
  expect(layersOf(env.h.state)).toEqual([]);
});

test("A file opened in Outputs itself still closes to the Outputs list", async () => {
  const p = panel();
  p.open("report.md", null);
  env.h.back();
  await tick();
  expect(p.state).toEqual({ tab: "outputs", file: null, form: null });
});
