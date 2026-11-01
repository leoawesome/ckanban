import { useState } from "react";
import { api, type Ticket } from "./api";
import { CloseIcon, DeviceIcon } from "./icons";
import { useNow } from "./useNow";

/** How long a device has been held or waited for, in whole minutes: "under 1 min", "12 min", "1 h 5 min". */
export function heldFor(iso: string, at = Date.now()): string {
  const m = Math.max(0, Math.floor((at - new Date(iso).getTime()) / 60_000));
  if (m < 1) return "under 1 min";
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}

/**
 * One shared device on a card. using: its run has it now (orange, with how long). waiting: its run asked and waits
 * (yellow, with how long). Neither: only listed in the ticket's Needs, as a hint (grey).
 */
export function DeviceChip({ name, using, waiting }: { name: string; using?: string; waiting?: string }) {
  useNow();
  const label = using ? `Using ${name} · ${heldFor(using)}` : waiting ? `Waiting for ${name} · ${heldFor(waiting)}` : name;
  const title = using ? `This ticket is using ${name} now` : waiting ? `Waiting for ${name}: another ticket is using it` : `Expects to use ${name} (a hint; it doesn't hold it)`;
  return (
    <span className={`res-chip ${using ? "held" : waiting ? "wait" : ""}`} title={title}>
      <DeviceIcon size={11} strokeWidth={1.7} /> {label}
    </span>
  );
}

/** A card's device chips: the ones in use, the ones it waits for, then the rest of its Needs as hints. */
export function DeviceChips({ ticket }: { ticket: Ticket }) {
  const d = ticket.devices;
  const using = d?.using ?? [];
  const waiting = d?.waiting?.names ?? [];
  const hints = (ticket.needs ?? []).filter((n) => !waiting.includes(n) && !using.some((u) => u.name === n));
  if (!using.length && !waiting.length && !hints.length) return null;
  return (
    <>
      {using.map((u) => <DeviceChip key={u.name} name={u.name} using={u.since} />)}
      {waiting.map((n) => <DeviceChip key={n} name={n} waiting={d!.waiting!.since} />)}
      {hints.map((n) => <DeviceChip key={n} name={n} />)}
    </>
  );
}

/** Ticket drawer field: the shared devices (Ticket.needs) this ticket expects to use, a hint for its runs. */
export function NeedsField({ slug, ticket, onError }: { slug: string; ticket: Ticket; onError: (msg: string) => void }) {
  const needs = ticket.needs ?? [];
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (next: string[]) => {
    setBusy(true);
    try {
      await api.updateTicket(slug, ticket.id, { needs: next });
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const names = draft.split(",").map((x) => x.trim().toLowerCase()).filter((x) => x && !needs.includes(x));
    setDraft("");
    if (names.length) void save([...needs, ...names]);
  };
  return (
    <div className="needs-field">
      <span className="field-key" title="Shared devices this ticket expects to use">Needs</span>
      <div className="needs-chips">
        {needs.map((n) => (
          <span key={n} className="chip on needs-chip">
            {n}
            <button className="link-btn" aria-label={`Remove ${n}`} disabled={busy} onClick={() => save(needs.filter((x) => x !== n))}>
              <CloseIcon size={10} />
            </button>
          </span>
        ))}
        <input value={draft} disabled={busy} placeholder={needs.length ? "Add…" : "Add device…"} aria-label="Add a device"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && needs.length) void save(needs.slice(0, -1));
          }} />
      </div>
      <span className="field-help">Shared devices this ticket expects to use. A hint only: the ticket still starts right away, and Claude takes a device just while it uses it.</span>
    </div>
  );
}
