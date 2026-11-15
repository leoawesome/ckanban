// Find links (board menu): Claude reads the board's open and recent tickets once and suggests which family each
// unlinked ticket belongs to, grouped by parent. Nothing changes until Link selected.
import { useEffect, useMemo, useState } from "react";
import { api, COLUMNS, type Ticket } from "./lib/api";
import { FormError } from "./components/formParts";
import { RefreshIcon } from "./components/icons";
import { Modal, ModalCancel } from "./components/Modal";
import { toast } from "./components/toast";
import { useNow } from "./hooks/useNow";

type Found = { id: string; parent: string; reason: string };

export function FindLinksDialog({ slug, tickets, onClose }: { slug: string; tickets: Ticket[]; onClose: () => void }) {
  const [found, setFound] = useState<{ links: Found[]; checked: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** Bumped by Retry: asks Claude again. */
  const [attempt, setAttempt] = useState(0);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const waiting = !found && !err;
  const now = useNow(waiting);

  useEffect(() => {
    let live = true;
    setStartedAt(Date.now());
    api.findLinks(slug).then((r) => {
      if (!live) return;
      setFound(r);
      setPicked(new Set(r.links.map((l) => l.id)));
    }, (e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [slug, attempt]);
  const retry = () => { setErr(null); setFound(null); setAttempt((n) => n + 1); };
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));

  const byId = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets]);
  // Grouped by parent, in the order Claude named them; links whose tickets went meanwhile are left out.
  const groups = useMemo(() => {
    const out = new Map<string, Found[]>();
    for (const l of found?.links ?? []) {
      if (!byId.has(l.id) || !byId.has(l.parent)) continue;
      (out.get(l.parent) ?? out.set(l.parent, []).get(l.parent)!).push(l);
    }
    return [...out];
  }, [found, byId]);
  const shown = groups.flatMap(([, ls]) => ls);
  const chosen = shown.filter((l) => picked.has(l.id));

  const toggle = (lid: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(lid)) n.delete(lid);
    else n.add(lid);
    return n;
  });

  const linkSelected = async () => {
    setBusy(true);
    const failed: string[] = [];
    for (const l of chosen) {
      try {
        await api.setPartOf(slug, l.id, l.parent);
      } catch (e) {
        failed.push(`${byId.get(l.id)?.title ?? l.id}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    const done = chosen.length - failed.length;
    if (done) toast(`Linked ${done} ticket${done === 1 ? "" : "s"}`, { tone: "ok" });
    if (failed.length) setErr(`Couldn't link ${failed.length}: ${failed.join("; ")}`);
    else onClose();
  };

  const column = (t?: Ticket) => (t ? COLUMNS.find((c) => c.id === t.status)?.label ?? t.status : "");

  return (
    <Modal title="Suggested links" onClose={onClose} wide className="find-links">
      <div className="find-links-body">
        {waiting && (
          <p className="muted small find-links-wait" role="status">
            <span className="spinner" aria-hidden /> Claude is reading your open and recent tickets to find which belong together. This takes about a minute
            <span className="find-links-elapsed"> ({secs}s so far)</span>.
          </p>
        )}
        {found && (
          <p className="muted small">
            Claude checked {found.checked} open and recent tickets. {shown.length ? `${shown.length} link${shown.length === 1 ? "" : "s"} suggested.` : "No links to suggest."} Nothing changes until you click Link selected.
          </p>
        )}
        <div className="find-links-list">
          {groups.map(([parent, ls]) => (
            <div key={parent} className="find-links-group">
              <div className="find-links-parent">{byId.get(parent)!.title} <span className="muted small">{column(byId.get(parent))}</span></div>
              {ls.map((l) => (
                <label key={l.id} className="find-links-item">
                  <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} />
                  <span>
                    {byId.get(l.id)!.title}
                    {l.reason && <span className="find-links-why">{l.reason}</span>}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
        <FormError>{err}</FormError>
        <div className="form-actions find-links-foot">
          <span className="muted small">{shown.length ? `${chosen.length} of ${shown.length} selected` : ""}</span>
          <span>
            <ModalCancel label={found && !shown.length ? "Close" : "Cancel"} />
            {err && !found && <button className="btn icon-label" onClick={retry}><RefreshIcon size={14} aria-hidden /> Retry</button>}
            {shown.length > 0 && (
              <button className="btn primary" disabled={busy || !chosen.length} onClick={linkSelected}>{busy ? "Linking…" : "Link selected"}</button>
            )}
          </span>
        </div>
      </div>
    </Modal>
  );
}
