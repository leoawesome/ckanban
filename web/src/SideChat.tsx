import { useEffect, useRef, useState } from "react";
import type { Profile } from "./api";
import { ClockIcon, CloseIcon, PlusIcon } from "./icons";
import { isTyping } from "./keynav";
import { useLayer } from "./layers";
import { QuickChatPane } from "./QuickChat";
import { CHAT_DEFAULT, CHAT_WIDTH_KEY, clampChatWidth } from "./sideChatLayout";

function savedWidth(): number {
  try {
    return Number(localStorage.getItem(CHAT_WIDTH_KEY)) || CHAT_DEFAULT;
  } catch {
    return CHAT_DEFAULT;
  }
}

/**
 * The chat's width: drag its left edge (or ←/→ on the edge, Shift for bigger steps), double-click to reset.
 * Persists per browser and is clamped to the window on every render, so the board always keeps some room.
 */
export function useChatWidth() {
  const [pref, setPref] = useState(savedWidth);
  const [vw, setVw] = useState(() => window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const width = clampChatWidth(pref, vw);
  const widthRef = useRef(width);
  widthRef.current = width;
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const persist = (w: number) => {
    try {
      localStorage.setItem(CHAT_WIDTH_KEY, String(w));
    } catch {}
  };
  const set = (w: number) => {
    const c = clampChatWidth(w, window.innerWidth);
    setPref(c);
    return c;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) set(window.innerWidth - e.clientX);
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    persist(widthRef.current);
  };
  const reset = () => {
    setPref(CHAT_DEFAULT);
    try {
      localStorage.removeItem(CHAT_WIDTH_KEY);
    } catch {}
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      persist(set(widthRef.current + (e.key === "ArrowLeft" ? step : -step)));
    }
  };
  return { width, windowWidth: vw, dragging, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset, onKeyDown } };
}

/** Where the keyboard lands when the chat opens: its message box. */
const FOCUS_ON_OPEN = ["textarea:not([disabled])", "input:not([disabled])", "button"];

/**
 * The quick chats with Claude (QuickChatPane, no ticket) as a dark panel on the right of the window, below the
 * header. It pushes the board narrower instead of covering it. App keeps it mounted while a ticket is open (beside
 * it on wide windows, over it on narrow ones), so the conversation, draft and scroll survive. Hiding it never stops
 * Claude: replies keep running on the server.
 */
export function SideChat({ profile, chat, onClose, onOpenTicket, focusRequest, covered }: {
  profile: Profile;
  chat: ReturnType<typeof useChatWidth>;
  onClose: () => void;
  onOpenTicket: (id: string) => void;
  /** Put the keyboard in the message box; changes for each request (C, the header button). */
  focusRequest: number;
  /** A ticket panel covers the chat (narrow windows): Esc and the keyboard belong to the ticket. */
  covered: boolean;
}) {
  const section = useRef<HTMLElement>(null);
  const historyBtn = useRef<HTMLButtonElement>(null);
  // Past chats: QuickChatPane's chat list, shown here as a drawer over the conversation only when asked (CSS: .history-open).
  const [history, setHistory] = useState(false);
  const closeHistory = (focusButton = false) => {
    setHistory(false);
    if (focusButton) historyBtn.current?.focus({ preventScroll: true });
  };
  // Esc closes the drawer first: a layer on top of everything (ticket panel included) while it is open.
  useLayer(() => closeHistory(true), { active: history });
  useEffect(() => {
    if (!history) return;
    const root = section.current;
    const list = root?.querySelector<HTMLElement>(".qc-list");
    // The keyboard goes to the open chat's row (or the first one).
    list?.querySelector<HTMLElement>(".qc-row.cur, .qc-row")?.focus({ preventScroll: true });
    // Picking a chat (or New chat) in the list closes it; so does a click anywhere outside it but the Chats button.
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".qc-row")) setHistory(false);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list?.contains(t) && !historyBtn.current?.contains(t)) setHistory(false);
    };
    list?.addEventListener("click", onClick);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      list?.removeEventListener("click", onClick);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [history]);
  // New chat from the header: the list's own New chat button (the list may be hidden).
  const newChat = () => {
    section.current?.querySelector<HTMLElement>(".qc-list .qc-new")?.click();
    setHistory(false);
    requestAnimationFrame(() => section.current?.querySelector<HTMLElement>(".qc-main textarea:not([disabled])")?.focus({ preventScroll: true }));
  };
  // Esc from outside the chat (the board, nothing focused) hides it, after any ticket panel: it sits under that layer.
  useLayer(onClose, { base: true, under: true, skipInInputs: true });

  // Under a ticket panel the chat can't be reached (React 18 has no inert prop).
  useEffect(() => {
    section.current?.toggleAttribute("inert", covered);
  }, [covered]);

  // Opening it puts the keyboard in the message box. The chat list may still be loading (and re-render, dropping
  // focus to the page): for a moment, look again on each frame, and focus again when focus fell back to the page.
  useEffect(() => {
    if (!focusRequest) return;
    const until = performance.now() + 1500;
    let frame = 0;
    let landed = false;
    const land = () => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (!landed || lost) {
        const el = section.current ? FOCUS_ON_OPEN.map((sel) => section.current!.querySelector<HTMLElement>(`.qc-main ${sel}`)).find(Boolean) : null;
        if (el) {
          el.focus({ preventScroll: true });
          landed = true;
        }
      }
      if (performance.now() < until) frame = requestAnimationFrame(land);
    };
    frame = requestAnimationFrame(land);
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

  // Esc with the keyboard in the chat: first leaves a text box, keeping what was typed; then hides the chat.
  // The keyboard goes back to the ticket panel when one is open.
  const onEsc = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (isTyping(e)) return section.current?.focus({ preventScroll: true });
    const panel = document.querySelector<HTMLElement>(".drawer-wrap .panel");
    onClose();
    panel?.focus({ preventScroll: true });
  };

  return (
    <section ref={section} className={`side-chat${chat.dragging ? " resizing" : ""}${history ? " history-open" : ""}`} style={{ width: chat.width }} aria-label="Quick Claude chat"
      tabIndex={-1} onKeyDown={onEsc}>
      <div className="side-chat-resize" role="separator" aria-orientation="vertical" aria-label="Resize the Claude chat" tabIndex={0}
        aria-valuenow={chat.width} title="Drag (or ←→) to resize · double-click to reset" {...chat.handle} />
      <div className="side-chat-head">
        <button ref={historyBtn} className={`btn ghost small icon-label${history ? " on" : ""}`} onClick={() => setHistory((o) => !o)}
          aria-expanded={history} aria-pressed={history} title="Past chats in this folder" aria-label="Past chats">
          <ClockIcon size={14} /> Chats
        </button>
        <span className="side-chat-title">Claude</span>
        <div className="spacer" />
        <button className="btn ghost small icon-label" onClick={newChat} title="Start a new chat"><PlusIcon size={14} /> New chat</button>
        <button className="icon-btn" onClick={onClose} title="Hide the chat (C, or Esc). Claude's replies keep running." aria-label="Hide the Claude chat">
          <CloseIcon />
        </button>
      </div>
      <div className="side-chat-body">
        <QuickChatPane profile={profile} phone={false} onOpenTicket={onOpenTicket} />
      </div>
    </section>
  );
}
