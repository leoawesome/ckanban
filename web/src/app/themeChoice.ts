/** Theme choice rules, kept free of the DOM so they can be unit tested (theme.ts applies them). */
export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export function parseThemeChoice(raw: string | null | undefined): ThemeChoice {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}
