import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Question } from "./api";
import { autoGrow } from "./autoGrow";
import { browserStore, forget, loadSaved } from "./drafts";
import { type Answer, answersMessage, answerText, fresh, parseAnswers, type Progress, signature, startProgress } from "./questionForms";
import { CheckIcon } from "./icons";
import { usePersistentState } from "./usePersistentState";
import { enterSends } from "./enterSends";
import { QuestionText } from "./QuestionText";
import { plainMarkdown } from "./miniMarkdown";

/**
 * A free-text answer box: grows to about 6 lines, then scrolls. Enter runs `onEnter`, Shift+Enter adds a new
 * line, and nothing fires while an IME is composing.
 */
function AnswerBox({ value, onChange, onEnter, autoFocus, disabled, placeholder, className = "", onFocus, inputRef }: {
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
  placeholder: string;
  className?: string;
  onFocus?: () => void;
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => autoGrow(ref.current, 6), [value]);
  return (
    <textarea ref={(el) => { ref.current = el; if (inputRef) inputRef.current = el; }} rows={1} autoFocus={autoFocus} disabled={disabled}
      className={`qother ${className}`} value={value} placeholder={placeholder} onFocus={onFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (enterSends(e)) {
          e.preventDefault();
          onEnter();
        }
      }} />
  );
}

/**
 * Claude's interview questions, one at a time (like Claude Code's question picker).
 * Keys: 1-9 pick an option, Enter goes next, Backspace/← goes back when not typing.
 */
export function QuestionsForm({ questions, answered, answer, replaced, closed, disabled: off, onSubmit, onClose, storageKey, onPreview }: {
  questions: Question[];
  answered: boolean;
  /** The message that answered it (its "My answers:" list pairs each question with its answer), when known. */
  answer?: string;
  /** Closed without answering (Close question, or answered in its task's chat). */
  closed?: boolean;
  /** Asked again further down (after a board update); same: with the same questions. Its progress lives on there. */
  replaced?: { same: boolean };
  disabled: boolean;
  /** Sends the answers; while its promise is pending the form can't send again (a double tap sends once). */
  onSubmit: (text: string) => void | Promise<unknown>;
  /** Close question: closes the form without sending anything; omit to not offer it. */
  onClose?: () => void | Promise<unknown>;
  /** Open an option's mockup (file name in outputs/mockups); options with one get a Preview link. */
  onPreview?: (mockup: string) => void;
  /** Where to keep unsent progress so it survives leaving the ticket; omit to not save. */
  storageKey?: string;
}) {
  const sig = signature(questions);
  const key = answered || replaced || closed ? null : storageKey ?? null;
  // Progress saved for this form, or for the earlier form it asks again (same key), carried over question by question.
  const [progress, setProgress] = usePersistentState<Progress>(
    key,
    () => startProgress(questions, key ? loadSaved<Progress>(browserStore(), key) : null),
    (p) => JSON.stringify(p) === JSON.stringify(fresh(questions)),
    (p) => p?.sig === sig && Array.isArray(p.answers) && p.answers.length === questions.length,
  );
  const { answers, step, note } = progress;
  const setStep = (n: number) => setProgress((p) => ({ ...p, step: n }));
  const setNote = (v: string) => setProgress((p) => ({ ...p, note: v }));
  const setAnswers = (fn: (arr: Answer[]) => Answer[]) => setProgress((p) => ({ ...p, answers: fn(p.answers) }));

  // Answered (here or elsewhere): saved progress is no longer needed.
  useEffect(() => {
    if ((answered || closed) && storageKey) forget(browserStore(), storageKey);
  }, [answered, closed, storageKey]);
  const root = useRef<HTMLDivElement>(null);
  const total = questions.length;
  const summary = step >= total;
  const q = questions[Math.min(step, total - 1)];
  const a = answers[Math.min(step, total - 1)];

  useEffect(() => {
    if (!answered && !replaced && !closed) root.current?.focus({ preventScroll: true });
  }, [step, answered, !!replaced, closed]);

  const update = (i: number, fn: (a: Answer) => Answer) => setAnswers((arr) => arr.map((x, j) => (j === i ? fn(x) : x)));

  const pick = (label: string) =>
    update(step, (x) => q.multiSelect
      ? { ...x, picked: x.picked.includes(label) ? x.picked.filter((l) => l !== label) : [...x.picked, label] }
      : { ...x, picked: [label], otherOn: false });

  // "Or type your own" is a text field: typing in it (or going back into it with text) makes it the answer; on a
  // one-answer question that clears the picked option, and picking an option sets the typed text aside.
  const otherRef = useRef<HTMLTextAreaElement | null>(null);
  const typeOther = (v: string) =>
    update(step, (x) => ({ ...x, other: v, otherOn: !!v.trim(), picked: q.multiSelect || !v.trim() ? x.picked : [] }));
  const focusOther = () =>
    update(step, (x) => (x.other.trim() && !x.otherOn ? { ...x, otherOn: true, picked: q.multiSelect ? x.picked : [] } : x));

  // A send in flight: the buttons and keys are off until it is done (the ref also stops a second tap in the same tick).
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const disabled = off || sending;
  const close = () => {
    if (sendingRef.current || disabled || !onClose) return;
    sendingRef.current = true;
    setSending(true);
    void Promise.resolve().then(() => onClose()).catch(() => {}).finally(() => {
      sendingRef.current = false;
      setSending(false);
    });
  };
  const send = () => {
    if (sendingRef.current || disabled) return;
    sendingRef.current = true;
    setSending(true);
    if (storageKey) forget(browserStore(), storageKey);
    void Promise.resolve().then(() => onSubmit(answersMessage(questions, answers, note))).catch(() => {}).finally(() => {
      sendingRef.current = false;
      setSending(false);
    });
  };

  const next = () => (step < total - 1 || (total > 1 && step === total - 1) ? setStep(step + 1) : send());

  if (replaced) {
    return (
      <div className="qcard answered replaced">
        <div className="qcard-head"><span className="qcard-title muted">{replaced.same ? "Asked again below" : "Replaced by newer questions below"}</span></div>
      </div>
    );
  }

  if (closed) {
    return (
      <div className="qcard answered replaced closed">
        <div className="qcard-head"><span className="qcard-title">Closed without answering</span></div>
      </div>
    );
  }

  if (answered) return <AnsweredCard questions={questions} answer={answer} />;

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled || (e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
    if (!summary && /^[1-9]$/.test(e.key)) {
      const opt = q.options[Number(e.key) - 1];
      if (opt) pick(opt.label);
      else if (Number(e.key) === q.options.length + 1) {
        e.preventDefault(); // the digit isn't typed into the field it moves to
        otherRef.current?.focus();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      summary ? send() : next();
    } else if ((e.key === "ArrowLeft" || e.key === "Backspace") && step > 0) {
      e.preventDefault();
      setStep(step - 1);
    }
  };

  return (
    <div className="qcard" ref={root} tabIndex={-1} onKeyDown={onKey}>
      <div className="qcard-head">
        <span className="qcard-title">Claude has {total} question{total > 1 ? "s" : ""}</span>
        {total > 1 && <span className="qsteps" aria-label={`Step ${Math.min(step + 1, total)} of ${total}`}>
          {questions.map((_, i) => (
            <button key={i} className={`qstep ${i === step ? "on" : ""} ${i < step || summary ? "done" : ""}`}
              onClick={() => setStep(i)} aria-label={`Question ${i + 1}`} />
          ))}
          <span className="muted small">{summary ? "Review" : `${step + 1} / ${total}`}</span>
        </span>}
      </div>

      {!summary ? (
        <div className="qbody">
          <div className="qhead">
            <div className="qquestion"><QuestionText as="span" text={q.question} />{q.multiSelect && <span className="muted small"> · pick any</span>}</div>
            {q.context?.trim() && (
              <details key={step} className="qcontext"><summary>Details</summary><QuestionText text={q.context} /></details>
            )}
          </div>
          <div className="qopts" role={q.multiSelect ? "group" : "radiogroup"}>
            {q.options.map((o, i) => {
              const on = a.picked.includes(o.label);
              const option = (
                <button key={o.label} type="button" disabled={disabled}
                  className={`qopt ${on ? "on" : ""} ${q.multiSelect ? "multi" : ""}`}
                  role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} onClick={() => pick(o.label)}>
                  <span className="qmark" aria-hidden>{q.multiSelect && on && <CheckIcon size={12} strokeWidth={2.2} />}</span>
                  <span className="qtext">
                    <span className="qlabel">
                      {o.label}
                      {o.recommended && <span className="qrec">Recommended</span>}
                    </span>
                    {o.description && <QuestionText as="span" className="qdesc" text={o.description} title={plainMarkdown(o.description)} />}
                  </span>
                  <kbd className="qkey">{i + 1}</kbd>
                </button>
              );
              // A sibling, not inside the option: previewing must not pick it. Progress is saved, so leaving for the Outputs tab keeps it.
              return o.mockup && onPreview ? (
                <div key={o.label} className="qopt-row">
                  {option}
                  <button type="button" className="qpreview" title={`Preview ${o.mockup} in the Outputs tab`} onClick={() => onPreview(o.mockup!)}>
                    Preview
                  </button>
                </div>
              ) : option;
            })}
            <AnswerBox key={step} value={a.other} disabled={disabled} className={a.otherOn ? "on" : ""} inputRef={otherRef}
              placeholder="Or type your own" onFocus={focusOther} onChange={typeOther} onEnter={next} />
          </div>
        </div>
      ) : (
        <div className="qbody">
          <ol className="qsummary">
            {questions.map((qq, i) => (
              <li key={i}>
                <button className="link-btn" onClick={() => setStep(i)}>{plainMarkdown(qq.question)}</button>
                <span>{answerText(answers[i])}</span>
              </li>
            ))}
          </ol>
          <AnswerBox value={note} onChange={setNote} onEnter={send} disabled={disabled}
            placeholder="Anything else Claude should know? (optional)" />
        </div>
      )}

      <div className="qfoot">
        <button className="btn ghost small qback" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        {onClose && (
          <button className="btn ghost small qclose" disabled={disabled} onClick={close}
            title="Close this question without answering: nothing is sent to Claude, and it stops waiting on you">Close question</button>
        )}
        <span className="muted small qhint">{summary ? "Enter to send" : "1-9 to pick · Enter for next"}</span>
        {summary || total === 1 ? (
          <button className="btn primary small qmain" disabled={disabled} onClick={send}>Send answers</button>
        ) : (
          <button className="btn primary small qmain" disabled={disabled} onClick={next}>{step === total - 1 ? "Review →" : "Next →"}</button>
        )}
      </div>
    </div>
  );
}

/** An answered form: each question in bold, the user's answer under it, and its Details folded as on the open form. */
function AnsweredCard({ questions, answer }: { questions: Question[]; answer?: string }) {
  const { answers, note } = answer ? parseAnswers(answer, questions) : { answers: questions.map(() => null), note: "" };
  const total = questions.length;
  return (
    <div className="qcard answered">
      <div className="qcard-head"><span className="qcard-title"><CheckIcon size={12} strokeWidth={2.2} /> Answered {total} question{total > 1 ? "s" : ""}</span></div>
      <ol className="qanswered">
        {questions.map((q, i) => (
          <li key={i}>
            <div className="qa-q"><QuestionText as="span" text={q.question} /></div>
            {answers[i] && <div className="qa-a">{answers[i]}</div>}
            {q.context?.trim() && (
              <details className="qcontext"><summary>Details</summary><QuestionText text={q.context} /></details>
            )}
          </li>
        ))}
      </ol>
      {note && <div className="qa-note"><span className="muted">Also: </span>{note}</div>}
    </div>
  );
}
