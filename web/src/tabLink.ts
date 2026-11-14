/**
 * The ticket panel's open tab (and the open Outputs file) in the link: #/<board>/<ticket>?tab=outputs&file=report.md.
 * Reloads, shared links and notifications then reopen the same tab. Other query keys (?browsers) are kept.
 */
const TABS = new Set(["ticket", "chat", "family", "huddle", "changes", "outputs", "usage"]);

const split = (hash: string): [string, URLSearchParams] => {
  const at = hash.indexOf("?");
  return at < 0 ? [hash, new URLSearchParams()] : [hash.slice(0, at), new URLSearchParams(hash.slice(at + 1))];
};

/** The tab and file a link asks for (null: none, or not a tab the panel has). */
export function readTabLink(hash: string): { tab: string | null; file: string | null } {
  const [, q] = split(hash);
  const tab = q.get("tab");
  return { tab: tab && TABS.has(tab) ? tab : null, file: tab === "outputs" ? q.get("file") : null };
}

/** The same hash with this tab and file (null: left out; Chat is the default and stays out of the link). */
export function withTabLink(hash: string, tab: string | null, file: string | null): string {
  const [path, q] = split(hash);
  q.delete("tab");
  q.delete("file");
  if (tab && tab !== "chat") q.set("tab", tab);
  if (tab === "outputs" && file) q.set("file", file);
  const rest = q.toString();
  return rest ? `${path}?${rest}` : path;
}

/** Whether a hash is this ticket's page (#/<board>/<ticket>, any query). */
export function hashIsTicket(hash: string, id: string): boolean {
  let path = split(hash)[0];
  try {
    path = decodeURIComponent(path);
  } catch {}
  return path.split("/")[2] === id;
}
