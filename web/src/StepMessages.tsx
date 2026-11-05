// "With you" steps in a main ticket's chat: a with_you tool ticket talks to the user itself, and everything it shows
// them (its replies and question forms, and the user's answers) appears inline in the main ticket's chat as its own
// labelled block, in the order it happened. The user answers right there: the answer goes straight to the step's
// session (api.chat on the step), never through the main ticket's Claude.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, subscribe, type Question, type SessionEntry, type Ticket } from "./api";
import { autoGrow } from "./autoGrow";
import { formKey } from "./drafts";
import { enterSends } from "./enterSends";
import { familyOf, withYouTool } from "./family";
import { QuestionsForm } from "./QuestionsForm";
import { stepMessages, type StepMsg } from "./stepTalk";
import { fullTime, timeAgo } from "./time";
import { Markdown } from "./Transcript";

export type { StepMsg };

/** A step that talks to the user, as the main chat shows it. */
export interface StepInfo {
  id: string;
  title: string;
  running: boolean;
  /** Its run ended asking the user and no answer is on its way. */
  waiting: boolean;
}

/** The main ticket's "with you" steps and what each showed the user, kept fresh as their chats change. */
export function useStepMessages(slug: string, ticket: Ticket, tickets: Ticket[]): { steps: StepInfo[]; messages: StepMsg[]; reload: (id: string) => void } {
  const steps: StepInfo[] = ticket.main
    ? familyOf(tickets, ticket.id).map((r) => r.ticket).filter((t) => withYouTool(t) && !!t.sessionId).map((t) => ({
      id: t.id, title: t.title, running: !!t.running,
      waiting: !t.running && t.outcome === "needs_input" && t.status !== "done" && t.status !== "ready" && t.status !== "in_progress" && !(t.queued?.length),
    }))
    : [];
  const ids = steps.map((s) => `${s.id}:${s.running ? 1 : 0}`).join(",");
  const [byStep, setByStep] = useState<Record<string, SessionEntry[]>>({});
  const runningRef = useRef<Record<string, boolean>>({});
  runningRef.current = Object.fromEntries(steps.map((s) => [s.id, s.running]));

  const reload = useCallback((id: string) => {
    api.conversation(slug, id).then((r) => setByStep((m) => ({ ...m, [id]: r.entries }))).catch(() => {});
  }, [slug]);

  // Load each step (again when it starts or stops running).
  useEffect(() => {
    for (const part of ids ? ids.split(",") : []) reload(part.split(":")[0]);
  }, [ids, reload]);

  // Their chats change: reload that one (debounced like the main chat).
  useEffect(() => {
    if (!ids) return;
    const mine = new Set(ids.split(",").map((p) => p.split(":")[0]));
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const off = subscribe((e) => {
      if ((e.type !== "session.updated" && e.type !== "activity") || e.profile !== slug || !mine.has(e.id) || timers.has(e.id)) return;
      timers.set(e.id, setTimeout(() => {
        timers.delete(e.id);
        reload(e.id);
      }, 700));
    });
    return () => {
      off();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, [ids, slug, reload]);

  const messages = steps.flatMap((s) => stepMessages(s.id, byStep[s.id] ?? [], s.running))
    .sort((a, b) => a.at.localeCompare(b.at));
  return { steps, messages, reload };
}

/** A reply box tied to one step: what the user types goes straight to that step. */
function StepReply({ step, onSend }: { step: StepInfo; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => autoGrow(ref.current, 6), [text]);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await onSend(t);
      setText("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="step-reply">
      <textarea ref={ref} rows={1} value={text} disabled={busy} placeholder={`Reply to ${step.title}…`} aria-label={`Reply to ${step.title}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (enterSends(e)) {
            e.preventDefault();
            void send();
          }
        }} />
      <button className="btn small" disabled={busy || !text.trim()} onClick={() => void send()}>Send</button>
    </div>
  );
}

/**
 * One step's messages at one point of the main chat, under its label ("Staging check asks:"). The newest open form is
 * answered right here; while the step waits without a form, a reply box goes to it.
 */
export function StepBlock({ slug, step, msgs, newest, onOpenTicket, onError, onSent, onPreview }: {
  slug: string;
  step: StepInfo;
  msgs: StepMsg[];
  /** This block holds the step's newest message: its reply box shows here. */
  newest: boolean;
  onOpenTicket: (id: string) => void;
  onError: (msg: string) => void;
  onSent: (stepId: string) => void;
  onPreview?: (mockup: string) => void;
}) {
  const send = async (text: string) => {
    try {
      await api.chat(slug, step.id, text);
      onSent(step.id);
    } catch (e: any) {
      onError(e.message);
      throw e;
    }
  };
  const asks = msgs.some((m) => m.role === "reply");
  const openForm = msgs.some((m) => m.form?.open);
  return (
    <div className="step-block" role="group" aria-label={`${step.title}${asks ? " asks" : ""}`}>
      <div className="step-head">
        <button className="link-btn" title="Open this step's own chat" onClick={() => onOpenTicket(step.id)}>{step.title}</button>
        {asks ? " asks:" : ":"}
        {step.waiting && newest && <span className="badge step-waiting">needs you</span>}
        {step.running && newest && <span className="muted"> · working</span>}
      </div>
      {msgs.map((m) => m.role === "user" ? (
        <div key={m.uuid} className="step-msg user"><span className="who">You:</span> {m.text}<span className="muted" title={fullTime(m.at)}> · {timeAgo(m.at)}</span></div>
      ) : (
        <div key={m.uuid} className="step-msg reply">
          {m.text && <div className="reply-text"><Markdown text={m.text} /></div>}
          {m.questions && (
            <QuestionsForm questions={m.questions as Question[]} answered={!m.form?.open} disabled={step.running}
              onSubmit={(text) => void send(text).catch(() => {})} onPreview={onPreview}
              storageKey={formKey(slug, step.id, m.form?.key ?? m.uuid)} />
          )}
        </div>
      ))}
      {newest && step.waiting && !openForm && <StepReply step={step} onSend={send} />}
    </div>
  );
}
