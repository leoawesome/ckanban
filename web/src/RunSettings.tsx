import { useState, type ReactNode } from "react";
import { api, type Profile, type Ticket } from "./api";
import { EFFORTS, MODELS } from "./models";
import { Select } from "./Select";
import { ASK_CHROME, chromeLabel, useBrowsers } from "./BrowsersDialog";
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
  const save = (patch: { model?: string | null; effort?: string | null; ultracode?: boolean | null; chrome?: string | null }) =>
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
      {(open || !!ticket.chrome) && <ChromeChip rows={rows} profile={profile} ticket={ticket} onChange={(v) => save({ chrome: v || null })} />}
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

/**
 * "Chrome: Work" for this ticket's runs (More → Browsers names them). Shown once two or more Chromes are named, or the
 * ticket already has its own. The default is the main ticket's pick for a tool step, else the board's.
 */
function ChromeChip({ profile, ticket, onChange, rows }: { profile: Profile; ticket: Ticket; onChange: (v: string) => void; rows?: boolean }) {
  const state = useBrowsers();
  if (!state) return null;
  const named = state.browsers.filter((b) => b.name);
  if (named.length < 2 && !ticket.chrome) return null;
  const nameOf = (v: string | null | undefined) =>
    !v ? null : v === ASK_CHROME ? "Ask each time" : chromeLabel(state.browsers.find((b) => b.deviceId === v))
  const above = ticket.chromeAbove ?? null;
  const fallback = nameOf(above ?? profile.chrome);
  const own = ticket.chrome ?? "";
  const shown = nameOf(own) ?? fallback;
  const defaultLabel = `${above ? "Main ticket's" : "Board default"}${fallback ? ` (${fallback})` : ""}`;
  const options = [
    { value: "", label: defaultLabel },
    ...named.map((b) => ({ value: b.deviceId, label: b.name })),
    { value: ASK_CHROME, label: "Ask each time" },
    ...(own && own !== ASK_CHROME && !named.some((b) => b.deviceId === own) ? [{ value: own, label: nameOf(own) ?? "Unnamed Chrome" }] : []),
  ];
  return (
    <RunRowOrChip rows={rows} label="Chrome" title={`${own ? "Chrome set for this ticket" : `Chrome: ${defaultLabel.toLowerCase()}`}, ${NEXT_RUN}. Claude stops and asks if it isn't connected.`}>
      <Select className={own ? "chip-set" : ""} ariaLabel={`Chrome for this ticket, ${NEXT_RUN}`} value={own} onChange={onChange}
        renderValue={() => rows ? (own ? nameOf(own) ?? "Unnamed Chrome" : fallback ? defaultLabel : "Any Chrome") : shown ? <><span className="run-key">Chrome</span>{shown}</> : "Any Chrome"}
        options={options} />
    </RunRowOrChip>
  );
}
