// Huddles: agent runs: workspaces, copies, snapshots, running and stopping an agent (methods of the Huddles class in huddle.ts, split by topic).
import { boardConnectorOptions } from "../runs/connectors";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { summarizeEvent } from "../runs/activity";
import { mcpConfig } from "../server/agents";
import { type RunBrowsers } from "../board/board";
import { hasCommits, NO_HOOKS, run as git } from "../runs/git";
import { HUDDLE_AGENT_ENV, NO_EDIT_TOOLS, proposalFile, summaryFile } from "./huddle-roster";
import { keepUnhanded, makeFolderCopy, makeGitCopy, readState } from "./huddle-copies";
import { huddleAgentSystemPrompt, withoutChromeRule } from "../runs/prompts";
import { buildArgs, MONITOR_IDLE_MS, startRun } from "../runs/runner";
import { addHuddleSpend } from "../usage/spend";
import { contextTokens, messageCost } from "../usage/ticket-usage";
import type { Huddle, HuddleParticipant, Ticket } from "../core/types";
import { nowIso } from "../core/util";
import { boardKeyEnv } from "../server/board-keys";
import type { Huddles } from "./huddle";
import { ACTIVITY_THROTTLE_MS, costAfter, AgentRun, isSnapshot, settled, agentDir, mainRepo } from "./huddle-types";

/**
 * Where an agent works: (workspace own) its own copy of the host's folder (see copyFor); a read-only agent, a
 * detached snapshot of the host's HEAD (see snapshot); anyone else the host ticket's folder. In a repo with no
 * commits there is nothing to snapshot, so read-only agents read the host's folder (as the host ticket does).
 */
export async function workspace(this: Huddles, slug: string, h: Huddle, p: HuddleParticipant): Promise<string> {
  const host = await this.board.ensureSession(slug, h.hostTicket);
  const committed = host.isGit && (await hasCommits(host.dir));
  if (p.workspace === "shared") return isSnapshot(p) && committed ? this.snapshot(slug, h, p, host.dir) : host.dir;
  // An older huddle's own worktree carries on as it was.
  if (!p.copy && p.branch && p.worktree && existsSync(p.worktree)) return p.worktree;
  if (p.copy && !p.copy.fresh && existsSync(p.copy.dir) && readState(p.copy.dir)) return p.copy.dir;
  return this.copyFor(slug, h, p, host.dir, committed);
}

/**
 * Make (or make again) an agent's own copy of the host's folder: a git worktree on its own branch at the host
 * folder as it is now (uncommitted work included) when the repo has commits, else a plain copy of the folder.
 * A read-only snapshot it had before it was allowed to change files makes way for it.
 */
export async function copyFor(this: Huddles, slug: string, h: Huddle, p: HuddleParticipant, hostDir: string, committed: boolean): Promise<string> {
  const profile = this.store.getProfile(slug)!;
  const dir = agentDir(profile, h, p);
  if (p.worktree && !p.branch) {
    if (existsSync(p.worktree)) await git(["git", "worktree", "remove", "--force", p.worktree], profile.path);
    rmSync(p.worktree, { recursive: true, force: true });
    await git(["git", "worktree", "prune"], profile.path);
    this.updateP(slug, h.id, p.handle, { worktree: null, snapshot: null });
  }
  // Made again (after a conflict): whatever it changed and never handed in is saved first, so nothing is lost.
  const cur = this.get(slug, h.id).participants.find((x) => x.handle === p.handle)?.copy;
  if (cur && cur.dir === dir && existsSync(cur.dir)) {
    const kept = await keepUnhanded(cur.dir, cur.kind, nowIso().replace(/[:.]/g, "-"));
    if (kept) this.system(slug, h.id, `Saved the changes @${p.handle} never handed in to ${kept} before giving it a fresh copy of the folder, so nothing is lost.`);
  }
  const branch = committed ? `ck/${h.hostTicket}-${p.handle}` : null;
  const repo = committed ? await mainRepo(hostDir) : null;
  if (committed) await makeGitCopy(repo!, hostDir, dir, branch!);
  else await makeFolderCopy(hostDir, dir);
  this.updateP(slug, h.id, p.handle, { copy: { kind: committed ? "git" : "folder", dir, repo, branch, at: nowIso() } });
  return dir;
}

/**
 * A read-only agent's folder: a detached worktree at the host worktree's committed HEAD, made on its first run and
 * reset at every wake (local changes and untracked files there are discarded). Nothing it does there reaches the
 * coordinator's worktree.
 */
export async function snapshot(this: Huddles, slug: string, h: Huddle, p: HuddleParticipant, hostDir: string): Promise<string> {
  const profile = this.store.getProfile(slug)!;
  const head = await git(["git", "rev-parse", "HEAD"], hostDir);
  if (head.code !== 0) throw new Error(`couldn't read the host worktree's HEAD: ${head.stderr.trim()}`);
  const sha = head.stdout.trim();
  const branch = (await git(["git", "branch", "--show-current"], hostDir)).stdout.trim() || null;
  const dir = p.worktree ?? agentDir(profile, h, p);
  if (existsSync(dir)) {
    for (const cmd of [[...NO_HOOKS, "checkout", "--quiet", "--force", "--detach", sha], ["git", "clean", "-fdq"]]) {
      const r = await git(cmd, dir);
      if (r.code !== 0) throw new Error(`couldn't reset the snapshot worktree ${dir}: ${r.stderr.trim()}`);
    }
  } else {
    await git(["git", "worktree", "prune"], profile.path);
    mkdirSync(dirname(dir), { recursive: true });
    const r = await git([...NO_HOOKS, "worktree", "add", "--detach", dir, sha], profile.path);
    if (r.code !== 0) throw new Error(`couldn't make the snapshot worktree ${dir}: ${r.stderr.trim()}`);
  }
  this.updateP(slug, h.id, p.handle, { worktree: dir, branch: null, snapshot: { branch, sha } });
  return dir;
}

export function browserLease(this: Huddles, slug: string, hid: string, handle: string): string {
  return `huddle:${slug}/${hid}/${handle}`;
}

export async function executeAgent(this: Huddles, slug: string, hid: string, handle: string, run: AgentRun, input: string): Promise<void> {
  let h = this.get(slug, hid);
  let p = h.participants.find((x) => x.handle === handle)!;
  const host = this.store.getTicket(slug, h.hostTicket);
  if (!host) throw new Error(`host ticket ${h.hostTicket} not found`);
  const dir = await this.workspace(slug, h, p);
  if (run.stopRequested || this.shuttingDown) return;
  h = this.get(slug, hid);
  p = h.participants.find((x) => x.handle === handle)!;
  const profile = this.store.getProfile(slug)!;
  const sessionId = p.sessionId ?? crypto.randomUUID();
  const resume = !!p.sessionStarted && this.sessionExists(sessionId);
  if (!p.sessionId) this.updateP(slug, hid, handle, { sessionId });
  const outputDir = this.store.huddleOutputsDir(slug, h.hostTicket, handle);
  const summary = join(this.store.outputsDir(slug, h.hostTicket), summaryFile(hid));
  const plan = join(this.store.outputsDir(slug, h.hostTicket), proposalFile(hid));
  const system = huddleAgentSystemPrompt(h, p, host as Ticket, outputDir, dir, profile.baseBranch, this.lessonsFor(slug, p.preset), summary, existsSync(plan) ? plan : undefined);
  const connectors = boardConnectorOptions(profile);
  // The host ticket's browsers: board browsers start now and stay open until this agent's run ends (runAgent).
  let browsers: RunBrowsers | null = null;
  try {
    browsers = await this.board.runBrowsers(slug, host as Ticket, this.browserLease(slug, hid, handle), outputDir);
  } catch (e) {
    console.error(`huddle ${slug}/${hid} @${handle}: browsers`, e);
  }
  if (run.stopRequested || this.shuttingDown) return;
  const args = buildArgs(sessionId, resume, p.model ?? profile.model, [...(p.canEdit ? [] : NO_EDIT_TOOLS.split(",")), ...connectors.disallowed],
    mcpConfig(undefined, { ...this.store.boardTools(slug), ...(browsers?.servers ?? {}) }), browsers?.note ? `${browsers.noChrome ? withoutChromeRule(system) : system}\n\n${browsers.note}` : system,
    undefined, undefined, false, browsers?.noChrome ? { noChrome: true } : null);
  let lastWrite = 0;
  let started = resume;
  run.handle = startRun({
    bin: this.opts.claudeBin, cwd: dir, args, input,
    // Huddle agents have no board slot: CKANBAN_TICKET is the host (its board and outputs), CKANBAN_HUDDLE_AGENT who they are.
    // The board's saved keys (ask_keys) first, so the board's own variables always win.
    env: { ...boardKeyEnv(this.store.root, slug), ...connectors.env, CKANBAN_OUTPUT_DIR: outputDir, CKANBAN_TICKET: `${slug}/${h.hostTicket}`, [HUDDLE_AGENT_ENV]: `${hid}/${handle}/${p.token}` },
    idleMs: p.mode === "monitor" ? this.opts.idleMs ?? MONITOR_IDLE_MS : undefined,
    onEvent: (ev) => {
      if (ev?.type === "stream_event" || this.shuttingDown) return;
      if (ev?.type === "result") {
        run.idle = true;
        run.turn = undefined;
        const cur = this.get(slug, hid).participants.find((x) => x.handle === handle);
        const cost = costAfter(cur, Number(ev.total_cost_usd) || 0);
        this.updateP(slug, hid, handle, { status: settled(cur) ? cur!.status : "idle", idleAt: nowIso(), ...cost, ...(run.ctx ? { contextTokens: run.ctx } : {}) });
        try {
          addHuddleSpend(this.store.root, slug, (cost.costUsd ?? 0) - (cur?.costUsd ?? 0));
        } catch {}
        this.board.restartWorkChanged();
        this.checkBudget(slug, hid);
        // Turn boundary: a monitor gets what came in while it worked.
        if (run.pending) queueMicrotask(() => this.deliverNow(slug, hid, handle));
        return;
      }
      // Saved at once: a restart may cut the run off before it ends, and the next run must resume this session.
      if (ev?.type === "system" && ev.subtype === "init" && !started) {
        started = true;
        this.updateP(slug, hid, handle, { sessionStarted: true });
      }
      if (run.idle && (ev?.type === "assistant" || (ev?.type === "system" && ev.subtype === "init"))) {
        run.idle = false;
        if (!settled(this.get(slug, hid).participants.find((x) => x.handle === handle))) this.updateP(slug, hid, handle, { status: "working" });
      }
      // Live cost on the roster: the turn's messages priced from their usage until the result line.
      if (ev?.type === "assistant" && ev.message?.id && ev.message.usage) {
        (run.turn ??= new Map()).set(ev.message.id, messageCost(String(ev.message.model ?? p.model ?? profile.model ?? ""), ev.message.usage));
        if (!ev.parent_tool_use_id) run.ctx = contextTokens(ev.message.usage) || run.ctx;
      }
      const s = summarizeEvent(ev);
      const now = Date.now();
      if ((s || run.ctx) && now - lastWrite >= ACTIVITY_THROTTLE_MS) {
        lastWrite = now;
        this.updateP(slug, hid, handle, { ...(s ? { lastActivity: s } : {}), ...(run.ctx ? { contextTokens: run.ctx } : {}) });
      }
    },
  });
  const out = await run.handle.done;
  if (this.shuttingDown) return;
  started ||= this.sessionExists(sessionId);
  if (!this.load(slug, hid)) return;
  if (run.stopRequested || run.handle.stopped) return this.updateP(slug, hid, handle, { sessionStarted: started, status: "stopped" });
  if (out.code !== 0) {
    const error = out.stderr.trim().split("\n").slice(-3).join("\n") || `claude exited with code ${out.code}`;
    this.updateP(slug, hid, handle, { sessionStarted: started, status: "failed", error });
    this.system(slug, hid, `@${handle}'s run failed: ${error}`);
    return;
  }
  const cur = this.get(slug, hid).participants.find((x) => x.handle === handle);
  this.updateP(slug, hid, handle, { sessionStarted: started, status: settled(cur) ? cur!.status : "idle", idleAt: nowIso() });
}

/**
 * Stop what the huddle runs for a participant: an agent's run, or the reply run the huddle woke a ticket's session
 * for. A ticket's own work (its runs, slot waits, card status) is never touched.
 */
export function stopParticipantRun(this: Huddles, slug: string, h: Huddle, p: HuddleParticipant) {
  const run = this.runs.get(this.key(slug, h.id, p.handle));
  if (run) {
    run.stopRequested = true;
    run.handle?.stop();
  }
  this.mainPending.delete(this.key(slug, h.id, p.handle));
  if (p.kind === "ticket-main" && p.ticketId && this.board.isPeerRun(slug, p.ticketId) && this.mainWoken.get(`${slug}/${p.ticketId}`)?.hid === h.id) {
    this.board.stop(slug, p.ticketId);
  }
}
