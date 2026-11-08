import { useEffect, useState } from "react";
import {
  clock, dayLabel, groupByDay, helperApi, levelLabel, levelTone, messageHash, sendTrail, setUnread, tapWord, useHelper, userTrail,
  type HelperStatus, type Message,
} from "./helper";
import { useNow } from "./useNow";
import { toast } from "./toast";

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
  const [held, setHeld] = useState(false);
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
                  {m.why && <span className="muted small msg-row-why">Why: {m.why}</span>}
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
  const { status } = useHelper();
  const [m, setM] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"got-it" | "not-urgent" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const now = useNow();

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

  const body = m.text.startsWith(m.oneLine) ? m.text.slice(m.oneLine.length).trim() : m.text.trim();
  const boards = [...new Set(m.items.map((i) => i.boardName))];
  const alert = m.level === "urgent" || m.level === "reminder";
  return (
    <main className="messages-page message-page">
      <div className="messages-top">
        <button className="link-btn msg-back" onClick={onBack}>‹ Messages</button>
        <span />
        <span />
      </div>
      <div className="messages-body">
        <div className="msg-row-head">
          <span className={`msg-badge b-${levelTone(m.level, m.held)}`}>{levelLabel(m.level, m.held)}</span>
          <span className="muted small">{dayLabel(m.at, now)} {clock(m.at)}{boards.length ? ` · ${boards.join(", ")}` : ""}</span>
        </div>
        <h1 className="msg-big">{m.oneLine}</h1>
        {body && <div className="msg-text">{body}</div>}
        {m.why && (
          <div className="msg-card msg-why">
            <div className="msg-label">{alert ? "Why I'm interrupting" : "Why"}</div>
            <div>{m.why}</div>
          </div>
        )}
        {m.items.length > 0 && (
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
