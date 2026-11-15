// What a task's panel offers in Backlog. A task (tool ticket) isn't shaped in Planning or refined with Claude: its main
// ticket wrote it. One waiting to be started (waitsForStart) gets a plain "Start this task"; any other task in Backlog
// is started by its main ticket's plan, so its panel says that instead of offering a button.
// No React and no api.ts, so tests can import it.

export type TaskStart = "start" | "waits" | null;

/** null: not a task in Backlog (the panel's usual Start work and Refine with Claude apply). */
export function taskStart(t: { tool?: boolean; status: string; waitsForStart?: boolean }): TaskStart {
  if (!t.tool || t.status !== "backlog") return null;
  return t.waitsForStart ? "start" : "waits";
}

/** The line under the status for a task in Backlog (the column's "Park ideas. Nothing runs." doesn't fit a task). */
export const TASK_START_HINT: Record<Exclude<TaskStart, null>, string> = {
  start: "Waiting for you to start it. Its main ticket can start it too.",
  waits: "Its main ticket starts it when its turn comes.",
};
