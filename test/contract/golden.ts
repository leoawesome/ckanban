// Bun's answers, recorded once before P4 removed the Bun server, for the tests that used to run Bun and the Rust
// server side by side (board-parity, mcp-parity). `CKANBAN_GOLDEN_RECORD=1` (only possible on a commit that still has
// Bun's server: the last one is named in docs/rust-port.md) writes test/contract/golden/<name>.json from Bun; without
// it each test checks the server under test against that file, value by value in order.
import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RECORD = process.env.CKANBAN_GOLDEN_RECORD === "1";

export class Golden {
  readonly file: string;
  private kept: { label: string; value: unknown }[] = [];
  private next = 0;

  constructor(name: string) {
    this.file = join(import.meta.dir, "golden", `${name}.json`);
    if (!RECORD) {
      if (!existsSync(this.file)) throw new Error(`${this.file} is missing: it is recorded from Bun (CKANBAN_GOLDEN_RECORD=1)`);
      this.kept = JSON.parse(readFileSync(this.file, "utf8"));
    }
  }

  /** Recording: keeps Bun's `value`. Checking: the server's `value` must be the one Bun gave at this point. */
  match(label: string, value: unknown) {
    if (RECORD) {
      this.kept.push({ label, value });
      return;
    }
    const want = this.kept[this.next++];
    expect({ label, value }).toEqual(want ?? { label: "(nothing recorded here)", value: null });
  }

  /** Recording: writes the file. Checking: every recorded value was checked. */
  done() {
    if (RECORD) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.kept, null, 1) + "\n");
      return;
    }
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
    .replace(/\/private\/var\/[^"\n\\ ]*|\/var\/folders\/[^"\n\\ ]*|\/tmp\/[^"\n\\ ]*/g, "<path>");
}
