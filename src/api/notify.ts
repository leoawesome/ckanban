// Notifications, the messages the board sent, the helper and phone push. Moved verbatim from http.ts.
import { RUN_HEADER } from "../schedules/scheduler";
import { MacOnlyError, TG_PAIR_FROM_MAC } from "../helper/notify";
import { asMessageTab, nearOf, needsShown, pageOf, toRow, type MessageCursor } from "../helper/messages";
import { type ApiContext, HttpError, NEXT, type RouteResult, body } from "./context";

/** /api/notify, /api/messages, /api/helper, /api/push */
export async function notifyRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string): Promise<RouteResult> {
  const { bus, json, userOnly, listenerOf, notifyView, push, notifier, helperOr503, helperCall } = ctx;
  // "Needs you" notifications (notify.ts). Runs can't read or change them: the webhook URL is the user's channel.
  if (parts[0] === "notify") {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "board runs can't use notification settings");
    if (parts.length === 1 && m === "GET") return json(notifyView(req, notifier.state()));
    if (parts.length === 1 && m === "POST") {
      const patch = await body(req);
      // Where messages go (webhook address, ntfy, the Telegram bot and its token) is the user's alone: a run's shell or
      // another program could point every message, full text included, at its own address. Only the user's browser.
      await userOnly(req, "Changing notification settings");
      try {
        return json(notifyView(req, notifier.update(patch, listenerOf(req))));
      } catch (e) {
        throw new HttpError(e instanceof MacOnlyError ? 403 : 400, (e as Error).message);
      }
    }
    if (parts[1] === "test" && m === "POST") {
      const b = await body(req);
      return json({ ...(await notifier.test(typeof b?.profile === "string" ? b.profile : undefined)), state: notifyView(req, notifier.state()) });
    }
    // Telegram pairing (helper/telegram.ts): a fresh 6-digit code to send to the bot, or forget the paired chat.
    // The code only comes back here, to the user's own browser: whoever sends it to the bot becomes the paired chat.
    if (parts[1] === "telegram" && parts[2] === "pair" && parts.length === 3 && m === "POST") {
      await userOnly(req, "Pairing Telegram");
      // Whoever pairs gets to answer tickets from that chat: only this Mac, so a lost phone can't pair a new chat.
      if (listenerOf(req) !== "local") throw new HttpError(403, TG_PAIR_FROM_MAC);
      try {
        const b = await body(req);
        return json({ ...notifier.telegramPair(typeof b?.board === "string" ? b.board : null), state: notifyView(req, notifier.state()) });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (parts[1] === "telegram" && parts[2] === "unpair" && parts.length === 3 && m === "POST") {
      await userOnly(req, "Unpairing Telegram");
      return json(notifyView(req, notifier.telegramUnpair()));
    }
  }

  // Messages the board sent the user (helper/messages.ts): the history, one message's full text, mark read.
  if (parts[0] === "messages") {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "board runs can't read the user's messages");
    const store = notifier.helper.messages;
    // The list, one page of a tab at a time, light rows only: ?tab=needs|all|summaries|quiet&limit=30, then
    // beforeAt+beforeId (the next page down) or afterAt+afterId (only what came in since the newest row shown).
    if (parts.length === 1 && m === "GET") {
      const q = url.searchParams;
      const tab = asMessageTab(q.get("tab") ?? "all");
      const limit = Math.min(Math.max(Math.floor(Number(q.get("limit"))) || 30, 1), 100);
      const cursor = (side: "before" | "after"): MessageCursor | null => {
        const at = q.get(`${side}At`), id = q.get(`${side}Id`);
        return at && id && !Number.isNaN(Date.parse(at)) ? { at, id } : null;
      };
      const newest = store.listNewest({ held: true });
      const needs = notifier.helper.needsYou(newest);
      const page = pageOf(newest, { tab, limit, before: cursor("before"), after: cursor("after") }, needs);
      return json({ rows: page.rows.map((x) => toRow(x, needs)), hasMore: page.hasMore, needs: needsShown(newest, needs), unread: store.unread() });
    }
    // "Mark all read" on the Messages page: one write, the same messages.updated event single reads send.
    if (parts.length === 2 && parts[1] === "read-all" && m === "POST") {
      const marked = store.markAllRead();
      return json({ marked, unread: store.unread() });
    }
    const msg = parts[1] ? store.get(decodeURIComponent(parts[1])) : null;
    if (parts.length === 2 && m === "GET") {
      if (!msg) throw new HttpError(404, "message not found");
      return json(notifier.helper.withStates(msg));
    }
    // A message page's up/down: the newer and older message in the list's tab (or the tab the message belongs to).
    if (parts.length === 3 && parts[2] === "near" && m === "GET") {
      if (!msg) throw new HttpError(404, "message not found");
      const newest = store.listNewest({ held: true });
      const needs = notifier.helper.needsYou(newest);
      // keep: the Needs you ids the user's list showed this session; read since, they left the tab, but still step.
      return json(nearOf(newest, msg, asMessageTab(url.searchParams.get("tab") ?? "all"), needs, url.searchParams.get("keep")));
    }
    if (parts.length === 3 && parts[2] === "read" && m === "POST") {
      if (!msg) throw new HttpError(404, "message not found");
      return json({ message: notifier.helper.withStates(store.markRead(msg.id) ?? msg), unread: store.unread() });
    }
    // The message page's buttons (POST, never links): Got it and Not urgent; key: only that item of the message.
    if (parts.length === 3 && (parts[2] === "got-it" || parts[2] === "not-urgent") && m === "POST") {
      if (!msg) throw new HttpError(404, "message not found");
      await userOnly(req, "Stopping reminders");
      const b = await body(req).catch(() => null);
      const key = typeof b?.key === "string" ? b.key : null;
      const h = helperOr503();
      const r = helperCall(() => (parts[2] === "got-it" ? h.gotIt(msg.id, key) : h.notUrgent(msg.id, key)));
      const after = store.get(msg.id);
      return json({ ...r, message: after ? notifier.helper.withStates(after) : null, unread: store.unread() });
    }
  }

  // The helper (helper/runner.ts): status and helper lines, its settings, "What the helper knows about you", taps.
  if (parts[0] === "helper") {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "board runs can't use the helper's settings");
    const h = helperOr503();
    if (parts.length === 1 && m === "GET") return json(h.status());
    // Changes are the user's own: settings (night wake-ups), the feedback the helper reads, taps.
    if (m !== "GET") await userOnly(req, "Changing the helper");
    if (parts[1] === "settings" && parts.length === 2 && m === "POST") {
      const b = await body(req);
      helperCall(() => h.settings.update(b));
      return json(h.status());
    }
    if (parts[1] === "feedback") {
      if (parts.length === 2 && m === "GET") return json({ lines: h.settings.get().feedback });
      if (parts.length === 2 && m === "POST") {
        const b = await body(req);
        const line = helperCall(() => h.settings.addFeedback(b?.text));
        h.feedbackAdded();
        return json({ line, lines: h.settings.get().feedback });
      }
      if (parts.length === 3 && m === "DELETE") {
        if (!h.settings.removeFeedback(decodeURIComponent(parts[2]))) throw new HttpError(404, "line not found");
        bus.emit({ type: "helper.updated" });
        return json({ lines: h.settings.get().feedback });
      }
    }
    if (parts[1] === "should-have-pinged" && parts.length === 2 && m === "POST") {
      const b = await body(req);
      if (typeof b?.profile !== "string" || typeof b?.ticketId !== "string") throw new HttpError(400, "profile and ticketId are required");
      return json({ ...helperCall(() => h.shouldHavePinged(b.profile, b.ticketId)), lines: h.settings.get().feedback });
    }
    // A pretend urgent alert (Settings, the hello page): sent like a real one, one reminder after a minute, never a wait.
    if (parts[1] === "practice" && parts.length === 2 && m === "POST") {
      try {
        return json(await h.practice());
      } catch (e) {
        return helperCall(() => { throw e; });
      }
    }
    if (parts[1] === "notice-seen" && parts.length === 2 && m === "POST") {
      h.noticeSeen();
      return json(h.status());
    }
  }

  // Phone push (push.ts): this device turns notifications on/off; the page's heartbeat says when its board is on screen.
  if (parts[0] === "push") {
    if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "board runs can't use notification settings");
    if (parts.length === 1 && m === "GET") return json({ publicKey: push.publicKey(), devices: push.devices(), dropped: push.dropped() });
    const b = m === "POST" ? await body(req) : null;
    const endpoint = typeof b?.endpoint === "string" ? b.endpoint : "";
    if (parts[1] === "subscribe" && m === "POST") {
      try {
        // On the board's own port: a browser on this Mac (phone access comes in on the remote listener).
        const d = push.subscribe(b?.subscription, b?.label, listenerOf(req) === "local", typeof b?.replaces === "string" ? b.replaces : undefined);
        return json({ id: d.id, label: d.label, createdAt: d.createdAt });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (parts[1] === "remove" && m === "POST") {
      const key = typeof b?.id === "string" ? b.id : endpoint;
      if (!key) throw new HttpError(400, "id or endpoint is required");
      return json({ removed: push.remove(key), devices: push.devices() });
    }
    if (parts[1] === "visible" && m === "POST") {
      if (!endpoint) throw new HttpError(400, "endpoint is required");
      push.setVisible(endpoint, b?.visible === true);
      if (listenerOf(req) === "local") push.markThisMac(endpoint);
      return json({ ok: true });
    }
    if (parts[1] === "test" && m === "POST") {
      if (typeof b?.id !== "string") throw new HttpError(400, "id is required");
      return json(await notifier.testDevice(b.id, typeof b?.profile === "string" ? b.profile : undefined));
    }
  }
  return NEXT;
}
