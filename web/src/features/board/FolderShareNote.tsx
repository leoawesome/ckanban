import { useEffect, useState } from "react";
import { api } from "../../lib/api";

/**
 * Under a card that shares a folder without version history with other running tickets. The newest such card shows a
 * short warning and "Turn on version history". While those tickets still change files the board saves the request and
 * turns it on by itself once they have finished: then every sharing card shows that line with a Cancel link (the state
 * comes from the card data, so a reload keeps it). Other refusals show here, inline (never a browser dialog).
 */
export function FolderShareNote({ path, offer, pending }: { path: string; offer: boolean; pending: boolean }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // What this card just asked for, until the card data catches up.
  const [local, setLocal] = useState<boolean | null>(null);
  useEffect(() => setLocal(null), [pending]);
  const waiting = local ?? pending;
  const call = async (f: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const turnOn = () => call(async () => {
    const r = await api.enableVersionHistory(path);
    if ("pending" in r) setLocal(true);
    else setDone(true);
  });
  const cancel = () => call(async () => {
    await api.cancelVersionHistory(path);
    setLocal(false);
  });
  // The card opens on click and Enter: the links and their messages keep both to themselves.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  if (done) return <div className="card-share-note" role="status" onClick={stop}>✓ Version history is on.</div>;
  if (waiting) {
    return (
      <div className="card-share-note" role="status" onClick={stop} onKeyDown={stop}>
        Version history will turn on when these tickets finish.{" "}
        <button type="button" className="link-btn" onClick={cancel} disabled={busy}>Cancel</button>
        {err && <div className="field-error" role="alert">{err}</div>}
      </div>
    );
  }
  if (!offer) return null;
  return (
    <div className="card-share-note" onClick={stop} onKeyDown={stop}>
      Both change files in the same folder with no way to undo a clash.{" "}
      <button type="button" className="link-btn" onClick={turnOn} disabled={busy}>{busy ? "Turning on…" : "Turn on version history"}</button>
      {err && <div className="field-error" role="alert">{err}</div>}
    </div>
  );
}
