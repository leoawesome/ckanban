import { useEffect, useState } from "react";
import { api, onReconnect, subscribe } from "../../lib/api";
import type { ClaudeSignInState } from "../../lib/api/types/claudeSignin";
import { ClaudeMissingSheet } from "./ClaudeMissingSheet";
import { ClaudeSignInSheet } from "./ClaudeSignInSheet";
import { stripOf } from "./signinText";

/**
 * Under the header on every screen when Claude Code's sign-in on the Mac needs the user: yellow a few days before it
 * runs out, red once it has (Sign in opens the three-step sheet), red when the board can't find Claude Code at all (How
 * to fix opens its steps). The status comes once on open and on reconnect, then
 * as `claude-signin.updated` events (the server checks it every 10 minutes, after a sign-in and after a run's sign-in
 * error); after a sign-in the strip goes away by itself.
 */
export function ClaudeSignInStrip() {
  const [state, setState] = useState<ClaudeSignInState | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const load = () => { api.claudeSignIn().then(setState).catch(() => {}); };
    load();
    const offReconnect = onReconnect(load);
    const off = subscribe((e) => { if (e.type === "claude-signin.updated") setState(e.state); });
    return () => {
      off();
      offReconnect();
    };
  }, []);

  const strip = stripOf(state?.status);
  return (
    <>
      {strip && (
        <div className={`banner cs-strip cs-${strip.tone}`} role={strip.tone === "err" ? "alert" : "status"}>
          <span>{strip.text}</span>
          <button className={`btn${strip.tone === "err" ? " primary" : ""}`} onClick={() => setOpen(true)}>{strip.fix ? "How to fix" : "Sign in"}</button>
        </div>
      )}
      {open && (strip?.fix ? <ClaudeMissingSheet path={state?.status.ckanbanPath ?? null} onClose={() => setOpen(false)} /> : <ClaudeSignInSheet onClose={() => setOpen(false)} />)}
    </>
  );
}
