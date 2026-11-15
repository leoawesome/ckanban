// What every tool group uses: the ToolContext, shared input schemas, argument helpers and shared texts. Moved verbatim from mcp-server.ts.
import { BoardClient, ClientError, resolveProfile, RUN_ENV, runProfile, ticketLine, type GatherResult } from "../cli/client";
import { PLAN_REVIEW } from "../huddle/huddle-templates";
import type { MessageResult } from "../helper/notify";
import { normalizeTags } from "../board/tags";
import type { ArtifactJob, ArtifactOutcome } from "../runs/artifact";
import { STATUSES } from "../core/types";

/** What gathering tickets into a feature did, for gather_tickets and create_ticket's gather. */
export const gatherText = (r: GatherResult): string => [
  r.gathered.length ? `Gathered ${r.gathered.length}:\n${r.gathered.map((t) => `- ${ticketLine(t)}`).join("\n")}` : "Gathered none.",
  ...(r.group ? [`New group: ${ticketLine(r.group)}`] : []),
  ...(r.movedUp.length ? [`Moved up to stay 2 levels deep:\n${r.movedUp.map((m) => `- ${m.id} "${m.title}" under ${m.to}`).join("\n")}`] : []),
  ...(r.skipped.length ? [`Skipped ${r.skipped.length}:\n${r.skipped.map((x) => `- ${x.id}: ${x.reason}`).join("\n")}`] : []),
  ...(r.kept?.length ? [`Kept their card ${r.kept.length}:\n${r.kept.map((x) => `- ${x.id}: ${x.reason}`).join("\n")}`] : []),
].join("\n\n");

export const PROFILE = {
  type: "string",
  description: "Board (profile) slug. Omit to use the board whose folder contains the current working directory.",
};
export const ID = { type: "string", description: "Ticket id, e.g. t_20261001_abcd (from list_tickets)." };
export const STATUS = {
  type: "string",
  enum: STATUSES,
  description: "Column. backlog: idea, nothing runs. planning: Claude interviews the user in the board chat. " +
    "ready: Claude starts working right away. in_progress/review/done: usually set by the board.",
};
export const SCHEDULE_ID = { type: "string", description: "Schedule id (from list_schedules)." };
export const CRON = {
  type: "string",
  description: "5-field cron (minute hour day-of-month month day-of-week) in this computer's local time. " +
    "Examples: \"0 9 * * 1-5\" weekdays 09:00, \"0 3 * * *\" daily 03:00, \"0 9 * * 1\" Mondays 09:00, \"*/30 * * * *\" every 30 minutes, \"0 * * * *\" hourly.",
};
export const SCHEDULE_FIELDS = {
  name: { type: "string", description: "Short name shown in the Schedules list, e.g. \"Nightly dependency audit\"." },
  title: { type: "string", description: "Title of each ticket it creates. {date} and {time} are filled in, e.g. \"Dependency audit {date}\"." },
  body: {
    type: "string",
    description: "The prompt each ticket gets, in markdown. It runs unattended with no access to this conversation, " +
      "so make it self-contained: goal, context (files, commands), steps, what done looks like.",
  },
  cron: CRON,
  mode: {
    type: "string", enum: ["auto", "interview"],
    description: "auto: Claude just does it (right for unattended runs). interview: each ticket waits for the user's answers first. Default: auto.",
  },
  enabled: { type: "boolean", description: "false pauses the schedule (no runs, no catch-up when resumed). Default: true." },
  skipIfRunning: { type: "boolean", description: "Skip a run while the previous ticket from this schedule is still queued or running. Default: true." },
  tags: {
    type: "array", items: { type: "string" },
    description: "Tags every ticket it creates gets, e.g. [\"post\"], so the user can filter them on the board. Replaces the list; [] clears it.",
  },
  quiet: {
    type: "boolean",
    description: "Quiet when nothing needs the user: each run is told which tickets it raised are still open, and a run that finds nothing " +
      "ends with \"quiet\":true in its result line so the board removes its ticket and keeps one line in the history. " +
      "For check-ins (\"every hour, tell me what needs me\"). Default: false.",
  },
  partOf: {
    type: "string",
    description: "Put each run in a feature as a task instead of its own card: the feature's main ticket id (or one of its groups', from list_tickets). " +
      "Its runs show in that main ticket's Tasks tab and wake it only when they need the user, are blocked, failed or hit the usage limit. " +
      "A Done main ticket works too: each run moves it back to Review. If the feature is gone, runs get their own card again. \"\" clears it.",
  },
  model: {
    type: "string",
    description: "Model for its runs, e.g. \"sonnet\" (cheaper for frequent check-ins), \"opus\", \"haiku\" or a model id. \"\" goes back to the board's model.",
  },
};

export const DEPENDS_ON = {
  type: "array", items: { type: "string" },
  description: "Sibling tool tickets (ticket id or key) that must be done before this one starts. Replaces the list.",
};

export function depList(args: any): string[] | undefined {
  if (args?.dependsOn === undefined) return undefined;
  if (!Array.isArray(args.dependsOn)) throw new ClientError("dependsOn must be a list of ticket ids or keys");
  return args.dependsOn.filter((d: unknown) => typeof d === "string" && d.trim()).map((d: string) => d.trim());
}

export const NEEDS = {
  type: "array", items: { type: "string" },
  description:
    "Shared devices this ticket expects to use, e.g. [\"chrome-whatsapp\"] (specific names, not \"chrome\"). A hint only: it never holds the ticket back; " +
    "its run takes a device with take_devices just before using it, so tickets that share a device still run side by side and only take turns on it. " +
    "Don't chain dependsOn for a shared device. Replaces the list; [] clears it.",
};

export function needsList(args: any): string[] | undefined {
  if (args?.needs === undefined) return undefined;
  if (!Array.isArray(args.needs) || args.needs.some((n: unknown) => typeof n !== "string")) throw new ClientError("needs must be a list of device names, e.g. [\"chrome-whatsapp\"]");
  return args.needs.map((n: string) => n.trim().toLowerCase()).filter(Boolean);
}

export const TAGS = {
  type: "array", items: { type: "string" },
  description: "Tags (short lowercase labels, e.g. [\"post\"]) the user filters the board by. Set them only when the user asked for them " +
    "(e.g. \"tag it post\") or they come with a schedule or plan the user set up; otherwise suggest tags with suggest_tags. Replaces the list; [] clears it.",
};

export function tagsList(args: any, key = "tags"): string[] | undefined {
  if (args?.[key] === undefined) return undefined;
  if (!Array.isArray(args[key]) || args[key].some((n: unknown) => typeof n !== "string")) throw new ClientError(`${key} must be a list of tag names, e.g. ["post"]`);
  return normalizeTags(args[key]);
}

/** Why propose_huddle is refused in Backlog, and what to do instead (see REVIEW_HUDDLE_FORMAT in prompts.ts). */
export const BACKLOG_HUDDLE =
  "this ticket is in Backlog, so no huddle starts before its work: put it in the proposed ticket's description as a \"## Review huddle\" section " +
  "(Template: auto-review or another template, or a short roster; what it should check; Budget: ~$N). The ticket's run does the work first, then starts that huddle itself. " +
  `Only in Planning, and only when the user asks for one, can the chat propose a ${PLAN_REVIEW} huddle that reviews the plan.`;

/** take_devices / release_devices: names as a list of strings. */
export function deviceArg(args: any): string[] {
  if (!Array.isArray(args?.names) || args.names.some((n: unknown) => typeof n !== "string")) throw new ClientError("names must be a list of device names, e.g. [\"chrome-whatsapp\"]");
  return args.names;
}

/** The ticket a board run belongs to ("<profile>/<ticket id>" in CKANBAN_TICKET), or null outside runs. */
export function runTicketId(ctx: ToolContext): string | null {
  return ctx.env[RUN_ENV]?.split("/")[1] || null;
}

export const MODE = {
  type: "string",
  enum: ["interview", "auto"],
  description: "interview: Claude asks the user clarifying questions before working. auto: Claude just does it.",
};

/** What a board run may do to other tickets (see runRights in http.ts). */
export const IN_RUN = " Inside a board run: other tickets on this board, when your ticket's task calls for it (logged on that ticket); a ticket that keeps restarting the run that started it is refused, to stop loops. " +
  "Another board's tickets (pass its profile; list_profiles lists them): only from a chat reply to a message the user typed in that chat.";

export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** MCP tool hints; readOnlyHint marks tools that change nothing. */
  annotations?: { readOnlyHint?: boolean };
  /** Changes the board: refused inside board runs, unless allowInRun. */
  changes: boolean;
  /**
   * Allowed inside board runs too. The schedule and job tools are (the user chose to let Claude manage them on its own
   * judgment): every schedule edit or run now is credited to the run's ticket in the schedule's history, a job change
   * to the run's ticket on the job, and delete_schedule only shows a card the user confirms.
   */
  allowInRun?: boolean;
  /** Inside a board run the daemon decides: only a main ticket (or tool group) may use it, on its own family. */
  plannerScope?: boolean;
  run(args: any, ctx: ToolContext): Promise<string>;
}

export interface ToolContext {
  client: Pick<BoardClient,
    | "listProfiles" | "listTickets" | "ticketsByIds" | "getTicket" | "getFamily" | "createTicket" | "updateTicket" | "deleteTicket" | "chat" | "stop" | "listComments"
    | "comment" | "reportBug" | "setFollowUp" | "cancelFollowUp" | "notifyUser" | "takeDevices" | "releaseDevices" | "listSchedules" | "createSchedule" | "updateSchedule" | "deleteSchedule" | "runSchedule"
    | "scheduleHistory" | "cronPreview" | "listJobs" | "createJob" | "updateJob" | "jobAction" | "updateStatus" | "gather" | "planAction"
    | "askTicket" | "searchChat" | "readChat" | "mergeIntoMain" | "landMilestone" | "huddleRead" | "huddlePost" | "huddleMode" | "huddleAdd" | "huddleFindings"
    | "huddleStatus" | "huddleCloseRequest" | "startAutoHuddle" | "huddleHandIn" | "huddleReviewHandIn" | "huddleAllowChanges"
    | "listHuddlePresets" | "saveHuddlePreset" | "deleteHuddlePreset" | "listHuddleTemplates" | "huddleBrief" | "huddleProposeTeammate" | "huddleProposeSquad"
    | "listPasses" | "claudeServers" | "passTools" | "testAutomation" | "sendTelegramFile">;
  cwd: string;
  env: Record<string, string | undefined>;
  main?: (dir: string) => string | null;
  now?: () => number;
  /** The board's data folder (backup_file). Default: $CKANBAN_HOME or ~/.claude-kanban. */
  dataRoot?: string;
  /** Runs an artifact publish/read (tests pass a fake). Default: runArtifactJob. */
  artifact?: (job: ArtifactJob, timeoutMs: number) => Promise<ArtifactOutcome>;
}


export async function slugFor(args: any, ctx: ToolContext): Promise<string> {
  const explicit = typeof args?.profile === "string" && args.profile.trim() ? args.profile : runProfile(ctx.env);
  return resolveProfile(await ctx.client.listProfiles(), { explicit, cwd: ctx.cwd, main: ctx.main }).slug;
}

export function str(args: any, key: string, required = true): string | undefined {
  const v = args?.[key];
  if (typeof v === "string" && v.trim()) return v;
  if (required) throw new ClientError(`${key} is required`);
  return undefined;
}

export const pad = (n: number) => String(n).padStart(2, "0");

/** ISO time as local "2026-10-01 09:00" (schedules run in this computer's local time). */
/** notify_user's answer: where the message went, or why it went nowhere. */
export function messageResultText(r: MessageResult): string {
  if (r.helper) return "Passed to the helper: it tells the user (at once when it is urgent, else in its next summary). It is logged on the ticket.";
  if (r.reason === "off") return "Not sent: the user turned off \"Messages from Claude\" in the board's notification settings.";
  if (r.reason === "on-screen") return `Not sent: the user has the board open on screen right now (${r.onScreen === 1 ? "1 device" : `${r.onScreen} devices`}), so they can see the ticket.`;
  if (!r.delivered) return r.error ? `Not sent: ${r.error}.` : "Not sent: the user hasn't set up any notifications (no phone or browser, webhook or Mac banner).";
  const where = [
    ...(r.devices ? [r.devices === 1 ? "1 phone or browser" : `${r.devices} phones or browsers`] : []),
    ...(r.webhook ? ["the webhook"] : []),
    ...(r.banner ? ["the Mac banner"] : []),
  ];
  return `Sent to ${where.join(", ")}. It is logged on the ticket.${r.onScreen ? ` Skipped ${r.onScreen} where the board is on screen.` : ""}${r.error ? ` One channel failed: ${r.error}.` : ""}`;
}

export function localTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** delete_schedule in a quick chat: no card can show there, and the daemon refuses the delete. */
export const QUICK_CHAT_NO_DELETE = "Nothing was deleted: a quick chat can't show the user a delete card, and only the user deletes a schedule. " +
  "Ask them to delete it in the board's Schedules window, or pause it now with update_schedule enabled=false (resume it later with enabled=true).";

/** delete_schedule in a tool ticket: nobody sees its chat, so the request goes to its main ticket. */
export function toolNoScheduleDelete(s: { id: string; name: string }): string {
  return `Nothing was deleted and no card was shown: this is a tool ticket, and the user doesn't see its chat. ` +
    `Put the request in your result for your main ticket (schedule ${s.id} "${s.name}" and why it can go); ` +
    "your main ticket asks the user with delete_schedule in its own chat, where a card shows. If it only needs to stop for now, pause it with update_schedule enabled=false.";
}

/** propose_helper_rule where no card can show (a quick chat, the Telegram front desk, the user's own Claude). */
export const NO_HELPER_RULE_CARD = "Nothing was saved and no card was shown: only a board ticket's chat can show the user a card for this, " +
  "and only the user adds lines to the helper. Tell them how: open the Notifications window, find \"What the helper knows about you\" and add the line there " +
  "(give them the exact line to paste).";

/** propose_helper_rule in a tool ticket: nobody sees its chat, so the suggestion goes to its main ticket. */
export const TOOL_NO_HELPER_RULE = "Nothing was saved and no card was shown: this is a tool ticket, and the user doesn't see its chat. " +
  "Put the suggestion in your result for your main ticket (the exact line and why); your main ticket shows it to the user with propose_helper_rule in its own chat, " +
  "and only if the user asked for that alert rule there.";

/** What a card tool answers: moved here from the planning cards so every group can use it. */
export const SHOWN = "Shown to the user as a card. End your turn and wait for their reply.";
