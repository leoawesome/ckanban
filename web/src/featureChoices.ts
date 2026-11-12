import { featureRoot, groupsOf, type FeatureTicket } from "./family";

/**
 * Features a schedule can put each run in, as tasks: every main ticket on the board, open ones first, then Done ones
 * (a run moves those back to Review), each followed by its groups. The current pick stays listed even when it is gone
 * (the server then gives runs their own card).
 */
export function featureChoices(tickets: FeatureTicket[], current: string): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const tops = tickets.filter((t) => t.main && featureRoot(tickets, t.id)?.id === t.id);
  for (const done of [false, true]) {
    for (const top of tops.filter((t) => (t.status === "done") === done)) {
      const mark = done ? " (done: runs move it back to Review)" : "";
      out.push({ value: top.id, label: `Put each run in: ${top.title}${mark}` });
      for (const g of groupsOf(tickets, top.id)) out.push({ value: g.id, label: `Put each run in: ${top.title} › ${g.title}${mark}` });
    }
  }
  if (current && !out.some((o) => o.value === current)) {
    const t = tickets.find((x) => x.id === current);
    out.push({ value: current, label: t ? `Put each run in: ${t.title} (can't take tasks now)` : "Put each run in: a ticket that no longer exists" });
  }
  return out;
}
