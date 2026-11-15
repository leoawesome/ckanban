import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, COLUMNS, type Profile, type Ticket, type TicketRow } from "./api";
import { avatarColor, avatarLetter } from "./avatar";
import { mainTicketOf, onBoard } from "./family";
import { fuzzyMatch, highlightRuns, rankTickets, type Snippet } from "./fuzzy";
import { CheckIcon, ChevronRightIcon, SearchIcon } from "./icons";
import { usePhone } from "./usePhone";
import { useFocusTrap, useLayer } from "./layers";
import { useBackdropClose } from "./sheet";

export interface CommandAction {
  id: string;
  label: string;
  /** Muted words after the label, e.g. what the action opens. */
  hint?: string;
  /** Keys shown on the right, e.g. ["N"] or ["Ctrl", "`"]. */
  keys?: string[];
  icon?: ReactNode;
  /** Listed only once something is typed (filters, columns, themes), so the list stays short when it opens. */
  searchOnly?: boolean;
  run: () => void;
}

type Item =
  | { kind: "ticket"; key: string; row: TicketRow; at: number[]; snippet?: Snippet }
  | { kind: "action"; key: string; action: CommandAction; at: number[] }
  | { kind: "board"; key: string; profile: Profile; num: number | null; at: number[] };

const GROUP_TITLE = { ticket: "Tickets", action: "Actions", board: "Boards" } as const;
const SWITCH = "Switch to ";
const SNIPPET_LABEL = { summary: "Result", body: "Description", pr: "Pull request" } as const;

function Marked({ text, at, offset = 0 }: { text: string; at: number[]; offset?: number }) {
  if (!at.length) return <>{text}</>;
  return <>{highlightRuns(text, at.map((i) => i + offset)).map((r, i) => (r.hit ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))}</>;
}

// The live list has no result summaries; they come from the all-boards rows.
const rowOf = (p: Profile, t: Ticket, summary: string, mainTicket?: { id: string; title: string } | null): TicketRow => ({
  profile: p.slug, profileName: p.name, id: t.id, title: t.title, status: t.status, running: !!t.running, updatedAt: t.updatedAt,
  body: t.body, summary, prUrl: t.prUrl, ...(mainTicket ? { mainTicket } : {}),
});

/**
 * Every board's tickets that aren't Done, kept for the session: the bar shows the last list at once and refreshes it
 * quietly each time it opens. Done tickets (thousands on a big board) are searched on the daemon as the user types.
 */
let openRows: TicketRow[] | null = null;
/** Recent Done searches (query → rows), so typing back or reopening the bar with the same words shows them at once. */
const doneFound = new Map<string, TicketRow[]>();
const DONE_FOUND_MAX = 30;
/** Waits this long after the last key before searching Done on the daemon. */
const SEARCH_WAIT_MS = 180;

/**
 * ⌘K: one box for tickets on every board, board actions and board switching.
 * Tickets on the shown board come from the live list; other boards' open tickets load when the bar opens (kept for
 * the session), and Done tickets on every board come from a search on the daemon a moment after typing.
 */
export function CommandBar({ profiles, current, tickets, needYou, actions, onOpenTicket, onSwitchBoard, onClose }: {
  profiles: Profile[];
  current: string | null;
  tickets: Ticket[];
  needYou: Map<string, number>;
  actions: CommandAction[];
  onOpenTicket: (board: string, id: string) => void;
  onSwitchBoard: (slug: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [others, setOthers] = useState<TicketRow[] | null>(openRows);
  // Done tickets matching what is typed (the last search's until the next one answers: the ranking drops misses).
  const [found, setFound] = useState<TicketRow[]>([]);
  const [searching, setSearching] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayer(onClose);
  useFocusTrap(box);
  const backdrop = useBackdropClose(onClose);
  const phone = usePhone();

  useEffect(() => {
    api.openTickets().then((r) => { openRows = r; setOthers(r); }).catch(() => setOthers((o) => o ?? []));
  }, []);

  const query = q.trim();
  useEffect(() => {
    if (!query) { setSearching(false); return; }
    const key = `${current ?? ""}\u0000${query.toLowerCase()}`;
    // A query asked before shows its last answer at once and is still asked again (a ticket finished, renamed or
    // deleted since), as the open rows are.
    const hit = doneFound.get(key);
    if (hit) setFound(hit);
    setSearching(!hit);
    let live = true;
    const timer = setTimeout(() => {
      api.findDoneTickets(query, current).then((r) => {
        doneFound.delete(key);
        doneFound.set(key, r);
        if (doneFound.size > DONE_FOUND_MAX) doneFound.delete(doneFound.keys().next().value!);
        if (live) setFound(r);
      }).catch(() => {}).finally(() => { if (live) setSearching(false); });
    }, SEARCH_WAIT_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [query, current]);

  const here = profiles.find((p) => p.slug === current) ?? null;
  const rows = useMemo(() => {
    const fetched = [...(others ?? []), ...found];
    const summaries = new Map(fetched.filter((r) => r.profile === current).map((r) => [r.id, r.summary]));
    const held = new Set(tickets.map((t) => t.id));
    const listed = new Set<string>();
    return [
      ...(here ? tickets.map((t) => {
        // A hidden task stands for its main ticket's card; one shown on the board is its own card.
        const main = !onBoard(t) ? mainTicketOf(tickets, t.id) : undefined;
        return rowOf(here, t, summaries.get(t.id) ?? "", main ? { id: main.id, title: main.title } : !onBoard(t) ? null : undefined);
      }) : []),
      // Other boards' open tickets, and Done ones the search found (this board's only when it hasn't loaded them:
      // Done loads in pages).
      ...fetched.filter((r) => {
        const key = `${r.profile}/${r.id}`;
        if ((r.profile === current && held.has(r.id)) || listed.has(key)) return false;
        listed.add(key);
        return true;
      }),
    ];
  }, [here, tickets, others, found, current]);

  const items = useMemo<Item[]>(() => {
    // Tool tickets are found (by query only) but open their main ticket; a tool ticket without one isn't listed.
    const ranked = rankTickets(rows.filter((r) => r.mainTicket !== null && (query || !r.mainTicket)), query, current, query ? 30 : 8);
    const seen = new Set<string>();
    const ticketItems: Item[] = ranked.flatMap(({ row, at, snippet }): Item[] => {
      const shown = row.mainTicket ? { ...row, id: row.mainTicket.id, title: row.mainTicket.title, via: row.title } : row;
      const key = `t:${shown.profile}/${shown.id}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ kind: "ticket", key, row: shown, at: row.mainTicket ? [] : at, snippet: row.mainTicket ? undefined : snippet }];
    }).slice(0, query ? 15 : 8);
    // Keep the list order when nothing is typed; otherwise best match first.
    const matched = <T,>(list: T[], text: (x: T) => string) => {
      const out = list.flatMap((x, i) => {
        const m = fuzzyMatch(text(x), query);
        return m ? [{ x, i, at: m.at, score: m.score }] : [];
      });
      return query ? out.sort((a, b) => a.score - b.score) : out;
    };
    const actionItems: Item[] = matched(query ? actions : actions.filter((a) => !a.searchOnly), (a) => a.label)
      .map(({ x, at }) => ({ kind: "action", key: `a:${x.id}`, action: x, at }));
    const boardItems: Item[] = matched(profiles, (p) => p.name)
      .map(({ x, i, at }) => ({ kind: "board", key: `b:${x.slug}`, profile: x, num: i < 9 ? i + 1 : null, at }));
    return [...ticketItems, ...actionItems, ...boardItems];
  }, [query, rows, current, actions, profiles]);

  const at = Math.min(active, Math.max(0, items.length - 1));
  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === "ticket") onOpenTicket(item.row.profile, item.row.id);
    else if (item.kind === "action") item.action.run();
    else onSwitchBoard(item.profile.slug);
  };

  const onKey = (e: React.KeyboardEvent) => {
    // Functional updates: fast repeats land before the next render.
    const last = items.length - 1;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(last, Math.min(i, last) + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, Math.min(i, last) - 1)); }
    else if (e.key === "Home" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setActive(last); }
    else if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); run(items[at]); }
  };

  const status = (r: TicketRow) => (r.running && r.status !== "in_progress" ? "Running" : COLUMNS.find((c) => c.id === r.status)?.label ?? r.status);
  const optionId = (item: Item) => `cmd-${item.key.replace(/[^\w-]/g, "_")}`;

  return (
    <div className="overlay cmdbar-overlay" {...backdrop}>
      <div ref={box} className="cmdbar" role="dialog" aria-modal="true" aria-label="Command bar">
        <div className="cmdbar-input">
          <SearchIcon className="icon" />
          <input autoFocus value={q} placeholder={phone ? "Search tickets and actions" : "Search tickets on every board, actions and boards…"} aria-label="Search tickets, actions and boards"
            role="combobox" aria-expanded aria-controls="cmdbar-list" aria-autocomplete="list"
            aria-activedescendant={items[at] ? optionId(items[at]) : undefined}
            onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKey} />
          {phone ? <button type="button" className="link-btn cmdbar-cancel" onClick={onClose}>Cancel</button> : <kbd aria-hidden>esc</kbd>}
        </div>
        <div className="cmdbar-list" id="cmdbar-list" role="listbox" aria-label="Results">
          {items.length === 0 && <div className="picker-empty">Nothing matches “{q.trim()}”.</div>}
          {items.map((item, i) => {
            const head = i === 0 || items[i - 1].kind !== item.kind;
            const on = i === at;
            return (
              <Fragment key={item.key}>
                {head && (
                  <div className="cmdbar-group" role="presentation">
                    {GROUP_TITLE[item.kind]}
                    {item.kind === "ticket" && !q.trim() && <span className="cmdbar-group-note">active, most recent first</span>}
                    {item.kind === "ticket" && (others === null || searching) && <span className="spinner" />}
                  </div>
                )}
                <div id={optionId(item)} role="option" aria-selected={on} className={`cmdbar-item${on ? " active" : ""}`}
                  onMouseMove={() => { if (!on) setActive(i); }} onMouseDown={(e) => e.preventDefault()} onClick={() => run(item)}
                  ref={(el) => { if (el && on) el.scrollIntoView({ block: "nearest" }); }}>
                  {item.kind === "ticket" && (
                    <>
                      <span className="cmdbar-title">
                        <Marked text={item.row.title} at={item.at} />
                        {item.row.via && <span className="cmdbar-snippet"><span className="cmdbar-snippet-label">via</span> {item.row.via}</span>}
                        {item.snippet && (
                          <span className="cmdbar-snippet">
                            <span className="cmdbar-snippet-label">{SNIPPET_LABEL[item.snippet.field]}</span> <Marked text={item.snippet.text} at={item.snippet.at} />
                          </span>
                        )}
                      </span>
                      <span className={`cmdbar-board${item.row.profile === current ? " here" : ""}`}>{item.row.profileName}</span>
                      <span className={`cmdbar-status st-${item.row.running ? "running" : item.row.status}`}>{status(item.row)}</span>
                    </>
                  )}
                  {item.kind === "action" && (
                    <>
                      <span className="cmdbar-icon" aria-hidden>{item.action.icon ?? <ChevronRightIcon size={14} />}</span>
                      <span className="cmdbar-title"><Marked text={item.action.label} at={item.at} />{item.action.hint && <span className="cmdbar-hint"> · {item.action.hint}</span>}</span>
                      {item.action.keys && <span className="cmdbar-keys">{item.action.keys.map((k, n) => <kbd key={n}>{k}</kbd>)}</span>}
                    </>
                  )}
                  {item.kind === "board" && (
                    <>
                      <span className="profile-avatar" style={{ background: avatarColor(item.profile.slug) }} aria-hidden>{avatarLetter(item.profile.name)}</span>
                      <span className="cmdbar-title"><Marked text={SWITCH + item.profile.name} at={item.at} offset={SWITCH.length} /></span>
                      {!!needYou.get(item.profile.slug) && <span className="need-chip">{needYou.get(item.profile.slug)} need you</span>}
                      {item.profile.slug === current && <span className="profile-check" aria-label="Current board"><CheckIcon size={14} /></span>}
                      {item.num && <span className="cmdbar-keys"><kbd aria-label={`Key ${item.num}`}>{item.num}</kbd></span>}
                    </>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
        <div className="cmdbar-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
          <span className="cmdbar-foot-note">Searches tickets (title, description, last result, review link) on every board, actions and boards</span>
        </div>
      </div>
    </div>
  );
}
