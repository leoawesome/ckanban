// One live update connection per browser, shared by every board tab.
// The board runs over plain http/1.1 where Chrome allows only 6 connections per origin across all tabs,
// so one EventSource per tab froze the board at 6 tabs. One tab (the leader, picked with a Web Lock) opens
// the EventSource and posts every event on a BroadcastChannel; the other tabs listen there. When the leader
// closes, a waiting tab takes the lock and opens the connection. Without Web Locks or BroadcastChannel
// (a phone over plain LAN http), every tab opens its own connection as before.
//
// A leader can go quiet while it still holds the lock: Chrome freezes or throttles background tabs, and an
// EventSource that got an error answer stops retrying for good. So the leader posts a heartbeat, and a visible
// tab that hears nothing for STALE_MS takes the lock over (steal) and opens its own connection. The leader
// gives the lock up when the page freezes or is put away (freeze / pagehide) and reopens a dead connection.
// Every take-over refetches once in every tab, so changes missed meanwhile show.
// Kept free of DOM types so the root typecheck and bun tests can load it with fakes.

export type SourceLike = {
  onmessage: ((m: { data: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onopen: ((e: unknown) => void) | null;
  /** 2 (CLOSED) after an error answer: the EventSource won't retry on its own. */
  readyState?: number;
  close?(): void;
};
export type ChannelLike = {
  onmessage: ((m: { data: unknown }) => void) | null;
  postMessage(msg: unknown): void;
};
type Lock = unknown;
export type AbortLike = { signal: unknown; abort(): void };
export type LocksLike = {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean; signal?: unknown },
    cb: (lock: Lock | null) => Promise<unknown> | unknown,
  ): Promise<unknown>;
};
/** The page's state, from document events; missing in tests that don't need it (always visible, never frozen). */
export type PageLike = {
  visible(): boolean;
  /** "visible": the tab came to the front; "freeze"/"resume": Chrome froze or woke it (also pagehide/pageshow). */
  on(event: "visible" | "freeze" | "resume", fn: () => void): void;
};
export type TimersLike = {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
};
export type LiveDeps<E> = {
  makeSource: () => SourceLike;
  /** Missing when the browser has no Web Locks (insecure context) or no BroadcastChannel. */
  locks?: LocksLike | null;
  makeChannel?: (() => ChannelLike) | null;
  parse?: (data: string) => E;
  page?: PageLike | null;
  timers?: TimersLike;
  makeAbort?: (() => AbortLike) | null;
};

type Msg<E> = { type: "event"; event: E } | { type: "reconnected" } | { type: "beat" };
export const LIVE_NAME = "ckanban-events";
/** How often the leader says it is alive. */
export const BEAT_MS = 1000;
/** A visible follower that heard nothing for this long takes over. Hidden tabs' timers run at most once a second. */
export const STALE_MS = 5000;
/** How often a follower checks for silence. */
export const WATCH_MS = 1000;
/** Wait before reopening an EventSource that gave up (error answer while the daemon restarted). */
export const REOPEN_MS = 3000;

const realTimers: TimersLike = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
};

export function createLive<E>(deps: LiveDeps<E>) {
  const listeners = new Set<(e: E) => void>();
  const reconnectListeners = new Set<() => void>();
  const parse = deps.parse ?? ((d: string) => JSON.parse(d) as E);
  const timers = deps.timers ?? realTimers;
  const page = deps.page ?? null;
  let started = false;
  let channel: ChannelLike | null = null;
  let role: "none" | "leader" | "follower" | "solo" | "frozen" = "none";
  // Bumped at every role change; a lock grant or rejection from an older request then does nothing.
  let gen = 0;
  let source: SourceLike | null = null;
  let releaseLock: (() => void) | null = null;
  let waitAbort: AbortLike | null = null;
  let beatTimer: unknown = null;
  let lastHeard = timers.now();

  const deliver = (e: E) => {
    for (const l of listeners) {
      try {
        l(e);
      } catch {}
    }
  };
  const runReconnect = () => {
    for (const fn of reconnectListeners) {
      try {
        fn();
      } catch {}
    }
  };
  const post = (msg: Msg<E>) => {
    if (!channel) return;
    try {
      channel.postMessage(msg);
    } catch {}
  };

  function closeSource() {
    if (!source) return;
    const s = source;
    source = null;
    s.onmessage = s.onerror = s.onopen = null;
    try {
      s.close?.();
    } catch {}
  }

  /** Opens the EventSource. `missed` is true when this tab may have missed events before the connection opens. */
  function open(missed: boolean) {
    closeSource();
    const s = deps.makeSource();
    source = s;
    let lost = missed;
    s.onmessage = (m) => {
      let e: E;
      try {
        e = parse(m.data);
      } catch {
        return;
      }
      post({ type: "event", event: e });
      deliver(e);
    };
    // EventSource retries on its own; remember that we missed events meanwhile. After an error answer it gives
    // up (CLOSED) and would leave this tab, and every tab it relays to, without events: reopen it ourselves.
    s.onerror = () => {
      lost = true;
      if (s.readyState !== 2) return;
      timers.setTimeout(() => {
        if (source === s && (role === "leader" || role === "solo")) open(true);
      }, REOPEN_MS);
    };
    s.onopen = () => {
      if (!lost) return;
      lost = false;
      post({ type: "reconnected" });
      runReconnect();
    };
  }

  function stopBeat() {
    if (beatTimer !== null) timers.clearInterval(beatTimer);
    beatTimer = null;
  }

  /** Lock granted: open the connection and hold the lock until this tab steps down (or closes). */
  function lead(missed: boolean, myGen: number): Promise<void> {
    if (myGen !== gen) return Promise.resolve(); // an old request: let the lock go at once
    role = "leader";
    waitAbort = null;
    open(missed);
    post({ type: "beat" });
    stopBeat();
    beatTimer = timers.setInterval(() => post({ type: "beat" }), BEAT_MS);
    return new Promise<void>((res) => {
      releaseLock = res;
    });
  }

  /** Stop leading: close the connection and let the lock go (if it wasn't taken from us). */
  function stepDown() {
    stopBeat();
    closeSource();
    const rel = releaseLock;
    releaseLock = null;
    rel?.();
  }

  /** A lock request ended with an error: the lock was taken from us (steal), or Web Locks doesn't work here. */
  function lockFailed(myGen: number) {
    if (myGen !== gen) return;
    if (role === "leader") {
      // Another tab took over because it heard nothing from us (frozen or throttled), so we may have missed
      // events too, and its "reconnected" came while we still led: refetch here, then follow it.
      stepDown();
      runReconnect();
      lastHeard = timers.now();
      wait(++gen);
      return;
    }
    if (role === "follower" || role === "none") fallback();
  }

  /** Wait in line for the lock; when the leader closes, this tab takes over and every tab refetches. */
  function wait(myGen: number) {
    role = "follower";
    const ac = deps.makeAbort?.() ?? null;
    waitAbort = ac;
    deps.locks!.request(LIVE_NAME, ac ? { signal: ac.signal } : {}, () => lead(true, myGen)).then(
      () => {},
      () => lockFailed(myGen),
    );
  }

  /** The leader went quiet while this tab is on screen: take the lock from it and open our own connection. */
  function takeOver() {
    const myGen = ++gen;
    waitAbort?.abort();
    waitAbort = null;
    role = "follower";
    deps.locks!.request(LIVE_NAME, { steal: true }, () => lead(true, myGen)).then(
      () => {},
      () => lockFailed(myGen),
    );
  }

  /** Web Locks failed: this tab opens its own connection and stops listening to the channel. */
  function fallback() {
    gen++;
    waitAbort?.abort();
    waitAbort = null;
    if (channel) channel.onmessage = null;
    channel = null;
    role = "solo";
    open(false);
  }

  const visible = () => (page ? page.visible() : true);
  /** Followers on screen check that the leader still speaks. */
  function watch() {
    if (role !== "follower" || !visible()) return;
    if (timers.now() - lastHeard > STALE_MS) takeOver();
  }

  function start() {
    if (started) return;
    started = true;
    let ch: ChannelLike | null = null;
    if (deps.locks && deps.makeChannel) {
      try {
        ch = deps.makeChannel();
      } catch {
        ch = null;
      }
    }
    if (!ch || !deps.locks) {
      role = "solo";
      open(false);
      return;
    }
    channel = ch;
    const locks = deps.locks;
    ch.onmessage = (m) => {
      if (role === "leader") return;
      const msg = m.data as Msg<E> | null;
      if (!msg || typeof msg !== "object") return;
      lastHeard = timers.now();
      if (msg.type === "event") deliver(msg.event);
      else if (msg.type === "reconnected") runReconnect();
    };
    timers.setInterval(watch, WATCH_MS);
    page?.on("visible", watch);
    // Frozen (or put in the back/forward cache): this tab can't relay, so let the lock go and leave the line.
    page?.on("freeze", () => {
      if (role !== "leader" && role !== "follower") return;
      gen++;
      waitAbort?.abort();
      waitAbort = null;
      if (role === "leader") stepDown();
      role = "frozen";
    });
    // Woken: events were missed while frozen, so refetch, then wait in line again (or take over if all is quiet).
    page?.on("resume", () => {
      if (role !== "frozen") return;
      lastHeard = timers.now();
      runReconnect();
      wait(++gen);
    });
    const myGen = gen;
    // First try without waiting: getting it now means no other tab holds the connection, so nothing was missed.
    locks
      .request(LIVE_NAME, { ifAvailable: true }, (lock) => {
        if (lock) return lead(false, myGen);
        if (myGen === gen) wait(myGen);
      })
      .then(
        () => {},
        () => lockFailed(myGen),
      );
  }

  return {
    subscribe(fn: (e: E) => void): () => void {
      listeners.add(fn);
      start();
      return () => {
        listeners.delete(fn);
      };
    },
    /** Called after the live connection comes back (daemon restart, laptop sleep, leader tab closed): refetch state. */
    onReconnect(fn: () => void): () => void {
      reconnectListeners.add(fn);
      start();
      return () => {
        reconnectListeners.delete(fn);
      };
    },
    /**
     * Hands an event to this tab's listeners as if the server had sent it: for a change this tab made itself (the
     * request's answer), so the page shows it even when the live connection is stalled (a phone that put the tab
     * holding the connection to sleep). The server's own event repeats it later; listeners merge, so that is harmless.
     */
    emitLocal(e: E): void {
      deliver(e);
    },
    /** For tests: is this tab the one holding the connection. */
    isLeader: () => role === "leader",
  };
}
