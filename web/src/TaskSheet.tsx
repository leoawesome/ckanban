// A main ticket's chat while its tasks wait on the user: a short card per waiting task (with a one-click recommended
// answer and Open), a one-line trail for a task's earlier messages, the "N waiting on you" button above the message box,
// and the side sheet that slides a task's own chat in over the right side, so the user answers without leaving the page.
// The sheet's task lives in the URL hash (?sheet=<id>), so browser Back closes it.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Question } from "./api";
import { browserStore, forget, formKey } from "./drafts";
import { ChevronDownIcon, CloseIcon, ExternalIcon } from "./icons";
import { useFocusTrap, useLayer } from "./layers";
import type { StepInfo, StepMsg } from "./StepMessages";
import { cardQuestion, oneClick, oneLine, openForm, sheetFromHash, sheetHash, waitingLabel, type WaitingItem } from "./taskCards";
import { plainMarkdown } from "./miniMarkdown";
import { fullTime, timeAgo } from "./time";

/**
 * The task open in the side sheet (from the URL hash), with open and close. Open adds a history entry, so browser Back
 * closes the sheet; close goes back over that entry (or just drops ?sheet from the URL when the page opened with it).
 */
export function useSheet(ticketId: string): { id: string | null; open: (id: string) => void; close: () => void } {
  const [id, setId] = useState(() => sheetFromHash(location.hash));
  useEffect(() => {
    const on = () => setId(sheetFromHash(location.hash));
    on();
    window.addEventListener("hashchange", on);
    window.addEventListener("popstate", on);
    return () => {
      window.removeEventListener("hashchange", on);
      window.removeEventListener("popstate", on);
    };
  }, [ticketId]);
  const open = useCallback((to: string) => {
    const target = sheetHash(location.hash, to);
    if (location.hash !== target) {
      // One more entry to go back over when the ticket closes (ticketHistory.ts counts ckDepth).
      const s = history.state as { ckDepth?: unknown } | null;
      const state = s && typeof s.ckDepth === "number" ? { ...s, ckDepth: s.ckDepth + 1, ckSheet: true } : { ...(s ?? {}), ckSheet: true };
      history.pushState(state, "", target);
    }
    setId(to);
  }, []);
  const close = useCallback(() => {
    if (!sheetFromHash(location.hash)) return setId(null);
    if ((history.state as { ckSheet?: boolean } | null)?.ckSheet) history.back();
    else history.replaceState(history.state, "", sheetHash(location.hash, null));
    setId(null);
  }, []);
  return { id, open, close };
}

/** The side sheet: a task's own chat over the right side of the page, with a dimmed background. */
export function TaskSheet({ title, onClose, onOpenFull, children }: {
  title: string;
  onClose: () => void;
  onOpenFull: () => void;
  /** The task's chat. */
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  // Esc in a text box leaves the box for the sheet (the draft stays); the next Esc closes the sheet.
  useLayer(onClose, { skipInInputs: true });
  useFocusTrap(ref, true);
  // A close click is the sheet's alone: nothing under or around it reacts to the same click.
  const close = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };
  return createPortal(
    <>
      <div className="task-sheet-scrim" onClick={close} aria-hidden="true" />
      <section ref={ref} className="task-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
          if (!(e.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) return;
          e.preventDefault();
          ref.current?.focus({ preventScroll: true });
        }}>
        <div className="task-sheet-head">
          <span className="task-sheet-title" title={title}>{title}</span>
          <button className="btn ghost small" onClick={onOpenFull} title="Open this task's own page">Open full <ExternalIcon size={12} /></button>
          <button className="icon-btn" onClick={close} aria-label="Close" title="Close (Esc)"><CloseIcon size={14} /></button>
        </div>
        <div className="task-sheet-body panel-main">{children}</div>
      </section>
    </>,
    document.body,
  );
}

/**
 * A waiting task in the main chat: "<task> needs you", its short question, a one-click recommended answer when its form
 * has one (sent to the task like the form would send it), and Open (the side sheet).
 */
export function TaskCard({ slug, step, msgs, onOpen, onError, onSent }: {
  slug: string;
  step: StepInfo;
  msgs: StepMsg[];
  onOpen: (opener: HTMLElement) => void;
  onError: (msg: string) => void;
  onSent: (stepId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const form = openForm(msgs);
  const quick = oneClick(form?.questions as Question[] | undefined);
  const question = cardQuestion(msgs);
  const answer = async () => {
    if (!quick || busy) return;
    setBusy(true);
    try {
      await api.chat(slug, step.id, quick.text);
      if (form?.form) forget(browserStore(), formKey(slug, step.id, form.form.key));
      onSent(step.id);
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="task-card" role="group" aria-label={`${step.title} needs you`}>
      <div className="task-card-who">{step.title} needs you</div>
      {question && <div className="task-card-q">{question}</div>}
      <div className="task-card-actions">
        {quick && (
          <button className="btn small task-card-ok" disabled={busy || step.running} title={quick.title} onClick={() => void answer()}>
            {busy ? "Sending…" : <>✓ {quick.label}</>}
          </button>
        )}
        <button className="btn primary small" onClick={(e) => onOpen(e.currentTarget)}>Open</button>
      </div>
    </div>
  );
}

/** A task's earlier messages in the main chat, one short line each; Open shows them in full in the side sheet. */
export function TaskTrail({ step, msgs, newest, onOpen }: { step: StepInfo; msgs: StepMsg[]; newest: boolean; onOpen: (opener: HTMLElement) => void }) {
  const lines = msgs.map((m) => {
    if (m.role === "user") return { key: m.uuid, who: "You", text: oneLine(m.text), at: m.at };
    const q = m.questions?.[0]?.question;
    return { key: m.uuid, who: q ? "Asked" : "", text: oneLine(plainMarkdown(q ?? m.text)), at: m.at };
  }).filter((l) => l.text);
  return (
    <div className="task-trail" role="group" aria-label={step.title}>
      <div className="task-trail-head">
        <button className="link-btn" title="Open this task here" onClick={(e) => onOpen(e.currentTarget)}>{step.title}</button>
        {step.running && newest && <span className="muted"> · working</span>}
      </div>
      {lines.map((l) => (
        <div key={l.key} className="task-trail-line">
          {l.who && <b>{l.who}: </b>}{l.text}<span className="muted" title={fullTime(l.at)}> · {timeAgo(l.at)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * "3 waiting on you ▾" above the message box: a list, one row per item (task title in bold, short question after it);
 * a row opens its task in the sheet, or goes to this chat's own form. With one item the button opens it directly.
 */
export function WaitingButton({ items, onPick }: { items: WaitingItem[]; onPick: (item: WaitingItem, opener: HTMLElement) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayer(() => {
    setOpen(false);
    btn.current?.focus();
  }, { active: open });
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    list.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  useEffect(() => {
    if (!items.length) setOpen(false);
  }, [items.length]);
  if (!items.length) return null;
  const one = items.length === 1;
  const pick = (it: WaitingItem) => {
    setOpen(false);
    // The sheet gives focus back to this button when it closes (the row is gone by then).
    btn.current?.focus();
    onPick(it, btn.current!);
  };
  return (
    <div className="waiting-wrap">
      {open && (
        <div ref={list} className="waiting-list" role="menu" aria-label="Waiting on you"
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
            const i = rows.indexOf(document.activeElement as HTMLButtonElement);
            rows[(i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
          }}>
          {items.map((it) => (
            <button key={`${it.kind}-${it.id}`} role="menuitem" title={it.question ? `${it.title}: ${it.question}` : it.title} onClick={() => pick(it)}>
              <b>{it.title}</b>{it.question && <span>{it.question}</span>}
            </button>
          ))}
        </div>
      )}
      <button ref={btn} className="waiting-btn" aria-haspopup={one ? undefined : "menu"} aria-expanded={one ? undefined : open}
        title={one ? `${items[0].title}${items[0].question ? `: ${items[0].question}` : ""}` : undefined}
        onClick={() => (one ? pick(items[0]) : setOpen((v) => !v))}>
        {waitingLabel(items.length)}{!one && <ChevronDownIcon size={12} />}
      </button>
    </div>
  );
}
