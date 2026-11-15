// A ticket's outputs, files, changes, conversation, rewind, fork, simplify, help, subagents, workflows and tool rows. Moved verbatim from http.ts.
import { ConflictError } from "../board/board";
import { DiffError, folderDiff, ticketDiff } from "../runs/diff";
import { detectBaseBranch } from "../runs/git";
import { applyRewind, messagesFrom, previewRewind, RewindRefused } from "../chat/rewind";
import { RUN_HEADER } from "../schedules/scheduler";
import { FileError, findInRoots, readFileForView } from "../core/files";
import { AGENT_STEP_TAIL, settleAgent } from "../runs/subagents";
import { workflowAgentDetail, workflowScript } from "../runs/workflows";
import { copyFileToClipboard, revealFile, ShareError } from "../board/share";
import { SimplifyError } from "../chat/simplify";
import { changesPrompt, HELP_KINDS, HelpError, recapAvailable, recapPrompt, type HelpKind } from "../chat/explain";
import type { Profile, Ticket } from "../core/types";
import { type ApiContext, HttpError, NEXT, type RouteResult, body, fileRoots, rawFile } from "./context";

/** /api/profiles/:p/tickets/:id/{outputs,find-files,file,diff,commands,conversation,rewind,rewind-undo,fork,simplified,simplify,help,agent,workflow,tool} */
export async function ticketFileRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string, slug: string, profile: Profile, id: string, action: string): Promise<RouteResult> {
  const { store, board, json, sessions, chatEntries, huddles, workflowView, userOnly, simplifier, helper, readChatIn, strings, view, startPublish } = ctx;
  if (action === "outputs" && m === "POST" && parts.length > 5) {
    // Share menu actions; the user's alone, a board run has no business with the clipboard or Finder.
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "sharing outputs is disabled inside a board run");
    const name = parts.slice(5).join("/");
    const file = store.outputPath(slug, id, name);
    if (!file) throw new HttpError(404, "output not found");
    const what = url.searchParams.get("action");
    try {
      if (what === "reveal") await revealFile(file);
      else if (what === "copy") await copyFileToClipboard(file);
      else if (what === "publish") return json(startPublish(slug, id, name, file), 202);
      else throw new HttpError(400, "action must be reveal, copy or publish");
    } catch (e) {
      if (e instanceof ShareError) throw new HttpError(e.status, e.message);
      throw e;
    }
    return json({ ok: true });
  }
  if (action === "outputs" && m === "GET") {
    if (parts.length === 5) return json(await store.listOutputsAsync(slug, id));
    const file = store.outputPath(slug, id, parts.slice(5).join("/"));
    if (!file) throw new HttpError(404, "output not found");
    return rawFile(file, url.searchParams.get("download") === "1");
  }
  // /tickets/:id/find-files { paths } — which file paths a chat message mentions exist, so they can be opened.
  // /tickets/:id/file?path= — one of them, read only (?raw=1 the bytes, for images and PDFs). Looked for in the
  // ticket's copy of the folder, then the project folder, then the ticket's outputs; nothing outside them.
  if (action === "find-files" && m === "POST") {
    const roots = fileRoots(profile, store.getTicket(slug, id)!, store.outputsPath(slug, id));
    const paths = strings((await body(req)).paths)?.slice(0, 200) ?? [];
    const found: Record<string, { root: string; rel: string }> = {};
    for (const p of paths) {
      const f = findInRoots(roots, p);
      if (f) found[p] = { root: f.root, rel: f.rel };
    }
    return json({ found });
  }
  if (action === "file" && m === "GET") {
    const f = findInRoots(fileRoots(profile, store.getTicket(slug, id)!, store.outputsPath(slug, id)), url.searchParams.get("path") ?? "");
    if (!f) throw new HttpError(404, "file not found in this ticket's folders");
    if (url.searchParams.get("raw") === "1") return rawFile(f.file, url.searchParams.get("download") === "1");
    try {
      return json({ ...readFileForView(f.dir, f.rel), root: f.root, dir: f.dir });
    } catch (e) {
      if (e instanceof FileError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }
  // The Changes tab: the worktree (committed, uncommitted and untracked) against its merge-base with the base branch;
  // a ticket working in the board's folder itself, that folder against its HEAD at the ticket's first run.
  const changes = async (t: Ticket, ignoreWhitespace = false) => {
    try {
      if (!t.worktree && t.baseSha && !t.workdir) return await folderDiff(profile.path, t.baseSha, { ignoreWhitespace });
      if (!t.worktree) throw new HttpError(404, "No version history for this folder, so changes can't be shown.");
      // A main ticket: everything its tool tickets merged into its copy since it started, landed milestones included.
      if (t.main && t.startSha) return await folderDiff(t.worktree, t.startSha, { ignoreWhitespace });
      return await ticketDiff(t.worktree, profile.baseBranch || (await detectBaseBranch(t.worktree)), { ignoreWhitespace, prBase: t.pr?.base });
    } catch (e) {
      if (e instanceof DiffError) throw new HttpError(e.status, e.message);
      throw e;
    }
  };
  if (action === "diff" && m === "GET") return json(await changes(store.getTicket(slug, id)!, url.searchParams.get("w") === "1"));
  // What `/` runs in this ticket's chat: skills, custom commands and built-ins (the composer's picker).
  if (action === "commands" && m === "GET") {
    return json(board.commands(slug, id).map(({ local, ...c }) => c));
  }
  if (action === "conversation" && m === "GET") {
    // Read-only view of the ticket's Claude session file (terminal chat + board runs), newest last.
    const t = store.getTicket(slug, id)!;
    await readChatIn(t);
    const parsed = t.sessionId ? sessions.get(t.sessionId) : null;
    const all = chatEntries(t);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : all.length;
    const end = Math.max(0, Math.min(all.length, before));
    const start = Math.max(0, end - limit);
    const active = board.isRunning(slug, id);
    // Subagent rows carry only their last steps; "show all" fetches the rest (agent endpoint below).
    // Workflows get the run's live progress (waiting agents too); their script loads on "Show script".
    // Rows from chats left behind with "Send in a fresh chat" come first; none of them is live.
    const earlier = all.length - (parsed?.entries.length ?? 0);
    const entries = all.slice(start, end).map((e, i) => {
      if (e.workflow) return { ...e, workflow: workflowView(e.workflow, slug, id, t.sessionId!, active && start + i >= earlier) };
      if (!e.agent) return e;
      const agent = settleAgent(e.agent, active);
      return { ...e, agent: { ...agent, steps: agent.steps.slice(-AGENT_STEP_TAIL) } };
    });
    // A saved key that shows in the chat (Claude printed one, or the user pasted it) is hidden in what the UI gets.
    return json({ entries, start, total: all.length, title: parsed?.title ?? null });
  }
  if (action === "rewind" && (m === "GET" || m === "POST")) {
    // Rewind: cut the chat before one of the user's messages and put the project files back as they were then.
    // GET ?uuid= says what would change; POST { uuid, files } does it. Only the user's click, never a board run.
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "Rewind is the user's click, not a board run's");
    const t = store.getTicket(slug, id)!;
    await readChatIn(t);
    const b = m === "POST" ? await body(req) : {};
    const uuid = m === "POST" ? String(b.uuid ?? "") : url.searchParams.get("uuid") ?? "";
    const entry = (t.sessionId ? sessions.get(t.sessionId)?.entries : null)?.find((e) => e.uuid === uuid && e.rewind);
    if (!t.sessionId || !entry) throw new HttpError(404, "This message can't be rewound to.");
    const blocked = board.rewindBlocked(slug, id);
    const dir = board.rewindDir(slug, id);
    if (m === "GET") return json({ blocked, ...(await previewRewind(dir, id, entry)) });
    if (blocked) throw new ConflictError(blocked);
    const file = sessions.file(t.sessionId);
    if (!file) throw new HttpError(404, "The conversation file is missing.");
    const sessionId = t.sessionId;
    const messages = messagesFrom(sessions.get(sessionId)?.entries ?? [], entry.uuid);
    // One rewind, undo or fork at a time; messages wait, and the run state is checked again right before the cut.
    const { restored, cut, undo } = await board.withRewind(slug, id, async () => {
      const r = await applyRewind({ dir, ticketId: id, entry, sessionFile: file, files: b.files !== false, sessionId, still: () => board.rewindBlocked(slug, id, true) })
        .catch((e) => { throw e instanceof RewindRefused ? new ConflictError(e.message) : e; });
      board.rewound(slug, id, r.cut.empty, { ...r.undo, messages });
      return r;
    });
    // messages/files: for "Rewound: N messages and M files went back."; undo: Undo can put it back (rewind-undo).
    // filesSaved false: files went back but the folder couldn't be saved first, so Undo brings back the chat only.
    return json({ text: entry.text, restored, messages, files: restored, undo: true, filesSaved: !restored || !!undo.before });
  }
  if (action === "rewind-undo" && (m === "GET" || m === "POST")) {
    // Undo the last rewind: the chat (and the files it changed back) as they were just before it.
    // GET ?files=0 says whether it can (blocked: why not) and what would come back; POST { files } does it.
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "Undo rewind is the user's click, not a board run's");
    if (m === "POST") await userOnly(req, "Undo rewind");
    const b = m === "POST" ? await body(req) : {};
    const files = m === "POST" ? b.files !== false : url.searchParams.get("files") !== "0";
    if (m === "GET") {
      const u = store.getTicket(slug, id)!.rewindUndo ?? null;
      const blocked = await board.undoRewindBlocked(slug, id, files);
      return json({ available: !!u, blocked, messages: u?.messages ?? 0, files: u?.files ?? 0, filesSaved: !!u?.before });
    }
    return json(await board.undoRewind(slug, id, files));
  }
  if (action === "fork" && m === "POST") {
    // Fork from here: a new ticket like Branch whose chat ends just before this message of the user's; text goes
    // back in the new chat's box. The original chat and files are only read.
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "Fork is the user's click, not a board run's");
    await userOnly(req, "Fork from here");
    const t = store.getTicket(slug, id)!;
    await readChatIn(t);
    const uuid = String((await body(req))?.uuid ?? "");
    const entry = (t.sessionId ? sessions.get(t.sessionId)?.entries : null)?.find((e) => e.uuid === uuid && e.rewind);
    if (!t.sessionId || !entry) throw new HttpError(404, "The chat can't be forked from this message.");
    try {
      const r = await board.forkTicket(slug, id, uuid);
      return json({ id: r.ticket.id, text: entry.text, ticket: view(profile, r.ticket), warning: r.warning }, 201);
    } catch (e) {
      if (e instanceof ConflictError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
  }
  if (action === "simplified" && m === "GET") {
    // Saved plain-words versions of this ticket's Claude replies, by message.
    const t = store.getTicket(slug, id)!;
    await readChatIn(t);
    return json(simplifier.saved(slug, id, chatEntries(t)));
  }
  if (action === "simplify" && m === "POST") {
    // "Say it simpler": a side call rewrites one reply; the ticket's session and activity log never see it.
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "Say it simpler is the user's click, not a board run's");
    const b = await body(req);
    const t = store.getTicket(slug, id)!;
    await readChatIn(t);
    const e = typeof b?.uuid === "string" ? chatEntries(t).find((x) => x.uuid === b.uuid) : null;
    if (!e) throw new HttpError(404, "no such message in this ticket's conversation");
    try {
      return json(await simplifier.simplify(slug, id, t.title, e));
    } catch (err) {
      if (err instanceof SimplifyError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }
  if (action === "help" && m === "GET") {
    // "Help me understand": the saved answer cards, the ones being worked out, and whether a recap has anything to tell.
    const t = store.getTicket(slug, id)!;
    await readChatIn(t);
    const entries = (t.sessionId ? sessions.get(t.sessionId)?.entries : null) ?? [];
    return json({
      cards: helper.cards(slug, id), busy: helper.busy(slug, id), recap: recapAvailable(entries),
    });
  }
  if (action === "help" && m === "POST") {
    // A side call answers from the conversation and the changes, reading the ticket's folder; the session never sees it.
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "Help me understand is the user's click, not a board run's");
    const kind = (await body(req))?.kind as HelpKind;
    if (!HELP_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of: ${HELP_KINDS.join(", ")}`);
    const t = store.getTicket(slug, id)!;
    await readChatIn(t);
    const entries = (t.sessionId ? sessions.get(t.sessionId)?.entries : null) ?? [];
    let prompt: string;
    if (kind === "recap") {
      if (!recapAvailable(entries)) throw new HttpError(400, "nothing happened since your last message");
      const findings = huddles.list(slug, id).flatMap((h) => h.findings);
      prompt = recapPrompt({ ticket: t, entries, findings, running: board.isRunning(slug, id) });
    } else {
      const diff = await changes(t);
      if (!diff.files.length) throw new HttpError(400, diff.note ?? "this ticket has no changed files");
      prompt = changesPrompt({ ticket: t, entries, diff });
    }
    const cwd = t.worktree ?? t.workdir ?? (t.baseSha ? profile.path : null);
    try {
      return json(await helper.ask(slug, id, kind, prompt, cwd));
    } catch (err) {
      if (err instanceof HelpError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }
  if (action === "agent" && parts.length === 6 && m === "GET") {
    const t = store.getTicket(slug, id)!;
    await readChatIn(t);
    const e = chatEntries(t).find((x) => x.agent?.toolUseId === parts[5]);
    if (!e?.agent) throw new HttpError(404, "no such subagent in this ticket's conversation");
    return json(settleAgent(e.agent, board.isRunning(slug, id)));
  }
  // A workflow in the ticket's conversation: its script, one helper agent in full, or stopping it (the user's click).
  if (action === "workflow" && parts.length >= 7) {
    const t = store.getTicket(slug, id)!;
    await readChatIn(t);
    const e = (t.sessionId ? sessions.get(t.sessionId)?.entries : null)?.find((x) => x.workflow?.toolUseId === parts[5]);
    if (!e?.workflow || !t.sessionId) throw new HttpError(404, "no such workflow in this ticket's conversation");
    const w = e.workflow;
    const run = w.runId ? sessions.workflowRun(t.sessionId, w.runId) : null;
    if (parts[6] === "script" && parts.length === 7 && m === "GET") {
      const script = workflowScript(w, run);
      if (script === null) throw new HttpError(404, "the workflow's script wasn't saved");
      return json({ script });
    }
    if (parts[6] === "agent" && parts.length === 8 && m === "GET") {
      const view = workflowView(w, slug, id, t.sessionId, board.isRunning(slug, id));
      const d = workflowAgentDetail(view, run, parts[7]);
      if (!d) throw new HttpError(404, "no such helper agent in this workflow");
      return json(d);
    }
    if (parts[6] === "stop" && parts.length === 7 && m === "POST") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "Stopping a workflow is the user's click, not a board run's");
      if (!w.taskId) throw new HttpError(400, "this workflow hasn't started yet");
      if (!board.isRunning(slug, id)) throw new HttpError(400, "this ticket isn't running");
      try {
        return json(await board.stopWorkflow(slug, id, w.taskId));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }
  }
  if (action === "tool" && parts.length === 6 && m === "GET") {
    // A tool call's full input and output, loaded when the user opens its row in the chat.
    const t = store.getTicket(slug, id)!;
    const d = [t.sessionId, ...(t.earlierSessions ?? []).map((x) => x.sessionId).reverse()]
      .reduce<ReturnType<typeof sessions.toolDetail>>((found, sid) => found ?? (sid ? sessions.toolDetail(sid, parts[5]) : null), null);
    if (!d) throw new HttpError(404, "no such tool call in this ticket's conversation");
    return json(d);
  }
  return NEXT;
}
