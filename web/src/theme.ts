/**
 * Light / dark theme. The choice (System, Light, Dark) is saved in this browser; the page carries the
 * resolved theme as <html data-theme="light|dark">, which styles.css reads. index.html runs the same
 * logic inline before first paint so there is no flash; keep THEME_KEY in sync with it.
 */
import { parseThemeChoice, resolveTheme, type Theme, type ThemeChoice } from "./themeChoice";
export type { ThemeChoice } from "./themeChoice";

export const THEME_KEY = "ckanban.theme";
export const THEME_EVENT = "ckanban-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const META_COLOR: Record<Theme, string> = { light: "#f6f5f1", dark: "#1a1917" };

export function savedThemeChoice(): ThemeChoice {
  try {
    return parseThemeChoice(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

const systemDark = () => typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;

/** Put the resolved theme on <html> (and the phone's status bar colour); tells listeners if it changed. */
export function applyTheme(choice: ThemeChoice = savedThemeChoice()) {
  const theme = resolveTheme(choice, systemDark());
  const root = document.documentElement;
  const changed = root.dataset.theme !== theme;
  root.dataset.theme = theme;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => (m.content = META_COLOR[theme]));
  if (changed) window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {}
  applyTheme(choice);
}

/** Once at startup: apply the saved choice and follow the system setting while the choice is System. */
export function initTheme() {
  applyTheme();
  if (typeof matchMedia === "function") matchMedia(DARK_QUERY).addEventListener("change", () => applyTheme());
  // Another tab changed the choice.
  window.addEventListener("storage", (e) => e.key === THEME_KEY && applyTheme());
}
