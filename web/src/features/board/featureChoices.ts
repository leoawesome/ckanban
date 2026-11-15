import { featureRoot, groupsOf, type FeatureTicket } from "./family";

/** What puts its tickets in the feature: the words differ ("each run" / "each new ticket"). */
export type FeatureMaker = "schedule" | "automation";

/**
 * Features a schedule can put each run in (an automation each new ticket), as tasks: every main ticket on the board,
 * open ones first, then Done ones (a run moves those back to Review), each followed by its groups. The current pick
 * stays listed even when it is gone (the server then gives runs their own card).
 */
export function featureChoices(tickets: FeatureTicket[], current: string, maker: FeatureMaker = "schedule"): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const put = maker === "schedule" ? "Put each run in" : "Put each new ticket in";
  const moves = maker === "schedule" ? "runs move it back to Review" : "new tickets move it back to Review";
  const tops = tickets.filter((t) => t.main && featureRoot(tickets, t.id)?.id === t.id);
  for (const done of [false, true]) {
    for (const top of tops.filter((t) => (t.status === "done") === done)) {
      const mark = done ? ` (done: ${moves})` : "";
      out.push({ value: top.id, label: `${put}: ${top.title}${mark}` });
      for (const g of groupsOf(tickets, top.id)) out.push({ value: g.id, label: `${put}: ${top.title} › ${g.title}${mark}` });
    }
  }
  if (current && !out.some((o) => o.value === current)) {
    const t = tickets.find((x) => x.id === current);
    out.push({ value: current, label: t ? `${put}: ${t.title} (can't take tasks now)` : `${put}: a ticket that no longer exists` });
  }
  return out;
}
