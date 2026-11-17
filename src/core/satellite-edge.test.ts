import { expect, test } from "bun:test";
import { fromEdge, internalRoute, SATELLITE_HEADER, type EdgeHandlers } from "./satellite-edge";
import { confirmedByFront, FRONT_CONFIRMED_HEADER, FRONT_SECRET_HEADER, FRONT_VIA_HEADER, viaPhoneFront } from "./front";

const front = { publicPort: 7777, secret: "s".repeat(40), pid: 2 };

const req = (headers: Record<string, string>, body?: unknown, path = "/api/internal/pass-call") =>
  new Request(`http://127.0.0.1:1${path}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });

test("edge calls need this start's secret in their own header", () => {
  expect(fromEdge(req({ [SATELLITE_HEADER]: front.secret }), front)).toBe(true);
  expect(fromEdge(req({ [SATELLITE_HEADER]: "x" }), front)).toBe(false);
  expect(fromEdge(req({ [FRONT_SECRET_HEADER]: front.secret }), front)).toBe(false);
  expect(fromEdge(req({ [SATELLITE_HEADER]: front.secret }), null)).toBe(false);
});

test("the phone and confirmed marks count only with the front's secret", () => {
  const with_ = (h: Record<string, string>) => req({ [FRONT_SECRET_HEADER]: front.secret, ...h });
  expect(viaPhoneFront(with_({ [FRONT_VIA_HEADER]: "remote" }), front)).toBe(true);
  expect(viaPhoneFront(req({ [FRONT_VIA_HEADER]: "remote" }), front)).toBe(false);
  expect(viaPhoneFront(with_({ [FRONT_VIA_HEADER]: "remote" }), null)).toBe(false);
  expect(confirmedByFront(with_({ [FRONT_CONFIRMED_HEADER]: "1" }), front)).toBe(true);
  expect(confirmedByFront(req({ [FRONT_CONFIRMED_HEADER]: "1", [FRONT_SECRET_HEADER]: "nope" }), front)).toBe(false);
});

test("internal routes call the handlers and answer JSON", async () => {
  const h: EdgeHandlers = {
    passCall: async (b) => ({ status: 200, body: { result: b.tool }, rateLimitMs: 0 }),
    publish: async () => {
      throw new Error("boom");
    },
  };
  const call = async (name: string, body: unknown) => {
    const r = await internalRoute(req({}, body, `/api/internal/${name}`), `/api/internal/${name}`, h);
    return r && { status: r.status, data: await r.json() };
  };
  expect((await call("pass-call", { tool: "t" }))?.data).toEqual({ status: 200, body: { result: "t" }, rateLimitMs: 0 });
  expect(await call("publish", { file: "f" })).toEqual({ status: 500, data: { error: "boom" } });
  // Telegram's calls are the Rust board's own since P1c.
  expect((await call("frontdesk-gate", {}))?.status).toBe(404);
  expect((await call("turn-ended", {}))?.status).toBe(404);
  expect((await call("nope", {}))?.status).toBe(404);
  expect(await internalRoute(req({}), "/api/other", h)).toBeNull();
});
