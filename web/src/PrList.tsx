// The ticket's PRs near the top of the drawer: one compact box, or a "Pull requests" list that folds (remembered
// per browser). In Review the main PR also gets the PR box with its checks and Merge & done (PrBox.tsx).
import { useState } from "react";
import { safeHref, type Ticket, type TicketPr } from "./api";
import { ExternalIcon } from "./icons";
import { currentPr, prNumber, prRepo, prStateWord, prSummary, ticketPrs } from "./prText";

/** Rows shown before "Show N more". */
const PR_ROWS = 3;
const FOLD_KEY = "ckanban.prsFolded";

/** A PR with the freshest state the drawer has: the main PR's cached status beats the list's last poll. */
function withLatest(t: Ticket, p: TicketPr): TicketPr {
  const pr = p.url === t.prUrl ? currentPr(t) : null;
  return pr ? { ...p, state: pr.state ?? p.state, base: pr.base ?? p.base } : p;
}

function PrMeta({ pr }: { pr: TicketPr }) {
  const parts = [prStateWord(pr.state), pr.base ? `into ${pr.base}` : null].filter(Boolean);
  return parts.length ? <div className="pr-meta">{parts.join(" · ")}</div> : null;
}

export function PrList({ ticket, review }: { ticket: Ticket; review: boolean }) {
  const prs = ticketPrs(ticket).map((p) => withLatest(ticket, p));
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(FOLD_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [all, setAll] = useState(false);
  if (!prs.length) return null;
  // In Review a single PR is the PR box itself.
  if (prs.length === 1) {
    if (review) return null;
    const pr = prs[0];
    return (
      <a className={`pr-one st-${(pr.state ?? "unknown").toLowerCase()}`} href={safeHref(pr.url)} target="_blank" rel="noreferrer">
        <span className="pr-one-title">PR {prNumber(pr.url)} <ExternalIcon size={11} /></span>
        <PrMeta pr={pr} />
      </a>
    );
  }
  const toggle = () => {
    setFolded((f) => {
      try {
        localStorage.setItem(FOLD_KEY, f ? "0" : "1");
      } catch {}
      return !f;
    });
  };
  const newestFirst = [...prs].reverse();
  const shown = all ? newestFirst : newestFirst.slice(0, PR_ROWS);
  return (
    <section className={`pr-list ${folded ? "folded" : ""}`} aria-label="Pull requests">
      <button className="pr-list-head" onClick={toggle} aria-expanded={!folded} title={folded ? "Show the pull requests" : "Hide the pull requests"}>
        <span className="fold-chev" aria-hidden>▾</span>
        <span className="field-key">Pull requests</span>
        <span className="pr-sp" />
        <span className="muted small">{prSummary(prs)}</span>
      </button>
      {!folded && (
        <div className="pr-rows">
          {shown.map((p) => (
            <div key={p.url} className="pr-row">
              <div className="pr-row-main">
                <a href={safeHref(p.url)} target="_blank" rel="noreferrer">{prRepo(p.url)} {prNumber(p.url)} <ExternalIcon size={11} /></a>
                {p.url === ticket.prUrl && <span className="pr-main" title="Merge & done and the PR box work on this one">main</span>}
                {p.base && <div className="pr-meta">into {p.base}</div>}
              </div>
              {prStateWord(p.state) && <span className={`pr-state st-${p.state!.toLowerCase()}`}>{prStateWord(p.state)}</span>}
            </div>
          ))}
          {prs.length > PR_ROWS && (
            <button className="mini-link pr-more" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show ${prs.length - PR_ROWS} more`}</button>
          )}
        </div>
      )}
    </section>
  );
}
