import { useEffect, useMemo, useRef, useState } from "react";
import { api, NotStarted, type Level, type NewTicketDraft, type Proposal, type SessionEntry, type TeammateProposal, type Ticket } from "../../lib/api";
import { usePresets } from "../huddle/HuddleRoster";
import { createdFromDraft } from "../board/proposalMatch";
import { followUpFor, followUpPlace, followUpState } from "../ticket/followUp";
import { parentLink } from "../family/family";
import { type FollowUp } from "../family/ProposalCard";
import { askClosed } from "../family/family";
import { type Pending } from "../../lib/pendingBubbles";
import { type FormState, formStates } from "../ticket/questionForms";
import { canStartFromProposal } from "../../app/keynav";
import { toast } from "../../components/toast";
import { laterCounts } from "./chatMemo";

export function useChatForms({ entries, onError, onOpenTicket, onPendingProposal, pending, running, slug, ticket, tickets }: {
  entries: SessionEntry[];
  onError: (m: string) => void;
  onOpenTicket: (id: string) => void;
  onPendingProposal: ((apply: ((start: boolean) => Promise<void>) | null) => void) | undefined;
  pending: Pending[];
  running: boolean;
  slug: string;
  ticket: Ticket;
  tickets: Ticket[];
}) {
  // A reply still on its way to the session file counts too, so the form doesn't offer "Send answers" again.
  const replying = pending.some((p) => !p.steer);
  // Board updates (kind "board") never answer: a form they interrupt stays open, or is asked again below.
  // "N later messages" and "answered after" for every message in one pass (a long chat has thousands loaded).
  const counts = useMemo(() => laterCounts(entries), [entries]);
  const answeredAfter = (index: number) => replying || counts.lastAnswer > index;
  // Forms the user closed without answering (Close question), by uuid; the newest open one also when the ticket only
  // knows a close came after its last run (it closed by itself when they answered in its task's chat).
  const closedIds = useMemo(() => new Set(Object.keys(ticket.closedForms ?? {})), [ticket.closedForms]);
  const closeLatest = !running && askClosed(ticket);
  const forms = useMemo(() => formStates(entries, replying, closedIds, closeLatest), [entries, replying, closedIds, closeLatest]);
  /** The message that answered form index: in the chat, or still on its way. */
  const answerOf = (index: number): string | undefined => {
    const f = formState(index);
    if (f.state !== "answered") return undefined;
    return f.by !== undefined ? entries[f.by]?.text : pending.find((p) => !p.steer)?.text;
  };
  const closeForm = (uuid: string) => api.closeForm(slug, ticket.id, uuid).catch((err: Error) => onError(err.message));
  const formState = (index: number): FormState => forms.get(index) ?? { state: "answered" };
  const replacedBy = (index: number) => { const f = formState(index); return f.state === "replaced" ? f : undefined; };
  /** Where an open form saves its progress: shared with the earlier forms it asks again. */
  const openKey = (index: number) => { const f = formState(index); return f.state === "open" ? f.key : undefined; };
  const isApplied = (p: Proposal) =>
    (!p.title || p.title === ticket.title) && (!p.description || p.description.trim() === ticket.body.trim()) && (!p.important || !!ticket.important) &&
    (p.partOf === undefined || (parentLink(ticket)?.id ?? null) === p.partOf);
  /** What Apply does to the ticket's family, for the card; undefined when the proposal leaves it as it is. */
  const familyNote = (p: Proposal) => {
    if (p.partOf === undefined || (parentLink(ticket)?.id ?? null) === p.partOf) return undefined;
    if (p.partOf === null) return "Apply also takes this ticket out of the work it is part of, so it is no longer one of its tasks.";
    const to = tickets.find((t) => t.id === p.partOf);
    return to ? `Apply also moves this ticket under “${to.title}”.` : undefined;
  };

  // The ticket a proposed draft became: this ticket's child with its key or proposed title (still found after a rename),
  // else any ticket on the board with that title, which counts as handled too (the server's attention rule).
  // A questions form still waits for answers: the message box offers a note instead of a second way to answer.
  const formWaiting = [...forms.values()].some((f) => f.state === "open");
  const childFor = (d: NewTicketDraft) => createdFromDraft(tickets, ticket.id, d);
  const createChild = async (d: NewTicketDraft) => {
    try {
      return await api.createTicket(slug, {
        title: d.title, body: d.description, status: "backlog", mode: "interview", parentId: ticket.id, proposedAs: d.title,
        ...(d.key ? { planKey: d.key } : {}), ...(d.dependsOn?.length ? { dependsOn: d.dependsOn } : {}),
        ...(d.needs?.length ? { needs: d.needs } : {}), ...(d.tags?.length ? { tags: d.tags } : {}), ...(d.important ? { important: true } : {}),
      });
    } catch (err: any) {
      onError(err.message);
      return null;
    }
  };

  // Proposals applied with "Apply & start work" here, so their card says the ticket moved on.
  const [startedProposals, setStartedProposals] = useState<ReadonlySet<string>>(new Set());
  // An already-planned main ticket's card offers "Apply & start work" too: moving it to Ready is the go-ahead for its plan
  // (the user asked for it after finding only Apply there; plain Apply still never starts anything).
  const canStart = canStartFromProposal({ status: ticket.status, working: ticket.status === "in_progress" || running });
  const applyProposal = async (p: Proposal, start?: { uuid: string }) => {
    const before = { title: ticket.title, body: ticket.body, important: !!ticket.important };
    try {
      // The family move first: when it can't be made (a plan sibling depends on it), nothing changes.
      if (familyNote(p)) await api.setPartOf(slug, ticket.id, p.partOf!);
      // One update, so the ticket never sits in Ready with the old text.
      await api.updateTicket(slug, ticket.id, {
        ...(p.title ? { title: p.title } : {}),
        ...(p.description ? { body: p.description } : {}),
        ...(p.important ? { important: true } : {}),
        ...(start ? { status: "ready" as const } : {}),
      });
      // No Undo once it starts: Claude may already be working from the new text.
      if (start) {
        setStartedProposals((s) => new Set(s).add(start.uuid));
        return void toast("Applied to the ticket and moved to Ready", { tone: "ok" });
      }
      toast("Applied to the ticket", {
        tone: "ok",
        action: {
          label: "Undo",
          run: () => api.updateTicket(slug, ticket.id, before).catch((err) => toast(`Undo failed: ${err.message}`, { tone: "error" })),
        },
      });
    } catch (err: any) {
      // Start was cancelled (a huddle works on the ticket): still apply the text, without starting.
      if (start && err instanceof NotStarted) return applyProposal(p);
      onError(err.message);
    }
  };

  // Teammate cards: the board's teammates tell a new one from a change; reloaded after each save.
  const [presetsVersion, setPresetsVersion] = useState(0);
  const presets = usePresets(slug, presetsVersion);
  const saveTeammate = async (uuid: string, p: TeammateProposal, scope: Level) => {
    try {
      const { why: _w, ...fields } = p;
      const saved = await api.saveHuddlePreset(slug, fields, scope);
      await api.answerTeammateCard(slug, ticket.id, uuid, { state: "saved", name: saved.name, scope });
      setPresetsVersion((n) => n + 1);
    } catch (err: any) {
      onError(err.message);
    }
  };
  const dismissTeammate = (uuid: string) => api.answerTeammateCard(slug, ticket.id, uuid, { state: "dismissed" }).then(() => {}, (err) => onError(err.message));

  // A plain ticket that already ran: proposals are follow-up work (a step of its feature, or its first step as it becomes
  // a main ticket), so this one keeps its title and description and the user keeps talking here.
  const onState = followUpState(ticket);
  const place = onState === undefined ? null : followUpPlace(tickets, ticket.id);
  const startFollowUp = async (p: Proposal, start: boolean) => {
    try {
      const f = await api.followUpWork(slug, ticket.id, { title: p.title, body: p.description, start, ...(p.important ? { important: true } : {}) });
      const runner = place?.as === "step" ? tickets.find((t) => t.id === place.manager) : place?.as === "main" ? ticket : undefined;
      const where = runner?.plan?.state === "paused" ? "Step added; it waits until you press Resume on the Plan tab"
        : place?.as === "step" ? "Step started; follow it on the feature's card"
        : place?.as === "main" ? "Step started; you keep talking here"
        : start ? "Ticket created and moved to Ready" : "Ticket created in Backlog";
      toast(where, { tone: "ok", ...(place?.as === "ticket" ? { action: { label: "Open", run: () => onOpenTicket(f.id) } } : {}) });
    } catch (err: any) {
      onError(err.message);
    }
  };
  const followUpOf = (p: Proposal): FollowUp | undefined => {
    const created = followUpFor(tickets, ticket.id, p.title);
    // A card that already started its work keeps saying so, also after it made this ticket a main ticket (its Apply
    // would otherwise overwrite the new main ticket's title and description).
    const at = place ?? (created ? followUpPlace(tickets, ticket.id) : null);
    if (!at || (onState === undefined && !created)) return undefined;
    return { state: onState ?? null, place: at, created, onCreate: (start) => startFollowUp(p, start), onOpen: onOpenTicket };
  };

  const pendingProposal = entries.findLast((e) => e.proposal && !isApplied(e.proposal) && !followUpFor(tickets, ticket.id, e.proposal.title));
  const applyPendingRef = useRef((_start: boolean) => Promise.resolve());
  applyPendingRef.current = (start) => (!pendingProposal?.proposal ? Promise.resolve()
    // ⌘⇧Enter on a follow-up card: start that work.
    : place ? startFollowUp(pendingProposal.proposal, true)
    : applyProposal(pendingProposal.proposal, start && canStart ? { uuid: pendingProposal.uuid } : undefined));
  useEffect(() => {
    onPendingProposal?.(pendingProposal ? (start) => applyPendingRef.current(start) : null);
  }, [pendingProposal?.uuid]);
  useEffect(() => () => onPendingProposal?.(null), []);
  return { answerOf, answeredAfter, applyProposal, canStart, childFor, closeForm, counts, createChild, dismissTeammate, familyNote, followUpOf, formState, formWaiting, forms, isApplied, openKey, pendingProposal, presets, replacedBy, saveTeammate, setPresetsVersion, startedProposals };
}
