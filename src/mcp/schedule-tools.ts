// Schedules (recurring tickets) and one-time jobs. Moved verbatim from mcp-server.ts.
import { hiddenTool } from "../../web/src/features/family/family";
import { FRONT_DESK_ENV, HUDDLE_AGENT_ENV, QUICK_CHAT_ENV } from "../core/env";
import { ClientError, huddleCaller, parseMode, RUN_ENV, type JobInfo, type JobInput, type ScheduleHistoryInfo, type ScheduleInfo, type ScheduleInput } from "../cli/client";
import { PROFILE, SCHEDULE_ID, SCHEDULE_FIELDS, tagsList, type Tool, slugFor, str, localTime, QUICK_CHAT_NO_DELETE, toolNoScheduleDelete } from "./shared";
import { HELPER_TOOLS } from "./helper-tools";

export function scheduleLine(s: ScheduleInfo): string {
  const state = [s.enabled ? "active" : "paused"];
  if (s.active) state.push("running");
  const bits = [`${s.id}  [${state.join(", ")}]  ${s.name}: ${s.summary} (${s.cron})`];
  if (s.enabled && s.nextRunAt) bits.push(`next ${localTime(s.nextRunAt)}`);
  if (s.lastFiredAt) bits.push(`last ticket ${localTime(s.lastFiredAt)}`);
  if (s.lastError) bits.push(`last run failed to start: ${s.lastError}`);
  if (s.quiet) bits.push("quiet when nothing needs the user");
  if (s.model) bits.push(`model ${s.model}`);
  if (s.partOf) bits.push(`each run is a task of ${s.partOf}${s.partOfTitle ? ` "${s.partOfTitle}"` : " (ticket not found: runs get their own card)"}`);
  return bits.join("; ");
}

export function scheduleText(s: ScheduleInfo): string {
  return [
    scheduleLine(s),
    `ticket title: ${s.title}`,
    `mode: ${s.mode}, skip while previous runs: ${s.skipIfRunning ? "yes" : "no"}`,
    ...(s.tags?.length ? [`tags: ${s.tags.join(", ")}`] : []),
    "", s.body.trim() || "(no prompt)",
  ].join("\n");
}


export function historyLine(e: ScheduleHistoryInfo): string {
  const t = e.ticket ? `${e.ticket.id} "${e.ticket.title}" [${e.ticket.running ? "running" : [e.ticket.status, e.ticket.outcome].filter(Boolean).join(", ")}]` : null;
  const at = localTime(e.at);
  const runBy = e.kind !== "edited" && e.by && e.by !== "user" ? ` by ticket ${e.by.ticketId}` : "";
  if (e.kind === "fired") return `${at}  fired (${e.trigger}${runBy}): ${t ?? `${e.ticketId} (deleted)`}${e.note ? ` (${e.note})` : ""}`;
  if (e.kind === "skipped") return `${at}  skipped (${e.trigger}${runBy}): previous ticket ${e.ticketId ?? ""} still queued or running`;
  if (e.kind === "error") return `${at}  could not create the ticket (${e.trigger}${runBy}): ${e.message}`;
  if (e.kind === "quiet") return `${at}  checked, nothing new: ${e.summary ?? ""}`;
  const by = !e.by || e.by === "user" ? "the user" : `ticket ${e.by.ticketId}`;
  const fields = e.fields?.length ? ` ${e.fields.join(", ")}` : "";
  const prev = e.previous ? Object.entries(e.previous).map(([k, v]) => `\n    previous ${k}: ${String(v).replace(/\s+/g, " ").slice(0, 300)}`).join("") : "";
  return `${at}  ${e.action}${fields} by ${by}${prev}`;
}

export function scheduleInput(args: any, partial: boolean): ScheduleInput {
  const out: ScheduleInput = {};
  for (const k of ["name", "title", "body", "cron"] as const) {
    if (typeof args?.[k] === "string") out[k] = args[k];
    else if (!partial && k !== "body") throw new ClientError(`${k} is required`);
  }
  if (args?.mode !== undefined) out.mode = parseMode(args.mode);
  if (args?.model !== undefined) {
    if (typeof args.model !== "string") throw new ClientError("model must be a string");
    out.model = args.model.trim() || null;
  }
  if (args?.partOf !== undefined) {
    if (args.partOf !== null && typeof args.partOf !== "string") throw new ClientError("partOf must be a ticket id, or \"\" to clear it");
    out.partOf = (args.partOf ?? "").trim() || null;
  }
  for (const k of ["enabled", "skipIfRunning", "quiet"] as const) {
    if (args?.[k] === undefined) continue;
    if (typeof args[k] !== "boolean") throw new ClientError(`${k} must be true or false`);
    out[k] = args[k];
  }
  const tags = tagsList(args);
  if (tags) out.tags = tags;
  return out;
}

export const SCHEDULE_TOOLS: Tool[] = [
  {
    name: "list_schedules",
    description:
      "List a board's schedules (recurring tickets): id, active/paused, when it fires (plain English + cron), next run, last ticket, errors. " +
      "Check this before create_schedule to avoid duplicates.",
    inputSchema: { type: "object", properties: { profile: PROFILE } },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const ss = await ctx.client.listSchedules(slug);
      return ss.length ? `Schedules on board ${slug}:\n${ss.map(scheduleLine).join("\n")}` : `Board ${slug} has no schedules.`;
    },
  },
  {
    name: "create_schedule",
    description:
      "Create a schedule: at each cron time the board creates a ticket from it and Claude starts working on it right away, unattended. " +
      "Use it when the user wants something done regularly (nightly audit, weekly changelog, daily CI check). " +
      "Runs happen only while the ckanban daemon is running; one missed run is caught up when it starts. " +
      "Returns the schedule id and its next run times.",
    inputSchema: { type: "object", properties: { profile: PROFILE, ...SCHEDULE_FIELDS }, required: ["name", "title", "body", "cron"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const s = await ctx.client.createSchedule(slug, scheduleInput(args, false), ctx.env[RUN_ENV]);
      const p = await ctx.client.cronPreview(s.cron).catch(() => null);
      const next = p?.next.length ? `\nNext runs: ${p.next.map(localTime).join(", ")}` : "";
      return `Created schedule ${s.id} on board ${slug}: ${s.name}, ${s.summary} (${s.cron}), ${s.mode} mode.${next}\n` +
        "The user can see, pause or edit it in the board's Schedules dialog.";
    },
  },
  {
    name: "update_schedule",
    description:
      "Change a schedule: any of name, title, prompt (body), cron, mode, skipIfRunning, tags, quiet, model, partOf; enabled false/true pauses/resumes it. " +
      "Only the fields you pass change. A run created by a schedule may update its own schedule (e.g. refine its prompt); " +
      "the old prompt is kept in the schedule's history.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: SCHEDULE_ID, ...SCHEDULE_FIELDS }, required: ["id"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const patch = scheduleInput(args, true);
      if (!Object.keys(patch).length) throw new ClientError("nothing to change: pass name, title, body, cron, mode, enabled, skipIfRunning, tags, quiet, model or partOf");
      const s = await ctx.client.updateSchedule(slug, str(args, "id")!, patch, ctx.env[RUN_ENV]);
      return `Updated: ${scheduleLine(s)}`;
    },
  },
  {
    name: "delete_schedule",
    description:
      "Ask the user to delete a schedule (tickets it already created stay). In a board ticket's chat or run nothing is deleted by the call: " +
      "the board shows a card in this ticket's chat with the schedule's name, when it runs and its next run, and the user's Delete click removes it " +
      "(an unattended run's ticket is marked as needing the user). Only schedules on this ticket's board. " +
      "A tool ticket (one working for a main ticket) gets no card: it reports the request to its main ticket, which asks in its own chat. " +
      "A quick chat can't show a card, so it is refused there: ask the user to delete it in the board's Schedules window. " +
      "The Telegram front desk holds it for the user's Confirm tap. " +
      "If the goal is only to stop it for now, pause it instead with update_schedule enabled=false (resume it later with enabled=true). " +
      "Outside the board (the user's own Claude) it deletes the schedule right away.",
    inputSchema: {
      type: "object",
      properties: { profile: PROFILE, id: SCHEDULE_ID, reason: { type: "string", description: "One short line: why it can go (shown on the card)." } },
      required: ["id"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const id = str(args, "id")!;
      if (ctx.env[HUDDLE_AGENT_ENV]) throw new ClientError("huddle participants can't delete schedules; ask @main");
      // The front desk's request is held for the user's Confirm tap in Telegram (ConfirmPending carries what to say).
      if (!ctx.env[RUN_ENV] && ctx.env[FRONT_DESK_ENV]) {
        await ctx.client.deleteSchedule(await slugFor(args, ctx), id);
        return `Deleted schedule ${id}.`;
      }
      // A quick chat shows no cards, and the daemon refuses its deletes.
      if (!ctx.env[RUN_ENV] && ctx.env[QUICK_CHAT_ENV]) throw new ClientError(QUICK_CHAT_NO_DELETE);
      if (!ctx.env[RUN_ENV]) {
        const slug = await slugFor(args, ctx);
        await ctx.client.deleteSchedule(slug, id);
        return `Deleted schedule ${id}.`;
      }
      // A board run or chat: the card in this ticket's chat (session.ts reads this call) deletes it on the user's click.
      const slug = await slugFor({}, ctx);
      if (typeof args?.profile === "string" && args.profile.trim() && (await slugFor(args, ctx)) !== slug) {
        throw new ClientError(`only schedules on this ticket's board (${slug}) can be proposed for deletion here; ask the user to delete it in that board's Schedules window.`);
      }
      const s = (await ctx.client.listSchedules(slug)).find((x) => x.id === id);
      if (!s) throw new ClientError(`no schedule ${id} on board ${slug}. Check list_schedules.`);
      // A tool ticket's chat is seen by nobody: its main ticket asks the user instead (refused, so session.ts shows no card).
      const me = await Promise.resolve().then(() => ctx.client.getTicket(slug, ctx.env[RUN_ENV]!.split("/")[1])).catch(() => null);
      if (hiddenTool(me)) throw new ClientError(toolNoScheduleDelete(s));
      return `Nothing is deleted yet: the board shows the user a card in this ticket's chat for schedule "${s.name}" (${s.summary}), ` +
        "and only their click on Delete removes it. You don't need to wait for it. " +
        "If the goal is only to stop it for now, pause it with update_schedule enabled=false instead, and tell the user.";
    },
  },
  ...HELPER_TOOLS,
  {
    name: "run_schedule",
    description: "Run a schedule now: creates its ticket and starts it, without moving the next scheduled run. " +
      "If the schedule skips while its previous ticket is still queued or running, that still applies. Inside a board run the run is credited to your ticket in the schedule's history.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: SCHEDULE_ID }, required: ["id"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      if (ctx.env[HUDDLE_AGENT_ENV]) throw new ClientError("huddle participants can't run a schedule now; ask @main");
      const { entry } = await ctx.client.runSchedule(slug, str(args, "id")!, huddleCaller(ctx.env));
      if (entry.kind === "fired") return `Started: created ticket ${entry.ticketId}, Claude is working on it.`;
      if (entry.kind === "skipped") return `Skipped: the previous ticket ${entry.ticketId ?? ""} from this schedule is still queued or running.`;
      throw new ClientError(`could not create the ticket: ${entry.message}`);
    },
  },
  {
    name: "schedule_history",
    description: "Show a schedule's settings and history, newest first: tickets it created with their status, skips, errors, and edits (who changed what, with the previous prompt).",
    inputSchema: {
      type: "object",
      properties: { profile: PROFILE, id: SCHEDULE_ID, limit: { type: "number", description: "Entries to show. Default: 20." } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      const [all, h] = await Promise.all([ctx.client.listSchedules(slug), ctx.client.scheduleHistory(slug, id)]);
      const s = all.find((x) => x.id === id);
      const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20));
      const lines = h.slice(0, limit).map(historyLine);
      return `${s ? scheduleText(s) : `Schedule ${id}`}\n\nHistory:\n${lines.length ? lines.join("\n") : "(not run yet)"}`;
    },
  },
];


// --- One-time jobs ---------------------------------------------------------------------------
// The board fires them once at a set time. Runs and chats may schedule them and change, run or cancel any of the board's.

export const JOB_ID = { type: "string", description: "Job id (from schedule_job or list_jobs)." };
export const JOB_AT = {
  type: "string",
  description: "When it runs, in this computer's local time: \"2026-10-20 22:00\" (or an ISO time with a timezone). Must be in the future.",
};
export const JOB_ACTION = {
  type: "object",
  description:
    "What happens at that time. {kind: \"ticket\", title, body, mode?}: the board creates a ticket and Claude starts on it right away, " +
    "unattended, with no access to this conversation. The body is the whole prompt: put everything the future run needs in it " +
    "(goal, the exact text to post, where, how to check it worked); for long content or images, save files in the board folder first and give their paths. " +
    "mode: auto (default) or interview. " +
    "{kind: \"command\", command, timeoutSec?, ifLate?}: runs the command with /bin/sh in the board folder, no ticket and no Claude " +
    "(env CKANBAN_BOARD, CKANBAN_JOB, CKANBAN_SOURCE_TICKET; killed after timeoutSec, default 600); its exit code and last 4 KB of output are kept, " +
    "and if it fails this ticket gets a comment. A command can create tickets itself with `ckanban ticket create`. " +
    "ifLate: what happens when the computer was off at that time and the board sees it more than 10 minutes late: " +
    "\"skip\" (default) or \"run\" it late. Pick per job: a post tied to a moment should skip; a backup or cleanup may run late.",
  properties: {
    kind: { type: "string", enum: ["ticket", "command"] },
    title: { type: "string" },
    body: { type: "string" },
    mode: { type: "string", enum: ["auto", "interview"] },
    command: { type: "string" },
    timeoutSec: { type: "number" },
    ifLate: { type: "string", enum: ["skip", "run"] },
  },
  required: ["kind"],
};

export function jobAction(v: any): JobInput["action"] {
  if (!v || typeof v !== "object") throw new ClientError("action must be an object: {kind: \"ticket\", title, body} or {kind: \"command\", command}");
  if (v.kind === "ticket") return { kind: "ticket", title: String(v.title ?? ""), body: String(v.body ?? ""), ...(v.mode !== undefined ? { mode: parseMode(v.mode) } : {}) };
  if (v.kind === "command") {
    return {
      kind: "command", command: String(v.command ?? ""),
      ...(v.timeoutSec !== undefined ? { timeoutSec: Number(v.timeoutSec) } : {}), ...(v.ifLate !== undefined ? { ifLate: v.ifLate } : {}),
    };
  }
  throw new ClientError("action.kind must be \"ticket\" or \"command\"");
}

/** One line per job: id, state, time, what it does, and how it went. */
export function jobLine(j: JobInfo): string {
  const what = j.action.kind === "ticket" ? `ticket "${j.action.title}"` : `command \`${j.action.command.replace(/\s+/g, " ").slice(0, 80)}\``;
  const bits = [`${j.id}  [${j.state}]  ${j.name}: ${j.when}, ${what}`];
  if (j.sourceTicketId) bits.push(`scheduled by ${j.sourceTicketId}`);
  if (j.changedBy) bits.push(`${j.changedBy.action} by ${j.changedBy.ticketId}`);
  const r = j.result;
  if (r?.ticketId) bits.push(`created ticket ${r.ticketId}`);
  if (r && j.action.kind === "command" && j.state !== "running" && (r.exitCode !== undefined || r.timedOut)) {
    bits.push(r.timedOut ? "timed out" : `exit ${r.exitCode}`);
    if (r.durationMs !== undefined) bits.push(`${(r.durationMs / 1000).toFixed(1)} s`);
  }
  if (r?.message && !r.timedOut) bits.push(r.message);
  return bits.join("; ");
}

export function jobText(j: JobInfo): string {
  const out = j.result?.output?.trim();
  return out ? `${jobLine(j)}\nLast output:\n${out.slice(-1500)}` : jobLine(j);
}

export const JOB_TOOLS: Tool[] = [
  {
    name: "schedule_job",
    description:
      "Schedule a one-time job: at a set date and time the board either creates and starts a ticket (Claude works on it unattended) " +
      "or runs a command with no Claude. Use it for \"do this once later\", e.g. at the end of a planning run: post A on Tue 22:00, post B on Wed 09:00; " +
      "nothing has to stay awake until then. If the computer is off at that time and the board sees it more than 10 minutes late, " +
      "a ticket job still starts and its run is told how late it is, so it decides whether to do it, adapt it or stop; " +
      "a command job follows its ifLate (skipped by default). For recurring work use create_schedule instead. " +
      "If this ticket was itself created by a job, check the chain (shown at the top of its body) makes sense before scheduling another " +
      "ticket job from it: work that repeats belongs in create_schedule. " +
      "Returns the job id and when it runs.",
    inputSchema: {
      type: "object",
      properties: { profile: PROFILE, name: { type: "string", description: "Short name the user sees, e.g. \"Post: new kitchen\"." }, at: JOB_AT, action: JOB_ACTION },
      required: ["name", "at", "action"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const j = await ctx.client.createJob(slug, { name: str(args, "name")!, at: str(args, "at")!, action: jobAction(args?.action) }, huddleCaller(ctx.env));
      return `Scheduled job ${j.id} on board ${slug}: ${j.name} runs ${j.when}.`;
    },
  },
  {
    name: "list_jobs",
    description: "List a board's one-time jobs: upcoming ones, plus recent finished or skipped ones (state, time, result: created ticket, exit code, errors).",
    inputSchema: {
      type: "object",
      properties: { profile: PROFILE, ticketId: { type: "string", description: "Only jobs this ticket's runs scheduled." } },
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const tid = str(args, "ticketId", false);
      const js = await ctx.client.listJobs(slug, tid);
      if (!js.length) return tid ? `Ticket ${tid} has no scheduled jobs.` : `Board ${slug} has no scheduled jobs.`;
      return `Jobs on board ${slug}${tid ? ` scheduled by ${tid}` : ""}:\n${js.map(jobText).join("\n")}`;
    },
  },
  {
    name: "update_job",
    description: "Change a job that hasn't run yet: its name, time (at) or action. The action is replaced as a whole: " +
      "send the whole action (kind and all its fields), not only the part you change. Any job on the board; inside a board run the change is credited to your ticket.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: JOB_ID, name: { type: "string" }, at: JOB_AT, action: JOB_ACTION }, required: ["id"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const patch: JobInput = {};
      if (typeof args?.name === "string") patch.name = args.name;
      if (typeof args?.at === "string") patch.at = args.at;
      if (args?.action !== undefined) {
        try {
          patch.action = jobAction(args.action);
        } catch (e) {
          throw new ClientError(`${(e as Error).message}: send the whole action (kind and all its fields), not only the part you change`);
        }
      }
      if (!Object.keys(patch).length) throw new ClientError("nothing to change: pass name, at or action");
      return `Updated: ${jobLine(await ctx.client.updateJob(slug, str(args, "id")!, patch, huddleCaller(ctx.env)))}`;
    },
  },
  {
    name: "cancel_job",
    description: "Cancel a job that hasn't run yet, so it never runs. Any job on the board; inside a board run the change is credited to your ticket.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: JOB_ID }, required: ["id"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      return `Cancelled: ${jobLine(await ctx.client.jobAction(slug, str(args, "id")!, "cancel", huddleCaller(ctx.env)))}`;
    },
  },
  {
    name: "run_job_now",
    description: "Run a scheduled job right away, ahead of its time. Any job on the board; inside a board run it is credited to your ticket.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: JOB_ID }, required: ["id"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const j = await ctx.client.jobAction(slug, str(args, "id")!, "run", huddleCaller(ctx.env));
      if (j.state === "failed") throw new ClientError(`job ${j.id} failed: ${j.result?.message ?? "unknown error"}`);
      if (j.result?.ticketId) return `Started: created ticket ${j.result.ticketId}, Claude is working on it.`;
      return `Started: ${jobLine(j)}. Check list_jobs for its exit code and output.`;
    },
  },
];
