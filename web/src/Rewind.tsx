import { useEffect, useState } from "react";
import { filesLine, laterLine, noFilesLine, type Change } from "./rewindText";

export type RewindPreview = { blocked: string | null; files: Change[] | null; filesReason: "no-history" | "no-snapshot" | "quick-chat" | null };

/**
 * Rewind's inline confirmation under one of the user's messages (its button is in the message's row, MessageActions.tsx):
 * says what goes away. Going back cuts the chat before the message and, when asked, puts the project files back.
 */
export function RewindConfirm({ later, preview: load, apply, onClose, onError }: {
  /** Messages after this one that would be removed. */
  later: number;
  preview: () => Promise<RewindPreview>;
  /** Does the rewind (files: put the files back too); the caller closes this and handles the result. */
  apply: (files: boolean) => Promise<void>;
  onClose: () => void;
  onError: (m: string) => void;
}) {
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    load().then((p) => live && setPreview(p), (e) => live && onError(e.message));
    return () => {
      live = false;
    };
  }, []);

  const go = async (files: boolean) => {
    setBusy(true);
    try {
      await apply(files);
    } catch (e: any) {
      onError(e.message);
      setBusy(false);
    }
  };

  const canFiles = !!preview?.files?.length;
  return (
    <div className="rewind-confirm" role="group" aria-label="Rewind" onKeyDown={(e) => e.key === "Escape" && !busy && (e.stopPropagation(), onClose())}>
      <b>Go back to before this message?</b>
      {!preview ? <div className="muted small">Checking what would change…</div> : (
        <>
          <ul>
            <li>{laterLine(later)}</li>
            <li>{preview.files ? filesLine(preview.files) : noFilesLine(preview.filesReason)}</li>
          </ul>
          {canFiles && <div className="rewind-warn">Files you edited yourself since then are also reset.</div>}
          <div className="rewind-actions">
            <button type="button" className="btn small primary" disabled={busy} onClick={() => go(canFiles)}>
              {canFiles ? "Rewind chat and files" : "Rewind chat"}
            </button>
            {canFiles && <button type="button" className="btn small" disabled={busy} onClick={() => go(false)}>Chat only</button>}
            <button type="button" className="btn small" disabled={busy} onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
