import { useEffect, useId, useState, type ReactNode } from "react";
import { api, type Loop, type LoopColumn, type LoopInput, type LoopTest, type Pass, type Profile, type Ticket } from "./api";
import { COLUMN_LABEL, COLUMN_MEANING, EVERY_CHOICES, everyLabel, groupLastItems, loopStatus, loopSubtitle, saveBlocker } from "./automations";
import { ConfirmDialog } from "./ConfirmDialog";
import { FeaturePicker } from "./FeaturePicker";
import { ChevronLeftIcon, ChevronRightIcon, MoreIcon } from "./icons";
import { MenuSheet } from "./MenuSheet";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { timeAgo } from "./time";
import { usePhone } from "./usePhone";
import { useBackEntry } from "./backEntry";

type Data = { passes: Pass[]; loops: Loop[] };
type Tab = "settings" | "last" | "how";
type SeenItem = Loop["lastItems"][number];

const NEW_SCRIPT = `# Prints the items to watch as JSON, one per line: {"id": "...", "title": "...", "text": "...", "link": "...", "thread": "..."}
# Items with the same "thread" (for example the issue a comment is on) go into one ticket. Print the oldest first.
# Call a connected service with: ckanban call <service> <tool> '<json arguments>'
`;
const DEFAULT_TEXT = "Look at this item from {{service}} and do what it needs.\n\nLink: {{link}}";
const COLUMNS = ["backlog", "planning", "ready"] as const;
const INTRO = "An automation checks a service on a timer, by itself and for free, and turns each new item into a ticket here.";

/**
 * The board's automations: a check script the board runs on a timer, without Claude; each item it finds for the first
 * time becomes a ticket. Most people set one up with Claude (a Planning chat); the editor here shows and fine-tunes it.
 * Desktop: the list on the left, the picked one on the right (header, tabs, Save at the bottom). Phone: the list fills
 * the screen; tapping one opens its own screen with a back arrow.
 * refreshKey: bumps when an automation or a pass changed on the server.
 */
export function AutomationsDialog({ profile, boards, tickets, refreshKey, initialId, onClose, onOpenTicket, onOpenConnections }: {
  profile: Profile;
  /** Every board, for "Copy to board". */
  boards: Profile[];
  /** This board's tickets, for "Where each new ticket goes". */
  tickets: Ticket[];
  refreshKey: number;
  /** Open on this automation (on a phone: its own screen) instead of the first one. */
  initialId?: string | null;
  onClose: () => void;
  /** Opens a ticket of this board (the setup chat, a ticket an automation made). */
  onOpenTicket: (id: string) => void;
  onOpenConnections: () => void;
}) {
  const phone = usePhone();
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | "new" | null>(initialId ?? null);
  /** Phone only: the picked automation's screen is showing (else the list). */
  const [phoneOpen, setPhoneOpen] = useState(!!initialId);
  const [busy, setBusy] = useState(false);
  /** A new automation just saved: its editor reopens under its id and still says "Saved". */
  const [justMade, setJustMade] = useState<string | null>(null);

  const reload = async () => {
    const [p, loops] = await Promise.all([api.passes(), api.loops(profile.slug)]);
    setData({ passes: p.passes, loops });
    return loops;
  };
  useEffect(() => {
    reload().then((loops) => setSelected((s) => s ?? loops[0]?.id ?? null)).catch((e) => setErr(e.message));
  }, [profile.slug, refreshKey]);

  const setUpWithClaude = async () => {
    setBusy(true);
    setErr(null);
    try {
      const t = await api.automationSetup(profile.slug);
      onOpenTicket(t.id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const open = (id: string | "new") => {
    setSelected(id);
    setPhoneOpen(true);
  };
  const back = () => setPhoneOpen(false);
  // Phone: Back from an automation's screen goes to the list first (the window's own entry closes it after that).
  useBackEntry(phone && phoneOpen, back);
  const deleted = async () => {
    setSelected(null);
    setPhoneOpen(false);
    await reload();
  };

  const loop = data && selected && selected !== "new" ? data.loops.find((l) => l.id === selected) ?? null : null;
  const detail = phone && phoneOpen;
  const title = detail ? (selected === "new" ? "New automation" : loop?.name ?? "Automation") : `Automations · ${profile.name}`;

  return (
    <Modal title={title} onClose={onClose} wide className="auto-modal" bare={detail}>
      {err && <div className="form-error auto-msg">{err}</div>}
      {!data && !err && <div className="muted auto-msg">Loading…</div>}
      {data && (
        <div className="auto-wrap">
          {!detail && (
            <div className="auto-side">
              <div className="auto-list" role="list" aria-label="Automations">
                {data.loops.map((l) => {
                  const st = loopStatus(l);
                  return (
                    <button key={l.id} role="listitem" className={`auto-item${!phone && selected === l.id ? " sel" : ""}`} onClick={() => open(l.id)}>
                      <span className={`auto-dot ${st.tone}`} role="img" aria-label={st.label} title={st.label} />
                      <span className="auto-item-main">
                        <span className="auto-item-name">{l.name}</span>
                        <span className="auto-item-sub">{loopSubtitle(l, timeAgo)}</span>
                      </span>
                      {phone && <ChevronRightIcon size={16} className="auto-chev" />}
                    </button>
                  );
                })}
                {(!data.loops.length || phone) && <div className="auto-intro">{INTRO}</div>}
              </div>
              <div className="auto-side-actions">
                <button className="btn primary" disabled={busy} onClick={setUpWithClaude}>✦ Set up with Claude</button>
                <button className={`btn${phone ? "" : " ghost"}`} onClick={() => open("new")}>+ New, by hand</button>
              </div>
            </div>
          )}
          {(!phone || phoneOpen) && (
            <div className="auto-main">
              {!selected && <div className="muted auto-empty">Set one up with Claude: say what to watch, Claude writes and tests the check, and you save it.</div>}
              {selected === "new" && (
                <LoopEditor key="new" slug={profile.slug} passes={data.passes} tickets={tickets} loop={null} phone={phone} onBack={back}
                  onOpenTicket={onOpenTicket} onOpenConnections={onOpenConnections}
                  onSaved={async (l) => { await reload(); setJustMade(l.id); setSelected(l.id); }} onDeleted={deleted} />
              )}
              {loop && loop.state === "unsupported" && (
                <UnsupportedLoop key={loop.id} slug={profile.slug} loop={loop} phone={phone} onBack={back}
                  onSaved={async () => { await reload(); }} onDeleted={deleted} />
              )}
              {loop && loop.state !== "unsupported" && (
                <LoopEditor key={loop.id} slug={profile.slug} passes={data.passes} tickets={tickets} loop={loop} otherBoards={boards.filter((b) => b.slug !== profile.slug)}
                  phone={phone} onBack={back} onOpenTicket={onOpenTicket} onOpenConnections={onOpenConnections} justSaved={justMade === loop.id}
                  onSaved={async () => { await reload(); }} onDeleted={deleted} />
              )}
              {selected && selected !== "new" && !loop && (
                <>
                  {phone && <PhoneBar title="Automation" onBack={back} />}
                  <div className="muted auto-empty">This automation no longer exists.</div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** A phone screen's top bar: back to the list, the name, and an optional ⋯ button. */
export function PhoneBar({ title, onBack, children }: { title: string; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="auto-phone-bar">
      <button type="button" className="icon-btn" onClick={onBack} aria-label="Back to the list"><ChevronLeftIcon size={20} /></button>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** A field's label with a round "?" that shows its help underneath (the help stays folded until asked for). */
function FieldHead({ label, help, id, htmlFor }: { label: string; help: ReactNode; id?: string; htmlFor?: string }) {
  const [open, setOpen] = useState(false);
  const helpId = useId();
  return (
    <>
      <div className="auto-key">
        {htmlFor ? <label id={id} htmlFor={htmlFor}>{label}</label> : <span id={id}>{label}</span>}
        <button type="button" className="auto-help-btn" aria-label={`About ${label}`} aria-expanded={open} aria-controls={helpId} onClick={() => setOpen((v) => !v)}>?</button>
      </div>
      {/* Under the label on a phone; on a computer under the whole row (styles.css). */}
      {open && <div id={helpId} className="auto-tip">{help}</div>}
    </>
  );
}

/** The header chip for a saved automation: whether it works, in plain words. */
function statusChip(l: Loop): { label: string; tone: string } {
  const st = loopStatus(l);
  if (st.tone === "ok") return { label: "Working", tone: "ok" };
  if (st.label === "Waiting") return { label: "Last check failed", tone: "blocked" };
  return st;
}

function LoopEditor({ slug, passes, tickets, loop, otherBoards = [], phone, justSaved, onBack, onSaved, onDeleted, onOpenTicket, onOpenConnections }: {
  slug: string;
  passes: Pass[];
  tickets: Ticket[];
  loop: Loop | null;
  otherBoards?: Profile[];
  phone: boolean;
  /** Opened right after it was created here: show "Saved" until the first edit. */
  justSaved?: boolean;
  onBack: () => void;
  onSaved: (l: Loop) => Promise<void>;
  onDeleted: () => void | Promise<void>;
  onOpenTicket: (id: string) => void;
  onOpenConnections: () => void;
}) {
  const ids = useId();
  const [name, setName] = useState(loop?.name ?? "");
  const [enabled, setEnabled] = useState(loop?.enabled ?? true);
  const [service, setService] = useState(loop?.service ?? "");
  const [passIds, setPassIds] = useState<string[]>(loop?.passes ?? []);
  const [script, setScript] = useState(loop?.script ?? NEW_SCRIPT);
  const [every, setEvery] = useState(loop?.everyMinutes ?? 15);
  const [column, setColumn] = useState<LoopColumn>(loop?.column ?? "backlog");
  const [autoStart, setAutoStart] = useState(loop?.autoStart ?? false);
  const [askOn, setAskOn] = useState(loop?.askClaude?.on ?? false);
  const [askPrompt, setAskPrompt] = useState(loop?.askClaude?.prompt ?? "");
  const [instructions, setInstructions] = useState(loop?.instructions ?? DEFAULT_TEXT);
  const [partOf, setPartOf] = useState(loop?.partOf ?? "");
  const changed = loop?.state === "script_changed";
  // A new one starts on its script; a changed script file opens that tab by itself.
  const [tab, setTab] = useState<Tab>(!loop || changed ? "how" : "settings");
  const [test, setTest] = useState<LoopTest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [menu, setMenu] = useState<null | "main" | "boards">(null);
  /** The form as last saved here (set right after Save; a new automation reopens with justSaved). */
  const [savedSnap, setSavedSnap] = useState<string | null>(null);
  useEffect(() => { if (changed) setTab("how"); }, [changed]);
  const svc = service.trim() || passes.find((p) => p.id === passIds[0])?.name || "the service";
  const everyOptions = [...new Set([...EVERY_CHOICES, every])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: everyLabel(m) }));
  const blocker = saveBlocker({ name, script, column, autoStart });

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr(null);
    setNote(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const input = (): LoopInput => ({
    name: name.trim(), enabled, service: service.trim(), passes: passIds, script, everyMinutes: every,
    column, autoStart: column !== "backlog" && autoStart, askClaude: { on: askOn, prompt: askPrompt }, instructions,
    partOf: partOf || null,
  });

  const save = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (blocker) return;
    return act("save", async () => {
      const sent = input();
      const l = loop ? await api.updateLoop(slug, loop.id, sent) : await api.createLoop(slug, sent);
      setSavedSnap(JSON.stringify(sent));
      await onSaved(l);
    });
  };

  const copyTo = (to: string) => act("copy", async () => {
    await api.copyLoop(slug, loop!.id, to);
    setNote(`Copied to ${otherBoards.find((b) => b.slug === to)?.name ?? to}, switched off. Switch it on there.`);
  });

  const checkNow = () => act("check", async () => { await onSaved(await api.checkLoop(slug, loop!.id)); });

  const pickColumn = (c: LoopColumn) => {
    setColumn(c);
    if (c === "backlog") setAutoStart(false);
  };

  const togglePass = (id: string) => setPassIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const usable = passes.filter((p) => p.kind !== "key" || p.envName || p.url);
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "settings", label: "Settings" },
    ...(loop ? [{ id: "last" as const, label: "Last check", count: loop.lastFound }] : []),
    { id: "how", label: "How it checks" },
  ];
  const chip = loop && statusChip(loop);
  // "✓ Saved" until the next edit: the form as it was saved, compared with the form now.
  const snap = JSON.stringify(input());
  useEffect(() => { if (justSaved) setSavedSnap(snap); }, []);
  const saved = !err && !note && !busy && savedSnap === snap;
  const footNote = err ?? note ?? (busy ? null : blocker) ?? (saved ? "✓ Saved" : "Changes apply after you save.");

  return (
    <form className="auto-form" onSubmit={save}>
      {phone && (
        <PhoneBar title={loop?.name || "New automation"} onBack={onBack}>
          {loop && (
            <button type="button" className="icon-btn" aria-label="More" aria-haspopup="menu" aria-expanded={!!menu} onClick={() => setMenu("main")}>
              <MoreIcon size={20} />
            </button>
          )}
        </PhoneBar>
      )}
      {menu && loop && (
        <MenuSheet onClose={() => setMenu(null)}>
          <div className="auto-menu" role="menu">
            {menu === "main" ? (
              <>
                {otherBoards.length > 0 && (
                  <button type="button" role="menuitem" className="menu-item" onClick={() => setMenu("boards")}>
                    <span className="menu-label">Copy to board…</span>
                  </button>
                )}
                <button type="button" role="menuitem" className="menu-item danger" onClick={() => { setMenu(null); setConfirm(true); }}>
                  <span className="menu-label">Delete</span>
                </button>
              </>
            ) : (
              <>
                <div className="menu-heading">Copy to board</div>
                {otherBoards.map((b) => (
                  <button key={b.slug} type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); copyTo(b.slug); }}>
                    <span className="menu-label">{b.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </MenuSheet>
      )}

      <div className="auto-scroll">
        <div className="auto-top">
          <div className="auto-title">
            <input className="auto-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Linear: assigned to me" aria-label="Automation name" />
            <label className="auto-switch">
              <input type="checkbox" role="switch" className="switch" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} aria-label="On" />
              <span aria-hidden>{enabled ? "On" : "Off"}</span>
            </label>
          </div>
          {loop && chip && (
            <div className="auto-status">
              <span className={`auto-status-dot ${chip.tone}`} aria-hidden>●</span> {chip.label} · {loop.lastCheckedAt ? `checked ${timeAgo(loop.lastCheckedAt)}` : "not checked yet"}
            </div>
          )}
          {loop && loop.state !== "ok" && <div className="mcp-msg">{loop.problems.map((p) => <div key={p}>{p}</div>)}</div>}
          {loop?.state === "ok" && loop.lastError && <div className="mcp-msg">Last check failed: {loop.lastError}</div>}
        </div>

        <div className="tabs auto-tabs" role="tablist" aria-label="Automation">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" id={`${ids}-tab-${t.id}`} aria-controls={`${ids}-pane`} aria-selected={tab === t.id}
              className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}{t.count ? <span className="auto-count">{t.count}</span> : null}
            </button>
          ))}
        </div>

        <div className="auto-pane" role="tabpanel" id={`${ids}-pane`} aria-labelledby={`${ids}-tab-${tab}`}>
          {tab === "settings" && (
            <>
              <div className="auto-field">
                <FieldHead label="Watch" help="Only items that show up after it's switched on count. Each one becomes a ticket. Checking is free; Claude only runs for tickets it makes." />
                <div className="auto-val">
                  <div className="auto-line">
                    <input className="auto-service" value={service} onChange={(e) => setService(e.target.value)} placeholder={svc} aria-label="What it checks" />
                    <span>every</span>
                    <Select<string> value={String(every)} ariaLabel="How often" options={everyOptions} onChange={(v) => setEvery(Number(v))} />
                  </div>
                </div>
              </div>

              <div className="auto-field">
                <FieldHead label="New tickets go to" id={`${ids}-col`}
                  help={COLUMNS.map((c) => `${COLUMN_LABEL[c]}: ${COLUMN_MEANING[c]}`).join(" ")} />
                <div className="auto-val">
                  <div className="auto-seg" role="radiogroup" aria-labelledby={`${ids}-col`}>
                    {COLUMNS.map((c) => (
                      <label key={c} className={column === c ? "on" : ""}>
                        <input type="radio" name={`${ids}-column`} checked={column === c} onChange={() => pickColumn(c)} />
                        <span>{COLUMN_LABEL[c]}</span>
                      </label>
                    ))}
                  </div>
                  {column !== "backlog" && (
                    <>
                      <label className={`auto-check${autoStart ? "" : " need"}`}>
                        <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
                        <span>Let Claude start by itself</span>
                      </label>
                      <div className="auto-hint">{autoStart
                        ? `Anyone who can write in ${svc} can start Claude here.`
                        : `Needed for ${COLUMN_LABEL[column]}. Without it, pick Backlog.`}</div>
                    </>
                  )}
                </div>
              </div>

              <div className="auto-field">
                <FieldHead label="Put it in" help={partOf
                  ? `Each new ticket becomes a task of that feature, in its Tasks tab, not its own card. ${autoStart && column !== "backlog"
                    ? "It starts right away."
                    : "It waits until you or the main ticket start it (pick Planning or Ready to start it right away)."} The main chat hears only when a task needs you, is blocked, failed or hit the usage limit. If the main ticket is in Done, each new task moves it back to Review.`
                  : "Each new ticket gets its own card on the board. Pick a feature to make them its tasks instead."} />
                <div className="auto-val auto-where">
                  <FeaturePicker tickets={tickets} value={partOf} onChange={setPartOf} maker="automation" ariaLabel="Where each new ticket goes" />
                </div>
              </div>

              <div className="auto-field">
                <FieldHead label="Each ticket" id={`${ids}-each`} help={askOn
                  ? "Claude looks at each new item first and decides whether it needs a ticket (a small cost per new item). Quiet checks cost nothing."
                  : `Free. ${"{{title}}"}, ${"{{link}}"} and ${"{{service}}"} are filled in, and the item's own text is added below, marked as copied from ${svc}.`} />
                <div className="auto-val">
                  <div className="auto-seg" role="radiogroup" aria-labelledby={`${ids}-each`}>
                    <label className={askOn ? "" : "on"}>
                      <input type="radio" name={`${ids}-ask`} checked={!askOn} onChange={() => setAskOn(false)} />
                      <span>Template</span>
                    </label>
                    <label className={askOn ? "on" : ""}>
                      <input type="radio" name={`${ids}-ask`} checked={askOn} onChange={() => setAskOn(true)} />
                      <span>Ask Claude first</span>
                    </label>
                  </div>
                  {askOn ? (
                    <textarea rows={4} value={askPrompt} onChange={(e) => setAskPrompt(e.target.value)} aria-label="What Claude should make tickets for"
                      placeholder="e.g. Skip questions and duplicates. Make a ticket for bugs, with the steps to reproduce." />
                  ) : (
                    <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} aria-label="Ticket text" />
                  )}
                </div>
              </div>
            </>
          )}

          {tab === "last" && loop && <LastCheck loop={loop} busy={busy} onCheck={checkNow} onOpenTicket={onOpenTicket} />}

          {tab === "how" && (
            <>
              {changed && <div className="mcp-msg auto-changed">The script file changed since it was saved. Read it below; Save runs this version from now on.</div>}
              <div className="auto-field">
                <FieldHead label="Connections" help="The services the script may call. Connect new ones in Connections." />
                <div className="auto-val">
                  <div className="auto-conns">
                    {usable.map((p) => (
                      <label key={p.id} className={`auto-conn${passIds.includes(p.id) ? " on" : ""}`}>
                        <input type="checkbox" checked={passIds.includes(p.id)} onChange={() => togglePass(p.id)} /> {p.name}
                        {p.status !== "connected" && <span className="badge blocked">needs connecting</span>}
                      </label>
                    ))}
                    {!usable.length && <span className="muted small">None yet.</span>}
                    <button type="button" className="link-btn" onClick={onOpenConnections}>Connections…</button>
                  </div>
                </div>
              </div>
              <div className="auto-field">
                <FieldHead label="Check script" htmlFor={`${ids}-script`} help={<>
                  It prints one JSON item per line: <code>{`{"id": "...", "title": "...", "text": "...", "link": "..."}`}</code>. Only id and title are required.
                  Give items about the same thing the same <code>thread</code> (for example the issue a comment is on): the first one makes a ticket, later ones go into that ticket.
                  It reaches a connection with <code>ckanban call &lt;name&gt; &lt;tool&gt; '&lt;json&gt;'</code>.
                </>} />
                <div className="auto-val">
                  <textarea id={`${ids}-script`} rows={9} className="mono auto-script" value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} />
                  <div className="auto-line">
                    <button type="button" className="btn" disabled={!!busy || !script.trim()}
                      onClick={() => act("test", async () => setTest(await api.testLoop(slug, script, passIds)))}>
                      {busy === "test" ? "Testing…" : "Test"}
                    </button>
                    {test && <span className={`small ${test.error ? "danger-text" : "muted"}`}>{test.error ? test.error : `Found ${test.found} item${test.found === 1 ? "" : "s"}`}</span>}
                  </div>
                  {test && test.items.length > 0 && <ul className="auto-found">{test.items.map((i) => <li key={i.id}>{i.title}</li>)}</ul>}
                  {test?.stderr.trim() && <details className="mcp-details"><summary>Error output</summary><pre>{test.stderr}</pre></details>}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="auto-foot">
        <span className={`auto-foot-note${err ? " err" : note ? "" : !busy && blocker ? " why" : saved ? " saved" : " idle"}`} role="status">{footNote}</span>
        {!phone && loop && otherBoards.length > 0 && (
          <Select<string> value="" ariaLabel="Copy to another board" options={otherBoards.map((b) => ({ value: b.slug, label: b.name }))}
            renderValue={() => "Copy to board…"} onChange={copyTo} />
        )}
        {!phone && loop && <button type="button" className="btn ghost danger" onClick={() => setConfirm(true)}>Delete</button>}
        <button type="submit" className="btn primary" disabled={!!busy || !!blocker} title={blocker ?? undefined}>
          {busy === "save" ? "Saving…" : changed ? "Save this version" : "Save"}
        </button>
      </div>
      {confirm && loop && <DeleteLoop slug={slug} loop={loop} onCancel={() => setConfirm(false)} onDeleted={onDeleted} />}
    </form>
  );
}

/** The Last check tab: Check now, new and skipped items, and the ones that were already there folded into one line. */
function LastCheck({ loop, busy, onCheck, onOpenTicket }: { loop: Loop; busy: string | null; onCheck: () => void; onOpenTicket: (id: string) => void }) {
  const { shown, first, seen } = groupLastItems(loop.lastItems);
  const canCheck = loop.state === "ok" && loop.enabled;
  return (
    <div className="auto-last">
      <div className="auto-lhead">
        <b>{loop.lastCheckedAt ? `Checked ${timeAgo(loop.lastCheckedAt)}` : "Not checked yet"}</b>
        <button type="button" className="btn" disabled={!!busy || !canCheck} onClick={onCheck}>{busy === "check" ? "Checking…" : "Check now"}</button>
      </div>
      {!loop.enabled && <div className="auto-hint">It's off, so it doesn't check. Switch it on and save first.</div>}
      {!loop.lastItems.length && canCheck && (
        <div className="auto-hint">{loop.lastCheckedAt ? "The last check found nothing." : "The first check notes what is already there; it makes no tickets."}</div>
      )}
      {shown.length > 0 && <ul className="auto-items">{shown.map((i) => <ItemRow key={i.id} item={i} onOpenTicket={onOpenTicket} />)}</ul>}
      {first.length > 0 && (
        <Folded items={first} text={first.length === 1 ? "was already there when it started, so it didn't become a ticket." : "were already there when it started, so they didn't become tickets."} />
      )}
      {seen.length > 0 && <Folded items={seen} text={seen.length === 1 ? "was already known from an earlier check, so it didn't become a new ticket." : "were already known from earlier checks, so they didn't become new tickets."} />}
      {loop.lastFound > loop.lastItems.length && <div className="auto-hint auto-more">and {loop.lastFound - loop.lastItems.length} more</div>}
    </div>
  );
}

function ItemRow({ item: i, onOpenTicket }: { item: SeenItem; onOpenTicket?: (id: string) => void }) {
  return (
    <li className="auto-li">
      {i.id.length <= 20 && <span className="auto-li-key" title={i.id}>{i.id}</span>}
      {i.link ? <a className="auto-li-title" href={i.link} target="_blank" rel="noreferrer" title={i.title}>{i.title}</a>
        : <span className="auto-li-title" title={i.title}>{i.title}</span>}
      {i.state === "new" && <span className="auto-tag">ticket made</span>}
      {i.state === "added" && <span className="auto-tag">added to its ticket</span>}
      {i.state === "waiting" && <span className="auto-tag skip">waiting</span>}
      {(i.state === "new" || i.state === "added" || i.state === "waiting") && i.ticketId && onOpenTicket && (
        <button type="button" className="link-btn" onClick={() => onOpenTicket(i.ticketId!)}>Open ticket</button>
      )}
      {i.state === "skipped" && <span className="auto-tag skip">Claude skipped: {i.note ?? "no ticket"}</span>}
      {(i.state === "new" || i.state === "added" || i.state === "waiting") && i.note && <span className="auto-tag skip">{i.note}</span>}
    </li>
  );
}

/** "11 were already there…" with Show items / Hide items. */
function Folded({ items, text }: { items: SeenItem[]; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="auto-fold">
        <span className="auto-fold-n">{items.length}</span>
        <span className="auto-fold-text">{text}</span>
        <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide items" : "Show items"}</button>
      </div>
      {open && <ul className="auto-items">{items.map((i) => <ItemRow key={i.id} item={i} />)}</ul>}
    </>
  );
}

/**
 * An automation this version can't run (saved by an older test version or a newer ckanban): only what is wrong, and
 * Switch off / Delete. It reads no other field, since an old file may not have them.
 */
function UnsupportedLoop({ slug, loop, phone, onBack, onSaved, onDeleted }: {
  slug: string; loop: Loop; phone: boolean; onBack: () => void; onSaved: () => Promise<void>; onDeleted: () => void | Promise<void>;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="auto-form">
      {phone && <PhoneBar title={loop.name} onBack={onBack} />}
      <div className="auto-scroll">
        <div className="auto-top">
          <div className="auto-title"><b className="auto-name static">{loop.name}</b></div>
          <div className="mcp-msg">{(loop.problems ?? []).map((p) => <div key={p}>{p}</div>)}</div>
        </div>
      </div>
      <div className="auto-foot">
        <span className={`auto-foot-note${err ? " err" : " idle"}`} role="status">{err}</span>
        {loop.enabled && (
          <button className="btn" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              await api.updateLoop(slug, loop.id, { enabled: false });
              await onSaved();
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}>Switch off</button>
        )}
        <button className="btn ghost danger" onClick={() => setConfirm(true)}>Delete</button>
      </div>
      {confirm && <DeleteLoop slug={slug} loop={loop} onCancel={() => setConfirm(false)} onDeleted={onDeleted} />}
    </div>
  );
}

function DeleteLoop({ slug, loop, onCancel, onDeleted }: { slug: string; loop: Loop; onCancel: () => void; onDeleted: () => void | Promise<void> }) {
  return (
    <ConfirmDialog title={`Delete ${loop.name}?`} confirmLabel="Delete" busyLabel="Deleting…" onCancel={onCancel}
      onConfirm={async () => {
        await api.deleteLoop(slug, loop.id);
        await onDeleted();
      }}>
      <p>It stops checking. Tickets it already made stay on the board.</p>
    </ConfirmDialog>
  );
}
