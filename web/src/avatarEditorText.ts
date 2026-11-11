// Words and small helpers for the avatar editor (AvatarEditor.tsx): plain names for the parts and swatches (screen
// readers read them), comparing looks, and a random look for "Surprise me".
import { AVATAR_ACCESSORIES, AVATAR_COLORS, AVATAR_FACES, AVATAR_HAIR_COLORS, AVATAR_HAIRS, type AvatarLook } from "./avatarLook";

const COLOR_NAMES: Record<string, string> = {
  "#b0502f": "Rust", "#7a5af5": "Violet", "#2b5fb8": "Blue", "#0e7c86": "Teal", "#2f7d4f": "Green",
  "#8a5a2b": "Brown", "#b3428a": "Pink", "#8e44ad": "Purple", "#a83838": "Red", "#4f6386": "Slate",
};
const HAIR_COLOR_NAMES: Record<string, string> = {
  "#5a3a24": "Brown", "#2b2622": "Black", "#d9a441": "Blond", "#a33a2a": "Auburn", "#9aa0a6": "Grey", "#e0457b": "Pink",
};

/** "Robot", "Magnifier": a part's name as the editor shows it. */
export const partLabel = (v: string): string => (v ? v[0].toUpperCase() + v.slice(1) : v);

/** A swatch's name for screen readers ("Teal"); a colour that isn't a swatch is "Current colour". */
export const colorName = (hex: string, hair = false): string => (hair ? HAIR_COLOR_NAMES : COLOR_NAMES)[hex.toLowerCase()] ?? "Current colour";

/** The swatches to show: the list, with the current colour first when it isn't one of them (a default like qa-lead's). */
export function swatches(list: readonly string[], current: string): string[] {
  const c = current.toLowerCase();
  return list.includes(c) ? [...list] : [c, ...list];
}

export const sameLook = (a: AvatarLook, b: AvatarLook): boolean =>
  a.face === b.face && a.color.toLowerCase() === b.color.toLowerCase() && a.hair === b.hair
  && a.hairColor.toLowerCase() === b.hairColor.toLowerCase() && a.accessory === b.accessory;

/** A random look; never the same as `from` (rnd: 0..1, Math.random by default). */
export function surpriseLook(from: AvatarLook, rnd: () => number = Math.random): AvatarLook {
  const pick = <T,>(a: readonly T[]): T => a[Math.min(a.length - 1, Math.floor(rnd() * a.length))];
  for (let i = 0; i < 20; i++) {
    const next: AvatarLook = {
      face: pick(AVATAR_FACES), color: pick(AVATAR_COLORS), hair: pick(AVATAR_HAIRS), hairColor: pick(AVATAR_HAIR_COLORS), accessory: pick(AVATAR_ACCESSORIES),
    };
    if (!sameLook(next, from)) return next;
  }
  return { ...from, face: AVATAR_FACES[(AVATAR_FACES.indexOf(from.face) + 1) % AVATAR_FACES.length] };
}
