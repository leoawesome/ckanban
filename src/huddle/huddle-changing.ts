// Huddles: changing a huddle: saving, appending messages, creating (methods of the Huddles class in huddle.ts, split by topic).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { planProposal } from "./plan-review-file";
import { type SessionEntry } from "../runs/session";
import { activeHost, DEFAULT_MAX_PARTICIPANTS, MAIN_HANDLE, parseMentions, proposalFile, rosterError, USER_HANDLE, type RosterEntry } from "./huddle-roster";
import { MAIN_PRESET } from "./huddle-presets";
import { customReviewBrief, type HuddleTemplate, templateBrief, topicInput } from "./huddle-templates";
import { ticketTopic } from "./squad";
import type { Huddle, HuddleMessage, HuddleMessageKind, HuddleParticipant, HuddleSource, Ticket } from "../core/types";
import { newId, nowIso } from "../core/util";
import type { Huddles } from "./huddle";
import { HuddleError, DEFAULT_MAX_COST_USD, money, sessionEntries } from "./huddle-types";

/** Read, change and save a huddle in one step (nothing else runs in between), then tell the UI. */
export function update(this: Huddles, slug: string, hid: string, fn: (h: Huddle) => void): Huddle {
  const h = this.get(slug, hid);
  const before = h.host && h.status === "live" ? activeHost(h) : null;
  const was = h.participants.find((x) => x.handle === h.host)?.status;
  fn(h);
  h.updatedAt = nowIso();
  this.save(slug, h);
  this.bus.emit({ type: "huddle.updated", profile: slug, huddle: this.view(slug, h) });
  const after = h.host && h.status === "live" ? activeHost(h) : null;
  // After the caller's own note (stopped, failed…), so the room reads in order.
  if (before && after && before !== after && !this.shuttingDown) queueMicrotask(() => this.hostMoved(slug, hid, after, was));
  return h;
}

/**
 * The host stopped, blocked or failed, so @main runs the huddle again and is tagged; or the host is back. A host
 * turning done (its final report already tagged @main) or waking from done gets no note. was: its status before.
 * Checked again here, in case it changed since.
 */
export function hostMoved(this: Huddles, slug: string, hid: string, now: string, was?: string) {
  const h = this.load(slug, hid);
  const p = h?.participants.find((x) => x.handle === h.host);
  if (!h || !p || h.status !== "live" || activeHost(h) !== now) return;
  if (now === p.handle) return void (was !== "done" && this.system(slug, hid, `@${p.handle} is back and runs the huddle again.`));
  if (p.status === "done") return;
  const why = p.statusReason || (p.status === "failed" ? p.error : null);
  this.system(slug, hid,
    `@${p.handle} (the host) is ${p.status}${why ? `: ${why}` : ""}. @main runs the huddle again: the idle watchdog, the notes, the budget warnings and the hand-ins go to @main until @${p.handle} is back.`,
    [MAIN_HANDLE]);
}

/** What an agent's turn in progress cost so far (≈); 0 between turns. */
export function turnCost(this: Huddles, slug: string, hid: string, handle: string): number {
  const turn = this.runs.get(this.key(slug, hid, handle))?.turn;
  return turn ? [...turn.values()].reduce((a, b) => a + b, 0) : 0;
}

export function updateP(this: Huddles, slug: string, hid: string, handle: string, patch: Partial<HuddleParticipant>): void {
  if (!this.load(slug, hid)) return;
  // Only what it is doing now and its conversation size (many times a minute): saved, and sent as a small event
  // instead of the whole view.
  if (Object.keys(patch).every((k) => k === "lastActivity" || k === "contextTokens")) {
    const h = this.get(slug, hid);
    const p = h.participants.find((x) => x.handle === handle);
    const liveCostUsd = this.turnCost(slug, hid, handle);
    if (!p) return;
    const changed = (Object.keys(patch) as ("lastActivity" | "contextTokens")[]).some((k) => p[k] !== patch[k]);
    if (!changed && !liveCostUsd) return;
    if (changed) {
      Object.assign(p, patch);
      this.save(slug, h);
    }
    this.bus.emit({
      type: "huddle.activity", profile: slug, huddleId: hid, handle, lastActivity: p.lastActivity ?? null,
      ...(liveCostUsd ? { liveCostUsd } : {}), ...(p.contextTokens ? { contextTokens: p.contextTokens } : {}),
    });
    return;
  }
  this.update(slug, hid, (h) => {
    const p = h.participants.find((x) => x.handle === handle);
    if (p) Object.assign(p, patch);
  });
}

/** known: handles that can be mentioned (plus "all" when allowAll). System messages mention only `known`, given as is. */
export function append(this: Huddles,
  slug: string, hid: string, from: string, text: string, kind: HuddleMessageKind, known: string[], allowAll = false, source?: HuddleSource, handIn?: string,
): HuddleMessage {
  let seq = 0;
  this.update(slug, hid, (h) => {
    seq = h.seq = h.seq + 1;
    // The sender has seen everything up to its own message.
    const p = h.participants.find((x) => x.handle === from);
    if (p && p.cursor === seq - 1) p.cursor = seq;
  });
  const mentions = kind === "system" ? known : parseMentions(text).filter((m) => (m === "all" ? allowAll : known.includes(m)));
  const m: HuddleMessage = { id: `m_${newId()}`, seq, ts: nowIso(), from, text, mentions, kind, ...(source ? { source } : {}), ...(handIn ? { handIn } : {}) };
  this.store.appendHuddleMessage(slug, hid, m);
  this.bus.emit({ type: "huddle.message", profile: slug, huddleId: hid, message: m });
  return m;
}

/** A system message: context only, except that `wake` (the brakes' warnings) are woken by it. */
export function system(this: Huddles, slug: string, hid: string, text: string, wake: string[] = []): HuddleMessage {
  const m = this.append(slug, hid, "system", text, "system", wake);
  const h = this.get(slug, hid);
  if (h.status === "live") for (const p of h.participants) if (this.wakes(h, p, m)) this.wake(slug, h, p, true);
  return m;
}

/**
 * Start a huddle on a ticket from a roster (the user pressed Start on a proposed roster, or made one). template: a
 * template's name; its roster is used when `roster` is empty, its budget unless one is given, and its rules become
 * the pinned brief.
 */
export function create(this: Huddles,
  slug: string, hostId: string, roster: RosterEntry[],
  opts: {
    maxParticipants?: number; maxCostUsd?: number; template?: string; auto?: { reason: string; askedCostUsd?: number; trigger?: string };
    /** The ticket's run started it because the user asked in its chat (see startForUser). */
    byUser?: { reason: string; askedCostUsd?: number };
    /** What this run of the squad is about (the start route, propose_huddle's card); default: the host ticket. */
    topic?: string | null;
  } = {},
): Huddle {
  const host = this.store.getTicket(slug, hostId);
  if (!host) throw new HuddleError(404, `ticket ${hostId} not found`);
  if (host.error?.startsWith("corrupt")) throw new HuddleError(409, `ticket ${hostId} file is corrupt`);
  let tpl: HuddleTemplate | undefined;
  if (opts.template) {
    tpl = this.templates(slug).find((t) => t.name === opts.template!.trim());
    if (!tpl) throw new HuddleError(404, `no huddle template "${opts.template}" (templates: ${this.templates(slug).map((t) => t.name).join(", ")})`);
    if (!roster.length) roster = tpl.roster;
  }
  const max = Math.max(2, Math.min(32, Math.round(opts.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS)));
  if (opts.maxCostUsd !== undefined && !(Number.isFinite(opts.maxCostUsd) && opts.maxCostUsd > 0)) throw new HuddleError(400, "maxCostUsd must be a positive amount");
  const maxCostUsd = opts.maxCostUsd ?? tpl?.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  const asked = opts.auto?.askedCostUsd ?? opts.byUser?.askedCostUsd;
  const budgetNote = opts.maxCostUsd === undefined ? (tpl?.maxCostUsd !== undefined ? " (template default)" : " (default)")
    : asked !== undefined && asked > maxCostUsd ? ` (asked ${money(asked)}, capped at ${money(maxCostUsd)})`
    : opts.auto ? " (asked by the ticket's run)" : opts.byUser ? " (asked by the user)" : "";
  const open = this.store.openHuddles(slug).find((h) => h.hostTicket === hostId);
  if (open) throw new HuddleError(409, `ticket ${hostId} already has an open huddle (${open.id}); close it first`);
  const presets = this.presetMap(slug);
  const err = rosterError(roster, max, [...presets.keys()]);
  if (err) throw new HuddleError(400, err);
  const at = nowIso();
  let topic: string | null;
  try {
    topic = topicInput(opts.topic);
  } catch (e) {
    throw new HuddleError(400, (e as Error).message);
  }
  const hostRules = tpl?.hostRules?.trim() || null;
  // A squad with host rules is about a topic: with none given, the host ticket's.
  const briefTopic = topic ?? (hostRules ? ticketTopic(host) : null);
  const main = presets.get(MAIN_PRESET)!;
  const base = { prompt: "", focus: undefined, sessionId: null, status: "idle" as const, cursor: 0, joinedAt: at, workspace: "shared" as const, preset: null };
  const h: Huddle = {
    id: `h_${newId()}`, hostTicket: hostId, status: "live", maxParticipants: max, findings: [], invited: [], seq: 0,
    maxCostUsd, posts: 0, sinceUser: 0, stopReason: null, createdAt: at, updatedAt: at,
    template: tpl?.name ?? null,
    ...(topic ? { topic } : {}),
    ...(hostRules ? { hostRules } : {}),
    brief: tpl ? { text: templateBrief(tpl, maxCostUsd, briefTopic), by: USER_HANDLE, at }
      : opts.auto ? { text: [customReviewBrief(maxCostUsd), topic ? `Topic: ${topic}` : ""].filter(Boolean).join("\n"), by: USER_HANDLE, at }
      : topic ? { text: `Topic: ${topic}`, by: USER_HANDLE, at } : null,
    ...(opts.auto ? { auto: { reason: opts.auto.reason } } : {}),
    participants: [
      { ...base, handle: USER_HANDLE, role: "User", model: null, mode: "monitor", lead: true, canEdit: false, kind: "human" },
      {
        ...base, handle: MAIN_HANDLE, role: main.role, preset: MAIN_PRESET, prompt: main.prompt, model: null, mode: main.mode, lead: true, canEdit: true,
        kind: "ticket-main", ticketId: hostId,
      },
    ],
  };
  const agents: HuddleParticipant[] = [];
  for (const e of roster) {
    const ps = this.expand(e, h.participants.map((p) => p.handle), presets, true, host.status === "planning");
    h.participants.push(...ps);
    agents.push(...ps);
    if (e.host) h.host = ps[0].handle;
  }
  // Templates and auto huddles run with a host by default: their first lead.
  if (!h.host && (tpl || opts.auto || opts.byUser)) h.host = agents.find((p) => p.lead)?.handle ?? null;
  this.save(slug, h);
  if (host.status === "planning") this.writeProposal(slug, h.id, host);
  this.bus.emit({ type: "huddle.updated", profile: slug, huddle: this.view(slug, h) });
  this.system(slug, h.id, `${opts.auto ? "Auto huddle" : "Huddle"} started on ticket ${hostId} "${host.title}"${opts.auto ? ` by its own run (${opts.auto.trigger ? `${opts.auto.trigger}: ` : ""}${opts.auto.reason})` : opts.byUser ? ` by its own session because the user asked in the chat (${opts.byUser.reason})` : ""}${tpl ? ` from squad ${tpl.label}` : ""} with ${agents.map((p) => `@${p.handle} (${p.role})`).join(", ")}. ${h.host ? `@${h.host} hosts: it hands out the tasks, accepts the hand-ins and sends @main the final report.` : "@main coordinates."} Budget ${money(maxCostUsd)}${budgetNote}.`);
  for (const p of agents) this.kickoff(slug, h.id, p.handle);
  return this.get(slug, h.id);
}

/**
 * A plan review reads the plan from a file, not the chat (see PLAN_REVIEW_READ): the latest proposed ticket, or the
 * ticket's own description. A failure to read the chat falls back to the description.
 */
export function writeProposal(this: Huddles, slug: string, hid: string, host: Ticket): void {
  let entries: SessionEntry[] = [];
  try {
    entries = (this.opts.entries ?? sessionEntries)(host);
  } catch {}
  try {
    const file = join(this.store.outputsDir(slug, host.id), proposalFile(hid));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, planProposal(host, entries));
  } catch (e) {
    console.error(`huddle ${hid}: couldn't write the plan for review:`, e);
  }
}
