import type { DiskSpace, FreeUp } from "../../lib/api/types/disk";

/** Sizes in decimal GB, as Finder shows them: one decimal under 10 GB, whole numbers above; MB under 0.1 GB. */
export function sizeText(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb < 0.1) return `${Math.max(0, Math.round(bytes / 1e6))} MB`;
  return gb < 10 ? `${gb.toFixed(1)} GB` : `${Math.round(gb)} GB`;
}

/** The banner shows while the disk is low, and while a Free up space started here runs or has its result to show. */
export function showBanner(space: DiskSpace | null, freeUp: FreeUp | null, startedHere: boolean, hidden: boolean): boolean {
  if (hidden) return false;
  if (freeUp?.state === "running") return true;
  if (startedHere && freeUp?.state === "done") return true;
  return !!space?.low;
}

/** The banner's lead (bold) and rest; the phone drops the rest, as in the mockup. */
export function bannerText(space: DiskSpace | null, freeUp: FreeUp | null, startedHere: boolean): { lead: string; rest: string } {
  const free = space?.freeBytes != null ? sizeText(space.freeBytes) : null;
  if (freeUp?.state === "running") {
    return {
      lead: "Freeing up space…",
      rest: freeUp.phase === "trimming" ? "Removing packages from finished tickets." : "Removing copies of finished and deleted tickets.",
    };
  }
  if (startedHere && freeUp?.state === "done") {
    const now = free ? ` Now ${free} free.` : "";
    if (freeUp.error) return { lead: "Free up space stopped early.", rest: freeUp.error };
    if (freeUp.reportOnly) return { lead: "Nothing was removed.", rest: "Deleting is switched off on this board server." };
    if (freeUp.bytesFreed <= 0) return { lead: "Nothing left to free.", rest: `Finished tickets have no copies or packages to remove.${now}` };
    return { lead: `Freed ${sizeText(freeUp.bytesFreed)}.`, rest: now.trim() };
  }
  return { lead: `Only ${free ?? "a little space"} free on this Mac.`, rest: "Runs may fail when the disk is full." };
}
