import { ReactNode } from "react";
import { FileMeta, fileKind } from "./api";

/*
 * Brand icon set. One visual system: 24px grid, 1.6px rounded strokes,
 * currentColor so icons inherit text color (slate by default, violet on
 * hover/active via CSS). The violet accent is reserved for the logomark,
 * the AI spark and focal glows.
 */

interface IconProps {
  size?: number;
  className?: string;
}

export function GearIcon({ size, className }: IconProps) {
  return (
    <Stroke size={size} className={className}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
    </Stroke>
  );
}

export function DownloadIcon({ size, className }: IconProps) {
  return (
    <Stroke size={size} className={className}>
      <path d="M12 4v10M8 10.5l4 4 4-4" />
      <path d="M5 18.5h14" />
    </Stroke>
  );
}

function Stroke({
  size = 16,
  className,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/* ---------- logomark: arched doorway with keyhole ---------- */

export function Logomark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden
    >
      <path
        d="M6 20.5V10.8a6 6 0 0 1 12 0v9.7"
        stroke="var(--accent)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M4 20.5h16"
        stroke="var(--accent)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="10.8" r="2.1" fill="var(--accent)" />
      <path d="M12 12.4l-1.5 4.8h3l-1.5-4.8z" fill="var(--accent)" />
    </svg>
  );
}

/* ---------- file-type icons ---------- */

const docBase = (
  <>
    <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3z" />
    <path d="M13.5 3v5.5H19" />
  </>
);

function PdfIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      {docBase}
      <path d="M9.6 17.5l2.4-6 2.4 6" />
      <path d="M10.6 15.3h2.8" />
    </Stroke>
  );
}

function DocxIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      {docBase}
      <path d="M8.6 12l1.1 5.5 2.3-4.6 2.3 4.6 1.1-5.5" />
    </Stroke>
  );
}

function SheetIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      {docBase}
      <rect x="8" y="11.5" width="8" height="6.5" rx="1" />
      <path d="M8 14.75h8M12 11.5v6.5" />
    </Stroke>
  );
}

function MarkdownIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <path d="M6 15v-5.5l2.4 2.8 2.4-2.8V15" />
      <path d="M16.5 9.5V15m0 0l-2-2m2 2l2-2" />
    </Stroke>
  );
}

function WebIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <ellipse cx="12" cy="12" rx="3.8" ry="8.5" />
      <path d="M3.8 12h16.4" />
    </Stroke>
  );
}

function ImageIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M5.5 17.5l4-5 3.6 4 2.4-2.6 3 3.6" />
    </Stroke>
  );
}

function TextIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      {docBase}
      <path d="M8.5 12.5h7M8.5 15.3h7M8.5 18.1h4" />
    </Stroke>
  );
}

function FileIcon(p: IconProps) {
  return <Stroke {...p}>{docBase}</Stroke>;
}

/** AI-generated files get the violet spark, always accent-colored. */
export function SparkIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="var(--accent)"
      className={className}
      aria-hidden
    >
      <path d="M10.5 3.5c.5 3.4 2.1 5.2 5.5 5.7-3.4.5-5 2.3-5.5 5.7-.5-3.4-2.1-5.2-5.5-5.7 3.4-.5 5-2.3 5.5-5.7z" />
      <path d="M17.8 13c.3 2 1.3 3.1 3.2 3.4-1.9.3-2.9 1.4-3.2 3.4-.3-2-1.3-3.1-3.2-3.4 1.9-.3 2.9-1.4 3.2-3.4z" />
      <circle cx="8" cy="18.5" r="1.1" />
    </svg>
  );
}

export function FileTypeIcon({
  file,
  size = 16,
}: {
  file: FileMeta;
  size?: number;
}) {
  switch (fileKind(file)) {
    case "image":
      return <ImageIcon size={size} />;
    case "generated":
      return <SparkIcon size={size} />;
    case "pdf":
      return <PdfIcon size={size} />;
    case "docx":
      return <DocxIcon size={size} />;
    case "sheet":
      return <SheetIcon size={size} />;
    case "markdown":
      return <MarkdownIcon size={size} />;
    case "web":
      return <WebIcon size={size} />;
    case "text":
      return <TextIcon size={size} />;
    default:
      return <FileIcon size={size} />;
  }
}

/* ---------- action icons ---------- */

export function PaperclipIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </Stroke>
  );
}

export function LockIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="5" y="11" width="14" height="9.5" rx="2.5" />
      <path d="M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11" />
      <circle cx="12" cy="15.7" r="1.3" fill="currentColor" stroke="none" />
    </Stroke>
  );
}

export function UnlockIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="5" y="11" width="14" height="9.5" rx="2.5" />
      <path d="M8.5 11V7.5a3.5 3.5 0 0 1 6.8-1.1" />
      <circle cx="12" cy="15.7" r="1.3" fill="currentColor" stroke="none" />
    </Stroke>
  );
}

export function TrashIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M3.5 6.5h17" />
      <path d="M8.5 6.5V5A1.5 1.5 0 0 1 10 3.5h4A1.5 1.5 0 0 1 15.5 5v1.5" />
      <path d="M6 6.5l.8 12.1a2 2 0 0 0 2 1.9h6.4a2 2 0 0 0 2-1.9l.8-12.1" />
      <path d="M10 10.5v6M14 10.5v6" />
    </Stroke>
  );
}

export function SendIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </Stroke>
  );
}

export function SaveIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </Stroke>
  );
}

export function CloseIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Stroke>
  );
}

export function EyeIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.7" />
    </Stroke>
  );
}

export function PencilIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M17 3.5a2.3 2.3 0 0 1 3.3 3.3L7.5 19.8l-4.2 1 1-4.2L17 3.5z" />
    </Stroke>
  );
}

/* ---------- empty-state illustrations ---------- */

/** Empty viewer: an open door with violet light spilling out. */
export function EmptyViewerArt() {
  return (
    <svg width="210" height="164" viewBox="0 0 220 172" fill="none" aria-hidden>
      <defs>
        <radialGradient id="pv-glow" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#8b7cf6" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#8b7cf6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="pv-light" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8b7cf6" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#8b7cf6" stopOpacity="0.12" />
        </linearGradient>
        <linearGradient id="pv-wedge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8b7cf6" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#8b7cf6" stopOpacity="0" />
        </linearGradient>
      </defs>

      <ellipse cx="110" cy="84" rx="100" ry="70" fill="url(#pv-glow)" />

      {/* light spilling onto the floor */}
      <path d="M82 150h56l26 18H54l28-18z" fill="url(#pv-wedge)" />

      {/* doorway interior */}
      <path
        d="M82 150V80a28 28 0 0 1 56 0v70H82z"
        fill="url(#pv-light)"
        opacity="0.85"
      />

      {/* arch frame */}
      <path
        d="M78 150V80a32 32 0 0 1 64 0v70"
        stroke="#8b93a7"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M64 150h92"
        stroke="#8b93a7"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* door panel, swung open */}
      <path
        d="M82 150l-30 12V70l30 8v72z"
        fill="#1c212c"
        stroke="#262d3b"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="58" cy="116" r="2.4" fill="#8b93a7" />

      {/* sparkles */}
      <path
        d="M164 52c.4 2.7 1.7 4.1 4.4 4.5-2.7.4-4 1.8-4.4 4.5-.4-2.7-1.7-4.1-4.4-4.5 2.7-.4 4-1.8 4.4-4.5z"
        fill="#8b7cf6"
      />
      <circle cx="152" cy="76" r="1.6" fill="#8b7cf6" opacity="0.7" />
      <circle cx="46" cy="46" r="1.4" fill="#8b7cf6" opacity="0.45" />

      {/* plant */}
      <path
        d="M182 150v-12m0 4c0-5 3-8 7-9m-7 4c0-4-2.5-6.5-6-7"
        stroke="#8b93a7"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Empty chat: a keyhole with a chat bubble — ask the room anything. */
export function EmptyChatArt() {
  return (
    <svg width="170" height="140" viewBox="0 0 200 164" fill="none" aria-hidden>
      <defs>
        <radialGradient id="pc-glow" cx="45%" cy="55%" r="55%">
          <stop offset="0%" stopColor="#8b7cf6" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#8b7cf6" stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse cx="90" cy="90" rx="90" ry="66" fill="url(#pc-glow)" />

      {/* dashed orbit */}
      <path
        d="M28 118a62 62 0 0 1 46-74"
        stroke="#262d3b"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="1 9"
      />

      {/* keyhole */}
      <circle
        cx="86"
        cy="78"
        r="20"
        fill="rgba(139,124,246,0.16)"
        stroke="#8b7cf6"
        strokeWidth="3"
      />
      <path
        d="M86 94l-10 34h20l-10-34z"
        fill="rgba(139,124,246,0.16)"
        stroke="#8b7cf6"
        strokeWidth="3"
        strokeLinejoin="round"
      />

      {/* chat bubble */}
      <path
        d="M124 26h44a10 10 0 0 1 10 10v18a10 10 0 0 1-10 10h-24l-12 12v-12h-8a10 10 0 0 1-10-10V36a10 10 0 0 1 10-10z"
        fill="#1c212c"
        stroke="#8b93a7"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="136" cy="45" r="2.6" fill="#8b7cf6" />
      <circle cx="146" cy="45" r="2.6" fill="#8b7cf6" />
      <circle cx="156" cy="45" r="2.6" fill="#8b7cf6" />

      {/* sparkles */}
      <path
        d="M152 96c.4 2.7 1.7 4.1 4.4 4.5-2.7.4-4 1.8-4.4 4.5-.4-2.7-1.7-4.1-4.4-4.5 2.7-.4 4-1.8 4.4-4.5z"
        fill="#8b7cf6"
      />
      <circle cx="38" cy="42" r="1.6" fill="#8b7cf6" opacity="0.6" />
    </svg>
  );
}
