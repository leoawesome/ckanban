import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { type ClaudeSession, type Status, type Ticket, type TicketMode } from "./api";
import { looksLikeQuestion } from "./family";
import { mainHint } from "./newTicketText";
import { FeatureChoice, useFeatureChoice } from "./FeatureChoice";
import { DescriptionEditor } from "./DescriptionEditor";
import { useImagePaste } from "./imagePaste";
import { autoGrow } from "./autoGrow";
import { ModeToggle, modeHint } from "./ModeToggle";
import { KeyHint } from "./KeyHint";
import { newTicketKey } from "./keynav";
import { Modal } from "./Modal";
import { SessionPicker, sessionLabel } from "./SessionPicker";
import { MOD } from "./Shortcuts";
import { StarToggle } from "./StarToggle";
import { TagEditor } from "./Tags";
import { usePhone } from "./usePhone";

export function NewTicketDialog({ slug, folder, knownTags = [], tickets = [], onClose, onCreate, onAskInChat }: {
  slug: string;
  folder: string;
  /** This board's tags (most used first), offered in the Tags field. */
  knownTags?: { name: string; count: number }[];
  /** The board's tickets: a new ticket that shares words with an open feature is offered to it. */
  tickets?: Ticket[];
  onClose: () => void;
  /** Closes the form and opens Chat with this text in a new chat's message box. */
  onAskInChat?: (text: string) => void;
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
  // A small "Part of X?" chip: the open feature sharing the most words (no AI call). It stays on its own until the user picks.
  const fc = useFeatureChoice(tickets, title, body);
  const partOf = fc.partOf;
  // "Just a question? Ask in Chat first": a word check, no AI call.
  const question = useMemo(() => looksLikeQuestion(title, body), [title, body]);

  // Start: an interview goes to Planning (questions now), "Just do it" goes to Ready (runs when a slot is free).
  const startStatus: Status = mode === "interview" ? "planning" : "ready";
  const [mainInfo, setMainInfo] = useState(false);
  const hint = mainHint(partOf, session?.id);
  // On a phone the description starts at 4 rows and grows to 6 while typing, so Start stays in view.
  const phone = usePhone();
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (phone) autoGrow(el, 6);
    else { el.style.height = ""; el.style.overflowY = ""; }
  }, [body, phone]);

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
          <DescriptionEditor slug={slug} value={body} setValue={setBody} images={images} inputRef={bodyRef} rows={phone ? 4 : 8} />
        </label>
        {question && (
          <div className="ask-first muted small" role="note">
            Just a question? Ask in Chat first. You can turn the chat into a ticket later.
            {onAskInChat && <> <button type="button" className="link-btn small" onClick={() => onAskInChat([title.trim(), body.trim()].filter(Boolean).join("\n\n"))}>Ask in Chat</button></>}
          </div>
        )}
        <FeatureChoice state={fc} hideNoMatchOnPhone />
        <div className="field">
          <ModeToggle value={mode} onChange={setMode} keyHint="⌘I" />
          <span className="muted small mode-hint">
            {modeHint(mode)}
            {/* The main-ticket hint: a tooltip on desktop, and a tap shows it on a phone (no hover there). */}
            {hint && <> <button type="button" className="info-tip" title={hint} aria-label="What happens next" aria-expanded={mainInfo}
              onClick={() => setMainInfo((v) => !v)}>ⓘ</button></>}
          </span>
          {hint && mainInfo && <span className="muted small new-ticket-main-hint">{hint}</span>}
        </div>
        {session && (
          <div className="session-chip">
            <span className="muted small">Continues the Claude Code chat</span>
            <span className="session-title">{sessionLabel(session)}</span>
            <button type="button" className="link-btn" onClick={() => setSession(null)}>Remove</button>
          </div>
        )}
        {err && <div className="form-error">{err}</div>}
        {/* One main button (the mode toggle above says what Start does) and a quiet "Save for later". */}
        <div className="form-actions new-ticket-actions">
          <button type="button" className="btn ghost" disabled={busy || !title.trim() || images.uploading} onClick={() => submit("backlog")} title={`Put it in Backlog; nothing runs until you start it (${MOD}S)`}>Save for later<KeyHint keys="⌘S" /></button>
          <button type="button" className="btn primary icon-label" onClick={() => submit(startStatus)} disabled={busy || !title.trim() || images.uploading}
            title={mode === "interview" ? "Goes to Planning: Claude asks its questions now" : "Goes to In Progress, or waits its turn if every slot is busy"}>
            {images.uploading ? "Uploading…" : <>Start <kbd className="kbd-on-primary">⌘↵</kbd></>}
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
