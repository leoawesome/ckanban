// An animated face for Claude, the user or a teammate: drawn from its parts (avatarLook.ts) and a mood, at any size.
// Inline SVG with CSS motion (.av in styles.css: transform and opacity only, still under prefers-reduced-motion).
// Decorative (aria-hidden): callers say the state in words next to it. useAvatar gives the look to draw for a name,
// the user's saved choice (shared by every board) or the default.
import { useEffect, useState } from "react";
import { req } from "./api";
import { avatarFor, avatarKey, claudeName, cleanAvatarLook, type AvatarLook, type AvatarMood, type AvatarWho, type SavedAvatars } from "./avatarLook";

const INK = "#2b2622";
const HAIR_BASE = "M9 19q1-10 11-10t11 10q-5-5-11-4.5T9 19z";
/** Spiky hair: five rounded spikes along the top of the head, a fringe curve underneath (x 10.6 to 29.4). */
const SPIKY = "M10.6 16.8l.5-6.6 2.4 1.4L15 7.2l2.6 3L20 5.6l2.4 4.6L25 7.2l1.5 4.4 2.4-1.4.5 6.6q-4-3.2-9.4-2.9T10.6 16.8z";
const MOUTH: Record<AvatarMood, string> = {
  idle: "M16 25.5q4 3 8 0", thinking: "M18 26.3h4", working: "M17 26h6", waiting: "M16 25.5q4 3 8 0", done: "M15 24.5q5 5 10 0", failed: "M16 27.5q4-3 8 0",
};

function Hair({ hair, color }: { hair: AvatarLook["hair"]; color: string }) {
  switch (hair) {
    case "short": return <path d={HAIR_BASE} />;
    case "ponytail": return <><path d={HAIR_BASE} /><path d="M29 12q8 1 6 13q-1 3-3 1q2-6-4-9z" /></>;
    case "bun": return <><circle cx="20" cy="7.5" r="4" /><path d={HAIR_BASE} /></>;
    // A tuft of five even spikes on the crown of the head, inside its width; the round stroke softens the tips.
    case "spiky": return <path d={SPIKY} stroke={color} strokeWidth="1.6" strokeLinejoin="round" />;
    default: return null;
  }
}

/** Where the crown's base sits (y): on the head, or on the hair, with a little overlap so it doesn't float. */
function crownBase(look: AvatarLook): number {
  if (look.hair === "spiky") return 10.2;
  if (look.hair !== "none") return 10.6;
  return look.face === "robot" ? 12.4 : 12;
}

function Accessory({ look }: { look: AvatarLook }) {
  switch (look.accessory) {
    case "glasses": return <g fill="none" stroke={INK} strokeWidth="1.4"><circle cx="15.5" cy="20" r="4" /><circle cx="24.5" cy="20" r="4" /></g>;
    case "bow": return <><path d="M13 10l-5-3.5v7zM13 10l5-3.5v7z" fill="#e0457b" /><circle cx="13" cy="10" r="1.7" fill="#b82d5e" /></>;
    case "headset": return (
      <>
        <path d="M8 21q0-12 12-12t12 12" fill="none" stroke={INK} strokeWidth="2" />
        <rect x="5.5" y="19" width="4.5" height="7.5" rx="2" fill={INK} />
        <rect x="30" y="19" width="4.5" height="7.5" rx="2" fill={INK} />
      </>
    );
    case "crown": {
      // Three rounded points over a band with jewels, centred and resting on the head or hair (crownBase).
      const b = crownBase(look);
      return (
        <g transform={`translate(0 ${b})`}>
          <path d="M13.6-1.5L13-7.6l3.8 3L20-8.6l3.2 4 3.8-3-.6 6.1z" fill="#f0b429" stroke="#f0b429" strokeWidth=".8" strokeLinejoin="round" />
          <circle cx="13" cy="-7.8" r="1.1" fill="#f0b429" /><circle cx="20" cy="-8.8" r="1.1" fill="#f0b429" /><circle cx="27" cy="-7.8" r="1.1" fill="#f0b429" />
          <rect x="13.2" y="-2.6" width="13.6" height="2.8" rx="1" fill="#d98a00" />
          <circle cx="16.4" cy="-1.2" r=".75" fill="#b82d5e" /><circle cx="20" cy="-1.2" r=".85" fill="#fff" /><circle cx="23.6" cy="-1.2" r=".75" fill="#b82d5e" />
        </g>
      );
    }
    case "magnifier": return (
      <>
        <circle cx="10" cy="26.5" r="4.5" fill="#ffffffaa" stroke={INK} strokeWidth="1.6" />
        <line x1="6.8" y1="29.7" x2="4.2" y2="32.6" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
      </>
    );
    default: return null;
  }
}

function Head({ look }: { look: AvatarLook }) {
  if (look.face === "person") return <circle cx="20" cy="21" r="11" fill="#f3c9a5" />;
  if (look.face === "critter") {
    return (
      <>
        <path d="M10.5 15l-2-9 8 4zM29.5 15l2-9-8 4z" fill="#fff" />
        <ellipse cx="20" cy="21" rx="12" ry="10.5" fill="#fff" />
        <ellipse cx="20" cy="23.3" rx="1.5" ry="1" fill={look.color} />
      </>
    );
  }
  return (
    <>
      {look.hair !== "bun" && look.hair !== "spiky" && look.accessory !== "crown" && <><line x1="20" y1="11" x2="20" y2="6" stroke="#fff" strokeWidth="2" /><circle cx="20" cy="5" r="2" fill="#fff" /></>}
      <rect x="9" y="11" width="22" height="19" rx="8" fill="#fff" />
    </>
  );
}

function Eyes({ mood, ink }: { mood: AvatarMood; ink: string }) {
  const st = { stroke: ink, fill: "none", strokeLinecap: "round" as const };
  if (mood === "done") return <path d="M13.6 20.8q2.4-3.2 4.8 0M21.6 20.8q2.4-3.2 4.8 0" strokeWidth="1.8" {...st} />;
  if (mood === "failed") return <path d="M14.4 18.4l3.2 3.2m0-3.2l-3.2 3.2M22.4 18.4l3.2 3.2m0-3.2l-3.2 3.2" strokeWidth="1.6" {...st} />;
  return <><circle cx="16" cy="20" r="2.3" fill={ink} /><circle cx="24" cy="20" r="2.3" fill={ink} /></>;
}

const markText = (t: string) => <text x="32" y="35.8" fontSize="11" fontWeight="700" textAnchor="middle" fill="#fff" fontFamily="sans-serif">{t}</text>;
const RING = <circle cx="32" cy="32" r="7.5" fill="#fff" stroke="#e2dfd6" />;

/** The corner mark that says the mood at a glance (none for idle). */
function Mark({ mood }: { mood: AvatarMood }) {
  switch (mood) {
    case "thinking": return <>{RING}<circle className="d1" cx="28.6" cy="32" r="1.3" fill="#6b6862" /><circle className="d2" cx="32" cy="32" r="1.3" fill="#6b6862" /><circle className="d3" cx="35.4" cy="32" r="1.3" fill="#6b6862" /></>;
    case "working": return <>{RING}<circle className="bd" cx="32" cy="32" r="3.8" fill="none" stroke="#b0502f" strokeWidth="1.9" strokeDasharray="15 9" strokeLinecap="round" /></>;
    case "waiting": return <g className="bd"><circle cx="32" cy="32" r="7.5" fill="#d98a00" />{markText("?")}</g>;
    case "done": return <><circle cx="32" cy="32" r="7.5" fill="#2a7046" /><path d="M28.4 32.2l2.5 2.5 4.6-5" stroke="#fff" strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" /></>;
    case "failed": return <><circle cx="32" cy="32" r="7.5" fill="#b3261e" />{markText("!")}</>;
    default: return null;
  }
}

export interface AvatarFaceProps {
  /** The parts to draw (avatarFor / useAvatar give it for a name). */
  look: AvatarLook;
  mood?: AvatarMood;
  /** Square, in px. Below 24 the corner mark is left out; below 32 the moves are a little bigger (.small). */
  size?: number;
  className?: string;
}

/** One avatar face. Decorative: put the state in words next to it. */
export function AvatarFace({ look: raw, mood = "idle", size = 40, className }: AvatarFaceProps) {
  // A look from anywhere (an old cache, a hand-made object) still draws: unknown parts fall back to the defaults.
  const look: AvatarLook = { ...avatarFor("claude"), ...cleanAvatarLook(raw) };
  const ink = look.face === "person" ? INK : look.color;
  return (
    <svg className={`av ${mood}${size < 32 ? " small" : ""}${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <circle cx="20" cy="20" r="20" fill={look.color} />
      <g className="head">
        <Head look={look} />
        <g fill={look.hairColor}><Hair hair={look.hair} color={look.hairColor} /></g>
        <g className="eyes"><Eyes mood={mood} ink={ink} /></g>
        <path d={MOUTH[mood] ?? MOUTH.idle} strokeWidth="1.8" stroke={ink} fill="none" strokeLinecap="round" />
        <Accessory look={look} />
      </g>
      {size >= 24 && <Mark mood={mood} />}
    </svg>
  );
}

// ---- Saved choices: one copy for the page, loaded once, updated on save ----

let saved: SavedAvatars | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const publish = (next: SavedAvatars) => {
  saved = next;
  for (const f of listeners) f();
};

/** Loads the saved choices (once per page; again with force). Failure leaves the defaults showing. */
export function loadAvatars(force = false): Promise<void> {
  if (!loading || force) {
    loading = req<SavedAvatars>("GET", "/api/avatars").then((v) => publish(v && typeof v === "object" ? v : {}), () => {
      loading = null;
    });
  }
  return loading;
}

/** Saves the user's choice for "claude", "you" or a teammate (every board). Returns the look as stored. */
export async function saveAvatar(who: AvatarWho, look: Partial<AvatarLook>): Promise<SavedAvatars> {
  const next = await req<SavedAvatars>("PUT", `/api/avatars/${encodeURIComponent(avatarKey(who))}`, look);
  publish(next);
  return next;
}

/** Saves the name shown in place of "Claude" (every board); "" goes back to "Claude". Returns the choices as stored. */
export async function saveClaudeName(name: string): Promise<SavedAvatars> {
  const next = await req<SavedAvatars>("PUT", "/api/avatars/claude/name", { name });
  publish(next);
  return next;
}

/** Drops the saved choice: the default look comes back (Claude's name stays). */
export async function resetAvatar(who: AvatarWho): Promise<SavedAvatars> {
  const next = await req<SavedAvatars>("DELETE", `/api/avatars/${encodeURIComponent(avatarKey(who))}`);
  publish(next);
  return next;
}

/** Every saved choice (empty until loaded); re-renders when one is saved. */
export function useSavedAvatars(): SavedAvatars {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    void loadAvatars();
    return () => void listeners.delete(f);
  }, []);
  return saved ?? {};
}

/** The look to draw for "claude", "you", a teammate name or handle, or a huddle participant. */
export function useAvatar(who: AvatarWho): AvatarLook {
  return avatarFor(who, useSavedAvatars());
}

/** The name the board shows for Claude (the user's choice, else "Claude"); re-renders when it is saved. */
export function useClaudeName(): string {
  return claudeName(useSavedAvatars());
}
