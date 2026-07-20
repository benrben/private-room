import { IconProps } from "./types";
import { Stroke } from "./base";

/* ---------- moonshot feature icons (24px grid, 1.6px stroke) ---------- */

/** Workflows: a small left-to-right pipeline of linked nodes. */
export function WorkflowsIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="3" y="9.5" width="5" height="5" rx="1.3" />
      <rect x="16" y="4.5" width="5" height="5" rx="1.3" />
      <rect x="16" y="14.5" width="5" height="5" rx="1.3" />
      <path d="M8 12h4.5M12.5 12V7h3.5M12.5 12v5h3.5" />
    </Stroke>
  );
}

/** Room Map: a small constellation / node graph. */
export function GraphIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M10.6 10.7 6.4 7.2M13.4 11 17.4 7.7M13.4 13.2 16 16.6M10.6 13.3 7.4 16.2" />
      <circle cx="12" cy="12" r="2.1" />
      <circle cx="5.4" cy="6.4" r="1.7" />
      <circle cx="18.4" cy="6.8" r="1.7" />
      <circle cx="16.9" cy="17.6" r="1.7" />
      <circle cx="6.4" cy="17.4" r="1.7" />
    </Stroke>
  );
}

/** Time Machine: a clock with a counter-clockwise "back" arrow. */
export function TimeMachineIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.3" />
      <path d="M3.5 4.2v4.1h4.1" />
      <path d="M12 7.5V12l3 1.8" />
    </Stroke>
  );
}

/** Studio: a stack of cards (flashcards / slides). */
export function StudioIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="7" y="8" width="13" height="11" rx="2" />
      <path d="M4 15V7a2 2 0 0 1 2-2h9" />
      <path d="M10 12.5h7M10 15.5h4" />
    </Stroke>
  );
}

/** Podcast: a microphone flanked by sound waves. */
export function PodcastIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="9.5" y="2.5" width="5" height="9" rx="2.5" />
      <path d="M6.5 10.5a5.5 5.5 0 0 0 11 0" />
      <path d="M12 16v3" />
      <path d="M4.6 7.5a4.2 4.2 0 0 1 0 6M19.4 7.5a4.2 4.2 0 0 0 0 6" />
    </Stroke>
  );
}

/** Scripts: a document with an angle-bracket "code" glyph. */
export function ScriptIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
      <path d="M13.5 3.5V8h4.5" />
      <path d="M10.5 12.5 8.5 14.5l2 2M13.5 12.5l2 2-2 2" />
    </Stroke>
  );
}

/* ---- workflow template glyphs (one quiet line icon per template) ---- */

/** Morning digest: a sun rising over the horizon. */
export function SunriseIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M12 3v6M5.6 11.6 4.2 10.2M18.4 11.6l1.4-1.4M3 15h1.5M19.5 15H21M9 6l3-3 3 3" />
      <path d="M7 15a5 5 0 0 1 10 0" />
      <path d="M2.5 19h19" />
    </Stroke>
  );
}

/** New-file summarizer: an inbox tray. */
export function InboxIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M21 12.5h-5l-1.5 2.5h-5L8 12.5H3" />
      <path d="M5.6 5.7 3 12.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18v-5.5l-2.6-6.8A1.5 1.5 0 0 0 17 4.7H7a1.5 1.5 0 0 0-1.4 1z" />
    </Stroke>
  );
}

/** Weekly review: a calendar with a check. */
export function CalendarCheckIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
      <path d="m9 14.5 2 2 4-4" />
    </Stroke>
  );
}

/** Deep read: an open book. */
export function BookOpenIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M12 6.5v13" />
      <path d="M12 6.5C10.5 5.3 8.5 4.7 6 4.7c-1 0-1.9.1-2.5.3v12.7c.6-.2 1.5-.3 2.5-.3 2.5 0 4.5.6 6 1.8" />
      <path d="M12 6.5c1.5-1.2 3.5-1.8 6-1.8 1 0 1.9.1 2.5.3v12.7c-.6-.2-1.5-.3-2.5-.3-2.5 0-4.5.6-6 1.8" />
    </Stroke>
  );
}

/** Compare perspectives: two nodes with crossing compare arrows. */
export function CompareIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="5.5" cy="6.5" r="2.6" />
      <circle cx="18.5" cy="17.5" r="2.6" />
      <path d="M12 6.5h4a2 2 0 0 1 2 2v6.4" />
      <path d="m14.5 9 2.5-2.5L14.5 4" />
      <path d="M12 17.5H8a2 2 0 0 1-2-2V9.1" />
      <path d="m9.5 15-2.5 2.5L9.5 20" />
    </Stroke>
  );
}

/** Summarize every file: a stack of documents. */
export function FilesIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M8.5 3.5H15l4.5 4.5V18a1.5 1.5 0 0 1-1.5 1.5H8.5A1.5 1.5 0 0 1 7 18V5A1.5 1.5 0 0 1 8.5 3.5z" />
      <path d="M14.5 3.5V8H19" />
      <path d="M4 7.5V19a1.5 1.5 0 0 0 1.5 1.5H15" />
    </Stroke>
  );
}

/** Triage the newest note: a descending filter list. */
export function ListFilterIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M4 6.5h16M7 12h10M10 17.5h4" />
    </Stroke>
  );
}
