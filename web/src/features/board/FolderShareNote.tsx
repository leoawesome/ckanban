import { useState } from "react";
import { api } from "../../lib/api";

/**
 * Under a card that shares a folder without version history with other running tickets (the newest such card only):
 * a short warning and "Turn on version history". While those tickets still change files the server refuses; its
 * message shows here, inline (never a browser dialog).
 */
export function FolderShareNote({ path }: { path: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const turnOn = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.enableVersionHistory(path);
      setDone(true);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  // The card opens on click and Enter: the link and its message keep both to themselves.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  if (done) return <div className="card-share-note" role="status" onClick={stop}>✓ Version history is on.</div>;
  return (
    <div className="card-share-note" onClick={stop} onKeyDown={stop}>
      Both change files in the same folder with no way to undo a clash.{" "}
      <button type="button" className="link-btn" onClick={turnOn} disabled={busy}>{busy ? "Turning on…" : "Turn on version history"}</button>
      {err && <div className="field-error" role="alert">{err}</div>}
    </div>
  );
}
