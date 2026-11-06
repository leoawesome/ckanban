import { useEffect, useRef, useState } from "react";
import { openedAt, shouldPulse } from "./cardState";
import type { InboxItem } from "./api";
import { useLayer } from "./layers";
import { MenuSheet } from "./MenuSheet";
import { answers, groupInbox, marksDone } from "./inboxOrder";
import { useSafeClear } from "./useSafeClear";
import { fullTime, timeUntil, waitedFor } from "./time";
import { useNow } from "./useNow";
import { useMedia } from "./usePhone";
import { MoreIcon } from "./icons";

const keyOf = (i: InboxItem) => `${i.profile}/${i.id}`;
/** Touch screens have no keys to press: tooltips there leave out the "(d)"-style key text. */
export const TOUCH_QUERY = "(pointer: coarse)";

/**
 * The ⋯ next to a row's one button: the row's other actions (Snooze, ...) in a small menu, a bottom sheet on a phone.
 * Shown where there is no hover to reveal them (the phone Now cards, the Inbox on touch screens).
 */
export function RowMore({ label, actions }: { label: string; actions: { label: string; title?: string; run: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useLayer(() => setOpen(false), { active: open });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <span className="row-more" ref={root}>
      <button className="btn ghost row-more-btn" tabIndex={-1} aria-haspopup="menu" aria-expanded={open} aria-label={`More for ${label}`}
        onClick={() => setOpen((v) => !v)}>
        <MoreIcon size={16} />
      </button>
      {open && (
        <MenuSheet onClose={() => setOpen(false)}>
          <div className="inbox-menu row-more-menu" role="menu">
            {actions.map((a) => (
              <button key={a.label} className="menu-item" title={a.title} onClick={() => { setOpen(false); a.run(); }}>
                <span className="menu-label">{a.label}</span>
              </button>
            ))}
          </div>
        </MenuSheet>
      )}
    </span>
  );
}

/**
 * Top-bar "N need you" across every board, in two groups: what Claude is waiting on (questions, blocked, ...) then what
 * is ready to check (review, reply), each newest first, on one grey line "Ready for review · 10m" (red only for failed
 * or blocked). Items waiting over a week fold into "Older" with Snooze all. Each entry shows one button (Mark done for
 * review, else Answer/Open); its other actions appear on hover or focus, or behind ⋯ on a touch screen. A cleared row
 * shrinks away and clicks pause briefly, so the next row's button can't be hit by mistake.
 * Snoozed ones sit in a collapsed section with time left and Unsnooze.
 * ↑↓ move, Enter opens, d marks done, s snoozes (or unsnoozes), Esc closes.
 */
export function Inbox({ items, snoozed = [], onPick, onMarkDone, onSnooze, onSnoozeAll, openRequest }: {
  items: InboxItem[];
  snoozed?: InboxItem[];
  onPick: (i: InboxItem) => void;
  onMarkDone: (i: InboxItem) => void;
  onSnooze: (i: InboxItem, on: boolean) => void;
  onSnoozeAll: (list: InboxItem[]) => void;
  openRequest?: number;
}) {
  const [open, setOpen] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const { clear, busy, leaving } = useSafeClear();
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  useLayer(() => {
    setOpen(false);
    pill.current?.focus();
  }, { active: open });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // ⌘K "Open inbox": open the list with the first entry focused.
  useEffect(() => {
    if (!openRequest) return;
    setOpen(true);
    requestAnimationFrame(() => focusAt(0));
  }, [openRequest]);

  const entries = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
  const focusAt = (i: number) => {
    const list = entries();
    if (list.length) list[(i + list.length) % list.length].focus();
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = entries();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusAt(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusAt(at < 0 ? -1 : at - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusAt(0); }
    else if (e.key === "End") { e.preventDefault(); focusAt(-1); }
    else if (e.key === "Tab") setOpen(false);
    else if ((e.key.toLowerCase() === "d" || e.key.toLowerCase() === "s") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const key = list[at]?.dataset.entry;
      const i = key && [...items, ...snoozed].find((x) => keyOf(x) === key);
      if (!i) return;
      e.preventDefault();
      const done = e.key.toLowerCase() === "d";
      clear(keyOf(i), () => {
        if (done) onMarkDone(i);
        else onSnooze(i, !i.snoozedUntil);
        // The next entry moves up into this place.
        requestAnimationFrame(() => focusAt(Math.min(at, entries().length - 1)));
      });
    }
  };

  // The last entry went (done, snoozed or answered elsewhere): close, or the menu's layer would stay stacked.
  const empty = !items.length && !snoozed.length;
  useEffect(() => {
    if (empty) setOpen(false);
  }, [empty]);

  const now = useNow();
  const touch = useMedia(TOUCH_QUERY);
  /** Tooltip text, without its key part on a touch screen. */
  const tip = (text: string, keys: string) => (touch ? text : `${text} ${keys}`);
  if (empty) return null;
  const several = new Set([...items, ...snoozed].map((i) => i.profile)).size > 1;
  const groups = groupInbox(items, now);
  // The pill pulses only while something new and urgent waits (cardState.ts).
  const fresh = items.some((i) => shouldPulse(i.attention, now, openedAt(i.id)));
  const later = [...snoozed].sort((a, b) => a.snoozedUntil!.localeCompare(b.snoozedUntil!));
  const pick = (i: InboxItem) => {
    if (busy()) return;
    setOpen(false);
    onPick(i);
  };
  const row = (i: InboxItem) => {
    const key = keyOf(i);
    const done = () => clear(key, () => onMarkDone(i));
    const snooze = () => clear(key, () => onSnooze(i, true));
    const open = { label: answers(i) ? "Answer" : "Open", title: tip("Open the ticket", "(Enter)"), run: () => pick(i) };
    const markDone = { label: "Mark done", title: tip("Move it to Done", "(d)"), run: done };
    const snoozeIt = { label: "Snooze", title: tip("Hide it from the Inbox and counts for a day, or until something changes", "(s)"), run: snooze };
    const primary = marksDone(i) ? markDone : open;
    const others = marksDone(i) ? [snoozeIt] : [markDone, snoozeIt];
    return (
      <div key={key} className={`inbox-entry${leaving(key) ? " leaving" : ""}`}>
        <div className="inbox-entry-in">
          <button role="menuitem" data-entry={key} className="inbox-item" onClick={() => pick(i)}
            title={touch ? undefined : `Enter ${answers(i) ? "answers" : "opens"} · d marks done · s snoozes for a day`}>
            <span className="inbox-title">{i.title}</span>
            <span className={`inbox-why att-${i.attention.kind}`}>
              {i.attention.label} · <time dateTime={i.attention.since} title={`Waiting since ${fullTime(i.attention.since)}`}>{waitedFor(i.attention.since, now)}</time>
              {several && <> · {i.profileName}</>}
            </span>
          </button>
          <span className="inbox-actions">
            <button className="btn small primary" tabIndex={-1} onClick={primary.run} title={primary.title}>{primary.label}</button>
            <span className="inbox-secondary">
              {others.map((a) => <button key={a.label} className="btn small ghost" tabIndex={-1} onClick={a.run} title={a.title}>{a.label}</button>)}
            </span>
            <RowMore label={i.title} actions={others} />
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="inbox" ref={root}>
      <button ref={pill} className="inbox-pill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => focusAt(0));
          }
        }}
        title="Tickets on any board where Claude is waiting on you">
        {items.length ? <><span className={`yt-dot ${fresh ? "pulse" : ""}`} aria-hidden /> {items.length} need you</> : <>{snoozed.length} snoozed</>}
      </button>
      {open && (
        <MenuSheet onClose={() => setOpen(false)}>
          <div className="inbox-menu" role="menu" ref={menu} onKeyDown={onMenuKey}>
            {!items.length && <p className="inbox-empty muted small">Nothing needs you right now.</p>}
            {groups.waiting.length > 0 && <div className="inbox-board" role="presentation">Claude is waiting on you · {groups.waiting.length}</div>}
            {groups.waiting.map(row)}
            {groups.check.length > 0 && <div className="inbox-board" role="presentation">Ready to check · {groups.check.length}</div>}
            {groups.check.map(row)}
            {groups.older.length > 0 && (
              <>
                <div className="inbox-older-head">
                  <button role="menuitem" className="inbox-board inbox-snoozed-toggle" aria-expanded={showOlder} onClick={() => setShowOlder((v) => !v)}
                    title="Waiting for more than a week">
                    {showOlder ? "▾" : "▸"} Older · {groups.older.length}
                  </button>
                  <button className="btn small ghost" tabIndex={-1} onClick={() => { if (!busy()) onSnoozeAll(groups.older); }}
                    title="Hide every item waiting more than a week for a day">Snooze all</button>
                </div>
                {showOlder && groups.older.map(row)}
              </>
            )}
            {later.length > 0 && (
              <>
                <button role="menuitem" className="inbox-board inbox-snoozed-toggle" aria-expanded={showSnoozed} onClick={() => setShowSnoozed((v) => !v)}>
                  {showSnoozed ? "▾" : "▸"} Snoozed · {later.length}
                </button>
                {showSnoozed && later.map((i) => (
                  <div key={keyOf(i)} className={`inbox-entry snoozed${leaving(keyOf(i)) ? " leaving" : ""}`}><div className="inbox-entry-in">
                    <button role="menuitem" data-entry={keyOf(i)} className="inbox-item" onClick={() => pick(i)} title={touch ? undefined : "Enter opens · s unsnoozes · d marks done"}>
                      <span className="inbox-title">{i.title}</span>
                      <span className="inbox-why">
                        {i.attention.label} · <time dateTime={i.snoozedUntil} title={`Snoozed until ${fullTime(i.snoozedUntil!)}`}>back {timeUntil(i.snoozedUntil!)}</time>
                        {several && <> · {i.profileName}</>}
                      </span>
                    </button>
                    <span className="inbox-actions">
                      <button className="btn small ghost" tabIndex={-1} onClick={() => clear(keyOf(i), () => onSnooze(i, false))} title={tip("Back in the Inbox now", "(s)")}>Unsnooze</button>
                    </span>
                  </div></div>
                ))}
              </>
            )}
          </div>
        </MenuSheet>
      )}
    </div>
  );
}
