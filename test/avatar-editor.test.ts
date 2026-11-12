import { expect, test } from "bun:test";
import {
  AVATAR_ACCESSORIES, AVATAR_BACKGROUNDS, AVATAR_COLORS, AVATAR_DETAILS, AVATAR_EYES, AVATAR_FACES, AVATAR_HAIR_COLORS, AVATAR_HAIRS, AVATAR_HATS, CLAUDE_LOOK, crownBase, hairCut, shownHair, showsAntenna, TEAMMATE_LOOKS,
} from "../web/src/avatarLook";
import { colorName, looksRight, partLabel, sameLook, surpriseLook, swatches } from "../web/src/avatarEditorText";

test("every swatch has a name for screen readers", () => {
  for (const c of AVATAR_COLORS) expect(colorName(c)).not.toBe("Current colour");
  for (const c of AVATAR_HAIR_COLORS) expect(colorName(c, true)).not.toBe("Current colour");
  expect(colorName("#0b5c63")).toBe("Current colour");
});

test("a default colour that isn't a swatch is shown first, once", () => {
  expect(swatches(AVATAR_COLORS, "#B0502F")).toEqual([...AVATAR_COLORS]);
  const s = swatches(AVATAR_COLORS, TEAMMATE_LOOKS["qa-lead"].color);
  expect(s[0]).toBe("#0b5c63");
  expect(s).toHaveLength(AVATAR_COLORS.length + 1);
});

test("Surprise me always changes the look", () => {
  let i = 0;
  const seq = [0, 0, 0, 0, 0];
  const from = surpriseLook(CLAUDE_LOOK, () => seq[i++ % seq.length]);
  expect(sameLook(from, CLAUDE_LOOK)).toBe(false);
  // A generator that keeps landing on the same parts still gives a different look.
  const same = surpriseLook(from, () => 0);
  expect(sameLook(same, from)).toBe(false);
});

test("Surprise me picks from every part, new ones included, and never hides hair whole under a hat", () => {
  const seen = { face: new Set<string>(), hair: new Set<string>(), hat: new Set<string>(), accessory: new Set<string>(), eyes: new Set<string>(), detail: new Set<string>(), background: new Set<string>() };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let from = CLAUDE_LOOK;
  for (let i = 0; i < 3000; i++) {
    const next = surpriseLook(from, rnd);
    expect(looksRight(next)).toBe(true);
    expect(sameLook(next, from)).toBe(false);
    for (const k of ["face", "hair", "hat", "accessory", "eyes", "detail", "background"] as const) seen[k].add(next[k]);
    from = next;
  }
  expect([...seen.face].sort()).toEqual([...AVATAR_FACES].sort());
  expect([...seen.hair].sort()).toEqual([...AVATAR_HAIRS].sort());
  expect([...seen.hat].sort()).toEqual([...AVATAR_HATS].sort());
  expect([...seen.accessory].sort()).toEqual([...AVATAR_ACCESSORIES].sort());
  expect([...seen.eyes].sort()).toEqual([...AVATAR_EYES].sort());
  expect([...seen.detail].sort()).toEqual([...AVATAR_DETAILS].sort());
  expect([...seen.background].sort()).toEqual([...AVATAR_BACKGROUNDS].sort());
  // A ghost from Surprise me has no hair and no facial hair (a sheet shows none, a beard would hang off it).
  expect(looksRight({ ...CLAUDE_LOOK, face: "ghost", hair: "short" })).toBe(false);
  expect(looksRight({ ...CLAUDE_LOOK, face: "ghost", detail: "beard" })).toBe(false);
  expect(looksRight({ ...CLAUDE_LOOK, face: "ghost", detail: "blush" })).toBe(true);
  expect(looksRight({ ...CLAUDE_LOOK, face: "bear", eyes: "big" })).toBe(false);
  expect(looksRight(surpriseLook({ ...CLAUDE_LOOK, face: "alien", hair: "short" }, () => 0.999))).toBe(true);
  expect(looksRight({ ...CLAUDE_LOOK, hair: "bun", hat: "beanie" })).toBe(false);
  expect(looksRight({ ...CLAUDE_LOOK, hair: "mohawk", hat: "crown" })).toBe(false);
  expect(looksRight({ ...CLAUDE_LOOK, hair: "bun", hat: "bow" })).toBe(true);
  // Even from a hand-picked look that Surprise me wouldn't make, a stuck generator still gives one that looks right.
  expect(looksRight(surpriseLook({ ...CLAUDE_LOOK, hair: "bun", hat: "cap" }, () => 0))).toBe(true);
});

test("hair goes under covering hats, and the antenna hides under any hat but the bow", () => {
  expect(hairCut({ ...CLAUDE_LOOK, hat: "beanie", hair: "bun" })).not.toBeNull();
  expect(hairCut({ ...CLAUDE_LOOK, hat: "crown", hair: "mohawk" })).not.toBeNull();
  expect(hairCut({ ...CLAUDE_LOOK, hat: "crown", hair: "spiky" })).toBeNull();
  expect(hairCut({ ...CLAUDE_LOOK, hat: "party", hair: "bun" })).not.toBeNull();
  expect(hairCut({ ...CLAUDE_LOOK, hat: "crown", hair: "bun" })).toBeNull();
  expect(hairCut({ ...CLAUDE_LOOK, hat: "bow", hair: "mohawk" })).toBeNull();
  expect(showsAntenna(CLAUDE_LOOK)).toBe(true);
  expect(showsAntenna({ ...CLAUDE_LOOK, hat: "bow" })).toBe(true);
  for (const hat of AVATAR_HATS.filter((h) => h !== "none" && h !== "bow")) expect(showsAntenna({ ...CLAUDE_LOOK, hat })).toBe(false);
});

test("new faces: no hair on the ghost, the alien's antennae hide under any hat", () => {
  expect(shownHair({ ...CLAUDE_LOOK, face: "ghost", hair: "long" })).toBe("none");
  expect(shownHair({ ...CLAUDE_LOOK, face: "bear", hair: "long" })).toBe("long");
  expect(hairCut({ ...CLAUDE_LOOK, face: "ghost", hair: "bun", hat: "beanie" })).toBeNull();
  expect(crownBase({ ...CLAUDE_LOOK, face: "ghost", hair: "spiky" })).toBe(crownBase({ ...CLAUDE_LOOK, face: "ghost", hair: "none" }));
  expect(showsAntenna({ ...CLAUDE_LOOK, face: "alien" })).toBe(true);
  expect(showsAntenna({ ...CLAUDE_LOOK, face: "alien", hat: "bow" })).toBe(false);
  expect(showsAntenna({ ...CLAUDE_LOOK, face: "alien", hair: "curly" })).toBe(false);
  // The faces we had keep their fit exactly.
  expect(crownBase({ ...CLAUDE_LOOK, face: "robot" })).toBe(12.4);
  expect(crownBase({ ...CLAUDE_LOOK, face: "person" })).toBe(12);
  expect(crownBase({ ...CLAUDE_LOOK, face: "critter", hair: "short" })).toBe(10.6);
});

test("labels and comparisons", () => {
  expect(sameLook({ ...CLAUDE_LOOK, eyes: "big" }, CLAUDE_LOOK)).toBe(false);
  expect(sameLook({ ...CLAUDE_LOOK, detail: "blush" }, CLAUDE_LOOK)).toBe(false);
  expect(sameLook({ ...CLAUDE_LOOK, background: "fade" }, CLAUDE_LOOK)).toBe(false);
  expect(partLabel("magnifier")).toBe("Magnifier");
  expect(partLabel("tophat")).toBe("Top hat");
  expect(partLabel("eyepatch")).toBe("Eye patch");
  expect(sameLook({ ...CLAUDE_LOOK, hat: "cap" }, CLAUDE_LOOK)).toBe(false);
  expect(sameLook({ ...CLAUDE_LOOK, color: CLAUDE_LOOK.color.toUpperCase() }, CLAUDE_LOOK)).toBe(true);
  expect(sameLook({ ...CLAUDE_LOOK, hair: "bun" }, CLAUDE_LOOK)).toBe(false);
});
