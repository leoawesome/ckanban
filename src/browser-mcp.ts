// `ckanban browser-mcp --id <id> --name <name> --dir <data folder> --out <folder>`: a stdio MCP server that drives one
// board browser (src/server/board-browsers.ts) over its local debugging port. Each run gets one per browser it may use,
// named browser-<id>, so its tools are mcp__browser-<id>__browser_*. Hand-rolled (no Node, no Playwright): it is part of
// the ckanban binary and talks the Chrome DevTools Protocol directly (src/server/cdp.ts).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { boardPort } from "./client";
import { Cdp, CdpError, portMatches, readPortFile, type PortFile } from "./server/cdp";
import { VERSION } from "./server/version";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SNAPSHOT_MAX = 40_000;
const RESULT_MAX = 20_000;
const LOAD_WAIT_MS = 30_000;

export interface BrowserMcpOptions {
  id: string;
  name: string;
  dir: string;
  out: string;
  /** Asks the daemon to start the browser when it isn't running (tests pass a fake). */
  ensure?: () => Promise<void>;
}

export class ToolError extends Error {}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (v: unknown) => JSON.stringify(v);

/** Page-side helpers: element refs from browser_snapshot live in a Map on the page (no attributes added to it). */
const PAGE_LIB = `
const CK = (window[Symbol.for("ckanban.refs")] ??= { n: 0, map: new Map(), back: new WeakMap() });
const ckEl = (ref, sel) => {
  if (ref) {
    const w = CK.map.get(ref); const el = w && w.deref();
    if (!el || !el.isConnected) throw new Error("ref " + ref + " is gone from the page: take a new browser_snapshot");
    return el;
  }
  if (!sel) throw new Error("give ref (from browser_snapshot) or selector");
  const el = document.querySelector(sel);
  if (!el) throw new Error("nothing on the page matches " + sel);
  return el;
};`;

export const SNAPSHOT_JS = `(() => {${PAGE_LIB}
const ROLES = new Set(["link","button","checkbox","radio","textbox","searchbox","combobox","tab","menuitem","menuitemcheckbox","option","switch","slider","treeitem","row","gridcell","listitem"]);
const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const shown = (el) => { const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden") return false; const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0 || s.display === "contents"; };
const roleOf = (el) => {
  const r = el.getAttribute("role"); if (r) return r;
  const t = el.tagName.toLowerCase();
  if (t === "a" && el.hasAttribute("href")) return "link";
  if (t === "button" || t === "summary") return "button";
  if (t === "select") return "combobox";
  if (t === "textarea") return "textbox";
  if (t === "input") { const ty = (el.type || "text").toLowerCase(); if (ty === "hidden") return null; if (["button","submit","reset","image"].includes(ty)) return "button"; if (ty === "checkbox" || ty === "radio") return ty; if (ty === "search") return "searchbox"; return "textbox"; }
  if (el.isContentEditable && el.hasAttribute("contenteditable")) return "textbox";
  if (/^h[1-6]$/.test(t)) return "heading";
  if (t === "img") return "img";
  if (t === "iframe") return "iframe";
  return null;
};
const nameOf = (el) => {
  const lb = el.getAttribute("aria-labelledby");
  const by = lb ? clean(lb.split(/\\s+/).map((i) => document.getElementById(i)?.innerText || "").join(" ")) : "";
  return cut(clean(el.getAttribute("aria-label")) || by || clean(el.getAttribute("alt")) || clean(el.getAttribute("title")) || clean(el.getAttribute("placeholder")) || clean(el.innerText) || clean(el.value), 100);
};
const refOf = (el) => { let r = CK.back.get(el); if (!r) { r = "e" + (++CK.n); CK.back.set(el, r); CK.map.set(r, new WeakRef(el)); } return r; };
const lines = []; let size = 0; let more = 0;
const add = (depth, s) => { if (size > ${SNAPSHOT_MAX}) { more++; return; } const l = "  ".repeat(Math.min(depth, 8)) + s; lines.push(l); size += l.length + 1; };
const walk = (node, depth, inside) => {
  for (const c of node.childNodes) {
    if (c.nodeType === 3) { if (!inside) { const t = clean(c.textContent); if (t) add(depth, "- text: " + JSON.stringify(cut(t, 300))); } continue; }
    if (c.nodeType !== 1) continue;
    const el = c; const tag = el.tagName.toLowerCase();
    if (["script","style","noscript","template","svg","head"].includes(tag)) continue;
    if (!shown(el)) continue;
    const role = roleOf(el);
    const ti = el.getAttribute("tabindex");
    const act = (role && ROLES.has(role)) || (ti !== null && Number(ti) >= 0 && el !== document.body);
    if (role === "iframe") { add(depth, "- iframe " + JSON.stringify(cut(el.src || "", 80)) + " (contents not shown)"); continue; }
    if (role === "heading") { add(depth, "- heading " + JSON.stringify(nameOf(el)) + " [level=" + (tag[1] || el.getAttribute("aria-level") || "?") + "]"); continue; }
    if (role === "img") { const n = nameOf(el); if (n) add(depth, "- img " + JSON.stringify(n)); continue; }
    if (act) {
      let extra = "";
      if (role === "checkbox" || role === "radio" || role === "switch") extra += el.checked || el.getAttribute("aria-checked") === "true" ? " [checked]" : "";
      if ((role === "textbox" || role === "searchbox" || role === "combobox") && "value" in el && el.value) extra += " value=" + JSON.stringify(cut(String(el.value), 200));
      if (el.disabled || el.getAttribute("aria-disabled") === "true") extra += " [disabled]";
      if (el.getAttribute("aria-selected") === "true") extra += " [selected]";
      add(depth, "- " + (role || "clickable") + " " + JSON.stringify(nameOf(el)) + extra + " [ref=" + refOf(el) + "]");
      walk(el, depth + 1, true);
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1, true);
      continue;
    }
    walk(el, depth, inside);
    if (el.shadowRoot) walk(el.shadowRoot, depth, inside);
  }
};
if (document.body) walk(document.body, 0, false);
if (more) lines.push("… " + more + " more lines cut. Scroll (browser_press_key PageDown) or use browser_evaluate for the rest.");
return lines.join("\\n");
})()`;

const KEYS: Record<string, { code: number; key: string; text?: string }> = {
  Enter: { code: 13, key: "Enter", text: "\r" }, Tab: { code: 9, key: "Tab" }, Escape: { code: 27, key: "Escape" },
  Backspace: { code: 8, key: "Backspace" }, Delete: { code: 46, key: "Delete" }, Space: { code: 32, key: " ", text: " " },
  ArrowUp: { code: 38, key: "ArrowUp" }, ArrowDown: { code: 40, key: "ArrowDown" }, ArrowLeft: { code: 37, key: "ArrowLeft" },
  ArrowRight: { code: 39, key: "ArrowRight" }, PageUp: { code: 33, key: "PageUp" }, PageDown: { code: 34, key: "PageDown" },
  Home: { code: 36, key: "Home" }, End: { code: 35, key: "End" },
};
const MODS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };

/** "Meta+A", "Enter", "a": the CDP key events for it. */
export function keyEvent(spec: string): { modifiers: number; key: string; code: number; text?: string } {
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new ToolError("give a key, like Enter or Meta+A");
  let modifiers = 0;
  for (const m of parts.slice(0, -1)) {
    if (!(m in MODS)) throw new ToolError(`unknown modifier ${m} (use Alt, Control, Meta or Shift)`);
    modifiers |= MODS[m];
  }
  const last = parts[parts.length - 1];
  const known = KEYS[last];
  if (known) return { modifiers, ...known };
  if (last.length === 1) {
    const ch = modifiers & 8 ? last.toUpperCase() : last;
    return { modifiers, key: ch, code: ch.toUpperCase().charCodeAt(0), ...(modifiers & ~8 ? {} : { text: ch }) };
  }
  throw new ToolError(`unknown key ${last}`);
}

function siteOk(url: string): string {
  const s = url.trim();
  if (s === "about:blank") return s;
  const full = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(full);
  } catch {
    throw new ToolError(`not a web address: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ToolError("only http and https pages can be opened");
  return u.toString();
}

const REF = { type: "string", description: "The element's ref from the last browser_snapshot, e.g. e12." };
const SELECTOR = { type: "string", description: "A CSS selector instead of ref." };
const ELEMENT = { type: "string", description: "What the element is, in a few words (for the record)." };

export class BrowserMcp {
  private cdp: Cdp | null = null;
  private pf: PortFile | null = null;
  private own = new Set<string>();
  private current: { targetId: string; sessionId: string } | null = null;
  private notes: string[] = [];

  constructor(private o: BrowserMcpOptions) {}

  private notRunning(): ToolError {
    return new ToolError(`The board browser "${this.o.name}" isn't running and couldn't be started. Tell the user it isn't available right now; don't use another browser in its place.`);
  }

  private async connect(): Promise<Cdp> {
    if (this.cdp && !this.cdp.closed) return this.cdp;
    this.cdp = null;
    this.current = null;
    let pf = await readPortFile(this.o.dir);
    if (!pf || !(await portMatches(pf))) {
      // Not running (it crashed, or was closed): the daemon starts it again, then the new port is read.
      try {
        await this.o.ensure?.();
      } catch {}
      pf = await readPortFile(this.o.dir);
      if (!pf || !(await portMatches(pf))) throw this.notRunning();
    }
    this.pf = pf;
    const cdp = await Cdp.connect(pf.port, pf.path).catch(() => {
      throw this.notRunning();
    });
    cdp.on((method, params, sessionId) => {
      if (method === "Page.javascriptDialogOpening" && sessionId) {
        // An alert or confirm would freeze the page: dismiss it (never confirm), and say so in the next answer.
        const accept = params?.type === "alert" || params?.type === "beforeunload";
        void cdp.send("Page.handleJavaScriptDialog", { accept }, sessionId).catch(() => {});
        this.notes.push(`The page showed a ${params?.type} dialog ("${String(params?.message ?? "").slice(0, 200)}"); it was ${accept ? "closed" : "dismissed (cancelled)"}.`);
      }
      if (method === "Target.detachedFromTarget" && this.current?.sessionId === params?.sessionId) this.current = null;
    });
    this.cdp = cdp;
    return cdp;
  }

  private async attach(targetId: string): Promise<{ targetId: string; sessionId: string }> {
    const cdp = await this.connect();
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId).catch(() => {});
    this.current = { targetId, sessionId };
    return this.current;
  }

  private async newTab(url = "about:blank"): Promise<{ targetId: string; sessionId: string }> {
    const cdp = await this.connect();
    const { targetId } = await cdp.send("Target.createTarget", { url: siteOk(url), background: true });
    this.own.add(targetId);
    return this.attach(targetId);
  }

  /** The tab this run works in: the selected one, else a new tab of its own. */
  private async page(): Promise<{ targetId: string; sessionId: string }> {
    const cdp = await this.connect();
    if (this.current) {
      try {
        await cdp.send("Target.getTargetInfo", { targetId: this.current.targetId });
        return this.current;
      } catch {
        this.own.delete(this.current.targetId);
        this.current = null;
      }
    }
    return this.newTab();
  }

  /** timeoutMs: how long to wait for the page (a busy page, like WhatsApp Web syncing, can take long to answer). */
  private async evaluate(expression: string, sessionId: string, timeoutMs = 30_000): Promise<any> {
    const cdp = await this.connect();
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId, timeoutMs);
    if (r.exceptionDetails) throw new ToolError(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "the page script failed").split("\n")[0]);
    return r.result?.value;
  }

  private async waitReady(sessionId: string, ms = LOAD_WAIT_MS): Promise<boolean> {
    const end = Date.now() + ms;
    await sleep(150);
    while (Date.now() < end) {
      try {
        if ((await this.evaluate("document.readyState", sessionId, Math.max(500, Math.min(5000, end - Date.now())))) === "complete") return true;
      } catch {}
      await sleep(250);
    }
    return false;
  }

  private async where(sessionId: string): Promise<string> {
    try {
      const v = await this.evaluate("({ t: document.title, u: location.href })", sessionId, 5000);
      return `Page: ${v.t || "(no title)"}\nAddress: ${v.u}`;
    } catch {
      return "(The page is busy and didn't answer yet.)";
    }
  }

  private async tabs(): Promise<{ targetId: string; title: string; url: string }[]> {
    const cdp = await this.connect();
    const { targetInfos } = await cdp.send("Target.getTargets");
    return (targetInfos as any[]).filter((t) => t.type === "page").map((t) => ({ targetId: t.targetId, title: t.title, url: t.url }));
  }

  private async point(ref: string | undefined, selector: string | undefined, sessionId: string): Promise<{ x: number; y: number; covered: boolean }> {
    return this.evaluate(`(() => {${PAGE_LIB}
const el = ckEl(${q(ref ?? null)}, ${q(selector ?? null)});
el.scrollIntoView({ block: "center", inline: "center" });
const r = el.getBoundingClientRect();
const x = r.left + r.width / 2, y = r.top + r.height / 2;
const top = document.elementFromPoint(x, y);
return { x, y, covered: !!top && top !== el && !el.contains(top) && !top.contains(el) };
})()`, sessionId);
  }

  private async key(spec: string, sessionId: string): Promise<void> {
    const cdp = await this.connect();
    const k = keyEvent(spec);
    const base = { modifiers: k.modifiers, key: k.key, windowsVirtualKeyCode: k.code, nativeVirtualKeyCode: k.code };
    await cdp.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
  }

  readonly tools: { name: string; description: string; inputSchema: object; run: (a: any) => Promise<Content[] | string> }[] = [
    {
      name: "browser_tabs",
      description: "List, open, select or close tabs. list: all tabs, with yours and the current one marked. new: open a tab of your own (optionally at url) and work there. select: work in tab number index (e.g. a site that is already open). close: close a tab you opened (never someone else's).",
      inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "new", "select", "close"] }, index: { type: "number", description: "Tab number from list (select, close)." }, url: { type: "string", description: "Address for new." } }, required: ["action"] },
      run: async (a) => {
        const action = String(a.action ?? "list");
        if (action === "new") {
          const s = await this.newTab(a.url ? String(a.url) : "about:blank");
          if (a.url) await this.waitReady(s.sessionId);
          return `Opened a new tab of your own.\n${await this.where(s.sessionId)}`;
        }
        const list = await this.tabs();
        const pick = () => {
          const i = a.index === undefined ? list.findIndex((t) => t.targetId === this.current?.targetId) : Number(a.index);
          const t = list[i];
          if (!t) throw new ToolError("no tab with that number: call browser_tabs with action list");
          return t;
        };
        if (action === "select") {
          const t = pick();
          const s = await this.attach(t.targetId);
          return `Working in tab ${list.indexOf(t)} now.\n${await this.where(s.sessionId)}`;
        }
        if (action === "close") {
          const t = pick();
          if (!this.own.has(t.targetId)) throw new ToolError("That tab wasn't opened by this task: leave it open.");
          await (await this.connect()).send("Target.closeTarget", { targetId: t.targetId });
          this.own.delete(t.targetId);
          if (this.current?.targetId === t.targetId) this.current = null;
          return "Closed your tab.";
        }
        if (!list.length) return "No tabs are open.";
        return list.map((t, i) => `${i}: ${t.title || "(no title)"} - ${t.url}${this.own.has(t.targetId) ? " (yours)" : ""}${t.targetId === this.current?.targetId ? " (current)" : ""}`).join("\n");
      },
    },
    {
      name: "browser_navigate",
      description: "Open a web address in the current tab (a new tab of your own if you have none yet) and wait for it to load. Some sites keep loading after this: use browser_wait_for for what you need.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      run: async (a) => {
        const url = siteOk(String(a.url ?? ""));
        const s = await this.page();
        const r = await (await this.connect()).send("Page.navigate", { url }, s.sessionId);
        if (r.errorText) throw new ToolError(`couldn't open ${url}: ${r.errorText}`);
        const ready = await this.waitReady(s.sessionId);
        return `${await this.where(s.sessionId)}${ready ? "" : "\n(Still loading: use browser_wait_for.)"}`;
      },
    },
    {
      name: "browser_navigate_back",
      description: "Go back to the previous page in the current tab.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const s = await this.page();
        await this.evaluate("history.back()", s.sessionId);
        await this.waitReady(s.sessionId);
        return this.where(s.sessionId);
      },
    },
    {
      name: "browser_snapshot",
      description: "Read the current page as text: headings, text, and the elements you can act on, each with a ref (e.g. [ref=e12]) for browser_click, browser_type and others. Take a new one after the page changes.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const s = await this.page();
        const body = await this.evaluate(SNAPSHOT_JS, s.sessionId);
        return `${await this.where(s.sessionId)}\n\n${body || "(the page shows nothing yet)"}`;
      },
    },
    {
      name: "browser_click",
      description: "Click an element (by ref from browser_snapshot, or a CSS selector).",
      inputSchema: { type: "object", properties: { element: ELEMENT, ref: REF, selector: SELECTOR, doubleClick: { type: "boolean" } } },
      run: async (a) => {
        const s = await this.page();
        const cdp = await this.connect();
        const p = await this.point(a.ref, a.selector, s.sessionId);
        const clickCount = a.doubleClick ? 2 : 1;
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }, s.sessionId);
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount }, s.sessionId);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount }, s.sessionId);
        await sleep(400);
        return `Clicked.${p.covered ? " (Another element covered it: check the result with browser_snapshot.)" : ""}\n${await this.where(s.sessionId)}`;
      },
    },
    {
      name: "browser_type",
      description: "Type text into a field (by ref or selector), replacing what is in it. submit: press Enter after.",
      inputSchema: { type: "object", properties: { element: ELEMENT, ref: REF, selector: SELECTOR, text: { type: "string" }, submit: { type: "boolean" } }, required: ["text"] },
      run: async (a) => {
        const s = await this.page();
        await this.evaluate(`(() => {${PAGE_LIB}
const el = ckEl(${q(a.ref ?? null)}, ${q(a.selector ?? null)});
el.scrollIntoView({ block: "center" }); el.focus();
if ("select" in el && typeof el.select === "function") el.select();
else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
})()`, s.sessionId);
        await (await this.connect()).send("Input.insertText", { text: String(a.text ?? "") }, s.sessionId);
        if (a.submit) await this.key("Enter", s.sessionId);
        await sleep(200);
        return `Typed.${a.submit ? " Pressed Enter." : ""}`;
      },
    },
    {
      name: "browser_press_key",
      description: "Press a key in the page: Enter, Tab, Escape, ArrowDown, PageDown, a letter, or with modifiers like Meta+A.",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      run: async (a) => {
        const s = await this.page();
        await this.key(String(a.key ?? ""), s.sessionId);
        await sleep(200);
        return `Pressed ${a.key}.`;
      },
    },
    {
      name: "browser_select_option",
      description: "Choose option(s) in a dropdown (select element) by their value or visible text.",
      inputSchema: { type: "object", properties: { element: ELEMENT, ref: REF, selector: SELECTOR, values: { type: "array", items: { type: "string" } } }, required: ["values"] },
      run: async (a) => {
        const s = await this.page();
        const n = await this.evaluate(`(() => {${PAGE_LIB}
const el = ckEl(${q(a.ref ?? null)}, ${q(a.selector ?? null)});
const want = ${q((Array.isArray(a.values) ? a.values : []).map(String))};
let n = 0;
for (const o of el.options || []) { o.selected = want.includes(o.value) || want.includes(o.text.trim()); if (o.selected) n++; }
el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
return n;
})()`, s.sessionId);
        return n ? `Selected ${n} option(s).` : "No option matched.";
      },
    },
    {
      name: "browser_evaluate",
      description: "Run a JavaScript function in the page and get its result as JSON, e.g. \"() => document.title\". With ref, the function gets that element: \"(el) => el.innerText\".",
      inputSchema: { type: "object", properties: { function: { type: "string" }, element: ELEMENT, ref: REF }, required: ["function"] },
      run: async (a) => {
        const s = await this.page();
        const fn = String(a.function ?? "");
        const call = a.ref ? `(() => {${PAGE_LIB}\nreturn (${fn})(ckEl(${q(a.ref)}, null));})()` : `(${fn})()`;
        const v = await this.evaluate(call, s.sessionId);
        const text = v === undefined ? "undefined" : JSON.stringify(v, null, 1);
        return text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n… (cut, ${text.length} characters in all)` : text;
      },
    },
    {
      name: "browser_wait_for",
      description: "Wait until text shows on the page, text is gone, or a CSS selector matches (up to timeout seconds, default 30, at most 120); or just wait time seconds. Use this, not a fixed delay, for slow pages like WhatsApp Web.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, textGone: { type: "string" }, selector: { type: "string" }, time: { type: "number" }, timeout: { type: "number" } } },
      run: async (a) => {
        const s = await this.page();
        if (a.time !== undefined && a.text === undefined && a.textGone === undefined && a.selector === undefined) {
          const secs = Math.min(Math.max(Number(a.time) || 0, 0), 60);
          await sleep(secs * 1000);
          return `Waited ${secs}s.`;
        }
        const end = Date.now() + Math.min(Math.max(Number(a.timeout) || 30, 1), 120) * 1000;
        const check = `(() => { const t = document.body ? document.body.innerText : "";
  return ${a.text !== undefined ? `t.includes(${q(String(a.text))})` : "true"}
    && ${a.textGone !== undefined ? `!t.includes(${q(String(a.textGone))})` : "true"}
    && ${a.selector !== undefined ? `!!document.querySelector(${q(String(a.selector))})` : "true"}; })()`;
        while (Date.now() < end) {
          try {
            if (await this.evaluate(check, s.sessionId, Math.max(500, Math.min(5000, end - Date.now())))) return `Ready.\n${await this.where(s.sessionId)}`;
          } catch {}
          await sleep(400);
        }
        throw new ToolError("Timed out waiting. Take a browser_snapshot to see what the page shows.");
      },
    },
    {
      name: "browser_take_screenshot",
      description: "Take a picture of the current tab (fullPage: the whole page). It is saved as a file and shown to you.",
      inputSchema: { type: "object", properties: { fullPage: { type: "boolean" }, filename: { type: "string", description: "File name (saved in the task's output folder)." } } },
      run: async (a) => {
        const s = await this.page();
        const cdp = await this.connect();
        const opts: Record<string, unknown> = { format: "png" };
        if (a.fullPage) {
          const m = await cdp.send("Page.getLayoutMetrics", {}, s.sessionId);
          const size = m.cssContentSize ?? m.contentSize;
          opts.captureBeyondViewport = true;
          opts.clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 16_000), scale: 1 };
        }
        const { data } = await cdp.send("Page.captureScreenshot", opts, s.sessionId);
        mkdirSync(this.o.out, { recursive: true });
        const name = a.filename ? basename(String(a.filename)).replace(/[^\w.-]+/g, "-").replace(/(\.png)?$/i, ".png") : `${this.o.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        const file = join(this.o.out, name);
        writeFileSync(file, Buffer.from(data, "base64"));
        return [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: `Saved to ${file}` }];
      },
    },
    {
      name: "browser_file_upload",
      description: "Put files (absolute paths on this Mac) into a file field (by ref or selector), as if picked in a file dialog.",
      inputSchema: { type: "object", properties: { element: ELEMENT, ref: REF, selector: SELECTOR, paths: { type: "array", items: { type: "string" } } }, required: ["paths"] },
      run: async (a) => {
        const s = await this.page();
        const cdp = await this.connect();
        const paths = (Array.isArray(a.paths) ? a.paths : []).map(String);
        for (const p of paths) if (!isAbsolute(p) || !existsSync(p)) throw new ToolError(`no file at ${p}`);
        const r = await cdp.send("Runtime.evaluate", { expression: `(() => {${PAGE_LIB}\nreturn ckEl(${q(a.ref ?? null)}, ${q(a.selector ?? null)});})()` }, s.sessionId);
        if (r.exceptionDetails || !r.result?.objectId) throw new ToolError(String(r.exceptionDetails?.exception?.description ?? "element not found").split("\n")[0]);
        await cdp.send("DOM.setFileInputFiles", { files: paths, objectId: r.result.objectId }, s.sessionId);
        return `Added ${paths.length} file(s).`;
      },
    },
  ];

  async call(name: string, args: unknown): Promise<{ content: Content[]; isError?: boolean }> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
    try {
      const out = await tool.run(args && typeof args === "object" ? args : {});
      const content: Content[] = typeof out === "string" ? [{ type: "text", text: out }] : out;
      if (this.notes.length) content.push({ type: "text", text: this.notes.splice(0).join("\n") });
      return { content };
    } catch (e) {
      // A dropped connection (Chrome restarted): the next call connects again.
      if (e instanceof CdpError && this.cdp?.closed) this.cdp = null;
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }

  async handle(msg: any): Promise<object | null> {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
    switch (msg?.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: `browser-${this.o.id}`, version: VERSION },
          instructions: `Tools for the board browser "${this.o.name}": a Chrome the board keeps with its own saved logins, separate from the user's Chrome. Work in a tab of your own; never close tabs you didn't open.`,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description: `${description} (Board browser "${this.o.name}".)`, inputSchema })) });
      case "tools/call":
        return reply(await this.call(String(msg.params?.name ?? ""), msg.params?.arguments));
      default:
        return msg?.id !== undefined && msg?.id !== null ? { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg?.method}` } } : null;
    }
  }

  /** The run ended: close the tabs this run opened (never others), then let go of the browser. */
  async end(): Promise<void> {
    const cdp = this.cdp;
    if (cdp && !cdp.closed) {
      await Promise.all([...this.own].map((targetId) => cdp.send("Target.closeTarget", { targetId }, undefined, 3000).catch(() => {})));
      cdp.close();
    }
    this.cdp = null;
  }
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function serveBrowserMcp(argv: string[]): Promise<void> {
  const id = arg(argv, "id");
  const dir = arg(argv, "dir");
  if (!id || !dir) {
    console.error("usage: ckanban browser-mcp --id <id> --dir <data folder> [--name <name>] [--out <folder>]");
    process.exit(1);
  }
  const mcp = new BrowserMcp({
    id, dir, name: arg(argv, "name") ?? id, out: arg(argv, "out") ?? join(dir, "..", "..", "browser-files", id),
    ensure: async () => {
      await fetch(`http://localhost:${boardPort()}/api/board-browsers/${encodeURIComponent(id)}/ensure`, { method: "POST", signal: AbortSignal.timeout(45_000) });
    },
  });
  // Claude Code ends a tool server with a signal (not only by closing its input): close this run's tabs either way.
  let ending: Promise<void> | null = null;
  const finish = () => {
    ending ??= Promise.race([mcp.end(), sleep(4000)]).then(() => process.exit(0));
    return ending;
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void finish());
  const write = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
  const decoder = new TextDecoder();
  let buf = "";
  const pending: Promise<void>[] = [];
  const handle = (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      pending.push(mcp.handle(m).then((r) => void (r && write(r)), (e) => {
        if (m?.id !== undefined) write({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: (e as Error).message } });
      }));
    }
  };
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf);
  await Promise.all(pending);
  await finish();
}
