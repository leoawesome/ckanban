// Find links (board menu): Claude reads the board's open and recent tickets once and suggests which family each
// unlinked ticket belongs to, grouped by parent. Nothing changes until Link selected.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, COLUMNS, type Ticket } from "./api";
import { useFocusTrap, useLayer } from "./layers";
import { toast } from "./toast";

type Found = { id: string; parent: string; reason: string };

export function FindLinksDialog({ slug, tickets, onClose }: { slug: string; tickets: Ticket[]; onClose: () => void }) {
  const [found, setFound] = useState<{ links: Found[]; checked: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useLayer(onClose);
  useFocusTrap(box);

  useEffect(() => {
    let live = true;
    api.findLinks(slug).then((r) => {
      if (!live) return;
      setFound(r);
      setPicked(new Set(r.links.map((l) => l.id)));
    }, (e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [slug]);

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
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="modal find-links" role="dialog" aria-modal="true" aria-labelledby={id}>
        <h3 id={id}>Suggested links</h3>
        {!found && !err && <p className="muted small">Claude is reading your open and recent tickets to find which belong together. This takes about a minute.</p>}
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
        {err && <div className="form-error">{err}</div>}
        <div className="form-actions find-links-foot">
          <span className="muted small">{shown.length ? `${chosen.length} of ${shown.length} selected` : ""}</span>
          <span>
            <button className="btn ghost" onClick={onClose}>{found && !shown.length ? "Close" : "Cancel"}</button>
            {shown.length > 0 && (
              <button className="btn primary" disabled={busy || !chosen.length} onClick={linkSelected}>{busy ? "Linking…" : "Link selected"}</button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
