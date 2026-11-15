import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api, type InboxItem, type Ticket } from "../lib/api";
import { INBOX_SAFETY_MS, INBOX_GAP_MS, quiet } from "./appState";

/** The Inbox list: loading it, snoozed items and the throttled refresh on live updates (moved from App.tsx). */
export function useInbox({ inboxTimer, setInbox, setInboxLoaded }: {
  inboxTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  setInbox: Dispatch<SetStateAction<InboxItem[]>>;
  setInboxLoaded: Dispatch<SetStateAction<boolean>>;
}) {
  const [snoozed, setSnoozed] = useState<InboxItem[]>([]);
  const loadInbox = useCallback(() => quiet(api.inbox, "the inbox", (list) => {
    setInbox(list.filter((i) => !i.snoozedUntil));
    setSnoozed(list.filter((i) => i.snoozedUntil));
    setInboxLoaded(true);
  }), []);
  // Live updates refresh the Inbox, but at most one request at a time and one every INBOX_GAP_MS: the Inbox looks at
  // every ticket on every board, and with several runs going, ticket updates arrive many times a second (each one
  // used to reload it, which kept the daemon busy and the whole board slow).
  // What the Inbox shows of each ticket in it (title, attention, snooze), from the last ticket event: an event that
  // leaves this the same, for a ticket in the Inbox or not, doesn't reload it. Holds only tickets in the Inbox.
  const inboxShown = useRef(new Map<string, string>());
  const inboxLists = useRef<{ inbox: InboxItem[]; snoozed: InboxItem[] }>({ inbox: [], snoozed: [] });
  const inboxHas = useCallback((profile: string, id: string) => inboxShown.current.has(`${profile}/${id}`)
    || [...inboxLists.current.inbox, ...inboxLists.current.snoozed].some((i) => i.profile === profile && i.id === id), []);
  const inboxMayChange = useCallback((profile: string, t: Ticket) => {
    const key = `${profile}/${t.id}`;
    const shows = t.attention || t.snoozed ? JSON.stringify([t.title, t.attention ?? null, t.snoozed ?? null]) : "";
    const was = inboxShown.current.get(key);
    if (shows) inboxShown.current.set(key, shows);
    else inboxShown.current.delete(key);
    if (was !== undefined) return was !== shows;
    // First event for it: it changes the Inbox if it is in it now or joins it.
    return !!shows || inboxHas(profile, t.id);
  }, [inboxHas]);
  const inboxBusy = useRef(false);
  const inboxAgain = useRef(false);
  const inboxLast = useRef(0);
  const refreshInboxSoon = useCallback(() => {
    if (inboxBusy.current) {
      inboxAgain.current = true;
      return;
    }
    if (inboxTimer.current) return;
    const wait = Math.max(400, inboxLast.current + INBOX_GAP_MS - Date.now());
    inboxTimer.current = setTimeout(() => {
      inboxTimer.current = null;
      inboxBusy.current = true;
      inboxAgain.current = false;
      inboxLast.current = Date.now();
      const done = () => {
        inboxBusy.current = false;
        if (inboxAgain.current) refreshInboxSoon();
      };
      api.inbox().then((list) => {
        setInbox(list.filter((i) => !i.snoozedUntil));
        setSnoozed(list.filter((i) => i.snoozedUntil));
        setInboxLoaded(true);
      }).catch(() => {}).finally(done);
    }, wait);
  }, []);

  // Live updates reload the Inbox only when a ticket's own attention changes; a main ticket's comes from its tasks, which
  // an event may not carry. A slow reload while the page is shown (and on coming back to it) catches what they miss.
  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    const timer = setInterval(() => { if (visible()) refreshInboxSoon(); }, INBOX_SAFETY_MS);
    const back = () => { if (visible()) refreshInboxSoon(); };
    document.addEventListener("visibilitychange", back);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", back); };
  }, [refreshInboxSoon]);
  return { inboxHas, inboxLists, inboxMayChange, loadInbox, refreshInboxSoon, setSnoozed, snoozed };
}
