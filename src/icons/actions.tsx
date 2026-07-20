import { IconProps } from "./types";
import { Stroke } from "./base";

export function DownloadIcon({ size, className }: IconProps) {
  return (
    <Stroke size={size} className={className}>
      <path d="M12 4v10M8 10.5l4 4 4-4" />
      <path d="M5 18.5h14" />
    </Stroke>
  );
}

/** ADD-18: dictation (voice input). */
export function MicIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3.5" />
    </Stroke>
  );
}

/** Idea 3: the room's spoken voice (auto-speak toggle, per-message Play). */
export function SpeakerIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4H4z" />
      <path d="M15 9.5a3.6 3.6 0 0 1 0 5" />
      <path d="M17.5 7a7 7 0 0 1 0 10" />
    </Stroke>
  );
}

/** Idea 3: hands-free loop — the mic re-arms itself after the voice finishes. */
export function HandsFreeIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <rect x="9" y="3" width="6" height="9.5" rx="3" />
      <path d="M12 15.5v2.5" />
      <path d="M5.5 18a8.5 8.5 0 0 0 13 0" />
      <path d="M18.5 18v3M18.5 21h-3" />
    </Stroke>
  );
}

export function UndoIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 5 5 5 5 0 0 1-5 5H8" />
    </Stroke>
  );
}

export function PaperclipIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
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

export function PencilIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M17 3.5a2.3 2.3 0 0 1 3.3 3.3L7.5 19.8l-4.2 1 1-4.2L17 3.5z" />
    </Stroke>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M4.5 12.5l5 5 10-11" />
    </Stroke>
  );
}

export function PlusIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M12 5v14M5 12h14" />
    </Stroke>
  );
}

/** Wave 5 (Idea 13): Run a script — a play triangle. */
export function PlayIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M7 5.5l11 6.5-11 6.5V5.5z" />
    </Stroke>
  );
}

/** A clock face — the schedule affordance. */
export function ClockIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </Stroke>
  );
}

/** AI authoring / "let the assistant build it" — a four-point sparkle. */
export function SparklesIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M11 4.5 12.4 8.6 16.5 10 12.4 11.4 11 15.5 9.6 11.4 5.5 10 9.6 8.6z" />
      <path d="M18 4v3.2M19.6 5.6h-3.2M18.5 15.5v2.4M19.7 16.7h-2.4" />
    </Stroke>
  );
}

/** Pin a workflow to the top bar. */
export function PinIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M12 16v5" />
      <path d="M9 4.5h6l-.8 4.2 2.3 2.6a1 1 0 0 1-.75 1.66H7.05a1 1 0 0 1-.76-1.65l2.3-2.61z" />
    </Stroke>
  );
}

/** A clock overlaid on a calendar — the "schedule" affordance. */
export function CalendarClockIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M20 9.5V6a1.5 1.5 0 0 0-1.5-1.5h-13A1.5 1.5 0 0 0 4 6v12a1.5 1.5 0 0 0 1.5 1.5H10" />
      <path d="M4 9.5h9M8 3v3M16 3v3" />
      <circle cx="17" cy="16.5" r="4.5" />
      <path d="M17 14.3v2.2l1.5 1" />
    </Stroke>
  );
}
