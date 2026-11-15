// Huddles: auto huddles, the slot, adding and inviting participants, findings (methods of the Huddles class in huddle.ts, split by topic).
import { handleBase, RESERVED_HANDLES, REVIEW_HUDDLE_HEADING, reviewHuddleRequest, rosterEntryError, type RosterEntry } from "./huddle-roster";
import { type HuddlePreset } from "./huddle-presets";
import { topicInput } from "./huddle-templates";
import { autoHuddleSlotPrompt, autoHuddleStoppedPrompt } from "../runs/prompts";
import { AUTO_HUDDLE_TRIGGERS, autoHuddlesOn, isAutoHuddleTrigger, USER_HUDDLE_TRIGGER } from "../core/types";
import type { Huddle, HuddleFinding, HuddleMode, HuddleParticipant, Ticket } from "../core/types";
import { newId, nowIso } from "../core/util";
import type { Huddles } from "./huddle";
import { HuddleError, AUTO_MAX_COST_USD, isCoordinator, canManage, findingTitle } from "./huddle-types";

/**
 * An unattended run of the host ticket starts its own review huddle (the HTTP route checks the caller is that run).
 * Refused (403) when the board has auto huddles off, the run isn't unattended, it already started one, or the
 * ticket has an open huddle. While another auto huddle is live on the board, the ticket waits for the slot instead:
 * the card stays In Progress and freeSlot() wakes it when that one ends. Trigger "user" goes to startForUser.
 */
export function startAuto(this: Huddles,
  slug: string, hostId: string, input: { reason: string; trigger?: string; template?: string; roster?: RosterEntry[]; maxCostUsd?: number; topic?: string },
): { huddle: Huddle | null; waiting: boolean; template: string } {
  const profile = this.store.getProfile(slug);
  const host = this.store.getTicket(slug, hostId);
  if (!profile || !host) throw new HuddleError(404, `ticket ${hostId} not found`);
  const reason = input.reason.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!reason) throw new HuddleError(400, "reason is required: one line on why this work needs a review huddle");
  const propose = "; use propose_huddle to propose one to the user instead (with the same maxCostUsd)";
  if (input.maxCostUsd !== undefined && !(Number.isFinite(input.maxCostUsd) && input.maxCostUsd > 0)) throw new HuddleError(400, "maxCostUsd must be a positive amount");
  if (input.trigger?.trim() === USER_HUDDLE_TRIGGER) return { huddle: this.startForUser(slug, host, { ...input, reason }), waiting: false, template: input.template?.trim() || "custom" };
  // A ticket with a "## Review huddle" section asked for one in Planning: that counts as opt-in, and gives the defaults.
  const requested = reviewHuddleRequest(host.body);
  const asked = input.maxCostUsd ?? requested?.maxCostUsd;
  const maxCostUsd = asked === undefined ? undefined : Math.min(asked, AUTO_MAX_COST_USD);
  if (!autoHuddlesOn(profile) && !requested) throw new HuddleError(403, `auto huddles are off on board ${slug} and the ticket has no "${REVIEW_HUDDLE_HEADING}" section${propose}`);
  if (!this.board.unattendedRun(slug, hostId)) {
    throw new HuddleError(403, `start_huddle only works in an unattended run of the ticket (Ready / In Progress work, a plan child, a schedule run), not in a chat${propose}`);
  }
  const open = this.store.openHuddles(slug).find((h) => h.hostTicket === hostId);
  if (open) throw new HuddleError(409, `ticket ${hostId} already has an open huddle (${open.id})${propose}, or post in that one`);
  // The trigger names the rule that called for the review, so the user can check it on the ticket.
  const trigger = input.trigger?.trim();
  if (!isAutoHuddleTrigger(trigger)) {
    throw new HuddleError(400, `trigger is required: one of ${[...AUTO_HUDDLE_TRIGGERS, USER_HUDDLE_TRIGGER].join(", ")} (the rule that calls for this review, or ${USER_HUDDLE_TRIGGER} when the user's own message asked for it)`);
  }
  if (trigger === "asked" && !requested) throw new HuddleError(400, `trigger "asked" is only for a ticket with a "${REVIEW_HUDDLE_HEADING}" section; this one has none`);
  if (trigger === "important" && !host.important) throw new HuddleError(400, `trigger "important" is only for a ticket marked ⭐ Important; this one isn't`);
  const roster = input.roster?.length ? input.roster : undefined;
  // A huddle the ticket asks for uses the template it names; otherwise the run builds a roster for this change.
  const template = input.template?.trim() || (roster ? "" : trigger === "asked" ? requested?.template ?? "" : "");
  if (!roster && !(trigger === "asked" && template)) {
    throw new HuddleError(400, `pass a roster built for this change (trigger ${trigger}): 1-4 reviewers or testers whose prompts say what to check, ` +
      "plus a lead (e.g. qa-lead) when there are 2 or more; list_huddle_presets lists the teammates you can use");
  }
  if (template && !this.templates(slug).some((t) => t.name === template)) {
    throw new HuddleError(404, `no huddle template "${template}" (templates: ${this.templates(slug).map((t) => t.name).join(", ")})`);
  }
  let topic: string | null;
  try {
    topic = topicInput(input.topic);
  } catch (e) {
    throw new HuddleError(400, (e as Error).message);
  }
  const busy = this.liveAuto(slug).find((h) => h.hostTicket !== hostId);
  if (busy) {
    const at = host.autoHuddle?.state === "waiting" ? host.autoHuddle.at : nowIso();
    this.board.setAutoHuddle(slug, hostId, {
      state: "waiting", reason, trigger, template: template || "custom", at, huddleId: null,
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}), ...(topic ? { topic } : {}),
    });
    if (host.autoHuddle?.state !== "waiting") this.store.addComment(slug, hostId, "ai", `Auto huddle wanted (${trigger}: ${reason}); waiting for huddle slot: ticket ${busy.hostTicket} has the board's auto huddle.`);
    return { huddle: null, waiting: true, template: template || "custom" };
  }
  if (!this.board.claimAutoHuddle(slug, hostId)) {
    throw new HuddleError(409, "this run already started an auto huddle (one per run); finish with the findings you have");
  }
  const h = this.create(slug, hostId, roster ?? [], { template: template || undefined, maxCostUsd, topic, auto: { reason, askedCostUsd: asked, trigger } });
  if (this.slotWoken.get(slug) === hostId) this.slotWoken.delete(slug);
  this.board.setAutoHuddle(slug, hostId, { state: "live", reason, trigger, template: template || "custom", at: h.createdAt, huddleId: h.id });
  this.store.addComment(slug, hostId, "ai", `Auto huddle started (${template || "custom roster"}, ${trigger}): ${reason}`);
  return { huddle: h, waiting: false, template: template || "custom" };
}

/**
 * start_huddle with trigger "user": the user typed in the ticket's chat that a huddle should start now, so the
 * ticket's run starts it as the user's Start on a proposal card would (not an auto huddle: no board setting, no
 * slot, the user closes it). The board decides the message was the user's (Board.userAskedRun), not Claude.
 * Planning and Backlog keep the click: there a huddle would work the ticket before its run does.
 */
export function startForUser(this: Huddles, slug: string, host: Ticket, input: { reason: string; template?: string; roster?: RosterEntry[]; maxCostUsd?: number; topic?: string }): Huddle {
  const propose = "; call propose_huddle instead so the user can press Start on the card";
  if (host.status === "planning" || host.status === "backlog") {
    throw new HuddleError(403, `in ${host.status === "planning" ? "Planning" : "Backlog"} a huddle only starts when the user presses Start on a proposal card${propose}`);
  }
  if (!this.board.userAskedRun(slug, host.id)) {
    throw new HuddleError(403, `trigger ${USER_HUDDLE_TRIGGER} only works while this ticket's run answers a message the user typed in its chat${propose}`);
  }
  const template = input.template?.trim() || undefined;
  if (!input.roster?.length && !template) throw new HuddleError(400, "pass a template or a roster: the roles the user asked for, each prompt saying what to do, plus a lead (e.g. qa-lead) when there are 2 or more");
  const maxCostUsd = input.maxCostUsd === undefined ? undefined : Math.min(input.maxCostUsd, AUTO_MAX_COST_USD);
  const h = this.create(slug, host.id, input.roster ?? [], { template, maxCostUsd, topic: input.topic, byUser: { reason: input.reason, askedCostUsd: input.maxCostUsd } });
  this.store.addComment(slug, host.id, "ai", `Huddle started because the user asked in the chat (${template ?? "custom roster"}): ${input.reason}`);
  return h;
}

/** The board's live auto huddles (at most one, unless the user resumed a stopped one). */
export function liveAuto(this: Huddles, slug: string): Huddle[] {
  return this.store.openHuddles(slug).filter((h) => h.auto && h.status === "live").map((h) => structuredClone(h));
}

/**
 * An auto huddle ended. closed: by @main after landing, or because the host is done or deleted. halt: a brake
 * stopped it, so the host is woken to decide whether it may land. user: the user stopped or closed it; a host that
 * only waited for it goes to Review. Then the next ticket waiting for the slot gets it.
 */
export function autoEnded(this: Huddles, slug: string, hid: string, how: "closed" | "halt" | "user", why: string) {
  const h = this.load(slug, hid);
  const t = h && this.store.getTicket(slug, h.hostTicket);
  if (h && t?.autoHuddle?.huddleId === hid) {
    const idle = t.status === "in_progress" && !this.board.isRunning(slug, t.id);
    if (how === "user" && idle) {
      this.store.addComment(slug, t.id, "ai", `Auto huddle ended: ${why}. The work was not landed.`);
      this.board.setAutoHuddle(slug, t.id, null, { status: "review", outcome: "stopped", lastActivity: null });
    } else this.board.setAutoHuddle(slug, t.id, null);
    if (how === "halt" && t.status !== "done") {
      const open = h.findings.filter((f) => f.status === "open").length;
      this.board.chat(slug, t.id, autoHuddleStoppedPrompt(h, why, open), { hostWake: true }).catch((e) => {
        this.store.addComment(slug, t.id, "ai", `Auto huddle stopped (${why}) and the ticket couldn't be woken: ${(e as Error).message}`);
      });
    }
  }
  queueMicrotask(() => this.freeSlot(slug));
}

/**
 * No auto huddle is live on the board: wake the ticket that has waited longest for the slot (one at a time; the
 * next one once that ticket's run is over). Also run after a restart.
 */
export function freeSlot(this: Huddles, slug: string): void {
  if (this.shuttingDown || this.board.isRestartPending() || this.liveAuto(slug).length) return;
  const woken = this.slotWoken.get(slug);
  if (woken) {
    const t = this.store.getTicket(slug, woken);
    if (t && (this.board.isRunning(slug, woken) || t.queued?.some((m) => m.state === "queued" && m.hostWake))) return;
    this.slotWoken.delete(slug);
  }
  const next = this.store.listTickets(slug)
    .filter((t) => t.autoHuddle?.state === "waiting" && t.status === "in_progress")
    .sort((a, b) => a.autoHuddle!.at.localeCompare(b.autoHuddle!.at))[0];
  if (!next) return;
  const a = next.autoHuddle!;
  this.slotWoken.set(slug, next.id);
  // It no longer waits: its run takes the slot with start_huddle, or lands without one.
  this.board.setAutoHuddle(slug, next.id, null, { lastActivity: "Huddle slot free: resuming" });
  this.board.chat(slug, next.id, autoHuddleSlotPrompt(a), { hostWake: true }).catch((e) => {
    this.slotWoken.delete(slug);
    this.board.setAutoHuddle(slug, next.id, a);
    console.error(`couldn't wake ${slug}/${next.id} for the auto-huddle slot`, e);
  });
}

/**
 * Participants made from one roster entry, with handles not in `taken`. grant: the user is adding them, so the
 * entry's lead applies (see addParticipants). readOnly: the host ticket is in Planning, which never changes the
 * project, so everyone reads in the shared workspace. One that can change files always works in its own copy.
 */
export function expand(this: Huddles, e: RosterEntry, taken: string[], presets: Map<string, HuddlePreset>, grant = true, readOnly = false): HuddleParticipant[] {
  const preset = e.preset ? presets.get(e.preset.trim()) : undefined;
  const count = e.count ?? 1;
  const base = handleBase(e.handle?.trim() || e.preset?.trim() || e.role!);
  const used = new Set([...taken, ...RESERVED_HANDLES]);
  const out: HuddleParticipant[] = [];
  for (let i = 0, n = 1; i < count; i++) {
    let handle = base;
    if (count > 1 || used.has(handle)) {
      while (used.has(`${base}-${n}`)) n++;
      handle = `${base}-${n}`;
    }
    used.add(handle);
    const asked = e.workspace ?? preset?.workspace ?? "shared";
    const canEdit = !readOnly && (e.canEdit ?? preset?.canEdit ?? asked === "own");
    const workspace = readOnly ? "shared" : canEdit ? "own" : asked;
    // The host runs the room, so it is a lead.
    const lead = grant && (!!e.host || (e.lead ?? preset?.lead ?? false));
    // Leads watch every message: an entry made a lead without a mode is monitor; an explicit mode wins.
    const mode = e.mode ?? (lead && (e.lead || e.host) ? "monitor" : preset?.mode ?? (lead ? "monitor" : "tagged"));
    out.push({
      handle, role: e.role?.trim() || preset?.role || base, preset: e.preset?.trim() ?? null,
      prompt: [preset?.prompt, e.prompt?.trim()].filter(Boolean).join("\n\n") || `Help with the ticket as ${e.role}.`,
      ...(e.focus?.trim() ? { focus: e.focus.trim() } : {}),
      model: e.model?.trim() || preset?.model || null, mode, lead,
      canEdit, workspace, sessionId: null, status: "idle", kind: "agent", cursor: 0, joinedAt: nowIso(), token: newId() + newId(),
    });
  }
  return out;
}

export function nonHuman(this: Huddles, h: Huddle): number {
  return h.participants.filter((p) => p.kind !== "human").length;
}

export function assertOpen(this: Huddles, h: Huddle) {
  if (h.status === "closed") throw new HuddleError(409, `huddle ${h.id} is closed (read-only)`);
}

/** Add participants (the user, the coordinator or a lead); refused once maxParticipants is reached. */
export function addParticipants(this: Huddles, slug: string, hid: string, by: HuddleParticipant, e: RosterEntry): HuddleParticipant[] {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  if (!canManage(h, by)) throw new HuddleError(403, `only a lead or @main can add participants; ask them (or the user) in the huddle`);
  const presets = this.presetMap(slug);
  const err = rosterEntryError(e, "", [...presets.keys()]);
  if (err) throw new HuddleError(400, err);
  const want = e.count ?? 1;
  const room = h.maxParticipants - this.nonHuman(h);
  if (want > room) {
    throw new HuddleError(409, `the huddle is full: ${this.nonHuman(h)} of ${h.maxParticipants} participants${room > 0 ? `, room for ${room} more` : ""}. ` +
      "Don't work around the limit: ask the user (tag @you) to raise it or stop someone.");
  }
  // Only the user makes leads; a lead or @main may add helpers that change files (they hand their changes in).
  // The host is named when the huddle starts.
  const added = this.expand({ ...e, host: undefined }, h.participants.map((p) => p.handle), presets, by.kind === "human", this.store.getTicket(slug, h.hostTicket)?.status === "planning");
  this.update(slug, hid, (x) => {
    x.participants.push(...added);
  });
  this.system(slug, hid, `@${by.handle} added ${added.map((p) => `@${p.handle} (${p.role}${p.focus ? `: ${p.focus}` : ""})`).join(", ")}.`);
  if (h.status === "live") for (const p of added) this.kickoff(slug, hid, p.handle);
  return added;
}

/** Invite another ticket's own session (same board), e.g. as @api-main. */
export function invite(this: Huddles, slug: string, hid: string, by: HuddleParticipant, ticketId: string, handle?: string): HuddleParticipant {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  if (by.kind !== "human" && !isCoordinator(h, by)) throw new HuddleError(403, "only the user or @main can invite tickets");
  const t = this.store.getTicket(slug, ticketId);
  if (!t) throw new HuddleError(404, `ticket ${ticketId} not found`);
  if (h.participants.some((p) => p.ticketId === ticketId)) throw new HuddleError(409, `ticket ${ticketId} is already in this huddle`);
  if (this.nonHuman(h) >= h.maxParticipants) throw new HuddleError(409, `the huddle is full (${h.maxParticipants} participants)`);
  const base = handleBase(handle?.trim() || `${t.planKey || t.title.split(/\s+/)[0] || "ticket"}-main`);
  const taken = new Set([...h.participants.map((p) => p.handle), ...RESERVED_HANDLES]);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  const p: HuddleParticipant = {
    handle: name, role: `Ticket ${t.id} "${t.title}"`, preset: null, prompt: "", model: null, mode: "tagged", lead: false, canEdit: false,
    workspace: "shared", sessionId: null, status: "idle", kind: "ticket-main", ticketId, cursor: h.seq, joinedAt: nowIso(),
  };
  this.update(slug, hid, (x) => {
    x.participants.push(p);
    x.invited.push(ticketId);
  });
  this.system(slug, hid, `@${by.handle} invited ticket ${t.id} "${t.title}" as @${name}.`);
  return p;
}

export function setMode(this: Huddles, slug: string, hid: string, by: HuddleParticipant, handle: string, mode: HuddleMode): HuddleParticipant {
  const h = this.get(slug, hid);
  this.assertOpen(h);
  if (by.kind !== "human" && by.handle !== handle) throw new HuddleError(403, "you can only change your own mode");
  const p = h.participants.find((x) => x.handle === handle && x.kind !== "human");
  if (!p) throw new HuddleError(404, `no participant @${handle}`);
  if (mode !== "tagged" && mode !== "monitor") throw new HuddleError(400, "mode must be tagged or monitor");
  if (p.mode === mode) return p;
  this.updateP(slug, hid, handle, { mode });
  // A monitor session no longer needs to stay open between turns.
  if (mode === "tagged") this.runs.get(this.key(slug, hid, handle))?.handle?.endWhenIdle();
  this.system(slug, hid, `@${handle} switched to ${mode} mode${by.handle !== handle ? ` (by @${by.handle})` : ""}.`);
  return { ...p, mode };
}

/** The pinned findings list: leads and the coordinator add and resolve; everyone can list. */
export function findings(this: Huddles, slug: string, hid: string, by: HuddleParticipant, action: "add" | "resolve" | "list", arg: { text?: string; id?: string } = {}): HuddleFinding[] {
  const h = this.get(slug, hid);
  if (action === "list") return h.findings;
  this.assertOpen(h);
  if (!canManage(h, by)) throw new HuddleError(403, "only a lead or @main can change the findings list; post your finding to your lead instead");
  if (action === "add") {
    const text = arg.text?.trim();
    if (!text) throw new HuddleError(400, "text is required");
    const f: HuddleFinding = { id: `f${h.findings.length + 1}`, text, by: by.handle, status: "open", resolvedBy: null, at: nowIso() };
    this.update(slug, hid, (x) => void x.findings.push(f));
    this.system(slug, hid, `@${by.handle} pinned finding ${f.id}: ${findingTitle(text)}`);
  } else if (action === "resolve") {
    const f = h.findings.find((x) => x.id === arg.id);
    if (!f) throw new HuddleError(404, `no finding ${arg.id}`);
    if (f.status === "resolved") return h.findings;
    this.update(slug, hid, (x) => {
      const g = x.findings.find((y) => y.id === arg.id)!;
      Object.assign(g, { status: "resolved", resolvedBy: by.handle });
    });
    this.system(slug, hid, `@${by.handle} resolved finding ${f.id}.`);
  } else throw new HuddleError(400, "action must be add, resolve or list");
  return this.get(slug, hid).findings;
}
