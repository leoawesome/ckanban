import { useEffect, useState } from "react";
import { api, subscribe, type DeviceUser, type DeviceView } from "./lib/api";
import { Modal, useFormDirty } from "./components/Modal";
import { EmptyState, FormError, LoadState } from "./components/formParts";
import { DevicesIcon, PlusIcon } from "./components/icons";
import { toast } from "./components/toast";
import { heldFor } from "./Needs";
import { timeAgo } from "./lib/time";
import { useNow } from "./hooks/useNow";

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

  const load = () => void api.devices().then((d) => { setDevices(d); setError(null); }, (e) => setError(e.message));
  useEffect(() => {
    load();
    return subscribe((e) => e.type === "devices.updated" && load());
  }, []);

  /** Runs a change; a failure is returned so the row it came from shows it under itself. */
  const act = async (fn: () => Promise<DeviceView[]>): Promise<string | null> => {
    try {
      setDevices(await fn());
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const remove = async (d: DeviceView) => {
    const failed = await act(() => api.deleteDevice(d.name));
    if (!failed) toast(`Removed ${d.name}`, { action: { label: "Undo", run: () => { void act(() => api.saveDevice({ name: d.name, description: d.description, capacity: d.capacity })); } } });
    return failed;
  };

  return (
    <Modal title="Devices" onClose={onClose} focusDialog>
      <div className="devices">
        <p className="muted small devices-intro">
          Things only a few tickets can use at once. Claude asks for one just before it uses it and lets go when done. Shared by every board.
        </p>
        {devices && devices.length > 0 && !adding && (
          <button className="btn small icon-label device-new-btn" onClick={() => setAdding(true)}><PlusIcon size={14} aria-hidden /> New device</button>
        )}
        {adding && <AddDevice onCancel={() => setAdding(false)} onAdd={async (input) => {
          const failed = await act(() => api.saveDevice(input));
          if (!failed) setAdding(false);
          return failed;
        }} />}
        {!devices && <LoadState error={error} onRetry={load} rows={3} className="devices-loading" />}
        {devices?.length === 0 && !adding && (
          <EmptyState icon={<DevicesIcon size={20} />} title="No devices yet"
            actions={<button className="btn primary icon-label" onClick={() => setAdding(true)}><PlusIcon size={14} aria-hidden /> New device</button>}>
            For example "chrome-whatsapp": a browser signed in to one account. Claude also adds one the first time it asks for a name that isn't here.
          </EmptyState>
        )}
        {devices?.map((d) => (
          <DeviceRow key={d.name} device={d} board={board} onOpenTicket={onOpenTicket}
            onSave={(patch) => act(() => api.saveDevice({ name: d.name, ...patch }))}
            onRemove={() => remove(d)}
            onFree={(u) => act(() => api.freeDevice(d.name, u.slug, u.id))} />
        ))}
        {devices && <FormError>{error}</FormError>}
      </div>
    </Modal>
  );
}

function DeviceRow({ device: d, board, onSave, onRemove, onFree, onOpenTicket }: {
  device: DeviceView;
  board: string | null;
  onSave: (patch: { description?: string; capacity?: number }) => Promise<string | null>;
  onRemove: () => Promise<string | null>;
  onFree: (u: DeviceUser) => Promise<string | null>;
  onOpenTicket?: (board: string, id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(d.description);
  const [cap, setCap] = useState(String(d.capacity));
  const [saving, setSaving] = useState(false);
  /** A failed action on this device, shown under it. */
  const [rowErr, setRowErr] = useState<string | null>(null);
  useFormDirty(editing && (desc !== d.description || cap !== String(d.capacity)));
  const startEdit = () => {
    setDesc(d.description);
    setCap(String(d.capacity));
    setRowErr(null);
    setEditing((v) => !v);
  };
  const run = async (fn: () => Promise<string | null>) => {
    setRowErr(null);
    const failed = await fn();
    setRowErr(failed);
    return !failed;
  };
  const save = async () => {
    const n = Math.floor(Number(cap));
    const patch: { description?: string; capacity?: number } = {};
    if (desc !== d.description) patch.description = desc;
    if (Number.isFinite(n) && n >= 1 && n !== d.capacity) patch.capacity = Math.min(50, n);
    if (!Object.keys(patch).length) return setEditing(false);
    setSaving(true);
    if (await run(() => onSave(patch))) setEditing(false);
    setSaving(false);
  };
  const who = (u: DeviceUser) => (
    <>
      {onOpenTicket
        ? <button className="link-btn device-ticket" onClick={() => onOpenTicket(u.slug, u.id)}>{u.title ?? u.id}</button>
        : <span className="device-ticket">{u.title ?? u.id}</span>}
      {u.slug !== board && <span className="muted"> · {u.board}</span>}
    </>
  );
  const tag = d.addedByClaude && (
    <span className="device-pill new" title="Claude asked for this name, so the board added it. Describe it so every Claude knows what it is.">Added by Claude</span>
  );
  const busy = d.using.length > 0 || d.waiting.length > 0;
  return (
    <div className="device">
      <div className="device-head">
        <span className="device-name">{d.name}</span>
        {d.capacity > 1 && <span className="device-cap-note muted">{d.capacity} at once</span>}
        <button className="btn ghost small device-edit-btn" aria-expanded={editing} onClick={startEdit}>{editing ? "Cancel" : "Edit"}</button>
      </div>
      {editing ? (
        <form className="device-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="device-field">
            <span>What it is</span>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} autoFocus maxLength={300}
              placeholder="e.g. Chrome tab signed in to WhatsApp Web as Leo" />
          </label>
          <div className="device-edit-row">
            <label className="device-cap" title="How many tickets may use it at once">
              <input type="number" min={1} max={50} inputMode="numeric" value={cap} aria-label={`How many tickets may use ${d.name} at once`}
                onChange={(e) => setCap(e.target.value)} />
              at once
            </label>
            <span className="spacer" />
            <button className="btn primary small" type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          </div>
          {/* Away from Save, so a thumb can't hit it by mistake; Undo brings it back. */}
          <div className="form-danger device-danger">
            <button className="btn ghost danger small" type="button" onClick={() => void run(onRemove)}
              disabled={d.using.length > 0 || d.waiting.length > 0} title={d.using.length || d.waiting.length ? "Free it first" : "Remove it from the list"}>Remove {d.name}</button>
            {(d.using.length > 0 || d.waiting.length > 0) && <span className="muted small">Free it first to remove it.</span>}
          </div>
        </form>
      ) : d.description && <div className="device-desc">{d.description}</div>}
      <div className="device-status">
        {d.using.map((u, i) => (
          <div key={`${u.slug}/${u.id}`} className="device-use">
            <span className="device-pill using">Using · {heldFor(u.since)}</span>
            {who(u)}
            {d.capacity > 1 && i === d.using.length - 1 && <span className="muted"> · {d.using.length} of {d.capacity} in use</span>}
            <button className="link-btn device-free" title="Take it from this ticket. The ticket keeps running; its next request waits in line." onClick={() => void run(() => onFree(u))}>Free it</button>
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
            {tag}
          </div>
        )}
        {busy && tag && <div className="device-use">{tag}</div>}
      </div>
      <FormError>{rowErr}</FormError>
    </div>
  );
}

function AddDevice({ onAdd, onCancel }: { onAdd: (input: { name: string; description: string; capacity: number }) => Promise<string | null>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [capacity, setCapacity] = useState("1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useFormDirty(!busy && !!(name.trim() || description.trim()));
  return (
    <form className="device device-new" onSubmit={async (e) => {
      e.preventDefault();
      if (!name.trim() || busy) return;
      setBusy(true);
      setErr(await onAdd({ name: name.trim().toLowerCase(), description, capacity: Math.max(1, Math.floor(Number(capacity)) || 1) }));
      setBusy(false);
    }}>
      <div className="device-head">
        <label className="device-field device-name-field">
          <span>Name<span className="req" aria-hidden>*</span></span>
          <input className="device-name-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-required="true"
            placeholder="chrome-whatsapp" spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off" aria-describedby="device-name-help" />
        </label>
        <label className="device-cap">
          at once
          <input type="number" min={1} max={50} inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} aria-label="How many tickets may use it at once" />
        </label>
      </div>
      <span id="device-name-help" className="muted small">Use a specific name: "chrome-whatsapp", not "chrome", so tickets only wait for the thing they share.</span>
      <label className="device-field">
        <span>What it is</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300}
          placeholder="e.g. Chrome tab signed in to WhatsApp Web as Leo" />
      </label>
      <FormError>{err}</FormError>
      <div className="device-edit-actions">
        {!name.trim() && <span className="why-off device-why">Add a name to save it.</span>}
        <button className="btn ghost small" type="button" onClick={onCancel}>Cancel</button>
        <button className="btn primary small" type="submit" disabled={!name.trim() || busy}>{busy ? "Adding…" : "Add device"}</button>
      </div>
    </form>
  );
}
