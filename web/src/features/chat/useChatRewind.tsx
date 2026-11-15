import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { api, type QueuedMessage, type RewindResult, type SessionEntry, type Ticket } from "../../lib/api";
import { undoFromRewind, undoFromState, type UndoInfo } from "./MessageActions";
import { draftAfterUndo } from "./messageText";
import { restoredDraft, rewindOff } from "../ticket/rewindText";
import { browserStore, draftKey, save } from "../../lib/drafts";
import { toast } from "../../components/toast";

/** Chat's rewind, Undo rewind and Fork from here (moved from Chat.tsx). */
export function useChatRewind({ composer, draft, onFilesChanged, onOpenTicket, queued, reload, running, setDraft, setPage, slug, stickToBottom, ticket }: {
  composer: RefObject<HTMLTextAreaElement>;
  draft: string;
  onFilesChanged: (() => void) | undefined;
  onOpenTicket: (id: string) => void;
  queued: QueuedMessage[];
  reload: () => void;
  running: boolean;
  setDraft: (next: string | ((prev: string) => string)) => void;
  setPage: Dispatch<SetStateAction<{ entries: SessionEntry[]; start: number; } | null>>;
  slug: string;
  stickToBottom: MutableRefObject<boolean>;
  ticket: Ticket;
}) {
  // Fork from here, Rewind and Undo rewind wait while Claude works or a message waits to be sent.
  const actionsOff = rewindOff(running, queued.length);
  // The last rewind while it can be undone (the Undo bar under the chat), and what the last Undo did.
  const [undo, setUndo] = useState<UndoInfo | null>(null);
  const [undone, setUndone] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Opening the chat: a rewind that can still be undone (nothing sent or run since) shows its bar again.
  useEffect(() => {
    setUndo(null);
    setUndone(null);
    if (running) return;
    let live = true;
    api.rewindUndoState(slug, ticket.id, false).then((s) => live && setUndo((u) => u ?? undoFromState(s)), () => {});
    return () => {
      live = false;
    };
  }, [slug, ticket.id]);
  // A run starting (the user's message or the board's) ends the chance to undo.
  useEffect(() => {
    if (!running) return;
    setUndo(null);
    setUndone(null);
  }, [running]);
  const rewound = (r: RewindResult) => {
    const before = draftRef.current;
    const filled = restoredDraft(r.text, before);
    setDraft(filled);
    setUndone(null);
    setUndo(r.undo ? undoFromRewind(r, filled, before) : null);
    stickToBottom.current = true;
    setPage(null);
    reload();
    onFilesChanged?.();
    composer.current?.focus();
  };
  const undoRewound = (r: { files: number }, line: string) => {
    const d = undo?.draft;
    if (d) setDraft((cur) => draftAfterUndo(cur, d.filled, d.before));
    setUndo(null);
    setUndone(line);
    stickToBottom.current = true;
    setPage(null);
    reload();
    if (r.files) onFilesChanged?.();
  };
  // Fork from here: a new ticket whose chat ends before the message; the message waits in its box.
  const forkFrom = async (uuid: string) => {
    const r = await api.forkTicket(slug, ticket.id, uuid);
    save(browserStore(), draftKey(slug, r.id), r.text);
    onOpenTicket(r.id);
    toast(r.warning ? <>Forked into <b>{r.ticket.title}</b>. {r.warning}</> : <>Forked into <b>{r.ticket.title}</b></>,
      { tone: r.warning ? "info" : "ok", ...(r.warning ? { ms: 9000 } : {}) });
    return `Forked into "${r.ticket.title}". It is open now.`;
  };
  return { actionsOff, forkFrom, rewound, setUndo, setUndone, undo, undoRewound, undone };
}
