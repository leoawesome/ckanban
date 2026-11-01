import { useEffect, useState } from "react";
import { api, subscribe, type DeviceUser, type DeviceView } from "./api";
import { Modal } from "./Modal";
import { heldFor } from "./Needs";
import { timeAgo } from "./time";
import { useNow } from "./useNow";

/**
 * More → Devices: the shared device list every board's runs take from (server: devices.ts). Each device has a
 * description and how many tickets may use it at once; the screen shows who uses it and who waits, live, and the
 * user can free a stuck hold.
 */
export function DevicesDialog({ board, onClose, onOpenTicket }: {
  /** The open board's slug: users on other boards get their board's name next to the title. */
  board: string | null;
  onClose: () => void;
  onOpenTicket?: (board: string, id: string) => void;
}) {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useNow();

  useEffect(() => {
    const load = () => void api.devices().then(setDevices, (e) => setError(e.message));
    load();
    return subscribe((e) => e.type === "devices.updated" && load());
  }, []);

  const act = async (fn: () => Promise<DeviceView[]>) => {
    setError(null);
    try {
      setDevices(await fn());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <Modal title="Devices" onClose={onClose} focusDialog>
      <div className="devices">
        <p className="muted small devices-intro">
          Things only a few tickets can use at once. Claude asks for one just before it uses it and lets go when done. Shared by every board.
        </p>
        {!devices && !error && <div className="muted small"><span className="spinner" /> Loading…</div>}
        {devices?.length === 0 && !adding && (
          <p className="muted small">No devices yet. Add one, or Claude adds one the first time it asks for a name that isn't here.</p>
        )}
        {devices?.map((d) => (
          <DeviceRow key={d.name} device={d} board={board} onOpenTicket={onOpenTicket}
            onSave={(patch) => act(() => api.saveDevice({ name: d.name, ...patch }))}
            onRemove={() => act(() => api.deleteDevice(d.name))}
            onFree={(u) => act(() => api.freeDevice(d.name, u.slug, u.id))} />
        ))}
        {adding
          ? <AddDevice onCancel={() => setAdding(false)} onAdd={async (input) => (await act(() => api.saveDevice(input))) && setAdding(false)} />
          : <button className="device-add" onClick={() => setAdding(true)}>+ Add a device</button>}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

function DeviceRow({ device: d, board, onSave, onRemove, onFree, onOpenTicket }: {
  device: DeviceView;
  board: string | null;
  onSave: (patch: { description?: string; capacity?: number }) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  onFree: (u: DeviceUser) => Promise<boolean>;
  onOpenTicket?: (board: string, id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(d.description);
  const [cap, setCap] = useState(String(d.capacity));
  useEffect(() => setCap(String(d.capacity)), [d.capacity]);
  const saveCap = () => {
    const n = Math.floor(Number(cap));
    if (!Number.isFinite(n) || n < 1) return setCap(String(d.capacity));
    if (n !== d.capacity) void onSave({ capacity: n });
  };
  const who = (u: DeviceUser) => (
    <>
      {onOpenTicket
        ? <button className="link-btn device-ticket" onClick={() => onOpenTicket(u.slug, u.id)}>{u.title ?? u.id}</button>
        : <span className="device-ticket">{u.title ?? u.id}</span>}
      {u.slug !== board && <span className="muted"> · {u.board}</span>}
    </>
  );
  return (
    <div className="device">
      <div className="device-head">
        <span className="device-name">{d.name}</span>
        {d.addedByClaude && <span className="device-pill new" title="Claude asked for this name, so the board added it. Describe it so every Claude knows what it is.">Added by Claude</span>}
        <label className="device-cap" title="How many tickets may use it at once">
          at once
          <input type="number" min={1} max={50} value={cap} aria-label={`How many tickets may use ${d.name} at once`}
            onChange={(e) => setCap(e.target.value)} onBlur={saveCap} onKeyDown={(e) => e.key === "Enter" && saveCap()} />
        </label>
        <button className="btn ghost small" onClick={() => { setDesc(d.description); setEditing((v) => !v); }}>{editing ? "Cancel" : "Edit"}</button>
      </div>
      {editing ? (
        <form className="device-edit" onSubmit={async (e) => { e.preventDefault(); if (await onSave({ description: desc })) setEditing(false); }}>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} autoFocus maxLength={300} aria-label={`What ${d.name} is`}
            placeholder="What it is, e.g. Chrome tab signed in to WhatsApp Web as Leo" />
          <button className="btn primary small" type="submit">Save</button>
          <button className="btn ghost danger small" type="button" onClick={() => void onRemove()}
            disabled={d.using.length > 0 || d.waiting.length > 0} title={d.using.length || d.waiting.length ? "Free it first" : "Remove it from the list"}>Remove</button>
        </form>
      ) : d.description
        ? <div className="device-desc">{d.description}</div>
        : <div className="device-desc muted">No description yet. Add one so every Claude knows what it is.</div>}
      <div className="device-status">
        {d.using.map((u, i) => (
          <div key={`${u.slug}/${u.id}`} className="device-use">
            <span className="device-pill using">Using · {heldFor(u.since)}</span>
            {who(u)}
            {d.capacity > 1 && i === d.using.length - 1 && <span className="muted"> · {d.using.length} of {d.capacity} in use</span>}
            <button className="link-btn device-free" title="Take it from this ticket. The ticket keeps running; its next request waits in line." onClick={() => void onFree(u)}>Free it</button>
          </div>
        ))}
        {d.waiting.map((u) => (
          <div key={`w:${u.slug}/${u.id}`} className="device-use">
            <span className="device-pill wait">Waiting · {heldFor(u.since)}</span>
            {who(u)}
          </div>
        ))}
        {!d.using.length && !d.waiting.length && (
          <div className="device-use">
            <span className="device-pill free">Free</span>
            {d.lastUsedAt && <span className="muted"> · last used {timeAgo(d.lastUsedAt)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function AddDevice({ onAdd, onCancel }: { onAdd: (input: { name: string; description: string; capacity: number }) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [capacity, setCapacity] = useState("1");
  return (
    <form className="device device-new" onSubmit={(e) => {
      e.preventDefault();
      if (name.trim()) onAdd({ name: name.trim().toLowerCase(), description, capacity: Math.max(1, Math.floor(Number(capacity)) || 1) });
    }}>
      <div className="device-head">
        <input className="device-name-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Device name"
          placeholder="chrome-whatsapp" spellCheck={false} autoComplete="off" />
        <label className="device-cap">
          at once
          <input type="number" min={1} max={50} value={capacity} onChange={(e) => setCapacity(e.target.value)} aria-label="How many tickets may use it at once" />
        </label>
      </div>
      <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} aria-label="What it is"
        placeholder="What it is, e.g. Chrome tab signed in to WhatsApp Web as Leo" />
      <span className="muted small">Use a specific name: "chrome-whatsapp", not "chrome", so tickets only wait for the thing they share.</span>
      <div className="device-edit-actions">
        <button className="btn ghost small" type="button" onClick={onCancel}>Cancel</button>
        <button className="btn primary small" type="submit" disabled={!name.trim()}>Add</button>
      </div>
    </form>
  );
}
