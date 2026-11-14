/**
 * The speed check's browser steps, each timed against a limit. Limits are generous on purpose (a busy Mac must not
 * fail them); a step going over is worth a look, a crash always is.
 */
import type { Page } from "./cdp";

export type Result = { view: string; step: string; ms: number | null; limitMs: number | null; status: "pass" | "slow" | "fail" | "crash"; note?: string };
export type Ctx = {
  page: Page;
  base: string;
  slug: string;
  /** A Done ticket far down the column ("Done N"), for search. */
  farDone: number;
  /** A screenshot, only with --shots. */
  shot: (name: string) => Promise<void>;
  api: (path: string, init?: RequestInit) => Promise<any>;
};
type Step = { step: string; limitMs: number | null; run: (c: Ctx) => Promise<{ ms: number | null; note?: string }> };

const CARDS_READY = `document.querySelector('.card:not(.skeleton-card)') && !document.querySelector('.skeleton-card')`;
const COL = (name: string) => `[...document.querySelectorAll('.column')].find(c => (c.querySelector('.column-title')?.textContent || '') === ${JSON.stringify(name)})`;
const BUTTON = (re: string) => `[...document.querySelectorAll('button')].find(b => /${re}/.test(b.textContent))`;
const CARD_STARTS = (prefix: string) => `[...document.querySelectorAll('.card')].find(c => c.offsetParent && (c.querySelector('.card-title')?.textContent || '').startsWith(${JSON.stringify(prefix)}))`;
/** The board is gone: React threw while drawing (e.g. #185) and the page is blank. */
const CRASHED = `!document.querySelector('#root')?.children.length || (!document.querySelector('.column, .phone-nav, .board, .drawer'))`;

class StepError extends Error {}
const need = <T>(v: T | null | undefined, what: string): T => {
  if (v === null || v === undefined) throw new StepError(what);
  return v;
};

/** Reloads the page and waits until the old document is gone and cards are drawn; ms or null. */
async function reloadToCards(p: Page, url: string | null): Promise<number | null> {
  await p.eval(`window.__speedcheckOld = 1`).catch(() => {});
  const t = performance.now();
  if (url) await p.goto(url);
  else await p.send("Page.reload", { ignoreCache: false });
  const ok = await p.waitFor(`!window.__speedcheckOld && (${CARDS_READY})`, 20_000);
  return ok === null ? null : performance.now() - t;
}

/**
 * Jumps a scroller down `jumps` times. Each jump waits until a real card shows in view; at the bottom it waits for the
 * next page of cards to arrive. Returns the slowest of those waits.
 */
async function scrollJumps(p: Page, body: string, jumps: number, by: number): Promise<{ ms: number | null; note: string }> {
  let worst = 0;
  let missed = 0;
  let pages = 0;
  const inView = `(() => { const b = ${body}; const r = b.getBoundingClientRect(); return [...b.querySelectorAll('.card:not(.skeleton-card)')].some(c => { const q = c.getBoundingClientRect(); return q.bottom > r.top && q.top < r.bottom; }); })()`;
  for (let i = 0; i < jumps; i++) {
    const s = await p.eval<{ end: boolean; h: number }>(`(() => { const b = ${body}; const end = b.scrollTop + b.clientHeight >= b.scrollHeight - 5; b.scrollTop += ${by}; return { end, h: b.scrollHeight }; })()`);
    const ms = s.end
      ? await p.waitFor(`${body}.scrollHeight > ${s.h}`, 5000, 15)
      : await p.waitFor(inView, 5000, 15);
    if (s.end && ms === null) break; // no more pages
    if (s.end) pages++;
    if (ms === null) missed++;
    else worst = Math.max(worst, ms);
    await Bun.sleep(60);
  }
  const seen = await p.eval<string>(`(() => { const t = [...${body}.querySelectorAll('.card .card-title')].map(e => e.textContent).filter(s => /^Done \\d+/.test(s)); return t.at(-1)?.split(' ').slice(0, 2).join(' ') ?? '?'; })()`);
  return { ms: missed ? null : worst, note: `${jumps} jumps, ${pages} more pages loaded, slowest shown; reached ${seen}${missed ? `; ${missed} jumps showed no cards in 5 s` : ""}` };
}

/**
 * The crash check, as in the 10,000-ticket test that found React #185: load every Done page by scrolling to the bottom
 * (up to 2 minutes), then scroll fast from the top to the bottom twice (up to 30 s a pass).
 */
async function fastScroll(p: Page, body: string, column: string): Promise<{ ms: number; note: string }> {
  const t = performance.now();
  const load = await p.eval<string>(`(async () => { const t = performance.now(); let h = 0, same = 0; while (performance.now() - t < 120000) { const c = ${column}; if (!c) return 'crash while loading'; const b = c.querySelector('.column-body'); b.scrollTop = b.scrollHeight; await new Promise(r => setTimeout(r, 120)); if (b.scrollHeight === h) { if (++same >= 25) break; } else { h = b.scrollHeight; same = 0; } } return 'ok'; })()`, 180_000);
  if (load !== "ok") throw new StepError(`board crashed (${load})`);
  const deepest = await p.eval<string>(`[...${body}.querySelectorAll('.card .card-title')].map(e => e.textContent).filter(s => /^Done \\d+/.test(s)).at(-1)?.split(' ').slice(0, 2).join(' ') ?? '?'`);
  const loadS = ((performance.now() - t) / 1000).toFixed(0);
  for (let pass = 0; pass < 2; pass++) {
    const r = await p.eval<string>(`(async () => { const c0 = ${column}; if (!c0) return 'gone'; c0.querySelector('.column-body').scrollTop = 0; await new Promise(r => setTimeout(r, 300)); const t = performance.now(); for (let i = 0; performance.now() - t < 30000; i++) { const c = ${column}; if (!c) return 'crash at step ' + i; const b = c.querySelector('.column-body'); if (b.scrollTop + b.clientHeight >= b.scrollHeight - 5 && i > 50) break; b.scrollTop += 400; await new Promise(r => setTimeout(r, 15)); } return 'ok'; })()`, 60_000);
    if (r !== "ok") throw new StepError(`board crashed (fast pass ${pass + 1}: ${r})`);
  }
  await Bun.sleep(500);
  if (await p.eval<boolean>(CRASHED)) throw new StepError("board crashed after the scroll");
  return { ms: performance.now() - t, note: `loaded Done down to ${deepest} in ${loadS} s, then 2 fast passes` };
}

/** Scrolls every column to the top, so a far Done card is no longer drawn (the Done column draws only what is in view). */
async function toTop(p: Page) {
  await p.eval(`document.querySelectorAll('.column-body').forEach(b => b.scrollTop = 0); document.scrollingElement.scrollTop = 0`);
  await Bun.sleep(400);
}

async function clearInput(p: Page, sel: string) {
  await p.eval(`(() => { const i = ${sel}; if (!i) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}

async function openLongChat(c: Ctx): Promise<{ ms: number | null; note?: string }> {
  const t = performance.now();
  await c.page.eval(`location.hash = '#/${c.slug}/t_20261101_long'`);
  const ok = await c.page.waitFor(`${BUTTON("Load earlier")} && document.body.innerText.includes('Done with item 1249')`, 15_000);
  return { ms: ok === null ? null : performance.now() - t, note: "6,250 entries" };
}

async function loadEarlier(c: Ctx, times: number): Promise<{ ms: number | null; note?: string }> {
  const p = c.page;
  const all: number[] = [];
  for (let i = 0; i < times; i++) {
    const before = await p.eval<string | null>(`${BUTTON("Load earlier")}?.textContent ?? null`);
    if (!before) break;
    const t = performance.now();
    await p.eval(`${BUTTON("Load earlier")}.click()`);
    const ok = await p.waitFor(`!${BUTTON("Loading…")} && (${BUTTON("Load earlier")}?.textContent ?? '') !== ${JSON.stringify(before)}`, 10_000);
    if (ok === null) return { ms: null, note: `load ${i + 1} did not finish in 10 s` };
    await p.eval(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    all.push(Math.round(performance.now() - t));
  }
  return { ms: all.length ? Math.max(...all) : null, note: `slowest of ${all.length}: ${all.join(", ")} ms` };
}

export const DESKTOP: Step[] = [
  {
    step: "First load (cold)", limitMs: 3000,
    run: async (c) => ({ ms: await reloadToCards(c.page, `${c.base}/#/${c.slug}`), note: "until cards are drawn" }),
  },
  { step: "Reload (warm)", limitMs: 1500, run: async (c) => ({ ms: await reloadToCards(c.page, null) }) },
  {
    step: "Open the Done column", limitMs: 1500,
    run: async (c) => {
      const strip = await c.page.rect(`[...document.querySelectorAll('.column-strip')].find(s => /Done/.test(s.textContent))`);
      const t = performance.now();
      if (strip) await c.page.click(strip);
      const ok = await c.page.waitFor(`${COL("Done")}?.querySelector('.card:not(.skeleton-card)')`, 10_000);
      return { ms: ok === null ? null : performance.now() - t, note: strip ? undefined : "was already open" };
    },
  },
  {
    step: "Scroll Done (cards after a jump)", limitMs: 1500,
    run: (c) => scrollJumps(c.page, `${COL("Done")}.querySelector('.column-body')`, 40, 3000),
  },
  {
    step: "Fast scroll Done (crash check)", limitMs: null,
    run: (c) => fastScroll(c.page, `${COL("Done")}.querySelector('.column-body')`, COL("Done")),
  },
  { step: "Open a 6,250-entry chat", limitMs: 2500, run: openLongChat },
  { step: "Load earlier in it (x5)", limitMs: 2000, run: (c) => loadEarlier(c, 5) },
  {
    step: "Board search, far Done card", limitMs: 1500,
    run: async (c) => {
      const p = c.page;
      await p.eval(`location.hash = '#/${c.slug}'`);
      await p.waitFor(CARDS_READY, 5000);
      const input = `document.querySelector('.board-search-row input')`;
      await p.click(need(await p.rect(input), "no search field"));
      const want = `Done ${c.farDone} `;
      await toTop(p);
      if (await p.eval<boolean>(`!!${CARD_STARTS(want)}`)) throw new StepError(`${want.trim()} was on screen before the search`);
      const t = performance.now();
      await p.type(want.trim());
      const ok = await p.waitFor(CARD_STARTS(want), 10_000);
      const ms = ok === null ? null : performance.now() - t;
      await c.shot("search");
      await clearInput(p, input);
      await p.eval(`document.activeElement?.blur()`);
      await Bun.sleep(500);
      return { ms, note: `"${want.trim()}"` };
    },
  },
  {
    step: "⌘K search, far Done card", limitMs: 1500,
    run: async (c) => {
      const p = c.page;
      await p.key("k", 4, "KeyK");
      need(await p.waitFor(`document.querySelector('.cmdbar input, [aria-label="Search tickets, actions and boards"]')`, 3000), "⌘K did not open");
      const t = performance.now();
      await p.type(`Done ${c.farDone}`);
      const ok = await p.waitFor(`[...document.querySelectorAll('[role=option]')].some(o => o.textContent.includes(${JSON.stringify(`Done ${c.farDone} `)}))`, 10_000);
      const ms = ok === null ? null : performance.now() - t;
      await p.key("Escape", 0, "Escape");
      await Bun.sleep(300);
      return { ms };
    },
  },
  {
    step: "Drag a card Backlog → Review", limitMs: 2000,
    run: async (c) => {
      const p = c.page;
      const id = "t_20261101_b001";
      const a = need(await p.rect(CARD_STARTS("Backlog 1 ")), "no Backlog 1 card");
      const b = need(await p.rect(`${COL("Review")}?.querySelector('.column-body')`), "no Review column");
      const t = performance.now();
      await p.drag(a, { x: b.x, y: b.y - b.h / 2 + 60 });
      for (let i = 0; i < 100; i++) {
        if ((await c.api(`/api/profiles/${c.slug}/tickets/${id}`))?.status === "review") {
          const ms = performance.now() - t;
          await c.api(`/api/profiles/${c.slug}/tickets/${id}`, { method: "PATCH", body: JSON.stringify({ status: "backlog" }) }).catch(() => {});
          return { ms, note: "incl. the drag's own ~0.5 s of moves; moved back after" };
        }
        await Bun.sleep(50);
      }
      return { ms: null, note: "the ticket did not move" };
    },
  },
  {
    step: "300-task feature, Tasks tab", limitMs: 2000,
    run: async (c) => {
      const p = c.page;
      const t = performance.now();
      await p.eval(`location.hash = '#/${c.slug}/t_20261101_feat'`);
      const tab = `[...document.querySelectorAll('[role=tab]')].find(b => /^Tasks/.test(b.textContent.trim()))`;
      need(await p.waitFor(tab, 10_000), "no Tasks tab");
      if (!(await p.eval<boolean>(`${tab}.getAttribute('aria-selected') === 'true'`))) await p.click(need(await p.rect(tab), "no Tasks tab"));
      const ok = await p.waitFor(BUTTON("Done · \\d+"), 10_000);
      const ms = ok === null ? null : performance.now() - t;
      await p.eval(`location.hash = '#/${c.slug}'`);
      return { ms, note: "open the ticket until Done · N shows" };
    },
  },
];

const NAV = (label: string) => `[...document.querySelectorAll('.phone-nav button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)}))`;
/** The element that scrolls the Done cards on the phone: the nearest scrolling parent of a Done card in view. */
const PHONE_DONE_BODY = `(() => { const t = [...document.querySelectorAll('.card .card-title')].find(e => e.offsetParent && /^Done \\d+ /.test(e.textContent)); for (let e = t; e; e = e.parentElement) { const o = getComputedStyle(e).overflowY; if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight) return e; } return document.scrollingElement; })()`;

export const PHONE: Step[] = [
  {
    step: "First load (cold)", limitMs: 3000,
    run: async (c) => {
      const t = performance.now();
      await c.page.eval(`window.__speedcheckOld = 1`).catch(() => {});
      await c.page.goto(`${c.base}/#/${c.slug}`);
      const ok = await c.page.waitFor(`!window.__speedcheckOld && ${NAV("Board")}`, 20_000);
      return { ms: ok === null ? null : performance.now() - t, note: "until the bottom bar shows" };
    },
  },
  {
    step: "Tap Board", limitMs: 1500,
    run: async (c) => {
      const t = performance.now();
      await c.page.tap(need(await c.page.rect(NAV("Board")), "no Board button"));
      const ok = await c.page.waitFor(CARDS_READY, 10_000);
      return { ms: ok === null ? null : performance.now() - t, note: "until cards are drawn" };
    },
  },
  {
    step: "Tap the Done tab", limitMs: 1500,
    run: async (c) => {
      const p = c.page;
      const tab = need(await p.rect(`[...document.querySelectorAll('.col-tab')].find(b => /Done/.test(b.textContent))`), "no Done tab");
      const t = performance.now();
      await p.tap(tab);
      const ok = await p.waitFor(`[...document.querySelectorAll('.card .card-title')].some(e => e.offsetParent && /^Done \\d+ /.test(e.textContent))`, 10_000);
      return { ms: ok === null ? null : performance.now() - t };
    },
  },
  {
    step: "Scroll Done (cards after a jump)", limitMs: 1500,
    run: (c) => scrollJumps(c.page, PHONE_DONE_BODY, 30, 2500),
  },
  { step: "Open a 6,250-entry chat", limitMs: 2500, run: openLongChat },
  { step: "Load earlier in it (x3)", limitMs: 2000, run: (c) => loadEarlier(c, 3) },
  {
    step: "Board search, far Done card", limitMs: 1500,
    run: async (c) => {
      const p = c.page;
      await p.eval(`location.hash = '#/${c.slug}'`);
      // On the Board tab 🔍 opens this board's search field (elsewhere it opens ⌘K).
      const btn = `[...document.querySelectorAll('button.board-search-btn')].find(b => b.offsetParent)`;
      need(await p.waitFor(btn, 5000), "no search button");
      await p.tap(need(await p.rect(btn), "no search button"));
      need(await p.waitFor(`document.activeElement?.tagName === 'INPUT'`, 3000), "search did not open");
      const want = `Done ${c.farDone} `;
      await toTop(p);
      if (await p.eval<boolean>(`!!${CARD_STARTS(want)}`)) throw new StepError(`${want.trim()} was on screen before the search`);
      const t = performance.now();
      await p.type(want.trim());
      const ok = await p.waitFor(CARD_STARTS(want), 10_000);
      const ms = ok === null ? null : performance.now() - t;
      await c.shot("search");
      await p.key("Escape", 0, "Escape");
      await p.key("Escape", 0, "Escape");
      await Bun.sleep(300);
      return { ms, note: `"${want.trim()}"` };
    },
  },
  {
    step: "Ask tab, open a long quick chat", limitMs: 2500,
    run: async (c) => {
      const p = c.page;
      const t = performance.now();
      await p.tap(need(await p.rect(NAV("Ask")), "no Ask button"));
      // The Ask tab shows the chat list, or reopens the last chat; open the long one from the list when shown.
      const row = `[...document.querySelectorAll('button, a, li, [role=button]')].find(e => /Long quick chat/.test(e.textContent) && e.getBoundingClientRect().height < 200 && e.getBoundingClientRect().height > 0 && !e.closest('header, .topbar'))`;
      const shown = `document.body.innerText.includes('Done with item 1249')`;
      need(await p.waitFor(`${row} || ${shown}`, 10_000), "the Ask tab showed neither the chat list nor the chat");
      if (!(await p.eval<boolean>(shown))) await p.tap(need(await p.rect(row), "no Long quick chat in the list"));
      const ok = await p.waitFor(shown, 10_000);
      return { ms: ok === null ? null : performance.now() - t, note: "6,250 entries; tap Ask until its last message shows" };
    },
  },
];

/** Runs the steps in order; after a crash the page is reloaded so the next steps still run. */
export async function runSteps(view: string, steps: Step[], c: Ctx, onResult: (r: Result) => void): Promise<void> {
  for (const s of steps) {
    let r: Result;
    c.page.takeErrors();
    try {
      const { ms, note } = await withTimeout(s.run(c), 300_000, s.step);
      const crashed = await c.page.eval<boolean>(CRASHED).catch(() => false);
      const status = crashed ? "crash" : ms === null ? "fail" : s.limitMs !== null && ms > s.limitMs ? "slow" : "pass";
      r = { view, step: s.step, ms, limitMs: s.limitMs, status, note: crashed ? `page went blank. ${note ?? ""}`.trim() : ms === null ? note ?? "did not finish" : note };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      const crashed = /crash/i.test(msg) || (await c.page.eval<boolean>(CRASHED).catch(() => false));
      r = { view, step: s.step, ms: null, limitMs: s.limitMs, status: crashed ? "crash" : "fail", note: msg };
    }
    const errors = c.page.takeErrors();
    const react = errors.find((e) => /Minified React error|Maximum update depth|React error/.test(e));
    if (react) r.note = `${r.note ? r.note + "; " : ""}${react.slice(0, 160)}`;
    else if (errors.length && r.status !== "pass") r.note = `${r.note ? r.note + "; " : ""}page error: ${errors[0].slice(0, 160)}`;
    onResult(r);
    await c.shot(s.step).catch(() => {});
    // The one-time "what's new" notice on a fresh data folder takes half a phone screen: dismiss it, untimed.
    if (s === steps[0]) await c.page.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Got it' && !b.closest('[role=dialog]'))?.click()`).catch(() => {});
    if (r.status === "crash") {
      await reloadToCards(c.page, null).catch(() => null);
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${what} took over ${ms / 1000} s`)), ms);
    p.then((v) => (clearTimeout(t), res(v)), (e) => (clearTimeout(t), rej(e)));
  });
}

