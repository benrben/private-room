import type { Tip } from "./types";

/** Cursor-following tooltip drawn over the stage (screen coords).
 *
 *  Composes .nb-tip: it floats, so it is opaque and structured rather than
 *  hand-drawn — the thing a reader has to read fast is the one place the
 *  notebook deliberately stops being a notebook. */
export default function Tooltip({ tip }: { tip: Tip }) {
  return (
    <div className="nb-tip rm-tip" style={{ left: tip.left, top: tip.top }}>
      <div className="rm-tip-title">{tip.title}</div>
      {tip.lines.map((l, i) => (
        <div key={i} className="rm-tip-line">
          {l}
        </div>
      ))}
    </div>
  );
}
