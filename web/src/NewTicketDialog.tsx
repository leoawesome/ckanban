import { useEffect, useMemo, useRef, useState } from "react";
import { COLUMNS, type ClaudeSession, type Status, type Ticket, type TicketMode } from "./api";
import { openFeatures, suggestFeature } from "./family";
import { DescriptionEditor } from "./DescriptionEditor";
import { useImagePaste } from "./imagePaste";
import { ModeToggle } from "./ModeToggle";
import { KeyHint } from "./KeyHint";
import { newTicketKey } from "./keynav";
import { Modal } from "./Modal";
import { SessionPicker, sessionLabel } from "./SessionPicker";
import { MOD } from "./Shortcuts";
import { StarToggle } from "./StarToggle";
import { TagEditor } from "./Tags";

export function NewTicketDialog({ slug, folder, knownTags = [], tickets = [], onClose, onCreate }: {
  slug: string;
  folder: string;
  /** This board's tags (most used first), offered in the Tags field. */
  knownTags?: { name: string; count: number }[];
  /** The board's tickets: a new ticket that shares words with an open feature is offered to it. */
  tickets?: Ticket[];
  onClose: () => void;
  onCreate: (input: { title: string; body: string; status: Status; sessionId?: string; mode?: TicketMode; important?: boolean; tags?: string[]; partOf?: string }) => Promise<void>;
}) {
  const [mode, setMode] = useState<TicketMode>("interview");
  const [session, setSession] = useState<ClaudeSession | null>(null);
  const [picking, setPicking] = useState(false);
  const [title, setTitle] = useState("");
  const [important, setImportant] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const images = useImagePaste(setBody);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // "This looks like part of X": the open feature sharing the most words (no AI call); Add to X is the default.
  const features = useMemo(() => openFeatures(tickets), [tickets]);
  const suggestion = useMemo(() => suggestFeature(tickets, title, body), [tickets, title, body]);
  const [choice, setChoice] = useState<"add" | "new" | "other">("add");
  const [other, setOther] = useState("");
  useEffect(() => setChoice((c) => (c === "other" ? c : "add")), [suggestion?.feature.id]);
  const partOf = choice === "add" ? suggestion?.feature.id : choice === "other" ? other || undefined : undefined;

  // Start: an interview goes to Planning (questions now), "Just do it" goes to Ready (runs when a slot is free).
  const startStatus: Status = mode === "interview" ? "planning" : "ready";
  const startLabel = mode === "interview" ? "Start: Claude asks first" : "Start: Claude just does it";

  const submit = async (status: Status) => {
    if (busy || !title.trim() || images.uploading) return;
    setBusy(true);
    try {
      await onCreate({ title: title.trim(), body, status, sessionId: session?.id, mode, ...(important ? { important } : {}), ...(tags.length ? { tags } : {}), ...(partOf ? { partOf } : {}) });
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New ticket" onClose={onClose} guard={!busy && (!!title.trim() || !!body.trim())}>
      {/* Plain Enter in the title does nothing: starting a run should be deliberate (button or ⌘Enter).
          ⌘S creates in Backlog, ⌘I switches how Claude works, ⌘D stars; each also keeps the browser's own ⌘S / ⌘D dialogs shut. */}
      <form className="form" onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          const k = newTicketKey(e.nativeEvent);
          if (!k) return;
          e.preventDefault();
          if (k === "start") submit(startStatus);
          else if (k === "create") submit("backlog");
          else if (k === "mode") setMode((m) => (m === "interview" ? "auto" : "interview"));
          else setImportant((v) => !v);
        }}>
        <div className="field">
          <label htmlFor="new-ticket-title">Title</label>
          <div className="title-row">
            <input id="new-ticket-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should be done?" />
            <StarToggle on={important} onChange={setImportant} keyHint="⌘D" />
          </div>
        </div>
        <div className="field">
          <div className="field-label">Tags</div>
          <TagEditor tags={tags} known={knownTags} onChange={setTags} disabled={busy} />
        </div>
        <label>
          Description
          <DescriptionEditor slug={slug} value={body} setValue={setBody} images={images} inputRef={bodyRef} />
        </label>
        {(suggestion || choice === "other") && (() => {
          const f = suggestion?.feature;
          const size = (id: string) => features.find((x) => x.top.id === id)?.rows.length ?? 1;
          const col = (t: Ticket) => COLUMNS.find((c) => c.id === t.status)?.label ?? t.status;
          return (
            <div className="feature-suggest" role="group" aria-label="Part of a feature">
              {f ? <p>This looks like part of <b>{f.title}</b> ({col(f)}, {size(f.id)} tickets).</p> : <p>Add it to a feature you're already working on.</p>}
              {f && (
                <label className="choice"><input type="radio" name="feature" checked={choice === "add"} onChange={() => setChoice("add")} /> Add to {f.title}
                  <span className="muted small">its chat picks it up and it shows in the feature's status</span></label>
              )}
              <label className="choice"><input type="radio" name="feature" checked={choice === "new"} onChange={() => setChoice("new")} /> Start a new feature
                <span className="muted small">its own card and its own status</span></label>
              <label className="choice"><input type="radio" name="feature" checked={choice === "other"} onChange={() => setChoice("other")} /> Other feature…
                {choice === "other" && (
                  <select value={other} onChange={(e) => setOther(e.target.value)} aria-label="Feature to add it to">
                    <option value="">Pick a feature</option>
                    {features.map((x) => <option key={x.top.id} value={x.top.id}>{x.top.title} ({x.rows.length})</option>)}
                  </select>
                )}
              </label>
              {suggestion && <div className="why muted small">Matched words: {suggestion.words.join(", ")}.</div>}
            </div>
          );
        })()}
        <div className="field">
          <div className="field-label">How should Claude work?</div>
          <ModeToggle value={mode} onChange={setMode} keyHint="⌘I" />
          <span className="muted small">
            {mode === "interview"
              ? "Claude first asks clarifying questions in the chat, then does the work once you answer."
              : "Claude works on its own and reports back when done."}
          </span>
        </div>
        {session && (
          <div className="session-chip">
            <span className="muted small">Continues the Claude Code chat</span>
            <span className="session-title">{sessionLabel(session)}</span>
            <button type="button" className="link-btn" onClick={() => setSession(null)}>Remove</button>
          </div>
        )}
        {err && <div className="form-error">{err}</div>}
        {/* One main button that says what happens (it follows the mode toggle) and one quiet "Save for later": no legend needed. */}
        <div className="form-actions new-ticket-actions">
          <button type="button" className="btn" disabled={busy || !title.trim() || images.uploading} onClick={() => submit("backlog")} title={`Put it in Backlog; nothing runs until you start it (${MOD}S)`}>Save for later<KeyHint keys="⌘S" /></button>
          <button type="button" className="btn primary icon-label" onClick={() => submit(startStatus)} disabled={busy || !title.trim() || images.uploading}
            title={mode === "interview" ? "Goes to Planning: Claude asks its questions now" : "Goes to In Progress, or waits its turn if every slot is busy"}>
            {images.uploading ? "Uploading…" : <>{startLabel} <kbd className="kbd-on-primary">⌘↵</kbd></>}
            <KeyHint keys="⌘↵" />
          </button>
        </div>
        {!session && (
          <button type="button" className="link-btn small new-ticket-from-chat" onClick={() => setPicking(true)}>Continue a Claude Code chat instead…</button>
        )}
      </form>
      {picking && (
        <SessionPicker slug={slug} folder={folder} onClose={() => setPicking(false)} onPick={(s) => {
          setSession(s);
          if (!title.trim()) setTitle(s.title ?? s.firstPrompt?.slice(0, 80) ?? "");
          setPicking(false);
        }} />
      )}
    </Modal>
  );
}
