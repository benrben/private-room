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
