// The avatar editor (Team page): pick who, try the moods on a big live preview, change the parts, then Save (all boards).
// Desktop: preview on the left, parts on the right. Phone: a bottom sheet with the preview pinned at the top while
// the parts scroll, and the buttons pinned at the bottom.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./Modal";
import { CheckIcon } from "./icons";
import { usePhone } from "./usePhone";
import { AvatarFace, resetAvatar, saveAvatar, saveClaudeName, useClaudeName, useSavedAvatars } from "./AvatarFace";
import {
  AVATAR_ACCESSORIES, AVATAR_COLORS, AVATAR_FACES, AVATAR_HAIR_COLORS, AVATAR_HAIRS, AVATAR_HATS, AVATAR_MOODS, avatarFor, avatarKey, claudeName, cleanClaudeName,
  defaultAvatar, DEFAULT_CLAUDE_NAME, MAX_CLAUDE_NAME, type AvatarLook, type AvatarMood, type SavedAvatars,
} from "./avatarLook";
import { colorName, partLabel, sameLook, surpriseLook, swatches } from "./avatarEditorText";

/** Someone whose avatar can be changed: "claude" or a teammate's handle, and the name to show. */
export interface AvatarPerson {
  who: string;
  label: string;
}

/**
 * The one way to open the editor (Team page, or a tap on Claude's face in a chat): `initial` is picked; `people` is who
 * can be switched to (missing: Claude only). AvatarEditorHost, mounted once in App, shows it above every page and panel.
 */
let opened: { initial: string; people?: AvatarPerson[] } | null = null;
const openListeners = new Set<() => void>();
const setOpened = (next: typeof opened) => { opened = next; openListeners.forEach((l) => l()); };
export function openAvatarEditor(initial: string, people?: AvatarPerson[]) { setOpened({ initial, people }); }
export function closeAvatarEditor() { setOpened(null); }
const subscribeOpened = (l: () => void) => { openListeners.add(l); return () => { openListeners.delete(l); }; };

export function AvatarEditorHost() {
  const open = useSyncExternalStore(subscribeOpened, () => opened);
  const claude = useClaudeName();
  if (!open) return null;
  return <AvatarEditor initial={open.initial} people={open.people ?? [{ who: "claude", label: claude }]} onClose={closeAvatarEditor} />;
}

const MOOD_LABELS: Record<AvatarMood, string> = { idle: "Idle", thinking: "Thinking", working: "Working", waiting: "Waiting", done: "Done", failed: "Failed" };

const hasSaved = (saved: SavedAvatars, who: string) => Object.prototype.hasOwnProperty.call(saved, avatarKey(who));

export function AvatarEditor({ people, initial, onClose }: { people: AvatarPerson[]; initial: string; onClose: () => void }) {
  const phone = usePhone();
  const saved = useSavedAvatars();
  const [cur, setCur] = useState(() => (people.some((p) => p.who === initial) ? initial : people[0]?.who ?? "claude"));
  const [mood, setMood] = useState<AvatarMood>("thinking");
  /** Changes not saved yet, per person (kept while the dialog is open, so switching doesn't lose them). */
  const [drafts, setDrafts] = useState<Record<string, AvatarLook>>({});
  /** Claude's name as typed, not saved yet (null: unchanged). */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const stored = (who: string) => avatarFor(who, saved);
  const lookOf = (who: string) => drafts[who] ?? stored(who);
  const savedName = claudeName(saved);
  /** The name as it would be saved ("Claude" when empty). */
  const nameAfter = nameDraft === null ? savedName : cleanClaudeName(nameDraft) || DEFAULT_CLAUDE_NAME;
  const nameDirty = nameAfter !== savedName;
  const dirty = (who: string) => (!!drafts[who] && !sameLook(drafts[who], stored(who))) || (who === "claude" && nameDirty);
  const look = lookOf(cur);
  const labelOf = (p: AvatarPerson) => (p.who === "claude" ? nameAfter : p.label);
  const found = people.find((p) => p.who === cur);
  const person = { who: cur, label: found ? labelOf(found) : cur };
  const anyDirty = people.some((p) => dirty(p.who));

  // The chosen person's button stays in view in the strip.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>("[aria-pressed='true']")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [cur]);

  const set = (patch: Partial<AvatarLook>) => {
    setMsg(null);
    setDrafts((d) => ({ ...d, [cur]: { ...lookOf(cur), ...patch } }));
  };
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // The default look is stored as "no choice", so a later change to the defaults still reaches it.
      if (drafts[cur] && !sameLook(drafts[cur], stored(cur))) {
        if (sameLook(look, defaultAvatar(cur))) {
          if (hasSaved(saved, cur)) await resetAvatar(cur);
        } else await saveAvatar(cur, look);
      }
      setDrafts(({ [cur]: _, ...rest }) => rest);
      if (cur === "claude" && nameDraft !== null) {
        if (nameDirty) await saveClaudeName(nameAfter === DEFAULT_CLAUDE_NAME ? "" : nameAfter);
        setNameDraft(null);
      }
      setMsg({ ok: true, text: "Saved for all boards." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const ids = useId();
  const optGroup = <K extends "face" | "hair" | "hat" | "accessory">(key: K, title: string, list: readonly AvatarLook[K][]) => (
    <section className="ave-part" aria-labelledby={`${ids}-${key}`}>
      <h4 id={`${ids}-${key}`}>{title}</h4>
      <div className="ave-opts" role="radiogroup" aria-labelledby={`${ids}-${key}`}>
        {list.map((v) => {
          const on = look[key] === v;
          return (
            <button key={v} type="button" role="radio" aria-checked={on} className={`ave-opt${on ? " on" : ""}`} onClick={() => set({ [key]: v } as Partial<AvatarLook>)}>
              <AvatarFace look={{ ...look, [key]: v }} size={36} />
              <span>{partLabel(v)}</span>
              {on && <span className="ave-tick" aria-hidden><CheckIcon size={12} /></span>}
            </button>
          );
        })}
      </div>
    </section>
  );
  const swatchGroup = (key: "color" | "hairColor", title: string, list: readonly string[]) => (
    <section className="ave-part" aria-labelledby={`${ids}-${key}`}>
      <h4 id={`${ids}-${key}`}>{title}</h4>
      <div className="ave-opts" role="radiogroup" aria-labelledby={`${ids}-${key}`}>
        {swatches(list, look[key]).map((c) => {
          const on = look[key].toLowerCase() === c;
          return (
            <button key={c} type="button" role="radio" aria-checked={on} aria-label={colorName(c, key === "hairColor")} title={colorName(c, key === "hairColor")}
              className={`ave-sw${on ? " on" : ""}`} style={{ background: c }} onClick={() => set({ [key]: c })}>
              {on && <CheckIcon size={16} />}
            </button>
          );
        })}
      </div>
    </section>
  );

  // On document.body: the Team page sits in panels that may clip or transform a fixed overlay.
  return createPortal(
    <Modal title="Avatars" wide className="ave-modal" guard={anyDirty} onClose={onClose}>
      <div className="ave">
        <div className="ave-who" ref={strip} role="group" aria-label="Whose avatar">
          {people.map((p) => (
            <button key={p.who} type="button" aria-pressed={p.who === cur} className={p.who === cur ? "on" : undefined} onClick={() => { setCur(p.who); setMsg(null); }}>
              <AvatarFace look={lookOf(p.who)} size={32} />
              <span>{labelOf(p)}</span>
              {dirty(p.who) && <span className="ave-dirty" title="Not saved yet"><span className="sr-only">(not saved yet)</span></span>}
            </button>
          ))}
        </div>
        <div className="ave-grid">
          <div className="ave-prev">
            <AvatarFace look={look} mood={mood} size={phone ? 72 : 128} />
            <div className="ave-prev-side">
              <b>{person.label}</b>
              {person.who !== "claude" && <span className="ave-handle mono">@{person.who}</span>}
              <div className="ave-moods" role="group" aria-label="Try a mood">
                {AVATAR_MOODS.map((m) => (
                  <button key={m} type="button" aria-pressed={mood === m} className={mood === m ? "on" : undefined} onClick={() => setMood(m)}>{MOOD_LABELS[m]}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="ave-parts">
            {cur === "claude" && (
              <section className="ave-part ave-name">
                <h4><label htmlFor={`${ids}-name`}>Name</label></h4>
                <input id={`${ids}-name`} type="text" value={nameDraft ?? (savedName === DEFAULT_CLAUDE_NAME ? "" : savedName)} placeholder={DEFAULT_CLAUDE_NAME}
                  maxLength={MAX_CLAUDE_NAME} autoComplete="off" spellCheck={false} enterKeyHint="done" aria-describedby={`${ids}-name-hint`}
                  onChange={(e) => { setMsg(null); setNameDraft(e.target.value); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && !busy && dirty(cur)) { e.preventDefault(); void save(); } }} />
                <div id={`${ids}-name-hint`} className="ave-name-hint">Shown in place of “Claude” on every board. Empty: Claude.</div>
              </section>
            )}
            {optGroup("face", "Face", AVATAR_FACES)}
            {swatchGroup("color", "Colour", AVATAR_COLORS)}
            {optGroup("hair", "Hair", AVATAR_HAIRS)}
            {swatchGroup("hairColor", "Hair colour", AVATAR_HAIR_COLORS)}
            {optGroup("hat", "Hat", AVATAR_HATS)}
            {optGroup("accessory", "Accessory", AVATAR_ACCESSORIES)}
            <div className="ave-acts">
              {msg && <span className={`ave-msg${msg.ok ? "" : " err"}`} role={msg.ok ? "status" : "alert"}>{msg.text}</span>}
              <button type="button" className="btn" onClick={() => set(surpriseLook(look))} disabled={busy}>Surprise me</button>
              <button type="button" className="btn" onClick={() => set(defaultAvatar(cur))} disabled={busy || sameLook(look, defaultAvatar(cur))}
                title={`Back to ${person.label}'s default look (Save to keep it)`}>Reset</button>
              <button type="button" className="btn primary" onClick={save} disabled={busy || !dirty(cur)}>{busy ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      </div>
    </Modal>,
    document.body,
  );
}
