// Outside-in contract: on the phone access port, only Tailscale's forwarder from another device is the user
// (t_20261115_v0ip). This daemon runs as on a real Mac (no CKANBAN_PHONE_FORWARDER_UID): Tailscale's forwarder is a
// process of another macOS user (root), and this test process, like a board run's shell, runs as the daemon's user. It
// sends everything a phone sends (the tailnet Host, the owner's Tailscale login, the tailnet Origin, a visitor address)
// straight to 127.0.0.1:<phone port>, and every user-only route refuses it. Reads still pass the phone's gate.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Daemon, startDaemon } from "./daemon";
import { phone, writeRemoteJson } from "./phone";

let d: Daemon;
const SLUG = "caller";
const base = `/api/profiles/${SLUG}`;

beforeAll(async () => {
  d = await startDaemon({ env: { CKANBAN_PHONE_FORWARDER_UID: "" } });
  expect((await d.api("POST", "/api/profiles", { name: "Caller", path: d.project })).status).toBe(201);
  writeRemoteJson(d.home, true);
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

test("reads: the phone's gate still lets the forged headers read the board", async () => {
  expect((await phone(d, "GET", "/api/profiles")).status).toBe(200);
});

test("a program of this macOS user calling the phone port with forged headers is refused at every user-only route", async () => {
  const ticket = await d.api("POST", `${base}/tickets`, { title: "Keys wanted" });
  expect(ticket.status).toBe(201);
  const schedule = await d.api("POST", `${base}/schedules`, { name: "Nightly", title: "Nightly", body: "Check.", cron: "0 3 * * *" });
  expect(schedule.status).toBe(201);
  const calls: [string, string, string, unknown?][] = [
    ["schedules", "DELETE", `${base}/schedules/${schedule.data.id}`],
    ["ticket writes", "POST", `${base}/tickets/${ticket.data.id}/key-cards/tu_keys`, { keys: { SENTRY_AUTH_TOKEN: "abc-12345678" } }],
    ["extras", "POST", `${base}/find-links`, {}],
    ["quick chats", "POST", `${base}/chats`, { text: "hello" }],
    ["helper", "POST", "/api/helper/settings", { nightOptIn: true }],
    ["outside services", "POST", "/api/passes", { kind: "key", name: "Linear", secret: "lin_api_12345678" }],
    ["board browsers", "POST", "/api/board-browsers", { name: "From a run" }],
    ["huddles", "POST", `${base}/huddles`, { ticketId: ticket.data.id, roster: [{ preset: "reviewer" }] }],
  ];
  for (const [what, method, path, body] of calls) {
    const r = await phone(d, method, path, body);
    expect({ what, status: r.status, error: r.data?.error ?? r.text }).toMatchObject({ what, status: 403 });
    expect(String(r.data?.error ?? r.text)).toMatch(/for the user only|only the user/);
  }
  // Nothing changed: the schedule is still there and no huddle started.
  expect((await d.api("GET", `${base}/schedules`)).data.map((s: any) => s.id)).toContain(schedule.data.id);
  expect((await d.api("GET", `${base}/huddles`)).data).toEqual([]);
});
