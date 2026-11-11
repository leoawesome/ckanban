// The Tasks tab (DrawerTab "family"): on a feature's top ticket its status on top (StatusBlock), then the whole feature from its top ticket down, grouped and folded, with each ticket's model, cost and
// status, a short view of the clicked row, the plan controls of a planner, and "Add tickets…" (GatherDialog).
import { resolveRun, runText } from "./models";
import { useEffect, useMemo, useState } from "react";
import { api, COLUMNS, type FamilyViewRow, type Profile, type Ticket } from "./api";
import { childrenByParent, familyOf, familyState, featureRows, groupsOf, groupSummary, MAX_LEVEL, matchWords, settled, STATE_WORDS, subFeatureState, type FamilyRow, type FamilyState } from "./family";
import { ClaudeFace } from "./ConvTurn";
import { familyMood } from "./avatarMood";
import { familyText } from "./FamilyPanel";
import { Modal } from "./Modal";
import { copyText } from "./share";
import { PlanControls } from "./PlanPanel";
import { ImportantStar } from "./StarToggle";
import { StatusBlock, useFeatureStatus } from "./StatusBlock";
import { timeAgo } from "./time";
import { toast } from "./toast";
import { Markdown } from "./Transcript";
import { MenuSheet } from "./MenuSheet";
import { usePhone } from "./usePhone";

const columnLabel = (status: string) => COLUMNS.find((c) => c.id === status)?.label ?? status;

/** A step's kind as a word on its detail line. */
const KIND_WORDS: Record<string, string> = { explore: "Explore", build: "Build", test: "Test", review: "Review", fix: "Fix", with_you: "With you" };

const money = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`;

/** The pill class for a status word. */
export const STATE_CLASS: Record<FamilyState, string> = {
  waiting: "wait", working: "work", done: "done", passed: "done", problem: "prob", failed: "prob", needs_you: "you", in_review: "you", paused: "wait",
};

/** A sub-feature's row: one line with its task count and Open; its tasks are its own (featureRows leaves them out). */
const subRow = (r: FamilyRow<Ticket>) => r.depth > 0 && !!r.ticket.main;

/** A row that holds others: a group or round, or any ticket with children (never a sub-feature: it opens on its own). */
const holds = (r: FamilyRow<Ticket>, kids: Map<string, unknown[]>) => !subRow(r) && ((kids.get(r.ticket.id)?.length ?? 0) > 0 || r.ticket.kind === "group" || r.ticket.kind === "round");

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function FamilyTab({ slug, profile, ticket, tickets, planChildren, onOpenTicket, onError, onMoveToDone, onAddMore }: {
  slug: string;
  /** The board: its model, Main ticket model and effort fill in what a ticket leaves unset. */
  profile: Profile;
  ticket: Ticket;
  tickets: Ticket[];
  /** Children of the opened ticket's plan (its plan controls show when there are any). */
  planChildren: Ticket[];
  onOpenTicket: (id: string) => void;
  onError: (m: string) => void;
  onMoveToDone: () => void;
  onAddMore: () => void;
}) {
  // Its own feature: a sub-feature is one row here, and opened it shows its own tasks.
  const rows = useMemo(() => featureRows(tickets, ticket.id), [tickets, ticket.id]);
  const kids = useMemo(() => childrenByParent(tickets), [tickets]);
  const top = rows[0]?.ticket;
  const feature = useFeatureStatus(slug, ticket, tickets);
  // Reload the server's view (costs, summaries) when any ticket of the family changes.
  const key = rows.map((r) => `${r.ticket.id}:${r.ticket.updatedAt}`).join("|");
  const [view, setView] = useState<Map<string, FamilyViewRow>>(new Map());
  useEffect(() => {
    let live = true;
    api.familyView(slug, ticket.id).then((v) => live && setView(new Map(v.map((r) => [r.id, r]))), () => {});
    return () => {
      live = false;
    };
  }, [slug, ticket.id, key]);
  // With no model or effort on the board, runs use Claude Code's own defaults: name them instead of "Default model".
  const [claude, setClaude] = useState<{ model: string | null; effort?: string | null } | null>(null);
  useEffect(() => {
    if (!profile.model || !profile.effort) api.claudeDefaults().then(setClaude, () => {});
  }, [profile.model, profile.effort]);
  const stateOf = (t: Ticket): FamilyState => familyState(t, view.get(t.id)?.needsYou ?? (!!t.attention && t.attention.kind !== "review"));
  // Folded: groups whose children are all settled, unless the user opened them (and the one holding the opened ticket).
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [peek, setPeek] = useState<string | null>(null);
  const [gathering, setGathering] = useState(false);
  const [report, setReport] = useState<{ title: string; text: string } | null>(null);
  const phone = usePhone();
  if (!top) return null;
  const below = (id: string): Ticket[] => (kids.get(id) ?? []).flatMap((c) => [c.ticket, ...(c.ticket.main ? [] : below(c.ticket.id))]);
  const [acting, setActing] = useState<string | null>(null);
  const act = (id: string, p: Promise<unknown>, done?: string) => {
    setActing(id);
    p.then(() => done && toast(done), (e) => onError((e as Error).message)).finally(() => setActing(null));
  };
  const path = new Set<string>();
  {
    const at = rows.findIndex((r) => r.ticket.id === ticket.id);
    const seen: FamilyRow<Ticket>[] = [];
    for (const r of rows.slice(0, at)) seen[r.depth] = r;
    seen.slice(0, rows[at]?.depth ?? 0).forEach((r) => r && path.add(r.ticket.id));
  }
  const isOpen = (r: FamilyRow<Ticket>) => {
    if (open[r.ticket.id] !== undefined) return open[r.ticket.id];
    if (r.depth === 0 || path.has(r.ticket.id)) return true;
    const inside = below(r.ticket.id);
    return !inside.length || !inside.every((k) => settled(stateOf(k)));
  };
  const shown: FamilyRow<Ticket>[] = [];
  let hideBelow: number | null = null;
  for (const r of rows) {
    if (hideBelow !== null && r.depth > hideBelow) continue;
    hideBelow = null;
    shown.push(r);
    if (holds(r, kids) && r.depth > 0 && !isOpen(r)) hideBelow = r.depth;
  }
  const total = rows.reduce((n, r) => n + (view.get(r.ticket.id)?.costUsd ?? 0), 0);
  const cost = (r: FamilyRow<Ticket>) => {
    const own = view.get(r.ticket.id)?.costUsd ?? 0;
    if (r.depth === 0 || !holds(r, kids) || isOpen(r)) return own;
    return below(r.ticket.id).reduce((n, k) => n + (view.get(k.id)?.costUsd ?? 0), own);
  };
  const peeked = peek ? rows.find((r) => r.ticket.id === peek) : undefined;
  const pv = peeked && view.get(peeked.ticket.id);
  const groupOf = (id: string) => {
    const at = rows.findIndex((r) => r.ticket.id === id);
    return rows.slice(0, at).findLast((r) => r.depth === 1 && r.depth < rows[at].depth)?.ticket.title ?? null;
  };
  const readReport = async (t: Ticket) => {
    try {
      setReport({ title: t.title, text: await api.outputText(slug, t.id, "report.md") });
    } catch (e) {
      onError(`Couldn't open the report: ${(e as Error).message}`);
    }
  };
  return (
    <section className="family-tab">
      {feature.status && <StatusBlock slug={slug} ticket={ticket} tickets={tickets} status={feature.status} onChanged={feature.reload} onOpenTicket={onOpenTicket} />}
      {planChildren.length > 0 && (
        <PlanControls slug={slug} ticket={ticket} children={planChildren} onOpenTicket={onOpenTicket} onError={onError} onMoveToDone={onMoveToDone} onAddMore={onAddMore} countShown={!!feature.status} />
      )}
      <div className="family-tab-head">
        <b>Tasks</b>
        <span className="muted small">{rows.length} ticket{rows.length === 1 ? "" : "s"} · {money(total)}</span>
        <button className="mini-link" onClick={() => copyText(familyText(rows), "Task list copied")}
          title="Copy the tasks as a list, for example to ask Claude to summarise this piece of work">Copy list</button>
        <button className="mini-link" onClick={() => setGathering(true)} title={`Bring tickets you already made into "${top.title}"`}>Add tickets…</button>
      </div>
      <div className="family-tab-tree" role="tree">
        {shown.map((r) => {
          const t = r.ticket;
          const group = holds(r, kids) && r.depth > 0;
          const st = stateOf(t);
          const inside = group ? below(t.id) : [];
          const groupState: FamilyState = subRow(r) ? subFeatureState(tickets, t.id, st) : group ? (inside.every((k) => settled(stateOf(k))) ? "done" : inside.some((k) => stateOf(k) === "needs_you") ? "needs_you" : inside.some((k) => stateOf(k) === "in_review") ? "in_review" : "working") : st;
          const v = view.get(t.id);
          return (
            <div key={t.id} role="treeitem" aria-current={t.id === ticket.id ? "true" : undefined}
              className={`ft-row${group ? " group" : ""}${t.id === ticket.id ? " me" : ""}${peek === t.id ? " peeked" : ""}`}
              style={{ paddingLeft: 8 + r.depth * 16 }} onClick={() => setPeek(peek === t.id ? null : t.id)} title={t.title}>
              <button className={`ft-chev${holds(r, kids) && r.depth > 0 ? "" : " none"}`} aria-label={isOpen(r) ? "Fold" : "Unfold"} tabIndex={holds(r, kids) && r.depth > 0 ? 0 : -1}
                onClick={(e) => {
                  e.stopPropagation();
                  if (holds(r, kids) && r.depth > 0) setOpen((o) => ({ ...o, [t.id]: !isOpen(r) }));
                }}>{holds(r, kids) ? (isOpen(r) || r.depth === 0 ? "▾" : "▸") : ""}</button>
              {/* Its Claude's face in the row's state (the words beside it say the state too). */}
              <span className="ft-face" aria-hidden><ClaudeFace mood={familyMood(groupState)} size={20} /></span>
              <span className="ft-body">
                <span className="ft-title">{subRow(r) && <span className="part-chip ft-sub">Sub-feature</span>}{t.important && <ImportantStar />}{t.title}</span>
                <span className="ft-meta">
                  {subRow(r)
                    ? <span className="ft-sum">{plural(featureRows(tickets, t.id).length - 1, "task")}</span>
                    : group
                    ? <span className="ft-sum">{groupSummary(inside.map((k) => ({ kind: k.kind, state: stateOf(k) })))}</span>
                    : <span className="ft-model">{[t.kind ? KIND_WORDS[t.kind] : null, runText(resolveRun(t, profile, claude))].filter(Boolean).join(" · ")}</span>}
                  <span className={`ft-st ${STATE_CLASS[groupState]}`}>{STATE_WORDS[groupState]}</span>
                  {v && cost(r) > 0 && <span className="ft-cost">{money(cost(r))}</span>}
                </span>
              </span>
              {(subRow(r) || (t.tool && r.depth > 0)) && (
                <span className="ft-actions" onClick={(e) => e.stopPropagation()}>
                  {subRow(r) ? (
                    <button className="mini-link" onClick={() => onOpenTicket(t.id)} title={`Open ${t.title}: its own chat and tasks`}>Open</button>
                  ) : (
                    <>
                      <label className="ft-show" title={t.showOnBoard ? "Hide its card again; it stays in this list" : "Give it its own card on the board; its questions still come to this chat"}>
                        <input type="checkbox" checked={!!t.showOnBoard} disabled={acting === t.id}
                          onChange={(e) => act(t.id, api.setShowOnBoard(slug, t.id, e.target.checked))} /> Show on board
                      </label>
                      <button className="mini-link" disabled={acting === t.id || !!t.running}
                        title={t.running ? "Wait until it stops working" : `Becomes its own work with its own card, chat and tasks, still part of ${rows[0]?.ticket.title ?? "this feature"}`}
                        onClick={() => act(t.id, api.makeOwnWork(slug, t.id), `${t.title} is now its own work`)}>Make it its own work</button>
                    </>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {peeked && (
        <MenuSheet onClose={() => setPeek(null)}>
        <div className="ft-peek" role={phone ? "dialog" : undefined} aria-label={phone ? peeked.ticket.title : undefined}>
          <h3>{peeked.ticket.title}</h3>
          <div className="muted small">
            {[groupOf(peeked.ticket.id), runText(resolveRun(peeked.ticket, profile, claude)),
              pv?.finishedAt ? `finished ${timeAgo(pv.finishedAt)}` : peeked.ticket.running ? "working now" : columnLabel(peeked.ticket.status)].filter(Boolean).join(" · ")}
          </div>
          {pv?.summary ? <div className="ft-peek-sum"><Markdown text={pv.summary} /></div> : <p className="muted small">No result yet.</p>}
          <div className="ft-peek-btns">
            {peeked.ticket.id !== ticket.id && <button className="btn small" onClick={() => onOpenTicket(peeked.ticket.id)}>Open ticket</button>}
            {pv?.report && <button className="btn small" onClick={() => void readReport(peeked.ticket)}>Read report</button>}
            {phone && <button className="btn small ft-peek-close" onClick={() => setPeek(null)}>Close</button>}
          </div>
        </div>
        </MenuSheet>
      )}
      {gathering && <GatherDialog slug={slug} top={top} tickets={tickets} onClose={() => setGathering(false)} onError={onError} />}
      {report && (
        <Modal title={`Report: ${report.title}`} wide onClose={() => setReport(null)}>
          <div className="ft-report"><Markdown text={report.text} /></div>
        </Modal>
      )}
    </section>
  );
}

/** How many levels a ticket's own tickets go down below it (0: none). */
function subtreeDepths(tickets: Ticket[], id: string): FamilyRow<Ticket>[] {
  const rows = familyOf(tickets, id);
  const at = rows.findIndex((r) => r.ticket.id === id);
  const out: FamilyRow<Ticket>[] = [];
  for (let i = at + 1; i < rows.length && rows[i].depth > rows[at].depth; i++) out.push({ ...rows[i], depth: rows[i].depth - rows[at].depth });
  return out;
}

/** Gather tickets into a feature: search, pick, choose a group for each, then link them all at once. */
export function GatherDialog({ slug, top, tickets, onClose, onError }: {
  slug: string; top: Ticket; tickets: Ticket[]; onClose: () => void; onError: (m: string) => void;
}) {
  const [q, setQ] = useState(() => [...matchWords(top.title)].join(" "));
  const inFamily = useMemo(() => new Set(familyOf(tickets, top.id).map((r) => r.ticket.id)), [tickets, top.id]);
  const groups = useMemo(() => groupsOf(tickets, top.id), [tickets, top.id]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [newGroup, setNewGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return tickets
      .filter((t) => !inFamily.has(t.id))
      .map((t) => ({ t, hits: words.filter((w) => t.title.toLowerCase().includes(w) || t.id === w).length }))
      .filter((x) => !words.length || x.hits > 0)
      .sort((a, b) => b.hits - a.hits || b.t.updatedAt.localeCompare(a.t.updatedAt))
      .slice(0, 40)
      .map((x) => x.t);
  }, [q, tickets, inFamily]);
  const chosen = Object.keys(picked);
  const usesNew = Object.values(picked).includes("new");
  // Their own tickets that would sit deeper than level 2 move up beside them: say so before Add.
  const moving = chosen.flatMap((id) => {
    const level = picked[id] ? 2 : 1;
    return subtreeDepths(tickets, id).filter((r) => level + r.depth > MAX_LEVEL).map((r) => r.ticket.title);
  });
  const gather = async () => {
    setBusy(true);
    try {
      const r = await api.gather(slug, top.id, chosen.map((id) => ({ id, group: picked[id] || null })), usesNew ? newGroup.trim() || "New group" : null);
      toast(`Added ${r.gathered.length} ticket${r.gathered.length === 1 ? "" : "s"} to ${top.title}${r.skipped.length ? `; ${r.skipped.length} skipped: ${r.skipped.map((s) => s.reason).join("; ")}` : ""}.`);
      onClose();
    } catch (e) {
      onError(`Couldn't add the tickets: ${(e as Error).message}`);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Add tickets to ${top.title}`} wide onClose={onClose} guard={chosen.length > 0 && !busy}>
      <div className="gather">
        <input className="gather-search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find tickets…" aria-label="Find tickets to add" />
        <div className="gather-list">
          {options.map((t) => (
            <label key={t.id} className="gather-row">
              <input type="checkbox" checked={t.id in picked} onChange={(e) => setPicked((p) => {
                const next = { ...p };
                if (e.target.checked) next[t.id] = "";
                else delete next[t.id];
                return next;
              })} />
              <span className="gather-title" title={t.title}>{t.title}</span>
              <span className={`gather-col st-${t.status}`}>{columnLabel(t.status)}</span>
              <select value={picked[t.id] ?? ""} disabled={!(t.id in picked)} aria-label={`Group for ${t.title}`}
                onChange={(e) => setPicked((p) => ({ ...p, [t.id]: e.target.value }))}>
                <option value="">No group</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                <option value="new">New group</option>
              </select>
            </label>
          ))}
          {!options.length && <p className="muted small gather-empty">No matching tickets outside this feature.</p>}
        </div>
        {usesNew && (
          <label className="gather-new">New group's name <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="e.g. Fixes" /></label>
        )}
        <p className="hint muted small">
          Picked tickets keep their chats, work and changes, and tickets still running keep running. They move under {top.title}, grouped as shown.
        </p>
        {moving.length > 0 && (
          <p className="gather-warn small" role="status">
            {moving.length} of their own ticket{moving.length === 1 ? "" : "s"} ({moving.slice(0, 4).join(", ")}{moving.length > 4 ? ", …" : ""}) move up beside {moving.length === 1 ? "its parent" : "their parents"}, so the feature stays at most 2 levels deep.
          </p>
        )}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!chosen.length || busy} onClick={() => void gather()}>
            {busy ? "Adding…" : `Add ${chosen.length} ticket${chosen.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
