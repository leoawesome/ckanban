import { expect, test } from "bun:test";
import { heldByReply, inSession, liveProgress, unsentNow, userAfterSaved } from "../web/src/pendingBubbles";

test("the message that started a reply shows once: its plain bubble hides the board's held copy", () => {
  const pending = [{ text: "hi", steer: false }];
  expect(heldByReply({ text: "hi", state: "queued" }, pending)).toBe(true);
  // A steering message shows as the board's copy, not twice.
  expect(heldByReply({ text: "hi", state: "queued" }, [{ text: "hi", steer: true }])).toBe(false);
  // Stopped before Claude read it: the unsent bubble shows (with Send, Edit and Discard).
  expect(heldByReply({ text: "hi", state: "unsent" }, pending)).toBe(false);
});

test("Stop before Claude read the reply's message: its plain bubble gives way to the unsent one", () => {
  const stuck = { text: "oops", steer: false };
  const pending = [stuck, { text: "later", steer: false }, { text: "oops", steer: true }];
  expect(unsentNow(pending, [{ text: "oops", state: "unsent" }])).toEqual([stuck]);
  expect(unsentNow(pending, [{ text: "oops", state: "queued" }])).toEqual([]);
  expect(unsentNow(pending, [{ text: "oops", state: "unsent", peer: true }])).toEqual([]);
});

test("a queued message already in the conversation shows once: its timeline copy hides the board's copy", () => {
  const q = { text: "hi", state: "queued" as const, at: "2026-10-19T10:00:00.000Z" };
  const said = (text: string, at: string) => ({ role: "user" as const, text, at });
  expect(inSession(q, [said("hi", "2026-10-19T10:00:02.000Z")])).toBe(true);
  // Not in the conversation yet: the board's copy shows.
  expect(inSession(q, [{ role: "assistant", text: "hi", at: "2026-10-19T10:00:02.000Z" }])).toBe(false);
  // The same text sent earlier doesn't hide a new message.
  expect(inSession(q, [said("hi", "2026-10-19T09:59:00.000Z")])).toBe(false);
  // Stopped before Claude read it: the unsent bubble shows (with Send, Edit and Discard).
  expect(inSession({ ...q, state: "unsent" }, [said("hi", "2026-10-19T10:00:02.000Z")])).toBe(false);
  // Image links reach the session as local file paths.
  const img = "see /api/attachments/0123456789abcdef0123456789abcdef.png";
  expect(inSession({ ...q, text: img }, [said("see /Users/me/.claude-kanban/attachments/0123456789abcdef0123456789abcdef.png", "2026-10-19T10:00:02.000Z")])).toBe(true);
});

// Leo's chat: Claude's steps for "Check metrics again." were the newest saved block; he pressed Stop and sent
// "do you login aws sso", which shows as a bubble after the saved blocks until Claude's run saves it.
const at = "2026-11-06T00:44:57.000Z";
const savedSteps = [{ role: "user" as const, text: "Check metrics again.", at: "2026-11-06T00:42:36.000Z" }];

test("Stop then send: the stopped reply's steps aren't live, the working row shows under the new message", () => {
  const pending = [{ text: "do you login aws sso", steer: false }];
  const userAfter = userAfterSaved(pending, [{ text: "do you login aws sso", state: "queued", at }], savedSteps);
  expect(userAfter).toBe(true);
  expect(liveProgress({ running: true, streaming: false, lastBlock: "tools", userAfter, waitingOn: false, stalled: false }))
    .toEqual({ stepsLive: false, workingRow: true });
});

test("Stop then Send an unsent message: the board's copy is the new reply's prompt, the working row goes under it", () => {
  // sendQueued adds no plain bubble: the board's held copy shows until Claude reads it.
  const userAfter = userAfterSaved([], [{ text: "first", state: "queued", at }], savedSteps);
  expect(userAfter).toBe(true);
  expect(liveProgress({ running: true, streaming: false, lastBlock: "tools", userAfter, waitingOn: false, stalled: false }).stepsLive).toBe(false);
});

test("Stop then send, with the old message still unsent or discarded: only the new one counts", () => {
  const queued = [{ text: "first", state: "unsent" as const, at }];
  // Unsent alone: Claude isn't answering it, so a run's own newest steps stay live.
  expect(userAfterSaved([], queued, savedSteps)).toBe(false);
  expect(userAfterSaved([{ text: "second", steer: false }], queued, savedSteps)).toBe(true);
  // Discarded: gone from the queue; the new message's bubble still counts.
  expect(userAfterSaved([{ text: "second", steer: false }], [], savedSteps)).toBe(true);
});

test("a message typed while Stop is still finishing shows as sending: the old steps lose their spinner", () => {
  expect(userAfterSaved([{ text: "wait", steer: true }], [], savedSteps)).toBe(true);
});

test("once the saved copy replaces the bubble, nothing counts after the saved conversation", () => {
  const saved = [...savedSteps, { role: "user" as const, text: "do you login aws sso", at: "2026-11-06T00:45:25.000Z" }];
  expect(userAfterSaved([], [{ text: "do you login aws sso", state: "queued", at }], saved)).toBe(false);
  // Saved conversation ends in the user's message: the working row shows (no steps group is newest).
  expect(liveProgress({ running: true, streaming: false, lastBlock: "entry", userAfter: false, waitingOn: false, stalled: false }).workingRow).toBe(true);
});

test("a reply's own newest steps stay the one live line; another ticket's message doesn't change that", () => {
  const userAfter = userAfterSaved([], [{ text: "hi", state: "queued", at, peer: true }, { text: "x", state: "queued", at, from: {} }], savedSteps);
  expect(userAfter).toBe(false);
  expect(liveProgress({ running: true, streaming: false, lastBlock: "tools", userAfter, waitingOn: false, stalled: false })).toEqual({ stepsLive: true, workingRow: false });
  // Stalled: the working row shows with the stall actions too.
  expect(liveProgress({ running: true, streaming: false, lastBlock: "tools", userAfter, waitingOn: false, stalled: true }).workingRow).toBe(true);
  // Finished or stopped: nothing is live.
  expect(liveProgress({ running: false, streaming: false, lastBlock: "tools", userAfter, waitingOn: false, stalled: false })).toEqual({ stepsLive: false, workingRow: false });
});
