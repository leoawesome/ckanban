// A summary's text (Telegram, ntfy) and the rows its page shows. Pure: the runner gathers the items, this writes them.
// Short on purpose: the headline, one line per new item (runs of one repeating schedule merged), one line counting
// what still waits, no links (the message itself opens its page), board headings only when there are several boards.
import { cut } from "./core";
import type { SummaryRow, SummaryView } from "./messages";

/** A new item waiting longer than this is only counted with what still waits, never listed. */
export const STALE_MS = 3 * 24 * 3600_000;
/** A row's line in the text, and a row's label on its own. */
export const ROW_MAX = 100;
export const LABEL_MAX = 80;

/** One item as the runner hands it in. */
export interface SummaryInput {
  key?: string | null;
  board: string;
  boardName: string;
  ticketId: string;
  title: string;
  /** What it needs: directLabel (the question's first line or the label). */
  label: string;
  /** When it started waiting (ISO). */
  since: string;
}

/** A repeating schedule's title without its date and time: "Product Hunt replies 2026-11-09 10:20" -> "Product Hunt replies". */
const STAMP = /^(.*\S)\s+\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?$/;
export function titleStem(title: string): string | null {
  const m = STAMP.exec(title.trim());
  return m ? m[1] : null;
}

const row = (i: SummaryInput, count?: number): SummaryRow => ({
  key: i.key ?? null, board: i.board, boardName: i.boardName, ticketId: i.ticketId, title: i.title, label: cut(i.label, LABEL_MAX), since: i.since,
  ...(count ? { count } : {}),
});

const lower = (s: string) => (s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/**
 * New items as rows: runs of the same repeating schedule on the same board (2 or more tickets) become one row
 * ("Product Hunt replies: 4 runs ready for review", opening the newest), in the order they first appear.
 */
export function collapseRuns(items: SummaryInput[]): SummaryRow[] {
  const groups = new Map<string, SummaryInput[]>();
  const order: string[] = [];
  items.forEach((it, n) => {
    const stem = titleStem(it.title);
    const k = stem ? `${it.board}\u0000${stem}` : `#${n}`;
    if (!groups.has(k)) {
      groups.set(k, []);
      order.push(k);
    }
    groups.get(k)!.push(it);
  });
  const out: SummaryRow[] = [];
  for (const k of order) {
    const g = groups.get(k)!;
    const tickets = new Set(g.map((i) => i.ticketId));
    if (tickets.size < 2) {
      out.push(...g.map((i) => row(i)));
      continue;
    }
    const newest = [...g].sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0))[0];
    const labels = new Set(g.map((i) => i.label.trim().toLowerCase()));
    const n = tickets.size;
    const what = labels.size === 1 ? `${n} runs ${lower(g[0].label.trim())}` : `${n} runs wait on you`;
    out.push({ ...row(newest, n), title: titleStem(newest.title)!, label: what });
  }
  return out;
}

/** "12 Oct" (this Mac's time zone). */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}`;
}

/** Rows under board headings, in first-seen board order. */
export function byBoard<T extends { board: string; boardName: string }>(rows: T[]): { board: string; boardName: string; rows: T[] }[] {
  const out: { board: string; boardName: string; rows: T[] }[] = [];
  for (const r of rows) {
    const g = out.find((x) => x.board === r.board);
    if (g) g.rows.push(r);
    else out.push({ board: r.board, boardName: r.boardName, rows: [r] });
  }
  return out;
}

/** "27 more still wait on you, oldest from 12 Oct." */
export function stillLine(count: number, oldestAt: string | null, more: boolean): string {
  const verb = count === 1 ? "waits" : "wait";
  return `${count}${more ? " more" : ""} still ${verb} on you${oldestAt ? `, oldest from ${shortDate(oldestAt)}` : ""}.`;
}

export interface SummaryBuild {
  headline: string;
  fresh: SummaryInput[];
  still: SummaryInput[];
  checkins: SummaryInput[];
  olderCheckins: number;
  /** Closing lines (the first summary's greeting, the check-in offer). */
  notes: string[];
  /** Show board headings (the user has 2 or more boards, or the rows span 2 or more). */
  boards: boolean;
  now: number;
}

/** The summary's text and its page view. */
export function buildSummary(b: SummaryBuild): { text: string; view: SummaryView } {
  const stale = b.fresh.filter((i) => b.now - Date.parse(i.since) > STALE_MS);
  const listed = b.fresh.filter((i) => !stale.includes(i));
  const fresh = collapseRuns(listed);
  const still = [...stale, ...b.still].map((i) => row(i)).sort((a, b2) => (a.since! < b2.since! ? -1 : a.since! > b2.since! ? 1 : 0));
  const oldestAt = still.find((r) => r.since && Number.isFinite(Date.parse(r.since)))?.since ?? null;
  const checkins = b.checkins.map((i) => row(i));
  const view: SummaryView = { new: fresh, still, stillCount: still.length, oldestAt, checkins, olderCheckins: b.olderCheckins, notes: b.notes, grouped: b.boards };
  const line = (r: SummaryRow) => `- ${cut(`${r.title}: ${r.label}`, ROW_MAX)}`;
  const block = (rows: SummaryRow[]) => (b.boards ? byBoard(rows).map((g) => [g.boardName, ...g.rows.map(line)].join("\n")) : [rows.map(line).join("\n")]);
  const parts: string[] = [b.headline];
  if (fresh.length) parts.push(...block(fresh));
  if (still.length) parts.push(stillLine(still.length, oldestAt, fresh.length > 0));
  if (checkins.length || b.olderCheckins) {
    const rows = checkins.map(line);
    if (b.olderCheckins) rows.push(`+${b.olderCheckins} older from check-ins`);
    parts.push(["From your check-ins:", ...rows].join("\n"));
  }
  parts.push(...b.notes);
  return { text: parts.filter(Boolean).join("\n\n"), view };
}
