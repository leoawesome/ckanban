import { describe, expect, test } from "bun:test";
import { parseThemeChoice, resolveTheme } from "../web/src/themeChoice";

describe("theme choice", () => {
  test("unknown or missing saved values mean System", () => {
    expect(parseThemeChoice(null)).toBe("system");
    expect(parseThemeChoice("blue")).toBe("system");
    expect(parseThemeChoice("dark")).toBe("dark");
    expect(parseThemeChoice("light")).toBe("light");
  });
  test("System follows the computer; Light and Dark ignore it", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
