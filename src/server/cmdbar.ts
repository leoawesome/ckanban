// The ⌘K command bar's ticket rows (GET /api/tickets?scope=open|done). The bar used to get a row for every ticket on
// every board each time it opened (about 2 MB at 10,000 tickets). Now it gets the tickets that aren't Done at once
// (a few hundred), and finds Done tickets through a search here that sends only the best few matches.
import { hiddenTool, parentLink } from "../../web/src/family";
import { rankTickets } from "../../web/src/fuzzy";
import { pauser } from "./lag";
import type { Store } from "./store";
import type { Ticket } from "./types";

export interface CmdRow {
  profile: string;
  profileName: string;
  id: string;
  title: string;
  status: string;
  running: boolean;
  updatedAt: string;
  body: string;
  summary: string;
  prUrl: string | null;
  mainTicket?: { id: string; title: string } | null;
}

/** Most Done tickets one search sends (the bar shows 15 tickets at most). */
export const CMD_SEARCH_LIMIT = 20;
/** Done tickets ranked per step of a search: each step keeps its best, and the best of those are the answer. */
const CHUNK = 250;

/** Long texts are capped: the bar only needs enough to find a word and show a snippet around it. */
const cap = (s: string | null | undefined) => (s && s.length > 4000 ? s.slice(0, 4000) : s ?? "");

export class CommandRows {
  /**
   * Each ticket's last result summary (capped), kept while its comments and the ticket didn't change: the Store counts
   * its own comment writes (commentStamp, in memory), so a search reads no file for a ticket it saw before. The first
   * search after a start reads them in slices. Real summaries are a few hundred characters: about 4 MB at 10,000.
   */
  private summaries = new Map<string, { key: string; text: string }>();

  constructor(private store: Store, private isRunning: (slug: string, id: string) => boolean) {}

  private summary(slug: string, t: Ticket): string {
    const id = `${slug}/${t.id}`;
    const key = `${t.updatedAt}|${this.store.commentStamp(slug, t.id)}`;
    const hit = this.summaries.get(id);
    if (hit?.key === key) return hit.text;
    const text = cap(this.store.lastAiComment(slug, t.id));
    this.summaries.set(id, { key, text });
    return text;
  }

  private row(p: { slug: string; name: string }, t: Ticket): CmdRow {
    return {
      profile: p.slug, profileName: p.name, id: t.id, title: t.title, status: t.status,
      running: this.isRunning(p.slug, t.id), updatedAt: t.updatedAt,
      body: cap(t.body), summary: this.summary(p.slug, t), prUrl: t.prUrl,
    };
  }

  /** A hidden tool ticket stands for its main ticket's card (null: it has none, so the bar doesn't list it). */
  private withMain(row: CmdRow, t: Ticket, byId: () => Map<string, Ticket>): CmdRow {
    if (!hiddenTool(t)) return row;
    const ids = byId();
    const seen = new Set<string>();
    let cur: Ticket | undefined = t;
    let top: Ticket = t;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.main) { top = cur; break; }
      top = cur;
      const l = parentLink(cur);
      cur = l ? ids.get(l.id) : undefined;
    }
    return { ...row, mainTicket: top.id !== t.id ? { id: top.id, title: top.title } : null };
  }

  private byIdOf(slug: string): () => Map<string, Ticket> {
    let m: Map<string, Ticket> | undefined;
    return () => (m ??= new Map(this.store.listTickets(slug).map((t) => [t.id, t])));
  }

  /** Every ticket that isn't Done, on every board. */
  async open(): Promise<CmdRow[]> {
    const pause = pauser();
    const out: CmdRow[] = [];
    for (const p of this.store.listProfiles()) {
      await this.store.listTicketsSliced(p.slug);
      const byId = this.byIdOf(p.slug);
      for (const t of this.store.listOpenTickets(p.slug)) {
        await pause();
        out.push(this.withMain(this.row(p, t), t, byId));
      }
    }
    return out;
  }

  /**
   * The Done tickets on every board that best match `q`, ranked as the bar ranks (title first, then the result, the
   * description or the pull request, then title letters in order; `current` board first on ties). Walks the boards'
   * cached lists in slices; at most `limit` rows.
   */
  async searchDone(q: string, current: string | null, limit = CMD_SEARCH_LIMIT): Promise<CmdRow[]> {
    const query = q.trim();
    if (!query) return [];
    const n = Math.max(1, Math.min(Math.floor(limit) || CMD_SEARCH_LIMIT, 50));
    const pause = pauser();
    let best: CmdRow[] = [];
    let chunk: CmdRow[] = [];
    const tickets = new Map<CmdRow, Ticket>();
    const flush = (byId: () => Map<string, Ticket>) => {
      if (!chunk.length) return;
      // A step's best, with their main tickets (a tool ticket without one isn't listed), joins the best so far.
      const top = rankTickets(chunk, query, current, n * 2).map((h) => this.withMain(h.row, tickets.get(h.row)!, byId)).filter((r) => r.mainTicket !== null);
      best = rankTickets([...best, ...top], query, current, n).map((h) => h.row);
      chunk = [];
      tickets.clear();
    };
    for (const p of this.store.listProfiles()) {
      const byId = this.byIdOf(p.slug);
      for (const t of await this.store.listTicketsSliced(p.slug)) {
        if (t.status !== "done") continue;
        await pause();
        const r = this.row(p, t);
        tickets.set(r, t);
        chunk.push(r);
        if (chunk.length >= CHUNK) flush(byId);
      }
      flush(byId);
    }
    return best;
  }
}
