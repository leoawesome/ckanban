// Plain time helpers, no React, so tests can import them (the ticking hook is in useNow.ts).

/** Full local date and time, for tooltips next to relative times. */
export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** How long something has waited since `iso`, coarse: "just now", "12m", "9h", "1d 4h". */
export function waitedFor(iso: string, at = Date.now()): string {
  const m = Math.max(0, Math.floor((at - new Date(iso).getTime()) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

/** Short running time since `iso`: "45s", "3m", "1h 5m". */
export function elapsed(iso: string, at = Date.now()): string {
  const s = Math.max(0, Math.floor((at - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const m = Math.floor((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)}h ${m}m` : `${Math.floor(s / 3600)}h`;
}

/** Duration with seconds for live timers: "48s", "2m 14s", "1h 5m". */
export function duration(fromIso: string, to = Date.now()): string {
  const s = Math.max(0, Math.floor((to - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function timeUntil(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 60) return "any moment";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

/** Plain one-line preview of markdown text (for cards). */
export function plainPreview(md: string, max = 160): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~>#|]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (n: number) => String(n).padStart(2, "0");

/**
 * When a message was sent, short (local time): "14:32" today, "9 Nov, 16:05" another day this year, "9 Nov 2025, 16:05"
 * another year. title: the full date and time, "Monday 9 November 2026, 16:05:12".
 */
export function sentTime(iso: string, now = new Date()): { text: string; title: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { text: "", title: "" };
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const today = sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const text = today ? hm : `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? "" : ` ${d.getFullYear()}`}, ${hm}`;
  const title = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}, ${hm}:${two(d.getSeconds())}`;
  return { text, title };
}
