import type { ReactNode, SVGProps } from "react";

/** Small inline icon set (16px grid, stroked, currentColor). No icon library on purpose. */
type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function svg(paths: ReactNode, { size = 14, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" className="icon" {...rest}>
      {paths}
    </svg>
  );
}

export const CloseIcon = (p: IconProps) => svg(<path d="M4 4l8 8M12 4l-8 8" />, p);
export const PlusIcon = (p: IconProps) => svg(<path d="M8 3v10M3 8h10" />, p);
export const CheckIcon = (p: IconProps) => svg(<path d="M3.5 8.5l3 3 6-7" />, p);
export const CopyIcon = (p: IconProps) => svg(<><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.8c0-.7-.6-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.4c0 .7.6 1.3 1.3 1.3h1.7" /></>, p);
export const ExternalIcon = (p: IconProps) => svg(<><path d="M9 3h4v4M13 3L7.5 8.5" /><path d="M11 9.5v2.7c0 .7-.6 1.3-1.3 1.3H3.8c-.7 0-1.3-.6-1.3-1.3V6.3c0-.7.6-1.3 1.3-1.3h2.7" /></>, p);
export const DownloadIcon = (p: IconProps) => svg(<path d="M8 2.5v7.5M4.8 7l3.2 3.2L11.2 7M3 13h10" />, p);
export const LinkIcon = (p: IconProps) => svg(<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.1-2.1a2.6 2.6 0 0 0-3.7-3.7l-.8.8M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />, p);
export const ClipIcon = (p: IconProps) => svg(<path d="M12.5 7.5l-4.6 4.6a3 3 0 0 1-4.2-4.2l4.9-4.9a2 2 0 0 1 2.8 2.8L6.6 10.6a1 1 0 0 1-1.4-1.4l4.3-4.3" />, p);
export const HashIcon = (p: IconProps) => svg(<path d="M6.3 2.5l-1.3 11M11 2.5l-1.3 11M3 6h10.5M2.5 10H13" />, p);
export const FileIcon = (p: IconProps) => svg(<><path d="M9 2H4.8c-.7 0-1.3.6-1.3 1.3v9.4c0 .7.6 1.3 1.3 1.3h6.4c.7 0 1.3-.6 1.3-1.3V5.5L9 2z" /><path d="M9 2v3.5h3.5" /></>, p);
export const FileTextIcon = (p: IconProps) => svg(<><path d="M9 2H4.8c-.7 0-1.3.6-1.3 1.3v9.4c0 .7.6 1.3 1.3 1.3h6.4c.7 0 1.3-.6 1.3-1.3V5.5L9 2z" /><path d="M9 2v3.5h3.5M5.8 8.5h4.4M5.8 11h4.4" /></>, p);
export const FileCodeIcon = (p: IconProps) => svg(<><path d="M9 2H4.8c-.7 0-1.3.6-1.3 1.3v9.4c0 .7.6 1.3 1.3 1.3h6.4c.7 0 1.3-.6 1.3-1.3V5.5L9 2z" /><path d="M6.8 8.3L5.5 9.8l1.3 1.5M9.2 8.3l1.3 1.5-1.3 1.5" /></>, p);
export const FileImageIcon = (p: IconProps) => svg(<><path d="M9 2H4.8c-.7 0-1.3.6-1.3 1.3v9.4c0 .7.6 1.3 1.3 1.3h6.4c.7 0 1.3-.6 1.3-1.3V5.5L9 2z" /><path d="M5 12l2-2.5 1.5 1.5 1-1L11 12" /></>, p);
export const PaperclipIcon = (p: IconProps) => svg(<path d="M13.2 7.6l-5 5a3.2 3.2 0 01-4.5-4.5l5.4-5.4a2.1 2.1 0 013 3l-5.3 5.3a1 1 0 01-1.5-1.5l4.8-4.8" />, p);
export const ImageIcon = (p: IconProps) => svg(<><rect x="2" y="3" width="12" height="10" rx="1.6" /><circle cx="5.8" cy="6.6" r="1.1" /><path d="M14 10.6l-3.4-3.4L4 13" /></>, p);
export const FolderIcon = (p: IconProps) => svg(<path d="M2.5 4.3c0-.7.6-1.3 1.3-1.3h2.6l1.4 1.5h4.4c.7 0 1.3.6 1.3 1.3v5.9c0 .7-.6 1.3-1.3 1.3H3.8c-.7 0-1.3-.6-1.3-1.3V4.3z" />, p);
export const FolderOpenIcon = (p: IconProps) => svg(<path d="M2.5 11.7V4.3c0-.7.6-1.3 1.3-1.3h2.6l1.4 1.5h4c.7 0 1.3.6 1.3 1.3V7M2.5 11.7L4.3 7.6c.2-.4.6-.6 1-.6h8.4c.5 0 .8.5.6.9L12.5 12c-.2.4-.6.6-1 .6H3.4c-.6 0-1-.5-.9-.9z" />, p);
export const BranchIcon = (p: IconProps) => svg(<><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5" r="1.5" /><path d="M4.5 5v6M11.5 6.5c0 2.5-2 3.5-7 4.5" /></>, p);
/** A card going to another board: an arrow out of a box. */
export const MoveIcon = (p: IconProps) => svg(<><path d="M9.5 2.5h-5.7c-.7 0-1.3.6-1.3 1.3v8.4c0 .7.6 1.3 1.3 1.3h5.7" /><path d="M7 8h7M11.2 5.2L14 8l-2.8 2.8" /></>, p);
export const ChevronRightIcon = (p: IconProps) => svg(<path d="M6 3.5L10.5 8 6 12.5" />, p);
export const ChevronDownIcon = (p: IconProps) => svg(<path d="M3.5 6L8 10.5 12.5 6" />, p);
export const ChevronUpIcon = (p: IconProps) => svg(<path d="M3.5 10L8 5.5 12.5 10" />, p);
export const ChevronLeftIcon = (p: IconProps) => svg(<path d="M10 3.5L5.5 8l4.5 4.5" />, p);
export const ArrowDownIcon = (p: IconProps) => svg(<path d="M8 3v10M4 9l4 4 4-4" />, p);
export const ArrowUpIcon = (p: IconProps) => svg(<path d="M8 13V3M4 7l4-4 4 4" />, p);
export const MoreIcon = (p: IconProps) => svg(<><circle cx="3.5" cy="8" r=".9" fill="currentColor" /><circle cx="8" cy="8" r=".9" fill="currentColor" /><circle cx="12.5" cy="8" r=".9" fill="currentColor" /></>, p);
export const SearchIcon = (p: IconProps) => svg(<><circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2L13.5 13.5" /></>, p);
export const TerminalIcon = (p: IconProps) => svg(<><rect x="2" y="3" width="12" height="10" rx="1.8" /><path d="M5 6.5L7 8.3 5 10M8.5 10.5H11" /></>, p);
export const ChatIcon = (p: IconProps) => svg(<path d="M3.8 2.8h8.4c.7 0 1.3.6 1.3 1.3v5.6c0 .7-.6 1.3-1.3 1.3H7.5L4.5 13.5V11h-.7c-.7 0-1.3-.6-1.3-1.3V4.1c0-.7.6-1.3 1.3-1.3z" />, p);
/** Teammates (the Team side panel). */
export const TeamIcon = (p: IconProps) => svg(<><circle cx="6" cy="5.4" r="2.2" /><path d="M2 13.2c0-2.2 1.8-3.9 4-3.9s4 1.7 4 3.9" /><path d="M10.4 3.4a2.1 2.1 0 0 1 0 4.1M11.6 9.5c1.4.4 2.4 1.9 2.4 3.7" /></>, p);
export const RefreshIcon = (p: IconProps) => svg(<><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.5v3h-3" /></>, p);
export const KeyboardIcon = (p: IconProps) => svg(<><rect x="1.8" y="4" width="12.4" height="8" rx="1.5" /><path d="M4.5 6.6h.01M7 6.6h.01M9.5 6.6h.01M12 6.6h.01M5 9.4h6" /></>, p);
/** A shared device or other exclusive resource a ticket needs (Ticket.needs). */
export const NowIcon = (p: IconProps) => svg(<><circle cx="8" cy="8" r="6.2" /><circle cx="8" cy="8" r="2.2" fill="currentColor" /></>, p);
export const BoardIcon = (p: IconProps) => svg(<><rect x="2" y="2.5" width="3.4" height="11" rx="1" /><rect x="6.3" y="2.5" width="3.4" height="7.5" rx="1" /><rect x="10.6" y="2.5" width="3.4" height="9" rx="1" /></>, p);
export const GlobeIcon = (p: IconProps) => svg(<><circle cx="8" cy="8" r="5.8" /><path d="M2.2 8h11.6M8 2.2c1.6 1.6 2.4 3.5 2.4 5.8S9.6 12.2 8 13.8M8 2.2C6.4 3.8 5.6 5.7 5.6 8s.8 4.2 2.4 5.8" /></>, p);
export const DeviceIcon = (p: IconProps) => svg(<><rect x="4.5" y="1.8" width="7" height="12.4" rx="1.6" /><path d="M7.2 11.8h1.6" /></>, p);
export const BellIcon = (p: IconProps) => svg(<path d="M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1.2 1.3H2.8L4 11.2zM6.6 14h2.8" />, p);
export const GearIcon = (p: IconProps) => svg(<><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6" /></>, p);
export const ClockIcon = (p: IconProps) => svg(<><circle cx="8" cy="8" r="6.2" /><path d="M8 4.6V8l2.4 1.6" /></>, p);
export const AtIcon = (p: IconProps) => svg(<><circle cx="8" cy="8" r="2.4" /><path d="M10.4 8v1.1c0 1 .8 1.7 1.7 1.7s1.6-.8 1.6-1.7V8A5.7 5.7 0 1 0 11 13" /></>, p);
export const PlugIcon = (p: IconProps) => svg(<path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0V5zM8 11v3" />, p);
export const BugIcon = (p: IconProps) => svg(<><rect x="5" y="5" width="6" height="8.5" rx="3" /><path d="M6.3 5.2a1.7 1.7 0 0 1 3.4 0M8 8v5.5M5 8.5H2.5M13.5 8.5H11M5.2 11.5l-2 1.2M10.8 11.5l2 1.2M5.3 6.3L3.5 5M10.7 6.3L12.5 5" /></>, p);
export const TrashIcon = (p: IconProps) => svg(<path d="M2.8 4.5h10.4M6.3 4.5V3.2c0-.4.3-.7.7-.7h2c.4 0 .7.3.7.7v1.3M4.2 4.5l.6 8.3c0 .4.4.7.8.7h4.8c.4 0 .8-.3.8-.7l.6-8.3" />, p);
/** A huddle: two speech bubbles (agents talking together). */
export const HuddleIcon = (p: IconProps) => svg(<><path d="M2.5 3.6c0-.6.5-1.1 1.1-1.1h5.8c.6 0 1.1.5 1.1 1.1v3.8c0 .6-.5 1.1-1.1 1.1H5.6L3.5 10.3V8.5h0c-.6 0-1-.5-1-1.1V3.6z" /><path d="M12.2 5.5h.2c.6 0 1.1.5 1.1 1.1v3.8c0 .6-.4 1.1-1 1.1v1.8l-2.1-1.8H7.6c-.6 0-1.1-.5-1.1-1.1" /></>, p);
/** An idea ("Help me understand"). */
export const BulbIcon = (p: IconProps) => svg(<><path d="M6 11.5h4M6.5 13.8h3" /><path d="M5.9 9.6C4.9 8.9 4.2 7.8 4.2 6.5a3.8 3.8 0 0 1 7.6 0c0 1.3-.7 2.4-1.7 3.1-.3.2-.5.6-.5 1v.9H6.4v-.9c0-.4-.2-.8-.5-1z" /></>, p);
/** Learnings: a graduation cap. */
export const CapIcon = (p: IconProps) => svg(<><path d="M1.8 6.2L8 3.2l6.2 3L8 9.2 1.8 6.2z" /><path d="M4.5 7.6v3c0 .9 1.6 1.9 3.5 1.9s3.5-1 3.5-1.9v-3M14.2 6.2v3.6" /></>, p);
/** A push pin: the huddle brief, and 📌 pinned tickets. */
export const PinIcon = (p: IconProps) => svg(<><path d="M9.8 2.2l4 4-1.4.6-2.3 2.3-.3 2.7-1.2 1.2-5.4-5.4 1.2-1.2 2.7-.3 2.3-2.3.4-1.6z" /><path d="M5.2 10.8L2.2 13.8" /></>, p);
/** Thinking: a thought bubble. */
export const ThoughtIcon = (p: IconProps) => svg(<><path d="M5 10.2a3 3 0 0 1-.4-5.9 3.4 3.4 0 0 1 6.3-.2 2.8 2.8 0 0 1 .4 5.6c-.3.3-.8.5-1.3.5H5z" /><circle cx="4" cy="12.3" r=".8" /><circle cx="2.4" cy="14" r=".5" /></>, p);
/** Stopped: an octagon with a bar. */
export const StopIcon = (p: IconProps) => svg(<><path d="M5.5 2h5L14 5.5v5L10.5 14h-5L2 10.5v-5L5.5 2z" /><path d="M5.2 8h5.6" /></>, p);
/** Warning: a triangle with a mark. */
export const WarnIcon = (p: IconProps) => svg(<><path d="M7.1 2.6a1 1 0 0 1 1.8 0l5.3 9.6a1 1 0 0 1-.9 1.5H2.7a1 1 0 0 1-.9-1.5l5.3-9.6z" /><path d="M8 6.3v3.2M8 11.6h.01" /></>, p);
/** Theme choices (header menu). */
export const SunIcon = (p: IconProps) => svg(<><circle cx="8" cy="8" r="2.8" /><path d="M8 1.8v1.3M8 12.9v1.3M1.8 8h1.3M12.9 8h1.3M3.6 3.6l.9.9M11.5 11.5l.9.9M3.6 12.4l.9-.9M11.5 4.5l.9-.9" /></>, p);
export const MoonIcon = (p: IconProps) => svg(<path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8z" />, p);
export const SystemThemeIcon = (p: IconProps) => svg(<><rect x="2" y="2.8" width="12" height="8.4" rx="1.4" /><path d="M5.5 13.6h5M8 11.2v2.4" /></>, p);
export const InfoIcon = (p: IconProps) => svg(<><circle cx="8" cy="8" r="6.2" /><path d="M8 7.3v3.7M8 5h.01" /></>, p);
export const CollapseIcon = (p: IconProps) => svg(<path d="M9.5 3.5L5 8l4.5 4.5M13 3v10" />, p);
export const ExpandIcon = (p: IconProps) => svg(<path d="M6.5 3.5L11 8l-4.5 4.5M3 3v10" />, p);
export const SparkIcon = ({ size = 12, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false" className="icon" {...rest}>
    <path d="M8 0c.5 3.9 2.1 5.5 6 6-3.9.5-5.5 2.1-6 6-.5-3.9-2.1-5.5-6-6 3.9-.5 5.5-2.1 6-6Z" fill="currentColor" />
  </svg>
);

/** App logo: an L of cards on an accent tile, the last card sliding into place. Same shape as the favicon in index.html and docs/assets/logo.svg. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false" className="logo">
      <rect width="32" height="32" rx="8" style={{ fill: "var(--accent)" }} />
      <g fill="#fff">
        <rect x="6" y="6.5" width="5.5" height="5.5" rx="1.4" />
        <rect x="6" y="13.25" width="5.5" height="5.5" rx="1.4" />
        <rect x="6" y="20" width="5.5" height="5.5" rx="1.4" />
        <rect x="13.25" y="20" width="5.5" height="5.5" rx="1.4" />
        <rect x="20.5" y="20" width="5.5" height="5.5" rx="1.4" opacity=".25" />
        <rect x="20.5" y="14.2" width="6" height="6" rx="1.5" transform="rotate(-14 23.5 17)" />
      </g>
    </svg>
  );
}
export const LoopIcon = (p: IconProps) => svg(<path d="M3 8a5 5 0 0 1 8.6-3.4M13 8a5 5 0 0 1-8.6 3.4M11.8 2v3h-3M4.2 14v-3h3" />, p);
/** Fill the side column with one panel, and back. */
export const MaximizeIcon = (p: IconProps) => svg(<path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />, p);
export const RestoreIcon = (p: IconProps) => svg(<path d="M13.5 6.5h-4v-4M9.5 6.5L14 2M2.5 9.5h4v4M6.5 9.5L2 14" />, p);
/** The side panel column (the Panels button). */
export const PanelsIcon = (p: IconProps) => svg(<><rect x="2" y="2.5" width="12" height="11" rx="1.8" /><path d="M9.5 2.5v11M9.5 8H14" /></>, p);
/** A ticket's changes (the Changes panel). */
export const DiffIcon = (p: IconProps) => svg(<path d="M5 2.5v6M2 5.5h6M2 12.5h6M11.5 2.5v11M9.5 11.5l2 2 2-2" />, p);

/** Messages: an inbox tray (Notifications keeps the bell). */
export const InboxIcon = (p: IconProps) => svg(<><path d="M2.5 9.5l1.6-5.2c.2-.5.6-.8 1.1-.8h5.6c.5 0 .9.3 1.1.8l1.6 5.2v2.7c0 .7-.6 1.3-1.3 1.3H3.8c-.7 0-1.3-.6-1.3-1.3V9.5z" /><path d="M2.5 9.5h3l.8 1.5h3.4l.8-1.5h3" /></>, p);
/** Board settings: sliders (GearIcon reads as a sun at small sizes). */
export const SlidersIcon = (p: IconProps) => svg(<><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" /><circle cx="10" cy="4.5" r="1.5" /><circle cx="6" cy="11.5" r="1.5" /></>, p);
/** Shared devices: a laptop with a phone beside it (Phone access keeps the single phone). */
export const DevicesIcon = (p: IconProps) => svg(<><path d="M9 11.5H1.8M3 10V4.3c0-.5.4-.8.8-.8h7.4c.4 0 .8.3.8.8V5.5" /><rect x="10" y="7" width="4.2" height="6.5" rx="1" /></>, p);
/** Filter this board's cards (the phone board's search; the top bar's magnifier searches every board). */
export const FilterIcon = (p: IconProps) => svg(<path d="M2.5 3.5h11L9.3 8.6v4.2l-2.6 1.1V8.6L2.5 3.5z" />, p);
