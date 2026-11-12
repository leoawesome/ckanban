// Customizable avatar looks (AvatarFace.tsx draws them): the parts, the default look for Claude, the user and every
// teammate, and the lookup that puts a saved choice over the default. Saved choices come from the daemon
// (GET /api/avatars, <home>/avatars.json, src/server/avatars.ts); anything unknown in them is ignored here too.
import { faceLookKey, faceLook, handleBase } from "./huddleText";

export const AVATAR_FACES = ["robot", "person", "critter"] as const;
export const AVATAR_HAIRS = ["none", "short", "ponytail", "bun", "spiky"] as const;
export const AVATAR_ACCESSORIES = ["none", "glasses", "bow", "headset", "crown", "magnifier"] as const;
export const AVATAR_MOODS = ["idle", "thinking", "working", "waiting", "done", "failed"] as const;

export type AvatarFace = (typeof AVATAR_FACES)[number];
export type AvatarHair = (typeof AVATAR_HAIRS)[number];
export type AvatarAccessory = (typeof AVATAR_ACCESSORIES)[number];
export type AvatarMood = (typeof AVATAR_MOODS)[number];

/** One avatar: colours are #rrggbb. */
export interface AvatarLook {
  face: AvatarFace;
  color: string;
  hair: AvatarHair;
  hairColor: string;
  accessory: AvatarAccessory;
}

/** Saved choices by name: "claude", "you" or a teammate name. Fields left out keep the default. Claude's entry may
 * also hold `name`, the name the board shows in place of "Claude" (claudeName). */
export type SavedAvatars = Record<string, Partial<AvatarLook> & { name?: string }>;

/** The name the board shows for Claude when the user gave none. */
export const DEFAULT_CLAUDE_NAME = "Claude";
/** Longest name kept (characters); the server (src/server/avatars.ts) keeps the same. */
export const MAX_CLAUDE_NAME = 24;

/** A name as kept: one line, spaces collapsed, trimmed, at most MAX_CLAUDE_NAME characters; "" when unusable or "Claude".
 * Same rule as cleanClaudeName in src/server/avatars.ts (test/avatars.test.ts checks). */
export function cleanClaudeName(v: unknown): string {
  if (typeof v !== "string") return "";
  const one = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\p{Cf}+/gu, "").replace(/\s+/g, " ").trim();
  const name = Array.from(one).slice(0, MAX_CLAUDE_NAME).join("").trim();
  return name.toLowerCase() === "claude" ? "" : name;
}

/** The name the board shows for Claude: the user's saved name, else "Claude" (missing, empty or damaged too). */
export function claudeName(saved?: SavedAvatars | null): string {
  if (!saved || typeof saved !== "object" || !Object.prototype.hasOwnProperty.call(saved, "claude")) return DEFAULT_CLAUDE_NAME;
  const e = saved.claude;
  return (e && typeof e === "object" && cleanClaudeName(e.name)) || DEFAULT_CLAUDE_NAME;
}

/** Swatches for the editor (the role colours are in them, plus the brand colour). */
export const AVATAR_COLORS = ["#b0502f", "#7a5af5", "#2b5fb8", "#0e7c86", "#2f7d4f", "#8a5a2b", "#b3428a", "#8e44ad", "#a83838", "#4f6386"] as const;
export const AVATAR_HAIR_COLORS = ["#5a3a24", "#2b2622", "#d9a441", "#a33a2a", "#9aa0a6", "#e0457b"] as const;

const BROWN = "#5a3a24", DARK = "#2b2622";
const look = (face: AvatarFace, color: string, hair: AvatarHair = "none", accessory: AvatarAccessory = "none", hairColor = BROWN): AvatarLook =>
  ({ face, color, hair, hairColor, accessory });

/** The main Claude: a robot in the brand colour. */
export const CLAUDE_LOOK = look("robot", "#b0502f");
/** The human user: a person, as the huddle faces show them today. */
export const YOU_LOOK = look("person", "#c96442", "short");

/** Built-in teammates (the keys of faceLook's LOOKS), keeping today's role colours. */
export const TEAMMATE_LOOKS: Record<string, AvatarLook> = {
  main: look("robot", "#8a5a2b", "none", "crown"),
  facilitator: look("person", "#7a5af5", "bun", "headset", DARK),
  reviewer: look("robot", "#2b5fb8", "short", "glasses"),
  qa: look("critter", "#0e7c86", "none", "headset"),
  "qa-lead": look("critter", "#0b5c63", "spiky", "headset", DARK),
  engineer: look("robot", "#2f7d4f", "none", "none", DARK),
  designer: look("person", "#b3428a", "short", "crown", "#a33a2a"),
  security: look("robot", "#a83838", "spiky", "glasses", DARK),
  researcher: look("person", "#4f6386", "bun", "glasses", "#9aa0a6"),
  "ux-critic": look("critter", "#c96442", "none", "magnifier"),
  "blast-radius": look("critter", "#c2410c", "spiky", "none", DARK),
  breaker: look("robot", "#6b4f3a", "short", "none", DARK),
  ponytail: look("person", "#8e44ad", "ponytail", "bow", "#d9a441"),
};

const FALLBACK_HAIRS: AvatarHair[] = ["none", "short", "spiky", "bun"];

/** Who an avatar is for: "claude", "you", a teammate name or handle ("qa-2"), or a huddle participant. */
export type AvatarWho = string | { handle: string; role?: string | null; preset?: string | null; kind?: string | null };

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** The known fields of one saved look; anything else (unknown parts, bad colours, other types) is dropped. */
export function cleanAvatarLook(v: unknown): Partial<AvatarLook> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const x = v as Record<string, unknown>;
  const out: Partial<AvatarLook> = {};
  if (oneOf(AVATAR_FACES, x.face)) out.face = x.face;
  if (isHex(x.color)) out.color = x.color.toLowerCase();
  if (oneOf(AVATAR_HAIRS, x.hair)) out.hair = x.hair;
  if (isHex(x.hairColor)) out.hairColor = x.hairColor.toLowerCase();
  if (oneOf(AVATAR_ACCESSORIES, x.accessory)) out.accessory = x.accessory;
  return out;
}

/** The default look: Claude, the user, a built-in teammate (by preset, handle without -N, or words in its role, as faceLook), else a stable robot from the name. */
export function defaultAvatar(who: AvatarWho): AvatarLook {
  const p = typeof who === "string" ? { handle: handleBase(who) } : who;
  if (p.handle === "claude" && typeof who === "string") return { ...CLAUDE_LOOK };
  if (p.handle === "you" || p.kind === "human") return { ...YOU_LOOK };
  const key = faceLookKey(p);
  if (key && TEAMMATE_LOOKS[key]) return { ...TEAMMATE_LOOKS[key] };
  let h = 0x811c9dc5;
  for (const c of p.handle.replace(/-\d+$/, "")) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return look("robot", faceLook(p).color, FALLBACK_HAIRS[(h >>> 3) % FALLBACK_HAIRS.length], "none", DARK);
}

/** The names a saved choice may be under, most specific first: preset, handle, handle without -N. */
function savedKeys(who: AvatarWho): string[] {
  if (typeof who === "string") {
    const h = handleBase(who);
    return [h, h.replace(/-\d+$/, "")];
  }
  if (who.handle === "you" || who.kind === "human") return ["you"];
  const h = handleBase(who.handle);
  return [who.preset ? handleBase(who.preset) : "", h, h.replace(/-\d+$/, "")].filter(Boolean);
}

/** The avatar to draw: the saved choice (field by field) over the default. Damaged or missing data gives the default. */
export function avatarFor(who: AvatarWho, saved?: SavedAvatars | null): AvatarLook {
  const base = defaultAvatar(who);
  if (!saved || typeof saved !== "object") return base;
  for (const k of savedKeys(who)) {
    if (Object.prototype.hasOwnProperty.call(saved, k)) return { ...base, ...cleanAvatarLook(saved[k]) };
  }
  return base;
}

/** The name a choice is saved under: "claude", "you" or the teammate's name in handle form. */
export const avatarKey = (who: AvatarWho): string => savedKeys(who)[0];
