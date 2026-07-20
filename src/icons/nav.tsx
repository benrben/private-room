import { IconProps } from "./types";
import { Stroke } from "./base";

/* ---------- logomark: the folded Arcelle "A" ---------- */

export function Logomark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="235 258 560 560"
      fill="none"
      className={className}
      aria-hidden
    >
      <path d="M375 623 L654 710 Q668 715 661 730 L635 778 Q628 790 614 784 L345 682 Z" fill="#9d80d8" />
      <path d="M507 279 Q523 263 541 274 Q550 279 557 294 L731 739 Q738 757 727 772 L702 800 Q692 812 677 805 L637 785 L470 337 Q463 319 473 304 Z" fill="#7857b0" />
      <path d="M494 277 Q507 264 524 269 Q542 275 548 292 Q552 303 546 318 L381 737 Q376 749 387 758 L365 797 Q356 813 339 810 Q331 809 323 801 L304 781 Q292 769 298 750 L479 308 Q484 288 494 277 Z" fill="#c3acf2" />
      <path d="M672 781 L707 785" stroke="#dfbc72" strokeWidth="8" strokeLinecap="round" />
      <circle cx="672" cy="781" r="4" fill="#fff0b5" />
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
