import type { SnoozeLength } from "./snooze";
import { useState, type ReactNode } from "react";
import type { InboxItem, Ticket } from "./api";
import { answers, groupInbox, marksDone } from "./inboxOrder";
import { useSafeClear } from "./useSafeClear";
import { elapsed, waitedFor } from "./time";
import { useNow } from "./useNow";
import { RowMore, ShowMore, usePaged, type InboxHelper } from "./Inbox";
import { isHeldLine } from "./helper";
import { HelperStatusLine, MessagesEntry } from "./Messages";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";
import { ClaudeFace } from "./ConvTurn";
import { liveLine, runMood } from "./avatarMood";
import { useClaudeName } from "./AvatarFace";

/**
 * Phone home (≤720px), for the board shown: what needs you (what Claude is waiting on, then what is ready to check,
 * newest first; over a week old folds into Older), what runs and what is being planned. Other boards that need you are
 * one line at the end. Tapping a card opens the ticket full screen. A waiting card shows one big button (Answer or Open; review
 * cards add a quieter Mark done beside it) and a ⋯ with Snooze. A cleared card shrinks away and taps pause briefly.
 * Until the inbox and the tickets have loaded, grey placeholder rows stand in (no "nothing waits" line yet). `footer`
 * (the notifications offer) goes below the list, so its late arrival doesn't push the rows down.
 */
export function NowView({ inbox, tickets, slug, onOpen, onMarkDone, onSnooze, onSnoozeAll, onSwitchBoard, inboxLoaded = true, ticketsLoaded = true, footer, helper }: {
  inbox: InboxItem[];
  tickets: Ticket[];
  slug: string;
  onOpen: (profile: string, id: string) => void;
  onMarkDone: (i: InboxItem) => void;
  onSnooze: (i: InboxItem, len?: SnoozeLength) => void;
  onSnoozeAll: (list: InboxItem[]) => void;
  onSwitchBoard: (slug: string) => void;
  inboxLoaded?: boolean;
  ticketsLoaded?: boolean;
  footer?: ReactNode;
  /** The helper: "Messages, N new" on top, its status line, the line on each card. */
  helper?: InboxHelper;
}) {
  const now = useNow();
  const [showOlder, setShowOlder] = useState(false);
  const { page, more } = usePaged();
  const claude = useClaudeName();
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

  const moreRow = (group: string, list: unknown[]) => (
    <ShowMore className="now-more" total={list.length} shown={page(group, list).length} onClick={() => more(group)} />
  );
  const open = (i: InboxItem) => { if (!busy()) onOpen(i.profile, i.id); };
  const card = (i: InboxItem) => {
    const key = `${i.profile}/${i.id}`;
    const done = marksDone(i);
    const snooze = { label: "Snooze", title: "Hide it for a day, or until something changes", run: () => clear(key, () => onSnooze(i)) };
    const line = helper?.status?.on ? helper.status.lines[key] : undefined;
    const longer = [
      { label: "Snooze for a week", title: "Hide it for a week, or until something changes", run: () => clear(key, () => onSnooze(i, "week")) },
      { label: "Snooze until I unsnooze", title: "Hide it until you unsnooze it, or until something changes", run: () => clear(key, () => onSnooze(i, "forever")) },
    ];
    const more = [...(isHeldLine(line) ? [{ label: "Should have pinged me", title: "Tell the helper you wanted to hear about this sooner", run: () => helper?.onShouldHavePinged(i) }] : []), snooze, ...longer];
    return (
      <div key={key} className={`now-card need att-${i.attention.kind}${leaving(key) ? " leaving" : ""}`}>
        <div className="now-card-in">
          <button className="now-open" onClick={() => open(i)}>
            <span className="now-title">{i.title}</span>
            <span className="now-act">{i.attention.label} · {waitedFor(i.attention.since, now)}{done && <ChevronRightIcon size={12} className="now-go" aria-hidden />}</span>
            {line && <span className={`helper-line${line.startsWith("Urgent") ? " urgent" : ""}`}>{line}</span>}
          </button>
          <div className="now-actions">
            <button className="btn primary" onClick={() => open(i)}>{answers(i) ? "Answer" : "Open"}</button>
            {/* Finishing a ticket is the quieter button beside Open, so a thumb slip on the big one never ends it. */}
            {done && <button className="btn now-done" onClick={() => clear(key, () => onMarkDone(i))}>Mark done</button>}
            <RowMore label={i.title} actions={more} />
          </div>
        </div>
      </div>
    );
  };

  return (
    <main className="now" aria-busy={!inboxLoaded || !ticketsLoaded}>
      {helper && (
        <div className="now-helper">
          {helper.status?.notice && (
            <div className="inbox-notice small">
              <span>Notifications now come grouped: routine waits arrive together in a summary, urgent ones interrupt you.</span>
              <button className="btn small ghost" onClick={helper.onNoticeSeen}>Got it</button>
            </div>
          )}
          <MessagesEntry unread={helper.unread} onOpen={helper.onOpenMessages} />
          <HelperStatusLine status={helper.status} compact total={inbox.length} />
        </div>
      )}
      {!inboxLoaded && <>
        <h2 className="now-head">Needs you</h2>
        <NowPlaceholders n={2} />
      </>}
      {inboxLoaded && needs.length === 0 && <>
        <h2 className="now-head">Needs you · 0</h2>
        <p className="now-empty muted small">Nothing waits on you right now.</p>
      </>}
      {groups.waiting.length > 0 && <h2 className="now-head">{claude} is waiting on you · {groups.waiting.length}</h2>}
      {page("waiting", groups.waiting).map(card)}
      {moreRow("waiting", groups.waiting)}
      {groups.check.length > 0 && <h2 className="now-head">Ready to check · {groups.check.length}</h2>}
      {page("check", groups.check).map(card)}
      {moreRow("check", groups.check)}
      {groups.older.length > 0 && (
        <>
          <div className="now-older">
            <button className="now-head now-older-toggle" aria-expanded={showOlder} onClick={() => setShowOlder((v) => !v)}>
              {showOlder ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />} {showOlder ? "Hide older" : "Show older"} · {groups.older.length}
            </button>
            <button className="btn small now-snooze-all" onClick={() => { if (!busy()) onSnoozeAll(groups.older); }} title="Hide every item waiting more than a week for a day">Snooze older</button>
          </div>
          {showOlder && <>{page("older", groups.older).map(card)}{moreRow("older", groups.older)}</>}
        </>
      )}

      <h2 className="now-head">Running{ticketsLoaded && <> · {running.length}</>}</h2>
      {!ticketsLoaded && <NowPlaceholders n={1} />}
      {ticketsLoaded && running.length === 0 && <p className="now-empty muted small">No run active on this board.</p>}
      {running.map((t) => (
        <button key={t.id} className="now-card run now-open" onClick={() => onOpen(slug, t.id)}>
          <span className="now-title">{t.title}</span>
          <span className="now-act now-run-act">
            <ClaudeFace mood={runMood(t.lastActivity)} size={20} />
            <span className="now-run-text">{liveLine(t.lastActivity, claude) || `${claude} is working…`}{t.runStartedAt && <> · {elapsed(t.runStartedAt, now)}</>}</span>
          </span>
        </button>
      ))}

      {planning.length > 0 && (
        <>
          <h2 className="now-head">Planning · {planning.length}</h2>
          {page("planning", planning).map((t) => (
            <button key={t.id} className="now-card now-open" onClick={() => onOpen(slug, t.id)}>
              <span className="now-title">{t.title}</span>
              <span className="now-act">{liveLine(t.lastActivity, claude) || "Waiting for your reply"}</span>
            </button>
          ))}
          {moreRow("planning", planning)}
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
      {footer}
    </main>
  );
}

function NowPlaceholders({ n }: { n: number }) {
  return <>{Array.from({ length: n }, (_, i) => <div key={i} className="now-card skeleton-card" aria-hidden><i /><i /></div>)}</>;
}
