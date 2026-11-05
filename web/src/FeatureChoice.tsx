import { useEffect, useMemo, useState } from "react";
import { COLUMNS, type Ticket } from "./api";
import { openFeatures, suggestFeature } from "./family";

export type FeatureChoiceValue = "add" | "own" | "other";

/**
 * Which open feature a new ticket joins: the one sharing the most words (no AI call) is offered as "Add to X" and is the
 * default; with no match the default is "Keep it on its own". partOf is the chosen feature's id, or undefined.
 */
export function useFeatureChoice(tickets: Ticket[], title: string, body: string) {
  const features = useMemo(() => openFeatures(tickets), [tickets]);
  const suggestion = useMemo(() => suggestFeature(tickets, title, body), [tickets, title, body]);
  const [choice, setChoice] = useState<FeatureChoiceValue>(suggestion ? "add" : "own");
  const [other, setOther] = useState("");
  useEffect(() => setChoice((c) => (c === "other" ? c : suggestion ? "add" : "own")), [suggestion?.feature.id]);
  const partOf = choice === "add" ? suggestion?.feature.id : choice === "other" ? other || undefined : undefined;
  return { features, suggestion, choice, setChoice, other, setOther, partOf };
}

/** The radio group: Add to X (when a feature matches), Keep it on its own, Other feature… */
export function FeatureChoice({ state, name = "feature" }: { state: ReturnType<typeof useFeatureChoice>; name?: string }) {
  const { features, suggestion, choice, setChoice, other, setOther } = state;
  const f = suggestion?.feature;
  const size = (id: string) => features.find((x) => x.top.id === id)?.rows.length ?? 1;
  const col = (t: Ticket) => COLUMNS.find((c) => c.id === t.status)?.label ?? t.status;
  return (
    <div className="feature-suggest" role="group" aria-label="Part of a feature">
      {f ? <p>This looks like part of <b>{f.title}</b> ({col(f)}, {size(f.id)} tickets).</p> : <p>Is it part of a feature you're already working on?</p>}
      {f && (
        <label className="choice"><input type="radio" name={name} checked={choice === "add"} onChange={() => setChoice("add")} /> Add to {f.title}
          <span className="muted small">its chat picks it up and it shows in the feature's status</span></label>
      )}
      <label className="choice"><input type="radio" name={name} checked={choice === "own"} onChange={() => setChoice("own")} /> Keep it on its own
        <span className="muted small">its own card</span></label>
      <label className="choice"><input type="radio" name={name} checked={choice === "other"} onChange={() => setChoice("other")} /> Other feature…
        {choice === "other" && (
          <select value={other} onChange={(e) => setOther(e.target.value)} aria-label="Feature to add it to">
            <option value="">Pick a feature</option>
            {features.map((x) => <option key={x.top.id} value={x.top.id}>{x.top.title} ({x.rows.length})</option>)}
          </select>
        )}
      </label>
      {suggestion && <div className="why muted small">Matched words: {suggestion.words.join(", ")}.</div>}
    </div>
  );
}
