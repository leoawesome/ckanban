import { useState } from "react";
import type { InboxItem, Ticket } from "./api";
import { groupInbox } from "./inboxOrder";
import { useSafeClear } from "./useSafeClear";
import { elapsed, OLD_WAIT_MS, waitedFor } from "./time";
import { useNow } from "./useNow";

/**
 * Phone home (≤720px), for the board shown: what needs you (what Claude is waiting on, then what is ready to check,
 * newest first; over a week old folds into Older), what runs and what is being planned. Other boards that need you are
 * one line at the end. Tapping a card opens the ticket full screen. A cleared card shrinks away and taps pause briefly.
 */
export function NowView({ inbox, tickets, slug, onOpen, onMarkDone, onSnooze, onSnoozeAll, onSwitchBoard }: {
  inbox: InboxItem[];
  tickets: Ticket[];
  slug: string;
  onOpen: (profile: string, id: string) => void;
  onMarkDone: (i: InboxItem) => void;
  onSnooze: (i: InboxItem) => void;
  onSnoozeAll: (list: InboxItem[]) => void;
  onSwitchBoard: (slug: string) => void;
}) {
  const now = useNow();
  const [showOlder, setShowOlder] = useState(false);
  const { clear, busy, leaving } = useSafeClear();
  const needs = inbox.filter((i) => i.profile === slug);
  const groups = groupInbox(needs, now);
  const elsewhere = [...inbox.filter((i) => i.profile !== slug).reduce((m, i) => {
    const b = m.get(i.profile) ?? { slug: i.profile, name: i.profileName, n: 0 };
    b.n++;
    return m.set(i.profile, b);
  }, new Map<string, { slug: string; name: string; n: number }>()).values()];
  const waiting = new Set(needs.map((i) => i.id));
  const running = tickets.filter((t) => t.running && !waiting.has(t.id));
  const planning = tickets.filter((t) => t.status === "planning" && !t.running && !waiting.has(t.id));

  const open = (i: InboxItem) => { if (!busy()) onOpen(i.profile, i.id); };
  const card = (i: InboxItem) => {
    const answer = i.attention.kind === "questions" || i.attention.kind === "proposal" || i.attention.kind === "reply" || i.attention.kind === "huddle";
    const review = i.attention.kind === "review";
    const old = now - new Date(i.attention.since).getTime() > OLD_WAIT_MS;
    const key = `${i.profile}/${i.id}`;
    return (
      <div key={key} className={`now-card need att-${i.attention.kind}${leaving(key) ? " leaving" : ""}`}>
        <div className="now-card-in">
          <button className="now-open" onClick={() => open(i)}>
            <span className="now-title">{i.title}</span>
            <span className="now-act">
              {i.attention.label}
              <span className={old ? " now-old" : ""}> · {waitedFor(i.attention.since, now)}</span>
            </span>
          </button>
          <div className="now-actions">
            <button className="btn primary" onClick={() => open(i)}>{answer ? "Answer" : "Open"}</button>
            {review && <button className="btn" onClick={() => clear(key, () => onMarkDone(i))}>Mark done</button>}
            <button className="btn ghost" onClick={() => clear(key, () => onSnooze(i))} title="Hide it for a day, or until something changes">Snooze</button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <main className="now">
      {needs.length === 0 && <>
        <h3 className="now-head">Needs you · 0</h3>
        <p className="now-empty muted small">Nothing waits on you right now.</p>
      </>}
      {groups.waiting.length > 0 && <h3 className="now-head">Claude is waiting on you · {groups.waiting.length}</h3>}
      {groups.waiting.map(card)}
      {groups.check.length > 0 && <h3 className="now-head">Ready to check · {groups.check.length}</h3>}
      {groups.check.map(card)}
      {groups.older.length > 0 && (
        <>
          <div className="now-older">
            <button className="now-head now-older-toggle" aria-expanded={showOlder} onClick={() => setShowOlder((v) => !v)}>
              {showOlder ? "▾" : "▸"} Older · {groups.older.length}
            </button>
            <button className="btn ghost" onClick={() => { if (!busy()) onSnoozeAll(groups.older); }} title="Hide every item waiting more than a week for a day">Snooze all</button>
          </div>
          {showOlder && groups.older.map(card)}
        </>
      )}

      <h3 className="now-head">Running · {running.length}</h3>
      {running.length === 0 && <p className="now-empty muted small">No run active on this board.</p>}
      {running.map((t) => (
        <button key={t.id} className="now-card run now-open" onClick={() => onOpen(slug, t.id)}>
          <span className="now-title">{t.title}</span>
          <span className="now-act">{t.lastActivity || "Claude is working…"}{t.runStartedAt && <> · {elapsed(t.runStartedAt, now)}</>}</span>
        </button>
      ))}

      {planning.length > 0 && (
        <>
          <h3 className="now-head">Planning · {planning.length}</h3>
          {planning.map((t) => (
            <button key={t.id} className="now-card now-open" onClick={() => onOpen(slug, t.id)}>
              <span className="now-title">{t.title}</span>
              <span className="now-act">{t.lastActivity || "Waiting for your reply"}</span>
            </button>
          ))}
        </>
      )}

      {elsewhere.length > 0 && (
        <div className="now-elsewhere">
          <span className="muted small">Other boards:</span>
          {elsewhere.map((b) => (
            <button key={b.slug} className="chip" onClick={() => onSwitchBoard(b.slug)}>{b.name}<span className="need-chip">{b.n}</span></button>
          ))}
        </div>
      )}
    </main>
  );
}
