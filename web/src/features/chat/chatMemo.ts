import { createElement, Fragment, memo, type ReactNode } from "react";

/**
 * Helpers that keep a long chat (thousands of messages loaded by "Load earlier") cheap to keep open: a live update or
 * a tail refresh redraws only the messages that changed, and nothing walks the rest of the list once per message.
 * No imports from api.ts, so tests load it.
 */

/** Same values in the same order (Object.is). null: never the same (the block always redraws). */
export function sameDeps(a: readonly unknown[] | null, b: readonly unknown[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * One block of a chat, drawn again only when one of `deps` changed (null: on every render). `render` runs only then,
 * so everything it shows that can change must be in `deps`; callbacks it hands out should read the latest ones
 * through a ref, as an old `render` stays in use while the deps stay the same.
 */
export const MemoBlock = memo(
  function MemoBlock({ render }: { deps: readonly unknown[] | null; render: () => ReactNode }) {
    return createElement(Fragment, null, render());
  },
  (a, b) => sameDeps(a.deps, b.deps),
);

/** Deep equality for parsed JSON (plain objects, arrays, strings, numbers, booleans, null). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  if (ka.length !== Object.keys(b as object).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * A refreshed tail of the conversation with the entries that did not change swapped for the ones already on screen
 * (matched by uuid), so their blocks keep their identity and are not drawn again. Returns `old` itself when nothing
 * changed at all.
 */
export function keepSame<E extends { uuid: string }>(old: readonly E[], fresh: E[]): E[] {
  if (!old.length) return fresh;
  const byUuid = new Map<string, E>();
  for (const e of old) byUuid.set(e.uuid, e);
  let same = old.length === fresh.length;
  const out = fresh.map((e, i) => {
    const o = byUuid.get(e.uuid);
    const keep = o && sameJson(o, e) ? o : e;
    if (keep !== old[i]) same = false;
    return keep;
  });
  return same ? (old as E[]) : out;
}

type CountEntry = { role: string; kind: string; text?: string; commandOutput?: boolean; huddleId?: string; peer?: { automation?: string } | null };

/** A message of the user's that answers what came before it (a form, a Resend offer, a key box). */
export const answers = (e: CountEntry): boolean => e.role === "user" && e.kind === "text" && !e.huddleId && !e.peer?.automation;

/**
 * In one pass from the end: for each index, how many messages come after it (Rewind's "N later messages"), and the
 * index of the last message that answers (answered after i: lastAnswer > i).
 */
export function laterCounts(entries: readonly CountEntry[]): { textAfter: Int32Array; lastAnswer: number } {
  const textAfter = new Int32Array(entries.length);
  let n = 0;
  let lastAnswer = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    textAfter[i] = n;
    const e = entries[i];
    if (e.kind === "text" && !!e.text && !e.commandOutput) n++;
    if (lastAnswer < 0 && answers(e)) lastAnswer = i;
  }
  return { textAfter, lastAnswer };
}

/** Keeps at most `max` entries in a Map used as a cache, dropping the oldest added (Maps keep insertion order). */
export function capMap<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) {
    const first = m.keys().next();
    if (first.done) return;
    m.delete(first.value);
  }
}
