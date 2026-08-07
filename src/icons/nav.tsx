import { IconProps } from "./types";
import { Stroke } from "./base";

/* ---------- the Arcelle brand mark ----------

   The marker-x-notebook A. A highlighter band swiped across the page first,
   then the handwritten letter drawn over it in ink — the order things happen
   in a real notebook. The letter is the signature A: a sail-curve left
   stroke, a re-inked apex where the pen turned, a bowed descender, and the
   crossbar with its short leg, the whole glyph tilted 1.8 degrees because
   handwriting never sits level.

   The geometry is the 0..100 design space of src-tauri/icons/generate.py
   (GLYPH / BAND / MICRO_*), mapped here by scale(0.24) into the 24 box.
   index.html's launch shell carries the same numbers, public/logo.svg
   carries the micro cut in its tile, and the application icon is the same
   construction rasterised. Change generate.py FIRST and the other three
   have to move with it, or the brand stops being one brand.

   Under 18px the letter switches to the MICRO cut — the same object redrawn
   heavier, not shrunk — so the strokes stop fragmenting into speckle.

   PALETTE SPLIT — deliberate, please do not "fix" it:
   the brand lilac (#9A82D1) belongs to the APPLICATION ICON and the
   standalone marketing mark ONLY. The interface itself has no violet in it —
   an earlier pass removed every trace of the old brand violet from UI
   chrome — so the in-app band is drawn with the product's own highlighter
   track (--mk-yellow) under theme-ink strokes: literally the app's own
   gesture, a yellow highlight beneath handwriting, instead of importing a
   second palette into the product. */

const BAND = "M11 73.5C36 71 66 68.6 90 67L89.2 47.5C65 49.2 35 51.6 10.2 54Z";
const GLYPH: Array<[string, number]> = [
  ["M20.5 89C25 66 33 42 44 25.5C48.5 18.8 53 13.4 57.5 10.5", 9.4],
  ["M52.5 14.5C54.5 12.6 56.2 11.2 57.5 10.5", 10.6],
  ["M57.5 10.5C60 26 63.5 55 66.5 88.5", 9],
  ["M40 57.5C49 56.6 58 56.4 66.8 57.2", 7],
  ["M40.6 57.5C40.2 66 40 76 40.2 85.5", 7],
];
const MICRO_BAND = "M8 72C36 68.5 68 65.5 94 63.5L92.8 41C66 43.5 34 46.5 7 50Z";
const MICRO_GLYPH: Array<[string, number]> = [
  ["M20 89C26 62 38 30 57 10", 12.5],
  ["M57 10C61 30 65.5 62 68 89", 12.5],
  ["M39 58L68 57.5", 9.5],
  ["M39.6 58L39.6 86", 9.5],
];

/**
 * The logomark. Strokes render in theme ink by default; pass `mono` to let
 * the whole mark take `currentColor` from whatever it sits in (the band
 * drops to a translucent wash of the same hue, no yellow).
 *
 * Under 18px it switches to the micro cut: heavier strokes, the band pushed
 * through the letter's waist, no tilt — redrawn for the distance, not shrunk.
 */
export function Logomark({
  size = 24,
  className,
  mono = false,
}: IconProps & { mono?: boolean }) {
  const micro = size < 18;
  const band = micro ? MICRO_BAND : BAND;
  const glyph = micro ? MICRO_GLYPH : GLYPH;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      // Monochrome inherits; otherwise the mark is pinned to ink so it never
      // picks up the muted grey of a toolbar row it happens to live in.
      // Inert either way: it is aria-hidden decoration, so hovering it must
      // resolve to whatever wrapper carries the real label and tooltip.
      style={{
        pointerEvents: "none",
        ...(mono ? null : { color: "var(--ink)" }),
      }}
      aria-hidden
    >
      <g transform="scale(0.24)">
        {/* The FILL track, not --mk-yellow-ink: the band is a wash behind
            ink, so the low-contrast highlighter fill is exactly right — the
            ink-track yellow would compete with the strokes over it. */}
        <path
          d={band}
          fill={mono ? "currentColor" : "var(--mk-yellow)"}
          fillOpacity={mono ? 0.18 : micro ? 0.66 : 0.5}
        />
        <g
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          transform={micro ? undefined : "rotate(-1.8 50 50)"}
        >
          {glyph.map(([d, w]) => (
            <path key={d} d={d} strokeWidth={w} />
          ))}
        </g>
      </g>
    </svg>
  );
}

/**
 * The handwritten "Arcelle" wordmark.
 *
 * Kalam is bundled, so the honest wordmark is live text in the hand — not an
 * SVG tracing that would fall out of sync with the face and be unreadable to
 * a screen reader. This is the one place handwriting carries a name rather
 * than an annotation: it is a signature, which is exactly what the hand is
 * for. Colour is inherited so the lockup takes whatever ink surrounds it.
 */
export function Wordmark({
  size = 28,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={className}
      style={{
        fontFamily: "var(--hand)",
        fontSize: size,
        lineHeight: 1,
        // Kalam runs tight and slightly narrow; a hair of tracking gives the
        // word the unhurried spacing of something written rather than typed.
        letterSpacing: "0.015em",
        whiteSpace: "nowrap",
        display: "inline-block",
        // Its ascenders overshoot the em box, so a capital A clips when the
        // wordmark lands in a line-height: 0 row (every logo row in this app).
        paddingTop: Math.round(size * 0.1),
      }}
    >
      Arcelle
    </span>
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

export function ChevronLeftIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M14.5 6l-6 6 6 6" />
    </Stroke>
  );
}

export function ChevronRightIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M9.5 6l6 6-6 6" />
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
