import { useState } from "react";
import { MoonIcon, SunIcon, SystemThemeIcon } from "./icons";
import { savedThemeChoice, setThemeChoice, type ThemeChoice } from "./theme";

const CHOICES: { value: ThemeChoice; label: string; icon: JSX.Element; title: string }[] = [
  { value: "system", label: "System", icon: <SystemThemeIcon />, title: "Follow your computer's light or dark setting" },
  { value: "light", label: "Light", icon: <SunIcon />, title: "Always light" },
  { value: "dark", label: "Dark", icon: <MoonIcon />, title: "Always dark" },
];

/** "Theme: System / Light / Dark" row for the ⋯ menu and the phone More sheet. Picking keeps the menu open. */
export function ThemePicker() {
  const [choice, setChoice] = useState(savedThemeChoice);
  return (
    <div className="theme-picker" role="group" aria-label="Theme">
      <span className="theme-picker-label">Theme</span>
      <div className="theme-seg">
        {CHOICES.map((c) => (
          <button key={c.value} type="button" role="menuitemradio" aria-checked={choice === c.value} title={c.title}
            className={`theme-opt${choice === c.value ? " on" : ""}`}
            onClick={() => { setChoice(c.value); setThemeChoice(c.value); }}>
            {c.icon}<span>{c.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
