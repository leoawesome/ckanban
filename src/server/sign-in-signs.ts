/**
 * Known login pages, for the board browsers' sign-in check (board-browsers.ts tick). One place, so more signs can be
 * added: a URL or title rule here, or a site with its own page check (WhatsApp Web keeps the same address and title
 * when it logs out, so only a look inside the page tells).
 *
 * The check only reads: tab addresses and titles from /json/list, and for WhatsApp one small Runtime.evaluate that
 * looks for elements. It never navigates, reloads, clicks or types in the user's pages.
 */

export type PageSignIn = "in" | "out" | "unknown";

export interface LoginSign {
  /** Plain name for tests and the docs. */
  name: string;
  test: (u: URL, title: string) => boolean;
}

/** Address or title rules that mean "this tab is a login page". */
export const LOGIN_SIGNS: LoginSign[] = [
  {
    name: "Google sign-in",
    test: (u) => u.hostname === "accounts.google.com" && /signin|servicelogin|accountchooser|\/o\/oauth2/i.test(u.pathname),
  },
  { name: "Microsoft sign-in", test: (u) => u.hostname === "login.microsoftonline.com" || u.hostname === "login.live.com" },
  { name: "X log-in", test: (u) => /(^|\.)(x|twitter)\.com$/.test(u.hostname) && u.pathname.startsWith("/i/flow/login") },
  // Only a path that ends in a login word (/login, /users/sign_in, /account/signin/), not an article about logging in.
  { name: "Login address", test: (u) => /\/(log-?in|sign-?in|log_in|sign_in)\/?$/i.test(u.pathname) },
];

/** Sites whose logged-out page keeps the same address: the board looks inside the page (PAGE_PROBES). */
export const PAGE_PROBES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  /**
   * WhatsApp Web: the chat list (#pane-side / #side) means signed in. The QR code (canvas, data-ref) or the "Log into
   * WhatsApp Web" / "Use WhatsApp on your computer" / phone-number link page means logged out. Anything else (still
   * loading, "open in another window") says nothing. The chat list check comes first, so a big signed-in page is never
   * read as text.
   */
  "web.whatsapp.com": `(() => {
    const d = document;
    if (d.querySelector('#pane-side, #side, [aria-label="Chat list"], [data-testid="chat-list"]')) return "in";
    if (d.querySelector('canvas[aria-label*="QR" i], canvas[aria-label*="scan" i], div[data-ref] canvas')) return "out";
    const t = ((d.body && d.body.innerText) || "").slice(0, 4000);
    if (/Log into WhatsApp|Use WhatsApp on your computer|Steps to log in|Link with phone number|Log in with phone number|Scan to log in|Enter phone number|Enter code on (your )?phone/i.test(t)) return "out";
    return "unknown";
  })()`,
});

/** "web.whatsapp.com" from a web address; null for blank, chrome:// and other non-web pages. */
export function siteOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * What the address and title alone say: "out" on a known login page, "probe" when the site needs a look inside the
 * page, "in" for any other web page, null for a blank or non-web tab (says nothing).
 */
export function classifyByAddress(url: string, title: string): PageSignIn | "probe" | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (PAGE_PROBES[u.hostname]) return "probe";
  return LOGIN_SIGNS.some((s) => s.test(u, title ?? "")) ? "out" : "in";
}

/** A page probe's answer, anything unexpected read as "unknown". */
export function probeAnswer(v: unknown): PageSignIn {
  return v === "in" || v === "out" ? v : "unknown";
}

/** How a site reads in an alert: "WhatsApp" for web.whatsapp.com, else its address. */
export function siteName(site: string | null): string {
  if (!site) return "a site";
  if (site === "web.whatsapp.com") return "WhatsApp";
  return site;
}
