// A feature's status ("Where we are" in status.md): shown at the top of its main ticket's Tasks tab, with a one-line
// "Waiting on you" in its chat.
// Claude writes the words (goal, done, broken, waiting on you, next step, a note per pull request) with update_status;
// the board adds the facts it knows from ticket data (counts per group, test results per round, pull requests). Both
// are saved in the top ticket's outputs folder: status.json (what the block renders from) and status.md (to read).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childrenByParent, familyOf, familyState, settled, STATE_WORDS, type FamilyState } from "../../web/src/family";
import { ticketPrs } from "./prs";
import type { Ticket } from "./types";

/** The sections Claude writes, in the block's order (Pull requests sits between waiting and next). */
export const STATUS_FIELDS = ["goal", "done", "broken", "waiting", "next"] as const;
export type StatusField = (typeof STATUS_FIELDS)[number];
export const STATUS_FIELD_MAX = 2000;
export const STATUS_NOTE_MAX = 2000;
/** Said where a section was longer than its limit, so it never just ends mid-word. */
export const CUT_SHORT = "… (cut short)";

/** Cuts text to max at a word break with CUT_SHORT at the end (text that fits comes back as is). */
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  const room = s.slice(0, max - CUT_SHORT.length);
  const space = room.search(/\s\S*$/);
  const cut = space > room.length - 80 ? room.slice(0, space) : room;
  return `${cut.trimEnd().replace(/[\s,;:(]+$/, "")}${CUT_SHORT}`;
}

/** The line every commit of a feature's tickets ends with, so the board can list the feature's saved changes. */
export const FEATURE_TRAILER = "Ckanban-Feature";
/** Saved changes shown in "Where we are" before "and N more" (the full list is in SAVED_CHANGES_FILE). */
export const CHANGES_SHOWN = 30;
export const SAVED_CHANGES_FILE = "saved-changes.md";

/**
 * The feature's saved changes, built by the board: entries in the version history that carry the feature's line
 * (newest first, so also the order to undo them in), or for a folder without version history the files its tickets
 * changed. file: where the full list is (written when there are more than CHANGES_SHOWN).
 */
export interface SavedChanges {
  kind: "history" | "files";
  items: { id?: string; text: string }[];
  file?: string;
}

export interface StatusNote {
  at: string;
  text: string;
  /** Claude in the main chat got it (at its next turn). */
  delivered?: boolean;
}

export interface SavedStatus extends Partial<Record<StatusField, string | null>> {
  /** Claude's note per pull request URL, e.g. "on staging". */
  prNotes?: Record<string, string>;
  /** "Add a note": what the user added from outside the board, oldest first. */
  notes?: StatusNote[];
  /** Any change (Claude's or a note). */
  updatedAt: string;
  /** Claude's last update_status. */
  claudeAt?: string | null;
  /** The family as it was at Claude's last update_status (familySig): the board nudges once it has changed. */
  familySig?: string | null;
  /** Milestones the main ticket landed (land_milestone), oldest first. */
  milestones?: { at: string; summary: string; landed: string }[];
}

export type StatusPatch = Partial<Record<StatusField, string | null>> & { prNotes?: Record<string, string | null> };

export interface GroupFacts {
  id: string;
  title: string;
  kind: string | null;
  total: number;
  counts: Partial<Record<FamilyState, number>>;
  /** Every child is Done, Passed or Found a problem. */
  settled: boolean;
}

export interface PrFact {
  url: string;
  number: number | null;
  state: "open" | "merged" | "closed" | "unknown";
  ticketId: string;
  ticketTitle: string;
  note?: string;
}

export interface StatusFacts {
  /** Tickets in the family, the top one included. */
  size: number;
  /** Counts over the family below the top ticket. */
  counts: Partial<Record<FamilyState, number>>;
  /** Level-1 tickets that hold others (or are of kind group or round). */
  groups: GroupFacts[];
  /** Level-1 tickets that are no group, counted together. */
  loose: { total: number; counts: Partial<Record<FamilyState, number>> };
  /** Test results per round (rounds and groups whose children are tests). */
  rounds: { id: string; title: string; passed: number; problem: number; open: number }[];
  /** Tickets that failed or found a problem (reason: one plain line on why), and ones that need the user. */
  broken: { id: string; title: string; state: FamilyState; reason?: string }[];
  /** Tickets waiting on the usage limit (not working now): resumeAt is when it resets, auto when the board continues then. */
  paused: { id: string; title: string; resumeAt: string | null; auto: boolean }[];
  needsYou: { id: string; title: string }[];
  prs: PrFact[];
  /** Filled in by the board (Board.savedChanges); missing or null when there are none yet. */
  changes?: SavedChanges | null;
}

export const statusFiles = (outputsDir: string) => ({ json: join(outputsDir, "status.json"), md: join(outputsDir, "status.md") });

export function readStatus(outputsDir: string): SavedStatus | null {
  const { json } = statusFiles(outputsDir);
  if (!existsSync(json)) return null;
  try {
    const v = JSON.parse(readFileSync(json, "utf8"));
    if (!v || typeof v !== "object" || typeof v.updatedAt !== "string") return null;
    // Saved before sections said where they were cut: one exactly at the limit was cut mid-word.
    for (const f of STATUS_FIELDS) {
      if (typeof v[f] === "string" && v[f].length >= STATUS_FIELD_MAX && !v[f].endsWith(CUT_SHORT)) v[f] = clipText(`${v[f]}…`, STATUS_FIELD_MAX);
    }
    return v;
  } catch {
    return null;
  }
}

/** What the family looks like for the nudge: who is in it, each one's column, outcome, verdict and pull request states. */
export function familySig(rows: Ticket[]): string {
  return rows.map((t) => `${t.id}:${t.status}:${t.outcome ?? ""}:${t.verdict ?? ""}:${ticketPrs(t).map((p) => p.state ?? "").join(",")}`).sort().join("|");
}

const add = (c: Partial<Record<FamilyState, number>>, s: FamilyState) => {
  c[s] = (c[s] ?? 0) + 1;
};

const lastLine = (s: string | null | undefined) => (s ?? "").trim().split("\n").findLast((l) => l.trim())?.trim() ?? "";
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * Why a ticket failed or found a problem, in one plain line: a failure's last error line (else its last result's
 * summary), a cap it stopped at, or a test's last result summary. results: result cards from the family, oldest first.
 */
export function brokenReason(t: Ticket, results: { ticketId: string; summary: string }[]): string | undefined {
  if (t.outcome === "blocked" && t.capHit) return `Stopped at its $${t.capHit.capUsd.toFixed(2)} cap.`;
  const summary = lastLine(results.findLast((r) => r.ticketId === t.id)?.summary);
  const error = lastLine(t.error);
  const why = t.outcome === "failed" ? error || summary : summary || error;
  return why ? clip(why, 160) : undefined;
}

const prNumber = (url: string) => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? NaN) || null;

/** The board's facts for the feature topId (its family from tickets). needsYou: the board's attention says Your turn. */
export function statusFacts(tickets: Ticket[], topId: string, needsYou: (t: Ticket) => boolean, prNotes: Record<string, string> = {}): StatusFacts {
  const rows = familyOf(tickets, topId);
  const kids = childrenByParent(tickets);
  const stateOf = new Map(rows.map((r) => [r.ticket.id, familyState(r.ticket, needsYou(r.ticket))]));
  const counts: StatusFacts["counts"] = {};
  const groups: GroupFacts[] = [];
  const loose: StatusFacts["loose"] = { total: 0, counts: {} };
  const rounds: StatusFacts["rounds"] = [];
  const below = (id: string): Ticket[] => (kids.get(id) ?? []).flatMap((c) => [c.ticket, ...below(c.ticket.id)]);
  for (const r of rows.slice(1)) add(counts, stateOf.get(r.ticket.id)!);
  for (const r of rows.filter((x) => x.depth === 1)) {
    const t = r.ticket;
    const inside = below(t.id);
    if (!inside.length && t.kind !== "group" && t.kind !== "round") {
      loose.total++;
      add(loose.counts, stateOf.get(t.id)!);
      continue;
    }
    const c: GroupFacts["counts"] = {};
    for (const k of inside) add(c, stateOf.get(k.id)!);
    groups.push({ id: t.id, title: t.title, kind: t.kind ?? null, total: inside.length, counts: c, settled: inside.every((k) => settled(stateOf.get(k.id)!)) });
    const tests = inside.filter((k) => k.kind === "test");
    if (t.kind === "round" || (tests.length && tests.length === inside.length)) {
      const verdicts = tests.map((k) => stateOf.get(k.id)!);
      rounds.push({
        id: t.id, title: t.title,
        passed: verdicts.filter((s) => s === "passed").length,
        problem: verdicts.filter((s) => s === "problem").length,
        open: verdicts.filter((s) => !settled(s)).length,
      });
    }
  }
  // A problem an earlier round found is history (later work fixed it or not; the newest round tells): only the newest
  // round's problems, tests outside rounds and failed tickets count as broken now.
  const newest = rounds.at(-1)?.id;
  const results = rows.flatMap((r) => r.ticket.results ?? []).sort((a, b) => a.at.localeCompare(b.at));
  const roundOf = new Map<string, string>();
  for (const g of rounds) for (const k of below(g.id)) roundOf.set(k.id, g.id);
  const broken = rows.slice(1)
    .filter((r) => stateOf.get(r.ticket.id) === "failed" || (stateOf.get(r.ticket.id) === "problem" && (!roundOf.has(r.ticket.id) || roundOf.get(r.ticket.id) === newest)))
    .map((r) => {
      const reason = brokenReason(r.ticket, results);
      return { id: r.ticket.id, title: r.ticket.title, state: stateOf.get(r.ticket.id)!, ...(reason ? { reason } : {}) };
    });
  const paused = rows.slice(1)
    .filter((r) => stateOf.get(r.ticket.id) === "paused" && r.ticket.status !== "ready" && r.ticket.status !== "in_progress")
    .map((r) => ({ id: r.ticket.id, title: r.ticket.title, resumeAt: r.ticket.limit?.resetAt ?? null, auto: !!r.ticket.limit?.auto }));
  const waiting = rows.slice(1).filter((r) => stateOf.get(r.ticket.id) === "needs_you").map((r) => ({ id: r.ticket.id, title: r.ticket.title }));
  const prs: PrFact[] = rows.flatMap((r) => ticketPrs(r.ticket).map((p) => ({
    url: p.url, number: prNumber(p.url), state: (p.state?.toLowerCase() ?? "unknown") as PrFact["state"], ticketId: r.ticket.id, ticketTitle: r.ticket.title,
    ...(prNotes[p.url] ? { note: prNotes[p.url] } : {}),
  })));
  return { size: rows.length, counts, groups, loose, rounds, broken, paused, needsYou: waiting, prs };
}

/** Applies Claude's update: only the sections it names change (null or "" clears one). */
export function applyPatch(saved: SavedStatus | null, patch: StatusPatch, now: string, sig: string): SavedStatus {
  const next: SavedStatus = { ...(saved ?? {}), updatedAt: now, claudeAt: now, familySig: sig };
  for (const f of STATUS_FIELDS) {
    if (!(f in patch)) continue;
    const v = patch[f];
    if (typeof v === "string" && v.trim()) next[f] = clipText(v.trim(), STATUS_FIELD_MAX);
    else delete next[f];
  }
  if (patch.prNotes) {
    const notes = { ...(saved?.prNotes ?? {}) };
    for (const [url, v] of Object.entries(patch.prNotes)) {
      if (typeof v === "string" && v.trim()) notes[url] = clipText(v.trim(), 200);
      else delete notes[url];
    }
    next.prNotes = notes;
  }
  return next;
}

const countWords = (c: Partial<Record<FamilyState, number>>, total: number): string => {
  const done = (c.done ?? 0) + (c.passed ?? 0) + (c.problem ?? 0);
  const rest = (["working", "waiting", "needs_you", "failed", "paused"] as FamilyState[])
    .filter((s) => c[s]).map((s) => `${c[s]} ${s === "needs_you" ? "need you" : STATE_WORDS[s].toLowerCase()}`);
  return [`${done} of ${total} done`, ...rest].join(", ");
};

/** The heading of the saved changes list. */
export const changesLabel = (c: Pick<SavedChanges, "kind">) =>
  c.kind === "history" ? "Saved changes (newest first; undo in this order)" : "Files changed in your folder";

/** The full list for SAVED_CHANGES_FILE. */
export function savedChangesMarkdown(top: Pick<Ticket, "id" | "title">, c: SavedChanges): string {
  return [`# ${changesLabel(c)}: ${top.title}`, "", ...c.items.map((i) => `- ${i.id ? `${i.id} ` : ""}${i.text}`), ""].join("\n");
}

/** The block's sections as plain lines, in order; empty ones left out. */
export function statusSections(saved: SavedStatus | null, f: StatusFacts): { key: string; label: string; text: string }[] {
  const out: { key: string; label: string; text: string }[] = [];
  const push = (key: string, label: string, ...parts: (string | null | undefined)[]) => {
    const text = parts.filter((p) => p && p.trim()).join(" ");
    if (text) out.push({ key, label, text });
  };
  push("goal", "Goal", saved?.goal);
  const doneGroups = f.groups.filter((g) => g.settled && g.total).map((g) => {
    const r = f.rounds.find((x) => x.id === g.id);
    return r ? `${g.title} (${r.passed} passed${r.problem ? `, ${r.problem} found a problem` : ""})` : `${g.title} (${g.total} done)`;
  });
  const looseDone = (f.loose.counts.done ?? 0) + (f.loose.counts.passed ?? 0) + (f.loose.counts.problem ?? 0);
  const doneFacts = [...doneGroups, ...(looseDone ? [`${looseDone} other ticket${looseDone === 1 ? "" : "s"} done`] : [])];
  push("done", "Done", doneFacts.length ? `[${doneFacts.join("; ")}]` : null, saved?.done);
  const running = f.groups.filter((g) => !g.settled && g.total).map((g) => {
    const r = f.rounds.find((x) => x.id === g.id);
    return `${g.title}: ${countWords(g.counts, g.total)}${r && (r.passed || r.problem) ? ` (${r.passed} passed, ${r.problem} found a problem)` : ""}.`;
  });
  const looseActive = (["working", "waiting", "needs_you", "paused"] as FamilyState[]).some((x) => f.loose.counts[x]);
  if (looseActive) running.push(`Other tickets: ${countWords(f.loose.counts, f.loose.total)}.`);
  push("running", "Running", running.join(" "));
  const brokenFacts = f.broken.length ? `[${f.broken.length}: ${f.broken.map((b) => `${b.title} (${STATE_WORDS[b.state].toLowerCase()}${b.reason ? `: ${b.reason}` : ""})`).join("; ")}]` : null;
  push("broken", "Broken", brokenFacts, saved?.broken);
  const youFacts = f.needsYou.length ? `[${f.needsYou.length}: ${f.needsYou.map((b) => b.title).join("; ")}]` : null;
  push("waiting", "Waiting on you", youFacts, saved?.waiting);
  push("prs", "Pull requests", f.prs.map((p) => `${p.number ? `#${p.number}` : p.url} ${p.ticketTitle} · ${p.state === "open" ? "open" : p.state}${p.note ? ` · ${p.note}` : ""}`).join("\n"));
  push("milestones", "Milestones landed", (saved?.milestones ?? []).slice(-5).map((m) => `${m.at.slice(0, 10)}: ${m.summary} (${m.landed})`).join("\n"));
  if (f.changes?.items.length) {
    const c = f.changes;
    const shown = c.items.slice(0, CHANGES_SHOWN).map((i) => (i.id ? `${i.id} ${i.text}` : i.text));
    const more = c.items.length - shown.length;
    if (more > 0) shown.push(`…and ${more} more${c.file ? `: the full list is in ${c.file}` : ""}`);
    push("changes", changesLabel(c), shown.join("\n"));
  }
  push("next", "Next step", saved?.next);
  return out;
}

/** status.md: the combined status for Claude and the user to read as a file. */
export function statusMarkdown(top: Pick<Ticket, "id" | "title">, saved: SavedStatus | null, f: StatusFacts): string {
  const lines = [`# Where we are: ${top.title}`, "", `Feature ticket ${top.id}, ${f.size} tickets. Updated ${saved?.updatedAt ?? "never"}.`, ""];
  for (const s of statusSections(saved, f)) {
    lines.push(`## ${s.label}`, "", s.key === "prs" || s.key === "milestones" || s.key === "changes" ? s.text.split("\n").map((l) => `- ${l}`).join("\n") : s.text, "");
  }
  if (saved?.notes?.length) {
    lines.push("## Notes from the user", "", ...saved.notes.map((n) => `- ${n.at.slice(0, 10)}: ${n.text}`), "");
  }
  lines.push("Counts, test results, pull requests and saved changes come from the board (counts in [brackets]); the rest is written with update_status.", "");
  return lines.join("\n");
}

/** Writes status.json (only with saved) and status.md; returns the markdown. */
export function writeStatus(outputsDir: string, top: Pick<Ticket, "id" | "title">, saved: SavedStatus | null, f: StatusFacts, writeJson: boolean): string {
  const { json, md } = statusFiles(outputsDir);
  if (writeJson && saved) {
    writeFileSync(`${json}.tmp`, JSON.stringify(saved, null, 2));
    renameSync(`${json}.tmp`, json);
  }
  const text = statusMarkdown(top, saved, f);
  let old = "";
  try {
    old = readFileSync(md, "utf8");
  } catch {}
  if (old !== text) writeFileSync(md, text);
  return text;
}
