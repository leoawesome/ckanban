// Sends one request the way the user's own web browser would, for routes marked "user only" in contracts/api.md.
// The daemon decides who is on the other end of a local connection by the process that holds it (`ps` shows its
// executable path), and only a web browser it didn't start counts as the user. So the request is sent by a short-lived
// Bun process started through a symlink named "Google Chrome": no real browser is opened or touched.
// Run as a script (the child) it sends the request given as JSON in argv[2] and prints the answer as JSON.
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface UserAnswer<T = any> {
  status: number;
  data: T;
  text: string;
  headers: Record<string, string>;
}

let link: string | null = null;

/** The symlink, made once per test process; the folder sits in the temp folder like the daemons' own. */
function chromeLink(): string {
  if (link) return link;
  const dir = mkdtempSync(join(tmpdir(), "ck-contract-userbrowser-"));
  link = join(dir, "Google Chrome");
  symlinkSync(process.execPath, link);
  return link;
}

/** A request from "the user's browser": the board's Origin (left out with noOrigin, as a same-origin GET) plus a JSON body when given. */
export async function asUser<T = any>(base: string, method: string, path: string, body?: unknown, opts: { noOrigin?: boolean } = {}): Promise<UserAnswer<T>> {
  const req = {
    url: base + path,
    method,
    headers: { ...(opts.noOrigin ? {} : { origin: base }), ...(body === undefined && method === "GET" ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const p = Bun.spawn([chromeLink(), import.meta.path, JSON.stringify(req)], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`user browser request failed (${code}): ${err}`);
  const r = JSON.parse(out) as { status: number; text: string; headers: Record<string, string> };
  let data: any = null;
  try {
    data = r.text ? JSON.parse(r.text) : null;
  } catch {}
  return { ...r, data };
}

if (import.meta.main) {
  const req = JSON.parse(process.argv[2]!);
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const text = res.headers.get("content-type")?.includes("image/") ? `<${(await res.arrayBuffer()).byteLength} bytes>` : await res.text();
  process.stdout.write(JSON.stringify({ status: res.status, text, headers: Object.fromEntries(res.headers) }));
}
