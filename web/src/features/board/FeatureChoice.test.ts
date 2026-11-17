import { expect, test } from "bun:test";
import { MAIN_HINT, mainHint, runsOn } from "./newTicketText";
import { plural } from "../team/teamText";

test("the New ticket form shows the main-ticket hint only for a top-level ticket", () => {
  expect(mainHint(undefined, undefined)).toBe(MAIN_HINT);
  expect(MAIN_HINT).toContain("Tasks tab");
  expect(mainHint("t_feature", undefined)).toBeNull();
  expect(mainHint(undefined, "session-1")).toBeNull();
});

test("feature suggestion counts tickets in plain words", () => {
  expect(plural(1, "ticket")).toBe("1 ticket");
  expect(plural(3, "ticket")).toBe("3 tickets");
});

test("the feature chip never adds a new ticket to a feature by itself", async () => {
  // Must-not-break (U31): partOf is only set after the user taps Add or picks a feature; the default is "own".
  const src = await Bun.file(new URL("./FeatureChoice.tsx", import.meta.url)).text();
  expect(src).toContain('useState<FeatureChoiceValue>("own")');
  expect(src).not.toContain("useEffect");
});

test("New ticket chip: board default wording, picked values drop it, empty values read plainly", () => {
  expect(runsOn({ model: "", effort: "", boardModel: "sonnet", boardEffort: "medium" })).toEqual({ what: "Sonnet · medium", boardDefault: true });
  expect(runsOn({ model: "opus", effort: "", boardModel: "sonnet", boardEffort: "medium" })).toEqual({ what: "Opus · medium", boardDefault: false });
  expect(runsOn({ model: "", effort: "high", boardModel: null, boardEffort: null })).toEqual({ what: "Default model · high", boardDefault: false });
  expect(runsOn({ model: "", effort: "", boardModel: null, boardEffort: null })).toEqual({ what: "Default model", boardDefault: true });
  expect(runsOn({ model: "", effort: "", boardModel: "claude-opus-5-5", boardEffort: null }).what).toBe("claude-opus-5-5");
});
