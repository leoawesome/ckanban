import { useState } from "react";
import { api, safeHref, type KeysAsk } from "./api";

/**
 * Claude asked for keys (ask_keys): one password field per key, Save keys and "I'll do it myself". Save sends the
 * values to the board only (it keeps them on this Mac for this board, and the ticket's runs get them as environment
 * variables); Claude gets a message with the names saved, never the values. The typed values live only in this
 * component's state: never in the browser's storage, the chat or a draft.
 */
export function KeysBox({ slug, ticketId, uuid, ask, answered, old, onError }: {
  slug: string;
  ticketId: string;
  uuid: string;
  ask: KeysAsk;
  /** The ticket's keyCards entry for this box, once answered. */
  answered?: { saved: string[]; self?: boolean };
  /** An older box the conversation moved past without an answer: shown closed. */
  old?: boolean;
  onError: (m: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"save" | "self" | null>(null);
  const names = ask.keys.map((k) => `$${k.envName}`);
  const filled = ask.keys.filter((k) => values[k.envName]?.trim());

  if (answered) {
    const n = answered.saved.length;
    return (
      <div className="keys-box done">
        <span className="keys-saved">
          {answered.self || !n
            ? "✓ You'll add it yourself. Claude carries on without it."
            : `✓ ${n === 1 ? "1 key" : `${n} keys`} saved on this Mac (${answered.saved.map((x) => `$${x}`).join(", ")}). Claude is putting ${n === 1 ? "it" : "them"} in place.`}
        </span>
      </div>
    );
  }
  if (old) {
    return <div className="keys-box done"><span className="muted small">🔒 Claude asked for {names.join(", ")} here; the chat moved on.</span></div>;
  }

  const send = async (kind: "save" | "self") => {
    setBusy(kind);
    try {
      await api.answerKeyCard(slug, ticketId, uuid, kind === "self" ? { self: true } : { keys: Object.fromEntries(filled.map((k) => [k.envName, values[k.envName]])) });
      setValues({});
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className="keys-box" onSubmit={(e) => { e.preventDefault(); if (filled.length && !busy) void send("save"); }} autoComplete="off">
      <div className="keys-title">🔒 Keys for this ticket</div>
      <div className="keys-sub">
        Saved on this Mac only. Claude gets {names.length === 1 ? "it" : "them"} as {names.join(" and ")}, not as text.
        {ask.replace && ` This replaces the ${names.length === 1 ? "key" : "keys"} already saved for this board.`}
        {ask.reason && <> For: {ask.reason}</>}
      </div>
      {ask.keys.map((k) => {
        const href = k.createUrl ? safeHref(k.createUrl) : null;
        return (
          <label key={k.envName} className="keys-field">
            <span className="keys-label">
              {k.label}
              {(k.help || href) && (
                <span className="keys-help">
                  {k.help}{k.help && href ? " · " : ""}
                  {href && <a href={href} target="_blank" rel="noopener noreferrer">create one</a>}
                </span>
              )}
            </span>
            <input type="password" value={values[k.envName] ?? ""} placeholder={k.envName} aria-label={k.label} autoComplete="off" spellCheck={false}
              data-1p-ignore data-lpignore="true" disabled={!!busy}
              onChange={(e) => setValues((v) => ({ ...v, [k.envName]: e.target.value }))} />
          </label>
        );
      })}
      <div className="keys-actions">
        <button className="btn primary" disabled={!!busy || !filled.length}>{busy === "save" ? "Saving…" : ask.keys.length === 1 ? "Save key" : "Save keys"}</button>
        <button type="button" className="btn ghost" disabled={!!busy} onClick={() => void send("self")}>I'll do it myself</button>
      </div>
    </form>
  );
}
