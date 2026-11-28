/**
 * Finding a file that was asked for by name (a form option's Preview, a file link in the chat) in the ticket's outputs
 * folder. No React, so it can be unit tested.
 */

/** Where the board keeps a questions form's mockups, inside the outputs folder. */
const MOCKUPS = "mockups/";

/**
 * The outputs file `asked` means, or null when there is none. The exact path first; a mockup also matches the same
 * name at the outputs root ("mockups/a.html" -> "a.html"), and a bare name also matches it inside mockups/
 * ("a.html" -> "mockups/a.html"). Never another file: a missing one is reported, not swapped.
 */
export function findOutput(names: ReadonlySet<string>, asked: string): string | null {
  const tries = [asked];
  if (asked.startsWith(MOCKUPS)) tries.push(asked.slice(MOCKUPS.length));
  else if (!asked.includes("/")) tries.push(MOCKUPS + asked);
  return tries.find((n) => names.has(n)) ?? null;
}
