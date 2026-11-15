import { useEffect, useId, useState } from "react";
import { api, type Profile, type Snippet } from "./lib/api";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { AtIcon, ChevronRightIcon, PlusIcon } from "./components/icons";
import { PhoneBar } from "./AutomationsDialog";
import { EmptyState, FormError, LoadState, useDiscardAsk } from "./components/formParts";
import { useBackEntry } from "./app/backEntry";
import { usePhone } from "./hooks/usePhone";
import { Modal } from "./components/Modal";
import { Select } from "./components/Select";
import { firstLine } from "./snippetText";
import { reloadSnippets, useSnippets } from "./snippets";

type Draft = { name: string; scope: string; text: string };
const blank = (): Draft => ({ name: "", scope: "global", text: "" });

/**
 * ⋯ → Snippets: reusable prompt text, inserted by typing `@name` in a ticket description or the chat.
 * Same frame as Automations: desktop has the list on the left and the picked one on the right; a phone shows the list,
 * and tapping one opens its own screen with a back arrow.
 */
export function SnippetsDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const phone = usePhone();
  const snippets = useSnippets(profile.slug);
  // Snippet being edited: an id, "new", or null before the list has loaded.
  const [sel, setSel] = useState<string | null>(null);
  /** Phone only: the picked snippet's screen is showing (else the list). */
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(blank);
  const [saved, setSaved] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Snippet | null>(null);
  const ids = useId();

  const dirty = draft.name !== saved.name || draft.scope !== saved.scope || draft.text !== saved.text;
  const ask = useDiscardAsk(dirty);

  const load = (s: Snippet | null) => {
    const d = s ? { name: s.name, scope: s.scope, text: s.text } : blank();
    setSel(s?.id ?? "new");
    setDraft(d);
    setSaved(d);
    setErr(null);
  };
  // Picking another snippet (or New) with unsaved edits asks first.
  const pick = (s: Snippet | null) => ask.leave(() => { load(s); setPhoneOpen(true); });
  const back = () => ask.leave(() => { setPhoneOpen(false); if (dirty) setDraft(saved); });
  useBackEntry(phone && phoneOpen, back);

  // First load: open the first snippet (desktop), or a blank form when there are none.
  useEffect(() => {
    if (snippets && sel === null) load(snippets[0] ?? null);
    // A snippet deleted elsewhere: fall back to the first one.
    if (snippets && sel && sel !== "new" && !snippets.some((s) => s.id === sel)) load(snippets[0] ?? null);
  }, [snippets, sel]);

  const current = snippets?.find((s) => s.id === sel) ?? null;
  const blocker = !draft.name.trim() ? "Give it a name to save it." : !draft.text.trim() ? "Add the text to save it." : null;

  const save = async () => {
    if (blocker || !dirty) return;
    setBusy(true);
    setErr(null);
    try {
      const input = { name: draft.name.trim().replace(/^@/, ""), scope: draft.scope, text: draft.text };
      const s = current ? await api.updateSnippet(current.id, input) : await api.createSnippet(input);
      const d = { name: s.name, scope: s.scope, text: s.text };
      await reloadSnippets(profile.slug);
      setSel(s.id);
      setDraft(d);
      setSaved(d);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const scopeLabel = (s: Snippet) => (s.scope === "global" ? "All boards" : "This board");
  const detail = phone && phoneOpen;
  const empty = snippets && !snippets.length;
  const newButton = (
    <button type="button" className={`btn${phone ? " primary" : " small snippet-new"}`} onClick={() => pick(null)} disabled={!phone && sel === "new" && !dirty}>
      <PlusIcon size={14} aria-hidden /> New snippet
    </button>
  );

  return (
    <Modal title={detail ? (current ? `@${current.name}` : "New snippet") : "Snippets"} onClose={onClose} wide className="auto-modal snippets-modal"
      bare={detail} guard={dirty} guardKind="changes">
      {!snippets && <LoadState onRetry={() => reloadSnippets(profile.slug)} />}
      {snippets && (
        <div className="auto-wrap">
          {!detail && (
            <div className="auto-side">
              {!phone && newButton}
              {empty && phone ? (
                <EmptyState icon={<AtIcon size={20} />} title="No snippets yet">
                  Save text you keep retyping, like "run the e2e tests before finishing", then type <code>@name</code> in a ticket or the chat to insert it.
                </EmptyState>
              ) : (
                <div className="auto-list" role="list" aria-label="Snippets">
                  {snippets.map((s) => (
                    <button key={s.id} role="listitem" className={`auto-item${!phone && s.id === sel ? " sel" : ""}`} onClick={() => pick(s)} title={firstLine(s.text)}>
                      <span className="auto-item-main">
                        <span className="auto-item-name mono">@{s.name}</span>
                        <span className="auto-item-sub">{scopeLabel(s)} · {firstLine(s.text)}</span>
                      </span>
                      {phone && <ChevronRightIcon size={16} className="auto-chev" />}
                    </button>
                  ))}
                </div>
              )}
              {phone && <div className="auto-side-actions">{newButton}</div>}
            </div>
          )}
          {(!phone || phoneOpen) && (
            <form className="auto-form snippet-editor" onSubmit={(e) => { e.preventDefault(); save(); }}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }}>
              {phone && <PhoneBar title={current ? `@${current.name}` : "New snippet"} onBack={back} />}
              <div className="auto-scroll">
                {!phone && empty && sel === "new" && !dirty && (
                  <div className="snippet-hint muted small">
                    No snippets yet. Save text you keep retyping (e.g. "run the e2e tests before finishing"), then type <code>@name</code> in
                    a new ticket, a description or the chat to insert it.
                  </div>
                )}
                <div className="auto-pane form snippet-fields">
                  <label>
                    <span>Name<span className="req" aria-hidden>*</span></span>
                    <input className="mono" value={draft.name} placeholder="e2e" spellCheck={false} autoFocus={!phone} aria-required="true"
                      autoCapitalize="off" autoCorrect="off" aria-describedby={`${ids}-name-help`}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase().replace(/\s+/g, "-") })} />
                  </label>
                  <span id={`${ids}-name-help`} className="muted small snippet-help">Lowercase letters, digits and dashes. Type <code>@{draft.name.trim() || "name"}</code> to insert it.</span>
                  <div className="field">
                    <div className="field-label">Available on</div>
                    <Select ariaLabel="Available on" value={draft.scope} onChange={(scope) => setDraft({ ...draft, scope })}
                      options={[{ value: "global", label: "All boards" }, { value: profile.slug, label: `This board only (${profile.name})` }]} />
                  </div>
                  <label>
                    <span>Text<span className="req" aria-hidden>*</span></span>
                    <textarea rows={9} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} aria-required="true"
                      placeholder="Before finishing, run the test suite and fix any failures." />
                  </label>
                  <FormError>{err}</FormError>
                </div>
              </div>
              <div className="auto-foot">
                <span className={`auto-foot-note${dirty && blocker && !busy ? " why" : " idle"}`} role="status">{dirty && !busy ? blocker : null}</span>
                {!phone && current && <button type="button" className="btn ghost danger" onClick={() => setConfirm(current)}>Delete</button>}
                {phone && current && !dirty && <button type="button" className="btn ghost danger" onClick={() => setConfirm(current)}>Delete</button>}
                {dirty && <button type="button" className="btn ghost" onClick={() => { setDraft(saved); setErr(null); }}>Revert</button>}
                <button type="submit" className="btn primary" disabled={busy || !dirty || !!blocker} title={blocker ?? undefined}>
                  {busy ? "Saving…" : current ? "Save" : "Create"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
      {ask.dialog}
      {confirm && (
        <ConfirmDialog title={`Delete @${confirm.name}?`} confirmLabel="Delete" busyLabel="Deleting…" onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await api.deleteSnippet(confirm.id);
            await reloadSnippets(profile.slug);
            setConfirm(null);
            setSel(null);
            setPhoneOpen(false);
          }}>
          <p>Text already inserted into tickets stays as it is.</p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}
