// The UI's shared scale (tokens in web/src/styles.css :root, documented in design-system/kanban/MASTER.md).
// test/style-scale.test.ts runs these checks over the stylesheet and the components, so new code can't add an
// off-scale text size, weight, corner, shadow, icon size, raw colour or spacing value.

export const FONT_WEIGHTS = ["400", "500", "600", "700"];
export const ICON_SIZES = [12, 14, 16, 20];
/** The spacing steps (--sp-* in styles.css), in px. */
export const SPACING: Record<string, number> = {
  "--sp-1": 2, "--sp-2": 4, "--sp-2h": 6, "--sp-3": 8, "--sp-3h": 10, "--sp-4": 12, "--sp-5": 16, "--sp-6": 24, "--sp-7": 32,
};
const FS = /^var\(--fs-(2xs|xs|sm|md|lg|xl)\)$/;
const RADIUS = /^(0|inherit|50%|var\(--r-(sm|md|pill)\))$/;

export type Problem = { line: number; text: string };

// Every CSS named colour (transparent, currentColor and inherit are fine: they aren't a colour of their own).
const NAMED = "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen";
const RAW_COLOUR = new RegExp(
  `#[0-9a-fA-F]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(|(?<![-\\w])(?:${NAMED.split(" ").join("|")})(?![-\\w])`, "i");
const SPACING_PROP = /^(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$|^(?:gap|row-gap|column-gap)$/;

const lineAt = (src: string, index: number) => src.slice(0, index).split("\n").length;
/** Blank out comments (keeping line breaks) so commented-out code and prose aren't checked. */
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));

/** A raw colour in a property value (quoted text such as `content: "…"` doesn't count). */
export const hasRawColour = (value: string) => RAW_COLOUR.test(value.replace(/"[^"]*"|'[^']*'/g, ""));

/** A spacing value is off the scale if it has a length other than 0 outside var(…) and env(…). em is allowed: it
 *  follows the text size (prose rhythm in markdown); %, vw and vh are layout, not spacing steps. */
export function offScaleSpacing(value: string): boolean {
  const rest = value.replace(/var\(--[\w-]+\)|env\([^)]*\)/g, " ");
  for (const m of rest.matchAll(/(?<![\w.-])-?(\d*\.?\d+)(px|rem|pt|ch|ex)?(?![\w.%])/g)) {
    if (+m[1] === 0) continue;
    if (m[2]) return true;
    // A bare number is only fine as a calc() factor (`calc(-1 * var(--sp-2))`, `/ 2`).
    if (!/[*/]\s*$/.test(rest.slice(0, m.index)) && !/^\s*[*/]/.test(rest.slice(m.index! + m[0].length))) return true;
  }
  return false;
}

/** Off-scale font-size, font-weight, font shorthand, border-radius, drop-shadow, colour and spacing values in a
 *  stylesheet. Custom properties (`--x: …`) are token definitions and may hold raw values; mask images use colour
 *  only for its alpha, so they may too. */
export function offScaleCss(source: string): Problem[] {
  const css = noComments(source);
  const problems: Problem[] = [];
  const add = (index: number, text: string) => problems.push({ line: lineAt(css, index), text });
  // A declaration ends at ; or }. A selector like `a:hover {` ends at {, so it never matches.
  for (const m of css.matchAll(/(?<![-\w])([a-z][a-z-]*)\s*:\s*([^;{}]+)(?=[;}])/g)) {
    const prop = m[1];
    const value = m[2].replace(/!important/, "").trim();
    const text = `${prop}: ${value}`.replace(/\s+/g, " ");
    if (value === "inherit") continue;
    let ok = true;
    if (prop === "font-size") ok = FS.test(value);
    else if (prop === "font-weight") ok = FONT_WEIGHTS.includes(value) || value === "normal" || value === "bold";
    else if (prop === "font") ok = fontShorthandOk(value);
    else if (prop === "border-radius") ok = value.split(/\s+/).every((v) => RADIUS.test(v));
    else if (prop === "box-shadow") ok = splitTop(value).every((p) => shadowOk(p.trim()));
    else if (SPACING_PROP.test(prop)) ok = !offScaleSpacing(value);
    if (ok && !/^(?:-webkit-)?mask(?:-image)?$/.test(prop) && hasRawColour(value)) ok = false;
    if (!ok) add(m.index!, text);
  }
  return problems;
}

/** Split a list on its top-level commas (not the ones inside color-mix(…) or var(…)). */
function splitTop(value: string): string[] {
  const parts = [""];
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) parts.push("");
    else parts[parts.length - 1] += ch;
  }
  return parts;
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

const TSX_SPACING = /\b((?:padding|margin)(?:Top|Right|Bottom|Left|Inline|Block)?|gap|rowGap|columnGap)\s*:\s*(`[^`]*`|"[^"]*"|'[^']*'|[^,;}\n]+)/g;
const TSX_COLOUR = /\b(color|background|backgroundColor|borderColor|outlineColor|fill|stroke)\s*:\s*("[^"]*"|'[^']*'|`[^`]*`)/g;

/** Off-scale icon sizes (size={N} on an *Icon component, or an IconProps default in icons.tsx; the logo isn't an icon),
 *  inline fontSize, and raw spacing or colours in style objects. A number in a style is px, so spacing must be 0 or a
 *  string of tokens (`calc(var(--sp-3) + ${depth} * var(--sp-4))`). */
export function offScaleTsx(src: string): Problem[] {
  const problems: Problem[] = [];
  const add = (index: number, text: string) => problems.push({ line: lineAt(src, index), text });
  for (const m of src.matchAll(/Icon\b[^>]*?\bsize=\{(\d+)\}/g))
    if (!ICON_SIZES.includes(+m[1])) add(m.index!, `size={${m[1]}}`);
  for (const m of src.matchAll(/\{\s*size\s*=\s*(\d+)[^}]*\}\s*:\s*IconProps/g))
    if (!ICON_SIZES.includes(+m[1])) add(m.index!, `size = ${m[1]}`);
  for (const m of src.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g))
    if (![11, 12, 13, 14, 16, 20].includes(+m[1])) add(m.index!, `fontSize: ${m[1]}`);
  for (const m of src.matchAll(TSX_SPACING)) {
    const value = m[2].trim();
    // Strings: check their CSS. Expressions: any number literal other than 0 outside a string is raw px.
    const strings = [...value.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((s) => (s[1] ?? s[2] ?? s[3]).replace(/\$\{[^}]*\}/g, "1"));
    const code = value.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, " ");
    const rawNumber = [...code.matchAll(/(?<![\w.])(\d*\.?\d+)(?![\w.])/g)].some((n) => +n[1] !== 0);
    if (rawNumber || strings.some(offScaleSpacing)) add(m.index!, `${m[1]}: ${value}`);
  }
  for (const m of src.matchAll(TSX_COLOUR))
    if (hasRawColour(m[2].slice(1, -1))) add(m.index!, `${m[1]}: ${m[2]}`);
  return problems;
}
