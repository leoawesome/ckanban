// The satellite's edge over HTTP (docs/rust-port-board-plan.md 3.3), the Bun half of rust/board/src/gate/edge.rs.
// Only in satellite mode (core/satellite.ts): the Rust board owns the board and this daemon keeps the helper and the
// outside services. Every call carries SATELLITE_HEADER with the front server's secret; the front drops any copy a
// caller sends, so a request passed through can never be one of these.
//
// - Rust to this daemon: `POST /api/internal/<name>` on the internal port (`internalRoute`): frontdesk-gate,
//   pass-call, publish, turn-ended.
// - This daemon to Rust: `POST /api/internal/<name>` on the board's port (`rustCall`): chat-from-telegram,
//   patch-telegram, drop-telegram-queued, comment, replay.
import { timingSafeEqual } from "node:crypto";
import type { TelegramBoard } from "../helper/notify";
import type { Replay } from "../helper/frontdesk";
import type { Front } from "./front";

export const SATELLITE_HEADER = "x-ckanban-satellite";
export const INTERNAL_PREFIX = "/api/internal/";

/** Whether a request is one of the Rust board's own edge calls (the header holds this start's secret). */
export function fromEdge(req: Request, front: Front | null): boolean {
  if (!front) return false;
  const got = req.headers.get(SATELLITE_HEADER);
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(front.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface EdgeHandlers {
  frontdeskGate: (desk: string, method: string, path: string, body: unknown) => Promise<{ status: number; body: unknown } | null>;
  passCall: (b: Record<string, unknown>) => Promise<{ status: number; body: unknown; rateLimitMs?: number }>;
  publish: (job: any) => Promise<unknown>;
  turnEnded: (slug: string, id: string, text: string) => Promise<void>;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Answers one edge call from the Rust board; null when `pathname` isn't an edge route. */
export async function internalRoute(req: Request, pathname: string, h: EdgeHandlers): Promise<Response | null> {
  if (!pathname.startsWith(INTERNAL_PREFIX) || req.method !== "POST") return null;
  const name = pathname.slice(INTERNAL_PREFIX.length);
  let b: any = null;
  try {
    b = await req.json();
  } catch {}
  b = b && typeof b === "object" ? b : {};
  try {
    switch (name) {
      case "frontdesk-gate":
        return json({ held: await h.frontdeskGate(String(b.desk ?? ""), String(b.method ?? "GET"), String(b.path ?? ""), b.body ?? null) });
      case "pass-call":
        return json(await h.passCall(b));
      case "publish":
        return json(await h.publish(b));
      case "turn-ended":
        await h.turnEnded(String(b.slug ?? ""), String(b.id ?? ""), String(b.text ?? ""));
        return json({ ok: true });
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

/** One call to the Rust board's `/api/internal/<name>`: its status and JSON answer. */
export async function rustCall(front: Front, name: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${front.publicPort}${INTERNAL_PREFIX}${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", [SATELLITE_HEADER]: front.secret },
    body: JSON.stringify(body ?? null),
  });
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, body: data };
}

function logFailed(what: string, r: { status: number; body: any }) {
  if (r.status >= 300) console.error(`satellite: the Rust board's ${what}: ${r.status} ${r.body?.error ?? ""}`);
}

/** The Telegram router's board (notify.ts TelegramBoard), on the Rust board. */
export function rustTelegramBoard(front: Front): TelegramBoard {
  return {
    async chatFromTelegram(slug, id, text, from) {
      const { still: _still, ...rest } = from;
      const r = await rustCall(front, "chat-from-telegram", { slug, id, text, from: rest });
      if (r.status >= 300) throw new Error(r.body?.error ?? `the Rust board answered ${r.status}`);
      return r.body?.sent === true;
    },
    patchTelegram(slug, id, patch) {
      void rustCall(front, "patch-telegram", { slug, id, patch }).then((r) => logFailed("patch-telegram", r), (e) => console.error("satellite: patch-telegram", e));
      return null;
    },
    dropTelegramQueued() {
      void rustCall(front, "drop-telegram-queued", {}).then((r) => logFailed("drop-telegram-queued", r), (e) => console.error("satellite: drop-telegram-queued", e));
      return 0;
    },
  };
}

/** The notifier's comments on a ticket, written by the Rust board. */
export function rustComment(front: Front): (slug: string, id: string, author: string, text: string) => void {
  return (slug, id, author, text) => {
    void rustCall(front, "comment", { slug, id, author, text }).then((r) => logFailed("comment", r), (e) => console.error("satellite: comment", e));
  };
}

/** A held front desk request after the user's Confirm, run by the Rust board as the user. */
export function rustReplay(front: Front): Replay {
  return async (method, path, body) => {
    const r = await rustCall(front, "replay", { method, path, body: body ?? null });
    if (r.status >= 300) return { status: r.status, body: r.body };
    return { status: Number(r.body?.status) || 500, body: r.body?.body ?? null };
  };
}
