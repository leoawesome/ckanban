// The user's avatar choices (AvatarFace.tsx draws them): one look per name ("claude", "you" or a teammate), stored once
// for every board in <home>/avatars.json. Only known part names and #rrggbb colours are kept; anything else in a
// request or a hand-edited file is dropped, and a missing field means "the default" (web/src/avatarLook.ts).
// The part lists match web/src/avatarLook.ts (test/avatars.test.ts checks).
// Claude's entry may also hold `name`: the name the board shows in place of "Claude" (display only; missing, empty or
// damaged means "Claude"). It lives on the "claude" entry only, and changing or resetting the look keeps it.

export const AVATAR_FACES = ["robot", "person", "critter", "cat", "bear", "alien", "ghost"] as const;
export const AVATAR_HAIRS = ["none", "short", "ponytail", "bun", "spiky", "long", "curly", "mohawk", "pigtails", "fringe"] as const;
export const AVATAR_HATS = ["none", "crown", "bow", "cap", "beanie", "wizard", "party", "tophat"] as const;
export const AVATAR_ACCESSORIES = ["none", "glasses", "headset", "magnifier", "sunglasses", "bowtie", "scarf", "flower", "eyepatch"] as const;
export const AVATAR_EYES = ["dots", "round", "big", "sleepy", "lashes"] as const;
export const AVATAR_DETAILS = ["none", "blush", "freckles", "moustache", "beard"] as const;
export const AVATAR_BACKGROUNDS = ["plain", "fade", "stripes", "dots", "stars"] as const;
/** Parts that were accessories before hats got their own slot (old files may still hold them there). */
const OLD_HAT_ACCESSORIES = ["crown", "bow"] as const;

export interface SavedLook {
  face?: (typeof AVATAR_FACES)[number];
  color?: string;
  hair?: (typeof AVATAR_HAIRS)[number];
  hairColor?: string;
  hat?: (typeof AVATAR_HATS)[number];
  accessory?: (typeof AVATAR_ACCESSORIES)[number];
  /** Missing (every look saved before these existed): dots, none, plain. */
  eyes?: (typeof AVATAR_EYES)[number];
  detail?: (typeof AVATAR_DETAILS)[number];
  background?: (typeof AVATAR_BACKGROUNDS)[number];
  /** Only on "claude": the name shown in place of "Claude". */
  name?: string;
}

/** Name -> look. Plain object built from validated keys only. */
export type SavedAvatarMap = Record<string, SavedLook>;

/** Names a choice can be saved under: a teammate name in handle form ("qa", "code-reviewer"), "claude" or "you". */
export const AVATAR_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Most choices kept (a hand-edited file can't grow the reply without bound). */
export const MAX_AVATARS = 500;

export class AvatarError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** The key whose entry may carry a display name. */
export const CLAUDE_KEY = "claude";
/** Longest display name kept (characters). */
export const MAX_CLAUDE_NAME = 24;

/** A display name as kept: one line, spaces collapsed, trimmed, at most MAX_CLAUDE_NAME characters; "" when unusable.
 * "Claude" itself is "" (the default, so nothing is stored). Same rule as cleanClaudeName in web/src/avatarLook.ts. */
export function cleanClaudeName(v: unknown): string {
  if (typeof v !== "string") return "";
  const one = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\p{Cf}+/gu, "").replace(/\s+/g, " ").trim();
  const name = Array.from(one).slice(0, MAX_CLAUDE_NAME).join("").trim();
  return name.toLowerCase() === "claude" ? "" : name;
}

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

export const isAvatarName = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && AVATAR_NAME.test(v);

/** The known, valid fields of one look; everything else is ignored. A look saved before hats had their own slot
 * (an `accessory` and no usable `hat`) is read in the new shape with the same face: a crown or bow accessory becomes that
 * hat with no accessory, any other accessory means no hat. The file is written in the new shape on the next save. */
export function cleanLook(v: unknown, key?: string): SavedLook {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const x = v as Record<string, unknown>;
  const out: SavedLook = {};
  if (oneOf(AVATAR_FACES, x.face)) out.face = x.face;
  if (isHex(x.color)) out.color = x.color.toLowerCase();
  if (oneOf(AVATAR_HAIRS, x.hair)) out.hair = x.hair;
  if (isHex(x.hairColor)) out.hairColor = x.hairColor.toLowerCase();
  if (oneOf(AVATAR_HATS, x.hat)) out.hat = x.hat;
  if (oneOf(AVATAR_ACCESSORIES, x.accessory)) out.accessory = x.accessory;
  if (oneOf(AVATAR_EYES, x.eyes)) out.eyes = x.eyes;
  if (oneOf(AVATAR_DETAILS, x.detail)) out.detail = x.detail;
  if (oneOf(AVATAR_BACKGROUNDS, x.background)) out.background = x.background;
  // No usable hat (an old entry, or a damaged hat): read a crown or bow accessory as that hat; another accessory means no hat.
  if (!out.hat) {
    if (oneOf(OLD_HAT_ACCESSORIES, x.accessory)) Object.assign(out, { hat: x.accessory, accessory: "none" });
    else if (out.accessory) out.hat = "none";
  }
  if (key === CLAUDE_KEY) {
    const name = cleanClaudeName(x.name);
    if (name) out.name = name;
  }
  return out;
}

/** Keeps well-formed names with at least one valid field, from a hand-edited, old or damaged avatars.json. */
export function cleanAvatars(v: unknown): SavedAvatarMap {
  const out: SavedAvatarMap = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  let n = 0;
  for (const [name, raw] of Object.entries(v as Record<string, unknown>)) {
    if (n >= MAX_AVATARS) break;
    if (!isAvatarName(name)) continue;
    const look = cleanLook(raw, name);
    if (!Object.keys(look).length) continue;
    out[name] = look;
    n++;
  }
  return out;
}

const has = (map: SavedAvatarMap, name: string) => Object.prototype.hasOwnProperty.call(map, name);
/** Claude's saved display name ({} when none), kept when its look changes. */
const keptName = (map: SavedAvatarMap, name: string): SavedLook => {
  const n = name === CLAUDE_KEY && has(map, name) ? cleanClaudeName(map[name].name) : "";
  return n ? { name: n } : {};
};

/** The map after saving `look` for `name` (replaces the old look; Claude's display name stays). Throws AvatarError on a bad name or nothing valid. */
export function withAvatar(map: SavedAvatarMap, name: string, look: unknown): SavedAvatarMap {
  if (!isAvatarName(name)) throw new AvatarError(400, "name may only use lowercase letters, digits and dashes");
  const { name: _ignored, ...clean } = cleanLook(look, name);
  if (!Object.keys(clean).length) throw new AvatarError(400, "nothing to save: use known parts and #rrggbb colours");
  if (!has(map, name) && Object.keys(map).length >= MAX_AVATARS) throw new AvatarError(400, `at most ${MAX_AVATARS} avatars can be saved`);
  return { ...map, [name]: { ...clean, ...keptName(map, name) } };
}

/** The map without `name`'s look (its default look comes back); Claude's display name stays. */
export function withoutAvatar(map: SavedAvatarMap, name: string): SavedAvatarMap {
  const kept = keptName(map, name);
  const out: SavedAvatarMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (k !== name) out[k] = v;
    else if (kept.name) out[k] = kept;
  }
  return out;
}

/** The map with Claude's display name set (cleaned), or cleared when it is empty or "Claude"; the look stays. */
export function withClaudeName(map: SavedAvatarMap, raw: unknown): SavedAvatarMap {
  if (raw !== null && raw !== undefined && typeof raw !== "string") throw new AvatarError(400, "name must be text");
  const name = cleanClaudeName(raw);
  const { name: _old, ...look } = has(map, CLAUDE_KEY) ? map[CLAUDE_KEY] : ({} as SavedLook);
  const next = { ...look, ...(name ? { name } : {}) };
  if (!has(map, CLAUDE_KEY) && name && Object.keys(map).length >= MAX_AVATARS) throw new AvatarError(400, `at most ${MAX_AVATARS} avatars can be saved`);
  const keep = Object.keys(next).length > 0;
  const out: SavedAvatarMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (k !== CLAUDE_KEY) out[k] = v;
    else if (keep) out[k] = next;
  }
  if (keep) out[CLAUDE_KEY] = next;
  return out;
}
