// The row under the user's messages and the Undo rewind bar (web/src/messageText.ts, sentTime in web/src/time.ts).
import { expect, test } from "bun:test";
import { copyText, draftAfterUndo, forkPoints, forkTitle, rewoundLine, undoneLine } from "../web/src/messageText";
import { noFilesLine } from "../web/src/rewindText";
import { sentTime } from "../web/src/time";

const now = new Date(2026, 10, 10, 18, 0); // Tue 10 Nov 2026 18:00, local
const at = (y: number, mo: number, d: number, h: number, m: number, s = 0) => new Date(y, mo, d, h, m, s).toISOString();

test("sent time: only the time today, the day this year, the year before that", () => {
  expect(sentTime(at(2026, 10, 10, 14, 32, 40), now)).toEqual({ text: "14:32", title: "Tuesday 10 November 2026, 14:32:40" });
  expect(sentTime(at(2026, 10, 10, 0, 5), now).text).toBe("00:05");
  expect(sentTime(at(2026, 10, 9, 16, 5, 12), now)).toEqual({ text: "9 Nov, 16:05", title: "Monday 9 November 2026, 16:05:12" });
  expect(sentTime(at(2026, 0, 1, 9, 0), now).text).toBe("1 Jan, 09:00");
  expect(sentTime(at(2025, 10, 9, 16, 5), now).text).toBe("9 Nov 2025, 16:05");
  // Same day and month in another year is not "today".
  expect(sentTime(at(2025, 10, 10, 14, 32), now).text).toBe("10 Nov 2025, 14:32");
  expect(sentTime("not a date", now)).toEqual({ text: "", title: "" });
});

test("Copy: the text as typed, pasted images as [image]", () => {
  expect(copyText("Fix the header")).toBe("Fix the header");
  expect(copyText("Look:\n![image](/api/attachments/0123456789abcdef0123456789abcdef.png)\nthis is wrong")).toBe("Look:\n[image]\nthis is wrong");
  expect(copyText("![image](/Users/me/.claude-kanban/attachments/0123456789abcdef0123456789abcdef.png)")).toBe("[image]");
  // Links to files stay as they are.
  expect(copyText("[notes.pdf](/api/attachments/x.pdf)")).toBe("[notes.pdf](/api/attachments/x.pdf)");
});

test("fork title: one (fork), never stacked", () => {
  expect(forkTitle("Dark mode")).toBe("Dark mode (fork)");
  expect(forkTitle("Dark mode (fork)")).toBe("Dark mode (fork)");
  expect(forkTitle("Dark mode (Fork 2)")).toBe("Dark mode (fork)");
  expect(forkTitle("  ")).toBe("Chat (fork)");
});

test("fork confirmation: the mockup's four points for a ticket; a quick chat's own words", () => {
  expect(forkPoints(false)).toEqual([
    "The new ticket keeps the chat before this message.",
    "This message goes into its chat box, so you can change it before sending.",
    "Files are copied as they are now, not as they were at this message.",
    "This chat stays as it is.",
  ]);
  const chat = forkPoints(true);
  expect(chat).toHaveLength(4);
  expect(chat.join(" ")).not.toContain("ticket");
  expect(chat[2]).toContain("same folder");
});

test("Undo bar words", () => {
  expect(rewoundLine(4, 2)).toBe("Rewound: 4 messages and 2 files went back.");
  expect(rewoundLine(1, 1)).toBe("Rewound: 1 message and 1 file went back.");
  expect(rewoundLine(3, 0)).toBe("Rewound: 3 messages went back.");
  expect(undoneLine({ messages: 4, files: 2, filesRestored: true, filesReason: null }, 2)).toBe("Undone: 4 messages and 2 files came back.");
  expect(undoneLine({ messages: 2, files: 0, filesRestored: false, filesReason: "unchanged" }, 0)).toBe("Undone: 2 messages came back.");
  expect(undoneLine({ messages: 2, files: 0, filesRestored: false, filesReason: "not-saved" }, 3)).toBe("Only the chat came back.");
  expect(undoneLine({ messages: 2, files: 0, filesRestored: false, filesReason: "skipped" }, 3)).toBe("Only the chat came back.");
});

test("Undo empties the box the rewind filled, but keeps the user's edits", () => {
  expect(draftAfterUndo("Make it a switch", "Make it a switch", "")).toBe("");
  expect(draftAfterUndo("Make it a switch\n\nmy note", "Make it a switch\n\nmy note", "my note")).toBe("my note");
  expect(draftAfterUndo("Make it a three-way switch", "Make it a switch", "")).toBe("Make it a three-way switch");
});

test("quick chat rewind says files stay", () => {
  expect(noFilesLine("quick-chat")).toContain("Files stay as they are");
});
