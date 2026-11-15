import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { type Profile, type Ticket } from "../lib/api";
import { onlyBaseLayers } from "../lib/layers";
import { boardDigit, cardDir, cardKey, inDock, isBoardPickerKey, isInboxKey, isTyping, isUndoKey, panelBoardKey, stepBoard, stepCard } from "./keynav";
import type { PanelId } from "./panelState";
import { undoLatest } from "../components/toast";
import type { TeamRequest } from "../features/team/Team";
import { cardGrid, focusedCard, focusedCardId, focusCard } from "./hash";

/** The board's window-wide keyboard shortcuts (moved from App.tsx). */
export function useAppKeys({
  automationsOpen, connections, newTicket, openChat, openId, openPanel, profileDialog, profiles, schedulesOpen,
  searchRef, setBoardSwitcher, setCmdCard, setCommandBar, setInboxRequest, setMoveAsk, setNewTicket, setShortcuts,
  slug, switchBoard, tickets,
}: {
  automationsOpen: boolean;
  connections: boolean;
  newTicket: boolean;
  openChat: () => void;
  openId: string | null;
  openPanel: (id: PanelId, team?: TeamRequest | undefined) => void;
  profileDialog: "new" | "edit" | null;
  profiles: Profile[] | null;
  schedulesOpen: boolean;
  searchRef: RefObject<HTMLInputElement>;
  setBoardSwitcher: Dispatch<SetStateAction<boolean>>;
  setCmdCard: Dispatch<SetStateAction<string | null>>;
  setCommandBar: Dispatch<SetStateAction<boolean>>;
  setInboxRequest: Dispatch<SetStateAction<number>>;
  setMoveAsk: Dispatch<SetStateAction<string | null>>;
  setNewTicket: Dispatch<SetStateAction<boolean>>;
  setShortcuts: Dispatch<SetStateAction<boolean>>;
  slug: string | null;
  switchBoard: (to: string) => void;
  tickets: Ticket[];
}) {
  // Latest values for the window key handler below, which is bound once per dialog state.
  const live = useRef({ profiles, tickets, markDone: (_id: string) => {}, toggleStar: (_id: string) => {}, togglePin: (_id: string) => {}, inboxCount: 0 });

  // Shortcuts: N new ticket, / search, ? cheatsheet, Ctrl+` Terminal, F Files, C Claude, T Team (each opens or focuses its side panel),
  // ⌘K command bar (tickets on every board, actions, boards), I the Inbox, U the newest toast's Undo,
  // B or ⌘B board picker, [ ] previous / next board, 1…9 board N, J/K/H/L or arrows select a card;
  // on a focused card S stars, P pins or unpins, M moves to a column, D marks a Review card done.
  // With a ticket panel open (and it has the keyboard) only N, ?, B, F, C, T, U, ⌘K and ⌘B; single keys stay quiet while
  // typing and inside the side panels. Esc is handled by the panel and dialogs (one layer at a time, see layers.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`") {
        e.preventDefault();
        if (slug) openPanel("terminal");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if ((e.target as HTMLElement | null)?.closest?.(".xterm")) return;
        e.preventDefault();
        // Works without a board too, and over the ticket panel (its own entries join the list); a second ⌘K closes the bar.
        const free = onlyBaseLayers();
        setCmdCard(focusedCardId());
        setCommandBar((o) => (o ? false : free));
        return;
      }
      const boards = live.current.profiles ?? [];
      if (isBoardPickerKey(e)) {
        if ((e.target as HTMLElement | null)?.closest?.(".xterm")) return;
        e.preventDefault();
        // Like ⌘K: works from a text field and over the ticket panel too, and a second ⌘B closes the picker.
        const free = onlyBaseLayers();
        setBoardSwitcher((o) => (o ? false : free && boards.length > 0));
        return;
      }
      const at = boards.findIndex((p) => p.slug === slug);
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || inDock(e)) return;
      // U: the newest toast's Undo (Moved…, Snoozed…), from the board, the ticket panel or the open Inbox; not over a dialog.
      if (isUndoKey(e)) {
        if (!document.querySelector(".overlay") && undoLatest()) e.preventDefault();
        return;
      }
      if (profileDialog || newTicket || connections || schedulesOpen || automationsOpen || !onlyBaseLayers() || document.querySelector(".overlay")) return;
      if (openId) {
        // The ticket panel has the keyboard (nothing above it, nothing typed into): N, ? and B still work.
        const k = e.defaultPrevented ? null : panelBoardKey(e);
        if (!k) return;
        e.preventDefault();
        if (k === "new") { if (slug) setNewTicket(true); }
        else if (k === "shortcuts") setShortcuts(true);
        else if (k === "files" || k === "team") { if (slug) openPanel(k); }
        else if (k === "claude") { if (slug) openChat(); }
        else if (boards.length) setBoardSwitcher(true);
        return;
      }
      // Plain 1…9 (Alt+digit is taken by Chrome's tab switching); the ticket panel's questions form uses digits too.
      const digit = e.shiftKey || e.isComposing ? null : boardDigit(e.code);
      if (digit !== null) {
        if (!boards[digit]) return;
        e.preventDefault();
        switchBoard(boards[digit].slug);
        return;
      }
      const dir = e.shiftKey && e.key.startsWith("Arrow") ? null : cardDir(e.key);
      if (dir) {
        // A picked-up card (Space) moves with the arrows instead: leave those to the drag.
        if (!slug || e.defaultPrevented || document.querySelector(".sortable-card[aria-pressed='true']")) return;
        // Arrows on a focused button or menu trigger belong to it; J/K/H/L work from anywhere.
        const focus = document.activeElement;
        if (e.key.startsWith("Arrow") && focus && focus !== document.body && !focus.closest(".sortable-card")) return;
        const grid = cardGrid();
        const next = stepCard(grid.map((c) => c.length), focusedCard(grid), dir);
        if (!next) return;
        e.preventDefault();
        focusCard(next, grid);
        return;
      }
      // S, P, M and D on a focused card (elsewhere they do nothing).
      const card = cardKey(e);
      const cardId = card && focusedCardId();
      if (card && cardId) {
        e.preventDefault();
        if (card === "star") live.current.toggleStar(cardId);
        else if (card === "pin") live.current.togglePin(cardId);
        else if (card === "move") setMoveAsk(cardId);
        else live.current.markDone(cardId);
        return;
      }
      if (isInboxKey(e)) {
        if (!live.current.inboxCount) return;
        e.preventDefault();
        setInboxRequest(Date.now());
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (slug) setNewTicket(true);
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "?") {
        e.preventDefault();
        setShortcuts(true);
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        if (slug) openChat();
      } else if (e.key === "f" || e.key === "F") {
        if (!slug) return;
        e.preventDefault();
        openPanel("files");
      } else if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        if (slug) openPanel("team");
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        if (boards.length) setBoardSwitcher(true);
      } else if (e.key === "[" || e.key === "]") {
        const to = boards[stepBoard(boards.length, at, e.key === "]" ? 1 : -1)];
        if (!to) return;
        e.preventDefault();
        switchBoard(to.slug);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, profileDialog, newTicket, connections, schedulesOpen, automationsOpen, slug, switchBoard]);
  return { live };
}
