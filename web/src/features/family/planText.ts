import { tallyOf, type FeatureTicket } from "./family";

type PlanChild = { status: string; outcome: string | null; prUrl: string | null };

/** Done, or finished in Review without a PR to merge (same rule as the server's plan.ts): a stuck plan's waiting list leaves these out. */
export const complete = (t: PlanChild) => t.status === "done" || (t.status === "review" && t.outcome === "done" && !t.prUrl);

/**
 * Whether a main ticket's (or group's) tasks are all finished, and how many there are: the tasks under it (tasksUnder),
 * counted like the Tasks tab badge, the list head and the status (taskTally), so Plan finished never says another number.
 */
export function planDone(tasks: FeatureTicket[]): { finished: boolean; done: number; total: number } {
  const { done, total } = tallyOf(tasks);
  return { finished: total > 0 && done === total, done, total };
}

/** The plan's wake-up count in plain words: "Claude checked in 3 times". */
export const checkInsText = (n: number) => `Claude checked in ${n === 1 ? "once" : `${n} times`}`;

/**
 * What a main ticket's task waits on the user for, as the end of "Waiting on you: <title> …", from the server's userWaitReason
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
