import { useEffect, useRef, useState } from "react";
import { api, type Profile, type Ticket } from "../../lib/api";
import { BellIcon } from "../../components/icons";
import { useLayer } from "../../lib/layers";
import { RunSettings, RunSheet } from "./RunSettings";
import { oldChat } from "../chat/cacheNote";
import { useFeatureStatus } from "./StatusBlock";
import { taskProgress } from "./tasksText";
import { usePhone } from "../../hooks/usePhone";
import { messageHash } from "../helper/helper";
import { useHelperLine } from "./TicketSheet";

/**
 * A run waiting on the user (usage limit, spending cap, stall): one line and its main button; "Details" opens the
 * longer explanation and the other choices.
 */
export function WaitBanner({ line, details, actions }: { line: string; details: React.ReactNode; actions: (open: boolean) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="banner warn inline limit-banner" role="status">
      <span className="limit-line">
        <strong>{line}</strong>
        <button className="link-btn limit-details" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Less" : "Details"}</button>
      </span>
      {actions(open)}
      {open && <div className="limit-more">{details}</div>}
    </div>
  );
}


/**
 * What the helper did about this ticket's open wait ("Urgent: Phone 14:02; reminders stopped when you opened this",
 * "In the 16:00 summary: ..."), the same line as the Inbox's, while the helper is on: a small bell next to the title with
 * the line as its tooltip. It opens the alert's message when there is one.
 */
export function HelperIcon({ slug, ticketId }: { slug: string; ticketId: string }) {
  const alert = useHelperLine(slug, ticketId);
  if (!alert) return null;
  const { line, msg } = alert;
  const cls = `icon-btn helper-icon${line.startsWith("Urgent") ? " urgent" : ""}`;
  return msg
    ? <a className={cls} href={messageHash(msg)} title={`${line} · open the message`} aria-label={`${line}. Open the message`}><BellIcon size={14} /></a>
    : <span className={cls} role="img" tabIndex={0} title={line} aria-label={line}><BellIcon size={14} /></span>;
}

/** "Model and effort" from the ⋯ menu: the dropdowns under the header's first row, with Done (Esc closes too). */
/** "Model and effort": a row under the header on a desktop, a bottom sheet with one labelled row per setting on a phone. */
export function RunPopover(props: { profile: Profile; ticket: Ticket; onError: (m: string) => void; onClose: () => void }) {
  return usePhone() ? <RunSheet {...props} /> : <RunRow {...props} />;
}

function RunRow({ profile, ticket, onError, onClose }: { profile: Profile; ticket: Ticket; onError: (m: string) => void; onClose: () => void }) {
  useLayer(onClose);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(".select-trigger")?.focus()); }, []);
  return (
    <div className="run-popover" ref={ref} role="group" aria-label="Model and effort for this ticket">
      <span className="field-key">Model and effort</span>
      <RunSettings profile={profile} ticket={ticket} onError={onError} startOpen />
      <button className="btn small" onClick={onClose}>Done</button>
    </div>
  );
}

/**
 * Whether the form, card or message the ticket waits on (attentionGoal's targets, not the message box it falls back to)
 * is on screen in the panel: the sidebar's "Answer questions" button hides meanwhile. Re-checked as the chat changes.
 */
export function useGoalOnScreen(panelRef: React.RefObject<HTMLElement | null>, targets: string[] | null): boolean {
  const [onScreen, setOnScreen] = useState(false);
  const key = targets?.join("|") ?? "";
  useEffect(() => {
    setOnScreen(false);
    const panel = panelRef.current;
    const sels = (targets ?? []).filter((t) => t !== ".reply-text");
    if (!panel || !sels.length || typeof IntersectionObserver === "undefined") return;
    let watched: Element | null = null;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.target === watched) setOnScreen(e.isIntersecting);
    });
    const find = () => {
      const main = panel.querySelector(".panel-main");
      for (const sel of sels) {
        const all = main?.querySelectorAll(sel);
        if (all?.length) return all[all.length - 1];
      }
      return null;
    };
    let frame = 0;
    const check = () => {
      frame = 0;
      const el = find();
      if (el === watched) return;
      if (watched) io.unobserve(watched);
      watched = el;
      if (el) io.observe(el);
      else setOnScreen(false);
    };
    check();
    const mo = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(check); });
    mo.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    return () => {
      mo.disconnect();
      io.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [panelRef, key]);
  return onScreen;
}

/** The feature's "Where we are" at the top of a main ticket's sidebar: progress, what is done, what waits, what's next. */
export function WhereWeAre({ slug, ticket, tickets, onOpen }: { slug: string; ticket: Ticket; tickets: Ticket[]; onOpen: () => void }) {
  const { status } = useFeatureStatus(slug, ticket, tickets);
  if (!status) return null;
  const { done, total } = taskProgress(status.facts);
  const saved = status.saved;
  return (
    <section className="where-we-are" aria-label="Where we are">
      <div className="section-head">
        <h3 className="sec-h">Where we are</h3>
        <button className="mini-link" onClick={onOpen} title="The whole status and every task, in the Tasks tab">Tasks ▸</button>
      </div>
      {total > 0 && <div className="wwa-count muted small">{done} of {total} tasks done</div>}
      {saved?.done && <p className="wwa-line">{saved.done}</p>}
      {saved?.waiting && <p className="wwa-line"><b>Waiting on you:</b> {saved.waiting}</p>}
      {saved?.next && <p className="wwa-line"><b>Next:</b> {saved.next}</p>}
      {!saved && <p className="wwa-line muted small">No status written yet.</p>}
    </section>
  );
}

/** The chat is old (cacheNote.ts): the next message re-reads it all. Fresh chat starts a new session; the status stays. */
export function OldChatNote({ slug, ticket, working, feature, onError }: { slug: string; ticket: Ticket; working: boolean; feature: boolean; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  // Re-checked every minute: a chat turns old an hour (or 5 minutes) after Claude's last reply.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const old = oldChat({ cache: ticket.session?.cache, running: working, freshSession: ticket.freshSession, now });
  if (!old) return null;
  const fresh = async () => {
    setBusy(true);
    try {
      await api.freshChat(slug, ticket.id);
    } catch (e: any) {
      onError(`Fresh chat not started: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="old-chat-note" title={old.title}>
      <span>{old.line}</span>
      <button className="btn small" disabled={busy} onClick={fresh}
        title={`Your next message starts a new chat: Claude starts from ${feature ? "the status" : "the ticket and its last result"}. The chat history${feature ? ", status" : ""} and outputs stay.`}>
        {busy ? "Starting…" : feature ? "Fresh chat (keeps status)" : "Fresh chat"}
      </button>
    </div>
  );
}
