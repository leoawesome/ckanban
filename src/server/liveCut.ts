/**
 * The live copy of a run's raw events (the `activity` event every open tab gets) carries no long strings: a tool
 * result can be hundreds of KB (a file read, a long log, an image), and every tab would get all of it for every
 * running ticket, although the page only looks at the event's type. The stored log keeps everything, and the tool
 * detail route serves a call's full output when its row is opened.
 */
export const LIVE_STRING_MAX = 2000;

/**
 * JSON of `value` with every string longer than `max` cut to its first `max` characters and a note of how much was
 * left out. `mask` hides saved keys in a string before it is cut, so a cut can't leave half a key unmasked.
 */
export function liveJson(value: unknown, mask: (s: string) => string, max = LIVE_STRING_MAX): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v !== "string" || v.length <= max) return v;
    const m = mask(v);
    return m.length <= max ? m : `${m.slice(0, max)}… (${m.length - max} more characters, not sent live)`;
  });
}
