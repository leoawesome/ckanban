import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "./util";

/**
 * Shared devices (a WhatsApp Web tab, a phone, an emulator): things only a few tickets may use at once, on every board.
 * A run's Claude takes one just before it uses it and lets go when done (take_devices / release_devices); the board
 * frees whatever a ticket still holds when its run ends. Ticket.needs is only a hint of which devices a ticket expects.
 *
 * Takes are all-or-nothing (a request for two devices gets both or waits for both) and first come, first served: a
 * waiting request keeps later requests off its devices, so nobody overtakes it. A ticket that already holds a device
 * can't ask for more until it lets go: it asks for everything it needs together, so two tickets never each hold one
 * device and wait forever for the other. Holds and the queue live in memory: a daemon restart ends every run anyway.
 */

export interface Device {
  /** Lowercase, specific: "chrome-whatsapp", not "chrome". */
  name: string;
  /** One line on what it is, for every Claude that reads the list. */
  description: string;
  /** How many tickets may use it at once. */
  capacity: number;
  /** Claude asked for a name that wasn't on the list, so the board added it (capacity 1). */
  addedByClaude?: boolean;
  lastUsedAt?: string | null;
}

/** Who holds or waits: a ticket ("<profile>/<ticket id>"). */
export interface DeviceUser { slug: string; id: string; since: string }

export interface DeviceView extends Device {
  using: DeviceUser[];
  waiting: DeviceUser[];
}

/** What a ticket's card shows: devices it has now, and the ones it waits for. */
export interface DeviceTicketState {
  using: { name: string; since: string }[];
  waiting: { names: string[]; since: string } | null;
}

export type TakeResult =
  | { ok: true; names: string[] }
  | { ok: false; names: string[]; place: number; usedBy: DeviceUser[] };

export class DeviceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** How long one take_devices call waits before it answers "still waiting" (the ticket keeps its place). */
export const TAKE_WAIT_MS = 4 * 60_000;
/** A waiting request nobody asked about again for this long is dropped (its Claude moved on). */
export const STALE_WAIT_MS = 10 * 60_000;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const MAX_CAPACITY = 50;

/** Trimmed, lowercase, without repeats; throws on an empty list or a name that isn't a plain word. */
export function deviceNames(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const names = [...new Set(list.map((n) => (typeof n === "string" ? n.trim().toLowerCase() : "")).filter(Boolean))];
  if (!names.length) throw new DeviceError(400, "name at least one device, e.g. [\"chrome-whatsapp\"]");
  for (const n of names) {
    if (!NAME_RE.test(n)) throw new DeviceError(400, `"${n}" isn't a device name: use lowercase letters, digits and dashes, e.g. "chrome-whatsapp"`);
  }
  return names;
}

interface Hold { owner: string; name: string; at: string }
interface Wait {
  owner: string;
  names: string[];
  at: string;
  /** Last time its Claude asked (a call waiting now counts as asking). */
  askedAt: number;
  /** Calls waiting for this request right now. */
  wakers: Set<() => void>;
}

const ownerKey = (slug: string, id: string) => `${slug}/${id}`;
const userOf = (owner: string, since: string): DeviceUser => {
  const i = owner.indexOf("/");
  return { slug: owner.slice(0, i), id: owner.slice(i + 1), since };
};

export class Devices {
  private list: Device[];
  private holds: Hold[] = [];
  private queue: Wait[] = [];

  /** onChange: the list or who holds or waits changed; owners: tickets whose state changed ("<profile>/<id>"). */
  constructor(private root: string, private onChange: (owners: string[]) => void = () => {}, private now: () => number = Date.now) {
    this.list = this.load();
  }

  private get file() {
    return join(this.root, "devices.json");
  }

  private load(): Device[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      return (Array.isArray(raw) ? raw : []).filter((d) => d && typeof d.name === "string" && NAME_RE.test(d.name)).map((d) => ({
        name: d.name, description: typeof d.description === "string" ? d.description : "",
        capacity: clampCapacity(d.capacity), ...(d.addedByClaude ? { addedByClaude: true } : {}), lastUsedAt: d.lastUsedAt ?? null,
      }));
    } catch {
      return [];
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.list, null, 2));
    renameSync(tmp, this.file);
  }

  devices(): Device[] {
    return this.list.map((d) => ({ ...d }));
  }

  get(name: string): Device | null {
    return this.list.find((d) => d.name === name) ?? null;
  }

  views(): DeviceView[] {
    return this.list.map((d) => ({
      ...d,
      using: this.holds.filter((h) => h.name === d.name).map((h) => userOf(h.owner, h.at)),
      waiting: this.queue.filter((w) => w.names.includes(d.name)).map((w) => userOf(w.owner, w.at)),
    }));
  }

  ticketState(slug: string, id: string): DeviceTicketState | null {
    const owner = ownerKey(slug, id);
    const using = this.holds.filter((h) => h.owner === owner).map((h) => ({ name: h.name, since: h.at }));
    const w = this.queue.find((x) => x.owner === owner);
    if (!using.length && !w) return null;
    return { using, waiting: w ? { names: [...w.names], since: w.at } : null };
  }

  /** Add a device, or change its description or capacity. */
  upsert(input: { name: string; description?: string; capacity?: number }): Device {
    const [name] = deviceNames([input.name]);
    let d = this.get(name);
    if (!d) {
      d = { name, description: "", capacity: 1, lastUsedAt: null };
      this.list.push(d);
    }
    if (input.description !== undefined) d.description = String(input.description).trim().slice(0, 300);
    if (input.capacity !== undefined) d.capacity = clampCapacity(input.capacity);
    // The user looked at it: it is theirs now.
    delete d.addedByClaude;
    this.save();
    this.pump();
    return { ...d };
  }

  /** Remove a device from the list; refused while a ticket uses it or waits for it. */
  remove(name: string): void {
    if (!this.get(name)) throw new DeviceError(404, `no device named "${name}"`);
    if (this.holds.some((h) => h.name === name) || this.queue.some((w) => w.names.includes(name))) {
      throw new DeviceError(409, `${name} is in use or a ticket waits for it: free it first`);
    }
    this.list = this.list.filter((d) => d.name !== name);
    this.save();
    this.onChange([]);
  }

  /**
   * Take every named device for the ticket, waiting up to waitMs for all of them at once. Names not on the list are
   * added (one ticket at a time). When the wait runs out, the ticket keeps its place and asks again.
   */
  async take(slug: string, id: string, rawNames: unknown, waitMs = TAKE_WAIT_MS): Promise<TakeResult> {
    const names = deviceNames(rawNames);
    const owner = ownerKey(slug, id);
    const mine = this.holds.filter((h) => h.owner === owner).map((h) => h.name);
    if (names.every((n) => mine.includes(n))) return { ok: true, names };
    if (mine.length) {
      throw new DeviceError(409, `you already have ${mine.join(", ")}. Let go of it first (release_devices), then ask for everything you need in one request ` +
        `(e.g. ${JSON.stringify([...new Set([...mine, ...names])])}), so two tickets never each hold one device and wait for the other.`);
    }
    let added = false;
    for (const n of names) {
      if (this.get(n)) continue;
      this.list.push({ name: n, description: "", capacity: 1, addedByClaude: true, lastUsedAt: null });
      added = true;
    }
    if (added) this.save();
    let w = this.queue.find((x) => x.owner === owner);
    if (w && !sameSet(w.names, names)) {
      // A different request: it goes to the back of the line.
      this.queue = this.queue.filter((x) => x !== w);
      w = undefined;
    }
    if (!w) {
      w = { owner, names, at: nowIso(), askedAt: this.now(), wakers: new Set() };
      this.queue.push(w);
    }
    w.askedAt = this.now();
    this.pump(owner);
    if (this.has(owner, names)) return { ok: true, names };
    const wait = w;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wait.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      wait.wakers.add(done);
    });
    wait.askedAt = this.now();
    if (this.has(owner, names)) return { ok: true, names };
    const place = this.queue.indexOf(wait);
    if (place < 0) throw new DeviceError(409, "your request was cancelled (the user freed it or the run ended): ask again if you still need it");
    const usedBy = this.holds.filter((h) => names.includes(h.name) && h.owner !== owner).map((h) => userOf(h.owner, h.at));
    return { ok: false, names, place: place + 1, usedBy };
  }

  /** Let go of the named devices (all of them when names is empty), and drop the ticket's waiting request. */
  release(slug: string, id: string, rawNames?: unknown): string[] {
    const owner = ownerKey(slug, id);
    const names = rawNames === undefined || rawNames === null || (Array.isArray(rawNames) && !rawNames.length) ? null : deviceNames(rawNames);
    const gone = this.holds.filter((h) => h.owner === owner && (!names || names.includes(h.name)));
    this.holds = this.holds.filter((h) => !gone.includes(h));
    const w = this.queue.find((x) => x.owner === owner && (!names || x.names.some((n) => names.includes(n))));
    if (w) this.drop(w);
    if (gone.length || w) this.pump(owner);
    return gone.map((h) => h.name);
  }

  /** The ticket's run ended: free everything it holds or waits for. */
  releaseAll(slug: string, id: string): void {
    this.release(slug, id);
  }

  /** The user's "Free it": the ticket loses this device (it keeps running; its next take waits in line). */
  free(name: string, slug: string, id: string): void {
    const owner = ownerKey(slug, id);
    const before = this.holds.length;
    this.holds = this.holds.filter((h) => !(h.owner === owner && h.name === name));
    if (this.holds.length === before) throw new DeviceError(404, `that ticket isn't using ${name}`);
    this.pump(owner);
  }

  private has(owner: string, names: string[]): boolean {
    return names.every((n) => this.holds.some((h) => h.owner === owner && h.name === n));
  }

  private drop(w: Wait): void {
    this.queue = this.queue.filter((x) => x !== w);
    for (const wake of [...w.wakers]) wake();
  }

  /** Grant waiting requests in arrival order; a request that can't be granted keeps later ones off its devices. */
  private pump(...changed: string[]): void {
    const owners = new Set(changed);
    const cutoff = this.now() - STALE_WAIT_MS;
    for (const w of [...this.queue]) {
      if (!w.wakers.size && w.askedAt < cutoff) {
        this.drop(w);
        owners.add(w.owner);
      }
    }
    const free = new Map(this.list.map((d) => [d.name, d.capacity - this.holds.filter((h) => h.name === d.name).length]));
    let used = false;
    for (const w of [...this.queue]) {
      if (w.names.every((n) => (free.get(n) ?? 0) > 0)) {
        const at = nowIso();
        for (const n of w.names) {
          free.set(n, free.get(n)! - 1);
          this.holds.push({ owner: w.owner, name: n, at });
          const d = this.get(n);
          if (d) d.lastUsedAt = at;
        }
        used = true;
        this.drop(w);
        owners.add(w.owner);
      } else {
        for (const n of w.names) free.set(n, 0);
      }
    }
    if (used) this.save();
    this.onChange([...owners]);
  }
}

function clampCapacity(n: unknown): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_CAPACITY, Math.max(1, v)) : 1;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}
