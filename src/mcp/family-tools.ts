// Tickets talking to tickets: chat, ask, merge into main, land, send files, stop, comment, delete, report a bug. Moved verbatim from mcp-server.ts.
import { bugReportText, ClientError, RUN_ENV } from "../cli/client";
import { REPO } from "../core/version";
import { PROFILE, ID, runTicketId, IN_RUN, type Tool, slugFor, str } from "./shared";

export const FAMILY_TOOLS: Tool[] = [
  {
    name: "chat_ticket",
    description:
      "Send a message to the Claude session working on a ticket (or start one), like typing in the board's ticket chat. " +
      "Answering a question form or applying a proposed ticket can only be done in the board UI." + IN_RUN +
      " The message is labelled as coming from your ticket.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID, message: { type: "string" } }, required: ["id", "message"] },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const t = await ctx.client.chat(slug, str(args, "id")!, str(args, "message")!, ctx.env[RUN_ENV]);
      return `Sent to ${t.id}. ${t.running ? "Claude is working on it" : `Ticket is in ${t.status}`}; read the reply later with get_ticket or on the board.`;
    },
  },
  {
    name: "ask_ticket",
    description:
      "Main tickets: ask one of your tool tickets a question about its work. Read its report first. A copy of its conversation answers in at most " +
      "5 sentences with read-only tools; the ticket itself is untouched and may keep working. The answer comes back to you as an event when you are " +
      "woken (\"no answer\" after 5 minutes), so end your run if you have nothing else to do.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID, question: { type: "string" } }, required: ["id", "question"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const me = runTicketId(ctx);
      if (!me) throw new ClientError("ask_ticket works inside a board run (the answer comes back to that run's ticket)");
      return (await ctx.client.askTicket(slug, me, str(args, "id")!, str(args, "question")!, ctx.env[RUN_ENV])).message;
    },
  },
  {
    name: "merge_into_main",
    description:
      "Tool tickets: once your work is committed and you merged the main ticket's branch into yours (and the checks pass), fast-forward the main " +
      "ticket's copy to your branch. One merge runs at a time per main ticket. If the main copy moved meanwhile it fails with \"merge again and retry\"; " +
      "after 3 failed tries end your run with status \"blocked\".",
    inputSchema: { type: "object", properties: { profile: PROFILE } },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const me = runTicketId(ctx);
      if (!me) throw new ClientError("merge_into_main works inside a tool ticket's board run");
      return (await ctx.client.mergeIntoMain(slug, me, ctx.env[RUN_ENV])).message;
    },
  },
  {
    name: "land_milestone",
    description:
      "Main tickets: land a milestone of the work in your copy (for example before a test round that needs it deployed). The board pushes your " +
      "copy and opens one pull request (or updates the open one), or merges it into the project folder when the repo has no remote, and records " +
      "it in the status. Plain folders only record it. If it can't land cleanly it refuses and says why: start a fix tool ticket then.",
    inputSchema: { type: "object", properties: { profile: PROFILE, summary: { type: "string", description: "One line: what this milestone is." } }, required: ["summary"] },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const me = runTicketId(ctx);
      if (!me) throw new ClientError("land_milestone works inside the main ticket's board run");
      return (await ctx.client.landMilestone(slug, me, str(args, "summary")!, ctx.env[RUN_ENV])).message;
    },
  },
  {
    name: "send_file",
    description:
      "Telegram front desk only: send a file to the user's Telegram chat (50 MB at most), when the result they want is a file and the phone " +
      "can't open the board. Only files inside a board's folder or a ticket's outputs; hidden files (.env and the like) are never sent.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file." },
        caption: { type: "string", description: "One short line shown with the file." },
      },
      required: ["path"],
    },
    changes: true,
    async run(args, ctx) {
      const r = await ctx.client.sendTelegramFile(str(args, "path")!, typeof args?.caption === "string" ? args.caption : "");
      return `Sent ${r.sent} (${Math.max(1, Math.round(r.bytes / 1024))} KB) to the user's Telegram.`;
    },
  },
  {
    name: "stop_ticket",
    description: "Stop the Claude run working on a ticket." + IN_RUN,
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID }, required: ["id"] },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      const r = await ctx.client.stop(slug, id, ctx.env[RUN_ENV]);
      return r.stopped ? `Stopped the run on ${id}.` : `${id} had no run to stop.`;
    },
  },
  {
    name: "comment_ticket",
    description: "Add a comment to a ticket. Claude reads new comments at the start of its next run." + IN_RUN +
      " From a run it is saved as a note from your ticket (\"Note from ticket …\"), never as the user's words.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID, text: { type: "string" } }, required: ["id", "text"] },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      await ctx.client.comment(slug, id, str(args, "text")!, ctx.env[RUN_ENV]);
      return `Commented on ${id}.`;
    },
  },
  {
    name: "delete_ticket",
    description: "Delete a ticket and its worktree. Only do this when the user asked for it.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID }, required: ["id"] },
    changes: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      await ctx.client.deleteTicket(slug, id);
      return `Deleted ${id}.`;
    },
  },
  {
    name: "report_bug",
    description:
      `File a bug in ckanban itself as a GitHub issue on ${REPO}. ` +
      "Only use it when the user asks to report a ckanban bug, never on your own initiative. " +
      "Before calling, show the user the title and description you will send and wait for a yes. " +
      "Write the description in markdown with: what happened, steps to reproduce (numbered), expected vs actual. " +
      "Pass ticketId to attach that ticket's details, last run result and log tail (home and data paths and secrets are hidden). " +
      "Screenshots can't be uploaded: tell the user to drag them into a comment on the issue. " +
      "Returns the issue URL, or a prefilled link to finish it in the browser when gh is missing or logged out.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short summary of the bug (under 80 characters)." },
        description: { type: "string", description: "Markdown: what happened, steps to reproduce, expected vs actual." },
        ticketId: { ...ID, description: "Ticket the bug showed up on (optional): its context is attached." },
        includeLogs: { type: "boolean", description: "Attach the tail of the ticket's last run log. Default: true." },
        profile: PROFILE,
      },
      required: ["title", "description"],
    },
    // Doesn't change the board, so it works from a board run's ticket chat too.
    changes: false,
    async run(args, ctx) {
      const ticketId = str(args, "ticketId", false);
      const slug = ticketId ? await slugFor(args, ctx) : undefined;
      const include: ("env" | "ticket" | "log")[] = ["env", "ticket"];
      if (args?.includeLogs !== false) include.push("log");
      const r = await ctx.client.reportBug({
        title: str(args, "title")!.trim(), description: str(args, "description")!, profile: slug, ticketId, include, source: "ai",
      });
      return bugReportText(r);
    },
  },
];
