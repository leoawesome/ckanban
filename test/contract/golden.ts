// Bun's answers, recorded before P4 removed the Bun server, for the tests that used to run Bun's server and the Rust
// one side by side (board-parity, board-reads, board-writes, board-family-writes, mcp-parity). Each test checks the
// server under test against test/contract/golden/<name>.json, value by value in order. They were recorded with
// `CKANBAN_GOLDEN_RECORD=1` on the commit "wip: P4 the Rust server runs without Bun..." (4f3447eb), the last one with
// both Bun's server and the recording code; to record again, check that commit out.
import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class Golden {
  readonly file: string;
  private kept: { label: string; value: unknown }[] = [];
  private next = 0;

  constructor(name: string) {
    this.file = join(import.meta.dir, "golden", `${name}.json`);
    if (!existsSync(this.file)) throw new Error(`${this.file} is missing: it was recorded from Bun (see golden.ts)`);
    this.kept = JSON.parse(readFileSync(this.file, "utf8"));
  }

  /** The server's `value` must be the one Bun gave at this point. */
  match(label: string, value: unknown) {
    const want = this.kept[this.next++];
    expect({ label, value }).toEqual(want ?? { label: "(nothing recorded here)", value: null });
  }

  /** Every recorded value was checked. */
  done() {
    expect(this.next).toBe(this.kept.length);
  }
}

/**
 * What differs between two runs of the same script: ids (named in the order they first appear, so the same object
 * gets the same name), times, durations, ports and temp paths.
 */
export function runMasker(): (text: string) => string {
  const seen = new Map<string, string>();
  const name = (kind: string) => (m: string) => {
    if (!seen.has(m)) seen.set(m, `<${kind}${seen.size}>`);
    return seen.get(m)!;
  };
  return (text) => text
    .replace(/[tshjc]_\d{8}_[a-z0-9]{4}(?![a-z0-9])/g, name("ticket"))
    .replace(/(?:(?<=\\n)|(?<![a-z0-9]))[hsjc]_[0-9a-z]{6,}(?![a-z0-9])/g, name("id"))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, name("uuid"))
    .replace(/(schedule|job) [a-z0-9]{8}\b/g, (_, k) => `${k} <id>`)
    // Schedule and job ids: 8 lowercase letters and digits; at the start of a list row, any 8.
    .replace(/(?:(?<=\\n)|^)[0-9a-z]{8}(?=  \[)/g, name("id"))
    .replace(/(?:(?<=\\n)|(?<![0-9a-zA-Z_-]))(?=[0-9a-z]{0,7}\d)(?=[0-9a-z]{0,7}[a-z])[0-9a-z]{8}(?![0-9a-zA-Z_-])/g, name("id"))
    .replace(/\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?Z?)?/g, (m) => (m.startsWith("2099") ? m : "<time>"))
    .replace(/\d{8}T\d{9}Z(-\d+)?/g, "<stamp>")
    .replace(/\(\d+\.\d s\)|in \d+\.\d s/g, "<secs>")
    .replace(/(localhost|127\.0\.0\.1):\d+/g, "$1:<port>")
    // The Mac's system version in a bug report (changes with every macOS update).
    .replace(/OS%3A\+[^%]+(%28[^%]*%29)?/g, "OS%3A+<os>")
    .replace(/\/private\/var\/[^"\n\\ ]*|\/var\/folders\/[^"\n\\ ]*|\/tmp\/[^"\n\\ ]*/g, "<path>");
}
