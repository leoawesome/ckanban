export interface RunResult {
  status: "done" | "blocked" | "questions";
  /** The last PR it reported (prUrl, else the last of prUrls). */
  prUrl: string | null;
  /** Every PR it reported: prUrls plus prUrl. */
  prUrls: string[];
  summary: string;
}

const PREFIX = "CKANBAN_RESULT:";

export function parseResult(text: string): RunResult | null {
  const lines = text.split("\n").filter((l) => l.includes(PREFIX));
  const line = lines.at(-1);
  if (!line) return null;
  const json = line.slice(line.indexOf(PREFIX) + PREFIX.length).trim().replace(/`+$/, "").trim();
  try {
    const v = JSON.parse(json);
    if (v.status !== "done" && v.status !== "blocked" && v.status !== "questions") return null;
    const url = (u: unknown): u is string => typeof u === "string" && /^https:\/\//.test(u);
    const prUrls = [...new Set([...(Array.isArray(v.prUrls) ? v.prUrls.filter(url) : []), ...(url(v.prUrl) ? [v.prUrl] : [])])];
    return {
      status: v.status,
      prUrl: url(v.prUrl) ? v.prUrl : prUrls.at(-1) ?? null,
      prUrls,
      summary: typeof v.summary === "string" ? v.summary : "",
    };
  } catch {
    return null;
  }
}
