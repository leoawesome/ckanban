import type { useAppKeys } from "./useAppKeys";
import { useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api, COLUMNS, type Status, type Ticket } from "../lib/api";
import { parkNeedsConfirm } from "../features/family/familyActions";
import { toast } from "../components/toast";
import { clearArrival } from "../features/board/arrivals";
import { cardGrid, focusedCard, focusCard } from "./hash";

/** Moving, marking done, starring and pinning cards, with the feature park confirm (moved from App.tsx). */
export function useCardMoves({ live, loadTickets, setError, setTickets, slug, slugRef, tickets }: {
  live: ReturnType<typeof useAppKeys>["live"];
  loadTickets: (board: string, touched?: string[], full?: boolean) => Promise<void>;
  setError: (msg: string) => number;
  setTickets: Dispatch<SetStateAction<Ticket[]>>;
  slug: string | null;
  slugRef: MutableRefObject<string | null>;
  tickets: Ticket[];
}) {
  // A feature card (main ticket with tool tickets) dragged to Backlog or Done: one confirm first (familyActions.ts).
  const [parkAsk, setParkAsk] = useState<{ id: string; status: "backlog" | "done"; order?: number } | null>(null);
  const move = async (id: string, status: Status, order?: number, undo = true, confirmed = false) => {
    const board = slug!;
    const before = tickets.find((t) => t.id === id);
    if (!confirmed && before && parkNeedsConfirm(before, status)) {
      setParkAsk({ id, status: status as "backlog" | "done", order });
      return;
    }
    // You moved it yourself: it isn't "new" where it lands.
    clearArrival(id);
    setTickets((ts) => ts.map((t) => (t.id === id ? { ...t, status, ...(order === undefined ? {} : { order }) } : t)));
    try {
      await api.updateTicket(board, id, order === undefined ? { status } : { status, order });
      if (undo && before && before.status !== status) {
        const label = COLUMNS.find((c) => c.id === status)?.label ?? status;
        toast(<>Moved <b>{before.title}</b> to {label}</>, {
          action: { label: "Undo", run: () => { if (slugRef.current === board) move(id, before.status, before.order, false); } },
        });
      }
    } catch (e: any) {
      setError(`Couldn't move the ticket: ${e.message}`);
      // Its id goes along: a Done card beyond the first page comes back where it was.
      loadTickets(board, [id]).catch(() => {});
    }
  };

  // D on a focused Review card; focus stays at the same spot on the board for the next key.
  const markDone = (id: string) => {
    if (tickets.find((t) => t.id === id)?.status !== "review") return;
    const pos = focusedCard(cardGrid());
    void move(id, "done");
    setTimeout(() => focusCard(pos));
  };
  // S on a focused card: star / unstar (shows at once, the server confirms).
  const toggleStar = (id: string) => {
    const t = tickets.find((x) => x.id === id);
    const board = slug;
    if (!t || !board) return;
    const important = !t.important;
    setTickets((ts) => ts.map((x) => (x.id === id ? { ...x, important } : x)));
    api.updateTicket(board, id, { important }).catch((e) => {
      setError(`Couldn't ${important ? "star" : "unstar"} the ticket: ${e.message}`);
      loadTickets(board, [id]).catch(() => {});
    });
  };
  // 📌 Pin to the top of its column, or unpin (card button, P, ticket panel, ⌘K): shows at once, with Undo; Done cards can't be pinned.
  const pin = (id: string, on: boolean, undo = true) => {
    const t = live.current.tickets.find((x) => x.id === id);
    const board = slug;
    if (!t || !board || (on && t.status === "done") || on === !!t.pinnedAt) return;
    setTickets((ts) => ts.map((x) => (x.id === id ? { ...x, pinnedAt: on ? new Date().toISOString() : null } : x)));
    api.updateTicket(board, id, { pinned: on }).then(() => {
      if (undo) toast(<>{on ? "Pinned" : "Unpinned"} <b>{t.title}</b></>, {
        action: { label: "Undo", run: () => { if (slugRef.current === board) pin(id, !on, false); } },
      });
    }, (e) => {
      setError(`Couldn't ${on ? "pin" : "unpin"} the ticket: ${e.message}`);
      loadTickets(board, [id]).catch(() => {});
    });
  };
  const togglePin = (id: string) => {
    const t = tickets.find((x) => x.id === id);
    if (t) pin(id, !t.pinnedAt);
  };
  return { markDone, move, parkAsk, pin, setParkAsk, togglePin, toggleStar };
}
