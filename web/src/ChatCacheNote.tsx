import { useEffect, useState } from "react";
import type { Ticket } from "./api";
import { cacheNote, coldNoteKey, nextNoteChange } from "./cacheNote";
import { browserStore } from "./drafts";
import { CloseIcon } from "./icons";

/**
 * Above the ticket chat's box: green while Claude still has the chat ready (counts down by the minute), yellow once
 * it has gone cold and the next message re-reads the whole chat. The ✕ hides the cold note until Claude replies again.
 */
export function ChatCacheNote({ slug, ticket }: { slug: string; ticket: Ticket }) {
  const cache = ticket.session?.cache ?? null;
  const key = coldNoteKey(slug, ticket.id);
  // Bumped by the timer below so the note re-renders; the note itself always reads the clock.
  const [tick, setTick] = useState(0);
  const [hiddenAt, setHiddenAt] = useState<string | null>(() => browserStore()?.getItem(key) ?? null);

  useEffect(() => setHiddenAt(browserStore()?.getItem(key) ?? null), [key]);
  // Re-render at the next minute of the countdown, and when it goes cold.
  useEffect(() => {
    const next = nextNoteChange(cache, Date.now());
    if (next === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [cache?.at, cache?.ttl, tick]);

  const note = cacheNote({ cache, running: !!ticket.running, freshSession: ticket.freshSession, hiddenAt, now: Date.now() });
  if (!note) return null;
  if (note.kind === "warm") {
    return <div className="cache-note warm" title={note.title}><span aria-hidden>●</span><span>{note.text}</span></div>;
  }
  const hide = () => {
    if (!cache) return;
    try { browserStore()?.setItem(key, cache.at); } catch { /* private mode: hidden until reload */ }
    setHiddenAt(cache.at);
  };
  return (
    <div className="cache-note cold" title={note.title} role="status">
      <span aria-hidden>⏱</span>
      <span><b>This chat has gone cold.</b> {note.text}</span>
      <button className="cache-note-x" aria-label="Hide until Claude replies again" title="Hide until Claude replies again" onClick={hide}>
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
