import {
  closestCenter, DndContext, pointerWithin, DragOverlay, KeyboardSensor, PointerSensor, rectIntersection, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent, type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BOARD_COLUMNS, type Job, type Status, type Ticket } from "./api";
import { Card } from "./Card";
import { boardColumnOf, dropOrder, groupByColumn, regroupByColumn } from "./columns";
import { playMove } from "./arrivals";
import { reducedMotion } from "./motion";
import { useCardTabs } from "./useCardTabs";
import { ChatIcon, CheckIcon, CollapseIcon, PlusIcon, SparkIcon } from "./icons";
import { usePhone } from "./usePhone";
import { toast } from "./toast";
import { useCardWindow, WINDOW_MIN } from "./useCardWindow";

const COLLAPSED_KEY = "ckanban.collapsedColumns";

function readCollapsed(): Set<Status> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/**
 * The columns folded to a narrow strip (saved in this browser): the column's own button and ⌘K both change it. Done
 * starts folded on every load: its cards load only once it is opened.
 */
export function useCollapsedColumns() {
  const [collapsed, setCollapsed] = useState(() => readCollapsed().add("done"));
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {}
  }, [collapsed]);
  const setColumnCollapsed = (id: Status, v: boolean) => setCollapsed((s) => {
    const next = new Set(s);
    if (v) next.add(id);
    else next.delete(id);
    return next;
  });
  return { collapsed, setColumnCollapsed };
}

interface Props {
  tickets: Ticket[];
  /** The board's tickets haven't loaded yet: grey placeholder cards, no counts and no "empty" texts. */
  loading?: boolean;
  onOpen: (id: string) => void;
  onMove: (id: string, status: Status, order: number) => void;
  onAdd: (status: Status) => void;
  /** A pending daemon restart holds queued tickets. */
  restartPending?: boolean;
  /** A search or filter is active (empty columns say "no match" instead of the usual hint). */
  filtered?: boolean;
  /** The board's slug: cards waiting on the usage limit get "Continue now" and the auto-continue toggle. */
  slug?: string;
  /** The board's one-time scheduled jobs: "⏰ N scheduled" on the cards that scheduled them. */
  jobs?: Job[];
  /** That chip was clicked: open Schedules → Upcoming for the ticket. */
  onOpenJobs?: (ticketId: string) => void;
  /** A search found a main ticket through one of its tool tickets: main ticket id to that tool ticket's title. */
  via?: Map<string, string>;
  /** Folded columns (useCollapsedColumns). */
  collapsed: Set<Status>;
  onCollapse: (id: Status, v: boolean) => void;
  /**
   * Phones, while a search or filter is on: every ticket the board shows unfiltered (and Done's cards not loaded yet),
   * for the "N of M match" line at the top of each column, and Clear filters.
   */
  filter?: { all: Ticket[]; doneMore: number; clear: () => void };
  /** 📌 Pin (true) or unpin a ticket (the card's pin button). */
  onPin?: (id: string, on: boolean) => void;
  /** Done loads in pages: `more` cards aren't loaded yet (counted in its badge), loadMore fetches the next page. */
  done?: DonePaging;
}

/** Done's cards not loaded yet, and how to load the next page. */
export interface DonePaging { more: number; loading: boolean; loadMore: () => void }

/** Card props shared down the columns. */
interface CardCtx {
  limit?: { slug: string; onError: (msg: string) => void }; jobs?: Job[]; onOpenJobs?: (ticketId: string) => void; via?: Map<string, string>;
  /** 📌 Pin (true) or unpin a ticket: the card's pin button. */
  onPin?: (id: string, on: boolean) => void;
}

/** What a screen reader says on every card, after its title and status (also how to move between cards). */
const CARD_HELP = "Arrow keys or J and K move between cards in a column, H and L between columns. Enter opens the ticket. " +
  "Tab reaches the card's buttons, and Escape comes back to the card. To move the card, press Space, then the arrow keys, then Space to drop it or Escape to cancel.";

/**
 * Drag with the mouse, or focus a card: Enter opens it, Space picks it up (arrows move, Space drops, Esc cancels).
 * One Tab stop per card: Tab enters its chips only once the card has focus (cardTabs.ts). Screen readers hear the
 * title as its name and the status lines plus CARD_HELP as its description.
 */
const SortableCard = memo(function SortableCard({ ticket, onOpen, queued, held, ctx }: { ticket: Ticket; onOpen: (id: string) => void; queued?: number; held?: boolean; ctx: CardCtx }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    data: { status: ticket.status },
    // A list item, not a button: the card holds its own buttons and links (pin, follow-up, job chip), which a button
    // would flatten for screen readers. Space picks it up and Enter opens it as before (aria-roledescription "card").
    attributes: { role: "listitem" },
  });
  // Claude moved it here: the card travels from where it was (arrivals.ts).
  const node = useRef<HTMLDivElement | null>(null);
  useCardTabs(node);
  const a11y = useId();
  const column = boardColumnOf(ticket);
  useLayoutEffect(() => {
    playMove(ticket.id, node.current?.querySelector<HTMLElement>(":scope > .card") ?? null);
  }, [ticket.id, column]);
  // Stable for the memoised Card: it redraws only when its ticket or the board's card props change.
  const id = ticket.id;
  const open = useCallback(() => onOpen(id), [onOpen, id]);
  const ctxPin = ctx.onPin;
  const pin = useMemo(() => ctxPin && ((on: boolean) => ctxPin(id, on)), [ctxPin, id]);
  return (
    <div
      ref={(n) => { setNodeRef(n); node.current = n; }}
      className="sortable-card"
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      {...attributes}
      {...listeners}
      aria-roledescription="card"
      aria-labelledby={`${a11y}-title`}
      aria-describedby={[`${a11y}-turn`, `${a11y}-line`, `${a11y}-meta`, attributes["aria-describedby"]].join(" ")}
      data-ticket={ticket.id}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen(ticket.id);
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
    >
      <Card a11yId={a11y} ticket={ticket} onClick={open} queued={queued} held={held}
        limit={ctx.limit} jobs={ctx.jobs} onOpenJobs={ctx.onOpenJobs} via={ctx.via?.get(ticket.id)}
        onPin={pin} />
    </div>
  );
});

/** The same array as last time while its items are the same (ids for the drag and drop list: a new array redraws every card). */
function useSameArray<T>(next: T[]): T[] {
  const ref = useRef(next);
  const prev = ref.current;
  if (prev !== next && (prev.length !== next.length || prev.some((x, i) => x !== next[i]))) ref.current = next;
  return ref.current;
}

const EMPTY_HINT: Record<Status, string> = {
  backlog: "No parked ideas. Press N or + to add one.",
  planning: "Drop a card here and Claude starts interviewing you",
  ready: "Drop a card here and Claude starts working on it",
  in_progress: "Drop a card here and Claude starts working on it (queued if all slots are busy)",
  review: "Finished work lands here for you to check",
  done: "Nothing finished yet",
};

/** A phone's empty columns: what the column is for, in phone words (desktop keeps EMPTY_HINT). */
const PHONE_EMPTY: Record<Status, { title: string; text?: string }> = {
  backlog: { title: "No parked ideas", text: "Save ideas here for later. Nothing runs until you start one." },
  planning: { title: "Nothing in planning", text: "Claude asks you its questions about a ticket here before it starts." },
  ready: { title: "Nothing running", text: "Started tickets run here while Claude works on them." },
  in_progress: { title: "Nothing running", text: "Started tickets run here while Claude works on them." },
  review: { title: "Nothing to check", text: "Finished work lands here for you to check." },
  done: { title: "Nothing finished yet" },
};
const PHONE_EMPTY_ICON: Record<Status, ReactNode> = {
  backlog: <PlusIcon size={20} />, planning: <ChatIcon size={20} />, ready: <SparkIcon size={20} />, in_progress: <SparkIcon size={20} />,
  review: <CheckIcon size={20} />, done: <CheckIcon size={20} />,
};

/** Placeholder cards per column while the board loads (Backlog, Planning, In Progress, Review, Done). */
const PLACEHOLDERS: Record<Status, number> = { backlog: 3, planning: 2, ready: 0, in_progress: 2, review: 2, done: 3 };
const CLAUDE_TAG = "Claude starts automatically when a card is here";

/**
 * The end of Done's loaded cards: once it scrolls into view (the column open, on a phone its tab shown), the next page
 * loads. It is watched again after each page, so a short page that still shows it loads the next one too.
 */
function MoreDone({ paging, loaded }: { paging: DonePaging; loaded: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { loadMore, loading } = paging;
  useEffect(() => {
    const el = ref.current;
    if (!el || loading || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, loading, loaded]);
  return (
    <div ref={ref} className="done-more">
      {loading
        ? Array.from({ length: 2 }, (_, i) => <div key={i} className="card skeleton-card" aria-hidden><i /><i /><i /></div>)
        : <button className="btn ghost small show-all" onClick={loadMore}>Show more ({paging.more} left)</button>}
    </div>
  );
}

const NO_QUEUE: Ticket[] = [];

function Column({ id, label, hint, claude, tickets, queue = NO_QUEUE, held = false, onOpen, onAdd, collapsed, onCollapse, filtered, loading, ctx, phone = false, done, match, dragId = null }: {
  id: Status; label: string; hint: string; claude: boolean; tickets: Ticket[]; loading: boolean;
  /** In Progress only: tickets waiting their turn on the folder, in start order. */
  queue?: Ticket[];
  /** A pending daemon restart holds the queue. */
  held?: boolean;
  onOpen: (id: string) => void; onAdd: (s: Status) => void;
  collapsed: boolean; onCollapse: (v: boolean) => void; filtered: boolean; ctx: CardCtx; phone?: boolean;
  /** Done only: its paging. */
  done?: DonePaging;
  /** Phones while filtering: the column's count before the filter, and Clear filters. */
  match?: { total: number; clear: () => void };
  /** The card being dragged: a windowed column keeps it drawn. */
  dragId?: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${id}`, data: { status: id } });
  const all = [...tickets, ...queue];
  const needYou = all.filter((t) => t.attention).length;
  // Done counts the cards it hasn't loaded yet too.
  const more = done?.more ?? 0;
  const count = all.length + more;
  const total = `${count} ${count === 1 ? "ticket" : "tickets"}${queue.length ? `, ${queue.length} queued` : ""}`;
  const countLabel = needYou > 0 ? `${total}, ${needYou} ${needYou === 1 ? "needs" : "need"} you` : total;
  // Only Backlog has its own +: elsewhere N and New ticket add one.
  const canAdd = id === "backlog";
  const shown = tickets;
  // A long Done column draws only the cards in view (useCardWindow.ts); the others stay short and draw every card.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyNode = useCallback((n: HTMLDivElement | null) => { setNodeRef(n); bodyRef.current = n; }, [setNodeRef]);
  const windowed = id === "done" && !collapsed && !loading && shown.length > WINDOW_MIN;
  const shownIds = useSameArray(useMemo(() => shown.map((t) => t.id), [shown]));
  const win = useCardWindow(bodyRef, shownIds, windowed, dragId);
  const drawn = windowed ? shown.slice(win.start, win.end) : shown;
  const sortIds = useSameArray(useMemo(() => [...drawn, ...queue].map((t) => t.id), [drawn, queue]));
  // The count bumps when a card arrives.
  const countRef = useRef<HTMLSpanElement>(null);
  const lastCount = useRef(count);
  useEffect(() => {
    // One or two more, not a whole board loading in.
    const grew = count > lastCount.current && count - lastCount.current <= 2;
    lastCount.current = count;
    if (grew && !reducedMotion()) countRef.current?.animate?.([{ transform: "scale(1)" }, { transform: "scale(1.15)" }, { transform: "scale(1)" }], { duration: 200, easing: "ease-out" });
  }, [count]);
  const countBadge = loading ? null : <span ref={countRef} className={`count${collapsed && needYou > 0 ? " needs-you" : ""}`} role="img" title={collapsed ? countLabel : total} aria-label={collapsed ? countLabel : total}>{count}</span>;
  // Waiting on you gets its own chip in words, not only an amber count (colour alone).
  const needChip = loading || needYou === 0 ? null : <span className="count needs-you">{needYou} need{needYou === 1 ? "s" : ""} you</span>;
  if (collapsed) {
    // Narrow strip: still a drop target; click to expand.
    return (
      <section ref={setNodeRef} className={`column collapsed col-${id} ${claude ? "claude-zone" : ""} ${isOver ? "over" : ""}`}>
        <button className="column-strip" onClick={() => onCollapse(false)} title={`Expand ${label}`} aria-label={loading ? `Expand ${label}` : `Expand ${label}, ${countLabel}`}>
          {countBadge}
          <span className="column-strip-title">{label}</span>
        </button>
      </section>
    );
  }
  return (
    <section className={`column col-${id} ${claude ? "claude-zone" : ""} ${isOver ? "over" : ""}`} aria-label={label} aria-busy={loading || undefined}>
      {/* A phone has no column head: its tab row names the column, its count, the ✦ and Backlog's +. */}
      {!phone && (
      <header className="column-head">
        {/* The column's hint is the title's tooltip (a phone has no title here: a tap on its column chip shows it). */}
        <h2 className="column-title" title={hint}>{label}</h2>
        {/* One badge: total count, turning amber with a dot while tickets wait on you. */}
        {countBadge}
        {needChip}
        {claude && <span className="claude-tag" role="img" title={CLAUDE_TAG} aria-label={CLAUDE_TAG}><SparkIcon /></span>}
        <span className="spacer" />
        <button className="icon-btn tiny column-collapse" title={`Collapse ${label}`} aria-label={`Collapse ${label}`} onClick={() => onCollapse(true)}>
          <CollapseIcon />
        </button>
        {canAdd ? (
          <button className="icon-btn" title={`Add to ${label}`} aria-label={`Add ticket to ${label}`} onClick={() => onAdd(id)}><PlusIcon /></button>
        ) : <span className="icon-btn-placeholder" aria-hidden />}
      </header>
      )}
      <SortableContext items={sortIds} strategy={verticalListSortingStrategy}>
        <div ref={bodyNode} className={windowed ? "column-body windowed" : "column-body"} role="list" aria-label={`${label} tickets`}>
          {match && !loading && (
            <div className="col-filter-bar">
              <span>{count} of {match.total} match</span>
              <button className="link-btn" onClick={match.clear}>Clear filters</button>
            </div>
          )}
          {loading && Array.from({ length: PLACEHOLDERS[id] }, (_, i) => <div key={i} className="card skeleton-card" aria-hidden><i /><i /><i /></div>)}
          {win.top > 0 && <div className="card-spacer" aria-hidden style={{ height: win.top, flex: "none" }} />}
          {drawn.map((t) => (
            <SortableCard key={t.id} ticket={t} onOpen={onOpen} ctx={ctx} />
          ))}
          {win.bottom > 0 && <div className="card-spacer" aria-hidden style={{ height: win.bottom, flex: "none" }} />}
          {queue.length > 0 && <div className="queue-sep" title="These start in this order as the folder frees up">Queued</div>}
          {queue.map((t, i) => (
            <SortableCard key={t.id} ticket={t} onOpen={onOpen} queued={i + 1} held={held} ctx={ctx} />
          ))}
          {!loading && done && more > 0 && <MoreDone paging={done} loaded={tickets.length} />}
          {!loading && count === 0 && phone && (
            <div className="col-empty">
              {filtered ? <div className="col-empty-title">No matching tickets</div> : <>
                <div className="col-empty-icon" aria-hidden>{PHONE_EMPTY_ICON[id]}</div>
                <div className="col-empty-title">{PHONE_EMPTY[id].title}</div>
                {PHONE_EMPTY[id].text && <div className="col-empty-text">{PHONE_EMPTY[id].text}</div>}
                {id === "backlog" && <button className="btn primary" onClick={() => onAdd(id)}>New ticket</button>}
              </>}
            </div>
          )}
          {!loading && count === 0 && !phone && (
            <div className={claude ? "column-drop-hint" : "column-empty"}>{filtered ? "No matching tickets" : EMPTY_HINT[id]}</div>
          )}
        </div>
      </SortableContext>
    </section>
  );
}

// Keyboard: ←/→ jump to the next column (top of its list), ↑/↓ move within the column.
const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") return sortableKeyboardCoordinates(event, args);
  const rect = args.context.collisionRect;
  if (!rect) return undefined;
  const cols = [...document.querySelectorAll<HTMLElement>(".board > .column")].map((c) => c.getBoundingClientRect());
  const mid = rect.left + rect.width / 2;
  const at = cols.findIndex((c) => mid >= c.left && mid <= c.right);
  const next = cols[at + (event.code === "ArrowRight" ? 1 : -1)];
  if (at < 0 || !next) return undefined;
  event.preventDefault();
  return { x: next.left + (next.width - rect.width) / 2, y: next.top + 70 };
};

// Prefer whatever is under the pointer (a card beats its column); fall back to nearest card.
const collision: CollisionDetection = (args) => {
  // Keyboard drags have no pointer: take what the moved card overlaps most (a card, else the column).
  if (!args.pointerCoordinates) {
    const overlap = rectIntersection(args);
    if (overlap.length) return [overlap[0]];
    return closestCenter(args);
  }
  const hits = pointerWithin(args);
  if (hits.length) {
    const card = hits.find((h) => !String(h.id).startsWith("col:"));
    return [card ?? hits[0]];
  }
  return closestCenter(args);
};

/**
 * Phones: the shown column and each column's scroll, kept while the Board tab is closed (Now, Ask or Team unmount it),
 * so coming back lands where the user left. Per board; only this tab's memory, nothing is saved.
 */
const phoneSpot: { slug?: string; col: number; scroll: number[] } = { col: 0, scroll: [] };

const POINTER_PHONE = { activationConstraint: { delay: 300, tolerance: 8 } };
const POINTER_DESKTOP = { activationConstraint: { distance: 5 } };
const KEYBOARD_OPTIONS = {
  coordinateGetter: keyboardCoordinates,
  keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
};
const ACCESSIBILITY = { screenReaderInstructions: { draggable: CARD_HELP } };

export function Board({ tickets, loading = false, onOpen, onMove, onAdd, filtered = false, restartPending = false, slug, jobs, onOpenJobs, via, collapsed, onCollapse: setColumnCollapsed, filter, onPin, done }: Props) {
  // The latest onPin, so the cards' context doesn't change on every render.
  const pinRef = useRef(onPin);
  pinRef.current = onPin;
  const canPin = !!onPin;
  const ctx = useMemo(() => ({
    limit: slug ? { slug, onError: (msg: string) => toast(msg, { tone: "error" }) } : undefined, jobs, onOpenJobs, via,
    onPin: canPin ? (id: string, on: boolean) => pinRef.current?.(id, on) : undefined,
  }), [slug, jobs, onOpenJobs, via, canPin]);
  const phone = usePhone();
  // Options kept the same object between draws: new ones would give dnd-kit new sensors, and every card would redraw.
  const sensors = useSensors(
    // Phones: long-press picks a card up, so a swipe still scrolls the board.
    useSensor(PointerSensor, phone ? POINTER_PHONE : POINTER_DESKTOP),
    // Enter is kept for opening the card, so only Space picks up / drops.
    useSensor(KeyboardSensor, KEYBOARD_OPTIONS),
  );
  const [dragId, setDragId] = useState<string | null>(null);
  // Columns whose cards didn't change keep their list (columns.ts), so their cards and drag lists stay as they were.
  const lastGroups = useRef<Map<Status, Ticket[]> | null>(null);
  const byColumn = useMemo(() => (lastGroups.current = regroupByColumn(tickets, lastGroups.current)), [tickets]);
  // While filtering on a phone: each column's count before the filter (In Progress with its queue, Done with its unloaded cards).
  const allTickets = filter?.all;
  const totals = useMemo(() => {
    if (!allTickets) return null;
    const by = groupByColumn(allTickets);
    return (id: Status) => (by.get(id)?.length ?? 0) + (id === "in_progress" ? by.get("ready")?.length ?? 0 : 0) + (id === "done" ? filter?.doneMore ?? 0 : 0);
  }, [allTickets, filter?.doneMore]);
  // The cards fade in when the first load lands (not on later moves).
  const [fadeIn, setFadeIn] = useState(false);
  const wasLoading = useRef(loading);
  useEffect(() => {
    if (wasLoading.current && !loading) {
      setFadeIn(true);
      const t = setTimeout(() => setFadeIn(false), 400);
      wasLoading.current = loading;
      return () => clearTimeout(t);
    }
    wasLoading.current = loading;
  }, [loading]);

  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id));

  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const { active, over } = e;
    if (!over) return;
    const ticket = tickets.find((t) => t.id === active.id);
    if (!ticket) return;
    let targetStatus = (over.data.current?.status as Status | undefined) ?? ticket.status;
    // Only Claude puts a ticket in progress: a card dropped on In Progress joins the queue
    // (at the front when dropped on a running card, else at the end) and starts when a slot is free.
    const queueDrop = targetStatus === "in_progress" && ticket.status !== "in_progress";
    if (queueDrop) targetStatus = "ready";
    const list = (byColumn.get(targetStatus) ?? []).filter((t) => t.id !== ticket.id);
    let index = queueDrop && !String(over.id).startsWith("col:") ? 0 : list.length;
    if (!queueDrop && !String(over.id).startsWith("col:")) {
      const overIndex = list.findIndex((t) => t.id === over.id);
      if (overIndex >= 0) {
        const originalList = byColumn.get(targetStatus) ?? [];
        const movingDown = ticket.status === targetStatus &&
          originalList.findIndex((t) => t.id === ticket.id) < originalList.findIndex((t) => t.id === over.id);
        index = movingDown ? overIndex + 1 : overIndex;
      }
    }
    // Pinned cards keep the top of the column: the order is worked out among the unpinned ones (columns.ts).
    const order = dropOrder(ticket, targetStatus, list, index);
    if (order === null) return;
    if (targetStatus === ticket.status && order === ticket.order) return;
    onMove(ticket.id, targetStatus, order);
  };

  const dragging = tickets.find((t) => t.id === dragId);

  // Phones show one column at a time (scroll snap): the chips jump to a column and follow the swipe.
  const boardRef = useRef<HTMLElement>(null);
  const remembered = phone && phoneSpot.slug === slug;
  const [shownCol, setShownCol] = useState(remembered ? phoneSpot.col : 0);
  useEffect(() => { if (phone) Object.assign(phoneSpot, { slug, col: shownCol }); }, [phone, slug, shownCol]);
  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!phone || !el) return;
    const bodies = () => [...el.querySelectorAll<HTMLElement>(":scope > .column .column-body")];
    if (remembered) {
      const col = el.querySelectorAll<HTMLElement>(":scope > .column")[phoneSpot.col];
      if (col) el.scrollLeft += col.getBoundingClientRect().left - el.getBoundingClientRect().left - (parseFloat(getComputedStyle(el).paddingLeft) || 0);
      bodies().forEach((b, i) => { b.scrollTop = phoneSpot.scroll[i] ?? 0; });
    }
    // Runs before the tab's DOM goes away, so the scroll positions are still readable.
    return () => { phoneSpot.scroll = bodies().map((b) => b.scrollTop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, slug]);
  // A phone has no column title: a tap on the shown column's chip says what the column is for, another tap hides it.
  const [hintOpen, setHintOpen] = useState(false);
  useEffect(() => setHintOpen(false), [shownCol]);
  const onBoardScroll = () => {
    const el = boardRef.current;
    if (!el) return;
    const left = el.getBoundingClientRect().left;
    const dist = [...el.querySelectorAll<HTMLElement>(":scope > .column")].map((c) => Math.abs(c.getBoundingClientRect().left - left));
    setShownCol(dist.indexOf(Math.min(...dist)));
  };
  const jumpTo = (i: number) => {
    const el = boardRef.current;
    const col = el?.querySelectorAll<HTMLElement>(":scope > .column")[i];
    if (!el || !col) return;
    const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    el.scrollTo({ left: el.scrollLeft + col.getBoundingClientRect().left - el.getBoundingClientRect().left - pad, behavior: reducedMotion() ? "auto" : "smooth" });
    setShownCol(i);
  };

  return (
    <DndContext accessibility={ACCESSIBILITY} sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
      {phone && (
        // Five equal tabs that all fit: the count on top (✦ where Claude starts work, an amber dot when one needs you), the name under it.
        <nav className="col-jump" aria-label="Columns">
          {BOARD_COLUMNS.map((c, i) => {
            const list = [...(byColumn.get(c.id) ?? []), ...(c.id === "in_progress" ? byColumn.get("ready") ?? [] : [])];
            const n = list.length + (c.id === "done" ? done?.more ?? 0 : 0);
            const needYou = list.some((t) => t.attention);
            return (
              <button key={c.id} className={`col-tab${i === shownCol ? " on" : ""}`} aria-current={i === shownCol || undefined} title={c.hint}
                aria-label={`${c.label}${loading ? "" : `, ${n}`}${needYou ? ", needs you" : ""}${c.claude ? ", Claude starts work here" : ""}`}
                aria-expanded={i === shownCol ? hintOpen : undefined} onClick={() => (i === shownCol ? setHintOpen((v) => !v) : jumpTo(i))}>
                <span className="col-tab-count" aria-hidden>
                  {loading ? "·" : n}
                  {c.claude && <span className="col-tab-claude"><SparkIcon size={12} /></span>}
                  {needYou && <span className="col-tab-you" />}
                </span>
                <span className="col-tab-label" aria-hidden>{c.label}</span>
              </button>
            );
          })}
        </nav>
      )}
      {phone && hintOpen && <p className="col-jump-hint" role="status">{BOARD_COLUMNS[shownCol]?.hint}</p>}
      <main className={`board${fadeIn ? " fade-in" : ""}`} ref={boardRef} onScroll={phone ? onBoardScroll : undefined}>
        {BOARD_COLUMNS.map((c) => (
          <Column key={c.id} {...c} tickets={byColumn.get(c.id) ?? []} queue={c.id === "in_progress" ? byColumn.get("ready") : undefined} held={restartPending} onOpen={onOpen} onAdd={onAdd} filtered={filtered} loading={loading} ctx={ctx} phone={phone}
            done={c.id === "done" ? done : undefined} dragId={dragId}
            match={phone && filter && totals ? { total: totals(c.id), clear: filter.clear } : undefined}
            collapsed={!phone && collapsed.has(c.id)} onCollapse={(v) => setColumnCollapsed(c.id, v)} />
        ))}
      </main>
      <DragOverlay>{dragging ? <Card ticket={dragging} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}
