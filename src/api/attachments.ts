// Uploads (raw bytes, before the JSON-only check) and attached files. Moved verbatim from http.ts.
import { statSync } from "node:fs";
import { join } from "node:path";
import { AttachmentError, attachmentFile, attachmentType, cleanFileName, IMAGE_TYPES, opensInline, saveAttachment, UNSUPPORTED, uploadExt } from "../board/attachments";
import { attachmentHeader } from "../board/share";
import { type ApiContext, HttpError, NEXT, type RouteResult } from "./context";

/** /api/attachments */
export async function attachmentRoutes(ctx: ApiContext, req: Request, url: URL, parts: string[], m: string, type: string): Promise<RouteResult> {
  const { store, json } = ctx;
  // Uploads send the raw bytes: images with their image/* type, other files as application/octet-stream with
  // the original name in x-file-name. Neither is CORS-safelisted, so they preflight like JSON does.
  if (parts[0] === "attachments") {
    if (m === "POST" && parts.length === 1) {
      if (!IMAGE_TYPES[type] && type !== "application/octet-stream") throw new HttpError(415, UNSUPPORTED);
      let fileName: string | null = null;
      try {
        fileName = decodeURIComponent(req.headers.get("x-file-name") ?? "") || null;
      } catch {}
      try {
        const name = saveAttachment(store.attachmentsDir, uploadExt(type, fileName), new Uint8Array(await req.arrayBuffer()));
        return json({ url: `/api/attachments/${name}`, path: join(store.attachmentsDir, name) }, 201);
      } catch (e) {
        if (e instanceof AttachmentError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    if (m === "GET" && parts.length === 3 && parts[2] === "info") {
      const file = attachmentFile(store.attachmentsDir, parts[1]);
      if (!file) throw new HttpError(404, "attachment not found");
      return json({ size: statSync(file).size });
    }
    if (m === "GET" && parts.length === 2) {
      const file = attachmentFile(store.attachmentsDir, parts[1]);
      if (!file) throw new HttpError(404, "attachment not found");
      // Office files and ?download=1 download, under the original name (?name=, the link text) when given.
      const shown = url.searchParams.get("name");
      const download = url.searchParams.has("download") || !opensInline(parts[1]);
      const headers: Record<string, string> = {
        "content-type": attachmentType(parts[1])!,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "private, max-age=31536000, immutable",
      };
      if (download || shown) {
        const disposition = attachmentHeader(shown ? cleanFileName(shown) : parts[1]);
        headers["content-disposition"] = download ? disposition : disposition.replace(/^attachment/, "inline");
      }
      return new Response(Bun.file(file), { headers });
    }
    throw new HttpError(404, "not found");
  }
  return NEXT;
}
