import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { type ClaudeSession, type Profile, type Status, type Ticket, type TicketMode } from "./api";
import { looksLikeQuestion } from "./family";
import { mainHint, modelWord, runsOn } from "./newTicketText";
import { EFFORTS, modelOptions } from "./models";
import { Select } from "./Select";
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

export function NewTicketDialog({ slug, folder, profile, knownTags = [], tickets = [], onClose, onCreate, onAskInChat }: {
  slug: string;
  /** The board: its model, Main ticket model and effort are what "Board default" means here. */
  profile?: Pick<Profile, "model" | "mainModel" | "effort"> | null;
  folder: string;
  /** This board's tags (most used first), offered in the Tags field. */
  knownTags?: { name: string; count: number }[];
  /** The board's tickets: a new ticket that shares words with an open feature is offered to it. */
  tickets?: Ticket[];
  onClose: () => void;
  /** Closes the form and opens Chat with this text in a new chat's message box. */
  onAskInChat?: (text: string) => void;
  onCreate: (input: { title: string; body: string; status: Status; sessionId?: string; mode?: TicketMode; important?: boolean; tags?: string[]; partOf?: string; model?: string; effort?: string }) => Promise<void>;
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
  // Model and effort for this ticket ("" = board default). Not remembered: every new form starts at the board's.
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [runOpen, setRunOpen] = useState(false);
  // Tags live behind the description toolbar's "# Tag": the row shows while the ticket has tags or "+ tag" is open.
  const [tagSignal, setTagSignal] = useState(0);
  const [tagEditing, setTagEditing] = useState(false);
  const tagRow = tags.length > 0 || tagEditing;
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
  // Same rule as the server (http.ts): the user's ticket on its own, not part of a feature or a linked chat, is a main
  // ticket, and main tickets run on the board's Main ticket model when it is set.
  const isMain = !partOf && !session;
  const boardModel = (isMain ? profile?.mainModel : null) || profile?.model || null;
  const boardEffort = (profile?.effort === "ultracode" ? "xhigh" : profile?.effort) || null;
  const runs = runsOn({ model, effort, boardModel, boardEffort });
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
      await onCreate({ title: title.trim(), body, status, sessionId: session?.id, mode, ...(important ? { important } : {}), ...(tags.length ? { tags } : {}), ...(partOf ? { partOf } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    // Plain Enter in the title does nothing: starting a run should be deliberate (button or ⌘Enter).
    // ⌘S creates in Backlog, ⌘I switches how Claude works, ⌘D stars, anywhere in the dialog (also on its frame or ×);
    // each also keeps the browser's own ⌘S / ⌘D dialogs shut.
    <Modal title="New ticket" className="new-ticket-modal" onClose={onClose} guard={!busy && (!!title.trim() || !!body.trim())}
      onKeys={(e) => {
        const k = newTicketKey(e.nativeEvent);
        if (!k) return;
        e.preventDefault();
        if (k === "start") submit(startStatus);
        else if (k === "create") submit("backlog");
        else if (k === "mode") setMode((m) => (m === "interview" ? "auto" : "interview"));
        else setImportant((v) => !v);
      }}>
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        {/* No visible labels: the placeholders say what goes where; screen readers get aria-labels. */}
        <div className="title-row">
          <input id="new-ticket-title" aria-label="Title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should be done?" />
          <StarToggle on={important} onChange={setImportant} keyHint="⌘D" />
        </div>
        <DescriptionEditor slug={slug} value={body} setValue={setBody} images={images} inputRef={bodyRef} rows={phone ? 4 : 6}
          ariaLabel="Description" placeholder="Context, what done looks like, links… (optional)"
          above={tagRow && (
            <div className="new-ticket-tags">
              <TagEditor tags={tags} known={knownTags} onChange={setTags} disabled={busy} openSignal={tagSignal} onOpenChange={setTagEditing} />
            </div>
          )}
          tools={
            <button type="button" className={phone ? "desc-editor-tool new-ticket-tag-btn" : "btn small desc-editor-pick new-ticket-tag-btn"}
              aria-expanded={tagRow} title="Add tags" disabled={busy}
              // Keep the "+ tag" input's own blur from closing the row under the tap.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setTagEditing(true); setTagSignal((n) => n + 1); }}>
              {phone ? <><kbd>#</kbd> Tag</> : "# Tag"}
            </button>
          } />
        <FeatureChoice state={fc} hideNoMatchOnPhone />
        <div className="new-ticket-how">
          <ModeToggle value={mode} onChange={setMode} keyHint="⌘I" />
          {/* Small: only what runs. Tapping it shows the Model and Effort pickers below. */}
          <button type="button" className="new-ticket-run-chip" aria-expanded={runOpen} onClick={() => setRunOpen((v) => !v)}
            aria-label={`Model and effort: ${runs.what}${runs.boardDefault ? " (board default)" : ""}`}
            title={isMain && profile?.mainModel && !model ? "Main tickets use the board's Main ticket model" : runs.boardDefault ? "Board default. Tap to pick a model and effort for this ticket" : undefined}>
            <b>{runs.what}</b><span className="new-ticket-run-caret" aria-hidden="true">{runOpen ? "▴" : "▾"}</span>
          </button>
        </div>
        {runOpen && (
          <div className="new-ticket-run-panel">
            <div>
              <span className="field-label">Model</span>
              <Select ariaLabel="Model for this ticket" value={model} onChange={setModel}
                options={[{ value: "", label: `Board default${boardModel ? ` (${modelWord(boardModel)})` : ""}` }, ...modelOptions()]} />
            </div>
            <div>
              <span className="field-label">Effort</span>
              <Select ariaLabel="Effort for this ticket" value={effort} onChange={setEffort}
                options={[{ value: "", label: `Board default${boardEffort ? ` (${boardEffort})` : ""}` }, ...EFFORTS.map((e) => ({ value: e, label: e }))]} />
            </div>
          </div>
        )}
        <div className="new-ticket-hint">
          <span className="muted small mode-hint">
            {/* The main-ticket hint: a tooltip on desktop, and a tap shows it on a phone (no hover there). The ⓘ stays on
                the hint's last line. */}
            <span className="mode-hint-text">{modeHint(mode)}{hint && <>{"\u00a0"}<button type="button" className="info-tip" title={hint} aria-label="What happens next" aria-expanded={mainInfo}
              onClick={() => setMainInfo((v) => !v)}>ⓘ</button></>}</span>
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
        {/* The bottom line offers the other way in: "Ask in Chat" while the title reads like a question (it takes the
            Claude Code chat link's place, so typing "?" adds no line and nothing jumps), otherwise an old Claude Code chat. */}
        {question && onAskInChat ? (
          <button type="button" className="link-btn small new-ticket-from-chat" title="You can turn the chat into a ticket later"
            onClick={() => onAskInChat([title.trim(), body.trim()].filter(Boolean).join("\n\n"))}>Just a question? Ask in Chat instead</button>
        ) : !session && (
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
