// Back on the installed app's main screen shows a note first (web/src/app/exitGuard.ts); a second Back leaves.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { openBackEntry, resetBackEntries } from "./backEntry";
import { GUARD_MS, resetExitGuard, startExitGuard } from "./exitGuard";

/** A browser history; go() fires popstate later, like a real browser. Going back from the first entry leaves the app. */
function fakeEnv() {
  const entries: unknown[] = [null];
  let at = 0;
  let left = false;
  const subs: Record<string, ((e: unknown) => void)[]> = {};
  const fire = (type: string, e: unknown = {}) => (subs[type] ?? []).slice().forEach((f) => f(e));
  const h = {
    get state() { return entries[at]; },
    pushState(state: unknown) { entries.splice(at + 1); entries.push(structuredClone(state)); at++; },
    replaceState(state: unknown) { entries[at] = structuredClone(state); },
    go(n: number) {
      setTimeout(() => {
        if (at + n < 0) { left = true; return; }
        at = Math.min(entries.length - 1, at + n);
        fire("popstate");
      }, 0);
    },
    back() { h.go(-1); },
  };
  const win = {
    addEventListener: (t: string, f: (e: unknown) => void) => { (subs[t] ??= []).push(f); },
    removeEventListener: (t: string, f: (e: unknown) => void) => { subs[t] = (subs[t] ?? []).filter((x) => x !== f); },
  };
  return { h, win, fire, entries, get at() { return at; }, get left() { return left; } };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
let env: ReturnType<typeof fakeEnv>;
let clock = 1_000;
let notes = 0;
let main = true;
let stop: () => void;
const g = globalThis as any;
const saved = { history: g.history, window: g.window };
const tap = () => env.fire("pointerup");
const back = async () => { env.h.back(); await tick(); };

beforeEach(() => {
  env = fakeEnv();
  g.history = env.h;
  g.window = env.win;
  resetBackEntries();
  resetExitGuard();
  clock = 1_000;
  notes = 0;
  main = true;
  stop = startExitGuard({ enabled: () => true, atMain: () => main, warn: () => { notes++; }, now: () => clock });
});
afterEach(() => {
  stop();
  g.history = saved.history;
  g.window = saved.window;
});

test("nothing is added until a tap; then one guard entry under the main screen", () => {
  expect(env.entries.length).toBe(1);
  tap();
  expect(env.entries).toEqual([{ ckGuard: true }, { ckGuardTop: true }]);
  tap(); // never stacks
  env.fire("keydown", { key: "a" });
  expect(env.entries.length).toBe(2);
});

test("first Back on the main screen shows the note and stays; a second Back within the window leaves", async () => {
  tap();
  await back();
  expect(notes).toBe(1);
  expect(env.left).toBe(false);
  expect(env.at).toBe(0);
  clock += GUARD_MS - 100;
  tap(); // a tap inside the window doesn't bring the guard back
  expect(env.entries.length).toBe(2);
  expect(env.at).toBe(0);
  await back();
  expect(env.left).toBe(true);
  expect(notes).toBe(1);
});

test("after the window, the next tap brings the guard back (one entry), and Back shows the note again", async () => {
  tap();
  await back();
  clock += GUARD_MS + 1;
  expect(env.entries.length).toBe(2); // not without a tap
  env.fire("keydown", { key: "Escape" }); // Esc isn't a user gesture for Chrome
  expect(env.at).toBe(0);
  tap();
  expect(env.at).toBe(1);
  expect(env.entries).toEqual([{ ckGuard: true }, { ckGuardTop: true }]);
  await back();
  expect(notes).toBe(2);
  expect(env.left).toBe(false);
});

test("Back with a layer open closes only the layer; the next Back shows the note", async () => {
  tap();
  main = false;
  let closed = 0;
  openBackEntry(() => { closed++; });
  await back();
  expect(closed).toBe(1);
  expect(notes).toBe(0);
  expect(env.at).toBe(1);
  main = true;
  await back();
  expect(notes).toBe(1);
});

test("a layer closed with its × leaves no stale step: one Back shows the note, nothing stacks", async () => {
  tap();
  main = false;
  const close = openBackEntry(() => {});
  close();
  await tick();
  main = true;
  expect(env.at).toBe(1);
  tap();
  expect(env.at).toBe(1);
  await back();
  expect(notes).toBe(1);
  expect(env.at).toBe(0);
});

test("a ticket opened on the main screen closes back onto it, not onto the guard (ckDepth counts stay right)", async () => {
  tap();
  env.h.pushState({ ckDepth: 1, ckBoard: "b" }); // openTicket
  main = false;
  env.h.go(-1); // closeTicket goes back ckDepth entries
  await tick();
  main = true;
  expect(env.at).toBe(1);
  expect(notes).toBe(0);
});

test("not on the main screen or a normal browser tab: no guard", () => {
  main = false;
  tap();
  expect(env.entries.length).toBe(1);
  stop();
  resetExitGuard();
  main = true;
  stop = startExitGuard({ enabled: () => false, atMain: () => true, warn: () => { notes++; } });
  tap();
  expect(env.entries.length).toBe(1);
});

test("a ticket opened over the guard during the note's window closes onto it without another note", async () => {
  tap();
  await back();
  env.h.pushState({ ckDepth: 1, ckBoard: "b" });
  env.h.go(-1);
  await tick();
  expect(notes).toBe(1);
  clock += GUARD_MS + 1;
  tap();
  expect(env.entries).toEqual([{ ckGuard: true }, { ckGuardTop: true }]);
});

test("after a reload on the main screen the guard under it is reused", () => {
  tap();
  resetExitGuard(); // the page reloads: memory gone, history stays
  tap();
  expect(env.entries.length).toBe(2);
  expect(env.at).toBe(1);
});
