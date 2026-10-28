/** Mirrors PrCheck/PrStatus in src/server/types.ts. No imports, so tests can load this file. */
export interface PrCheck {
  name: string;
  state: "pass" | "fail" | "pending" | "skipped";
  url: string | null;
  at: string | null;
}

export interface PrStatus {
  url: string;
  number: number | null;
  state: "OPEN" | "MERGED" | "CLOSED" | null;
  checks: PrCheck[];
  failing: number;
  pending: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  conflicts: boolean;
  mergeStateStatus: string | null;
  /** The branch it merges into; missing on statuses cached before the board read it. */
  base?: string | null;
  reviewDecision: string | null;
  comments: number;
  fetchedAt: string;
}


/** One of a ticket's PRs (Ticket.prs), with its last known state and target branch. */
export interface TicketPr {
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED" | null;
  base?: string | null;
}

/** The ticket's PRs, oldest first; an old ticket's prUrl is its only one. Same rule as ticketPrs in src/server/prs.ts. */
export function ticketPrs(t: { prs?: TicketPr[] | null; prUrl: string | null; pr?: PrStatus | null }): TicketPr[] {
  if (t.prs?.length) return t.prs;
  if (!t.prUrl) return [];
  const cached = currentPr(t);
  return [{ url: t.prUrl, state: cached?.state ?? null, base: cached?.base ?? null }];
}

/** "#37601" from a PR's URL. */
export function prNumber(url: string): string {
  return `#${url.replace(/\/+$/, "").split("/").pop()}`;
}

/** The repo name of a GitHub (or GitLab-style) PR URL: "respond-io" from github.com/respond-io/respond-io/pull/1. */
export function prRepo(url: string): string {
  const m = url.match(/^https?:\/\/[^/]+\/[^/]+\/([^/]+)\//);
  return m ? m[1] : "";
}

/** The state as the panel says it, or null when it isn't known yet. */
export function prStateWord(state: TicketPr["state"]): string | null {
  return state === "OPEN" ? "Open" : state === "MERGED" ? "Merged" : state === "CLOSED" ? "Closed" : null;
}

/** The PR list's folded line: "5 · 2 open". PRs not checked yet count as open. */
export function prSummary(prs: TicketPr[]): string {
  const open = prs.filter((p) => p.state !== "MERGED" && p.state !== "CLOSED").length;
  return `${prs.length} · ${open} open`;
}

/** The ticket's cached PR status, if it belongs to its current PR. */
export function currentPr(t: { pr?: PrStatus | null; prUrl: string | null }): PrStatus | null {
  return t.pr && t.prUrl && t.pr.url === t.prUrl ? t.pr : null;
}

/** Why Merge & done is disabled, or null. Same rules as mergeBlock in src/server/prstatus.ts (the server re-checks). */
export function mergeBlock(pr: PrStatus | null | undefined): string | null {
  if (!pr) return "PR status not loaded yet";
  if (pr.state !== "OPEN") return pr.state === "MERGED" ? "PR is already merged" : pr.state === "CLOSED" ? "PR is closed" : "PR state unknown";
  if (pr.conflicts) return "PR has conflicts with the base branch";
  if (pr.failing) return `${pr.failing} ${pr.failing === 1 ? "check" : "checks"} failing`;
  if (pr.pending) return "Checks are still running";
  if (pr.mergeable !== "MERGEABLE") return "GitHub has not confirmed the PR is mergeable yet";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "A reviewer requested changes";
  return null;
}

export interface PrChip {
  label: string;
  tone: "ok" | "bad" | "pend" | "plain";
  title: string;
}

/** Review card chips after "PR #n": checks, conflicts, comments. */
export function prChips(pr: PrStatus | null): PrChip[] {
  if (!pr || pr.state !== "OPEN") return [];
  const chips: PrChip[] = [];
  const failed = pr.checks.filter((c) => c.state === "fail").map((c) => c.name);
  if (pr.failing) chips.push({ label: `✗ ${pr.failing} failing`, tone: "bad", title: `Failing: ${failed.join(", ")}` });
  else if (pr.pending) chips.push({ label: "● running", tone: "pend", title: `${pr.pending} ${pr.pending === 1 ? "check" : "checks"} still running` });
  else if (pr.checks.length) chips.push({ label: "✓ checks", tone: "ok", title: `All ${pr.checks.length} checks passed` });
  if (pr.conflicts) chips.push({ label: "conflicts", tone: "bad", title: "The PR has conflicts with its base branch" });
  if (pr.comments > 0) chips.push({ label: `${pr.comments} ${pr.comments === 1 ? "comment" : "comments"}`, tone: "plain", title: "Comments on the PR" });
  return chips;
}

const REVIEW: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
};

export function reviewText(decision: string | null): string {
  return decision ? REVIEW[decision] ?? decision.charAt(0) + decision.slice(1).toLowerCase().replace(/_/g, " ") : "No review required";
}
