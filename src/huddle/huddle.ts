// Huddles: a shared message room where several headless Claude sessions work on one ticket together.
// The host ticket's own session is @main (the coordinator); agents (reviewer, QA, ...) are sessions the huddle runs
// itself, outside the board's run slots (only maxParticipants limits them). Other tickets' sessions can be invited.
// The daemon stamps every message's sender, keeps the log append-only, caps the roster, and one Stop stops every
// huddle agent. Stop and Close never touch the tickets' own work: only the reply runs the huddle woke them for.
//
// Routing: an @mentioned participant is woken (steered if it is running, else its session resumes with what it
// hasn't read). Monitor-mode participants get every new message at their next turn boundary; tagged ones sleep until
// mentioned. Nobody gets their own messages. System messages are context only and wake nobody, except the ones that
// tag someone (the brakes' warnings, the notes below). Only leads, @main and the user can wake everyone with @all.
// Leads (monitor mode unless their roster or preset says otherwise) always watch: a done lead still wakes on any
// direct tag and, in monitor mode, on a non-lead's report. A done non-lead sleeps until a lead, @main or the user tags
// it (so workers can't loop); a blocked one until someone tags it. A tag that wakes nobody because its target is done,
// blocked or stopped is never dropped silently: a system note tags @main, once per target and sender until the
// target wakes. Wakes owed while the huddle was stopped or the daemon was down are delivered on Resume and after a
// restart (see wakeIfOwed).
//
// Idle watchdog: a live huddle where nobody (@main included) has worked and no wake was queued or owed for
// HUDDLE_IDLE_MS, and @main or the user didn't have the last word, wakes @main once with a system note; again only
// after a new message. It is a sweep from the huddle's times, so it carries over a daemon restart, and it pauses while
// the daemon shuts down or a restart is pending.
//
// Host: a huddle may have one lead that runs it (h.host; templates and auto huddles default to their first lead), so
// @main, which holds the ticket's whole context, doesn't spend turns on the room. While the host can act (activeHost),
// the idle watchdog, the "wasn't woken" notes, the budget warnings, blocked notes and hand-ins go to
// it instead of @main; @main still wakes on a direct tag (the host's final report) and the user still closes. When the
// host is stopped, blocked or fails, @main takes its place again and a system note says so (when the host is done,
// @main takes it quietly: the host's final report already tagged @main).
//
// Lifecycle: @main or a lead writes outputs/huddles/<id>/summary.md and asks the user to close (huddle_close); only
// the user closes, or the host ticket moving to Done does. Closing removes the agents' clean own worktrees and the
// read-only agents' snapshots. A huddle closed without a summary gets one: @main is asked to write it, or, when the
// host ticket can't run (Done, no session), the board writes one from the huddle's data (fallbackSummary).
//
// Workspaces: the shared worktree is the coordinator's. A read-only agent (shared, can't edit) works in a detached
// snapshot worktree at the host branch's committed HEAD, reset at every wake, so its shell can't touch the
// coordinator's files. A helper that can change files works in its own copy of the host's folder (huddle-copies.ts),
// on any project: a git worktree, or a plain copy when the folder has no commits. It hands its changes in
// (huddle_hand_in); a lead, @main or the user accepts them into the host's folder or rejects them, and on a conflict
// nothing is applied and the helper redoes the work on a fresh copy. The board remembers its own last save of the
// huddle file; an edit from outside can't raise lead, canEdit or the limits, or move a copy (see guard).
//
// The one brake, so a huddle can't overspend: it stops at maxCostUsd (agents' runs and @main's huddle replies; the
// leads are warned at 80%). There is no message limit: agents talk until they reach a conclusion.
import { existsSync } from "node:fs";
import { pauser } from "../core/lag";
import { join } from "node:path";
import { claudeSessionExists, type Board } from "../board/board";
import type { Bus } from "../core/events";
import { LEGACY_SUMMARY_FILE, summaryFile } from "./huddle-roster";
import { BUILTIN_PRESETS, deletePreset, type HuddlePresetView, presetName, savePreset } from "./huddle-presets";
import { BUILTIN_TEMPLATES, deleteTemplate, type HuddleTemplateView, saveTemplate } from "./huddle-templates";
import type { HostHuddle } from "../helper/attention";
import { isLevel, lowerLevels } from "../core/layers";
import type { Store } from "../core/store";
import { contextTokens } from "../usage/ticket-usage";
import type { Huddle, HuddleMessage, HuddleParticipant } from "../core/types";
import { nowIso } from "../core/util";
import { HuddleError, ACTIVITY_THROTTLE_MS, HuddleTeammateSpend, teammateSpend, HuddleView, pendingLearnings, userSeenSeq, isForYou, Caller, HuddleOptions, AgentRun, isCoordinator, endedByDone } from "./huddle-types";
import * as presetsPart from "./huddle-presets-api";
import * as templatesPart from "./huddle-templates-api";
import * as changingPart from "./huddle-changing";
import * as autoPart from "./huddle-auto";
import * as handinPart from "./huddle-handin";
import * as messagesPart from "./huddle-messages";
import * as routingPart from "./huddle-routing";
import * as agentsPart from "./huddle-agents";
import * as lifecyclePart from "./huddle-lifecycle";

export * from "./huddle-types";

export class Huddles {
  runs = new Map<string, AgentRun>();
  /** Ticket sessions (monitor mode) with messages waiting until their current run ends, "<slug>/<huddle>/<handle>". */
  mainPending = new Set<string>();
  /** Closed huddles ("slug/hid") whose summary @main was asked to write; see ensureSummary. */
  summaryOwed = new Set<string>();
  /** Ticket sessions by "<slug>/<ticket>": the huddle participant that last woke them (its peer runs' cost is that huddle's). */
  mainWoken = new Map<string, { hid: string; handle: string }>();
  /** Ticket sessions' running cost, "<slug>/<ticket>/<session>" -> total_cost_usd at its latest result. */
  private ticketTotals = new Map<string, number>();
  /** A ticket session's latest conversation size ("slug/id" -> tokens), and when it was last written to its huddles. */
  private ticketCtx = new Map<string, { tokens: number; savedAt: number; saved: number }>();
  shuttingDown = false;
  sessionExists: (id: string) => boolean;
  /** Background work whenIdle() waits for (worktree cleanup after a close). */
  chores = new Set<Promise<void>>();
  /** Ticket -> the doneAt its outputs were last cleaned for (cleanOutputs); capped, oldest dropped. */
  private doneCleaned = new Map<string, string>();
  /** Per ticket: the outputs cleanup running now, so two never walk the same folders at once. */
  cleaning = new Map<string, Promise<void>>();
  /** Each huddle as this board last saved it, with its file's stamp, by "<slug>/<huddle>" (see guard). */
  private saved = new Map<string, { stamp: string | null; h: Huddle }>();
  sweeper: ReturnType<typeof setInterval> | null = null;
  /** Per board: the ticket the board last woke because the auto-huddle slot freed; the next waiter waits until its run is over. */
  slotWoken = new Map<string, string>();

  constructor(public store: Store, public board: Board, public bus: Bus, public opts: HuddleOptions) {
    this.sessionExists = opts.sessionExists ?? claudeSessionExists;
    // A pending restart waits for huddle agents mid-turn too.
    board.onRestartBusy(() => this.busyBoards());
    // "Needs you" on a host ticket depends on its huddle (attention.ts).
    board.onHostHuddles((slug) => this.hostStates(slug));
    // A monitor-mode ticket session gets what came in while it worked once its run is over.
    bus.on((e) => {
      // Satellite mode: the Rust board owns the huddles and acts on its own events; this daemon must not write them.
      if (bus.isMirrored(e)) return;
      if (e.type === "activity") {
        this.ticketContext(e.profile, e.id, e.event);
        return this.mainResult(e.profile, e.id, e.event);
      }
      if (e.type !== "ticket.updated" || this.shuttingDown) return;
      // The host ticket moved to Done: so did its huddles from before then (one started on a Done card keeps going).
      if (e.ticket.status === "done") {
        const { profile, ticket } = e;
        // Once per move to Done (doneAt): project copies left in its earlier huddles' helper folders go.
        const doneKey = `${profile}/${ticket.id}`;
        // huddleIndex is cached in memory: no file read for a Done ticket without closed huddles.
        if (ticket.doneAt && this.doneCleaned.get(doneKey) !== ticket.doneAt
          && this.store.huddleIndex(profile).some((x) => x.hostTicket === ticket.id && x.status === "closed")) {
          this.doneCleaned.delete(doneKey);
          this.doneCleaned.set(doneKey, ticket.doneAt);
          if (this.doneCleaned.size > 2000) this.doneCleaned.delete(this.doneCleaned.keys().next().value!);
          queueMicrotask(() => this.chore(this.cleanOutputs(profile, ticket.id)));
        }
        if (this.store.openHuddles(profile).some((h) => h.hostTicket === ticket.id && endedByDone(h, ticket))) {
          queueMicrotask(() => this.closeForTicket(profile, ticket.id, "the host ticket moved to Done"));
        }
      }
      // A ticket woken for a free auto-huddle slot finished its run without taking it: the next waiter gets it.
      if (this.slotWoken.get(e.profile) === e.ticket.id && !this.board.isRunning(e.profile, e.ticket.id)) {
        const { profile } = e;
        queueMicrotask(() => this.freeSlot(profile));
      }
      // @main was asked for a closed huddle's summary: once its run is over, the board writes it if it didn't.
      for (const key of [...this.summaryOwed]) {
        const [slug, hid] = key.split("/");
        if (slug !== e.profile) continue;
        const h = this.load(slug, hid);
        if (h && (h.hostTicket !== e.ticket.id || this.board.isRunning(slug, e.ticket.id) || e.ticket.queued?.some((m) => m.state === "queued"))) continue;
        this.summaryOwed.delete(key);
        if (h) queueMicrotask(() => this.writeFallbackSummary(slug, hid));
      }
      if (!this.mainPending.size) return;
      for (const key of [...this.mainPending]) {
        const [slug, hid, handle] = key.split("/");
        if (slug !== e.profile) continue;
        const h = this.load(slug, hid);
        const p = h?.participants.find((x) => x.handle === handle);
        if (!h || !p || p.ticketId !== e.ticket.id || this.board.isRunning(slug, e.ticket.id)) continue;
        this.mainPending.delete(key);
        queueMicrotask(() => this.deliverNow(slug, hid, handle));
      }
    });
  }

  key(slug: string, hid: string, handle: string) {
    return `${slug}/${hid}/${handle}`;
  }

  /**
   * A ticket session's result line: a huddle reply run's cost counts toward the huddle that woke it. Its total is the
   * session's running total (kept across --resume), so the run's cost is the growth since the session's previous
   * result, not since @main joined: the ticket's earlier chats and runs are not the huddle's.
   */
  private mainResult(slug: string, ticketId: string, ev: any) {
    if (ev?.type !== "result") return;
    const sid = String(ev.session_id ?? "");
    const total = Number(ev.total_cost_usd) || 0;
    const key = `${slug}/${ticketId}/${sid}`;
    const known = this.ticketTotals.get(key);
    this.ticketTotals.set(key, total);
    if (this.shuttingDown) return;
    const woken = this.mainWoken.get(`${slug}/${ticketId}`);
    if (!woken || !this.board.isPeerRun(slug, ticketId)) return;
    const h = this.load(slug, woken.hid);
    const p = h?.participants.find((x) => x.handle === woken.handle && x.ticketId === ticketId);
    if (!h || !p || h.status === "closed") return;
    const charge = (prev: number) => {
      const h = this.load(slug, woken.hid);
      const p = h?.participants.find((x) => x.handle === woken.handle && x.ticketId === ticketId);
      if (!h || !p || h.status === "closed" || this.shuttingDown) return;
      const cost = total >= prev ? total - prev : total;
      this.updateP(slug, h.id, p.handle, { costUsd: (p.costUsd ?? 0) + cost, sessionCostUsd: total, idleAt: nowIso() });
      this.checkBudget(slug, h.id);
    };
    if (known !== undefined) charge(known);
    else void this.priorSessionTotal(slug, ticketId, sid, total).then(charge, (e) => console.error(`huddle cost of ${slug}/${ticketId}:`, e));
  }

  /**
   * A ticket session's running total before its latest result (already in the activity log), from that log; 0 if none.
   * The log's digest reads only what was appended since last time (the first time in slices).
   */
  private async priorSessionTotal(slug: string, ticketId: string, sid: string, latest: number): Promise<number> {
    const totals = [...((await this.store.activityDigest(slug, ticketId)).sessionTotals.get(sid) ?? [])];
    if (totals.at(-1) === latest) totals.pop();
    return totals.at(-1) ?? 0;
  }

  /**
   * A ticket session's conversation size, for the huddles it is a ticket-main in (@main or invited): from each
   * assistant message's usage, written at most once a second while it works and at once on its result line.
   */
  private ticketContext(slug: string, ticketId: string, ev: any) {
    if (this.shuttingDown) return;
    const key = `${slug}/${ticketId}`;
    const st = this.ticketCtx.get(key);
    // A subagent's (Task) messages carry its own small context, not the session's.
    if (ev?.type === "assistant") {
      if (ev.parent_tool_use_id) return;
      const tokens = contextTokens(ev.message?.usage);
      if (!tokens) return;
      if (st) st.tokens = tokens;
      else this.ticketCtx.set(key, { tokens, savedAt: 0, saved: 0 });
    } else if (ev?.type !== "result" || !st) return;
    const cur = this.ticketCtx.get(key)!;
    const now = Date.now();
    if (cur.tokens === cur.saved || (ev.type !== "result" && now - cur.savedAt < ACTIVITY_THROTTLE_MS)) return;
    cur.saved = cur.tokens;
    cur.savedAt = now;
    for (const h of this.store.openHuddles(slug)) {
      for (const p of h.participants) {
        if (p.kind === "ticket-main" && p.ticketId === ticketId && p.contextTokens !== cur.tokens) this.updateP(slug, h.id, p.handle, { contextTokens: cur.tokens });
      }
    }
  }

  // ---- Reading ----

  get(slug: string, hid: string): Huddle {
    const h = this.load(slug, hid);
    if (!h) throw new HuddleError(404, `huddle ${hid} not found`);
    return h;
  }

  /** The huddle from disk, checked against edits made outside the board (see guard). */
  load(slug: string, hid: string): Huddle | null {
    const h = this.store.getHuddle(slug, hid);
    if (!h) {
      this.saved.delete(`${slug}/${hid}`);
      return null;
    }
    return this.guard(slug, h);
  }

  save(slug: string, h: Huddle) {
    this.store.saveHuddle(slug, h);
    this.saved.set(`${slug}/${h.id}`, { stamp: this.store.huddleStamp(slug, h.id), h: structuredClone(h) });
  }

  /**
   * The huddle file changed since the board last saved it (an agent's shell can write it): whatever it raised (lead,
   * canEdit, the limits) goes back to what the board had, as do the status, any lowered cost or message count, and
   * participants the board didn't add; a system message says so.
   * The first read after a daemon start is taken as is.
   */
  private guard(slug: string, h: Huddle): Huddle {
    const key = `${slug}/${h.id}`;
    const last = this.saved.get(key);
    const stamp = this.store.huddleStamp(slug, h.id);
    if (!last) {
      this.saved.set(key, { stamp, h: structuredClone(h) });
      return h;
    }
    if (stamp === last.stamp) return h;
    const was = last.h;
    // Only the board adds participants; one the board doesn't know is dropped.
    h.participants = h.participants.filter((p) => was.participants.some((x) => x.handle === p.handle));
    for (const p of h.participants) {
      const before = was.participants.find((x) => x.handle === p.handle)!;
      if (!before.lead) p.lead = false;
      if (!before.canEdit) p.canEdit = false;
      p.kind = before.kind;
      // Where its folders are: the board removes and remakes them, so a file edit can't point them elsewhere.
      p.copy = before.copy;
      p.worktree = before.worktree;
      p.branch = before.branch;
      // Spend only goes up, so a lowered cost can't get under the budget brake.
      if ((before.costUsd ?? 0) > (p.costUsd ?? 0)) p.costUsd = before.costUsd;
    }
    // Paused, stopped or closed only changes through the board (Resume, close), not by editing the file.
    h.status = was.status;
    h.stopReason = was.stopReason;
    // Proposed lessons only change through the board: an agent can't reword or save one by editing the file.
    h.learnings = was.learnings;
    // So do hand-ins: an agent can't accept its own changes or edit what it handed in.
    h.handIns = was.handIns;
    h.host = was.host;
    // The host's rules and topic are the user's: an agent can't rewrite its host's instructions by editing the file.
    h.hostRules = was.hostRules;
    h.topic = was.topic;
    for (const k of ["posts", "sinceUser", "idleNudged"] as const) {
      if ((was[k] ?? 0) > (h[k] ?? 0)) h[k] = was[k];
    }
    for (const k of ["maxParticipants", "maxCostUsd", "maxMessages"] as const) {
      const limit = was[k];
      if (limit !== undefined && (h[k] === undefined || h[k]! > limit)) h[k] = limit;
    }
    this.save(slug, h);
    // Not from inside this read: it may be part of an update that saves after it.
    queueMicrotask(() => {
      if (this.store.getHuddle(slug, h.id)) {
        this.system(slug, h.id, "Huddle file edited outside the board. Changes there to lead, canEdit, the host, the limits, the status, the costs, the participants, the learnings, the hand-ins or the copies of the folder were ignored; only the board changes them.");
      }
    });
    return h;
  }

  isRunning(slug: string, h: Huddle, p: HuddleParticipant): boolean {
    if (p.kind === "agent") return this.runs.has(this.key(slug, h.id, p.handle));
    if (p.kind === "ticket-main" && p.ticketId) return this.board.isRunning(slug, p.ticketId);
    return false;
  }

  /** The board of each huddle agent mid-turn (or starting): a pending restart waits for them. */
  busyBoards(): string[] {
    return [...this.runs].filter(([, r]) => !r.idle && !r.stopRequested).map(([k]) => k.slice(0, k.indexOf("/")));
  }

  /** Doing something now: an agent mid-turn, or a ticket session with a run (its own work or a huddle reply). */
  working(slug: string, h: Huddle, p: HuddleParticipant): boolean {
    if (p.kind === "agent") {
      const run = this.runs.get(this.key(slug, h.id, p.handle));
      return !!run && !run.idle;
    }
    return this.isRunning(slug, h, p);
  }

  view(slug: string, h: Huddle): HuddleView {
    const msgs = h.status === "closed" ? [] : this.store.readHuddleMessages(slug, h.id);
    const since = userSeenSeq(h, msgs);
    const learningsPending = pendingLearnings(h).length;
    return {
      ...h,
      hostTitle: this.store.getTicket(slug, h.hostTicket)?.title ?? null,
      participants: h.participants.map(({ token: _t, ...p }) => {
        const running = this.isRunning(slug, h, p);
        // A ticket session's status is its ticket's run (unless it said it is done or blocked, or was stopped).
        const status = p.kind === "ticket-main" && (p.status === "idle" || p.status === "working") ? (running ? "working" : "idle") : p.status;
        const liveCostUsd = running ? this.turnCost(slug, h.id, p.handle) : 0;
        return { ...p, status, running, ...(liveCostUsd > 0 ? { liveCostUsd } : {}) };
      }),
      ...this.quiet(slug, h, msgs),
      forYou: msgs.filter((m) => isForYou(m, since)).length + learningsPending,
      forYouSince: since,
      learningsPending,
      summary: this.summaryOf(slug, h),
    };
  }

  /**
   * Each open huddle by host ticket, as "needs you" sees it (attention.ts): who is working, whether a wake is on its
   * way, and what waits for the user (tags since they last looked, pending learnings, a close request) since when.
   */
  hostStates(slug: string): Map<string, HostHuddle> {
    const out = new Map<string, HostHuddle>();
    for (const h of this.store.huddleIndex(slug)) {
      if (h.status === "closed") continue;
      const msgs = this.store.readHuddleMessages(slug, h.id);
      const seen = userSeenSeq(h, msgs);
      const tagged = msgs.filter((m) => isForYou(m, seen));
      const learnings = pendingLearnings(h);
      const live = h.status === "live";
      const agents = h.participants.filter((p) => p.kind !== "human");
      const queued = live && agents.some((p) => {
        if (this.mainPending.has(this.key(slug, h.id, p.handle))) return true;
        const run = this.runs.get(this.key(slug, h.id, p.handle));
        return !!run && !run.stopRequested && (!run.handle || run.pending || run.again);
      });
      const times = [...tagged.map((m) => m.ts), ...learnings.map((l) => l.at), h.closeRequest?.at].filter((t): t is string => !!t);
      // Helpers: everyone but the user and the host's own session (@main).
      const helpers = agents.filter((p) => !isCoordinator(h, p));
      out.set(h.hostTicket, {
        working: live ? agents.filter((p) => this.working(slug, h, p)).length : 0,
        queued,
        helpers: helpers.length,
        helpersWorking: live ? helpers.filter((p) => this.working(slug, h, p)).length : 0,
        findings: h.findings.filter((f) => f.status === "open").length,
        tagged: tagged.length,
        learnings: learnings.length,
        closeRequest: !!h.closeRequest,
        since: times.length ? times.reduce((a, b) => (a < b ? a : b)) : null,
        latest: times.length ? times.reduce((a, b) => (a > b ? a : b)) : null,
      });
    }
    return out;
  }

  /** The huddle's summary file in the host's outputs: its own, or for a closed one the single file older huddles wrote. */
  summaryOf(slug: string, h: Huddle): string | null {
    const dir = this.store.outputsPath(slug, h.hostTicket);
    if (existsSync(join(dir, summaryFile(h.id)))) return summaryFile(h.id);
    return h.status === "closed" && existsSync(join(dir, LEGACY_SUMMARY_FILE)) ? LEGACY_SUMMARY_FILE : null;
  }

  /** Live, nobody working, nobody with an unanswered tag and no open findings; idleSince: the last message or turn. */
  quiet(slug: string, h: Huddle, msgs: readonly HuddleMessage[]): { quiet: boolean; idleSince: string | null } {
    const no = { quiet: false, idleSince: null };
    const ps = h.participants.filter((p) => p.kind !== "human");
    if (h.status !== "live" || h.findings.some((f) => f.status === "open") || ps.some((p) => this.working(slug, h, p))) return no;
    if (ps.some((p) => msgs.some((m) => m.seq > p.cursor && this.wakes(h, p, m) === "mention"))) return no;
    const times = [msgs.at(-1)?.ts, ...ps.map((p) => p.idleAt)].filter((t): t is string => !!t);
    return { quiet: true, idleSince: times.length ? times.reduce((a, b) => (a > b ? a : b)) : h.createdAt };
  }

  /** What the agents of a ticket's huddles spent (see teammateSpend). */
  ticketSpend(slug: string, ticketId: string): { costUsd: number; huddles: HuddleTeammateSpend[] } {
    return teammateSpend(this.hostedBy(slug).get(ticketId) ?? [], ticketId);
  }

  /**
   * The board's huddles by host ticket, rebuilt only when the huddle list changed: ticketSpend runs once per row of a
   * feature view or open card, and walking every huddle (thousands) for each one added up to hundreds of ms.
   */
  private hosted = new Map<string, { version: string; index: readonly Huddle[]; map: Map<string, Huddle[]> }>();
  private hostedBy(slug: string): Map<string, Huddle[]> {
    const index = this.store.huddleIndex(slug);
    const version = this.store.huddlesVersion(slug);
    const had = this.hosted.get(slug);
    if (had && had.version === version && had.index === index) return had.map;
    const map = new Map<string, Huddle[]>();
    for (const h of index) {
      const list = map.get(h.hostTicket);
      if (list) list.push(h);
      else map.set(h.hostTicket, [h]);
    }
    this.hosted.set(slug, { version, index, map });
    return map;
  }

  list(slug: string, ticketId?: string): HuddleView[] {
    // Filtered on the shared index first, then only those copied: copying every huddle (thousands) per call added up.
    return this.store.huddleIndex(slug)
      .filter((h) => !ticketId || h.hostTicket === ticketId || h.participants.some((p) => p.ticketId === ticketId))
      .map((h) => this.view(slug, structuredClone(h) as Huddle));
  }

  /**
   * list() for the HTTP route: the huddle files read in slices if a fresh daemon hasn't read them yet, then each view
   * (a copy, two file checks for its summary, a closed one's nothing else) built with a pause between, so 2,000
   * huddles don't freeze the daemon. open: only those not closed (the board's first load).
   */
  async listSliced(slug: string, q: { ticketId?: string; open?: boolean }, pause = pauser()): Promise<HuddleView[]> {
    await this.store.loadHuddles(slug);
    const { ticketId, open } = q;
    const picked = (open ? this.store.openHuddles(slug) : this.store.huddleIndex(slug))
      .filter((h) => !ticketId || h.hostTicket === ticketId || h.participants.some((p) => p.ticketId === ticketId));
    const out: HuddleView[] = [];
    for (const h of picked) {
      // A huddle saved while this paused shows as it was when the list started (the next poll has the new one).
      await pause();
      out.push(this.view(slug, structuredClone(h) as Huddle));
    }
    return out;
  }

  /** Messages, newest page first: `before` pages back, `since` reads forward from a seq. */
  messages(slug: string, hid: string, q: { before?: number; since?: number; limit?: number } = {}): { messages: HuddleMessage[]; hasMore: boolean } {
    this.get(slug, hid);
    const limit = Math.max(1, Math.min(500, q.limit ?? 100));
    let all = this.store.readHuddleMessages(slug, hid);
    if (q.since !== undefined) {
      all = all.filter((m) => m.seq > q.since!);
      return { messages: all.slice(0, limit), hasMore: all.length > limit };
    }
    if (q.before !== undefined) all = all.filter((m) => m.seq < q.before!);
    return { messages: all.slice(-limit), hasMore: all.length > limit };
  }

  /**
   * The participant a request comes from. The sender of everything is decided here, from the run's identity:
   * an agent proves who it is with its token, a ticket run is that ticket's session, no run header is the user.
   * hid "current": the caller's own huddle.
   */
  identify(slug: string, hid: string, who: Caller): { h: Huddle; me: HuddleParticipant } {
    if (who.agent) {
      const [aHid, handle, token] = who.agent.split("/");
      if (hid !== "current" && hid !== aHid) throw new HuddleError(403, `you are in huddle ${aHid}, not ${hid}`);
      const h = this.get(slug, aHid);
      const me = h.participants.find((p) => p.handle === handle && p.kind === "agent");
      if (!me || !token || me.token !== token) throw new HuddleError(403, "unknown huddle agent");
      if (who.run && who.run !== `${slug}/${h.hostTicket}`) throw new HuddleError(403, "huddle agents can only reach their own huddle");
      return { h, me };
    }
    if (who.run) {
      const [runSlug, ticketId] = who.run.split("/");
      if (runSlug !== slug || !ticketId) throw new HuddleError(403, `a run can only reach huddles on its own board (${runSlug})`);
      const mine = (h: Huddle) => h.participants.find((p) => p.kind === "ticket-main" && p.ticketId === ticketId);
      let h: Huddle | undefined;
      if (hid === "current") {
        // Its newest open huddle, preferring one it hosts.
        const open = this.store.openHuddles(slug).filter((x) => mine(x)).reverse();
        const found = open.find((x) => x.hostTicket === ticketId) ?? open[0];
        h = found && structuredClone(found);
        if (!h) throw new HuddleError(404, `ticket ${ticketId} is in no open huddle`);
      } else h = this.get(slug, hid);
      const me = mine(h);
      if (!me) throw new HuddleError(403, `ticket ${ticketId} is not in huddle ${h.id}`);
      return { h, me };
    }
    if (hid === "current") throw new HuddleError(400, "pass a huddle id");
    const h = this.get(slug, hid);
    return { h, me: h.participants.find((p) => p.kind === "human")! };
  }

  // ---- Role presets ("teammates"): built-ins, the global huddle-presets.json and the board's (see layers.ts) ----

  presets(...a: Parameters<typeof presetsPart.presets>): ReturnType<typeof presetsPart.presets> { return presetsPart.presets.call(this, ...a); }

  presetMap(...a: Parameters<typeof presetsPart.presetMap>): ReturnType<typeof presetsPart.presetMap> { return presetsPart.presetMap.call(this, ...a); }

  /**
   * Add or change a preset at one level: "board" (default) or "global" (every board). A lower level's name overrides it.
   * Saving for every board drops this board's own version of it, so the saved one is what this board uses.
   * Only the user saves (the HTTP route refuses runs and huddle agents; they propose with propose_teammate).
   */
  savePreset(slug: string, input: unknown, level: unknown = "board"): HuddlePresetView {
    if (!this.store.getProfile(slug)) throw new HuddleError(404, `board ${slug} not found`);
    if (!isLevel(level)) throw new HuddleError(400, "scope must be board or global");
    const global = this.store.listHuddlePresets(null);
    const board = this.store.listHuddlePresets(slug);
    let r: ReturnType<typeof savePreset>;
    try {
      r = savePreset(level === "global" ? global : board, input, lowerLevels(BUILTIN_PRESETS, global, level));
    } catch (e) {
      throw new HuddleError(400, (e as Error).message);
    }
    this.store.saveHuddlePresets(level === "global" ? null : slug, r.list);
    if (level === "global" && board.some((p) => p.name === r.preset.name)) this.store.saveHuddlePresets(slug, board.filter((p) => p.name !== r.preset.name));
    return this.presets(slug).find((p) => p.name === r.preset.name)!;
  }

  /**
   * Delete a preset at one level (default: the level whose version is in effect); it falls back to the level below,
   * or goes away. Built-ins themselves can't be deleted.
   */
  deletePreset(slug: string, name: string, level?: unknown): { reset: boolean; presets: HuddlePresetView[] } {
    const lvl = this.levelOf(level, this.presets(slug).find((p) => p.name === presetName(name))?.source);
    const global = this.store.listHuddlePresets(null);
    let r: ReturnType<typeof deletePreset>;
    try {
      r = deletePreset(this.store.listHuddlePresets(lvl === "global" ? null : slug), name, lowerLevels(BUILTIN_PRESETS, global, lvl));
    } catch (e) {
      throw new HuddleError(/built-in/.test((e as Error).message) ? 409 : 404, (e as Error).message);
    }
    this.store.saveHuddlePresets(lvl === "global" ? null : slug, r.list);
    return { reset: r.reset, presets: this.presets(slug) };
  }

  private levelOf(...a: Parameters<typeof presetsPart.levelOf>): ReturnType<typeof presetsPart.levelOf> { return presetsPart.levelOf.call(this, ...a); }

  // ---- Whole-huddle templates: built-ins, the global huddle-templates.json and the board's ----

  templates(...a: Parameters<typeof templatesPart.templates>): ReturnType<typeof templatesPart.templates> { return templatesPart.templates.call(this, ...a); }

  /** Add or change a template at one level, like savePreset (a lower level's name overrides it). */
  saveTemplate(slug: string, input: unknown, level: unknown = "board"): HuddleTemplateView {
    if (!this.store.getProfile(slug)) throw new HuddleError(404, `board ${slug} not found`);
    if (!isLevel(level)) throw new HuddleError(400, "scope must be board or global");
    const global = this.store.listHuddleTemplates(null);
    const board = this.store.listHuddleTemplates(slug);
    let r: ReturnType<typeof saveTemplate>;
    try {
      r = saveTemplate(level === "global" ? global : board, input, this.presets(slug).map((p) => p.name), lowerLevels(BUILTIN_TEMPLATES, global, level));
    } catch (e) {
      throw new HuddleError(400, (e as Error).message);
    }
    this.store.saveHuddleTemplates(level === "global" ? null : slug, r.list);
    if (level === "global" && board.some((t) => t.name === r.template.name)) this.store.saveHuddleTemplates(slug, board.filter((t) => t.name !== r.template.name));
    return this.templates(slug).find((t) => t.name === r.template.name)!;
  }

  /** Delete a template at one level (default: the one in effect); it falls back to the level below. */
  deleteTemplate(slug: string, name: string, level?: unknown): { reset: boolean; templates: HuddleTemplateView[] } {
    const lvl = this.levelOf(level, this.templates(slug).find((t) => t.name === presetName(name))?.source);
    const global = this.store.listHuddleTemplates(null);
    let r: ReturnType<typeof deleteTemplate>;
    try {
      r = deleteTemplate(this.store.listHuddleTemplates(lvl === "global" ? null : slug), name, lowerLevels(BUILTIN_TEMPLATES, global, lvl));
    } catch (e) {
      throw new HuddleError(/built-in/.test((e as Error).message) ? 409 : 404, (e as Error).message);
    }
    this.store.saveHuddleTemplates(lvl === "global" ? null : slug, r.list);
    return { reset: r.reset, templates: this.templates(slug) };
  }

  usage(...a: Parameters<typeof templatesPart.usage>): ReturnType<typeof templatesPart.usage> { return templatesPart.usage.call(this, ...a); }

  // ---- Role notes (huddle-notes.ts): only the user writes them ----

  notes(...a: Parameters<typeof presetsPart.notes>): ReturnType<typeof presetsPart.notes> { return presetsPart.notes.call(this, ...a); }

  setNotes(...a: Parameters<typeof presetsPart.setNotes>): ReturnType<typeof presetsPart.setNotes> { return presetsPart.setNotes.call(this, ...a); }

  lessonsFor(...a: Parameters<typeof presetsPart.lessonsFor>): ReturnType<typeof presetsPart.lessonsFor> { return presetsPart.lessonsFor.call(this, ...a); }

  addLearnings(...a: Parameters<typeof presetsPart.addLearnings>): ReturnType<typeof presetsPart.addLearnings> { return presetsPart.addLearnings.call(this, ...a); }

  learning(...a: Parameters<typeof presetsPart.learning>): ReturnType<typeof presetsPart.learning> { return presetsPart.learning.call(this, ...a); }

  patched(...a: Parameters<typeof presetsPart.patched>): ReturnType<typeof presetsPart.patched> { return presetsPart.patched.call(this, ...a); }

  editLearning(...a: Parameters<typeof presetsPart.editLearning>): ReturnType<typeof presetsPart.editLearning> { return presetsPart.editLearning.call(this, ...a); }

  saveLearning(...a: Parameters<typeof presetsPart.saveLearning>): ReturnType<typeof presetsPart.saveLearning> { return presetsPart.saveLearning.call(this, ...a); }

  proposeTeammate(...a: Parameters<typeof presetsPart.proposeTeammate>): ReturnType<typeof presetsPart.proposeTeammate> { return presetsPart.proposeTeammate.call(this, ...a); }

  // ---- Squads (huddle templates to the user; see squad.ts) ----

  proposeSquad(...a: Parameters<typeof templatesPart.proposeSquad>): ReturnType<typeof templatesPart.proposeSquad> { return templatesPart.proposeSquad.call(this, ...a); }

  saveSquad(...a: Parameters<typeof templatesPart.saveSquad>): ReturnType<typeof templatesPart.saveSquad> { return templatesPart.saveSquad.call(this, ...a); }

  genericSquad(...a: Parameters<typeof templatesPart.genericSquad>): ReturnType<typeof templatesPart.genericSquad> { return templatesPart.genericSquad.call(this, ...a); }

  discardLearning(...a: Parameters<typeof templatesPart.discardLearning>): ReturnType<typeof templatesPart.discardLearning> { return templatesPart.discardLearning.call(this, ...a); }

  // ---- Changing ----

  update(...a: Parameters<typeof changingPart.update>): ReturnType<typeof changingPart.update> { return changingPart.update.call(this, ...a); }

  hostMoved(...a: Parameters<typeof changingPart.hostMoved>): ReturnType<typeof changingPart.hostMoved> { return changingPart.hostMoved.call(this, ...a); }

  turnCost(...a: Parameters<typeof changingPart.turnCost>): ReturnType<typeof changingPart.turnCost> { return changingPart.turnCost.call(this, ...a); }

  updateP(...a: Parameters<typeof changingPart.updateP>): ReturnType<typeof changingPart.updateP> { return changingPart.updateP.call(this, ...a); }

  append(...a: Parameters<typeof changingPart.append>): ReturnType<typeof changingPart.append> { return changingPart.append.call(this, ...a); }

  system(...a: Parameters<typeof changingPart.system>): ReturnType<typeof changingPart.system> { return changingPart.system.call(this, ...a); }

  create(...a: Parameters<typeof changingPart.create>): ReturnType<typeof changingPart.create> { return changingPart.create.call(this, ...a); }

  writeProposal(...a: Parameters<typeof changingPart.writeProposal>): ReturnType<typeof changingPart.writeProposal> { return changingPart.writeProposal.call(this, ...a); }

  // ---- Auto huddles: an unattended run reviews its own work before landing it (start_huddle) ----

  startAuto(...a: Parameters<typeof autoPart.startAuto>): ReturnType<typeof autoPart.startAuto> { return autoPart.startAuto.call(this, ...a); }

  startForUser(...a: Parameters<typeof autoPart.startForUser>): ReturnType<typeof autoPart.startForUser> { return autoPart.startForUser.call(this, ...a); }

  liveAuto(...a: Parameters<typeof autoPart.liveAuto>): ReturnType<typeof autoPart.liveAuto> { return autoPart.liveAuto.call(this, ...a); }

  autoEnded(...a: Parameters<typeof autoPart.autoEnded>): ReturnType<typeof autoPart.autoEnded> { return autoPart.autoEnded.call(this, ...a); }

  freeSlot(...a: Parameters<typeof autoPart.freeSlot>): ReturnType<typeof autoPart.freeSlot> { return autoPart.freeSlot.call(this, ...a); }

  expand(...a: Parameters<typeof autoPart.expand>): ReturnType<typeof autoPart.expand> { return autoPart.expand.call(this, ...a); }

  nonHuman(...a: Parameters<typeof autoPart.nonHuman>): ReturnType<typeof autoPart.nonHuman> { return autoPart.nonHuman.call(this, ...a); }

  assertOpen(...a: Parameters<typeof autoPart.assertOpen>): ReturnType<typeof autoPart.assertOpen> { return autoPart.assertOpen.call(this, ...a); }

  addParticipants(...a: Parameters<typeof autoPart.addParticipants>): ReturnType<typeof autoPart.addParticipants> { return autoPart.addParticipants.call(this, ...a); }

  invite(...a: Parameters<typeof autoPart.invite>): ReturnType<typeof autoPart.invite> { return autoPart.invite.call(this, ...a); }

  setMode(...a: Parameters<typeof autoPart.setMode>): ReturnType<typeof autoPart.setMode> { return autoPart.setMode.call(this, ...a); }

  findings(...a: Parameters<typeof autoPart.findings>): ReturnType<typeof autoPart.findings> { return autoPart.findings.call(this, ...a); }

  // ---- Changes helpers hand in from their own copies (see huddle-copies.ts) ----

  allowChanges(...a: Parameters<typeof handinPart.allowChanges>): ReturnType<typeof handinPart.allowChanges> { return handinPart.allowChanges.call(this, ...a); }

  handIn(...a: Parameters<typeof handinPart.handIn>): ReturnType<typeof handinPart.handIn> { return handinPart.handIn.call(this, ...a); }

  reviewHandIn(...a: Parameters<typeof handinPart.reviewHandIn>): ReturnType<typeof handinPart.reviewHandIn> { return handinPart.reviewHandIn.call(this, ...a); }

  post(...a: Parameters<typeof messagesPart.post>): ReturnType<typeof messagesPart.post> { return messagesPart.post.call(this, ...a); }

  setBrief(...a: Parameters<typeof messagesPart.setBrief>): ReturnType<typeof messagesPart.setBrief> { return messagesPart.setBrief.call(this, ...a); }

  checkStatus(...a: Parameters<typeof messagesPart.checkStatus>): ReturnType<typeof messagesPart.checkStatus> { return messagesPart.checkStatus.call(this, ...a); }

  checkLessons(...a: Parameters<typeof messagesPart.checkLessons>): ReturnType<typeof messagesPart.checkLessons> { return messagesPart.checkLessons.call(this, ...a); }

  setStatus(...a: Parameters<typeof messagesPart.setStatus>): ReturnType<typeof messagesPart.setStatus> { return messagesPart.setStatus.call(this, ...a); }

  requestClose(...a: Parameters<typeof messagesPart.requestClose>): ReturnType<typeof messagesPart.requestClose> { return messagesPart.requestClose.call(this, ...a); }

  brakes(...a: Parameters<typeof messagesPart.brakes>): ReturnType<typeof messagesPart.brakes> { return messagesPart.brakes.call(this, ...a); }



  halt(...a: Parameters<typeof messagesPart.halt>): ReturnType<typeof messagesPart.halt> { return messagesPart.halt.call(this, ...a); }

  checkBudget(...a: Parameters<typeof messagesPart.checkBudget>): ReturnType<typeof messagesPart.checkBudget> { return messagesPart.checkBudget.call(this, ...a); }

  route(...a: Parameters<typeof routingPart.route>): ReturnType<typeof routingPart.route> { return routingPart.route.call(this, ...a); }

  noteUnwoken(...a: Parameters<typeof routingPart.noteUnwoken>): ReturnType<typeof routingPart.noteUnwoken> { return routingPart.noteUnwoken.call(this, ...a); }

  wakes(...a: Parameters<typeof routingPart.wakes>): ReturnType<typeof routingPart.wakes> { return routingPart.wakes.call(this, ...a); }

  wake(...a: Parameters<typeof routingPart.wake>): ReturnType<typeof routingPart.wake> { return routingPart.wake.call(this, ...a); }

  idleSweep(...a: Parameters<typeof routingPart.idleSweep>): ReturnType<typeof routingPart.idleSweep> { return routingPart.idleSweep.call(this, ...a); }

  idleCheck(...a: Parameters<typeof routingPart.idleCheck>): ReturnType<typeof routingPart.idleCheck> { return routingPart.idleCheck.call(this, ...a); }

  startWatchdog(...a: Parameters<typeof routingPart.startWatchdog>): ReturnType<typeof routingPart.startWatchdog> { return routingPart.startWatchdog.call(this, ...a); }

  wakeIfOwed(...a: Parameters<typeof routingPart.wakeIfOwed>): ReturnType<typeof routingPart.wakeIfOwed> { return routingPart.wakeIfOwed.call(this, ...a); }

  takeUnread(...a: Parameters<typeof routingPart.takeUnread>): ReturnType<typeof routingPart.takeUnread> { return routingPart.takeUnread.call(this, ...a); }

  deliver(...a: Parameters<typeof routingPart.deliver>): ReturnType<typeof routingPart.deliver> { return routingPart.deliver.call(this, ...a); }

  deliverNow(...a: Parameters<typeof routingPart.deliverNow>): ReturnType<typeof routingPart.deliverNow> { return routingPart.deliverNow.call(this, ...a); }

  holdForRestart(...a: Parameters<typeof routingPart.holdForRestart>): ReturnType<typeof routingPart.holdForRestart> { return routingPart.holdForRestart.call(this, ...a); }

  kickoff(...a: Parameters<typeof routingPart.kickoff>): ReturnType<typeof routingPart.kickoff> { return routingPart.kickoff.call(this, ...a); }

  runAgent(...a: Parameters<typeof routingPart.runAgent>): ReturnType<typeof routingPart.runAgent> { return routingPart.runAgent.call(this, ...a); }

  workspace(...a: Parameters<typeof agentsPart.workspace>): ReturnType<typeof agentsPart.workspace> { return agentsPart.workspace.call(this, ...a); }

  copyFor(...a: Parameters<typeof agentsPart.copyFor>): ReturnType<typeof agentsPart.copyFor> { return agentsPart.copyFor.call(this, ...a); }

  snapshot(...a: Parameters<typeof agentsPart.snapshot>): ReturnType<typeof agentsPart.snapshot> { return agentsPart.snapshot.call(this, ...a); }

  browserLease(...a: Parameters<typeof agentsPart.browserLease>): ReturnType<typeof agentsPart.browserLease> { return agentsPart.browserLease.call(this, ...a); }

  executeAgent(...a: Parameters<typeof agentsPart.executeAgent>): ReturnType<typeof agentsPart.executeAgent> { return agentsPart.executeAgent.call(this, ...a); }

  stopParticipantRun(...a: Parameters<typeof agentsPart.stopParticipantRun>): ReturnType<typeof agentsPart.stopParticipantRun> { return agentsPart.stopParticipantRun.call(this, ...a); }

  stopParticipant(...a: Parameters<typeof lifecyclePart.stopParticipant>): ReturnType<typeof lifecyclePart.stopParticipant> { return lifecyclePart.stopParticipant.call(this, ...a); }

  restartParticipant(...a: Parameters<typeof lifecyclePart.restartParticipant>): ReturnType<typeof lifecyclePart.restartParticipant> { return lifecyclePart.restartParticipant.call(this, ...a); }

  markSeen(...a: Parameters<typeof lifecyclePart.markSeen>): ReturnType<typeof lifecyclePart.markSeen> { return lifecyclePart.markSeen.call(this, ...a); }

  userActed(...a: Parameters<typeof lifecyclePart.userActed>): ReturnType<typeof lifecyclePart.userActed> { return lifecyclePart.userActed.call(this, ...a); }

  stopAll(...a: Parameters<typeof lifecyclePart.stopAll>): ReturnType<typeof lifecyclePart.stopAll> { return lifecyclePart.stopAll.call(this, ...a); }

  resume(...a: Parameters<typeof lifecyclePart.resume>): ReturnType<typeof lifecyclePart.resume> { return lifecyclePart.resume.call(this, ...a); }

  close(...a: Parameters<typeof lifecyclePart.close>): ReturnType<typeof lifecyclePart.close> { return lifecyclePart.close.call(this, ...a); }

  closeForTicket(...a: Parameters<typeof lifecyclePart.closeForTicket>): ReturnType<typeof lifecyclePart.closeForTicket> { return lifecyclePart.closeForTicket.call(this, ...a); }

  ensureSummary(...a: Parameters<typeof lifecyclePart.ensureSummary>): ReturnType<typeof lifecyclePart.ensureSummary> { return lifecyclePart.ensureSummary.call(this, ...a); }

  writeFallbackSummary(...a: Parameters<typeof lifecyclePart.writeFallbackSummary>): ReturnType<typeof lifecyclePart.writeFallbackSummary> { return lifecyclePart.writeFallbackSummary.call(this, ...a); }

  touch(...a: Parameters<typeof lifecyclePart.touch>): ReturnType<typeof lifecyclePart.touch> { return lifecyclePart.touch.call(this, ...a); }

  chore(...a: Parameters<typeof lifecyclePart.chore>): ReturnType<typeof lifecyclePart.chore> { return lifecyclePart.chore.call(this, ...a); }

  removeWorktrees(...a: Parameters<typeof lifecyclePart.removeWorktrees>): ReturnType<typeof lifecyclePart.removeWorktrees> { return lifecyclePart.removeWorktrees.call(this, ...a); }

  cleanOutputs(...a: Parameters<typeof lifecyclePart.cleanOutputs>): ReturnType<typeof lifecyclePart.cleanOutputs> { return lifecyclePart.cleanOutputs.call(this, ...a); }

  cleanOutputsNow(...a: Parameters<typeof lifecyclePart.cleanOutputsNow>): ReturnType<typeof lifecyclePart.cleanOutputsNow> { return lifecyclePart.cleanOutputsNow.call(this, ...a); }

  shutdown(...a: Parameters<typeof lifecyclePart.shutdown>): ReturnType<typeof lifecyclePart.shutdown> { return lifecyclePart.shutdown.call(this, ...a); }

  recover(...a: Parameters<typeof lifecyclePart.recover>): ReturnType<typeof lifecyclePart.recover> { return lifecyclePart.recover.call(this, ...a); }

  whenIdle(...a: Parameters<typeof lifecyclePart.whenIdle>): ReturnType<typeof lifecyclePart.whenIdle> { return lifecyclePart.whenIdle.call(this, ...a); }
}
