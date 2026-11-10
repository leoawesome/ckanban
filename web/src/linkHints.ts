// What the ticket panel's Part of buttons (Change, Unlink, Link to a ticket…) will do, in plain words. No imports from
// api.ts, so tests load it.
import type { LinkHow } from "./family";

/** What Unlink also ends, so the user knows before clicking. */
export const UNLINK_NOTE: Partial<Record<LinkHow, string>> = {
  plan: "Takes it out of that piece of work and out of that ticket's plan",
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * What Change, Unlink and "Link to a ticket…" will do, in plain words, by what the ticket is: a task, a piece of work
 * with its own tasks (a sub-feature once linked), or any other ticket. tasks: the tasks of its own feature.
 */
export function linkHints(t: { main?: boolean; tool?: boolean }, how: LinkHow | null, tasks: number): { change: string; unlink: string; link: string } {
  const plan = how ? UNLINK_NOTE[how] : undefined;
  if (t.tool) {
    return {
      change: `Moves it under another ticket, as one of its tasks${plan ? `. ${plan}` : ""}`,
      unlink: `Becomes its own work on the board${plan ? `. ${plan}` : ""}`,
      link: "Puts it under the ticket you pick, as one of its tasks",
    };
  }
  if (t.main) {
    const own = tasks ? `with its ${plural(tasks, "task")}` : "with its own card and chat";
    return {
      change: `Moves it, ${own}, under another feature as a sub-feature${plan ? `. ${plan}` : ""}`,
      unlink: `Stays its own work on the board, ${own}${plan ? `. ${plan}` : ""}`,
      link: `Makes it a sub-feature of the ticket you pick; it keeps its own card, chat and ${tasks ? plural(tasks, "task") : "tasks"}`,
    };
  }
  return {
    change: plan ? `Put it under another ticket. ${plan}` : "Put it under another ticket",
    unlink: plan ?? "Takes it out of that piece of work",
    link: "Puts it under the ticket you pick, as part of that piece of work",
  };
}

