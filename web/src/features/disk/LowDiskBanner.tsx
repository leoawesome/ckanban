import { useEffect, useState } from "react";
import { CloseIcon } from "../../components/icons";
import { usePhone } from "../../hooks/usePhone";
import { api, onReconnect, subscribe } from "../../lib/api";
import type { DiskSpace, FreeUp } from "../../lib/api/types/disk";
import { bannerText, showBanner } from "./diskText";

/**
 * Under the header on every screen while the Mac has under 10 GB free: Free up space removes old ticket copies and
 * the packages of finished tickets, with its progress and result in the same line. × hides it until the page reloads.
 * The free space comes once on open and on reconnect, then as `disk.space` events (the server reads it each minute).
 */
export function LowDiskBanner() {
  const phone = usePhone();
  const [space, setSpace] = useState<DiskSpace | null>(null);
  const [freeUp, setFreeUp] = useState<FreeUp | null>(null);
  const [startedHere, setStartedHere] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    const load = () => {
      api.diskSpace().then(setSpace).catch(() => {});
      api.freeUpState().then(setFreeUp).catch(() => {});
    };
    load();
    const offReconnect = onReconnect(load);
    const off = subscribe((e) => {
      if (e.type === "disk.space") setSpace(e.space);
      else if (e.type === "disk.freeup") setFreeUp(e.status);
    });
    return () => {
      off();
      offReconnect();
    };
  }, []);

  // While the start is on its way, an older result mustn't show as this one's.
  const status: FreeUp | null = asking && freeUp ? { ...freeUp, state: "running", phase: "removing" } : freeUp;
  if (!showBanner(space, status, startedHere, hidden)) return null;
  const running = asking || status?.state === "running";
  const result = startedHere && !running && status?.state === "done";
  const { lead, rest } = bannerText(space, status, startedHere);

  const start = async () => {
    setAsking(true);
    setStartedHere(true);
    try {
      setFreeUp(await api.freeUp());
    } catch (e) {
      setFreeUp({
        state: "done", phase: null, reportOnly: false, startedAt: null, finishedAt: null, bytesFreed: 0,
        foldersRemoved: 0, foldersTrimmed: 0, error: (e as Error).message || "The board server didn't answer.",
      });
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className={`banner disk-banner${result ? "" : " has-action"}`} role="status" aria-live="polite">
      <span>
        <b>{lead}</b>
        {rest && (!phone || result) ? ` ${rest}` : ""}
      </span>
      {running ? (
        <button className="btn disk-banner-busy" disabled><span className="spinner" aria-hidden /> Working</button>
      ) : !result && (
        <button className="btn primary" onClick={() => void start()}>Free up space</button>
      )}
      <button className="icon-btn" aria-label="Hide" title="Hide until the page reloads" onClick={() => setHidden(true)}>
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
