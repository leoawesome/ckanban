import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { api, safeHref, subscribe, type ClaudeSession, type Ticket } from "../../lib/api";
import { recentOutputs } from "../files/outputsOnce";
import { type DrawerTab } from "../../app/keynav";

/** The ticket panel's tab bar scroll, outputs count and title/description sync (moved from TicketDrawer.tsx). */
export function useDrawerSync({ editing, setBaseBody, setBody, setLinked, setOutputCount, setTitle, slug, tab, tabs, ticket, titleRef }: {
  editing: boolean;
  setBaseBody: Dispatch<SetStateAction<string>>;
  setBody: Dispatch<SetStateAction<string>>;
  setLinked: Dispatch<SetStateAction<ClaudeSession | null>>;
  setOutputCount: Dispatch<SetStateAction<number>>;
  setTitle: Dispatch<SetStateAction<string>>;
  slug: string;
  tab: DrawerTab;
  tabs: DrawerTab[];
  ticket: Ticket;
  titleRef: RefObject<HTMLInputElement & HTMLTextAreaElement>;
}) {
  // The tab bar scrolls sideways on narrow screens: fade its right edge while tabs are hidden there,
  // and keep the open tab in view.
  const tabsRef = useRef<HTMLElement>(null);
  const [tabsMore, setTabsMore] = useState(false);
  const checkTabs = () => {
    const el = tabsRef.current;
    setTabsMore(!!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(checkTabs);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = tabsRef.current;
    const on = el?.querySelector<HTMLElement>("button.active");
    if (el && on) {
      const r = on.getBoundingClientRect();
      const n = el.getBoundingClientRect();
      if (r.left < n.left || r.right > n.right) el.scrollLeft += r.left - n.left - (n.width - r.width) / 2;
    }
    checkTabs();
  }, [tab, tabs.length]);

  const links = (ticket.links ?? []).filter((l) => safeHref(l.url));
  const loadOutputs = () => recentOutputs(slug, ticket.id).then((o) => setOutputCount(o.length)).catch(() => {});

  useEffect(() => {
    loadOutputs();
    api.ticket(slug, ticket.id).then((t) => { setBody(t.body); setBaseBody(t.body); setTitle(t.title); }).catch(() => {});
  }, [slug, ticket.id]);

  useEffect(() => {
    if (!ticket.workdir || !ticket.sessionId) return setLinked(null);
    api.sessions(slug).then((ss) => setLinked(ss.find((s) => s.id === ticket.sessionId) ?? null)).catch(() => {});
  }, [slug, ticket.sessionId, ticket.workdir, ticket.status]);

  useEffect(() => subscribe((e) => {
    if (e.type === "ticket.updated" && e.profile === slug && e.ticket.id === ticket.id) loadOutputs();
  }), [slug, ticket.id]);

  useEffect(() => {
    if (!editing) {
      setBody(ticket.body);
      setBaseBody(ticket.body);
    }
  }, [ticket.body]);
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitle(ticket.title);
  }, [ticket.title]);

  return { checkTabs, links, tabsMore, tabsRef };
}
