// An animated face for Claude, the user or a teammate: drawn from its parts (avatarLook.ts) and a mood, at any size.
// Inline SVG with CSS motion (.av in styles.css: transform and opacity only, still under prefers-reduced-motion).
// Decorative (aria-hidden): callers say the state in words next to it. useAvatar gives the look to draw for a name,
// the user's saved choice (shared by every board) or the default.
import { useEffect, useId, useState } from "react";
import { req } from "./api";
import {
  avatarFor, avatarKey, claudeName, cleanAvatarLook, COVERING_HATS, crownBase, DARK_INK_FACES, hairCut, shownHair, showsAntenna,
  type AvatarLook, type AvatarMood, type AvatarWho, type SavedAvatars,
} from "./avatarLook";

const INK = "#2b2622";
const HAIR_BASE = "M9 19q1-10 11-10t11 10q-5-5-11-4.5T9 19z";
/** Spiky hair: five rounded spikes along the top of the head, a fringe curve underneath (x 10.6 to 29.4). */
const SPIKY = "M10.6 16.8l.5-6.6 2.4 1.4L15 7.2l2.6 3L20 5.6l2.4 4.6L25 7.2l1.5 4.4 2.4-1.4.5 6.6q-4-3.2-9.4-2.9T10.6 16.8z";
const MOUTH: Record<AvatarMood, string> = {
  idle: "M16 25.5q4 3 8 0", thinking: "M18 26.3h4", working: "M17 26h6", waiting: "M16 25.5q4 3 8 0", done: "M15 24.5q5 5 10 0", failed: "M16 27.5q4-3 8 0",
};

/** Long hair: a cap over the top and curtains down both sides of the face, to the chin. */
const LONG = "M8.6 30.5Q6.6 18 10 12.8Q14 8.6 20 8.6t10 4.2q3.4 5.2 1.4 17.7q-1.6 1-3-.6q.9-8-1.2-12.6Q24 14.6 20 14.8t-7.2 2.4q-2.1 4.6-1.2 12.6q-1.4 1.6-3 .7z";
/** Curly hair: a cloud of curls along the top and down the sides (top at y 5). */
const CURLS: [number, number, number][] = [[10.6, 19.6, 2.6], [29.4, 19.6, 2.6], [10.4, 15.2, 3], [29.6, 15.2, 3], [12.8, 10.8, 3.3], [27.2, 10.8, 3.3], [17, 8.4, 3.4], [23, 8.4, 3.4], [20, 9.6, 3]];
/** Mohawk: a fin of four rounded points along the middle of the head, standing up from it. */
const MOHAWK = "M16.9 14Q15.9 8.4 17.6 4.6l1.4 2.2L20 2.6l1.1 4.2 1.4-2.2q1.7 3.8.6 9.4z";
/** Fringe: a bob with straight-cut bangs over the forehead. */
const FRINGE = "M8.8 20Q8 9 20 8.8T31.2 20h-1.7q-.2-3.6-1.3-4.4h-16.4q-1.1.8-1.3 4.4z";

function Hair({ hair, color }: { hair: AvatarLook["hair"]; color: string }) {
  switch (hair) {
    case "short": return <path d={HAIR_BASE} />;
    case "ponytail": return <><path d={HAIR_BASE} /><path d="M29 12q8 1 6 13q-1 3-3 1q2-6-4-9z" /></>;
    case "bun": return <><circle cx="20" cy="7.5" r="4" /><path d={HAIR_BASE} /></>;
    // A tuft of five even spikes on the crown of the head, inside its width; the round stroke softens the tips.
    case "spiky": return <path d={SPIKY} stroke={color} strokeWidth="1.6" strokeLinejoin="round" />;
    case "long": return <path d={LONG} />;
    case "curly": return <>{CURLS.map(([x, y, r]) => <circle key={`${x},${y}`} cx={x} cy={y} r={r} />)}</>;
    case "mohawk": return <path d={MOHAWK} stroke={color} strokeWidth="1.2" strokeLinejoin="round" />;
    // Two bunches low on the sides, tied with a yellow band.
    case "pigtails": return (
      <>
        <path d={HAIR_BASE} />
        <path d="M9.6 15.6q-5.4.4-5.6 6.6q.2 4.6 2.6 5.8q-.6-5 3.4-8.6zM30.4 15.6q5.4.4 5.6 6.6q-.2 4.6-2.6 5.8q.6-5-3.4-8.6z" />
        <circle cx="9.2" cy="16.4" r="1.5" fill="#f0b429" /><circle cx="30.8" cy="16.4" r="1.5" fill="#f0b429" />
      </>
    );
    case "fringe": return <path d={FRINGE} />;
    default: return null;
  }
}

function Hat({ look }: { look: AvatarLook }) {
  switch (look.hat) {
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
    case "bow": return <><path d="M13 10l-5-3.5v7zM13 10l5-3.5v7z" fill="#e0457b" /><circle cx="13" cy="10" r="1.7" fill="#b82d5e" /></>;
    // A cap seen from the front: a dome with seams and a button, the peak curving over the forehead.
    case "cap": return (
      <>
        <path d="M10.2 13.4Q10 5.2 20 5.2t9.8 8.2z" fill="#e8553d" />
        <path d="M20 5.6v7.6M15 6.6q-1.6 2.6-1.6 6.6M25 6.6q1.6 2.6 1.6 6.6" stroke="#b83a26" strokeWidth=".7" fill="none" />
        <circle cx="20" cy="5.4" r="1.1" fill="#b83a26" />
        <path d="M8.6 13.4Q20 10.8 31.4 13.4q.6 2.4-1.6 2.4Q20 13.6 10.2 15.8q-2.2 0-1.6-2.4z" fill="#b83a26" />
      </>
    );
    // A knitted beanie: dome, ribbed cuff, pompom.
    case "beanie": return (
      <>
        <path d="M10.4 12.4Q10.2 4.6 20 4.6t9.6 7.8z" fill="#2f9e8f" />
        <circle cx="20" cy="4.2" r="2.5" fill="#f3efe6" />
        <rect x="9.2" y="11.2" width="21.6" height="4.2" rx="1.9" fill="#227a6e" />
        <path d="M12.6 11.8v3M15.8 11.8v3M19 11.8v3M22.2 11.8v3M25.4 11.8v3M28.2 12v2.6" stroke="#1a5e55" strokeWidth=".8" strokeLinecap="round" />
      </>
    );
    // A tall pointed wizard hat with a star, leaning a little, on a wide brim.
    case "wizard": return (
      <>
        <path d="M11.6 13Q16 7 22.4 1.4q1 .2.6 1.2Q24.6 8 28.4 13z" fill="#4b3fa8" />
        <path d="M18.4 8.2l.5 1.2 1.3.1-1 .8.3 1.3-1.1-.7-1.1.7.3-1.3-1-.8 1.3-.1zM24.2 10.6a1 1 0 1 0 .9-1.6a1.4 1.4 0 1 1-.9 1.6z" fill="#f0b429" />
        <ellipse cx="20" cy="13.2" rx="12" ry="2" fill="#382e85" />
      </>
    );
    // A small striped party cone with a pompom, tilted, resting on the head or hair like the crown.
    case "party": {
      const b = crownBase(look);
      return (
        <g transform={`translate(20 ${b}) rotate(10)`}>
          <path d="M-5.2-.4L0-8 5.2-.4q-5.2 1.6-10.4 0z" fill="#e0457b" />
          <path d="M-3.6-2.8l1.8 2.2M-1.8-5.4l3.6 4.4M.6-7l2.4 3" stroke="#f0b429" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="0" cy="-8.2" r="1.5" fill="#f0b429" />
        </g>
      );
    }
    // A black top hat with a coloured band on a wide brim.
    case "tophat": return (
      <>
        <rect x="13" y="2.6" width="14" height="10.2" rx="1" fill="#2b2622" />
        <rect x="13" y="9" width="14" height="2.2" fill="#b82d5e" />
        <ellipse cx="20" cy="12.8" rx="11.6" ry="1.9" fill="#2b2622" />
        <path d="M14.4 3.8v4.4" stroke="#ffffff40" strokeWidth="1" strokeLinecap="round" />
      </>
    );
    default: return null;
  }
}

function Accessory({ look }: { look: AvatarLook }) {
  switch (look.accessory) {
    case "glasses": return <g fill="none" stroke={INK} strokeWidth="1.4"><circle cx="15.5" cy="20" r="4" /><circle cx="24.5" cy="20" r="4" /></g>;
    case "headset": return (
      <>
        <path d="M8 21q0-12 12-12t12 12" fill="none" stroke={INK} strokeWidth="2" />
        <rect x="5.5" y="19" width="4.5" height="7.5" rx="2" fill={INK} />
        <rect x="30" y="19" width="4.5" height="7.5" rx="2" fill={INK} />
      </>
    );
    case "magnifier": return (
      <>
        <circle cx="10" cy="26.5" r="4.5" fill="#ffffffaa" stroke={INK} strokeWidth="1.6" />
        <line x1="6.8" y1="29.7" x2="4.2" y2="32.6" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
      </>
    );
    // Dark rounded lenses with a bridge and a little shine.
    case "sunglasses": return (
      <>
        <path d="M10.6 17.6h7.8q.4 5-3.8 5.2q-4.4-.2-4-5.2zM21.6 17.6h7.8q.4 5-4 5.2q-4.2-.2-3.8-5.2z" fill="#1d1a17" stroke="#1d1a17" strokeWidth=".8" strokeLinejoin="round" />
        <path d="M18.4 18.2q1.6-.9 3.2 0" stroke="#1d1a17" strokeWidth="1.2" fill="none" />
        <path d="M12.4 18.8l1.6 1.6M23.4 18.8l1.6 1.6" stroke="#ffffff66" strokeWidth=".9" strokeLinecap="round" />
      </>
    );
    // A bow tie under the chin.
    case "bowtie": return (
      <>
        <path d="M20 32.6l-5.2-2.8v5.6zM20 32.6l5.2-2.8v5.6z" fill="#b82d5e" />
        <rect x="18.4" y="31.1" width="3.2" height="3" rx="1" fill="#8c1f45" />
      </>
    );
    // A striped scarf round the neck, one end hanging down on the left.
    case "scarf": return (
      <>
        <path d="M11.4 29q8.6 4.6 17.2 0l.8 3.2q-9.4 4.6-18.8 0z" fill="#d64545" />
        <path d="M12.4 31.6l3 5.6q-1.4 1-3 .8l-2-5.4z" fill="#d64545" />
        <path d="M15.8 31.2l.8 3M20 31.8v3.2M24.2 31.2l-.8 3M11.6 34.6l2.2-.6" stroke="#f3efe6" strokeWidth="1" strokeLinecap="round" />
      </>
    );
    // A flower tucked over the right ear (on the hat band when a hat is worn).
    case "flower": {
      const y = COVERING_HATS.has(look.hat) ? 12.6 : 14.4;
      return (
        <g transform={`translate(29.2 ${y})`}>
          {[0, 72, 144, 216, 288].map((a) => <ellipse key={a} cx="0" cy="-2" rx="1.6" ry="2" fill="#ff8fbd" transform={`rotate(${a})`} />)}
          <circle r="1.3" fill="#f0b429" />
        </g>
      );
    }
    // A patch over the right eye, its strap running across the forehead.
    case "eyepatch": return (
      <>
        <path d="M10 13.4L31.2 23.4" stroke={INK} strokeWidth="1.1" />
        <path d="M20.4 17.6q4-1.4 7.4.6q.6 4.6-3.6 5q-4.2-.2-3.8-5.6z" fill={INK} />
      </>
    );
    default: return null;
  }
}

/** The ghost's sheet: a dome with a scalloped hem. */
const GHOST = "M9.4 31.2V19.6Q9.4 9 20 9t10.6 10.6v11.6" + "q-1.33 1.7-2.65 0".repeat(8) + "z";
/** The alien's head: wide at the top, narrowing to the chin. */
const ALIEN = "M20 9C27.6 9 32 13.2 32 19c0 6.6-6 12-12 12S8 25.6 8 19C8 13.2 12.4 9 20 9z";

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
  // A cat: pointed ears with pink insides, a pink nose and whiskers (the critter has plain ears and a nose in its colour).
  if (look.face === "cat") {
    return (
      <>
        <path d="M10 16.4L9.2 5.8l8.2 4.8zM30 16.4l.8-10.6-8.2 4.8z" fill="#fff" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M11 13.6l-.5-5.4 4.4 2.8zM29 13.6l.5-5.4-4.4 2.8z" fill="#ffb3c7" />
        <ellipse cx="20" cy="21" rx="11.6" ry="10.4" fill="#fff" />
        <path d="M18.9 23h2.2l-1.1 1.2z" fill="#ff8fab" stroke="#ff8fab" strokeWidth=".9" strokeLinejoin="round" />
        <path d="M6.6 22.6l5.4 1M6.8 26.2l5.2-.9M33.4 22.6l-5.4 1M33.2 26.2l-5.2-.9" stroke={INK} strokeOpacity=".35" strokeWidth=".7" strokeLinecap="round" />
      </>
    );
  }
  // A bear: round ears, a light muzzle round the mouth, a dark nose.
  if (look.face === "bear") {
    return (
      <>
        <circle cx="11" cy="12.4" r="4.2" fill="#c08a5c" /><circle cx="29" cy="12.4" r="4.2" fill="#c08a5c" />
        <circle cx="11" cy="12.4" r="2.2" fill="#e8c39c" /><circle cx="29" cy="12.4" r="2.2" fill="#e8c39c" />
        <circle cx="20" cy="21" r="11" fill="#c08a5c" />
        <ellipse cx="20" cy="25.4" rx="6" ry="4.6" fill="#f0dcc2" />
        <ellipse cx="20" cy="22.5" rx="1.9" ry="1.25" fill={INK} />
      </>
    );
  }
  // An alien: a green head, wide on top, with two antennae (hidden under hats and tall hair, like the robot's).
  if (look.face === "alien") {
    return (
      <>
        {showsAntenna(look) && (
          <>
            <path d="M15.4 10.6L12.6 5.4M24.6 10.6l2.8-5.2" stroke="#7cc45a" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="12.4" cy="5" r="1.8" fill="#c6f08a" /><circle cx="27.6" cy="5" r="1.8" fill="#c6f08a" />
          </>
        )}
        <path d={ALIEN} fill="#9bd86f" />
      </>
    );
  }
  // A ghost: a white sheet with a wavy hem (no hair shows on it).
  if (look.face === "ghost") return <path d={GHOST} fill="#fff" />;
  return (
    <>
      {showsAntenna(look) && <><line x1="20" y1="11" x2="20" y2="6" stroke="#fff" strokeWidth="2" /><circle cx="20" cy="5" r="2" fill="#fff" /></>}
      <rect x="9" y="11" width="22" height="19" rx="8" fill="#fff" />
    </>
  );
}

/** One eye in a style, open (idle, thinking, working, waiting: the moves come from .av in styles.css). */
function OpenEye({ x, style, ink }: { x: number; style: AvatarLook["eyes"]; ink: string }) {
  const side = x < 20 ? -1 : 1;
  switch (style) {
    case "round": return <><circle cx={x} cy="20" r="2.8" fill={ink} /><circle cx={x + 0.9} cy="19.1" r=".95" fill="#fff" /></>;
    case "big": return <><circle cx={x} cy="20" r="3.5" fill={ink} /><circle cx={x + 1.1} cy="18.8" r="1.3" fill="#fff" /><circle cx={x - 1.2} cy="21.3" r=".6" fill="#fff" /></>;
    // Half closed: the lower half of the eye under a heavy lid.
    case "sleepy": return <path d={`M${x - 2.5} 20.4a2.5 2.1 0 0 0 5 0z`} fill={ink} stroke={ink} strokeWidth=".9" strokeLinejoin="round" />;
    case "lashes": return (
      <>
        <circle cx={x} cy="20" r="2.3" fill={ink} />
        <path d={`M${x + side * 1.7} 18.3l${side * 1.3}-1.3M${x + side * 0.5} 17.8l${side * 0.5}-1.6`} stroke={ink} strokeWidth=".9" strokeLinecap="round" />
      </>
    );
    default: return <circle cx={x} cy="20" r="2.3" fill={ink} />;
  }
}

/** The eyes: done (happy closed) and failed (crossed) are the same for every style, so the mood always reads. */
function Eyes({ mood, ink, style }: { mood: AvatarMood; ink: string; style: AvatarLook["eyes"] }) {
  const st = { stroke: ink, fill: "none", strokeLinecap: "round" as const };
  if (mood === "done") return <path d={`M13.6 20.8q2.4-3.2 4.8 0M21.6 20.8q2.4-3.2 4.8 0${style === "lashes" ? "M13.6 20.8l-1.3-.9M26.4 20.8l1.3-.9" : ""}`} strokeWidth="1.8" {...st} />;
  if (mood === "failed") return <path d="M14.4 18.4l3.2 3.2m0-3.2l-3.2 3.2M22.4 18.4l3.2 3.2m0-3.2l-3.2 3.2" strokeWidth="1.6" {...st} />;
  if (style === "dots") return <><circle cx="16" cy="20" r="2.3" fill={ink} /><circle cx="24" cy="20" r="2.3" fill={ink} /></>;
  return <><OpenEye x={16} style={style} ink={ink} /><OpenEye x={24} style={style} ink={ink} /></>;
}

/** Cheeks and facial hair: drawn under the mouth, which always stays on top and uncovered (a beard leaves room round it). */
function Detail({ look }: { look: AvatarLook }) {
  switch (look.detail) {
    case "blush": return <g fill="#ff6f91" opacity=".5"><ellipse cx="12.3" cy="24.3" rx="2.3" ry="1.4" /><ellipse cx="27.7" cy="24.3" rx="2.3" ry="1.4" /></g>;
    case "freckles": return (
      <g fill="#a0522d" opacity=".75">
        {[[11.6, 23.2], [13.5, 23.7], [12.2, 25.1], [28.4, 23.2], [26.5, 23.7], [27.8, 25.1]].map(([x, y]) => <circle key={x} cx={x} cy={y} r=".6" />)}
      </g>
    );
    // A curled moustache between the nose and the mouth.
    case "moustache": return <path d="M20 22.9q-1.7-1.3-3.8-.9q-2 .4-3.3 1.9q2 .5 3.8-.1q2.1-.5 3.3-.9zM20 22.9q1.7-1.3 3.8-.9q2 .4 3.3 1.9q-2 .5-3.8-.1q-2.1-.5-3.3-.9z" fill={look.hairColor} />;
    // A beard along the jaw and round the chin, with an opening that leaves the mouth's shape clear in every mood.
    case "beard": return (
      <path fillRule="evenodd" fill={look.hairColor}
        d="M9.6 21.2Q9.4 33.2 20 33.4T30.4 21.2Q29.4 23.6 27 24.6Q24.6 22.4 20 22.4T13 24.6Q10.6 23.6 9.6 21.2zM13.6 25.9a6.4 3.5 0 1 0 12.8 0a6.4 3.5 0 1 0-12.8 0z" />
    );
    default: return null;
  }
}

/** Mixes a #rrggbb colour toward white (t > 0) or black (t < 0). */
const tone = (hex: string, t: number): string => {
  const n = parseInt(hex.slice(1), 16), to = t > 0 ? 255 : 0, a = Math.abs(t);
  return "#" + [16, 8, 0].map((sh) => Math.round(((n >> sh) & 255) * (1 - a) + to * a).toString(16).padStart(2, "0")).join("");
};
/** A four-pointed sparkle centred on x, y. */
const sparkle = (x: number, y: number, r: number) => `M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}z`;
const STARS: [number, number, number][] = [[6.6, 9.4, 2], [33.4, 9.8, 1.6], [4.4, 23.6, 1.4], [35.6, 21.4, 1.8], [9.6, 34, 1.6], [20, 3, 1.2], [27, 36.6, 1.2]];

/** The round background: plain in the avatar's colour, or a quiet pattern in tones of it (never animated). */
function Background({ look, plain, id }: { look: AvatarLook; plain: boolean; id: string }) {
  // The id is this face's own (useId): a shared one would resolve to the first copy on the page, which may sit in a
  // hidden panel and then draws nothing.
  const base = <circle cx="20" cy="20" r="20" fill={look.color} />;
  if (plain || look.background === "plain") return base;
  if (look.background === "fade") {
    return (
      <>
        <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={tone(look.color, 0.3)} /><stop offset="1" stopColor={tone(look.color, -0.22)} /></linearGradient></defs>
        {base}
        <circle cx="20" cy="20" r="20" fill={`url(#${id})`} />
      </>
    );
  }
  if (look.background === "stars") return <>{base}<path d={STARS.map(([x, y, r]) => sparkle(x, y, r)).join("")} fill="#fff" fillOpacity=".6" /></>;
  return (
    <>
      <defs>
        {look.background === "stripes"
          ? <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(40)"><rect width="3" height="6" fill="#fff" fillOpacity=".14" /></pattern>
          : <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1" fill="#fff" fillOpacity=".2" /><circle cx="4.5" cy="4.5" r="1" fill="#fff" fillOpacity=".2" /></pattern>}
      </defs>
      {base}
      <circle cx="20" cy="20" r="20" fill={`url(#${id})`} />
    </>
  );
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
  const ink = DARK_INK_FACES.has(look.face) ? INK : look.color;
  const cut = hairCut(look);
  const clip = `avc${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg className={`av ${mood}${size < 32 ? " small" : ""}${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <Background look={look} plain={size < 24} id={`${clip}bg`} />
      <g className="head">
        <Head look={look} />
        {cut !== null && <clipPath id={clip}><rect x="0" y={cut} width="40" height={40 - cut} /></clipPath>}
        <g fill={look.hairColor} clipPath={cut !== null ? `url(#${clip})` : undefined}><Hair hair={shownHair(look)} color={look.hairColor} /></g>
        <g className="eyes"><Eyes mood={mood} ink={ink} style={look.eyes} /></g>
        <Detail look={look} />
        <path d={MOUTH[mood] ?? MOUTH.idle} strokeWidth="1.8" stroke={ink} fill="none" strokeLinecap="round" />
        {/* Face things first, then the hat over them (a headset band or eye patch strap goes under a hat); a flower
            goes on top, so with a hat it sits on the band. */}
        {look.accessory !== "flower" && <Accessory look={look} />}
        <Hat look={look} />
        {look.accessory === "flower" && <Accessory look={look} />}
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
