import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type ChannelState, type NotifyKind, type NotifyPatch, type NotifyState } from "./api";
import { helperApi, setHelperStatus, spendLine, useHelper, type FeedbackLine } from "./helper";
import { HelperStatusLine, PracticeAlert } from "./Messages";
import { PhoneBar } from "./AutomationsDialog";
import { ChevronRightIcon } from "./icons";
import { Modal } from "./Modal";
import { PUSH_CHANGED } from "./push";
import { PushSection } from "./PushSection";
import { Select } from "./Select";
import { timeAgo } from "./time";
import { toast } from "./toast";
import { usePhone } from "./usePhone";

const KINDS: { kind: NotifyKind; label: string }[] = [
  { kind: "questions", label: "Questions for you" },
  { kind: "proposal", label: "Proposal to review" },
  { kind: "review", label: "Ready for review" },
  { kind: "failed", label: "Run failed" },
  { kind: "stalled", label: "Run stalled (no output)" },
  { kind: "limit", label: "Usage limit hit" },
  { kind: "blocked", label: "Blocked / plan stuck" },
  { kind: "huddle", label: "Huddle asks you" },
  { kind: "reply", label: "Claude replied in Planning" },
  { kind: "message", label: "Messages from Claude" },
];

/** A fresh, hard-to-guess ntfy topic address. */
function randomTopic(): string {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `https://ntfy.sh/ckanban-${[...bytes].map((b) => abc[b % abc.length]).join("")}`;
}

/** A plain on/off switch (a checkbox styled as a switch). */
function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return <input type="checkbox" role="switch" className="switch" aria-label={label} checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
}

/** One channel row: a dot (green when it can reach you), its name, one plain line and the switch; setup below when open. */
/** What Telegram gets: summaries and other routine messages skip it (helper/channels.ts telegramTakes). */
const TELEGRAM_URGENT_ONLY = "Telegram gets only urgent alerts and their reminders.";

function ChannelRow({ ch, title, detail, onToggle, children }: {
  ch: ChannelState | undefined; title: string; detail?: string; onToggle: (on: boolean) => void; children?: ReactNode;
}) {
  if (!ch) return null;
  return (
    <div className="ch-row">
      <div className="ch-head">
        <span className={`ch-dot${ch.on && ch.ready ? " on" : ch.on ? " half" : ""}`} aria-hidden />
        <div className="grow">
          <div className="ch-ttl">{title}</div>
          <div className="muted small">{detail ?? ch.detail}</div>
        </div>
        <Switch on={ch.on} label={title} onChange={onToggle} />
      </div>
      {children && <div className="ch-body">{children}</div>}
    </div>
  );
}

/**
 * Header menu → Notifications: a list on the left (desktop) or its own screen (phone) of the helper, the channels it
 * reaches you on (This Mac, phone push, ntfy, Telegram; a JSON web address under More), my night with Focus mode, what
 * the helper knows about you, and More (its model, message format, kinds). Picking one shows its settings on the right
 * (desktop) or on a screen with a back arrow (phone), like the Automations window. Every switch saves at once.
 */
export function NotificationsDialog({ profile, onClose }: { profile: string | null; onClose: () => void }) {
  const [state, setState] = useState<NotifyState | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const { status } = useHelper();
  const phone = usePhone();
  /** The setting shown on the right (desktop) or on its own screen (phone, while phoneOpen). */
  const [pane, setPane] = useState<Pane>("helper");
  const [phoneOpen, setPhoneOpen] = useState(false);

  useEffect(() => {
    api.notify().then((s) => { setState(s); setUrl(s.webhookUrl); }).catch((e) => setError(e.message));
    // Turning this device on or off decides whether the macOS banner is used.
    const refresh = () => void api.notify().then((s) => setState((cur) => (cur ? { ...cur, ...s, webhookUrl: cur.webhookUrl } : s))).catch(() => {});
    window.addEventListener(PUSH_CHANGED, refresh);
    return () => window.removeEventListener(PUSH_CHANGED, refresh);
  }, []);

  const save = async (patch: NotifyPatch) => {
    setError(null);
    try {
      const next = await api.setNotify(patch);
      setState(next);
      if ("helper" in patch || "push" in patch || "webhookOn" in patch || "mac" in patch || patch.telegram) {
        void helperApi.status().then(setHelperStatus, () => {});
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const saveUrl = async (next = url) => {
    if (!state || next.trim() === state.webhookUrl) return true;
    setBusy("save");
    const ok = await save({ webhookUrl: next, ...(next.trim() && !state.webhookOn ? { webhookOn: true } : {}) });
    setBusy(null);
    return ok;
  };

  const test = async () => {
    if (!(await saveUrl())) return;
    setBusy("test");
    try {
      const r = await api.testNotify(profile);
      setState(r.state);
      if (r.error) setError(r.error);
      else toast("Test message sent to every channel that's on", { tone: "ok" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const ch = (name: ChannelState["name"]) => state?.channels?.find((c) => c.name === name);
  const json = state?.format === "json" || (state?.format === "auto" && !!url && !/ntfy/i.test(url));
  const chItem = (name: ChannelState["name"], title: string, id: Pane = name as Pane): PaneItem | null => {
    const c = ch(name);
    if (!c) return null;
    return { id, title, sub: c.on ? c.detail : "Off", tone: c.on && c.ready ? "ok" : c.on ? "blocked" : "" };
  };
  const items: PaneItem[] = state ? [
    { id: "helper", title: "Helper", sub: state.helper ? "On: groups routine waits, interrupts only when urgent" : "Off", tone: state.helper ? "ok" : "" },
    chItem("mac", "This Mac"),
    chItem("push", "Phone push"),
    chItem("webhook", json ? "Web address" : "ntfy", "ntfy"),
    chItem("telegram", "Telegram"),
    { id: "night", title: "My night", sub: status ? `Quiet ${status.night.start} to ${status.night.end} · Focus mode` : "Quiet hours and Focus mode", tone: "none" },
    { id: "knows", title: "What the helper knows", sub: "Lasting preferences it always follows", tone: "none" },
    { id: "more", title: "More", sub: "Model, message format, what to notify about", tone: "none" },
  ].filter((x): x is PaneItem => !!x) : [];
  const cur = items.find((i) => i.id === pane) ?? items[0];
  const open = (id: Pane) => { setPane(id); setPhoneOpen(true); };
  const detail = phone && phoneOpen && !!cur;

  const body = state && cur && (() => {
    switch (cur.id) {
      case "helper":
        return (
          <section className="hs-card">
            <div className="ch-head">
              <div className="grow">
                <div className="ch-ttl big">Helper</div>
                <div className="muted small">Groups routine waits into summaries. Interrupts you and keeps reminding only when something is urgent.</div>
              </div>
              <Switch on={state.helper} label="Helper" onChange={(on) => void save({ helper: on })} />
            </div>
            <HelperStatusLine status={status} reach={false} />
            <div className="hs-warn small">Alerts need this Mac on and awake. A closed lid means no alerts.</div>
            {status?.on && (
              <div className="ch-head hs-sep hs-stack">
                <div className="grow">
                  <div className="ch-ttl">See what an urgent alert looks like</div>
                  <div className="muted small">Sends a pretend alert now and one reminder a minute later, like a real one. Tap Got it to stop it.</div>
                </div>
                <PracticeAlert compact />
              </div>
            )}
          </section>
        );
      case "mac":
        return <section className="hs-card ch-list"><ChannelRow ch={ch("mac")} title="This Mac" onToggle={(on) => void save({ mac: on })} /></section>;
      case "push":
        return (
          <section className="hs-card ch-list">
            <ChannelRow ch={ch("push")} title="Phone push" onToggle={(on) => void save({ push: on })}>
              {state.push && <PushSection profile={profile} />}
            </ChannelRow>
          </section>
        );
      case "ntfy":
        return (
          <section className="hs-card ch-list">
            <ChannelRow ch={ch("webhook")} title={json ? "Web address" : "ntfy"} detail={json ? undefined : ch("webhook")?.ready ? ch("webhook")?.detail : "A free phone app. It shows the full message."}
              onToggle={(on) => void (on && !url ? (setUrl(state.ntfyTopicSuggestion), save({ webhookUrl: state.ntfyTopicSuggestion, webhookOn: true })) : save({ webhookOn: on }))}>
              {state.webhookOn && (
                <>
                  <div className="small">{json ? "Messages go to this address:" : "Install the ntfy app and subscribe to this topic:"}</div>
                  <div className="hs-inline">
                    <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => void saveUrl()}
                      placeholder="https://ntfy.sh/your-secret-topic" spellCheck={false} autoComplete="off" aria-label="ntfy topic address" />
                    {!json && <button type="button" className="btn small" onClick={() => { const t = randomTopic(); setUrl(t); void saveUrl(t); }}>New topic</button>}
                    <button type="button" className="btn small" disabled={!!busy || !url.trim()} onClick={() => void test()}>{busy === "test" ? "Sending…" : "Send test"}</button>
                  </div>
                  {!json && !state.webhookUrl && (
                    <div className="hs-suggest small">
                      <span>A random topic for you:</span> <code>{state.ntfyTopicSuggestion}</code>
                      <button type="button" className="btn small primary" onClick={() => { setUrl(state.ntfyTopicSuggestion); void saveUrl(state.ntfyTopicSuggestion); }}>Use it</button>
                    </div>
                  )}
                  {!json && <div className="hs-warn small">{state.ntfyWarning}</div>}
                </>
              )}
            </ChannelRow>
          </section>
        );
      case "telegram":
        return (
          <section className="hs-card ch-list">
            <ChannelRow ch={ch("telegram")} title="Telegram" detail={`${TELEGRAM_URGENT_ONLY} ${state.telegram.paired ? ch("telegram")?.detail ?? "" : "Alerts come with Got it and Not urgent buttons. Reply to an alert to answer that ticket."}`.trim()}
              onToggle={(on) => void save({ telegram: { on } })}>
              {state.telegram.on && <TelegramSetup state={state} profile={profile} onState={setState} onError={setError} />}
              {state.telegram.on && (
                <div className="small muted">
                  Messages pass through Telegram's servers, and bot chats aren't end-to-end encrypted: Telegram can read them. Leave Telegram off if your tickets hold private things.
                </div>
              )}
            </ChannelRow>
          </section>
        );
      case "night":
        return (
          <>
            <NightSection />
            <section className="hs-card">
              <div className="ch-ttl">Focus mode</div>
              <div className="muted small">{state.focusHint}</div>
            </section>
          </>
        );
      case "knows":
        return <KnowsSection />;
      case "more":
        return (
          <section className="hs-card hs-more">
            <ModelRow />
            <div className="ch-head hs-more-row hs-stack">
              <div className="grow">
                <div className="ch-ttl">Send to a web address as JSON</div>
                <div className="muted small">For your own tools: the web address (under ntfy) gets each message as JSON instead of ntfy text.</div>
              </div>
              <Select ariaLabel="Message format" value={state.format} onChange={(format) => void save({ format })}
                options={[
                  { value: "auto", label: "Pick by address", hint: "ntfy when the address has “ntfy” in it" },
                  { value: "ntfy", label: "ntfy" },
                  { value: "json", label: "JSON" },
                ]} />
            </div>
            <div className="form-section"><span>{state.helper ? "Things the helper may tell you about" : "Notify me about"}</span></div>
            <div className="notify-kinds">
              {KINDS.map(({ kind, label }) => (
                <label key={kind} className="board-switch">
                  <input type="checkbox" checked={state.kinds[kind]} onChange={(e) => void save({ kinds: { [kind]: e.target.checked } })} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <span className="muted small">
              Links open the message on your phone when Phone access is on, else on this Mac.
              {state.lastSentAt && <> Last sent {timeAgo(state.lastSentAt)}.</>}
            </span>
          </section>
        );
    }
  })();

  const testButton = (
    <button type="button" className="btn" disabled={!state || !!busy} onClick={() => void test()}>{busy === "test" ? "Sending…" : "Send test message"}</button>
  );
  const errorLine = error && <div className="form-error notify-err" role="alert">{error}</div>;

  return (
    <Modal title={detail ? cur.title : "Notifications"} onClose={onClose} focusDialog wide className="auto-modal notify-modal" bare={detail}>
      {!state && !error && <div className="muted auto-msg"><span className="spinner" /> Loading…</div>}
      {!state && error && <div className="form-error auto-msg" role="alert">{error}</div>}
      {state && (
        <form className="auto-wrap helper-settings" onSubmit={(e) => { e.preventDefault(); void saveUrl(); }}>
          {!detail && (
            <div className="auto-side">
              {state.reachLine && <div className="helper-status warn notify-reach"><i aria-hidden /><span>{state.reachLine}. Turn on a phone channel.</span></div>}
              <div className="auto-list" role="list" aria-label="Notification settings">
                {items.map((it) => (
                  <button key={it.id} type="button" role="listitem" className={`auto-item${!phone && cur?.id === it.id ? " sel" : ""}`}
                    aria-current={!phone && cur?.id === it.id ? "true" : undefined} onClick={() => open(it.id)}>
                    {it.tone !== "none" && <span className={`auto-dot ${it.tone}`} aria-hidden />}
                    <span className="auto-item-main">
                      <span className="auto-item-name">{it.title}</span>
                      <span className="auto-item-sub">{it.sub}</span>
                    </span>
                    {phone && <ChevronRightIcon size={16} className="auto-chev" />}
                  </button>
                ))}
              </div>
              {phone && (
                <div className="auto-side-actions">
                  {errorLine}
                  {testButton}
                </div>
              )}
            </div>
          )}
          {(!phone || detail) && cur && (
            <div className="auto-main">
              {phone && <PhoneBar title={cur.title} onBack={() => setPhoneOpen(false)} />}
              <div className="auto-pane notify-pane form">
                {phone && errorLine}
                {body}
              </div>
              {!phone && (
                <div className="auto-foot">
                  <span className="auto-foot-note err">{error}</span>
                  {testButton}
                  <button type="button" className="btn primary" disabled={busy === "save"} onClick={async () => { if (await saveUrl()) onClose(); }}>Done</button>
                </div>
              )}
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}

type Pane = "helper" | "mac" | "push" | "ntfy" | "telegram" | "night" | "knows" | "more";
/** One row in the Notifications list: tone "none" = no dot (a settings page, not a channel). */
type PaneItem = { id: Pane; title: string; sub: string; tone: "ok" | "blocked" | "" | "none" };

/** Telegram: BotFather steps, the bot key, then the 6-digit pairing code the user sends to the bot. */
function TelegramSetup({ state, profile, onState, onError }: { state: NotifyState; profile: string | null; onState: (s: NotifyState) => void; onError: (e: string | null) => void }) {
  const t = state.telegram;
  // Phone access: turning messages back on and pairing are for this Mac only (the server refuses them too).
  const mac = state.local !== false;
  const [token, setToken] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState(String(t.deskCapUsd));
  useEffect(() => setCap(String(t.deskCapUsd)), [t.deskCapUsd]);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  // While a code is shown, look every 3 s whether the bot got it.
  useEffect(() => {
    if (!code) return;
    poll.current = setInterval(() => {
      void api.notify().then((s) => {
        onState(s);
        if (s.telegram.paired) {
          setCode(null);
          toast(`Paired with ${s.telegram.chatName ?? "your Telegram"}`, { tone: "ok" });
        } else if (!s.telegram.pairing) setCode(null);
      }, () => {});
    }, 3000);
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [code]);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveToken = () => run(async () => {
    const s = await api.setNotify({ telegram: { token: token.trim(), on: true } });
    setToken("");
    onState(s);
    const r = await api.telegramPair(profile);
    onState(r.state);
    setCode(r.code);
  });
  const pair = () => run(async () => {
    const r = await api.telegramPair(profile);
    onState(r.state);
    setCode(r.code);
  });
  const unpair = () => run(async () => onState(await api.telegramUnpair()));
  const forget = () => run(async () => {
    setCode(null);
    onState(await api.setNotify({ telegram: { token: "" } }));
  });

  if (t.paired && t.tokenSet) {
    const setTaking = (on: boolean) => run(async () => onState(await api.setNotify({ telegram: { takeMessages: on } })));
    return (
      <div className="tg-setup tg-paired">
        <div className="ch-head tg-row">
          <div className="grow">
            <div className="small">Paired with <b>{t.chatName ?? "your chat"}</b>{t.botName ? <> through {t.botName}</> : null}</div>
            <div className="muted small">Messages from this chat can answer tickets and start work.</div>
          </div>
          <span className={`tg-state small${t.takeMessages ? " ok" : ""}`}>{t.takeMessages ? "On" : t.lockedAt ? "Locked" : "Paused"}</span>
        </div>
        {t.error && <div className="form-error small">{t.error}</div>}
        <div className="ch-head tg-row">
          <div className="grow">
            <div className="small">Take messages from Telegram</div>
            <div className="muted small">
              {t.lockedAt && !t.takeMessages
                ? <>Locked from Telegram {timeAgo(t.lockedAt)}. Alerts still arrive. {mac ? "Turn it on to take messages again." : "Turn this back on from the Mac."}</>
                : !t.takeMessages && !mac ? "Off: alerts still arrive, but your messages are ignored. Turn this back on from the Mac."
                : "Off: alerts still arrive, but your messages are ignored."}
            </div>
          </div>
          <Switch on={t.takeMessages} label="Take messages from Telegram" disabled={busy || (!mac && !t.takeMessages)} onChange={(on) => void setTaking(on)} />
        </div>
        <div className="ch-head tg-row">
          <div className="grow">
            <div className="small">Ask before sending typed answers</div>
            <div className="muted small">Shows Send / Cancel before a typed reply goes to a ticket.</div>
          </div>
          <Switch on={t.askTyped} label="Ask before sending typed answers" disabled={busy}
            onChange={(on) => void run(async () => onState(await api.setNotify({ telegram: { askTyped: on } })))} />
        </div>
        <div className="ch-head tg-row">
          <div className="grow">
            <div className="small">Front desk limit a day</div>
            <div className="muted small">
              Spent today ${t.deskSpentToday.toFixed(2)}. Past the limit it pauses until tomorrow and says so; alerts still come.
            </div>
          </div>
          <label className="tg-cap">
            $<input className="input" type="number" inputMode="decimal" min={0} max={100} step={0.5} value={cap} disabled={busy} aria-label="Front desk limit a day, in dollars"
              onChange={(e) => setCap(e.target.value)}
              onBlur={() => {
                const v = Number(cap);
                if (cap.trim() === "" || !Number.isFinite(v) || v < 0) return setCap(String(t.deskCapUsd));
                if (v !== t.deskCapUsd) void run(async () => onState(await api.setNotify({ telegram: { deskCapUsd: v } })));
              }} />
          </label>
        </div>
        <div className="ch-head tg-row">
          <div className="grow">
            <div className="small">Spent from Telegram today</div>
            <div className="muted small">Front desk and work started from Telegram.</div>
          </div>
          <b className="tg-spent">${t.spentToday.toFixed(2)}</b>
        </div>
        {t.boards.length > 1 && (
          <div className="ch-head tg-row">
            <div className="grow">
              <div className="small">Front desk lives on</div>
              <div className="muted small">Messages that aren't replies to an alert go to its Ask tab. It can reach every board.</div>
            </div>
            <select className="tg-desk" aria-label="Front desk lives on" value={t.frontDesk ?? ""} disabled={busy}
              onChange={(e) => void run(async () => onState(await api.setNotify({ telegram: { frontDesk: e.target.value } })))}>
              {t.boards.map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
            </select>
          </div>
        )}
        <div className="ch-head tg-row hs-stack">
          <div className="grow">
            <div className="small">Lost your phone?</div>
            <div className="muted small">Unpair stops everything at once. Also turn on Telegram's passcode.</div>
          </div>
          <div className="tg-actions">
            <button type="button" className="btn small" disabled={busy || !t.takeMessages} onClick={() => void setTaking(false)}>{t.takeMessages ? "Pause" : "Paused"}</button>
            <button type="button" className="btn small tg-unpair" disabled={busy} onClick={() => void unpair()}>Unpair</button>
          </div>
        </div>
        <div className="small muted">Reply to an alert in Telegram to answer that ticket; anything else goes to the front desk, which asks you to Confirm before it starts, stops or moves work. Send /lock there to stop taking messages from your phone.</div>
        <button type="button" className="link-btn small tg-forget" disabled={busy} onClick={() => void forget()}>Remove the bot</button>
      </div>
    );
  }
  if (!mac) {
    return (
      <div className="tg-setup">
        <div className="small">Pair Telegram from the Mac.</div>
        {t.error && <div className="form-error small">{t.error}</div>}
        {t.tokenSet && <button type="button" className="link-btn small" disabled={busy} onClick={() => void forget()}>Remove the key</button>}
      </div>
    );
  }
  return (
    <div className="tg-setup">
      <b className="small">Set it up (about 3 minutes)</b>
      <ol className="tg-steps small">
        <li>In Telegram, search for <b>@BotFather</b> and send <code>/newbot</code>.</li>
        <li>
          Pick a name. BotFather gives you a long key. Paste it here:
          <div className="hs-inline">
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false}
              placeholder={t.tokenSet ? `Key ${t.tokenMasked}` : "Paste the bot key"} aria-label="Bot key from BotFather" />
            <button type="button" className="btn small primary" disabled={busy || !token.trim()} onClick={() => void saveToken()}>Save</button>
          </div>
        </li>
        <li>
          Open your new bot in Telegram and send it this code:
          {code ? (
            <div className="tg-code-row">
              <span className="tg-code">{code.slice(0, 3)} {code.slice(3)}</span>
              <span className="muted small"><span className="spinner" /> Waiting for your code… it works for 10 minutes.</span>
            </div>
          ) : (
            <div className="hs-inline">
              <button type="button" className="btn small" disabled={busy || !t.tokenSet} onClick={() => void pair()}>Show a pairing code</button>
              {!t.tokenSet && <span className="muted small">Save the key first.</span>}
            </div>
          )}
        </li>
      </ol>
      {t.pairError && <div className="form-error small">{t.pairError}</div>}
      {t.error && <div className="form-error small">{t.error}</div>}
      {t.tokenSet && <button type="button" className="link-btn small" disabled={busy} onClick={() => void forget()}>Remove the key</button>}
    </div>
  );
}

/** My night: quiet hours (the Mac's time zone) and whether the helper may wake you when harm grows while you sleep. */
function NightSection() {
  const { status } = useHelper();
  const [start, setStart] = useState(status?.night.start ?? "22:00");
  const [end, setEnd] = useState(status?.night.end ?? "07:00");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!status) return;
    setStart(status.night.start);
    setEnd(status.night.end);
  }, [status?.night.start, status?.night.end]);
  const save = async (patch: Parameters<typeof helperApi.settings>[0]) => {
    setError(null);
    try {
      setHelperStatus(await helperApi.settings(patch));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saveNight = () => {
    if (!status || (start === status.night.start && end === status.night.end)) return;
    void save({ night: { start, end } });
  };
  if (!status) return null;
  return (
    <section className="hs-card">
      <div className="ch-head hs-stack">
        <div className="grow">
          <div className="ch-ttl">Quiet hours</div>
          <div className="muted small">In this Mac's time zone.</div>
        </div>
        <div className="hs-times">
          <input type="time" className="hs-time" value={start} onChange={(e) => setStart(e.target.value)} onBlur={saveNight} aria-label="Night starts" />
          <span className="muted">to</span>
          <input type="time" className="hs-time" value={end} onChange={(e) => setEnd(e.target.value)} onBlur={saveNight} aria-label="Night ends" />
        </div>
      </div>
      <div className="ch-head hs-sep">
        <div className="grow">
          <div className="ch-ttl">Wake me at night if it gets worse while I sleep</div>
          <div className="muted small">
            For example, customers being billed twice. Off means everything waits until morning.
            {status.nightOptIn === null && " You haven't chosen yet, so it's off."}
          </div>
        </div>
        <Switch on={status.nightOptIn === true} label="Wake me at night" onChange={(on) => void save({ nightOptIn: on })} />
      </div>
      {error && <div className="form-error small" role="alert">{error}</div>}
    </section>
  );
}

/** "What the helper knows about you": the lines the helper reads (yours only), each with Remove, plus Add. */
function KnowsSection() {
  const [lines, setLines] = useState<FeedbackLine[] | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { status } = useHelper();
  useEffect(() => {
    helperApi.feedback().then((r) => setLines(r.lines), (e) => setError(e.message));
  }, [status]);
  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setError(null);
    try {
      setLines((await helperApi.addFeedback(t)).lines);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (id: string) => {
    setError(null);
    try {
      setLines((await helperApi.removeFeedback(id)).lines);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="hs-card ch-list">
      {lines?.length === 0 && <div className="ch-row muted small">Nothing yet. Add lasting preferences the helper should always follow, like "Pricing questions are always urgent." Not for one-off requests.</div>}
      {lines?.map((l) => (
        <div key={l.id} className="ch-row ch-head">
          <span className="grow small">{l.text}</span>
          <button type="button" className="btn small ghost" onClick={() => void remove(l.id)}>Remove</button>
        </div>
      ))}
      <div className="ch-row ch-head">
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="A lasting preference, like: never wake me for docs" maxLength={300}
          aria-label="Add something the helper should know" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }} />
        <button type="button" className="btn small primary" disabled={!text.trim()} onClick={() => void add()}>Add</button>
      </div>
      {error && <div className="form-error small" role="alert">{error}</div>}
    </section>
  );
}

/** More → the helper's model: Sonnet (careful) or Haiku (cheaper). */
function ModelRow() {
  const { status } = useHelper();
  if (!status) return null;
  return (
    <div className="ch-head hs-more-row hs-stack">
      <div className="grow">
        <div className="ch-ttl">Helper's model</div>
        {spendLine(status.today) && <div className="muted small">{spendLine(status.today)}</div>}
      </div>
      <Select ariaLabel="Helper's model" value={status.model}
        onChange={(model) => void helperApi.settings({ model }).then(setHelperStatus, (e) => toast((e as Error).message, { tone: "error" }))}
        options={[
          { value: "sonnet", label: "Sonnet (careful, recommended)" },
          { value: "haiku", label: "Haiku (cheaper, less careful)" },
        ]} />
    </div>
  );
}
