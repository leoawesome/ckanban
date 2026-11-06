import { EFFORTS, MODELS } from "./models";
import { useEffect, useMemo, useState } from "react";
import { api, type ClaudeProject, type Profile, type RepoKind, type SetupDetection, type Workspace } from "./api";
import { capInputText, parseCap } from "./capText";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { timeAgo } from "./time";
import { VersionHistoryOffer } from "./VersionHistoryOffer";


const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

export function ProfileDialog({ profile, onClose, onSaved, onDeleted, onOpenTeam }: {
  profile: Profile | null;
  onClose: () => void;
  /** Close and open the dock's Team tab (teammates and templates live there). */
  onOpenTeam?: () => void;
  onSaved: (p: Profile) => void;
  onDeleted: () => void;
}) {
  const isNew = !profile;
  const [name, setName] = useState(profile?.name ?? "");
  const [nameTouched, setNameTouched] = useState(!isNew);
  const [path, setPath] = useState(profile?.path ?? "");
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState(profile?.model ?? "");
  const [mainModel, setMainModel] = useState(profile?.mainModel ?? "");
  const [freshText, setFreshText] = useState(profile?.freshChatTokens ? String(Math.round(profile.freshChatTokens / 1000)) : "");
  const freshK = freshText.trim() ? Number(freshText) : null;
  const freshError = freshK !== null && !(freshK > 0 && freshK <= 10_000) ? "Enter a chat size in thousands, like 150, or leave it empty." : null;
  // "ultracode" saved as the effort (the first version): xhigh with the Ultracode switch on.
  const [effort, setEffort] = useState(profile?.effort === "ultracode" ? "xhigh" : profile?.effort ?? "");
  const [ultracode, setUltracode] = useState(!!profile?.ultracode || profile?.effort === "ultracode");
  const [autoHuddles, setAutoHuddles] = useState(profile?.autoHuddles !== false);
  const [keepAwake, setKeepAwake] = useState(profile?.keepAwake !== false);
  const [capText, setCapText] = useState(capInputText(profile?.runCapUsd));
  const cap = parseCap(capText);
  const capError = cap === undefined ? "An amount in $, e.g. 5 (empty: no cap)" : null;
  const [artifacts, setArtifacts] = useState(!!profile?.artifacts);
  const savedConnectors = profile?.claudeAiConnectors;
  const [connectorMode, setConnectorMode] = useState<"all" | "none" | "some">(
    Array.isArray(savedConnectors) ? "some" : savedConnectors === "none" ? "none" : "all");
  const [keepConnectors, setKeepConnectors] = useState<string[]>(Array.isArray(savedConnectors) ? savedConnectors : []);
  // Signed-in claude.ai connectors the board sees now (Connections list); null while loading.
  const [connectors, setConnectors] = useState<string[] | null>(null);
  const [workspace, setWorkspace] = useState<Workspace>(profile?.workspace ?? "worktree");
  // The folder's version history (VersionHistoryOffer checks it): without commits there is nothing to make copies from.
  const [repo, setRepo] = useState<RepoKind | null>(null);
  const noHistory = repo === "plain" || repo === "empty";
  const shownWorkspace: Workspace = noHistory ? "folder" : workspace;
  const [stallText, setStallText] = useState(String(profile?.stallMinutes ?? 20));
  const stallMinutes = Number(stallText);
  const stallError = /^\d+$/.test(stallText.trim()) && stallMinutes <= 1440 ? null : "Minutes from 0 (off) to 1440";
  const [claudeModel, setClaudeModel] = useState<string | null>(null);
  const [recent, setRecent] = useState<ClaudeProject[] | null>(null);
  const [filter, setFilter] = useState("");
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A new board asks only for a folder and a name; the rest waits under "More options". Board settings keep Folder, Name,
  // Workspace and Model at the top and the rest under a closed "More options".
  const [more, setMore] = useState(!isNew);
  const [advanced, setAdvanced] = useState(false);
  // New board: the 4 most recent folders, all of them after "Show all"; the path box only after "Type a path".
  const [showAll, setShowAll] = useState(false);
  const [typing, setTyping] = useState(false);
  const [ticketCount, setTicketCount] = useState<number | null>(null);
  // Worktree setup (existing boards; new ones are detected when created).
  const [copyFiles, setCopyFiles] = useState<string[]>(profile?.copyFiles ?? []);
  const [newFile, setNewFile] = useState("");
  const [setupCommand, setSetupCommand] = useState(profile?.setupCommand ?? "");
  const [cleanupCommand, setCleanupCommand] = useState(profile?.cleanupCommand ?? "");
  const [detected, setDetected] = useState<SetupDetection | null>(profile?.setupDetected ?? null);
  const [detecting, setDetecting] = useState(false);
  const filesAuto = !!detected && detected.copyFiles.length > 0 && sameList(copyFiles, detected.copyFiles);
  const setupAuto = !!detected && !!detected.setupCommand && setupCommand.trim() === detected.setupCommand;

  useEffect(() => {
    api.claudeDefaults().then((d) => setClaudeModel(d.model)).catch(() => {});
    if (isNew) api.claudeProjects().then(setRecent).catch(() => setRecent([]));
    else api.tickets(profile!.slug).then((ts) => setTicketCount(ts.length)).catch(() => {});
    if (!isNew) api.mcp().then((s) => setConnectors(s.servers
      .filter((x) => x.scope === "claude.ai" && x.status === "connected")
      .map((x) => x.name.replace(/^claude\.ai /, ""))
      .sort((a, b) => a.localeCompare(b)))).catch(() => setConnectors([]));
  }, [isNew]);

  const choose = (p: string) => {
    setPath(p);
    setErr(null);
    if (!nameTouched) setName(folderName(p));
  };

  const browse = async () => {
    setPicking(true);
    try {
      const r = await api.pickFolder();
      if (r.path) choose(r.path);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setPicking(false);
    }
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = recent ?? [];
    const found = q ? list.filter((p) => p.path.toLowerCase().includes(q)) : list;
    return showAll ? found : found.slice(0, 4);
  }, [recent, filter, showAll]);
  // A folder from Browse (or typed) that isn't one of the rows shows in the path box, so the user sees what was picked.
  const pathShown = !isNew || typing || (!!path && !shown.some((p) => p.path === path));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || capError || (profile && (stallError || freshError))) return;
    setSaving(true);
    try {
      const p = profile
        ? await api.updateProfile(profile.slug, {
          name, path, model: model || null, effort: effort || null, ultracode, autoHuddles, keepAwake, runCapUsd: cap || null, artifacts, stallMinutes, workspace,
          mainModel: mainModel || null, freshChatTokens: freshK === null ? null : Math.round(freshK * 1000),
          claudeAiConnectors: connectorMode === "some" ? keepConnectors : connectorMode,
          // A file typed but not yet added with Enter still counts.
          copyFiles: newFile.trim() && !copyFiles.includes(newFile.trim()) ? [...copyFiles, newFile.trim()] : copyFiles,
          setupCommand: setupCommand.trim(), cleanupCommand: cleanupCommand.trim(), setupDetected: detected,
        })
        : await api.createProfile({ name, path, model: model || undefined, effort: effort || undefined, ultracode: ultracode || undefined, workspace });
      onSaved(p);
    } catch (e: any) {
      setErr(e.message);
      setSaving(false);
    }
  };

  const addFile = () => {
    const f = newFile.trim();
    if (f && !copyFiles.includes(f)) setCopyFiles([...copyFiles, f]);
    setNewFile("");
  };

  const detectAgain = async () => {
    if (!profile) return;
    setDetecting(true);
    try {
      const d = await api.detectSetup(profile.slug);
      setDetected(d);
      setCopyFiles(d.copyFiles);
      setSetupCommand(d.setupCommand);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setDetecting(false);
    }
  };

  const remove = async () => {
    if (!profile) return;
    await api.deleteProfile(profile.slug);
    onDeleted();
  };

  const customModel = model && !MODELS.includes(model) ? model : null;

  return (
    <Modal title={profile ? `Board settings · ${profile.name}` : "New board"} onClose={onClose} wide={isNew} focusDialog={!isNew}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <div className="field-label">{isNew ? "Pick a folder" : "Folder"}</div>
          {isNew && (
            <div className="picker" role="listbox" aria-label="Recent folders">
              {showAll && recent && recent.length > 6 && (
                <input className="picker-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" aria-label="Filter folders" />
              )}
              {recent === null && <div className="picker-empty">Loading…</div>}
              {recent !== null && shown.length === 0 && (
                <div className="picker-empty">{recent.length ? "No match." : "No recent Claude Code folders. Browse for one."}</div>
              )}
              {shown.map((p) => (
                <button
                  type="button"
                  key={p.path}
                  role="option"
                  aria-selected={path === p.path}
                  className={`picker-row ${path === p.path ? "selected" : ""}`}
                  onClick={() => choose(p.path)}
                >
                  <span className="picker-name">{p.name}</span>
                  <span className="picker-path" title={p.path}>{p.path}</span>
                  <span className="picker-meta">
                    {p.hasProfile && <span className="badge stopped">has board</span>}
                    {p.lastUsed && <span className="muted small" title={new Date(p.lastUsed).toLocaleString()}>{timeAgo(p.lastUsed)}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
          {isNew && (
            <div className="picker-links">
              {recent && recent.length > 4 && (
                <button type="button" className="link-btn" onClick={() => { setShowAll((v) => !v); setFilter(""); }}>{showAll ? "Show fewer" : "Show all"}</button>
              )}
              <button type="button" className="link-btn" onClick={browse} disabled={picking}>{picking ? "Choosing…" : "Browse…"}</button>
              {!pathShown && <button type="button" className="link-btn" onClick={() => setTyping(true)}>Type a path</button>}
            </div>
          )}
          {pathShown && (
            <div className="path-row">
              <input value={path} onChange={(e) => choose(e.target.value)} placeholder="/Users/you/dev/my-app" spellCheck={false}
                aria-label="Folder path" autoFocus={isNew && typing && !path} />
              {!isNew && <button type="button" className="btn" onClick={browse} disabled={picking}>{picking ? "Choosing…" : "Browse…"}</button>}
            </div>
          )}
        </div>

        <label>
          Name
          <input value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} placeholder="My app" />
        </label>
        <VersionHistoryOffer path={path} onRepo={setRepo} />

        {isNew && (
          <button type="button" className="link-btn more-options" aria-expanded={more} onClick={() => setMore((v) => !v)}>
            {more ? "Fewer options" : "More options"}
          </button>
        )}

        {more && <>
        <label className="check-row board-switch ws-check" title={noHistory ? "Turn on version history above to use copies" : undefined}>
          <input type="checkbox" checked={shownWorkspace === "folder"} disabled={noHistory}
            onChange={(e) => setWorkspace(e.target.checked ? "folder" : "worktree")} />
          <span>
            Work in my folder directly (tickets take turns)
            <span className="muted small">
              {noHistory
                ? "Copies need version history: turn it on above, then several tickets can run at once."
                : `Off: each ticket works on its own copy, so several can run at once.${profile ? " Affects new tickets only." : ""}`}
            </span>
          </span>
        </label>

        <div className="row two">
          <label>
            Model
            <Select
              ariaLabel="Model"
              value={model}
              onChange={setModel}
              options={[
                { value: "", label: claudeModel ? `Claude default (${claudeModel})` : "Claude default", hint: "follows ~/.claude/settings.json" },
                ...MODELS.map((m) => ({ value: m, label: m })),
                ...(customModel ? [{ value: customModel, label: customModel }] : []),
              ]}
            />
            <span className="muted small">Tickets can override it. Changes apply from the next run.</span>
          </label>
        </div>
        {profile && (
          <button type="button" className="link-btn more-options" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
            {advanced ? "Fewer options" : "More options"} <span aria-hidden>{advanced ? "▴" : "▾"}</span>
          </button>
        )}
        {(isNew || advanced) && <div className="row two">
          <label>
            Reasoning effort
            <Select
              ariaLabel="Reasoning effort"
              value={effort}
              onChange={setEffort}
              options={[{ value: "", label: "Claude default" }, ...EFFORTS.map((e) => ({ value: e, label: e }))]}
            />
            <span className="muted small">Tickets can override it.</span>
          </label>
          <label className="check-row board-switch ultracode-row">
            <input type="checkbox" checked={ultracode} onChange={(e) => setUltracode(e.target.checked)} />
            <span>
              Ultracode
              <span className="muted small">
                Helper agents on every big task: more thorough, uses much more of your plan.
              </span>
            </span>
          </label>
        </div>}
        </>}

        {profile && advanced && (
          <>
            <label className="check-row board-switch">
              <input type="checkbox" checked={autoHuddles} onChange={(e) => setAutoHuddles(e.target.checked)} />
              <span>
                Auto huddles
                <span className="muted small">
                  While you're away, ⭐ important or risky work gets a review huddle before it lands ($20 cap).
                </span>
              </span>
            </label>
            <label className="check-row board-switch">
              <input type="checkbox" checked={keepAwake} onChange={(e) => setKeepAwake(e.target.checked)} />
              <span>
                Keep this Mac awake while Claude is working
                <span className="muted small">
                  The Mac stays awake while this board's work runs; the screen can still turn off.
                </span>
              </span>
            </label>
            <label className="check-row board-switch">
              <input type="checkbox" checked={artifacts} onChange={(e) => setArtifacts(e.target.checked)} />
              <span>
                claude.ai artifacts
                <span className="muted small">
                  Claude can publish, read and update claude.ai artifacts (always, for messages with an artifact link).
                </span>
              </span>
            </label>
            <div className="field connectors-field">
              <span className="field-label">claude.ai connectors for this board's runs</span>
              <div className="segmented" role="group" aria-label="claude.ai connectors for this board's runs">
                {(["all", "none", "some"] as const).map((m) => (
                  <button key={m} type="button" className={connectorMode === m ? "on" : ""} aria-pressed={connectorMode === m} onClick={() => setConnectorMode(m)}>
                    {m === "all" ? "All" : m === "none" ? "None" : "Only these"}
                  </button>
                ))}
              </div>
              {connectorMode === "some" && (connectors === null
                ? <span className="muted small">Looking for your connectors…</span>
                : connectors.length === 0
                  ? <div className="connectors-empty">No claude.ai connectors found right now. Your saved choice stays as it is.</div>
                  : <div className="connectors-grid">
                    {connectors.map((c) => (
                      <label key={c} className="check-row">
                        <input type="checkbox" checked={keepConnectors.includes(c)}
                          onChange={(e) => setKeepConnectors(e.target.checked ? [...keepConnectors, c] : keepConnectors.filter((k) => k !== c))} />
                        <span>{c}</span>
                      </label>
                    ))}
                  </div>)}
              <span className="muted small">Fewer connectors make every run cheaper.</span>
            </div>
            <label className="cap-field">
              Spending cap per run
              <span className="muted small">A run pauses in the Inbox once it spends this much (API-equivalent $). Empty: no cap.</span>
              <input inputMode="decimal" value={capText} onChange={(e) => setCapText(e.target.value)} placeholder="No cap, e.g. 5"
                aria-invalid={!!capError} aria-describedby={capError ? "cap-error" : undefined} />
              {capError && <span id="cap-error" className="field-error">{capError}</span>}
            </label>
            <label>
              Main ticket model
              <Select
                ariaLabel="Main ticket model"
                value={mainModel}
                onChange={setMainModel}
                options={[
                  { value: "", label: "Same as the board's model" },
                  ...MODELS.map((m) => ({ value: m, label: m })),
                  ...(mainModel && !MODELS.includes(mainModel) ? [{ value: mainModel, label: mainModel }] : []),
                ]}
              />
              <span className="muted small">The ticket you talk to; its tool tickets pick their own.</span>
            </label>
            <label>
              Start an old chat fresh above this chat size (thousands)
              <input inputMode="numeric" value={freshText} onChange={(e) => setFreshText(e.target.value)} placeholder="150" aria-invalid={!!freshError} />
              {freshError
                ? <span className="field-error">{freshError}</span>
                : <span className="muted small">A main ticket's old chat bigger than this starts its next turn fresh from the status.</span>}
            </label>
            <label>
              Flag a run as stalled after (minutes without output)
              <input type="number" min={0} max={1440} step={1} value={stallText} onChange={(e) => setStallText(e.target.value)}
                aria-invalid={!!stallError} aria-describedby={stallError ? "stall-error" : "stall-hint"} />
              {stallError
                ? <span id="stall-error" className="field-error">{stallError}</span>
                : <span id="stall-hint" className="muted small">A silent run shows in the Inbox; nothing is stopped. 0: off.</span>}
            </label>
            <div className="form-section">
              <span>Preparing each ticket's copy</span>
              <button type="button" className="btn small ghost link" onClick={detectAgain} disabled={detecting}>
                {detecting ? "Detecting…" : "↺ Detect again"}
              </button>
            </div>
            <span className="muted small">Files your version history skips (like <code>.env</code>) aren't in a ticket's copy; add them here.</span>
            <div className="field">
              <div className="field-label setup-label">Files to copy {filesAuto && <span className="auto-badge">Auto-detected</span>}</div>
              {copyFiles.length > 0 && (
                <div className="setup-chips">
                  {copyFiles.map((f) => (
                    <span key={f} className="setup-chip">
                      {f}
                      <button type="button" aria-label={`Remove ${f}`} title="Remove" onClick={() => setCopyFiles(copyFiles.filter((x) => x !== f))}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <input className="mono" value={newFile} onChange={(e) => setNewFile(e.target.value)} spellCheck={false}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFile(); } }}
                placeholder="Add a path or glob, then Enter" aria-label="Add a file to copy" />
              <span className="muted small">
                {filesAuto ? "Found .env* files your version history skips." : "Copied from your folder into each new copy; missing ones are skipped."}
              </span>
            </div>
            <label>
              <span className="setup-label">Setup command {setupAuto && <span className="auto-badge">Auto-detected</span>}</span>
              <textarea className="mono" rows={2} value={setupCommand} onChange={(e) => setSetupCommand(e.target.value)} spellCheck={false}
                placeholder="e.g. npm ci" />
              <span className="muted small setup-hint">
                {setupAuto && detected?.setupFrom.length ? `From ${detected.setupFrom.join(", ")}. ` : ""}
                Runs when Claude first needs the project's dependencies.
              </span>
            </label>
            <label>
              <span>Cleanup command <span className="muted small setup-hint">(optional, rarely needed)</span></span>
              <input className="mono" value={cleanupCommand} onChange={(e) => setCleanupCommand(e.target.value)} spellCheck={false}
                placeholder="e.g. docker compose down" />
              <span className="muted small setup-hint">Runs in the ticket's copy before the board removes it.</span>
            </label>
            <span className="muted small">
              Teammates and templates moved to the Team tab{onOpenTeam && <> · <button type="button" className="link-btn" onClick={onOpenTeam}>Open Team</button></>}
            </span>
          </>
        )}

        {err && <div className="form-error">{err}</div>}
        <div className="form-actions">
          {profile && (
            <button type="button" className="btn ghost danger" onClick={() => setConfirmDelete(true)}>Delete board</button>
          )}
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={saving || !name.trim() || !path.trim() || !!capError || (!!profile && !!stallError)}>
            {saving ? (profile ? "Saving…" : "Creating…") : profile ? "Save" : "Create board"}
          </button>
        </div>
      </form>
      {confirmDelete && profile && (
        <ConfirmDialog
          title={`Delete board "${profile.name}"?`}
          confirmLabel="Delete board"
          busyLabel="Deleting…"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={remove}
        >
          <p>
            Removes {ticketCount === null ? "all" : ticketCount} ticket{ticketCount === 1 ? "" : "s"} with their comments and transcripts
            from <code>~/.claude-kanban</code>. This cannot be undone.
          </p>
          <p className="muted">Your folder <code>{profile.path}</code>, its version history and your Claude Code chats are not touched.</p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}
