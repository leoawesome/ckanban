import { useContext } from "react";
import type { ResultCard } from "./api";
import { FileLinkContext } from "./fileLinkContext";
import { requestTab } from "./pendingTab";
import { QuestionText } from "./QuestionText";

/** Short model name for the card's head ("Opus 5.5"). */
export function modelLabel(m: string | null | undefined): string | null {
  if (!m) return null;
  const x = /claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i.exec(m);
  if (x) return `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}`;
  return m.length > 24 ? null : m[0].toUpperCase() + m.slice(1);
}

/** What the card's badge says. */
export function resultBadge(r: Pick<ResultCard, "outcome" | "verdict" | "kind">): { text: string; tone: "done" | "fail" } {
  if (r.outcome === "done") return r.kind === "test" && r.verdict === "problem" ? { text: "Found a problem", tone: "fail" } : { text: r.kind === "test" ? "Passed" : "Done", tone: "done" };
  if (r.outcome === "needs_input") return { text: "Has a question", tone: "fail" };
  if (r.outcome === "blocked") return { text: "Blocked", tone: "fail" };
  if (r.outcome === "limit") return { text: "Hit the limit", tone: "fail" };
  return { text: "Failed", tone: "fail" };
}

/** A tool ticket's result in its parent's chat (stored on the parent, placed by time like the status notes). */
export function ResultCardView({ r, onOpenTicket }: { r: ResultCard; onOpenTicket: (id: string) => void }) {
  const files = useContext(FileLinkContext);
  const badge = resultBadge(r);
  const meta = [modelLabel(r.model), r.costUsd ? `$${r.costUsd.toFixed(2)}` : null].filter(Boolean).join(" · ");
  return (
    <div className={`result-card${badge.tone === "fail" ? " bad" : ""}`}>
      <div className="r-head">
        <b>{r.title}</b>
        <span className={`r-state ${badge.tone}`}>{badge.text}</span>
        {meta && <span className="muted">{meta}</span>}
      </div>
      {r.summary && <QuestionText className="r-summary" text={r.summary} />}
      {r.folderFiles ? <p className="r-folder muted small">Changed {r.folderFiles} file{r.folderFiles === 1 ? "" : "s"} in your folder</p> : null}
      <div className="r-links">
        {r.report && files && <button className="link-btn" onClick={() => files.open(r.report!)}>Read report</button>}
        {!r.folderFiles && <button className="link-btn" onClick={() => { requestTab(r.ticketId, "changes"); onOpenTicket(r.ticketId); }}>Changes</button>}
        <button className="link-btn" onClick={() => onOpenTicket(r.ticketId)}>Open ticket</button>
      </div>
    </div>
  );
}
