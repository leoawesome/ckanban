import type { Loop, LoopInput, LoopTest, Pass } from "../../features/schedules/automationTypes";
import type { Status } from "../../features/board/columns";
import type { ContextView } from "../../features/chat/contextText";
import type { TicketKind } from "../../features/family/family";
import type { PrStatus } from "../../features/ticket/prText";
import type { SlashCommand } from "../../features/chat/slashText";
import type { TicketUsage, UsageResult } from "../../features/usage/usage";
import { isImageFile } from "../attachText";
import { req } from "./request";
import type { Health, Profile, RepoKind, SetupDetection, Snippet, SnippetInput, TicketPage, TicketRow, VersionHistory } from "./types/board";
import type { BrowsersState, DeviceView } from "./types/browsers";
import type { DiskSpace, FreeUp } from "./types/disk";
import type { ClaudeSignInState } from "./types/claudeSignin";
import type { AgentInfo, ClaudeProject, ClaudeSession, HelpCard, HelpKind, QuickChat, SessionEntry, ToolDetail, WorkflowAgentDetail } from "./types/chat";
import type { AgentStatus, McpAddInput, McpConfig, McpState } from "./types/connections";
import type { FileContent, FileEntry, FileRootName, OutputFile, TicketDiff, TicketFile } from "./types/files";
import type { DroppedPushDevice, InboxItem, NotifyPatch, NotifyState, PushDevice } from "./types/helper";
import type { GenericSquadResult, HandIn, Huddle, HuddleFinding, HuddleLearning, HuddleMessage, HuddleMode, HuddleNote, HuddleNotes, HuddleParticipant, HuddlePreset, HuddleTemplate, LayerInfo, Level, ParticipantSession, RosterEntry, SquadCardRef, SquadCardState, SquadDraft, TeammateCardState } from "./types/huddle";
import type { CronPreview, Job, Schedule, ScheduleHistoryItem, ScheduleInput } from "./types/schedules";
import type { BugBlock, BugBlockId, BugReportResult, LearnCandidate, LearnChange, LearnedView, RemoteState } from "./types/settings";
import type { ActivityEntry, Comment, FamilyViewRow, FeatureStatus, RewindResult, RewindUndoState, Ticket, TicketMode, UndoRewindResult, Workspace } from "./types/ticket";
import type { TeamUsage, TodaySpend } from "./types/usage";

const inTicket = (ticket?: string | null) => (ticket ? `&ticket=${encodeURIComponent(ticket)}` : "");

/** `?a=1&b=2` from the defined values ("" when none). */
const query = (q: Record<string, number | undefined>) => {
  const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
  return s ? `?${s}` : "";
};
const hud = (slug: string, id?: string) => `/api/profiles/${encodeURIComponent(slug)}/huddles${id ? `/${encodeURIComponent(id)}` : ""}`;

const sch = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/schedules${id ? `/${encodeURIComponent(id)}` : ""}`;

const lp = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/loops${id ? `/${encodeURIComponent(id)}` : ""}`;

const jb = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/jobs${id ? `/${encodeURIComponent(id)}` : ""}`;

const t = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/tickets${id ? `/${encodeURIComponent(id)}` : ""}`;

const chatsUrl = (slug: string, id?: string) =>
  `/api/profiles/${encodeURIComponent(slug)}/chats${id ? `/${encodeURIComponent(id)}` : ""}`;

const sizes = new Map<string, Promise<number | null>>();

export const api = {
  claudeProjects: () => req<ClaudeProject[]>("GET", "/api/claude/projects"),
  /** Claude's own default model, and the version each alias means as learned from real runs ({ fable: "5.2" }). */
  claudeDefaults: () => req<{ model: string | null; effort?: string | null; versions?: Record<string, string> }>("GET", "/api/claude/defaults"),
  pickFolder: () => req<{ path: string | null }>("POST", "/api/pick-folder"),
  versionHistory: (path: string) => req<VersionHistory>("GET", `/api/version-history?path=${encodeURIComponent(path)}`),
  /** Turned on now, or `{pending: true}` while tickets change files in the folder: the board turns it on once they finish. */
  enableVersionHistory: (path: string) => req<{ changed: boolean; sha: string | null; ignored: string[]; repo: RepoKind } | { pending: true }>("POST", "/api/version-history", { path }),
  cancelVersionHistory: (path: string) => req<{ pending: false }>("POST", "/api/version-history", { path, cancel: true }),
  /** Claude plan usage (5h / weekly windows) or a plain-words error. */
  usage: (fresh = false) => req<UsageResult>("GET", `/api/usage${fresh ? "?fresh=1" : ""}`),
  /** What every board spent today (local day). */
  spend: () => req<TodaySpend>("GET", "/api/spend"),
  version: () => req<{ version: string; latest: string | null; updateAvailable: boolean; url: string | null }>("GET", "/api/version"),
  health: () => req<Health>("GET", "/api/health"),
  /** pending: a daemon restart holds new runs until the `waiting` active runs finish. */
  remote: () => req<RemoteState>("GET", "/api/remote"),
  setRemote: (enabled: boolean) => req<RemoteState>("POST", "/api/remote", { enabled }),
  browsers: () => req<BrowsersState>("GET", "/api/browsers"),
  renameBrowser: (deviceId: string, name: string) => req<BrowsersState>("PATCH", `/api/browsers/${encodeURIComponent(deviceId)}`, { name }),
  removeBrowser: (deviceId: string) => req<BrowsersState>("DELETE", `/api/browsers/${encodeURIComponent(deviceId)}`),
  /** Board browsers (server: board-browsers.ts, routes in http.ts /api/board-browsers). */
  addBoardBrowser: (name: string) => req<BrowsersState & { added: string }>("POST", "/api/board-browsers", { name }),
  updateBoardBrowser: (id: string, patch: { name?: string; keepRunning?: boolean; startUrl?: string | null }) =>
    req<BrowsersState>("PATCH", `/api/board-browsers/${encodeURIComponent(id)}`, patch),
  /** Deletes its folder and logins; refused while a task uses it. */
  removeBoardBrowser: (id: string) => req<BrowsersState>("DELETE", `/api/board-browsers/${encodeURIComponent(id)}`),
  /** Sign in / Open window: a visible window on the Mac (url: the site to open). opened false: it opens once the task using it is done. */
  openBoardBrowser: (id: string, url?: string) => req<BrowsersState & { opened: boolean; message: string }>("POST", `/api/board-browsers/${encodeURIComponent(id)}/open`, url ? { url } : {}),
  /** A live picture of a logged-out browser's login tab (an object URL; revoke it when replaced). */
  boardBrowserScreen: async (id: string): Promise<string> => {
    const r = await fetch(`/api/board-browsers/${encodeURIComponent(id)}/screen`, {
      method: "POST", headers: { "content-type": "application/json", "x-ckanban-source": "ui" }, body: "{}", cache: "no-store",
    });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `${r.status} ${r.statusText}`);
    return URL.createObjectURL(await r.blob());
  },
  /** A tap (x, y as shares of the picture) or typing passed to that login tab. */
  boardBrowserInput: (id: string, ev: { type: "click"; x: number; y: number } | { type: "text"; text: string } | { type: "key"; key: "Enter" | "Backspace" | "Tab" }) =>
    req<{ ok: true }>("POST", `/api/board-browsers/${encodeURIComponent(id)}/input`, ev),
  closeBoardBrowser: (id: string) => req<BrowsersState & { closed: boolean; message: string }>("POST", `/api/board-browsers/${encodeURIComponent(id)}/close`),
  devices: () => req<DeviceView[]>("GET", "/api/devices"),
  saveDevice: (input: { name: string; description?: string; capacity?: number }) => req<DeviceView[]>("POST", "/api/devices", input),
  deleteDevice: (name: string) => req<DeviceView[]>("DELETE", `/api/devices/${encodeURIComponent(name)}`),
  freeDevice: (name: string, profile: string, id: string) => req<DeviceView[]>("POST", `/api/devices/${encodeURIComponent(name)}/free`, { profile, id }),
  notify: () => req<NotifyState>("GET", "/api/notify"),
  setNotify: (patch: NotifyPatch) => req<NotifyState>("POST", "/api/notify", patch),
  telegramPair: (board?: string | null) => req<{ code: string; expiresAt: string; state: NotifyState }>("POST", "/api/notify/telegram/pair", board ? { board } : {}),
  telegramUnpair: () => req<NotifyState>("POST", "/api/notify/telegram/unpair", {}),
  testNotify: (profile: string | null) =>
    req<{ ok: boolean; error: string | null; webhook: boolean; devices: number; state: NotifyState }>("POST", "/api/notify/test", profile ? { profile } : {}),
  push: () => req<{ publicKey: string; devices: PushDevice[]; dropped: DroppedPushDevice[] }>("GET", "/api/push"),
  pushSubscribe: (subscription: PushSubscriptionJSON, label: string, replaces?: string) =>
    req<PushDevice>("POST", "/api/push/subscribe", replaces ? { subscription, label, replaces } : { subscription, label }),
  pushRemove: (key: { id: string } | { endpoint: string }) => req<{ removed: boolean; devices: PushDevice[] }>("POST", "/api/push/remove", key),
  pushTest: (id: string, profile: string | null) => req<{ ok: boolean; error: string | null }>("POST", "/api/push/test", profile ? { id, profile } : { id }),
  pushVisible: (endpoint: string, visible: boolean) => req<{ ok: boolean }>("POST", "/api/push/visible", { endpoint, visible }),
  restartState: () => req<{ pending: boolean; waiting: number }>("GET", "/api/restart"),
  awakeState: () => req<{ held: boolean }>("GET", "/api/awake"),
  /** Free space for the low-disk banner. */
  diskSpace: () => req<DiskSpace>("GET", "/api/disk"),
  freeUpState: () => req<FreeUp>("GET", "/api/disk/free-up"),
  /** Starts Free up space; progress comes as `disk.freeup` events. */
  freeUp: () => req<FreeUp>("POST", "/api/disk/free-up", {}),
  /** Claude Code's own sign-in on the Mac: the strip's status, and the sheet's start, paste and cancel (user only). */
  claudeSignIn: () => req<ClaudeSignInState>("GET", "/api/claude-signin"),
  claudeSignInStart: () => req<ClaudeSignInState>("POST", "/api/claude-signin/start", {}),
  claudeSignInPaste: (id: number, code: string) => req<ClaudeSignInState>("POST", "/api/claude-signin/paste", { id, code }),
  claudeSignInCancel: (id: number) => req<ClaudeSignInState>("POST", "/api/claude-signin/cancel", { id }),
  bugDraft: (ref: { profile: string; ticketId: string } | null) =>
    req<{ blocks: BugBlock[]; screenshots: string[] }>("POST", "/api/bug-report/draft", ref ?? {}),
  reportBug: (input: { title: string; description: string; include: BugBlockId[]; profile?: string; ticketId?: string }) =>
    req<BugReportResult>("POST", "/api/bug-report", { ...input, source: "ui" }),
  profiles: () => req<Profile[]>("GET", "/api/profiles"),
  createProfile: (p: { name: string; path: string; model?: string; effort?: string; ultracode?: boolean; baseBranch?: string; workspace?: Workspace; folderTurns?: boolean }) =>
    req<Profile>("POST", "/api/profiles", p),
  updateProfile: (slug: string, p: Partial<Profile>) => req<Profile>("PATCH", `/api/profiles/${slug}`, p),
  deleteProfile: (slug: string) => req<void>("DELETE", `/api/profiles/${slug}`),
  detectSetup: (slug: string) => req<SetupDetection>("POST", `/api/profiles/${slug}/detect-setup`),
  /** How many tickets the board has (all, open, Done column cards), without sending them. */
  ticketCount: (slug: string) => req<{ total: number; open: number; doneTotal: number }>("GET", `${t(slug)}?scope=count`),
  /**
   * The board's first load: unfinished work with whole families, plus the first `done` cards of Done and the `ids`
   * asked for (open tickets, search finds) with their families. doneTotal: the Done column's card count.
   */
  boardTickets: (slug: string, opts: { done?: number; ids?: string[]; after?: string | null } = {}) => req<TicketPage>("GET",
    `${t(slug)}?scope=board${opts.done ? `&done=${opts.done}` : ""}${opts.ids?.length ? `&ids=${opts.ids.map(encodeURIComponent).join(",")}` : ""}${opts.after ? `&after=${encodeURIComponent(opts.after)}` : ""}`),
  /** A page of the Done column, right after the card `after` (offset: cards in, if the daemon can't find it). */
  doneTickets: (slug: string, offset: number, after?: string | null) =>
    req<TicketPage>("GET", `${t(slug)}?scope=done&offset=${offset}${after ? `&after=${encodeURIComponent(after)}` : ""}`),
  /** These tickets with their families. */
  ticketsByIds: (slug: string, ids: string[]) => req<TicketPage>("GET", `${t(slug)}?scope=ids&ids=${ids.map(encodeURIComponent).join(",")}`),
  /** Finished tickets matching the board search (text and/or tags). */
  searchDone: (slug: string, q: string, tags: string[]) => req<TicketPage>("GET",
    `${t(slug)}?scope=search&q=${encodeURIComponent(q)}${tags.length ? `&tags=${tags.map(encodeURIComponent).join(",")}` : ""}`),
  huddlePresets: (slug: string) => req<HuddlePreset[]>("GET", `/api/profiles/${encodeURIComponent(slug)}/huddle-presets`),
  /** scope: global (every board) or this board. */
  saveHuddlePreset: (slug: string, p: Partial<Omit<HuddlePreset, keyof LayerInfo>> & { name: string }, scope: Level) =>
    req<HuddlePreset>("POST", `/api/profiles/${encodeURIComponent(slug)}/huddle-presets`, { ...p, scope }),
  /** Deletes a teammate at one level: it falls back to the level below (all boards, then built-in), or goes away. */
  deleteHuddlePreset: (slug: string, name: string, scope: Level) =>
    req<{ reset: boolean; presets: HuddlePreset[] }>("DELETE", `/api/profiles/${encodeURIComponent(slug)}/huddle-presets/${encodeURIComponent(name)}?scope=${scope}`),
  /** How every teammate and template was used, from the huddles on every board. */
  teamUsage: () => req<{ teammates: Record<string, TeamUsage>; templates: Record<string, TeamUsage> }>("GET", "/api/team-usage"),
  /** Every huddle on the board (live, stopped and closed). */
  boardHuddles: (slug: string, open = false) => req<Huddle[]>("GET", `${hud(slug)}${open ? "?open=1" : ""}`),
  /** Huddles the ticket hosts or takes part in. */
  huddles: (slug: string, ticketId: string) => req<Huddle[]>("GET", `${hud(slug)}?ticket=${encodeURIComponent(ticketId)}`),
  /** A huddle and its newest messages (`before`: the page before that seq; `since`: the ones after it). */
  huddle: (slug: string, id: string, q: { before?: number; since?: number; limit?: number } = {}) =>
    req<{ huddle: Huddle; you: string; messages: HuddleMessage[]; hasMore: boolean }>("GET",
      `${hud(slug, id)}${query(q)}`),
  /**
   * template: a squad's name (its roster when `roster` is empty, its budget unless given, its rules as the brief).
   * topic: what this run of the squad works on (default: the ticket's title and description).
   */
  startHuddle: (slug: string, ticketId: string, roster: RosterEntry[], maxParticipants?: number, maxCostUsd?: number, template?: string, topic?: string) =>
    req<Huddle>("POST", hud(slug), { ticketId, roster, maxParticipants, maxCostUsd, template, ...(topic?.trim() ? { topic: topic.trim() } : {}) }),
  /** "Save as squad…": Claude writes a generic squad from a huddle (running or closed). Saves nothing; always resolves unless the request fails. */
  genericSquad: (slug: string, id: string) => req<GenericSquadResult>("POST", `${hud(slug, id)}/generic-squad`, {}),
  /**
   * Save a squad (a card's, or edited first): people with no preset become teammates at the same scope (existing ones
   * are used as they are). A squad of the same name: 409 unless replace. card: the card it came from, marked saved.
   */
  saveSquad: (slug: string, squad: SquadDraft, scope: Level, card?: SquadCardRef, replace = false) =>
    req<{ squad: HuddleTemplate; teammates: { created: string[]; reused: string[] } }>("POST", `/api/profiles/${encodeURIComponent(slug)}/squads`,
      { squad, scope, ...(card ? { card } : {}), ...(replace ? { replace } : {}) }),
  setHuddleBrief: (slug: string, id: string, text: string) => req<Huddle>("PUT", `${hud(slug, id)}/brief`, { text }),
  huddleTemplates: (slug: string) => req<HuddleTemplate[]>("GET", `/api/profiles/${encodeURIComponent(slug)}/huddle-templates`),
  saveHuddleTemplate: (slug: string, t: Omit<HuddleTemplate, keyof LayerInfo>, scope: Level) =>
    req<HuddleTemplate>("POST", `/api/profiles/${encodeURIComponent(slug)}/huddle-templates`, { ...t, scope }),
  /** Deletes a template at one level: it falls back to the level below, or goes away. */
  deleteHuddleTemplate: (slug: string, name: string, scope: Level) =>
    req<{ reset: boolean; templates: HuddleTemplate[] }>("DELETE", `/api/profiles/${encodeURIComponent(slug)}/huddle-templates/${encodeURIComponent(name)}?scope=${scope}`),
  postHuddle: (slug: string, id: string, text: string) => req<HuddleMessage>("POST", `${hud(slug, id)}/messages`, { text }),
  addHuddleParticipants: (slug: string, id: string, entry: RosterEntry) =>
    req<{ added: HuddleParticipant[]; huddle: Huddle }>("POST", `${hud(slug, id)}/participants`, entry),
  setHuddleMode: (slug: string, id: string, handle: string, mode: HuddleMode) =>
    req<Huddle>("PATCH", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}`, { mode }),
  stopHuddleParticipant: (slug: string, id: string, handle: string) =>
    req<Huddle>("POST", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}/stop`),
  /** Accept (into the ticket's folder) or reject changes a helper handed in. */
  reviewHandIn: (slug: string, id: string, handInId: string, accept: boolean, reason = "") =>
    req<HandIn>("POST", `${hud(slug, id)}/hand-ins/${encodeURIComponent(handInId)}/${accept ? "accept" : "reject"}`, { reason }),
  /** Let a helper change files: it works in its own copy of the folder and hands its changes in. */
  allowHuddleChanges: (slug: string, id: string, handle: string) =>
    req<HuddleParticipant>("POST", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}/allow-changes`, {}),
  /** A failed or stopped participant is idle again (and wakes now on a live huddle). */
  restartHuddleParticipant: (slug: string, id: string, handle: string) =>
    req<Huddle>("POST", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}/restart`),
  /** resume: addBudgetUsd raises the budget (needed once it is spent). */
  huddleAction: (slug: string, id: string, action: "stop" | "resume" | "close", addBudgetUsd?: number) =>
    req<Huddle>("POST", `${hud(slug, id)}/${action}`, addBudgetUsd ? { addBudgetUsd } : undefined),
  /** A participant's session, read-only: newest steps last (`before`: older page; `since`: every step from that index). */
  huddleSession: (slug: string, id: string, handle: string, q: { before?: number; since?: number; limit?: number } = {}) =>
    req<ParticipantSession>("GET", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}/session${query(q)}`),
  huddleSessionTool: (slug: string, id: string, handle: string, toolUseId: string) =>
    req<ToolDetail>("GET", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}/session/tool/${encodeURIComponent(toolUseId)}`),
  /** Show the participant's transcript file in Finder. */
  revealHuddleSession: (slug: string, id: string, handle: string) =>
    req<{ ok: true; file: string }>("POST", `${hud(slug, id)}/participants/${encodeURIComponent(handle)}/session/reveal`),
  /** The user viewed the huddle up to message seq: the "for you" count clears up to there. */
  huddleSeen: (slug: string, id: string, seq: number) => req<Huddle>("POST", `${hud(slug, id)}/seen`, { seq }),
  /** Change a pending learning (text, scope, where it goes) before saving it. */
  editLearning: (slug: string, id: string, lid: string, patch: Partial<Pick<HuddleLearning, "text" | "scope" | "target">>) =>
    req<HuddleLearning>("PATCH", `${hud(slug, id)}/learnings/${encodeURIComponent(lid)}`, patch),
  saveLearning: (slug: string, id: string, lid: string, patch: Partial<Pick<HuddleLearning, "text" | "scope" | "target">> = {}) =>
    req<HuddleLearning>("POST", `${hud(slug, id)}/learnings/${encodeURIComponent(lid)}/save`, patch),
  discardLearning: (slug: string, id: string, lid: string) => req<HuddleLearning>("POST", `${hud(slug, id)}/learnings/${encodeURIComponent(lid)}/discard`, {}),
  /** Every role's notes (general and this board's repo notes); cap: lines per file that go into instructions. */
  /** What the board learned on its own: saved this week, cleaned up, seen once. */
  learned: (slug: string) => req<LearnedView>("GET", `/api/profiles/${encodeURIComponent(slug)}/learned`),
  /** Only how many lessons are new (the Team badge). */
  learnedCount: (slug: string) => req<{ newCount: number }>("GET", `/api/profiles/${encodeURIComponent(slug)}/learned?count=1`),
  /** The user opened the Learned view: the new count goes back to 0. */
  learnedSeen: (slug: string) => req<LearnedView>("POST", `/api/profiles/${encodeURIComponent(slug)}/learned/seen`),
  /** Undo (or redo) a saved lesson or a tidy step. */
  undoLearned: (slug: string, id: string, redo = false) =>
    req<LearnChange>("POST", `/api/profiles/${encodeURIComponent(slug)}/learned/changes/${encodeURIComponent(id)}/${redo ? "redo" : "undo"}`),
  /** A lesson seen once: save it now, drop it, or keep it after a drop. */
  learnedLesson: (slug: string, id: string, act: "save" | "drop" | "keep") =>
    req<LearnCandidate>("POST", `/api/profiles/${encodeURIComponent(slug)}/learned/lessons/${encodeURIComponent(id)}/${act}`),
  huddleNotes: (slug: string) => req<{ notes: HuddleNotes; cap: number }>("GET", `/api/profiles/${encodeURIComponent(slug)}/huddle-notes`),
  setHuddleNotes: (slug: string, role: string, scope: "general" | "repo", notes: HuddleNote[]) =>
    req<HuddleNote[]>("PUT", `/api/profiles/${encodeURIComponent(slug)}/huddle-notes/${encodeURIComponent(role)}/${scope}`, { notes }),
  inviteToHuddle: (slug: string, id: string, ticketId: string) => req<HuddleParticipant>("POST", `${hud(slug, id)}/invite`, { ticketId }),
  huddleFindings: (slug: string, id: string, action: "add" | "resolve", arg: { text?: string; id?: string }) =>
    req<HuddleFinding[]>("POST", `${hud(slug, id)}/findings`, { action, ...arg }),
  /** ticket: in that ticket's copy of the folder (the board folder when it has none). */
  files: (slug: string, path: string, ticket?: string | null) =>
    req<{ path: string; entries: FileEntry[]; more?: number }>("GET", `/api/profiles/${encodeURIComponent(slug)}/files?path=${encodeURIComponent(path)}${inTicket(ticket)}`),
  file: (slug: string, path: string, ticket?: string | null) =>
    req<FileContent>("GET", `/api/profiles/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}${inTicket(ticket)}`),
  ticket: (slug: string, id: string) => req<Ticket>("GET", t(slug, id)),
  /** A page of the board's chats, latest first; next: pass it as `before` for the older ones (null: none left). */
  chats: (slug: string, before?: string | null) =>
    req<{ chats: QuickChat[]; next: string | null }>("GET", `${chatsUrl(slug)}?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  chat1: (slug: string, id: string) => req<QuickChat>("GET", chatsUrl(slug, id)),
  /** A new chat starts with its first message. */
  newChat: (slug: string, text: string) => req<QuickChat>("POST", chatsUrl(slug), { text }),
  chatSend: (slug: string, id: string, text: string) => req<QuickChat>("POST", `${chatsUrl(slug, id)}/messages`, { text }),
  chatStop: (slug: string, id: string) => req<QuickChat>("POST", `${chatsUrl(slug, id)}/stop`, {}),
  chatRename: (slug: string, id: string, title: string) => req<QuickChat>("PATCH", chatsUrl(slug, id), { title }),
  chatDelete: (slug: string, id: string) => req<void>("DELETE", chatsUrl(slug, id)),
  /** partOf: the open feature (or one of its groups) the new ticket joins. */
  chatTicket: (slug: string, id: string, partOf?: string) =>
    req<{ ticket: Ticket; chat: QuickChat }>("POST", `${chatsUrl(slug, id)}/ticket`, partOf ? { partOf } : {}),
  /** Quick chat rewind: the chat only (files are never changed back in quick chats). */
  chatRewindPreview: (slug: string, id: string, uuid: string) =>
    req<{ blocked: string | null; files: null; filesReason: "quick-chat" }>("GET", `${chatsUrl(slug, id)}/rewind?uuid=${encodeURIComponent(uuid)}`),
  chatRewind: (slug: string, id: string, uuid: string) => req<RewindResult>("POST", `${chatsUrl(slug, id)}/rewind`, { uuid }),
  chatRewindUndoState: (slug: string, id: string) => req<RewindUndoState>("GET", `${chatsUrl(slug, id)}/rewind-undo`),
  chatUndoRewind: (slug: string, id: string) => req<UndoRewindResult>("POST", `${chatsUrl(slug, id)}/rewind-undo`, {}),
  /** Fork from here in a quick chat: a new chat "<title> (fork)" ending just before the message. */
  chatFork: (slug: string, id: string, uuid: string) => req<{ id: string; text: string; chat: QuickChat }>("POST", `${chatsUrl(slug, id)}/fork`, { uuid }),
  chatConversation: (slug: string, id: string, before?: number) =>
    req<{ entries: SessionEntry[]; start: number; total: number }>("GET", `${chatsUrl(slug, id)}/conversation${before !== undefined ? `?before=${before}` : ""}`),
  chatTool: (slug: string, id: string, toolUseId: string) => req<ToolDetail>("GET", `${chatsUrl(slug, id)}/tool/${encodeURIComponent(toolUseId)}`),
  chatSimplified: (slug: string, id: string) => req<Record<string, string>>("GET", `${chatsUrl(slug, id)}/simplified`),
  chatSimplify: (slug: string, id: string, uuid: string) => req<{ text: string; cached: boolean }>("POST", `${chatsUrl(slug, id)}/simplify`, { uuid }),
  sessions: (slug: string) => req<ClaudeSession[]>("GET", `/api/profiles/${encodeURIComponent(slug)}/sessions`),
  followUpWork: (slug: string, id: string, input: { title: string; body: string; start?: boolean; important?: boolean }) =>
    req<Ticket>("POST", `${t(slug, id)}/follow-up-work`, input),
  branchTicket: (slug: string, id: string) => req<{ ticket: Ticket; warning: string | null }>("POST", `${t(slug, id)}/branch`),
  /** external: the session is open in a terminal the board can't close (nothing changed). */
  freshSession: (slug: string, id: string) => req<{ ticket: Ticket; external: boolean }>("POST", `${t(slug, id)}/fresh-session`),
  /** "Fresh chat (keeps status)": the next message starts a new Claude session; chat history, status and outputs stay. */
  freshChat: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/fresh-chat`),
  takeOver: (slug: string, id: string) => req<{ ticket: Ticket; external: boolean }>("POST", `${t(slug, id)}/take-over`),
  linkSession: (slug: string, id: string, sessionId: string | null) =>
    req<Ticket>("POST", `${t(slug, id)}/link-session`, { sessionId }),
  outputs: (slug: string, id: string) => req<OutputFile[]>("GET", `${t(slug, id)}/outputs`),
  outputUrl: (slug: string, id: string, name: string) => `${t(slug, id)}/outputs/${name.split("/").map(encodeURIComponent).join("/")}`,
  outputDownloadUrl: (slug: string, id: string, name: string) => `${api.outputUrl(slug, id, name)}?download=1`,
  /** Share menu: reveal in Finder, copy the file to the clipboard, or start publishing it as a claude.ai page. */
  outputAction: (slug: string, id: string, name: string, action: "reveal" | "copy" | "publish") =>
    req<unknown>("POST", `${api.outputUrl(slug, id, name)}?action=${action}`),
  outputText: async (slug: string, id: string, name: string) => {
    const r = await fetch(api.outputUrl(slug, id, name));
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.text();
  },
  /** Which of these file paths (as written in a chat message) exist in the ticket's folders. */
  findFiles: (slug: string, id: string, paths: string[]) =>
    req<{ found: Record<string, { root: FileRootName; rel: string }> }>("POST", `${t(slug, id)}/find-files`, { paths }),
  ticketFile: (slug: string, id: string, path: string) =>
    req<TicketFile>("GET", `${t(slug, id)}/file?path=${encodeURIComponent(path)}`),
  ticketFileUrl: (slug: string, id: string, path: string, download = false) =>
    `${t(slug, id)}/file?raw=1${download ? "&download=1" : ""}&path=${encodeURIComponent(path)}`,
  createTicket: (slug: string, input: {
    title: string; body: string; status: Status; sessionId?: string; mode?: TicketMode; parentId?: string; planKey?: string; dependsOn?: string[];
    needs?: string[]; tags?: string[]; important?: boolean; proposedAs?: string; partOf?: string; kind?: TicketKind;
    /** This ticket's model and effort (left out = board default). */
    model?: string; effort?: string;
  }) => req<Ticket>("POST", t(slug), input),
  /** The feature's "Where we are" status (on any ticket of its family). */
  featureStatus: (slug: string, id: string) => req<FeatureStatus>("GET", `${t(slug, id)}/status`),
  /** "Add a note": saved in the status; the main chat gets it at its next turn. */
  addStatusNote: (slug: string, id: string, text: string) => req<FeatureStatus>("POST", `${t(slug, id)}/status/notes`, { text }),
  /** The Family tab's rows: each ticket's model, cost, state and last summary. */
  familyView: (slug: string, id: string) => req<FamilyViewRow[]>("GET", `${t(slug, id)}/family-view`),
  /** Gather tickets into the feature: each under one of its groups, a new group ("new"), or the feature itself. */
  gather: (slug: string, id: string, tickets: { id: string; group: string | null }[], newGroup: string | null) =>
    req<{ gathered: Ticket[]; movedUp: { id: string; title: string; to: string }[]; skipped: { id: string; reason: string }[]; group: Ticket | null }>(
      "POST", `${t(slug, id)}/gather`, { tickets, newGroup }),
  plan: (slug: string, id: string, action: "start" | "pause" | "resume" | "done") =>
    req<Ticket>("POST", `${t(slug, id)}/plan`, { action }),
  updateTicket: (slug: string, id: string, patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order" | "mode" | "notice" | "needs" | "tags" | "suggestedTags" | "important" | "runCapUsd" | "model" | "effort" | "ultracode" | "chrome" | "browsers">> & { expectedBody?: string; pinned?: boolean; freshChat?: boolean }) =>
    req<Ticket>("PATCH", t(slug, id), patch),
  deleteTicket: (slug: string, id: string) => req<void>("DELETE", t(slug, id)),
  /** Part of parent's family (null unlinks). */
  setPartOf: (slug: string, id: string, parent: string | null) => req<Ticket>("PATCH", t(slug, id), { partOf: parent }),
  /** "Show on board" for a task: it gets a card (true) or lives in its feature only again (false). */
  setShowOnBoard: (slug: string, id: string, on: boolean) => req<Ticket>("PATCH", t(slug, id), { showOnBoard: on }),
  /** "Make it its own work": a task becomes its own main ticket (a sub-feature while it stays linked). */
  makeOwnWork: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/own-work`),
  /** Not related: the board doesn't suggest a parent for this ticket again. */
  dismissParentSuggestion: (slug: string, id: string) => req<Ticket>("PATCH", t(slug, id), { parentSuggestion: null }),
  /** Find links: Claude's suggested parents for tickets without one (nothing changes until each is set). */
  findLinks: (slug: string) =>
    req<{ links: { id: string; parent: string; reason: string }[]; checked: number }>("POST", `/api/profiles/${encodeURIComponent(slug)}/find-links`, {}),
  /** Send a Backlog ticket to another board; returns the new ticket there. */
  moveTicketToBoard: (slug: string, id: string, board: string) => req<Ticket>("POST", `${t(slug, id)}/move`, { board }),
  /** Inbox Snooze: hide what the ticket waits for now for a day (or until its state changes). */
  followUpNow: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/follow-up/now`, {}),
  stopFollowUp: (slug: string, id: string) => req<Ticket>("DELETE", `${t(slug, id)}/follow-up`, {}),
  markSeen: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/seen`, {}),
  /** body: {} for a day, { hours } (a week: 168), { forever: true } until unsnoozed (snoozeBody in snooze.ts). */
  snooze: (slug: string, id: string, body: Record<string, unknown> = {}) => req<Ticket>("POST", `${t(slug, id)}/snooze`, body),
  unsnooze: (slug: string, id: string) => req<Ticket>("DELETE", `${t(slug, id)}/snooze`),
  /** The user answered a schedule delete card: deleted deletes the schedule, kept keeps it. */
  answerHelperRuleCard: (slug: string, id: string, uuid: string, answer: { state: "added"; text: string } | { state: "dismissed" }) =>
    req<Ticket>("PUT", `${t(slug, id)}/helper-rule-cards/${encodeURIComponent(uuid)}`, answer),
  answerScheduleDeleteCard: (slug: string, id: string, uuid: string, answer: { state: "deleted"; scheduleId: string } | { state: "kept" }) =>
    req<Ticket>("PUT", `${t(slug, id)}/schedule-delete-cards/${encodeURIComponent(uuid)}`, answer),
  /** The user answered a teammate card (saved it, or dismissed it). */
  answerTeammateCard: (slug: string, id: string, uuid: string, card: Omit<TeammateCardState, "at">) =>
    req<Ticket>("PUT", `${t(slug, id)}/teammate-cards/${encodeURIComponent(uuid)}`, card),
  /** Close question: the form closes without sending anything to Claude, and stops waiting on the user. */
  closeForm: (slug: string, id: string, uuid: string) => req<Ticket>("PUT", `${t(slug, id)}/closed-forms/${encodeURIComponent(uuid)}`, {}),
  /** The user dismissed a squad card (saving goes through saveSquad with the card). */
  answerSquadCard: (slug: string, id: string, uuid: string, card: Omit<SquadCardState, "at" | "teammates">) =>
    req<Ticket>("PUT", `${t(slug, id)}/squad-cards/${encodeURIComponent(uuid)}`, card),
  comments: (slug: string, id: string) => req<Comment[]>("GET", `${t(slug, id)}/comments`),
  addComment: (slug: string, id: string, text: string) => req<Comment>("POST", `${t(slug, id)}/comments`, { text }),
  diff: (slug: string, id: string, ignoreWhitespace: boolean) =>
    req<TicketDiff>("GET", `${t(slug, id)}/diff${ignoreWhitespace ? "?w=1" : ""}`),
  /** fresh: "Send in a fresh chat" (the old chat stays visible, Claude no longer sees it). */
  chat: (slug: string, id: string, text: string, fresh?: boolean) => req<Ticket>("POST", `${t(slug, id)}/chat`, fresh ? { text, fresh } : { text }),
  sendQueued: (slug: string, id: string, msgId: string) => req<Ticket>("POST", `${t(slug, id)}/queued/${msgId}`),
  discardQueued: (slug: string, id: string, msgId: string) => req<Ticket>("DELETE", `${t(slug, id)}/queued/${msgId}`),
  editQueued: (slug: string, id: string, msgId: string, text: string) => req<Ticket>("PATCH", `${t(slug, id)}/queued/${msgId}`, { text }),
  conversation: (slug: string, id: string, before?: number) =>
    req<{ entries: SessionEntry[]; start: number; total: number; title: string | null }>(
      "GET", `${t(slug, id)}/conversation${before !== undefined ? `?before=${before}` : ""}`),
  /** Rewind: what going back to one of the user's messages would change (files null: they can't be changed back, filesReason says why). */
  rewindPreview: (slug: string, id: string, uuid: string) =>
    req<{ blocked: string | null; files: { path: string; status: "A" | "D" | "M" }[] | null; filesReason: "no-history" | "no-snapshot" | null }>(
      "GET", `${t(slug, id)}/rewind?uuid=${encodeURIComponent(uuid)}`),
  /** Rewind: cut the chat before the message and, with files, put the project files back. Returns the message text. */
  rewind: (slug: string, id: string, uuid: string, files: boolean) =>
    req<RewindResult>("POST", `${t(slug, id)}/rewind`, { uuid, files }),
  /** Undo rewind: can the last rewind be put back (blocked says why not; files false: asking about the chat only). */
  rewindUndoState: (slug: string, id: string, files = true) =>
    req<RewindUndoState>("GET", `${t(slug, id)}/rewind-undo${files ? "" : "?files=0"}`),
  /** Undo rewind: the chat, and with files the project files, come back as they were just before the last rewind. */
  undoRewind: (slug: string, id: string, files = true) => req<UndoRewindResult>("POST", `${t(slug, id)}/rewind-undo`, { files }),
  /** Fork from here: a new ticket (own card, like Branch) whose chat ends just before the message; text goes in its box. */
  forkTicket: (slug: string, id: string, uuid: string) =>
    req<{ id: string; text: string; ticket: Ticket; warning: string | null }>("POST", `${t(slug, id)}/fork`, { uuid }),
  /** Saved plain-words versions of the ticket's Claude replies, by message uuid. */
  simplified: (slug: string, id: string) => req<Record<string, string>>("GET", `${t(slug, id)}/simplified`),
  /** "Say it simpler": one reply rewritten in plain words (a side call; saved, so the second time is free). */
  simplify: (slug: string, id: string, uuid: string) => req<{ text: string; cached: boolean }>("POST", `${t(slug, id)}/simplify`, { uuid }),
  /** "Help me understand": saved answer cards, the kinds being answered, and whether a recap has anything to tell. */
  help: (slug: string, id: string) => req<{ cards: HelpCard[]; busy: HelpKind[]; recap: boolean }>("GET", `${t(slug, id)}/help`),
  /** A new "Help me understand" answer (a side call reading the ticket; its cost goes on the ticket). */
  askHelp: (slug: string, id: string, kind: HelpKind) => req<HelpCard>("POST", `${t(slug, id)}/help`, { kind }),
  /** One subagent of the ticket's conversation, with all of its steps. */
  agent: (slug: string, id: string, toolUseId: string) => req<AgentInfo>("GET", `${t(slug, id)}/agent/${encodeURIComponent(toolUseId)}`),
  /** A workflow's script ("Show script"). */
  workflowScript: (slug: string, id: string, toolUseId: string) => req<{ script: string }>("GET", `${t(slug, id)}/workflow/${encodeURIComponent(toolUseId)}/script`),
  /** One helper agent of a workflow, with all of its steps and its result. */
  workflowAgent: (slug: string, id: string, toolUseId: string, agentId: string) =>
    req<WorkflowAgentDetail>("GET", `${t(slug, id)}/workflow/${encodeURIComponent(toolUseId)}/agent/${encodeURIComponent(agentId)}`),
  /** Stop a running workflow; when Claude Code can't stop just the workflow, the whole run stops ("run"). */
  stopWorkflow: (slug: string, id: string, toolUseId: string) =>
    req<{ stopped: "workflow" | "run"; error?: string }>("POST", `${t(slug, id)}/workflow/${encodeURIComponent(toolUseId)}/stop`),
  /** A tool call's full input and output (main conversation or a subagent's). */
  tool: (slug: string, id: string, toolUseId: string) => req<ToolDetail>("GET", `${t(slug, id)}/tool/${encodeURIComponent(toolUseId)}`),
  /** What `/` can run in this ticket's chat (skills, custom commands, built-ins). */
  commands: (slug: string, id: string) => req<SlashCommand[]>("GET", `${t(slug, id)}/commands`),
  /** Skills and commands in the board's folder: the `/` picker of descriptions not tied to a ticket yet. */
  boardCommands: (slug: string) => req<SlashCommand[]>("GET", `/api/profiles/${slug}/commands`),
  /** The activity log's newest page; pass the answer's `before` back for the page before it (null: reached the start). */
  activity: (slug: string, id: string, before?: number) =>
    req<{ entries: ActivityEntry[]; before: number | null }>("GET", `${t(slug, id)}/activity${before === undefined ? "" : `?before=${before}`}`),
  /** Cost, tokens and ≈ share of the 5h plan window per run. */
  ticketUsage: (slug: string, id: string) => req<TicketUsage>("GET", `${t(slug, id)}/usage`),
  /** The Context panel (GET: the last check, POST: check now; answered once the check is over). */
  ticketContext: (slug: string, id: string, check = false) => req<ContextView>(check ? "POST" : "GET", `${t(slug, id)}/context`),
  chatContext: (slug: string, id: string, check = false) => req<ContextView>(check ? "POST" : "GET", `${chatsUrl(slug, id)}/context`),
  inbox: () => req<InboxItem[]>("GET", "/api/inbox"),
  /** ⌘K: every ticket that isn't Done, on every board. */
  openTickets: () => req<TicketRow[]>("GET", "/api/tickets?scope=open"),
  /** ⌘K: the Done tickets on every board that best match q (board: the one the user is on, first on ties). */
  findDoneTickets: (q: string, board: string | null) =>
    req<TicketRow[]>("GET", `/api/tickets?scope=done&limit=20&q=${encodeURIComponent(q)}${board ? `&board=${encodeURIComponent(board)}` : ""}`),
  snippets: (slug: string) => req<Snippet[]>("GET", `/api/snippets?profile=${encodeURIComponent(slug)}`),
  createSnippet: (input: SnippetInput) => req<Snippet>("POST", "/api/snippets", input),
  updateSnippet: (id: string, patch: Partial<SnippetInput>) => req<Snippet>("PATCH", `/api/snippets/${encodeURIComponent(id)}`, patch),
  deleteSnippet: (id: string) => req<void>("DELETE", `/api/snippets/${encodeURIComponent(id)}`),
  passes: () => req<{ passes: Pass[]; automations: number }>("GET", "/api/passes"),
  addPass: (input: { kind: Pass["kind"]; name?: string; claudeName?: string | null; url?: string; envName?: string; secret?: string; board?: string }) =>
    req<Pass>("POST", "/api/passes", input),
  replacePassKey: (id: string, secret: string) => req<Pass>("PATCH", `/api/passes/${encodeURIComponent(id)}`, { secret }),
  deletePass: (id: string) => req<void>("DELETE", `/api/passes/${encodeURIComponent(id)}`),
  authorizePass: (id: string) => req<{ url: string }>("POST", `/api/passes/${encodeURIComponent(id)}/authorize`),
  testLoop: (slug: string, script: string, passes: string[]) => req<LoopTest>("POST", `${lp(slug)}/test`, { script, passes }),
  automationSetup: (slug: string) => req<Ticket>("POST", `/api/profiles/${encodeURIComponent(slug)}/automation-setup`),
  /** Schedules → Proactive check-ins: a Planning chat that sets up a quiet check-in schedule. */
  checkinSetup: (slug: string) => req<Ticket>("POST", `/api/profiles/${encodeURIComponent(slug)}/checkin-setup`),
  /** A key box's Save ({ keys: { NAME: value } }) or "I'll do it myself" ({ self: true }). */
  answerKeyCard: (slug: string, ticketId: string, uuid: string, answer: { keys: Record<string, string> } | { self: true }) =>
    req<Ticket>("POST", `/api/profiles/${encodeURIComponent(slug)}/tickets/${encodeURIComponent(ticketId)}/key-cards/${encodeURIComponent(uuid)}`, answer),
  answerAutomationCard: (slug: string, ticketId: string, uuid: string, loopId: string) =>
    req<Ticket>("PUT", `/api/profiles/${encodeURIComponent(slug)}/tickets/${encodeURIComponent(ticketId)}/automation-cards/${encodeURIComponent(uuid)}`, { loopId }),
  loops: (slug: string) => req<Loop[]>("GET", lp(slug)),
  createLoop: (slug: string, input: LoopInput) => req<Loop>("POST", lp(slug), input),
  updateLoop: (slug: string, id: string, patch: Partial<LoopInput>) => req<Loop>("PATCH", lp(slug, id), patch),
  deleteLoop: (slug: string, id: string) => req<void>("DELETE", lp(slug, id)),
  checkLoop: (slug: string, id: string) => req<Loop>("POST", `${lp(slug, id)}/check`),
  copyLoop: (slug: string, id: string, to: string) => req<Loop>("POST", `${lp(slug, id)}/copy`, { to }),
  schedules: (slug: string) => req<Schedule[]>("GET", sch(slug)),
  createSchedule: (slug: string, input: ScheduleInput) => req<Schedule>("POST", sch(slug), input),
  updateSchedule: (slug: string, id: string, patch: Partial<ScheduleInput & { enabled: boolean }>) => req<Schedule>("PATCH", sch(slug, id), patch),
  deleteSchedule: (slug: string, id: string) => req<void>("DELETE", sch(slug, id)),
  runSchedule: (slug: string, id: string) => req<{ entry: ScheduleHistoryItem; schedule: Schedule }>("POST", `${sch(slug, id)}/run`),
  scheduleHistory: (slug: string, id: string) => req<ScheduleHistoryItem[]>("GET", `${sch(slug, id)}/history`),
  /** Upcoming jobs plus every one that finished in the last 7 days. */
  jobs: (slug: string) => req<Job[]>("GET", `${jb(slug)}?finishedDays=7`),
  /** at: local "YYYY-MM-DDTHH:MM" (this computer's time). */
  updateJob: (slug: string, id: string, patch: { name?: string; at?: string }) => req<Job>("PATCH", jb(slug, id), patch),
  cancelJob: (slug: string, id: string) => req<Job>("POST", `${jb(slug, id)}/cancel`),
  runJobNow: (slug: string, id: string) => req<Job>("POST", `${jb(slug, id)}/run`),
  cronPreview: (expr: string) => req<CronPreview>("GET", `/api/cron/preview?expr=${encodeURIComponent(expr)}`),
  mcp: () => req<McpState>("GET", "/api/mcp"),
  mcpRefresh: () => req<McpState>("POST", "/api/mcp/refresh"),
  mcpAdd: (input: McpAddInput) => req<McpState>("POST", "/api/mcp", input),
  mcpRemove: (name: string, board?: string) => req<McpState>("DELETE", `/api/mcp/${encodeURIComponent(name)}${board ? `?board=${encodeURIComponent(board)}` : ""}`),
  mcpMove: (name: string, to: "board" | "all", board: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/move`, { to, board }),
  mcpRetryMove: (name: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/retry-move`),
  mcpLogin: (name: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/login`),
  mcpLoginPaste: (name: string, text: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/login-paste`, { text }),
  mcpCancelLogin: (name: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/cancel-login`),
  mcpLogout: (name: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/logout`),
  mcpRecheck: (name: string) => req<McpState>("POST", `/api/mcp/${encodeURIComponent(name)}/recheck`),
  mcpConfig: (name: string, board?: string) => req<McpConfig>("GET", `/api/mcp/${encodeURIComponent(name)}/config${board ? `?board=${encodeURIComponent(board)}` : ""}`),
  mcpUpdate: (name: string, input: McpAddInput) => req<McpState>("PUT", `/api/mcp/${encodeURIComponent(name)}`, input),
  agents: () => req<AgentStatus[]>("GET", "/api/agents"),
  agentInstall: (id: AgentStatus["id"]) => req<AgentStatus[]>("POST", `/api/agents/${id}/install`),
  agentUninstall: (id: AgentStatus["id"]) => req<AgentStatus[]>("POST", `/api/agents/${id}/uninstall`),
  openFile: (slug: string, path: string, ticket?: string | null) =>
    req<{ ok: true }>("POST", `/api/profiles/${encodeURIComponent(slug)}/open-file`, ticket ? { path, ticket } : { path }),
  stop: (slug: string, id: string) => req<{ stopped: boolean }>("POST", `${t(slug, id)}/stop`).then((r) => {
    if (!r.stopped) throw new Error("Claude is not running on this ticket.");
    return r;
  }),
  checkPr: (slug: string, id: string) => req<{ state: string | null }>("POST", `${t(slug, id)}/check-pr`),
  /** force: skip the server's 30s reuse of a fresh status. */
  prRefresh: (slug: string, id: string, force = false) => req<{ pr: PrStatus | null; ticket: Ticket }>("POST", `${t(slug, id)}/pr/refresh`, { force }),
  prSendFailures: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/pr/send-failures`),
  prResolveConflicts: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/pr/resolve-conflicts`),
  prMerge: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/pr/merge`),
  /** Stalled run: stop it, keep waiting, or restart it in the same session. */
  stall: (slug: string, id: string, action: "stop" | "wait" | "restart") => req<Ticket>("POST", `${t(slug, id)}/stall`, { action }),
  /** Usage limit: send "continue" now. */
  /** "Continue with +$Y" after a run stopped at its spending cap. */
  capContinue: (slug: string, id: string, addUsd: number) => req<Ticket>("POST", `${t(slug, id)}/cap-continue`, { addUsd }),
  limitContinue: (slug: string, id: string) => req<Ticket>("POST", `${t(slug, id)}/limit`, { action: "continue" }),
  /** Usage limit: turn the automatic continue at the reset on or off for this ticket. */
  limitAuto: (slug: string, id: string, auto: boolean) => req<Ticket>("POST", `${t(slug, id)}/limit`, { auto }),
  planningCommand: (slug: string, id: string) => req<{ command: string }>("POST", `${t(slug, id)}/planning-command`),
  /** Raw image bytes; the server saves them and returns the URL to put in markdown. */
  /** Images go up with their type; other files as bytes with their name (the server checks both). */
  uploadAttachment: async (file: File, signal?: AbortSignal) => {
    const headers: Record<string, string> = isImageFile(file)
      ? { "content-type": file.type }
      : { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) };
    const r = await fetch("/api/attachments", { method: "POST", headers, body: file, signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as any).error ?? `${r.status} ${r.statusText}`);
    return data as { url: string; path: string };
  },
  /** Size of a stored attachment, fetched once per file (file cards show it). */
  attachmentSize: (stored: string): Promise<number | null> => {
    let p = sizes.get(stored);
    if (!p) {
      p = fetch(`/api/attachments/${stored}/info`).then((r) => (r.ok ? r.json() : null)).then((d: any) => d?.size ?? null, () => null);
      sizes.set(stored, p);
    }
    return p;
  },
};
