// "Where we are": the feature's status pinned at the top of its main chat (the family's top ticket). Counts, test
// results and pull requests come from the board; goal, done, broken, waiting on you and next step from Claude's
// update_status; "Add a note" adds what happened outside the board (the main chat gets it at its next turn).
// Calm on purpose: only Next step, Waiting on you, Failed and Paused show by default ("Show more" opens the
// goal, what is done, what runs and pull requests); each failed or paused step says why with one button to move it on
// (Try again, Resume).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type FeatureStatus, type Ticket } from "./api";
import { familyOf, isFeature } from "./family";
import { InfoIcon } from "./icons";
import { pausedLine } from "./limitText";
import { toast } from "./toast";
import { usePersistentState } from "./usePersistentState";
import { timeAgo } from "./time";

/** The feature status when ticket is a feature's top ticket (its main chat), reloaded as the family changes. */
export function useFeatureStatus(slug: string, ticket: Ticket, tickets: Ticket[]): { status: FeatureStatus | null; reload: () => void; loaded: boolean } {
  const rows = useMemo(() => familyOf(tickets, ticket.id), [tickets, ticket.id]);
  const main = rows[0]?.ticket.id === ticket.id && isFeature(tickets, ticket);
  const key = rows.map((r) => `${r.ticket.id}:${r.ticket.status}:${r.ticket.outcome}:${r.ticket.verdict ?? ""}:${(r.ticket.prs ?? []).map((p) => p.state).join(",")}:${r.ticket.running ? 1 : 0}`).join("|");
  const [status, setStatus] = useState<FeatureStatus | null>(null);
  // The ticket whose status answered (or failed) at least once: its notes join the chat's first paint.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!main) {
      setStatus(null);
      return;
    }
    let live = true;
    const id = ticket.id;
    api.featureStatus(slug, id).then((s) => {
      if (!live) return;
      setStatus(s);
      setLoadedFor(id);
    }, () => live && setLoadedFor(id));
    return () => {
      live = false;
    };
  }, [slug, ticket.id, main, ticket.statusAt, key, n]);
  return { status: main ? status : null, reload: () => setN((x) => x + 1), loaded: !main || loadedFor === ticket.id };
}

const Pill = ({ tone, children }: { tone: "ok" | "run" | "bad" | "you"; children: React.ReactNode }) => <span className={`ws-pill ${tone}`}>{children}</span>;

const n = (c: Record<string, number>, ...keys: string[]) => keys.reduce((s, k) => s + (c[k] ?? 0), 0);

/** "4 of 6 done, 1 working, 1 waiting" */
function countText(c: Record<string, number>, total: number): string {
  const parts = [`${n(c, "done", "passed", "problem")} of ${total} done`];
  for (const [k, w] of [["working", "working"], ["waiting", "waiting"], ["needs_you", "need you"], ["failed", "failed"], ["paused", "paused"]] as const) {
    if (c[k]) parts.push(`${c[k]} ${w}`);
  }
  return parts.join(", ");
}

/** Where the words come from, behind the info icon (it used to be two grey lines under the box). */
export const STATUS_SOURCE = "Counts, tests and pull requests come from the board; the summary, decisions and next step are written by Claude. " +
  "\"Add a note\" adds what happened outside the board.";

/** Done, folded to about two lines with "more" when it is longer. */
function Clamped({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  });
  return (
    <>
      <div ref={ref} className={`ws-clamp${open ? " open" : ""}`}>{children}</div>
      {(long || open) && <button className="ws-act ws-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "less" : "more"}</button>}
    </>
  );
}

/** One failed or paused step: its title, why in one line, and the button that moves it on. */
function StepLine({ title, why, action, onOpen }: { title: string; why?: string; action?: { label: string; run: () => Promise<unknown> }; onOpen: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await action!.run();
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ws-step">
      <div className="ws-step-text">
        <button className="link-btn ws-link" onClick={onOpen}>{title}</button>
        {why && <span className="ws-why">{why}</span>}
      </div>
      {action && <button className="btn small" disabled={busy} onClick={() => void go()}>{action.label}</button>}
    </div>
  );
}

export function StatusBlock({ slug, ticket, status, onChanged, onOpenTicket }: {
  slug: string; ticket: Ticket; status: FeatureStatus; onChanged: () => void; onOpenTicket: (id: string) => void;
}) {
  const [hidden, setHidden] = usePersistentState(`ckanban.statusHidden.${slug}.${ticket.id}`, () => false, (v) => !v, (v) => typeof v === "boolean");
  const [more, setMore] = useState(false);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { saved, facts: f } = status;
  const updated = saved?.updatedAt ?? ticket.statusAt ?? null;
  const save = async () => {
    if (!note.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.addStatusNote(slug, ticket.id, note);
      setNote("");
      setNoting(false);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const source = saved?.claudeAt ? STATUS_SOURCE : `Claude fills in the goal, what is done and the next step as the work goes on. ${STATUS_SOURCE}`;
  const head = (
    <div className="ws-head">
      <span className="ws-title">Where we are</span>
      <span className="ws-info" title={source} aria-label={source} role="img"><InfoIcon size={12} /></span>
      {updated && <span className="muted small">updated {timeAgo(updated)}</span>}
      {!hidden && <button className="ws-act" onClick={() => setNoting((v) => !v)}>Add a note</button>}
      <button className="ws-act" onClick={() => setHidden(!hidden)} aria-expanded={!hidden}>{hidden ? "Show" : "Hide"}</button>
    </div>
  );
  if (hidden) return <section className="where-we-are hidden" aria-label="Where we are">{head}</section>;

  const doneGroups = f.groups.filter((g) => g.settled && g.total);
  const looseDone = n(f.loose.counts, "done", "passed", "problem");
  const running = f.groups.filter((g) => !g.settled && g.total);
  const looseActive = n(f.loose.counts, "working", "waiting", "needs_you", "paused");
  const roundOf = (id: string) => f.rounds.find((r) => r.id === id);
  const link = (id: string, title: string) => <button key={id} className="link-btn ws-link" onClick={() => onOpenTicket(id)}>{title}</button>;
  const after = () => onChanged();
  // Shown by default: what moves the work on. The rest sits behind "Show more".
  const rows: { label: string; body: React.ReactNode }[] = [];
  const extra: { label: string; body: React.ReactNode }[] = [];
  if (saved?.next) rows.push({ label: "Next step", body: <span className="ws-next">{saved.next}</span> });
  if (saved?.goal) extra.push({ label: "Goal", body: saved.goal });
  if (doneGroups.length || looseDone || saved?.done) {
    extra.push({
      label: "Done", body: <Clamped>
        {doneGroups.map((g) => {
          const r = roundOf(g.id);
          return <Pill key={g.id} tone="ok">{g.title}{r ? `: ${r.passed} passed${r.problem ? `, ${r.problem} problem` : ""}` : ` · ${g.total}`}</Pill>;
        })}
        {looseDone > 0 && <Pill tone="ok">{looseDone} done</Pill>}
        {saved?.done}
      </Clamped>,
    });
  }
  if (running.length || looseActive) {
    extra.push({
      label: "Running", body: <div className="ws-lines">
        {running.map((g) => {
          const r = roundOf(g.id);
          return <span key={g.id}><Pill tone="run">{g.title}</Pill>{countText(g.counts, g.total)}{r && (r.passed || r.problem) ? ` (${r.passed} passed, ${r.problem} found a problem)` : ""}.</span>;
        })}
        {looseActive > 0 && <span><Pill tone="run">Other tickets</Pill>{countText(f.loose.counts, f.loose.total)}.</span>}
      </div>,
    });
  }
  if (f.needsYou.length || saved?.waiting) {
    rows.push({
      label: "Waiting on you", body: <>
        {f.needsYou.length > 0 && <Pill tone="you">{f.needsYou.length}</Pill>}
        {saved?.waiting ?? <span className="ws-titles">{f.needsYou.map((b, i) => <span key={b.id}>{i > 0 && ", "}{link(b.id, b.title)}</span>)}</span>}
      </>,
    });
  }
  if (f.broken.length || saved?.broken) {
    rows.push({
      label: "Failed", body: <div className="ws-lines">
        {f.broken.map((b) => (
          <StepLine key={b.id} title={b.title} onOpen={() => onOpenTicket(b.id)}
            why={b.reason ?? (b.state === "problem" ? "Found a problem" : undefined)}
            action={b.state === "failed" ? { label: "Try again", run: () => api.updateTicket(slug, b.id, { status: "ready" }).then(after) } : undefined} />
        ))}
        {saved?.broken && <span>{saved.broken}</span>}
      </div>,
    });
  }
  const paused = f.paused ?? [];
  if (paused.length) {
    rows.push({
      label: "Paused", body: <div className="ws-lines">
        {paused.map((p) => (
          <StepLine key={p.id} title={p.title} why={pausedLine(p)} onOpen={() => onOpenTicket(p.id)}
            action={{ label: "Resume", run: () => api.limitContinue(slug, p.id).then(after) }} />
        ))}
      </div>,
    });
  }
  if (f.prs.length) {
    extra.push({
      label: "Pull requests", body: <div className="ws-lines">
        {f.prs.map((p) => (
          <span key={p.url}>
            <a href={p.url} target="_blank" rel="noreferrer"><b>{p.number ? `#${p.number}` : "PR"}</b></a> {p.ticketTitle} · {p.state === "unknown" ? "state not known yet" : p.state === "open" ? "open" : p.state}{p.note ? ` · ${p.note}` : ""}
          </span>
        ))}
      </div>,
    });
  }
  return (
    <section className="where-we-are" aria-label="Where we are">
      {head}
      {noting && (
        <div className="ws-note-form">
          <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What happened outside the board, e.g. a decision made on Slack"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
              if (e.key === "Escape") setNoting(false);
            }} />
          <div className="ws-note-actions">
            <span className="muted small">Claude gets it at its next turn; nothing starts now.</span>
            <button className="btn small" onClick={() => setNoting(false)}>Cancel</button>
            <button className="btn small primary" disabled={busy || !note.trim()} onClick={() => void save()}>Save note</button>
          </div>
          {err && <div className="form-error">{err}</div>}
        </div>
      )}
      <div className="ws-body">
        {/* With nothing to act on, the rest shows straight away. */}
        {[...rows, ...(more || !rows.length ? extra : [])].map((r) => (
          <div key={r.label} className="ws-row"><div className="ws-k">{r.label}</div><div className="ws-v">{r.body}</div></div>
        ))}
        {rows.length > 0 && extra.length > 0 && (
          <button className="ws-act ws-toggle" aria-expanded={more} onClick={() => setMore(!more)}>{more ? "Show less" : "Show more"}</button>
        )}
      </div>
    </section>
  );
}

/** A note the user added, in the chat's timeline. */
export function StatusNoteView({ text }: { text: string }) {
  return <div className="status-note">You added a note: {text}</div>;
}
