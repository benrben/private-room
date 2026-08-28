import { IconProps } from "./types";
import { Stroke } from "./base";

/* ---------- the Arcelle brand mark ----------

   The paper fold-A. A cream ribbon bent into the letter A, its bottom edge
   peeling up to show the underside of the fold, with a small four-point
   spark resting in the counter. The counter is not a hole in the ribbon
   alone — the fold's flap closes it from below — so the body is filled
   even-odd OVER the flap, and where the counter overlaps the flap the flap
   shows through: the lip along the counter's bottom edge, exactly as the
   artwork has it.

   The geometry is shared with the master artwork in assets/brand/, mapped here by
   scale(0.24) into the 24 box. index.html's launch shell carries the same
   numbers, public/logo.svg the same numbers inside its tile, and the
   application icon is generated from assets/brand/appicon.svg. Update the master
   artwork first and carry the paths into the other two so the brand remains
   consistent.

   PALETTE SPLIT — deliberate, please do not "fix" it:
   the brand plum and gold belong to the APPLICATION ICON and the standalone
   mark (public/logo.svg) ONLY. The interface carries neither, so in-app the
   fold's underside and the spark are drawn with the product's own
   highlighter tokens (--mk-yellow / --mk-yellow-ink) under a theme-ink
   body: the app's own materials rather than a second palette imported into
   the product. */

const BODY_OUTER =
  "M50.7 17.5L52.2 17.7L53.6 18.2L55.2 19.1L57.4 20.9L60 23.9L62.9 28.7L66.1 34.8L69.2 41.4L72 48.4L74.6 55.4L76.8 62L78.2 66.8L78.7 70.1L78.9 72.4L78.7 73.9L78.3 75.3L77.7 76.7L76.9 77.9L75.8 79.1L74.9 79.8L74.1 80.2L73.6 80.3L73.2 80.2L72.9 79.3L72.5 78.2L71.6 77.7L70.1 77.4L67.7 76L64.5 73.8L61 71.9L57.7 70.4L56.3 69.6L56 69.2L55.2 68.9L53.7 68.5L51.6 68.3L49.2 68.2L47.5 68.4L46.1 68.7L44.2 69.4L41.7 70.4L38.3 72.1L34.5 74.1L31.8 75.3L30.1 75.8L28.7 76L27.6 75.9L26.5 75.7L25.3 75.2L24.4 74.6L23.6 73.8L22.8 72.8L22.2 71.6L21.8 70.3L21.5 69L21.3 67.5L21.4 65.7L21.9 63.1L22.9 59.4L24.8 53.9L27.5 47.3L30.2 41.4L32.8 36.1L35 31.9L37 28.5L39 25.4L41 22.8L42.9 20.8L44.8 19.3L46.9 18.3L49 17.6Z";
const BODY_COUNTER =
  "M71.3 77.2L70.5 77L68.9 75.9L66.5 74.2L62.8 72.1L58.6 70.1L56.8 69.1L55.7 68.4L50.8 66.1L43.7 62.9L39.6 60.6L37.8 59L36.8 57.6L36.3 56.2L36.1 54.7L36.1 52.8L36.7 50.1L37.8 46.7L39.5 43.1L41.5 39.5L42.9 37.2L44 36L45.3 34.7L46.8 33.6L48 32.8L49.3 32.4L50.7 32.2L52.2 32.2L53.7 32.7L55 33.5L56.4 34.8L57.8 36.6L59.3 39.3L60.9 43.1L63 48.9L65.6 56.2L68.2 64.3L70.6 71.9L71.7 75.8L71.7 76.8Z";
const FLAP =
  "M57.6 79.1L40 77.6L32.2 76.8L32.2 76.5L33.6 76.1L35.6 75.5L36.6 75.1L36.9 74.8L38.4 74.3L40.5 73.6L42.4 72.9L44.4 72L47.4 71.2L50.9 70.4L52.4 69.9L52.7 69.6L53.8 69.4L55.7 69.4L58 70L60.7 71.1L63.6 72.6L66.5 74.3L69 76.2L71 78L72.1 79.3L70 79.8Z";
const STAR =
  "M56.2 48.4Q56.2 50.7 58.5 50.7Q56.2 50.7 56.2 53Q56.2 50.7 53.9 50.7Q56.2 50.7 56.2 48.4Z";

/**
 * The logomark. The body renders in theme ink by default; pass `mono` to
 * let the whole mark take `currentColor` from whatever it sits in (the
 * fold's underside drops to a translucent wash of the same hue, no yellow).
 */
export function Logomark({
  size = 24,
  className,
  mono = false,
}: IconProps & { mono?: boolean }) {
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
        {/* The flap first, the body over it: the ribbon overlaps the fold's
            top edge, and the counter (even-odd) lets the flap show through
            as the plum lip in the artwork — here the highlighter FILL track,
            a surface rather than a wash, so it carries more opacity than the
            old band did. */}
        <path
          d={FLAP}
          fill={mono ? "currentColor" : "var(--mk-yellow)"}
          fillOpacity={mono ? 0.35 : 0.8}
        />
        <path
          d={`${BODY_OUTER}${BODY_COUNTER}`}
          fill="currentColor"
          fillRule="evenodd"
        />
        <path d={STAR} fill={mono ? "currentColor" : "var(--mk-yellow-ink)"} />
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

export function ChevronUpIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <path d="M6 14.5l6-6 6 6" />
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
