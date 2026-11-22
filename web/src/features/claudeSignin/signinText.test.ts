import { expect, test } from "bun:test";
import { codeProblem, stripOf } from "./signinText";

const base = { checked: true, checkedAt: "2026-11-20T00:00:00.000Z", loggedIn: true, expiresAt: "2026-11-23T00:00:00.000Z", daysLeft: 3, warning: null } as const;

test("the strip: nothing while fine or unchecked, yellow before it runs out, red when signed out", () => {
  expect(stripOf(null)).toBeNull();
  expect(stripOf({ ...base, checked: false, warning: "signed-out" })).toBeNull();
  expect(stripOf(base)).toBeNull();
  expect(stripOf({ ...base, warning: "expiring" })).toEqual({ tone: "warn", text: "Claude's sign-in on your Mac runs out in 3 days." });
  expect(stripOf({ ...base, warning: "expiring", daysLeft: 1 })?.text).toBe("Claude's sign-in on your Mac runs out in 1 day.");
  expect(stripOf({ ...base, warning: "expiring", daysLeft: 0 })?.text).toBe("Claude's sign-in on your Mac runs out today.");
  expect(stripOf({ ...base, loggedIn: false, warning: "signed-out" })).toEqual({ tone: "err", text: "Claude is signed out, so tasks can't run." });
  expect(stripOf({ ...base, loggedIn: null, expiresAt: null, daysLeft: null, warning: "missing" })).toEqual({ tone: "err", text: "The board can't find Claude Code on this Mac, so tasks can't run.", fix: true });
  // An API key or a cloud provider: signed in, no expiry to warn about, no strip.
  expect(stripOf({ ...base, authMethod: "api_key", expiresAt: null, daysLeft: null })).toBeNull();
});

test("a pasted code needs its # and no spaces", () => {
  expect(codeProblem("  ")).toBe("Paste the code first.");
  expect(codeProblem("abc")).toContain("including the #");
  expect(codeProblem("ab c#d")).toContain("including the #");
  expect(codeProblem(" abc#def ")).toBeNull();
});
