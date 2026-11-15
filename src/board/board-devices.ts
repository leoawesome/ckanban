import { existsSync } from "node:fs";
import { type DeviceTicketState } from "../server/devices";
import { ticketAttention, userWaitReason } from "../server/attention";
import { withYouTool } from "../../web/src/features/family/family";
import { youWaiting } from "./main-ticket";
import { run as runCmd } from "../runs/git";
import { messageCost } from "../usage/ticket-usage";
import { transcriptDirOf } from "../runs/workflows";
import { type Status, type Ticket } from "../core/types";
import { nowIso } from "../core/util";
import type { Board } from "./board";
import { chatFor, takesSlot, FOLDER_WAIT, WORKFLOW_STOPPED_TEXT } from "./board-types";

/** Who holds or waits for devices changed: refresh those tickets' cards and the Devices screen. */
export function devicesChanged(this: Board, owners: string[]): void {
  if (this.shuttingDown) return;
  for (const o of owners) {
    const i = o.indexOf("/");
    const t = this.store.getTicket(o.slice(0, i), o.slice(i + 1));
    if (t) this.emitTicket(o.slice(0, i), t);
  }
  this.bus.emit({ type: "devices.updated" });
}

/** For the card: the devices the ticket's run uses now, and the ones it waits for. */
export function deviceState(this: Board, slug: string, id: string): DeviceTicketState | null {
  return this.devices.ticketState(slug, id);
}

/** The ticket waits on the user now: not working, and a question or proposal is open (userWait). */
export function waitsForAnswer(this: Board, slug: string, t: Ticket): boolean {
  return !this.isRunning(slug, t.id) && this.userWait(t) !== null;
}

/** Why a plan child waits on the user (questions, a proposal to apply, in Planning), or null. */
export function userWait(this: Board, t: Ticket): string | null {
  return userWaitReason(t, t.sessionId ? this.sessionSummary(t.sessionId) : null);
}

/** The card still needs the user (questions, a proposal or new tickets to apply, a failed run), not just a look. */
export function waitsOnUser(this: Board, slug: string, id: string): boolean {
  const t = this.store.getTicket(slug, id);
  if (!t) return false;
  // A "with you" step has no card of its own: it waits on the user while its question is unanswered.
  if (withYouTool(t)) return youWaiting(t, this.isRunning(slug, id));
  const a = ticketAttention(this.store, slug, t, t.sessionId ? this.sessionSummary(t.sessionId) ?? null : null, this.isRunning(slug, id),
    this.hostHuddles(slug).get(id), (x) => this.isRunning(slug, x));
  return !!a && a.kind !== "review";
}

/** Snooze the ticket from the Inbox until a time (null: unsnooze); key: snoozeKey of what it waits for now. */
export function setSnooze(this: Board, slug: string, id: string, snooze: { until: string; key: string } | null): Ticket {
  return this.patch(slug, id, { snooze });
}

/** Working runs on the board (see takesSlot). */
export function running(this: Board, slug: string): number {
  let n = 0;
  for (const r of this.runs.values()) if (r.slug === slug && takesSlot(r.chat, r.noEdit)) n++;
  return n;
}

/** The ticket's run is a working run (see takesSlot). */
export function holdsSlot(this: Board, slug: string, id: string): boolean {
  const r = this.runs.get(this.key(slug, id));
  return !!r && takesSlot(r.chat, r.noEdit);
}

export function isRunning(this: Board, slug: string, id: string): boolean {
  return this.runs.has(this.key(slug, id));
}

/** The board's tickets with a run now, as one string that changes when one starts or stops (the daemon's caches key on it). */
export function runningKey(this: Board, slug: string): string {
  const ids: string[] = [];
  for (const r of this.runs.values()) if (r.slug === slug) ids.push(`${r.id}${takesSlot(r.chat, r.noEdit) ? "" : "~"}`);
  return ids.sort().join(",");
}

/** Live progress of a workflow in this ticket's run (the latest task_progress agent list), if any came in. */
export function workflowProgress(this: Board, slug: string, id: string, toolUseId: string): any[] | null {
  return this.workflowLive.get(`${slug}/${id}/${toolUseId}`) ?? null;
}

/** Keep a run's workflow progress for the chat, and what it spends for the cap. */
export function watchWorkflows(this: Board, slug: string, id: string, ev: any, spend: { main: Map<string, number>; workflowDirs: Set<string> }): void {
  if (ev?.type === "system" && ev.subtype === "task_progress" && typeof ev.tool_use_id === "string" && Array.isArray(ev.workflow_progress)) {
    this.workflowLive.set(`${slug}/${id}/${ev.tool_use_id}`, ev.workflow_progress);
  } else if (ev?.type === "assistant" && ev.message?.usage) {
    const mid = typeof ev.message.id === "string" ? ev.message.id : `#${spend.main.size}`;
    spend.main.set(mid, messageCost(String(ev.message.model ?? ""), ev.message.usage));
  } else if (ev?.type === "user" && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b?.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c?.text ?? "").join("\n") : "";
      const dir = text.startsWith("Workflow launched") ? transcriptDirOf(text) : null;
      if (dir) spend.workflowDirs.add(dir);
    }
  }
}

/**
 * Stop one workflow of the ticket's run and let the run go on. Claude Code answers the stop request; if it can't
 * stop just the workflow, the whole run stops instead (the result says which).
 */
export async function stopWorkflow(this: Board, slug: string, id: string, taskId: string): Promise<{ stopped: "workflow" | "run"; error?: string }> {
  const r = this.runs.get(this.key(slug, id));
  if (!r?.handle) throw new Error("this ticket isn't running");
  const res = await r.handle.stopTask(taskId);
  if (res.ok) {
    // Claude only hears "killed": tell it the user did it, so it doesn't report the workflow as still running.
    r.handle.send(WORKFLOW_STOPPED_TEXT);
    this.store.addComment(slug, id, "ai", "Workflow stopped by user. The run goes on.");
    this.emitTicket(slug, this.store.getTicket(slug, id)!);
    return { stopped: "workflow" };
  }
  this.stopRun(r);
  return { stopped: "run", error: res.error };
}

/** The ticket's current run is a quiet reply to another session's message (a peer run, e.g. a huddle's). */
export function isPeerRun(this: Board, slug: string, id: string): boolean {
  return !!this.runs.get(this.key(slug, id))?.chat?.quiet;
}

export function dispatch(this: Board, slug: string): void {
  if (this.restartPending || this.shuttingDown) return; // Ready tickets start after the restart
  const profile = this.store.getProfile(slug);
  if (!profile || !existsSync(profile.path)) return;
  const idle = this.store.listTickets(slug).filter((t) => !t.error?.startsWith("corrupt") && !this.isRunning(slug, t.id));
  // Chat replies waiting for a slot go first, oldest first: they continue work that is already underway.
  for (const t of idle.filter((t) => t.slotWait).sort((a, b) => a.slotWait!.at.localeCompare(b.slotWait!.at))) {
    const next = this.waiting(slug, t.id)[0];
    if (!next) {
      this.cancelSlotWait(slug, t.id);
      continue;
    }
    const chat = next.peer || next.hostWake ? chatFor(t, next) : next.followUp ? chatFor(t.slotWait!.from, next) : { ...chatFor(t, next), mode: "act" as const, from: t.slotWait!.from };
    if (chat.mode === "act" && this.folderBusy(slug, t)) continue;
    this.patch(slug, t.id, { slotWait: null });
    this.start(slug, t.id, chat, next.id);
  }
  const ready = idle.filter((t) => t.status === "ready").sort((a, b) => a.order - b.order);
  for (const t of ready) {
    // It would edit the board's folder in place while another ticket does: it waits its turn the same way.
    if (this.folderBusy(slug, t)) continue;
    this.start(slug, t.id);
  }
}

/** All slots are busy (or the folder is): the card waits in In Progress with its queued message(s) until dispatch() starts it. */
export function waitForSlot(this: Board, slug: string, id: string): Ticket {
  const t = this.store.getTicket(slug, id)!;
  return this.patch(slug, id, {
    status: "in_progress", outcome: null, error: null, lastActivity: FOLDER_WAIT,
    slotWait: t.slotWait ?? { at: nowIso(), from: { status: t.status, outcome: t.outcome } },
  });
}

/** Stop (or a move) before a waiting reply started: its messages stay for the user to send or discard. */
export function cancelSlotWait(this: Board, slug: string, id: string): Ticket {
  const t = this.store.getTicket(slug, id)!;
  const from = t.slotWait?.from ?? { status: "review" as Status, outcome: t.outcome };
  return this.patch(slug, id, {
    status: from.status, outcome: from.outcome, slotWait: null, lastActivity: null,
    queued: (t.queued ?? []).map((m) => (m.state === "queued" ? { ...m, state: "unsent" } : m)),
  });
}
