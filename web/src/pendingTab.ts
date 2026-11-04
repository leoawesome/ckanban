/** A tab to open a ticket on, asked for before its panel mounts (a result card's Changes link). */
const pending = new Map<string, string>();

export function requestTab(id: string, tab: string): void {
  pending.set(id, tab);
}

/** The tab asked for this ticket, once. */
export function takeTab(id: string): string | null {
  const t = pending.get(id) ?? null;
  pending.delete(id);
  return t;
}
