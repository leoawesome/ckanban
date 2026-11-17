// Satellite mode (P1a): the Rust board owns the helper's files. The satellite's stores read them again when they
// change, send the front desk's seenInChatAt to Rust and refuse every other write.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/support/helpers";
import { MessageStore } from "./messages";
import { Bus } from "../core/events";
import { Store } from "../core/store";
import type { HelperEdge } from "./core";
import { Notifier } from "./notify";
import { PushService } from "./push";
import { WaitStore } from "./waits";

const rec = (key: string, extra: Record<string, unknown> = {}) => ({
  key, board: "p", ticketId: key.split("/")[1].split("|")[0], kind: "review", question: "q", label: "l", since: "s", queuedAt: "2026-11-17T10:00:00.000Z",
  toldAt: null, toldVia: null, fallbackAt: null, digestAt: null, reminders: [], closedAt: null, ...extra,
});

describe("satellite mode: the helper's files are read only", () => {
  test("waits: read again when Rust writes them; seenInChatAt goes to Rust; other writes throw", async () => {
    const dir = tempDir();
    const file = join(dir, "waits.json");
    writeFileSync(file, JSON.stringify({ version: 1, records: { "p/t1|review": rec("p/t1|review") }, notifyUserAt: {} }));
    const sent: [string, unknown][] = [];
    const w = new WaitStore(dir, Date.now, (key, patch) => sent.push([key, patch]));
    expect(w.start).toBe("present");
    expect(w.open().map((r) => r.key)).toEqual(["p/t1|review"]);
    await Bun.sleep(5);
    writeFileSync(file, JSON.stringify({ version: 1, records: { "p/t1|review": rec("p/t1|review"), "p/t2|review": rec("p/t2|review") }, notifyUserAt: {}, firstSummaryPending: true }));
    expect(w.open().map((r) => r.key)).toEqual(["p/t1|review", "p/t2|review"]);
    expect(w.firstSummaryPending).toBe(true);
    w.update("p/t2|review", { seenInChatAt: "2026-11-17T11:00:00.000Z" });
    expect(sent).toEqual([["p/t2|review", { seenInChatAt: "2026-11-17T11:00:00.000Z" }]]);
    expect(w.get("p/t2|review")?.seenInChatAt).toBe("2026-11-17T11:00:00.000Z");
    expect(() => w.close(["p/t1|review"], "answered")).toThrow("belongs to the Rust board");
    expect(() => w.markTold(["p/t1|review"], "helper")).toThrow("belongs to the Rust board");
    expect(() => w.add({ board: "p", ticketId: "t3", kind: "review", identity: "review", question: "", label: "", since: "s" })).toThrow("belongs to the Rust board");
    expect(() => w.save()).toThrow("belongs to the Rust board");
  });

  test("a waits file that can't be read is left alone (never set aside by the satellite)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "waits.json"), "{ not json");
    const w = new WaitStore(dir, Date.now, () => {});
    expect(w.open()).toEqual([]);
    expect(Bun.file(join(dir, "waits.json")).size).toBeGreaterThan(0);
  });

  test("messages: read again when Rust writes them; the satellite never writes", async () => {
    const dir = tempDir();
    const file = join(dir, "messages.json");
    const m = (id: string) => ({ id, at: "2026-11-17T10:00:00.000Z", level: "urgent", oneLine: id, text: "t", why: null, items: [], sends: [], readAt: null });
    writeFileSync(file, JSON.stringify({ version: 1, messages: [m("m_a")] }));
    const s = new MessageStore(dir, Date.now, undefined, true);
    expect(s.get("m_a")?.oneLine).toBe("m_a");
    await Bun.sleep(5);
    writeFileSync(file, JSON.stringify({ version: 1, messages: [m("m_a"), m("m_bb")] }));
    expect(s.get("m_bb")?.oneLine).toBe("m_bb");
    expect(() => s.add({ level: "direct", oneLine: "x", text: "y" })).toThrow("belongs to the Rust board");
    expect(() => s.markRead("m_a")).toThrow("belongs to the Rust board");
  });
});

describe("satellite mode (P1b): push.json and notify.json belong to the Rust board", () => {
  test("phone push devices are read, never written", async () => {
    const dir = tempDir();
    const push = new PushService(dir, { readOnly: true, fetch: async () => new Response(null, { status: 410 }) });
    // No file: keys for this read only, nothing written.
    expect(typeof push.publicKey()).toBe("string");
    expect(existsSync(join(dir, "push.json"))).toBe(false);
    const file = join(dir, "push.json");
    const saved = JSON.stringify({ vapid: { publicKey: "BPub", privateKey: "priv" }, devices: [{ id: "d1", endpoint: "https://p.example/x", keys: { p256dh: "a", auth: "b" }, label: "Phone", createdAt: "c" }] }, null, 2) + "\n";
    writeFileSync(file, saved);
    expect(push.devices()).toEqual([{ id: "d1", label: "Phone", createdAt: "c" }]);
    push.markThisMac("https://p.example/x");
    expect(push.remove("d1")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(saved);
  });

  test("Telegram's saves go to Rust as only its own fields; a Settings change Rust saved is followed", async () => {
    const dir = tempDir();
    const writes: unknown[] = [];
    const edge: HelperEdge = {
      waitSeen() {},
      async sendMessage() {
        throw new Error("not here");
      },
      async writeSettings(s, telegram) {
        writes.push(telegram ?? { whole: s });
      },
      async action() {
        return "";
      },
    };
    const store = new Store(dir);
    const n = new Notifier(store, new Bus(), {
      root: dir, sessionSummary: () => null, isRunning: () => false, hostHuddles: () => new Map(), baseUrl: () => "http://localhost:1", telegramPoll: false, helperEdge: edge,
    });
    n.telegramLock();
    await n.settingsSaved();
    expect(writes).toEqual([{ takeMessages: false, lockedAt: expect.any(String) }]);
    expect(existsSync(join(dir, "notify.json"))).toBe(false);
    expect(n.telegramPublic()).toMatchObject({ on: false, tokenSet: false, paired: false, status: "no-token" });
    n.settingsChanged({ tokenChanged: false, stoppedTaking: false });
    expect(n.settings().telegram.takeMessages).toBe(true);
  });
});
