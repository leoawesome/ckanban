/**
 * Stand-in for the `claude` command in the speed check's daemon: no real Claude runs and nothing goes to Anthropic.
 * A print run (-p) writes a short stream of events (a tool call, a reply, a result) and ends; anything else
 * (`--version`, `mcp list`, ...) answers at once with nothing.
 */
const a = process.argv.slice(2);
if (a.includes("--version")) {
  console.log("2.1.0 (Claude Code)");
  process.exit(0);
}
if (!a.includes("-p") && !a.includes("--print")) process.exit(0);
const ri = a.indexOf("--resume");
const sid = ri >= 0 ? a[ri + 1] : crypto.randomUUID();
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
await Bun.sleep(300);
out({ type: "system", subtype: "init", session_id: sid, cwd: process.cwd(), model: "claude-fake", tools: [] });
await Bun.sleep(1000);
out({ type: "assistant", session_id: sid, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } });
await Bun.sleep(Number(process.env.SPEEDCHECK_FAKE_RUN_MS ?? 5000));
out({ type: "user", session_id: sid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "README.md" }] } });
out({ type: "assistant", session_id: sid, message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Done." }] } });
out({ type: "result", subtype: "success", session_id: sid, is_error: false, result: "Done.", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });

export {};
