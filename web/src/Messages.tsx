import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  anyItemOpen, appendRows, hashMoved, asksNight, asTab, clock, dayLabel, emptyLine, entryKey, entryLines, entryRows, foldByDay, helperApi, isFresh, levelLabel, levelTone, loadingMoreLine,
  MESSAGE_TABS, messageHash, nightQuestion, prependRows, rowIcon, rowsByBoard, itemStateKey, itemStateLabel, setHelperStatus, setUnread, stillWaitingLine, tapWord, useHelper,
  userTrail, withoutLinks, type HelperStatus, type ItemState, type ListEntry, type Message, type MessageRow, type MessageTab, type SummaryRow, type SummaryView,
} from "./helper";
import { ChevronDownIcon, ChevronUpIcon } from "./icons";
import { KeyHint } from "./KeyHint";
import { isTyping, panelStep } from "./keynav";
import { openFromList, stepTo } from "./msgNav";
import { useSwipeBack } from "./sheet";
import { useNow } from "./useNow";
import { usePhone } from "./usePhone";
import { toast } from "./toast";

/** The Messages tab chosen, kept for this browser tab so a message page's up/down walks the same list. */
const TAB_KEY = "ck.messages.tab";
const readTab = (): MessageTab => {
  try {
    return asTab(sessionStorage.getItem(TAB_KEY));
  } catch {
    return "needs";
  }
};
const writeTab = (tab: MessageTab) => {
  try {
    sessionStorage.setItem(TAB_KEY, tab);
  } catch {}
};

/**
 * The Needs you tab as the user saw it this session: its rows' ids, and messages stepped to or opened unread from it.
 * Opening one marks it read, so it leaves the tab; up/down send these so it still steps (both ways).
 */
const SEEN_KEY = "ck.messages.needsSeen";
const SEEN_MAX = 300;
export function readSeen(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
/** reset: the tab loaded again from the top (what it shows now is the list the user sees). */
export function noteSeen(ids: (string | null | undefined)[], reset = false): void {
  const add = ids.filter((x): x is string => !!x);
  if (!add.length && !reset) return;
  const all = [...new Set([...(reset ? [] : readSeen()), ...add])].slice(-SEEN_MAX);
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify(all));
  } catch {}
}

/**
 * What the list had loaded when a message was opened from it (rows, scroll spot, open groups): Back shows it again at
 * once, in the same place, then adds only what came in since.
 */
interface ListCache { tab: MessageTab; rows: MessageRow[]; hasMore: boolean; needs: number; scroll: number; open: string[] }
let listCache: ListCache | null = null;

/** A message page marked one read: the list it returns to shows it read. */
function noteRead(id: string, at: string) {
  if (listCache) listCache = { ...listCache, rows: listCache.rows.map((r) => (r.id === id && !r.readAt ? { ...r, readAt: at } : r)) };
}

/**
 * The helper's status line: "Helper on, checked 2:41, nothing waits on you", red when it is paused or failing, and
 * "I can only reach you on this Mac" under it when no phone channel works (reach: show that part too).
 */
export function HelperStatusLine({ status, reach = true, compact, total }: {
  status: HelperStatus | null; reach?: boolean; compact?: boolean;
  /** What needs you on every board (the Inbox's count): said in place of the helper's own count, so the numbers match. */
  total?: number;
}) {
  if (!status) return null;
  const red = status.problem || status.paused;
  const line = total === undefined ? status.line : helperLineWithTotal(status.line, total);
  return (
    <div className={`helper-status-wrap${compact ? " compact" : ""}`}>
      <div className={`helper-status${red ? " red" : status.on ? "" : " off"}`} role="status">
        <i aria-hidden />
        <span>{line}</span>
      </div>
      {reach && status.on && status.onlyMac && (
        <div className="helper-status warn" role="status"><i aria-hidden /><span>I can only reach you on this Mac. Turn on a phone channel in Notifications.</span></div>
      )}
    </div>
  );
}

/**
 * "Helper on, checked 21:07, 16 wait on you" → "Helper on, checked 21:07 · 7 need you on all boards", with the Inbox's
 * count (the one the tab badges and board picker use). Other lines (off, paused, failed) stay as they are.
 */
export function helperLineWithTotal(line: string, total: number): string {
  const m = /^(Helper on, [^,]+), (?:\d+ waits? on you|nothing waits on you)$/.exec(line);
  if (!m) return line;
  return `${m[1]} · ${total ? `${total} need${total === 1 ? "s" : ""} you on all boards` : "nothing needs you"}`;
}

const TELL_HINT = "For lasting preferences it should always follow, not one-off requests.";

/** "Tell the helper": a line for "What the helper knows about you" (the helper reads it at once). */
export function TellHelper({ hint = TELL_HINT, multiline }: { hint?: string; multiline?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await helperApi.addFeedback(t);
      setText("");
      toast("Saved. The helper will remember this.", { tone: "ok" });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const placeholder = "For example: pricing questions are always urgent";
  return (
    <form className="msg-card tell-helper" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="msg-ttl">Tell the helper</div>
      {hint && <div className="muted small">{hint}</div>}
      {multiline ? (
        <>
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label="Tell the helper" maxLength={300} />
          <div><button className="btn small" disabled={!text.trim() || busy}>Save note</button></div>
        </>
      ) : (
        <div className="tell-row">
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a note" aria-label="Tell the helper" maxLength={300} />
          <button className="btn primary" disabled={!text.trim() || busy}>Add</button>
        </div>
      )}
    </form>
  );
}

/**
 * #/~messages: tabs (Needs you, All, Summaries, Kept quiet), then the messages newest first under day headings, a pause
 * and its missed waits as one row, runs of updates folded into "N updates". Loads 30 at a time as you scroll; new
 * messages are added on top without loading the list again.
 */
export function MessagesHistory({ onBack }: { onBack: () => void }) {
  const { status, messagesRev } = useHelper();
  const phone = usePhone();
  const now = useNow();
  const kept = listCache?.tab === readTab() ? listCache : null;
  const [tab, setTabState] = useState<MessageTab>(kept?.tab ?? readTab);
  const [rows, setRows] = useState<MessageRow[] | null>(kept?.rows ?? null);
  const [hasMore, setHasMore] = useState(kept?.hasMore ?? false);
  const [needs, setNeeds] = useState(kept?.needs ?? 0);
  const [open, setOpen] = useState<Set<string>>(() => new Set(kept?.open ?? []));
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const page = useRef<HTMLElement>(null);
  const live = useRef({ tab, rows, hasMore, needs, open });
  live.current = { tab, rows, hasMore, needs, open };
  // Requests for an older tab are dropped when they come back.
  const gen = useRef(0);

  // Back from a message: the same scroll spot.
  useLayoutEffect(() => {
    if (kept && page.current) page.current.scrollTop = kept.scroll;
  }, []);
  // The scroll spot as it moves (the page is gone by the time the list unmounts).
  const scroll = useRef(kept?.scroll ?? 0);
  useEffect(() => () => {
    const l = live.current;
    if (l.rows) listCache = { tab: l.tab, rows: l.rows, hasMore: l.hasMore, needs: l.needs, scroll: scroll.current, open: [...l.open] };
  }, []);

  const loadFirst = (t: MessageTab) => {
    const g = ++gen.current;
    helperApi.messages(t).then((r) => {
      if (g !== gen.current) return;
      if (t === "needs") noteSeen(r.rows.map((x) => x.id), true);
      setRows(r.rows); setHasMore(r.hasMore); setNeeds(r.needs); setUnread(r.unread); setError(null);
    }, (e) => g === gen.current && setError(e.message));
  };
  const setTab = (t: MessageTab) => {
    if (t === tab) return;
    writeTab(t);
    setTabState(t);
    setRows(null);
    setHasMore(false);
    setOpen(new Set());
    if (page.current) page.current.scrollTop = 0;
    scroll.current = 0;
    loadFirst(t);
  };

  // First load (or nothing kept), then on each change only what is newer than the top row.
  const firstRev = useRef(messagesRev);
  useEffect(() => {
    if (!kept) loadFirst(tab);
  }, []);
  useEffect(() => {
    if (messagesRev === firstRev.current && !kept) return;
    const { tab: t, rows: have } = live.current;
    if (!have) return;
    const g = gen.current;
    const top = have[0];
    helperApi.messages(t, top ? { after: top, limit: 100 } : {}).then((r) => {
      if (g !== gen.current) return;
      if (t === "needs") noteSeen(r.rows.map((x) => x.id));
      setNeeds(r.needs);
      setUnread(r.unread);
      if (!top) setRows(r.rows), setHasMore(r.hasMore);
      else if (r.hasMore) loadFirst(t); // a lot came in: start from the top again
      else if (r.rows.length) setRows((l) => l && prependRows(l, r.rows));
    }, () => {});
  }, [messagesRev]);

  // The next 30 when the bottom comes near.
  const more = () => {
    const { tab: t, rows: have, hasMore: any } = live.current;
    if (!have?.length || !any || loadingMore) return;
    setLoadingMore(true);
    const g = gen.current;
    helperApi.messages(t, { before: have.at(-1) }).then((r) => {
      if (g !== gen.current) return;
      if (t === "needs") noteSeen(r.rows.map((x) => x.id));
      setRows((l) => l && appendRows(l, r.rows));
      setHasMore(r.hasMore);
      setNeeds(r.needs);
    }, (e) => toast((e as Error).message, { tone: "error" })).finally(() => setLoadingMore(false));
  };
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loadingMore) return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) more(); }, { root: page.current, rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, rows?.length]);

  // "Mark all read": only while something shows New; the list stays, the dots and the count go.
  const [marking, setMarking] = useState(false);
  const anyNew = !!rows?.some(isFresh);
  const markAll = async () => {
    if (marking) return;
    setMarking(true);
    try {
      const r = await helperApi.markAllRead();
      const at = new Date().toISOString();
      setRows((l) => l && l.map((m) => (isFresh(m) ? { ...m, readAt: at } : m)));
      setUnread(r.unread);
      toast(r.marked === 1 ? "Marked 1 message read." : `Marked ${r.marked} messages read.`, { tone: "ok" });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setMarking(false);
    }
  };

  const toggle = (e: ListEntry) => {
    const ids = entryRows(e).map((r) => r.id);
    setOpen((s) => {
      const n = new Set(s);
      if (ids.some((id) => n.has(id))) ids.forEach((id) => n.delete(id));
      else n.add(ids[0]);
      return n;
    });
  };

  return (
    <main className="messages-page" ref={page} onScroll={(e) => { scroll.current = e.currentTarget.scrollTop; }}>
      <div className="messages-top">
        <button className="link-btn msg-back" onClick={onBack}>‹ Board</button>
        <h2>Messages</h2>
        <span className="msg-top-right">
          {anyNew && <button className="link-btn msg-mark-all" disabled={marking} onClick={() => void markAll()}>{marking ? "Marking…" : "Mark all read"}</button>}
        </span>
      </div>
      <div className="messages-body">
        {/* A phone has this line on Now already. */}
        {!phone && <HelperStatusLine status={status} />}
        <div className="msg-tabs" role="tablist" aria-label="Which messages">
          {MESSAGE_TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`msg-tab${tab === t.id ? " on" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "needs" && needs > 0 && <span className="msg-tab-n" aria-label={`, ${needs}`}>{needs}</span>}
            </button>
          ))}
        </div>
        {tab === "quiet" && <div className="muted small msg-tab-hint">What the helper held back for a later summary. Only changes what you see here.</div>}
        {error && <div className="form-error" role="alert">{error}</div>}
        {!rows && !error && <div className="muted small"><span className="spinner" /> Loading…</div>}
        {rows && !rows.length && <p className="muted">{emptyLine(tab)}</p>}
        {rows && foldByDay(rows, now).map((d) => (
          <section key={d.day}>
            <h3 className="msg-day">{d.day}</h3>
            <div className="msg-card msg-list">
              {d.entries.map((e) => <EntryRow key={entryKey(e)} entry={e} open={entryRows(e).some((r) => open.has(r.id))} onToggle={() => toggle(e)} />)}
            </div>
          </section>
        ))}
        {hasMore && <div ref={sentinel} className="msg-more muted" role="status"><span className="spinner" />{loadingMoreLine(rows?.at(-1), now)}</div>}
        {rows && !hasMore && <TellHelper hint={'Lasting preferences it should always follow, like "Never wake me for docs tickets." Not for one-off requests.'} />}
      </div>
    </main>
  );
}

/** A row opens its message on a new history entry, so Back returns to this list. */
const openRow = (id: string) => (e: ReactMouseEvent) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  const from = location.href;
  openFromList(history, id);
  hashMoved(from);
};

/** One line of the list: a message, a pause with its missed waits, or "N updates" that opens in place. */
function EntryRow({ entry, open, onToggle }: { entry: ListEntry; open: boolean; onToggle: () => void }) {
  const { title, sub } = entryLines(entry);
  const icon = rowIcon(entry);
  const rows = entryRows(entry);
  const fresh = rows.some(isFresh);
  const first = rows[0];
  const body = (
    <>
      <span className={`msg-ic i-${icon.tone}`} aria-hidden>{icon.glyph}</span>
      <span className="msg-mid">
        <span className="msg-t">{title}</span>
        {sub && <span className="msg-s">{sub}</span>}
      </span>
      <span className="msg-tm">
        {fresh && <i className="msg-dot" aria-hidden />}
        {clock(first.at)}
        {entry.kind === "group" && <span className="msg-chev" aria-hidden>›</span>}
      </span>
    </>
  );
  const cls = `msg-row${fresh ? " new" : ""}${rows.every((r) => r.held) ? " held" : ""}`;
  const label = `${fresh ? "Unread. " : ""}${title}${sub ? `. ${sub}` : ""}, ${clock(first.at)}`;
  if (entry.kind !== "group") {
    const id = entry.kind === "pair" ? entry.missed.id : entry.row.id;
    return <a href={messageHash(id)} className={cls} aria-label={label} onClick={openRow(id)}>{body}</a>;
  }
  return (
    <div className={`msg-grp${open ? " open" : ""}`}>
      <button type="button" className={cls} aria-expanded={open} aria-label={label} onClick={onToggle}>{body}</button>
      {open && (
        <div className="msg-kids">
          {entry.rows.map((r) => (
            <a key={r.id} href={messageHash(r.id)} className={`msg-row kid${isFresh(r) ? " new" : ""}`} onClick={openRow(r.id)}
              aria-label={`${isFresh(r) ? "Unread. " : ""}${r.title}${r.sub ? `. ${r.sub}` : ""}, ${clock(r.at)}`}>
              <span className="msg-mid">
                <span className="msg-t">{r.title}</span>
                {r.sub && <span className="msg-s">{r.sub}</span>}
              </span>
              <span className="msg-tm">{isFresh(r) && <i className="msg-dot" aria-hidden />}{clock(r.at)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * #/~messages/<id>: the full text in large type, why, each ticket with Open, what was sent where (the reminder trail),
 * a "Tell the helper" box and, on urgent ones, Got it / Not urgent. Opening the page only marks the message read.
 */
export function MessagePage({ id, onBack, onOpenTicket }: { id: string; onBack: () => void; onOpenTicket: (board: string, ticketId: string) => void }) {
  const { status, messagesRev } = useHelper();
  const [m, setM] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"got-it" | "not-urgent" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const now = useNow();
  // Swipe right to go back to the list (phone).
  const pageRef = useRef<HTMLElement>(null);
  const swipe = useSwipeBack(pageRef, onBack);
  // Up/down walk the list's tab (the server picks Kept quiet or All when this message isn't in it).
  const [nav, setNav] = useState<{ newer: string | null; older: string | null }>({ newer: null, older: null });
  useEffect(() => {
    let live = true;
    const tab = readTab();
    helperApi.near(id, tab, tab === "needs" ? readSeen() : []).then((r) => {
      // Needs you: what it steps to was in the tab now, so it keeps stepping once read.
      if (r.tab === "needs") noteSeen([r.newer, r.older]);
      if (live) setNav({ newer: r.newer, older: r.older });
    }, () => {});
    return () => { live = false; };
  }, [id, messagesRev]);
  const navRef = useRef(nav);
  navRef.current = nav;
  // Same history entry, so one Back still returns to the list.
  const go = (to: string | null) => {
    if (!to) return;
    const from = location.href;
    stepTo(history, to);
    hashMoved(from);
  };
  useEffect(() => {
    // ↑/K the newer message, ↓/J the older one (as in the ticket panel); Alt+↑/↓ also while typing.
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented || document.querySelector(".overlay, [role=dialog]")) return;
      let dir: "prev" | "next" | null = null;
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) dir = e.key === "ArrowUp" ? "prev" : "next";
      else if (!isTyping(e)) dir = panelStep(e);
      if (!dir) return;
      const to = dir === "prev" ? navRef.current.newer : navRef.current.older;
      if (!to) return;
      e.preventDefault();
      go(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const navButtons = (
    <span className="ticket-nav msg-nav">
      <button className="icon-btn" disabled={!nav.newer} onClick={() => go(nav.newer)} aria-label="Newer message" title="Newer message (↑ or K)"><ChevronUpIcon size={16} /></button>
      <button className="icon-btn" disabled={!nav.older} onClick={() => go(nav.older)} aria-label="Older message" title="Older message (↓ or J)"><ChevronDownIcon size={16} /></button>
      <KeyHint keys="↑↓ J K" />
    </span>
  );

  useEffect(() => {
    let live = true;
    setM(null);
    setError(null);
    setDone(null);
    helperApi.message(id).then(async (msg) => {
      if (!live) return;
      setM(msg);
      // Opened unread (a notification, a link) while the list's tab is Needs you: it was in that tab.
      if (!msg.readAt && !msg.held && readTab() === "needs") noteSeen([id]);
      if (!msg.readAt) {
        const r = await helperApi.markRead(id).catch(() => null);
        if (r?.message.readAt) noteRead(id, r.message.readAt);
        if (r && live) { setM(r.message); setUnread(r.unread); }
      }
    }, (e) => live && setError(/not found/i.test(e.message) ? "This message is gone: messages are kept for 30 days (the last 500), and what the helper kept quiet for 7 days (the last 200)." : e.message));
    return () => { live = false; };
  }, [id]);

  const stop = async (how: "got-it" | "not-urgent") => {
    if (busy) return;
    setBusy(how);
    try {
      const r = await helperApi.stop(id, how);
      setM(r.message);
      setUnread(r.unread);
      setDone(r.text);
      toast(r.text, { tone: "ok" });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <main className="messages-page message-page" ref={pageRef} {...swipe}>
        <div className="messages-top"><button className="link-btn msg-back" onClick={onBack}>‹ Messages</button><span /><span /></div>
        <div className="messages-body"><p className="muted">{error}</p></div>
      </main>
    );
  }
  if (!m) return <main className="messages-page"><div className="messages-body"><span className="spinner" /> Loading…</div></main>;

  // The morning's "Held overnight" line has its own card at the top.
  const raw = withoutLinks(m.text);
  const text = m.heldOvernight && raw.startsWith(m.heldOvernight) ? raw.slice(m.heldOvernight.length).trim() : raw;
  const body = text.startsWith(m.oneLine) ? text.slice(m.oneLine.length).trim() : text;
  const view = m.level === "summary" ? m.summary ?? null : null;
  const open = (r: SummaryRow) => onOpenTicket(r.board, r.ticketId);
  const boards = [...new Set(m.items.map((i) => i.boardName))];
  const alert = m.level === "urgent" || m.level === "reminder" || !!m.practice;
  return (
    <main className="messages-page message-page" ref={pageRef} {...swipe}>
      <div className="messages-top">
        <button className="link-btn msg-back" onClick={onBack}>‹ Messages</button>
        <span />
        {navButtons}
      </div>
      <div className="messages-body">
        <div className="msg-row-head">
          <span className={`msg-badge b-${levelTone(m.level, m.held, m.practice)}`}>{levelLabel(m.level, m.held, m.practice)}</span>
          <span className="muted small">{dayLabel(m.at, now)} {clock(m.at)}{boards.length ? ` · ${boards.join(", ")}` : ""}</span>
        </div>
        {m.heldOvernight && (
          <div className="msg-card msg-why">
            <div className="msg-label">While you slept</div>
            <div>{m.heldOvernight}</div>
          </div>
        )}
        <h1 className="msg-big">{m.oneLine}</h1>
        {view ? <SummaryBody view={view} states={m.itemState} onOpen={open} /> : body && <div className="msg-text">{body}</div>}
        {m.why && !view && m.level !== "summary" && (
          <div className="msg-card msg-why">
            <div className="msg-label">{alert ? "Why I'm interrupting" : "Why"}</div>
            <div>{m.why}</div>
          </div>
        )}
        {!view && m.items.length > 0 && (
          <div className="msg-card">
            <div className="msg-label">{m.items.length === 1 ? "Ticket" : `Tickets · ${m.items.length}`}</div>
            {m.items.map((i) => {
              const st = m.itemState?.[itemStateKey(i)];
              const state = itemStateLabel(st);
              const line = state ? null : status?.lines[`${i.board}/${i.ticketId}`];
              return (
                <div key={`${i.board}/${i.ticketId}/${i.key ?? ""}`} className="msg-ticket">
                  <div className="grow">
                    <div className="msg-ttl">{i.title}</div>
                    {i.question && <div className="small msg-question">{i.question}</div>}
                    <div className="muted small">{i.boardName}{line ? ` · ${line}` : ""}</div>
                    {state && <div className={`small msg-item-state s-${st!.state}`}>{state}</div>}
                  </div>
                  {st?.state !== "removed" && <button className="btn primary small" onClick={() => onOpenTicket(i.board, i.ticketId)}>Open</button>}
                </div>
              );
            })}
          </div>
        )}
        {(m.sends.length > 0 || m.readAt || m.tapped) && (
          <div className="msg-card">
            <div className="msg-label">What I did</div>
            <ol className="msg-trail">
              {m.sends.map((s, n) => (
                <li key={n} className={alert ? "u" : ""}>
                  <b>{clock(s.at)}</b> {channelLine(s)}
                </li>
              ))}
              {userTrail(m).map((u) => <li key={u.text} className="o"><b>{clock(u.at)}</b> {u.text}</li>)}
            </ol>
          </div>
        )}
        {m.level === "hello" && <PracticeAlert />}
        {status && asksNight(m, status.nightOptIn) && <NightQuestion night={status.night} />}
        <TellHelper multiline />
        {alert && m.tapped && (
          <div className="msg-actions">
            <p className="msg-done small" role="status">{done ?? (m.practice ? "That stopped the reminder. Real alerts work the same way." : `You tapped ${tapWord(m.tapped.how)}: no more reminders for this.`)}</p>
          </div>
        )}
        {alert && !m.tapped && anyItemOpen(m) && (
          <div className="msg-actions">
            {done && <p className="msg-done small" role="status">{done}</p>}
            <button className="btn primary big" disabled={!!busy} onClick={() => void stop("got-it")}>{busy === "got-it" ? "Stopping…" : "Got it"}</button>
            <button className="btn big" disabled={!!busy} onClick={() => void stop("not-urgent")}>{busy === "not-urgent" ? "Stopping…" : "Not urgent"}</button>
          </div>
        )}
      </div>
    </main>
  );
}

/** The night question with Yes / Not at night (shown while the user hasn't chosen). Saves the setting at once. */
export function NightQuestion({ night }: { night: { start: string; end: string } }) {
  const [busy, setBusy] = useState(false);
  const answer = async (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      setHelperStatus(await helperApi.settings({ nightOptIn: allow }));
      toast(allow ? `Done: urgent alerts may wake you at night (${night.start}-${night.end}).` : "Done: nothing wakes you at night; urgent things wait for the morning.", { tone: "ok" });
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="msg-card night-ask">
      <div className="msg-label">At night</div>
      <div>{nightQuestion(night)}</div>
      <div className="muted small">Until you choose, nothing wakes you at night. You can change it any time in Settings.</div>
      <div className="night-ask-btns">
        <button className="btn primary" disabled={busy} onClick={() => void answer(true)}>Yes</button>
        <button className="btn" disabled={busy} onClick={() => void answer(false)}>Not at night</button>
      </div>
    </div>
  );
}

/** "Try a pretend urgent alert": one alert now, one reminder a minute later, stopped by Got it (Settings, the hello page). */
export function PracticeAlert({ compact }: { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await helperApi.practice();
      toast("Pretend alert sent. Leave it unanswered for a minute to get its reminder, then tap Got it.", { tone: "ok" });
      location.hash = messageHash(r.messageId);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const button = <button type="button" className="btn small" disabled={busy} onClick={() => void run()}>{busy ? "Sending…" : "Try a pretend urgent alert"}</button>;
  if (compact) return button;
  return (
    <div className="msg-card">
      <div className="msg-ttl">See what an urgent alert looks like</div>
      <div className="muted small">Sends a pretend alert now and one reminder a minute later, like a real one. Tap Got it to stop it. Nothing real changes.</div>
      <div>{button}</div>
    </div>
  );
}

/** A summary's page: new rows (under board headings when there are several boards), what still waits behind "Show all". */
function SummaryBody({ view, states, onOpen }: { view: SummaryView; states?: Record<string, ItemState>; onOpen: (r: SummaryRow) => void }) {
  const [all, setAll] = useState(false);
  const rows = (list: SummaryRow[]) => (view.grouped ? rowsByBoard(list) : [{ board: "", boardName: "", rows: list }]).map((g) => (
    <div key={g.board || "all"} className="msg-group">
      {g.boardName && <div className="msg-label">{g.boardName}</div>}
      {g.rows.map((r) => {
        const st = states?.[itemStateKey(r)];
        const state = itemStateLabel(st);
        return (
          <div key={`${r.board}/${r.ticketId}/${r.key ?? ""}`} className="msg-ticket">
            <div className="grow">
              <div className="msg-ttl">{r.title}</div>
              <div className="msg-sum-label">{r.label}</div>
              {state && <div className={`small msg-item-state s-${st!.state}`}>{state}</div>}
            </div>
            {st?.state !== "removed" && <button className="btn primary small" onClick={() => onOpen(r)} aria-label={`Open ${r.title}`}>Open</button>}
          </div>
        );
      })}
    </div>
  ));
  return (
    <>
      {view.new.length > 0 && <div className="msg-card msg-sum">{rows(view.new)}</div>}
      {(view.stillCount > 0 || (view.olderCount ?? 0) > 0) && (
        <div className="msg-card msg-sum">
          {view.stillCount > 0 && <div className="msg-sum-still">{stillWaitingLine(view)}</div>}
          {(view.olderCount ?? 0) > 0 && <div className="msg-sum-still">+{view.olderCount} older in Inbox</div>}
          {view.still.length > 0 && (
            <button className="link-btn msg-sum-toggle" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? "Hide the list" : `Show all ${view.stillCount} still waiting`}
            </button>
          )}
          {all && rows(view.still)}
        </div>
      )}
      {(view.checkins.length > 0 || view.olderCheckins > 0) && (
        <div className="msg-card msg-sum">
          <div className="msg-label">From your check-ins</div>
          {rows(view.checkins)}
          {view.olderCheckins > 0 && <div className="muted small">+{view.olderCheckins} older from check-ins</div>}
        </div>
      )}
      {view.notes.map((n) => <p key={n} className="msg-text msg-note">{n}</p>)}
    </>
  );
}

function channelLine(s: Message["sends"][number]): string {
  const name = s.channel === "push" ? "Phone push" : s.channel === "mac" ? "This Mac" : s.channel === "webhook" ? "ntfy" : s.channel === "telegram" ? "Telegram" : s.channel;
  if (!s.ok) return `${name}: didn't arrive${s.error ? ` (${s.error})` : ""}`;
  if (s.channel === "push" && s.devices !== undefined) return `${name} to ${s.devices === 1 ? "1 phone" : `${s.devices} phones`}`;
  return name;
}

/** "Messages, N new" at the top of the Inbox and the phone view (across boards). */
export function MessagesEntry({ unread, latest, onOpen, menuItem }: { unread: number; latest?: string | null; onOpen: () => void; menuItem?: boolean }) {
  return (
    <a href="#/~messages" role={menuItem ? "menuitem" : undefined} className={`messages-entry${unread ? " has-new" : ""}`} onClick={(e) => { e.preventDefault(); onOpen(); }}>
      <span aria-hidden>✉</span>
      <span className="grow">
        <span className="msg-ttl">Messages</span>
        {latest && <span className="muted small"> {latest}</span>}
      </span>
      {unread > 0 && <span className="msg-badge b-new" aria-label={`${unread} unread`}>{unread} unread</span>}
      <span className="muted" aria-hidden>›</span>
    </a>
  );
}

/**
 * The one-time notice after the helper arrives (upgrade or fresh install): what changed, my night, the awake rule.
 * Got it (or Settings) tells the board it was seen, on every screen.
 */
export function HelperNotice({ status, onSettings, onSeen, inline }: { status: HelperStatus; onSettings: () => void; onSeen: () => void; inline?: boolean }) {
  return (
    <div className={`banner info helper-notice${inline ? " inline" : ""}`} role="status">
      <span>
        <b>Notifications now come grouped.</b> A helper sends routine waits together in a summary and interrupts you only when
        something is urgent, reminding you until you act. Your night is {status.night.start} to {status.night.end}.
        {" "}Alerts need this Mac on and awake; a closed lid means no alerts.
      </span>
      <button className="btn small" onClick={() => { onSeen(); onSettings(); }}>Settings</button>
      <button className="btn small primary" onClick={onSeen}>Got it</button>
    </div>
  );
}
