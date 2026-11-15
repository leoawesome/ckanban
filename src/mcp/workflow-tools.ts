// Moving work along: follow-ups, notifications, devices, moves, feature status, gathering and plans. Moved verbatim from mcp-server.ts.
import { hiddenTool, withYouTool } from "../../web/src/features/family/family";
import { TOOL_NO_NOTIFY } from "../board/main-ticket";
import { HUDDLE_AGENT_ENV } from "../core/env";
import { ClientError, deviceTakeText, parseStatus, RUN_ENV, runProfile, ticketLine } from "../cli/client";
import { CLAUDE_MESSAGE_GAP_MS, CLAUDE_MESSAGE_MAX } from "../helper/notify";
import { gatherText, PROFILE, ID, STATUS, deviceArg, runTicketId, IN_RUN, type Tool, slugFor, str, messageResultText, localTime } from "./shared";
import { URGENT, WHY, urgencyError } from "./form-tools";

export const WORKFLOW_TOOLS: Tool[] = [
  {
    name: "follow_up",
    description:
      "Come back to the ticket you are working on later: at that time the board wakes this same conversation (your board run's or its chat's) " +
      "with your note and what happened since (user messages, whether the user opened the card, earlier follow-ups and their cost), so you can check and act. " +
      "Use it whenever the work ends waiting on someone or something outside: a reply to an email, a person, a deploy, a file, a review; or when the user asks you to check back. " +
      "Pick the time a person would (minutes for a deploy, hours for a colleague, a day or more for a customer). One follow-up per ticket: a new call replaces the pending one. " +
      "Never use Claude Code's own timers (ScheduleWakeup, CronCreate) for this: they stop when the run ends. The card shows \"Follows up <when>\" with your note.",
    inputSchema: {
      type: "object",
      properties: {
        after: { type: "string", description: "Delay from now: \"30m\", \"4h\", \"2d\", \"1d 6h\". Give after or at." },
        at: { type: "string", description: "Exact time in this computer's local time: \"2026-10-20 09:00\" (or ISO with a timezone). Give after or at." },
        note: { type: "string", description: "For your future self, shown on the card: why you come back and what to check or do then, e.g. \"Check Gmail for Michie's reply; if none by Thu, draft a short nudge for the user to approve.\"" },
        cancelOnReply: { type: "boolean", description: "A message the user types in this ticket's chat cancels it (default true). Set false when the user's messages don't change what you wait for." },        profile: PROFILE,
      },
      required: ["note"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const own = runTicketId(ctx);
      if (!own) throw new ClientError("follow_up works inside a board run or ticket chat, on its own ticket");
      const slug = await slugFor(args, ctx);
      const input: { after?: string; at?: string; note: string; cancelOnReply?: boolean } = { note: str(args, "note")! };
      const after = str(args, "after", false);
      const at = str(args, "at", false);
      if (after) input.after = after;
      if (at) input.at = at;
      if (typeof args?.cancelOnReply === "boolean") input.cancelOnReply = args.cancelOnReply;
      const t = await ctx.client.setFollowUp(slug, own, input, ctx.env[RUN_ENV]);
      const f = t.followUp!;
      return `Follow-up set: the board wakes this conversation at ${localTime(f.dueAt)} (local time).${f.cancelOnReply ? " It is cancelled if the user writes in this chat first." : ""}`;
    },
  },
  {
    name: "cancel_follow_up",
    description:
      "Stop following up on the ticket you are working on: cancels its pending follow-up, and the card shows \"Stopped following up: <reason>\". " +
      "Call it when there is nothing more to follow up on (it is finished, nobody is reading, or you have nudged enough).",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "One line the user reads on the card, e.g. \"2 nudges, no reply since Monday\"." }, profile: PROFILE },
      required: ["reason"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const own = runTicketId(ctx);
      if (!own) throw new ClientError("cancel_follow_up works inside a board run or ticket chat, on its own ticket");
      const slug = await slugFor(args, ctx);
      await ctx.client.cancelFollowUp(slug, own, str(args, "reason")!, ctx.env[RUN_ENV]);
      return "Stopped following up. The card says so with your reason.";
    },
  },
  {
    name: "notify_user",
    description:
      "Send the user a notification about the ticket you are working on, in your own words: their phone, browser, webhook or Mac banner shows the ticket title " +
      "and your message, and tapping it opens the ticket. Use it sparingly, when you are stuck waiting on the user and they haven't answered " +
      "(for example a follow-up finds no reply), with one short, specific ask: \"Pick A or B for the login page so I can continue.\" " +
      "Not for progress updates or finished work: the board already tells the user when a ticket starts waiting on them. " +
      `At most one message per ticket every ${CLAUDE_MESSAGE_GAP_MS / 60_000} minutes. The result says whether it reached the user.`,
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: `What you need from the user, one short sentence (max ${CLAUDE_MESSAGE_MAX} characters).` },
        urgent: URGENT,
        why: WHY,
        profile: PROFILE,
      },
      required: ["message"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const own = runTicketId(ctx);
      if (!own) throw new ClientError("notify_user works inside a board run or ticket chat, on its own ticket");
      const slug = await slugFor(args, ctx);
      const me = await Promise.resolve().then(() => ctx.client.getTicket(slug, own)).catch(() => null);
      if (hiddenTool(me) && !withYouTool(me)) throw new ClientError(TOOL_NO_NOTIFY);
      const u = urgencyError(args);
      if (u) throw new ClientError(u);
      const extra = { ...(args?.urgent === true ? { urgent: true } : {}), ...(typeof args?.why === "string" && args.why.trim() ? { why: args.why.trim() } : {}) };
      const r = Object.keys(extra).length
        ? await ctx.client.notifyUser(slug, own, str(args, "message")!, ctx.env[RUN_ENV], extra)
        : await ctx.client.notifyUser(slug, own, str(args, "message")!, ctx.env[RUN_ENV]);
      return messageResultText(r);
    },
  },
  {
    name: "take_devices",
    description:
      "Take shared devices (a WhatsApp Web tab, a phone, an emulator) just before you use them, so other tickets don't use them at the same time. " +
      "The device list in your instructions says what each one is and how many tickets may use it at once. Ask for everything you need together " +
      "in one call (e.g. [\"chrome-whatsapp\", \"leo-phone\"]): you get all of them or wait for all of them. Waits up to 4 minutes; if they are " +
      "still busy it says so and you keep your place in line: call again with the same names. A name not on the list is added as a device one " +
      "ticket at a time may use. Let go with release_devices as soon as you are done; the board also frees them when your run ends. " +
      "Things not on the list (plain Chrome, your own simulator) need no take.",
    inputSchema: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" }, description: "Device names from the list, e.g. [\"chrome-whatsapp\"]." },
        profile: PROFILE,
      },
      required: ["names"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const own = runTicketId(ctx);
      if (!own || ctx.env[HUDDLE_AGENT_ENV]) throw new ClientError("take_devices works inside a board run or ticket chat, for its own ticket (not from a huddle)");
      const slug = await slugFor(args, ctx);
      return deviceTakeText(await ctx.client.takeDevices(slug, own, deviceArg(args), ctx.env[RUN_ENV]));
    },
  },
  {
    name: "release_devices",
    description: "Let go of shared devices you took with take_devices, as soon as you are done with them, so the next ticket in line gets them. " +
      "Leave names out to let go of everything you hold (and stop waiting for any).",
    inputSchema: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" }, description: "Devices to let go of. Default: all of yours." },
        profile: PROFILE,
      },
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const own = runTicketId(ctx);
      if (!own || ctx.env[HUDDLE_AGENT_ENV]) throw new ClientError("release_devices works inside a board run or ticket chat, for its own ticket (not from a huddle)");
      const slug = await slugFor(args, ctx);
      const r = await ctx.client.releaseDevices(slug, own, args?.names === undefined ? null : deviceArg(args), ctx.env[RUN_ENV]);
      return r.released.length ? `Let go of ${r.released.join(", ")}.` : "You weren't holding any of those, so nothing changed.";
    },
  },
  {
    name: "move_ticket",
    description: "Move a ticket to another column. ready starts a Claude run; planning starts the interview in the board chat. " +
      "Your own ticket: only to done, backlog or ready, only when the user asked for it in a message they typed in this chat; it moves once your reply ends." + IN_RUN +
      " A ticket that is working or has unsaved changes can't be moved to done from a run.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID, status: STATUS }, required: ["id", "status"] },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const t = await ctx.client.updateTicket(slug, str(args, "id")!, { status: parseStatus(str(args, "status")) }, ctx.env[RUN_ENV]);
      if (t.selfMove) return `${t.id} moves to ${t.selfMove} once this reply ends. Tell the user.`;
      return `Moved ${t.id} to ${t.status}${t.running ? " (Claude is working on it)" : ""}.`;
    },
  },
  {
    name: "update_status",
    description:
      "Update a feature's status, shown at the top of its main ticket's Tasks tab (the family's top ticket; Waiting on you also shows as one line in its chat) and saved as status.md in its outputs. " +
      "Pass only the sections that changed; each call replaces just those (an empty string clears one) and returns the whole status. " +
      "The board adds counts, test results and pull request states itself. Any run of a ticket in the feature may call it; " +
      "on a ticket that has no status yet it starts one, which makes its family's top ticket a feature. A chat reply to a message the user typed may " +
      "also update another feature, on this board or another (pass its profile and id); the change is logged on the feature.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        id: { ...ID, description: "A ticket in the feature. Omit inside a board run to use your own ticket's feature." },
        goal: { type: "string", description: "What the feature is for, in one or two plain sentences." },
        done: { type: "string", description: "What is done, in words." },
        broken: { type: "string", description: "What is broken or failed, and why." },
        waitingOnYou: { type: "string", description: "What the user has to do or decide." },
        nextStep: { type: "string", description: "The one next step." },
        prNotes: {
          type: "object", additionalProperties: { type: "string" },
          description: "A short note per pull request URL, e.g. {\"https://github.com/o/r/pull/7\": \"on staging\"}.",
        },
        prs: {
          type: "array", items: { type: "string" },
          description: "Pull requests in other repos that belong to this feature, by URL: they join its list and the board tracks their state.",
        },
      },
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id", false)?.trim() || (slug === runProfile(ctx.env) ? runTicketId(ctx) : null);
      if (!id) throw new ClientError("id is required outside a board run and for another board's feature");
      const patch: Record<string, unknown> = {};
      for (const [from, to] of [["goal", "goal"], ["done", "done"], ["broken", "broken"], ["waitingOnYou", "waiting"], ["nextStep", "next"]] as const) {
        if (typeof args?.[from] === "string") patch[to] = args[from];
      }
      if (args?.prNotes && typeof args.prNotes === "object") patch.prNotes = args.prNotes;
      if (Array.isArray(args?.prs)) patch.prs = args.prs;
      if (!Object.keys(patch).length) throw new ClientError("nothing to update: pass goal, done, broken, waitingOnYou, nextStep, prNotes or prs");
      const r = await ctx.client.updateStatus(slug, id, patch, ctx.env[RUN_ENV]);
      return `Updated the status of "${r.title}" (${r.topId}). The whole status now:\n\n${r.markdown}`;
    },
  },
  {
    name: "gather_tickets",
    description:
      "Gather existing tickets into a feature (when the user asks, in a message they typed in this chat): each one links under one of the feature's groups, " +
      "a new group, or the feature itself. They keep their chats, work and pull requests, and running ones keep running. " +
      "A ticket's own tickets that would sit deeper than 2 levels move up beside it. A main ticket gathered in becomes a sub-feature: it keeps its own card, " +
      "chat and tasks (they report to it); a sub-feature can't hold another one, so a main ticket can't go into a sub-feature. Find tickets with list_tickets first. " +
      "Works on any feature, also on another board (pass its profile and the feature's id); outside the feature's own chat it is logged on the changed tickets. " +
      "hide: true also takes the gathered cards off the board, like the feature's tasks (e.g. a schedule's old run cards): they keep their chats, results and run history " +
      "and show in the feature's Tasks tab; main tickets, sub-features and groups keep their card. Tickets already in the feature can be passed again to hide them.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        id: { ...ID, description: "The feature's top ticket. Default: the ticket of this board run." },
        tickets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              group: { type: "string", description: "A group ticket id of the feature, \"new\" for the new group, or omit for under the feature itself." },
            },
            required: ["id"],
          },
        },
        newGroup: { type: "string", description: "Title of the new group, when a ticket uses group \"new\"." },
        hide: { type: "boolean", description: "true: also hide the gathered cards from the board (they stay in the feature's Tasks tab). Same as update_ticket showOnBoard: false on each." },
      },
      required: ["tickets"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id", false)?.trim() || (slug === runProfile(ctx.env) ? runTicketId(ctx) : null);
      if (!id) throw new ClientError("id is required outside a board run and for another board's feature");
      if (!Array.isArray(args?.tickets) || !args.tickets.length) throw new ClientError("tickets must list { id, group } entries");
      return gatherText(await ctx.client.gather(slug, id, args.tickets, typeof args?.newGroup === "string" ? args.newGroup : null, ctx.env[RUN_ENV], args?.hide === true));
    },
  },
  {
    name: "adopt_tickets",
    description:
      "Manager mode: make existing tickets on this board children of this ticket, so its plan runs them (use when the user asks you, in this " +
      "ticket's chat, to manage, run or take over tickets). Find them with list_tickets first. Tickets in another plan, finished ones, this " +
      "ticket and its parents are skipped with a reason. Adopted tickets keep their column, mode, dependsOn and needs; nothing starts until " +
      "the plan starts (plan_control). Then set dependsOn (ticket ids) and needs with update_ticket. Tell the user what was adopted and skipped. " +
      "Inside a board run it only works in a reply to the user's own message in this ticket's chat.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        ids: { type: "array", items: { type: "string" }, description: "Ticket ids to adopt, e.g. [\"t_20261001_abcd\"]." },
        id: { ...ID, description: "Adopting ticket. Default: the ticket of this board run." },
      },
      required: ["ids"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id", false) ?? runTicketId(ctx);
      if (!id) throw new ClientError("id is required outside a board run");
      if (!Array.isArray(args?.ids) || !args.ids.some((x: unknown) => typeof x === "string" && x.trim())) throw new ClientError("ids must be a non-empty list of ticket ids");
      const r = await ctx.client.adopt(slug, id, args.ids.filter((x: unknown) => typeof x === "string"), ctx.env[RUN_ENV]);
      const lines = [
        r.adopted.length ? `Adopted ${r.adopted.length}:\n${r.adopted.map((t) => `- ${ticketLine(t)}`).join("\n")}` : "Adopted none.",
        ...(r.skipped.length ? [`Skipped ${r.skipped.length}:\n${r.skipped.map((x) => `- ${x.id}: ${x.reason}`).join("\n")}`] : []),
        "Nothing starts until the plan starts: set dependsOn / needs with update_ticket, then call plan_control.",
      ];
      return lines.join("\n\n");
    },
  },
  {
    name: "plan_control",
    description:
      "Start or resume this ticket's plan, so the board runs its child tickets unattended: each child starts as soon as the ones it waits for are done, " +
      "shared devices (needs) taken in turns, never a child waiting on the user. Use it when the user asked you to run, manage or take over the " +
      "tickets. Pausing and finishing stay with the user (Plan tab). Inside a board run it works for the ticket's own plan " +
      "only: in a reply to the user's message in this ticket's chat, or while the plan runs.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        action: { type: "string", enum: ["start", "resume"], description: "start a new plan, or resume a paused or stuck one (both work either way)." },
        id: { ...ID, description: "Planner ticket. Default: the ticket of this board run." },
      },
      required: ["action"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id", false) ?? runTicketId(ctx);
      if (!id) throw new ClientError("id is required outside a board run");
      const action = args?.action === "resume" ? "resume" : args?.action === "start" ? "start" : null;
      if (!action) throw new ClientError("action must be start or resume");
      const t = await ctx.client.planAction(slug, id, action, ctx.env[RUN_ENV]);
      const p = t.plan;
      return `Plan of ${t.id} is ${p?.state ?? "not started"}. ` +
        "The board starts children itself and wakes this ticket when one needs a decision; end your reply now.";
    },
  },
];
