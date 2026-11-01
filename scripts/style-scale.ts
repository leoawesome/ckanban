// The UI's shared scale (tokens in web/src/styles.css :root). test/style-scale.test.ts runs these checks
// over the stylesheet and the components, so new code can't add an off-scale text size, weight, corner,
// shadow or icon size.

export const FONT_WEIGHTS = ["400", "500", "600", "700"];
export const ICON_SIZES = [12, 14, 16, 20];
const FS = /^var\(--fs-(2xs|xs|sm|md|lg|xl)\)$/;
const RADIUS = /^(0|inherit|50%|var\(--r-(sm|md|pill)\))$/;

export type Problem = { line: number; text: string };

/** Off-scale font-size, font-weight, font shorthand, border-radius and drop-shadow values in a stylesheet. */
export function offScaleCss(css: string): Problem[] {
  const problems: Problem[] = [];
  const add = (index: number, text: string) => problems.push({ line: css.slice(0, index).split("\n").length, text });
  // Only real properties: a custom property (--fs-xs: 12px) is the token itself.
  const decl = /(?<![-\w])(font-size|font-weight|font|border-radius|box-shadow)\s*:\s*([^;}]+)/g;
  for (const m of css.matchAll(decl)) {
    const [whole, prop] = m;
    const value = m[2].replace(/!important/, "").trim();
    if (value === "inherit") continue;
    let ok = true;
    if (prop === "font-size") ok = FS.test(value);
    else if (prop === "font-weight") ok = FONT_WEIGHTS.includes(value) || value === "normal" || value === "bold";
    else if (prop === "font") ok = fontShorthandOk(value);
    else if (prop === "border-radius") ok = value.split(/\s+/).every((v) => RADIUS.test(v));
    else ok = value.split(/,(?![^(]*\))/).every((p) => shadowOk(p.trim()));
    if (!ok) add(m.index!, whole.trim());
  }
  return problems;
}

function fontShorthandOk(value: string): boolean {
  const weight = value.match(/^(\d{3})\s/);
  if (weight && !FONT_WEIGHTS.includes(weight[1])) return false;
  const size = value.replace(/^\d{3}\s+/, "").split(/[\s/]/)[0];
  return FS.test(size);
}

/** none, a shadow token, or a ring / edge bar (no blur): focus rings and accent edges aren't elevation. */
function shadowOk(part: string): boolean {
  if (part === "none" || /^var\(--shadow-(sm|pop|panel)\)$/.test(part)) return true;
  const lengths = part.replace(/^inset\s+/, "").split(/\s+/).slice(0, 3);
  if (lengths.length < 3 || lengths.some((l) => !/^-?[\d.]+(px)?$/.test(l))) return false;
  return parseFloat(lengths[2]) === 0;
}

/** Off-scale icon sizes (size={N} on an *Icon component, or an IconProps default in icons.tsx; the logo isn't an icon) and inline fontSize. */
export function offScaleTsx(src: string): Problem[] {
  const problems: Problem[] = [];
  const add = (index: number, text: string) => problems.push({ line: src.slice(0, index).split("\n").length, text });
  for (const m of src.matchAll(/Icon\b[^>]*?\bsize=\{(\d+)\}/g))
    if (!ICON_SIZES.includes(+m[1])) add(m.index!, `size={${m[1]}}`);
  for (const m of src.matchAll(/\{\s*size\s*=\s*(\d+)[^}]*\}\s*:\s*IconProps/g))
    if (!ICON_SIZES.includes(+m[1])) add(m.index!, `size = ${m[1]}`);
  for (const m of src.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g))
    if (![11, 12, 13, 14, 16, 20].includes(+m[1])) add(m.index!, `fontSize: ${m[1]}`);
  return problems;
}
