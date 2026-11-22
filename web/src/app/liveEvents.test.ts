// Shared live connection across board tabs (web/src/app/liveEvents.ts): one leader tab opens the EventSource,
// the others hear events on a BroadcastChannel, handover and reconnects make every tab refetch.
import { expect, test } from "bun:test";
import { createLive, type ChannelLike, type LocksLike, type PageLike, type SourceLike, type TimersLike, STALE_MS, REOPEN_MS } from "./liveEvents";

type Req = { cb: (lock: unknown) => unknown; tab: Tab; resolve: (v: unknown) => void; reject: (e: unknown) => void; signal?: FakeAbort["signal"] };
type Tab = { closed: boolean; frozen?: boolean; sources: FakeSource[]; channel?: FakeChannel };

/** One browser: a lock manager (with steal and abort, like Web Locks) and a channel bus shared by its tabs. */
function browser() {
  let holder: Req | null = null;
  const queue: Req[] = [];
  const channels: FakeChannel[] = [];
  const grant = (r: Req) => {
    holder = r;
    Promise.resolve(r.cb({})).then(
      (v) => {
        if (holder === r) {
          holder = null;
          grantNext();
        }
        r.resolve(v);
      },
      r.reject,
    );
  };
  const grantNext = () => {
    while (!holder && queue.length) {
      const r = queue.shift()!;
      if (r.tab.closed) continue;
      grant(r);
    }
  };
  const locksFor = (tab: Tab): LocksLike => ({
    request(_name, opts, cb) {
      return new Promise((resolve, reject) => {
        const r: Req = { cb, tab, resolve, reject, signal: opts.signal as Req["signal"] };
        if (opts.steal) {
          const old = holder;
          holder = null;
          old?.reject(new Error("AbortError: stolen"));
          return grant(r);
        }
        if (!holder) return grant(r);
        if (opts.ifAvailable) return Promise.resolve(cb(null)).then(resolve, reject);
        queue.push(r);
        r.signal?.on(() => {
          const i = queue.indexOf(r);
          if (i >= 0) queue.splice(i, 1);
          reject(new Error("AbortError"));
        });
      });
    },
  });
  const close = (tab: Tab) => {
    tab.closed = true;
    if (tab.channel) channels.splice(channels.indexOf(tab.channel), 1);
    if (holder?.tab === tab) {
      holder = null;
      grantNext();
    }
  };
  const holderTab = () => holder?.tab ?? null;
  return { channels, locksFor, close, holderTab };
}

class FakeAbort {
  private fns: (() => void)[] = [];
  signal = { on: (fn: () => void) => this.fns.push(fn) };
  abort() {
    for (const f of this.fns.splice(0)) f();
  }
}

/** Fake clock: `advance` runs due intervals and timeouts in order. */
function clock() {
  let now = 0;
  let next = 1;
  const jobs = new Map<number, { at: number; every: number | null; fn: () => void }>();
  const timers: TimersLike = {
    now: () => now,
    setInterval: (fn, ms) => (jobs.set(next, { at: now + ms, every: ms, fn }), next++),
    clearInterval: (id) => void jobs.delete(id as number),
    setTimeout: (fn, ms) => (jobs.set(next, { at: now + ms, every: null, fn }), next++),
  };
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      let due: [number, { at: number; every: number | null; fn: () => void }] | null = null;
      for (const e of jobs) if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e;
      if (!due) break;
      const [id, j] = due;
      now = j.at;
      if (j.every === null) jobs.delete(id);
      else j.at += j.every;
      j.fn();
      await tick();
    }
    now = end;
    await tick();
  }
  return { timers, advance };
}

class FakeChannel implements ChannelLike {
  onmessage: ChannelLike["onmessage"] = null;
  constructor(private all: FakeChannel[], private tab?: Tab) {
    all.push(this);
  }
  postMessage(msg: unknown) {
    if (this.tab?.frozen) return;
    for (const c of this.all) if (c !== this && !c.tab?.frozen) c.onmessage?.({ data: structuredClone(msg) });
  }
}

class FakeSource implements SourceLike {
  onmessage: SourceLike["onmessage"] = null;
  onerror: SourceLike["onerror"] = null;
  onopen: SourceLike["onopen"] = null;
  readyState = 0;
  closed = false;
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  send(e: unknown) {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}

/** A tab's page: on screen or not, and its freeze/resume events. */
function fakePage(visible = true) {
  const fns: Record<string, (() => void)[]> = { visible: [], freeze: [], resume: [] };
  const page: PageLike & { show(): void; hide(): void; fire(e: "freeze" | "resume"): void } = {
    visible: () => visible,
    on: (e, fn) => void fns[e].push(fn),
    show() {
      visible = true;
      for (const f of fns.visible) f();
    },
    hide() {
      visible = false;
    },
    fire(e) {
      for (const f of fns[e]) f();
    },
  };
  return page;
}

function openTab(b: ReturnType<typeof browser> | null, opts: { timers?: TimersLike; page?: ReturnType<typeof fakePage> } = {}) {
  const tab: Tab = { closed: false, sources: [] };
  const live = createLive<{ n: number }>({
    makeSource: () => {
      const s = new FakeSource();
      tab.sources.push(s);
      return s;
    },
    locks: b ? b.locksFor(tab) : null,
    makeChannel: b ? () => (tab.channel = new FakeChannel(b.channels, tab)) : null,
    timers: opts.timers,
    page: opts.page,
    makeAbort: () => new FakeAbort(),
  });
  const got: number[] = [];
  let refetches = 0;
  live.subscribe((e) => got.push(e.n));
  live.onReconnect(() => refetches++);
  /** The tab's live connection: the last one it opened, if still open. */
  const src = () => {
    const s = tab.sources.at(-1);
    return s && !s.closed ? s : null;
  };
  return { tab, live, got, refetches: () => refetches, src };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("only the first tab opens a connection; others get its events", async () => {
  const b = browser();
  const tabs = [openTab(b), openTab(b), openTab(b), openTab(b), openTab(b), openTab(b), openTab(b)];
  await tick();
  expect(tabs.map((t) => t.tab.sources.length)).toEqual([1, 0, 0, 0, 0, 0, 0]);
  tabs[0].tab.sources[0].onopen?.({});
  tabs[0].tab.sources[0].send({ n: 1 });
  for (const t of tabs) expect(t.got).toEqual([1]);
  for (const t of tabs) expect(t.refetches()).toBe(0);
});

test("leader closes: next tab opens the connection and every tab refetches", async () => {
  const b = browser();
  const a = openTab(b), x = openTab(b), y = openTab(b);
  await tick();
  a.tab.sources[0].onopen?.({});
  b.close(a.tab);
  await tick();
  expect(x.tab.sources.length).toBe(1);
  expect(y.tab.sources.length).toBe(0);
  expect(x.live.isLeader()).toBe(true);
  x.tab.sources[0].onopen?.({});
  expect(x.refetches()).toBe(1);
  expect(y.refetches()).toBe(1);
  x.tab.sources[0].send({ n: 2 });
  expect(y.got).toEqual([2]);
  expect(a.got).toEqual([]);
});

test("leader's connection drops and comes back: every tab refetches", async () => {
  const b = browser();
  const a = openTab(b), x = openTab(b);
  await tick();
  const s = a.tab.sources[0];
  s.onopen?.({});
  s.onerror?.({});
  s.onerror?.({});
  s.onopen?.({});
  expect(a.refetches()).toBe(1);
  expect(x.refetches()).toBe(1);
  s.onopen?.({});
  expect(a.refetches()).toBe(1);
});

test("no Web Locks or BroadcastChannel: each tab opens its own connection", async () => {
  const a = openTab(null), x = openTab(null);
  await tick();
  expect(a.tab.sources.length).toBe(1);
  expect(x.tab.sources.length).toBe(1);
  const s = a.tab.sources[0];
  s.onopen?.({});
  s.send({ n: 3 });
  expect(a.got).toEqual([3]);
  expect(x.got).toEqual([]);
  s.onerror?.({});
  s.onopen?.({});
  expect(a.refetches()).toBe(1);
});

test("lock request fails: falls back to its own connection", async () => {
  const tab: Tab = { closed: false, sources: [] };
  const live = createLive<{ n: number }>({
    makeSource: () => {
      const s = new FakeSource();
      tab.sources.push(s);
      return s;
    },
    locks: { request: () => Promise.reject(new Error("SecurityError")) },
    makeChannel: () => new FakeChannel([]),
  });
  const got: number[] = [];
  live.subscribe((e) => got.push(e.n));
  await tick();
  expect(tab.sources.length).toBe(1);
  tab.sources[0].send({ n: 4 });
  expect(got).toEqual([4]);
});

test("leader keeps beating: followers never take over", async () => {
  const b = browser();
  const c = clock();
  const a = openTab(b, { timers: c.timers }), x = openTab(b, { timers: c.timers });
  await tick();
  await c.advance(60_000);
  expect(a.live.isLeader()).toBe(true);
  expect(x.tab.sources.length).toBe(0);
});

test("leader goes quiet (frozen without notice): a visible tab takes over, the old connection closes, all refetch", async () => {
  const b = browser();
  const c = clock();
  const hiddenPage = fakePage(false);
  const a = openTab(b, { timers: c.timers }), x = openTab(b, { timers: c.timers }), h = openTab(b, { timers: c.timers, page: hiddenPage });
  await tick();
  a.src()!.onopen?.({});
  a.tab.frozen = true; // its posts no longer reach anyone
  await c.advance(STALE_MS - 1000);
  expect(x.tab.sources.length).toBe(0);
  await c.advance(2000);
  expect(x.live.isLeader()).toBe(true);
  expect(b.holderTab()).toBe(x.tab);
  expect(a.live.isLeader()).toBe(false);
  expect(a.src()).toBe(null);
  expect(h.tab.sources.length).toBe(0);
  x.src()!.onopen?.({});
  expect(x.refetches()).toBe(1);
  expect(h.refetches()).toBe(1);
  x.src()!.send({ n: 7 });
  expect(h.got).toEqual([7]);
  // The old leader lost the lock while quiet: it refetches once. Waking, it follows the new one and gets its events.
  expect(a.refetches()).toBe(1);
  a.tab.frozen = false;
  x.src()!.send({ n: 8 });
  expect(a.got).toEqual([8]);
  await c.advance(30_000);
  expect(a.tab.sources.length).toBe(1);
  expect(x.tab.sources.length).toBe(1);
});

test("a hidden tab waits; when it comes to the front after silence it takes over at once", async () => {
  const b = browser();
  const c = clock();
  const page = fakePage(false);
  const a = openTab(b, { timers: c.timers }), x = openTab(b, { timers: c.timers, page });
  await tick();
  a.tab.frozen = true;
  await c.advance(20_000);
  expect(x.tab.sources.length).toBe(0);
  page.show();
  await tick();
  expect(x.live.isLeader()).toBe(true);
  expect(x.tab.sources.length).toBe(1);
});

test("leader frozen with notice: it lets the lock go, the next tab leads, and on resume it refetches and follows", async () => {
  const b = browser();
  const c = clock();
  const pa = fakePage();
  const a = openTab(b, { timers: c.timers, page: pa }), x = openTab(b, { timers: c.timers });
  await tick();
  a.src()!.onopen?.({});
  pa.fire("freeze");
  a.tab.frozen = true;
  await tick();
  expect(a.src()).toBe(null);
  expect(x.live.isLeader()).toBe(true);
  x.src()!.onopen?.({});
  expect(x.refetches()).toBe(1);
  a.tab.frozen = false;
  pa.fire("resume");
  await tick();
  expect(a.refetches()).toBe(1);
  expect(a.live.isLeader()).toBe(false);
  x.src()!.send({ n: 9 });
  expect(a.got).toEqual([9]);
  // a is back in line: when x closes, a leads.
  b.close(x.tab);
  await tick();
  expect(a.live.isLeader()).toBe(true);
  expect(a.tab.sources.length).toBe(2);
});

test("a follower frozen in line is skipped: it left the line, so the lock goes to an awake tab", async () => {
  const b = browser();
  const c = clock();
  const px = fakePage();
  const a = openTab(b, { timers: c.timers }), x = openTab(b, { timers: c.timers, page: px }), y = openTab(b, { timers: c.timers });
  await tick();
  px.fire("freeze");
  await tick();
  b.close(a.tab);
  await tick();
  expect(x.tab.sources.length).toBe(0);
  expect(y.live.isLeader()).toBe(true);
});

test("the connection gives up after an error answer: the leader reopens it and every tab refetches", async () => {
  const b = browser();
  const c = clock();
  const a = openTab(b, { timers: c.timers }), x = openTab(b, { timers: c.timers });
  await tick();
  const s = a.src()!;
  s.onopen?.({});
  s.readyState = 2;
  s.onerror?.({});
  await c.advance(REOPEN_MS + 10);
  expect(a.tab.sources.length).toBe(2);
  expect(s.closed).toBe(true);
  a.src()!.onopen?.({});
  expect(a.refetches()).toBe(1);
  expect(x.refetches()).toBe(1);
});

test("two quiet periods in a row: only one connection is open at a time", async () => {
  const b = browser();
  const c = clock();
  const a = openTab(b, { timers: c.timers }), x = openTab(b, { timers: c.timers }), y = openTab(b, { timers: c.timers, page: fakePage(false) });
  await tick();
  a.tab.frozen = true;
  await c.advance(STALE_MS + 1000);
  expect(x.live.isLeader()).toBe(true);
  x.tab.frozen = true;
  a.tab.frozen = false;
  await c.advance(STALE_MS + 1000);
  expect(a.live.isLeader()).toBe(true);
  const open = [a, x, y].filter((t) => t.src()).length;
  expect(open).toBe(1);
  expect(y.tab.sources.length).toBe(0);
});
