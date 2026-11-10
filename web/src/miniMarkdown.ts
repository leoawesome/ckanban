/**
 * A tiny, safe markdown subset for question forms: **bold**, *italic*, `code`, [links](https://…) and bare
 * https links (new tab, rel=noopener), "- " / "1. " lists and line breaks. Everything else is escaped, so no raw
 * HTML ever gets through (no React, so it can be unit tested).
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const link = (href: string, inner: string) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;

const INLINE = new RegExp([
  /`([^`\n]+)`/.source, // 1 code
  /\[([^\]\n]+)\]\(([^)\s]+)\)/.source, // 2 text, 3 url
  /\*\*(?!\s)(.+?)\*\*/.source, // 4 bold
  /__(?!\s)(.+?)__/.source, // 5 bold
  /(?<![\w*])\*(?![\s*])(.+?)(?<!\s)\*(?![\w*])/.source, // 6 italic
  /(?<!\w)_(?![\s_])(.+?)(?<!\s)_(?!\w)/.source, // 7 italic (not inside snake_case)
  /(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/.source, // 8 bare link
].join("|"), "g");

/**
 * A "**" left over after the pairs are matched (a summary cut off with "…" before its closing "**"), dropped unless it
 * stands alone between spaces ("2 ** 3" stays).
 */
const STRAY_BOLD = /(?<!\s)\*\*|\*\*(?!\s)/g;
const text = (s: string) => esc(s.replace(STRAY_BOLD, ""));

/** One line of text: inline marks only. */
export function inlineMarkdown(s: string, links = true): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    const at = m.index!;
    out += text(s.slice(last, at));
    last = at + m[0].length;
    if (m[1] !== undefined) out += `<code>${esc(m[1])}</code>`;
    else if (m[2] !== undefined) out += links && SAFE_URL.test(m[3]) ? link(m[3], inlineMarkdown(m[2], false)) : esc(m[0]);
    else if (m[4] !== undefined || m[5] !== undefined) out += `<strong>${inlineMarkdown(m[4] ?? m[5], links)}</strong>`;
    else if (m[6] !== undefined || m[7] !== undefined) out += `<em>${inlineMarkdown(m[6] ?? m[7], links)}</em>`;
    else out += links ? link(m[8], esc(m[8])) : esc(m[8]);
  }
  return out + text(s.slice(last));
}

const ITEM = /^\s*(?:([-*•])|(\d{1,3})[.)])\s+(.*)$/;

/**
 * Text as HTML: paragraphs (blank lines), line breaks, "- " and "1. " lists. A single paragraph comes back without
 * a <p>, so a one-line question stays inline.
 */
export function miniMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  const blocks: string[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push(`<p>${para.map((l) => inlineMarkdown(l.trim())).join("<br>")}</p>`);
    para = [];
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : "";
      blocks.push(`<${tag}${start}>${list.items.map((i) => `<li>${inlineMarkdown(i)}</li>`).join("")}</${tag}>`);
    }
    list = null;
  };
  for (const line of lines) {
    const m = ITEM.exec(line);
    if (m) {
      const ordered = m[2] !== undefined;
      if (para.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, start: ordered ? Number(m[2]) : 1, items: [] };
      list.items.push(m[3]);
    } else if (!line.trim()) flush();
    else if (list && /^\s+\S/.test(line)) list.items[list.items.length - 1] += ` ${line.trim()}`; // an item's next line
    else {
      if (list) flush();
      para.push(line);
    }
  }
  flush();
  if (blocks.length === 1 && blocks[0].startsWith("<p>")) return blocks[0].slice(3, -4);
  return blocks.join("");
}

/** The text without its marks, for places that show it plain (inside a button, a tooltip). */
export function plainMarkdown(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/\*\*(?!\s)(.+?)\*\*|__(?!\s)(.+?)__/g, (_, a, b) => a ?? b)
    .replace(/(?<![\w*])\*(?![\s*])(.+?)(?<!\s)\*(?![\w*])/g, "$1")
    .replace(/(?<!\w)_(?![\s_])(.+?)(?<!\s)_(?!\w)/g, "$1")
    .replace(STRAY_BOLD, "");
}
