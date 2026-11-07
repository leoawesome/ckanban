import { familyOf, hiddenTool } from "../../web/src/family";
import { stepWait, type StepWait } from "./main-ticket";
import { childrenOf, isComplete, planActive } from "./plan";
import type { SessionSummary } from "./session";
import type { Store } from "./store";
import type { Ticket } from "./types";

export type AttentionKind = "stalled" | "failed" | "limit" | "blocked" | "questions" | "proposal" | "review" | "reply" | "huddle";

/**
 * Why a ticket is waiting on the user, or null if it isn't. This one rule drives every "needs you": the card's
 * "Your turn" badge, the column and filter counts and the Inbox. since: when it started waiting (the Inbox's age).
 */
export interface Attention {
  kind: AttentionKind;
  label: string;
  since: string;
  /** On a main ticket: it comes from this kind of step wait (the card says "Step failed" for "failed"). */
  step?: StepWait["attention"];
}

/** The ticket's own open huddle, as far as "needs you" goes (Huddles.hostStates). */
export interface HostHuddle {
  /** Participants mid-turn (agents, or a ticket session with a run). */
  working: number;
  /** A wake is on its way to a participant (starting, or waiting for its run's turn to end). */
  queued: boolean;
  /** Messages tagging @you the user hasn't seen yet. */
  tagged: number;
  /** Learnings waiting for the user to save or discard them. */
  learnings: number;
  /** A lead or @main asked the user to close the huddle. */
  closeRequest: boolean;
  /** When the oldest of the tags, learnings and close request came in; null without any. */
  since: string | null;
  /** When the newest of them came in (a new ask ends a snooze). */
  latest?: string | null;
}

/** The huddle works on its own: the card shows "Huddle · n working" and it doesn't need the user. */
export const huddleBusy = (h: HostHuddle | null | undefined): boolean => !!h && (h.working > 0 || h.queued);

/** What the ticket's huddle asks of the user, or null: tags for @you, a close request or learnings to review. */
export function huddleAsk(h: HostHuddle | null | undefined): string | null {
  if (!h) return null;
  if (h.closeRequest) return "Huddle asks to close";
  if (h.tagged > 0) return `Huddle: ${h.tagged} for you`;
  if (h.learnings > 0) return `Review ${h.learnings} learning${h.learnings === 1 ? "" : "s"}`;
  return null;
}

/** When the ticket's state last changed for the user: Claude's last word in the session, else the last run or edit. */
export function lastChange(t: Ticket, s: SessionSummary | null): string {
  return s?.lastMessage?.at || s?.updatedAt || t.lastRunAt || t.updatedAt || t.createdAt;
}

/**
 * createdTitles: titles of the board's other tickets, to tell which proposed new tickets still wait for a click: a proposal
 * whose title is already on the board (created from this chat, or by hand, or by another ticket) counts as handled.
 * createdKeys: keys of this ticket's children made before cards saved the proposed title (proposedAs, in createdTitles), so
 * those stay handled after a rename too.
 * managed: the ticket is a child of a running plan, so its planner, not the user, handles it.
 * planComplete: every child of this ticket's plan is finished, so a stuck plan no longer needs the user.
 * huddle: the ticket's own open huddle; while it works the ticket doesn't need the user unless the huddle asks.
 * step: a main ticket's oldest tool ticket waiting on a decision (main-ticket.ts stepWait), when the main ticket hasn't
 * dealt with it yet or passes it on to the user: the main card names it ("Test: checkout sign-in asks a question").
 */
export function attentionFor(
  t: Ticket, s: SessionSummary | null, running: boolean,
  o: { createdTitles?: Set<string>; createdKeys?: Set<string>; managed?: boolean; planComplete?: boolean; huddle?: HostHuddle | null; step?: StepWait | null } = {},
): Attention | null {
  // A tool ticket is its main ticket's business: its questions, failures and limits show on the main card instead.
  if (hiddenTool(t)) return null;
  const own = ownAttention(t, s, running, o);
  const step = o.step;
  if (!t.main || !step || t.status === "done" || t.status === "backlog") return own;
  // A "with you" step waits for the user's answer (in this chat): the main card says so until the user answers it,
  // also while the main ticket works. Its own asks come first.
  if (step.withYou) return own && own.kind !== "review" && own.kind !== "reply" ? own : { kind: "questions", label: step.label, since: step.since, step: step.attention };
  // The main ticket passes a step's question on (or its plan stopped there): name the step.
  if (own && (own.kind === "questions" || own.kind === "blocked" || own.kind === "failed")) return { ...own, label: step.label, step: step.attention };
  if (running || (own && own.kind !== "review" && own.kind !== "reply")) return own;
  // A step ended and the main ticket hasn't run since (and won't be woken for it): the main card names it until it does.
  const unseen = step.since > (t.runEndedAt ?? "");
  const willWake = (t.plan?.state === "running" || t.plan?.state === "finishing") && (!!t.plan.awaiting || !!t.plan.inbox?.length);
  if (unseen && !willWake) return { kind: step.attention, label: step.label, since: step.since, step: step.attention };
  return own;
}

function ownAttention(
  t: Ticket, s: SessionSummary | null, running: boolean,
  o: { createdTitles?: Set<string>; createdKeys?: Set<string>; managed?: boolean; planComplete?: boolean; huddle?: HostHuddle | null },
): Attention | null {
  // A follow-up the board saw too late to wake (computer asleep, board off) waits for the user in any column: Claude
  // meant to come back, and only the user can say whether that still makes sense.
  if (t.followUp?.missedAt && !running) return { kind: "blocked", label: "Missed follow-up", since: t.followUp.missedAt };
  // Done means accepted as-is; Backlog means parked. Neither waits on the user, whatever the session holds.
  if (t.status === "done") return null;
  const since = lastChange(t, s);
  // A run that went silent: still running, but only the user can tell a hung tool from a slow one.
  if (t.stalled && running) return { kind: "stalled", label: `Stalled · no output for ${t.stalled.minutes} min`, since: t.stalled.at };
  // A main ticket's stuck plan (no progress, or it asked something) needs the user even when its tool tickets are done.
  if (t.plan?.state === "stuck" && (!o.planComplete || t.main)) return { kind: "blocked", label: "Plan stuck", since: t.updatedAt };
  if (running || t.status === "in_progress") return null;
  // A running plan's planner and children are handled unattended; the plan pings the user when stuck.
  if (o.managed || t.plan?.state === "running" || t.plan?.state === "finishing" || t.plan?.state === "paused") return null;
  if (t.status === "backlog") return null;
  const ask = huddleAsk(o.huddle);
  if (ask) return { kind: "huddle", label: ask, since: o.huddle!.since ?? since };
  if (huddleBusy(o.huddle)) return null;
  if (t.outcome === "failed") return { kind: "failed", label: "Run failed", since };
  // Hit the usage limit: it waits for the reset and continues by itself, unless that is off or used up for today.
  if (t.outcome === "limit") return t.limit?.auto ? null : { kind: "limit", label: "Limit hit", since };
  if (t.outcome === "blocked") return { kind: "blocked", label: t.capHit ? `Stopped at $${t.capHit.capUsd.toFixed(2)} cap` : "Blocked", since };
  const q = s?.openQuestions ?? 0;
  if (q > 0) return { kind: "questions", label: `Answer ${q} question${q === 1 ? "" : "s"}`, since };
  if (t.outcome === "needs_input") return { kind: "questions", label: "Answer Claude", since };
  const p = s?.pendingProposal;
  if (p && !((!p.title || p.title === t.title) && (!p.description || p.description.trim() === t.body.trim()))) {
    return { kind: "proposal", label: "Review proposal", since };
  }
  if (s?.pendingNewTickets?.some((n) => !o.createdTitles?.has(titleKey(n.title)) && !(n.key && o.createdKeys?.has(n.key)))) return { kind: "proposal", label: "Review proposed tickets", since };
  if (s?.pendingTeammates?.some((id) => !t.teammateCards?.[id])) return { kind: "proposal", label: "Review proposed teammate", since };
  if (s?.pendingAutomations?.some((id) => !t.automationCards?.[id])) return { kind: "proposal", label: "Review proposed automation", since };
  if (t.status === "review") return { kind: "review", label: "Ready for review", since };
  // A reply cut off by a restart isn't a reply yet: recover() resumes it.
  if (t.status === "planning" && s?.lastMessage?.role === "assistant" && !s.lastMessage.peerReply && !t.interrupted) return { kind: "reply", label: "Claude replied", since };
  return null;
}

/**
 * Titles of every ticket on the board but `self`, trimmed and case-folded the way sameTitle compares them, plus the title
 * each of self's children was proposed with (it may have been renamed since).
 */
export function boardTitles(tickets: Pick<Ticket, "id" | "title" | "parentId" | "proposedAs" | "tool" | "kind">[], self: string): Set<string> {
  // Tool tickets have no card: a proposal isn't "already on the board" because a hidden tool ticket has its title.
  const others = tickets.filter((c) => c.id !== self && !hiddenTool(c));
  return new Set([
    ...others.map((c) => titleKey(c.title)),
    ...others.filter((c) => c.parentId === self && c.proposedAs).map((c) => titleKey(c.proposedAs!)),
  ]);
}

/** How two ticket titles are compared to tell a proposal is already on the board: case and spacing don't count. */
export const titleKey = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

/** attentionFor with its options read from the board; the other tickets are only listed when they matter. */
export function ticketAttention(
  store: Store, slug: string, t: Ticket, s: SessionSummary | null, running: boolean, huddle?: HostHuddle | null,
  isRunning: (id: string) => boolean = () => false,
): Attention | null {
  const planComplete = () => {
    const kids = childrenOf(store.listTickets(slug), t.id);
    return kids.length > 0 && kids.every(isComplete);
  };
  if (hiddenTool(t)) return null;
  return attentionFor(t, s, running, {
    createdTitles: s?.pendingNewTickets.length ? boardTitles(store.listTickets(slug), t.id) : undefined,
    createdKeys: s?.pendingNewTickets.length
      ? new Set(childrenOf(store.listTickets(slug), t.id).flatMap((c) => (c.planKey && !c.proposedAs ? [c.planKey] : []))) : undefined,
    managed: t.parentId ? planActive(store.getTicket(slug, t.parentId)?.plan) : false,
    step: t.main ? oldestStep(store.listTickets(slug), t.id, isRunning) : undefined,
    planComplete: t.plan?.state === "stuck" ? planComplete() : undefined,
    huddle,
  });
}

/**
 * A main ticket's oldest tool ticket that waits on a decision, or null. "With you" steps waiting for the user come
 * first; with more than one, the label counts them ("2 tasks need you").
 */
export function oldestStep(tickets: Ticket[], mainId: string, running: (id: string) => boolean): StepWait | null {
  let best: StepWait | null = null;
  const you: StepWait[] = [];
  for (const r of familyOf(tickets, mainId)) {
    if (r.ticket.id === mainId || !hiddenTool(r.ticket)) continue;
    const w = stepWait(r.ticket, running(r.ticket.id));
    if (w?.withYou) you.push(w);
    else if (w && (!best || w.since < best.since)) best = w;
  }
  if (you.length) {
    you.sort((a, b) => a.since.localeCompare(b.since));
    return you.length === 1 ? you[0] : { ...you[0], label: `${you.length} tasks need you` };
  }
  return best;
}

/** How long Snooze in the Inbox hides a ticket. */
export const SNOOZE_MS = 24 * 3600_000;

/**
 * What a snooze holds on to: the reason and the last thing that happened (Claude's last word, the last run).
 * A new question, message or run changes it and ends the snooze. Not updatedAt: saving the snooze bumps that.
 */
export function snoozeKey(t: Ticket, s: SessionSummary | null, a: Attention, huddle?: HostHuddle | null): string {
  // A huddle's asks don't touch the session or the runs: the newest unseen ask (and the oldest, once that one is read).
  const asks = a.kind === "huddle" ? `${a.since}|${huddle?.latest ?? ""}` : "";
  return [a.kind, a.label, s?.lastMessage?.at ?? "", t.lastRunAt ?? "", t.outcome ?? "", asks].join("|");
}

/** A ticket that would need the user but is snoozed: the Inbox lists it apart, with time left. */
export interface Snoozed {
  attention: Attention;
  until: string;
}

/** Applies the ticket's snooze to its attention: while it holds, the ticket doesn't need the user. */
export function withSnooze(
  t: Ticket, s: SessionSummary | null, a: Attention | null, now = Date.now(), huddle?: HostHuddle | null,
): { attention: Attention | null; snoozed: Snoozed | null } {
  const z = t.snooze;
  if (a && z && Date.parse(z.until) > now && z.key === snoozeKey(t, s, a, huddle)) return { attention: null, snoozed: { attention: a, until: z.until } };
  return { attention: a, snoozed: null };
}

/** Oldest first: the Inbox order. */
export const byWaitingAge = <T extends { attention: Pick<Attention, "since"> }>(a: T, b: T) => a.attention.since.localeCompare(b.attention.since);

/**
 * Why a plan child waits on the user, or null: a plan never starts it, the user has to answer or apply something
 * first (or the planner answers its questions with chat_ticket). Done children never wait.
 */
export function userWaitReason(t: Ticket, s: SessionSummary | null): string | null {
  if (t.status === "done") return null;
  // Open questions first, also in Planning: the plan names what to do ("Launch kit has 5 questions").
  const q = s?.openQuestions ?? 0;
  if (q > 0) return `${q} question${q === 1 ? "" : "s"} for you`;
  if (t.status === "planning") return "in Planning";
  if (t.outcome === "needs_input") return "has questions for you";
  const p = s?.pendingProposal;
  if (p && !((!p.title || p.title === t.title) && (!p.description || p.description.trim() === t.body.trim()))) return "proposal to apply";
  return null;
}
