import { useEffect, useRef, useState } from "react";
import {
  api, type CronPreview, type Job, type ScheduleTrigger, type Outcome, type Profile, type Schedule, type ScheduleHistoryItem, type ScheduleInput, type Status,
  type Ticket, type TicketMode,
} from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { UpcomingJobs } from "./Jobs";
import { DescriptionEditor } from "./DescriptionEditor";
import { Modal } from "./Modal";
import { MenuSheet } from "./MenuSheet";
import { MoreIcon } from "./icons";
import { ModeToggle } from "./ModeToggle";
import { TagChip, TagEditor } from "./Tags";
import { boardTags } from "./tagText";
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
  quiet: "quiet setting", model: "model",
};

/** Models a schedule can pick; "" is the board's own. */
const MODELS: { value: string; label: string }[] = [
  { value: "", label: "Board's model" },
  { value: "sonnet", label: "Sonnet (cheaper, good for check-ins)" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku (cheapest)" },
];

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

  const row = (s: Schedule) => (
    <div key={s.id} className="sched-item">
      <div className="mcp-row">
        <div className="mcp-main">
          <div className="mcp-name">
            <span>{s.name}</span>
            {s.enabled ? <span className="badge ok">Active</span> : <span className="badge stopped">Paused</span>}
            {s.active && <span className="badge running"><span className="spinner" /> Running</span>}
            <span className="badge stopped">{s.mode === "auto" ? "Just do it" : "Interview first"}</span>
            {s.quiet && <span className="badge stopped" title="Checks that find nothing leave no ticket">Quiet</span>}
            {s.model && <span className="badge stopped">{s.model}</span>}
            {s.tags?.map((g) => <TagChip key={g} name={g} />)}
          </div>
          <div className="sched-when">
            {s.summary}
          </div>
          <div className="muted small">
            {s.enabled && s.nextRunAt ? <>Next: {when(s.nextRunAt)} ({timeUntil(s.nextRunAt)})</> : "Paused: won't run until resumed."}
            {s.lastFiredAt && <> · Last {s.quiet ? "check" : "ticket"} {timeAgo(s.lastFiredAt)}</>}
          </div>
          {(s.spend7dUsd !== undefined || s.quiet) && (
            <div className="muted small">
              {s.spend7dUsd !== undefined && <>Last 7 days: {usd(s.spend7dUsd)}</>}
              {s.quiet && <>{s.spend7dUsd !== undefined ? " · " : ""}Quiet checks today: {s.quietPerDay?.find((d) => d.day === today())?.count ?? 0}</>}
            </div>
          )}
          {s.lastError && <div className="mcp-msg">Last run failed to start: {s.lastError}</div>}
        </div>
        <div className="mcp-actions">
          <button className="btn small ghost" disabled={busy === `toggle:${s.id}`}
            onClick={() => act(`toggle:${s.id}`, () => api.updateSchedule(profile.slug, s.id, { enabled: !s.enabled }))}>
            {s.enabled ? "Pause" : "Resume"}
          </button>
          <button className="btn small" disabled={busy === `run:${s.id}`} onClick={() => runNow(s)}>
            {busy === `run:${s.id}` ? "Starting…" : "Run now"}
          </button>
          {phone ? (
            <button className="btn small ghost sched-more-btn" aria-label={`More for ${s.name}`} aria-haspopup="menu" onClick={() => setMenuOf(s)}>
              <MoreIcon size={20} />
            </button>
          ) : (
            <>
              <button className={`btn small ghost${historyOf === s.id ? " on" : ""}`} aria-pressed={historyOf === s.id}
                onClick={() => setHistoryOf((h) => (h === s.id ? null : s.id))}>History</button>
              <button className="btn small ghost" onClick={() => setEditing(s)}>Edit</button>
              <button className="btn small ghost danger" onClick={() => setConfirm(s)}>Delete</button>
            </>
          )}
        </div>
      </div>
      {editing !== "new" && editing?.id === s.id && (
        <ScheduleForm slug={profile.slug} initial={s} knownTags={boardTags(tickets)} onDone={() => setEditing(null)} />
      )}
      {historyOf === s.id && <History slug={profile.slug} schedule={s} tickets={tickets} onOpenTicket={onOpenTicket} />}
    </div>
  );

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
        {editing === "new" && <ScheduleForm slug={profile.slug} knownTags={boardTags(tickets)} onDone={() => setEditing(null)} />}
        {err && <div className="form-error">{err}</div>}
        {note && <div className="muted small">{note}</div>}
        {!schedules && <div className="muted">Loading…</div>}
        {schedules && !schedules.length && editing !== "new" && (
          <div className="muted">No schedules yet. Examples: a nightly dependency audit, a weekly changelog draft, a daily "fix failing CI".</div>
        )}
        {schedules && schedules.length > 0 && <div className="mcp-section">{schedules.map(row)}</div>}
        </>}
      </div>
      {menuOf && (
        <MenuSheet onClose={() => setMenuOf(null)}>
          <div className="auto-menu" role="menu" aria-label={menuOf.name}>
            <button type="button" role="menuitem" className="menu-item" onClick={() => { setHistoryOf((h) => (h === menuOf.id ? null : menuOf.id)); setMenuOf(null); }}>
              <span className="menu-label">{historyOf === menuOf.id ? "Hide history" : "History"}</span>
            </button>
            <button type="button" role="menuitem" className="menu-item" onClick={() => { setEditing(menuOf); setMenuOf(null); }}>
              <span className="menu-label">Edit</span>
            </button>
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
          </div>
        );
      })}
    </div>
  );
}

function ScheduleForm({ slug, initial, knownTags, onDone }: {
  slug: string; initial?: Schedule; knownTags: { name: string; count: number }[]; onDone: () => void;
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
    const input: ScheduleInput = { name: name.trim(), title: title.trim(), body, mode, cron: cron.trim(), skipIfRunning, tags, quiet, model: model || null };
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
