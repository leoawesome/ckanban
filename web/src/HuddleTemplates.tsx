import { useEffect, useState, type KeyboardEvent } from "react";
import { api, type HuddlePreset, type HuddleTemplate, type Level, type SquadCardRef, type SquadDraft, type TeamUsage } from "./api";
import { RosterEditor, rosterDraft, templateRules, type RosterDraft } from "./HuddleRoster";
import { DEFAULT_BUDGET } from "./huddleText";
import { useSquadSave } from "./SquadCard";
import { personHandle } from "./squadText";
import { resetTitle, scopeChip, usageText } from "./teamText";

type Draft = { name: string; label: string; description: string; rounds: string; budget: string; report: string; hostRules: string; roster: RosterDraft };

/** Enter in these inputs must not submit anything around them. */
const noSubmit = (e: KeyboardEvent) => {
  if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
};

const toDraft = (t: SquadDraft | null): Draft => ({
  name: t?.name ?? "", label: t?.label ?? "", description: t?.description ?? "",
  rounds: t?.rounds ? String(t.rounds) : "", budget: String(t?.maxCostUsd ?? DEFAULT_BUDGET), report: t?.report ?? "", hostRules: t?.hostRules ?? "",
  roster: rosterDraft(t?.roster ?? [{ preset: "reviewer" }]),
});

const fromDraft = (d: Draft): SquadDraft => ({
  name: d.name.trim(), label: d.label.trim(), description: d.description, report: d.report, hostRules: d.hostRules,
  rounds: d.rounds.trim() ? Number(d.rounds) : null,
  maxCostUsd: d.budget.trim() ? Number(d.budget) : null,
  roster: d.roster.rows.map(({ key: _k, ...e }) => ({ ...e, focus: e.focus?.trim() || undefined })),
});

type Editing = {
  draft: Draft; isNew: boolean; scope: Level; current: HuddleTemplate | null;
  /** Opened from a squad card or "Save as squad…": saved like the card (people with no teammate become teammates). */
  fromCard: boolean;
  card?: SquadCardRef;
};

/**
 * The Team tab's Squads view: saved huddles to start on any ticket (people with their focus, how the host runs it,
 * rounds, budget and report format), each with Start huddle. Saved for all boards (default) or this board only, like
 * teammates. Saves right away.
 */
export function TeamSquads({ slug, squads, loading, filtered, presets, usage, startHint, newRequest, editRequest, onChanged, onError, onStart }: {
  slug: string;
  /** The squads to list (filtered). */
  squads: HuddleTemplate[];
  loading: boolean;
  filtered: boolean;
  presets: HuddlePreset[] | null;
  usage: Record<string, TeamUsage> | null;
  startHint: string;
  /** Changes when "+ New squad" is pressed. */
  newRequest: number;
  /** The editor filled in from a squad card (Edit first, or "Save as squad…"'s Open the editor); n changes per request. */
  editRequest?: { draft: SquadDraft; card?: SquadCardRef; n: number } | null;
  onChanged: () => void;
  onError: (m: string | null) => void;
  onStart: (name: string) => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const cardSave = useSquadSave(slug, editing?.card, () => { setEditing(null); onChanged(); }, (m) => onError(m));

  const edit = (t: HuddleTemplate | null) => {
    onError(null);
    setEditing({ draft: toDraft(t), isNew: !t, scope: t?.source === "board" ? "board" : "global", current: t, fromCard: false });
  };
  useEffect(() => {
    if (newRequest) edit(null);
  }, [newRequest]);
  useEffect(() => {
    if (!editRequest) return;
    onError(null);
    setEditing({ draft: toDraft(editRequest.draft), isNew: true, scope: "board", current: null, fromCard: true, card: editRequest.card });
  }, [editRequest?.n]);

  const save = async () => {
    if (!editing) return;
    const { draft, scope } = editing;
    onError(null);
    if (editing.fromCard) return cardSave.save(fromDraft(draft), scope);
    setBusy(true);
    try {
      await api.saveHuddleTemplate(slug, fromDraft(draft), scope);
      setEditing(null);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: HuddleTemplate) => {
    setBusy(true);
    onError(null);
    try {
      await api.deleteHuddleTemplate(slug, t.name, t.source === "global" ? "global" : "board");
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    const { draft, isNew, scope } = editing;
    const working = busy || cardSave.busy;
    const set = (patch: Partial<Draft>) => setEditing((x) => x && { ...x, draft: { ...x.draft, ...patch } });
    const title = editing.fromCard ? `Save the squad${draft.label ? ` ${draft.label}` : ""}` : isNew ? "New squad" : editing.current?.source === "builtin" ? `Customise ${draft.label}` : `Edit ${draft.label}`;
    return (
      <div className="tm-pane tm-edit tt-edit form" onKeyDown={noSubmit}>
        <div className="tm-head"><h3>{title}</h3></div>
        {editing.fromCard && <p className="muted small tt-edit-note">People with no teammate of their name are saved as new teammates with the squad.</p>}
        <div className="row two">
          <label>
            Name
            <input className="mono" value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={!isNew} placeholder="design-review" spellCheck={false} autoFocus={isNew} />
          </label>
          <label>
            Label
            <input value={draft.label} onChange={(e) => set({ label: e.target.value })} placeholder="Design review" />
          </label>
        </div>
        <label>
          What it's for
          <input value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="Critics review a feature from several angles; a facilitator ranks the findings." />
        </label>
        <div className="row two">
          <label>
            Rounds
            <input type="number" min={1} max={20} value={draft.rounds} onChange={(e) => set({ rounds: e.target.value })} placeholder="no limit" />
          </label>
          <label>
            Budget ($)
            <input type="number" min={1} step={1} value={draft.budget} onChange={(e) => set({ budget: e.target.value })} />
          </label>
        </div>
        <label>
          How the host runs it
          <textarea rows={4} value={draft.hostRules} onChange={(e) => set({ hostRules: e.target.value })}
            placeholder={"The steps the host follows each time, e.g.\n1. Post the topic's points, no names.\n2. Everyone posts on their own first.\n3. Debate by name; report only when nobody has anything missing."} />
        </label>
        <label>
          Report format
          <textarea rows={2} value={draft.report} onChange={(e) => set({ report: e.target.value })}
            placeholder="How teammates report, e.g. one finding per line: [MUST|SHOULD|COULD] file:line - problem - fix. Report to @facilitator." />
        </label>
        <div className="hp-roster">
          <span className="small">People</span>
          <RosterEditor presets={presets} draft={draft.roster} setDraft={(roster) => set({ roster })} tickets={[]} hostId="" hideMain pickHost noFocus disabled={working} />
        </div>
        <div className="tt-focus">
          <span className="small">Each person's focus</span>
          {draft.roster.rows.map((r) => (
            <label key={r.key} className="tt-focus-row">
              <span className="mono">@{personHandle(r)}</span>
              <textarea rows={2} value={r.focus ?? ""} placeholder="What this person looks at, in any ticket" disabled={working}
                onChange={(e) => set({ roster: { ...draft.roster, rows: draft.roster.rows.map((x) => (x.key === r.key ? { ...x, focus: e.target.value } : x)) } })} />
            </label>
          ))}
        </div>
        <div className="tm-scope">
          <span className="small">Use on</span>
          <div className="segmented" role="radiogroup" aria-label="Use on">
            {([["global", "All boards"], ["board", "This board"]] as const).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={scope === v} className={scope === v ? "on" : undefined}
                onClick={() => setEditing((x) => x && { ...x, scope: v })}>{label}</button>
            ))}
          </div>
        </div>
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost small" onClick={() => { setEditing(null); onError(null); }}>Cancel</button>
          <button type="button" className="btn primary small" onClick={save}
            disabled={working || !draft.name.trim() || !draft.roster.rows.length || draft.roster.rows.some((r) => !r.preset && !r.role?.trim())}>
            {working ? "Saving…" : isNew ? "Save squad" : "Save changes"}
          </button>
        </div>
        {cardSave.confirm}
      </div>
    );
  }

  if (loading) return <div className="muted small tm-empty">Loading…</div>;
  if (!squads.length) {
    return (
      <div className="muted small tm-empty">
        {filtered ? "No squad matches." : "No squads yet. Save a huddle that worked with Save as squad… in its ⋯ menu, or press + New squad."}
      </div>
    );
  }
  return (
    <div className="tt-list">
      {squads.map((t) => {
        const chip = scopeChip(t);
        const changed = t.source !== "builtin";
        return (
          <div key={t.name} className="tt-row">
            <div className="tt-main">
              <span className="tt-label">{t.label}</span>
              <span className="tm-name mono">{t.name}</span>
              {chip && <span className={`tm-chip ${chip.tone}`}>{chip.text}</span>}
              <span className="tm-stats">{usage ? usageText(usage[t.name]) : ""}</span>
            </div>
            {t.description && <div className="tt-desc">{t.description}</div>}
            <div className="tt-meta">
              {[t.roster.map((e) => `@${e.handle ?? e.preset ?? e.role}${e.host ? " (host)" : ""}${e.count && e.count > 1 ? ` ×${e.count}` : ""}`).join(", "), templateRules(t), t.hostRules?.trim() && "host rules"].filter(Boolean).join(" · ")}
            </div>
            <div className="tt-actions">
              <button className="btn small primary" onClick={() => onStart(t.name)} title={startHint} disabled={busy}>Start huddle…</button>
              <button className="btn small" onClick={() => edit(t)} disabled={busy}>{changed ? "Edit" : "Copy to customise"}</button>
              {changed && t.base && <button className="btn small ghost" onClick={() => remove(t)} disabled={busy} title={resetTitle(t)}>Reset</button>}
              {changed && !t.base && <button className="btn small ghost danger" onClick={() => remove(t)} disabled={busy}>Delete</button>}
            </div>
          </div>
        );
      })}
      <div className="tm-hint tt-foot">Start huddle… {startHint} You can change the topic before it starts.</div>
    </div>
  );
}
