import { isClaudeCommand, processCommands } from "./claude";
import { DONE_PASS_MS, SAFETY_PASS_MS, type SessionChanges } from "./changefeed";
import { pauser, trackedInterval } from "./lag";
import type { Bus } from "./events";
import type { SessionCache } from "./session";
import type { Store } from "./store";

/**
 * Tracks which linked tickets have their Claude session open in a terminal right now.
 * One `ps` per poll for all tickets; views read the last result synchronously.
 */
export class TerminalWatcher {
  private open = new Set<string>();
  /**
   * Session titles (a terminal resumed by title shows it in its command line), so a poll doesn't read every linked
   * ticket's session summary (a few stats each: seconds on a big board when the Mac is busy). A session the feed
   * reports as changed is read again; those of tickets not Done every SAFETY_PASS_MS (every poll without a live feed),
   * those of Done tickets (most of a big board) every DONE_PASS_MS.
   */
  private titles = new Map<string, string | null>();
  private titlesAt = -Infinity;
  private doneAt = -Infinity;

  constructor(
    private store: Store,
    private bus: Bus,
    private sessions: SessionCache,
    private commands: () => Promise<string[]> = processCommands,
    private feed?: SessionChanges,
    private now: () => number = Date.now,
    private sliceMs = 30,
  ) {
    feed?.subscribe((c) => (c ? this.titles.delete(c.sessionId) : this.titles.clear()));
  }

  private title(sessionId: string): string | null {
    if (this.titles.has(sessionId)) return this.titles.get(sessionId)!;
    const title = this.sessions.summary(sessionId)?.title ?? null;
    this.titles.set(sessionId, title);
    return title;
  }

  isOpen(slug: string, id: string): boolean {
    return this.open.has(`${slug}/${id}`);
  }

  async poll(): Promise<void> {
    const cmds = (await this.commands()).filter(isClaudeCommand);
    const next = new Set<string>();
    // No claude running: nothing to match, and no title to read.
    if (cmds.length > 0) {
      const now = this.now();
      const active = !this.feed?.live || now - this.titlesAt >= SAFETY_PASS_MS;
      const done = now - this.doneAt >= DONE_PASS_MS;
      if (active) this.titlesAt = now;
      if (done) this.doneAt = now;
      // One string to search (every line is a claude command already): a session id or title in any of them.
      const all = cmds.join("\n");
      const linked = done ? new Set<string>() : null;
      // In slices: a title not known yet is a few stats, or a long transcript read.
      const pause = pauser(this.sliceMs);
      for (const p of this.store.listProfiles()) {
        for (const t of this.store.listTickets(p.slug)) {
          if (!t.sessionId || !t.workdir) continue;
          await pause();
          linked?.add(t.sessionId);
          if (t.status === "done" ? done : active) this.titles.delete(t.sessionId);
          const key = `${p.slug}/${t.id}`;
          if (all.includes(t.sessionId)) {
            next.add(key);
            continue;
          }
          if (!this.titles.has(t.sessionId)) await this.sessions.readIn(t.sessionId, pause);
          const title = this.title(t.sessionId);
          if (title && all.includes(title)) next.add(key);
        }
      }
      // Sessions no ticket links any more.
      if (linked) for (const id of this.titles.keys()) if (!linked.has(id)) this.titles.delete(id);
    }
    const changed = [...next].filter((k) => !this.open.has(k));
    for (const k of this.open) if (!next.has(k)) changed.push(k);
    this.open = next;
    for (const k of changed) {
      const i = k.indexOf("/");
      const slug = k.slice(0, i);
      const t = this.store.getTicket(slug, k.slice(i + 1));
      if (t) this.bus.emit({ type: "ticket.updated", profile: slug, ticket: t });
    }
  }

  start(intervalMs = 3000): () => void {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await this.poll();
      } catch (e) {
        console.error("terminal watcher", e);
      } finally {
        busy = false;
      }
    };
    tick();
    const timer = trackedInterval("terminal-watcher", tick, intervalMs);
    return () => clearInterval(timer);
  }
}
