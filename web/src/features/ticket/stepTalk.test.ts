// A main ticket's chat shows what its "with you" steps showed the user (web/src/StepMessages.tsx stepMessages).
import { expect, test } from "bun:test";
import type { StepEntry as SessionEntry } from "../web/src/stepTalk";
import { stepMessages, type StepMsg } from "../web/src/stepTalk";

let n = 0;
const e = (role: SessionEntry["role"], kind: SessionEntry["kind"], text: string, x: Partial<SessionEntry> = {}): SessionEntry =>
  ({ uuid: `u${++n}`, at: `2026-11-05T10:${String(n).padStart(2, "0")}:00Z`, role, kind, text, ...x });
const q = [{ question: "Ready for the call?", options: [{ label: "Yes" }, { label: "Not now" }], multiSelect: false }];

test("only each finished turn's last reply, its forms and the user's own answers show; the board's prompts and other tickets' messages don't", () => {
  n = 0;
  const entries = [
    e("user", "board", "Board started work on the ticket"),
    e("assistant", "text", "Let me take the device first."),
    e("assistant", "tool", "take_devices"),
    e("assistant", "text", "Before I call, check the steps.", { questions: q }),
    e("assistant", "text", "Waiting for your go.\nCKANBAN_RESULT: {\"status\":\"questions\"}"),
    e("user", "text", "Yes"),
    e("assistant", "text", "Calling now."),
    e("assistant", "text", "Did the call ring?"),
    e("user", "text", "Use WhatsApp.", { peer: { dir: "in", ticketId: "M", title: "Main" } }),
    e("assistant", "text", "Done: payloads saved."),
  ];
  const out = stepMessages("S", entries, false);
  expect(out.map((m: StepMsg) => [m.role, m.text])).toEqual([
    ["reply", "Before I call, check the steps."],
    ["reply", "Waiting for your go."],
    ["user", "Yes"],
    ["reply", "Did the call ring?"],
    ["reply", "Done: payloads saved."],
  ]);
  // The form was answered by the user's "Yes".
  expect(out[0].form).toEqual({ open: false, key: out[0].uuid });
  // While the step runs, its current turn waits until it ends.
  expect(stepMessages("S", entries, true).map((m: StepMsg) => m.text)).not.toContain("Done: payloads saved.");
});

test("an unanswered form is open, keyed like the step's own chat so typed answers carry over", () => {
  n = 0;
  const entries = [e("user", "board", "start"), e("assistant", "text", "Pick one.", { questions: q })];
  const [m] = stepMessages("S", entries, false);
  expect(m.form).toEqual({ open: true, key: m.uuid });
  expect(m.questions).toEqual(q);
});

test("a last word that only repeats the form above it doesn't show again under the form", () => {
  n = 0;
  const form = [{ question: "Ready for the call?", context: "I take the phone for ten minutes.", options: [{ label: "Yes" }, { label: "Not now" }], multiSelect: false }];
  const out = stepMessages("S", [
    e("assistant", "text", "", { questions: form }),
    e("assistant", "text", "Ready for the call? I take the phone for ten minutes.\nCKANBAN_RESULT: {\"status\":\"questions\"}"),
  ], false);
  expect(out.map((m: StepMsg) => [m.role, m.text])).toEqual([["reply", ""]]);
});
