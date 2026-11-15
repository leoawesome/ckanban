// Huddles: routing: who a message wakes, the idle watchdog, delivering unread messages (methods of the Huddles class in huddle.ts, split by topic).
import { trackedInterval } from "../core/lag";
import { activeHost, MAIN_HANDLE, USER_HANDLE } from "./huddle-roster";
import { huddleAgentPrompt, huddleDigest, huddleMainPrompt } from "../runs/prompts";
import type { Huddle, HuddleMessage, HuddleParticipant } from "../core/types";
import type { Huddles } from "./huddle";
import { digestWindow, HUDDLE_IDLE_MS, IDLE_SWEEP_MS, AgentRun, isCoordinator, canManage, isSnapshot, settled } from "./huddle-types";

export function route(this: Huddles, slug: string, hid: string, m: HuddleMessage) {
  const h = this.get(slug, hid);
  const unwoken: HuddleParticipant[] = [];
  for (const p of h.participants) {
    const w = this.wakes(h, p, m);
    if (w) this.wake(slug, h, p, w === "mention");
    else if (m.mentions.includes(p.handle) && p.kind !== "human" && p.handle !== m.from) unwoken.push(p);
  }
  for (const p of unwoken) this.noteUnwoken(slug, hid, p, m.from);
}

/**
 * A tag didn't wake its target because it is done, blocked or stopped: say so in a system note that tags the host
 * or @main (the user, when the target is @main), once per target and sender until the target wakes. A held pair
 * already has a note.
 */
export function noteUnwoken(this: Huddles, slug: string, hid: string, p: HuddleParticipant, from: string) {
  const h = this.get(slug, hid);
  const cur = h.participants.find((x) => x.handle === p.handle);
  if (!cur || (!settled(cur) && cur.status !== "stopped") || from === USER_HANDLE) return;
  if (h.unwoken?.[p.handle]?.includes(from)) return;
  this.update(slug, hid, (x) => {
    x.unwoken ??= {};
    x.unwoken[p.handle] = [...(x.unwoken[p.handle] ?? []), from];
  });
  const to = p.handle === MAIN_HANDLE ? USER_HANDLE : activeHost(h);
  const who = cur.status === "stopped" ? "only the user can restart it" : `@${to} or a lead can wake it`;
  this.system(slug, hid, `@${p.handle} is ${cur.status} and wasn't woken by @${from}'s tag; ${who}.`, [to]);
}

/**
 * Whether a message wakes a participant: "mention" (tagged, or a system message naming it), "monitor" (it sees
 * every message) or null. Done: a lead wakes on a direct tag from anyone and, in monitor mode, on a non-lead's
 * message; anyone else only on a tag from a lead, @main or the user (or the brakes). Blocked: only a tag.
 */
export function wakes(this: Huddles, h: Huddle, p: HuddleParticipant, m: HuddleMessage): "mention" | "monitor" | null {
  if (p.kind === "human" || m.from === p.handle || p.status === "stopped") return null;
  const mentioned = m.mentions.includes(p.handle) || m.mentions.includes("all");
  if (m.kind === "system") return mentioned ? "mention" : null;
  if (p.status === "done") {
    const from = h.participants.find((x) => x.handle === m.from);
    // @all only reaches mentions when a lead, @main or the user sent it.
    if (mentioned && from && canManage(h, from)) return "mention";
    if (!p.lead) return null;
    if (m.mentions.includes(p.handle)) return "mention";
    return p.mode === "monitor" && from && !canManage(h, from) ? "monitor" : null;
  }
  if (mentioned) return "mention";
  return p.mode === "monitor" && p.status !== "blocked" ? "monitor" : null;
}

/** Wake a participant; being woken ends done or blocked, and its unwoken-tag notes start over. */
export function wake(this: Huddles, slug: string, h: Huddle, p: HuddleParticipant, mentioned: boolean) {
  if (settled(p)) this.updateP(slug, h.id, p.handle, { status: "idle", statusReason: null });
  if (this.get(slug, h.id).unwoken?.[p.handle]) this.update(slug, h.id, (x) => void delete x.unwoken![p.handle]);
  this.deliver(slug, h, p, mentioned);
}

/**
 * The idle watchdog (see the header): wakes the host, or @main, in each live huddle that has sat idle for
 * HUDDLE_IDLE_MS since someone other than @main, the user or that host spoke last. now: for tests.
 */
export function idleSweep(this: Huddles, now = Date.now()): void {
  if (this.shuttingDown || this.board.isRestartPending()) return;
  for (const profile of this.store.listProfiles()) {
    // Open huddles only, shared (no copies): a board keeps every closed huddle.
    for (const h of this.store.openHuddles(profile.slug)) {
      if (h.status === "live") this.idleCheck(profile.slug, h.id, now);
    }
  }
}

export function idleCheck(this: Huddles, slug: string, hid: string, now: number) {
  const h = this.load(slug, hid);
  if (!h || h.status !== "live") return;
  const msgs = this.store.readHuddleMessages(slug, hid);
  const last = msgs.findLast((m) => m.kind !== "system");
  const to = activeHost(h);
  if (!last || last.from === MAIN_HANDLE || last.from === USER_HANDLE || last.seq <= (h.idleNudged ?? 0)) return;
  // The host speaking last is normally the host waiting on nobody, but when it tagged helpers and none of them has
  // answered since, the huddle would sit idle forever (the host's rules have it wait for every answer).
  const silent = last.from === to
    ? h.participants.filter((p) => p.kind !== "human" && p.handle !== to && p.status !== "stopped" && last.mentions.includes(p.handle)).map((p) => p.handle)
    : [];
  if (last.from === to && !silent.length) return;
  const times = [h.updatedAt, msgs.at(-1)?.ts, ...h.participants.map((p) => p.idleAt)].filter((t): t is string => !!t).map((t) => Date.parse(t));
  if (now - Math.max(...times) < HUDDLE_IDLE_MS) return;
  const ps = h.participants.filter((p) => p.kind !== "human");
  if (ps.some((p) => this.working(slug, h, p) || this.mainPending.has(this.key(slug, hid, p.handle)))) return;
  for (const p of ps) {
    const run = this.runs.get(this.key(slug, hid, p.handle));
    if (run && (run.pending || run.again || run.refreshing)) return;
    if (msgs.some((m) => m.seq > p.cursor && this.wakes(h, p, m))) return;
  }
  this.update(slug, hid, (x) => void (x.idleNudged = last.seq));
  const mins = Math.round(HUDDLE_IDLE_MS / 60_000);
  if (silent.length) {
    const who = silent.map((x) => `@${x}`).join(", ").replace(/, ([^,]*)$/, " and $1");
    const one = silent.length === 1;
    this.system(slug, hid, `Huddle idle for ${mins} min: ${who} ${one ? "hasn't" : "haven't"} answered your #${last.seq}. Count ${one ? "that answer" : "their answers"} as "no" and name ${one ? "it" : "them"} in the report, or tag ${one ? "it" : "them"} once more.`, [to]);
    return;
  }
  this.system(slug, hid, `Huddle idle for ${mins} min since #${last.seq} (last: @${last.from}). Check who should act, or ask the user to close it.`, [to]);
}

/** Start the idle watchdog's sweep (the daemon, after recover()). */
export function startWatchdog(this: Huddles): void {
  if (this.sweeper) return;
  this.sweeper = trackedInterval("huddle-idle-sweep", () => {
    try {
      this.idleSweep();
    } catch (e) {
      console.error("huddle idle sweep failed", e);
    }
  }, IDLE_SWEEP_MS);
  this.sweeper.unref?.();
}

/**
 * Deliver a wake that was owed but never happened: messages that tag the participant (or, in monitor mode, any
 * new ones) after its cursor. Run on Resume and after a restart, so nothing posted while the huddle was stopped
 * or the daemon was going down is lost. A monitor ticket session's pending messages come back this way too.
 */
export function wakeIfOwed(this: Huddles, slug: string, hid: string, handle: string): "mention" | "monitor" | null {
  const h = this.load(slug, hid);
  const p = h?.participants.find((x) => x.handle === handle);
  if (!h || !p || h.status !== "live") return null;
  let owed: "mention" | "monitor" | null = null;
  for (const m of this.store.readHuddleMessages(slug, hid)) {
    if (m.seq <= p.cursor) continue;
    const w = this.wakes(h, p, m);
    if (w === "mention") {
      owed = w;
      break;
    }
    owed ??= w;
  }
  if (owed) this.wake(slug, h, p, owed === "mention");
  return owed;
}

/**
 * Unread messages for a participant as one digest, and moves its cursor past them. Null when there is nothing
 * to act on (only system messages, unless withSystem). undo: put the cursor back (the digest never arrived).
 */
export function takeUnread(this: Huddles, slug: string, hid: string, handle: string, withSystem = false): { digest: string; tagged: boolean; undo: () => void } | null {
  const h = this.get(slug, hid);
  const p = h.participants.find((x) => x.handle === handle);
  if (!p) return null;
  const unread = this.store.readHuddleMessages(slug, hid).filter((m) => m.seq > p.cursor && m.from !== handle);
  const prev = p.cursor;
  if (p.cursor !== h.seq) this.updateP(slug, hid, handle, { cursor: h.seq });
  // A system message only counts when it tags this participant (the brakes' warnings).
  const tags = (m: HuddleMessage) => m.mentions.includes(handle) || m.mentions.includes("all");
  if (!unread.length || (!withSystem && !unread.some((m) => m.kind !== "system" || tags(m)))) return null;
  const shown = digestWindow(unread);
  return { digest: huddleDigest(shown, unread.length - shown.length, h.brief), tagged: unread.some(tags), undo: () => this.updateP(slug, hid, handle, { cursor: prev }) };
}

export function deliver(this: Huddles, slug: string, h: Huddle, p: HuddleParticipant, mentioned: boolean) {
  if (p.kind === "ticket-main") {
    // Monitor: one message with everything once its current run is over, not a steer per message.
    if (!mentioned && p.ticketId && this.board.isRunning(slug, p.ticketId)) {
      this.mainPending.add(this.key(slug, h.id, p.handle));
      return;
    }
    return this.deliverNow(slug, h.id, p.handle);
  }
  const run = this.runs.get(this.key(slug, h.id, p.handle));
  if (run) {
    // Mid-turn: a mention steers it now; for a monitor the rest waits for the turn boundary.
    if (!mentioned && !run.idle) {
      run.pending = true;
      return;
    }
    return this.deliverNow(slug, h.id, p.handle);
  }
  this.deliverNow(slug, h.id, p.handle);
}

/** Hand the participant everything it hasn't read: into its live run, a ticket chat message, or a new run. */
export function deliverNow(this: Huddles, slug: string, hid: string, handle: string) {
  const h = this.load(slug, hid);
  const p = h?.participants.find((x) => x.handle === handle);
  if (!h || !p || h.status !== "live" || p.status === "stopped" || p.status === "done" || this.shuttingDown) return;
  if (p.kind === "ticket-main") {
    const u = p.ticketId ? this.takeUnread(slug, hid, handle) : null;
    if (!u) return;
    this.mainWoken.set(`${slug}/${p.ticketId}`, { hid, handle });
    // Its own auto huddle wakes the host as unattended work on the ticket (it ends with a result line and lands).
    const own = this.store.getTicket(slug, p.ticketId!)?.autoHuddle;
    const hostWake = !!h.auto && isCoordinator(h, p) && own?.state === "live" && own.huddleId === h.id;
    const planning = this.store.getTicket(slug, p.ticketId!)?.status === "planning";
    this.board.chat(slug, p.ticketId!, huddleMainPrompt(h, p, u.digest, this.board.committed(slug), planning), hostWake ? { hostWake } : { peer: true }).catch((e) => {
      u.undo();
      this.system(slug, hid, `Couldn't reach @${handle}: ${(e as Error).message}`);
    });
    return;
  }
  const run = this.runs.get(this.key(slug, hid, handle));
  if (run) {
    if (run.stopRequested) return;
    // Still starting (worktree, setup): it gets them at its first turn boundary.
    if (!run.handle) {
      run.pending = true;
      return;
    }
    // Between turns, a snapshot agent sees the host's latest commit first. Mid-turn its files stay put.
    if (run.idle && isSnapshot(p) && !run.fresh) {
      if (run.refreshing) return;
      run.refreshing = this.workspace(slug, h, p)
        .then(() => {}, (e) => {
          if (!run.stopRequested) this.system(slug, hid, `Couldn't refresh @${handle}'s snapshot: ${(e as Error).message}`);
        })
        .finally(() => {
          run.refreshing = null;
          run.fresh = true;
          this.deliverNow(slug, hid, handle);
        });
      this.chore(run.refreshing);
      return;
    }
    if (run.refreshing) return;
    run.fresh = false;
    run.pending = false;
    const u = this.takeUnread(slug, hid, handle);
    if (!u) return;
    const cur = this.get(slug, hid).participants.find((x) => x.handle === handle)!;
    if (run.handle?.send(huddleAgentPrompt("wake", cur, u.digest, u.tagged, isSnapshot(cur) ? cur.snapshot : null))) {
      if (run.idle && !settled(p)) this.updateP(slug, hid, handle, { status: "working" });
      run.idle = false;
    } else {
      // Input is closing (the run is finishing): a new run picks them up.
      u.undo();
      run.again = true;
    }
    return;
  }
  // Before taking the unread messages: recover() hands them over after the restart.
  if (this.holdForRestart(slug, hid, handle)) return;
  const u = this.takeUnread(slug, hid, handle);
  if (u) this.runAgent(slug, hid, handle, huddleAgentPrompt("wake", p, u.digest, u.tagged));
}

/** A restart is pending: no new agent run starts; the agent is marked so recover() starts it after the restart. */
export function holdForRestart(this: Huddles, slug: string, hid: string, handle: string): boolean {
  if (!this.board.isRestartPending()) return false;
  this.updateP(slug, hid, handle, { interrupted: true, lastActivity: "Waiting for the board to restart" });
  return true;
}

/** An agent's first run: start on its job with what was said so far. */
export function kickoff(this: Huddles, slug: string, hid: string, handle: string) {
  if (this.holdForRestart(slug, hid, handle)) return;
  const p = this.get(slug, hid).participants.find((x) => x.handle === handle)!;
  this.runAgent(slug, hid, handle, huddleAgentPrompt("start", p, this.takeUnread(slug, hid, handle, true)?.digest ?? ""));
}

export function runAgent(this: Huddles, slug: string, hid: string, handle: string, input: string) {
  const key = this.key(slug, hid, handle);
  if (this.runs.has(key) || this.shuttingDown || this.holdForRestart(slug, hid, handle)) return;
  const run: AgentRun = { handle: null, promise: Promise.resolve(), idle: false, pending: false, again: false, stopRequested: false };
  this.runs.set(key, run);
  const cur = this.get(slug, hid).participants.find((x) => x.handle === handle);
  this.updateP(slug, hid, handle, { status: settled(cur) ? cur!.status : "working", error: null, interrupted: false });
  run.promise = this.executeAgent(slug, hid, handle, run, input)
    .catch((e) => {
      console.error(`huddle ${slug}/${hid} @${handle} crashed`, e);
      const error = String((e as Error)?.message ?? e);
      this.updateP(slug, hid, handle, { status: "failed", error });
      if (this.load(slug, hid)) this.system(slug, hid, `@${handle} failed: ${error}`);
    })
    .finally(() => {
      this.runs.delete(key);
      this.board.boardBrowsers.release(this.browserLease(slug, hid, handle));
      if (this.shuttingDown) return;
      this.board.restartWorkChanged();
      // Emit with running: false now that the run is gone.
      if (this.load(slug, hid)) this.update(slug, hid, () => {});
      if ((run.again || run.pending) && !run.stopRequested) this.deliverNow(slug, hid, handle);
    });
}
