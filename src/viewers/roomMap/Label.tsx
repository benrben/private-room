import type { LabelBox } from "./types";

/** One persistent on-canvas label — an ink-safe pill + its text. */
export default function Label({ l }: { l: LabelBox }) {
  return (
    <g>
      <rect
        className={`rm-label-bg${l.prio === 3 ? " is-focus" : ""}`}
        x={l.boxX}
        y={l.boxY}
        width={l.boxW}
        height={l.boxH}
        rx={5}
      />
      <text
        className={`rm-label-text${l.kind === "memory" ? " is-memory" : ""}`}
        x={l.textX}
        y={l.textY}
      >
        {l.name}
      </text>
    </g>
  );
}
