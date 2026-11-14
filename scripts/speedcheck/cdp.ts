/** Headless Chrome over the DevTools protocol, just what the speed check needs (no Puppeteer). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome(): string | null {
  for (const c of CANDIDATES) if (c && existsSync(c)) return c;
  return null;
}

export type Chrome = { proc: Subprocess; port: number };

/** Starts headless Chrome with its own profile folder; the DevTools port is picked by Chrome and read back. */
export async function launchChrome(bin: string, profileDir: string): Promise<Chrome> {
  const proc = Bun.spawn([bin, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run",
    "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const file = join(profileDir, "DevToolsActivePort");
  for (let i = 0; i < 150; i++) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (port) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return { proc, port };
        } catch {}
      }
    }
    if (proc.exitCode !== null) break;
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error("headless Chrome did not start");
}

export type Rect = { x: number; y: number; w: number; h: number };

export class Page {
  private id = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  /** Uncaught page errors and console.error lines since the last take. */
  errors: string[] = [];

  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(`${m.error.message}`));
        else p.res(m.result);
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        this.errors.push(String(d.exception?.description ?? d.text ?? "error").split("\n")[0].slice(0, 300));
      } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        this.errors.push(m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ").split("\n")[0].slice(0, 300));
      }
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.rej(new Error("Chrome tab closed"));
      this.pending.clear();
    };
  }

  static async open(chrome: Chrome): Promise<Page> {
    const t = (await (await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, { method: "PUT" })).json()) as any;
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("cannot reach the Chrome tab"));
    });
    const p = new Page(ws);
    await p.send("Page.enable");
    await p.send("Runtime.enable");
    await p.send("Page.bringToFront");
    // A headless tab that isn't focused pauses requestAnimationFrame, which the board's lists wait for.
    await p.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    return p;
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<any> {
    const i = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(i);
        rej(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(i, { res: (v) => (clearTimeout(timer), res(v)), rej: (e) => (clearTimeout(timer), rej(e)) });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }

  async eval<T = any>(expr: string, timeoutMs = 60_000): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split("\n")[0]);
    return r.result?.value as T;
  }

  async size(width: number, height: number, phone: boolean): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
    await this.send("Emulation.setTouchEmulationEnabled", phone ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  }

  async goto(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
  }

  /** Waits until `expr` is truthy in the page; returns the ms it took, or null after `timeoutMs`. */
  async waitFor(expr: string, timeoutMs = 15_000, everyMs = 30): Promise<number | null> {
    const t = performance.now();
    while (performance.now() - t < timeoutMs) {
      try {
        if (await this.eval(`!!(${expr})`)) return performance.now() - t;
      } catch {}
      await Bun.sleep(everyMs);
    }
    return null;
  }

  /** Center of the element `sel` (a JS expression), scrolled into view; null when it isn't there. */
  rect(sel: string): Promise<Rect | null> {
    return this.eval(`(() => { const e = ${sel}; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
  }

  private mouse(type: string, x: number, y: number, buttons = 1) {
    return this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : buttons, clickCount: 1 });
  }

  async click(r: Rect): Promise<void> {
    await this.mouse("mouseMoved", r.x, r.y, 0);
    await this.mouse("mousePressed", r.x, r.y);
    await this.mouse("mouseReleased", r.x, r.y);
  }

  async tap(r: Rect): Promise<void> {
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x, y: r.y }] });
    await Bun.sleep(60);
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  async drag(a: Rect, b: { x: number; y: number }, steps = 12): Promise<void> {
    await this.mouse("mouseMoved", a.x, a.y, 0);
    await this.mouse("mousePressed", a.x, a.y);
    for (let i = 1; i <= steps; i++) {
      await this.mouse("mouseMoved", a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
      await Bun.sleep(30);
    }
    await Bun.sleep(150);
    await this.mouse("mouseReleased", b.x, b.y);
  }

  async key(key: string, modifiers = 0, code = key): Promise<void> {
    const vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined;
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, windowsVirtualKeyCode: vk });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: vk });
  }

  type(text: string): Promise<void> {
    return this.send("Input.insertText", { text });
  }

  async screenshot(file: string): Promise<void> {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    await Bun.write(file, Buffer.from(r.data, "base64"));
  }

  takeErrors(): string[] {
    const e = this.errors;
    this.errors = [];
    return e;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}
