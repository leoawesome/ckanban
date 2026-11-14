import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BoardBrowsers } from "../src/server/board-browsers";
import { classifyByAddress, PAGE_PROBES, probeAnswer, siteName } from "../src/server/sign-in-signs";
import { fakes, harness } from "./fake-chrome";
import { tempDir } from "./helpers";

afterEach(() => {
  for (const f of fakes.splice(0)) if (!f.closed) f.quit();
});

const WA = { id: "wa", type: "page", title: "WhatsApp", url: "https://web.whatsapp.com/" };

async function setup() {
  const root = tempDir("ck-bb-");
  const h = harness(root);
  const lines: string[] = [];
  const bb = new BoardBrowsers(root, () => {}, { ...h.deps, log: (l) => lines.push(l) });
  const alerts: [string, string | null][] = [];
  bb.onLoggedOut = (b, site) => alerts.push([b.name, site]);
  const b = await bb.add("Fatt Interior WhatsApp");
  await bb.ensure(b.id);
  const f = h.byPid.get(1001)!;
  return { root, h, bb, b, f, lines, alerts, view: () => bb.view().browsers[0] };
}

test("login signs: known login addresses and titles, WhatsApp looked at inside the page, blank tabs say nothing", () => {
  expect(classifyByAddress("https://accounts.google.com/v3/signin/identifier?x=1", "Sign in - Google Accounts")).toBe("out");
  expect(classifyByAddress("https://x.com/i/flow/login", "X")).toBe("out");
  expect(classifyByAddress("https://shop.example.com/account/login?next=/", "Shop")).toBe("out");
  expect(classifyByAddress("https://example.com/users/sign_in", "Example")).toBe("out");
  // Ordinary pages about logging in are not login pages.
  expect(classifyByAddress("https://example.com/", "Log in to Example")).toBe("in");
  expect(classifyByAddress("https://www.google.com/search?q=login", "login - Google Search")).toBe("in");
  expect(classifyByAddress("https://docs.github.com/en/get-started/how-to-login", "Docs")).toBe("in");
  expect(classifyByAddress("https://example.com/blog/sign-in-with-apple", "Blog")).toBe("in");
  expect(classifyByAddress("https://mail.example.com/inbox", "Inbox")).toBe("in");
  expect(classifyByAddress("https://example.com/blog/signing-off", "Blog")).toBe("in");
  expect(classifyByAddress("https://web.whatsapp.com/", "WhatsApp")).toBe("probe");
  expect(classifyByAddress("about:blank", "")).toBeNull();
  expect(classifyByAddress("chrome://newtab/", "New Tab")).toBeNull();
  expect(probeAnswer("out")).toBe("out");
  expect(probeAnswer({ x: 1 })).toBe("unknown");
  expect(siteName("web.whatsapp.com")).toBe("WhatsApp");
});

test("the WhatsApp page check reads a fake logged-in page and a fake QR page correctly", () => {
  // The probe runs in a page; here it runs against tiny fake documents.
  const run = (doc: { sel: string[]; text: string }) => {
    const document = {
      querySelector: (q: string) => (q.split(",").some((s) => doc.sel.some((x) => s.trim() === x)) ? {} : null),
      body: { innerText: doc.text },
    };
    return new Function("document", `return ${PAGE_PROBES["web.whatsapp.com"]}`)(document);
  };
  expect(run({ sel: ["#pane-side"], text: "Chats" })).toBe("in");
  expect(run({ sel: ['canvas[aria-label*="QR" i]'], text: "" })).toBe("out");
  expect(run({ sel: [], text: "Log into WhatsApp Web\nMessage privately with friends" })).toBe("out");
  expect(run({ sel: [], text: "Use WhatsApp on your computer" })).toBe("out");
  expect(run({ sel: [], text: "Loading your chats" })).toBe("unknown");
});

test("signed in, then logged out: one alert after two looks, none again until it was signed in again", async () => {
  const { bb, f, view, alerts, lines } = await setup();
  expect(view().signIn).toBe("Not checked");
  f.pages = [WA];
  f.answers.set("wa", "unknown"); // still loading: says nothing
  await bb.tick();
  expect(view().signIn).toBe("Not checked");
  f.answers.set("wa", "in");
  await bb.tick();
  expect(view().signIn).toBe("Signed in");
  // Only Runtime.evaluate was sent to the user's page: no navigation, reload, click or typing.
  expect(new Set(f.pageCalls.map((c) => c[1]))).toEqual(new Set(["Runtime.evaluate"]));
  f.answers.set("wa", "out");
  await bb.tick();
  expect(view().signIn).toBe("Signed in");
  expect(alerts).toEqual([]);
  await bb.tick();
  expect([view().signIn, view().signInSite]).toEqual(["Needs sign-in", "web.whatsapp.com"]);
  expect(alerts).toEqual([["Fatt Interior WhatsApp", "web.whatsapp.com"]]);
  await bb.tick();
  await bb.tick();
  expect(alerts.length).toBe(1);
  f.answers.set("wa", "in");
  await bb.tick();
  expect(view().signIn).toBe("Signed in");
  f.answers.set("wa", "out");
  await bb.tick();
  await bb.tick();
  expect(alerts.length).toBe(2);
  expect(lines.filter((l) => l.includes("sign-in:"))).toEqual([
    "[browsers] Fatt Interior WhatsApp (fatt-interior-whatsapp): sign-in: signed in on web.whatsapp.com",
    "[browsers] Fatt Interior WhatsApp (fatt-interior-whatsapp): sign-in: was signed in, now needs sign-in on web.whatsapp.com",
    "[browsers] Fatt Interior WhatsApp (fatt-interior-whatsapp): sign-in: signed in again on web.whatsapp.com",
    "[browsers] Fatt Interior WhatsApp (fatt-interior-whatsapp): sign-in: was signed in, now needs sign-in on web.whatsapp.com",
  ]);
});

test("a task leaving another site's login page open changes nothing, and a WhatsApp logout still alerts", async () => {
  const { bb, f, view, alerts } = await setup();
  f.pages = [WA];
  f.answers.set("wa", "in");
  await bb.tick();
  f.pages = [WA, { id: "g", type: "page", title: "Sign in", url: "https://accounts.google.com/v3/signin/identifier" }];
  for (let i = 0; i < 3; i++) await bb.tick();
  expect(view().signIn).toBe("Signed in");
  expect(alerts).toEqual([]);
  f.answers.set("wa", "out");
  await bb.tick();
  await bb.tick();
  expect([view().signIn, view().signInSite]).toEqual(["Needs sign-in", "web.whatsapp.com"]);
  expect(alerts).toEqual([["Fatt Interior WhatsApp", "web.whatsapp.com"]]);
});

test("a site seen signed in that shows its login page later is logged out too, per site", async () => {
  const { bb, f, view, alerts } = await setup();
  f.pages = [WA, { id: "s", type: "page", title: "Shop", url: "https://shop.example.com/orders" }];
  f.answers.set("wa", "in");
  await bb.tick();
  f.pages = [WA, { id: "s", type: "page", title: "Shop", url: "https://shop.example.com/login" }];
  await bb.tick();
  await bb.tick();
  expect([view().signIn, view().signInSite]).toEqual(["Needs sign-in", "shop.example.com"]);
  // WhatsApp logging out as well gets its own alert, and the card names WhatsApp first.
  f.answers.set("wa", "out");
  await bb.tick();
  await bb.tick();
  expect(alerts.map((a) => a[1])).toEqual(["shop.example.com", "web.whatsapp.com"]);
  expect(view().signInSite).toBe("web.whatsapp.com");
});

test("a stopped browser keeps its last look with the time; a restart that finds it still logged out doesn't alert again", async () => {
  const { root, h, bb, b, f, view, alerts } = await setup();
  f.pages = [{ id: "g", type: "page", title: "Sign in", url: "https://accounts.google.com/v3/signin/identifier?token=SECRET" }];
  await bb.tick();
  // First look on a login page: Needs sign-in at once, no alert (it was never signed in).
  expect(view().signIn).toBe("Needs sign-in");
  expect(alerts).toEqual([]);
  await bb.close(b.id);
  const v = view();
  expect([v.state, v.signIn, v.signInSite]).toEqual(["stopped", "Needs sign-in", "accounts.google.com"]);
  expect(v.checkedAt).toBeTruthy();
  const again = new BoardBrowsers(root, () => {}, { ...h.deps, log: () => {} });
  expect(again.view().browsers[0].signIn).toBe("Needs sign-in");
  const saved = readFileSync(join(root, "board-browsers.json"), "utf8");
  expect(saved).not.toContain("SECRET");
});

test("log lines: start, close and death with why, site host only", async () => {
  const { bb, b, f, h, lines } = await setup();
  f.pages = [{ id: "p", type: "page", title: "Inbox", url: "https://mail.example.com/inbox?token=SECRET" }];
  await bb.tick();
  await bb.close(b.id);
  await bb.ensure(b.id);
  h.byPid.get(1002)!.quit();
  await bb.tick();
  const text = lines.join("\n");
  expect(text).toContain("started hidden (for a task)");
  expect(text).toContain("closed (asked by the user)");
  expect(text).toContain("stopped (quit on the Mac or crashed)");
  expect(text).not.toContain("SECRET");
  expect(text).not.toContain("/inbox");
});

test("sign-in screen: only for a running browser that needs sign-in, a picture of the login tab, taps and typing passed on", async () => {
  const { bb, b, f } = await setup();
  f.pages = [WA];
  f.answers.set("wa", "in");
  await bb.tick();
  await expect(bb.screen(b.id)).rejects.toThrow("doesn't need sign-in");
  await expect(bb.input(b.id, { type: "text", text: "hi" })).rejects.toThrow("doesn't need sign-in");
  f.answers.set("wa", "out");
  await bb.tick();
  await bb.tick();
  const shot = await bb.screen(b.id);
  expect(Buffer.from(shot.jpeg).toString()).toBe("fake-jpeg");
  expect(shot.site).toBe("web.whatsapp.com");
  await bb.input(b.id, { type: "click", x: 0.5, y: 0.25 });
  await bb.input(b.id, { type: "text", text: "60123456789" });
  await bb.input(b.id, { type: "key", key: "Enter" });
  const sent = f.pageCalls.filter((c) => c[1] !== "Runtime.evaluate");
  expect(new Set(sent.map((c) => c[1]))).toEqual(new Set(["Page.captureScreenshot", "Page.getLayoutMetrics", "Emulation.setFocusEmulationEnabled", "Input.dispatchMouseEvent", "Input.insertText", "Input.dispatchKeyEvent"]));
  expect(sent.find((c) => c[1] === "Input.dispatchMouseEvent" && c[2].type === "mousePressed")?.[2]).toMatchObject({ x: 500, y: 200, button: "left" });
  expect(sent.find((c) => c[1] === "Input.insertText")?.[2]).toEqual({ text: "60123456789" });
  expect(sent.filter((c) => c[1] === "Input.dispatchKeyEvent").map((c) => c[2].type)).toEqual(["keyDown", "keyUp"]);
  // Nothing else gets through.
  await expect(bb.input(b.id, { type: "click", x: 3, y: 0 })).rejects.toThrow("between 0 and 1");
  await expect(bb.input(b.id, { type: "key", key: "Escape" })).rejects.toThrow("isn't one");
  await expect(bb.input(b.id, { type: "navigate", url: "https://evil" })).rejects.toThrow("Send a tap");
  await expect(bb.screen("other")).rejects.toThrow("no board browser");
  await bb.close(b.id);
  await expect(bb.screen(b.id)).rejects.toThrow("isn't running");
});
