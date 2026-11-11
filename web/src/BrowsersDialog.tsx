import { useEffect, useState } from "react";
import { api, subscribe, type BrowsersState, type ChromeBrowser } from "./api";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { timeAgo } from "./time";
import { useNow } from "./useNow";

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

/**
 * More → Browsers: every Chrome a run has listed on this Mac (server: chromes.ts), each with the user's name and the
 * last site a run opened there, then each board's default Chrome. Runs then select that Chrome by deviceId.
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

  const setDefault = async (slug: string, chrome: string) => {
    setError(null);
    try {
      await api.updateProfile(slug, { chrome: chrome || null });
      setState(await api.browsers());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const browsers = state?.browsers ?? [];
  const named = browsers.filter((b) => b.name);
  const options = [
    { value: "", label: "Not set", hint: "Claude uses whichever Chrome is connected" },
    ...named.map((b) => ({ value: b.deviceId, label: b.name })),
    { value: ASK_CHROME, label: "Ask each time" },
  ];

  return (
    <Modal title="Browsers" onClose={onClose} focusDialog>
      <div className="browsers">
        <p className="muted small browsers-intro">
          Name each Chrome once. Claude uses the board's Chrome unless a task picks another one.
        </p>
        {!state && !error && <div className="muted small"><span className="spinner" /> Loading…</div>}
        {state && !browsers.length && (
          <p className="muted small">
            No Chrome seen yet. A Chrome shows up here after a task has used the browser while it was connected to Claude in Chrome.
          </p>
        )}
        {browsers.map((b) => (
          <BrowserRow key={b.deviceId} browser={b} connected={state!.connected.includes(b.deviceId)} listedAt={state!.listedAt}
            onRename={(name) => act(() => api.renameBrowser(b.deviceId, name))}
            onRemove={() => act(() => api.removeBrowser(b.deviceId))} />
        ))}
        {state && browsers.length > 0 && (
          <>
            <h3 className="browsers-h">Default Chrome per board</h3>
            {named.length === 0 && <p className="muted small">Name a Chrome above to pick it as a board's default.</p>}
            {state.boards.map((p) => {
              // A default whose Chrome was removed from the list still shows, so the user sees it and can change it.
              const gone = p.chrome && p.chrome !== ASK_CHROME && !named.some((b) => b.deviceId === p.chrome);
              const opts = gone ? [...options, { value: p.chrome!, label: "A removed or unnamed Chrome" }] : options;
              return (
                <div key={p.slug} className="browsers-board">
                  <span>{p.name}</span>
                  <Select ariaLabel={`Default Chrome for ${p.name}`} value={p.chrome ?? ""} options={opts}
                    onChange={(v) => void setDefault(p.slug, v)} />
                </div>
              );
            })}
            <div className="browsers-note">
              If the chosen Chrome isn't connected, Claude stops and asks you. It never falls back to another one.
            </div>
          </>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </Modal>
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
    <div className="browser">
      <span className={`browser-dot${connected ? "" : " off"}`} title={connected ? "Connected when a task last listed the Chromes" : "Not connected when a task last listed the Chromes"} />
      <div className="browser-meta">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void save()} maxLength={40}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setName(b.name); }}
          placeholder="Name it, e.g. Work" aria-label={`Name for ${b.label || "this Chrome"}`} />
        <span className="muted small">{status}{b.hint ? ` · last used on ${b.hint.site}` : ""}</span>
        <span className="browser-id muted" title="Claude in Chrome's name for it changes when it reconnects; the board goes by this id">
          {b.label ? `${b.label} · ` : ""}{b.deviceId}
        </span>
      </div>
      <button className="btn ghost small" onClick={() => void onRemove()} title="Forget this Chrome. It comes back, unnamed, the next time a task lists the Chromes.">Remove</button>
    </div>
  );
}
