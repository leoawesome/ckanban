// Outside-in contract: what waits on the user and how the board tells them. The helper's status, settings and
// feedback; notification settings and the test send; the messages the board sent (list, one, read, read all); a
// ticket's own Claude notifying the user; phone push devices; the Telegram refusals. See contracts/api.md
// ("Notifications, messages, helper, push, Telegram") and contracts/data-files.md.
//
// Nothing leaves this Mac: the webhook is a local fake (plain http, which the settings allow), phone push goes to a
// local https fake with a self-signed certificate (the daemon gets NODE_TLS_REJECT_UNAUTHORIZED=0 for it), the Mac
// banner is a stub `osascript` that writes down its arguments, and Telegram talks to a local fake Bot API
// (CKANBAN_TELEGRAM_URL). The helper is switched off first, so each wait is sent at once (with the helper on, its side
// call to Claude decides, which the fake Claude can't answer).
//
// User-only actions go through the phone access listener (phone.ts); remote.json is seeded as on. Pairing Telegram is
// only for the user's browser on this Mac: those requests come from a stand-in browser (bun started through a link
// named "Google Chrome", which is what the daemon's browser check looks at).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { phone, writeRemoteJson } from "./phone";
import { schemaProblems } from "./schema";

const SLUG = "helper";
const RUN = "x-ckanban-run";
const p = (path: string) => `/api/profiles/${SLUG}${path}`;

// The local fake webhook (ntfy or JSON): every request it gets.
const hooks: { path: string; headers: Record<string, string>; body: string }[] = [];
const webhook = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req) => {
    hooks.push({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() });
    return new Response("ok");
  },
});

// The local fake push service (https only: the board refuses other endpoints). A throwaway self-signed certificate.
const certDir = mkdtempSync(join(tmpdir(), "ck-contract-push-"));
const made = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
  "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")], { stdout: "ignore", stderr: "pipe" });
if (made.exitCode !== 0) throw new Error(`openssl could not make a test certificate: ${made.stderr}`);
const pushes: { path: string; headers: Record<string, string>; bytes: number }[] = [];
const pushFake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { cert: readFileSync(join(certDir, "cert.pem"), "utf8"), key: readFileSync(join(certDir, "key.pem"), "utf8") },
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    pushes.push({ path, headers: Object.fromEntries(req.headers), bytes: (await req.arrayBuffer()).byteLength });
    // A device the push service has forgotten answers 410.
    return new Response(null, { status: path.includes("gone") ? 410 : 201 });
  },
});

// The local fake Telegram Bot API: every call, and the updates the next getUpdates returns.
const TOKEN = "123456789:AAHfakeFAKEfakeFAKEfakeFAKEfake_1234";
const CHAT = 4242;
const tgCalls: { method: string; body: any }[] = [];
let tgUpdates: any[] = [];
let tgNextId = 1000;
let tgUpdateId = 1;
const telegram = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
  fetch: async (req) => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(req.url).pathname);
    if (!m || m[1] !== TOKEN) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
    const method = m[2];
    const body: any = (req.headers.get("content-type") ?? "").includes("json") ? await req.json() : {};
    tgCalls.push({ method, body });
    let result: unknown = true;
    if (method === "getMe") result = { id: 1, is_bot: true, username: "ck_contract_bot" };
    else if (method === "getUpdates") {
      // A short long poll: up to a second for something to arrive.
      for (let i = 0; i < 20 && !tgUpdates.length; i++) await Bun.sleep(50);
      result = tgUpdates.filter((u) => u.update_id >= (body.offset ?? 0));
      tgUpdates = [];
    } else if (method === "sendMessage" || method === "sendDocument") result = { message_id: tgNextId++, chat: { id: body.chat_id }, date: Math.floor(Date.now() / 1000) };
    return Response.json({ ok: true, result });
  },
});
const tgSent = () => tgCalls.filter((c) => c.method === "sendMessage").map((c) => c.body);
const tgUser = { id: CHAT, is_bot: false, first_name: "Owner", username: "owner" };
/** A message the user sends the bot (replyTo: the bot's message it answers). */
function tgSay(text: string, replyTo?: number) {
  const id = tgUpdateId++;
  tgUpdates.push({ update_id: id, message: { message_id: 50 + id, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" }, from: tgUser, text,
    ...(replyTo ? { reply_to_message: { message_id: replyTo, chat: { id: CHAT, type: "private" } } } : {}) } });
}
/** The user taps a button (callback data) on the bot's message. */
function tgTap(data: string, messageId: number) {
  const id = tgUpdateId++;
  tgUpdates.push({ update_id: id, callback_query: { id: `cq${id}`, from: tgUser, data, message: { message_id: messageId, chat: { id: CHAT, type: "private" } } } });
}
/** The message id the fake handed out for a sent message (ids are given in order from 1000). */
const msgIdOf = (body: any): number => 1000 + tgCalls.filter((c) => c.method === "sendMessage" || c.method === "sendDocument").findIndex((c) => c.body === body);
/** The buttons' callback data on a sent message. */
const buttons = (b: any): string[] => (b.reply_markup?.inline_keyboard ?? []).flat().map((x: any) => x.callback_data).filter(Boolean);

/** A request from a stand-in for the user's browser on this Mac (see the top of the file). */
async function asBrowser(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const script = `const r = await fetch(${JSON.stringify(d.url + path)}, { method: ${JSON.stringify(method)}, headers: { origin: ${JSON.stringify(d.url)}, "content-type": "application/json" }, body: ${JSON.stringify(body === undefined ? undefined : JSON.stringify(body))} });
process.stdout.write(JSON.stringify({ status: r.status, text: await r.text() }));`;
  const run = Bun.spawn([browserBin, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(run.stdout).text();
  await run.exited;
  const r = JSON.parse(out);
  let data: any = null;
  try {
    data = JSON.parse(r.text);
  } catch {}
  return { status: r.status, data };
}
const browserDir = mkdtempSync(join(tmpdir(), "ck-contract-browser-"));
const browserBin = join(browserDir, "Google Chrome");
symlinkSync(process.execPath, browserBin);

/** A browser's push subscription: a real P-256 key and auth secret (the board encrypts to them). */
function subscription(name: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://127.0.0.1:${pushFake.port}/push/${name}`,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
}

let d: Daemon;
let bannerLog = "";
/** Every message on the event stream so far (parsed `data:` lines). */
const events: any[] = [];
const stream = new AbortController();

const banners = (): string[][] => {
  try {
    return readFileSync(bannerLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

/** Fails with the answer's text when the status is not the expected one. */
function ok(r: { status: number; text: string }, status: number, what: string) {
  if (r.status !== status) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`);
}

beforeAll(async () => {
  const logDir = mkdtempSync(join(tmpdir(), "ck-contract-banner-"));
  bannerLog = join(logDir, "osascript.jsonl");
  d = await startDaemon({
    env: { NODE_TLS_REJECT_UNAUTHORIZED: "0", FAKE_PLAN_FILE: join(logDir, "plan.json"), CKANBAN_TELEGRAM_URL: `http://127.0.0.1:${telegram.port}` },
    // The Mac banner: osascript -e 'display notification ...'; written down, never shown.
    stubs: { osascript: `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(bannerLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` },
    before: ({ home }) => {
      writeRemoteJson(home, true);
      // The fake Claude ends a run whose message says ASK-ME with status "questions", and one saying STUCK "blocked".
      writeFileSync(join(logDir, "plan.json"), JSON.stringify([
        { match: "ASK-ME", status: "questions", text: "I asked about the colour.", tools: [{ name: "mcp__ckanban__ask_questions", input: {
          questions: [{ question: "Which colour should the button be?", options: [{ label: "Blue" }, { label: "Green" }], multiSelect: false }],
        } }] },
        { match: "STUCK", status: "blocked", text: "I need the API key." },
      ]));
    },
  });
  ok(await d.api("POST", "/api/profiles", { name: "Helper", path: d.project }), 201, "board");
  // The event stream, read in the background for the whole file.
  const res = await fetch(`${d.url}/api/events`, { signal: stream.signal });
  (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done) return;
      buf += dec.decode(r.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {}
        }
      }
    }
  })();
}, 60_000);

afterAll(async () => {
  stream.abort();
  await d?.stop();
  webhook.stop(true);
  telegram.stop(true);
  rmSync(browserDir, { recursive: true, force: true });
  pushFake.stop(true);
  rmSync(certDir, { recursive: true, force: true });
}, 30_000);

describe("refusals", () => {
  test("board runs can't read or change notifications, messages, the helper or push", async () => {
    const h = { [RUN]: `${SLUG}/t_x` };
    for (const [m, path] of [["GET", "/api/notify"], ["POST", "/api/notify/test"], ["GET", "/api/messages"], ["POST", "/api/messages/read-all"],
      ["GET", "/api/helper"], ["GET", "/api/helper/feedback"], ["GET", "/api/push"], ["POST", "/api/push/remove"]] as const) {
      const r = await d.api(m, path, m === "POST" ? {} : undefined, h);
      expect({ path, status: r.status }).toEqual({ path, status: 403 });
    }
  });

  test("changing settings, the helper and Telegram is for the user only", async () => {
    // A program on this Mac (no browser) is refused, with or without an Origin.
    for (const [path, b] of [["/api/notify", { mac: false }], ["/api/helper/settings", { night: true }], ["/api/helper/feedback", { text: "x" }],
      ["/api/notify/telegram/pair", {}], ["/api/notify/telegram/unpair", {}], ["/api/helper/notice-seen", {}]] as const) {
      const bare = await d.api("POST", path, b);
      expect({ path, status: bare.status }).toEqual({ path, status: 403 });
      expect(bare.data.error).toContain("for the user only");
    }
    // With the board's Origin but not from a browser (the daemon looks at the program on the other end): still refused.
    expect((await d.api("POST", "/api/notify", { mac: false }, { origin: d.url })).status).toBe(403);
    // Pairing Telegram is only from this Mac, never from the phone.
    const fromPhone = await phone(d, "POST", "/api/notify/telegram/pair", {});
    expect(fromPhone.status).toBe(403);
    // The front desk's file route needs its own header.
    expect((await d.api("POST", "/api/telegram/front-desk/file", { path: "/etc/hosts" })).status).toBe(403);
  });
});

describe("settings", () => {
  test("GET /api/notify: the defaults, the channels and where the request came from", async () => {
    const r = await d.api("GET", "/api/notify");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ webhookUrl: "", format: "auto", mac: true, helper: true, push: true, webhookOn: true, local: true, phoneReady: false });
    expect(r.data.kinds).toMatchObject({ questions: true, blocked: true, reply: false, message: true });
    // The token is never in an answer; an unpaired, unset bot.
    expect(r.data.telegram.token).toBeUndefined();
    expect(r.data.telegram).toMatchObject({ on: false, paired: false, tokenSet: false, tokenMasked: "", status: "no-token" });
    expect(Array.isArray(r.data.channels)).toBe(true);
    // From the phone, `local` is false.
    expect((await phone(d, "GET", "/api/notify")).data.local).toBe(false);
  });

  test("POST /api/notify from the user: a local webhook, the helper off; notify.json is owner-only", async () => {
    const r = await phone(d, "POST", "/api/notify", { webhookUrl: `http://127.0.0.1:${webhook.port}/hook`, format: "json", helper: false });
    ok(r, 200, "settings");
    expect(r.data).toMatchObject({ webhookUrl: `http://127.0.0.1:${webhook.port}/hook`, format: "json", helper: false, local: false });
    const file = join(d.home, "notify.json");
    const raw = readFileSync(file, "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw).toStartWith("{\n  ");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(raw);
    expect(saved).toMatchObject({ webhookUrl: `http://127.0.0.1:${webhook.port}/hook`, format: "json", helper: false });
    expect(schemaProblems("notify.schema.json", saved)).toEqual([]);
  });

  test("bad settings are refused with 400 and change nothing", async () => {
    const before = readFileSync(join(d.home, "notify.json"), "utf8");
    const badUrl = await phone(d, "POST", "/api/notify", { webhookUrl: "ftp://example.com/x" });
    expect(badUrl.status).toBe(400);
    expect(badUrl.data.error).toBe("webhook URL must start with https:// or http://");
    const badToken = await phone(d, "POST", "/api/notify", { telegram: { token: "not a token" } });
    expect(badToken.status).toBe(400);
    expect(badToken.data.error).toContain("doesn't look like a bot token");
    // The typed text is never echoed back.
    expect(badToken.text).not.toContain("not a token");
    expect(readFileSync(join(d.home, "notify.json"), "utf8")).toBe(before);
  });

  test("Telegram unpair with nothing paired answers the state", async () => {
    const r = await phone(d, "POST", "/api/notify/telegram/unpair", {});
    ok(r, 200, "unpair");
    expect(r.data.telegram).toMatchObject({ paired: false, status: "no-token" });
    expect(r.data.local).toBe(false);
  });
});

describe("the helper", () => {
  test("GET /api/helper: its status (the daemon always runs one)", async () => {
    const r = await d.api("GET", "/api/helper");
    expect(r.status).toBe(200);
    // Switched off above: one notification per wait.
    expect(r.data).toMatchObject({ on: false, line: "Helper off: you get one notification per wait", waiting: 0, failures: 0, paused: false, notice: true });
    for (const k of ["model", "night", "nightOptIn", "lastCheckAt", "nextWakeAt", "lines", "runs", "today"]) expect(k in r.data).toBe(true);
  });

  test("settings, feedback lines and the notice; helper.json", async () => {
    const set = await phone(d, "POST", "/api/helper/settings", { nightOptIn: true });
    ok(set, 200, "helper settings");
    expect(set.data.nightOptIn).toBe(true);

    const added = await phone(d, "POST", "/api/helper/feedback", { text: "Ping me for anything about payments." });
    ok(added, 200, "feedback");
    expect(added.data.line).toMatchObject({ text: "Ping me for anything about payments." });
    expect(typeof added.data.line.id).toBe("string");
    expect(added.data.lines.map((l: any) => l.id)).toContain(added.data.line.id);
    expect((await phone(d, "POST", "/api/helper/feedback", { text: "" })).status).toBe(400);

    const list = await d.api("GET", "/api/helper/feedback");
    expect(list.status).toBe(200);
    expect(list.data.lines.map((l: any) => l.text)).toContain("Ping me for anything about payments.");

    const file = join(d.home, "helper.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ nightOptIn: true });
    expect(saved.feedback.map((l: any) => l.id)).toContain(added.data.line.id);
    expect(schemaProblems("helper-settings.schema.json", saved)).toEqual([]);

    const removed = await phone(d, "DELETE", `/api/helper/feedback/${added.data.line.id}`);
    ok(removed, 200, "remove feedback");
    expect(removed.data.lines.map((l: any) => l.id)).not.toContain(added.data.line.id);
    expect((await phone(d, "DELETE", `/api/helper/feedback/${added.data.line.id}`)).status).toBe(404);
    await until(() => events.some((e) => e.type === "helper.updated"), 5_000, "helper.updated on the event stream");

    const seen = await phone(d, "POST", "/api/helper/notice-seen", {});
    ok(seen, 200, "notice seen");
    expect(seen.data.notice).toBe(false);

    // A practice alert needs the helper on (HelperError 409).
    const practice = await phone(d, "POST", "/api/helper/practice", {});
    expect(practice.status).toBe(409);
    expect(practice.data.error).toBe("Turn the helper on first");

    const missing = await phone(d, "POST", "/api/helper/should-have-pinged", { profile: SLUG });
    expect(missing.status).toBe(400);
    expect(missing.data.error).toBe("profile and ticketId are required");
  });
});

describe("notifications", () => {
  test("POST /api/notify/test sends to the webhook and the Mac banner, and is stored as a \"test\" message", async () => {
    const n = hooks.length;
    const r = await d.api("POST", "/api/notify/test", {});
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ webhook: true, devices: 0 });
    expect(Array.isArray(r.data.channels)).toBe(true);
    const hook = r.data.channels.find((c: any) => c.channel === "webhook");
    expect(hook).toMatchObject({ ok: true, error: null });
    expect(r.data.state).toMatchObject({ helper: false });
    expect(hooks.length).toBe(n + 1);
    expect(hooks.at(-1)!.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(hooks.at(-1)!.body)).toMatchObject({ kind: expect.any(String), title: expect.any(String) });
    if (process.platform === "darwin") {
      await until(() => banners().some((a) => a.join(" ").includes("display notification")), 5_000, "the Mac banner");
    }
    // Stored with level "test" (messages.json), like every send.
    const saved = await until(() => existsSync(join(d.home, "messages.json")) && JSON.parse(readFileSync(join(d.home, "messages.json"), "utf8")), 5_000, "messages.json");
    expect(saved).toMatchObject({ version: 1 });
    expect(saved.messages.at(-1)).toMatchObject({ level: "test" });
  });

  test("runs that end asking questions or blocked wait on the user: the inbox, the card, a sent and stored message", async () => {
    // Created in Ready: the work run starts at once, and its prompt carries the body (the fake Claude's plans).
    const t = (await d.api("POST", p("/tickets"), { title: "Pick a colour", body: "ASK-ME which colour", status: "ready", mode: "auto" })).data;
    const b = (await d.api("POST", p("/tickets"), { title: "Needs a key", body: "STUCK on the key", status: "ready", mode: "auto" })).data;
    for (const x of [t, b]) {
      await until(async () => {
        const r = await d.api("GET", p(`/tickets/${x.id}`));
        return r.data.runEndedAt && !r.data.running ? r.data : null;
      }, 20_000, "the run to end");
    }

    // Waits on the user: in the Inbox (every board, oldest first) and on the ticket's card.
    const inbox = await until(async () => {
      const r = await d.api("GET", "/api/inbox");
      expect(r.status).toBe(200);
      const q = r.data.find((x: any) => x.id === t.id && x.attention.kind === "questions");
      const s = r.data.find((x: any) => x.id === b.id && x.attention.kind === "blocked");
      return q && s ? { q, s } : null;
    }, 15_000, "both tickets in the inbox");
    expect(inbox.q).toMatchObject({ profile: SLUG, profileName: "Helper", id: t.id, title: "Pick a colour", attention: { kind: "questions", label: "Answer 1 question" } });
    expect(typeof inbox.q.attention.since).toBe("string");
    expect(inbox.s.attention).toMatchObject({ kind: "blocked", label: "Blocked" });
    const card = (await d.api("GET", p(`/tickets/${t.id}`))).data;
    expect(card).toMatchObject({ status: "review", outcome: "needs_input", attention: { kind: "questions", label: "Answer 1 question" } });
    // The form itself is in the conversation.
    const conv = (await d.api("GET", p(`/tickets/${t.id}/conversation`))).data;
    expect(conv.entries.find((e: any) => e.questions)?.questions[0]).toMatchObject({ question: "Which colour should the button be?", multiSelect: false });

    // With the helper off the board sends each wait at once: the webhook gets it, and it is stored as a message.
    const hook = await until(() => hooks.map((h) => JSON.parse(h.body)).find((x) => x.ticketId === t.id && x.kind === "questions"), 15_000, "the webhook call");
    expect(hook).toMatchObject({ board: SLUG, boardName: "Helper", ticketId: t.id, title: "Pick a colour" });
    // A single question is sent as its own text; with phone access on, the link is the tailnet address.
    expect(hook.label).toBe("Which colour should the button be?");
    expect(hook.url).toBe(`https://ckmac.tail0000.ts.net/#/${SLUG}/${t.id}`);
    const blockedHook = await until(() => hooks.map((h) => JSON.parse(h.body)).find((x) => x.ticketId === b.id), 15_000, "the blocked webhook call");
    expect(blockedHook).toMatchObject({ kind: "blocked", label: "Blocked", title: "Needs a key" });

    const list = await until(async () => {
      const r = await d.api("GET", "/api/messages");
      return r.data.rows.some((x: any) => x.level === "direct") ? r.data : null;
    }, 10_000, "a stored message");
    expect(list.hasMore).toBe(false);
    expect(typeof list.unread).toBe("number");
    expect(typeof list.needs).toBe("number");
    // Rows are light: the one line ("<what it needs>: <ticket title>"), level, read state; no ticket id.
    const row = list.rows.find((x: any) => x.level === "direct" && x.oneLine.includes("Pick a colour"));
    // (Plain checks: bun's toMatchObject with expect.any() can write the matchers into the object it checks.)
    expect(typeof row.id).toBe("string");
    expect(typeof row.at).toBe("string");
    expect(row).toMatchObject({ readAt: null, needsYou: true });
    expect(row.oneLine).toContain("Pick a colour");
    const full = (await d.api("GET", `/api/messages/${row.id}`)).data;
    expect(full.sends.map((s: any) => s.channel)).toContain("webhook");
    await until(() => events.some((e) => e.type === "messages.updated"), 5_000, "messages.updated on the event stream");
    const saved = JSON.parse(readFileSync(join(d.home, "messages.json"), "utf8"));
    expect(saved.version).toBe(1);
    expect(saved.messages.map((m: any) => m.id)).toContain(row.id);
    const waits = JSON.parse(readFileSync(join(d.home, "waits.json"), "utf8"));
    expect(schemaProblems("waits.schema.json", waits)).toEqual([]);
  }, 60_000);

  test("messages: one, near, read, read all; unknown ids are 404", async () => {
    const list = (await d.api("GET", "/api/messages?tab=all&limit=1")).data;
    expect(list.rows.length).toBe(1);
    expect(list.hasMore).toBe(true);
    // The next page down, from the cursor of the last row shown.
    const next = (await d.api("GET", `/api/messages?tab=all&limit=1&beforeAt=${encodeURIComponent(list.rows[0].at)}&beforeId=${list.rows[0].id}`)).data;
    expect(next.rows.length).toBe(1);
    expect(next.rows[0].id).not.toBe(list.rows[0].id);
    const id = list.rows[0].id;
    const one = await d.api("GET", `/api/messages/${id}`);
    expect(one.status).toBe(200);
    expect(one.data.id).toBe(id);
    const near = await d.api("GET", `/api/messages/${id}/near?tab=all`);
    expect(near.status).toBe(200);
    const read = await d.api("POST", `/api/messages/${id}/read`, {});
    expect(read.status).toBe(200);
    expect(read.data.message.id).toBe(id);
    expect(typeof read.data.unread).toBe("number");
    const all = await d.api("POST", "/api/messages/read-all", {});
    expect(all.status).toBe(200);
    expect(typeof all.data.marked).toBe("number");
    expect(all.data.unread).toBe(0);
    for (const [m, path] of [["GET", "/api/messages/nope"], ["GET", "/api/messages/nope/near"], ["POST", "/api/messages/nope/read"], ["POST", "/api/messages/nope/got-it"]] as const) {
      const r = await d.api(m, path, m === "POST" ? {} : undefined);
      expect({ path, status: r.status }).toEqual({ path, status: 404 });
    }
    // Only what came in since the newest row shown: nothing new.
    const after = (await d.api("GET", `/api/messages?tab=all&afterAt=${encodeURIComponent(list.rows[0].at)}&afterId=${id}`)).data;
    expect(after.rows).toEqual([]);
    // The tabs; an unknown tab is read as "all".
    for (const tab of ["needs", "summaries", "quiet", "bogus"]) expect((await d.api("GET", `/api/messages?tab=${tab}`)).status).toBe(200);
    expect((await d.api("GET", "/api/messages?tab=quiet")).data.rows).toEqual([]);

    // Got it and Not urgent are the user's (a program is refused): the helper's answer plus the message and unread.
    expect((await d.api("POST", `/api/messages/${id}/got-it`, {})).status).toBe(403);
    const got = await phone(d, "POST", `/api/messages/${id}/got-it`, {});
    ok(got, 200, "got it");
    expect(typeof got.data.text).toBe("string");
    expect(typeof got.data.stopped).toBe("number");
    expect(got.data.message).toMatchObject({ id, tapped: { how: "got-it" } });
    expect(got.data.unread).toBe(0);
    const calm = await phone(d, "POST", `/api/messages/${id}/not-urgent`, {});
    ok(calm, 200, "not urgent");
    expect(calm.data.message.id).toBe(id);
  });

  test("a ticket's own Claude notifies the user once in a while; others can't", async () => {
    const t = (await d.api("POST", p("/tickets"), { title: "Long job" })).data;
    const path = p(`/tickets/${t.id}/notify`);
    // Not its own run: refused.
    expect((await d.api("POST", path, { message: "hi" })).status).toBe(403);
    expect((await d.api("POST", path, { message: "hi" }, { [RUN]: `${SLUG}/t_other` })).status).toBe(403);
    const own = { [RUN]: `${SLUG}/${t.id}` };
    expect((await d.api("POST", path, {}, own)).status).toBe(400);
    expect((await d.api("POST", path, { message: "x", urgent: "yes" }, own)).status).toBe(400);
    const n = hooks.length;
    const r = await d.api("POST", path, { message: "Please log in to the dashboard.", why: "the deploy waits" }, own);
    ok(r, 200, "notify");
    expect(r.data).toMatchObject({ delivered: true, webhook: true, error: null });
    await until(() => hooks.length > n, 5_000, "the webhook call");
    expect(JSON.parse(hooks.at(-1)!.body)).toMatchObject({ kind: "message", ticketId: t.id, label: "Please log in to the dashboard." });
    // A second one within the gap: 429.
    const again = await d.api("POST", path, { message: "And again." }, own);
    expect(again.status).toBe(429);
    expect(again.data.error).toContain("already sent for this ticket");
  });
});

describe("phone push", () => {
  let id = "";

  test("GET /api/push makes the VAPID keys on first read; push.json is owner-only", async () => {
    const r = await d.api("GET", "/api/push");
    expect(r.status).toBe(200);
    expect(typeof r.data.publicKey).toBe("string");
    expect(r.data.devices).toEqual([]);
    const file = join(d.home, "push.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.vapid.publicKey).toBe(r.data.publicKey);
    expect(schemaProblems("push.schema.json", saved)).toEqual([]);
  });

  test("subscribe, the test send to the local fake push service, visible, remove", async () => {
    const sub = subscription("phone1");
    // Adding or removing a device is the user's own (the phone here): another program would get every message.
    const notUser = await d.api("POST", "/api/push/subscribe", { subscription: sub, label: "Not the user" });
    expect(notUser.status).toBe(403);
    expect((await d.api("POST", "/api/push/subscribe", { subscription: sub, label: "Run" }, { origin: d.url, [RUN]: `${SLUG}/t_x` })).status).toBe(403);
    expect((await d.api("GET", "/api/push")).data.devices).toEqual([]);

    const bad = await phone(d, "POST", "/api/push/subscribe", { subscription: { endpoint: "http://127.0.0.1/x", keys: { p256dh: "a", auth: "b" } } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toBe("endpoint must be https");
    expect((await phone(d, "POST", "/api/push/subscribe", { subscription: { endpoint: "https://127.0.0.1/x" } })).status).toBe(400);

    const r = await phone(d, "POST", "/api/push/subscribe", { subscription: sub, label: "Test phone" });
    ok(r, 200, "subscribe");
    expect(r.data).toMatchObject({ label: "Test phone" });
    id = r.data.id;
    expect(typeof r.data.createdAt).toBe("string");
    const listed = (await d.api("GET", "/api/push")).data.devices;
    expect(listed.find((x: any) => x.id === id)).toMatchObject({ id, label: "Test phone" });
    // Keys and endpoints stay in push.json, not in the answer.
    expect(JSON.stringify(listed)).not.toContain(sub.keys.auth);
    const saved = JSON.parse(readFileSync(join(d.home, "push.json"), "utf8"));
    expect(saved.devices.find((x: any) => x.id === id)).toMatchObject({ endpoint: sub.endpoint, keys: sub.keys });
    expect(schemaProblems("push.schema.json", saved)).toEqual([]);

    expect((await d.api("POST", "/api/push/test", {})).status).toBe(400);
    const n = pushes.length;
    const sent = await d.api("POST", "/api/push/test", { id });
    ok(sent, 200, "push test");
    expect(sent.data).toEqual({ ok: true, error: null });
    expect(pushes.length).toBe(n + 1);
    const got = pushes.at(-1)!;
    expect(got.path).toBe("/push/phone1");
    expect(got.headers["content-encoding"]).toBe("aes128gcm");
    expect(got.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(got.bytes).toBeGreaterThan(0);
    expect((await d.api("POST", "/api/push/test", { id: "nope" })).data).toEqual({ ok: false, error: "device not found" });

    expect((await d.api("POST", "/api/push/visible", { visible: true })).status).toBe(400);
    expect((await d.api("POST", "/api/push/visible", { endpoint: sub.endpoint, visible: true })).data).toEqual({ ok: true });

    expect((await phone(d, "POST", "/api/push/remove", {})).status).toBe(400);
    expect((await d.api("POST", "/api/push/remove", { id })).status).toBe(403);
    const removed = await phone(d, "POST", "/api/push/remove", { id });
    ok(removed, 200, "remove");
    expect(removed.data).toMatchObject({ removed: true });
    expect(removed.data.devices.find((x: any) => x.id === id)).toBeUndefined();
    expect((await phone(d, "POST", "/api/push/remove", { endpoint: sub.endpoint })).data.removed).toBe(false);
  });

  test("a device the push service has forgotten (410) is dropped", async () => {
    const r = await phone(d, "POST", "/api/push/subscribe", { subscription: subscription("gone"), label: "Old phone" });
    ok(r, 200, "subscribe");
    const sent = await d.api("POST", "/api/push/test", { id: r.data.id });
    expect(sent.data.ok).toBe(false);
    expect(sent.data.error).toContain("no longer accepts notifications");
    const after = (await d.api("GET", "/api/push")).data;
    expect(after.devices.find((x: any) => x.id === r.data.id)).toBeUndefined();
  });
});

describe("Telegram (a local fake Bot API)", () => {
  let alertId = 0;

  test("a bot token from the user's browser on this Mac (not the phone); the token is never shown", async () => {
    const fromPhone = await phone(d, "POST", "/api/notify", { telegram: { token: TOKEN } });
    expect(fromPhone.status).toBe(403);
    expect(fromPhone.data.error).toBe("Pair Telegram from the Mac.");
    // Pairing needs a token first.
    expect((await asBrowser("POST", "/api/notify/telegram/pair", { board: SLUG })).status).toBe(400);
    const r = await asBrowser("POST", "/api/notify", { telegram: { token: TOKEN } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data)).not.toContain(TOKEN);
    expect(r.data.telegram).toMatchObject({ tokenSet: true, paired: false });
    expect(r.data.telegram.tokenMasked).not.toBe("");
    expect(JSON.parse(readFileSync(join(d.home, "notify.json"), "utf8")).telegram.token).toBe(TOKEN);
  });

  test("pair: a code for the user's browser on this Mac, sent to the bot from the user's chat", async () => {
    const r = await asBrowser("POST", "/api/notify/telegram/pair", { board: SLUG });
    expect(r.status).toBe(200);
    expect(r.data.code).toMatch(/^\d{6}$/);
    expect(Date.parse(r.data.expiresAt)).toBeGreaterThan(Date.now());
    // The state shows a pairing going on, never its code.
    expect(r.data.state.telegram.pairing).toEqual({ expiresAt: r.data.expiresAt });
    expect(JSON.stringify(r.data.state)).not.toContain(r.data.code);

    // A wrong code first, then the right one.
    tgSay("000000" === r.data.code ? "111111" : "000000");
    await until(() => tgSent().some((b) => b.chat_id === CHAT && String(b.text).includes("doesn't match")), 15_000, "the wrong-code answer");
    tgSay(r.data.code);
    await until(() => tgSent().some((b) => b.chat_id === CHAT && String(b.text).startsWith("Paired")), 15_000, "the Paired message");
    const state = (await d.api("GET", "/api/notify")).data.telegram;
    expect(state).toMatchObject({ paired: true, on: true, chatName: "Owner (@owner)", botName: "@ck_contract_bot", status: "ok", frontDesk: SLUG, pairing: null });
    const saved = JSON.parse(readFileSync(join(d.home, "notify.json"), "utf8")).telegram;
    expect(saved).toMatchObject({ on: true, chatId: CHAT, chatName: "Owner (@owner)", takeMessages: true, frontDesk: SLUG });
    expect(typeof saved.pairedAt).toBe("string");
    expect(schemaProblems("notify.schema.json", JSON.parse(readFileSync(join(d.home, "notify.json"), "utf8")))).toEqual([]);
  }, 40_000);

  test("/waiting in: the bot answers with what waits on the user", async () => {
    const n = tgSent().length;
    tgSay("/waiting");
    const reply = await until(() => tgSent().slice(n).find((b) => b.chat_id === CHAT), 15_000, "the /waiting answer");
    expect(reply.text).toContain("Pick a colour");
  });

  test("an urgent alert out; a reply to it in goes to that ticket's chat after the Send tap", async () => {
    const t = (await d.api("POST", p("/tickets"), { title: "Deploy waits" })).data;
    const n = tgSent().length;
    const r = await d.api("POST", p(`/tickets/${t.id}/notify`), { message: "Approve the deploy?", urgent: true }, { [RUN]: `${SLUG}/${t.id}` });
    ok(r, 200, "urgent notify");
    expect(r.data).toMatchObject({ delivered: true, telegram: true, webhook: true, error: null });
    const alert = await until(() => tgCalls.filter((c) => c.method === "sendMessage").slice(n).find((c) => String(c.body.text).includes("Approve the deploy?")), 15_000, "the alert in Telegram");
    expect(alert.body.chat_id).toBe(CHAT);
    alertId = msgIdOf(alert.body);
    // Got it / Not urgent buttons on an urgent alert, with the stored message's id.
    const gotIt = buttons(alert.body).find((x) => /^g:m_/.test(x))!;
    expect(buttons(alert.body)).toContain(`n:${gotIt.slice(2)}`);

    const m = tgSent().length;
    tgSay("Yes, ship it", alertId);
    const card = await until(() => tgSent().slice(m).find((b) => buttons(b).some((x) => /^p:\w+:y$/.test(x))), 15_000, "the Send card");
    expect(String(card.text)).toContain("Deploy waits");
    // Message ids are handed out in order: the card's is the one for its sendMessage.
    tgTap(buttons(card).find((x) => x.endsWith(":y"))!, msgIdOf(card));
    await until(() => tgCalls.some((c) => c.method === "answerCallbackQuery"), 15_000, "the tap answered");
    const conv = await until(async () => {
      const r = await d.api("GET", p(`/tickets/${t.id}/conversation`));
      return r.data.entries.some((e: any) => e.role === "user" && String(e.text).includes("Yes, ship it")) ? r.data : null;
    }, 20_000, "the reply in the ticket's chat");
    expect(conv.entries.length).toBeGreaterThan(0);

    // Got it on the alert: the tap is answered and the stored message marked.
    const a = tgCalls.filter((c) => c.method === "answerCallbackQuery").length;
    tgTap(gotIt, alertId);
    await until(() => tgCalls.filter((c) => c.method === "answerCallbackQuery").length > a, 15_000, "the Got it tap answered");
    const msg = await until(async () => (await d.api("GET", `/api/messages/${gotIt.slice(2)}`)).data?.tapped, 10_000, "the message marked");
    expect(msg.how).toBe("got-it");
  }, 60_000);

  test("the front desk: a message in, its answer out, and a held change runs only after Confirm", async () => {
    const t = (await d.api("POST", p("/tickets"), { title: "Move me" })).data;
    const n = tgSent().length;
    tgSay("Hello desk, what is on the board?");
    // The front desk is a quick chat on the paired board; its Claude (the fake) gets CKANBAN_FRONTDESK.
    const args = await until(() => {
      try {
        return readFileSync(d.env.FAKE_ARGS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((a) => a.frontDesk);
      } catch {
        return null;
      }
    }, 20_000, "the front desk's run");
    const desk: string = args.frontDesk;
    expect(desk).toMatch(new RegExp(`^${SLUG}/[^/]+/[^/]+$`));
    // Its answer goes back to the chat.
    await until(() => tgSent().slice(n).some((b) => b.chat_id === CHAT && String(b.text).includes("Work complete")), 20_000, "the desk's answer");

    // A change from the desk is held: 202 and a Confirm card in Telegram; the ticket doesn't move yet.
    const bad = await d.api("PATCH", p(`/tickets/${t.id}`), { status: "ready" }, { "x-ckanban-frontdesk": `${SLUG}/nope/nope` });
    expect(bad.status).toBe(403);
    const m = tgSent().length;
    const held = await d.api("PATCH", p(`/tickets/${t.id}`), { status: "ready" }, { "x-ckanban-frontdesk": desk });
    expect(held.status).toBe(202);
    expect(held.data.confirmation).toStartWith("Sent for confirmation");
    const card = await until(() => tgSent().slice(m).find((b) => buttons(b).some((x) => /^p:\w+:y$/.test(x))), 10_000, "the Confirm card");
    expect(String(card.text)).toContain("Move me");
    expect((await d.api("GET", p(`/tickets/${t.id}`))).data.status).toBe("backlog");
    // Reads pass straight through.
    expect((await d.api("GET", p(`/tickets/${t.id}`), undefined, { "x-ckanban-frontdesk": desk })).status).toBe(200);

    tgTap(buttons(card).find((x) => x.endsWith(":y"))!, msgIdOf(card));
    await until(async () => (await d.api("GET", p(`/tickets/${t.id}`))).data.status !== "backlog", 15_000, "the move after Confirm");
  }, 90_000);

  test("unpair forgets the chat", async () => {
    const r = await phone(d, "POST", "/api/notify/telegram/unpair", {});
    ok(r, 200, "unpair");
    expect(r.data.telegram).toMatchObject({ paired: false });
    expect(JSON.parse(readFileSync(join(d.home, "notify.json"), "utf8")).telegram.chatId).toBeNull();
  });
});
