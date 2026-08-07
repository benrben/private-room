import type { LabelBox } from "./types";
import { LABEL_PAD } from "./constants";

/** One persistent on-canvas label — a small index card and the file's name.
 *
 *  The card is the one opaque thing the map draws, and it has to be: a name
 *  printed straight onto a field of crossing lines is unreadable, and this is a
 *  REAL FILE NAME, which the app promises to show truthfully. An opaque card
 *  is also what the notebook allows anything that occludes what is under it.
 *
 *  A memory carries a small ring in front of its name — the same shape its node
 *  is drawn as — so the two kinds are told apart by a shape and not only by
 *  their position on the canvas. */
export default function Label({ l }: { l: LabelBox }) {
  const isMemory = l.kind === "memory";
  return (
    <g>
      <rect
        className={`rm-label-bg${l.prio === 3 ? " is-focus" : ""}`}
        x={l.boxX}
        y={l.boxY}
        width={l.boxW}
        height={l.boxH}
        rx={3}
      />
      {isMemory && (
        <circle
          className="rm-label-mark"
          cx={l.boxX + LABEL_PAD + 4}
          cy={l.boxY + l.boxH / 2}
          r={3.4}
        />
      )}
      <text
        className={`rm-label-text${isMemory ? " is-memory" : ""}`}
        x={l.textX}
        y={l.textY}
      >
        {l.name}
      </text>
    </g>
  );
}
