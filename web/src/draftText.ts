/**
 * The text of a quoted draft in Claude's reply (a blockquote), for its Copy button: plain text as it reads, with its
 * line breaks and paragraphs kept and list items on their own lines. Works on any DOM-like tree (tests use plain objects).
 */
export interface DraftNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<DraftNode>;
}

const PARAGRAPH = new Set(["P", "DIV", "UL", "OL", "PRE", "BLOCKQUOTE", "TABLE", "H1", "H2", "H3", "H4", "H5", "H6", "HR"]);
const LINE = new Set(["LI", "TR"]);

export function draftText(root: DraftNode): string {
  let out = "";
  const walk = (n: DraftNode, inPre: boolean, listIndex?: number, ordered?: boolean) => {
    if (n.nodeType === 3) {
      // Outside code a newline in the HTML source is just a space, as on screen, and a line starts with no space.
      const t = inPre ? n.nodeValue ?? "" : (n.nodeValue ?? "").replace(/\s*\n\s*/g, " ");
      out += !inPre && (!out || out.endsWith("\n")) ? t.trimStart() : t;
      return;
    }
    if (n.nodeType !== 1) return;
    const name = n.nodeName.toUpperCase();
    if (name === "BR") return void (out += "\n");
    if (name === "BUTTON") return;
    const para = PARAGRAPH.has(name);
    if (para) out += "\n\n";
    if (LINE.has(name)) out += `\n${name === "LI" ? (ordered ? `${listIndex}. ` : "- ") : ""}`;
    let li = 0;
    for (const c of Array.from(n.childNodes)) {
      const isLi = c.nodeType === 1 && c.nodeName.toUpperCase() === "LI";
      if (isLi) li++;
      walk(c, inPre || name === "PRE", isLi ? li : undefined, name === "OL" ? true : name === "UL" ? false : undefined);
    }
    if (para) out += "\n\n";
  };
  for (const c of Array.from(root.childNodes)) walk(c, false);
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\s+$/g, "");
}
