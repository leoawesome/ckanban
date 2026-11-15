// Huddles: several Claude sessions working on one ticket in a shared room. Moved verbatim from mcp-server.ts.
import { HUDDLE_AGENT_ENV } from "../core/env";
import { ClientError, huddleCaller, RUN_ENV, type HuddlePage } from "../cli/client";
import { BUILTIN_PRESETS, presetLine, presetName } from "../huddle/huddle-presets";
import { huddleLine, PROPOSED_MAX_COST_USD, proposedBudget, rosterEntryError, rosterError } from "../huddle/huddle-roster";
import { BUILTIN_TEMPLATES, PLAN_REVIEW, templateLine, TOPIC_MAX, topicInput } from "../huddle/huddle-templates";
import { AUTO_HUDDLE_TRIGGERS, USER_HUDDLE_TRIGGER } from "../core/types";
import { PROFILE, BACKLOG_HUDDLE, runTicketId, type Tool, type ToolContext, slugFor, str, SHOWN } from "./shared";
import { ROSTER_ENTRY, PRESET_FIELDS, PROPOSE_INSTEAD } from "./form-tools";

// ---- Huddles: several Claude sessions working on one ticket in a shared room (see src/huddle/huddle.ts) ----

export const HUDDLE = {
  type: "string",
  description: "Huddle id (h_...). Omit inside a board run to use your own huddle; required outside one.",
};

/** Inside a run: its own huddle unless one is named; outside: the named one, as the user. */
export function huddleId(args: any, ctx: ToolContext): string {
  const id = str(args, "huddle", false);
  if (id) return id.trim();
  if (!ctx.env[RUN_ENV]) throw new ClientError("huddle is required outside a board run");
  return "current";
}

/** since: reading on from a message, so only the new messages (the brief, roster and findings are left out). */
export function huddlePageText(p: HuddlePage, since?: number): string {
  const h = p.huddle;
  const head = `Huddle ${h.id} on ticket ${h.hostTicket}${h.hostTitle ? ` "${h.hostTitle}"` : ""}: ${h.status}. You are @${p.you}.`;
  if (since !== undefined) {
    const lines = [head, "", p.messages.length ? `Messages after #${since}:` : `No messages after #${since}.`, ...p.messages.map(huddleLine)];
    if (p.hasMore) lines.push("", `More messages: call huddle_read with since=${p.messages.at(-1)?.seq ?? 0}.`);
    return lines.join("\n");
  }
  const lines = [
    head,
    ...(h.brief?.text ? ["", `Pinned brief (by @${h.brief.by}):`, ...h.brief.text.split("\n").map((l) => `    ${l}`)] : []),
    "",
    `Participants (${h.participants.filter((x) => x.kind !== "human").length}/${h.maxParticipants}):`,
    ...h.participants.map((x) =>
      `- @${x.handle}: ${x.role}${h.host === x.handle ? ", host (runs the huddle)" : ""}${x.lead ? ", lead" : ""}, ${x.mode}, ${x.status}${x.statusReason ? ` (${x.statusReason})` : ""}${x.focus ? ` (focus: ${x.focus})` : ""}`),
  ];
  if (h.quiet) lines.push("", `The huddle is quiet${h.idleSince ? ` since ${h.idleSince}` : ""}: nobody is working, no tag is unanswered and no finding is open.`);
  if (h.closeRequest) lines.push("", `@${h.closeRequest.by} asked the user to close the huddle: ${h.closeRequest.reason}`);
  const waiting = (h.handIns ?? []).filter((x) => x.status === "waiting");
  if (waiting.length) {
    lines.push("", `Hand-ins waiting for a decision (huddle_review_changes):`,
      ...waiting.map((x) => `- ${x.id} from @${x.from}: ${x.summary} (${x.files.map((f) => `${f.change} ${f.path}`).join(", ")})`));
  }
  const open = h.findings.filter((f) => f.status === "open");
  if (h.findings.length) {
    lines.push("", `Findings (${open.length} open of ${h.findings.length}):`, ...h.findings.map((f) => `- ${f.id} [${f.status}${f.resolvedBy ? ` by @${f.resolvedBy}` : ""}] ${f.text} (by @${f.by})`));
  }
  lines.push("", p.messages.length ? "Messages:" : "No messages.");
  for (const m of p.messages) lines.push(huddleLine(m));
  if (p.hasMore) lines.push("", `More messages: call huddle_read with since=${p.messages.at(-1)?.seq ?? 0}.`);
  return lines.join("\n");
}

/** Lessons an agent may propose when it turns done: they go to the board's pile (learner.ts), saved once they come back. */
export const LESSONS = {
  type: "array",
  maxItems: 3,
  description:
    "Optional, with status done: up to 3 lessons that would help your role on a different task. Each text is a general rule (max 200 characters), " +
    "with no ids, names, message numbers or task-only paths (those go in evidence: a message #n or a file), and scope general (any repo) or repo (this repo only). " +
    "The board saves one for future agents only once it comes up again in another huddle. None is fine.",
  items: {
    type: "object",
    properties: {
      text: { type: "string", description: "The rule, e.g. \"Check UI changes in light and dark mode.\"" },
      evidence: { type: "string", description: "Why: a message #n or a file." },
      scope: { type: "string", enum: ["general", "repo"] },
    },
    required: ["text", "evidence", "scope"],
  },
};

export const HUDDLE_TOOLS: Tool[] = [
  {
    name: "huddle_post",
    description:
      "Post a message in your huddle. Tag who should act with @handle (@all for everyone; only leads, @main and the user can wake everyone): " +
      "tagged participants sleep until someone tags them, monitor-mode ones see every message. Every @handle in the text wakes that participant " +
      "(except inside code or quotes), so write a handle without @ when you only refer to someone. The board stamps you as the sender. " +
      "kind finding marks a bug or problem you found.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The message, with @mentions." },
        kind: { type: "string", enum: ["message", "finding"], description: "Default message." },
        status: { type: "string", enum: ["done", "blocked"], description: "Optional: with this message you are done or blocked (give reason). Same as huddle_status. done means your job is finished. Don't mark yourself done while you wait for others; just end your turn. Leads are woken by any tag." },
        reason: { type: "string", description: "status: why (required for blocked)." },
        lessons: LESSONS,
        huddle: HUDDLE, profile: PROFILE,
      },
      required: ["text"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const status = args?.status === "done" || args?.status === "blocked" ? { status: args.status, reason: str(args, "reason", false), ...(args?.lessons ? { lessons: args.lessons } : {}) } : undefined;
      const m = await ctx.client.huddlePost(slug, huddleId(args, ctx), str(args, "text")!, args?.kind === "finding" ? "finding" : "message", huddleCaller(ctx.env), status);
      return `Posted #${m.seq} as @${m.from}${m.mentions.length ? `; woke ${m.mentions.map((x) => `@${x}`).join(", ")}` : ""}.${status ? ` You are now ${status.status}.` : ""}`;
    },
  },
  {
    name: "huddle_status",
    description:
      "Set your own huddle status. done: your job is finished; you sleep until a lead, @main or the user tags you. Don't mark yourself done while you wait for others; just end your turn. Leads are woken by any tag. " +
      "blocked: you can't go on (give reason); @main is told (the user, when you are @main). active: back at work.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["done", "blocked", "active"] },
        reason: { type: "string", description: "What you finished, or what blocks you (required for blocked)." },
        lessons: LESSONS,
        huddle: HUDDLE, profile: PROFILE,
      },
      required: ["status"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const status = args?.status === "done" || args?.status === "blocked" || args?.status === "active" ? args.status : null;
      if (!status) throw new ClientError("status must be done, blocked or active");
      const slug = await slugFor(args, ctx);
      const lessons = Array.isArray(args?.lessons) ? args.lessons : undefined;
      const p = await ctx.client.huddleStatus(slug, huddleId(args, ctx), status, str(args, "reason", false), huddleCaller(ctx.env), lessons);
      const n = lessons?.length ?? 0;
      return `@${p.handle} is now ${p.status}${p.statusReason ? ` (${p.statusReason})` : ""}.${n ? ` ${n} lesson${n === 1 ? "" : "s"} noted; the board saves ${n === 1 ? "it" : "them"} once ${n === 1 ? "it comes" : "they come"} up again.` : ""}`;
    },
  },
  {
    name: "huddle_close",
    description:
      "@main and leads: ask the user to close the huddle once its work is done. First write the summary to outputs/huddles/<huddle id>/summary.md " +
      "in the host ticket's outputs folder (what was decided, the findings and their state, what is left). This tags the user; only the user closes the huddle. " +
      "Exception: @main of an auto huddle (start_huddle) closes it at once.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "One line: why the huddle can close." }, huddle: HUDDLE, profile: PROFILE },
      required: ["reason"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const h = await ctx.client.huddleCloseRequest(slug, huddleId(args, ctx), str(args, "reason")!, huddleCaller(ctx.env));
      if (h.status === "closed") return "Closed the auto huddle. Finish the run as usual (land the work if you haven't, then the result line).";
      return "Asked the user to close the huddle. Only they close it; until then the huddle stays open.";
    },
  },
  {
    name: "huddle_read",
    description: "Read your huddle: the pinned brief, the roster, the findings and recent messages. With `since`, only the messages after that #seq " +
      "(no roster or findings), in full: since=n-1 shows message #n that a digest cut short.",
    inputSchema: {
      type: "object",
      properties: { since: { type: "integer", description: "Only messages after this #seq." }, huddle: HUDDLE, profile: PROFILE },
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const since = Number.isInteger(args?.since) ? args.since : undefined;
      return huddlePageText(await ctx.client.huddleRead(slug, huddleId(args, ctx), { since, limit: 60 }, huddleCaller(ctx.env)), since);
    },
  },
  {
    name: "huddle_brief",
    description:
      "Leads, @main and the user: set the huddle's pinned brief, the goal and the decisions so far (max 2,000 characters). It heads every digest each " +
      "participant gets, so keep it short and current; empty text clears it. Replaces the whole brief: include what should stay.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The whole brief: goal, decisions, constraints. Empty clears it." }, huddle: HUDDLE, profile: PROFILE },
      required: ["text"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      if (typeof args?.text !== "string") throw new ClientError("text is required (empty text clears the brief)");
      const slug = await slugFor(args, ctx);
      const h = await ctx.client.huddleBrief(slug, huddleId(args, ctx), args.text, huddleCaller(ctx.env));
      return h.brief ? `Pinned brief updated (${h.brief.text.length} characters).` : "Pinned brief cleared.";
    },
  },
  {
    name: "huddle_mode",
    description: "Switch your own huddle mode. tagged: you sleep until someone @mentions you. monitor: every new message reaches you between your turns.",
    inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["tagged", "monitor"] }, huddle: HUDDLE, profile: PROFILE }, required: ["mode"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const mode = args?.mode === "monitor" ? "monitor" : args?.mode === "tagged" ? "tagged" : null;
      if (!mode) throw new ClientError("mode must be tagged or monitor");
      const slug = await slugFor(args, ctx);
      const hid = huddleId(args, ctx);
      const me = await ctx.client.huddleRead(slug, hid, { limit: 1 }, huddleCaller(ctx.env));
      if (me.you === "you") throw new ClientError("outside a board run you are the user; change a participant's mode on the board");
      await ctx.client.huddleMode(slug, me.huddle.id, me.you, mode, huddleCaller(ctx.env));
      return `@${me.you} is now in ${mode} mode.`;
    },
  },
  {
    name: "huddle_add_participant",
    description:
      "Add participants to your huddle (leads and @main only). Give a preset (list_huddle_presets) or a free-text role with a prompt, how many, and their focus. " +
      "The huddle has a participant limit; when it is full the call fails: then ask the user (tag @you) instead of working around it.",
    inputSchema: { type: "object", properties: { ...ROSTER_ENTRY.properties, huddle: HUDDLE, profile: PROFILE }, required: ["focus"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const { huddle: _h, profile: _p, ...entry } = args ?? {};
      const e = rosterEntryError(entry);
      if (e) throw new ClientError(`${e}. Fix it and call huddle_add_participant again.`);
      const slug = await slugFor(args, ctx);
      const r = await ctx.client.huddleAdd(slug, huddleId(args, ctx), entry, huddleCaller(ctx.env));
      return `Added ${r.added.map((p) => `@${p.handle} (${p.role}, ${p.mode})`).join(", ")}; they start now. ` +
        `${r.huddle.participants.filter((p) => p.kind !== "human").length}/${r.huddle.maxParticipants} participants.`;
    },
  },
  {
    name: "huddle_findings",
    description:
      "The huddle's pinned findings list. list: everyone. add (text) and resolve (id): leads and @main only; " +
      "others post their findings to their lead with huddle_post.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "resolve", "list"] },
        text: { type: "string", description: "add: the finding, with file:line or steps to reproduce." },
        id: { type: "string", description: "resolve: finding id, e.g. f2." },
        huddle: HUDDLE, profile: PROFILE,
      },
      required: ["action"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const action = args?.action === "add" || args?.action === "resolve" || args?.action === "list" ? args.action : null;
      if (!action) throw new ClientError("action must be add, resolve or list");
      const slug = await slugFor(args, ctx);
      const fs = await ctx.client.huddleFindings(slug, huddleId(args, ctx), action, { text: str(args, "text", false), id: str(args, "id", false) }, huddleCaller(ctx.env));
      if (!fs.length) return "No findings yet.";
      return fs.map((f) => `- ${f.id} [${f.status}${f.resolvedBy ? ` by @${f.resolvedBy}` : ""}] ${f.text} (by @${f.by})`).join("\n");
    },
  },
  {
    name: "huddle_hand_in",
    description:
      "Helpers that can change files: hand in what you changed in your own copy of the folder, with a one-line summary. The board finds the changed, " +
      "added and removed files itself, saves them as they are now and posts them as a card; @main or a lead accepts them into the ticket's folder or rejects them. " +
      "One hand-in waits at a time; end your turn after it. If the ticket's folder changed the same files meanwhile, nothing is applied and you get a fresh copy to redo it.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", description: "One line: what you changed and why." }, huddle: HUDDLE, profile: PROFILE },
      required: ["summary"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const x = await ctx.client.huddleHandIn(slug, huddleId(args, ctx), str(args, "summary")!, huddleCaller(ctx.env));
      return `Handed in ${x.id} (${x.files.length} file${x.files.length === 1 ? "" : "s"}: ${x.files.map((f) => `${f.change} ${f.path}`).join(", ")}). @main is tagged to accept or reject it; end your turn.`;
    },
  },
  {
    name: "huddle_review_changes",
    description:
      "Leads and @main: accept or reject changes a helper handed in (huddle_hand_in; the ids are on the cards, e.g. c1, and in huddle_read). " +
      "accept: the files go into the ticket's folder (yours, @main: check them and commit them with your work); nothing in the folder is overwritten that changed since the helper's copy was made: " +
      "then it is a conflict, nothing is applied and the helper redoes it on a fresh copy. reject: give the reason; the helper is told.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Hand-in id, e.g. c1." },
        accept: { type: "boolean", description: "true: bring the changes in. false: reject them." },
        reason: { type: "string", description: "Why (required to reject): what the helper should change." },
        huddle: HUDDLE, profile: PROFILE,
      },
      required: ["id", "accept"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      if (typeof args?.accept !== "boolean") throw new ClientError("accept must be true or false");
      const reason = str(args, "reason", false) ?? "";
      if (!args.accept && !reason.trim()) throw new ClientError("say why you reject it (reason), so the helper knows what to change");
      const slug = await slugFor(args, ctx);
      const x = await ctx.client.huddleReviewHandIn(slug, huddleId(args, ctx), str(args, "id")!, args.accept, reason, huddleCaller(ctx.env));
      if (x.status === "accepted") return `Accepted ${x.id}: ${x.files.length} file${x.files.length === 1 ? "" : "s"} now in the ticket's folder (${x.files.map((f) => `${f.change} ${f.path}`).join(", ")}).`;
      if (x.status === "conflict") return `Conflict on ${x.id}: the ticket's folder also changed ${(x.conflicts ?? []).join(", ")}. Nothing was applied; @${x.from} redoes it on a fresh copy and hands it in again.`;
      return `Rejected ${x.id}; @${x.from} was told why.`;
    },
  },
  {
    name: "huddle_allow_changes",
    description:
      "Leads and @main: let a read-only helper change files, e.g. a researcher who found something to fix. From its next turn it works in its own copy of the folder " +
      "and hands its changes in with huddle_hand_in. Keep reviewers read-only unless their review is done: their review should stay independent.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: "The helper's handle, without @." }, huddle: HUDDLE, profile: PROFILE },
      required: ["handle"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const p = await ctx.client.huddleAllowChanges(slug, huddleId(args, ctx), str(args, "handle")!.replace(/^@/, ""), huddleCaller(ctx.env));
      return `@${p.handle} can change files now; it was tagged and works in its own copy of the folder from its next turn.`;
    },
  },
  {
    name: "propose_huddle",
    description:
      "Board ticket chat (the ticket's own session, as coordinator): propose a huddle, a room where helper Claude sessions (reviewer, QA testers, a QA lead...) " +
      "work on this ticket with you and talk to each other; you join as @main. The board shows the roster as a card; nothing starts until the user presses Start. " +
      "For each entry choose: read-only (workspace shared) for review and QA, or canEdit true for helpers that make things (build a part, design, fix): each works in its own copy of the folder and hands its changes in for you to accept. " +
      "A lead (e.g. qa-lead) gathers findings so you are woken with one consolidated list. Keep it small (limit 8 including you). Nothing starts by the call. " +
      `When the user's own chat message asks you to start a huddle now (not in Planning or Backlog), start it with start_huddle trigger ${USER_HUDDLE_TRIGGER} instead; propose one when they haven't asked to start it, or start_huddle was refused. ` +
      `Or give a squad (a saved huddle: a roster with its rules: host rules, rounds, budget, report format; built-in: ${BUILTIN_TEMPLATES.map((t) => t.name).join(", ")}; list_huddle_presets lists the board's) ` +
      "and leave out roster to use the squad's, with a topic: what this run of the squad works on (squads are generic; the topic makes them about this ticket's question). " +
      "When the user names a budget (e.g. \"budget 80 usd\"), pass it as maxCostUsd so the card starts with it. " +
      "Refused while the ticket is in Backlog: there, write the huddle into the proposed ticket as a \"## Review huddle\" section instead, so the ticket's run does the work first and starts the huddle after it. " +
      `In Planning, propose one only when the user's own message asks for it: a plan review (template ${PLAN_REVIEW}), read-only, whose findings come back to the chat.`,
    inputSchema: {
      type: "object",
      properties: {
        roster: { type: "array", minItems: 1, items: ROSTER_ENTRY, description: "The participants. Optional with a squad (its roster is used)." },
        squad: { type: "string", description: "Squad name, e.g. design-review: its roster (unless you give one), budget and rules. (Older name: template, still accepted.)" },
        template: { type: "string", description: "Older name for squad." },
        topic: { type: "string", description: `With a squad: what this huddle works on, in a few sentences (the question, the plan or the change to look at; max ${TOPIC_MAX} characters). The host's first post is about it. Default: the ticket's title and description.` },
        reason: { type: "string", description: "One line: what the huddle is for." },
        maxCostUsd: { type: "number", description: `Optional budget in USD when the user names one (capped at $${PROPOSED_MAX_COST_USD}). Default: the template's budget, else the board's. The user can change it on the card.` },
      },
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      // The board's presets, when the daemon is reachable; otherwise only the shape is checked here and the daemon checks names at Start.
      const slug = await slugFor(args, ctx).catch(() => null);
      // In Backlog the work hasn't started: a huddle started now would run alongside the ticket's own run once it starts.
      // Planning may review the plan (read-only, see Huddles.create) when the user asks.
      const own = runTicketId(ctx);
      const host = slug && own ? await ctx.client.getTicket(slug, own).catch(() => null) : null;
      if (host?.status === "backlog") throw new ClientError(BACKLOG_HUDDLE);
      if (proposedBudget(args?.maxCostUsd) === null) throw new ClientError("maxCostUsd must be a positive amount in USD. Fix it and call propose_huddle again.");
      const names = slug ? await ctx.client.listHuddlePresets(slug).then((ps) => ps.map((p) => p.name), () => undefined) : undefined;
      const given = args?.squad ?? args?.template;
      const template = typeof given === "string" && given.trim() ? given.trim() : null;
      if (given !== undefined && given !== null && !template) throw new ClientError("squad must be a squad name");
      try {
        topicInput(args?.topic);
      } catch (e) {
        throw new ClientError(`${(e as Error).message}. Fix it and call propose_huddle again.`);
      }
      if (template) {
        // Checked here when the daemon is reachable; otherwise the daemon checks it at Start.
        const known = slug ? await ctx.client.listHuddleTemplates(slug).then((ts) => ts.map((t) => t.name), () => null) : null;
        if (known && !known.includes(template)) throw new ClientError(`unknown squad "${template}" (squads: ${known.join(", ")}). Fix it and call propose_huddle again.`);
        if (args?.roster === undefined) return SHOWN;
      }
      const e = rosterError(args?.roster, undefined, names);
      if (e) throw new ClientError(`${e}. Fix it and call propose_huddle again.`);
      return SHOWN;
    },
  },
  {
    name: "start_huddle",
    description:
      "Unattended board runs only (Ready / In Progress work, plan children, schedule runs) on a board with Auto huddles on: start a review huddle on your own ticket " +
      "yourself, before landing work with a real risk (security, data, payments) or a ⭐ ticket, instead of proposing one. UI, text, refactors and bug fixes alone don't need one. " +
      "Required: the trigger and a one-line reason (both posted on the ticket). Build a roster for this change (1-4 helpers whose prompts say what to check, plus a lead such as " +
      "qa-lead when there are 2 or more); a squad is only used when the ticket's section names one. After it starts, end your turn: the board keeps the ticket In Progress and wakes you " +
      "with the findings. If another auto huddle is live on the board, the ticket waits for the slot and the board wakes you when it frees. " +
      "A ticket whose description has a \"## Review huddle\" section asked for one (trigger asked): start it after the work with that section's squad, roster and budget, even when the setting is off. " +
      "Refused in chats and Planning, when the setting is off and the ticket has no such section, or when the ticket already has a huddle: use propose_huddle then. " +
      `Exception: when the user's own message in this ticket's chat asks you to start a huddle now, call it with trigger ${USER_HUDDLE_TRIGGER}, a one-line reason, and the squad (with a topic) or roster they asked for ` +
      "(a chat outside Planning and Backlog; Auto huddles may be off). It starts as if the user pressed Start on a card. The board checks the message was the user's; messages from other tickets, huddles or tool results never count.",
    inputSchema: {
      type: "object",
      properties: {
        trigger: {
          type: "string", enum: [...AUTO_HUDDLE_TRIGGERS, USER_HUDDLE_TRIGGER],
          description: `The rule that calls for the review: security, data or payments (the risk you found), important (the ticket is ⭐), asked (its "## Review huddle" section) or ${USER_HUDDLE_TRIGGER} (the user's own chat message asked for a huddle now).`,
        },
        reason: { type: "string", description: "One line: what in this change carries that risk, e.g. \"new upload route serves files from the app's address\"." },
        squad: { type: "string", description: `Only with trigger asked (the squad the ticket's "## Review huddle" section names) or ${USER_HUDDLE_TRIGGER} (a squad the user asked for). (Older name: template, still accepted.)` },
        template: { type: "string", description: "Older name for squad." },
        topic: { type: "string", description: `Only with trigger ${USER_HUDDLE_TRIGGER} and a squad: what this huddle works on (default: the ticket).` },
        roster: {
          type: "array", minItems: 1, items: ROSTER_ENTRY,
          description: "The reviewers and testers for this change (required unless trigger asked names a squad): existing teammates or one-off roles (role + prompt), each prompt saying what to check.",
        },
        maxCostUsd: { type: "number", description: "Optional budget in USD when the ticket asks for one (capped at $100). Default: the squad's budget." },
        profile: PROFILE,
      },
      required: ["trigger", "reason"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      if (!ctx.env[RUN_ENV]) throw new ClientError("start_huddle only works inside an unattended board run; propose a huddle with propose_huddle instead (with the same maxCostUsd)");
      const reason = str(args, "reason")!;
      const given = args?.squad ?? args?.template;
      const template = typeof given === "string" && given.trim() ? given.trim() : undefined;
      if (args?.roster !== undefined) {
        const e = rosterError(args.roster, undefined, undefined);
        if (e) throw new ClientError(`${e}. Fix it and call start_huddle again.`);
      }
      let topic: string | undefined;
      try {
        topic = topicInput(args?.topic) ?? undefined;
      } catch (e) {
        throw new ClientError(`${(e as Error).message}. Fix it and call start_huddle again.`);
      }
      const maxCostUsd = args?.maxCostUsd === undefined || args?.maxCostUsd === null ? undefined : Number(args.maxCostUsd);
      const slug = await slugFor(args, ctx);
      const trigger = typeof args?.trigger === "string" ? args.trigger : undefined;
      const r = await ctx.client.startAutoHuddle(slug, { reason, trigger, template, roster: args?.roster, maxCostUsd, ...(topic ? { topic } : {}) }, huddleCaller(ctx.env));
      if (r.waiting) {
        return "Another auto huddle is running on this board, so this ticket waits for the huddle slot. End your turn now with a short note (no landing); " +
          "the board keeps the ticket In Progress and wakes you when the slot frees.";
      }
      const h = r.huddle!;
      if (trigger === USER_HUDDLE_TRIGGER) {
        return `Huddle ${h.id} started as the user asked (${r.template}${h.maxCostUsd !== undefined ? `, budget $${h.maxCostUsd.toFixed(2)}` : ""}) with ${h.participants.filter((p) => p.kind === "agent").map((p) => `@${p.handle}`).join(", ")}; you are @main. ` +
          (h.host ? `@${h.host} hosts it: it hands out the tasks and sends you the final report. If it needs something only you know, brief it now in one huddle_post that tags @${h.host}. ` : "") +
          "Tell the user in one or two sentences that it started, who is in it and its budget; they follow it in the ticket's Huddle tab. The board wakes you in this chat with huddle messages.";
      }
      return `Auto huddle ${h.id} started (${r.template}${h.maxCostUsd !== undefined ? `, budget $${h.maxCostUsd.toFixed(2)}` : ""}) with ${h.participants.filter((p) => p.kind === "agent").map((p) => `@${p.handle}`).join(", ")}; you are @main. ` +
        (h.host ? `@${h.host} hosts it: it hands out the tasks and sends you the final report. If it needs something only you know, brief it now in one huddle_post that tags @${h.host}. ` : "") +
        "Don't land yet: end your turn now with a short note. The board keeps the ticket In Progress and wakes you with the consolidated findings.";
    },
  },
  {
    name: "list_huddle_presets",
    description: "List the board's teammates (huddle role presets: built-ins, the user's for all boards and the board's own) with their prompt, default model, mode, lead, canEdit and workspace, and the squads (saved huddles: a roster with its rules). " +
      "Use the preset names in propose_huddle and huddle_add_participant, the squad names in propose_huddle (squad, with a topic).",
    inputSchema: { type: "object", properties: { profile: PROFILE } },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const [ps, ts] = await Promise.all([ctx.client.listHuddlePresets(slug), ctx.client.listHuddleTemplates(slug).catch(() => [])]);
      return `Teammates (huddle presets) on board ${slug}:\n${ps.map(presetLine).join("\n")}` +
        (ts.length ? `\n\nSquads (saved huddles: a roster with its rules; use with propose_huddle squad and a topic):\n${ts.map(templateLine).join("\n")}` : "");
    },
  },
  {
    name: "save_huddle_preset",
    description:
      `Create or change a teammate (huddle role preset) for the user, outside board runs. Saving a built-in's name (${BUILTIN_PRESETS.map((p) => p.name).join(", ")}) ` +
      "overrides it; delete_huddle_preset resets it. scope board (default) saves it for this board only, global for every board. Fields you leave out keep the existing teammate's values. " +
      "Inside a board or huddle run it saves nothing: use propose_teammate, and the user saves it with one click.",
    inputSchema: {
      type: "object",
      properties: {
        ...PRESET_FIELDS,
        scope: { type: "string", enum: ["board", "global"], description: "board: this board only (default). global: every board." },
        profile: PROFILE,
      },
      required: ["name", "prompt"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      // Only the user saves teammates; a run proposes one (the daemon refuses runs too).
      if (ctx.env[RUN_ENV] || ctx.env[HUDDLE_AGENT_ENV]) return PROPOSE_INSTEAD;
      const { profile: _p, ...input } = args ?? {};
      const slug = await slugFor(args, ctx);
      const p = await ctx.client.saveHuddlePreset(slug, input, huddleCaller(ctx.env));
      const where = p.source === "global" ? "for all boards" : `on board ${slug}`;
      return `Saved preset "${p.name}" ${where}${p.base ? ` (overrides the ${p.base === "builtin" ? "built-in" : "all-boards version"})` : ""}:\n${presetLine(p)}`;
    },
  },
  {
    name: "delete_huddle_preset",
    description: "Delete a teammate (huddle role preset), or reset a changed one to the version below it (all boards, then built-in). Built-ins themselves can't be deleted. Not from a board or huddle run (ask the user).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Preset name." },
        scope: { type: "string", enum: ["board", "global"], description: "The level to delete at. Default: the version in effect on this board." },
        profile: PROFILE,
      },
      required: ["name"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const name = str(args, "name")!.trim();
      const scope = args?.scope === "global" || args?.scope === "board" ? args.scope : undefined;
      const r = await ctx.client.deleteHuddlePreset(slug, name, huddleCaller(ctx.env), scope);
      const now = r.presets.find((p) => p.name === presetName(name));
      return r.reset && now ? `Reset "${name}": board ${slug} now uses the ${now.source === "builtin" ? "built-in" : "all-boards"} version.` : `Deleted preset "${name}".`;
    },
  },
];
