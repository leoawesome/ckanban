// No imports from api.ts or React: the server typecheck and tests load this file (test/inboxOrder.test.ts).
// AttentionKind matches api.ts.
type AttentionKind = "stalled" | "failed" | "limit" | "blocked" | "questions" | "proposal" | "review" | "reply" | "huddle";
/** The part of an Inbox item (api.ts InboxItem) the order needs. */
interface Waiting { attention: { kind: AttentionKind; since: string } }

/** Claude is stopped until you act: these lead the Inbox and the phone Now view. The rest (review, reply) are ready to check. */
export const WAITING_KINDS: ReadonlySet<AttentionKind> = new Set(["questions", "blocked", "proposal", "failed", "stalled", "limit", "huddle"]);
/** Items waiting longer than this fold into "Older". */
export const OLDER_MS = 7 * 24 * 3600_000;

export interface InboxGroups<T extends Waiting> {
  /** "Claude is waiting on you", newest first. */
  waiting: T[];
  /** "Ready to check" (review, reply), newest first. */
  check: T[];
  /** Waited more than a week (either kind): waiting ones first, then newest first. */
  older: T[];
}

const newestFirst = (a: Waiting, b: Waiting) => b.attention.since.localeCompare(a.attention.since);

/** Splits the Inbox into what Claude waits on, what is ready to check, and what has waited over a week. */
export function groupInbox<T extends Waiting>(items: T[], now: number): InboxGroups<T> {
  const g: InboxGroups<T> = { waiting: [], check: [], older: [] };
  for (const i of items) {
    const at = new Date(i.attention.since).getTime();
    if (now - at > OLDER_MS) g.older.push(i);
    else (WAITING_KINDS.has(i.attention.kind) ? g.waiting : g.check).push(i);
  }
  g.waiting.sort(newestFirst);
  g.check.sort(newestFirst);
  g.older.sort((a, b) => Number(WAITING_KINDS.has(b.attention.kind)) - Number(WAITING_KINDS.has(a.attention.kind)) || newestFirst(a, b));
  return g;
}
