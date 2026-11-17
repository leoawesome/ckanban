// Telegram's pure text rules as rust/board/tests/fixtures/telegram.json records them: `answer(case)` runs one case on
// Bun's code and gives its answer as JSON text. Run as a script it reads the cases on stdin and prints the answers, so
// the caller picks the time zone (TZ) the day rules run in.
import { dayEnded, dayTitle, deskPaused, FrontDesk, heldKind } from "../../src/helper/frontdesk";
import { forwardedFrom, isLock, maskToken, scrub, telegramText } from "../../src/helper/telegram";
import { formMessage, questionText, rowsOf } from "../../src/helper/tgforms";
import { cutTail, reportParts } from "../../src/helper/tgreply";

const j = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v));

export function answer(c: { fn: string; args: any[] }): string {
  const a = c.args;
  try {
    switch (c.fn) {
      case "scrub": return j(scrub(a[0], a[1]));
      case "maskToken": return j(maskToken(a[0]));
      case "telegramText": return j(telegramText(a[0], a[1]));
      case "isLock": return j(isLock(a[0]));
      case "forwardedFrom": return j(forwardedFrom(a[0]));
      case "reportParts": return j(reportParts(a[0], a[1], a[2], a[3], a[4]));
      case "cutTail": return j(cutTail(a[0]));
      case "rowsOf": return j(rowsOf(a[0]));
      case "questionText": return j(questionText(a[0], a[1], a[2]));
      case "formMessage": return j(formMessage(a[0]));
      case "heldKind": return j(heldKind(a[0], a[1], a[2]));
      case "dayTitle": return j(dayTitle(a[0]));
      case "dayEnded": return j(dayEnded(a[0], a[1], a[2]));
      case "deskPaused": return j(deskPaused(a[0]));
      case "briefing": return j(FrontDesk.briefing(a[0]));
      default: return j({ error: `unknown fn ${c.fn}` });
    }
  } catch (e) {
    return j({ threw: (e as Error).message });
  }
}

if (import.meta.main) {
  const cases = JSON.parse(await Bun.stdin.text());
  console.log(JSON.stringify(cases.map(answer)));
}
