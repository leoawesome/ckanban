// Boards and tickets: list, read, search chats, create, update, tag. Moved verbatim from mcp-server.ts.
import { ClientError, parseMode, parseStatus, profileList, RUN_ENV, familyLine, ticketLine, ticketListText, ticketText, type TicketListQuery, type TicketPatch } from "../cli/client";
import { gatherText, PROFILE, ID, STATUS, DEPENDS_ON, depList, NEEDS, needsList, TAGS, tagsList, runTicketId, MODE, IN_RUN, type Tool, slugFor, str } from "./shared";

export const TICKET_TOOLS: Tool[] = [
  {
    name: "list_profiles",
    description: "List the kanban boards (profiles) and the repo folder each one belongs to.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(_args, ctx) {
      const ps = await ctx.client.listProfiles();
      return profileList(ps);
    },
  },
  {
    name: "list_tickets",
    description: "List tickets on a board with id, column and title, newest first, a page at a time (100 unless limit says otherwise). " +
      "Without status it lists open work only (every column but Done) and says how many Done tickets it left out; status \"done\" pages through Done. " +
      "Call this before create_ticket to avoid duplicates: query finds tickets by words in the title, description or id in every column, Done included " +
      "(with status: in that column only; at most 100 matches, newest first). " +
      "A page that isn't the last ends with the after value for the next one. Open features are marked \"open feature\". " +
      "Tool tickets (the ones a main ticket made to do its work; they have no card) are left out unless includeTool is true.",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE, status: { ...STATUS, description: "Only this column (\"done\" for finished tickets). Leave out for open work." },
        query: { type: "string", description: "Words to look for in the title, description or id (one phrase, any case)." },
        limit: { type: "number", description: "Tickets per page: 100 if left out, at most 500 (100 with query)." },
        after: { type: "string", description: "The ticket id the previous page ended with (its \"More: ... after\" line): the next page." },
        includeTool: { type: "boolean", description: "true: also list tool tickets. get_family lists one feature's tool tickets." },
      },
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const q: TicketListQuery = {
        status: args?.status ? parseStatus(args.status) : null, tool: args?.includeTool === true,
        query: typeof args?.query === "string" ? args.query : null,
        limit: typeof args?.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : undefined,
        after: typeof args?.after === "string" && args.after.trim() ? args.after.trim() : null,
      };
      const page = await ctx.client.listTickets(slug, q);
      return ticketListText(slug, page, q, (after) => `call list_tickets again with the same arguments and after: "${after}"`, 'list_tickets with status "done" pages through them, or query finds one');
    },
  },
  {
    name: "get_ticket",
    description: "Show one ticket: description, column, run state, branch/PR and its last 50 comments (commentsBefore pages back to earlier ones).",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE, id: ID,
        commentsBefore: { type: "number", description: "Show the 50 comments before this position (the number the earlier-comments note gives) instead of the last 50." },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const id = str(args, "id")!;
      const before = typeof args?.commentsBefore === "number" && args.commentsBefore >= 0 ? Math.floor(args.commentsBefore) : null;
      const [t, page] = await Promise.all([ctx.client.getTicket(slug, id), ctx.client.listComments(slug, id, before)]);
      return ticketText(t, page.comments, { count: page.earlier, how: `call get_ticket with commentsBefore: ${page.earlier}` });
    },
  },
  {
    name: "get_family",
    description:
      "Show a ticket's whole family: the tickets of one piece of work (a project or flight), linked as part of or planned by each other. " +
      "Lists every ticket from the top one down with its column, how it is linked, its Claude session and its last result. " +
      "Use it to summarise or learn from all the work on something, instead of searching tickets by words.",
    inputSchema: { type: "object", properties: { profile: PROFILE, id: ID }, required: ["id"] },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const rows = await ctx.client.getFamily(slug, str(args, "id")!);
      if (rows.length <= 1) return `${rows[0]?.id ?? str(args, "id")} has no linked tickets yet: it is not part of a family.`;
      return [`Family of ${rows.length} tickets on board ${slug}, from the top ticket down:`, "", ...rows.map(familyLine)].join("\n");
    },
  },
  {
    name: "search_chat",
    description:
      "Search earlier messages of a ticket's chat, including chats from before \"Send in a fresh chat\" or an automatic fresh start, instead of " +
      "guessing or re-reading everything. Matches messages that have all the query's words (whole words, any case), newest first, at most 10, " +
      "each with its date, who wrote it, the lines around it and a ref for read_chat. Searches the user's messages and your replies; tool calls " +
      "and their output only with includeTools. By default your own ticket's chat; a main ticket may also search its tool tickets'. In a chat reply to a message the user typed, any ticket's chat, " +
      "also on another board (pass its profile and ticket).",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        query: { type: "string", description: "Words to look for, e.g. \"staging password\". Every word must appear." },
        ticket: { type: "string", description: "Ticket whose chat to search. Default: your own ticket." },
        includeTools: { type: "boolean", description: "Also search tool calls and their output. Default false." },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const ticket = str(args, "ticket", false) ?? null;
      if (!ticket && !runTicketId(ctx)) throw new ClientError("outside a board run, say which ticket's chat to search (ticket)");
      return (await ctx.client.searchChat(slug, { query: str(args, "query")!, ticket, includeTools: args?.includeTools === true }, ctx.env[RUN_ENV])).text;
    },
  },
  {
    name: "read_chat",
    description:
      "Load the messages of a ticket's chat around a ref from search_chat (\"<session id>:<number>\"): by default 10 before and 10 after, at most " +
      "40 messages or about 8,000 tokens, whichever comes first. For another board's ticket pass its profile (in a chat reply to a message the user typed).",
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        ref: { type: "string", description: "A ref from search_chat, e.g. 1f0c...:42." },
        before: { type: "number", description: "How many earlier messages to include. Default 10." },
        after: { type: "number", description: "How many later messages to include. Default 10." },
      },
      required: ["ref"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const n = (k: string) => (typeof args?.[k] === "number" ? args[k] : undefined);
      return (await ctx.client.readChat(slug, { ref: str(args, "ref")!, before: n("before"), after: n("after") }, ctx.env[RUN_ENV])).text;
    },
  },
  {
    name: "create_ticket",
    description:
      "Create a ticket on the board. Check list_tickets first so you don't add a duplicate. " +
      "Write a self-contained description in markdown (## Goal, ## Context with relevant files, ## Acceptance criteria), " +
      "because another Claude session will work on it later without this conversation. " +
      "Leave status and mode at their defaults (backlog, interview) unless the user explicitly asks to start work or skip the interview." + IN_RUN,
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE,
        title: { type: "string", description: "Short, specific title (under 80 characters)." },
        body: { type: "string", description: "Markdown description." },
        status: { ...STATUS, description: `${STATUS.description} Default: backlog.` },
        mode: { ...MODE, description: `${MODE.description} Default: interview.` },
        key: { type: "string", description: "Planner only: short name siblings can use in dependsOn." },
        dependsOn: DEPENDS_ON,
        needs: NEEDS,
        tags: TAGS,
        kind: {
          type: "string", enum: ["explore", "build", "test", "review", "fix", "group", "round", "with_you"],
          description: "What the ticket is for. test: it checks whether something works and ends with a verdict. group: holds other tickets of a feature. " +
            "round: a testing round of a feature; the board titles it \"Testing round N\" and puts it right under the feature. " +
            "with_you: a step that needs the user live (a phone test, an approval): unlike other tool tickets it talks to the user itself. Its messages " +
            "and ask_questions forms show in the main ticket's chat, where the user answers it directly, and it may call notify_user; its result still comes back to you.",
        },
        partOf: {
          type: "string",
          description: "Add the new ticket to an open feature: the feature's top ticket id or one of its groups (list_tickets marks open features). " +
            "Use it when the work belongs to that feature instead of starting a new top ticket. Inside a board run, any ticket of your own ticket's feature works " +
            "too (a testing round, a group, another step). A feature keeps tickets at most 2 levels deep: a ticket that would go deeper goes under the nearest " +
            "ticket above that leaves room, and a partOf the board can't use puts it under your own ticket; the reply says where it went.",
        },
        model: {
          type: "string",
          description: "Model for its runs: an alias (\"opus\", \"fable\", \"sonnet\", \"haiku\", always the newest version) or a full id. " +
            "Inside a main ticket, leave it out to use the kind's model from the board's Task models setting (your rules list it).",
        },
        effort: {
          type: "string", enum: ["low", "medium", "high", "xhigh", "max"],
          description: "Reasoning effort for its runs. Inside a main ticket, leave it out to use the kind's effort from the board's Task models setting.",
        },
        partOfThisTicket: {
          type: "boolean",
          description: "Inside a board run or ticket chat: true links the new ticket as part of your ticket (same piece of work: a next step, " +
            "a follow-up, a fix or a part of it), so both show in one family. Leave it out when the user asks for a ticket unrelated to your ticket's work.",
        },
        main: {
          type: "boolean",
          description: "true makes a new main ticket, like the user's own New ticket: it talks and decides, and tool tickets in its family do the work. " +
            "Only when the user asks, in a message they typed in this chat, for a new main ticket or a new feature they will follow as its own piece of work. " +
            "Top level, or a sub-feature: with partOf (or partOfThisTicket) it is part of another main ticket's feature and keeps its own card, chat and tasks " +
            "(its tasks report to it). A sub-feature can't hold another one. Other new work that belongs to an open feature still joins it with partOf and no main.",
        },
        gather: {
          type: "array",
          description: "With main: true, existing tickets (of the board it is created on) to move into the new main ticket, when the user asks for that. " +
            "They keep their cards, chats, work and pull requests. Same entries as gather_tickets.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              group: { type: "string", description: "\"new\" for the new group (newGroup), or omit for under the main ticket itself." },
            },
            required: ["id"],
          },
        },
        newGroup: { type: "string", description: "With gather: title of the new group, when an entry uses group \"new\"." },
      },
      required: ["title"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const deps = depList(args);
      const needs = needsList(args);
      const tags = tagsList(args);
      const main = args?.main === true;
      if (!main && Array.isArray(args?.gather) && args.gather.length) throw new ClientError("gather only works with main: true (use gather_tickets to add tickets to an existing feature)");
      const t = await ctx.client.createTicket(slug, {
        title: str(args, "title")!.trim(),
        body: typeof args?.body === "string" ? args.body : "",
        status: args?.status ? parseStatus(args.status) : "backlog",
        mode: args?.mode ? parseMode(args.mode) : "interview",
        ...(str(args, "key", false) ? { planKey: str(args, "key")!.trim() } : {}),
        ...(deps ? { dependsOn: deps } : {}),
        ...(needs?.length ? { needs } : {}),
        ...(tags?.length ? { tags } : {}),
        // Only the run's own board: a guest chat on another board has no ticket here to be part of.
        ...(args?.partOfThisTicket === true && runTicketId(ctx) && ctx.env[RUN_ENV]?.split("/")[0] === slug ? { partOf: runTicketId(ctx)! } : {}),
        ...(str(args, "partOf", false)?.trim() ? { partOf: str(args, "partOf")!.trim() } : {}),
        ...(str(args, "kind", false) ? { kind: str(args, "kind")!.trim() } : {}),
        ...(str(args, "model", false)?.trim() ? { model: str(args, "model")!.trim() } : {}),
        ...(str(args, "effort", false)?.trim() ? { effort: str(args, "effort")!.trim() } : {}),
        ...(main ? { main: true } : {}),
        ...(main && Array.isArray(args?.gather) && args.gather.length ? { gather: args.gather } : {}),
        ...(main && typeof args?.newGroup === "string" ? { newGroup: args.newGroup } : {}),
      }, ctx.env[RUN_ENV]);
      const how = [t.kind, t.model, t.effort ? `${t.effort} effort` : null].filter(Boolean).join(", ");
      // Where the board put it instead of the partOf asked for, or whose step it is (see the create handler in http.ts).
      const placed = (t as { note?: unknown }).note;
      const note = typeof placed === "string" && placed ? ` ${placed}` : "";
      if (note) {
        const where = t.tool ? `tool ticket ${t.id} under ${t.parentId}` : `${t.id} in ${t.status} (${t.mode} mode)${t.partOf ? `, part of ${t.partOf}` : ", at the top level"}`;
        return `Created ${where}${how ? ` (${how})` : ""}: ${t.title}.${note}`;
      }
      if (t.main) {
        return [`Created main ticket ${t.id} on board ${slug} in ${t.status} (${t.mode} mode): ${t.title}`, ...(t.gather ? [gatherText(t.gather)] : [])].join("\n\n");
      }
      if (t.tool && (t as { planPaused?: boolean }).planPaused) {
        return `Created tool ticket ${t.id}${how ? ` (${how})` : ""}: ${t.title}. It won't start yet: this feature's tasks are paused because the user pressed Stop. ` +
          "Tell the user it waits until they write in this chat or move this ticket to ready; don't say it is queued or started.";
      }
      if (t.tool) return `Created tool ticket ${t.id}${how ? ` (${how})` : ""}: ${t.title}. The board starts it when its dependsOn are done and wakes you with its result.`;
      return `Created ${t.id} on board ${slug} in ${t.status} (${t.mode} mode)${t.partOf ? `, part of ${t.partOf}` : ""}${how ? ` (${how})` : ""}: ${t.title}`;
    },
  },
  {
    name: "update_ticket",
    description:
      "Edit a ticket's title, description, column, mode, dependsOn, needs, tags or ⭐ important. Moving it to ready starts a Claude run, " +
      "moving it to planning starts the interview in the board chat (same as dragging it on the board). " +
      "A planner can take one of its children out of its plan with release: true. showOnBoard gives a task (tool ticket) its own card on the board, " +
      "or hides a card gathered into a feature (false), when the user asks for it." + IN_RUN,
    inputSchema: {
      type: "object",
      properties: {
        profile: PROFILE, id: ID, title: { type: "string" }, body: { type: "string", description: "New markdown description (replaces the old one)." },
        status: STATUS, mode: MODE, dependsOn: DEPENDS_ON, needs: NEEDS, tags: TAGS,
        important: {
          type: "boolean",
          description: "⭐ Important: unattended runs review the work in an auto huddle before landing it. Set it only when the user says the task is very important; " +
            "a ticket's own run (its chat included) may set it on that ticket.",
        },
        release: { type: "boolean", description: "true: take the ticket out of its plan (it keeps its column; its dependsOn and key are cleared)." },
        showOnBoard: {
          type: "boolean",
          description: "When the user asks. A task (tool ticket): true shows its card on the board, false hides it again; its questions still go to its main ticket's chat. " +
            "A card gathered into a feature (not a main ticket, sub-feature or group): false hides it from the board like a task, true shows it again; " +
            "it keeps its chat, results and run history, shows in the feature's Tasks tab, and its card comes back while it works or waits for the user. " +
            "To hide many gathered cards at once, use gather_tickets with hide: true.",
        },
      },
      required: ["id"],
    },
    changes: true,
    plannerScope: true,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const patch: TicketPatch = {};
      if (typeof args?.title === "string" && args.title.trim()) patch.title = args.title.trim();
      if (typeof args?.body === "string") patch.body = args.body;
      if (args?.status) patch.status = parseStatus(args.status);
      if (args?.mode) patch.mode = parseMode(args.mode);
      const deps = depList(args);
      if (deps) patch.dependsOn = deps;
      const needs = needsList(args);
      if (needs) patch.needs = needs;
      const tags = tagsList(args);
      if (tags) patch.tags = tags;
      if (args?.release === true) patch.parentId = null;
      if (typeof args?.important === "boolean") patch.important = args.important;
      if (typeof args?.showOnBoard === "boolean") patch.showOnBoard = args.showOnBoard;
      if (!Object.keys(patch).length) throw new ClientError("nothing to change: pass title, body, status, mode, dependsOn, needs, tags, important, release or showOnBoard");
      const t = await ctx.client.updateTicket(slug, str(args, "id")!, patch, ctx.env[RUN_ENV]);
      return `Updated ${t.id}: ${ticketLine(t)}`;
    },
  },
  {
    name: "suggest_tags",
    description:
      "Suggest tags for the ticket you are working on (your board run or its chat), e.g. [\"post\"] for a posting task. " +
      "The board shows them as suggestions on the ticket; the user keeps or drops each one, nothing is tagged until then. " +
      "Prefer tags the board already uses (list_tickets shows them as #tag). Suggest only when it helps the user find the ticket; don't repeat its tags.",
    inputSchema: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, description: "1-3 short tag names, e.g. [\"post\", \"xhs\"]." },
        profile: PROFILE,
        id: { ...ID, description: "Ticket id. Omit inside a board run to use your own ticket." },
      },
      required: ["tags"],
    },
    changes: true,
    allowInRun: true,
    async run(args, ctx) {
      const tags = tagsList(args);
      if (!tags?.length) throw new ClientError("tags must list at least one tag name, e.g. [\"post\"]");
      const own = runTicketId(ctx);
      const id = str(args, "id", false)?.trim() || own;
      if (!id) throw new ClientError("id is required outside a board run");
      const slug = await slugFor(args, ctx);
      const t = await ctx.client.getTicket(slug, id);
      const fresh = tags.filter((g) => !t.tags?.includes(g));
      if (!fresh.length) return `${t.id} already has ${tags.map((g) => `#${g}`).join(" ")}; nothing to suggest.`;
      const u = await ctx.client.updateTicket(slug, id, { suggestedTags: [...(t.suggestedTags ?? []), ...fresh] }, ctx.env[RUN_ENV]);
      return `Suggested ${fresh.map((g) => `#${g}`).join(" ")} on ${u.id}: the user keeps or drops them on the board.`;
    },
  },
];
