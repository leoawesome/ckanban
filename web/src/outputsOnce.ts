import { api, type OutputFile } from "./api";
import { capMap } from "./chatMemo";

/**
 * A ticket's outputs list, shared between the ticket panel (the Outputs count) and its chat (file cards under
 * replies): opening a ticket asks once, not once per part. `reuseMs`: a list asked for at most this long ago (or still
 * on its way) is used as is; 0 always asks the board.
 */
const recent = new Map<string, { at: number; list: Promise<OutputFile[]> }>();
/** Tickets remembered (oldest out). */
const MAX = 20;

export function recentOutputs(slug: string, id: string, reuseMs = 0): Promise<OutputFile[]> {
  const key = `${slug}/${id}`;
  const hit = recent.get(key);
  if (hit && reuseMs > 0 && Date.now() - hit.at <= reuseMs) return hit.list;
  const list = api.outputs(slug, id);
  recent.delete(key);
  recent.set(key, { at: Date.now(), list });
  capMap(recent, MAX);
  list.catch(() => {
    if (recent.get(key)?.list === list) recent.delete(key);
  });
  return list;
}
