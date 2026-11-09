// Whole-huddle templates ("squads" to the user and to Claude): a named roster plus the rules the huddle runs by
// (rounds, budget, report format, the host's process rules). Internal names and the file name stay "template".
// Built-ins ship here; the user's global ones live in <home>/huddle-templates.json and a board's own in
// profiles/<slug>/huddle-templates.json, merged the same way as role presets (built-in -> global -> board, see layers.ts). Starting a huddle from a template uses its roster and budget, and its rules
// become the huddle's pinned brief. Plain helpers shared by the daemon and the MCP server (no file access here).
import { presetName } from "./huddle-presets";
import { proposalFile, rosterError, type RosterEntry } from "./huddle-roster";
import { type Layered, mergeLayers, withItem } from "./layers";

export interface HuddleTemplate {
  /** Key, e.g. design-review. Lowercase letters, digits and dashes. */
  name: string;
  /** Shown in pickers, e.g. "Design review". */
  label: string;
  /** One line: what this huddle is for. */
  description: string;
  roster: RosterEntry[];
  /** Rounds of discussion before the lead wraps up; null: no limit. */
  rounds: number | null;
  /** Budget in USD; null: the board's default. */
  maxCostUsd: number | null;
  /** How participants report (format of findings, who to send them to); "" for none. */
  report: string;
  /**
   * The host's process rules (how the huddle runs: rounds, who marks done when, how the final call goes), kept apart
   * from each person's focus; "" for none. Older files have no such field: it loads as "".
   */
  hostRules: string;
}

export type HuddleTemplateView = Layered<HuddleTemplate>;

/** Longest text field (label, description, report, host rules). */
export const MAX_TEXT = 4000;
/** Longest topic a squad starts with (start route, propose_huddle). */
export const TOPIC_MAX = 2000;
const MAX_ROUNDS = 20;

const DESIGN_REVIEW_READ =
  "Read the code you review without changing the checkout (git show <ref>:<path>, git grep); never edit, checkout or reset. ";

/** The templates an unattended run starts by itself with start_huddle (auto huddles). */
export const AUTO_REVIEW = "auto-review";
export const AUTO_REVIEW_IMPORTANT = "auto-review-important";
export const AUTO_TEMPLATES = [AUTO_REVIEW, AUTO_REVIEW_IMPORTANT];

/** How auto-huddle reviewers read the work; the templates add who they report to. */
export const AUTO_REVIEW_READ_ONLY = "Read the code without changing the checkout; never edit, checkout or reset.";
const AUTO_REVIEW_READ = `${AUTO_REVIEW_READ_ONLY} Report to @qa-lead, not @main. `;
const AUTO_REVIEW_LEAD =
  "Collect the reviewers' and testers' findings, de-duplicate them, pin them with huddle_findings and send @main one consolidated list, MUST first. " +
  "When @main asks for the re-check after its fixes, have the same reviewer check the MUST fixes once, briefly, then tell @main the result.";
/** The finding format every auto huddle reports in. */
export const AUTO_REVIEW_FINDINGS =
  "One finding per line: [MUST|SHOULD|COULD] file:line - problem - concrete fix. MUST = a bug, data loss, security hole or broken user path; " +
  "evidence required. SHOULD/COULD are listed in the ticket's result, not fixed now.";
const AUTO_REVIEW_REPORT = `${AUTO_REVIEW_FINDINGS} Workers report to @qa-lead, who sends @main one list.`;

/** The template a Planning chat proposes when the user asks to review the plan before any work starts. */
export const PLAN_REVIEW = "plan-review";
/**
 * Planning never changes the project, so plan reviewers only read (Huddles.create also keeps them read-only). They
 * read the plan from the proposal file, never the chat: a fresh reader notices what the writer left unsaid.
 */
export const PLAN_REVIEW_READ =
  `Review the plan, not code changes. The board wrote it to a file in this huddle's folder in the host ticket's outputs ` +
  `(${proposalFile("<huddle id>")}; the full path is under "Plan under review" below): the latest ticket or child tickets proposed in the ticket's chat, ` +
  "or the ticket's description when nothing was proposed. Read only that file for the plan: don't read the ticket's chat log or Claude's session files, " +
  "so you judge the plan as written, like the worker who gets it. When it has several child tickets, review each one and start every finding with its ticket key. " +
  "Read the project to check it, but never edit, create or delete files, and don't run commands that change anything: planning never changes the project. ";

/**
 * How a fresh reader checks a ticket it gets with no chat: the plan-review `qa` role and the planning chat's own helper
 * before propose_tickets (TICKETS_FORMAT) share it, so the two don't drift apart.
 */
export const FRESH_READER_CHECK =
  "For each ticket, first restate its goal and the change it asks for in 2-3 plain sentences, from the ticket text alone; " +
  "a part you can't restate from the text is a MUST finding. Then list the choices the ticket leaves to the worker that the worker could plausibly get wrong " +
  "(data format, error handling, which file, UI wording, what happens on failure), each with the question the ticket should answer.";

/**
 * Before propose_tickets: a fresh helper reads each child ticket with no chat, the way its worker will, so gaps get
 * fixed before the cards appear. Shared with the propose_tickets tool description.
 */
export const FRESH_HELPER_CHECK = `Before you call \`propose_tickets\`, run one fresh-reader check: start a fresh helper with the Agent tool and give it only each ticket's title and description, plus the other tickets' keys and titles; no chat text and none of your reasoning. Tell it: "${FRESH_READER_CHECK}" Fix what it found in the tickets, then call \`propose_tickets\` and tell the user in one line what the check changed (or that it changed nothing). One check per proposal: don't run it again on the fixed tickets.`;

/** Before a plan or design adds new code, check the project doesn't already have it. */
const REUSE_CHECK =
  "Before accepting a new function, module or component, search the project for an existing one (git grep for its likely names and for the job it does); " +
  "when one fits, name it (file:line) and say to use or extend it instead. ";

/** Pinned brief of an auto huddle the run built its own roster for (no template): its budget and report format. */
export function customReviewBrief(budget: number): string {
  return [
    "Custom review (roster built by the ticket's run for this change).",
    `Budget: $${budget}.`,
    `Report format: ${AUTO_REVIEW_FINDINGS} With a lead, helpers report to the lead, who sends @main one list; without one, they report to @main.`,
    `Reviewers: ${AUTO_REVIEW_READ_ONLY}`,
  ].join("\n");
}

export const BUILTIN_TEMPLATES: HuddleTemplate[] = [
  {
    name: "design-review",
    label: "Design review",
    description: "Several critics review a feature from different angles; a facilitator de-duplicates and ranks their findings for @main.",
    rounds: 2,
    maxCostUsd: 20,
    hostRules: "",
    report: "One finding per line: [MUST|SHOULD|COULD][S|M|L] file:line - problem - concrete fix. MUST = bug, safety hole or cost leak; evidence required. " +
      "Don't repeat another participant's point: +1 it by #seq. Post findings with kind=finding and report to @facilitator, not @main.",
    roster: [
      {
        handle: "architect", role: "Architect", preset: "reviewer",
        prompt: DESIGN_REVIEW_READ + "Review the core design and engine code: routing bugs, races, recovery after restarts, cost leaks, missing tests. " + REUSE_CHECK,
      },
      {
        handle: "ux", preset: "ux-critic",
        prompt: DESIGN_REVIEW_READ + "Critique the feature under review.",
      },
      {
        handle: "safety", role: "Safety reviewer", preset: "security",
        prompt: DESIGN_REVIEW_READ + "For each risk give a realistic scenario, the current mitigation (or none) and a proportionate fix; this is a single-user local tool, so avoid enterprise overkill.",
      },
      {
        handle: "agentx", role: "Agent ergonomics tester",
        prompt: DESIGN_REVIEW_READ + "Review the feature from an agent's point of view: prompts, tool descriptions, message formats. " +
          "Use this very huddle as evidence: note anything confusing you hit yourself while taking part.",
      },
      {
        handle: "research", role: "Product researcher", preset: "researcher",
        prompt: "Compare the design with how other products and multi-agent frameworks solve the same problem. " +
          "Keep to ideas that fit the project's scale; report the top 5 with effort and benefit.",
      },
      {
        handle: "facilitator", preset: "facilitator", host: true,
        prompt: "Run the rounds the brief sets; when they are over, send @main the final ranked list.",
      },
    ],
  },
  {
    name: PLAN_REVIEW,
    label: "Plan review",
    description: "Before any work starts, a small read-only squad checks the proposed ticket or child tickets against the real project: what's missing, what's risky, whether the checks can be tested. Findings go back to the planning chat.",
    rounds: null,
    maxCostUsd: 5,
    hostRules: "",
    report: "One finding per line: [MUST|SHOULD|COULD] ticket key (for child tickets) and plan section - problem - the change to make in the ticket. MUST = the plan as written would build the wrong thing, " +
      "miss something that has to change, or can't be checked; give evidence (file:line, or the line of the plan). Workers report to @skeptic, who sends @main one list.",
    roster: [
      {
        handle: "codebase", role: "Codebase checker",
        prompt: PLAN_REVIEW_READ + "Check the plan against the real project: do the files, functions and flows it names exist and work as it says? " +
          "Is anything that will have to change left out? " + REUSE_CHECK + "Report to @skeptic, not @main.",
      },
      {
        handle: "qa", role: "QA voice",
        prompt: PLAN_REVIEW_READ + "Read it as the worker who gets only the ticket. " + FRESH_READER_CHECK + " Then check the acceptance criteria: is each one concrete, and could someone outside test it and tell pass from fail? " +
          "Name missing checks for the main paths and edge cases. Report to @skeptic, not @main.",
      },
      {
        handle: "skeptic", role: "Skeptic", lead: true, mode: "monitor", host: true,
        prompt: PLAN_REVIEW_READ + "Look for gaps, edge cases, risks and simpler ways to reach the same goal. Then collect the others' findings, " +
          "de-duplicate them, pin them with huddle_findings and send @main one list, MUST first.",
      },
    ],
  },
  {
    name: AUTO_REVIEW,
    label: "Auto review",
    description: "Claude's own review squad before landing risky work while the user is away: a reviewer and a QA tester, with a QA lead who sends @main one list.",
    rounds: null,
    maxCostUsd: 20,
    report: AUTO_REVIEW_REPORT,
    hostRules: "",
    roster: [
      { preset: "reviewer", prompt: AUTO_REVIEW_READ + "Review the change for correctness: bugs, edge cases, missing tests." },
      { preset: "qa", prompt: AUTO_REVIEW_READ + "Test the change: run the tests and try the user-facing paths it touches." },
      { preset: "qa-lead", host: true, prompt: AUTO_REVIEW_LEAD },
    ],
  },
  {
    name: AUTO_REVIEW_IMPORTANT,
    label: "Auto review (important)",
    description: "The bigger squad for ⭐ important tickets and security, data, payments or migration changes: two reviewers (correctness and security), a blast-radius check, two QA testers and a QA lead.",
    rounds: null,
    maxCostUsd: 20,
    report: AUTO_REVIEW_REPORT,
    hostRules: "",
    roster: [
      { handle: "reviewer", preset: "reviewer", prompt: AUTO_REVIEW_READ + "Review the change for correctness: bugs, edge cases, missing tests." },
      { handle: "security", preset: "security", prompt: AUTO_REVIEW_READ + "Review the change for security and data risks." },
      { handle: "blast-radius", preset: "blast-radius", prompt: AUTO_REVIEW_READ + "Find what the change breaks outside the diff and prove the fact it is safe because of." },
      { preset: "qa", count: 2, prompt: AUTO_REVIEW_READ + "Test the change: run the tests and try the paths it touches; the QA lead splits the areas." },
      { preset: "qa-lead", host: true, prompt: AUTO_REVIEW_LEAD },
    ],
  },
];

const BUILTIN = new Map(BUILTIN_TEMPLATES.map((t) => [t.name, t]));

export const isBuiltinTemplate = (name: string) => BUILTIN.has(name);

/** Built-ins (or their overrides) first, then the user's own templates by name; each at its highest level. */
export function mergeTemplates(global: HuddleTemplate[], board: HuddleTemplate[] = []): HuddleTemplateView[] {
  return mergeLayers(BUILTIN_TEMPLATES, global, board);
}

/**
 * A template to save, filled in from `input` over `base` (the template it overrides or edits); throws a readable
 * message when invalid. `presets`: the board's preset names, to check the roster against (omitted: shape only).
 */
export function templateFromInput(input: any, base?: HuddleTemplate, presets?: string[]): HuddleTemplate {
  if (!input || typeof input !== "object") throw new Error("template must be an object");
  const name = presetName(typeof input.name === "string" ? input.name : "");
  if (!name) throw new Error("name is required (letters, digits and dashes)");
  const text = (k: string) => {
    const v = input[k];
    if (v !== undefined && v !== null && typeof v !== "string") throw new Error(`${k} must be text`);
    if (typeof v === "string" && v.length > MAX_TEXT) throw new Error(`${k} is too long (max ${MAX_TEXT} characters)`);
    return typeof v === "string" ? v.trim() : undefined;
  };
  const roster = input.roster === undefined ? base?.roster : input.roster;
  if (roster === undefined) throw new Error("roster is required: the participants this huddle starts with");
  // Templates may name presets this board doesn't have yet; Start checks names.
  const err = rosterError(roster, 32, presets);
  if (err) throw new Error(err);
  const rounds = input.rounds === undefined ? base?.rounds ?? null : input.rounds;
  if (rounds !== null && (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS)) throw new Error(`rounds must be a whole number from 1 to ${MAX_ROUNDS}, or null`);
  const cost = input.maxCostUsd === undefined ? base?.maxCostUsd ?? null : input.maxCostUsd;
  if (cost !== null && !(typeof cost === "number" && Number.isFinite(cost) && cost > 0)) throw new Error("maxCostUsd must be a positive amount, or null");
  const label = text("label") || base?.label || name.split("-").map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
  return {
    name, label,
    description: text("description") ?? base?.description ?? "",
    roster: (roster as RosterEntry[]).map((e) => ({ ...e })),
    rounds, maxCostUsd: cost,
    report: text("report") ?? base?.report ?? "",
    hostRules: text("hostRules") ?? base?.hostRules ?? "",
  };
}

/**
 * One level's templates after saving `input`: replaces its template of that name, or adds an override or a new one.
 * `lower`: the templates under this level, which an edit starts from.
 */
export function saveTemplate(list: HuddleTemplate[], input: any, presets?: string[], lower: HuddleTemplate[] = BUILTIN_TEMPLATES): { list: HuddleTemplate[]; template: HuddleTemplate } {
  const name = presetName(typeof input?.name === "string" ? input.name : "");
  const base = list.find((t) => t.name === name) ?? lower.find((t) => t.name === name);
  const template = templateFromInput(input, base, presets);
  return { list: withItem(list, template), template };
}

/** One level's templates after deleting `name`; `reset`: a lower level has it, so it falls back to that version. */
export function deleteTemplate(list: HuddleTemplate[], name: string, lower: HuddleTemplate[] = BUILTIN_TEMPLATES): { list: HuddleTemplate[]; reset: boolean } {
  const n = presetName(name);
  if (!list.some((t) => t.name === n)) {
    if (BUILTIN.has(n)) throw new Error(`"${n}" is a built-in template; it can only be changed, not deleted`);
    throw new Error(`no template "${name}" at this level`);
  }
  return { list: list.filter((t) => t.name !== n), reset: lower.some((t) => t.name === n) };
}

/** Keeps only well-formed entries from a hand-edited or old huddle-templates.json. */
export function cleanTemplates(v: unknown): HuddleTemplate[] {
  if (!Array.isArray(v)) return [];
  const out: HuddleTemplate[] = [];
  for (const x of v) {
    try {
      const t = templateFromInput(x);
      if (!out.some((o) => o.name === t.name)) out.push(t);
    } catch {}
  }
  return out;
}

/** The squad's rules as the huddle's pinned brief. `budget`: the huddle's actual budget; `topic`: what this run is about. */
export function templateBrief(t: HuddleTemplate, budget: number, topic?: string | null): string {
  return [
    `${t.label} (squad ${t.name})${t.description ? `: ${t.description}` : ""}`,
    topic?.trim() ? `Topic: ${topic.trim()}` : "",
    t.hostRules?.trim() ? `Host rules (how this huddle runs):\n${t.hostRules.trim()}` : "",
    t.rounds ? `Rounds: at most ${t.rounds}. A round: everyone posts, the lead challenges and de-duplicates, each answers once. After the last round the lead wraps up.` : "",
    `Budget: $${budget}.`,
    t.report ? `Report format: ${t.report}` : "",
  ].filter(Boolean).join("\n");
}

/** A topic from a request or tool call: trimmed, null when empty; throws when it isn't text or is too long. */
export function topicInput(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error("topic must be text");
  const t = v.trim();
  if (t.length > TOPIC_MAX) throw new Error(`topic is too long (max ${TOPIC_MAX} characters)`);
  return t || null;
}

/** One line per squad, for list_huddle_presets and tool descriptions. */
export function templateLine(t: HuddleTemplateView): string {
  const who = t.roster.map((e) => `${e.count && e.count > 1 ? `${e.count}× ` : ""}${e.handle ?? e.preset ?? e.role}`).join(", ");
  const rules = [t.rounds && `${t.rounds} rounds`, t.maxCostUsd && `$${t.maxCostUsd} budget`, t.hostRules?.trim() && "host rules"].filter(Boolean).join(", ");
  return `- ${t.name}: ${t.label} (${who}${rules ? `; ${rules}` : ""}${t.source === "builtin" ? "; built-in" : ""})${t.description ? `\n  ${t.description}` : ""}`;
}
