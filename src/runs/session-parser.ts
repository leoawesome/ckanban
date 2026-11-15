import { basename } from "node:path";
import { commandText, localCommandOutput } from "../chat/commands";
import { ChatCacheTracker } from "../chat/chat-cache";
import { AGENT_TOOL, notifiedStatus, parseTaskNotification, toolLabel, type AgentInfo } from "./subagents";
import { WORKFLOW_TOOL, workflowFromCall, workflowLaunched, workflowNotified, type WorkflowInfo } from "./workflows";
import { parseSetupBlock } from "./worktree-setup";
import { PUBLISHED, SETUP_HELPER, assistantBlock, cardEntry, dropBlockedMoves, fromAutomation, fromTicket, isPublisher, resultText, terminalOnly, type ParsedSession, type SessionArtifact, type SessionEntry, userText } from "./session-markers";

/**
 * Parses a transcript as it grows: feed it the new bytes, read the result when needed. Feeding a transcript in pieces
 * gives the same result as parsing it whole, so a running session's new lines are parsed on their own.
 */
export class SessionParser {
  private customTitle: string | null = null;
  private aiTitle: string | null = null;
  /** As parsed; result() copies them before the end-of-transcript fix-ups (errors, failed cards, blocked moves). */
  private entries: SessionEntry[] = [];
  private artifacts = new Map<string, SessionArtifact>();
  private publishers = new Set<string>();
  /** Bash calls running `ckanban ticket setup` (by tool_use id). */
  private setups = new Set<string>();
  /** Card tool calls (by tool_use id) and those whose result was an error: those don't render. */
  private cards = new Set<string>();
  private failed = new Set<string>();
  /** Tool calls whose result was an error (their rows get a ✗). */
  private errored = new Set<string>();
  /** Subagents by the Agent tool_use id; their rows update as results and notifications arrive. */
  private agents = new Map<string, AgentInfo>();
  /** Workflows by the Workflow tool_use id; they update as the launch result and the end notification arrive. */
  private workflows = new Map<string, WorkflowInfo>();
  /** The last command was terminal-only: its output (next local-command-stdout, if any) is hidden too. */
  private hideOutput = false;
  private cache = new ChatCacheTracker();
  /** The bytes after the last newline: a line still being written. */
  private tail: Buffer = Buffer.alloc(0);
  private snapshot: ParsedSession | null = null;

  /** New bytes of the transcript, cut anywhere (even inside a line or a character). */
  feed(chunk: Uint8Array): void {
    let buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const nl = buf.lastIndexOf(10);
    if (nl >= 0) {
      this.lines(buf.toString("utf8", 0, nl));
      buf = buf.subarray(nl + 1);
    }
    // A complete JSON object with no newline yet is a whole line (a whole parse reads it too); a half-written one waits.
    if (buf.length && buf[0] === 0x7b && buf[buf.length - 1] === 0x7d) {
      let ev: any;
      try {
        ev = JSON.parse(buf.toString("utf8"));
      } catch {}
      if (ev && typeof ev === "object") {
        this.event(ev);
        buf = buf.subarray(buf.length);
      }
    }
    this.tail = Buffer.from(buf);
  }

  /** Whole lines of text (the last one may lack its newline). */
  lines(text: string): void {
    for (const line of text.split("\n")) {
      if (!line) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      this.event(ev);
    }
  }

  private notified(text: unknown, at: string) {
    const n = typeof text === "string" ? parseTaskNotification(text) : null;
    const w = n && this.workflows.get(n.toolUseId);
    if (n && w) workflowNotified(w, n.status, n.result, at);
    const a = n && this.agents.get(n.toolUseId);
    if (!n || !a) return;
    a.status = notifiedStatus(n.status);
    a.endedAt = at || a.endedAt;
    a.updatedAt = at || a.updatedAt;
    if (a.status === "done") a.result = n.result ?? a.result;
    else a.error = n.result ?? `Agent ${n.status}`;
  }

  private peerEntry(u: NonNullable<ReturnType<typeof userText>>, uuid: string, at: string): SessionEntry {
    const from = u.kind === "text" && !u.huddle ? fromTicket(u.text) : null;
    // An automation's item is a peer entry too, so nothing reads it as the user's (lessons, rewind, Explain, chat search).
    const auto = u.kind === "text" && !u.huddle && !from ? fromAutomation(u.text) : null;
    return {
      uuid, at, role: "user", kind: u.kind, text: from ? from.text : auto ? auto.text : u.text, ...(u.command ? { command: u.command } : {}),
      ...(u.huddle ? { peer: { dir: "in" as const, ticketId: null }, huddleId: u.huddle } : {}),
      ...(from ? { peer: { dir: "in" as const, ticketId: from.ticketId, title: from.title } } : {}),
      ...(auto ? { peer: { dir: "in" as const, ticketId: null, automation: auto.name } } : {}),
      ...(u.setup ? { setup: u.setup } : {}), ...(u.wake ? { wake: u.wake } : {}),
    };
  }

  private event(ev: any): void {
    this.snapshot = null;
    if (ev.type === "custom-title" && typeof ev.customTitle === "string") this.customTitle = ev.customTitle;
    else if (ev.type === "ai-title" && typeof ev.aiTitle === "string") this.aiTitle = ev.aiTitle;
    const at = typeof ev.timestamp === "string" ? ev.timestamp : "";
    const uuid = typeof ev.uuid === "string" ? ev.uuid : `${this.entries.length}`;
    // A message sent while Claude was working is saved as an attachment to the running turn, not a user message.
    if (ev.type === "attachment" && ev.attachment?.type === "queued_command" && !ev.isSidechain) this.notified(ev.attachment.prompt, at);
    // A background task's end is queued for Claude first; a run that ends meanwhile (e.g. at its cap) never delivers it.
    if (ev.type === "queue-operation" && ev.operation === "enqueue" && typeof ev.content === "string") this.notified(ev.content, at);
    if (ev.type === "attachment" && ev.attachment?.type === "queued_command" && ev.attachment.commandMode === "prompt" && !ev.isSidechain) {
      const u = userText(ev.attachment.prompt);
      if (u) this.entries.push(this.peerEntry(u, uuid, at));
      return;
    }
    if (ev.type === "system" && !ev.isSidechain) {
      // What a built-in command printed (/context, /model), and where /compact summarised the conversation.
      const out = ev.subtype === "local_command" && typeof ev.content === "string" ? localCommandOutput(ev.content) : null;
      if (out !== null && this.hideOutput) this.hideOutput = false;
      else if (out) this.entries.push({ uuid, at, role: "assistant", kind: "text", text: out, commandOutput: true });
      else if (ev.subtype === "compact_boundary") this.entries.push({ uuid, at, role: "user", kind: "board", text: "Conversation compacted" });
      return;
    }
    if ((ev.type !== "user" && ev.type !== "assistant") || ev.isSidechain) return;
    if (!ev.isCompactSummary) this.cache.add(ev);
    const content = ev.message?.content;

    if (ev.type === "user") {
      // The summary /compact left behind: the boundary above already says so.
      if (ev.isCompactSummary) return;
      // A terminal-only command is hidden, and so is what it printed.
      if (typeof content === "string" && terminalOnly(commandText(content.trim()))) {
        this.hideOutput = true;
        return;
      }
      const out = typeof content === "string" ? localCommandOutput(content) : null;
      if (out !== null) {
        if (this.hideOutput) this.hideOutput = false;
        else if (out) this.entries.push({ uuid, at, role: "assistant", kind: "text", text: out, commandOutput: true });
        return;
      }
      if (!ev.isMeta) this.hideOutput = false;
      this.notified(typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n") : "", at);
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "tool_result" && this.agents.has(b.tool_use_id)) agentResult(this.agents.get(b.tool_use_id)!, b, ev.toolUseResult, at);
          if (b?.type === "tool_result" && this.workflows.has(b.tool_use_id)) workflowLaunched(this.workflows.get(b.tool_use_id)!, b, ev.toolUseResult, at);
          if (b?.type === "tool_result" && b.is_error && this.cards.has(b.tool_use_id)) this.failed.add(b.tool_use_id);
          if (b?.type === "tool_result" && b.is_error) this.errored.add(b.tool_use_id);
          if (b?.type === "tool_result" && this.setups.has(b.tool_use_id)) {
            const setup = parseSetupBlock(resultText(b.content));
            if (setup) this.entries.push({ uuid: `${b.tool_use_id}:setup`, at, role: "assistant", kind: "board", text: "", setup });
          }
          // Only real publishes: output of the Artifact tool, or of the `ckanban artifact publish`
          // helper / publish_artifact MCP tool headless runs use. Other tools (e.g. Bash grepping a different session's file)
          // can print the same text.
          if (b?.type !== "tool_result" || !this.publishers.has(b.tool_use_id)) continue;
          for (const m of resultText(b.content).matchAll(PUBLISHED)) {
            const label = basename(m[1]).replace(/\.[a-z0-9]+$/i, "");
            this.artifacts.delete(m[2]); // re-insert so the newest publish sorts last
            this.artifacts.set(m[2], { url: m[2], label, at });
          }
        }
      }
      const u = userText(content);
      if (u && !ev.isMeta) {
        const e = this.peerEntry(u, uuid, at);
        if (e.kind === "text" && !e.peer && !e.setup) e.rewind = true;
        this.entries.push(e);
      }
      return;
    }

    this.hideOutput = false;
    if (!Array.isArray(content)) return;
    content.forEach((b: any, i: number) => {
      if (b?.type === "tool_use" && typeof b.id === "string" && isPublisher(b)) this.publishers.add(b.id);
      if (b?.type === "tool_use" && typeof b.id === "string" && b.name === "Bash" && SETUP_HELPER.test(String(b.input?.command ?? ""))) this.setups.add(b.id);
      const id = i ? `${uuid}:${i}` : uuid;
      const card = b?.type === "tool_use" && typeof b.id === "string" ? cardEntry(b) : null;
      if (b?.type === "text" && b.text?.trim()) this.entries.push({ uuid: id, at, role: "assistant", kind: "text", ...assistantBlock(b.text.trim()) });
      else if (card) {
        // The tool_use id keeps the uuid stable, so form drafts and answered/applied state stick to it.
        this.cards.add(b.id);
        this.entries.push({ uuid: b.id, at, role: "assistant", kind: "text", text: "", ...card });
      } else if (b?.type === "tool_use" && AGENT_TOOL.test(b.name ?? "") && typeof b.id === "string") {
        const input = b.input ?? {};
        const agent: AgentInfo = {
          toolUseId: b.id, description: typeof input.description === "string" && input.description.trim() ? input.description.trim() : "Subagent",
          type: typeof input.subagent_type === "string" ? input.subagent_type : null, background: input.run_in_background === true,
          status: "running", startedAt: at, endedAt: null, updatedAt: at, steps: [], stepCount: 0, current: null, result: null, error: null,
        };
        this.agents.set(b.id, agent);
        this.entries.push({ uuid: b.id, at, role: "assistant", kind: "agent", text: toolLabel(b), agent });
      } else if (b?.type === "tool_use" && WORKFLOW_TOOL.test(b.name ?? "") && typeof b.id === "string") {
        const workflow = workflowFromCall(b.id, b.input, at);
        this.workflows.set(b.id, workflow);
        this.entries.push({ uuid: b.id, at, role: "assistant", kind: "workflow", text: workflow.name, workflow });
      } else if (b?.type === "tool_use") {
        this.entries.push({ uuid: id, at, role: "assistant", kind: "tool", text: toolLabel(b), ...(typeof b.id === "string" ? { toolUseId: b.id } : {}) });
      }
    });
  }

  /** The session as parsed so far (the same object until more lines arrive; later lines don't change it). */
  result(): ParsedSession {
    if (this.snapshot) return this.snapshot;
    const entries = this.entries.filter((e) => !this.failed.has(e.uuid)).map((e) => {
      const c: SessionEntry = { ...e, ...(e.agent ? { agent: { ...e.agent } } : {}), ...(e.workflow ? { workflow: { ...e.workflow } } : {}) };
      if (c.toolUseId && this.errored.has(c.toolUseId)) c.error = true;
      return c;
    });
    dropBlockedMoves(entries);
    const last = entries.findLast((e) => e.kind === "text" && (e.text || e.questions || e.proposal || e.branch || e.deletion || e.scheduleDeletion || e.helperRule || e.teammate || e.squad || e.automation || e.keys));
    const lastText = !last ? "" : last.text
      || (last.questions ? `Asked ${last.questions.length} question${last.questions.length > 1 ? "s" : ""}`
        : last.branch ? "Offered to branch this ticket"
        : last.deletion ? `Asked to delete ${last.deletion.ids.length} ticket${last.deletion.ids.length > 1 ? "s" : ""}`
        : last.scheduleDeletion ? "Asked to delete a schedule"
        : last.helperRule ? "Suggested a line for the helper"
        : last.teammate ? `Proposed teammate @${last.teammate.name}`
        : last.squad ? `Proposed squad "${last.squad.squad.label}"`
        : last.automation ? `Proposed automation "${last.automation.name}"` : "Proposed an updated ticket");
    const asked = last?.role === "assistant" ? entries.findLast((e, i) => i < entries.indexOf(last) && e.role === "user" && e.kind === "text") : undefined;
    return (this.snapshot = {
      title: this.customTitle ?? this.aiTitle,
      entries,
      artifacts: [...this.artifacts.values()],
      lastMessage: last
        ? {
          role: last.role, text: lastText, at: last.at,
          ...(last.role === "user" && last.huddleId ? { from: "huddle" as const } : {}),
          ...(last.role === "user" && last.peer?.automation ? { from: "automation" as const } : {}),
          ...(asked?.huddleId ? { peerReply: true } : {}),
        }
        : null,
      ...pendingSince(entries),
      cache: this.cache.result(),
    });
  }
}

export function parseSession(raw: string): ParsedSession {
  const p = new SessionParser();
  p.lines(raw);
  return p.result();
}

/** The parent's tool_result for an Agent call: the report (sync), the launch (background) or an error. */
function agentResult(a: AgentInfo, block: any, meta: any, at: string): void {
  a.updatedAt = at || a.updatedAt;
  if (meta?.status === "async_launched") {
    a.background = true;
    return;
  }
  if (block.is_error) {
    a.status = "failed";
    a.error = resultText(block.content).trim() || "Agent failed";
  } else {
    a.status = "done";
    const report = meta && Array.isArray(meta.content) ? resultText(meta.content).trim() : "";
    a.result = report || handBack(resultText(block.content));
    if (typeof meta?.agentType === "string") a.type ??= meta.agentType;
  }
  a.endedAt = at || null;
}

/** A sync agent's tool_result wraps its report in a notice and indents it; keep just the report. */
function handBack(text: string): string {
  const m = /^\[Subagent hand-back\][^\n]*\n/.exec(text);
  if (!m) return text.trim();
  return text.slice(m[0].length).split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n").trim();
}

function pendingSince(entries: SessionEntry[]): Pick<ParsedSession, "openQuestions" | "openForm" | "openAsk" | "openFormId" | "pendingProposal" | "pendingTeammates" | "pendingSquads" | "pendingAutomations" | "pendingKeys" | "pendingScheduleDeletes" | "pendingHelperRules"> {
  let lastUser = -1;
  entries.forEach((e, i) => {
    // Huddle messages and an automation's items don't answer what Claude asked the user (another ticket's message, e.g.
    // the planner's answer, does).
    if (e.role === "user" && e.kind === "text" && !e.huddleId && !e.peer?.automation) lastUser = i;
  });
  const after = entries.slice(lastUser + 1);
  // A form asked again (after a board wake) replaces the earlier ones: the chat shows only the newest as open.
  const form = after.findLast((e) => e.questions);
  const openForm = form?.questions ?? [];
  return {
    openQuestions: openForm.length,
    openForm,
    ...(form?.ask ? { openAsk: form.ask } : {}),
    ...(form ? { openFormId: form.uuid } : {}),
    pendingProposal: after.findLast((e) => e.proposal)?.proposal ?? null,
    pendingTeammates: after.filter((e) => e.teammate).map((e) => e.uuid),
    pendingSquads: after.filter((e) => e.squad).map((e) => e.uuid),
    pendingAutomations: after.filter((e) => e.automation).map((e) => e.uuid),
    pendingKeys: after.filter((e) => e.keys).map((e) => e.uuid),
    // Not only since the user's last message: a schedule waits to be deleted until the card is answered.
    pendingScheduleDeletes: entries.filter((e) => e.scheduleDeletion).map((e) => ({ uuid: e.uuid, id: e.scheduleDeletion!.id })),
    // Likewise: a suggested helper line waits for Add or Not now.
    pendingHelperRules: entries.filter((e) => e.helperRule).map((e) => e.uuid),
  };
}
