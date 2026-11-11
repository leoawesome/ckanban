// Which version each model alias (opus, fable, sonnet, haiku) means today, learned from real runs: every run's
// `system/init` event names its full model id ("claude-fable-5-2"). The newest seen per family is kept and saved, so
// labels like "Fable (5.2)" stay right after Claude Code moves an alias to a new version.
import { familyVersion, KNOWN_VERSIONS, newerVersion } from "../../web/src/models";
import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "./store";

let file: string | null = null;
let versions: Record<string, string> | null = null;

/** Where learned versions are saved (<store root>/model-versions.json); the board sets it at start. */
export function useModelVersionsFile(f: string | null): void {
  file = f;
  versions = null;
}

/** family → newest version seen in a run ({ fable: "5.2" }). */
export function learnedVersions(): Record<string, string> {
  if (versions) return versions;
  let saved: unknown = null;
  try {
    saved = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))?.versions : null;
  } catch {
    saved = null;
  }
  versions = {};
  if (saved && typeof saved === "object") {
    for (const [k, v] of Object.entries(saved)) if (typeof v === "string" && /^\d+(\.\d+)*$/.test(v)) versions[k] = v;
  }
  return versions;
}

/**
 * A run's stream event: an init event's model teaches its family's version when it is newer than the one known
 * (learned, else built in), so a run on an old pinned id (claude-haiku-4-5-20251001) never lowers a label.
 */
export function learnModel(ev: any): void {
  if (ev?.type !== "system" || ev.subtype !== "init" || typeof ev.model !== "string") return;
  const fv = familyVersion(ev.model);
  if (!fv) return;
  const [family, version] = fv;
  const now = learnedVersions();
  const known = now[family] ?? KNOWN_VERSIONS[family];
  if (known && !newerVersion(version, known)) return;
  versions = { ...now, [family]: version };
  if (!file) return;
  try {
    atomicWrite(file, JSON.stringify({ versions }, null, 2));
  } catch (e) {
    console.error("couldn't save model versions", e);
  }
}
