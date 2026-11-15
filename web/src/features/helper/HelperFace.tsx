// A huddle participant's face: their avatar (AvatarFace.tsx, the user's saved choice or the default for the role) with
// a mood. One place draws it, so the huddle chat, People pane, session view, header stack and the Huddles list all
// match. The user (@you) keeps a person face.
import { AvatarFace, useAvatar } from "./AvatarFace";
import type { AvatarMood } from "./avatarLook";
import { participantMood } from "./avatarMood";

export interface FacePerson {
  handle: string; role?: string | null; preset?: string | null; kind?: string | null;
  /** A huddle participant's state, for FaceStack's moods. */
  status?: string | null; lastActivity?: string | null; error?: string | null;
}

/** One face, `size` px square. Corner marks show from 24px up (smaller, they are a speck). */
export function HelperFace({ p, size = 20, mood = "idle", className }: { p: FacePerson; size?: number; mood?: AvatarMood; className?: string }) {
  const look = useAvatar(p);
  return <AvatarFace look={look} mood={mood} size={size} className={`helper-face${className ? ` ${className}` : ""}`} />;
}

/** Up to `max` overlapping faces, then "+N" for the rest; each with its own mood (idle once the huddle is closed). */
export function FaceStack({ people, max = 4, size = 20, closed = false }: { people: FacePerson[]; max?: number; size?: number; closed?: boolean }) {
  if (!people.length) return null;
  const rest = people.length - max;
  return (
    <span className="face-stack" title={people.map((p) => `@${p.handle}`).join(", ")} aria-label={`${people.length} ${people.length === 1 ? "helper" : "helpers"}`}>
      {people.slice(0, max).map((p) => <HelperFace key={p.handle} p={p} size={size} mood={closed ? "idle" : participantMood(p)} />)}
      {rest > 0 && <span className="face-more">+{rest}</span>}
    </span>
  );
}
