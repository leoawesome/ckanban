import { useEffect, useRef, useState } from "react";
import {
  clock, dayLabel, groupByDay, helperApi, levelLabel, levelTone, listWithHeld, messageHash, messageNeighbours, rowsByBoard, sendTrail, setUnread, stillWaitingLine,
  tapWord, useHelper, userTrail, withoutLinks, type HelperStatus, type Message, type Stepping, type SummaryRow, type SummaryView,
} from "./helper";
import { ChevronDownIcon, ChevronUpIcon } from "./icons";
import { KeyHint } from "./KeyHint";
import { isTyping, panelStep } from "./keynav";
import { useNow } from "./useNow";
import { toast } from "./toast";

/** "Show held items" on the history, kept for this tab so a message page's up/down walks the same list. */
const HELD_KEY = "ck.messages.held";
const readHeld = () => {
  try {
    return sessionStorage.getItem(HELD_KEY) === "1";
  } catch {
    return false;
  }
};
const writeHeld = (on: boolean) => {
  try {
    sessionStorage.setItem(HELD_KEY, on ? "1" : "0");
  } catch {}
};

/**
 * Next/previous carries the list the first message page chose (with or without held items) to the page it steps to,
 * so stepping from a held message to a normal one and back returns to the held one.
 */
let stepping: Stepping | null = null;

/**
 * The helper's status line: "Helper on, checked 2:41, nothing waits on you", red when it is paused or failing, and
 * "I can only reach you on this Mac" under it when no phone channel works (reach: show that part too).
 */
export function HelperStatusLine({ status, reach = true, compact }: { status: HelperStatus | null; reach?: boolean; compact?: boolean }) {
  if (!status) return null;
  const red = status.problem || status.paused;
  return (
    <div className={`helper-status-wrap${compact ? " compact" : ""}`}>
      <div className={`helper-status${red ? " red" : status.on ? "" : " off"}`} role="status">
        <i aria-hidden />
        <span>{status.line}</span>
      </div>
      {reach && status.on && status.onlyMac && (
        <div className="helper-status warn" role="status"><i aria-hidden /><span>I can only reach you on this Mac. Turn on a phone channel in Notifications.</span></div>
      )}
    </div>
  );
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

/** #/~messages: every message, newest first, grouped by day; "Show held items" adds what the helper held (its log). */
export function MessagesHistory({ onBack }: { onBack: () => void }) {
  const { status, messagesRev } = useHelper();
  // Back on the history: a message opened from here picks its list afresh.
  useEffect(() => { stepping = null; }, []);
  const [held, setHeldState] = useState(readHeld);
  const setHeld = (on: boolean) => {
    writeHeld(on);
    setHeldState(on);
  };
  const [list, setList] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  useEffect(() => {
    let live = true;
    helperApi.messages(held).then((r) => { if (live) { setList(r.messages); setError(null); setUnread(r.unread); } }, (e) => live && setError(e.message));
    return () => { live = false; };
  }, [held, messagesRev]);

  return (
    <main className="messages-page">
      <div className="messages-top">
        <button className="link-btn msg-back" onClick={onBack}>‹ Board</button>
        <h2>Messages</h2>
        <span />
      </div>
      <div className="messages-body">
        <HelperStatusLine status={status} />
        <label className="msg-switch-row">
          <span>Show held items</span>
          <input type="checkbox" role="switch" className="switch" checked={held} onChange={(e) => setHeld(e.target.checked)} />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        {!list && !error && <div className="muted small"><span className="spinner" /> Loading…</div>}
        {list && !list.length && <p className="muted">No messages yet. When the helper tells you something, it shows here.</p>}
        {list && groupByDay(list, now).map((g) => (
          <section key={g.day}>
            <h3 className="msg-day">{g.day}</h3>
            <div className="msg-card msg-list">
              {g.messages.map((m) => (
                <a key={m.id} href={messageHash(m.id)} className={`msg-row${m.held ? " held" : ""}${!m.readAt && !m.held ? " new" : ""}`}>
                  <span className="msg-row-head">
                    <span className={`msg-badge b-${levelTone(m.level, m.held)}`}>{levelLabel(m.level, m.held)}</span>
                    {!m.readAt && !m.held && <span className="msg-badge b-new">New</span>}
                    <span className="grow" />
                    <span className="muted small">{clock(m.at)}{m.readAt ? " · read" : ""}</span>
                  </span>
                  <span className="msg-row-line">{m.oneLine}</span>
                  {m.sends.length > 0 && <span className="muted small">{sendTrail(m)}</span>}
                  {m.why && m.level !== "summary" && <span className="muted small msg-row-why">Why: {m.why}</span>}
                </a>
              ))}
            </div>
          </section>
        ))}
        <TellHelper hint={'Lasting preferences it should always follow, like "Never wake me for docs tickets." Not for one-off requests.'} />
      </div>
    </main>
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
  const [list, setList] = useState<Message[] | null>(null);
  const now = useNow();
  // The list the history shows (with held items when it shows them, or when this one is held): up/down walk it. While
  // stepping, the list the first page chose stays.
  const withHeld = listWithHeld(stepping, id, readHeld(), !!m?.held);
  useEffect(() => {
    let live = true;
    helperApi.messages(withHeld).then((r) => live && setList(r.messages), () => {});
    return () => { live = false; };
  }, [withHeld, messagesRev]);
  const nav = list ? messageNeighbours(list, id) : { newer: null, older: null };
  const navRef = useRef({ ...nav, withHeld });
  navRef.current = { ...nav, withHeld };
  const go = (to: string | null) => {
    if (!to) return;
    stepping = { to, withHeld: navRef.current.withHeld };
    location.hash = messageHash(to);
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
      if (!msg.readAt) {
        const r = await helperApi.markRead(id).catch(() => null);
        if (r && live) { setM(r.message); setUnread(r.unread); }
      }
    }, (e) => live && setError(/not found/i.test(e.message) ? "This message is gone: messages are kept for 30 days." : e.message));
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
      <main className="messages-page">
        <div className="messages-top"><button className="link-btn msg-back" onClick={onBack}>‹ Messages</button><span /><span /></div>
        <div className="messages-body"><p className="muted">{error}</p></div>
      </main>
    );
  }
  if (!m) return <main className="messages-page"><div className="messages-body"><span className="spinner" /> Loading…</div></main>;

  const text = withoutLinks(m.text);
  const body = text.startsWith(m.oneLine) ? text.slice(m.oneLine.length).trim() : text;
  const view = m.level === "summary" ? m.summary ?? null : null;
  const open = (r: SummaryRow) => onOpenTicket(r.board, r.ticketId);
  const boards = [...new Set(m.items.map((i) => i.boardName))];
  const alert = m.level === "urgent" || m.level === "reminder";
  return (
    <main className="messages-page message-page">
      <div className="messages-top">
        <button className="link-btn msg-back" onClick={onBack}>‹ Messages</button>
        <span />
        {navButtons}
      </div>
      <div className="messages-body">
        <div className="msg-row-head">
          <span className={`msg-badge b-${levelTone(m.level, m.held)}`}>{levelLabel(m.level, m.held)}</span>
          <span className="muted small">{dayLabel(m.at, now)} {clock(m.at)}{boards.length ? ` · ${boards.join(", ")}` : ""}</span>
        </div>
        <h1 className="msg-big">{m.oneLine}</h1>
        {view ? <SummaryBody view={view} onOpen={open} /> : body && <div className="msg-text">{body}</div>}
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
              const line = status?.lines[`${i.board}/${i.ticketId}`];
              return (
                <div key={`${i.board}/${i.ticketId}/${i.key ?? ""}`} className="msg-ticket">
                  <div className="grow">
                    <div className="msg-ttl">{i.title}</div>
                    {i.question && <div className="small msg-question">{i.question}</div>}
                    <div className="muted small">{i.boardName}{line ? ` · ${line}` : ""}</div>
                  </div>
                  <button className="btn primary small" onClick={() => onOpenTicket(i.board, i.ticketId)}>Open</button>
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
        <TellHelper multiline />
        {alert && m.tapped && (
          <div className="msg-actions">
            <p className="msg-done small" role="status">{done ?? `You tapped ${tapWord(m.tapped.how)}: no more reminders for this.`}</p>
          </div>
        )}
        {alert && !m.tapped && (
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

/** A summary's page: new rows (under board headings when there are several boards), what still waits behind "Show all". */
function SummaryBody({ view, onOpen }: { view: SummaryView; onOpen: (r: SummaryRow) => void }) {
  const [all, setAll] = useState(false);
  const rows = (list: SummaryRow[]) => (view.grouped ? rowsByBoard(list) : [{ board: "", boardName: "", rows: list }]).map((g) => (
    <div key={g.board || "all"} className="msg-group">
      {g.boardName && <div className="msg-label">{g.boardName}</div>}
      {g.rows.map((r) => (
        <div key={`${r.board}/${r.ticketId}/${r.key ?? ""}`} className="msg-ticket">
          <div className="grow">
            <div className="msg-ttl">{r.title}</div>
            <div className="msg-sum-label">{r.label}</div>
          </div>
          <button className="btn primary small" onClick={() => onOpen(r)} aria-label={`Open ${r.title}`}>Open</button>
        </div>
      ))}
    </div>
  ));
  return (
    <>
      {view.new.length > 0 && <div className="msg-card msg-sum">{rows(view.new)}</div>}
      {view.stillCount > 0 && (
        <div className="msg-card msg-sum">
          <div className="msg-sum-still">{stillWaitingLine(view)}</div>
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
        <span className="msg-ttl">{unread ? `Messages, ${unread} new` : "Messages"}</span>
        {latest && <span className="muted small"> {latest}</span>}
      </span>
      {unread > 0 && <span className="msg-badge b-new">{unread}</span>}
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
