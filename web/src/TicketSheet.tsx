import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type HelpKind } from "./api";
import { chipText, type ContextView } from "./contextText";
import { HELP_ITEMS, type HelpState } from "./HelpMenu";
import { messageHash, useHelper } from "./helper";
import { ChevronRightIcon } from "./icons";
import { Modal } from "./Modal";

/** The helper's line about this ticket's open wait (the Inbox's "Urgent: Phone 14:02; …") and its message, while the helper is on. */
export function useHelperLine(slug: string, ticketId: string): { line: string; msg?: string } | null {
  const { status } = useHelper();
  const key = `${slug}/${ticketId}`;
  const line = status?.on ? status.lines[key] : undefined;
  return line ? { line, msg: status?.lineMsg?.[key] } : null;
}

/**
 * Phones: the ticket's details sheet, opened by tapping the title in the header: the whole title, the status in words,
 * Move to (every column, as the old status picker), then cost, chat memory, pin, star, alerts, rename and help.
 * `focusMove`: opened by M / "Move to a column…": the keyboard lands on the current column.
 */
export function TicketSheet({ slug, ticketId, title, status, tone, columns, current, onMove, goal, cost, onCost, onContext, pin, star,
  help, onHelp, onRename, focusMove, onClose }: {
  slug: string;
  ticketId: string;
  title: string;
  /** "Your turn: review the result", "Running". */
  status: ReactNode;
  tone: string;
  columns: { value: string; label: string; hint?: string }[];
  current: string;
  onMove: (column: string) => void;
  /** "Show me where" for a ticket that waits on the user: its button words and action. */
  goal?: { label: string; onGo: () => void } | null;
  /** "$6.09", or null before the first run. */
  cost: string | null;
  onCost: () => void;
  onContext: () => void;
  pin?: { on: boolean; toggle: () => void } | null;
  star: { on: boolean; toggle: () => void };
  help: HelpState;
  onHelp: (kind: HelpKind) => void;
  onRename: (title: string) => Promise<void>;
  focusMove?: boolean;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const alert = useHelperLine(slug, ticketId);
  const [ctx, setCtx] = useState<ContextView | null>(null);
  useEffect(() => {
    let live = true;
    // The last check's result only (no new check): the Context panel itself checks when opened.
    api.ticketContext(slug, ticketId, false).then((v) => live && setCtx(v), () => {});
    return () => { live = false; };
  }, [slug, ticketId]);
  useEffect(() => {
    if (!focusMove) return;
    requestAnimationFrame(() => box.current?.closest(".modal")?.querySelector<HTMLButtonElement>(".ts-col.current")?.focus());
  }, [focusMove]);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(title);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const saveName = async () => {
    const t = name.replace(/\s*\n\s*/g, " ").trim();
    if (!t || t === title) return setRenaming(false);
    setSaving(true);
    setRenameError(null);
    try {
      await onRename(t);
      setRenaming(false);
    } catch (e) {
      setRenameError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const go = (fn: () => void) => () => { onClose(); fn(); };
  const helpItems = HELP_ITEMS.filter((i) => help.available[i.kind]);
  const memory = ctx?.result ? chipText(ctx) : null;
  return (
    <Modal title={title} onClose={onClose} className="ticket-sheet" focusDialog>
      <div ref={box} className="ts-body">
        <div className={`ts-status tone-${tone}`}><span className="ts-dot" aria-hidden />{status}</div>
        <div className="ts-label" id="ts-move">Move to</div>
        <div className="ts-cols" role="group" aria-labelledby="ts-move">
          {columns.map((c) => (
            <button key={c.value} type="button" className={`ts-col${c.value === current ? " current" : ""}`} aria-pressed={c.value === current}
              title={c.hint} onClick={() => { onClose(); if (c.value !== current) onMove(c.value); }}>{c.label}</button>
          ))}
        </div>
        {goal && (
          <button type="button" className="btn primary ts-goal" onClick={go(goal.onGo)}>{goal.label} <ChevronRightIcon size={12} /></button>
        )}
        <div className="ts-rows">
          {cost && <Row label="Cost so far" value={cost} onClick={go(onCost)} />}
          <Row label="Chat memory used" value={memory ?? "Check"} onClick={go(onContext)} />
          {pin && <Row label="Pin to top" value={pin.on ? "On" : "Off"} pressed={pin.on} onClick={pin.toggle} />}
          <Row label="Star as important" value={star.on ? "On" : "Off"} pressed={star.on} onClick={star.toggle} />
          {alert && (alert.msg
            ? <a className="ts-row" href={messageHash(alert.msg)} onClick={onClose}><span className="ts-row-label">Alerts for this ticket<small>{alert.line}</small></span><span className="ts-row-value">Open <ChevronRightIcon size={12} /></span></a>
            : <div className="ts-row static"><span className="ts-row-label">Alerts for this ticket<small>{alert.line}</small></span></div>)}
          {renaming ? (
            <div className="ts-rename">
              <textarea aria-label="Title" rows={2} value={name} autoFocus onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void saveName(); }
                  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setName(title); setRenaming(false); }
                }} />
              {renameError && <div className="form-error">Title not saved: {renameError}</div>}
              <div className="ts-rename-actions">
                <button type="button" className="btn" onClick={() => { setName(title); setRenaming(false); }}>Cancel</button>
                <button type="button" className="btn primary" disabled={saving || !name.trim()} onClick={() => void saveName()}>{saving ? "Saving…" : "Save"}</button>
              </div>
            </div>
          ) : <Row label="Rename" onClick={() => { setName(title); setRenaming(true); }} />}
          {helpItems.length > 0 && <div className="ts-label ts-help-label">Help me understand</div>}
          {helpItems.map((i) => (
            <Row key={i.kind} label={i.question} sub={help.busy.includes(i.kind) ? "Working on it…" : i.hint} disabled={help.busy.includes(i.kind)}
              onClick={go(() => onHelp(i.kind))} />
          ))}
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, sub, value, onClick, pressed, disabled }: { label: string; sub?: string; value?: string; onClick: () => void; pressed?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className="ts-row" onClick={onClick} aria-pressed={pressed} disabled={disabled}>
      <span className="ts-row-label">{label}{sub && <small>{sub}</small>}</span>
      <span className="ts-row-value">{value}{pressed === undefined && <ChevronRightIcon size={12} />}</span>
    </button>
  );
}
