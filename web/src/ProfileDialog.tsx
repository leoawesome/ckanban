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
  // A new board asks only for a folder and a name; the rest waits under "More options" (settings always show it all).
  const [more, setMore] = useState(!isNew);
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
    return q ? list.filter((p) => p.path.toLowerCase().includes(q)) : list;
  }, [recent, filter]);

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
          <div className="field-label">Folder</div>
          {isNew && (
            <div className="picker">
              <div className="picker-head">
                <span className="muted small">Recent Claude Code folders</span>
                {recent && recent.length > 6 && (
                  <input className="picker-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" />
                )}
              </div>
              <div className="picker-list" role="listbox" aria-label="Recent folders">
                {recent === null && <div className="picker-empty">Loading…</div>}
                {recent !== null && shown.length === 0 && (
                  <div className="picker-empty">{recent.length ? "No match." : "No recent Claude Code folders. Browse for a folder below."}</div>
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
                    <span className="picker-path">{p.path}</span>
                    <span className="picker-meta">
                      {p.hasProfile && <span className="badge stopped">has board</span>}
                      {p.lastUsed && <span className="muted small" title={new Date(p.lastUsed).toLocaleString()}>{timeAgo(p.lastUsed)}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="path-row">
            <input value={path} onChange={(e) => choose(e.target.value)} placeholder="/Users/you/dev/my-app" spellCheck={false}
              aria-label="Folder path" />
            <button type="button" className="btn" onClick={browse} disabled={picking}>{picking ? "Choosing…" : "Browse…"}</button>
          </div>
          <VersionHistoryOffer path={path} onRepo={setRepo} />
        </div>

        <label>
          Name
          <input value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} placeholder="My app" />
        </label>

        {isNew && (
          <button type="button" className="link-btn more-options" aria-expanded={more} onClick={() => setMore((v) => !v)}>
            {more ? "Fewer options" : "More options"}
          </button>
        )}

        {more && <>
        <fieldset className="ws-cards">
          <legend>Workspace</legend>
          <label className={`ws-card ${shownWorkspace === "worktree" ? "on" : ""} ${noHistory ? "off" : ""}`}
            title={noHistory ? "Turn on version history above to use this" : undefined}>
            <input type="radio" name="workspace" checked={shownWorkspace === "worktree"} disabled={noHistory} onChange={() => setWorkspace("worktree")} />
            <span>
              <span>A copy per ticket <span className="muted small">(default)</span></span>
              <span className="muted small">
                {noHistory
                  ? "Needs version history: turn it on above. Each ticket then gets its own copy of the folder, and tickets run in parallel."
                  : "Each ticket gets its own copy of the folder, so tickets run in parallel."}
              </span>
            </span>
          </label>
          <label className={`ws-card ${shownWorkspace === "folder" ? "on" : ""}`}>
            <input type="radio" name="workspace" checked={shownWorkspace === "folder"} onChange={() => setWorkspace("folder")} />
            <span>
              <span>Work in the project folder</span>
              <span className="muted small">
                Claude edits your folder directly. Tickets run one at a time so they don't clash.
                {profile && " Changing this affects new tickets only; tickets that already have their own copy keep it."}
              </span>
            </span>
          </label>
        </fieldset>

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
          </label>
        </div>
        <div className="row two">
          <label>
            Reasoning effort
            <Select
              ariaLabel="Reasoning effort"
              value={effort}
              onChange={setEffort}
              options={[{ value: "", label: "Claude default" }, ...EFFORTS.map((e) => ({ value: e, label: e }))]}
            />
            <span className="muted small">Tickets can override both. Changes apply from the next run.</span>
          </label>
          <label className="check-row board-switch ultracode-row">
            <input type="checkbox" checked={ultracode} onChange={(e) => setUltracode(e.target.checked)} />
            <span>
              Ultracode
              <span className="muted small">
                At any effort level, Claude runs a workflow of helper agents for every big task. More thorough, but it uses much more of your plan.
              </span>
            </span>
          </label>
        </div>
        </>}

        {profile && (
          <>
            <label className="check-row board-switch">
              <input type="checkbox" checked={autoHuddles} onChange={(e) => setAutoHuddles(e.target.checked)} />
              <span>
                Auto huddles
                <span className="muted small">
                  When you're away, Claude starts a review huddle on its own before landing ⭐ important or risky work ($20 cap, one at a time per board).
                </span>
              </span>
            </label>
            <label className="check-row board-switch">
              <input type="checkbox" checked={keepAwake} onChange={(e) => setKeepAwake(e.target.checked)} />
              <span>
                Keep this Mac awake while Claude is working
                <span className="muted small">
                  While this board's tickets, chats, huddles or jobs are working, the Mac doesn't go to sleep, so they keep going when you step away. The screen can still turn off. It sleeps as usual once they finish. Mac only.
                </span>
              </span>
            </label>
            <label className="check-row board-switch">
              <input type="checkbox" checked={artifacts} onChange={(e) => setArtifacts(e.target.checked)} />
              <span>
                claude.ai artifacts
                <span className="muted small">
                  Teach Claude to publish, read and update claude.ai artifacts from runs and Planning chats. When off, Claude still learns this for tickets and messages that contain an artifact link.
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
              <span className="muted small">Fewer connectors make every Claude run cheaper. Runs on this board can't use the ones you turn off.</span>
            </div>
            <label className="cap-field">
              Spending cap per run
              <span className="muted small">
                Each work run stops once it has spent this much (API-equivalent $) and waits in the Inbox for you to continue it. Empty: no cap. Tickets can override it in their ⋯ menu.
              </span>
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
              <span className="muted small">The ticket you talk to. Its tool tickets pick their model by kind; a ticket's own /model still wins.</span>
            </label>
            <label>
              Start an old chat fresh above this chat size (thousands)
              <input inputMode="numeric" value={freshText} onChange={(e) => setFreshText(e.target.value)} placeholder="150" aria-invalid={!!freshError} />
              {freshError
                ? <span className="field-error">{freshError}</span>
                : <span className="muted small">When a main ticket's chat has gone old and is bigger than this (the chat size shown in the chat), its next turn starts fresh from the status. Claude can still look up earlier messages.</span>}
            </label>
            <label>
              Flag a run as stalled after (minutes without output)
              <input type="number" min={0} max={1440} step={1} value={stallText} onChange={(e) => setStallText(e.target.value)}
                aria-invalid={!!stallError} aria-describedby={stallError ? "stall-error" : "stall-hint"} />
              {stallError
                ? <span id="stall-error" className="field-error">{stallError}</span>
                : <span id="stall-hint" className="muted small">A silent run lands in the Inbox with Stop / Keep waiting / Restart; nothing is killed. Runs waiting on background tasks don't count. 0: off.</span>}
            </label>
            <div className="form-section">
              <span>Preparing each ticket's copy</span>
              <button type="button" className="btn small ghost link" onClick={detectAgain} disabled={detecting}>
                {detecting ? "Detecting…" : "↺ Detect again"}
              </button>
            </div>
            <div className="setup-explain">
              Each ticket works in a fresh copy of your folder. Files your version history skips, like <code>.env</code> and{" "}
              <code>node_modules</code>, aren't in it. The files below are copied in when the copy is made; the setup command runs only when Claude needs the project's dependencies (to build, test or run it), so other tickets start right away.{" "}
              {(filesAuto || setupAuto) && <b>We filled them in from your folder, so you can leave them as they are.</b>}
            </div>
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
                Runs the first time Claude needs it in a ticket; if it fails, Claude sees the error.
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
