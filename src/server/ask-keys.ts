// ask_keys: Claude asks the user for keys by name. The ticket chat shows a box with one password field per key (built
// from the tool call in the transcript, session.ts); Save stores them for the board (board-keys.ts, passes.ts) and
// resumes the ticket with a message that names what was saved. The values never reach Claude, the chat or a log.

import { keyNameError } from "./board-keys";

/** One key Claude asks for. */
export interface AskedKey {
  /** The environment variable runs get it as, e.g. SENTRY_AUTH_TOKEN. */
  envName: string;
  /** What it is, in plain words ("Sentry auth token"). */
  label: string;
  /** Short hint: what access it needs, where to find it. */
  help?: string;
  /** Where to create one (https only). */
  createUrl?: string;
}

export interface KeysAsk {
  keys: AskedKey[];
  /** One line: what Claude will do with them. */
  reason: string;
  /** Replace keys already saved for the board. */
  replace: boolean;
}

export const MAX_ASKED_KEYS = 8;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The ask from ask_keys' input; throws a readable message when it is invalid. */
export function keysAsk(input: any): KeysAsk {
  const raw = input?.keys;
  if (!Array.isArray(raw) || !raw.length) throw new Error("keys must be a non-empty list of {envName, label}");
  if (raw.length > MAX_ASKED_KEYS) throw new Error(`ask for at most ${MAX_ASKED_KEYS} keys at once`);
  const seen = new Set<string>();
  const keys = raw.map((k: any, i: number): AskedKey => {
    const at = `key ${i + 1}: `;
    const envName = str(k?.envName);
    const bad = keyNameError(envName);
    if (bad) throw new Error(at + bad);
    if (seen.has(envName)) throw new Error(`${at}${envName} is listed twice`);
    seen.add(envName);
    const label = str(k?.label).replace(/\s+/g, " ").slice(0, 80);
    if (!label) throw new Error(`${at}label is required, e.g. "Sentry auth token"`);
    const help = str(k?.help).replace(/\s+/g, " ").slice(0, 200);
    const url = str(k?.createUrl);
    if (url && !/^https:\/\/[^\s"<>]+$/.test(url)) throw new Error(`${at}createUrl must be an https:// address`);
    return { envName, label, ...(help ? { help } : {}), ...(url ? { createUrl: url } : {}) };
  });
  const reason = str(input?.reason).replace(/\s+/g, " ").slice(0, 300);
  if (!reason) throw new Error("reason is required: one line on what you will do with the keys");
  if (input?.replace !== undefined && typeof input.replace !== "boolean") throw new Error("replace must be true or false");
  return { keys, reason, replace: input?.replace === true };
}

/** Like keysAsk, but null for input that can't be read (an old or broken tool call in a transcript). */
export function parseKeysAsk(input: unknown): KeysAsk | null {
  try {
    return keysAsk(input);
  } catch {
    return null;
  }
}

/** The message that resumes Claude after the box was answered: names only, never a value. */
export function keysAnswerText(ask: KeysAsk, saved: string[], self: boolean): string {
  const label = (n: string) => ask.keys.find((k) => k.envName === n)?.label ?? n;
  const list = (names: string[]) => names.map((n) => `$${n} (${label(n)})`).join(", ");
  const skipped = ask.keys.map((k) => k.envName).filter((n) => !saved.includes(n));
  if (self || !saved.length) return `I'll add ${list(ask.keys.map((k) => k.envName))} myself. Carry on without it and tell me what is left for me to do.`;
  return `Saved on this Mac for this board: ${list(saved)}. ${saved.length === 1 ? "It is" : "They are"} in your environment under ${saved.length === 1 ? "that name" : "those names"}: ` +
    "place them with commands that use the variable, and never print a value." + (skipped.length ? ` Left empty, not saved: ${list(skipped)}.` : "");
}
