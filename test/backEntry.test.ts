// The phone's Back gesture closes the layer on top (web/src/backEntry.ts): each layer adds a history entry; Back pops
// only the top one, and closing a layer another way goes back over its entry so none is left behind.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { layersOf, openBackEntry, resetBackEntries } from "../web/src/backEntry";

/** A browser history: entries with state, go() fires popstate later, like a real browser. */
function fakeHistory() {
  const entries: unknown[] = [{ ckDepth: 1, ckBoard: "b" }];
  let at = 0;
  const pops: (() => void)[] = [];
  const h = {
    get state() { return entries[at]; },
    pushState(state: unknown) { entries.splice(at + 1); entries.push(structuredClone(state)); at++; },
    replaceState(state: unknown) { entries[at] = structuredClone(state); },
    go(n: number) { setTimeout(() => { at = Math.max(0, Math.min(entries.length - 1, at + n)); pops.forEach((f) => f()); }, 0); },
    back() { h.go(-1); },
    get length() { return entries.length; },
    get index() { return at; },
  };
  const win = { addEventListener: (t: string, f: () => void) => { if (t === "popstate") pops.push(f); }, removeEventListener() {} };
  return { h, win, pops };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
let env: ReturnType<typeof fakeHistory>;
const g = globalThis as any;
const saved = { history: g.history, window: g.window };

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

test("Back closes only the top layer; the one under it stays and gets its turn next", async () => {
  const closed: string[] = [];
  openBackEntry(() => closed.push("dialog"));
  openBackEntry(() => closed.push("confirm"));
  expect(layersOf(env.h.state)).toHaveLength(2);
  expect((env.h.state as any).ckDepth).toBe(3); // ticketHistory goes back over both entries too
  env.h.back();
  await tick();
  expect(closed).toEqual(["confirm"]);
  env.h.back();
  await tick();
  expect(closed).toEqual(["confirm", "dialog"]);
  expect(env.h.index).toBe(0);
});

test("closing with × goes back over the entry and closes nothing else", async () => {
  const closed: string[] = [];
  openBackEntry(() => closed.push("dialog"));
  const closeConfirm = openBackEntry(() => closed.push("confirm"));
  closeConfirm();
  await tick();
  expect(env.h.index).toBe(1);
  expect(closed).toEqual([]);
});

test("two layers closing at once go back over both entries in one step", async () => {
  const closed: string[] = [];
  const closeDialog = openBackEntry(() => closed.push("dialog"));
  const closeConfirm = openBackEntry(() => closed.push("confirm"));
  closeConfirm();
  closeDialog();
  await tick();
  expect(env.h.index).toBe(0);
  expect(closed).toEqual([]);
});

test("a layer closed after something else took over history (a ticket opened from it) goes back over nothing", async () => {
  const closeDialog = openBackEntry(() => {});
  env.h.pushState({ ckDepth: 1, ckBoard: "b" });
  closeDialog();
  await tick();
  expect(env.h.index).toBe(2);
});

test("Back that pops a layer the page is closing anyway doesn't close the layer under it", async () => {
  const closed: string[] = [];
  openBackEntry(() => closed.push("dialog"));
  const closeConfirm = openBackEntry(() => closed.push("confirm"));
  closeConfirm(); // the module's own step back: its popstate is ignored
  await tick();
  expect(closed).toEqual([]);
  env.h.back(); // the user's Back now closes the dialog
  await tick();
  expect(closed).toEqual(["dialog"]);
});

test("a sheet item that opens a dialog in the same moment: the dialog takes over the sheet's entry (More sheet)", async () => {
  const closed: string[] = [];
  const closeSheet = openBackEntry(() => closed.push("sheet"));
  expect(env.h.index).toBe(1);
  // The item's click: the sheet closes and its dialog opens in one render (sheet cleanup first, then the dialog's push).
  closeSheet();
  openBackEntry(() => closed.push("dialog"));
  await tick();
  expect(env.h.index).toBe(1);
  expect(env.h.length).toBe(2);
  expect((env.h.state as any).ckDepth).toBe(2);
  // Back closes the dialog and lands on the board, with no dead entry left for a second Back.
  env.h.back();
  await tick();
  expect(closed).toEqual(["dialog"]);
  expect(env.h.index).toBe(0);
  expect(layersOf(env.h.state)).toEqual([]);
});

test("closing the sheet with × leaves no entry behind; Back then goes where it would have without the sheet", async () => {
  const closeSheet = openBackEntry(() => {});
  closeSheet();
  await tick();
  expect(env.h.index).toBe(0);
  // A dialog opened later stacks normally on the board's entry.
  const closed: string[] = [];
  openBackEntry(() => closed.push("dialog"));
  expect(env.h.index).toBe(1);
  env.h.back();
  await tick();
  expect(closed).toEqual(["dialog"]);
  expect(env.h.index).toBe(0);
});
