import { createContext } from "react";

/** Lets Markdown inside a ticket turn file paths that exist into chips that open them (FileViewer.tsx). */
export interface FileLinks {
  /** Which of these paths (as written) exist in the ticket's folders. */
  find(paths: string[]): Promise<Set<string>>;
  open(path: string): void;
}

export const FileLinkContext = createContext<FileLinks | null>(null);

/** A path that wasn't there is asked about again after this long: the run may write it any moment. */
const MISSING_TTL = 15_000;
/** Most paths one find-files request looks at (the daemon reads no more: http.ts). */
export const FIND_CHUNK = 200;

/**
 * `find` with a memory: found paths stay found, missing ones are rechecked after a while. Calls made together (every
 * message of a chat page asks when it is drawn) share one request: paths are collected until the current task ends.
 */
export function fileFinder(lookup: (paths: string[]) => Promise<string[]>, now = () => Date.now()): FileLinks["find"] {
  const found = new Set<string>();
  const missing = new Map<string, number>();
  /** Paths asked about and not answered yet: the request that answers them. */
  const asking = new Map<string, Promise<void>>();
  let batch: Set<string> | null = null;
  let batchDone: Promise<void> | null = null;
  // The daemon looks at FIND_CHUNK paths per request (http.ts find-files): a long chat page asks in several, one after
  // another, and only paths a request answered for count as missing (a failed one leaves its paths to ask again).
  const send = async (paths: string[]) => {
    for (let i = 0; i < paths.length; i += FIND_CHUNK) {
      const chunk = paths.slice(i, i + FIND_CHUNK);
      try {
        const hits = new Set(await lookup(chunk));
        for (const p of chunk) {
          if (hits.has(p)) {
            found.add(p);
            missing.delete(p);
          } else missing.set(p, now());
        }
      } catch {}
    }
  };
  return async (paths) => {
    const unique = [...new Set(paths)];
    const ask = unique.filter((p) => !found.has(p) && !asking.has(p) && !(now() - (missing.get(p) ?? -Infinity) < MISSING_TTL));
    if (ask.length) {
      if (!batch) {
        const b = new Set<string>();
        batch = b;
        batchDone = Promise.resolve().then(() => {
          batch = null;
          const list = [...b];
          return send(list).finally(() => {
            for (const p of list) asking.delete(p);
          });
        });
      }
      for (const p of ask) {
        batch.add(p);
        asking.set(p, batchDone!);
      }
    }
    await Promise.all(unique.map((p) => asking.get(p)).filter((x) => !!x));
    return new Set(paths.filter((p) => found.has(p)));
  };
}
