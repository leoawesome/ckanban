import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, type BrowserPick, type BrowsersState, type Profile, type Ticket } from "./api";
import { EFFORTS, MODELS } from "./models";
import { Select } from "./Select";
import { ASK_CHROME, BrowserPicker, picksText, useBrowsers } from "./BrowsersDialog";
import { Modal } from "./Modal";

const NEXT_RUN = "applies from the next run";

/**
 * Model, effort and ultracode for this ticket's next runs. A chip shows only when the ticket differs from the board's
 * default; otherwise one quiet "Model and effort" button opens them. The dropdowns list "Board default (x)" and every
 * option. Ultracode is a switch next to the effort level, like Claude Code's.
 */
/** "Opus · medium" (the ticket's own or the board's), under "Model and effort" in the ticket's ⋯ menu. */
export function runSettingsText(profile: Profile, ticket: Ticket): string {
  const level = (e: string | null | undefined) => (e === "ultracode" ? "xhigh" : e ?? "");
  const model = ticket.model || profile.model || "Default model";
  const effort = level(ticket.effort) || level(profile.effort) || "default effort";
  const ultra = ticket.ultracode ?? (ticket.effort === "ultracode" ? true : null) ?? (!!profile.ultracode || profile.effort === "ultracode");
  return `${model} · ${effort}${ultra ? " · ultracode" : ""}`;
}

/** "Model and effort" on a phone: a bottom sheet with one labelled row each (Done closes it). */
export function RunSheet({ profile, ticket, onError, onClose }: { profile: Profile; ticket: Ticket; onError: (msg: string) => void; onClose: () => void }) {
  return (
    <Modal title="Model and effort" onClose={onClose} className="run-sheet" focusDialog
      action={<button className="btn primary run-sheet-done" onClick={onClose}>Done</button>}>
      <p className="run-sheet-sub muted">For this ticket, from its next run.</p>
      <RunSettings profile={profile} ticket={ticket} onError={onError} startOpen rows />
    </Modal>
  );
}

/** startOpen: show every dropdown at once (opened from the ⋯ menu). rows: one labelled row each (the phone sheet). */
export function RunSettings({ profile, ticket, onError, startOpen = false, rows = false }: {
  profile: Profile; ticket: Ticket; onError: (msg: string) => void; startOpen?: boolean; rows?: boolean;
}) {
  const slug = profile.slug;
  const save = (patch: { model?: string | null; effort?: string | null; ultracode?: boolean | null }) =>
    api.updateTicket(slug, ticket.id, patch).catch((e) => onError(`Not saved: ${e.message}`));
  const model = ticket.model ?? "";
  // "ultracode" saved as the effort (the first version): xhigh with ultracode on.
  const level = (e: string | null | undefined) => (e === "ultracode" ? "xhigh" : e ?? "");
  const effort = level(ticket.effort);
  const boardEffort = level(profile.effort) || null;
  const boardUltra = !!profile.ultracode || profile.effort === "ultracode";
  const ultra = ticket.ultracode ?? (ticket.effort === "ultracode" ? true : null);
  const ultraValue = ultra === null ? "" : ultra ? "on" : "off";
  const customModel = model && !MODELS.includes(model) ? model : null;
  const [open, setOpen] = useState(startOpen);
  const differs = (v: string, board: string | null | undefined) => !!v && v !== (board ?? "");
  const showModel = open || differs(model, profile.model);
  const showEffort = open || differs(effort, boardEffort);
  const showUltra = open || (ultra !== null && ultra !== boardUltra);
  return (
    <span className={rows ? "run-rows" : "run-settings"}>
      {showModel && <RunChip rows={rows} label="Model" value={model} board={profile.model ?? null} onChange={(v) => save({ model: v || null })}
        options={[...MODELS, ...(customModel ? [customModel] : [])]} />}
      {showEffort && <RunChip rows={rows} label="Effort" value={effort} board={boardEffort} onChange={(v) => save({ effort: v || null })}
        options={EFFORTS} />}
      {showUltra && <RunChip rows={rows} label="Ultracode" short="Helper agents for big tasks" value={ultraValue} board={boardUltra ? "on" : "off"}
        onChange={(v) => save({ ultracode: v === "" ? null : v === "on" })} options={["on", "off"]}
        hint="Claude runs a workflow of helper agents for every big task. More thorough, uses much more of your plan." />}
      {(open || !!ownPicks(ticket)) && <BrowsersChip rows={rows} profile={profile} ticket={ticket} onError={onError} />}
      {!rows && !(showModel && showEffort) && (
        <button className="mini-link run-settings-more" onClick={() => setOpen(true)}
          title={`This ticket uses the board's ${showModel ? "effort" : showEffort ? "model" : "model and effort"}. Change it for this ticket`}>
          {showModel ? "Effort" : showEffort ? "Model" : "Model and effort"}
        </button>
      )}
    </span>
  );
}

/** A chip, or in `rows` a labelled row whose value always reads in full ("Board default (Opus)"). */
function RunRowOrChip({ rows, label, short, title, children }: { rows?: boolean; label: string; short?: string; title: string; children: ReactNode }) {
  if (!rows) return <span className="run-chip" title={title}>{children}</span>;
  return (
    <div className="run-row">
      <span className="run-row-label">{label}{short && <small>{short}</small>}</span>
      {children}
    </div>
  );
}

function RunChip({ label, value, board, options, onChange, hint, short, rows }: {
  label: string;
  /** One-line hint under the label in `rows`. */
  short?: string;
  rows?: boolean;
  /** Set for this ticket, or "" for the board's default. */
  value: string;
  board: string | null;
  options: string[];
  onChange: (v: string) => void;
  /** What the setting does, in the chip's tooltip. */
  hint?: string;
}) {
  const shown = value || board;
  const why = value ? `${label} set for this ticket` : `${label}: board default`;
  const boardLabel = `Board default${board ? ` (${board})` : ""}`;
  return (
    <RunRowOrChip rows={rows} label={label} short={short} title={`${why}, ${NEXT_RUN}${hint ? `. ${hint}` : ""}`}>
      <Select className={value ? "chip-set" : ""} ariaLabel={`${label} for this ticket, ${NEXT_RUN}`} value={value} onChange={onChange}
        renderValue={() => rows ? (value || boardLabel) : shown ? <><span className="run-key">{label}</span>{shown}</> : `Default ${label.toLowerCase()}`}
        options={[
          { value: "", label: boardLabel },
          ...options.map((o) => ({ value: o, label: o })),
        ]} />
    </RunRowOrChip>
  );
}

/** A board's or ticket's list, or its old single Chrome read as a list of one (server: chromes.ts ownPicks). */
function ownPicks(x: { browsers?: BrowserPick[] | null; chrome?: string | null }): BrowserPick[] | null {
  if (x.browsers?.length) return x.browsers;
  if (!x.chrome) return null;
  return x.chrome === ASK_CHROME ? [{ kind: "ask" }] : [{ kind: "chrome", id: x.chrome }];
}

/**
 * "Browsers: Fatt Interior WhatsApp" for this ticket's runs: opens a window to tick one or more browsers with notes, or
 * to follow the main ticket's (a tool step) or the board's choice. Shown once there is a browser to pick, or the ticket
 * already has its own.
 */
function BrowsersChip({ profile, ticket, onError, rows }: { profile: Profile; ticket: Ticket; onError: (msg: string) => void; rows?: boolean }) {
  const state = useBrowsers();
  const [open, setOpen] = useState(false);
  if (!state) return null;
  const own = ownPicks(ticket);
  const canPick = state.boardBrowsers.length > 0 || state.browsers.some((b) => b.name);
  if (!canPick && !own) return null;
  const above = ticket.browsersAbove?.length ? ticket.browsersAbove : (ticket.chromeAbove ? ownPicks({ chrome: ticket.chromeAbove }) : null);
  const fallback = picksText(above ?? ownPicks(profile), state);
  const defaultLabel = `${above ? "Main ticket's choice" : "Board's choice"}${fallback ? ` (${fallback})` : ""}`;
  const shown = own ? picksText(own, state) : null;
  const value = rows ? (shown ?? defaultLabel) : shown ?? fallback;
  return (
    <RunRowOrChip rows={rows} label="Browsers" title={`${own ? "Browsers set for this ticket" : `Browsers: ${defaultLabel}`}, ${NEXT_RUN}`}>
      <span className={`select${own ? " chip-set" : ""}`}>
        <button type="button" className="select-trigger" aria-haspopup="dialog" aria-label={`Browsers for this ticket, ${NEXT_RUN}`} onClick={() => setOpen(true)}>
          <span className="select-value">{rows ? value : value ? <><span className="run-key">Browsers</span>{value}</> : "Any browser"}</span>
        </button>
      </span>
      {open && createPortal(<TaskBrowsers state={state} own={own} defaultLabel={defaultLabel} onClose={() => setOpen(false)}
        onSave={(browsers) => api.updateTicket(profile.slug, ticket.id, { browsers }).then(() => setOpen(false), (e) => onError(`Not saved: ${e.message}`))} />, document.body)}
    </RunRowOrChip>
  );
}

/** The per-task pick: follow the board's (or main ticket's) choice, or tick this task's own browsers with notes. */
function TaskBrowsers({ state, own, defaultLabel, onSave, onClose }: {
  state: BrowsersState; own: BrowserPick[] | null; defaultLabel: string;
  onSave: (browsers: BrowserPick[] | null) => Promise<void>; onClose: () => void;
}) {
  const [mine, setMine] = useState(!!own);
  const [draft, setDraft] = useState<BrowserPick[]>(own ?? []);
  const [busy, setBusy] = useState(false);
  const done = async () => {
    const clean = draft.map((d) => (d.note?.trim() ? { ...d, note: d.note.trim() } : { kind: d.kind, ...(d.id ? { id: d.id } : {}) }));
    const next = mine && clean.length ? clean : null;
    if (JSON.stringify(next) === JSON.stringify(own)) return onClose();
    setBusy(true);
    await onSave(next);
    setBusy(false);
  };
  const changed = mine !== !!own || (mine && JSON.stringify(draft) !== JSON.stringify(own ?? []));
  return (
    <Modal title="Browsers for this task" onClose={onClose} guard={changed} className="task-browsers"
      action={<button className="btn primary run-sheet-done" disabled={busy} onClick={() => void done()}>{busy ? "Saving…" : "Done"}</button>}>
      <div className="browsers">
        <p className="muted small browsers-intro">From this task's next run. Add or sign in to browsers in More, Browsers.</p>
        <label className="browser-opt">
          <input type="radio" name="task-browsers" checked={!mine} onChange={() => setMine(false)} />
          <span className="browser-opt-main">{defaultLabel}</span>
        </label>
        <label className="browser-opt">
          <input type="radio" name="task-browsers" checked={mine} onChange={() => setMine(true)} />
          <span className="browser-opt-main">Pick for this task</span>
        </label>
        {mine && <BrowserPicker state={state} value={draft} onChange={setDraft} />}
      </div>
    </Modal>
  );
}
