import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api, type InboxItem, type Status, type Ticket } from "../lib/api";
import { toast } from "../components/toast";
import { snoozeBody, snoozeUntil, snoozeWords, type SnoozeLength } from "../lib/snooze";

/** Inbox triage on any board: Done, snooze, snooze all and open (moved from App.tsx). */
export function useInboxActions({
  loadInbox, loadTickets, move, openTicket, setError, setInbox, setSlug, setSnoozed, setTickets, slug, slugRef,
}: {
  loadInbox: () => void;
  loadTickets: (board: string, touched?: string[], full?: boolean) => Promise<void>;
  move: (id: string, status: Status, order?: number | undefined, undo?: boolean, confirmed?: boolean) => Promise<void>;
  openTicket: (id: string, board?: string | null) => void;
  setError: (msg: string) => number;
  setInbox: Dispatch<SetStateAction<InboxItem[]>>;
  setSlug: Dispatch<SetStateAction<string | null>>;
  setSnoozed: Dispatch<SetStateAction<InboxItem[]>>;
  setTickets: Dispatch<SetStateAction<Ticket[]>>;
  slug: string | null;
  slugRef: MutableRefObject<string | null>;
}) {
  // Inbox triage on any board: the entry leaves the list (and the counts) at once, the server confirms.
  const inboxDone = async (i: InboxItem) => {
    setInbox((l) => l.filter((x) => x !== i));
    setSnoozed((l) => l.filter((x) => x !== i));
    if (i.profile === slug) return move(i.id, "done").finally(loadInbox);
    try {
      const before = await api.ticket(i.profile, i.id).catch(() => null);
      await api.updateTicket(i.profile, i.id, { status: "done" });
      toast(<>Moved <b>{i.title}</b> to Done</>, before && before.status !== "done" ? {
        action: {
          label: "Undo",
          run: () => void api.updateTicket(i.profile, i.id, { status: before.status, order: before.order }).then(loadInbox,
            (e: any) => setError(`Couldn't move the ticket back: ${e.message}`)),
        },
      } : undefined);
    } catch (e: any) {
      setError(`Couldn't move the ticket: ${e.message}`);
      loadInbox();
    }
  };
  const inboxSnooze = async (i: InboxItem, on: boolean, len: SnoozeLength = "day") => {
    const until = snoozeUntil(len);
    if (on) {
      setInbox((l) => l.filter((x) => x !== i));
      setSnoozed((l) => [...l, { ...i, snoozedUntil: until }]);
    } else {
      setSnoozed((l) => l.filter((x) => x !== i));
      setInbox((l) => [...l, { ...i, snoozedUntil: undefined }]);
    }
    if (i.profile === slug) setTickets((ts) => ts.map((t) => (t.id === i.id ? { ...t, attention: on ? null : i.attention, snoozed: on ? { attention: i.attention, until } : null } : t)));
    try {
      const t = await (on ? api.snooze(i.profile, i.id, snoozeBody(len)) : api.unsnooze(i.profile, i.id));
      const merge = (t: Ticket) => { if (i.profile === slugRef.current) setTickets((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...t } : x))); };
      if (on) toast(<>Snoozed <b>{i.title}</b> {snoozeWords(len)}</>, { action: { label: "Undo", run: () => void api.unsnooze(i.profile, i.id).then((t) => { merge(t); loadInbox(); }, () => {}) } });
      merge(t);
    } catch (e: any) {
      setError(`Couldn't ${on ? "snooze" : "unsnooze"} the ticket: ${e.message}`);
      if (i.profile === slugRef.current) loadTickets(i.profile).catch(() => {});
    }
    loadInbox();
  };
  /** Snooze all (the Inbox's Older group): each for a day, one toast with one Undo. */
  const inboxSnoozeAll = async (list: InboxItem[]) => {
    if (!list.length) return;
    const until = new Date(Date.now() + 24 * 3600_000).toISOString();
    const keys = new Set(list.map((i) => `${i.profile}/${i.id}`));
    const hit = (x: InboxItem) => keys.has(`${x.profile}/${x.id}`);
    setInbox((l) => l.filter((x) => !hit(x)));
    setSnoozed((l) => [...l.filter((x) => !hit(x)), ...list.map((i) => ({ ...i, snoozedUntil: until }))]);
    const here = new Map(list.filter((i) => i.profile === slug).map((i) => [i.id, i]));
    if (here.size) setTickets((ts) => ts.map((t) => {
      const i = here.get(t.id);
      return i ? { ...t, attention: null, snoozed: { attention: i.attention, until } } : t;
    }));
    const done = await Promise.allSettled(list.map((i) => api.snooze(i.profile, i.id)));
    const ok = list.filter((_, n) => done[n].status === "fulfilled");
    if (ok.length < list.length) setError(`Couldn't snooze ${list.length - ok.length} of ${list.length} tickets.`);
    if (ok.length) {
      toast(<>Snoozed {ok.length} {ok.length === 1 ? "ticket" : "tickets"} for a day</>, {
        action: {
          label: "Undo",
          run: () => void Promise.allSettled(ok.map((i) => api.unsnooze(i.profile, i.id))).then(() => {
            loadInbox();
            if (slugRef.current) loadTickets(slugRef.current).catch(() => {});
          }),
        },
      });
    }
    if (slug) loadTickets(slug).catch(() => {});
    loadInbox();
  };

  const openFrom = (board: string, id: string) => {
    if (board !== slug) setSlug(board);
    openTicket(id, board);
  };
  return { inboxDone, inboxSnooze, inboxSnoozeAll, openFrom };
}
