// read_artifact and publish_artifact: claude.ai artifact pages. Moved verbatim from mcp-server.ts.
import { ClientError } from "../cli/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactJob, type ArtifactOutcome, runArtifactJob } from "../runs/artifact";
import { type Tool, type ToolContext, str } from "./shared";

/** How long an artifact job may take: 3 minutes, or less when MCP_TOOL_TIMEOUT would cut the call off sooner. */
export function artifactWaitMs(env: Record<string, string | undefined>): number {
  const wait = 180_000;
  const limit = Number(env.MCP_TOOL_TIMEOUT);
  if (!Number.isFinite(limit) || limit < 1000) return wait;
  return Math.max(1000, Math.min(wait, limit - 5_000));
}

/** File name for a published page: the artifact id when updating (so updates overwrite it), else the title. */
export function artifactFileName(url: string | undefined, title: string | undefined, now: number): string {
  const id = url?.match(/\/artifact\/([A-Za-z0-9-]+)/)?.[1];
  const slug = (id ?? title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || `artifact-${now}`}.html`;
}

export function runArtifact(job: ArtifactJob, ctx: ToolContext): Promise<ArtifactOutcome> {
  const timeoutMs = artifactWaitMs(ctx.env);
  if (ctx.artifact) return ctx.artifact(job, timeoutMs);
  return runArtifactJob(job, { bin: ctx.env.CKANBAN_CLAUDE_BIN, model: ctx.env.CKANBAN_ARTIFACT_MODEL, timeoutMs });
}

export const ARTIFACT_URL = { type: "string", description: "claude.ai artifact link, e.g. https://claude.ai/artifact/AbC123." };

// The board's stand-in for the Artifact tool, which headless runs don't get. The planning chat uses
// them too: publishing only writes the page to the ticket's outputs folder, never the project.
export const ARTIFACT_TOOLS: Tool[] = [
  {
    name: "read_artifact",
    description:
      "Read a claude.ai artifact and return its page source (HTML). Use it to look at an artifact, or before publish_artifact " +
      "with its url to update it: edit the returned HTML and publish the whole page. Takes a minute or two.",
    inputSchema: { type: "object", properties: { url: ARTIFACT_URL }, required: ["url"] },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const url = str(args, "url")!.trim();
      const r = await runArtifact({ kind: "read", url }, ctx);
      if (!r.ok) throw new ClientError(`artifact read failed: ${r.error}`);
      if (r.kind !== "read") throw new ClientError("artifact read failed: no page source");
      return r.html;
    },
  },
  {
    name: "publish_artifact",
    description:
      "Publish a complete HTML page as a claude.ai artifact and return its link. Pass url to update that artifact " +
      "(same link, new version): read_artifact it first and send the full edited page, not a diff. " +
      "The page is also saved in the ticket's outputs folder. Takes a minute or two.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "The full page source (a complete HTML document)." },
        url: { ...ARTIFACT_URL, description: "Artifact to update (keeps its link). Omit to publish a new page." },
        title: { type: "string", description: "Page title (optional)." },
      },
      required: ["html"],
    },
    annotations: { readOnlyHint: true },
    changes: false,
    async run(args, ctx) {
      const html = str(args, "html")!;
      const url = str(args, "url", false)?.trim();
      const title = str(args, "title", false)?.trim();
      const dir = join(ctx.env.CKANBAN_OUTPUT_DIR || join(tmpdir(), "ckanban-artifacts"), "artifacts");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, artifactFileName(url, title, (ctx.now ?? Date.now)()));
      writeFileSync(file, html);
      const r = await runArtifact({ kind: "publish", file, url, title }, ctx);
      if (!r.ok) throw new ClientError(`artifact publish failed: ${r.error}`);
      if (r.kind !== "publish") throw new ClientError("artifact publish failed: no link came back");
      // Same wording as the Artifact tool, so the board lists the page on the ticket.
      return r.text;
    },
  },
];
