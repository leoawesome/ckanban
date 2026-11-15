import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { api, type QueuedMessage, type Ticket } from "../../lib/api";
import { unsentNow, type Pending } from "../../lib/pendingBubbles";

export function useQueuedEdits({ composer, onError, pendingRef, queued, running, setPending, slug, ticket }: {
  composer: RefObject<HTMLTextAreaElement>;
  onError: (m: string) => void;
  pendingRef: MutableRefObject<Pending[]>;
  queued: QueuedMessage[];
  running: boolean;
  setPending: Dispatch<SetStateAction<Pending[]>>;
  slug: string;
  ticket: Ticket;
}) {
  // A message Claude hasn't received yet (not sent after Stop, or waiting for a slot or a restart): the user can
  // still edit or discard it. With Claude running it was handed over at once.
  const editable = (q: QueuedMessage) => !q.from && !q.automation && (q.state === "unsent" || (!q.peer && !running));
  // Another ticket's message: shown as that ticket's, not as the user's.
  const fromUser = (q: QueuedMessage) => !q.peer && !q.from && !q.automation;
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const discarded = useRef(new Set<string>());
  const cancelEdit = () => {
    setEditing(null);
    composer.current?.focus();
  };
  const saveEdit = async () => {
    if (!editing?.text.trim()) return;
    try {
      await api.editQueued(slug, ticket.id, editing.id, editing.text.trim());
      cancelEdit();
    } catch (e: any) {
      onError(e.message);
    }
  };
  const discard = (msgId: string) => {
    discarded.current.add(msgId);
    api.discardQueued(slug, ticket.id, msgId).catch((e) => {
      discarded.current.delete(msgId);
      onError(e.message);
    });
  };

  // Claude read a queued message: keep its bubble until the session file shows it, so it doesn't blink out.
  const prevQueued = useRef(queued);
  useEffect(() => {
    // Peer messages show up in the session as another ticket's message, not as the user's bubble.
    const read = prevQueued.current.filter((q) => q.state === "queued" && fromUser(q) && !discarded.current.has(q.id) && !queued.some((n) => n.id === q.id)).map((q) => q.text);
    prevQueued.current = queued;
    // The reply's own message already has its plain bubble.
    if (read.length) setPending((ps) => [...ps, ...read.filter((text) => !ps.some((p) => !p.steer && p.text === text)).map((text) => ({ text, steer: false }))]);
    const unsent = unsentNow(pendingRef.current, queued);
    if (unsent.length) setPending((ps) => ps.filter((p) => !unsent.includes(p)));
  }, [ticket.queued]);
  return { cancelEdit, discard, editable, editing, fromUser, saveEdit, setEditing };
}
