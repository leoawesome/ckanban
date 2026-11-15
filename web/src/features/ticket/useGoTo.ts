import { api, type Ticket } from "../../lib/api";
import { type DrawerTab } from "../../app/keynav";
import { pickAsk, type AttentionGoal } from "../board/attentionGoal";
import type { RefObject } from "react";

/** The ticket panel's "Your turn" jump: opens the tab the ticket waits in and highlights what to act on (moved from TicketDrawer.tsx). */
export function useGoTo({ goal, openTab, panelRef, slug, tabs, ticket, whereShown }: {
  goal: AttentionGoal | null;
  openTab: (t: DrawerTab) => void;
  panelRef: RefObject<HTMLElement>;
  slug: string;
  tabs: DrawerTab[];
  ticket: Ticket;
  whereShown: boolean;
}) {
  // Opens the tab the ticket waits in, scrolls to the form, card or message to act on and highlights it for a moment.
  // The chat may still be loading: it looks again on each frame for up to 3 seconds.
  // A blocked ticket ("See what Claude needs") lands on Claude's latest reply that asks something; when none of the
  // recent ones does, on the feature status's "Waiting on you" line in the Tasks tab; else on the last reply.
  const goTo = () => {
    if (!goal) return;
    openTab(goal.tab);
    const until = performance.now() + 3000;
    const main = () => panelRef.current?.querySelector(".panel-main");
    const newest = (sels: string[]) => {
      for (const sel of sels) {
        const all = main()?.querySelectorAll<HTMLElement>(sel);
        if (all?.length) return all[all.length - 1];
      }
      return null;
    };
    const flash = (el: HTMLElement) => {
      el.classList.remove("attn-flash");
      void el.offsetWidth; // restart the highlight when pressed again
      el.classList.add("attn-flash"); // first: its scroll margin keeps the ring in view
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
      // The keyboard lands in the form too: its first field or button (or the box itself).
      const field = el.querySelector<HTMLElement>("input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select, button:not(:disabled)");
      if (field) field.focus({ preventScroll: true });
      else {
        if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
        el.focus({ preventScroll: true });
      }
      setTimeout(() => el.classList.remove("attn-flash"), 2200);
    };
    // Waits for the target to render (the chat or Tasks tab may still be loading), then flashes it.
    const land = (find: () => HTMLElement | null | "handled" | Promise<HTMLElement | null | "handled">) => {
      const step = async () => {
        const el = await find();
        if (el === "handled") return;
        if (el) flash(el);
        else if (performance.now() < until) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    if (goal.find !== "ask") return land(() => newest(goal.targets));
    let statusAsk: Promise<string | undefined> | undefined; // fetched once per press
    land(async () => {
      // Only the chat's newest items: Claude's replies and the user's messages, newest last (bounded for long chats).
      const nodes = [...(main()?.querySelectorAll<HTMLElement>(".reply-text:not(.writing), .conv-msg.user") ?? [])].slice(-40);
      if (!nodes.length) return null;
      const items = nodes.map((n) => {
        if (n.matches(".conv-msg.user")) return { user: true as const };
        const words = n.cloneNode(true) as HTMLElement;
        words.querySelectorAll("pre, code").forEach((c) => c.remove());
        return { text: words.textContent ?? "", bold: [...n.querySelectorAll("strong, b")].map((b) => b.textContent ?? "") };
      });
      const i = pickAsk(items);
      if (i >= 0) return nodes[i];
      const fallback = newest(goal.targets);
      // Nothing recent asks: the feature status's saved "Waiting on you" line, in the Tasks tab, says what to do.
      if (whereShown && tabs.includes("family")) {
        statusAsk ??= api.featureStatus(slug, ticket.id).then((s) => s.saved?.waiting?.trim(), () => "");
        const waiting = await statusAsk;
        if (waiting) {
          openTab("family");
          land(() => main()?.querySelector<HTMLElement>("[data-attn=waiting]") ?? null);
          return "handled";
        }
      }
      return fallback;
    });
  };
  return { goTo };
}
