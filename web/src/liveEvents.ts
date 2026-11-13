// One live update connection per browser, shared by every board tab.
// The board runs over plain http/1.1 where Chrome allows only 6 connections per origin across all tabs,
// so one EventSource per tab froze the board at 6 tabs. One tab (the leader, picked with a Web Lock) opens
// the EventSource and posts every event on a BroadcastChannel; the other tabs listen there. When the leader
// closes, a waiting tab takes the lock and opens the connection. Without Web Locks or BroadcastChannel
// (a phone over plain LAN http), every tab opens its own connection as before.
// Kept free of DOM types so the root typecheck and bun tests can load it with fakes.

export type SourceLike = {
  onmessage: ((m: { data: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onopen: ((e: unknown) => void) | null;
};
export type ChannelLike = {
  onmessage: ((m: { data: unknown }) => void) | null;
  postMessage(msg: unknown): void;
};
type Lock = unknown;
export type LocksLike = {
  request(name: string, options: { ifAvailable?: boolean }, cb: (lock: Lock | null) => Promise<unknown> | unknown): Promise<unknown>;
};
export type LiveDeps<E> = {
  makeSource: () => SourceLike;
  /** Missing when the browser has no Web Locks (insecure context) or no BroadcastChannel. */
  locks?: LocksLike | null;
  makeChannel?: (() => ChannelLike) | null;
  parse?: (data: string) => E;
};

type Msg<E> = { type: "event"; event: E } | { type: "reconnected" };
export const LIVE_NAME = "ckanban-events";

export function createLive<E>(deps: LiveDeps<E>) {
  const listeners = new Set<(e: E) => void>();
  const reconnectListeners = new Set<() => void>();
  const parse = deps.parse ?? ((d: string) => JSON.parse(d) as E);
  let started = false;
  let channel: ChannelLike | null = null;
  let leader = false;

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

  /** Opens the EventSource. `missed` is true when this tab may have missed events before the connection opens. */
  function open(missed: boolean) {
    const source = deps.makeSource();
    let lost = missed;
    source.onmessage = (m) => {
      let e: E;
      try {
        e = parse(m.data);
      } catch {
        return;
      }
      if (channel) {
        try {
          channel.postMessage({ type: "event", event: e } satisfies Msg<E>);
        } catch {}
      }
      deliver(e);
    };
    // EventSource retries on its own; remember that we missed events meanwhile.
    source.onerror = () => {
      lost = true;
    };
    source.onopen = () => {
      if (!lost) return;
      lost = false;
      if (channel) {
        try {
          channel.postMessage({ type: "reconnected" } satisfies Msg<E>);
        } catch {}
      }
      runReconnect();
    };
  }

  function becomeLeader(handover: boolean): Promise<never> {
    leader = true;
    open(handover);
    // Hold the lock for the tab's lifetime; closing the tab releases it.
    return new Promise<never>(() => {});
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
      open(false);
      return;
    }
    channel = ch;
    const locks = deps.locks;
    ch.onmessage = (m) => {
      if (leader) return;
      const msg = m.data as Msg<E> | null;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "event") deliver(msg.event);
      else if (msg.type === "reconnected") runReconnect();
    };
    const fallback = () => {
      if (leader) return;
      channel = null;
      ch.onmessage = null;
      open(false);
    };
    // First try without waiting: getting it now means no other tab holds the connection, so nothing was missed.
    locks
      .request(LIVE_NAME, { ifAvailable: true }, (lock) => {
        if (lock) return becomeLeader(false);
        // Another tab leads. Wait in line; when it closes, this tab takes over and everyone refetches.
        locks.request(LIVE_NAME, {}, () => becomeLeader(true)).catch(fallback);
      })
      .catch(fallback);
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
    isLeader: () => leader,
  };
}
