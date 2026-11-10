import { useMemo, useState } from "react";
import type { Profile } from "./api";
import { avatarColor, avatarLetter } from "./avatar";
import { fuzzyMatch } from "./fuzzy";
import { boardDigit } from "./keynav";
import { CheckIcon } from "./icons";
import { Modal } from "./Modal";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";

// Every row matches a real handler (App.tsx, TicketDrawer.tsx, Inbox.tsx, Changes.tsx, Dock.tsx, …). Single keys stay
// quiet while typing in a field and inside the bottom panel.
const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: "Boards",
    keys: [
      [[MOD, "K"], "Command bar: tickets on every board, actions, boards (with a ticket open, its actions too)"],
      [[MOD, "B"], "Switch board (from anywhere, even while typing)"],
      [["B"], "Switch board (also with a ticket open)"],
      [["[", "]"], "Previous / next board (on the board)"],
      [["1…9"], "Go to board 1–9 (on the board)"],
    ],
  },
  {
    title: "Board",
    keys: [
      [["N"], "New ticket (also with a ticket open)"],
      [["/"], "Search tickets"],
      [["Esc"], "In the search box: clear it, again to leave it"],
      [["I"], "Open the inbox, first entry selected"],
      [["U"], "Undo, while a note with Undo shows (Moved…, Snoozed…)"],
      [["Ctrl", "`"], "Terminal side panel: opens it, or puts the keyboard in it (in the open ticket's copy of the folder)"],
      [["F"], "Files side panel (also with a ticket open)"],
      [["C"], "Claude side panel: quick chat, no ticket (also with a ticket open)"],
      [["T"], "Team side panel: teammates, squads, huddles (also with a ticket open)"],
      [["Esc"], "In the side panels: leave a text box, again to hide the column (not in the Terminal)"],
      [[MOD, "Shift", "O"], "In the Claude panel: start a new chat (even while typing)"],
      [["Esc"], "In the Claude panel: close its past chats list first"],
      [["?"], "This list (also with a ticket open)"],
      [["Hold", MOD], "Show key hints on buttons"],
    ],
  },
  {
    title: "New ticket dialog",
    keys: [
      [[MOD, "Enter"], "Start (planning or work, by how Claude works)"],
      [[MOD, "S"], "Save for later (Backlog, nothing runs)"],
      [[MOD, "I"], "Switch Interview me first / Just do it"],
      [[MOD, "D"], "Star as important"],
      [["Esc"], "Close (asks first when you typed something)"],
    ],
  },
  {
    title: "Cards",
    keys: [
      [["J", "K", "H", "L", "↑", "↓", "←", "→"], "Select a card"],
      [["Enter"], "Open the ticket"],
      [["S"], "Star / unstar (a focused card)"],
      [["M"], "Move to a column (a focused card)"],
      [["D"], "Mark done (a focused Review card)"],
      [["Space"], "Pick up / drop the card"],
      [["↑", "↓", "←", "→"], "Move a picked-up card"],
      [["Esc"], "Cancel the move"],
    ],
  },
  {
    title: "Inbox",
    keys: [
      [["I"], "Open it (on the board)"],
      [["↑", "↓"], "Select an entry"],
      [["Home", "End"], "First / last entry"],
      [["Enter"], "Open the ticket (Answer / Open)"],
      [["D"], "Mark done"],
      [["S"], "Snooze for a day / unsnooze (on the Older row: snooze them all)"],
      [["Esc"], "Close"],
    ],
  },
  {
    title: "Ticket panel",
    keys: [
      [["↑", "↓", "K", "J"], "Previous / next ticket"],
      [["Alt", "↑", "↓"], "Previous / next ticket, also while typing"],
      [[MOD, "Shift", "Enter"], "Next step: apply proposal & start work / start work / mark done"],
      [["/"], "Write a message (opens the Chat tab)"],
      [["Enter"], "Send a chat message"],
      [["Shift", "Enter"], "New line"],
      [["Esc"], "In a text box: leave it (what you typed stays)"],
      [["E"], "Edit the description"],
      [["R"], "Refine with Claude (Backlog)"],
      [["S"], "Star / unstar as important"],
      [["M"], "Move to a column (Status)"],
      [["[", "]"], "Previous / next tab"],
      [[MOD, "."], "Stop Claude (asks first)"],
      [[MOD, "Enter"], "Save the description"],
      [["Esc"], "Cancel the description edit"],
      [[MOD, "\\"], "Show / hide details"],
      [[MOD, "K"], "This ticket's actions: go to what needs you, mark done, delete…"],
      [["↑", "↓", "C"], "Changes tab, on a line's +: other lines, comment on it"],
      [["Esc"], "Close (one layer at a time)"],
    ],
  },
  {
    title: "In forms and lists",
    keys: [
      [["Esc"], "Close the dialog or menu on top (one at a time)"],
      [["↑", "↓", "Enter"], "Lists (⌘K, board picker, Move to column): pick, then open"],
      [["1…9"], "Board picker (nothing typed) and Move to column: that row"],
      [[MOD, "Home", "End"], "Command bar: first / last result"],
      [["1…9"], "Claude's questions: pick that answer (one more: your own answer)"],
      [["Enter"], "Claude's questions: next question, then send"],
      [["←"], "Claude's questions: back one question"],
      [["↑"], "Empty chat box: edit your queued message"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="form shortcuts">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <dl>
              {g.keys.map(([keys, what]) => (
                <div key={what} className="shortcut-row">
                  <dt>{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/** Lower is better; null = no match. Letters must appear in order; word starts and runs score best. */
export const fuzzyScore = (text: string, query: string): number | null => fuzzyMatch(text, query)?.score ?? null;

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** B: type part of a board name, Enter switches. Rows keep the header's board order, so the 1…9 hints match. */
export function BoardSwitcher({ profiles, current, needYou, onPick, onClose }: {
  profiles: Profile[]; current: string | null; needYou: Map<string, number>; onPick: (slug: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const all = profiles.map((p, i) => ({ p, num: i < 9 ? i + 1 : null }));
    if (!q.trim()) return all;
    return all.map((x) => ({ x, s: fuzzyScore(x.p.name, q) ?? fuzzyScore(x.p.slug, q) }))
      .filter((y) => y.s !== null).sort((a, b) => a.s! - b.s!).map((y) => y.x);
  }, [profiles, q]);
  const [active, setActive] = useState(() => Math.max(0, profiles.findIndex((p) => p.slug === current)));
  const pick = (i: number) => shown[i] && onPick(shown[i].p.slug);

  return (
    <Modal title="Switch board" onClose={onClose}>
      <div className="form switcher">
        <input autoFocus value={q} placeholder="Type part of a board name…" aria-label="Board name"
          role="combobox" aria-expanded aria-controls="board-switcher-list" aria-activedescendant={shown[active] ? `bs-${shown[active].p.slug}` : undefined}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            // 1…9 with nothing typed yet: switch to that board (the number shown on its row), don't search for the digit.
            const digit = !q && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey ? boardDigit(e.nativeEvent.code) : null;
            if (digit !== null) {
              e.preventDefault();
              if (profiles[digit]) onPick(profiles[digit].slug);
              return;
            }
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(active); }
          }} />
        <div className="switcher-list" id="board-switcher-list" role="listbox" aria-label="Boards">
          {shown.length === 0 && <div className="picker-empty">No board matches.</div>}
          {shown.map(({ p, num }, i) => {
            const need = needYou.get(p.slug);
            return (
              <div key={p.slug} id={`bs-${p.slug}`} role="option" aria-selected={i === active}
                className={`switcher-item board-switcher-item${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}
                ref={(el) => { if (el && i === active) el.scrollIntoView({ block: "nearest" }); }}>
                <span className="profile-avatar" style={{ background: avatarColor(p.slug) }} aria-hidden>{avatarLetter(p.name)}</span>
                <span className="profile-body">
                  <span className="profile-name">{p.name}</span>
                  <span className="profile-path" title={p.path}>{tilde(p.path)}</span>
                </span>
                {!!need && <span className="need-chip">{need} need you</span>}
                {p.slug === current && <span className="profile-check" aria-label="Current board"><CheckIcon size={14} /></span>}
                {num && <kbd aria-label={`Key ${num}`}>{num}</kbd>}
              </div>
            );
          })}
        </div>
        <div className="muted small switcher-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> pick</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>1…9</kbd> go to that board</span>
          <span><kbd>[</kbd> <kbd>]</kbd> previous / next board anywhere</span>
        </div>
      </div>
    </Modal>
  );
}
