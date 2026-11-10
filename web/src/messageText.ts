/** Words and text of the row under the user's messages (time, Copy, Fork from here) and the Undo rewind bar. Kept free of React. */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What Copy puts on the clipboard: the text as typed, with pasted images as "[image]". */
export function copyText(text: string): string {
  return text.replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "[image]").trim();
}

/** The title a fork gets: "<title> (fork)" (as the server's forkTitle; it may number it "(fork 2)" to keep it unique). */
export function forkTitle(title: string): string {
  const base = title.trim().replace(/\s*\(fork(?: \d+)?\)$/i, "").trim();
  return `${base || "Chat"} (fork)`;
}

/** The fork confirmation's points. chat: a quick chat (a new chat, not a new ticket). */
export function forkPoints(chat: boolean): string[] {
  return [
    chat ? "The new chat keeps the conversation before this message." : "The new ticket keeps the chat before this message.",
    "This message goes into its chat box, so you can change it before sending.",
    chat ? "Files stay as they are: the new chat works in the same folder." : "Files are copied as they are now, not as they were at this message.",
    "This chat stays as it is.",
  ];
}

/** "Rewound: 4 messages and 2 files went back." */
export function rewoundLine(messages: number, files: number): string {
  const m = plural(messages, "message", "messages");
  return files > 0 ? `Rewound: ${m} and ${plural(files, "file", "files")} went back.` : `Rewound: ${m} went back.`;
}

/** After Undo rewind. Files the rewind changed back that didn't come back: "Only the chat came back." */
export function undoneLine(r: { messages: number; files: number; filesRestored: boolean; filesReason: string | null }, rewoundFiles: number): string {
  if (!r.filesRestored && rewoundFiles > 0 && r.filesReason !== "unchanged") return "Only the chat came back.";
  const m = plural(r.messages, "message", "messages");
  return r.files > 0 ? `Undone: ${m} and ${plural(r.files, "file", "files")} came back.` : `Undone: ${m} came back.`;
}

/** The chat box after Undo: what it held before the rewind, unless the user edited what the rewind put there. */
export function draftAfterUndo(current: string, filled: string, before: string): string {
  return current === filled ? before : current;
}
