// Which mood each screen's avatar shows (web/src/avatarMood.ts).
import { expect, test } from "bun:test";
import { agentMood, familyMood, finishMood, participantMood, runMood } from "../web/src/avatarMood";

test("a run thinks until its live line names a step, then works", () => {
  expect(runMood(null)).toBe("thinking");
  expect(runMood("Starting…")).toBe("thinking");
  expect(runMood("Claude is replying…")).toBe("thinking");
  expect(runMood("Stopping…")).toBe("thinking");
  expect(runMood("Running gh")).toBe("working");
});

test("the end-of-run mark: done, failed, or waiting when it stopped for the user", () => {
  expect(finishMood({ tone: "ok" })).toBe("done");
  expect(finishMood({ tone: "failed" })).toBe("failed");
  expect(finishMood({ tone: "warn" })).toBe("waiting");
});

test("huddle participants: the user rests, a closed huddle stops the motion, a stop with an error fails", () => {
  expect(participantMood({ kind: "human", status: "working" })).toBe("idle");
  expect(participantMood({ kind: "agent", status: "working" })).toBe("thinking");
  expect(participantMood({ kind: "agent", status: "working", lastActivity: "Reading a file" })).toBe("working");
  expect(participantMood({ kind: "agent", status: "working", lastActivity: "x" }, true)).toBe("idle");
  expect(participantMood({ kind: "agent", status: "blocked" })).toBe("waiting");
  expect(participantMood({ kind: "agent", status: "done" })).toBe("done");
  expect(participantMood({ kind: "agent", status: "failed" })).toBe("failed");
  expect(participantMood({ kind: "agent", status: "stopped", error: "boom" })).toBe("failed");
  expect(participantMood({ kind: "agent", status: "stopped" })).toBe("idle");
  expect(participantMood({ kind: "agent", status: "idle" })).toBe("idle");
});

test("subagents and task rows", () => {
  expect(agentMood("running")).toBe("thinking");
  expect(agentMood("running", "Bash")).toBe("working");
  expect(agentMood("done")).toBe("done");
  expect(agentMood("failed")).toBe("failed");
  expect(agentMood("stopped")).toBe("idle");
  expect(familyMood("working")).toBe("working");
  expect(familyMood("needs_you")).toBe("waiting");
  expect(familyMood("in_review")).toBe("waiting");
  expect(familyMood("passed")).toBe("done");
  expect(familyMood("problem")).toBe("done");
  expect(familyMood("failed")).toBe("failed");
  expect(familyMood("paused")).toBe("idle");
});
