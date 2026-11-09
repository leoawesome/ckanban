// Wait records: one per (ticket, thing it waits on), kept on disk in `<root>/waits.json` so the helper's bookkeeping
// (who was told, when, which reminders are due) survives restarts. Pure bookkeeping: nothing here sends anything.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttentionKind } from "../attention";

/** What a record waits on: a "needs you" kind, or a message a ticket's Claude passed to the helper (notify_user). */
export type WaitKind = AttentionKind | "message";

/** How a record was told to the user. helper: in a helper message; direct: the board sent it itself (helper off or failing, fallback); digest: in a fallback digest; seed / restart: never sent (already waiting at upgrade with no helper, or helper off at restart). */
export type ToldVia = "helper" | "direct" | "digest" | "seed" | "restart";

/** Why a record closed. */
export type CloseWhy = "cleared" | "answered" | "deleted" | "opened" | "expired";

/** One planned reminder step (the helper plans them; the board fires them). */
export interface ReminderStep {
  channel: string;
  dueAt: string;
  sentAt?: string | null;
  /** Overdue when a later step fired (after sleep or a snooze): not sent, never sent. */
  skipped?: boolean;
  /** Sent, but no channel reached the user (the record stays untold until a later step or send gets through). */
  failed?: boolean;
  /** The message id the step sent, once sent. */
  messageId?: string | null;
}

export interface WaitRecord {
  /** `<board>/<ticket>|<identity>` (see waitIdentity); a closed record that came back is kept as `<key>#<since>`. */
  key: string;
  board: string;
  ticketId: string;
  kind: WaitKind;
  /** The question text (all questions of the form, one per line), Claude's message, or the attention label. */
  question: string;
  /** The attention label when it started, e.g. "Answer 2 questions". */
  label: string;
  /** When the ticket started waiting (attention since). */
  since: string;
  /** When the board opened this record. */
  queuedAt: string;
  /** Waiting when the board first ran with records (fresh install or upgrade): no 5-minute fallback, it goes into the helper's first summary. */
  seeded?: boolean;
  /** Set by the asking ticket (ask_questions / notify_user urgent and why). */
  urgent?: boolean;
  why?: string | null;
  toldAt: string | null;
  toldVia: ToldVia | null;
  /** The message that told it. */
  messageId?: string | null;
  /** The helper holds it until then (for a summary); informational for the board. */
  heldUntil?: string | null;
  /** Due times. fallbackAt: direct send if no helper run succeeded since queuedAt. digestAt: fallback digest if still untold. */
  fallbackAt: string | null;
  digestAt: string | null;
  /** The helper's next wake as it planned it for this record (informational; the runner owns the wake). */
  wakeAt?: string | null;
  reminders: ReminderStep[];
  /** Reminders stop after this time (the hard expiry). */
  remindUntil?: string | null;
  /** Steps sent by earlier alerts on this wait (an alert that reached no one, then a retry): the 6-step cap is per wait. */
  stepsUsed?: number;
  /** Why reminders stopped early: "got-it", "not-urgent", "opened", "answered", "expired", "off", "deleted". */
  remindersStopped?: string | null;
  /** The user opened the ticket after this record was queued. */
  openedAt?: string | null;
  closedAt: string | null;
  closedWhy?: CloseWhy | null;
}

export interface WaitsFile {
  version: 1;
  records: Record<string, WaitRecord>;
  /** notify_user's per-ticket limit: when each `<board>/<ticket>` last reached the user (ms). */
  notifyUserAt: Record<string, number>;
  /** The board told the user about these seeded records' existence in no message yet: the helper's first summary takes them. */
  firstSummaryPending?: boolean;
}

/** How the waits file was found at start-up. */
export type WaitsStart = "missing" | "present" | "corrupt";

/** Closed records are kept this long (message pages name them), then dropped. */
export const CLOSED_KEEP_MS = 7 * 24 * 3600_000;
/** The board sends a wait itself when no helper run succeeded this long after it was queued. */
export const FALLBACK_MS = 5 * 60_000;
/** ...and never sooner than this after the daemon started (the helper needs a moment to run after a restart). */
export const BOOT_GRACE_MS = 2 * 60_000;
/** A wait no message named this long goes into one fallback digest. */
export const DIGEST_MS = 4 * 3600_000;

/** Lower case, spacing collapsed: the same question asked again (a re-asked form) keeps its record. */
export function normalizeQuestion(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function questionHash(text: string): string {
  return createHash("sha256").update(normalizeQuestion(text)).digest("hex").slice(0, 16);
}

/**
 * What makes a wait "the same wait" for a ticket. Questions with a form: the hash of the question text (a second,
 * different question is a new wait; the same form asked again is not). A message passed on with notify_user: the
 * hash of its text. Other kinds: the kind, held while it lasts (a review stays the same wait while the user chats on
 * it). A wait that ends and comes back (failed again after a re-run) opens a new record: the old one is closed and
 * archived under its key plus its start time (since), see WaitStore.add.
 */
export function waitIdentity(kind: WaitKind, question?: string | null): string {
  if (kind === "questions" && question) return `q:${questionHash(question)}`;
  if (kind === "message" && question) return `m:${questionHash(question)}`;
  return kind;
}

export const recordKey = (board: string, ticketId: string, identity: string) => `${board}/${ticketId}|${identity}`;

/** What opening a record needs; the rest is filled in. */
export interface NewWait {
  board: string;
  ticketId: string;
  kind: WaitKind;
  identity: string;
  question: string;
  label: string;
  since: string;
  urgent?: boolean;
  why?: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const emptyFile = (): WaitsFile => ({ version: 1, records: {}, notifyUserAt: {} });

/** The waits file: records keyed on recordKey, written with temp file plus rename on every change. */
export class WaitStore {
  private data: WaitsFile = emptyFile();
  readonly file: string;
  /** How the file was found when loaded. */
  readonly start: WaitsStart;
  /** When the daemon started (fallbacks wait at least BOOT_GRACE_MS after it). */
  readonly bootAt: number;

  constructor(root: string, private now: () => number = Date.now) {
    this.file = join(root, "waits.json");
    this.bootAt = now();
    this.start = this.load();
  }

  private load(): WaitsStart {
    if (!existsSync(this.file)) return "missing";
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      if (!v || typeof v !== "object" || !v.records || typeof v.records !== "object") throw new Error("no records");
      this.data = { version: 1, records: normalizeRecords(v.records), notifyUserAt: v.notifyUserAt && typeof v.notifyUserAt === "object" ? v.notifyUserAt : {}, firstSummaryPending: !!v.firstSummaryPending };
      return "present";
    } catch (e) {
      // Set it aside (never treated as an upgrade: current waits get normal records).
      const aside = `${this.file}.corrupt-${this.now()}`;
      try {
        renameSync(this.file, aside);
      } catch {}
      console.warn(`helper: waits.json could not be read (${(e as Error).message}); set aside as ${aside}`);
      return "corrupt";
    }
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1) + "\n");
    renameSync(tmp, this.file);
  }

  get firstSummaryPending(): boolean {
    return !!this.data.firstSummaryPending;
  }

  set firstSummaryPending(v: boolean) {
    this.data.firstSummaryPending = v;
    this.save();
  }

  get(key: string): WaitRecord | undefined {
    return this.data.records[key];
  }

  /**
   * The record a message's item meant: the wait under `key` (or one archived from it as `<key>#<since>`) that this
   * message told or reminded about, else the one that was live when the message went out. A wait that closed and came
   * back reuses its key, so a tap on an old message must not reach the newer wait (or one opened after the message).
   */
  forMessage(key: string, message: { id: string; at: string }): WaitRecord | undefined {
    const recs = Object.values(this.data.records).filter((r) => r.key === key || r.key.startsWith(`${key}#`));
    const linked = recs.find((r) => r.messageId === message.id || r.reminders.some((s) => s.messageId === message.id));
    if (linked) return linked;
    const at = Date.parse(message.at);
    return recs
      .filter((r) => !(Date.parse(r.queuedAt) > at))
      .sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt))[0];
  }

  /** Every record, open and closed. */
  all(): WaitRecord[] {
    return Object.values(this.data.records);
  }

  open(): WaitRecord[] {
    return this.all().filter((r) => !r.closedAt);
  }

  openFor(board: string, ticketId?: string): WaitRecord[] {
    return this.open().filter((r) => r.board === board && (ticketId === undefined || r.ticketId === ticketId));
  }

  /** The 5-minute fallback time for a record queued now: queuedAt + FALLBACK_MS, not before boot + BOOT_GRACE_MS. */
  fallbackFor(queuedMs: number): string {
    return iso(Math.max(queuedMs + FALLBACK_MS, this.bootAt + BOOT_GRACE_MS));
  }

  /**
   * Opens a record (or returns the open one with that key). seeded: waiting at first start (no fallback, first summary).
   * told: already told another way (helper off at restart, upgrade without a helper).
   */
  add(w: NewWait, o: { seeded?: boolean; told?: ToldVia } = {}): WaitRecord {
    const key = recordKey(w.board, w.ticketId, w.identity);
    const have = this.data.records[key];
    if (have && !have.closedAt) {
      // A later urgent mark on the same wait counts.
      if (w.urgent && !have.urgent) {
        have.urgent = true;
        have.why = w.why ?? have.why ?? null;
        this.save();
      }
      return have;
    }
    // The same wait came back (failed again, re-asked after an answer): keep the closed one under its start time.
    if (have) {
      delete this.data.records[key];
      this.data.records[`${key}#${have.since}`] = { ...have, key: `${key}#${have.since}` };
    }
    const now = this.now();
    const rec: WaitRecord = {
      key, board: w.board, ticketId: w.ticketId, kind: w.kind, question: w.question, label: w.label, since: w.since, queuedAt: iso(now),
      ...(o.seeded ? { seeded: true } : {}),
      ...(w.urgent ? { urgent: true } : {}), why: w.why ?? null,
      toldAt: o.told ? iso(now) : null, toldVia: o.told ?? null,
      fallbackAt: o.seeded || o.told ? null : this.fallbackFor(now),
      digestAt: o.seeded || o.told ? null : iso(now + DIGEST_MS),
      reminders: [], closedAt: null,
    };
    this.data.records[key] = rec;
    this.prune();
    this.save();
    return rec;
  }

  /**
   * Moves an open record to the key of `w` (same wait, now known by its real question), keeping what was told and
   * planned; the question, urgent mark and why come from `w`. Returns it, or undefined when there is nothing to move
   * (no open record under `from`, or one is already open under the new key).
   */
  rekey(from: string, w: NewWait): WaitRecord | undefined {
    const r = this.data.records[from];
    const key = recordKey(w.board, w.ticketId, w.identity);
    if (!r || r.closedAt || key === from || this.data.records[key]?.closedAt === null) return undefined;
    const prev = this.data.records[key];
    if (prev) this.data.records[`${key}#${prev.since}`] = { ...prev, key: `${key}#${prev.since}` };
    delete this.data.records[from];
    const moved: WaitRecord = { ...r, key, question: w.question, label: w.label, ...(w.urgent ? { urgent: true } : {}), why: w.why ?? r.why ?? null };
    this.data.records[key] = moved;
    this.save();
    return moved;
  }

  /** Changes a record (by key) and saves; returns it, or undefined when there is none. */
  update(key: string, patch: Partial<WaitRecord>): WaitRecord | undefined {
    const r = this.data.records[key];
    if (!r) return undefined;
    Object.assign(r, patch);
    this.save();
    return r;
  }

  /** Marks records told (nothing sends them again: no fallback, no digest). */
  markTold(keys: string[], via: ToldVia, messageId?: string | null): void {
    const at = iso(this.now());
    let changed = false;
    for (const k of keys) {
      const r = this.data.records[k];
      if (!r || r.toldAt) continue;
      Object.assign(r, { toldAt: at, toldVia: via, messageId: messageId ?? null, fallbackAt: null, digestAt: null });
      changed = true;
    }
    if (changed) this.save();
  }

  /**
   * Gives back a claim (markTold before a send) when the send reached no one: the records are untold again, with the
   * fallback and digest times they had, so a later message or the 4-hour digest still tells them.
   */
  unclaim(prev: Pick<WaitRecord, "key" | "toldAt" | "toldVia" | "fallbackAt" | "digestAt">[]): void {
    let changed = false;
    for (const p of prev) {
      const r = this.data.records[p.key];
      if (!r || p.toldAt || r.closedAt) continue;
      Object.assign(r, { toldAt: null, toldVia: null, fallbackAt: p.fallbackAt, digestAt: p.digestAt });
      changed = true;
    }
    if (changed) this.save();
  }

  /** Stops a record's pending reminder steps (why: see WaitRecord.remindersStopped). */
  stopReminders(key: string, why: string): boolean {
    const r = this.data.records[key];
    if (!r || !pending(r)) return false;
    r.reminders = r.reminders.filter((s) => s.sentAt);
    r.remindersStopped = why;
    this.save();
    return true;
  }

  close(keys: string[], why: CloseWhy): WaitRecord[] {
    const at = iso(this.now());
    const out: WaitRecord[] = [];
    for (const k of keys) {
      const r = this.data.records[k];
      if (!r || r.closedAt) continue;
      if (pending(r)) {
        r.reminders = r.reminders.filter((s) => s.sentAt);
        r.remindersStopped = why;
      }
      Object.assign(r, { closedAt: at, closedWhy: why, fallbackAt: null, digestAt: null });
      out.push(r);
    }
    if (out.length) this.save();
    return out;
  }

  /** The user opened the ticket: openedAt on its open records, their reminders stop; passed-on messages close. */
  opened(board: string, ticketId: string): WaitRecord[] {
    const at = iso(this.now());
    const recs = this.openFor(board, ticketId);
    for (const r of recs) {
      r.openedAt = at;
      if (pending(r)) {
        r.reminders = r.reminders.filter((s) => s.sentAt);
        r.remindersStopped = "opened";
      }
    }
    if (recs.length) this.save();
    this.close(recs.filter((r) => r.kind === "message").map((r) => r.key), "opened");
    return recs;
  }

  /** The ticket has a reminder step still to come. */
  hasPendingReminder(board: string, ticketId: string): boolean {
    return this.openFor(board, ticketId).some(pending);
  }

  /** notify_user's limit, on disk. */
  lastNotifyUser(board: string, ticketId: string): number | undefined {
    return this.data.notifyUserAt[`${board}/${ticketId}`];
  }

  setNotifyUser(board: string, ticketId: string, at: number): void {
    this.data.notifyUserAt[`${board}/${ticketId}`] = at;
    this.save();
  }

  /** Drops closed records older than CLOSED_KEEP_MS and notify_user stamps older than a day. */
  private prune(): void {
    const cut = this.now() - CLOSED_KEEP_MS;
    for (const [k, r] of Object.entries(this.data.records)) if (r.closedAt && Date.parse(r.closedAt) < cut) delete this.data.records[k];
    const day = this.now() - 24 * 3600_000;
    for (const [k, at] of Object.entries(this.data.notifyUserAt)) if (at < day) delete this.data.notifyUserAt[k];
  }
}

/**
 * Records as read from disk, made safe to use: an old or hand-edited file may miss fields (a record without reminders
 * would make every tick throw). Entries that aren't records are dropped.
 */
export function normalizeRecords(raw: Record<string, unknown>): Record<string, WaitRecord> {
  const out: Record<string, WaitRecord> = {};
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Partial<WaitRecord>;
    const board = str(r.board);
    const ticketId = str(r.ticketId);
    if (!board || !ticketId) continue;
    const reminders = (Array.isArray(r.reminders) ? r.reminders : [])
      .filter((x): x is ReminderStep => !!x && typeof x === "object" && typeof x.channel === "string" && typeof x.dueAt === "string");
    out[k] = {
      ...r, key: k, board, ticketId, kind: (str(r.kind) ?? "message") as WaitKind, question: str(r.question) ?? "", label: str(r.label) ?? "",
      since: str(r.since) ?? str(r.queuedAt) ?? new Date(0).toISOString(), queuedAt: str(r.queuedAt) ?? str(r.since) ?? new Date(0).toISOString(),
      toldAt: str(r.toldAt), toldVia: (str(r.toldVia) as ToldVia | null), fallbackAt: str(r.fallbackAt), digestAt: str(r.digestAt),
      reminders, closedAt: str(r.closedAt),
    };
  }
  return out;
}

/** A reminder step not sent yet, and the expiry not passed. */
export function pending(r: WaitRecord): boolean {
  return r.reminders.some((s) => !s.sentAt);
}
