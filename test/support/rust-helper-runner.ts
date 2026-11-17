// The helper runner's scenarios as rust/board/tests/fixtures/helper_runner.json records them. Each scenario is a list
// of steps (waits arriving, the clock moving, wakes with the helper's answer, ticks, taps, settings) run on Bun's
// HelperCore and HelperRunner with a fixed clock, fake channels and a fake side call; after each step the helper's
// files (waits.json, messages.json, helper-state.json, helper.json, helper-spend.jsonl) and what the step answered.
// Run as a script it reads scenarios on stdin and prints the snapshots (the caller sets TZ).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramTakes, Channels, type Channel } from "../../src/helper/channels";
import { HelperCore } from "../../src/helper/core";
import { normalizeSettings, writeNotifySettings } from "../../src/helper/notify";
import { HelperRunner } from "../../src/helper/runner";
import { TOKEN_RE } from "../../src/helper/telegram";
import type { SideCallResult } from "../../src/runs/side-call";

export const BASE = "http://localhost:4000";

/** Message ids (m_...) and feedback ids (f_...) numbered by first sight, so random parts compare. */
export function named(text: string, ids: Map<string, string>): string {
  return text.replace(/\b([mf])_[a-z0-9]{6,}\b/g, (m, k: string) => {
    if (!ids.has(m)) ids.set(m, `${k}_${[...ids.keys()].filter((x) => x.startsWith(k)).length + 1}`);
    return ids.get(m)!;
  });
}

const read = (f: string) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

export async function runScenario(sc: any): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "helper-run-"));
  let now = Date.parse(sc.start);
  const clock = () => now;
  let results: Record<string, { ok: boolean; error?: string | null; devices?: number }> = sc.channels ?? {};
  const fake = (name: string, enabled: (s: any) => boolean): Channel => ({
    name, enabled, ...(name === "telegram" ? { takes: telegramTakes } : {}),
    async send() {
      const r = results[name] ?? { ok: true };
      return { channel: name, ok: r.ok, error: r.error ?? (r.ok ? null : `${name} failed`), ...(r.devices !== undefined ? { devices: r.devices } : {}) };
    },
  });
  const channels = new Channels([
    fake("mac", (s) => s.mac), fake("webhook", (s) => !!s.webhookUrl && s.webhookOn), fake("push", (s) => s.push),
    fake("telegram", (s) => s.telegram.on && TOKEN_RE.test(s.telegram.token) && s.telegram.chatId !== null),
  ]);
  const tickets: Record<string, any[]> = sc.board.tickets;
  const profiles: { slug: string; name: string }[] = sc.board.profiles;
  const store = {
    root: dir,
    listProfiles: () => profiles,
    getProfile: (slug: string) => profiles.find((p) => p.slug === slug),
    listTickets: (slug: string) => tickets[slug] ?? [],
    getTicket: (slug: string, id: string) => (tickets[slug] ?? []).find((t) => t.id === id),
  } as any;
  const link = (slug: string, id?: string) => `${BASE}/#/${encodeURIComponent(slug)}${id ? `/${encodeURIComponent(id)}` : ""}`;
  const settings = () => {
    try {
      return normalizeSettings(JSON.parse(readFileSync(join(dir, "notify.json"), "utf8")), undefined, true);
    } catch {
      return normalizeSettings({}, undefined, true);
    }
  };
  let core: HelperCore | null = null;
  let runner: HelperRunner | null = null;
  const replies: SideCallResult[] = [];
  const make = () => {
    core = new HelperCore({ root: dir, store, channels, settings, link, now: clock });
    runner = new HelperRunner({
      root: dir, store, core, notifySettings: settings, link, messageLink: (id) => `${BASE}/#/~messages/${encodeURIComponent(id)}`,
      sideCall: async () => replies.shift() ?? { ok: false, error: "no reply" }, snoozedUntil: () => null, onScreen: () => false, phoneDevices: () => 0,
      checkinOffer: () => false, now: clock,
    });
  };
  const ids = new Map<string, string>();
  const out: string[] = [];
  const msgId = (n: number) => [...ids].find(([, v]) => v === `m_${n}`)?.[0] ?? "";
  try {
    for (const st of sc.steps) {
      let said: unknown = null;
      switch (st.op) {
        case "notify": writeNotifySettings(dir, normalizeSettings(st.settings, undefined, true)); break;
        case "start": make(); break;
        case "advance": now += st.ms; break;
        case "route": said = (await core!.route(st.wait)).key; break;
        case "reconcile": core!.reconcile(st.board, st.ticketId, st.wait ?? null, st.wait?.identity ?? null); break;
        case "started": core!.started(); break;
        case "settled": core!.settled(st.board, st.ticketId, st.identity ?? null); break;
        case "opened": core!.opened(st.board, st.ticketId); break;
        case "deleted": core!.deleted(st.board, st.ticketId); break;
        case "reply": replies.push(...st.replies.map((r: any) => (r.fail ? { ok: false, error: r.fail, ...(r.costUsd ? { costUsd: r.costUsd } : {}) } : { ok: true, text: typeof r.text === "string" ? r.text : JSON.stringify(r.decision), costUsd: r.costUsd ?? 0.01, model: "claude-sonnet" }))); break;
        case "wake": said = (await runner!.wake())?.ok ?? null; break;
        case "tick": await runner!.tick(); break;
        case "coreTick": await core!.tick(); break;
        case "switched": await core!.switched(st.on); break;
        case "channels": results = st.results; break;
        case "gotIt": said = runner!.gotIt(msgId(st.m), st.key ?? null); break;
        case "notUrgent": said = runner!.notUrgent(msgId(st.m), st.key ?? null); break;
        case "night": said = runner!.nightAnswer(msgId(st.m), st.allow); break;
        case "practice": said = await runner!.practice(); break;
        case "helperSettings": said = runner!.settings.update(st.raw); break;
        case "feedback": said = runner!.settings.addFeedback(st.text); runner!.feedbackAdded(); break;
        case "pinged": said = runner!.shouldHavePinged(st.board, st.ticketId); break;
        case "status": {
          const s = runner!.status();
          said = { ...s, nextWakeAt: s.nextWakeAt };
          break;
        }
        case "awake": said = runner!.wantsAwake(); break;
        case "waiting": said = await core!.waitingText(); break;
        case "dueAt": said = runner!.dueAt(); break;
      }
      const snap = { said, waits: read(join(dir, "waits.json")), messages: read(join(dir, "messages.json")), state: read(join(dir, "helper-state.json")), helper: read(join(dir, "helper.json")), spend: read(join(dir, "helper-spend.jsonl")) };
      out.push(named(JSON.stringify(snap), ids));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

if (import.meta.main) {
  const scenarios = JSON.parse(await Bun.stdin.text());
  const out = [];
  for (const sc of scenarios) out.push(await runScenario(sc));
  console.log(JSON.stringify(out));
}
