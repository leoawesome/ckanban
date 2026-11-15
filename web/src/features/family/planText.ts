type PlanChild = { status: string; outcome: string | null; prUrl: string | null };

/** Done, or finished in Review without a PR to merge (same rule as the server's plan.ts). */
export const complete = (t: PlanChild) => t.status === "done" || (t.status === "review" && t.outcome === "done" && !t.prUrl);

/** The plan has at least one child and every child is done: the planner's next step is Move to Done. */
export const planFinished = (children: PlanChild[]) => children.length > 0 && children.every(complete);

/** The plan's wake-up count in plain words: "Claude checked in 3 times". */
export const checkInsText = (n: number) => `Claude checked in ${n === 1 ? "once" : `${n} times`}`;

/** A finished child's badge: Done once accepted, "Finished · to check" while it still sits in Review. */
export const finishedLabel = (t: { status: string }) => (t.status === "done" ? "Done" : "Finished · to check");

/**
 * What a plan child waits on the user for, as the end of "Waiting on you: <title> …", from the server's userWaitReason
 * ("5 questions for you", "has questions for you", "proposal to apply", "in Planning").
 */
export function waitPhrase(userWait: string): string {
  const q = /^(\d+) (questions?) for you$/.exec(userWait);
  if (q) return `has ${q[1]} ${q[2]}`;
  if (userWait === "has questions for you") return "has questions";
  if (userWait === "proposal to apply") return "has a proposal to apply";
  if (userWait === "in Planning") return "is waiting in Planning";
  return userWait;
}
