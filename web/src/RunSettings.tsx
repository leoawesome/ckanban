import { useState } from "react";
import { api, type Profile, type Ticket } from "./api";
import { EFFORTS, MODELS } from "./models";
import { Select } from "./Select";

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

/** startOpen: show every dropdown at once (opened from the ⋯ menu). */
export function RunSettings({ profile, ticket, onError, startOpen = false }: { profile: Profile; ticket: Ticket; onError: (msg: string) => void; startOpen?: boolean }) {
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
    <span className="run-settings">
      {showModel && <RunChip label="Model" value={model} board={profile.model ?? null} onChange={(v) => save({ model: v || null })}
        options={[...MODELS, ...(customModel ? [customModel] : [])]} />}
      {showEffort && <RunChip label="Effort" value={effort} board={boardEffort} onChange={(v) => save({ effort: v || null })}
        options={EFFORTS} />}
      {showUltra && <RunChip label="Ultracode" value={ultraValue} board={boardUltra ? "on" : "off"}
        onChange={(v) => save({ ultracode: v === "" ? null : v === "on" })} options={["on", "off"]}
        hint="Claude runs a workflow of helper agents for every big task. More thorough, uses much more of your plan." />}
      {!(showModel && showEffort) && (
        <button className="mini-link run-settings-more" onClick={() => setOpen(true)}
          title={`This ticket uses the board's ${showModel ? "effort" : showEffort ? "model" : "model and effort"}. Change it for this ticket`}>
          {showModel ? "Effort" : showEffort ? "Model" : "Model and effort"}
        </button>
      )}
    </span>
  );
}

function RunChip({ label, value, board, options, onChange, hint }: {
  label: string;
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
  return (
    <span className="run-chip" title={`${why}, ${NEXT_RUN}${hint ? `. ${hint}` : ""}`}>
      <Select className={value ? "chip-set" : ""} ariaLabel={`${label} for this ticket, ${NEXT_RUN}`} value={value} onChange={onChange}
        renderValue={() => shown ? <><span className="run-key">{label}</span>{shown}</> : `Default ${label.toLowerCase()}`}
        options={[
          { value: "", label: `Board default${board ? ` (${board})` : ""}` },
          ...options.map((o) => ({ value: o, label: o })),
        ]} />
    </span>
  );
}
