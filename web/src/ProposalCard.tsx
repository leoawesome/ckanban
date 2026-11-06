import { useLayoutEffect, useRef, useState } from "react";
import type { Proposal } from "./api";
import { KeyHint } from "./KeyHint";
import { MOD } from "./Shortcuts";
import { ImportantStar } from "./StarToggle";
import { Markdown } from "./Transcript";

/**
 * A proposal on a ticket that already ran (Done, In review, or ran before): it becomes a new linked ticket, so the
 * original keeps its title and description. state: how the note names the original ("Done", "In review", null: it ran).
 * created: the add-on ticket made from this proposal.
 */
export interface AddOn {
  state: string | null;
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

/** Claude's proposed title/description; Apply replaces the ticket's fields, Apply & start work also moves it to Ready. */
export function ProposalCard({ proposal, applied, started, onApply, onApplyStart, keyHint, addOn, family }: {
  proposal: Proposal;
  applied: boolean;
  /** Applied with "Apply & start work" in this session. */
  started?: boolean;
  onApply: () => Promise<void>;
  /** Set when the ticket can start from here (Backlog/Planning, Claude idle). */
  onApplyStart?: () => Promise<void>;
  /** The newest unapplied proposal: ⌘⇧Enter in the panel applies this one (and starts work when it can). */
  keyHint?: boolean;
  /** Set on a ticket that already ran: the card offers an add-on ticket first (see AddOn). */
  addOn?: AddOn;
  /** What Apply does to the ticket's family (proposal.partOf), e.g. Moves it under “Outbound calls”. */
  family?: string;
}) {
  const [busy, setBusy] = useState<"apply" | "start" | null>(null);
  const run = (kind: "apply" | "start", fn: () => Promise<void>) => async () => {
    setBusy(kind);
    try { await fn(); } finally { setBusy(null); }
  };
  const hint = keyHint ? `${MOD}⇧Enter` : null;
  if (addOn && !applied) return <AddOnCard {...{ proposal, addOn, busy, run, onApply, keyHint, hint }} />;
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
          <span className="badge ok">{started ? "Applied · moved to Queued" : "Applied to ticket"}</span>
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
              ? "Replaces the title and description. Start work moves it to Queued; Claude works on its own."
              : "Replaces the title and description. You can undo right after."}
        </span>
      </div>
    </div>
  );
}

function AddOnCard({ proposal, addOn, busy, run, onApply, keyHint, hint }: {
  proposal: Proposal; addOn: AddOn;
  busy: "apply" | "start" | null; run: (kind: "apply" | "start", fn: () => Promise<void>) => () => Promise<void>;
  onApply: () => Promise<void>; keyHint?: boolean; hint: string | null;
}) {
  const { created } = addOn;
  return (
    <div className={`proposal ticket-proposal ${created ? "applied" : ""}`}>
      <div className="proposal-head">
        <span className="proposal-tag">Proposed add-on ticket</span>
      </div>
      {proposal.title && <div className="proposal-title">{proposal.important && <ImportantStar />}{proposal.title}</div>}
      {proposal.description && <ProposalBody text={proposal.description} />}
      {created ? (
        <div className="proposal-actions">
          <span className="badge ok">Add-on ticket created</span>
          <button className="link-btn ticket-link" onClick={() => addOn.onOpen(created.id)}>Open “{created.title}” →</button>
        </div>
      ) : (
        <>
          <div className="proposal-note">
            {addOn.state ? `This ticket is ${addOn.state}.` : "This ticket already ran."} An add-on ticket keeps this one's title and description as they are.
          </div>
          <div className="proposal-actions">
            <button className="btn primary small" disabled={!!busy}
              title={`Creates a new ticket linked to this one and moves it to Queued; Claude works on its own${hint ? ` (${hint})` : ""}`}
              onClick={run("start", () => addOn.onCreate(true))}>
              {busy === "start" ? "Creating…" : "Create add-on ticket & start work"}{keyHint && <KeyHint keys="⌘⇧↵" />}
            </button>
            <button className="btn small" disabled={!!busy} onClick={run("apply", () => addOn.onCreate(false))}>
              {busy === "apply" ? "Creating…" : "Create add-on ticket"}
            </button>
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
