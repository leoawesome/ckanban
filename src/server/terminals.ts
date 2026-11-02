import { isClaudeCommand, liveSessionMatch, processCommands } from "./claude";
import { SAFETY_PASS_MS, type SessionChanges } from "./changefeed";
import { trackedInterval } from "./lag";
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
   * ticket's session summary. A session the feed reports as changed is read again; all are, every SAFETY_PASS_MS.
   */
  private titles = new Map<string, string | null>();
  private titlesAt = 0;

  constructor(
    private store: Store,
    private bus: Bus,
    private sessions: SessionCache,
    private commands: () => Promise<string[]> = processCommands,
    private feed?: SessionChanges,
    private now: () => number = Date.now,
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
    if (!this.feed?.live || this.now() - this.titlesAt >= SAFETY_PASS_MS) {
      this.titles.clear();
      this.titlesAt = this.now();
    }
    const next = new Set<string>();
    const changed: [string, string][] = [];
    for (const p of this.store.listProfiles()) {
      for (const t of this.store.listTickets(p.slug)) {
        if (!t.sessionId || !t.workdir) continue;
        const key = `${p.slug}/${t.id}`;
        // No claude running: nothing to match, and no title to read.
        const live = cmds.length > 0 && liveSessionMatch(cmds, { id: t.sessionId, title: this.title(t.sessionId) });
        if (live) next.add(key);
        if (live !== this.open.has(key)) changed.push([p.slug, t.id]);
      }
    }
    for (const k of this.open) if (!next.has(k)) {
      const [slug, id] = k.split("/");
      if (!changed.some(([s, i]) => s === slug && i === id)) changed.push([slug, id]);
    }
    this.open = next;
    for (const [slug, id] of changed) {
      const t = this.store.getTicket(slug, id);
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
