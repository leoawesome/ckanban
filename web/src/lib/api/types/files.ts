import type { Ticket } from "./ticket";

export interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

/** The Changes tab: a ticket worktree's diff against its merge-base with the base branch (see src/server/diff.ts). */
export interface DiffLine {
  type: "ctx" | "add" | "del";
  text: string;
  old: number | null;
  new: number | null;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "A" | "M" | "D" | "R";
  additions: number;
  deletions: number;
  binary: boolean;
  tooLarge: boolean;
  hunks: { header: string; lines: DiffLine[] }[];
  /** Not a file: the last row, "… and N more changed files (not shown)" (TicketDiff.moreFiles). */
  more?: boolean;
}

export interface TicketDiff {
  base: string;
  mergeBase: string;
  branch: string | null;
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** Shown instead of files when the changes can't be worked out. */
  note?: string;
  /** The version the changes are compared with, when it isn't the board's base branch. */
  startedFrom?: string;
  /** Changed files not sent (past the first 300); the file list ends with a row saying so (DiffFile.more). */
  moreFiles?: number;
}

export interface FileContent {
  path: string;
  size: number;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
}

export interface ShareLink { file: string; url: string; at: string }
/** Where a link was found: the ticket's session, a huddle teammate's session ("huddle:@handle"), a result summary or the Share menu. */
export interface TicketLink { url: string; label: string; at: string; source: string }
export const isArtifactLink = (l: TicketLink) => l.source !== "share";
/** The ticket's newest claude.ai artifact (share links of output files aside). */
export const newestArtifact = (t: Pick<Ticket, "links">) => t.links?.find(isArtifactLink) ?? null;
export interface ShareJob { file: string; state: "publishing" | "failed"; error?: string; at: string }

/** A tool ticket's result as a card in its parent's chat. */
export interface ResultCard {
  at: string;
  ticketId: string;
  title: string;
  kind?: string | null;
  outcome: string;
  verdict?: "passed" | "problem" | null;
  summary: string;
  report: string | null;
  model?: string | null;
  costUsd?: number | null;
  folderFiles?: number | null;
}

export interface OutputFile {
  name: string;
  size: number;
  updatedAt: string;
}

/** Where a file mentioned in a chat was found: the ticket's copy of the folder, the project folder or Outputs. */
export type FileRootName = "ticket" | "project" | "outputs";

export interface TicketFile {
  /** Relative to `dir`. */
  path: string;
  size: number;
  /** null when the file is binary or too large to show. */
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  root: FileRootName;
  dir: string;
}
