// The Rust front server (rust/, `ckanban-rs dev`) can sit in front of this daemon: it listens on the board's port and
// passes every request to this daemon on an internal port. Behind it every caller's TCP connection comes from the
// front server, so the checks that look up the process behind the caller's port (integrations/guard.ts, used by the
// user-only routes in api/context.ts) would see the front server instead of the real caller.
//
// So the front server sends the real caller's port in FRONT_PEER_HEADER, with FRONT_SECRET_HEADER carrying a random
// secret it makes at each start. The secret reaches this daemon on stdin (first line), never in its environment: on
// macOS any process of the same user can read another's environment (`ps eww`), board runs included. The internal
// port refuses requests without the secret, and the peer header is trusted only with it.
//
// The rest of stdin stays open: the front server holds the other end, so end of input means it is gone (even when
// killed hard) and this daemon stops too. Without CKANBAN_FRONT_PORT (the daemon alone) none of this applies and the
// daemon behaves exactly as before: the headers are ignored and stdin is not read.
import { timingSafeEqual } from "node:crypto";

export const FRONT_SECRET_HEADER = "x-ckanban-front";
export const FRONT_PEER_HEADER = "x-ckanban-peer-port";

export interface Front {
  /** The board's port, where the front server listens; what the board hands out (runs, links, Host checks). */
  publicPort: number;
  secret: string;
  /** The front server's pid: its side of each caller's connection is not the caller. */
  pid: number;
}

let front: Front | null = null;

/** How long the daemon waits for the secret line before it gives up (the front writes it right after the start). */
const SECRET_WAIT_MS = 10_000;

/** The front server this daemon runs behind, or null when it runs alone. */
export function frontInfo(): Front | null {
  return front;
}

export function setFront(f: Front | null): void {
  front = f;
}

/**
 * Reads the front server's settings when CKANBAN_FRONT_PORT is set: the first line of `input` is "<secret> <front pid>" (the pid may be left out: then the parent's). Then
 * keeps reading in the background and calls `onGone` at end of input (the front server exited or was killed).
 * Throws when the port or the secret is missing or malformed: a daemon told it is behind a front must not start open.
 */
export async function readFront(
  env: Record<string, string | undefined>,
  input: ReadableStream<Uint8Array>,
  onGone: () => void,
  parentPid = process.ppid,
): Promise<Front | null> {
  const raw = env.CKANBAN_FRONT_PORT;
  if (!raw) return null;
  const publicPort = Number(raw);
  if (!Number.isInteger(publicPort) || publicPort <= 0 || publicPort > 65535) throw new Error(`CKANBAN_FRONT_PORT is not a port: ${raw}`);
  const reader = input.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + SECRET_WAIT_MS;
  while (!buf.includes("\n")) {
    const left = deadline - Date.now();
    const next = left > 0 ? await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]) : null;
    if (!next) throw new Error(`CKANBAN_FRONT_PORT is set but the front server sent no secret on stdin within ${SECRET_WAIT_MS / 1000}s`);
    const { done, value } = next;
    if (done) throw new Error("CKANBAN_FRONT_PORT is set but the front server sent no secret on stdin");
    buf += dec.decode(value, { stream: true });
    if (buf.length > 4096) throw new Error("the front server's secret line is too long");
  }
  // "<secret> <front pid>": the pid is the front server's own (a bun wrapper that doesn't exec sits between us).
  const [secret = "", pidText] = buf.slice(0, buf.indexOf("\n")).trim().split(/\s+/);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error("the front server's secret is malformed");
  const pid = pidText === undefined ? parentPid : Number(pidText);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("the front server's pid is malformed");
  void (async () => {
    try {
      while (!(await reader.read()).done);
    } catch {}
    onGone();
  })();
  return { publicPort, secret, pid };
}

/** Whether a request on the internal port carries the front server's secret (always true when there is no front). */
export function fromFront(req: Request, f: Front | null = front): boolean {
  if (!f) return true;
  const got = req.headers.get(FRONT_SECRET_HEADER);
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(f.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The caller's TCP port: from the front server's header behind a front (the request already passed fromFront),
 * else what the socket says. 0 when it can't be told, which the guards treat as "not the user".
 */
export function callerPort(req: Request, socketPort: number | undefined, f: Front | null = front): number {
  if (!f) return socketPort ?? 0;
  const n = Number(req.headers.get(FRONT_PEER_HEADER));
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
}
