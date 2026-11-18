/**
 * The proposal card's "Start work in a fresh chat" box (kept DOM-free for tests). The server makes the same call when a
 * ticket moves from Planning to work without a choice (PLANNING_FRESH_TOKENS in rust/board/src/runloop/prompt.rs): a
 * planning chat over 50k starts the work fresh, a short or unknown one is kept.
 */

/** The parts of a ticket and a proposal this needs (structural, so the test doesn't load the API client). */
interface WithCache { session?: { cache?: { tokens: number; coldTokens?: number } | null } | null }
interface ProposalFields { title?: string; description?: string; important?: boolean }

export const PLANNING_FRESH_TOKENS = 50_000;

export interface FreshDefault {
  /** Planning chat size Claude would re-read (null: not known yet). */
  tokens: number | null;
  /** The box starts ticked. */
  on: boolean;
}

/** From the ticket's session summary, the same numbers the old-chat note uses (coldTokens, else tokens). */
export function freshDefault(ticket: WithCache): FreshDefault {
  const c = ticket.session?.cache;
  const n = c ? c.coldTokens ?? c.tokens : null;
  const tokens = typeof n === "number" && Number.isFinite(n) ? n : null;
  return { tokens, on: tokens !== null && tokens > PLANNING_FRESH_TOKENS };
}

/** "86k". */
export const kTokens = (n: number) => `${Math.max(1, Math.round(n / 1000))}k`;

/** The muted note under the box's label, by the chat's size (not by the tick). Plain words: no "session", "context" or "token". */
export function freshNote(d: { tokens: number | null; on?: boolean }): string {
  if (d.tokens === null) return "Claude keeps the planning chat. Tick to start from the ticket only.";
  if (d.tokens > PLANNING_FRESH_TOKENS) return `The planning chat is long (${kTokens(d.tokens)}). Claude starts from this ticket and the chosen mockups, and can look back at the planning chat when it needs to.`;
  return `The planning chat is short (${kTokens(d.tokens)}), so Claude keeps it. Tick to start from the ticket only.`;
}

/**
 * The one update "Apply" sends: the proposal's fields, and with "Apply & start work" the move to Ready plus the box's
 * choice (fresh: true starts the work in a fresh chat, false keeps the planning chat). "Apply only" sends no choice.
 */
export function proposalPatch(p: ProposalFields, start?: { fresh: boolean }) {
  return {
    ...(p.title ? { title: p.title } : {}),
    ...(p.description ? { body: p.description } : {}),
    ...(p.important ? { important: true } : {}),
    ...(start ? { status: "ready" as const, freshChat: start.fresh } : {}),
  };
}
