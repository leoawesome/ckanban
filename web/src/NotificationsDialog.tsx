import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type ChannelState, type NotifyKind, type NotifyPatch, type NotifyState } from "./api";
import { helperApi, setHelperStatus, useHelper, type FeedbackLine } from "./helper";
import { HelperStatusLine } from "./Messages";
import { Modal } from "./Modal";
import { PUSH_CHANGED } from "./push";
import { PushSection } from "./PushSection";
import { Select } from "./Select";
import { timeAgo } from "./time";
import { toast } from "./toast";

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
 * Header menu → Notifications: the helper (on/off, its status line), the channels it reaches you on (This Mac, phone
 * push, ntfy, Telegram; a JSON web address under More), my night, Focus mode, what the helper knows about you, and its
 * model. Every switch saves at once; errors show in plain words under the section.
 */
export function NotificationsDialog({ profile, onClose }: { profile: string | null; onClose: () => void }) {
  const [state, setState] = useState<NotifyState | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const { status } = useHelper();

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
  return (
    <Modal title="Notifications" onClose={onClose} focusDialog wide>
      <form className="form notify-form helper-settings" onSubmit={(e) => { e.preventDefault(); void saveUrl(); }}>
        {!state && !error && <div className="muted small"><span className="spinner" /> Loading…</div>}
        {state && (
          <>
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
            </section>

            <h3 className="hs-head">Channels</h3>
            {state.reachLine && <div className="helper-status warn"><i aria-hidden /><span>{state.reachLine}. Turn on a phone channel below.</span></div>}
            <section className="hs-card ch-list">
              <ChannelRow ch={ch("mac")} title="This Mac" onToggle={(on) => void save({ mac: on })} />
              <ChannelRow ch={ch("push")} title="Phone push" onToggle={(on) => void save({ push: on })}>
                {state.push && <PushSection profile={profile} />}
              </ChannelRow>
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
              <ChannelRow ch={ch("telegram")} title="Telegram" detail={state.telegram.paired ? ch("telegram")?.detail : "Messages with Got it and Not urgent buttons. Reply to an alert to answer that ticket."}
                onToggle={(on) => void save({ telegram: { on } })}>
                {state.telegram.on && <TelegramSetup state={state} onState={setState} onError={setError} />}
                {state.telegram.on && (
                  <div className="small muted">
                    Messages pass through Telegram's servers, and bot chats aren't end-to-end encrypted: Telegram can read them. Leave Telegram off if your tickets hold private things.
                  </div>
                )}
              </ChannelRow>
            </section>
            {error && <div className="form-error" role="alert">{error}</div>}

            <h3 className="hs-head">My night</h3>
            <NightSection />
            <section className="hs-card">
              <div className="ch-ttl">Focus mode</div>
              <div className="muted small">{state.focusHint}</div>
            </section>

            <h3 className="hs-head">What the helper knows about you</h3>
            <KnowsSection />

            <details className="hs-card hs-more">
              <summary>More</summary>
              <ModelRow />
              <div className="ch-head hs-more-row hs-stack">
                <div className="grow">
                  <div className="ch-ttl">Send to a web address as JSON</div>
                  <div className="muted small">For your own tools: the address above gets each message as JSON instead of ntfy text.</div>
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
            </details>
          </>
        )}
        {!state && error && <div className="form-error" role="alert">{error}</div>}
        <div className="form-actions">
          <button type="button" className="btn" disabled={!state || !!busy} onClick={() => void test()}>{busy === "test" ? "Sending…" : "Send test message"}</button>
          <div className="spacer" />
          <button type="button" className="btn" disabled={busy === "save"} onClick={async () => { if (await saveUrl()) onClose(); }}>Done</button>
        </div>
      </form>
    </Modal>
  );
}

/** Telegram: BotFather steps, the bot key, then the 6-digit pairing code the user sends to the bot. */
function TelegramSetup({ state, onState, onError }: { state: NotifyState; onState: (s: NotifyState) => void; onError: (e: string | null) => void }) {
  const t = state.telegram;
  const [token, setToken] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    const r = await api.telegramPair();
    onState(r.state);
    setCode(r.code);
  });
  const pair = () => run(async () => {
    const r = await api.telegramPair();
    onState(r.state);
    setCode(r.code);
  });
  const unpair = () => run(async () => onState(await api.telegramUnpair()));
  const forget = () => run(async () => {
    setCode(null);
    onState(await api.setNotify({ telegram: { token: "" } }));
  });

  if (t.paired && t.tokenSet) {
    return (
      <div className="tg-setup">
        <div className="small">Paired with <b>{t.chatName ?? "your chat"}</b>{t.botName ? <> through @{t.botName}</> : null}.</div>
        {t.error && <div className="form-error small">{t.error}</div>}
        <div className="small muted">Reply to an alert in Telegram to answer that ticket.</div>
        <div className="ch-head">
          <div className="grow">
            <div className="small">Ask before sending typed answers</div>
            <div className="muted small">Shows what you typed with Send and Cancel before it reaches the ticket.</div>
          </div>
          <Switch on={t.askTyped} label="Ask before sending typed answers" disabled={busy}
            onChange={(on) => void run(async () => onState(await api.setNotify({ telegram: { askTyped: on } })))} />
        </div>
        <div className="hs-inline">
          <button type="button" className="btn small" disabled={busy} onClick={() => void unpair()}>Unpair</button>
          <button type="button" className="btn small ghost" disabled={busy} onClick={() => void forget()}>Remove the bot</button>
        </div>
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
        <div className="muted small">Sonnet costs about 1 to 3 cents a check.</div>
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
