import { afterAll, expect, test } from "bun:test";

// cardMotion.ts with a stub IntersectionObserver: off-screen cards get data-still, the open ticket narrows the
// observer's root, and a ticket over the whole width pauses the whole board through a class.
const observers: FakeIO[] = [];
class FakeIO {
  targets = new Set<FakeEl>();
  constructor(public cb: (e: { target: FakeEl; isIntersecting: boolean }[]) => void, public opts: { rootMargin: string }) { observers.push(this); }
  observe(el: FakeEl) { this.targets.add(el); }
  unobserve(el: FakeEl) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
}
class FakeEl {
  attrs = new Set<string>();
  toggleAttribute(n: string, on: boolean) { on ? this.attrs.add(n) : this.attrs.delete(n); }
  removeAttribute(n: string) { this.attrs.delete(n); }
}
const classes = new Set<string>();
const g = globalThis as any;
const saved = { IntersectionObserver: g.IntersectionObserver, window: g.window, document: g.document };
afterAll(() => Object.assign(g, saved));
g.IntersectionObserver = FakeIO;
g.window = { innerWidth: 1280 };
g.document = { documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) } } };
// A path tsc doesn't follow: the root typecheck has no DOM types (web/ has its own tsconfig).
const motionPath = "../web/src/cardMotion";
const { watchMotion, setCoveredFrom } = await import(motionPath);
const live = () => observers[observers.length - 1];

test("off-screen cards are marked still, and unwatching clears the mark", () => {
  const a = new FakeEl(), b = new FakeEl();
  const stopA = watchMotion(a as any); watchMotion(b as any);
  live().cb([{ target: a, isIntersecting: false }, { target: b, isIntersecting: true }]);
  expect(a.attrs.has("data-still")).toBe(true);
  expect(b.attrs.has("data-still")).toBe(false);
  stopA();
  expect(a.attrs.has("data-still")).toBe(false);
  expect(live().targets.has(a)).toBe(false);
});

test("an open ticket narrows the root to the part it leaves showing; full width pauses the board", () => {
  setCoveredFrom(360);
  expect(live().opts.rootMargin).toBe("0px -920px 0px 0px");
  expect(live().targets.size).toBe(1);
  expect(classes.has("ck-board-covered")).toBe(false);
  setCoveredFrom(0);
  expect(classes.has("ck-board-covered")).toBe(true);
  setCoveredFrom(null);
  expect(classes.has("ck-board-covered")).toBe(false);
  expect(live().opts.rootMargin).toBe("0px -0px 0px 0px");
});
