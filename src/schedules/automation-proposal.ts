// propose_automation: the setup chat (Automations → Set up with Claude) proposes an automation and the user saves it
// with one click. It is a card built from the tool call in the transcript (session.ts). autoStart pre-ticks the card's
// "Start Claude by itself" box (tickets go to Ready and start at once); the user's tick or untick on the card decides.

/** A connection the automation needs, as the setup chat names it. */
export interface ProposedPass {
  /** Display name ("Linear"); the script calls it by this name. */
  name: string;
  /** The Connections (Claude) server to connect it from, for one-click Connect. */
  from?: string;
  /** An online MCP server address the board signs in to by itself (when it isn't in Connections, e.g. a claude.ai connector's). */
  url?: string;
  /** For a key the user pastes: the environment variable the script reads it from. */
  envName?: string;
  /** Plain-words hint where to find the key. */
  keyHelp?: string;
}

export interface AutomationProposal {
  name: string;
  service: string;
  passes: ProposedPass[];
  script: string;
  everyMinutes: number;
  instructions?: string;
  askClaude?: { on: boolean; prompt: string };
  /** The feature each new ticket goes into as a task: a main ticket's or group's id (Loop.partOf; checked on save). */
  partOf?: string;
  /** Claude suggests that new tickets start Claude by themselves (Ready + Loop.autoStart): pre-ticks the card's box. */
  autoStart?: boolean;
  /** One line: what it watches, in plain words. */
  summary: string;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The proposal from propose_automation's input; throws a readable message when it is invalid. */
export function automationProposal(input: any): AutomationProposal {
  const name = str(input?.name).slice(0, 80);
  if (!name) throw new Error("name is required, e.g. \"Linear: assigned to me\"");
  const script = typeof input?.script === "string" ? input.script : "";
  if (!script.trim()) throw new Error("script is required: the check script you tested with test_automation_script");
  if (script.length > 64_000) throw new Error("script is too long");
  const every = input?.everyMinutes === undefined ? 15 : Number(input.everyMinutes);
  if (!Number.isInteger(every) || every < 1 || every > 1440) throw new Error("everyMinutes must be 1 to 1440");
  const rawPasses = input?.passes === undefined ? [] : input.passes;
  if (!Array.isArray(rawPasses)) throw new Error("passes must be a list");
  const passes: ProposedPass[] = rawPasses.map((p: any) => {
    const n = str(p?.name);
    if (!n) throw new Error("each entry of passes needs a name");
    return {
      name: n.slice(0, 60), ...(str(p?.from) ? { from: str(p.from) } : {}), ...(/^https:\/\/\S+$/.test(str(p?.url)) ? { url: str(p.url) } : {}), ...(str(p?.envName) ? { envName: str(p.envName) } : {}),
      ...(str(p?.keyHelp) ? { keyHelp: str(p.keyHelp).slice(0, 300) } : {}),
    };
  });
  const summary = str(input?.summary).slice(0, 300);
  if (!summary) throw new Error("summary is required: one plain line on what it watches");
  const ask = input?.askClaude;
  const partOf = str(input?.partOf);
  if (partOf && !/^[A-Za-z0-9_-]{1,80}$/.test(partOf)) throw new Error("partOf must be a ticket id: a main ticket's or one of its groups'");
  return {
    name, script, everyMinutes: every, passes, summary,
    service: (str(input?.service) || passes[0]?.name || "a script").slice(0, 60),
    ...(str(input?.instructions) ? { instructions: str(input.instructions).slice(0, 8000) } : {}),
    ...(ask && typeof ask === "object" ? { askClaude: { on: ask.on === true, prompt: str(ask.prompt).slice(0, 4000) } } : {}),
    ...(partOf ? { partOf } : {}),
    ...(input?.autoStart === true ? { autoStart: true } : {}),
  };
}

/** Like automationProposal, but null for input that can't be read (an old or broken tool call in a transcript). */
export function parseAutomationProposal(input: unknown): AutomationProposal | null {
  try {
    return automationProposal(input);
  } catch {
    return null;
  }
}
