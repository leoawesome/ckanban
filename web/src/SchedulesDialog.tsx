import { useEffect, useRef, useState } from "react";
import {
  api, type CronPreview, type Job, type ScheduleTrigger, type Outcome, type Profile, type Schedule, type ScheduleHistoryItem, type ScheduleInput, type Status,
  type Ticket, type TicketMode,
} from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { UpcomingJobs } from "./Jobs";
import { DescriptionEditor } from "./DescriptionEditor";
import { FeaturePicker } from "./FeaturePicker";
import { Modal } from "./Modal";
import { MenuSheet } from "./MenuSheet";
import { MoreIcon } from "./icons";
import { ModeToggle } from "./ModeToggle";
import { TagChip, TagEditor } from "./Tags";
import { boardTags } from "./tagText";
import { scheduleGroup, type ScheduleGroup } from "./scheduleGroups";
import { timeAgo, timeUntil } from "./time";
import { useNow } from "./useNow";
import { usePhone } from "./usePhone";

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 09:00", cron: "0 9 * * *" },
  { label: "Weekdays 09:00", cron: "0 9 * * 1-5" },
  { label: "Weekly Mon 09:00", cron: "0 9 * * 1" },
];

const FIELD_LABEL: Record<string, string> = {
  name: "name", title: "ticket title", body: "prompt", mode: "mode", cron: "timing", enabled: "on/off", skipIfRunning: "skip setting", tags: "tags",
  quiet: "quiet setting", model: "model", partOf: "where runs go",
};

/** Models a schedule can pick; "" is the board's own. */
const MODELS: { value: string; label: string }[] = [
  { value: "", label: "Board's model" },
  { value: "sonnet", label: "Sonnet (cheaper, good for check-ins)" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku (cheapest)" },
];

/** Finished schedules shown before "Show N more". */
const FINISHED_SHOWN = 3;

const usd = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/** Local day key (YYYY-MM-DD), as the server counts quiet checks. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const ACTION_LABEL = { created: "Created", updated: "Edited", paused: "Paused", resumed: "Resumed" } as const;

const TRIGGER_LABEL: Record<ScheduleTrigger, string> = {
  schedule: "on schedule", missed: "missed run, caught up", manual: "run now",
};

export function when(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ticketBadge(t: { status: Status; outcome: Outcome; running?: boolean }) {
  if (t.status === "in_progress" || t.running) return <span className="badge running"><span className="spinner" /> Running</span>;
  if (t.status === "ready") return <span className="badge stopped">Queued</span>;
  switch (t.outcome) {
    case "failed": return <span className="badge failed">Failed</span>;
    case "blocked": return <span className="badge blocked">Blocked</span>;
    case "needs_input": return <span className="badge blocked">Needs your input</span>;
    case "stopped": return <span className="badge stopped">Stopped</span>;
  }
  if (t.status === "done") return <span className="badge ok">Done</span>;
  if (t.status === "review") return <span className="badge ok">Ready for review</span>;
  return <span className="badge stopped">{t.status}</span>;
}

/**
 * Upcoming one-time jobs (jobFilter: only those one ticket scheduled), then the board's recurring ticket templates:
 * each cron tick creates a ticket that runs right away.
 */
export function SchedulesDialog({ profile, schedules, jobs, jobFilter, onJobFilter, tickets, onOpenTicket, onClose }: {
  profile: Profile;
  schedules: Schedule[] | null;
  jobs: Job[] | null;
  jobFilter: string | null;
  onJobFilter: (ticketId: string | null) => void;
  tickets: Ticket[];
  onOpenTicket: (id: string) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Phone: the schedule whose "…" menu (History, Edit, Delete) is open. */
  const [menuOf, setMenuOf] = useState<Schedule | null>(null);
  /** The finished schedules "Delete all N" asks about. */
  const [confirmAll, setConfirmAll] = useState<Schedule[] | null>(null);
  const [showAllFinished, setShowAllFinished] = useState(false);
  const phone = usePhone();
  useNow();

  const act = async (key: string, fn: () => Promise<unknown>) => {
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

  const setUpCheckins = () => act("checkin", async () => {
    const t = await api.checkinSetup(profile.slug);
    onOpenTicket(t.id);
  });

  const runNow = (s: Schedule) => act(`run:${s.id}`, async () => {
    const { entry } = await api.runSchedule(profile.slug, s.id);
    if (entry.kind === "skipped") setNote(`${s.name}: skipped, the previous run is still going.`);
    else if (entry.kind === "error") setErr(`${s.name}: ${entry.message}`);
    else setNote(`${s.name}: ticket created and started.`);
  });

  const toggle = (s: Schedule) => act(`toggle:${s.id}`, () => api.updateSchedule(profile.slug, s.id, { enabled: !s.enabled }));

  /** The coloured line under the name: when it runs next, who paused it, or when it ran. */
  const stateLine = (s: Schedule, g: ScheduleGroup) => {
    if (g === "finished") return s.lastFiredAt ? <>Ran {when(s.lastFiredAt)}</> : <>Finished</>;
    if (g === "on") return s.nextRunAt ? <>Next run {when(s.nextRunAt)} ({timeUntil(s.nextRunAt)})</> : <>On, no next run found</>;
    if (!s.pausedAt) return <>Paused: won't run until you turn it on</>;
    const by = s.pausedBy;
    return (
      <>
        Paused {timeAgo(s.pausedAt)}
        {by === "user" && " by you"}
        {by && by !== "user" && (by.title
          ? <> by Claude in <button type="button" className="link-btn sched-by" onClick={() => onOpenTicket(by.ticketId)}>{by.title}</button></>
          : " by Claude in a ticket that was deleted")}
      </>
    );
  };

  /** Everything else, as one muted line of plain text. */
  const metaLine = (s: Schedule, g: ScheduleGroup) => {
    const parts: string[] = [s.summary];
    if (g !== "finished") {
      if (s.model) parts.push(s.model[0].toUpperCase() + s.model.slice(1));
      parts.push(s.mode === "auto" ? "Just do it" : "Interview first");
      if (s.partOf) parts.push(s.partOfTitle ? `in ${s.partOfTitle}` : "feature gone, so each run gets its own card");
      if (s.lastFiredAt) parts.push(`last ${s.quiet ? "check" : "ticket"} ${timeAgo(s.lastFiredAt)}`);
    }
    if (s.spend7dUsd) parts.push(`${usd(s.spend7dUsd)} last 7 days`);
    if (s.quiet && g !== "finished") parts.push(`quiet checks today: ${s.quietPerDay?.find((d) => d.day === today())?.count ?? 0}`);
    return parts.join(" · ");
  };

  const row = (s: Schedule) => {
    const g = scheduleGroup(s);
    const done = g === "finished";
    return (
      <div key={s.id} className={`sched-item sched-${g}`}>
        <div className="mcp-row sched-row">
          <span className={`sched-dot ${g}`} aria-hidden="true" />
          <div className="mcp-main">
            <div className="mcp-name">
              <span>{s.name}</span>
              {s.active && <span className="badge running"><span className="spinner" /> Running</span>}
              {s.tags?.map((t) => <TagChip key={t} name={t} />)}
            </div>
            <div className={`sched-state ${g}`}>{stateLine(s, g)}</div>
            <div className="muted small sched-meta">{metaLine(s, g)}</div>
            {s.lastError && <div className="mcp-msg">Last run failed to start: {s.lastError}</div>}
          </div>
          {!done && (
            <label className="sched-switch" title={s.enabled ? "On: click to pause" : "Paused: click to turn on"}>
              <input type="checkbox" role="switch" className="switch" checked={s.enabled} aria-checked={s.enabled}
                aria-label={`${s.enabled ? "Pause" : "Resume"} ${s.name}`} disabled={busy === `toggle:${s.id}`}
                onChange={() => toggle(s)} />
            </label>
          )}
          <div className="mcp-actions">
            {!done && (
              <button className="btn small" disabled={busy === `run:${s.id}`} onClick={() => runNow(s)}>
                {busy === `run:${s.id}` ? "Starting…" : "Run now"}
              </button>
            )}
            {phone ? (
              <button className="btn small ghost sched-more-btn" aria-label={`More for ${s.name}`} aria-haspopup="menu" onClick={() => setMenuOf(s)}>
                <MoreIcon size={20} />
              </button>
            ) : (
              <>
                <button className={`btn small ghost${historyOf === s.id ? " on" : ""}`} aria-pressed={historyOf === s.id}
                  onClick={() => setHistoryOf((h) => (h === s.id ? null : s.id))}>History</button>
                {!done && <button className="btn small ghost" onClick={() => setEditing(s)}>Edit</button>}
                <button className="btn small ghost danger" onClick={() => setConfirm(s)}>Delete</button>
              </>
            )}
          </div>
        </div>
        {editing !== "new" && editing?.id === s.id && (
          <ScheduleForm slug={profile.slug} initial={s} knownTags={boardTags(tickets)} tickets={tickets} onDone={() => setEditing(null)} />
        )}
        {historyOf === s.id && <History slug={profile.slug} schedule={s} tickets={tickets} onOpenTicket={onOpenTicket} />}
      </div>
    );
  };

  // On (soonest first), Paused, then Finished (latest run first).
  const groups: Record<ScheduleGroup, Schedule[]> = { on: [], paused: [], finished: [] };
  for (const s of schedules ?? []) groups[scheduleGroup(s)].push(s);
  groups.on.sort((a, b) => (a.nextRunAt ?? "~").localeCompare(b.nextRunAt ?? "~"));
  groups.finished.sort((a, b) => (b.lastFiredAt ?? "").localeCompare(a.lastFiredAt ?? ""));
  const shownFinished = showAllFinished ? groups.finished : groups.finished.slice(0, FINISHED_SHOWN);

  return (
    <Modal title={`Schedules · ${profile.name}`} onClose={onClose} wide>
      <div className="form mcp">
        <section className="sched-group">
          <h3 className="sched-heading">Upcoming</h3>
          <span className="muted small">Runs once, at the set time.</span>
          <UpcomingJobs slug={profile.slug} jobs={jobs} tickets={tickets} filter={jobFilter} onFilter={onJobFilter} onOpenTicket={onOpenTicket} />
        </section>
        {!jobFilter && <h3 className="sched-heading">Recurring</h3>}
        {!jobFilter && <>
        {schedules && schedules.length > 0 && (
          <div className="sched-summary">
            {groups.on.length > 0 && <span className="sched-pill on"><span className="sched-pill-dot" aria-hidden="true" />{groups.on.length} on</span>}
            {groups.paused.length > 0 && <span className="sched-pill paused"><span className="sched-pill-dot" aria-hidden="true" />{groups.paused.length} paused</span>}
            {groups.finished.length > 0 && <span className="sched-pill finished"><span className="sched-pill-dot" aria-hidden="true" />{groups.finished.length} finished</span>}
          </div>
        )}
        <div className="mcp-toolbar">
          <details className="muted small sched-intro">
            <summary>Each time one fires, a new ticket starts on this board.</summary>
            Claude starts it right away. Times are this computer's local time; runs happen only while ckanban is running (one missed
            run is caught up on start).
          </details>
          <div className="spacer" />
          <button className="btn small" disabled={busy === "checkin"} onClick={setUpCheckins}
            title="Claude checks every work hour what needs you and tells you only then. Set it up in a short chat.">
            {busy === "checkin" ? "Opening…" : "✦ Proactive check-ins"}
          </button>
          <button className="btn small primary" onClick={() => setEditing((e) => (e === "new" ? null : "new"))}>
            {editing === "new" ? "Close form" : "New schedule"}
          </button>
        </div>
        {editing === "new" && <ScheduleForm slug={profile.slug} knownTags={boardTags(tickets)} tickets={tickets} onDone={() => setEditing(null)} />}
        {err && <div className="form-error">{err}</div>}
        {note && <div className="muted small">{note}</div>}
        {!schedules && <div className="muted">Loading…</div>}
        {schedules && !schedules.length && editing !== "new" && (
          <div className="muted">No schedules yet. Examples: a nightly dependency audit, a weekly changelog draft, a daily "fix failing CI".</div>
        )}
        {schedules && schedules.length > 0 && (
          <div className="mcp-section sched-sections">
            {groups.on.length > 0 && (
              <section aria-labelledby="sched-on">
                <h4 id="sched-on" className="sched-sec-head">On <span className="sched-sec-n">{groups.on.length}</span></h4>
                {groups.on.map(row)}
              </section>
            )}
            {groups.paused.length > 0 && (
              <section aria-labelledby="sched-paused">
                <h4 id="sched-paused" className="sched-sec-head">Paused <span className="sched-sec-n">{groups.paused.length}</span></h4>
                {groups.paused.map(row)}
              </section>
            )}
            {groups.finished.length > 0 && (
              <section aria-labelledby="sched-finished">
                <h4 id="sched-finished" className="sched-sec-head">
                  Finished <span className="sched-sec-n">{groups.finished.length}</span>
                  <button type="button" className="btn small ghost danger sched-del-all" onClick={() => setConfirmAll(groups.finished)}>
                    Delete all {groups.finished.length}
                  </button>
                </h4>
                <div className="muted small sched-hint">Set for one date. They already ran and would only run again next year.</div>
                {shownFinished.map(row)}
                {groups.finished.length > shownFinished.length && (
                  <button type="button" className="link-btn sched-more-done" onClick={() => setShowAllFinished(true)}>
                    Show {groups.finished.length - shownFinished.length} more
                  </button>
                )}
              </section>
            )}
          </div>
        )}
        </>}
      </div>
      {menuOf && (
        <MenuSheet onClose={() => setMenuOf(null)}>
          <div className="auto-menu" role="menu" aria-label={menuOf.name}>
            <button type="button" role="menuitem" className="menu-item" onClick={() => { setHistoryOf((h) => (h === menuOf.id ? null : menuOf.id)); setMenuOf(null); }}>
              <span className="menu-label">{historyOf === menuOf.id ? "Hide history" : "History"}</span>
            </button>
            {scheduleGroup(menuOf) !== "finished" && (
              <button type="button" role="menuitem" className="menu-item" onClick={() => { setEditing(menuOf); setMenuOf(null); }}>
                <span className="menu-label">Edit</span>
              </button>
            )}
            <button type="button" role="menuitem" className="menu-item danger" onClick={() => { setConfirm(menuOf); setMenuOf(null); }}>
              <span className="menu-label">Delete</span>
            </button>
          </div>
        </MenuSheet>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Delete ${confirm.name}?`}
          confirmLabel="Delete"
          busyLabel="Deleting…"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await api.deleteSchedule(profile.slug, confirm.id);
            if (historyOf === confirm.id) setHistoryOf(null);
            setConfirm(null);
          }}
        >
          <p>No more tickets will be created from it. Tickets it already created stay on the board.</p>
        </ConfirmDialog>
      )}
      {confirmAll && (
        <ConfirmDialog
          title={`Delete ${confirmAll.length} finished schedule${confirmAll.length === 1 ? "" : "s"}?`}
          confirmLabel={`Delete all ${confirmAll.length}`}
          busyLabel="Deleting…"
          onCancel={() => setConfirmAll(null)}
          onConfirm={async () => {
            for (const s of confirmAll) {
              await api.deleteSchedule(profile.slug, s.id);
              if (historyOf === s.id) setHistoryOf(null);
            }
            setConfirmAll(null);
          }}
        >
          <p>They already ran on their one date. Tickets they created stay on the board.</p>
          <ul className="sched-del-list">{confirmAll.map((s) => <li key={s.id}>{s.name}</li>)}</ul>
        </ConfirmDialog>
      )}
    </Modal>
  );
}

function History({ slug, schedule, tickets, onOpenTicket }: {
  slug: string;
  schedule: Schedule;
  tickets: Ticket[];
  onOpenTicket: (id: string) => void;
}) {
  const [items, setItems] = useState<ScheduleHistoryItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Refetch whenever the schedule fires or changes (its updatedAt / lastFiredAt / lastError move).
  useEffect(() => {
    api.scheduleHistory(slug, schedule.id).then(setItems).catch((e) => setErr(e.message));
  }, [slug, schedule.id, schedule.lastFiredAt, schedule.lastError, schedule.updatedAt]);

  if (err) return <div className="form-error sched-history">{err}</div>;
  if (!items) return <div className="muted small sched-history">Loading…</div>;
  if (!items.length) return <div className="muted small sched-history">Not run yet.</div>;
  return (
    <div className="sched-history">
      {items.map((e, i) => {
        // Live status from the board when the ticket is loaded there.
        const live = e.ticket ? tickets.find((t) => t.id === e.ticket!.id) : undefined;
        const t = live ? { ...e.ticket!, status: live.status, outcome: live.outcome, running: live.running } : e.ticket;
        return (
          <div key={i} className="sched-entry">
            <span className="sched-at" title={new Date(e.at).toLocaleString()}>{when(e.at)}</span>
            {(e.kind === "fired" || e.kind === "skipped" || e.kind === "error") && <span className="muted small">{TRIGGER_LABEL[e.trigger]}</span>}
            {e.kind === "quiet" && (
              <>
                <span className="badge stopped">Checked, nothing new</span>
                <span className="muted small" title={e.summary}>{e.summary}</span>
              </>
            )}
            {e.kind === "edited" && (
              <span className="sched-edit">
                <span className="badge stopped">{ACTION_LABEL[e.action]}{e.action === "updated" && e.fields.length ? `: ${e.fields.map((f) => FIELD_LABEL[f] ?? f).join(", ")}` : ""}</span>
                <span className="muted small">by</span>
                {e.by === "user"
                  ? <span className="muted small">you</span>
                  : t
                  ? <button className="link-btn sched-ticket" onClick={() => onOpenTicket(t.id)} title={`Claude in ${t.title}`}>Claude in {t.title}</button>
                  : <span className="muted small">Claude in {e.by.ticketId} (deleted)</span>}
                {e.previous && Object.keys(e.previous).length > 0 && (
                  <details className="sched-prev">
                    <summary className="link-btn small">Previous</summary>
                    {Object.entries(e.previous).map(([k, v]) => (
                      <div key={k}><span className="muted small">{FIELD_LABEL[k] ?? k}</span><pre>{v}</pre></div>
                    ))}
                  </details>
                )}
              </span>
            )}
            {e.kind === "error" && <span className="mcp-msg">Could not create the ticket: {e.message}</span>}
            {e.kind === "skipped" && <span className="badge stopped">Skipped (previous still running)</span>}
            {e.kind === "fired" && (t
              ? <>
                  <button className="link-btn sched-ticket" onClick={() => onOpenTicket(t.id)} title={t.title}>{t.title}</button>
                  {ticketBadge(t)}
                </>
              : <span className="muted small">ticket deleted</span>)}
            {e.kind === "fired" && e.note && <span className="muted small">{e.note}</span>}
          </div>
        );
      })}
    </div>
  );
}

function ScheduleForm({ slug, initial, knownTags, tickets, onDone }: {
  slug: string; initial?: Schedule; knownTags: { name: string; count: number }[]; tickets: Ticket[]; onDone: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<TicketMode>(initial?.mode ?? "auto");
  const [cron, setCron] = useState(initial?.cron ?? CRON_PRESETS[1].cron);
  const [custom, setCustom] = useState(() => !!initial && !CRON_PRESETS.some((p) => p.cron === initial.cron));
  const [skipIfRunning, setSkipIfRunning] = useState(initial?.skipIfRunning ?? true);
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [quiet, setQuiet] = useState(initial?.quiet ?? false);
  const [model, setModel] = useState(initial?.model ?? "");
  const [partOf, setPartOf] = useState(initial?.partOf ?? "");
  const [preview, setPreview] = useState<CronPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const expr = cron.trim();
    if (!expr) {
      setPreview({ valid: false, error: "cron expression is required", summary: null, next: [] });
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api.cronPreview(expr).then((p) => live && setPreview(p)).catch(() => {});
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [cron]);

  const preset = custom ? null : CRON_PRESETS.find((p) => p.cron === cron.trim()) ?? null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input: ScheduleInput = { name: name.trim(), title: title.trim(), body, mode, cron: cron.trim(), skipIfRunning, tags, quiet, model: model || null, partOf: partOf || null };
    setBusy(true);
    setErr(null);
    try {
      if (initial) await api.updateSchedule(slug, initial.id, input);
      else await api.createSchedule(slug, input);
      onDone();
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <form className="mcp-add" onSubmit={submit}>
      <div className="row two">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly dependency audit" autoFocus />
        </label>
        <label>
          Ticket title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Dependency audit {date}" />
        </label>
      </div>
      <span className="muted small field-help-tight"><code>{"{date}"}</code> and <code>{"{time}"}</code> in the title become the run's date and time.</span>
      <label>
        Prompt
        <DescriptionEditor slug={slug} value={body} setValue={setBody} inputRef={bodyRef} rows={5}
          placeholder="What Claude should do each time: context, steps, what done looks like." />
      </label>
      <div className="field">
        <div className="field-label">When</div>
        <div className="segmented sched-presets" role="radiogroup" aria-label="Schedule preset">
          {CRON_PRESETS.map((p) => (
            <button key={p.cron} type="button" role="radio" aria-checked={preset?.cron === p.cron} className={preset?.cron === p.cron ? "on" : ""}
              onClick={() => { setCron(p.cron); setCustom(false); }}>
              {p.label}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={!preset} className={!preset ? "on" : ""} onClick={() => setCustom(true)}>Custom</button>
        </div>
        <input className="mono" value={cron} onChange={(e) => { setCron(e.target.value); setCustom(false); }}
          placeholder="min hour day-of-month month day-of-week" aria-label="Cron expression" spellCheck={false} />
        {preview && (preview.valid
          ? <span className="muted small">{preview.summary}. Next: {preview.next.map(when).join(" · ")}</span>
          : <span className="form-error">{preview.error}</span>)}
      </div>
      <div className="field">
        <ModeToggle value={mode} onChange={setMode} />
        <span className="muted small">
          {mode === "auto"
            ? "Claude works on its own and reports back when done."
            : "Claude asks clarifying questions first; the ticket waits for your answers in the Inbox."}
        </span>
      </div>
      <div className="field">
        <div className="field-label">Tags</div>
        <TagEditor tags={tags} known={knownTags} onChange={setTags} disabled={busy} />
        <span className="muted small">Every ticket this schedule creates gets these tags, so you can filter them on the board.</span>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
        Quiet when nothing needs me: a run that finds nothing leaves no ticket, only a line in History
      </label>
      <label>
        Model
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          {model && !MODELS.some((m) => m.value === model) && <option value={model}>{model}</option>}
        </select>
      </label>
      <label>
        Where each run goes
        <FeaturePicker tickets={tickets} value={partOf} onChange={setPartOf} maker="schedule" />
      </label>
      {partOf && (
        <span className="muted small field-help-tight">
          Each run shows in that feature's Tasks tab instead of on the board. It tells the feature's main chat only when it needs you, is blocked, failed or hit the usage limit. If the main ticket is in Done, each run moves it back to Review so you see that something ran.
        </span>
      )}
      <label className="check-row">
        <input type="checkbox" checked={skipIfRunning} onChange={(e) => setSkipIfRunning(e.target.checked)} />
        Skip a run while the previous one is still queued or running
      </label>
      {err && <div className="form-error">{err}</div>}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !name.trim() || !title.trim() || preview?.valid === false}>
          {busy ? "Saving…" : initial ? "Save" : "Create schedule"}
        </button>
      </div>
    </form>
  );
}
