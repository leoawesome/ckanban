import { afterAll, setDefaultTimeout } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A test's deadline (tests can set their own). Generous: a passing test never waits it out, and a machine running
// several suites at once can be many times slower than an idle one. `bun test <file>` gets it too, not only `bun run test`.
setDefaultTimeout(60_000);

// Tests run inside board and huddle runs too; their identity vars would leak into the code under test
// (and into fake claude children), so every test file starts without them.
for (const k of ["CKANBAN_TICKET", "CKANBAN_HUDDLE_AGENT", "CKANBAN_OUTPUT_DIR"]) delete process.env[k];
// Code that falls back to the real `claude` (side calls such as parent suggestions) gets a stand-in that fails at
// once: tests never spend money or wait on the user's own Claude. Tests that need a fake claude pass their own.
process.env.CKANBAN_CLAUDE_BIN = "/bin/false";
// Saving a copy of the folder before a message gives up after 2s in the app; a machine running several test suites
// can be that slow, so tests allow it more time (tests of the limit itself pass their own).
process.env.CKANBAN_SNAPSHOT_LIMIT_MS = "30000";

// Git in tests ignores the user's own git config: no commit signing (slow, may prompt), hooks or
// aliases from their setup. Commits get a fixed test identity.
const gitConfig = join(tmpdir(), "ckanban-test-gitconfig");
const gitConfigText = "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n";
let current = "";
try {
  current = readFileSync(gitConfig, "utf8");
} catch {}
if (current !== gitConfigText) writeFileSync(gitConfig, gitConfigText);
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";

// Delete the temp dirs a test file made (helpers.ts tempDir) once its tests are done, so runs don't pile them up.
afterAll(() => {
  const dirs: string[] = (globalThis as any).__ckTempDirs ?? [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
