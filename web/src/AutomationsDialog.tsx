import { useEffect, useId, useState, type ReactNode } from "react";
import { api, type Loop, type LoopColumn, type LoopInput, type LoopTest, type Pass, type Profile } from "./api";
import { COLUMN_LABEL, COLUMN_MEANING, EVERY_CHOICES, everyLabel, groupLastItems, loopStatus, loopSubtitle, saveBlocker } from "./automations";
import { ConfirmDialog } from "./ConfirmDialog";
import { ChevronLeftIcon, ChevronRightIcon, MoreIcon } from "./icons";
import { MenuSheet } from "./MenuSheet";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { timeAgo } from "./time";
import { usePhone } from "./usePhone";

type Data = { passes: Pass[]; loops: Loop[] };
type Tab = "settings" | "last" | "how";
type SeenItem = Loop["lastItems"][number];

const NEW_SCRIPT = `# Prints the items to watch as JSON, one per line: {"id": "...", "title": "...", "text": "...", "link": "..."}
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
export function AutomationsDialog({ profile, boards, refreshKey, onClose, onOpenTicket, onOpenConnections }: {
  profile: Profile;
  /** Every board, for "Copy to board". */
  boards: Profile[];
  refreshKey: number;
  onClose: () => void;
  /** Opens a ticket of this board (the setup chat, a ticket an automation made). */
  onOpenTicket: (id: string) => void;
  onOpenConnections: () => void;
}) {
  const phone = usePhone();
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  /** Phone only: the picked automation's screen is showing (else the list). */
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [busy, setBusy] = useState(false);

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
                <LoopEditor key="new" slug={profile.slug} passes={data.passes} loop={null} phone={phone} onBack={back}
                  onOpenTicket={onOpenTicket} onOpenConnections={onOpenConnections}
                  onSaved={async (l) => { await reload(); setSelected(l.id); }} onDeleted={deleted} />
              )}
              {loop && loop.state === "unsupported" && (
                <UnsupportedLoop key={loop.id} slug={profile.slug} loop={loop} phone={phone} onBack={back}
                  onSaved={async () => { await reload(); }} onDeleted={deleted} />
              )}
              {loop && loop.state !== "unsupported" && (
                <LoopEditor key={loop.id} slug={profile.slug} passes={data.passes} loop={loop} otherBoards={boards.filter((b) => b.slug !== profile.slug)}
                  phone={phone} onBack={back} onOpenTicket={onOpenTicket} onOpenConnections={onOpenConnections}
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
function PhoneBar({ title, onBack, children }: { title: string; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="auto-phone-bar">
      <button type="button" className="icon-btn" onClick={onBack} aria-label="Back to the list"><ChevronLeftIcon size={20} /></button>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** The header chip for a saved automation: whether it works, in plain words. */
function statusChip(l: Loop): { label: string; tone: string } {
  const st = loopStatus(l);
  if (st.tone === "ok") return { label: "Working", tone: "ok" };
  if (st.label === "Waiting") return { label: "Last check failed", tone: "blocked" };
  return st;
}

function LoopEditor({ slug, passes, loop, otherBoards = [], phone, onBack, onSaved, onDeleted, onOpenTicket, onOpenConnections }: {
  slug: string;
  passes: Pass[];
  loop: Loop | null;
  otherBoards?: Profile[];
  phone: boolean;
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
  const changed = loop?.state === "script_changed";
  // A new one starts on its script; a changed script file opens that tab by itself.
  const [tab, setTab] = useState<Tab>(!loop || changed ? "how" : "settings");
  const [test, setTest] = useState<LoopTest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [menu, setMenu] = useState<null | "main" | "boards">(null);
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
  });

  const save = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (blocker) return;
    return act("save", async () => {
      const l = loop ? await api.updateLoop(slug, loop.id, input()) : await api.createLoop(slug, input());
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
  const footNote = err ?? note ?? (busy ? null : blocker) ?? "Changes apply after you save.";

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
            <div className="auto-chips">
              <span className={`auto-chip ${chip.tone}`}>● {chip.label}</span>
              <span className="auto-chip">{loop.lastCheckedAt ? `Checked ${timeAgo(loop.lastCheckedAt)}` : "Not checked yet"}</span>
              {loop.lastCheckedAt && <span className="auto-chip">Found {loop.lastFound} item{loop.lastFound === 1 ? "" : "s"}</span>}
              <span className="auto-chip">Free until something new shows up</span>
              {askOn && <span className="auto-chip">Then Claude looks at it</span>}
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
                <div className="auto-key">Watch</div>
                <div className="auto-val">
                  <div className="auto-line">
                    <input className="auto-service" value={service} onChange={(e) => setService(e.target.value)} placeholder={svc} aria-label="What it checks" />
                    <span>every</span>
                    <Select<string> value={String(every)} ariaLabel="How often" options={everyOptions} onChange={(v) => setEvery(Number(v))} />
                  </div>
                  <div className="auto-hint">Only items that show up after it's switched on. One ticket per item.</div>
                </div>
              </div>

              <div className="auto-field">
                <div className="auto-key" id={`${ids}-col`}>New tickets go to</div>
                <div className="auto-val" role="radiogroup" aria-labelledby={`${ids}-col`}>
                  {COLUMNS.map((c) => (
                    <label key={c} className={`auto-opt${column === c ? " on" : ""}`}>
                      <input type="radio" name={`${ids}-column`} checked={column === c} onChange={() => pickColumn(c)} />
                      <span><b>{COLUMN_LABEL[c]}</b><span className="auto-opt-sub">{COLUMN_MEANING[c]}</span></span>
                    </label>
                  ))}
                  {column !== "backlog" && (
                    <div className={`auto-warn${autoStart ? "" : " need"}`}>
                      <span>Text from {svc} will start Claude, which can change your files. Anyone who can write in {svc} can put text there.</span>
                      <label>
                        <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
                        <span>Let Claude start by itself (needed for {COLUMN_LABEL[column]}; without it, pick Backlog)</span>
                      </label>
                    </div>
                  )}
                </div>
              </div>

              <div className="auto-field">
                <div className="auto-key" id={`${ids}-each`}>Each ticket</div>
                <div className="auto-val">
                  <div className="auto-opt-pair" role="radiogroup" aria-labelledby={`${ids}-each`}>
                    <label className={`auto-opt${askOn ? "" : " on"}`}>
                      <input type="radio" name={`${ids}-ask`} checked={!askOn} onChange={() => setAskOn(false)} />
                      <span><b>Use a template</b><span className="auto-opt-sub">Free</span></span>
                    </label>
                    <label className={`auto-opt${askOn ? " on" : ""}`}>
                      <input type="radio" name={`${ids}-ask`} checked={askOn} onChange={() => setAskOn(true)} />
                      <span><b>Ask Claude first</b><span className="auto-opt-sub">Claude decides if it needs a ticket. Small cost per new item.</span></span>
                    </label>
                  </div>
                  {askOn ? (
                    <>
                      <textarea rows={4} value={askPrompt} onChange={(e) => setAskPrompt(e.target.value)} aria-label="What Claude should make tickets for"
                        placeholder="e.g. Skip questions and duplicates. Make a ticket for bugs, with the steps to reproduce." />
                      <div className="auto-hint">Claude looks at each new item and decides whether it needs a ticket. Quiet checks cost nothing.</div>
                    </>
                  ) : (
                    <>
                      <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} aria-label="Ticket text" />
                      <div className="auto-hint">
                        {"{{title}}"}, {"{{link}}"} and {"{{service}}"} are filled in. The item's own text is added below it, marked as copied from {svc}.
                      </div>
                    </>
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
                <div className="auto-key">Connections</div>
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
                <label className="auto-key" htmlFor={`${ids}-script`}>Check script</label>
                <div className="auto-val">
                  <textarea id={`${ids}-script`} rows={9} className="mono auto-script" value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} />
                  <div className="auto-hint">
                    It prints one JSON item per line: <code>{`{"id": "...", "title": "...", "text": "...", "link": "..."}`}</code>. Only id and title are required.
                    It reaches a connection with <code>ckanban call &lt;name&gt; &lt;tool&gt; '&lt;json&gt;'</code>.
                  </div>
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
        <span className={`auto-foot-note${err ? " err" : note ? "" : !busy && blocker ? " why" : " idle"}`} role="status">{footNote}</span>
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
      {i.state === "new" && i.ticketId && onOpenTicket && (
        <button type="button" className="link-btn" onClick={() => onOpenTicket(i.ticketId!)}>Open ticket</button>
      )}
      {i.state === "skipped" && <span className="auto-tag skip">Claude skipped: {i.note ?? "no ticket"}</span>}
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
