import { Fragment, useEffect, useState, type ReactNode } from "react";
import { newestArtifact, safeHref, waitsForSlot, type Job, type SessionMessage, type Ticket } from "./api";
import { digestPreview } from "./huddleText";
import { ClockIcon, CloseIcon, ExternalIcon, PinIcon } from "./icons";
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
import { ImportantStar } from "./StarToggle";
import { elapsed, fullTime, plainPreview, timeAgo } from "./time";
import { costText } from "./usage";
import { useNow } from "./useNow";
import { clearArrival, useArrival } from "./arrivals";
import { attentionLabel, cardFamily, familyLineText, partChip, cardHuddleLine, HUDDLE_WORKING, huddleLineText, familyWorkingNames, finishMark, foldChips, openedAt, overCap, previewShown, shouldPulse, signInError, stepAge, stepsShown, stepsText, type FinishMark } from "./cardState";
import { boardColumnOf } from "./columns";
import { usePhone } from "./usePhone";
import { ClaudeFace } from "./ConvTurn";
import type { AvatarMood } from "./avatarLook";
import { attentionMood, finishMood, runMood, runWord } from "./avatarMood";

/**
 * The card's 📌 button: Pin to top, or Unpin on a pinned card. Desktop shows it on hover and focus (always on a pinned
 * card); a phone always shows it, 40px to tap. A press never opens the card or picks it up.
 */
function PinButton({ pinned, onPin }: { pinned: boolean; onPin: (on: boolean) => void }) {
  const label = pinned ? "Unpin" : "Pin to top";
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <button type="button" className="icon-btn card-pin" aria-label={label} aria-pressed={pinned} title={`${label} (P)`}
      onClick={(e) => { e.stopPropagation(); onPin(!pinned); }} onPointerDown={stop} onMouseDown={stop} onTouchStart={stop}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}>
      {pinned ? <CloseIcon size={14} /> : <PinIcon size={14} />}
    </button>
  );
}

/** Live running time: ticks every second for the first minute, then every 30s. */
function Elapsed({ since, sep = true }: { since: string; sep?: boolean }) {
  const [now, setNow] = useState(Date.now);
  const fresh = now - new Date(since).getTime() < 60_000;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), fresh ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [fresh]);
  return <span className="badge-time" title={`Started ${fullTime(since)}`}>{sep && <span className="badge-sep"> · </span>}{elapsed(since, now)}</span>;
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

/** mood: Claude's face in that mood in place of the spinner (a huddle's helpers keep the spinner: no one face for them). */
function workingBadge(label: string, since?: string | null, title = label, mood?: AvatarMood) {
  // The label hides in a phone's ticket header (just the face and time there); the title keeps it.
  return (
    <span className="badge running" title={title}>
      {mood ? <ClaudeFace mood={mood} size={20} /> : <span className="spinner" />} <span className="badge-label">{label}</span>{since && <Elapsed since={since} />}
    </span>
  );
}

// Whether each ticket was working when last drawn, and the mark its last run left. Kept outside the components:
// a card that finishes usually moves column, which mounts a new Card.
const seenWorking = new Map<string, boolean>();
const finished = new Map<string, { mark: FinishMark; until: number }>();
const FINISH_MS = 2400;

/**
 * For a moment after a run ends (working turns false), the mark it leaves: Claude's done, failed or waiting face (✓, ✕ or !
 * in its corner from 24px up), shown in place of the working face.
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
  return <span className={`badge finish ${m.tone}`} role="status"><span className="finish-icon" aria-hidden><ClaudeFace mood={finishMood(m)} size={20} /></span> {m.label}</span>;
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

/** The panel header's pill while the ticket's own huddle works: "Huddle working", its counts in the tooltip. */
export function huddleBadge(t: Ticket) {
  return workingBadge(HUDDLE_WORKING, null, huddleLineText(t.huddleLine ?? { working: 0, helpers: 0, findings: 0 }));
}

/** In Progress only because it waits for its auto huddle (no run right now). */
export const autoHuddleIdle = (t: Ticket) => !!t.autoHuddle && !t.running;

export function outcomeBadge(t: Ticket) {
  if (autoHuddleIdle(t)) return autoHuddleChip(t.autoHuddle!);
  if (waitsForSlot(t)) return <span className="badge queued" title="Your reply starts when the other ticket is done with the folder">Queued</span>;
  if (t.status === "in_progress") return workingBadge("Running", t.runStartedAt, undefined, runMood(t.lastActivity));
  if (t.running) return workingBadge("Replying", t.runStartedAt, undefined, runMood(t.lastActivity));
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

/**
 * queued: 1-based place in the queue (status `ready`, or a reply waiting for the folder). held: a pending daemon restart holds it.
 * PR, huddle, linked tickets and tags show only in the ticket panel, not on the card.
 * limit: the board's slug and error toast, for the usage-limit buttons ("Continue now", auto-continue) and a stalled
 * run's Stop / Keep waiting / Restart.
 */
/** The main card's working line (familyCard.line): the current step, Paused / Stuck / a step that needs you in amber, a failed step in red. */
function FamilyLineView({ line, fc, id }: { line: NonNullable<NonNullable<Ticket["familyCard"]>["line"]>; fc: NonNullable<Ticket["familyCard"]>; id?: string }) {
  const base = familyLineText(line, fc);
  const text = line.until ? `${base}, resumes at ${clockTime(line.until)}` : base;
  return (
    <div id={id} className={`card-family-line ${line.tone}`} title={text}>
      {line.tone === "work" && <ClaudeFace mood="working" size={20} />}
      <span className="activity-text">{text}</span>
    </div>
  );
}

export function Card({ a11yId, ticket, onClick, dragging, queued, held, limit, jobs, onOpenJobs, via, onPin }: {
  /** Board cards: id prefix of the title (`-title`) and status lines (`-turn`, `-line`, `-meta`) the card is labelled by. */
  a11yId?: string;
  ticket: Ticket; onClick?: () => void; dragging?: boolean; queued?: number; held?: boolean;
  limit?: { slug: string; onError: (msg: string) => void };
  /** The board's one-time jobs: "⏰ N scheduled" when this ticket scheduled some; onOpenJobs opens them. */
  jobs?: Job[];
  onOpenJobs?: (ticketId: string) => void;
  /** A board search found this card through one of its tool tickets: that ticket's title. */
  via?: string;
  /** Board cards: pin (true) or unpin the ticket; the 📌 button shows when given (not on Done cards). */
  onPin?: (on: boolean) => void;
}) {
  const phone = usePhone();
  const ownWorking = (ticket.status === "in_progress" && !waitsForSlot(ticket) && !autoHuddleIdle(ticket)) || !!ticket.running;
  // A main ticket with a step, or a ticket of its feature working: one card for the feature (working line, "7 of 16
  // steps", family cost). Its feature working shows the blue stripe too (cardFamily).
  const { fc, busy: familyBusy, familyWorks, working, att, doneHint } = cardFamily(ticket, ownWorking);
  // One status pill, and only when it says something the card doesn't: its own huddle working on it hides a stale
  // Blocked or Failed, and a running card's spinner and time sit in the muted line instead of a Running pill.
  const badge = att || ticket.huddleBusy || familyBusy ? null
    : ticket.folderWait ? <span className="badge wait" title="Tickets on a folder without version history run one at a time; this one starts when the other finishes">waiting: another ticket is using the folder</span>
    : queued && !working ? (held
      ? <span className="badge queued" title="A daemon restart is pending; queued tickets start right after it">Waits for restart</span>
      : <span className="badge queued" title="Starts as soon as nothing else holds it back (another ticket editing the folder, or a restart)">Queued · #{queued}</span>)
    : ownWorking ? null : outcomeBadge(ticket);
  const showActivity = ownWorking && ticket.lastActivity && !QUIET_ACTIVITY.has(ticket.lastActivity);
  // Its own huddle working while its own run isn't: a blue working line in place of the last message ("Needs you" wins).
  const huddleLine = cardHuddleLine(ticket, { working, needsYou: !!att });
  // How long since the run's last step; amber and a slower spinner once it has been quiet for 3 minutes.
  const step = useStepAge(ownWorking ? ticket.lastActivityAt : null);
  const quiet = ownWorking && !!step?.quiet;
  const last = ticket.session?.lastMessage;
  const done = ticket.status === "done";
  // 📌 Pinned: the dark card at the top of its column (Done unpins it).
  const pinned = !!ticket.pinnedAt && !done;
  const pinBtn = onPin && !dragging && !done;
  // Claude Code's own "Not logged in" isn't Claude's last word: a red chip says what to do instead (nothing on Done).
  const signIn = !!last && last.role !== "user" && signInError(last.text);
  const finish = useFinishMark(ownWorking, ticket);
  // Claude just moved it here: a fading ring, then a "new" dot until hovered or opened.
  const arrival = useArrival(ticket.id);
  const now = useNow();
  const pulse = shouldPulse(att, now, openedAt(ticket.id));
  // Waiting on the user's answer: Claude's waiting face stays in place of the dot (the end-of-run mark leaves after a moment).
  const waitFace = att ? attentionMood(att.kind) : null;
  const lastAt = ticket.session ? ticket.session.lastMessage?.at || ticket.session.updatedAt : null;
  const artifact = newestArtifact(ticket);
  const artifactHref = safeHref(artifact?.url);
  const hasJobs = !!jobs && !!jobChip(jobs, ticket.id);
  // A main ticket whose "with you" steps wait for the user's answers (in its chat): "Needs you · n".
  const stepsWaiting = ticket.main ? ticket.familyCard?.needsYou ?? [] : [];
  const fromSteps = !!att && stepsWaiting.length > 0 && (stepsWaiting.some((w) => w.label === att.label) || / (?:steps|tasks) need you$/.test(att.label));
  // Chips that need no action: at most two, the rest fold into "+N".
  const extras: { key: string; node: ReactNode; label: string }[] = [];
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
  const folded = foldChips(extras);
  const hiddenLabels = extras.slice(folded.shown.length).map((x) => x.label);
  const signInChip = signIn && !done && <span className="badge failed sign-in" title={last!.text}>Sign-in needed</span>;
  // The muted line: "7 of 16 tasks · $3.20 · 5m". Steps only part way; cost (the feature's on a main card) red when
  // the ticket's last run stopped at its cap; the run's time while it works, else how long ago it last spoke.
  const workingNames = fc ? familyWorkingNames(fc) : [];
  const cost = fc ? fc.costUsd : ticket.costUsd ?? 0;
  const capped = overCap(ticket);
  const facts: { key: string; node: ReactNode }[] = [];
  if (fc && stepsShown(fc)) facts.push({ key: "steps", node: (
    <span title={workingNames.length ? `Working now:\n${workingNames.join("\n")}` : "No task is working now"}>{stepsText(fc)}</span>
  ) });
  if (cost > 0) facts.push({ key: "cost", node: (
    <span className={`card-cost${capped ? " over" : ""}`}
      title={`${fc ? "What the whole feature has cost so far" : "What this ticket's runs have cost so far"} (API-equivalent)${ticket.runCap ? ` · runs stop at ${costText(ticket.runCap)}` : ""}`}>
      {costText(cost)}{capped && " over budget"}
    </span>
  ) });
  if (ownWorking && ticket.runStartedAt) facts.push({ key: "time", node: (
    <span className="card-run-time"><ClaudeFace mood={runMood(ticket.lastActivity)} size={20} /><span className="card-run-word">{runWord(runMood(ticket.lastActivity))}</span><Elapsed since={ticket.runStartedAt} sep={false} /></span>
  ) });
  else if (lastAt && !working) facts.push({ key: "time", node: <time dateTime={lastAt} title={fullTime(lastAt)}>{timeAgo(lastAt)}</time> });
  // A main ticket's plan runs in the background: its card shows In progress instead, unless it stopped.
  const planPill = ticket.plan && ticket.plan.state !== "done" && !(ticket.main && (ticket.plan.state === "running" || ticket.plan.state === "finishing")) && (
    <span className={`badge plan ${ticket.plan.state}`} title="This ticket runs a plan of child tickets">
      Plan {ticket.plan.state === "finishing" ? "final check" : ticket.plan.state}
    </span>
  );
  // At most one pill: Sign-in needed, then the end-of-run mark, then what needs the user, then its auto huddle or a stopped plan.
  // A sub-feature's "Part of …" or a shown task's "Task of …" chip on top.
  const part = partChip(ticket);
  const pill = signInChip || (finish ? finishBadge(finish) : badge) || (ticket.autoHuddle && ownWorking && autoHuddleChip(ticket.autoHuddle)) || planPill || null;
  return (
    <article
      className={`card ${dragging ? "dragging" : ""} ${done ? "is-done" : ""} ${queued && !working ? "is-queued" : ""} ${working || huddleLine ? "is-running" : ""} ${quiet ? "is-quiet" : ""} ${att ? `needs-you att-${att.kind}` : ""}${arrival.ring ? " just-arrived" : ""}${pinned ? " is-pinned" : ""}${pinBtn ? " has-pin" : ""}${pinBtn && phone ? " pin-phone" : ""}`}
      onClick={() => { clearArrival(ticket.id); onClick?.(); }} onMouseEnter={arrival.isNew ? () => clearArrival(ticket.id) : undefined}>
      {pinBtn && <PinButton pinned={pinned} onPin={onPin} />}
      {pinned && <div className="card-pinned-label" aria-hidden><PinIcon size={12} /> Pinned</div>}
      {att && (
        <div className={`your-turn att-${att.kind}`} id={a11yId && `${a11yId}-turn`}>
          {waitFace ? <span className={`yt-face${pulse ? " pulse" : ""}`} aria-hidden><ClaudeFace mood={waitFace} size={20} /></span>
            : <span className={`yt-dot ${pulse ? "pulse" : ""}`} aria-hidden />}
          <span className="yt-label">{attentionLabel(att, fromSteps ? stepsWaiting.length : 0, familyWorks)}</span>
          <span className="yt-why" title={ticket.error ?? undefined}>{att.kind === "limit" ? limitLabel(ticket) : att.label}</span>
        </div>
      )}
      {part && (
        <div className="card-part">
          <span className={`part-chip ${part.kind}`} title={part.kind === "sub"
            ? `A sub-feature of ${part.parent.title}: it keeps its own card, chat and tasks`
            : `A task of ${part.parent.title}, shown on the board`}>{part.text}</span>
        </div>
      )}
      <KeyHint inset className="card-keys" keys={doneHint ? "↵ open · S star · P pin · M move · D done · Space drag" : `↵ open · S star${done ? "" : " · P pin"} · M move · Space drag`} />
      <div className="card-title" title={ticket.title} id={a11yId && `${a11yId}-title`}>
        {arrival.isNew && <span className="arrived-dot" role="img" aria-label="New here" title="Claude moved this card here" />}
        {ticket.important && <ImportantStar />}{ticket.title}
      </div>
      {part?.note && <div className="card-shown-note" title={part.note}>{part.note}</div>}
      {via && <div className="card-via" title={`Found in the step “${via}”`}>via {via}</div>}
      {!showActivity && fc?.line && !att ? (
        <FamilyLineView line={fc.line} fc={fc} id={a11yId && `${a11yId}-line`} />
      ) : huddleLine ? (
        <div id={a11yId && `${a11yId}-line`} className="card-family-line card-huddle-line" title={huddleLine}>
          <span className="spinner" aria-hidden />
          <span className="activity-text">{huddleLine}</span>
        </div>
      ) : showActivity ? (
        // Keyed on the text, so each new step fades in instead of swapping.
        <div key={ticket.lastActivity!} id={a11yId && `${a11yId}-line`} className="card-activity" title={step ? `${ticket.lastActivity!}\n${step.quiet ? "No new step" : "Last step"} ${step.text} ago` : ticket.lastActivity!}>
          <span className="activity-text">{ticket.lastActivity}</span>
          {step && <span className={`step-age${step.quiet ? " quiet" : ""}`}>{step.quiet ? ` · quiet for ${step.text}` : ` · ${step.text}`}</span>}
        </div>
      ) : last && !signIn && previewShown(boardColumnOf(ticket)) && (
        <div className="card-last" title={last.text}>
          <span className={`who ${last.role}`}>{lastWho(last)}:</span>{" "}
          {plainPreview(last.from === "huddle" ? digestPreview(last.text) : last.text)}
        </div>
      )}
      {(pill || facts.length > 0 || ticket.scheduleId || ticket.needs?.length || ticket.devices || ticket.followUp || hasJobs || ticket.terminalOpen || extras.length > 0) && (
        <div className="card-meta" id={a11yId && `${a11yId}-meta`}>
          {pill}
          {ticket.scheduleId && (
            <span className="badge sched" title="Created by a schedule" aria-label="Scheduled">
              <ClockIcon size={12} strokeWidth={1.8} />
            </span>
          )}
          <DeviceChips ticket={ticket} />
          {/* Why Claude stopped following up is history: the ticket shows it, the card doesn't. */}
          {limit && ticket.followUp && (
            <FollowUpChip slug={limit.slug} ticket={ticket} onError={limit.onError} disabled={dragging} />
          )}
          {hasJobs && <JobChip jobs={jobs!} ticketId={ticket.id} onOpen={dragging ? undefined : onOpenJobs} />}
          {ticket.workdir && ticket.terminalOpen && <span className="badge running" title="This ticket's Claude Code chat is open in a terminal"><span className="live-dot" /> In terminal</span>}
          {folded.shown.map((x) => <Fragment key={x.key}>{x.node}</Fragment>)}
          {folded.more > 0 && <span className="badge more-chips" title={hiddenLabels.join("\n")} aria-label={`${folded.more} more: ${hiddenLabels.join(", ")}`}>+{folded.more}</span>}
          {facts.length > 0 && (
            <span className="card-facts">
              {facts.map((f, i) => <Fragment key={f.key}>{i > 0 && <span className="card-facts-sep" aria-hidden> · </span>}{f.node}</Fragment>)}
            </span>
          )}
        </div>
      )}
      {limit && !dragging && limitWait(ticket) && <LimitActions slug={limit.slug} ticket={ticket} onError={limit.onError} small secondary={false} />}
      {limit && !dragging && capWait(ticket) && <CapActions slug={limit.slug} ticket={ticket} onError={limit.onError} small />}
      {limit && !dragging && stallWait(ticket) && <StallActions slug={limit.slug} ticket={ticket} onError={limit.onError} small secondary={false} />}
    </article>
  );
}
