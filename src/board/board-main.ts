import { boardConnectorOptions } from "../runs/connectors";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractFinalText } from "../runs/activity";
import { repoKind } from "../runs/git";
import { forkSessionFile } from "../chat/fork";
import { familyBelow, featureRoot, featureRows, groupsOf, levelOf, MAX_LEVEL, parentLink, workingInFamily } from "../../web/src/features/family/family";
import { readStatus, writeStatus, type SavedStatus } from "./feature";
import { type MainRole, type RunRole, type ToolRole } from "../runs/prompts";
import { ASK_TIMEOUT_MS, finishedLine, isManager, mainPlanned, MERGE_TRIES, REPORT_FILE, RESULTS_KEEP, sentences, youWaiting, stepName } from "./main-ticket";
import { NO_EDIT_TOOLS } from "../huddle/huddle-roster";
import { childrenOf, resolveDeps } from "./plan";
import { run as runCmd } from "../runs/git";
import { addPrs, ticketPrs } from "./prs";
import { buildArgs, PLANNING_DISALLOWED_TOOLS, startRun } from "../runs/runner";
import { runOptions } from "../chat/commands";
import { mcpConfig } from "../integrations/agents";
import { boardKeyEnv } from "../integrations/board-keys";
import { BOARD_NOTES_KEEP, type BoardNote, type ResultCard, type Plan, type Profile, type Ticket, type TicketMode, type TicketSource } from "../core/types";
import { nowIso } from "../core/util";
import type { Board } from "./board";
import { TaskPlace, TaskMaker, RunBrowsers, chatModeFor, Session, claudeSessionFile, ConflictError, openPrWithGh } from "./board-types";

export function onCost(this: Board, f: (slug: string, id: string) => number): void {
  this.costOf = f;
}

export function newPlan(this: Board, children: number): Plan {
  return { state: "running", wakeups: 0, startedAt: nowIso(), originalCount: children, inbox: [], seen: {}, retries: {}, awaiting: null };
}

/**
 * A main ticket (or tool group) gets a running plan once it has tool tickets or events: the engine then runs its
 * family in any column. A finished plan starts again and keeps what it already reported (seen).
 */
export function ensurePlan(this: Board, slug: string, id: string): Ticket | null {
  const t = this.store.getTicket(slug, id);
  if (!t) return null;
  if (t.plan && t.plan.state !== "done") return t;
  const kids = childrenOf(this.store.listTickets(slug), id);
  const plan: Plan = t.plan
    ? { ...t.plan, state: "running", awaiting: null, reason: null, finishedAt: null, originalCount: Math.max(t.plan.originalCount, kids.length) }
    : this.newPlan(kids.length);
  return this.patch(slug, id, { plan });
}

/** Queue an event for a manager ticket's next wake (saved with it) and move its plan on. */
export function pushEvent(this: Board, slug: string, plannerId: string, line: string): void {
  if (!this.ensurePlan(slug, plannerId)) return;
  const t = this.store.getTicket(slug, plannerId)!;
  this.patch(slug, plannerId, { plan: { ...t.plan!, inbox: [...(t.plan!.inbox ?? []), line] } });
  this.advancePlans(slug);
}

/** The main ticket a ticket belongs to: up its links to the first main ticket, or null. */
export function mainOf(this: Board, slug: string, t: Ticket): Ticket | null {
  const all = this.store.listTickets(slug);
  const seen = new Set<string>();
  for (let cur: Ticket | undefined = t; cur && !seen.has(cur.id); cur = all.find((o) => o.id === parentLink(cur!)?.id)) {
    seen.add(cur.id);
    if (cur.main) return cur;
  }
  return null;
}

/**
 * Where a schedule or automation set to put its tickets in a feature (Schedule.partOf / Loop.partOf: a main ticket's
 * id or one of its groups') puts the next one: a task of the nearest ticket there that runs tasks (a tool group, else
 * the main ticket), like a task a run makes with create_ticket's partOf. A Done feature (or a done group of it) still
 * takes them: createFeatureTask moves its main ticket back to Review. A problem (the feature is gone or not a
 * feature): its own card instead.
 */
export function taskPlaceFor(this: Board, slug: string, partOf: string): TaskPlace | { problem: string } {
  const all = this.store.listTickets(slug);
  const at = all.find((t) => t.id === partOf);
  if (!at) return { problem: `The feature ${partOf} it puts runs in no longer exists` };
  const top = featureRoot(all, at.id);
  if (!top?.main || (at.id !== top.id && !groupsOf(all, top.id).some((g) => g.id === at.id))) {
    return { problem: `${at.id} ("${at.title}") isn't a feature's main ticket or one of its groups` };
  }
  const manager = isManager(at) && levelOf(all, at.id) + 1 <= MAX_LEVEL ? at : top;
  return {
    managerId: manager.id, mainId: top.id, ...(at.id !== manager.id ? { partOf: at.id } : {}),
    // A task that changes files starts from the main ticket's copy (git boards), so its work merges back there.
    ...(top.branch && top.worktree ? { startFrom: top.branch } : {}),
  };
}

/**
 * A schedule's run or an automation's new item as a task of a feature (taskPlaceFor): a tool ticket that keeps its
 * schedule or source, tags, model and mode. In progress: it starts right away (the schedule or automation decides
 * when, not the main ticket's plan). Backlog: it waits (waitsForStart) until the user or the main ticket starts it.
 * Its main ticket's card stays where it is, except in Done: there it goes back to Review (no run, no wake, not the
 * user's move) so the user sees that something came in. The plan picks the result up (resultWakesMain decides
 * whether it wakes the main ticket).
 */
export async function createFeatureTask(this: Board,
  slug: string, place: TaskPlace,
  input: {
    title: string; body: string; status: "in_progress" | "backlog"; mode: TicketMode; scheduleId?: string; source?: TicketSource;
    tags?: string[]; model?: string;
  },
  by: TaskMaker,
): Promise<Ticket> {
  const main = this.store.getTicket(slug, place.mainId);
  if (main?.main && main.status === "done") {
    this.patch(slug, main.id, { status: "review", reopenedFrom: null });
    this.store.addComment(slug, main.id, "ai", by.kind === "schedule"
      ? `Back to Review: scheduled run "${by.name}" started.`
      : `Back to Review: the automation "${by.name}" added a task.`);
  }
  const t = await this.createTicket(slug, {
    ...input, parentId: place.managerId, tool: true, ...(place.partOf ? { partOf: place.partOf } : {}), ...(place.startFrom ? { startFrom: place.startFrom } : {}),
    ...(input.status === "backlog" ? { waitsForStart: true } : {}),
  });
  const manager = this.store.getTicket(slug, place.managerId);
  this.store.addComment(slug, t.id, "ai", `Task of ${place.managerId} ("${manager?.title ?? ""}"), made by the ${by.kind} "${by.name}".`
    + (input.status === "backlog" ? " It waits in Backlog until you or the main ticket start it." : ""));
  this.ensurePlan(slug, place.managerId);
  this.advancePlans(slug);
  return this.store.getTicket(slug, t.id)!;
}

/**
 * A later item of an automation's thread (LoopState.threads) for the ticket its first item made. text is labelled as
 * the automation's (threadItemText), so it never counts as the user's words.
 * - Left as a note (a comment the ticket's next run reads, never a run of its own) when the automation's "Start Claude
 *   by itself" is off (autoStart false: only the user starts Claude on outside text, also on a ticket that ran
 *   before), when the ticket hasn't started its work (it never ran, waits in Backlog, Planning or Ready, or is a task
 *   waiting to be started), and when a Planning chat is going on it.
 * - Otherwise it goes into the chat without the user's rights: a waiting ticket resumes its own session (also when it
 *   is cold and large), a working one gets it in a turn of its own once the current run ends (nextRun: never inside a
 *   run that answers the user), and a ticket in Done comes back (its run moves it to In progress; a feature whose task
 *   it is goes back to Review, as createFeatureTask does).
 * Throws when it can't be delivered (the ticket is gone, stopping or being rewound): the caller keeps the item for its next check.
 */
export async function automationItem(this: Board, slug: string, id: string, text: string, by: { loopId: string; name: string; autoStart: boolean }): Promise<"note" | "chat"> {
  const t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  const active = this.runs.get(this.key(slug, id));
  if (active?.stopRequested || this.shuttingDown) throw new ConflictError("Claude is stopping; the item waits for the next check");
  const notStarted = t.waitsForStart || t.runCount === 0 || t.status === "backlog" || t.status === "planning" || t.status === "ready";
  if (!by.autoStart || (!active && notStarted) || active?.chat?.mode === "refine") {
    this.addComment(slug, id, text, `loop:${by.loopId}`);
    return "note";
  }
  await this.chat(slug, id, text, { fromPlanner: true, automation: { loopId: by.loopId, name: by.name }, nextRun: true });
  // Brought back once the message is on the ticket: a refused message leaves the feature where it was.
  const main = t.main ? this.store.getTicket(slug, id) : this.mainOf(slug, t);
  if (main?.main && main.status === "done") {
    this.unparkMain(slug, main.id, main.id === id ? `the automation "${by.name}" sent it a new item` : `the automation "${by.name}" sent a new item to its task ${id}`);
  }
  return "chat";
}

/** The ticket's last result in words (its newest summary comment). */
export function lastSummary(this: Board, slug: string, id: string): string {
  return this.store.lastAiSummary(slug, id) ?? "";
}

/** A ticket's outputs/report.md, if it wrote one. */
export function reportOf(this: Board, slug: string, id: string): string | null {
  const file = join(this.store.outputsPath(slug, id), REPORT_FILE);
  return existsSync(file) ? file : null;
}

/**
 * Files a tool ticket changed in the project folder itself (a folder without version history): files modified while
 * its last run went (tool tickets there run one at a time), or at least the ones its edit tool calls named.
 */
export function folderFiles(this: Board, slug: string, id: string): number {
  const t = this.store.getTicket(slug, id);
  const root = this.store.getProfile(slug)?.path;
  const files = new Set<string>();
  const from = t?.lastRunAt ? Date.parse(t.lastRunAt) - 1000 : NaN;
  const to = (t?.runEndedAt ? Date.parse(t.runEndedAt) : Date.now()) + 2000;
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || seen > 20_000) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name === ".git" || d.name === "node_modules" || d.name.startsWith(".ckanban")) continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p, depth + 1);
      else if (d.isFile() && ++seen) {
        const m = statSync(p).mtimeMs;
        if (m >= from && m <= to) files.add(p);
      }
    }
  };
  if (root && Number.isFinite(from)) {
    try {
      walk(root, 0);
    } catch {}
  }
  for (const f of this.editedFiles(slug, id)) files.add(f);
  return files.size;
}

/**
 * Files a ticket's edit tool calls named (from its activity). Reads what the log gained since last time in one go:
 * runs in a folder without version history warm it at their start (executeOnce), so that is about one run's worth.
 */
export function editedFiles(this: Board, slug: string, id: string): Set<string> {
  return this.store.activityDigestNow(slug, id).edited;
}

/** A tool ticket's result as a card for its parent's chat. */
export function resultCard(this: Board, slug: string, id: string): ResultCard | null {
  const t = this.store.getTicket(slug, id);
  if (!t) return null;
  const summary = this.lastSummary(slug, id).trim();
  const plain = !t.worktree && !t.branch && !t.workdir && (this.repoState(slug) === "plain" || this.repoState(slug) === "empty");
  let cost: number | null = null;
  try {
    cost = Math.round(this.costOf(slug, id) * 100) / 100;
  } catch {}
  return {
    at: nowIso(), ticketId: t.id, title: t.title, kind: t.kind ?? null, outcome: t.outcome ?? "done", verdict: t.verdict ?? null,
    summary: summary.length > 600 ? `${summary.slice(0, 599)}…` : summary, report: this.reportOf(slug, id), model: t.model ?? null, costUsd: cost,
    ...(plain ? { folderFiles: this.folderFiles(slug, id) } : {}),
  };
}

/**
 * A ticket the user added to a main ticket's feature (not one of its tool tickets) finished a run: its result also
 * reaches the main ticket, as an event and a result card.
 */
export function reportToMain(this: Board, slug: string, id: string, summary: string): void {
  const t = this.store.getTicket(slug, id);
  if (!t || t.tool || t.main) return;
  const main = this.mainOf(slug, t);
  if (!main || main.id === id) return;
  const card = this.resultCard(slug, id);
  if (card) this.patch(slug, main.id, { results: [...(this.store.getTicket(slug, main.id)?.results ?? []), card].slice(-RESULTS_KEEP) });
  this.pushEvent(slug, main.id, finishedLine(t, summary, this.reportOf(slug, id)));
}

/**
 * A "with you" step ended waiting for the user: a grey board note in its main ticket's chat says so ("Staging check
 * needs you: <its first question>"). The note doesn't wake the main ticket: only the user answers the step.
 */
export function noteStepWaiting(this: Board, slug: string, id: string, summary: string): void {
  const t = this.store.getTicket(slug, id);
  if (!t || !youWaiting(t, false)) return;
  const main = this.mainOf(slug, t);
  if (!main || main.id === id) return;
  const ask = this.openForm(t)[0]?.question ?? summary;
  const first = ask.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
  const line = first.length > 160 ? `${first.slice(0, 159)}…` : first;
  const note: BoardNote = { at: nowIso(), ticketId: t.id, text: `${stepName(t)} needs you${line ? `: ${line}` : ""}` };
  this.patch(slug, main.id, { boardNotes: [...(this.store.getTicket(slug, main.id)?.boardNotes ?? []), note].slice(-BOARD_NOTES_KEEP) });
}

/** The user wrote in a tool ticket's chat: its parent hears the whole message before its next decision. */
export function noteUserMessage(this: Board, slug: string, id: string, text: string): void {
  const t = this.store.getTicket(slug, id);
  if (!t?.tool) return;
  const parent = t.parentId ?? this.mainOf(slug, t)?.id;
  if (!parent) return;
  this.pushEvent(slug, parent, `the user wrote in tool ticket ${t.id} "${t.title}": ${text}`);
}

/**
 * How many tickets of a main ticket's family are working now (tool tickets and tickets the user added; the main
 * ticket itself left out). Its card shows In progress meanwhile (columns.ts familyBusy) with familyCard's working line.
 */
export function familyWorking(this: Board, slug: string, id: string, tickets = this.store.listTickets(slug)): number {
  return workingInFamily(familyBelow(tickets, id), id, (t) => this.isRunning(slug, t.id)).length;
}

/**
 * How many of a main ticket's steps (tool tickets, not tickets the user added) are running now. A main card parked in
 * Done or Backlog shows In progress meanwhile (columns.ts familyBusy); queued steps don't count there (parked, they wait).
 */
export function stepsRunning(this: Board, slug: string, id: string, tickets = this.store.listTickets(slug)): number {
  return featureRows(tickets, id).filter((r) => r.ticket.id !== id && r.ticket.tool && this.isRunning(slug, r.ticket.id)).length;
}

/** The flags a run of the ticket's chat gets (see executeOnce); contextSpec copies them for the Context panel. */
export function chatArgs(this: Board, slug: string, t: Ticket, profile: Profile, refine: boolean, sessionId: string, resume: boolean, systemPrompt?: string, cap?: number | null, browsers?: RunBrowsers | null): string[] {
  const effortNow = runOptions(t, profile, !refine);
  // The board's claude.ai connector setting: hidden connectors join --disallowedTools, "none" turns them all off.
  const connectors = boardConnectorOptions(profile);
  return buildArgs(sessionId, resume, t.model ?? (t.main ? profile.mainModel : null) ?? profile.model,
    // A main ticket never edits: every change goes to a tool ticket.
    [...(refine ? PLANNING_DISALLOWED_TOOLS : []), ...(t.main ? NO_EDIT_TOOLS.split(",") : []), ...connectors.disallowed],
    mcpConfig(undefined, { ...this.store.boardTools(slug), ...(browsers ? browsers.servers : this.browserServers(this.browserPicks(slug, t), this.store.outputsDir(slug, t.id))) }),
    systemPrompt, cap ?? null, effortNow.effort, effortNow.ultracode, browsers?.noChrome ? { noChrome: true } : null);
}

/** The environment a run of the ticket gets. */
export function chatEnv(this: Board, slug: string, id: string, outputDir: string): Record<string, string> {
  const connectors = boardConnectorOptions(this.store.getProfile(slug)!);
  // CKANBAN_TICKET marks board runs: the ckanban MCP/CLI refuses board changes there (no runs starting runs).
  // The board's saved keys (ask_keys) come first, so the board's own variables always win.
  return { ...boardKeyEnv(this.store.root, slug), ...connectors.env, CKANBAN_OUTPUT_DIR: outputDir, CKANBAN_TICKET: `${slug}/${id}` };
}

/**
 * What the Context panel needs to run `/context` like the ticket's chat runs (same folder, flags and environment), or
 * null when the ticket has no saved Claude session yet. The per-run system prompt and spending cap are left out.
 */
/** The session contextSpec would check, without building the chat's command (a whole prompt): null when it has none. */
export function contextSession(this: Board, slug: string, id: string): string | null {
  const t = this.store.getTicket(slug, id);
  const profile = this.store.getProfile(slug);
  if (!t || !profile || !t.sessionId || !this.sessionExists(t.sessionId)) return null;
  return existsSync(t.workdir ?? t.worktree ?? profile.path) ? t.sessionId : null;
}

export function contextSpec(this: Board, slug: string, id: string): { sessionId: string; cwd: string; args: string[]; env: Record<string, string> } | null {
  const sessionId = this.contextSession(slug, id);
  if (!sessionId) return null;
  const t = this.store.getTicket(slug, id)!;
  const profile = this.store.getProfile(slug)!;
  const cwd = t.workdir ?? t.worktree ?? profile.path;
  const refine = chatModeFor(t.status) === "refine";
  return { sessionId, cwd, args: this.chatArgs(slug, t, profile, refine, sessionId, true), env: this.chatEnv(slug, id, this.store.outputsDir(slug, id)) };
}

/** Called after each run of a ticket ends (the Context panel refreshes then). */
export function onRunEnd(this: Board, fn: (slug: string, id: string) => void): void {
  this.runEnded.push(fn);
}

/** The main or tool rules a run of t gets, or undefined for other tickets. */
export function roleOf(this: Board, slug: string, t: Ticket, session: Pick<Session, "repo" | "inPlace">): RunRole | undefined {
  if (t.main) {
    const now = this.store.getTicket(slug, t.id) ?? t;
    const planned = mainPlanned(this.store.listTickets(slug), now);
    const up = parentLink(now);
    const above = up && this.store.getTicket(slug, up.id) ? featureRoot(this.store.listTickets(slug), up.id) : undefined;
    return {
      kind: "main", repo: session.repo, branch: session.inPlace ? null : now.branch ?? null, inPlace: session.inPlace, ...(now.plan?.state === "paused" ? { paused: true } : {}), ...(planned ? { planned } : {}),
      ...(above ? { subFeatureOf: { id: above.id, title: above.title } } : {}),
      taskModels: this.store.getProfile(slug)?.taskModels ?? null,
    } satisfies MainRole;
  }
  if (!t.tool) return undefined;
  const all = this.store.listTickets(slug);
  const main = this.mainOf(slug, t) ?? featureRoot(all, t.id) ?? t;
  const parent = (t.parentId ? all.find((o) => o.id === t.parentId) : null) ?? main;
  const saved = readStatus(this.store.outputsPath(slug, main.id));
  let statusPath: string | null = null;
  try {
    statusPath = this.refreshStatusFile(slug, main.id);
  } catch {}
  const siblings = childrenOf(all, parent.id);
  const deps = resolveDeps(t, siblings).deps.map((d) => ({ id: d.id, title: d.title, path: this.reportOf(slug, d.id) }));
  return {
    kind: "tool", repo: session.repo, parent: { id: parent.id, title: parent.title }, main: { id: main.id, title: main.title },
    goal: saved?.goal?.trim() || main.title, statusPath, depReports: deps,
    mainBranch: session.inPlace ? null : main.branch ?? null, outputDir: this.store.outputsDir(slug, t.id),
    ...(t.kind === "with_you" ? { withYou: true } : {}),
  } satisfies ToolRole;
}

/**
 * ask_ticket: a fork of the tool ticket's session at its latest saved point (its own session is untouched) answers
 * the question in at most 5 sentences with read-only tools. It needs no run slot and works while the ticket runs. The
 * answer reaches the asker as an event, or "no answer" after the timeout.
 */
export function askTicket(this: Board, slug: string, askerId: string, targetId: string, question: string): string {
  const asker = this.store.getTicket(slug, askerId);
  const target = this.store.getTicket(slug, targetId);
  const profile = this.store.getProfile(slug);
  if (!asker || !target || !profile) throw new Error(`ticket ${!target ? targetId : askerId} not found`);
  if (!question.trim()) throw new Error("the question is empty");
  const label = `${target.id} "${target.title}"`;
  const reply = (line: string) => this.pushEvent(slug, askerId, line);
  const src = target.sessionId ? claudeSessionFile(target.sessionId) : null;
  const dir = target.workdir ?? target.worktree ?? profile.path;
  if (!src || !existsSync(dir)) {
    queueMicrotask(() => reply(`no answer from ${label} to "${question}": it has no conversation yet.`));
    return `${target.id} has no conversation yet, so it can't answer; you'll get that as an event.`;
  }
  const forkId = crypto.randomUUID();
  const file = forkSessionFile(src, { fromId: target.sessionId!, toId: forkId, fromCwd: dir, toCwd: dir });
  const prompt = `${asker.title} (${asker.id}) asks you a question about your work on this ticket. This is a copy of your conversation: answer from what you did and know, in at most 5 sentences. You may read files, but don't change anything and don't start new work. Don't write a CKANBAN_RESULT line.\n\nQuestion: ${question.trim()}`;
  let timedOut = false;
  const handle = startRun({
    bin: this.opts.claudeBin, cwd: dir,
    args: buildArgs(forkId, true, target.model ?? profile.model, [...NO_EDIT_TOOLS.split(","), "Bash"], undefined, undefined, null, "low"),
    input: prompt, env: { CKANBAN_OUTPUT_DIR: this.store.outputsPath(slug, target.id) }, onEvent: () => {},
  });
  // A restart stops the fork before it answers: shutdown() saves this "no answer" on the asker, so it is woken after.
  this.asks.set(handle, () => reply(`no answer from ${label} to "${question}": the board restarted before it answered. Ask again if you still need it.`));
  const timer = setTimeout(() => {
    timedOut = true;
    handle.stop();
  }, this.opts.askTimeoutMs ?? ASK_TIMEOUT_MS);
  void handle.done.then((out) => {
    clearTimeout(timer);
    this.asks.delete(handle);
    try {
      rmSync(file, { force: true });
    } catch {}
    if (this.shuttingDown) return; // shutdown() already saved the "no answer" event
    const text = extractFinalText(out.events).replace(/^.*CKANBAN_RESULT:.*$/gm, "").trim();
    const minutes = Math.round((this.opts.askTimeoutMs ?? ASK_TIMEOUT_MS) / 60_000);
    reply(timedOut || !text
      ? `no answer from ${label} to "${question}"${timedOut ? ` within ${minutes || "a few"} minute${minutes === 1 ? "" : "s"}` : ""}.`
      : `answer from ${label} to "${question}": ${sentences(text)}`);
  });
  return `Asked ${label}. Its answer (or "no answer" after ${Math.round((this.opts.askTimeoutMs ?? ASK_TIMEOUT_MS) / 60_000) || 1} minutes) comes back as an event when you are woken; end your run if you have nothing else to do.`;
}

/**
 * merge_into_main: fast-forwards the main ticket's copy to the tool ticket's branch, one at a time per main ticket.
 * Refused (and counted) when the main copy moved since the tool ticket merged it; after MERGE_TRIES the tool ticket
 * ends blocked and its parent hears about it.
 */
export function mergeIntoMain(this: Board, slug: string, toolId: string): Promise<string> {
  const tool = this.store.getTicket(slug, toolId);
  if (!tool) return Promise.reject(new Error(`ticket ${toolId} not found`));
  if (!tool.tool) return Promise.reject(new Error("only a tool ticket merges into its main ticket's copy"));
  const main = this.mainOf(slug, tool);
  if (!main) return Promise.reject(new Error("this ticket has no main ticket to merge into"));
  const key = this.key(slug, main.id);
  const next = (this.mergeLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.mergeNow(slug, toolId, main.id));
  this.mergeLocks.set(key, next);
  next.finally(() => {
    if (this.mergeLocks.get(key) === next) this.mergeLocks.delete(key);
  }).catch(() => {});
  return next;
}

export async function mergeNow(this: Board, slug: string, toolId: string, mainId: string): Promise<string> {
  const profile = this.store.getProfile(slug)!;
  const tool = this.store.getTicket(slug, toolId)!;
  const main = this.store.getTicket(slug, mainId)!;
  if (!tool.worktree || !tool.branch) return "Nothing to merge: you edit the project folder itself, so your changes are already where the main ticket sees them.";
  if (!main.branch) throw new Error("the main ticket has no copy of its own to merge into; end with your branch as it is and say so in your summary");
  const dirty = await runCmd(["git", "status", "--porcelain"], tool.worktree);
  if (dirty.code === 0 && dirty.stdout.trim()) throw new Error("you have changes that aren't committed yet: commit them, then call merge_into_main again");
  const ancestor = await runCmd(["git", "merge-base", "--is-ancestor", main.branch, tool.branch], profile.path);
  if (ancestor.code !== 0) {
    const fails = (tool.mergeFails ?? 0) + 1;
    this.patch(slug, toolId, { mergeFails: fails });
    if (fails >= MERGE_TRIES) {
      this.pushEvent(slug, tool.parentId ?? mainId, `merge failed: ${tool.id} "${tool.title}" couldn't merge into the main copy ${fails} times, so it ends blocked.`);
      throw new Error(`The main ticket's copy moved again (try ${fails} of ${MERGE_TRIES}). Stop here: end your run with status "blocked" and say what is left to merge; your parent decides what happens next.`);
    }
    throw new Error(`The main ticket's copy moved since you last merged it (try ${fails} of ${MERGE_TRIES}): merge again and retry. Run \`git merge ${main.branch}\`, sort out any clashes, re-run the checks, commit, then call merge_into_main again.`);
  }
  const sha = (await runCmd(["git", "rev-parse", tool.branch], profile.path)).stdout.trim();
  const count = Number((await runCmd(["git", "rev-list", "--count", `${main.branch}..${tool.branch}`], profile.path)).stdout.trim()) || 0;
  if (!count) {
    this.patch(slug, toolId, { merged: sha, mergeFails: 0 });
    return "Nothing new to merge: the main ticket's copy already has your work.";
  }
  const r = main.worktree && existsSync(main.worktree)
    ? await runCmd(["git", "merge", "--ff-only", tool.branch], main.worktree)
    : await runCmd(["git", "branch", "-f", main.branch, tool.branch], profile.path);
  if (r.code !== 0) throw new Error(`couldn't move the main ticket's copy forward: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
  this.patch(slug, toolId, { merged: sha, mergeFails: 0 });
  this.store.addComment(slug, mainId, "ai", `Merged ${count} commit${count === 1 ? "" : "s"} of ${tool.id} "${tool.title}" into this ticket's copy.`);
  this.emitTicket(slug, this.store.getTicket(slug, mainId)!);
  return `Merged ${count} commit${count === 1 ? "" : "s"} into the main ticket's copy (${main.branch}).`;
}

/**
 * land_milestone: lands the main ticket's copy as the board lands work (landRule): push and one pull request on a
 * repo with a remote (the open one is updated), a merge into the project folder without one. Plain folders only
 * record it (the work is already there). Refused with the reason when it can't land cleanly.
 */
export async function landMilestone(this: Board, slug: string, id: string, summary: string): Promise<string> {
  const t = this.store.getTicket(slug, id);
  const profile = this.store.getProfile(slug);
  if (!t || !profile) throw new Error(`ticket ${id} not found`);
  if (!t.main) throw new Error("only a main ticket lands milestones");
  const text = summary.trim().slice(0, 500);
  if (!text) throw new Error("say in one line what this milestone is (summary)");
  const record = (landed: string) => {
    const dir = this.store.outputsDir(slug, id);
    const saved = readStatus(dir);
    const next: SavedStatus = { ...(saved ?? {}), updatedAt: nowIso(), milestones: [...(saved?.milestones ?? []), { at: nowIso(), summary: text, landed }].slice(-20) };
    writeStatus(dir, this.store.getTicket(slug, id)!, next, this.facts(slug, this.store.listTickets(slug), id, next.prNotes), true);
    this.patch(slug, id, { statusAt: nowIso() });
    this.store.addComment(slug, id, "ai", `Milestone landed: ${text} (${landed}).`);
  };
  // Fresh: a remote the user just added must be pushed to, not missed for a few seconds.
  const repo = await repoKind(profile.path, { fresh: true });
  if (repo === "plain" || repo === "empty" || !t.branch || !t.worktree || !existsSync(t.worktree)) {
    record("already in the project folder");
    return "Recorded the milestone: the tool tickets already edited the project folder itself, so there is nothing else to land.";
  }
  const dirty = await runCmd(["git", "status", "--porcelain"], t.worktree);
  if (dirty.code === 0 && dirty.stdout.trim()) throw new Error("the main ticket's copy has uncommitted changes, so it can't land cleanly; start a fix tool ticket to commit or drop them");
  const base = profile.baseBranch || "main";
  if (repo === "remote") {
    const push = await runCmd(["git", "push", "-u", "origin", t.branch], t.worktree);
    if (push.code !== 0) throw new Error(`couldn't push the main ticket's copy: ${(push.stderr || push.stdout).trim().split("\n").slice(-3).join(" ")}. Start a fix tool ticket (for example to merge ${base} in and sort out clashes).`);
    const open = ticketPrs(t).find((p) => p.state !== "MERGED" && p.state !== "CLOSED");
    let url = open?.url ?? null;
    if (!url) {
      try {
        url = await (this.opts.openPr ?? openPrWithGh)(t.worktree, { branch: t.branch, base, title: t.title, body: text });
      } catch (e) {
        throw new Error(`pushed the copy, but couldn't open the pull request: ${(e as Error).message}`);
      }
      this.patch(slug, id, addPrs(this.store.getTicket(slug, id)!, [url]));
    }
    record(`${open ? "updated" : "opened"} ${url}`);
    return `Landed: pushed your copy and ${open ? "updated the open" : "opened a"} pull request: ${url}`;
  }
  // No remote: merge the copy into the project folder, like a ticket's own run would (see localLand in prompts.ts).
  const head = await runCmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], profile.path);
  if (head.stdout.trim() !== base) throw new Error(`the project folder is on "${head.stdout.trim()}", not ${base}, so the board won't merge into it; ask the user to switch it back`);
  const folderDirty = await runCmd(["git", "status", "--porcelain"], profile.path);
  if (folderDirty.stdout.trim()) throw new Error("the project folder has uncommitted changes, so the board won't merge into it; ask the user to save or discard them first");
  const m = await runCmd(["git", "merge", "--no-edit", t.branch], profile.path);
  if (m.code !== 0) {
    await runCmd(["git", "merge", "--abort"], profile.path);
    throw new Error(`merging into ${base} clashed (${(m.stdout || m.stderr).trim().split("\n").slice(-2).join(" ")}), so nothing was landed. Start a fix tool ticket to merge ${base} into your copy and sort out the clashes`);
  }
  const sha = (await runCmd(["git", "rev-parse", "--short", "HEAD"], profile.path)).stdout.trim();
  record(`merged into ${base} in the project folder at ${sha}`);
  return `Landed: merged your copy into ${base} in the project folder (${sha}).`;
}
