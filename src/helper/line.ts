// One line of "What the helper knows about you": how it is folded and checked. Shared by the helper's settings, the
// chat's suggestion card (session.ts) and propose_helper_rule (mcp-server.ts), without pulling in the store.

export const FEEDBACK_MAX = 300;

/** A helper line as the helper saves it: spaces folded, trimmed. */
export const helperLineText = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/**
 * Characters a card can't show but the helper's model still reads: format characters (zero-width, bidi controls, Unicode
 * tags U+E0000-E007F), default-ignorable and blank fillers (Hangul fillers, braille blank), other controls, private-use and unassigned code points, and variation selectors (which can
 * carry hidden bytes). A suggested line with any of them is refused, so the line saved is the line the user saw.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{2800}]/u;
export const hasHiddenChars = (text: string): boolean => HIDDEN.test(text);

/** Why a suggested line can't be shown on a card, or null when it can. */
export function suggestedLineError(text: string): string | null {
  if (!text) return "text is required: the exact line to add.";
  if (text.length > FEEDBACK_MAX) return `text is too long (${text.length} characters, max ${FEEDBACK_MAX})`;
  if (hasHiddenChars(text)) return "text has invisible or control characters the user wouldn't see on the card; use plain visible text only";
  return null;
}
