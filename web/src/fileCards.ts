/** The fields used here of api.ts's SessionEntry and OutputFile (kept DOM-free so the root typecheck and tests can import it). */
interface Entry { uuid: string; at: string; role: "user" | "assistant"; kind: string; peer?: unknown }
interface OutFile { name: string; updatedAt: string }

const NO_SKIP: ReadonlySet<string> = new Set();
/** A feature's "Where we are" files in its main ticket's outputs (src/server/feature.ts statusFiles). */
export const STATUS_FILES: ReadonlySet<string> = new Set(["status.json", "status.md"]);

/**
 * Which reply each output file belongs to, for the file cards under replies. A turn runs from one incoming message
 * (the user's, a board prompt or another ticket's) to the next; a file last written during a turn goes under that
 * turn's last Claude reply. File times are reliable where paths in the reply text are not (Claude names files in
 * many ways, or not at all), and a file written again later moves to the newer reply. Mockups have their own chips.
 * Files older than the first loaded entry are left out: their reply isn't on screen. skip: names never listed (a
 * main ticket's status files, which "Where we are" already pins at the top and the board rewrites at every update).
 */
export function filesByReply<F extends OutFile>(entries: Entry[], files: F[], skip: ReadonlySet<string> = NO_SKIP): Map<string, F[]> {
  const out = new Map<string, F[]>();
  const turns: { from: string; reply: string | null }[] = [];
  for (const e of entries) {
    if (e.role === "user" && e.kind !== "tool") turns.push({ from: e.at, reply: null });
    else if (e.role === "assistant" && e.kind === "text" && !e.peer && turns.length) turns[turns.length - 1].reply = e.uuid;
  }
  for (const f of files) {
    if (f.name.startsWith("mockups/") || skip.has(f.name)) continue;
    let i = turns.length - 1;
    while (i >= 0 && f.updatedAt < turns[i].from) i--;
    const reply = i >= 0 ? turns[i].reply : null;
    if (!reply) continue;
    const list = out.get(reply);
    if (list) list.push(f);
    else out.set(reply, [f]);
  }
  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
