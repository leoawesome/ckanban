import { useEffect, useId, useRef, useState } from "react";
import { api, subscribe, type BoardBrowserView, type BrowserPick, type BrowsersState, type ChromeBrowser } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { timeAgo } from "./time";
import { useNow } from "./useNow";
import { usePhone } from "./usePhone";

/** A board's or ticket's chrome setting meaning "ask each time" (server: chromes.ts ASK_CHROME). */
export const ASK_CHROME = "ask";

/** How a Chrome reads in menus: the user's name, else Claude in Chrome's own display name. */
export function chromeLabel(b: Pick<ChromeBrowser, "name" | "label"> | undefined): string {
  return b?.name || (b?.label ? `${b.label} (unnamed)` : "Unnamed Chrome");
}

/** Browsers state for any component, kept live (browsers.updated). */
export function useBrowsers(): BrowsersState | null {
  const [state, setState] = useState<BrowsersState | null>(null);
  useEffect(() => {
    const load = () => void api.browsers().then(setState, () => {});
    load();
    return subscribe((e) => (e.type === "browsers.updated" || e.type === "profile.updated") && load());
  }, []);
  return state;
}

const samePick = (a: BrowserPick, b: BrowserPick) => a.kind === b.kind && (a.id ?? "") === (b.id ?? "");

/** How one chosen browser reads in a chip or list: its name, "(your own Chrome)" for an extension Chrome. */
export function pickLabel(p: BrowserPick, state: BrowsersState): string {
  if (p.kind === "ask") return "Ask each time";
  if (p.kind === "board") return state.boardBrowsers.find((b) => b.id === p.id)?.name ?? "A removed browser";
  const c = state.browsers.find((b) => b.deviceId === p.id);
  return c ? `${chromeLabel(c)} (your own Chrome)` : "A removed Chrome";
}

/** "Fatt Interior WhatsApp, Personal WhatsApp" for a list, or null when nothing is chosen. */
export function picksText(picks: BrowserPick[] | null | undefined, state: BrowsersState): string | null {
  return picks?.length ? picks.map((p) => pickLabel(p, state)).join(", ") : null;
}

/**
 * Tick one or more browsers, each with a note on what it is for (Claude reads it). Lists the board browsers, then the
 * named own Chromes, then "Ask each time"; a chosen browser that was removed still shows, so it can be unticked.
 */
export function BrowserPicker({ state, value, onChange }: {
  state: BrowsersState;
  value: BrowserPick[];
  onChange: (next: BrowserPick[]) => void;
}) {
  const uid = useId();
  const options: { pick: BrowserPick; label: string; own?: boolean }[] = [
    ...state.boardBrowsers.map((b) => ({ pick: { kind: "board" as const, id: b.id }, label: b.name })),
    ...state.browsers.filter((b) => b.name).map((b) => ({ pick: { kind: "chrome" as const, id: b.deviceId }, label: b.name, own: true })),
  ];
  // Chosen ones no longer listed (removed, or an own Chrome without a name) and "Ask each time" when chosen or useful.
  for (const p of value) {
    if (p.kind !== "ask" && !options.some((o) => samePick(o.pick, p))) options.push({ pick: { kind: p.kind, id: p.id }, label: pickLabel(p, state) });
  }
  const askUseful = state.browsers.some((b) => b.name) || value.some((p) => p.kind === "ask");
  if (askUseful) options.push({ pick: { kind: "ask" }, label: "Ask each time which of your own Chromes" });

  const toggle = (pick: BrowserPick, on: boolean) =>
    onChange(on ? [...value, pick] : value.filter((p) => !samePick(p, pick)));
  const setNote = (pick: BrowserPick, note: string) =>
    onChange(value.map((p) => (samePick(p, pick) ? { ...p, note } : p)));

  if (!options.length) return <p className="muted small">No browsers yet. Add a board browser above, or name one of your own Chromes.</p>;
  return (
    <div className="browser-pick">
      {options.map(({ pick, label, own }, i) => {
        const chosen = value.find((p) => samePick(p, pick));
        const id = `${uid}-${i}`;
        return (
          <div key={`${pick.kind}:${pick.id ?? ""}`} className="browser-opt">
            <input type="checkbox" id={id} checked={!!chosen} onChange={(e) => toggle(pick, e.target.checked)} />
            <div className="browser-opt-main">
              <label htmlFor={id}>{label}{own && <span className="muted small"> (your own Chrome)</span>}</label>
              {chosen && pick.kind !== "ask" && (
                <input type="text" value={chosen.note ?? ""} maxLength={200} aria-label={`What ${label} is for`}
                  placeholder="What it is for (optional)"
                  onChange={(e) => setNote(pick, e.target.value)} />
              )}
            </div>
          </div>
        );
      })}
      <span className="muted small">Claude reads the note to know which browser to use for which job.</span>
    </div>
  );
}

/**
 * More → Browsers, one page: the board's own browsers (board-browsers.ts: Chromes the board starts, each with its own
 * logins) as cards, Add, the user's own Chromes through the Claude extension (chromes.ts) folded, then the browsers
 * each board uses.
 */
export function BrowsersDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<BrowsersState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useNow();

  useEffect(() => {
    const load = () => void api.browsers().then(setState, (e) => setError(e.message));
    load();
    return subscribe((e) => (e.type === "browsers.updated" || e.type === "profile.updated") && load());
  }, []);

  const act = async (fn: () => Promise<BrowsersState>) => {
    setError(null);
    try {
      setState(await fn());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const own = state?.browsers ?? [];
  const boardBrowsers = state?.boardBrowsers ?? [];
  const canPick = boardBrowsers.length > 0 || own.some((b) => b.name);

  return (
    <Modal title="Browsers" onClose={onClose} focusDialog>
      <div className="browsers">
        <p className="muted small browsers-intro">
          Board browsers are Chrome windows the board keeps for itself, each with its own logins. They keep working when you switch Claude account.
        </p>
        {!state && !error && <div className="muted small"><span className="spinner" /> Loading…</div>}
        {state && (
          <>
            <h3 className="browsers-h">Board browsers</h3>
            {!state.chrome.installed && state.chrome.message && <div className="browsers-note">{state.chrome.message}</div>}
            {!boardBrowsers.length && state.chrome.installed && (
              <p className="muted small">None yet. Add one for each set of logins a task needs, for example a business WhatsApp.</p>
            )}
            {boardBrowsers.map((b) => (
              <BoardBrowserCard key={b.id} browser={b} chromeInstalled={state.chrome.installed} setState={setState} />
            ))}
            <AddBoardBrowser disabled={!state.chrome.installed} onAdded={setState} />

            <details className="browsers-own" open={!boardBrowsers.length}>
              <summary>Your own Chrome (through the Claude extension){own.length ? ` · ${own.length}` : ""}</summary>
              {!own.length && (
                <p className="muted small">
                  No Chrome seen yet. A Chrome shows up here after a task has used the browser while it was connected to Claude in Chrome.
                </p>
              )}
              {own.map((b) => (
                <BrowserRow key={b.deviceId} browser={b} connected={state.connected.includes(b.deviceId)} listedAt={state.listedAt}
                  onRename={(name) => act(() => api.renameBrowser(b.deviceId, name))}
                  onRemove={() => act(() => api.removeBrowser(b.deviceId))} />
              ))}
              <p className="muted small browsers-own-foot">These depend on the Claude extension and on the Claude account it is signed in to.</p>
            </details>

            <h3 className="browsers-h">Browsers each board uses</h3>
            {!canPick && <p className="muted small">Add a board browser or name one of your own Chromes, then pick it for a board here.</p>}
            {canPick && (
              <div>
                {state.boards.map((p) => <BoardPick key={p.slug} board={p} state={state} onSaved={setState} onError={setError} />)}
              </div>
            )}
            <div className="browsers-note">
              A task only uses the browsers ticked for its board, unless the task picks its own. If one needs sign-in, Claude stops and tells you.
            </div>
          </>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

/** One board browser: name, Signed in / Needs sign-in, last site and use, Open window or Sign in, keep running, rename, remove. */
function BoardBrowserCard({ browser: b, chromeInstalled, setState }: {
  browser: BoardBrowserView;
  chromeInstalled: boolean;
  setState: (s: BrowsersState) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(b.name);
  const [startUrl, setStartUrl] = useState(b.startUrl ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setName(b.name), [b.name]);
  useEffect(() => setStartUrl(b.startUrl ?? ""), [b.startUrl]);

  const run = async <T extends BrowsersState>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(what);
    setError(null);
    try {
      const r = await fn();
      setState(r);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  };
  const open = async () => {
    setMessage(null);
    const r = await run("open", () => api.openBoardBrowser(b.id));
    if (r) setMessage(r.message);
  };
  const close = async () => {
    setMessage(null);
    const r = await run("close", () => api.closeBoardBrowser(b.id));
    if (r) setMessage(r.message);
  };
  const saveName = async () => {
    const clean = name.trim();
    if (!clean || clean === b.name) { setName(b.name); setRenaming(false); return; }
    if (await run("rename", () => api.updateBoardBrowser(b.id, { name: clean }))) setRenaming(false);
  };
  const saveStart = async () => {
    const v = startUrl.trim();
    if (v === (b.startUrl ?? "")) return;
    if (!(await run("start", () => api.updateBoardBrowser(b.id, { startUrl: v || null })))) setStartUrl(b.startUrl ?? "");
  };

  const phone = usePhone();
  const needsSignIn = b.signIn === "Needs sign-in";
  const notChecked = b.signIn === "Not checked";
  const running = b.state === "hidden" || b.state === "visible";
  const inUse = b.inUse > 0;
  const where = needsSignIn && b.signInSite ? `logged out of ${b.signInSite}` : b.lastSite ? b.lastSite.site : notChecked ? "no site opened yet" : null;
  // A browser that isn't running keeps what the last look said, with when.
  const checked = !running && b.checkedAt && !notChecked ? `checked ${timeAgo(b.checkedAt)}` : null;
  const used = b.lastUsedAt ? `used ${timeAgo(b.lastUsedAt)}` : null;
  const stateText = b.state === "visible" ? "Window open on your Mac" : b.state === "starting" ? "Starting…" : b.state === "closing" ? "Closing…" : null;
  const onMac = phone ? " on the Mac" : "";
  return (
    <div className="browser board-browser">
      <span className={`browser-dot${needsSignIn ? " warn" : notChecked ? " off" : ""}`} />
      <div className="browser-meta">
        {renaming ? (
          <input value={name} autoFocus maxLength={40} aria-label="Browser name" onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { e.stopPropagation(); setName(b.name); setRenaming(false); } }} />
        ) : <span className="browser-name">{b.name}</span>}
        <span className="muted small">
          <span className={`browser-tag${needsSignIn ? " warn" : notChecked ? " off" : ""}`}>{b.signIn}</span>
          {inUse && <span className="browser-tag busy">In use by a task</span>}
          {[checked, where, used, stateText].filter(Boolean).join(" · ")}
        </span>
        {needsSignIn && running && <SignInScreen id={b.id} site={b.signInSite} />}
        <div className="browser-acts">
          {needsSignIn
            ? <button className="btn primary" disabled={!chromeInstalled || !!busy} onClick={() => void open()}>{busy === "open" ? "Opening…" : phone ? "Sign in on the Mac" : "Sign in on your Mac"}</button>
            : <button className="btn" disabled={!chromeInstalled || !!busy} onClick={() => void open()}>{busy === "open" ? "Opening…" : `Open window${onMac}`}</button>}
          {b.state === "visible" && !inUse && (
            <button className="btn ghost" disabled={!!busy} onClick={() => void close()}>{busy === "close" ? "Closing…" : "Close window"}</button>
          )}
          {!renaming && <button className="btn ghost" disabled={!!busy} onClick={() => setRenaming(true)}>Rename</button>}
          {!inUse && <button className="btn ghost" disabled={!!busy} onClick={() => setConfirming(true)}>Remove</button>}
        </div>
        <span className="muted small">
          {b.windowPending
            ? "A task is using it now. Its window opens on your Mac once the task is done."
            : inUse
              ? "A task is using it now. Open window waits until the task is done; the window opens on your Mac."
              : phone
                ? needsSignIn && running
                  ? "Or sign in above, from this phone. The button opens a window on the Mac, not on this phone."
                  : "Opens a Chrome window on the Mac, not on this phone."
                : needsSignIn || notChecked
                  ? "Opens a Chrome window on your Mac. Sign in to the sites this browser needs, then close it."
                  : "Opens a Chrome window on your Mac."}
        </span>
        <label className="browser-keep">
          <input type="checkbox" role="switch" className="switch" checked={b.keepRunning} disabled={!!busy}
            onChange={(e) => void run("keep", () => api.updateBoardBrowser(b.id, { keepRunning: e.target.checked }))} />
          <span>
            Keep running
            <span className="muted small">Stays open in the background, for tasks that watch a page all day.</span>
          </span>
        </label>
        {b.keepRunning && (
          <label className="browser-start">
            <span className="muted small">Opens at</span>
            <input value={startUrl} maxLength={300} placeholder="e.g. web.whatsapp.com" aria-label="Page it opens at"
              onChange={(e) => setStartUrl(e.target.value)} onBlur={() => void saveStart()}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          </label>
        )}
        {message && <span className="browser-msg small">{message}</span>}
        {(error || b.error) && <span className="form-error small" role="alert">{error ?? b.error}</span>}
      </div>
      {confirming && (
        <ConfirmDialog title={`Remove ${b.name}?`} confirmLabel="Remove" busyLabel="Removing…"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setState(await api.removeBoardBrowser(b.id));
            setConfirming(false);
          }}>
          This deletes the browser and every login saved in it. To use those sites again, you would add a new browser and sign in again.
        </ConfirmDialog>
      )}
    </div>
  );
}

/** How often the sign-in screen asks for a new picture while it is shown. */
const SCREEN_MS = 3000;

/**
 * A logged-out browser's login page, live (a new picture every few seconds while the card is open), so sign-in works
 * without the Mac: scan a WhatsApp QR code with the phone that has the account, or tap the picture and type (for
 * "Link with phone number instead"). Taps and typing go to that page only. Pictures are never saved.
 */
function SignInScreen({ id, site }: { id: string; site: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [big, setBig] = useState(false);
  const inFlight = useRef(false);
  const current = useRef<string | null>(null);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (inFlight.current || document.hidden) return;
      inFlight.current = true;
      try {
        const url = await api.boardBrowserScreen(id);
        if (!alive) return URL.revokeObjectURL(url);
        if (current.current) URL.revokeObjectURL(current.current);
        current.current = url;
        setSrc(url);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        inFlight.current = false;
      }
    };
    refresh.current = () => void load();
    void load();
    const t = setInterval(() => void load(), SCREEN_MS);
    return () => {
      alive = false;
      clearInterval(t);
      if (current.current) URL.revokeObjectURL(current.current);
      current.current = null;
    };
  }, [id]);

  const send = async (ev: Parameters<typeof api.boardBrowserInput>[1]) => {
    setSending(true);
    try {
      await api.boardBrowserInput(id, ev);
      setError(null);
      setTimeout(() => refresh.current(), 400);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSending(false);
    }
  };
  const tap = (e: React.MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const share = (v: number) => Math.min(1, Math.max(0, v));
    void send({ type: "click", x: share((e.clientX - r.left) / r.width), y: share((e.clientY - r.top) / r.height) });
  };
  const typeIt = async () => {
    if (!text) return;
    if (await send({ type: "text", text })) setText("");
  };
  const whatsapp = site === "web.whatsapp.com";
  return (
    <div className="signin-screen">
      <span className="small">
        {whatsapp
          ? "The WhatsApp login page, live. Scan the code with the phone that has this WhatsApp account (Settings, Linked devices), or tap \"Log in with phone number\" in the picture and type the number in the box below."
          : "The login page, live. Tap it to press buttons or pick a field, then type below."}
      </span>
      <div className={`signin-shot${big ? " big" : ""}`}>
        {src
          ? <img src={src} alt={`Login page of ${site ?? "the site"}. Tap to click there.`} onClick={tap} draggable={false} />
          : !error && <span className="muted small"><span className="spinner" /> Loading the page…</span>}
      </div>
      <div className="signin-type">
        <input value={text} maxLength={200} placeholder="Type into the page" aria-label="Text to type into the login page"
          autoComplete="off" autoCapitalize="off" spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void typeIt(); } }} />
        <button className="btn" disabled={sending || !text} onClick={() => void typeIt()}>Type</button>
      </div>
      <div className="browser-acts">
        <button className="btn ghost" disabled={sending} onClick={() => void send({ type: "key", key: "Enter" })}>Press Enter</button>
        <button className="btn ghost" disabled={sending} onClick={() => void send({ type: "key", key: "Backspace" })}>Delete a letter</button>
        <button className="btn ghost" aria-pressed={big} onClick={() => setBig(!big)}>{big ? "Smaller" : "Bigger"}</button>
      </div>
      {error && <span className="form-error small" role="alert">{error}</span>}
    </div>
  );
}

/** "+ Add a board browser", then a name field. */
function AddBoardBrowser({ disabled, onAdded }: { disabled: boolean; onAdded: (s: BrowsersState) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onAdded(await api.addBoardBrowser(name));
      setName("");
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return <button className="btn browsers-add" disabled={disabled} onClick={() => setOpen(true)}>+ Add a board browser</button>;
  }
  return (
    <div className="browsers-add-form">
      <input value={name} autoFocus maxLength={40} placeholder="Name it, e.g. Business WhatsApp" aria-label="New browser name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void add(); if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }} />
      <div className="browser-acts">
        <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void add()}>{busy ? "Adding…" : "Add"}</button>
        <button className="btn ghost" onClick={() => { setOpen(false); setName(""); setError(null); }}>Cancel</button>
      </div>
      <span className="muted small">Then sign in to the sites it is for. Its logins stay separate from your own Chrome.</span>
      {error && <span className="form-error small" role="alert">{error}</span>}
    </div>
  );
}

/** One board's row: the chosen browsers as chips, Change opens the ticks (Done saves). */
function BoardPick({ board: p, state, onSaved, onError }: {
  board: BrowsersState["boards"][number];
  state: BrowsersState;
  onSaved: (s: BrowsersState) => void;
  onError: (msg: string | null) => void;
}) {
  const [draft, setDraft] = useState<BrowserPick[] | null>(null);
  const [busy, setBusy] = useState(false);
  const picks = p.browsers ?? [];
  const done = async () => {
    if (!draft) return;
    const clean = draft.map((d) => (d.note?.trim() ? { ...d, note: d.note.trim() } : { kind: d.kind, ...(d.id ? { id: d.id } : {}) }));
    if (JSON.stringify(clean) === JSON.stringify(picks)) { setDraft(null); return; }
    setBusy(true);
    onError(null);
    try {
      await api.updateProfile(p.slug, { browsers: clean.length ? clean : null });
      onSaved(await api.browsers());
      setDraft(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="browsers-board">
      <div className="browsers-board-top">
        <span className="browsers-board-name">{p.name}</span>
        <span className="browsers-chips">
          {picks.length
            ? picks.map((x) => <span key={`${x.kind}:${x.id ?? ""}`} className="pill" title={x.note || undefined}>{pickLabel(x, state)}</span>)
            : <span className="muted small">Not set</span>}
          {draft
            ? <button className="btn ghost" disabled={busy} onClick={() => void done()}>{busy ? "Saving…" : "Done"}</button>
            : <button className="btn ghost" onClick={() => setDraft(picks)} aria-label={`Change browsers for ${p.name}`}>Change</button>}
        </span>
      </div>
      {draft && <BrowserPicker state={state} value={draft} onChange={setDraft} />}
    </div>
  );
}

function BrowserRow({ browser: b, connected, listedAt, onRename, onRemove }: {
  browser: ChromeBrowser;
  connected: boolean;
  listedAt: string | null;
  onRename: (name: string) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}) {
  const [name, setName] = useState(b.name);
  useEffect(() => setName(b.name), [b.name]);
  const save = async () => {
    if (name.trim() === b.name) return;
    if (!(await onRename(name))) setName(b.name);
  };
  const status = connected
    ? `Connected${listedAt ? ` at the last check, ${timeAgo(listedAt)}` : ""}`
    : `Not connected at the last check · last seen ${timeAgo(b.lastSeenAt)}`;
  return (
    <div className="browser own-browser">
      <span className={`browser-dot${connected ? "" : " off"}`} title={connected ? "Connected when a task last listed the Chromes" : "Not connected when a task last listed the Chromes"} />
      <div className="browser-meta">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void save()} maxLength={40}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setName(b.name); }}
          placeholder="Name it, e.g. Work" aria-label={`Name for ${b.label || "this Chrome"}`} />
        <span className="muted small">{status}{b.hint ? ` · last used on ${b.hint.site}` : ""}</span>
        <span className="browser-id muted" title="Claude in Chrome's name for it changes when it reconnects; the board goes by this id">
          {b.label ? `${b.label} · ` : ""}{b.deviceId}
        </span>
        <button className="btn ghost small browser-remove" onClick={() => void onRemove()} title="Forget this Chrome. It comes back, unnamed, the next time a task lists the Chromes.">Remove</button>
      </div>
    </div>
  );
}
