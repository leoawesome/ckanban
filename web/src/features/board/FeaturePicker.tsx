import { featureChoices, type FeatureMaker } from "./featureChoices";
import type { FeatureTicket } from "./family";

/**
 * "Its own card" or a feature (a main ticket or one of its groups) a schedule's runs or an automation's new tickets go
 * into as tasks. Shared by the Schedules and Automations windows; each puts its own label and help around it.
 */
export function FeaturePicker({ tickets, value, onChange, maker, ariaLabel }: {
  tickets: FeatureTicket[];
  value: string;
  onChange: (v: string) => void;
  maker: FeatureMaker;
  ariaLabel?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel}>
      <option value="">Its own card</option>
      {featureChoices(tickets, value, maker).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
