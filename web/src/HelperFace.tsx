// A huddle participant's face: a small robot (round coloured head, white face plate, eyes, smile, antenna) with its
// role's badge in the corner. One place draws it, so the huddle chat, People pane, session view, header stack and the
// Huddles list all match. The user (@you) gets a person: no antenna, a fringe of hair.
import { faceLook } from "./huddleText";

export interface FacePerson { handle: string; role?: string | null; preset?: string | null; kind?: string | null }

/** One face, `size` px square. Badges show from 24px up (smaller, they are a speck). */
export function HelperFace({ p, size = 20, className }: { p: FacePerson; size?: number; className?: string }) {
  const { color: c, badge, you } = faceLook(p);
  const showBadge = !!badge && size >= 24;
  return (
    <svg className={`helper-face${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 40 40" aria-hidden focusable="false">
      <circle cx="20" cy="20" r="20" fill={c} />
      {you ? (
        <>
          <rect x="9" y="12" width="22" height="19" rx="9" fill="#fff" opacity=".95" />
          <path d="M9 19q2-9 11-9t11 9q-5-5-11-4.5T9 19z" fill="#5a3a24" />
        </>
      ) : (
        <>
          <rect x="9" y="11" width="22" height="19" rx="8" fill="#fff" opacity=".95" />
          <line x1="20" y1="11" x2="20" y2="6" stroke="#fff" strokeWidth="2" />
          <circle cx="20" cy="5" r="2" fill="#fff" />
        </>
      )}
      <circle cx="16" cy="20" r="2.4" fill={c} />
      <circle cx="24" cy="20" r="2.4" fill={c} />
      <path d="M16 25.5q4 3 8 0" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round" />
      {showBadge && (
        <>
          <circle cx="31" cy="31" r="8" fill="#fff" />
          <text x="31" y="35" fontSize="10.5" textAnchor="middle">{badge}</text>
        </>
      )}
    </svg>
  );
}

/** Up to `max` overlapping faces, then "+N" for the rest. */
export function FaceStack({ people, max = 4, size = 20 }: { people: FacePerson[]; max?: number; size?: number }) {
  if (!people.length) return null;
  const rest = people.length - max;
  return (
    <span className="face-stack" title={people.map((p) => `@${p.handle}`).join(", ")} aria-label={`${people.length} ${people.length === 1 ? "helper" : "helpers"}`}>
      {people.slice(0, max).map((p) => <HelperFace key={p.handle} p={p} size={size} />)}
      {rest > 0 && <span className="face-more">+{rest}</span>}
    </span>
  );
}
