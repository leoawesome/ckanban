// backup_file: before Claude puts a saved key into an existing file (a .env, a tool's config in the home folder), it
// saves a copy here, so an edit that drops lines the user wanted can be undone by hand. The copies hold keys, so they
// live only in the board's private data folder, in a hidden folder (the Telegram front desk never sends hidden
// paths, and nothing in the UI lists it), owner-only: folders 0700, files 0600. Never the project folder, a ticket's
// outputs or a reply: the tool answers with where the copy went, never with what is in it.

import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

/** The hidden folder in a board's data folder that holds the copies. */
export const BACKUPS_DIR = ".key-backups";
/** Copies kept per file: the first one (the file as it was before Claude touched it) and the newest after it. */
export const BACKUPS_KEPT = 5;
/** Larger files are not copied: a file a key goes into is small. */
export const BACKUP_MAX_BYTES = 10 * 1024 * 1024;

export type BackupResult =
  | { ok: true; source: string; copy: string; kept: number; removed: number }
  | { ok: false; reason: string };

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const COPY_NAME = /^(\d{8}T\d{9}Z)(?:-(\d+))?$/;

/** Copy names in time order: by stamp, then by the number a same-millisecond copy gets ("-10" after "-2"). */
function byTime(a: string, b: string): number {
  const [, sa, na] = COPY_NAME.exec(a)!;
  const [, sb, nb] = COPY_NAME.exec(b)!;
  return sa < sb ? -1 : sa > sb ? 1 : Number(na ?? 0) - Number(nb ?? 0);
}

/**
 * The path as the shell would read it: a leading ~ or $HOME is the home folder (Claude writes "~/.sentryclirc" and
 * its shell expands it; taking it literally would back up nothing and call the real file missing).
 */
export function expandPath(path: string, cwd: string, home = homedir()): string {
  const p = path.trim();
  const m = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)(.*)$/.exec(p);
  if (m) return join(home, m[1]);
  if (p.startsWith("~")) throw new Error(`write the full path instead of ${p}`);
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Makes (or checks) a private folder: a real folder, not a link, mode 0700. */
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain folder`);
  chmodSync(dir, 0o700);
}

/**
 * The folder one file's copies go in: its name made safe, after a short hash of its full real path, so two files
 * named .env in different projects never share (or prune) each other's copies. Built only from the hash and the
 * cleaned name: a crafted path can't point it outside the backups folder.
 */
export function backupFolderName(real: string): string {
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 12);
  const name = basename(real).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "file";
  return `${hash}-${name}`;
}

/** 20261109T153012345Z: sorts by time as text. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

/**
 * Copies `path` (absolute, or relative to `cwd`) to <root>/profiles/<slug>/.key-backups/<hash>-<name>/<time>, keeps the
 * newest BACKUPS_KEPT copies, and says where the copy went. A missing file is not an error: nothing is done.
 */
export function backupFile(root: string, slug: string, path: string, cwd: string, now = new Date(), home = homedir()): BackupResult {
  if (!SLUG.test(slug)) throw new Error(`"${slug}" is not a board name`);
  if (!path.trim()) throw new Error("path is required");
  const asked = expandPath(path, cwd, home);
  let real: string;
  try {
    real = realpathSync(asked);
  } catch (e) {
    // Only a file that really isn't there is "missing": one that can't be read must not be overwritten.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: `${asked} doesn't exist: nothing to back up. Check the path is the one you will write; if it is, create the file with only the key's line.` };
    }
    throw new Error(`${asked} can't be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
  // Open without blocking (a FIFO swapped in stays unread), then check what was opened.
  const fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK);
  let data: Buffer;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: `${asked} is not a file: nothing was copied.` };
    if (st.size > BACKUP_MAX_BYTES) return { ok: false, reason: `${asked} is larger than ${BACKUP_MAX_BYTES / 1048576} MB: not copied. A file a key goes into should be small; check the path.` };
    data = readFileSync(fd);
  } finally {
    closeSync(fd);
  }

  const board = join(root, "profiles", slug);
  if (!lstatSync(board, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`board "${slug}" has no data folder`);
  const base = join(board, BACKUPS_DIR);
  privateDir(base);
  const dir = join(base, backupFolderName(real));
  privateDir(dir);

  const first = stamp(now);
  let copy = "";
  for (let n = 0; ; n++) {
    const name = n ? `${first}-${n}` : first;
    copy = join(dir, name);
    try {
      // wx: never overwrite, never follow a link planted at the name.
      writeFileSync(copy, data, { mode: 0o600, flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n > 50) throw e;
    }
  }
  chmodSync(copy, 0o600);

  // Keep the first copy (the file before Claude's edits), the one just made, and the newest others up to BACKUPS_KEPT.
  const made = basename(copy);
  const copies = readdirSync(dir).filter((f) => COPY_NAME.test(f) && f !== made).sort(byTime);
  const [oldest, ...rest] = copies;
  const keepRest = Math.max(0, BACKUPS_KEPT - 2);
  const old = oldest === undefined ? [] : rest.slice(0, Math.max(0, rest.length - keepRest));
  for (const f of old) unlinkSync(join(dir, f));
  return { ok: true, source: real, copy, kept: copies.length + 1 - old.length, removed: old.length };
}

/** The tool's answer: where the copy went, never what is in it. */
export function backupText(r: BackupResult): string {
  if (!r.ok) return r.reason;
  return `Saved a private copy of ${r.source} to ${r.copy} (only this Mac's user can read it; ${BACKUPS_KEPT} copies of this file are kept: the first and the newest${r.removed ? `, ${r.removed} older removed` : ""}; deleting the board deletes them). ` +
    "Don't read or print the copy (it can hold keys); to undo, copy it back over the file. Now change only the key's line (add it if it is missing), using the variable; don't rewrite or print the file.";
}
