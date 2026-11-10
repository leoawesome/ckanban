// Huddle stalls: a tag at the end of a long message reaches the helper whole, and a host waiting on silent helpers
// gets nudged instead of the huddle sitting idle forever.
import { expect, test } from "bun:test";
import { callTool } from "../src/mcp-server";
import { DIGEST_MAX_CHARS, digestWindow, HUDDLE_IDLE_MS } from "../src/server/huddle";
import { huddleDigest } from "../src/server/prompts";
import { agentCtx, heardBy, host, huddles, idle, messages, participant, useHuddleEnv } from "./huddle-env";

useHuddleEnv();

const ROSTER = [
  { preset: "reviewer", handle: "skeptic" },
  { preset: "reviewer", handle: "research", mode: "tagged" as const },
  { preset: "qa-lead", handle: "lead", host: true },
];

test("a done, tagged helper tagged by the host at the end of a long message gets the whole message, tag line included", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, ROSTER);
  await idle();
  await callTool("huddle_post", { text: "Round 1: peer apps checked, notes in outputs.", status: "done" }, agentCtx(h, "research"));
  await idle();
  expect(participant(h, "research").status).toBe("done");
  const heard0 = heardBy("research").length;
  const tagLine = "ANYTHING STILL MISSING? @research: answer no, or yes plus the items.";
  const body = `SETTLEMENTS (round 5) ${"S16. the reminder tap opens the free sheet for capped users only. ".repeat(22)}`.slice(0, 1500 - tagLine.length - 1);
  const long = `${body}\n${tagLine}`;
  expect(long.length).toBe(1500);
  await callTool("huddle_post", { text: long }, agentCtx(h, "lead"));
  await idle();
  expect(heardBy("research").length).toBe(heard0 + 1);
  const prompt = heardBy("research").at(-1)!;
  expect(prompt).toContain("(you were tagged)");
  expect(prompt).toContain(`    ${tagLine}`);
  expect(prompt).toContain(body);
  expect(prompt).not.toContain("with huddle_read)");
  expect(participant(h, "research").status).not.toBe("done");
  await huddles.stopAll("p", h.id);
}, 60_000);

test("the host tags a helper who stays silent while everyone is idle: one note to the host names it", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, ROSTER);
  await idle();
  await callTool("huddle_post", { text: "Round 1 done.", status: "done" }, agentCtx(h, "research"));
  await callTool("huddle_post", { text: "@lead no, nothing missing." }, agentCtx(h, "skeptic"));
  await idle();
  const ask = await callTool("huddle_post", { text: "@research anything still missing? no, or yes plus items." }, agentCtx(h, "lead"));
  expect(ask.isError).toBeFalsy();
  await idle();
  // It was woken (the fake session ends without posting), so it is silent, not owed a wake.
  expect(participant(h, "research").cursor).toBeGreaterThan(0);
  const askSeq = messages(h).findLast((m) => m.kind !== "system")!.seq;
  const notes = () => messages(h).filter((m) => m.kind === "system" && m.text.startsWith("Huddle idle"));
  const heardLead = heardBy("lead").length;
  huddles.idleSweep(Date.now() - 1000);
  expect(notes().length).toBe(0);
  huddles.idleSweep(Date.now() + HUDDLE_IDLE_MS + 1000);
  expect(notes().length).toBe(1);
  expect(notes()[0].text).toBe(`Huddle idle for 5 min: @research hasn't answered your #${askSeq}. Count that answer as "no" and name it in the report, or tag it once more.`);
  expect(notes()[0].mentions).toEqual(["lead"]);
  await idle();
  expect(heardBy("lead").length).toBeGreaterThan(heardLead);
  expect(heardBy("lead").at(-1)).toContain("@research hasn't answered");
  // Once per stall.
  huddles.idleSweep(Date.now() + HUDDLE_IDLE_MS * 3);
  expect(notes().length).toBe(1);
  // The host speaking last without tagging anyone is the host waiting on nobody: no note.
  await callTool("huddle_post", { text: "Writing the report now." }, agentCtx(h, "lead"));
  await idle();
  huddles.idleSweep(Date.now() + HUDDLE_IDLE_MS * 3);
  expect(notes().length).toBe(1);
  await huddles.stopAll("p", h.id);
}, 60_000);

test("a digest carries every unread message whole up to the size guard; only then are the oldest left out", () => {
  const msg = (seq: number, len: number) => ({ id: `m${seq}`, seq, ts: "", from: "qa", mentions: [], kind: "message" as const, text: `${seq}:`.padEnd(len, "x") });
  // 50 messages of 2,000 characters: well past the old 40-message cap, under the size guard.
  const many = Array.from({ length: 50 }, (_, i) => msg(i + 1, 2000));
  expect(digestWindow(many)).toHaveLength(50);
  // Past the guard: the newest that fit, oldest left out.
  const huge = Array.from({ length: 80 }, (_, i) => msg(i + 1, 2000));
  const shown = digestWindow(huge);
  expect(shown.length).toBe(DIGEST_MAX_CHARS / 2000);
  expect(shown.at(-1)!.seq).toBe(80);
  expect(shown[0].seq).toBe(80 - shown.length + 1);
  const d = huddleDigest(shown, huge.length - shown.length);
  expect(d).toContain(`(${huge.length - shown.length} earlier unread messages left out; read them with huddle_read)`);
  expect(d).toContain(`[#80] @qa: ${huge.at(-1)!.text}`);
  // The newest message always goes in, even alone over the guard.
  expect(digestWindow([msg(1, 10), msg(2, 50)], 20).map((m) => m.seq)).toEqual([2]);
  expect(digestWindow([])).toEqual([]);
});
