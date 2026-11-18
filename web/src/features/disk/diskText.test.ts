import { expect, test } from "bun:test";
import type { DiskSpace, FreeUp } from "../../lib/api/types/disk";
import { bannerText, showBanner, sizeText } from "./diskText";

const space = (gb: number): DiskSpace => ({ freeBytes: gb * 1e9, low: gb < 10, lowBelowBytes: 10e9, checkedAt: "" });
const freeUp = (p: Partial<FreeUp>): FreeUp => ({
  state: "done", phase: null, reportOnly: false, startedAt: null, finishedAt: null, bytesFreed: 0, foldersRemoved: 0, foldersTrimmed: 0, ...p,
});

test("sizes read like Finder", () => {
  expect(sizeText(6.24e9)).toBe("6.2 GB");
  expect(sizeText(54.4e9)).toBe("54 GB");
  expect(sizeText(42e6)).toBe("42 MB");
});

test("shows under 10 GB, while freeing, and with a result started here; never once hidden", () => {
  expect(showBanner(space(6.2), null, false, false)).toBe(true);
  expect(showBanner(space(12), null, false, false)).toBe(false);
  expect(showBanner(space(12), freeUp({ state: "running" }), false, false)).toBe(true);
  expect(showBanner(space(12), freeUp({ state: "done" }), true, false)).toBe(true);
  expect(showBanner(space(12), freeUp({ state: "done" }), false, false)).toBe(false);
  expect(showBanner(space(6.2), null, false, true)).toBe(false);
  expect(showBanner(null, null, false, false)).toBe(false);
});

test("the banner's words", () => {
  expect(bannerText(space(6.2), null, false)).toEqual({ lead: "Only 6.2 GB free on this Mac.", rest: "Runs may fail when the disk is full." });
  expect(bannerText(space(6.2), freeUp({ state: "running", phase: "trimming" }), true).lead).toBe("Freeing up space…");
  expect(bannerText(space(14), freeUp({ bytesFreed: 8.1e9 }), true)).toEqual({ lead: "Freed 8.1 GB.", rest: "Now 14 GB free." });
  expect(bannerText(space(6), freeUp({ reportOnly: true }), true).lead).toBe("Nothing was removed.");
  expect(bannerText(space(6), freeUp({}), true).lead).toBe("Nothing left to free.");
  // A result started in another tab isn't this page's: the low-space words stay.
  expect(bannerText(space(6.2), freeUp({ bytesFreed: 1e9 }), false).lead).toBe("Only 6.2 GB free on this Mac.");
});
