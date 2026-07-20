import { IconProps } from "./types";
import { Stroke } from "./base";

/* ---------- logomark: the folded Arcelle "A" ---------- */

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
      <g
        stroke="var(--accent)"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3.6 19.4 20.4 M12 3.6 4.6 20.4 M7.8 15 H16.2" />
      </g>
    </svg>
  );
}

export function CloseIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Stroke>
  );
}

export function FolderIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z" />
    </Stroke>
  );
}

export function LinkIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.5 1.5" />
      <path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.5-1.5" />
    </Stroke>
  );
}

export function GlobeIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z" />
    </Stroke>
  );
}

export function ChevronDownIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M6 9.5l6 6 6-6" />
    </Stroke>
  );
}

export function SearchIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </Stroke>
  );
}
