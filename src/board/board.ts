import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractFinalText, summarizeEvent } from "../runs/activity";
import { localizeAttachments } from "./attachments";
import type { Bus } from "../core/events";
import { isSessionLive as psSessionLive, sessionTitle } from "../runs/claude";
import { FetchError, type RepoKind } from "../runs/git";
import { MOVE_TO_PLANNING_RE, STAY_RE } from "../runs/session";
import { saveMockups } from "./mockups";
import { Devices } from "../browser/devices";
import { ChromeWatch, Chromes, ownPicks, resolveBrowserPicks, resolveChromeSetting, type BrowserPick, type ChromeChoice } from "../browser/chromes";
import { BoardBrowsers, BROWSER_FILES_DIR, browserServer, serverName } from "../browser/board-browsers";
import { macBanner } from "../helper/notify";
import { type HostHuddle } from "../helper/attention";
import type { SessionSummary } from "../runs/session";
import { RecallIndex } from "./recall";
import { familyBelow, featureRoot, featureRows, linkProblem, nextRoundTitle, type TicketKind } from "../../web/src/features/family/family";
import { type SavedChanges } from "./feature";
import { followUpPlace } from "../../web/src/features/ticket/followUp";
import { canEndQuietly } from "../schedules/quiet";
import { addTelegramSpend } from "../usage/spend";
import { mainTicketRules, toolFirstPrompt, type RunRole } from "../runs/prompts";
import { learnModel, useModelVersionsFile } from "../runs/model-versions";
import { askedNothing, familyCard, type FamilyCard, MERGE_TRIES, replyAsked } from "./main-ticket";
import { chatNotes, chatPrompt, chromeChoiceNote, chromeTurnNote, withoutChromeRule, type BoardBrowserChoice, devicesNote, firstRunPrompt, mentionsArtifact, planningCommand, planningPrompt, resumePrompt, toolsChangedNote } from "../runs/prompts";
import { planActive } from "./plan";
import { run as runCmd } from "../runs/git";
import { addPrs } from "./prs";
import { deleteSnapshots, takeSnapshot } from "../chat/rewind";
import { parseResult } from "../runs/result";
import { limitMessage } from "../usage/limit";
import { DraftTracker } from "../chat/draft";
import { startRun, type RunHandle } from "../runs/runner";
import { RETRY_DELAY_MS, RETRY_TEXT, transientError } from "../runs/retry";
import { BOARD_COMMANDS, parseSlash, REFUSED_COMMANDS, rememberInit, slashMessage, useBundledFile } from "../chat/commands";
import { toolsVersion } from "../mcp/server";
import { type Store } from "../core/store";
import { maskSaved } from "../integrations/board-keys";
import { autoHuddlesOn, runCapFor, type PrStatus, type QueuedMessage, type Ticket } from "../core/types";
import { type SetupOutcome } from "../runs/worktree-setup";
import { nowIso } from "../core/util";
import { THINKING_LINE, RunBrowsers, BoardOptions, ActiveRun, hasText, replayText, chatFor, flags, StillRefused, ChatOptions, autoHuddleActivity, reopenable, takesSlot, ACTIVITY_THROTTLE_MS, FOLDER_WAIT, Session, STALL_RESTART_TEXT, DRAFT_THROTTLE_MS, RunSpend, spentWith, WORKFLOW_CAP_POLL_MS, claudeSessionExists, REWINDING, sessionMissing, claudeSetupHint, SESSION_OPEN_MSG, ConflictError, startError } from "./board-types";
import * as devicesPart from "./board-devices";
import * as rewindPart from "./board-rewind";
import * as queuePart from "./board-queue";
import * as limitsPart from "./board-limits";
import * as followupsPart from "./board-followups";
import * as repoPart from "./board-repo";
import * as ticketsPart from "./board-tickets";
import * as plansPart from "./board-plans";
import * as familiesPart from "./board-families";
import * as mainPart from "./board-main";
import * as featuresPart from "./board-features";
import * as recoveryPart from "./board-recovery";

export * from "./board-types";

// The class keeps its fields, the constructor and the core run loop (chat, start, execute). Other methods live by topic
// in board-*.ts as functions with `this: Board`; the one-line methods here call them, so `board.x()` works as before.

export class Board {
  runs = new Map<string, ActiveRun>();
  /** "What we did before" word index per board (recall.ts), kept up to date as tickets change. */
  recallIndexes = new Map<string, RecallIndex>();
  /** Per ticket: the last form answer taken and when (repeatedAnswer). */
  recentAnswers = new Map<string, { text: string; at: number }>();
  /** Latest live progress of each workflow (stream task_progress: every agent, waiting ones too), by ticket and Workflow call. */
  workflowLive = new Map<string, any[]>();
  /** Shared devices every board's runs take and let go (devices.ts); a run's end frees what it still holds. */
  readonly devices: Devices;
  /** Named Chromes (More → Browsers), learned from runs' list_connected_browsers results (chromes.ts). */
  readonly chromes: Chromes;
  /** The board's own browsers (More → Browsers, board-browsers.ts): Chromes it starts per set of logins, for runs. */
  readonly boardBrowsers: BoardBrowsers;
  /** Setup commands running now (`ckanban ticket setup`; stopping the ticket's run aborts them), per ticket key. */
  setups = new Map<string, { done: Promise<SetupOutcome>; abort: AbortController }>();
  shuttingDown = false;
  /** A restart waits for active runs to finish: no new run starts until then (see requestRestart). */
  restartPending = false;
  /** Other work a restart waits for besides board runs (huddle agents mid-turn), see onRestartBusy. */
  restartBusy: (() => string[])[] = [];
  /** Each board's open huddles by host ticket (see onHostHuddles); none until Huddles registers. */
  hostHuddleStates: (slug: string) => Map<string, HostHuddle> = () => new Map();
  sessionExists: (id: string) => boolean;
  isSessionLive: (id: string, title: string | null) => Promise<boolean>;
  notify: (title: string, body: string, slug: string, id: string) => void;

  sessionSummary: (sessionId: string) => SessionSummary | null;

  constructor(public store: Store, public bus: Bus, public opts: BoardOptions) {
    this.sessionSummary = opts.sessionSummary ?? (() => null);
    this.sessionExists = opts.sessionExists ?? claudeSessionExists;
    this.isSessionLive = opts.isSessionLive ?? psSessionLive;
    this.notify = opts.notify ?? ((title, body) => macBanner(title, body));
    useBundledFile(join(store.root, "claude-commands.json"));
    useModelVersionsFile(join(store.root, "model-versions.json"));
    this.devices = new Devices(store.root, (owners) => this.devicesChanged(owners));
    this.chromes = new Chromes(store.root, () => this.bus.emit({ type: "browsers.updated" }));
    this.boardBrowsers = new BoardBrowsers(store.root, () => this.bus.emit({ type: "browsers.updated" }), opts.browserDeps);
  }

  /** The browsers a ticket's runs may use (its own list, the ticket above it, the board's); null ticket: the board's. */
  browserPicks(slug: string, t: Ticket | null): BrowserPick[] | null {
    const profile = this.store.getProfile(slug);
    return t ? resolveBrowserPicks(t, this.store.listTickets(slug), profile) : ownPicks(profile);
  }

  /** The tool servers for the board browsers in a list, without starting them (the Context panel's copy of a run's flags). */
  browserServers(picks: BrowserPick[] | null, outDir: string | null): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of picks ?? []) {
      const b = p.kind === "board" && p.id ? this.boardBrowsers.get(p.id) : undefined;
      if (b) out[serverName(b.id)] = browserServer(b, this.boardBrowsers.folder(b.id), outDir ?? join(this.store.root, BROWSER_FILES_DIR, b.id));
    }
    return out;
  }

  /**
   * What a run (lease: "slug/id", a quick chat, a huddle agent) gets for its browsers: each chosen board browser is
   * started and kept open until boardBrowsers.release(lease), with a tool server named browser-<id>; one that can't
   * start is left out and the run is told so in plain words. Only board browsers chosen: no Claude in Chrome.
   * Nothing chosen: nothing changes (note null, Claude in Chrome as before).
   */
  async runBrowsers(slug: string, t: Ticket | null, lease: string, outDir: string | null): Promise<RunBrowsers> {
    const picks = this.browserPicks(slug, t);
    const chrome = this.chromes.choiceOf(picks);
    const own = (picks ?? []).filter((p) => p.kind === "board" && p.id && this.boardBrowsers.get(p.id));
    const board: BoardBrowserChoice[] = [];
    // A chosen board browser that was removed since: the run hears it isn't there (and doesn't fall back to Claude in Chrome).
    for (const p of picks ?? []) {
      if (p.kind === "board" && p.id && !this.boardBrowsers.get(p.id)) {
        board.push({ id: p.id, name: p.id, ...(p.note ? { note: p.note } : {}), server: serverName(p.id), available: false, why: "it was removed from More, Browsers" });
      }
    }
    let servers: Record<string, unknown> = {};
    if (own.length) {
      const got = await this.boardBrowsers.acquire(lease, own.map((p) => p.id!));
      const up = own.filter((p) => got.get(p.id!)?.ok);
      servers = this.browserServers(up, outDir);
      for (const p of own) {
        const b = this.boardBrowsers.get(p.id!)!;
        const r = got.get(p.id!);
        board.push({ id: b.id, name: b.name, ...(p.note ? { note: p.note } : {}), server: serverName(b.id), available: !!r?.ok, why: r && !r.ok ? r.why : null });
      }
    }
    return { servers, note: chromeChoiceNote(chrome, board), noChrome: board.length > 0 && !chrome };
  }

  /** The Chrome a ticket's runs use: its own pick, else the nearest ticket above it with one, else the board's default. */
  chromeChoice(slug: string, t: Ticket): ChromeChoice {
    const setting = resolveChromeSetting(t, this.store.listTickets(slug), this.store.getProfile(slug)?.chrome);
    return this.chromes.choice(setting);
  }

  key(slug: string, id: string) {
    return `${slug}/${id}`;
  }

  emitTicket(slug: string, t: Ticket) {
    this.bus.emit({ type: "ticket.updated", profile: slug, ticket: t });
  }

  patch(slug: string, id: string, patch: Partial<Ticket>): Ticket {
    // Every new activity line is stamped, so the card can show how long ago the last step was (W7).
    if ("lastActivity" in patch && !("lastActivityAt" in patch)) patch = { ...patch, lastActivityAt: patch.lastActivity ? nowIso() : null };
    const t = this.store.updateTicket(slug, id, patch);
    this.emitTicket(slug, t);
    // Done: nothing will be rewound any more, so its saved copies of the folder go (in the background).
    if (patch.status === "done") void this.dropRewindCopies(slug, t);
    return t;
  }

  /** Deletes the ticket's saved copies for Rewind, wherever its Claude worked (the board's folder or a linked one). */
  async dropRewindCopies(slug: string, t: Ticket): Promise<void> {
    const profile = this.store.getProfile(slug);
    const dirs = new Set([profile?.path, t.workdir].filter((d): d is string => !!d && existsSync(d)));
    for (const dir of dirs) await deleteSnapshots(dir, t.id).catch(() => {});
  }

  /** Cache the ticket's PR status (prpoller.ts) and tell the UI. */
  setPr(slug: string, id: string, pr: PrStatus): Ticket {
    return this.patch(slug, id, { pr });
  }

  /** Record the ticket's PR list and main PR (prs.ts) and tell the UI. */
  patchPrs(slug: string, id: string, prs: Pick<Ticket, "prs" | "prUrl">): Ticket {
    return this.patch(slug, id, prs);
  }

  // ---- Shared devices (devices.ts): taken by a run only while it uses them; Ticket.needs is just a hint ----

  private devicesChanged(...a: Parameters<typeof devicesPart.devicesChanged>): ReturnType<typeof devicesPart.devicesChanged> { return devicesPart.devicesChanged.call(this, ...a); }

  deviceState(...a: Parameters<typeof devicesPart.deviceState>): ReturnType<typeof devicesPart.deviceState> { return devicesPart.deviceState.call(this, ...a); }

  waitsForAnswer(...a: Parameters<typeof devicesPart.waitsForAnswer>): ReturnType<typeof devicesPart.waitsForAnswer> { return devicesPart.waitsForAnswer.call(this, ...a); }

  userWait(...a: Parameters<typeof devicesPart.userWait>): ReturnType<typeof devicesPart.userWait> { return devicesPart.userWait.call(this, ...a); }

  waitsOnUser(...a: Parameters<typeof devicesPart.waitsOnUser>): ReturnType<typeof devicesPart.waitsOnUser> { return devicesPart.waitsOnUser.call(this, ...a); }

  setSnooze(...a: Parameters<typeof devicesPart.setSnooze>): ReturnType<typeof devicesPart.setSnooze> { return devicesPart.setSnooze.call(this, ...a); }

  running(...a: Parameters<typeof devicesPart.running>): ReturnType<typeof devicesPart.running> { return devicesPart.running.call(this, ...a); }

  holdsSlot(...a: Parameters<typeof devicesPart.holdsSlot>): ReturnType<typeof devicesPart.holdsSlot> { return devicesPart.holdsSlot.call(this, ...a); }


  isRunning(...a: Parameters<typeof devicesPart.isRunning>): ReturnType<typeof devicesPart.isRunning> { return devicesPart.isRunning.call(this, ...a); }

  runningKey(...a: Parameters<typeof devicesPart.runningKey>): ReturnType<typeof devicesPart.runningKey> { return devicesPart.runningKey.call(this, ...a); }

  workflowProgress(...a: Parameters<typeof devicesPart.workflowProgress>): ReturnType<typeof devicesPart.workflowProgress> { return devicesPart.workflowProgress.call(this, ...a); }

  private watchWorkflows(...a: Parameters<typeof devicesPart.watchWorkflows>): ReturnType<typeof devicesPart.watchWorkflows> { return devicesPart.watchWorkflows.call(this, ...a); }

  stopWorkflow(...a: Parameters<typeof devicesPart.stopWorkflow>): ReturnType<typeof devicesPart.stopWorkflow> { return devicesPart.stopWorkflow.call(this, ...a); }

  isPeerRun(...a: Parameters<typeof devicesPart.isPeerRun>): ReturnType<typeof devicesPart.isPeerRun> { return devicesPart.isPeerRun.call(this, ...a); }

  dispatch(...a: Parameters<typeof devicesPart.dispatch>): ReturnType<typeof devicesPart.dispatch> { return devicesPart.dispatch.call(this, ...a); }

  waitForSlot(...a: Parameters<typeof devicesPart.waitForSlot>): ReturnType<typeof devicesPart.waitForSlot> { return devicesPart.waitForSlot.call(this, ...a); }

  cancelSlotWait(...a: Parameters<typeof devicesPart.cancelSlotWait>): ReturnType<typeof devicesPart.cancelSlotWait> { return devicesPart.cancelSlotWait.call(this, ...a); }

  /**
   * Send a chat message: resumes the ticket's session right away, like typing in the terminal.
   * While Claude is working the message steers the run instead: Claude reads it at its next step.
   * peer: the message comes from another session (a huddle) and is already a full prompt.
   */
  async chat(slug: string, id: string, text: string, opts: ChatOptions = {}): Promise<Ticket> {
    // A rewind, undo or fork is cutting or copying the chat right now: a message must not start a run on it.
    if (this.rewinding.has(this.key(slug, id))) throw new ConflictError(REWINDING);
    // Rewind needs the folder as it is right before this message: saved quietly, the user's own history is untouched.
    // Done first, so everything below still runs in one go (a message can't slip in between the checks and the start).
    // Only when Claude is idle: a message sent while it works steers the run and can't be rewound to anyway, and
    // waiting on the copy there would let the run finish or stop in between.
    if (!opts.peer && !opts.hostWake && !opts.followUp && text.trim() && !this.runs.has(this.key(slug, id))) {
      const dir = this.rewindDir(slug, id);
      if (dir) await takeSnapshot(dir, id, text);
    }
    return this.chatNow(slug, id, text, opts);
  }

  private async chatNow(slug: string, id: string, text: string, opts: ChatOptions): Promise<Ticket> {
    // Checked again after the snapshot wait: a rewind may have started meanwhile.
    if (this.rewinding.has(this.key(slug, id))) throw new ConflictError(REWINDING);
    if (opts.still && !opts.still()) throw new StillRefused();
    let t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (!text.trim()) throw new Error("message is empty");
    if (t.error?.startsWith("corrupt")) throw new Error("ticket file is corrupt");
    const active = this.runs.get(this.key(slug, id));
    if (opts.fresh) {
      if (active) throw new ConflictError("Claude is working on this ticket; send it once Claude is done");
      t = this.startFreshChat(slug, id);
    }
    if (!opts.peer && !opts.slash && !opts.hostWake && !opts.followUp) {
      const refused = parseSlash(text)?.name;
      if (refused && REFUSED_COMMANDS.has(refused)) {
        throw new Error(`/${refused} isn't available here: start a new ticket for a fresh conversation.`);
      }
      const slash = slashMessage(text, this.commands(slug, id));
      if (slash && BOARD_COMMANDS.has(slash.command.name)) return this.boardCommand(slug, id, slash.command.name, slash.args);
      if (slash) [text, opts] = [slash.text, { ...opts, slash: slash.command.local ? "local" : "prompt" }];
    }
    // The same form answer twice (two tabs, or a second tap while the board was slow): the first one counts. Only form
    // answers; ordinary chat text the user repeats is sent again.
    if (this.repeatedAnswer(slug, id, t, text, opts)) return t;
    // The user writes (or answers a form) in a main ticket parked in Done, or in Backlog after its family started: they
    // want more from it, so it is back in Review and stays there (only the user's own move parks it again). A follow-up
    // brings it back only while its tool tickets are still at work; otherwise it rests where the user put it.
    if (t.main && !opts.peer && !opts.fromPlanner && !opts.hostWake && opts.slash !== "local") {
      const user = !opts.followUp;
      if (user ? this.unparkMain(slug, id, "you wrote in its chat", true) : this.openSteps(slug, id) && this.unparkMain(slug, id, "its follow-up came while its steps are still at work")) {
        t = this.store.getTicket(slug, id)!;
        // Steps it held back while parked start again.
        if (t.plan) this.advancePlans(slug);
      }
    }
    // The user chats on a Backlog card: it is being shaped now, so it shows in Planning (a running plan's children stay put).
    const parent = t.parentId ? this.store.getTicket(slug, t.parentId) : null;
    if (t.status === "backlog" && !opts.peer && !opts.fromPlanner && !opts.hostWake && !opts.followUp && opts.slash !== "local" && !planActive(parent?.plan)) {
      t = this.patch(slug, id, { status: "planning", refineStarted: true });
    }
    // The user (or the board's automatic continue) picks the conversation up again: the limit wait is over.
    if (t.limit && !opts.peer && !opts.hostWake && !opts.followUp) this.patch(slug, id, { limit: null });
    // The user answers a main ticket whose plan got stuck (it asked them something, or went round in circles): its
    // family's engine goes on, and the no-progress count starts over.
    if (t.main && t.plan?.state === "stuck" && !opts.peer && !opts.fromPlanner && !opts.hostWake && !opts.followUp) {
      t = this.patch(slug, id, { plan: { ...t.plan, state: "running", reason: null, awaiting: null, noProgress: 0 } });
    }
    // The user writes (or answers a form) in a stopped main ticket's chat: Stop held its steps only until now.
    if (t.main && t.plan?.state === "paused" && !opts.peer && !opts.fromPlanner && !opts.hostWake && !opts.followUp && opts.slash !== "local") {
      if (this.resumeStoppedPlan(slug, id, "you wrote in its chat")) t = this.store.getTicket(slug, id)!;
    }
    if (active) {
      if (active.stopRequested || this.shuttingDown) throw new ConflictError("Claude is stopping; send your message once it has stopped");
      // Saved on the ticket until Claude reads it, so closing the chat, Stop or a restart can't lose it.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      this.patch(slug, id, { queued: [...(t.queued ?? []), msg] });
      // A nextRun message waits for this run to end: drainQueue then starts a new run with it.
      if (!msg.nextRun) this.steer(active, msg);
      return this.store.getTicket(slug, id)!;
    }
    if (this.restartPending) {
      // Starts after the restart: recover() answers queued messages.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      return this.patch(slug, id, { queued: [...(t.queued ?? []), msg] });
    }
    // A cold, large main or feature chat: this turn starts fresh from the status (not for a reply to another session).
    if (!opts.peer && !opts.fresh && !opts.automation) t = this.autoFresh(slug, t);
    const chat = chatFor(t, { text, ...opts });
    // A reply that may edit files (not a read-only Planning one) waits while another ticket edits the folder in place.
    const folderBusy = chat.mode === "act" && this.folderBusy(slug, t);
    const slot = takesSlot(chat, t.main);
    if (!slot && (folderBusy || t.slotWait)) {
      // A reply to another session (a huddle) holds no slot: it waits on the ticket without moving the card.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      this.patch(slug, id, {
        queued: [...(t.queued ?? []), msg], lastActivity: FOLDER_WAIT,
        slotWait: t.slotWait ?? { at: nowIso(), from: { status: t.status, outcome: t.outcome } },
      });
      this.dispatch(slug);
      return this.store.getTicket(slug, id)!;
    }
    if (slot && (t.slotWait || folderBusy)) {
      // Another ticket edits the folder in place: the reply waits on the ticket like a Ready ticket, but starts before them.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      this.patch(slug, id, { queued: [...(t.queued ?? []), msg] });
      this.waitForSlot(slug, id);
      this.dispatch(slug);
      return this.store.getTicket(slug, id)!;
    }
    // The user's message is saved until Claude reads it: Stop before then leaves it unsent, not lost.
    // If the run can't start (e.g. the disk is full), the message is still saved where possible, and the caller hears why.
    if (opts.peer || opts.hostWake || opts.followUp) {
      const failed = this.start(slug, id, chat);
      if (failed) throw failed;
    } else {
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      const failed = this.start(slug, id, chat, msg.id);
      // Added once the run is registered, so the chat never shows it as waiting with no run behind it.
      try {
        this.patch(slug, id, { queued: [...(this.store.getTicket(slug, id)!.queued ?? []), msg] });
      } catch (e) {
        if (!failed) throw e;
      }
      if (failed) throw failed;
    }
    return this.store.getTicket(slug, id)!;
  }

  rewindDir(...a: Parameters<typeof rewindPart.rewindDir>): ReturnType<typeof rewindPart.rewindDir> { return rewindPart.rewindDir.call(this, ...a); }

  /** Tickets with a rewind, undo or fork under way: one at a time, and no message starts meanwhile. */
  rewinding = new Set<string>();

  rewindBlocked(...a: Parameters<typeof rewindPart.rewindBlocked>): ReturnType<typeof rewindPart.rewindBlocked> { return rewindPart.rewindBlocked.call(this, ...a); }

  rewound(...a: Parameters<typeof rewindPart.rewound>): ReturnType<typeof rewindPart.rewound> { return rewindPart.rewound.call(this, ...a); }

  /** Runs a rewind, undo or fork of the ticket's chat, refused while another one or a run is under way. */
  async withRewind<T>(slug: string, id: string, f: () => Promise<T>): Promise<T> {
    const blocked = this.rewindBlocked(slug, id);
    if (blocked) throw new ConflictError(blocked);
    const k = this.key(slug, id);
    this.rewinding.add(k);
    try {
      return await f();
    } finally {
      this.rewinding.delete(k);
    }
  }

  undoRewindBlocked(...a: Parameters<typeof rewindPart.undoRewindBlocked>): ReturnType<typeof rewindPart.undoRewindBlocked> { return rewindPart.undoRewindBlocked.call(this, ...a); }

  undoRewind(...a: Parameters<typeof rewindPart.undoRewind>): ReturnType<typeof rewindPart.undoRewind> { return rewindPart.undoRewind.call(this, ...a); }

  undoRewindNow(...a: Parameters<typeof rewindPart.undoRewindNow>): ReturnType<typeof rewindPart.undoRewindNow> { return rewindPart.undoRewindNow.call(this, ...a); }

  commands(...a: Parameters<typeof queuePart.commands>): ReturnType<typeof queuePart.commands> { return queuePart.commands.call(this, ...a); }

  private boardCommand(...a: Parameters<typeof queuePart.boardCommand>): ReturnType<typeof queuePart.boardCommand> { return queuePart.boardCommand.call(this, ...a); }

  sendQueued(...a: Parameters<typeof queuePart.sendQueued>): ReturnType<typeof queuePart.sendQueued> { return queuePart.sendQueued.call(this, ...a); }

  discardQueued(...a: Parameters<typeof queuePart.discardQueued>): ReturnType<typeof queuePart.discardQueued> { return queuePart.discardQueued.call(this, ...a); }

  editQueued(...a: Parameters<typeof queuePart.editQueued>): ReturnType<typeof queuePart.editQueued> { return queuePart.editQueued.call(this, ...a); }

  held(...a: Parameters<typeof queuePart.held>): ReturnType<typeof queuePart.held> { return queuePart.held.call(this, ...a); }

  dropQueued(...a: Parameters<typeof queuePart.dropQueued>): ReturnType<typeof queuePart.dropQueued> { return queuePart.dropQueued.call(this, ...a); }

  private repeatedAnswer(...a: Parameters<typeof queuePart.repeatedAnswer>): ReturnType<typeof queuePart.repeatedAnswer> { return queuePart.repeatedAnswer.call(this, ...a); }

  private steer(...a: Parameters<typeof queuePart.steer>): ReturnType<typeof queuePart.steer> { return queuePart.steer.call(this, ...a); }

  waiting(...a: Parameters<typeof queuePart.waiting>): ReturnType<typeof queuePart.waiting> { return queuePart.waiting.call(this, ...a); }

  private delivered(...a: Parameters<typeof queuePart.delivered>): ReturnType<typeof queuePart.delivered> { return queuePart.delivered.call(this, ...a); }

  autoRefine(...a: Parameters<typeof queuePart.autoRefine>): ReturnType<typeof queuePart.autoRefine> { return queuePart.autoRefine.call(this, ...a); }

  /**
   * Starts the ticket's run. Returns the error when it could not even start (e.g. the disk is full): the run is not
   * registered then, and the card shows the error; the caller keeps any message it meant for the run.
   */
  start(slug: string, id: string, chat?: ActiveRun["chat"], promptMsgId?: string): Error | null {
    const run: ActiveRun = {
      slug, id, handle: null, promise: Promise.resolve(), targetStatus: null, stopRequested: false, chat, inFlight: new Map(), promptMsgId,
      noEdit: !!this.store.getTicket(slug, id)?.main,
    };
    this.runs.set(this.key(slug, id), run);
    try {
      this.begin(run);
    } catch (e) {
      const err = new Error(startError(e));
      console.error(`run ${slug}/${id} could not start`, e);
      // Never a ghost run: without its promise nothing would ever unregister it.
      this.dropRun(run, { ...this.endStatus(run), outcome: "failed", error: err.message, lastActivity: null, runStartedAt: null });
      return err;
    }
    run.started = true;
    run.promise = this.execute(run)
      .catch((e) => {
        console.error(`run ${slug}/${id} crashed`, e);
        try {
          this.patch(slug, id, { ...this.endStatus(run), outcome: "failed", error: String(e?.message ?? e) });
        } catch {}
      })
      .finally(async () => {
        this.runs.delete(this.key(slug, id));
        // Whatever devices the run still holds or waits for go to the next ticket in line.
        this.devices.releaseAll(slug, id);
        this.boardBrowsers.release(this.key(slug, id));
        if (run.quietEnd && !this.shuttingDown && await this.endQuietly(slug, id, run.quietEnd)) {
          if (this.restartPending) this.emitRestart();
          this.dispatch(slug);
          return;
        }
        // Before a pending restart, so the move the user asked for isn't lost.
        await this.applySelfMove(run);
        if (this.restartPending) this.emitRestart();
        // Tell the UI the run is over (earlier updates were sent while it was still registered).
        const now = this.store.getTicket(slug, id);
        if (now && !this.shuttingDown) {
          if (now.runStartedAt || now.interrupted || now.waitingOn || now.stalled || now.followUpRun) this.patch(slug, id, { runStartedAt: null, interrupted: null, waitingOn: null, stalled: null, followUpRun: null });
          else this.emitTicket(slug, now);
        }
        // When the user moved the card, updateTicket() writes the new status and dispatches itself.
        if (!this.shuttingDown && !run.targetStatus) this.dispatch(slug);
        if (!this.shuttingDown) this.advancePlans(slug);
        if (!this.shuttingDown) for (const fn of this.runEnded) {
          try {
            fn(slug, id);
          } catch {}
        }
      });
    return null;
  }

  /**
   * Unregisters a run that has no promise behind it (it could not start), and puts what it shows on the card. The
   * patch may fail too (a full disk): the run is gone from the board either way.
   */
  dropRun(run: ActiveRun, patch: Partial<Ticket>): void {
    const { slug, id } = run;
    if (this.runs.get(this.key(slug, id)) === run) this.runs.delete(this.key(slug, id));
    this.devices.releaseAll(slug, id);
    this.boardBrowsers.release(this.key(slug, id));
    try {
      if (this.store.getTicket(slug, id)) this.patch(slug, id, patch);
    } catch (e) {
      console.error(`couldn't record the end of run ${slug}/${id}`, e);
    }
    if (this.restartPending) this.emitRestart();
  }

  /** The move the user asked the run for, now that its reply is over; not when the user stopped or moved it meanwhile. */
  private async applySelfMove(run: ActiveRun): Promise<void> {
    const status = run.selfMove;
    if (!status || run.stopRequested || run.targetStatus || this.shuttingDown || this.isRunning(run.slug, run.id)) return;
    const t = this.store.getTicket(run.slug, run.id);
    if (!t || t.status === status) return;
    try {
      await this.updateTicket(run.slug, run.id, { status }, { byUser: true });
      this.store.addComment(run.slug, run.id, "ai", `Moved it to ${status} by its own chat (user request).`);
    } catch (e) {
      this.store.addComment(run.slug, run.id, "ai", `Couldn't move it to ${status} as asked in the chat: ${(e as Error).message}`);
    }
  }

  begin(run: ActiveRun) {
    if (run.chat && !run.chat.quiet && (run.chat.mode !== "refine" || run.chat.text.trim())) run.statusEligible = true;
    const t = this.store.getTicket(run.slug, run.id);
    const followUpRun = run.chat?.followUp && run.chat.returnTo ? { returnTo: run.chat.returnTo } : null;
    if (followUpRun || t?.followUpRun) this.patch(run.slug, run.id, { followUpRun });
    // A main ticket's replies and wakes don't move its card: it stays where the user put it.
    this.patch(run.slug, run.id, run.chat?.quiet || (run.chat && run.noEdit && run.chat.mode === "act" && !run.chat.hostWake)
      ? { error: null, lastActivity: THINKING_LINE, runStartedAt: nowIso(), waitingOn: null, stalled: null }
      : run.chat?.mode === "refine"
      ? { error: null, lastActivity: THINKING_LINE, refineStarted: true, runStartedAt: nowIso(), waitingOn: null, stalled: null }
      : { status: "in_progress", outcome: null, error: null, limit: null, capHit: null, lastActivity: "Starting…", runStartedAt: nowIso(), waitingOn: null, stalled: null });
  }

  /** One claude run, then a chat reply for each message that came in too late for it. */
  private async execute(run: ActiveRun): Promise<void> {
    const startedAt = nowIso();
    await this.executeOnce(run);
    if (run.chat?.followUp) await this.followUpCost(run.slug, run.id);
    await this.drainQueue(run);
    if (await this.nudgeStatus(run, startedAt)) await this.drainQueue(run);
  }

  /** A chat reply for each message that came in too late for the run's last turn. */
  private async drainQueue(run: ActiveRun): Promise<void> {
    for (;;) {
      if (this.shuttingDown || this.restartPending) return; // queue stays on the ticket; recover() delivers it
      const t = this.store.getTicket(run.slug, run.id);
      if (!t) return;
      const next = this.waiting(run.slug, run.id)[0];
      if (!next) return;
      // Stopped, or the last reply could not even start: keep them for the user to send or discard.
      if (run.stopRequested || run.promptMsgId === next.id) {
        this.patch(run.slug, run.id, { queued: (t.queued ?? []).map((m) => (m.state === "queued" ? { ...m, state: "unsent" } : m)) });
        return;
      }
      const chat = chatFor(t, next);
      // A Planning or peer reply run that would now edit waits while another ticket edits the folder in place.
      if (takesSlot(chat, run.noEdit) && !takesSlot(run.chat, run.noEdit) && chat.mode === "act" && this.folderBusy(run.slug, t)) {
        this.waitForSlot(run.slug, run.id);
        return;
      }
      run.chat = chat;
      // A message came in after a quiet run: the user is talking to this ticket now, so it stays.
      run.quietEnd = undefined;
      run.retried = false;
      run.restartRequested = false;
      // Each turn has its own rights: the user's message steered into the last one doesn't carry over to this one.
      run.userSteered = false;
      run.promptMsgId = next.id;
      run.telegramFrom = undefined;
      run.inFlight = new Map();
      run.handle = null;
      this.begin(run);
      await this.executeOnce(run);
      if (run.chat?.followUp) await this.followUpCost(run.slug, run.id);
    }
  }

  /** Where the card lands after a run: refine chats and replies to other tickets never move it. */
  endStatus(run: ActiveRun): Partial<Ticket> {
    if (run.chat?.mode === "refine" || run.chat?.quiet) return run.targetStatus ? { status: run.targetStatus } : {};
    // A main ticket's reply or wake leaves its card where it was (a wake never sends it to Review).
    if (run.chat && run.noEdit && !run.chat.hostWake) return run.targetStatus ? { status: run.targetStatus } : {};
    const status = run.targetStatus ?? run.chat?.returnTo ?? "review";
    // Done would close the ticket's open huddle: the card waits in Review until the user closes it.
    return { status: status === "done" && !run.targetStatus && this.huddleOpen(run.slug, run.id) ? "review" : status };
  }

  /** The ticket hosts a huddle that isn't closed. */
  private huddleOpen(slug: string, id: string): boolean {
    return this.hostHuddles(slug).has(id);
  }

  /**
   * healed: this is the one retry in a new session after Claude could not find the old one.
   * resume: the board continues this run's own work in its session (a passing API error, a stall restart) with this
   * text as the whole prompt; the run otherwise ends as the one it continues (result line, column, card). Without a
   * saved session (it hung before Claude saved one) there is nothing to continue: the run starts over with its prompt.
   */
  async executeOnce(run: ActiveRun, healed = false, resumeText?: string): Promise<void> {
    const { slug, id } = run;
    const startedAt = nowIso();
    let session: Session;
    try {
      session = await this.ensureSession(slug, id);
    } catch (e) {
      const msg = (e as Error).message;
      this.store.addComment(slug, id, "ai", `Could not start: ${msg}`);
      // refineStarted back off: moving the card into Planning again retries the interview.
      // Offline or signed out (FetchError): nothing is wrong with the ticket; the user fixes it and sends a message.
      this.patch(slug, id, { ...this.endStatus(run), outcome: e instanceof FetchError ? "blocked" : "failed", error: msg, lastActivity: null, ...(run.chat?.mode === "refine" ? { refineStarted: false } : {}) });
      return;
    }
    if (this.shuttingDown) return;
    // A run log compressed while the ticket sat in Done comes back first (off the event loop), so this run's lines
    // follow the old ones. If it can't (a full disk), the run stops here with a plain message: nothing is written.
    try {
      await this.store.restoreActivity(slug, id);
    } catch (e) {
      console.error(`restore run log ${slug}/${id}:`, e);
      const full = (e as { code?: string }).code === "ENOSPC";
      const msg = full
        ? "Could not start: the Mac's disk is too full to bring back this ticket's old run log. Free some space, then send the message again."
        : `Could not start: this ticket's old run log could not be brought back (${(e as Error).message}). It is kept as it was; try again.`;
      this.store.addComment(slug, id, "ai", msg);
      this.patch(slug, id, { ...this.endStatus(run), outcome: "failed", error: msg, lastActivity: null });
      return;
    }
    // Unattended runs refuse to share a session with an open terminal; chat messages are the user's call (UI warns).
    if (session.existed && !run.stopRequested && !run.chat) {
      const t0 = this.store.getTicket(slug, id)!;
      const title = t0.workdir ? sessionTitle(t0.workdir, session.sessionId) : null;
      if (await this.isSessionLive(session.sessionId, title)) {
        const msg = SESSION_OPEN_MSG;
        this.store.addComment(slug, id, "ai", msg);
        this.patch(slug, id, { ...this.endStatus(run), outcome: "blocked", error: msg, lastActivity: null });
        return;
      }
    }
    if (run.stopRequested) {
      this.store.addComment(slug, id, "ai", "Run stopped by user.");
      this.patch(slug, id, { ...this.endStatus(run), outcome: "stopped", lastActivity: null });
      return;
    }

    const t = this.store.getTicket(slug, id)!;
    const resume = session.existed ? resumeText : undefined;
    const refine = run.chat?.mode === "refine";
    // A reply to another ticket's Claude: not a run of this ticket's own work.
    const quiet = !!run.chat?.quiet;
    const profile = this.store.getProfile(slug)!;
    const runNo = t.runCount + 1;
    const newComments = this.store.listComments(slug, id).filter((c) => (c.author === "user" || c.from) && (!t.lastRunAt || c.at > t.lastRunAt));
    const outputDir = this.store.outputsDir(slug, id);
    // Start fresh session: a work run in a new session that picks up from the branch (until that session exists).
    const fresh = !!t.freshSession && !run.chat;
    // "Send in a fresh chat": the new chat's first message carries the ticket and its last result (until that chat exists).
    // A main ticket's or feature's fresh chat also seeds a wake (raw) with the status, and whatever it starts with.
    const freshChat = !!t.freshSession && !!run.chat && !session.existed && (!run.chat.raw || this.seedsFromStatus(slug, t));
    const artifacts = !!profile.artifacts || mentionsArtifact(t.body, run.chat?.text, ...newComments.map((c) => c.text));
    // Main and tool tickets get their own rules (main-ticket.ts); a failure to work them out never stops the run.
    let role: RunRole | undefined;
    try {
      role = this.roleOf(slug, t, session);
    } catch (e) {
      console.error(`role of ${slug}/${id}:`, e);
    }
    // "What we did before" goes into a chat's first Planning turn, a fresh session's prompt and a first run.
    const wantsRecall = !resume && (run.chat ? !run.chat.raw && refine && !session.existed : fresh || t.runCount === 0 || !session.existed);
    const recall = wantsRecall ? await this.recall(slug, t) : "";
    // A folder without version history counts a tool ticket's changed files from its run log: read the old part now,
    // in slices, so the count at the end reads only this run's part.
    if (!t.worktree && !t.branch && !t.workdir && (session.repo === "plain" || session.repo === "empty")) {
      void this.store.activityDigest(slug, id).catch(() => {});
    }
    let prompt = resume ?? this.withSetupNote(slug, t, profile, session, refine, localizeAttachments(run.chat?.raw
      ? run.chat.text + (freshChat ? `\n\n${this.freshChatContext(slug, t)}` : "")
      : run.chat
      ? chatPrompt(t, run.chat.text, run.chat.mode, outputDir, artifacts, session.repo, session.inPlace, recall, role,
        refine && !role ? followUpPlace(this.store.listTickets(slug), t.id) : null)
        // A turn that acts counts as a run (lastRunAt): notes left since the last one reach Claude here or never.
        + (refine || quiet ? "" : chatNotes(newComments.filter((c) => c.from)))
        + (freshChat ? `\n\n${this.freshChatContext(slug, t)}` : "")
      : fresh
      ? this.freshPrompt(slug, t, session, outputDir, recall)
      : role?.kind === "tool" && (t.runCount === 0 || !session.existed)
      ? toolFirstPrompt(t, role, {
        comments: newComments, autoHuddles: autoHuddlesOn(profile), artifacts, recall,
      })
      : t.runCount === 0 || !session.existed
      ? firstRunPrompt(t, {
        repo: session.repo, inPlace: session.inPlace, home: { folder: profile.path, baseBranch: profile.baseBranch }, linked: !!t.workdir,
        // Notes other tickets' runs left reach even a ticket's first run: nobody else passes them on.
        comments: t.workdir || t.runCount > 0 ? newComments : newComments.filter((c) => c.from), outputDir,
        schedule: t.scheduleId ? this.scheduleContext(slug, t) : undefined,
        autoHuddles: autoHuddlesOn(profile), artifacts, recall, ...(role?.kind === "main" ? { main: role } : {}),
      })
      : resumePrompt(t, newComments, outputDir, autoHuddlesOn(profile), artifacts, session.repo, session.inPlace, { folder: profile.path, baseBranch: profile.baseBranch }, role), this.store.attachmentsDir));
    // A slash command only runs when it is the whole message: Claude Code passes everything after the name to
    // it as arguments (the board's note too). So the command goes alone and the board's instructions go in
    // the system prompt for this run.
    let systemPrompt: string | undefined;
    if (run.chat?.slash && !resume) {
      const cut = prompt.indexOf("\n\n<ckanban-context");
      if (cut >= 0) {
        systemPrompt = `The user's message in this turn is a slash command sent from the kanban board's ticket chat. The board's instructions for this run:\n\n${prompt.slice(cut + 2)}`;
        prompt = prompt.slice(0, cut);
      }
    }
    // Runs that may act learn the shared device list here, so it is current on every turn (Planning chats don't use devices).
    const deviceNote = refine ? null : devicesNote(this.devices.devices(), t.needs);
    if (deviceNote) systemPrompt = systemPrompt ? `${systemPrompt}\n\n${deviceNote}` : deviceNote;
    // The browsers this ticket uses (More → Browsers), on every turn; nothing when none is chosen. Board browsers are
    // started here (the run waits for them) and stay open until the run ends.
    let chromeNote: string | null = null;
    let browsers: RunBrowsers | null = null;
    try {
      browsers = await this.runBrowsers(slug, t, this.key(slug, id), outputDir);
      chromeNote = browsers.note;
    } catch (e) {
      console.error(`browsers for ${slug}/${id}:`, e);
    }
    if (run.stopRequested || this.shuttingDown) {
      if (!this.shuttingDown) {
        this.store.addComment(slug, id, "ai", "Run stopped by user.");
        this.patch(slug, id, { ...this.endStatus(run), outcome: "stopped", lastActivity: null });
      }
      return;
    }
    if (browsers?.noChrome) {
      prompt = withoutChromeRule(prompt);
      if (systemPrompt) systemPrompt = withoutChromeRule(systemPrompt);
    }
    if (chromeNote) systemPrompt = systemPrompt ? `${systemPrompt}\n\n${chromeNote}` : chromeNote;
    // A resumed session keeps the system prompt it started with (Claude Code ignores a new one), so the current
    // pick also goes in this turn's message (not with a slash command: that must stay the whole message).
    if (chromeNote && session.existed && !run.chat?.slash) prompt += `\n\n${chromeTurnNote(chromeNote)}`;
    // A resumed session may hold old copies of board tools it loaded before they changed (toolsChangedNote).
    let toolsNow: string | null = null;
    try {
      toolsNow = toolsVersion();
    } catch (e) {
      console.error("board tools fingerprint:", e);
    }
    if (toolsNow && t.toolsVersion !== toolsNow) {
      if (session.existed && !run.chat?.slash) prompt += `\n\n${toolsChangedNote()}`;
      this.patch(slug, id, { toolsVersion: toolsNow });
    }
    const chromeWatch = new ChromeWatch(this.chromes);
    // A main ticket's fixed rules go once per run here, not in every message the chat shows.
    if (role?.kind === "main" && !quiet) systemPrompt = systemPrompt ? `${systemPrompt}\n\n${mainTicketRules(role)}` : mainTicketRules(role);
    // A feature's main chat reads its status first and keeps it current; the family's other runs may update it too.
    if (!run.chat?.nudge && !quiet) {
      let featureNote: string | null = null;
      try {
        featureNote = this.featureNote(slug, t);
      } catch (e) {
        // The status is a help, never a reason for a run to fail.
        console.error(`feature status for ${slug}/${id}:`, e);
      }
      if (featureNote) systemPrompt = systemPrompt ? `${systemPrompt}\n\n${featureNote}` : featureNote;
      // Notes the user added to the status reach the main chat at its next turn (they never start a run themselves).
      const notes = resume ? null : this.takeStatusNotes(slug, id);
      if (notes) prompt += `\n\n${notes}`;
    }

    let lastWrite = 0;
    let pendingActivity: string | null = null;
    const draft = new DraftTracker();
    run.draft = draft;
    // A reply cut off by a restart stays on screen until this run's reply replaces it.
    let showsInterrupted = !!t.interrupted;
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    const emitDraft = () => {
      draftTimer = null;
      this.bus.emit({ type: "draft", profile: slug, id, text: maskSaved(this.store.root, draft.text) });
    };
    // The spending cap applies to the ticket's own work (not Planning chats or replies to other tickets).
    const cap = refine || quiet ? null : runCapFor(t, profile);
    if (!refine && !quiet && t.capNextUsd) this.patch(slug, id, { capNextUsd: null });
    // Workflow helper agents' spending doesn't count toward claude's own --max-budget-usd: the board adds it up
    // (this run's messages + its workflows' agents) and stops the run once the total reaches the cap.
    const spend: RunSpend = { main: new Map<string, number>(), workflowDirs: new Set<string>(), files: new Map<string, { key: string; cost: number }>() };
    run.spend = spend;
    // Its prompt is a message from Telegram: the whole attempt counts as Telegram's.
    if (run.promptMsgId && t.queued?.some((m) => m.id === run.promptMsgId && m.telegram)) run.telegramFrom = 0;
    const capWatch = cap === null ? null : setInterval(() => {
      if (!spend.workflowDirs.size || run.stopRequested || run.workflowCapHit !== undefined || !run.handle) return;
      const total = spentWith(spend);
      if (total < cap) return;
      run.workflowCapHit = total;
      this.patch(slug, id, { lastActivity: "Stopping: spending cap reached" });
      run.handle.stop();
    }, this.opts.capPollMs ?? WORKFLOW_CAP_POLL_MS);
    // Marks where this run starts in the log and what it was (the Usage tab lists runs by kind).
    // A resumed attempt (retry, stall restart) continues the same run in the log.
    if (!resumeText) this.store.appendActivity(slug, id, runNo, { type: "ckanban_run", kind: refine ? "planning" : quiet ? "reply" : run.chat?.followUp ? "follow-up" : run.chat ? "chat" : "work" });
    run.handle = startRun({
      bin: this.opts.claudeBin,
      cwd: session.dir,
      args: this.chatArgs(slug, t, profile, refine, session.sessionId, session.existed, systemPrompt, cap, browsers),
      input: prompt,
      inputLocal: run.chat?.slash === "local" && !resume,
      planning: refine,
      // CKANBAN_TICKET marks board runs: the ckanban MCP/CLI refuses board changes there (no runs starting runs).
      // The board's saved keys (ask_keys) come first, so the board's own variables always win.
      env: this.chatEnv(slug, id, outputDir),
      onEvent: (ev) => {
        const changed = draft.feed(ev);
        if (changed !== null) {
          // Clears go out at once with the finished text (the batched tail may not have gone out yet);
          // growing text is batched (~8 updates/s).
          if (changed === "") {
            if (draftTimer) clearTimeout(draftTimer);
            draftTimer = null;
            this.bus.emit({ type: "draft", profile: slug, id, text: "", ...(draft.finished ? { final: maskSaved(this.store.root, draft.finished) } : {}) });
          } else if (!draftTimer) draftTimer = setTimeout(emitDraft, DRAFT_THROTTLE_MS);
        }
        if (ev?.type === "stream_event") return;
        this.watchWorkflows(slug, id, ev, spend);
        chromeWatch.feed(ev);
        rememberInit(session.dir, ev, { projects: [profile.path] });
        learnModel(ev);
        if (refine && ev?.type === "assistant") this.saveMockups(slug, id, outputDir, ev);
        if (showsInterrupted && !this.shuttingDown && hasText(ev)) {
          showsInterrupted = false;
          this.patch(slug, id, { interrupted: null });
        }
        const read = replayText(ev);
        if (read !== null) this.delivered(run, read);
        this.store.appendActivity(slug, id, runNo, ev);
        this.bus.emit({ type: "activity", profile: slug, id, run: runNo, event: ev });
        const s = summarizeEvent(ev);
        // Keep "Stopping…" on the card until the process is gone.
        if (!s || run.stopRequested) return;
        pendingActivity = s;
        const now = Date.now();
        if (now - lastWrite >= ACTIVITY_THROTTLE_MS) {
          lastWrite = now;
          pendingActivity = null;
          this.patch(slug, id, { lastActivity: s });
        }
      },
      stallMs: this.stallMs(profile),
      onStall: (stalled) => {
        if (this.shuttingDown || !this.store.getTicket(slug, id)) return;
        if (!stalled) {
          if (this.store.getTicket(slug, id)?.stalled) this.patch(slug, id, { stalled: null });
          return;
        }
        if (run.stopRequested) return;
        const minutes = Math.max(1, Math.round(this.stallMs(profile) / 60_000));
        // The Notifier sees the new "stalled" attention and tells the user (webhook / macOS banner).
        this.patch(slug, id, { stalled: { at: nowIso(), minutes } });
      },
      onWaiting: (tasks) => {
        if (run.stopRequested || this.shuttingDown) return;
        const what = !tasks ? null : tasks.length === 1 ? `Waiting for background task: ${tasks[0].description}` : `Waiting for ${tasks.length} background tasks`;
        if (what) pendingActivity = null;
        this.patch(slug, id, { waitingOn: tasks, ...(what ? { lastActivity: what } : {}) });
      },
    });

    // A local command is never echoed back: it was read once it was written.
    if (run.chat?.slash === "local" && !resume && run.promptMsgId) {
      this.dropQueued(slug, id, [run.promptMsgId]);
      run.promptMsgId = undefined;
    }
    // Messages sent while the run was starting up, or left over from a run the daemon restarted. A nextRun message (an
    // automation's item, a pasted-key answer) never joins a turn it didn't start: drainQueue gives it one of its own.
    for (const msg of this.waiting(slug, id)) if (!msg.nextRun || run.promptMsgId === msg.id) this.steer(run, msg);

    const out = await run.handle.done;
    if (capWatch) clearInterval(capWatch);
    run.spend = undefined;
    if (run.telegramFrom !== undefined) {
      try {
        addTelegramSpend(this.store.root, spentWith(spend) - run.telegramFrom);
      } catch (e) {
        console.error("board: telegram spend", e);
      }
      // A retry of the same message (a fresh attempt) is Telegram's too.
      run.telegramFrom = 0;
    }
    if (draftTimer) clearTimeout(draftTimer);
    // A reply cut off before its message ended (Stop, a crash): the chat keeps it until it knows what was saved.
    if (draft.text) this.bus.emit({ type: "draft", profile: slug, id, text: "", final: maskSaved(this.store.root, draft.text) });
    // Daemon is exiting: leave the ticket in_progress so recover() resumes it on next start.
    if (this.shuttingDown) return;
    const finalText = extractFinalText(out.events);
    if (!(run.handle.stopped && run.restartRequested && !run.stopRequested)) {
      try {
        this.opts.turnEnded?.(slug, id, maskSaved(this.store.root, finalText));
      } catch (e) {
        console.error("board: turnEnded", e);
      }
    }
    // A steering message can get its own turn after the result line; the ticket outcome is still the last one given.
    let result = parseResult(finalText) ?? out.events
      .filter((e) => e?.type === "result" && typeof e.result === "string")
      .map((e) => parseResult(e.result))
      .findLast((r) => r !== null) ?? null;
    // Stopped before Claude got going: there is no session to resume, so the next run starts a new one.
    const started = session.existed || this.sessionExists(session.sessionId)
      || out.events.some((e) => (e?.type === "system" && e.subtype === "init") || e?.type === "assistant");
    const base: Partial<Ticket> = {
      ...this.endStatus(run),
      stalled: null,
      sessionStarted: started,
      runEndedAt: nowIso(),
      ...((fresh || freshChat) && started ? { freshSession: false, freshAuto: null } : {}),
      ...(refine || quiet ? {} : { lastRunAt: startedAt, runCount: runNo }),
      lastActivity: pendingActivity ?? this.store.getTicket(slug, id)?.lastActivity ?? null,
    };

    // Restart on a stalled run: the stuck process is gone, now the same session picks the work up again.
    if (run.handle.stopped && run.restartRequested && !run.stopRequested) {
      run.restartRequested = false;
      this.store.addComment(slug, id, "ai", "Restarted the stalled run: it continues in the same session.");
      this.patch(slug, id, { sessionStarted: started, stalled: null, lastActivity: "Restarting…" });
      return this.executeOnce(run, healed, STALL_RESTART_TEXT);
    }
    if (run.workflowCapHit !== undefined && cap !== null) {
      this.capReached(slug, id, base, cap, run.workflowCapHit);
      return;
    }
    if (run.handle.stopped) {
      this.store.addComment(slug, id, "ai", "Run stopped by user.");
      this.patch(slug, id, { ...base, outcome: "stopped", error: null, lastActivity: null, ...this.dropAutoWait(slug, id) });
      return;
    }
    if (cap !== null && out.events.some((e) => e?.type === "result" && e.subtype === "error_max_budget_usd")) {
      // Claude Code's own cap counts only this conversation: with workflows, say what they added on top.
      this.capReached(slug, id, base, cap, spend.workflowDirs.size ? spentWith(spend) : undefined);
      return;
    }
    // The account hit its usage limit: not a failure of the work, it continues once the limit resets.
    const limited = quiet || result ? null : limitMessage(out.events, out.code !== 0 ? out.stderr : "");
    if (limited) {
      this.limitHit(slug, id, base, limited);
      return;
    }
    if (out.code !== 0) {
      const error = out.stderr.trim() || finalText.trim() || `claude exited with code ${out.code}`;
      // Claude can't find the session (stopped before it was saved, cleaned up, or saved for another folder):
      // retry once in a new session instead of failing every run from now on.
      if (!healed && !this.store.getTicket(slug, id)?.workdir && sessionMissing(error, out.events)) {
        console.log(`ticket ${slug}/${id}: session ${session.sessionId} not found, starting a new one`);
        this.patch(slug, id, { sessionId: crypto.randomUUID(), sessionStarted: false, error: null });
        return this.executeOnce(run, true);
      }
      // A passing API problem (overloaded, a 5xx, a dropped connection): resume the same session once after a pause.
      const transient = run.retried || run.stopRequested ? null : transientError(out.events, out.stderr);
      if (transient) {
        run.retried = true;
        const delay = this.opts.retryDelayMs ?? RETRY_DELAY_MS;
        const line = transient.split("\n").findLast((l) => l.trim())?.trim().slice(0, 200) ?? transient;
        this.store.addComment(slug, id, "ai", `Run hit a temporary API error (${line}). Retrying once in ${Math.max(1, Math.round(delay / 1000))}s in the same session.`);
        this.patch(slug, id, { sessionStarted: started, error: null, lastActivity: "Temporary API error, retrying shortly…" });
        await Bun.sleep(delay);
        if (this.shuttingDown) return;
        if (run.stopRequested) {
          this.store.addComment(slug, id, "ai", "Run stopped by user.");
          this.patch(slug, id, { ...base, outcome: "stopped", error: null, lastActivity: null, ...this.dropAutoWait(slug, id) });
          return;
        }
        return this.executeOnce(run, healed, RETRY_TEXT);
      }
      // Claude reports a lost session only in its result event: keep it in the error so the UI offers Start fresh session.
      const shown = sessionMissing(error, out.events) && !sessionMissing(error, []) ? `No conversation found with session ID: ${session.sessionId}` : claudeSetupHint(error) ?? error;
      this.store.addComment(slug, id, "ai", `Run failed (exit ${out.code}): ${shown.split("\n").slice(-3).join("\n")}`);
      this.patch(slug, id, { ...base, outcome: "failed", error: shown });
      return;
    }
    const body = finalText.replace(/^.*CKANBAN_RESULT:.*$/gm, "").replace(MOVE_TO_PLANNING_RE, "").trim();
    // A working main ticket's reply that only answered or reported progress isn't waiting on the user: "done".
    if (result) {
      const t = this.store.getTicket(slug, id);
      if (t && askedNothing(t, result.status, replyAsked(this.openForm(t), body) || this.keysOpen(t))) result = { ...result, status: "done" };
    }
    // A reply to the ticket's huddle can land the work and report it: keep its PRs, summary and outcome. The card
    // stays where it is, and a ticket waiting for its auto huddle keeps waiting.
    if (quiet && result && !refine && !run.chat?.nudge) {
      const current = this.store.getTicket(slug, id)!;
      this.store.addComment(slug, id, "ai", (result.status === "questions" ? body : result.summary) || body || "(no output)");
      this.patch(slug, id, {
        ...base, lastActivity: null, error: null,
        ...(current.autoHuddle ? {} : { outcome: result.status === "questions" ? "needs_input" : result.status, ...(result.status === "questions" ? { interviewed: true } : {}) }),
        // A planner's PRs are its own work only when its own run reports them (see below).
        ...(current.plan ? {} : addPrs(current, result.prUrls)),
        ...(current.kind === "test" && !current.autoHuddle && result.status === "done" ? { verdict: result.verdict ?? null } : {}),
      });
      return;
    }
    if (refine || quiet) {
      this.patch(slug, id, { ...base, lastActivity: null, error: null });
      return;
    }
    // A Review/Done message that only asked for planning: show the ticket where it really is.
    if (run.chat?.mode === "act" && !run.targetStatus && result?.status !== "blocked" && MOVE_TO_PLANNING_RE.test(finalText)) {
      this.store.addComment(slug, id, "ai", result?.summary || body || "(no output)");
      this.patch(slug, id, {
        ...base, status: "planning",
        outcome: null, error: null, refineStarted: true, lastActivity: null,
        ...(run.chat.from && reopenable(run.chat.from.status) ? { reopenedFrom: run.chat.from } : {}),
      });
      return;
    }
    // A Review/Done message that only asked for new tickets: the card goes back where it was, outcome unchanged.
    // Not while the ticket hosts an open huddle: back in Done would close it, so the card goes to Review.
    const from = run.chat?.from;
    if (run.chat?.mode === "act" && !run.chat.raw && !run.targetStatus && from && from.status !== "in_progress" && result?.status !== "blocked" && STAY_RE.test(finalText) && !this.huddleOpen(slug, id)) {
      this.patch(slug, id, { ...base, status: from.status, outcome: from.outcome, error: null, lastActivity: null });
      return;
    }
    const current = this.store.getTicket(slug, id)!;
    // A quiet schedule's run that found nothing: Done without a word to the user; the ticket goes once the run is over.
    if (!run.chat && !run.targetStatus && result && current.scheduleId && canEndQuietly({
      schedule: this.store.getSchedule(slug, current.scheduleId), ticket: current, tickets: this.store.listTickets(slug),
      quietResult: !!result.quiet, prUrls: result.prUrls, waiting: this.waiting(slug, id).length,
    }) && !this.huddleOpen(slug, id)) {
      run.quietEnd = { summary: result.summary || body || "Nothing new.", costUsd: spentWith(spend) };
      this.store.addComment(slug, id, "ai", run.quietEnd.summary);
      this.patch(slug, id, { ...base, status: "done", outcome: "done", error: null, lastActivity: null });
      return;
    }
    // Questions must reach the user verbatim; otherwise the short summary is enough.
    const summary = (result?.status === "questions" ? body : result?.summary) || body || "(no output)";
    this.store.addComment(slug, id, "ai", summary);
    // Its auto huddle reviews the work (or it waits for the slot): the card stays In Progress until the huddle wakes it.
    const auto = current.autoHuddle;
    if (auto && !run.targetStatus && result?.status !== "blocked" && result?.status !== "questions") {
      this.patch(slug, id, {
        ...base, status: "in_progress", outcome: null, error: null, lastActivity: autoHuddleActivity(auto),
        ...addPrs(current, result?.prUrls ?? []),
      });
      return;
    }
    // A follow-up on a Done or Backlog card that needs the user: Review, where the user sees it (those columns never ask).
    const asks = result?.status === "questions" || result?.status === "blocked";
    if (run.chat?.followUp && asks && (base.status === "done" || base.status === "backlog")) base.status = "review";
    // A tool ticket whose merges into the main ticket's copy failed MERGE_TRIES times hasn't landed anything: blocked.
    const unmerged = !!current.tool && (current.mergeFails ?? 0) >= MERGE_TRIES && (result?.status ?? "done") === "done";
    // A tool ticket whose work is finished (and merged, where it merges) is Done: it has no card to review.
    const toolDone = !!current.tool && !unmerged && (result?.status ?? "done") === "done" && !run.targetStatus && !this.huddleOpen(slug, id);
    this.patch(slug, id, {
      ...base,
      ...(toolDone ? { status: "done" } : {}),
      outcome: unmerged ? "blocked" : result?.status === "questions" ? "needs_input" : result?.status ?? "done",
      ...(result?.status === "questions" ? { interviewed: true } : {}),
      // A planner wake-up reports its children's PRs; the planner keeps its own.
      ...(run.chat?.raw && !run.chat.hostWake ? {} : addPrs(current, result?.prUrls ?? [])),
      // A test ticket's result: the newest run's verdict (none: a done test counts as passed).
      ...(current.kind === "test" && result ? { verdict: result.verdict ?? null } : {}),
      error: null,
    });
    if (unmerged) this.store.addComment(slug, id, "ai", `Ended blocked: merging into the main ticket's copy failed ${MERGE_TRIES} times.`);
    // A ticket the user added to a feature (not one of its tool tickets): its result also reaches the main ticket.
    try {
      this.reportToMain(slug, id, summary);
      this.noteStepWaiting(slug, id, summary);
    } catch (e) {
      console.error(`report ${slug}/${id} to its main ticket:`, e);
    }
  }

  private stallMs(...a: Parameters<typeof limitsPart.stallMs>): ReturnType<typeof limitsPart.stallMs> { return limitsPart.stallMs.call(this, ...a); }

  stallAction(...a: Parameters<typeof limitsPart.stallAction>): ReturnType<typeof limitsPart.stallAction> { return limitsPart.stallAction.call(this, ...a); }

  now(...a: Parameters<typeof limitsPart.now>): ReturnType<typeof limitsPart.now> { return limitsPart.now.call(this, ...a); }

  private capReached(...a: Parameters<typeof limitsPart.capReached>): ReturnType<typeof limitsPart.capReached> { return limitsPart.capReached.call(this, ...a); }

  continueAfterCap(...a: Parameters<typeof limitsPart.continueAfterCap>): ReturnType<typeof limitsPart.continueAfterCap> { return limitsPart.continueAfterCap.call(this, ...a); }

  private limitHit(...a: Parameters<typeof limitsPart.limitHit>): ReturnType<typeof limitsPart.limitHit> { return limitsPart.limitHit.call(this, ...a); }

  continueAfterLimit(...a: Parameters<typeof limitsPart.continueAfterLimit>): ReturnType<typeof limitsPart.continueAfterLimit> { return limitsPart.continueAfterLimit.call(this, ...a); }

  setAutoContinue(...a: Parameters<typeof limitsPart.setAutoContinue>): ReturnType<typeof limitsPart.setAutoContinue> { return limitsPart.setAutoContinue.call(this, ...a); }

  dueContinues(...a: Parameters<typeof limitsPart.dueContinues>): ReturnType<typeof limitsPart.dueContinues> { return limitsPart.dueContinues.call(this, ...a); }

  // ---- Follow-ups (followup.ts): Claude comes back to this ticket later ----

  setFollowUp(...a: Parameters<typeof followupsPart.setFollowUp>): ReturnType<typeof followupsPart.setFollowUp> { return followupsPart.setFollowUp.call(this, ...a); }

  cancelFollowUp(...a: Parameters<typeof followupsPart.cancelFollowUp>): ReturnType<typeof followupsPart.cancelFollowUp> { return followupsPart.cancelFollowUp.call(this, ...a); }

  userReplied(...a: Parameters<typeof followupsPart.userReplied>): ReturnType<typeof followupsPart.userReplied> { return followupsPart.userReplied.call(this, ...a); }

  markSeen(...a: Parameters<typeof followupsPart.markSeen>): ReturnType<typeof followupsPart.markSeen> { return followupsPart.markSeen.call(this, ...a); }

  dueFollowUps(...a: Parameters<typeof followupsPart.dueFollowUps>): ReturnType<typeof followupsPart.dueFollowUps> { return followupsPart.dueFollowUps.call(this, ...a); }

  wakeFollowUp(...a: Parameters<typeof followupsPart.wakeFollowUp>): ReturnType<typeof followupsPart.wakeFollowUp> { return followupsPart.wakeFollowUp.call(this, ...a); }

  private followUpCost(...a: Parameters<typeof followupsPart.followUpCost>): ReturnType<typeof followupsPart.followUpCost> { return followupsPart.followUpCost.call(this, ...a); }

  /** Planning replies carry mockups as blocks (they can't write files); save them for the Outputs tab. */
  private saveMockups(slug: string, id: string, outputDir: string, ev: any) {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return;
    const text = content.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
    try {
      const names = saveMockups(outputDir, text);
      if (names.length) this.patch(slug, id, { lastActivity: `Saved mockup${names.length > 1 ? "s" : ""} ${names.join(", ")}` });
    } catch (e) {
      this.store.addComment(slug, id, "ai", `Couldn't save mockups: ${(e as Error).message}`);
    }
  }

  sessionLocks = new Map<string, Promise<unknown>>();

  /** Each board folder's version history as last seen, by folder path (see repoState); re-checked after REPO_TTL_MS. */
  repos = new Map<string, { kind: RepoKind; at: number }>();
  repoChecks = new Set<string>();

  repoState(...a: Parameters<typeof repoPart.repoState>): ReturnType<typeof repoPart.repoState> { return repoPart.repoState.call(this, ...a); }

  guessRepo(...a: Parameters<typeof repoPart.guessRepo>): ReturnType<typeof repoPart.guessRepo> { return repoPart.guessRepo.call(this, ...a); }

  committed(...a: Parameters<typeof repoPart.committed>): ReturnType<typeof repoPart.committed> { return repoPart.committed.call(this, ...a); }

  checkRepo(...a: Parameters<typeof repoPart.checkRepo>): ReturnType<typeof repoPart.checkRepo> { return repoPart.checkRepo.call(this, ...a); }

  noteRepo(...a: Parameters<typeof repoPart.noteRepo>): ReturnType<typeof repoPart.noteRepo> { return repoPart.noteRepo.call(this, ...a); }

  runsInFolder(...a: Parameters<typeof repoPart.runsInFolder>): ReturnType<typeof repoPart.runsInFolder> { return repoPart.runsInFolder.call(this, ...a); }

  folderBusy(...a: Parameters<typeof repoPart.folderBusy>): ReturnType<typeof repoPart.folderBusy> { return repoPart.folderBusy.call(this, ...a); }

  runMayEdit(...a: Parameters<typeof repoPart.runMayEdit>): ReturnType<typeof repoPart.runMayEdit> { return repoPart.runMayEdit.call(this, ...a); }

  folderWait(...a: Parameters<typeof repoPart.folderWait>): ReturnType<typeof repoPart.folderWait> { return repoPart.folderWait.call(this, ...a); }

  ensureSession(...a: Parameters<typeof repoPart.ensureSession>): ReturnType<typeof repoPart.ensureSession> { return repoPart.ensureSession.call(this, ...a); }

  ensureSessionNow(...a: Parameters<typeof repoPart.ensureSessionNow>): ReturnType<typeof repoPart.ensureSessionNow> { return repoPart.ensureSessionNow.call(this, ...a); }

  private withSetupNote(...a: Parameters<typeof repoPart.withSetupNote>): ReturnType<typeof repoPart.withSetupNote> { return repoPart.withSetupNote.call(this, ...a); }

  copyWorktreeFiles(...a: Parameters<typeof repoPart.copyWorktreeFiles>): ReturnType<typeof repoPart.copyWorktreeFiles> { return repoPart.copyWorktreeFiles.call(this, ...a); }

  runSetup(...a: Parameters<typeof repoPart.runSetup>): ReturnType<typeof repoPart.runSetup> { return repoPart.runSetup.call(this, ...a); }

  removeTicketWorktree(...a: Parameters<typeof repoPart.removeTicketWorktree>): ReturnType<typeof repoPart.removeTicketWorktree> { return repoPart.removeTicketWorktree.call(this, ...a); }

  async planningCommand(slug: string, id: string): Promise<string> {
    const s = await this.ensureSession(slug, id);
    const t = this.store.getTicket(slug, id)!;
    return planningCommand(s.dir, s.sessionId, localizeAttachments(planningPrompt(t, this.store.ticketPath(slug, id)), this.store.attachmentsDir), s.existed);
  }

  createTicket(...a: Parameters<typeof ticketsPart.createTicket>): ReturnType<typeof ticketsPart.createTicket> { return ticketsPart.createTicket.call(this, ...a); }

  /**
   * Where a new ticket goes in its family: a round is titled "Testing round N" by the board and always hangs right under
   * the feature's top ticket (also when created under a group); any other link below level 2 is refused with a hint.
   */
  placeInFeature<T extends { title: string; kind?: TicketKind | null; partOf?: string; partOfVia?: "chat"; parentId?: string; main?: boolean }>(slug: string, input: T): T {
    const tickets = this.store.listTickets(slug);
    const parent = input.partOf ?? input.parentId ?? null;
    if (input.kind === "round") {
      const top = parent ? featureRoot(tickets, parent) : undefined;
      const out = { ...input, title: nextRoundTitle(tickets, top?.id ?? null) };
      if (top && top.id !== parent) Object.assign(out, { partOf: top.id, partOfVia: undefined });
      return out;
    }
    // A new main ticket under another is a sub-feature: the same rules as a link (linkProblem).
    const problem = parent ? linkProblem(tickets, { id: "\u0000new", title: input.title, main: !!input.main }, parent) : null;
    if (problem) throw new Error(problem);
    return input;
  }

  updateTicket(...a: Parameters<typeof ticketsPart.updateTicket>): ReturnType<typeof ticketsPart.updateTicket> { return ticketsPart.updateTicket.call(this, ...a); }

  // ---- Plans: a planner ticket runs its children unattended (see plan.ts) ----

  startPlan(...a: Parameters<typeof plansPart.startPlan>): ReturnType<typeof plansPart.startPlan> { return plansPart.startPlan.call(this, ...a); }

  resumeStoppedPlan(...a: Parameters<typeof plansPart.resumeStoppedPlan>): ReturnType<typeof plansPart.resumeStoppedPlan> { return plansPart.resumeStoppedPlan.call(this, ...a); }

  unparkForNewStep(...a: Parameters<typeof plansPart.unparkForNewStep>): ReturnType<typeof plansPart.unparkForNewStep> { return plansPart.unparkForNewStep.call(this, ...a); }

  unparkMain(...a: Parameters<typeof plansPart.unparkMain>): ReturnType<typeof plansPart.unparkMain> { return plansPart.unparkMain.call(this, ...a); }

  holdsReview(...a: Parameters<typeof plansPart.holdsReview>): ReturnType<typeof plansPart.holdsReview> { return plansPart.holdsReview.call(this, ...a); }

  openSteps(...a: Parameters<typeof plansPart.openSteps>): ReturnType<typeof plansPart.openSteps> { return plansPart.openSteps.call(this, ...a); }

  pausePlan(...a: Parameters<typeof plansPart.pausePlan>): ReturnType<typeof plansPart.pausePlan> { return plansPart.pausePlan.call(this, ...a); }

  markPlanDone(...a: Parameters<typeof plansPart.markPlanDone>): ReturnType<typeof plansPart.markPlanDone> { return plansPart.markPlanDone.call(this, ...a); }

  unattendedRun(...a: Parameters<typeof plansPart.unattendedRun>): ReturnType<typeof plansPart.unattendedRun> { return plansPart.unattendedRun.call(this, ...a); }

  claimAutoHuddle(...a: Parameters<typeof plansPart.claimAutoHuddle>): ReturnType<typeof plansPart.claimAutoHuddle> { return plansPart.claimAutoHuddle.call(this, ...a); }

  setAutoHuddle(...a: Parameters<typeof plansPart.setAutoHuddle>): ReturnType<typeof plansPart.setAutoHuddle> { return plansPart.setAutoHuddle.call(this, ...a); }

  private dropAutoWait(...a: Parameters<typeof plansPart.dropAutoWait>): ReturnType<typeof plansPart.dropAutoWait> { return plansPart.dropAutoWait.call(this, ...a); }

  userChatRun(...a: Parameters<typeof plansPart.userChatRun>): ReturnType<typeof plansPart.userChatRun> { return plansPart.userChatRun.call(this, ...a); }

  requestSelfMove(...a: Parameters<typeof plansPart.requestSelfMove>): ReturnType<typeof plansPart.requestSelfMove> { return plansPart.requestSelfMove.call(this, ...a); }

  userAskedRun(...a: Parameters<typeof plansPart.userAskedRun>): ReturnType<typeof plansPart.userAskedRun> { return plansPart.userAskedRun.call(this, ...a); }

  plannerRights(...a: Parameters<typeof plansPart.plannerRights>): ReturnType<typeof plansPart.plannerRights> { return plansPart.plannerRights.call(this, ...a); }

  userRequestRights(...a: Parameters<typeof plansPart.userRequestRights>): ReturnType<typeof plansPart.userRequestRights> { return plansPart.userRequestRights.call(this, ...a); }

  runnerRights(...a: Parameters<typeof plansPart.runnerRights>): ReturnType<typeof plansPart.runnerRights> { return plansPart.runnerRights.call(this, ...a); }

  runStart(...a: Parameters<typeof plansPart.runStart>): ReturnType<typeof plansPart.runStart> { return plansPart.runStart.call(this, ...a); }

  chatFromTelegram(...a: Parameters<typeof plansPart.chatFromTelegram>): ReturnType<typeof plansPart.chatFromTelegram> { return plansPart.chatFromTelegram.call(this, ...a); }

  dropTelegramQueued(...a: Parameters<typeof plansPart.dropTelegramQueued>): ReturnType<typeof plansPart.dropTelegramQueued> { return plansPart.dropTelegramQueued.call(this, ...a); }

  patchTelegram(...a: Parameters<typeof plansPart.patchTelegram>): ReturnType<typeof plansPart.patchTelegram> { return plansPart.patchTelegram.call(this, ...a); }

  markStartedBy(...a: Parameters<typeof plansPart.markStartedBy>): ReturnType<typeof plansPart.markStartedBy> { return plansPart.markStartedBy.call(this, ...a); }

  adoptTickets(...a: Parameters<typeof plansPart.adoptTickets>): ReturnType<typeof plansPart.adoptTickets> { return plansPart.adoptTickets.call(this, ...a); }

  countRetry(...a: Parameters<typeof plansPart.countRetry>): ReturnType<typeof plansPart.countRetry> { return plansPart.countRetry.call(this, ...a); }

  advancing = new Set<string>();
  /** When a planner with waiting events gets woken, per planner: children that fail together arrive as one message. */
  wakeDue = new Map<string, number>();
  advanceAgain = new Set<string>();

  advancePlans(...a: Parameters<typeof plansPart.advancePlans>): ReturnType<typeof plansPart.advancePlans> { return plansPart.advancePlans.call(this, ...a); }

  advancePlan(...a: Parameters<typeof plansPart.advancePlan>): ReturnType<typeof plansPart.advancePlan> { return plansPart.advancePlan.call(this, ...a); }

  openForm(...a: Parameters<typeof plansPart.openForm>): ReturnType<typeof plansPart.openForm> { return plansPart.openForm.call(this, ...a); }

  closeForm(...a: Parameters<typeof plansPart.closeForm>): ReturnType<typeof plansPart.closeForm> { return plansPart.closeForm.call(this, ...a); }

  closeQuestionsAbout(...a: Parameters<typeof plansPart.closeQuestionsAbout>): ReturnType<typeof plansPart.closeQuestionsAbout> { return plansPart.closeQuestionsAbout.call(this, ...a); }

  private keysOpen(...a: Parameters<typeof plansPart.keysOpen>): ReturnType<typeof plansPart.keysOpen> { return plansPart.keysOpen.call(this, ...a); }

  wake(...a: Parameters<typeof plansPart.wake>): ReturnType<typeof plansPart.wake> { return plansPart.wake.call(this, ...a); }

  closePlan(...a: Parameters<typeof plansPart.closePlan>): ReturnType<typeof plansPart.closePlan> { return plansPart.closePlan.call(this, ...a); }

  stuck(...a: Parameters<typeof plansPart.stuck>): ReturnType<typeof plansPart.stuck> { return plansPart.stuck.call(this, ...a); }

  cleanupWorktree(...a: Parameters<typeof plansPart.cleanupWorktree>): ReturnType<typeof plansPart.cleanupWorktree> { return plansPart.cleanupWorktree.call(this, ...a); }

  sweepWorktrees(...a: Parameters<typeof plansPart.sweepWorktrees>): ReturnType<typeof plansPart.sweepWorktrees> { return plansPart.sweepWorktrees.call(this, ...a); }

  private scheduleContext(...a: Parameters<typeof ticketsPart.scheduleContext>): ReturnType<typeof ticketsPart.scheduleContext> { return ticketsPart.scheduleContext.call(this, ...a); }

  private endQuietly(...a: Parameters<typeof ticketsPart.endQuietly>): ReturnType<typeof ticketsPart.endQuietly> { return ticketsPart.endQuietly.call(this, ...a); }

  deleteTicket(...a: Parameters<typeof ticketsPart.deleteTicket>): ReturnType<typeof ticketsPart.deleteTicket> { return ticketsPart.deleteTicket.call(this, ...a); }

  deleteOne(...a: Parameters<typeof ticketsPart.deleteOne>): ReturnType<typeof ticketsPart.deleteOne> { return ticketsPart.deleteOne.call(this, ...a); }

  moveTicket(...a: Parameters<typeof ticketsPart.moveTicket>): ReturnType<typeof ticketsPart.moveTicket> { return ticketsPart.moveTicket.call(this, ...a); }

  attachmentsOf(...a: Parameters<typeof ticketsPart.attachmentsOf>): ReturnType<typeof ticketsPart.attachmentsOf> { return ticketsPart.attachmentsOf.call(this, ...a); }

  linkSession(...a: Parameters<typeof ticketsPart.linkSession>): ReturnType<typeof ticketsPart.linkSession> { return ticketsPart.linkSession.call(this, ...a); }

  branchTicket(...a: Parameters<typeof ticketsPart.branchTicket>): ReturnType<typeof ticketsPart.branchTicket> { return ticketsPart.branchTicket.call(this, ...a); }

  forkTicket(...a: Parameters<typeof ticketsPart.forkTicket>): ReturnType<typeof ticketsPart.forkTicket> { return ticketsPart.forkTicket.call(this, ...a); }

  copyTicket(...a: Parameters<typeof ticketsPart.copyTicket>): ReturnType<typeof ticketsPart.copyTicket> { return ticketsPart.copyTicket.call(this, ...a); }

  followUpWork(...a: Parameters<typeof ticketsPart.followUpWork>): ReturnType<typeof ticketsPart.followUpWork> { return ticketsPart.followUpWork.call(this, ...a); }

  // ---- Families: "part of" links (see web/src/family.ts) ----

  setPartOf(...a: Parameters<typeof familiesPart.setPartOf>): ReturnType<typeof familiesPart.setPartOf> { return familiesPart.setPartOf.call(this, ...a); }

  ownWorkPatch(...a: Parameters<typeof familiesPart.ownWorkPatch>): ReturnType<typeof familiesPart.ownWorkPatch> { return familiesPart.ownWorkPatch.call(this, ...a); }

  makeOwnWork(...a: Parameters<typeof familiesPart.makeOwnWork>): ReturnType<typeof familiesPart.makeOwnWork> { return familiesPart.makeOwnWork.call(this, ...a); }

  setShowOnBoard(...a: Parameters<typeof familiesPart.setShowOnBoard>): ReturnType<typeof familiesPart.setShowOnBoard> { return familiesPart.setShowOnBoard.call(this, ...a); }

  dismissParentSuggestion(...a: Parameters<typeof familiesPart.dismissParentSuggestion>): ReturnType<typeof familiesPart.dismissParentSuggestion> { return familiesPart.dismissParentSuggestion.call(this, ...a); }

  suggestParent(...a: Parameters<typeof familiesPart.suggestParent>): ReturnType<typeof familiesPart.suggestParent> { return familiesPart.suggestParent.call(this, ...a); }

  // ---- Main tickets and tool tickets (main-ticket.ts) ----

  /** What the family spent so far (the daemon's spend index; none until it registers). */
  costOf: (slug: string, id: string) => number = () => 0;
  /** ask_ticket runs in flight (forked sessions, no run slot), stopped on shutdown. */
  /** Running ask_ticket forks, each with what to tell its asker if a restart cuts it off. */
  asks = new Map<RunHandle, () => void>();
  /** merge_into_main runs one at a time per main ticket. */
  mergeLocks = new Map<string, Promise<unknown>>();

  onCost(...a: Parameters<typeof mainPart.onCost>): ReturnType<typeof mainPart.onCost> { return mainPart.onCost.call(this, ...a); }

  newPlan(...a: Parameters<typeof mainPart.newPlan>): ReturnType<typeof mainPart.newPlan> { return mainPart.newPlan.call(this, ...a); }

  ensurePlan(...a: Parameters<typeof mainPart.ensurePlan>): ReturnType<typeof mainPart.ensurePlan> { return mainPart.ensurePlan.call(this, ...a); }

  pushEvent(...a: Parameters<typeof mainPart.pushEvent>): ReturnType<typeof mainPart.pushEvent> { return mainPart.pushEvent.call(this, ...a); }

  mainOf(...a: Parameters<typeof mainPart.mainOf>): ReturnType<typeof mainPart.mainOf> { return mainPart.mainOf.call(this, ...a); }

  taskPlaceFor(...a: Parameters<typeof mainPart.taskPlaceFor>): ReturnType<typeof mainPart.taskPlaceFor> { return mainPart.taskPlaceFor.call(this, ...a); }

  createFeatureTask(...a: Parameters<typeof mainPart.createFeatureTask>): ReturnType<typeof mainPart.createFeatureTask> { return mainPart.createFeatureTask.call(this, ...a); }

  automationItem(...a: Parameters<typeof mainPart.automationItem>): ReturnType<typeof mainPart.automationItem> { return mainPart.automationItem.call(this, ...a); }

  lastSummary(...a: Parameters<typeof mainPart.lastSummary>): ReturnType<typeof mainPart.lastSummary> { return mainPart.lastSummary.call(this, ...a); }

  reportOf(...a: Parameters<typeof mainPart.reportOf>): ReturnType<typeof mainPart.reportOf> { return mainPart.reportOf.call(this, ...a); }

  folderFiles(...a: Parameters<typeof mainPart.folderFiles>): ReturnType<typeof mainPart.folderFiles> { return mainPart.folderFiles.call(this, ...a); }

  editedFiles(...a: Parameters<typeof mainPart.editedFiles>): ReturnType<typeof mainPart.editedFiles> { return mainPart.editedFiles.call(this, ...a); }

  resultCard(...a: Parameters<typeof mainPart.resultCard>): ReturnType<typeof mainPart.resultCard> { return mainPart.resultCard.call(this, ...a); }

  private reportToMain(...a: Parameters<typeof mainPart.reportToMain>): ReturnType<typeof mainPart.reportToMain> { return mainPart.reportToMain.call(this, ...a); }

  private noteStepWaiting(...a: Parameters<typeof mainPart.noteStepWaiting>): ReturnType<typeof mainPart.noteStepWaiting> { return mainPart.noteStepWaiting.call(this, ...a); }

  noteUserMessage(...a: Parameters<typeof mainPart.noteUserMessage>): ReturnType<typeof mainPart.noteUserMessage> { return mainPart.noteUserMessage.call(this, ...a); }

  /** What a main ticket's card shows of its family (main-ticket.ts familyCard). */
  familyCard(slug: string, id: string): FamilyCard | null {
    const all = this.store.listTickets(slug);
    const main = all.find((t) => t.id === id);
    if (!main?.main) return null;
    const family = featureRows(all, id).map((r) => r.ticket).filter((t) => t.id !== id);
    let cost = 0;
    for (const t of familyBelow(all, id)) {
      try {
        cost += this.costOf(slug, t.id);
      } catch {}
    }
    return familyCard(main, family, all, (x) => this.isRunning(slug, x), Math.round(cost * 100) / 100);
  }

  familyWorking(...a: Parameters<typeof mainPart.familyWorking>): ReturnType<typeof mainPart.familyWorking> { return mainPart.familyWorking.call(this, ...a); }

  stepsRunning(...a: Parameters<typeof mainPart.stepsRunning>): ReturnType<typeof mainPart.stepsRunning> { return mainPart.stepsRunning.call(this, ...a); }

  chatArgs(...a: Parameters<typeof mainPart.chatArgs>): ReturnType<typeof mainPart.chatArgs> { return mainPart.chatArgs.call(this, ...a); }

  chatEnv(...a: Parameters<typeof mainPart.chatEnv>): ReturnType<typeof mainPart.chatEnv> { return mainPart.chatEnv.call(this, ...a); }

  contextSession(...a: Parameters<typeof mainPart.contextSession>): ReturnType<typeof mainPart.contextSession> { return mainPart.contextSession.call(this, ...a); }

  contextSpec(...a: Parameters<typeof mainPart.contextSpec>): ReturnType<typeof mainPart.contextSpec> { return mainPart.contextSpec.call(this, ...a); }

  runEnded: ((slug: string, id: string) => void)[] = [];
  onRunEnd(...a: Parameters<typeof mainPart.onRunEnd>): ReturnType<typeof mainPart.onRunEnd> { return mainPart.onRunEnd.call(this, ...a); }

  private roleOf(...a: Parameters<typeof mainPart.roleOf>): ReturnType<typeof mainPart.roleOf> { return mainPart.roleOf.call(this, ...a); }

  askTicket(...a: Parameters<typeof mainPart.askTicket>): ReturnType<typeof mainPart.askTicket> { return mainPart.askTicket.call(this, ...a); }

  mergeIntoMain(...a: Parameters<typeof mainPart.mergeIntoMain>): ReturnType<typeof mainPart.mergeIntoMain> { return mainPart.mergeIntoMain.call(this, ...a); }

  mergeNow(...a: Parameters<typeof mainPart.mergeNow>): ReturnType<typeof mainPart.mergeNow> { return mainPart.mergeNow.call(this, ...a); }

  landMilestone(...a: Parameters<typeof mainPart.landMilestone>): ReturnType<typeof mainPart.landMilestone> { return mainPart.landMilestone.call(this, ...a); }

  // ---- Features: the feature status (Tasks tab), gathering tickets (feature.ts, web/src/family.ts) ----

  facts(...a: Parameters<typeof featuresPart.facts>): ReturnType<typeof featuresPart.facts> { return featuresPart.facts.call(this, ...a); }

  /** Each feature's saved changes as last built, by slug and top ticket id (see savedChanges). */
  changesCache = new Map<string, { at: number; sig: string; value: SavedChanges | null }>();
  changesChecks = new Set<string>();

  savedChanges(...a: Parameters<typeof featuresPart.savedChanges>): ReturnType<typeof featuresPart.savedChanges> { return featuresPart.savedChanges.call(this, ...a); }

  buildChanges(...a: Parameters<typeof featuresPart.buildChanges>): ReturnType<typeof featuresPart.buildChanges> { return featuresPart.buildChanges.call(this, ...a); }

  readChanges(...a: Parameters<typeof featuresPart.readChanges>): ReturnType<typeof featuresPart.readChanges> { return featuresPart.readChanges.call(this, ...a); }

  copyDuplicates(...a: Parameters<typeof featuresPart.copyDuplicates>): ReturnType<typeof featuresPart.copyDuplicates> { return featuresPart.copyDuplicates.call(this, ...a); }


  featureStatus(...a: Parameters<typeof featuresPart.featureStatus>): ReturnType<typeof featuresPart.featureStatus> { return featuresPart.featureStatus.call(this, ...a); }

  refreshStatusFile(...a: Parameters<typeof featuresPart.refreshStatusFile>): ReturnType<typeof featuresPart.refreshStatusFile> { return featuresPart.refreshStatusFile.call(this, ...a); }

  updateStatus(...a: Parameters<typeof featuresPart.updateStatus>): ReturnType<typeof featuresPart.updateStatus> { return featuresPart.updateStatus.call(this, ...a); }

  addStatusNote(...a: Parameters<typeof featuresPart.addStatusNote>): ReturnType<typeof featuresPart.addStatusNote> { return featuresPart.addStatusNote.call(this, ...a); }

  private takeStatusNotes(...a: Parameters<typeof featuresPart.takeStatusNotes>): ReturnType<typeof featuresPart.takeStatusNotes> { return featuresPart.takeStatusNotes.call(this, ...a); }

  private featureNote(...a: Parameters<typeof featuresPart.featureNote>): ReturnType<typeof featuresPart.featureNote> { return featuresPart.featureNote.call(this, ...a); }

  private nudgeStatus(...a: Parameters<typeof featuresPart.nudgeStatus>): ReturnType<typeof featuresPart.nudgeStatus> { return featuresPart.nudgeStatus.call(this, ...a); }

  gather(...a: Parameters<typeof featuresPart.gather>): ReturnType<typeof featuresPart.gather> { return featuresPart.gather.call(this, ...a); }

  // ---- One-click recovery from a lost or busy session ----

  private freshPrompt(...a: Parameters<typeof recoveryPart.freshPrompt>): ReturnType<typeof recoveryPart.freshPrompt> { return recoveryPart.freshPrompt.call(this, ...a); }

  private freshChatContext(...a: Parameters<typeof recoveryPart.freshChatContext>): ReturnType<typeof recoveryPart.freshChatContext> { return recoveryPart.freshChatContext.call(this, ...a); }

  seedsFromStatus(...a: Parameters<typeof recoveryPart.seedsFromStatus>): ReturnType<typeof recoveryPart.seedsFromStatus> { return recoveryPart.seedsFromStatus.call(this, ...a); }

  autoFresh(...a: Parameters<typeof recoveryPart.autoFresh>): ReturnType<typeof recoveryPart.autoFresh> { return recoveryPart.autoFresh.call(this, ...a); }

  private recall(...a: Parameters<typeof recoveryPart.recall>): ReturnType<typeof recoveryPart.recall> { return recoveryPart.recall.call(this, ...a); }

  requeue(...a: Parameters<typeof recoveryPart.requeue>): ReturnType<typeof recoveryPart.requeue> { return recoveryPart.requeue.call(this, ...a); }

  recoverable(...a: Parameters<typeof recoveryPart.recoverable>): ReturnType<typeof recoveryPart.recoverable> { return recoveryPart.recoverable.call(this, ...a); }

  startFresh(...a: Parameters<typeof recoveryPart.startFresh>): ReturnType<typeof recoveryPart.startFresh> { return recoveryPart.startFresh.call(this, ...a); }

  freshChat(...a: Parameters<typeof recoveryPart.freshChat>): ReturnType<typeof recoveryPart.freshChat> { return recoveryPart.freshChat.call(this, ...a); }

  startFreshChat(...a: Parameters<typeof recoveryPart.startFreshChat>): ReturnType<typeof recoveryPart.startFreshChat> { return recoveryPart.startFreshChat.call(this, ...a); }

  takeOver(...a: Parameters<typeof recoveryPart.takeOver>): ReturnType<typeof recoveryPart.takeOver> { return recoveryPart.takeOver.call(this, ...a); }

  addComment(...a: Parameters<typeof recoveryPart.addComment>): ReturnType<typeof recoveryPart.addComment> { return recoveryPart.addComment.call(this, ...a); }

  stopRun(...a: Parameters<typeof recoveryPart.stopRun>): ReturnType<typeof recoveryPart.stopRun> { return recoveryPart.stopRun.call(this, ...a); }

  toolTickets(...a: Parameters<typeof recoveryPart.toolTickets>): ReturnType<typeof recoveryPart.toolTickets> { return recoveryPart.toolTickets.call(this, ...a); }

  stopFamily(...a: Parameters<typeof recoveryPart.stopFamily>): ReturnType<typeof recoveryPart.stopFamily> { return recoveryPart.stopFamily.call(this, ...a); }

  merging(...a: Parameters<typeof recoveryPart.merging>): ReturnType<typeof recoveryPart.merging> { return recoveryPart.merging.call(this, ...a); }

  stop(...a: Parameters<typeof recoveryPart.stop>): ReturnType<typeof recoveryPart.stop> { return recoveryPart.stop.call(this, ...a); }

  stopAll(...a: Parameters<typeof recoveryPart.stopAll>): ReturnType<typeof recoveryPart.stopAll> { return recoveryPart.stopAll.call(this, ...a); }

  shutdown(...a: Parameters<typeof recoveryPart.shutdown>): ReturnType<typeof recoveryPart.shutdown> { return recoveryPart.shutdown.call(this, ...a); }

  markInterrupted(...a: Parameters<typeof recoveryPart.markInterrupted>): ReturnType<typeof recoveryPart.markInterrupted> { return recoveryPart.markInterrupted.call(this, ...a); }

  onHostHuddles(...a: Parameters<typeof recoveryPart.onHostHuddles>): ReturnType<typeof recoveryPart.onHostHuddles> { return recoveryPart.onHostHuddles.call(this, ...a); }

  hostHuddles(...a: Parameters<typeof recoveryPart.hostHuddles>): ReturnType<typeof recoveryPart.hostHuddles> { return recoveryPart.hostHuddles.call(this, ...a); }

  onRestartBusy(...a: Parameters<typeof recoveryPart.onRestartBusy>): ReturnType<typeof recoveryPart.onRestartBusy> { return recoveryPart.onRestartBusy.call(this, ...a); }

  activeWork(...a: Parameters<typeof recoveryPart.activeWork>): ReturnType<typeof recoveryPart.activeWork> { return recoveryPart.activeWork.call(this, ...a); }

  busyBoards(...a: Parameters<typeof recoveryPart.busyBoards>): ReturnType<typeof recoveryPart.busyBoards> { return recoveryPart.busyBoards.call(this, ...a); }

  requestRestart(...a: Parameters<typeof recoveryPart.requestRestart>): ReturnType<typeof recoveryPart.requestRestart> { return recoveryPart.requestRestart.call(this, ...a); }

  isRestartPending(...a: Parameters<typeof recoveryPart.isRestartPending>): ReturnType<typeof recoveryPart.isRestartPending> { return recoveryPart.isRestartPending.call(this, ...a); }

  restartState(...a: Parameters<typeof recoveryPart.restartState>): ReturnType<typeof recoveryPart.restartState> { return recoveryPart.restartState.call(this, ...a); }

  restartWorkChanged(...a: Parameters<typeof recoveryPart.restartWorkChanged>): ReturnType<typeof recoveryPart.restartWorkChanged> { return recoveryPart.restartWorkChanged.call(this, ...a); }

  emitRestart(...a: Parameters<typeof recoveryPart.emitRestart>): ReturnType<typeof recoveryPart.emitRestart> { return recoveryPart.emitRestart.call(this, ...a); }

  recover(...a: Parameters<typeof recoveryPart.recover>): ReturnType<typeof recoveryPart.recover> { return recoveryPart.recover.call(this, ...a); }

  whenIdle(...a: Parameters<typeof recoveryPart.whenIdle>): ReturnType<typeof recoveryPart.whenIdle> { return recoveryPart.whenIdle.call(this, ...a); }
}
