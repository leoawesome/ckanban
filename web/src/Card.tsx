import { Fragment, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { newestArtifact, safeHref, waitsForSlot, type Job, type SessionMessage, type Ticket } from "./api";
import { type CardHuddleBadge, digestPreview } from "./huddleText";
import { ClockIcon, ExternalIcon, HuddleIcon } from "./icons";
import type { AddOnLinks } from "./addOn";
import type { CardFamily } from "./family";
import { FollowUpChip } from "./FollowUpChip";
import { JobChip } from "./Jobs";
import { jobChip } from "./jobText";
import { KeyHint } from "./KeyHint";
import { CapActions } from "./CapActions";
import { capWait } from "./capText";
import { LimitActions } from "./LimitActions";
import { StallActions, stallWait } from "./StallActions";
import { clockTime, limitLabel, limitWait } from "./limitText";
import { DeviceChips } from "./Needs";
import { currentPr, prChips } from "./prText";
import { ResolveConflicts } from "./ResolveConflicts";
import { TagChip } from "./Tags";
import { ImportantStar } from "./StarToggle";
import { elapsed, fullTime, plainPreview, timeAgo } from "./time";
import { costText } from "./usage";
import { useNow } from "./useNow";
import { clearArrival, useArrival } from "./arrivals";
import { finishMark, foldChips, openedAt, shouldPulse, signInError, stepAge, type FinishMark } from "./cardState";

/** Live running time: ticks every second for the first minute, then every 30s. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now);
  const fresh = now - new Date(since).getTime() < 60_000;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), fresh ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [fresh]);
  return <span className="badge-time" title={`Started ${fullTime(since)}`}><span className="badge-sep"> · </span>{elapsed(since, now)}</span>;
}

/** Time since a running card's last step: ticks every second for the first minute, then every 15s. */
function useStepAge(at: string | null | undefined) {
  const [now, setNow] = useState(Date.now);
  const age = stepAge(at, now);
  const fresh = !!age && now - Date.parse(at!) < 60_000;
  useEffect(() => {
    if (!at) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), fresh ? 1000 : 15_000);
    return () => clearInterval(timer);
  }, [at, fresh]);
  return age;
}

function workingBadge(label: string, since?: string | null) {
  // The label hides in a phone's ticket header (just spinner and time there); the title keeps it.
  return <span className="badge running" title={label}><span className="spinner" /> <span className="badge-label">{label}</span>{since && <Elapsed since={since} />}</span>;
}

// Whether each ticket was working when last drawn, and the mark its last run left. Kept outside the components:
// a card that finishes usually moves column, which mounts a new Card.
const seenWorking = new Map<string, boolean>();
const finished = new Map<string, { mark: FinishMark; until: number }>();
const FINISH_MS = 2400;

/**
 * For a moment after a run ends (working turns false), the mark it leaves: ✓, ✕ or !, shown in place of the spinner.
 * Null the rest of the time, and on first load (nothing was seen running).
 */
export function useFinishMark(working: boolean, t: Ticket): FinishMark | null {
  const [, rerender] = useState(0);
  const now = Date.now();
  if (working) finished.delete(t.id);
  else if (seenWorking.get(t.id)) finished.set(t.id, { mark: finishMark(t), until: now + FINISH_MS });
  seenWorking.set(t.id, working);
  let f = finished.get(t.id);
  if (f && f.until <= now) {
    finished.delete(t.id);
    f = undefined;
  }
  useEffect(() => {
    if (!f) return;
    const timer = setTimeout(() => rerender((n) => n + 1), f.until - Date.now() + 20);
    return () => clearTimeout(timer);
  }, [f]);
  return f?.mark ?? null;
}

export function finishBadge(m: FinishMark) {
  return <span className={`badge finish ${m.tone}`} role="status"><span className="finish-icon" aria-hidden>{m.icon}</span> {m.label}</span>;
}

/** Badge text plus a shorter form that a phone's ticket header shows instead (styles.css picks one). */
function twoLabels(long: string, short: string) {
  return <><span className="badge-label">{long}</span><span className="badge-short">{short}</span></>;
}

// Shown by the badge already, so the activity line would only repeat it.
const QUIET_ACTIVITY = new Set(["Starting…", "Claude is replying…"]);

/** The ticket's auto huddle: reviewing its work ("Auto huddle · reason"), or waiting for the board's one slot. */
export function autoHuddleChip(a: NonNullable<Ticket["autoHuddle"]>) {
  if (a.state === "waiting") {
    return <span className="badge queued" title={`Another ticket has this board's auto huddle; this one resumes when it ends. Reason: ${a.reason}`}>{twoLabels("Waiting for huddle slot", "Waiting")}</span>;
  }
  return (
    <span className="badge auto-huddle" title={`Claude started a review huddle (${a.template}) before landing: ${a.reason}`}>
      <span className="live-dot" /> Auto huddle<span className="ah-reason"> · {a.reason}</span>
    </span>
  );
}

/** In Progress only because it waits for its auto huddle (no run right now). */
export const autoHuddleIdle = (t: Ticket) => !!t.autoHuddle && !t.running;

export function outcomeBadge(t: Ticket) {
  if (autoHuddleIdle(t)) return autoHuddleChip(t.autoHuddle!);
  if (waitsForSlot(t)) return <span className="badge queued" title="Your reply starts when a run slot is free">Queued</span>;
  if (t.status === "in_progress") return workingBadge("Running", t.runStartedAt);
  if (t.running) return workingBadge("Replying", t.runStartedAt);
  if (t.error?.startsWith("corrupt")) return <span className="badge failed">Corrupt file</span>;
  // Done means accepted: an old outcome there doesn't ask anything of the user.
  if (t.status === "done") return null;
  switch (t.outcome) {
    case "blocked": return <span className="badge blocked">Blocked</span>;
    case "needs_input": return <span className="badge blocked" title="Needs your input">{twoLabels("Needs your input", "Your input")}</span>;
    case "failed": return <span className="badge failed">Failed</span>;
    case "stopped": return <span className="badge stopped">Stopped</span>;
    case "limit": return <span className="badge limit" title={t.limit?.message ?? t.error ?? limitLabel(t)}>{twoLabels(limitLabel(t), "Limit hit")}</span>;
    case "done": return t.status === "review" ? <span className="badge ok" title="Ready for review">{twoLabels("Ready for review", "Review")}</span> : null;
    default: return null;
  }
}

/** Who wrote the card's last message: huddle digests aren't the user's. */
function lastWho(m: SessionMessage): string {
  if (m.from === "huddle") return "Huddle";
  return m.role === "user" ? "You" : "Claude";
}

/** The card's huddle chip; clicking it opens that ticket's Huddle tab instead of the card. */
function HuddleBadge({ badge, onOpen }: { badge: CardHuddleBadge; onOpen?: (ticketId: string) => void }) {
  return (
    <button type="button" className={`badge huddle ${badge.state}`} title={badge.title}
      onClick={(e) => { e.stopPropagation(); onOpen?.(badge.openTicket); }}
      onKeyDown={(e) => e.stopPropagation()}>
      {badge.state === "live" && <span className="live-dot" />}
      <HuddleIcon size={12} /> {badge.label}
      {badge.failed > 0 && <span className="hb-failed">· {badge.failed} failed</span>}
      {badge.forYou > 0 && <span className="for-you-pill">{badge.forYou} for you</span>}
    </button>
  );
}

/**
 * queued: 1-based place in the queue for a free run slot (status `ready`, or a reply waiting for one). held: a pending daemon restart holds it.
 * huddle: what the card says about huddles; onOpenHuddle opens a ticket's Huddle tab.
 * limit: the board's slug and error toast, for the usage-limit buttons ("Continue now", auto-continue) and a stalled
 * run's Stop / Keep waiting / Restart.
 */
/** The main card's working line (familyCard.line): the current step, or Paused / Stuck / a step that needs you in amber. */
function FamilyLineView({ line, id }: { line: NonNullable<NonNullable<Ticket["familyCard"]>["line"]>; id?: string }) {
  const text = line.until ? `${line.text}, resumes at ${clockTime(line.until)}` : line.text;
  return (
    <div id={id} className={`card-family-line ${line.tone}`} title={text}>
      {line.tone === "work" && <span className="spinner" aria-hidden />}
      <span className="activity-text">{text}</span>
    </div>
  );
}

export function Card({ a11yId, ticket, onClick, dragging, queued, held, huddle, onOpenHuddle, limit, onTag, jobs, onOpenJobs, addOn, family, onOpenTicket, via }: {
  /** Board cards: id prefix of the title (`-title`) and status lines (`-turn`, `-line`, `-meta`) the card is labelled by. */
  a11yId?: string;
  ticket: Ticket; onClick?: () => void; dragging?: boolean; queued?: number; held?: boolean;
  huddle?: CardHuddleBadge | null; onOpenHuddle?: (ticketId: string) => void;
  limit?: { slug: string; onError: (msg: string) => void };
  /** A tag chip was clicked: filter the board by it. */
  onTag?: (tag: string) => void;
  /** The board's one-time jobs: "⏰ N scheduled" when this ticket scheduled some; onOpenJobs opens them. */
  jobs?: Job[];
  onOpenJobs?: (ticketId: string) => void;
  /** The ticket it is an add-on to; its chip opens that ticket with onOpenTicket. */
  addOn?: AddOnLinks;
  /** The ticket it is part of and its linked tickets (family.ts); their chips open with onOpenTicket. */
  family?: CardFamily;
  onOpenTicket?: (id: string) => void;
  /** A board search found this card through one of its tool tickets: that ticket's title. */
  via?: string;
}) {
  // A main ticket with 2 or more tool tickets: one card for the feature (working line, "N tickets", family cost).
  const fc = ticket.main && ticket.familyCard && ticket.familyCard.tools >= 2 ? ticket.familyCard : null;
  const familyBusy = !!fc && fc.running.length > 0 && !ticket.running;
  const working = (ticket.status === "in_progress" && !waitsForSlot(ticket) && !autoHuddleIdle(ticket)) || !!ticket.running;
  const att = ticket.attention ?? null;
  // Its own huddle works on it: the huddle badge says so, not a stale Blocked or Failed.
  const badge = att || (ticket.huddleBusy && huddle) || familyBusy ? null
    : ticket.folderWait ? <span className="badge wait" title="Tickets on a folder without version history run one at a time; this one starts when the other finishes">waiting: another ticket is using the folder</span>
    : queued && !working ? (held
      ? <span className="badge queued" title="A daemon restart is pending; queued tickets start right after it">Waits for restart</span>
      : <span className="badge queued" title="Starts when a run slot is free">Queued · #{queued}</span>)
    : outcomeBadge(ticket);
  const showActivity = working && ticket.lastActivity && !QUIET_ACTIVITY.has(ticket.lastActivity);
  // How long since the run's last step; amber and a slower spinner once it has been quiet for 3 minutes.
  const step = useStepAge(working ? ticket.lastActivityAt : null);
  const quiet = working && !!step?.quiet;
  const last = ticket.session?.lastMessage;
  const done = ticket.status === "done";
  // Claude Code's own "Not logged in" isn't Claude's last word: a red chip says what to do instead (nothing on Done).
  const signIn = !!last && last.role !== "user" && signInError(last.text);
  const finish = useFinishMark(working, ticket);
  // Claude just moved it here: a fading ring, then a "new" dot until hovered or opened.
  const arrival = useArrival(ticket.id);
  const now = useNow();
  const pulse = shouldPulse(att, now, openedAt(ticket.id));
  const lastAt = ticket.session ? ticket.session.lastMessage?.at || ticket.session.updatedAt : null;
  const artifact = newestArtifact(ticket);
  const artifactHref = safeHref(artifact?.url);
  const hasJobs = !!jobs && !!jobChip(jobs, ticket.id);
  const linked = family?.children ?? [];
  const openLinked = (id: string) => (e: MouseEvent) => {
    e.stopPropagation();
    if (!dragging) onOpenTicket?.(id);
  };
  const addOnChip = ticket.addOnOf ? (addOn?.of
    ? <button className="badge add-on" title={`Add-on to “${addOn.of.title}”`} onClick={openLinked(addOn.of.id)}>↳ add-on to “{addOn.of.title}”</button>
    : <span className="badge add-on" title="Original ticket was deleted">↳ add-on</span>) : null;
  const partOfChip = ticket.partOf ? (family?.partOf
    ? <button className="badge add-on" title={`Part of “${family.partOf.title}”`} onClick={openLinked(family.partOf.id)}>↳ part of “{family.partOf.title}”</button>
    : null) : null;
  // Opens this ticket: its panel shows the whole family.
  const linkedChip = linked.length > 0 && (
    <button className="badge add-on" title={linked.map((f) => f.title).join("\n")} onClick={openLinked(ticket.id)}>
      {linked.length} linked
    </button>
  );
  // The board suggests a parent: the panel shows it with Link / Not related.
  const suggestChip = ticket.parentSuggestion && !ticket.partOf && !ticket.addOnOf && !ticket.parentId && (
    <button className="badge link-suggest" title="The board suggests a ticket this one is part of: open it to link or dismiss" onClick={openLinked(ticket.id)}>
      Link? 1 suggestion
    </button>
  );
  // A main ticket whose "with you" steps wait for the user's answers (in its chat): "Needs you · n".
  const stepsWaiting = ticket.main ? ticket.familyCard?.needsYou ?? [] : [];
  const fromSteps = !!att && stepsWaiting.length > 0 && (stepsWaiting.some((w) => w.label === att.label) || / steps need you$/.test(att.label));
  // Chips that need no action: at most two, the rest fold into "+N".
  const extras: { key: string; node: ReactNode; label: string }[] = [];
  if (partOfChip) extras.push({ key: "part-of", node: partOfChip, label: `Part of “${family!.partOf!.title}”` });
  if (addOnChip) extras.push({ key: "add-on", node: addOnChip, label: addOn?.of ? `Add-on to “${addOn.of.title}”` : "Add-on" });
  if (linkedChip) extras.push({ key: "linked", node: linkedChip, label: `${linked.length} linked` });
  if (suggestChip) extras.push({ key: "suggest", node: suggestChip, label: "Link? 1 suggestion" });
  if (ticket.source?.url) extras.push({ key: "source", label: `From ${ticket.source.provider}`, node: (
    <a className="badge pr" href={safeHref(ticket.source.url)} target="_blank" rel="noreferrer" title={`Open ${ticket.source.label} in ${ticket.source.provider}`}
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {ticket.source.provider} <ExternalIcon size={12} />
    </a>
  ) });
  if (artifact && artifactHref) extras.push({ key: "artifact", label: `Artifact: ${artifact.label}`, node: (
    <a className="badge artifact" href={artifactHref} target="_blank" rel="noreferrer" title={artifact.label === "claude.ai artifact" ? "Open claude.ai artifact" : `Open ${artifact.label} (claude.ai artifact)`}
      aria-label={`Open artifact: ${artifact.label}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <ExternalIcon size={12} /> artifact
    </a>
  ) });
  for (const g of ticket.tags ?? []) extras.push({ key: `tag-${g}`, label: `Tag: ${g}`, node: <TagChip name={g} onClick={onTag && !dragging ? () => onTag(g) : undefined} /> });
  const folded = foldChips(extras);
  const hiddenLabels = extras.slice(folded.shown.length).map((x) => x.label);
  const signInChip = signIn && !done && <span className="badge failed sign-in" title={last!.text}>Sign-in needed</span>;
  return (
    <article
      className={`card ${dragging ? "dragging" : ""} ${done ? "is-done" : ""} ${queued && !working ? "is-queued" : ""} ${working ? "is-running" : ""} ${quiet ? "is-quiet" : ""} ${att ? `needs-you att-${att.kind}` : ""}${arrival.ring ? " just-arrived" : ""}`}
      onClick={() => { clearArrival(ticket.id); onClick?.(); }} onMouseEnter={arrival.isNew ? () => clearArrival(ticket.id) : undefined}>
      {att && (
        <div className={`your-turn att-${att.kind}`} id={a11yId && `${a11yId}-turn`}>
          <span className={`yt-dot ${pulse ? "pulse" : ""}`} aria-hidden />
          <span className="yt-label">{fromSteps ? `Needs you · ${stepsWaiting.length}` : "Your turn"}</span>
          <span className="yt-why" title={ticket.error ?? undefined}>{att.kind === "limit" ? limitLabel(ticket) : att.label}</span>
        </div>
      )}
      <KeyHint inset className="card-keys" keys={ticket.status === "review" ? "↵ open · D done · Space move" : "↵ open · Space move"} />
      <div className="card-title" title={ticket.title} id={a11yId && `${a11yId}-title`}>
        {arrival.isNew && <span className="arrived-dot" role="img" aria-label="New here" title="Claude moved this card here" />}
        {ticket.important && <ImportantStar />}{ticket.title}
      </div>
      {via && <div className="card-via" title={`Found in the tool ticket “${via}”`}>via {via}</div>}
      {!showActivity && fc?.line && !att ? (
        <FamilyLineView line={fc.line} id={a11yId && `${a11yId}-line`} />
      ) : showActivity ? (
        // Keyed on the text, so each new step fades in instead of swapping.
        <div key={ticket.lastActivity!} id={a11yId && `${a11yId}-line`} className="card-activity" title={step ? `${ticket.lastActivity!}\n${step.quiet ? "No new step" : "Last step"} ${step.text} ago` : ticket.lastActivity!}>
          <span className="activity-text">{ticket.lastActivity}</span>
          {step && <span className={`step-age${step.quiet ? " quiet" : ""}`}>{step.quiet ? ` · quiet for ${step.text}` : ` · ${step.text}`}</span>}
        </div>
      ) : last && !signIn && (
        <div className="card-last" title={last.text}>
          <span className={`who ${last.role}`}>{lastWho(last)}:</span>{" "}
          {plainPreview(last.from === "huddle" ? digestPreview(last.text) : last.text)}
        </div>
      )}
      {(badge || finish || signInChip || fc || ticket.autoHuddle || ticket.costUsd || ticket.prUrl || ticket.runCount > 0 || ticket.workdir || ticket.session || ticket.scheduleId || ticket.source?.url || ticket.plan || ticket.needs?.length || ticket.devices || ticket.tags?.length || huddle || artifactHref || hasJobs || addOnChip || partOfChip || linkedChip || suggestChip || ticket.followUp) && (
        <div className="card-meta" id={a11yId && `${a11yId}-meta`}>
          {/* A main ticket's plan runs in the background: its card shows In progress instead, unless it stopped. */}
          {ticket.plan && ticket.plan.state !== "done" && !(ticket.main && (ticket.plan.state === "running" || ticket.plan.state === "finishing")) && (
            <span className={`badge plan ${ticket.plan.state}`} title="This ticket runs a plan of child tickets">
              Plan {ticket.plan.state === "finishing" ? "final check" : ticket.plan.state}
            </span>
          )}
          {ticket.scheduleId && (
            <span className="badge sched" title="Created by a schedule" aria-label="Scheduled">
              <ClockIcon size={12} strokeWidth={1.8} />
            </span>
          )}
          <DeviceChips ticket={ticket} />
          {finish ? finishBadge(finish) : badge}
          {signInChip}
          {ticket.autoHuddle && working && autoHuddleChip(ticket.autoHuddle)}
          {huddle && <HuddleBadge badge={huddle} onOpen={onOpenHuddle} />}
          {/* Why Claude stopped following up is history: the ticket shows it, the card doesn't. */}
          {limit && ticket.followUp && (
            <FollowUpChip slug={limit.slug} ticket={ticket} onError={limit.onError} disabled={dragging} />
          )}
          {hasJobs && <JobChip jobs={jobs!} ticketId={ticket.id} onOpen={dragging ? undefined : onOpenJobs} />}
          {ticket.prUrl && (
            <a className="badge pr pr-link" href={safeHref(ticket.prUrl)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              PR #{ticket.prUrl.split("/").pop()}{(ticket.prs?.length ?? 0) > 1 && <span className="pr-more-count" title={`${ticket.prs!.length} pull requests: open the ticket to see them all`}> +{ticket.prs!.length - 1}</span>}
            </a>
          )}
          {ticket.status === "review" && prChips(currentPr(ticket)).map((c) => (
            <span key={c.label} className={`badge pr-chip ${c.tone}`} title={c.title}>{c.label}</span>
          ))}
          {ticket.status === "review" && limit && !dragging && currentPr(ticket)?.state === "OPEN" && currentPr(ticket)?.conflicts && (
            <ResolveConflicts slug={limit.slug} ticket={ticket} onError={limit.onError} small />
          )}
          {fc && (
            <span className="badge fam" title={fc.running.length ? `Working now:\n${fc.running.join("\n")}` : "No tool ticket is working now"}
              aria-label={`${fc.tools} tool tickets${fc.running.length ? `, ${fc.running.length} working` : ""}`}>
              {fc.tools} tickets
            </span>
          )}
          {fc && fc.costUsd > 0 && <span className="badge cost" title="What the whole feature has cost so far (API-equivalent)">{costText(fc.costUsd)}</span>}
          {!fc && !!ticket.costUsd && (
            <span className="badge cost" title={`API-equivalent cost of this ticket's runs so far${ticket.runCap ? ` · runs stop at ${costText(ticket.runCap)}` : ""}`}>
              {costText(ticket.costUsd)}
            </span>
          )}
          {ticket.workdir && (ticket.terminalOpen
            ? <span className="badge running" title="This ticket's Claude Code chat is open in a terminal"><span className="live-dot" /> In terminal</span>
            : <span className="badge stopped" title="Linked to an existing Claude Code chat">linked chat</span>)}
          {folded.shown.map((x) => <Fragment key={x.key}>{x.node}</Fragment>)}
          {folded.more > 0 && <span className="badge more-chips" title={hiddenLabels.join("\n")} aria-label={`${folded.more} more: ${hiddenLabels.join(", ")}`}>+{folded.more}</span>}
          {lastAt && !working && (
            <time className="card-time" dateTime={lastAt} title={fullTime(lastAt)}>{timeAgo(lastAt)}</time>
          )}
        </div>
      )}
      {limit && !dragging && limitWait(ticket) && <LimitActions slug={limit.slug} ticket={ticket} onError={limit.onError} small />}
      {limit && !dragging && capWait(ticket) && <CapActions slug={limit.slug} ticket={ticket} onError={limit.onError} small />}
      {limit && !dragging && stallWait(ticket) && <StallActions slug={limit.slug} ticket={ticket} onError={limit.onError} small />}
    </article>
  );
}
