import { useLayoutEffect, useRef, useState } from "react";
import type { Proposal } from "./api";
import { KeyHint } from "./KeyHint";
import { MOD } from "./Shortcuts";
import { ImportantStar } from "./StarToggle";
import { Markdown } from "./Transcript";
import type { FollowUpPlace } from "./followUp";

/**
 * A proposal on a plain ticket that already ran (Done, In review, or ran before): follow-up work, so the ticket keeps its
 * title and description (web/src/followUp.ts). state: how the note names the ticket ("Done", "In review", null: it ran).
 * place: where the work goes. created: what this card already made (a step opens in its main ticket).
 */
export interface FollowUp {
  state: string | null;
  place: FollowUpPlace;
  created?: { id: string; title: string };
  onCreate: (start: boolean) => Promise<void>;
  onOpen: (id: string) => void;
}

/** The proposed description, clamped to 3 lines with "more", so the buttons stay on screen. */
function ProposalBody({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  });
  return (
    <>
      <div ref={ref} className={`proposal-body${open ? " open" : ""}`}><Markdown text={text} /></div>
      {(long || open) && <button className="link-btn proposal-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "less" : "more"}</button>}
    </>
  );
}

/** Claude's proposed title/description; Apply replaces the ticket's fields, Apply & start work also queues it (status `ready`, shown in the In Progress column). */
export function ProposalCard({ proposal, applied, started, onApply, onApplyStart, keyHint, followUp, family }: {
  proposal: Proposal;
  applied: boolean;
  /** Applied with "Apply & start work" in this session. */
  started?: boolean;
  onApply: () => Promise<void>;
  /** Set when the ticket can start from here (Backlog/Planning, Claude idle). */
  onApplyStart?: () => Promise<void>;
  /** The newest unapplied proposal: ⌘⇧Enter in the panel applies this one (and starts work when it can). */
  keyHint?: boolean;
  /** Set on a plain ticket that already ran: the card offers follow-up work first (see FollowUp). */
  followUp?: FollowUp;
  /** What Apply does to the ticket's family (proposal.partOf), e.g. Moves it under “Outbound calls”. */
  family?: string;
}) {
  const [busy, setBusy] = useState<"apply" | "start" | null>(null);
  const run = (kind: "apply" | "start", fn: () => Promise<void>) => async () => {
    setBusy(kind);
    try { await fn(); } finally { setBusy(null); }
  };
  const hint = keyHint ? `${MOD}⇧Enter` : null;
  if (followUp && !applied) return <FollowUpCard {...{ proposal, followUp, busy, run, onApply, keyHint, hint }} />;
  return (
    <div className={`proposal ticket-proposal ${applied ? "applied" : ""}`}>
      <div className="proposal-head">
        <span className="proposal-tag">Proposed ticket</span>
      </div>
      {proposal.title && <div className="proposal-title">{proposal.important && <ImportantStar />}{proposal.title}</div>}
      {proposal.description && <ProposalBody text={proposal.description} />}
      {family && <div className="proposal-family muted small">{family}</div>}
      <div className="proposal-actions">
        {applied ? (
          <span className="badge ok">{started ? "Applied · moved to In Progress" : "Applied to ticket"}</span>
        ) : onApplyStart ? (
          <>
            <button className="btn primary small" disabled={!!busy} title={hint ? `Apply & start work (${hint})` : undefined}
              onClick={run("start", onApplyStart)}>
              {busy === "start" ? "Starting…" : "Apply & start work"}{keyHint && <KeyHint keys="⌘⇧↵" />}
            </button>
            <button className="btn small" disabled={!!busy} onClick={run("apply", onApply)}>
              {busy === "apply" ? "Applying…" : "Apply only"}
            </button>
          </>
        ) : (
          <button className="btn primary small" disabled={!!busy} title={hint ? `Apply to ticket (${hint})` : undefined}
            onClick={run("apply", onApply)}>
            {busy === "apply" ? "Applying…" : "Apply to ticket"}{keyHint && <KeyHint keys="⌘⇧↵" />}
          </button>
        )}
        <span className="muted small">
          {applied
            ? started ? "Claude starts when a slot is free." : "You can still edit them in the details."
            : onApplyStart
              ? "Replaces the title and description. Start work moves it to In Progress; Claude starts when a slot is free."
              : "Replaces the title and description. You can undo right after."}
        </span>
      </div>
    </div>
  );
}

/** What the card says follow-up work does, by where it goes. */
function followUpWords(f: FollowUp): { tag: string; note: string; start: string; done: string } {
  const was = f.state ? `This ticket is ${f.state}.` : "This ticket already ran.";
  const p = f.place;
  if (p.as === "step") {
    return {
      tag: "Proposed follow-up step", start: "Start as a step", done: "Step started",
      note: `${was} It keeps its title and description; the work runs as a step of “${p.main.title}” and reports there, so you follow it on that card.`,
    };
  }
  if (p.as === "main") {
    return {
      tag: "Proposed follow-up step", start: "Start as a step", done: "Step started",
      note: `${was} You keep talking here: the work runs as its first step, and from then on steps do the work while Claude talks with you here.`,
    };
  }
  return { tag: "Proposed follow-up ticket", start: "Create ticket & start work", done: "Ticket created", note: `${was} A new ticket next to this one keeps this one's title and description as they are.` };
}

function FollowUpCard({ proposal, followUp, busy, run, onApply, keyHint, hint }: {
  proposal: Proposal; followUp: FollowUp;
  busy: "apply" | "start" | null; run: (kind: "apply" | "start", fn: () => Promise<void>) => () => Promise<void>;
  onApply: () => Promise<void>; keyHint?: boolean; hint: string | null;
}) {
  const { created } = followUp;
  const w = followUpWords(followUp);
  const step = followUp.place.as !== "ticket";
  return (
    <div className={`proposal ticket-proposal ${created ? "applied" : ""}`}>
      <div className="proposal-head">
        <span className="proposal-tag">{w.tag}</span>
      </div>
      {proposal.title && <div className="proposal-title">{proposal.important && <ImportantStar />}{proposal.title}</div>}
      {proposal.description && <ProposalBody text={proposal.description} />}
      {created ? (
        <div className="proposal-actions">
          <span className="badge ok">{w.done}</span>
          <button className="link-btn ticket-link" onClick={() => followUp.onOpen(created.id)}>Open “{created.title}” →</button>
        </div>
      ) : (
        <>
          <div className="proposal-note">{w.note}</div>
          <div className="proposal-actions">
            <button className="btn primary small" disabled={!!busy}
              title={`${step ? "Claude works on it on its own" : "Creates a new ticket next to this one and moves it to In Progress; Claude works on its own"}${hint ? ` (${hint})` : ""}`}
              onClick={run("start", () => followUp.onCreate(true))}>
              {busy === "start" ? "Starting…" : w.start}{keyHint && <KeyHint keys="⌘⇧↵" />}
            </button>
            {!step && (
              <button className="btn small" disabled={!!busy} onClick={run("apply", () => followUp.onCreate(false))}>
                {busy === "apply" ? "Creating…" : "Create ticket"}
              </button>
            )}
            <button className="btn ghost small" disabled={!!busy} title="Replaces this ticket's title and description; you can undo right after"
              onClick={run("apply", onApply)}>
              Replace this ticket instead
            </button>
          </div>
        </>
      )}
    </div>
  );
}
