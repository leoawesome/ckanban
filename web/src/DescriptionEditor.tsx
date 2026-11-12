import { useMemo, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { AttachmentChips } from "./AttachmentChips";
import { ImagePickButton } from "./ImagePickButton";
import type { useImagePaste } from "./imagePaste";
import { useSlashCommands, useSlashPicker } from "./SlashPicker";
import { useSnippetPicker } from "./SnippetPicker";
import type { SlashCommand } from "./slashText";
import { useTypeTrigger } from "./typeTrigger";
import { usePhone } from "./usePhone";

/** What `/` offers in a description: skills and custom commands (built-ins mean nothing outside the chat). */
export function useDescriptionCommands(slug: string, ticketId?: string): SlashCommand[] | null {
  const all = useSlashCommands(slug, ticketId);
  return useMemo(() => all?.filter((c) => c.kind !== "builtin") ?? null, [all]);
}

/**
 * The markdown description box of new tickets, the ticket panel and schedules: `@` inserts a snippet,
 * `/` picks a skill (just text: Claude reads it like the rest), images paste, drop or pick in. One look everywhere.
 */
export function DescriptionEditor({ slug, ticketId, value, setValue, images, inputRef, rows = 8, placeholder, ariaLabel, autoFocus, fill, onKeyDown, above, tools }: {
  slug: string;
  /** The ticket's own skills (its worktree); without one, the board folder's. */
  ticketId?: string;
  value: string;
  setValue: (v: string) => void;
  images?: ReturnType<typeof useImagePaste>;
  inputRef: RefObject<HTMLTextAreaElement>;
  rows?: number;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  /** Grow to fill the parent (ticket panel) instead of a fixed number of rows. */
  fill?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Shown inside the box between the text and the toolbar (New ticket: the tag row). */
  above?: ReactNode;
  /** Extra buttons at the end of the toolbar (New ticket: # Tag). */
  tools?: ReactNode;
}) {
  const snippets = useSnippetPicker({ slug, ref: inputRef, setValue });
  const commands = useDescriptionCommands(slug, ticketId);
  const slash = useSlashPicker({ commands, ref: inputRef, setValue, inline: true });
  const phone = usePhone();
  // Phone buttons type `@` / `/` at the caret; after that render the caret moves past it and the picker opens.
  const typeTrigger = useTypeTrigger(inputRef, setValue, () => {
    snippets.handlers.onSelect();
    slash.handlers.onSelect();
  });
  // Keep the textarea focused (and the caret where it was) while a button is pressed.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <>
    <div className={`desc-editor${fill ? " fill" : ""}${images?.dragOver ? " drop-target" : ""}`}>
      <textarea ref={inputRef} rows={rows} value={value} onChange={(e) => setValue(e.target.value)} autoFocus={autoFocus} aria-label={ariaLabel}
        placeholder={placeholder ?? "Context, what done looks like, links…"} {...images?.handlers}
        onSelect={() => { snippets.handlers.onSelect(); slash.handlers.onSelect(); }}
        onBlur={() => { snippets.handlers.onBlur(); slash.handlers.onBlur(); }}
        onKeyDown={(e) => {
          if (snippets.onKeyDown(e) || slash.onKeyDown(e)) return;
          onKeyDown?.(e);
        }} />
      {images && <AttachmentChips text={value} images={images} />}
      {above}
      {phone ? (
        // Phones: tap buttons instead of keyboard hints (paste and `@` / `/` are awkward on a phone keyboard).
        <div className="desc-editor-foot phone">
          {images && <ImagePickButton images={images} target={inputRef} className="desc-editor-tool" />}
          <button type="button" className="desc-editor-tool" onMouseDown={keepFocus} onClick={() => typeTrigger("@")}><kbd>@</kbd> Snippet</button>
          {!!commands?.length && (
            <button type="button" className="desc-editor-tool" onMouseDown={keepFocus} onClick={() => typeTrigger("/")}><kbd>/</kbd> Skill</button>
          )}
          {tools}
          {images?.uploading && <span className="desc-editor-status">Uploading…</span>}
        </div>
      ) : (
        <div className="desc-editor-foot">
          <span><kbd>@</kbd> snippet</span>
          <span><kbd>/</kbd> skill</span>
          {images && <span>{images.uploading ? "Uploading…" : "Paste or drop files"}</span>}
          {images && <ImagePickButton images={images} target={inputRef} className="desc-editor-pick" />}
          {tools}
        </div>
      )}
      {snippets.popup}
      {slash.popup}
    </div>
    {images?.error && <span className="form-error">{images.error}</span>}
    </>
  );
}
