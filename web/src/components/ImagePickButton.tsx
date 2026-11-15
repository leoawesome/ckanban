import { useRef, useState, type RefObject } from "react";
import { ACCEPT, PHOTO_ACCEPT } from "./attachText";
import type { MenuItem } from "./HeaderMenu";
import { ImageIcon, PaperclipIcon, PlusIcon } from "./icons";
import type { useImagePaste } from "./imagePaste";
import { MoreSheet } from "./PhoneNav";
import { usePhone } from "./usePhone";

const FILE_TYPES = "PDF, Word, Excel, PowerPoint, text or code";

/**
 * "Attach" button next to a markdown box: opens the system picker and adds the chosen images and files like a paste.
 * The way in where paste and drop don't work. Phones get two buttons instead: Photo (images only, so the phone opens
 * its gallery straight away) and a paperclip for files; a mixed picker there only offers Camera / Files. With `merged`
 * (the chat's message box) a phone gets one "+" instead, whose sheet offers Photo and File.
 */
export function ImagePickButton({ images, target, disabled, className = "", merged, extra }: {
  images: ReturnType<typeof useImagePaste>;
  target: RefObject<HTMLTextAreaElement>;
  disabled?: boolean;
  className?: string;
  merged?: boolean;
  /** With `merged` on a phone: more rows in the "+" sheet, after Photo and File (the chat's Snippet, Skill, old chat). */
  extra?: MenuItem[];
}) {
  const phone = usePhone();
  const [sheet, setSheet] = useState(false);
  const photo = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  // No `capture`: the phone then offers its library rather than only the camera.
  const input = (ref: RefObject<HTMLInputElement>, accept: string) => (
    <input ref={ref} type="file" accept={accept} multiple hidden tabIndex={-1}
      onChange={(e) => {
        const files = Array.from(e.currentTarget.files ?? []);
        e.currentTarget.value = ""; // picking the same file again still fires change
        if (files.length && target.current) images.pick(target.current, files);
      }} />
  );
  if (phone && merged) {
    return (
      <span className="image-pick-group">
        <button type="button" className={`btn small image-pick add-pick ${className}`} disabled={disabled}
          aria-label={extra?.length ? "Add a photo, file, snippet or skill" : "Add a photo or file"} aria-haspopup="menu"
          title={extra?.length ? "Add a photo, file, snippet or skill" : "Add a photo or file"} onClick={() => setSheet(true)}>
          <PlusIcon size={16} />
        </button>
        {sheet && (
          <MoreSheet label="Add" onClose={() => setSheet(false)} items={[
            { label: "Photo", icon: <ImageIcon />, title: "Add photos from your gallery", onSelect: () => photo.current?.click() },
            { label: "File", icon: <PaperclipIcon />, title: `Add a file: ${FILE_TYPES}`, onSelect: () => file.current?.click() },
            ...(extra ?? []),
          ]} />
        )}
        {input(photo, PHOTO_ACCEPT)}
        {input(file, ACCEPT)}
      </span>
    );
  }
  if (phone) {
    return (
      <span className="image-pick-group">
        <button type="button" className={`btn small image-pick ${className}`} disabled={disabled}
          title="Add photos from your gallery" onClick={() => photo.current?.click()}>
          <ImageIcon /> <span className="image-pick-label">Photo</span>
        </button>
        <button type="button" className={`btn small image-pick file-pick ${className}`} disabled={disabled}
          aria-label="Add file" title={`Add a file: ${FILE_TYPES}`} onClick={() => file.current?.click()}>
          <PaperclipIcon />
        </button>
        {input(photo, PHOTO_ACCEPT)}
        {input(file, ACCEPT)}
      </span>
    );
  }
  return (
    <>
      <button type="button" className={`btn small image-pick ${className}`} disabled={disabled}
        title={`Attach images or files: ${FILE_TYPES} (or paste / drop them into the text)`}
        onClick={() => file.current?.click()}>
        <PaperclipIcon /> <span className="image-pick-label">Attach</span>
      </button>
      {input(file, ACCEPT)}
    </>
  );
}
