import { useMemo, useState } from "react";
import type { Ticket } from "./api";
import { openFeatures, partOfFor, suggestFeature } from "./family";

export type FeatureChoiceValue = "add" | "own" | "other";

/**
 * Which open feature a new ticket joins. It stays on its own until the user picks: the open feature sharing the most
 * words (no AI call) is only offered, never chosen for them. partOf is the picked feature's id, or undefined.
 */
export function useFeatureChoice(tickets: Ticket[], title: string, body: string) {
  const features = useMemo(() => openFeatures(tickets), [tickets]);
  const suggestion = useMemo(() => suggestFeature(tickets, title, body), [tickets, title, body]);
  const [choice, setChoice] = useState<FeatureChoiceValue>("own");
  // "add" keeps the feature that was offered when the user tapped it, so later typing can't swap it underneath them.
  const [added, setAdded] = useState("");
  const [other, setOther] = useState("");
  const add = (id: string) => { setAdded(id); setChoice("add"); };
  const openIds = useMemo(() => features.map((x) => x.top.id), [features]);
  const partOf = partOfFor(choice, added, other, openIds);
  // The picked feature closed while the dialog was open: back to its own (reset while rendering, no effect), so
  // nothing hidden is sent and it can't come back by itself.
  const picked = choice === "add" ? added : choice === "other" ? other : "";
  if (picked && !openIds.includes(picked)) { setChoice("own"); setAdded(""); setOther(""); }
  return { features, suggestion, choice, setChoice, add, other, setOther, partOf };
}

/**
 * One quiet chip: `Part of "X"? ▾` when a feature matches, `Add to a feature…` otherwise (only when the board has open
 * features). Tapping it lists Add / Other feature… / Keep on its own; after a pick it reads `Added to "X" ✕`.
 * `hideNoMatchOnPhone`: in New ticket the no-match link is left out on phones (Make a ticket from chat always shows it).
 */
export function FeatureChoice({ state, hideNoMatchOnPhone }: { state: ReturnType<typeof useFeatureChoice>; hideNoMatchOnPhone?: boolean }) {
  const { features, suggestion, choice, setChoice, add, other, setOther, partOf } = state;
  const [open, setOpen] = useState(false);
  if (!suggestion && !features.length) return null;
  const titleOf = (id: string) => features.find((x) => x.top.id === id)?.top.title ?? suggestion?.feature.title ?? "a feature";
  const own = () => { setChoice("own"); setOther(""); setOpen(false); };

  if (partOf) {
    const t = titleOf(partOf);
    return (
      <div className="fc" role="group" aria-label="Part of a feature">
        <span className="fc-chip fc-added" title={t}>
          Added to <span className="fc-title">“{t}”</span>
          <button type="button" className="fc-undo" aria-label="Keep it on its own instead" title="Keep it on its own" onClick={own}>✕</button>
        </span>
      </div>
    );
  }

  const f = suggestion?.feature;
  const expanded = open || choice === "other";
  const tip = f?.title;
  const select = (
    <select value={other} autoFocus onChange={(e) => { setOther(e.target.value); if (e.target.value) setOpen(false); }} aria-label="Feature to add it to">
      <option value="">Pick a feature</option>
      {features.map((x) => <option key={x.top.id} value={x.top.id}>{x.top.title}</option>)}
    </select>
  );
  return (
    <div className={`fc${!f && hideNoMatchOnPhone ? " fc-hide-phone" : ""}`} role="group" aria-label="Part of a feature">
      <button type="button" className="fc-chip" aria-expanded={expanded} title={tip}
        onClick={() => {
          if (expanded) return own();
          if (f) setOpen(true);
          else setChoice("other");
        }}>
        {f ? <>Part of <span className="fc-title">“{f.title}”</span>? <span aria-hidden>▾</span></> : "Add to a feature…"}
      </button>
      {expanded && (
        <div className="fc-list">
          {f && (
            <button type="button" className="fc-row" onClick={() => { add(f.id); setOpen(false); }}>
              <span>Add to {f.title}</span>
              <span className="muted small">Matched words: {suggestion!.words.join(", ")}</span>
            </button>
          )}
          {f && choice !== "other" && <button type="button" className="fc-row" onClick={() => setChoice("other")}>Other feature…</button>}
          {choice === "other" && select}
          <button type="button" className="fc-row" onClick={own}>Keep on its own</button>
        </div>
      )}
    </div>
  );
}
