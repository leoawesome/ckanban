import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Modal } from "../../components/Modal";
import { CheckIcon } from "../../components/icons";
import { api, subscribe } from "../../lib/api";
import type { ClaudeSignInLogin } from "../../lib/api/types/claudeSignin";
import { codeProblem } from "./signinText";

const REPLACED = "This sign-in was replaced by a newer one (another tab or device started one). Tap Start again for a new link.";
const message = (e: unknown) => (e as Error)?.message || "The board didn't answer. Check that it is still running, then try again.";

/**
 * Sign Claude back in (opened from the strip): the board starts Claude's sign-in on the Mac and shows its link. The
 * user opens it (on the phone or here), approves, copies the code and pastes it. Opening the sheet always starts a new
 * sign-in (the old one is stopped); Cancel, ×, swipe and Back stop it. Paste and cancel name this sheet's sign-in, so a
 * sheet left open on another device can't cancel or fill in a newer one; it says it was replaced instead. The code goes
 * straight to the Mac's Claude and is cleared from the field once sent.
 */
export function ClaudeSignInSheet({ onClose }: { onClose: () => void }) {
  const [login, setLogin] = useState<ClaudeSignInLogin | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the newest start's answer counts; events only for this sheet's sign-in.
  const seq = useRef(0);
  const loginId = useRef<number | null>(null);
  // Closed before the start answered: that sign-in is stopped as soon as its id is known.
  const closed = useRef(false);
  const fieldId = useId();
  const errId = useId();

  const start = async () => {
    const mine = ++seq.current;
    setLogin(null); setUrl(null); setOpened(false); setCode(""); setFieldError(null); setError(null);
    try {
      const s = await api.claudeSignInStart();
      if (closed.current) {
        if (s.login) api.claudeSignInCancel(s.login.id).catch(() => {});
        return;
      }
      if (mine !== seq.current) return;
      loginId.current = s.login?.id ?? null;
      setLogin(s.login);
      setUrl(s.login?.url ?? null);
    } catch (e) {
      if (mine === seq.current) setError(message(e));
    }
  };

  useEffect(() => {
    void start();
    return subscribe((e) => {
      if (e.type !== "claude-signin.updated") return;
      const l = e.state.login;
      const id = loginId.current;
      if (id == null) return;
      if (l && l.id === id) setLogin(l);
      // Another tab or device started a newer sign-in (or stopped this one): this one is over.
      else setLogin((cur) => cur && cur.id === id && cur.state !== "done" && cur.state !== "failed"
        ? { ...cur, state: "failed", url: null, error: l ? REPLACED : "This sign-in was stopped. Tap Start again for a new link." } : cur);
    });
  }, []);

  const close = () => {
    closed.current = true;
    const live = login && (login.state === "starting" || login.state === "waiting" || login.state === "checking");
    if (live) api.claudeSignInCancel(login.id).catch(() => {});
    onClose();
  };

  const finish = async (e?: FormEvent) => {
    e?.preventDefault();
    const problem = codeProblem(code);
    if (problem) return setFieldError(problem);
    const id = loginId.current;
    if (id == null) return;
    setFieldError(null);
    setBusy(true);
    try {
      const s = await api.claudeSignInPaste(id, code.trim());
      setCode("");
      if (s.login && s.login.id === loginId.current) setLogin(s.login);
    } catch (err) {
      const text = message(err);
      // 409: this sign-in is over (replaced or ended): the failed view offers Start again.
      if (/Tap Start again/.test(text) && login) {
        setCode("");
        setLogin({ ...login, state: "failed", url: null, error: text });
      } else setFieldError(text);
    } finally {
      setBusy(false);
    }
  };

  const state = login?.state;
  let body;
  if (error) {
    body = (
      <>
        <div className="banner inline cs-alert" role="alert">{error}</div>
        <div className="cs-actions">
          <button type="button" className="btn" onClick={close}>Close</button>
          <button type="button" className="btn primary" onClick={() => void start()}>Try again</button>
        </div>
      </>
    );
  } else if (!login || state === "starting") {
    body = <p className="cs-wait" role="status"><span className="spinner" aria-hidden /> Getting the sign-in link…</p>;
  } else if (state === "done") {
    body = (
      <>
        <div className="cs-done" role="status">
          <span className="cs-n cs-ok" aria-hidden><CheckIcon size={16} /></span>
          <div>
            <b>Claude is signed in again.</b>
            <p className="cs-hint">Tasks can run now. Cards that stopped with Sign-in needed can be retried.</p>
          </div>
        </div>
        <div className="cs-actions">
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </>
    );
  } else if (state === "failed") {
    body = (
      <>
        <div className="banner inline cs-alert" role="alert">{login.error}</div>
        <div className="cs-actions">
          <button type="button" className="btn" onClick={close}>Close</button>
          <button type="button" className="btn primary" onClick={() => void start()}>Start again</button>
        </div>
      </>
    );
  } else {
    const checking = state === "checking" || busy;
    body = (
      <ol className="cs-steps">
        <li className={`cs-step${opened ? " done" : ""}`}>
          <span className="cs-n" aria-hidden>{opened ? <CheckIcon size={14} /> : "1"}</span>
          <div className="cs-body">
            <b>Open the Claude sign-in page{opened && <span className="sr-only"> (done)</span>}</b>
            {url && (
              <a className="btn" href={url} target="_blank" rel="noreferrer" onClick={() => setOpened(true)}>
                {opened ? "Open again" : "Open sign-in page"}
              </a>
            )}
          </div>
        </li>
        <li className="cs-step">
          <span className="cs-n" aria-hidden>2</span>
          <div className="cs-body">
            <b>Approve, then copy the code it shows</b>
            <span className="cs-hint">Come back here after you tap Authorize.</span>
          </div>
        </li>
        <li className="cs-step">
          <span className="cs-n" aria-hidden>3</span>
          <form className="cs-body" onSubmit={finish}>
            <label htmlFor={fieldId}><b>Paste the code</b></label>
            <input
              id={fieldId}
              value={code}
              onChange={(e) => { setCode(e.target.value); if (fieldError) setFieldError(null); }}
              placeholder="Paste code here"
              autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              aria-invalid={!!fieldError}
              aria-describedby={fieldError ? errId : undefined}
              disabled={checking}
            />
            {fieldError && <p className="form-error" id={errId} role="alert">{fieldError}</p>}
            <div className="cs-row">
              <button type="button" className="btn" onClick={close}>Cancel</button>
              <button type="submit" className="btn primary" disabled={checking || !code.trim()}>
                {checking ? <><span className="spinner" aria-hidden /> Checking</> : "Finish sign-in"}
              </button>
            </div>
          </form>
        </li>
      </ol>
    );
  }

  return (
    <Modal title="Sign Claude back in" onClose={close} className="cs-sheet">
      <div className="cs-content">
        <p className="cs-sub">This signs in Claude on your Mac. You can do it from here.</p>
        {body}
      </div>
    </Modal>
  );
}
