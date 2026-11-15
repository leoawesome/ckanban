import { hashIsTicket, withTabLink } from "./tabLink";
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { HuddleState } from "../huddle/huddle";
import { type Ticket } from "../../lib/api";
import { useTicketDiff } from "../files/Changes";
import { useHelp } from "../../app/HelpMenu";
import { drawerTabs, type DrawerTab } from "../../app/keynav";
import { isFeature, parentLink, runsTasks } from "../family/family";
import { useShareNotices } from "../../lib/share";
import { useTicketUsage } from "../usage/UsagePanel";

/** The ticket panel's tabs: which show, the open one, its link, and what they count (moved from TicketDrawer.tsx). */
export function useDrawerTabs({
  children, familySize, huddleState, linked0, phone, setTab, slug, tabPick, ticket, tickets,
}: {
  children: Ticket[];
  familySize: number;
  huddleState: HuddleState;
  linked0: { tab: string | null; file: string | null; };
  phone: boolean;
  setTab: Dispatch<SetStateAction<DrawerTab>>;
  slug: string;
  tabPick: DrawerTab;
  ticket: Ticket;
  tickets: Ticket[];
}) {
  // The Family tab (Tasks) exists while the ticket runs tasks (below); Changes once Claude changed files (in a worktree, or in the
  // board's folder itself); Huddle once the ticket has had a huddle (or one is being started); Usage only while open
  // from the cost chip. A tab asked for (a card badge, Start huddle, the chip) shows while it is open.
  const inFolder = !ticket.worktree && !ticket.workdir && !ticket.branch && (ticket.runCount > 0 || !!ticket.sessionStarted || !!ticket.baseSha);
  const diffState = useTicketDiff(slug, ticket);
  // The tabs shown, in order ([ and ] step through them); opening one refreshes what it shows, like a click.
  // The Tasks tab is the ticket that runs tasks (a main ticket or a group); a plain ticket gets it only at the top of
  // its family. A task, or a card linked into a feature, links to its main ticket instead (Part of), so it never shows
  // its parent's family as if it were its own.
  const hasFamily = children.length > 0 || familySize > 1;
  const tasksTab = runsTasks(ticket) ? hasFamily : !ticket.tool && !parentLink(ticket) && hasFamily;
  const tabs = drawerTabs({
    phone, family: tasksTab,
    changes: !!(ticket.worktree || inFolder) && (!!diffState.diff?.files.length || tabPick === "changes"),
    huddle: huddleState.list.length > 0 || tabPick === "huddle",
    usage: tabPick === "usage",
  });
  const tab = tabs.includes(tabPick) ? tabPick : "chat";
  // The Tasks tab shows the plan's progress (the feature status) for a feature's top ticket, so the sidebar's Plan row steps aside.
  const whereShown = useMemo(() => isFeature(tickets, ticket), [tickets, ticket]);
  const help = useHelp(slug, ticket, !!diffState.diff?.files.length);
  const [outputCount, setOutputCount] = useState(0);
  const ticketUsage = useTicketUsage(slug, ticket.id);
  const openTab = (t: typeof tabPick) => {
    if (t === "changes") diffState.reload();
    else if (t === "outputs") setOutputFocus(null);
    else if (t === "usage") ticketUsage.reload();
    setTab(t);
  };
  // The tab row is one Tab stop: ←/→ (Home/End) move between tabs and open them, as tabs do.
  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const at = tabs.indexOf(tab);
    const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (to === null || e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    const next = tabs[(to + tabs.length) % tabs.length];
    openTab(next);
    requestAnimationFrame(() => document.getElementById(`ticket-tab-${next}`)?.focus());
  };
  const usage = ticketUsage.usage;
  const hasUsage = !!usage?.runs.length;
  useShareNotices(ticket);
  // A file to show when the Outputs tab opens (a mockup clicked in the chat).
  const [outputFocus, setOutputFocus] = useState<string | null>(linked0.file);
  // The file open in Outputs, for the link (null: none picked).
  const [linkFile, setLinkFile] = useState<{ id: string; name: string | null }>({ id: ticket.id, name: linked0.file });
  const fileForLink = linkFile.id === ticket.id ? linkFile.name : null;
  // Keep the open tab in the link (replace: switching tabs doesn't add Back steps).
  useEffect(() => {
    if (!hashIsTicket(location.hash, ticket.id)) return;
    const next = withTabLink(location.hash, tab, fileForLink);
    if (next !== location.hash) history.replaceState(history.state, "", next);
  }, [tab, fileForLink, ticket.id]);
  return { diffState, hasUsage, help, onTabKey, openTab, outputCount, outputFocus, setLinkFile, setOutputCount, setOutputFocus, tab, tabs, ticketUsage, usage, whereShown };
}
