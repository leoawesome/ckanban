// Planning chat cards: questions, key boxes, backups and proposals the board shows the user as forms or cards. Moved verbatim from mcp-server.ts.
import { hiddenTool, withYouTool } from "../../web/src/features/family/family";
import { HUDDLE_AGENT_ENV } from "../core/env";
import { ClientError, huddleCaller, RUN_ENV, runProfile } from "../cli/client";
import { BUILTIN_PRESETS, MAIN_PRESET } from "../huddle/huddle-presets";
import { MAX_TEXT } from "../huddle/huddle-templates";
import { squadProposal } from "../huddle/squad";
import { teammateProposal } from "../huddle/teammate-proposal";
import { keysAsk, MAX_ASKED_KEYS } from "../integrations/ask-keys";
import { backupFile, backupText } from "../integrations/file-backup";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROFILE, runTicketId, type Tool, slugFor, str, SHOWN } from "./shared";
import { CONNECTION_TOOLS } from "./connection-tools";

// --- Planning chat cards ----------------------------------------------------------------------
// The board's planning chat renders these calls (from the session transcript) as a form or cards.
// The tools only check the input, so a bad call comes back to Claude as an error to fix.

export const MAX_TITLE = 80;

export const isText = (v: unknown): v is string => typeof v === "string" && !!v.trim();

export function titleError(title: unknown, where: string): string | null {
  if (!isText(title)) return `${where}title is required`;
  if (title.trim().length >= MAX_TITLE) return `${where}title must be under ${MAX_TITLE} characters (it has ${title.trim().length})`;
  return null;
}

/** ask_questions / notify_user: whether waiting causes harm that grows (the helper interrupts the user for it). */
export const URGENT = {
  type: "boolean",
  description: "true only when waiting causes harm or cost that grows (customers billed twice, data ingested twice, a deadline missed). The user's helper then interrupts them at once and reminds them; otherwise it groups this with other routine items.",
};
export const WHY = { type: "string", description: "One line: what waiting costs, e.g. \"each hour the old webhook runs, pricing data is ingested twice\"." };

/** urgent / why input the board refuses; null when fine. */
export function urgencyError(args: any): string | null {
  if (args?.urgent !== undefined && typeof args.urgent !== "boolean") return "urgent must be true or false";
  if (args?.why !== undefined && typeof args.why !== "string") return "why must be one line of text";
  if (typeof args?.why === "string" && args.why.length > 300) return "why is too long: keep it to one line";
  return null;
}

/** How long a question should be; a longer one without context is refused (its background belongs in context). */
export const SHORT_QUESTION = 120;
export const MAX_BARE_QUESTION = 200;

/** Checks ask_questions input; returns what's wrong, or null when it's fine. */
export function questionsError(args: any): string | null {
  const u = urgencyError(args);
  if (u) return u;
  if (args?.about !== undefined && (!Array.isArray(args.about) || args.about.some((x: unknown) => typeof x !== "string") || args.about.length > 20)) {
    return "about must be a list of task ids (at most 20)";
  }
  const qs = args?.questions;
  if (!Array.isArray(qs) || qs.length < 1) return "questions must be a non-empty list";
  for (const [i, q] of qs.entries()) {
    const at = `question ${i + 1}: `;
    if (!isText(q?.question)) return `${at}question text is required`;
    if (q.context !== undefined && typeof q.context !== "string") return `${at}context must be text`;
    if (q.question.trim().length > MAX_BARE_QUESTION && !isText(q.context)) {
      return `${at}the question has ${q.question.trim().length} characters: keep it to one sentence (about ${SHORT_QUESTION} characters) and move the background into its "context" (what the user should do after picking an option goes in that option's description)`;
    }
    const opts = q.options;
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > 8) return `${at}give 2-8 options`;
    if (opts.some((o: any) => !isText(o?.label))) return `${at}every option needs a label`;
    const rec = opts.filter((o: any) => o?.recommended === true).length;
    if (rec !== 1) return `${at}mark exactly one option recommended (found ${rec})`;
    if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") return `${at}multiSelect must be true or false`;
  }
  return null;
}

/** Checks propose_ticket input; returns what's wrong, or null when it's fine. */
export function proposalError(args: any): string | null {
  if (args?.important !== undefined && typeof args.important !== "boolean") return "important must be true or false";
  if (args?.partOf !== undefined && args.partOf !== null && !isText(args.partOf)) return 'partOf must be a ticket id, or "none" to take the ticket out of its family';
  return titleError(args?.title, "") ?? (isText(args?.description) ? null : "description is required");
}

export const TITLE = { type: "string", description: "Short, specific title (under 80 characters)." };
export const PROPOSED_IMPORTANT = {
  type: "boolean",
  description: "⭐ Important: unattended runs review the work in an auto huddle before landing it. Set it when the user (or the project's rules) " +
    "says this work is important; don't put a ⭐ in the title instead.",
};

export const BUILTIN_NAMES = BUILTIN_PRESETS.filter((p) => p.name !== MAIN_PRESET).map((p) => p.name);
export const ROSTER_ENTRY = {
  type: "object",
  properties: {
    preset: {
      type: "string",
      description: `Role preset name: built-ins ${BUILTIN_NAMES.join(", ")}, plus the board's own (list_huddle_presets shows them all with their prompts). ` +
        "It sets the role, prompt, model, mode, lead, canEdit and workspace defaults; the fields below override them.",
    },
    role: { type: "string", description: "Free-text role when no preset fits, e.g. \"Accessibility tester\" (give its prompt too). With a preset: overrides its label." },
    count: { type: "integer", minimum: 1, maximum: 8, description: "How many of this role (handles get -1, -2, ...). Default 1." },
    focus: { type: "string", description: "What exactly this participant should look at." },
    model: { type: "string", description: "Model, e.g. sonnet. Default: the board's." },
    mode: { type: "string", enum: ["tagged", "monitor"], description: "tagged: sleeps until @mentioned. monitor: gets every new message. Default: the preset's; monitor when this entry sets lead true (leads watch every message and wake on any tag)." },
    workspace: {
      type: "string", enum: ["shared", "own"],
      description: "shared: reads the host ticket's folder, read-only (review, QA). own: its own copy of the folder, where it may change files and then hand them in. Works on any project, with or without version history.",
    },
    lead: { type: "boolean", description: "May add participants and manage the findings list." },
    host: {
      type: "boolean",
      description: "Runs the huddle instead of you (@main): hands out the tasks, chases the helpers, accepts or rejects hand-ins, writes the summary and tags @main only for decisions and the final report. " +
        "One entry at most, count 1; it is made a lead. Squads and auto huddles default to their first lead.",
    },
    canEdit: { type: "boolean", description: "May change files (then it works in its own copy and hands its changes in with huddle_hand_in). Default: the preset's (true for a free-text role with workspace own)." },
    prompt: { type: "string", description: "Instructions: with a preset, added to its prompt; with a free-text role, its whole job." },
    handle: { type: "string", description: "Handle for @mentions. Default: the preset or role." },
  },
};

/** Teammate (huddle role preset) fields, shared by save_huddle_preset and propose_teammate. */
export const PRESET_FIELDS = {
  name: { type: "string", description: "Preset name, also the default @handle, e.g. \"a11y\" (lowercase letters, digits, dashes)." },
  prompt: { type: "string", description: "What this role does in a huddle: its job, what to look at, how to report." },
  role: { type: "string", description: "Label shown in the huddle, e.g. \"Accessibility tester\". Default: from the name." },
  model: { type: "string", description: "Default model, e.g. sonnet. Empty: the board's." },
  mode: { type: "string", enum: ["tagged", "monitor"], description: "tagged: sleeps until @mentioned. monitor: gets every new message. Default tagged; monitor for a lead." },
  lead: { type: "boolean", description: "May add participants and manage the findings list. Default false." },
  canEdit: { type: "boolean", description: "May change files: it works in its own copy of the folder and hands its changes in (huddle_hand_in). For roles that make things (build, design, fix); reviewers stay read-only so their review stays independent. Default: true for workspace own." },
  workspace: { type: "string", enum: ["shared", "own"], description: "shared: reads the host ticket's folder (a read-only snapshot). own: its own copy of the folder (always, when canEdit). Default shared." },
};

export const PROPOSE_INSTEAD = "Nothing was saved: inside a board or huddle run only the user saves teammates. Call propose_teammate with the same fields and a one-line why; " +
  "the user saves it with one click (in a ticket chat it shows as a card, in a huddle under Learnings).";

/** ask_keys inside a tool ticket's run: the user never sees a tool ticket's chat. */
export const TOOL_NO_KEYS = "This is a tool ticket: the user doesn't see its chat, so it can't show a key box. End your run with status \"questions\" and name each key you need in your summary (its variable name like SENTRY_AUTH_TOKEN, what it is for and where to create it): your parent asks the user for it with ask_keys, and your next run has it as that variable.";

/** ask_questions inside a tool ticket's run. */
export const TOOL_NO_QUESTIONS = "This is a tool ticket: it never asks the user. End your run with status \"questions\" and put the question in your summary instead; your parent ticket answers it with a message that resumes you.";

export const PLANNING_TOOLS: Tool[] = [
  {
    name: "ask_questions",
    description:
      "Board planning chat only: ask the user questions as a form in the board's ticket chat (they can also add free text). " +
      "Their answers come back as the user's next message. Ask every open question that matters, 2-8 options each, exactly one option recommended; " +
      "multiSelect true only when several options can apply. Each question is one short sentence (about 120 characters at most): put background in its context " +
      "(shown folded under the question as Details), and what the user should do after picking an option in that option's description. " +
      "Text may use simple markdown (bold, italic, `code`, links, lists). Put a one-line intro in your reply; don't repeat the questions or their context as text, before or after the call. " +
      "Nothing is created or changed. After the call, end your turn and wait for the answers.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array", minItems: 1,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "One short sentence, about 120 characters at most; no background here (that goes in context)." },
              context: { type: "string", description: "Optional background the user may need to decide (markdown), shown folded under the question as \"Details\"." },
              options: {
                type: "array", minItems: 2, maxItems: 8,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: {
                      type: "string",
                      description: "Short note on what this option means. If the user has something to do after picking it, put it here, e.g. \"What you say on call 5: 1. … 2. …\".",
                    },
                    recommended: { type: "boolean", description: "true on exactly one option." },
                    mockup: { type: "string", description: "File name of the mockup this option stands for (e.g. a-two-buttons.html); the form links to its preview." },
                  },
                  required: ["label"],
                },
              },
              multiSelect: { type: "boolean", description: "Several options can apply. Default: false." },
            },
            required: ["question", "options"],
          },
        },
        urgent: URGENT,
        why: WHY,
        about: {
          type: "array", items: { type: "string" },
          description: "Main ticket only: ids of your tasks this question is about (e.g. you pass on what a task found or asks). If the user answers in that task's own chat instead, this form closes by itself.",
        },
      },
      required: ["questions"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      // A tool ticket never asks the user: its question goes to its parent through its result.
      const own = ctx.env[RUN_ENV]?.split("/");
      if (own?.[0] && own[1]) {
        const t = await Promise.resolve().then(() => ctx.client.getTicket(own[0], own[1])).catch(() => null);
        if (hiddenTool(t) && !withYouTool(t)) throw new ClientError(TOOL_NO_QUESTIONS);
      }
      const e = questionsError(args);
      if (e) throw new ClientError(`${e}. Fix it and call ask_questions again.`);
      return SHOWN.replace("a card", "a form");
    },
  },
  {
    name: "ask_keys",
    description:
      "Board ticket chat (any column): ask the user for keys or tokens (an API key, a personal access token) by name, instead of asking them to paste one in the chat or into a file. " +
      "The chat shows a box with one password field per key, a \"create one\" link when you give createUrl, Save and \"I'll do it myself\". " +
      "The board keeps the keys on this Mac for this board; every later run on the board (this ticket's next run too) gets each one as an environment variable under its envName. " +
      "You never see the values: place a key with shell commands that use the variable (write \"$SENTRY_AUTH_TOKEN\" into the config file, `gh secret set NAME --body \"$NAME\"`), " +
      "and never print, echo, cat or log one. A key already saved for this board is not asked again (the reply says so) unless replace is true. " +
      "After the call, end your turn: the board resumes you with a message naming the keys saved (never their values), or saying the user will do it themselves.",
    inputSchema: {
      type: "object",
      properties: {
        keys: {
          type: "array", minItems: 1, maxItems: MAX_ASKED_KEYS,
          items: {
            type: "object",
            properties: {
              envName: { type: "string", description: "The environment variable name runs get it as: capital letters, digits and _, e.g. SENTRY_AUTH_TOKEN." },
              label: { type: "string", description: "What it is, in plain words, e.g. \"Sentry auth token\"." },
              help: { type: "string", description: "Short hint: the access it needs or where to find it, e.g. \"needs project:releases\"." },
              createUrl: { type: "string", description: "https address where the user creates one." },
            },
            required: ["envName", "label"],
          },
        },
        reason: { type: "string", description: "One line: what you will do with them, e.g. \"to upload source maps from the build\"." },
        replace: { type: "boolean", description: "Ask again for keys already saved for this board, to replace them (only when the user asks, or the saved one is refused). Default false." },
      },
      required: ["keys", "reason"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const own = ctx.env[RUN_ENV]?.split("/");
      if (!own?.[0] || !own[1] || ctx.env[HUDDLE_AGENT_ENV]) {
        throw new ClientError("ask_keys works only in a board ticket's chat, where the user sees the box. Ask the user to add the key in the ticket chat instead, and never ask them to paste it in a message.");
      }
      const t = await Promise.resolve().then(() => ctx.client.getTicket(own[0], own[1])).catch(() => null);
      if (hiddenTool(t)) throw new ClientError(TOOL_NO_KEYS);
      let ask;
      try {
        ask = keysAsk(args);
      } catch (e) {
        throw new ClientError(`${(e as Error).message}. Fix it and call ask_keys again.`);
      }
      // Always the run's own board: keys are kept per board.
      const { passes } = await ctx.client.listPasses();
      const saved = new Set(passes.filter((p) => p.kind === "key" && p.board === own[0] && p.envName).map((p) => p.envName!));
      const already = ask.keys.filter((k) => saved.has(k.envName)).map((k) => k.envName);
      if (already.length && !ask.replace) {
        const here = already.filter((n) => ctx.env[n] !== undefined);
        const later = already.filter((n) => ctx.env[n] === undefined);
        const names = (ns: string[]) => ns.map((n) => `$${n}`).join(", ");
        const status = (here.length ? `${names(here)} ${here.length === 1 ? "is" : "are"} already saved for this board and in your environment now. ` : "") +
          (later.length ? `${names(later)} ${later.length === 1 ? "was" : "were"} saved for this board after this run started: ${later.length === 1 ? "it reaches" : "they reach"} the next run, not this one. ` : "");
        const rest = ask.keys.filter((k) => !saved.has(k.envName));
        // An error result: the chat draws no box for this call (session.ts drops cards whose call failed).
        throw new ClientError(`No box shown. ${status}` + (rest.length
          ? `Call ask_keys again with only the keys not saved yet (${names(rest.map((k) => k.envName))}), or with replace: true to replace the saved ones.`
          : "Use them through the variables (never print a value). To replace a saved key, call ask_keys again with replace: true."));
      }
      return "Shown to the user as a key box" + (already.length ? " (it says it replaces the saved key)" : "") +
        ". End your turn now and wait: the board resumes you with a message naming the keys saved (they are then in your environment under those names) or saying the user will do it themselves.";
    },
  },
  {
    name: "backup_file",
    description:
      "Before you put a saved key into an existing file (a .env, a tool's config file in the home folder), call this with the file's path: " +
      "the board saves a private copy of it in its own data folder on this Mac (owner-only, never in the project or the ticket's outputs; 5 copies per file are kept: the first and the newest; deleting the board deletes them). " +
      "It answers with where the copy went, never with the file's contents. If the file doesn't exist yet it says so and copies nothing. " +
      "Then change only the key's line, using the variable.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file you are about to change: absolute, ~/... or $HOME/..., or relative to your working folder." },
        profile: { ...PROFILE, description: "Outside a board run only: the board whose private folder keeps the copy. Default: the board of your working folder." },
      },
      required: ["path"],
    },
    // Writes only into the board's own private folder: allowed in every run.
    changes: false,
    async run(args, ctx) {
      // Inside a run, always the run's own board (like its keys); outside, the board of the folder or `profile`.
      const slug = runProfile(ctx.env) ?? await slugFor(args, ctx);
      const root = ctx.dataRoot ?? ctx.env.CKANBAN_HOME ?? join(homedir(), ".claude-kanban");
      try {
        return backupText(backupFile(root, slug, str(args, "path")!, ctx.cwd, ctx.now ? new Date(ctx.now()) : new Date()));
      } catch (e) {
        if (e instanceof ClientError) throw e;
        throw new ClientError(`No copy made: ${(e as Error).message}. Don't change the file until a copy is saved.`);
      }
    },
  },
  {
    name: "propose_ticket",
    description:
      "Board planning chat only: propose an improved title and markdown description for this ticket. " +
      "The board shows it as a card; the user clicks Apply to replace the ticket's title and description " +
      "(on a ticket that already ran, Start follow-up work runs it as a step that reports to the feature's main ticket, or turns a ticket on its own into a main ticket with it as the first step). " +
      "Write the description self-contained (## Goal, ## Context, ## Scope, ## Requirements, ## Acceptance criteria, ## Open questions): " +
      "Claude works on it later without this chat. Nothing is created or changed by the call.",
    inputSchema: {
      type: "object",
      properties: {
        title: TITLE, description: { type: "string", description: "Markdown description." }, important: PROPOSED_IMPORTANT,
        partOf: {
          type: "string",
          description: "Only when the ticket belongs in another family (get_family shows its current one), e.g. the user says it hangs under the wrong ticket: " +
            "the id of the ticket it is part of, or \"none\" to take it out of its family (this also ends a wrong plan link). Apply then moves it. Leave out to keep its links.",
        },
      },
      required: ["title", "description"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args) {
      const e = proposalError(args);
      if (e) throw new ClientError(`${e}. Fix it and call propose_ticket again.`);
      return SHOWN;
    },
  },
  {
    name: "propose_branch",
    description:
      "Board ticket chat (any column): offer to branch this ticket, like Claude Code's /branch. Use it when the user asks to branch, fork, " +
      "or try another direction in parallel without losing this one. The board shows a card with a Branch button; the user's click creates " +
      "\"Branch: <title>\" in Planning with a copy of this conversation and its own git branch off this ticket's branch (committed work only). " +
      "Nothing is created by the call; don't start the other direction yourself.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "One short line: what the branch is for (e.g. try SQLite instead of Postgres)." } },
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args) {
      if (args?.reason !== undefined && typeof args.reason !== "string") throw new ClientError("reason must be a string. Fix it and call propose_branch again.");
      return SHOWN;
    },
  },
  {
    name: "propose_delete",
    description:
      "Board ticket chat: ask the user to delete tickets on this ticket's board (delete_ticket is refused inside board runs). Only when the user asked for it. " +
      "The board shows a card with each ticket's title, id and column, your reason, and Cancel / Delete buttons; deleting removes the ticket's " +
      "worktree, branch and chat and can't be undone. This ticket itself can't be proposed. Nothing is deleted by the call.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, minItems: 1, description: "Ticket ids to delete, e.g. [\"t_20261001_abcd\"]." },
        reason: { type: "string", description: "One short line: why they can go (e.g. replaced by t_20261001_wxyz)." },
      },
      required: ["ids", "reason"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const ids = Array.isArray(args?.ids) ? [...new Set(args.ids.filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim()))] as string[] : [];
      if (!ids.length) throw new ClientError("ids must be a non-empty list of ticket ids. Fix it and call propose_delete again.");
      if (typeof args?.reason !== "string" || !args.reason.trim()) throw new ClientError("reason is required. Fix it and call propose_delete again.");
      const own = runTicketId(ctx);
      if (own && ids.includes(own)) throw new ClientError(`${own} is this chat's own ticket and can't be proposed for deletion; ask the user to delete it from the board.`);
      // Always this chat's board: the card can only delete tickets there.
      const slug = await slugFor({}, ctx);
      const known = new Set((await ctx.client.ticketsByIds(slug, ids)).tickets.map((t) => t.id));
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length === ids.length) throw new ClientError(`no such ticket on board ${slug}: ${missing.join(", ")}. Check list_tickets.`);
      return SHOWN + (missing.length ? ` Not on board ${slug}, shown as skipped: ${missing.join(", ")}.` : "");
    },
  },
  {
    name: "propose_teammate",
    description:
      "Board ticket chat (any column) or huddle agent: propose a teammate (huddle role preset) when no existing one fits the job, e.g. \"a teammate that watches X\". " +
      "Call list_huddle_presets first: reuse a teammate that fits; giving an existing name proposes a change to it (fields you leave out keep its values). " +
      "In a ticket chat the board shows a card; the user saves it for all boards or this board, edits it first, or dismisses it. " +
      "From a huddle agent it goes to the huddle's Learnings for the user to review. Nothing is saved by the call.",
    inputSchema: {
      type: "object",
      properties: {
        ...PRESET_FIELDS,
        why: { type: "string", description: "One line: why no existing teammate fits (e.g. no teammate watches a web inbox; @researcher only reads and reports)." },
      },
      required: ["name", "prompt", "why"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const { profile: _p, ...input } = args ?? {};
      try {
        teammateProposal(input);
      } catch (e) {
        throw new ClientError(`${(e as Error).message}. Fix it and call propose_teammate again.`);
      }
      if (!ctx.env[HUDDLE_AGENT_ENV]) return SHOWN;
      // A huddle agent: its session is no ticket chat, so the proposal waits under the huddle's Learnings.
      const slug = await slugFor({}, ctx);
      const l = await ctx.client.huddleProposeTeammate(slug, "current", input, huddleCaller(ctx.env));
      return `Proposed teammate @${l.teammate?.name ?? input.name}: the user reviews it under the huddle's Learnings and saves it with one click. Nothing is saved until then; carry on with your work.`;
    },
  },
  {
    name: "propose_squad",
    description:
      "Board ticket chat (any column) or huddle agent: propose a squad, a saved huddle the user can start again on any ticket with that ticket's topic " +
      "(e.g. when the user says a huddle worked and they want it again, or asks for a reusable review setup). Make it generic: no file names, paths, ticket ids, " +
      "product or feature names, or point lists from this ticket; keep how the huddle runs, each role's angle, and the modes, models and budget. " +
      "Put the host's process rules (steps, when people may mark themselves done, how the final call goes) in hostRules, not in the host's focus. " +
      "People with a preset keep it (list_huddle_presets); a role with no preset gets role + prompt and is saved as a new teammate with the squad (an existing teammate of that name is used as is). " +
      "In a ticket chat the board shows a card; the user saves it for this board or all boards, edits it first, or dismisses it. From a huddle agent it goes to the huddle's Learnings. Nothing is saved by the call.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Squad name: lowercase letters, digits and dashes, for the kind of huddle (e.g. plan-critique), never a product or ticket name." },
        label: { type: "string", description: "Shown in pickers, e.g. \"Plan critique\"." },
        description: { type: "string", description: "One line: what this squad is for and when to use it." },
        hostRules: { type: "string", description: `The host's process rules, as numbered steps (max ${MAX_TEXT} characters): how the huddle runs, who posts when, when people may mark done, how the final call is made. Generic: no project facts.` },
        roster: { type: "array", minItems: 1, items: ROSTER_ENTRY, description: "The people. Exactly one host when the squad has one; focus says each one's angle in general terms." },
        rounds: { type: ["integer", "null"], description: "Rounds of discussion before the lead wraps up; null or leave out for no fixed number." },
        maxCostUsd: { type: ["number", "null"], description: "Budget in USD; null or leave out for the board's default." },
        report: { type: "string", description: "How people report findings (format, who to), or leave out." },
        why: { type: "string", description: "One line: what this squad is good for (shown on the card)." },
      },
      required: ["name", "roster", "why"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const { profile: _p, ...input } = args ?? {};
      const slug = await slugFor(args ?? {}, ctx).catch(() => null);
      // The board's presets when the daemon is reachable; otherwise only the shape is checked here.
      const names = slug ? await ctx.client.listHuddlePresets(slug).then((ps) => ps.map((p) => p.name), () => undefined) : undefined;
      try {
        squadProposal(input, names);
      } catch (e) {
        throw new ClientError(`${(e as Error).message}. Fix it and call propose_squad again.`);
      }
      if (!ctx.env[HUDDLE_AGENT_ENV]) return SHOWN;
      // A huddle agent: its session is no ticket chat, so the proposal waits under the huddle's Learnings.
      const l = await ctx.client.huddleProposeSquad(slug ?? await slugFor({}, ctx), "current", input, huddleCaller(ctx.env));
      return `Proposed squad "${l.squad?.squad.label ?? input.name}": the user reviews it under the huddle's Learnings and saves it with one click. Nothing is saved until then; carry on with your work.`;
    },
  },
  ...CONNECTION_TOOLS,
];
