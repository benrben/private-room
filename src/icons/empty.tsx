/* ---------- empty-state illustrations ----------
   Two drawings, not two icons: things made of paper, drawn with the same pen
   the rest of the notebook is drawn with.

   Rules they both follow, and the reason for each:

   - Ink line-art plus ONE marker wash. Colour is doing a single job in each
     drawing (the highlighter on the page, the room's own pen under its
     answer), so neither picture turns into an illustration-set palette.
   - Nothing is filled. Panes in this product are frames drawn onto the sheet
     rather than opaque boxes, and these obey that: the dotted grid runs right
     through the page and the speech bubbles. It also means neither drawing
     has to guess the surface colour of the pane it lands in, which is what
     broke the previous pair — they filled with --panel-2 and read as a solid
     block wherever that did not match.
   - Strokes come from tokens: --sketch is the pen (outlines), --rule-strong
     the pencil (writing, ~3:1 in both themes so the detail survives on ivory),
     --rule the faintest marks, --muted the metal of the clip. The retired
     brand violet used to be hard-coded in here "because it is the same in
     both themes", which stopped being true the moment the notebook gave the
     pen a light and a dark value.
   - Both are decoration: aria-hidden, pointer-events: none, and every mark is
     fixed geometry — nothing here is random or time-derived, so a frame draws
     identically every time.
   - Each outline is gone round twice — the second pass scaled a couple of px
     outward about the shape's own centre, which is the outset redraw the gate
     card and .nb-redraw draw. It costs one extra path and it is the house's
     drawn-by-hand tell. */

const NONE = { pointerEvents: "none" as const };

/**
 * Empty viewer: a clipped sheet of ruled paper with the corner turned down —
 * a page waiting to be written on, which is exactly what an empty room is.
 *
 * viewer.css pins this to width: 200px and lets the height follow, so the
 * viewBox aspect is what actually decides how tall the empty state sits. It
 * is deliberately shorter than the drawing it replaces: the old one ran 220
 * wide by 172 tall and dominated the pane it was apologising for.
 */
export function EmptyViewerArt() {
  return (
    <svg width="200" height="136" viewBox="0 0 200 136" fill="none" style={NONE} aria-hidden>
      {/* The sheet: a true rotated RECTANGLE — both side edges lean the same
          way — minus a turned-down corner. Two earlier cuts read as an open
          BOX rather than paper, and the causes are worth recording: a
          trapezoid whose sides converge downward is a perspective cue, and a
          second outline offset diagonally is an extrusion cue. So the sides
          are parallel, and the redraw is scaled about the sheet's own centre
          instead of translated — an outset second pass, the way the gate card
          does it, which reads as the pen going round twice. */}
      <g transform="translate(98.2 68.1) scale(1.034 1.044) translate(-98.2 -68.1)">
        <path
          d="M40 30 L136.7 22.4 L150.7 34.4 L156.3 105.1 L46.6 113.7 Z"
          stroke="var(--sketch)"
          strokeOpacity="0.24"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </g>
      <path
        d="M40 30 L136.7 22.4 L150.7 34.4 L156.3 105.1 L46.6 113.7 Z"
        stroke="var(--sketch)"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />

      {/* the turned-down corner: the flap is the reverse of the same paper,
          so it takes the softest line colour rather than a new surface */}
      <path
        d="M136.7 22.4 L150.7 34.4 L137.7 35.4 Z"
        fill="var(--line-soft)"
        stroke="var(--sketch)"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />

      {/* one highlighter drag, a shade taller at the start where the pen
          lands — under the second line of writing, never over it */}
      <path
        d="M60 49.9 L138 43.7 L139 57.5 L61 63.8 Z"
        fill="var(--mk-yellow)"
        fillOpacity="0.55"
      />

      {/* writing: pencil, on the sheet's own tilt, starting near the top the
          way a used page does — a page written on only in its lower half
          reads as an empty container, which is the opposite of the point */}
      <g stroke="var(--rule-strong)" strokeWidth="1.9" strokeLinecap="round">
        <path d="M64 41.4 L128 36.4" />
        <path d="M64 56.4 L134 50.9" />
        <path d="M64 71.4 L138 65.6" />
        <path d="M64 86.4 L112 82.6" />
        <path d="M64 99.4 L96 96.9" />
      </g>

      {/* the paperclip, hooked over the top edge near the corner */}
      <path
        d="M46 52 V22 a6 6 0 0 1 12 0 v32 a4.5 4.5 0 0 1 -9 0 V29"
        transform="rotate(-4.5 52 36)"
        stroke="var(--muted)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Empty chat: two speech bubbles pencilled in the margin — a question and the
 * room's answer, with the room's line run through with its own pen.
 *
 * Pink is not decoration here: it is the marker this product uses for AI
 * attribution everywhere else, so the highlighted line is legibly the room
 * talking rather than the person.
 */
export function EmptyChatArt() {
  return (
    <svg width="156" height="116" viewBox="0 0 156 116" fill="none" style={NONE} aria-hidden>
      {/* The question: pencil, smaller, up and to the right. Corner radii are
          all slightly different — the same trick --radius plays in tokens.css,
          which buys a hand-drawn rectangle for nothing. */}
      <path
        d="M86 12 L140 12 Q146 12 146 18 L146 36 Q146 45 137 45 L134 45 L136 56 L126 45 L85 45 Q78 45 78 38 L78 20 Q78 12 86 12 Z"
        stroke="var(--rule-strong)"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <g stroke="var(--rule)" strokeWidth="1.8" strokeLinecap="round">
        <path d="M90 24 L134 24" />
        <path d="M90 34 L116 34" />
      </g>

      {/* the answer: pen, larger, gone round twice */}
      <g transform="translate(60 82) scale(1.042 1.067) translate(-60 -82)">
        <path
          d="M21 52 L101 52 Q108 52 108 59 L108 90 Q108 100 98 100 L34 100 L24 112 L26 100 L20 100 Q12 100 12 92 L12 61 Q12 52 21 52 Z"
          stroke="var(--sketch)"
          strokeOpacity="0.22"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </g>
      <path
        d="M21 52 L101 52 Q108 52 108 59 L108 90 Q108 100 98 100 L34 100 L24 112 L26 100 L20 100 Q12 100 12 92 L12 61 Q12 52 21 52 Z"
        stroke="var(--sketch)"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />

      {/* the room's own marker, under its middle line */}
      <path
        d="M22 70.5 L101 70 L101 80.5 L22.5 82 Z"
        fill="var(--mk-pink)"
        fillOpacity="0.5"
      />

      <g stroke="var(--rule-strong)" strokeWidth="1.8" strokeLinecap="round">
        <path d="M26 64 L94 64" />
        <path d="M26 76 L98 76" />
        <path d="M26 88 L70 88" />
      </g>
    </svg>
  );
}
