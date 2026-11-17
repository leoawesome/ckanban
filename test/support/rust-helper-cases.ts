// The helper's pure rules as rust/board/tests/fixtures/helper.json records them: `answer(case)` runs one case on
// Bun's code and gives its answer as JSON text. Run as a script (`bun test/support/rust-helper-cases.ts`) it reads
// the cases on stdin and prints the answers, so the caller can pick the time zone (TZ) the night rules run in.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clockTime, cut, directLabel, usageLimitLine } from "../../src/helper/core";
import { channelFor, checkDecision, DECISION_SCHEMA, HELPER_SYSTEM, lastNightEnd, parseDecision, summaryAllowedAt, urgentRefusal } from "../../src/helper/decide";
import { MessageStore, nearOf, needsShown, needsYouIds, pageOf, rowLines, toRow, trimMessages } from "../../src/helper/messages";
import { headerValue, isNtfy, normalizeSettings } from "../../src/helper/notify";
import { maskToken } from "../../src/helper/telegram";
import { cutBytes, ntfyRequest, pushChannel, type OutMessage } from "../../src/helper/channels";

/** What the push channel hands the push service for a message (its payload), caught from a fake one. */
function pushChannelPayload(m: OutMessage): unknown {
  let got: unknown = null;
  const fake = { send: (p: unknown) => ((got = p), Promise.resolve({ sent: 1, removed: 0, onScreen: 0, error: null })) };
  void pushChannel({ fetch: fetch, push: fake as never }).send(m, {} as never);
  return got;
}
import { keptQuietLine, meetingTime, lookBeforeDigest, backoffMs } from "../../src/helper/runner-config";
import { reminderBody, reminderCount, stepChain, summaryLine } from "../../src/helper/runner-text";
import { hm, inNight, morningDigestAt, nightEnd } from "../../src/helper/settings";
import { buildSummary, collapseRuns, shortDate, titleStem, weekRecapLine, weekStart } from "../../src/helper/summary";
import { normalizeRecords, questionHash, recordForMessage, waitIdentity, WaitStore } from "../../src/helper/waits";

const j = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v));

/** A store script on a temp folder with a fixed clock: the file's text after each step (message ids numbered). */
function storeScript(kind: "waits" | "messages", steps: any[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "helper-fx-"));
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const out: string[] = [];
  const ids = new Map<string, string>();
  const named = (text: string) => text.replace(/m_[a-z0-9]+/g, (m) => {
    if (!ids.has(m)) ids.set(m, `m_${ids.size + 1}`);
    return ids.get(m)!;
  });
  try {
    const w = new WaitStore(dir, () => now);
    const m = new MessageStore(dir, () => now);
    const file = join(dir, `${kind}.json`);
    for (const s of steps) {
      now += s.advance ?? 0;
      const real = (id: string) => [...ids].find(([, v]) => v === id)?.[0] ?? id;
      switch (s.op) {
        case "add": w.add(s.w, s.o ?? {}); break;
        case "update": w.update(s.key, s.patch); break;
        case "markTold": w.markTold(s.keys, s.via, s.messageId ?? null); break;
        case "unclaim": w.unclaim(s.prev); break;
        case "stop": w.stopReminders(s.key, s.why); break;
        case "close": w.close(s.keys, s.why); break;
        case "opened": w.opened(s.board, s.ticketId); break;
        case "rekey": w.rekey(s.from, s.w); break;
        case "notifyUser": w.setNotifyUser(s.board, s.ticketId, now); break;
        case "first": w.firstSummaryPending = s.v; break;
        case "madd": m.add(s.m); break;
        case "msends": m.recordSends(real(s.id), s.sends); break;
        case "mtap": m.markTapped(real(s.id), s.how); break;
        case "mread": m.markRead(real(s.id)); break;
        case "mreadall": m.markAllRead(); break;
      }
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {}
      out.push(named(text));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

export function answer(c: { fn: string; args: any[] }): string {
  const a = c.args;
  try {
    switch (c.fn) {
      case "system": return j({ sha: createHash("sha256").update(HELPER_SYSTEM).digest("hex"), schema: JSON.stringify(DECISION_SCHEMA) });
      case "cut": return j(cut(a[0], a[1]));
      case "clockTime": return j(clockTime(a[0]));
      case "directLabel": return j(directLabel(a[0]));
      case "usageLimitLine": return j(usageLimitLine(a[0], a[1]));
      case "summaryLine": return j(summaryLine(a[0], a[1]));
      case "reminderCount": return j(reminderCount(a[0], a[1]));
      case "reminderBody": return j(reminderBody(a[0]));
      case "stepChain": return j(stepChain(a[0], a[1], a[2]));
      case "keptQuietLine": return j(keptQuietLine(a[0], a[1]));
      case "meetingTime": return j(meetingTime(a[0], a[1]));
      case "backoffMs": return j(backoffMs(a[0]));
      case "lookBeforeDigest": return j(lookBeforeDigest(a[0], a[1]));
      case "hm": return j(hm(a[0]));
      case "inNight": return j(inNight(a[0], a[1]));
      case "nightEnd": return j(nightEnd(a[0], a[1]));
      case "morningDigestAt": return j(morningDigestAt(a[0], a[1]));
      case "lastNightEnd": return j(lastNightEnd(a[0], a[1]));
      case "summaryAllowedAt": return j(summaryAllowedAt(a[0], a[1], a[2]));
      case "channelFor": return j(channelFor(a[0], a[1], a[2]));
      case "urgentRefusal": return j(urgentRefusal(a[0]));
      case "parseDecision": return j(parseDecision(a[0]));
      case "checkDecision": return j(checkDecision(a[0], { ...a[1], items: new Map(a[1].items) }));
      case "titleStem": return j(titleStem(a[0]));
      case "collapseRuns": return j(collapseRuns(a[0]));
      case "shortDate": return j(shortDate(a[0]));
      case "buildSummary": return j(buildSummary(a[0]));
      case "weekStart": return j(weekStart(a[0]));
      case "weekRecapLine": return j(weekRecapLine(a[0], new Map(Object.entries(a[1])), a[2]));
      case "rowLines": return j(rowLines(a[0]));
      case "toRow": return j(toRow(a[0], new Set(a[1])));
      case "pageOf": return j(pageOf(a[0], a[1], new Set(a[2])));
      case "nearOf": return j(nearOf(a[0], a[1], a[2], new Set(a[3]), a[4]));
      case "needsShown": return j(needsShown(a[0], new Set(a[1])));
      case "needsYouIds": return j([...needsYouIds(a[0], (k) => (a[1] as Record<string, string | null>)[k] ?? null)]);
      case "trimMessages": return j(trimMessages(a[0], a[1]).map((m) => m.id));
      case "normalizeRecords": return j(normalizeRecords(a[0]));
      case "questionHash": return j(questionHash(a[0]));
      case "waitIdentity": return j(waitIdentity(a[0], a[1]));
      case "recordForMessage": return j(recordForMessage(a[0], a[1], a[2]) ?? null);
      case "normalizeSettings": return j(normalizeSettings(a[0], undefined, true));
      // P1b: a Settings change over the file's settings, and the bits the settings view shows.
      case "normalizeUpdate": return j(normalizeSettings(a[0], normalizeSettings(a[1], undefined, true), false));
      case "isNtfy": return j(isNtfy(a[0]));
      case "maskToken": return j(maskToken(a[0]));
      case "headerValue": return j(headerValue(a[0]));
      case "cutBytes": return j(cutBytes(a[0], a[1]));
      case "ntfyRequest": {
        const r = ntfyRequest({ webhookUrl: "https://ntfy.sh/t" }, a[0], a[1]);
        return j({ headers: r.init.headers, body: r.init.body });
      }
      case "pushPayloadOf": return j(pushChannelPayload(a[0]));
      case "storeScript": return j(storeScript(a[0], a[1]));
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
