// "With you" steps in a main ticket's chat: a with_you tool ticket talks to the user itself. What it shows them (its
// replies and question forms, and the user's answers) is loaded here; the main chat shows a short card or line for it
// (TaskSheet.tsx) and the step's own chat opens in a side sheet, where answers go straight to the step's session.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribe, type SessionEntry, type Ticket } from "./api";
import { featureRows, withYouTool } from "./family";
import { stepMessages, type StepMsg } from "./stepTalk";

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
export function useStepMessages(slug: string, ticket: Ticket, tickets: Ticket[]): { steps: StepInfo[]; messages: StepMsg[]; reload: (id: string) => void; loaded: boolean } {
  const steps: StepInfo[] = ticket.main
    ? featureRows(tickets, ticket.id).map((r) => r.ticket).filter((t) => withYouTool(t) && !!t.sessionId).map((t) => ({
      id: t.id, title: t.title, running: !!t.running,
      waiting: !t.running && t.outcome === "needs_input" && t.status !== "done" && t.status !== "ready" && t.status !== "in_progress" && !(t.queued?.length),
    }))
    : [];
  const ids = steps.map((s) => `${s.id}:${s.running ? 1 : 0}`).join(",");
  const [byStep, setByStep] = useState<Record<string, SessionEntry[]>>({});
  const runningRef = useRef<Record<string, boolean>>({});
  runningRef.current = Object.fromEntries(steps.map((s) => [s.id, s.running]));

  const reload = useCallback((id: string) => {
    api.conversation(slug, id).then((r) => setByStep((m) => ({ ...m, [id]: r.entries })))
      .catch(() => setByStep((m) => (id in m ? m : { ...m, [id]: [] })));
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
  // Every step's chat answered once (or failed): the main chat waits for it so their messages paint with the rest. Stays
  // true for this ticket, so a step added later doesn't hide the timeline while it loads.
  const loadedFor = useRef<string | null>(null);
  if (steps.every((s) => s.id in byStep)) loadedFor.current = ticket.id;
  return { steps, messages, reload, loaded: loadedFor.current === ticket.id };
}
