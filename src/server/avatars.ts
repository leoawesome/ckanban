// The user's avatar choices (AvatarFace.tsx draws them): one look per name ("claude", "you" or a teammate), stored once
// for every board in <home>/avatars.json. Only known part names and #rrggbb colours are kept; anything else in a
// request or a hand-edited file is dropped, and a missing field means "the default" (web/src/avatarLook.ts).
// The part lists match web/src/avatarLook.ts (test/avatars.test.ts checks).

export const AVATAR_FACES = ["robot", "person", "critter"] as const;
export const AVATAR_HAIRS = ["none", "short", "ponytail", "bun", "spiky"] as const;
export const AVATAR_ACCESSORIES = ["none", "glasses", "bow", "headset", "crown", "magnifier"] as const;

export interface SavedLook {
  face?: (typeof AVATAR_FACES)[number];
  color?: string;
  hair?: (typeof AVATAR_HAIRS)[number];
  hairColor?: string;
  accessory?: (typeof AVATAR_ACCESSORIES)[number];
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

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

export const isAvatarName = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && AVATAR_NAME.test(v);

/** The known, valid fields of one look; everything else is ignored. */
export function cleanLook(v: unknown): SavedLook {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const x = v as Record<string, unknown>;
  const out: SavedLook = {};
  if (oneOf(AVATAR_FACES, x.face)) out.face = x.face;
  if (isHex(x.color)) out.color = x.color.toLowerCase();
  if (oneOf(AVATAR_HAIRS, x.hair)) out.hair = x.hair;
  if (isHex(x.hairColor)) out.hairColor = x.hairColor.toLowerCase();
  if (oneOf(AVATAR_ACCESSORIES, x.accessory)) out.accessory = x.accessory;
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
    const look = cleanLook(raw);
    if (!Object.keys(look).length) continue;
    out[name] = look;
    n++;
  }
  return out;
}

/** The map after saving `look` for `name` (replaces the old choice). Throws AvatarError on a bad name or nothing valid. */
export function withAvatar(map: SavedAvatarMap, name: string, look: unknown): SavedAvatarMap {
  if (!isAvatarName(name)) throw new AvatarError(400, "name may only use lowercase letters, digits and dashes");
  const clean = cleanLook(look);
  if (!Object.keys(clean).length) throw new AvatarError(400, "nothing to save: use known parts and #rrggbb colours");
  if (!Object.prototype.hasOwnProperty.call(map, name) && Object.keys(map).length >= MAX_AVATARS) throw new AvatarError(400, `at most ${MAX_AVATARS} avatars can be saved`);
  return { ...map, [name]: clean };
}

/** The map without `name` (its default look comes back). */
export function withoutAvatar(map: SavedAvatarMap, name: string): SavedAvatarMap {
  const out: SavedAvatarMap = {};
  for (const [k, v] of Object.entries(map)) if (k !== name) out[k] = v;
  return out;
}
