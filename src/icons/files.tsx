import { FileMeta, fileKind } from "../api";
import { IconProps } from "./types";
import { Stroke } from "./base";

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

/** ADD-27: live recordings — a record dot inside a ring. */
function RecordingIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="3.2" fill="#e5484d" stroke="none" />
    </svg>
  );
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
    case "recording":
      return <RecordingIcon size={size} />;
    default:
      return <FileIcon size={size} />;
  }
}
