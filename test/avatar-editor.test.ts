import { expect, test } from "bun:test";
import { AVATAR_COLORS, AVATAR_HAIR_COLORS, CLAUDE_LOOK, TEAMMATE_LOOKS } from "../web/src/avatarLook";
import { colorName, partLabel, sameLook, surpriseLook, swatches } from "../web/src/avatarEditorText";

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

test("labels and comparisons", () => {
  expect(partLabel("magnifier")).toBe("Magnifier");
  expect(sameLook({ ...CLAUDE_LOOK, color: CLAUDE_LOOK.color.toUpperCase() }, CLAUDE_LOOK)).toBe(true);
  expect(sameLook({ ...CLAUDE_LOOK, hair: "bun" }, CLAUDE_LOOK)).toBe(false);
});
