import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { api, type TicketPage, type Job, type Schedule, type Ticket } from "../lib/api";
import { doneCursor, doneDrifted, heldDoneHead, mergeTickets, reloadAsk, takeReload, unseenDone } from "../features/board/donePaging";
import { toast } from "../components/toast";

/** Loading the board's tickets (Done a page at a time), schedules and jobs (moved from App.tsx). */
export function useBoardData({ schedulesTimer, setJobs, setLoadedSlug, setSchedules, setTickets, slugRef, tickets }: {
  schedulesTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  setJobs: Dispatch<SetStateAction<Job[] | null>>;
  setLoadedSlug: Dispatch<SetStateAction<string | null>>;
  setSchedules: Dispatch<SetStateAction<Schedule[] | null>>;
  setTickets: Dispatch<SetStateAction<Ticket[]>>;
  slugRef: MutableRefObject<string | null>;
  tickets: Ticket[];
}) {
  // The board loads its unfinished work first; Done arrives a page at a time when its column is shown, and finished
  // tickets also come in from the search and when opened directly (donePaging.ts, server ticketScope.ts).
  // Done cards the server has that aren't loaded: the Done count adds them, and while some are left Done can load more.
  const [doneUnseen, setDoneUnseen] = useState(0);
  // Ids of the Done cards that came by page (the next page starts after the last of them: donePaging.ts doneCursor),
  // and finished tickets fetched by id or search: a reload asks for them again so they stay.
  const donePaged = useRef(new Set<string>());
  const extraIds = useRef(new Set<string>());
  const [doneLoading, setDoneLoading] = useState(false);
  const doneLoadingRef = useRef(false);
  const doneUnseenRef = useRef(0);
  // The list as last drawn (or set by a page): reloads and pages work out what to ask from it.
  const ticketsRef = useRef<Ticket[]>(tickets);
  ticketsRef.current = tickets;
  /**
   * Adds a piece of the board's tickets (late answers for a board no longer shown are dropped). reload: the board's
   * unfinished work plus Done's first page (or every paged card: ask.full), fetched again (takeReload).
   */
  const takeTickets = useCallback((board: string, page: TicketPage, reload?: { done: number; ids: string[]; full: boolean }) => {
    if (slugRef.current !== board) return false;
    // A reload applies at once (flushSync), so loadTickets reads the Done count it left right after.
    const apply = reload ? flushSync : (f: () => void) => f();
    apply(() => setTickets((cur) => {
      let next: Ticket[];
      if (reload) {
        const r = takeReload(cur, page.tickets, donePaged.current, extraIds.current, reload);
        next = r.tickets;
        donePaged.current = r.paged;
        // Asked extras the answer lacks were deleted: stop asking for them.
        const got = new Set(page.tickets.map((t) => t.id));
        for (const id of reload.ids) if (!got.has(id)) extraIds.current.delete(id);
      } else next = mergeTickets(cur, page.tickets);
      // Counted against the list it lands in (events may have changed it since the request went out).
      doneUnseenRef.current = unseenDone(page.doneTotal, next);
      setDoneUnseen(doneUnseenRef.current);
      ticketsRef.current = next;
      return next;
    }));
    return true;
  }, []);
  // A late answer for a board no longer shown is dropped (it would show that board's cards here). A reload (reconnect,
  // snooze end, failed move) asks only for unfinished work and Done's first page, not every Done page scrolled so far
  // (8.7 MB at 9,500 cards): the Done cards already loaded stay, and unchanged tickets keep their object (no redraw).
  // When the server's fingerprint of Done down to the cursor then disagrees with the cards held (deleted, finished,
  // dropped or reordered above it while away), it asks once more for every paged card and drops the ones gone. touched: a failed move's card, found wherever it is.
  const loadTickets = useCallback(async (board: string, touched: string[] = [], full = false): Promise<void> => {
    const ask = reloadAsk(ticketsRef.current, donePaged.current, extraIds.current, touched, full);
    const unseenBefore = doneUnseenRef.current;
    const page = await api.boardTickets(board, { done: ask.done, ids: ask.ids, after: ask.after });
    if (!takeTickets(board, page, ask)) return;
    setLoadedSlug(board);
    const heldHead = ask.after ? heldDoneHead(ticketsRef.current, ask.after) : null;
    if (doneDrifted(ask, page.doneHead, heldHead, unseenBefore, doneUnseenRef.current)) return loadTickets(board, touched, true);
  }, [takeTickets]);
  const loadMoreDone = useCallback(() => {
    const board = slugRef.current;
    if (!board || doneLoadingRef.current || doneUnseenRef.current <= 0) return;
    doneLoadingRef.current = true;
    setDoneLoading(true);
    const at = doneCursor(ticketsRef.current, donePaged.current);
    api.doneTickets(board, at.offset, at.after).then((page) => {
      if (slugRef.current !== board) return;
      for (const t of page.tickets) donePaged.current.add(t.id);
      takeTickets(board, page);
      const unseen = unseenDone(page.doneTotal, ticketsRef.current);
      // Nothing after the cursor though the count says more: the held cards are off (a card moved up in Done while
      // the board wasn't looking). Ask again for every paged card, which also brings the count right.
      if (!page.tickets.length && unseen > 0) return loadTickets(board, [], true);
    }).catch((e) => toast(`Couldn't load more of Done: ${(e as Error).message}`, { tone: "error" })).finally(() => {
      doneLoadingRef.current = false;
      setDoneLoading(false);
    });
  }, [takeTickets, loadTickets]);
  /** Finished tickets fetched outside Done's pages (search finds, a ticket opened by link): kept on reloads. */
  const takeExtra = useCallback((board: string, page: TicketPage) => {
    if (!takeTickets(board, page)) return;
    for (const t of page.tickets) if (t.status === "done") extraIds.current.add(t.id);
  }, [takeTickets]);
  const loadSchedules = useCallback((board: string) => api.schedules(board).then((list) => {
    // Ignore a late answer for a board we already left.
    if (slugRef.current === board) setSchedules(list);
  }).catch(() => {}), []);
  const loadJobs = useCallback((board: string) => api.jobs(board).then((list) => {
    if (slugRef.current === board) setJobs(list);
  }).catch(() => {}), []);
  // Fires and ticket changes move "next run", "running" and errors: refetch for the computed fields.
  const refreshSchedulesSoon = useCallback((board: string) => {
    if (schedulesTimer.current) return;
    schedulesTimer.current = setTimeout(() => {
      schedulesTimer.current = null;
      loadSchedules(board);
    }, 300);
  }, [loadSchedules]);
  return { doneLoading, donePaged, doneUnseen, doneUnseenRef, extraIds, loadJobs, loadMoreDone, loadSchedules, loadTickets, refreshSchedulesSoon, setDoneUnseen, takeExtra, ticketsRef };
}
