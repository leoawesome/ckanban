import { expect, test } from "bun:test";
import { chatPrompt, firstRunPrompt, MAIN_FIRST_REPLY } from "../src/server/prompts";
import { MAIN_HINT, mainHint, runsOn } from "../web/src/newTicketText";
import { plural } from "../web/src/teamText";

const main = { kind: "main" as const, repo: "remote" as const, branch: "ck/x", inPlace: false };
const ticket = (over: Record<string, unknown> = {}) => ({
  id: "t_1", title: "Big work", body: "Do it", status: "planning", mode: "interview", runCount: 0, lastRunAt: null,
  main: true, tags: [], ...over,
}) as any;

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

test("a new main ticket's first Planning reply explains what happens next", () => {
  const p = chatPrompt(ticket(), "", "refine", "/o", false, "remote", false, "", main);
  expect(p).toContain(MAIN_FIRST_REPLY);
  expect(MAIN_FIRST_REPLY).toContain("Tasks tab");
  expect(MAIN_FIRST_REPLY).not.toContain("Where we are");
  expect(MAIN_FIRST_REPLY).toContain("one sentence");
  // Not once it has run, not for a typed message, not for a plain ticket.
  expect(chatPrompt(ticket({ runCount: 1 }), "", "refine", "/o", false, "remote", false, "", main)).not.toContain(MAIN_FIRST_REPLY);
  expect(chatPrompt(ticket(), "hello", "refine", "/o", false, "remote", false, "", main)).not.toContain(MAIN_FIRST_REPLY);
  expect(chatPrompt(ticket({ main: false }), "", "refine", "/o")).not.toContain(MAIN_FIRST_REPLY);
});

test("a main ticket's first work run explains what happens next; later runs and plain tickets don't", () => {
  expect(firstRunPrompt(ticket({ status: "ready", mode: "auto" }), { repo: "remote", outputDir: "/o", main })).toContain(MAIN_FIRST_REPLY);
  expect(firstRunPrompt(ticket({ status: "ready", runCount: 2 }), { repo: "remote", outputDir: "/o", main })).not.toContain(MAIN_FIRST_REPLY);
  expect(firstRunPrompt(ticket({ main: false, status: "ready" }), { repo: "remote", outputDir: "/o" })).not.toContain(MAIN_FIRST_REPLY);
});

test("the feature chip never adds a new ticket to a feature by itself", async () => {
  // Must-not-break (U31): partOf is only set after the user taps Add or picks a feature; the default is "own".
  const src = await Bun.file(new URL("../web/src/FeatureChoice.tsx", import.meta.url)).text();
  expect(src).toContain('useState<FeatureChoiceValue>("own")');
  expect(src).not.toContain("useEffect");
});

test("New ticket chip: board default wording, picked values drop it, empty values read plainly", () => {
  expect(runsOn({ model: "", effort: "", boardModel: "sonnet", boardEffort: "medium" })).toEqual({ what: "Sonnet · medium", boardDefault: true });
  expect(runsOn({ model: "opus", effort: "", boardModel: "sonnet", boardEffort: "medium" })).toEqual({ what: "Opus · medium", boardDefault: false });
  expect(runsOn({ model: "", effort: "high", boardModel: null, boardEffort: null })).toEqual({ what: "Default model · high", boardDefault: false });
  expect(runsOn({ model: "", effort: "", boardModel: "claude-opus-5-5", boardEffort: null }).what).toBe("claude-opus-5-5 · default effort");
});
