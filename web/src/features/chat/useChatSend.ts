import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { useImagePaste } from "../../lib/imagePaste";
import { api, type Ticket } from "../../lib/api";
import { oldChat } from "./cacheNote";
import { type UndoInfo } from "./MessageActions";
import { messageCommand, type SlashCommand } from "./slashText";
import { type Pending } from "../../lib/pendingBubbles";
import { capMap } from "./chatMemo";
import { oldChatOk, OLD_CHAT_OK_MAX } from "./ChatParts";

export function useChatSend({ commands, draft, images, onError, running, setDraft, setPending, setUndo, setUndone, slug, stickToBottom, stopping, ticket }: {
  commands: SlashCommand[] | null;
  draft: string;
  images: ReturnType<typeof useImagePaste>;
  onError: (m: string) => void;
  running: boolean;
  setDraft: (next: string | ((prev: string) => string)) => void;
  setPending: Dispatch<SetStateAction<Pending[]>>;
  setUndo: Dispatch<SetStateAction<UndoInfo | null>>;
  setUndone: Dispatch<SetStateAction<string | null>>;
  slug: string;
  stickToBottom: MutableRefObject<boolean>;
  stopping: boolean;
  ticket: Ticket;
}) {
  // An old chat re-reads in full: the footer says so, and the first Send asks (Send anyway / Send in a fresh chat).
  const old = oldChat({ cache: ticket.session?.cache, running, freshSession: ticket.freshSession, now: Date.now() });
  const okKey = `${slug}/${ticket.id}`;
  const oldUnconfirmed = !!old && oldChatOk.get(okKey) !== old.at;
  const [askOld, setAskOld] = useState(false);
  const asking = askOld && oldUnconfirmed && !!draft.trim();
  /** Send or Enter in the box: asks first on an old chat; Enter (or Send) again means send anyway. */
  const submit = () => {
    if (!draft.trim() || stopping || images.uploading) return;
    if (old && oldUnconfirmed) {
      if (!asking) {
        setAskOld(true);
        return;
      }
      oldChatOk.delete(okKey);
      oldChatOk.set(okKey, old.at);
      capMap(oldChatOk, OLD_CHAT_OK_MAX);
    }
    setAskOld(false);
    send(draft);
  };
  const sendingNow = useRef(new Set<string>());
  const sendFresh = () => {
    if (old) {
      oldChatOk.delete(okKey);
      oldChatOk.set(okKey, old.at);
      capMap(oldChatOk, OLD_CHAT_OK_MAX);
    }
    setAskOld(false);
    send(draft, true);
  };

  const send = async (text: string, fresh = false) => {
    // A command goes as `/name args`, the way the server queues it and the session shows it.
    const t = messageCommand(text, commands) ? text.trim().replace(/^(\S+)\s+/, "$1 ") : text.trim();
    if (!t || stopping || images.uploading) return;
    // The same text already on its way (a double tap on a form's Send): sent once.
    if (sendingNow.current.has(t)) return;
    sendingNow.current.add(t);
    try {
      await sendOnce(t, fresh);
    } finally {
      sendingNow.current.delete(t);
    }
  };
  const sendOnce = async (t: string, fresh: boolean) => {
    images.clearError();
    stickToBottom.current = true;
    const steer = running;
    setPending((ps) => [...ps, { text: t, steer }]);
    setDraft("");
    setUndo(null);
    setUndone(null);
    try {
      const r = await api.chat(slug, ticket.id, t, fresh);
      // Steering or waiting for a slot: the server queue now shows it. A reply it started keeps its plain bubble while the
      // board holds it until Claude reads it. /clear and /model: the board ran them, nothing reaches the session.
      if ((r.queued?.some((q) => q.text === t) && (steer || !r.running)) || messageCommand(t, commands)?.source === "board") setPending((ps) => ps.filter((p) => p.text !== t));
    } catch (e: any) {
      setPending((ps) => ps.filter((p) => p.text !== t));
      setDraft(t);
      onError(e.message);
    }
  };
  return { asking, old, send, sendFresh, submit };
}
