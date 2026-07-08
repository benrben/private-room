import type { Tip } from "./types";

/** Cursor-following tooltip drawn over the stage (screen coords). */
export default function Tooltip({ tip }: { tip: Tip }) {
  return (
    <div className="rm-tip" style={{ left: tip.left, top: tip.top }}>
      <div className="rm-tip-title">{tip.title}</div>
      {tip.lines.map((l, i) => (
        <div key={i} className="rm-tip-line">
          {l}
        </div>
      ))}
    </div>
  );
}
