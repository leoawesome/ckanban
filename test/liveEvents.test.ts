// Shared live connection across board tabs (web/src/liveEvents.ts): one leader tab opens the EventSource,
// the others hear events on a BroadcastChannel, handover and reconnects make every tab refetch.
import { expect, test } from "bun:test";
import { createLive, type ChannelLike, type LocksLike, type SourceLike } from "../web/src/liveEvents";

type Waiter = { cb: (lock: unknown) => unknown; tab: Tab };
type Tab = { closed: boolean; sources: FakeSource[]; channel?: FakeChannel };

/** One browser: a lock manager and a channel bus shared by its tabs. */
function browser() {
  let holder: Tab | null = null;
  const queue: Waiter[] = [];
  const channels: FakeChannel[] = [];
  const grantNext = () => {
    while (!holder && queue.length) {
      const w = queue.shift()!;
      if (w.tab.closed) continue;
      holder = w.tab;
      w.cb({});
    }
  };
  const locksFor = (tab: Tab): LocksLike => ({
    async request(_name, opts, cb) {
      if (!holder) {
        holder = tab;
        return cb({});
      }
      if (opts.ifAvailable) return cb(null);
      queue.push({ cb, tab });
    },
  });
  const close = (tab: Tab) => {
    tab.closed = true;
    if (tab.channel) channels.splice(channels.indexOf(tab.channel), 1);
    if (holder === tab) {
      holder = null;
      grantNext();
    }
  };
  return { channels, locksFor, close };
}

class FakeChannel implements ChannelLike {
  onmessage: ChannelLike["onmessage"] = null;
  constructor(private all: FakeChannel[]) {
    all.push(this);
  }
  postMessage(msg: unknown) {
    for (const c of this.all) if (c !== this) c.onmessage?.({ data: structuredClone(msg) });
  }
}

class FakeSource implements SourceLike {
  onmessage: SourceLike["onmessage"] = null;
  onerror: SourceLike["onerror"] = null;
  onopen: SourceLike["onopen"] = null;
  send(e: unknown) {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}

function openTab(b: ReturnType<typeof browser> | null) {
  const tab: Tab = { closed: false, sources: [] };
  const live = createLive<{ n: number }>({
    makeSource: () => {
      const s = new FakeSource();
      tab.sources.push(s);
      return s;
    },
    locks: b ? b.locksFor(tab) : null,
    makeChannel: b ? () => (tab.channel = new FakeChannel(b.channels)) : null,
  });
  const got: number[] = [];
  let refetches = 0;
  live.subscribe((e) => got.push(e.n));
  live.onReconnect(() => refetches++);
  return { tab, live, got, refetches: () => refetches };
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
