/** Ticket ids ("t_20261114_ekqu") in Claude's saved status text, split out so the view can show each as its title. */
export type TextPart = { text: string } | { id: string; title: string };

const ID = /\bt_\d{8}_[a-z0-9]+\b/gi;

/**
 * Splits text into plain pieces and known tickets. Ids not in `titles` stay plain text.
 * Runs on a few status lines at a time, so a plain regex over each is fine.
 */
export function ticketParts(text: string, titles: ReadonlyMap<string, string>): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(ID)) {
    const title = titles.get(m[0]);
    if (title === undefined) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ id: m[0], title: title || m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
