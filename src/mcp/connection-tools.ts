// Automation setup: list_connections, connection_tools, test_automation_script, propose_automation. Moved verbatim from mcp-server.ts.
import { ClientError } from "../cli/client";
import { automationProposal } from "../schedules/automation-proposal";
import { PROFILE, type Tool, slugFor, SHOWN } from "./shared";

export const CONNECTION_TOOLS: Tool[] = [
  {
    name: "list_connections",
    description:
      "Automation setup: the services this board's automations can check by themselves (the board's own passes: signed in, a key, or a program on this computer), " +
      "and Claude Code's servers from Connections that could be connected for automations. claude.ai connectors can't be used by automations. " +
      "Use the names in test_automation_script and propose_automation, and in the script's `ckanban call <name> <tool> '<json>'`.",
    inputSchema: { type: "object", properties: { profile: PROFILE } },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(_args, ctx) {
      const [{ passes: all }, claude, slug] = await Promise.all([ctx.client.listPasses(), ctx.client.claudeServers().catch(() => ({ servers: [] })), slugFor(_args ?? {}, ctx).catch(() => null)]);
      // Keys saved for another board aren't this board's to use.
      const passes = all.filter((p) => !p.board || p.board === slug);
      const linked = new Set(passes.map((p) => p.claudeName).filter(Boolean));
      const own = passes.map((p) => `- ${p.name} (${p.kind === "local" ? "program on this computer" : p.kind === "mcp" ? "signed in" : p.url ? "key for an MCP server" : `key, scripts read it from $${p.envName}`}): ${p.status}${p.error ? ` (${p.error})` : ""}${p.claudeName ? `, from Connections server "${p.claudeName}"` : ""}`);
      const can = claude.servers.filter((s) => !linked.has(s.name) && s.scope !== "claude.ai" && (s.scope === "user" || s.scope === "local"))
        .map((s) => `- ${s.name}: ${s.transport === "stdio" ? "program on this computer, connects in one click" : "online server, the user signs in once (or pastes a key if it can't)"}`);
      const claudeOnly = claude.servers.filter((s: any) => s.scope === "claude.ai").map((s: any) => `${s.name}${s.target ? ` (${s.target})` : ""}`);
      return `Connected for automations:\n${own.join("\n") || "(none yet)"}\n\nIn Connections, can be connected for automations (propose them in passes with from: "<name>"):\n${can.join("\n") || "(none)"}` +
        (claudeOnly.length ? `\n\nclaude.ai connectors (automations can't use Claude's sign-in; for an online server the board can sign in by itself: propose {name, url} with its address): ${claudeOnly.join(", ")}` : "") +
        "\n\nA service with none of these: a key the user pastes (passes entry with envName; the script reads $ENV_NAME). A key saved for this board with ask_keys can be listed by its name the same way.";
    },
  },
  {
    name: "connection_tools",
    description: "Automation setup: the tools a connected service offers (name and description), to write a check script that calls them with `ckanban call`.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Connection name from list_connections." }, profile: PROFILE }, required: ["name"] },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const { passes } = await ctx.client.listPasses();
      const ref = String(args?.name ?? "").trim().toLowerCase();
      const p = passes.find((x) => x.name.toLowerCase() === ref || x.claudeName?.toLowerCase() === ref);
      if (!p) throw new ClientError(`"${args?.name}" isn't connected for automations yet: check list_connections, and ask the user to connect it (or propose it with from in propose_automation).`);
      const tools = await ctx.client.passTools(p.id);
      return tools.map((t) => `- ${t.name}${t.description ? `: ${t.description.replace(/\s+/g, " ")}` : ""}`).join("\n") || "(no tools)";
    },
  },
  {
    name: "test_automation_script",
    description:
      "Automation setup: run a check script once, the way the board will (bash, 60 s limit, no Claude), and see what it found. Nothing is saved and no tickets are made. " +
      "The script prints JSON items, one per line or one list: {\"id\": \"stable id\", \"title\": \"...\", \"text\": \"optional details\", \"link\": \"optional https link\", \"thread\": \"optional\"}. " +
      "When several items can be about the same thing (comments or notifications on one issue, messages in one conversation), set thread to that thing's id and print the oldest first: the first item of a thread makes a ticket, later ones go into that ticket. " +
      "It reaches connected services with `ckanban call <name> <tool> '<json args>'` (prints the tool's answer as JSON; use jq or bun to shape it); " +
      "a pasted key comes as its environment variable. It never gets sign-in tokens. Return the current open items each time: the board remembers ids and only new ones become tickets.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "The whole bash script." },
        passes: { type: "array", items: { type: "string" }, description: "Connection names it uses (from list_connections)." },
        profile: PROFILE,
      },
      required: ["script"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const slug = await slugFor(args, ctx);
      const r = await ctx.client.testAutomation(slug, String(args?.script ?? ""), Array.isArray(args?.passes) ? args.passes.map(String) : []);
      const lines = r.items.map((i) => `- [${i.id}] ${i.title}${i.link ? ` (${i.link})` : ""}${i.thread ? ` thread: ${i.thread}` : ""}`);
      const threads = new Set(r.items.map((i) => i.thread).filter(Boolean));
      return `${r.error ? `Failed: ${r.error}` : `Found ${r.found} item${r.found === 1 ? "" : "s"} in ${(r.durationMs / 1000).toFixed(1)} s.`}` +
        (lines.length ? `\n${lines.join("\n")}${r.found > lines.length ? `\n… and ${r.found - lines.length} more` : ""}` : "") +
        (r.items.length && !threads.size ? "\nNo item has a thread: each one becomes its own ticket. If several can be about the same thing, add thread." : "") +
        (threads.size ? `\n${threads.size} thread${threads.size === 1 ? "" : "s"}: items with the same thread go into one ticket.` : "") +
        (r.toolsUsed.length ? `\nTools it called: ${r.toolsUsed.join(", ")}` : "") +
        (r.stderr.trim() ? `\nstderr (end):\n${r.stderr.trim().split("\n").slice(-15).join("\n")}` : "");
    },
  },
  {
    name: "propose_automation",
    description:
      "Automation setup chat: propose the automation you set up with the user. The board shows a card with Connect buttons for connections not made yet and Save automation; " +
      "only the user's click saves it. Test the script with test_automation_script first. Its tickets land in Backlog, unless autoStart is set (then they go to Ready and start Claude at once). " +
      "passes: each connection the script uses: {name} for one already connected, {name, from: \"<Connections server>\"} to connect from Connections in one click, " +
      "{name, url: \"https://<online MCP server>\"} when its online MCP server isn't in the user's own Claude settings (e.g. a claude.ai connector's address): the board signs in to it by itself, " +
      "or {name, envName, keyHelp} for a key the user pastes (keyHelp says where to find it; a key already saved for this board under that envName is used as is, and ask_keys asks for one in a box). Nothing is saved by the call.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name, e.g. \"Linear: assigned to me\"." },
        summary: { type: "string", description: "One plain line on what it watches and what it makes." },
        service: { type: "string", description: "Display name of what it watches, e.g. \"Linear\"." },
        passes: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, from: { type: "string" }, url: { type: "string" }, envName: { type: "string" }, keyHelp: { type: "string" } },
            required: ["name"],
          },
        },
        script: { type: "string", description: "The tested check script." },
        everyMinutes: { type: "number", description: "How often it checks (default 15)." },
        instructions: { type: "string", description: "Optional ticket text before the copied item; may use {{title}}, {{link}}, {{service}}." },
        askClaude: {
          type: "object",
          properties: { on: { type: "boolean" }, prompt: { type: "string", description: "What Claude should make tickets for and what to skip." } },
          description: "Ask Claude first: a short no-tools Claude call per new item decides whether it needs a ticket (costs a little per new item, never on quiet checks).",
        },
        partOf: {
          type: "string",
          description: "Optional: a main ticket's id (or one of its groups') when the user wants each new item to become a task of that feature instead of its own card. " +
            "The task waits until the user or the main ticket starts it, unless autoStart is set; a main ticket in Done moves back to Review. Checked when the user saves.",
        },
        autoStart: {
          type: "boolean",
          description: "Optional: true pre-ticks \"Start Claude by itself\" on the card: each new ticket or task starts a Claude run right away (a little cost per run). " +
            "Set it when the watcher should clearly act on its own: the user asked for that, or the tasks only make sense if they start at once (e.g. a watcher that feeds a main ticket's work). " +
            "Leave it out when the user should look at each new item first. The user can untick it before saving.",
        },
      },
      required: ["name", "summary", "script"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args) {
      try {
        automationProposal(args);
      } catch (e) {
        throw new ClientError(`${(e as Error).message}. Fix it and call propose_automation again.`);
      }
      return SHOWN;
    },
  },
];
