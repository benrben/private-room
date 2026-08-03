import type { SimNode, SimEdge, View, Tip } from "./types";
import { styleFor, edgeLines } from "./edges";
import { nodeRadius } from "./layout";

interface EdgeProps {
  se: SimEdge;
  a: SimNode;
  b: SimNode;
  view: View;
  hovered: string | null;
  focusId: string | null;
  degree: Map<string, number>;
  showTip: (e: React.MouseEvent, title: string, lines: string[]) => void;
  setTip: (t: Tip | null) => void;
}

/** One link between two stars, drawn in its own kind's hue and dash pattern,
 *  with a fat invisible hit line that explains WHAT the link claims on hover.
 *
 *  Stroke and width are INLINE styles, not presentation attributes: a
 *  `.room-map-edge { stroke: … }` rule in misc-moonshot.css used to beat the
 *  attributes (any author selector outranks a presentation attribute), so
 *  every edge rendered as the same violet hairline no matter what the code
 *  asked for. An inline declaration wins whatever the stylesheet says. */
export default function Edge({
  se,
  a,
  b,
  view,
  hovered,
  focusId,
  degree,
  showTip,
  setTip,
}: EdgeProps) {
  const lit =
    hovered === a.id || hovered === b.id || focusId === a.id || focusId === b.id;
  const style = styleFor(se.edge.kind);
  const base = 0.14 + se.edge.weight * 0.4;
  const title = `${a.name} ${se.edge.directed ? "→" : "↔"} ${b.name}`;
  const lines = edgeLines(se.edge);

  // A directed line stops short of the target star, or its arrowhead is drawn
  // underneath the node (edges render before nodes) and reads as no arrow.
  let x2 = b.x;
  let y2 = b.y;
  if (se.edge.directed) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const back = nodeRadius(degree.get(b.id) ?? 0) + 3.5;
    if (dist > back) {
      x2 = b.x - (dx / dist) * back;
      y2 = b.y - (dy / dist) * back;
    }
  }

  return (
    <g>
      {/* fat invisible hit line for easy "why linked" hovering */}
      <line
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke="transparent"
        strokeWidth={7 / view.k}
        style={{ cursor: "help" }}
        onMouseEnter={(ev) => showTip(ev, title, lines)}
        onMouseMove={(ev) => showTip(ev, title, lines)}
        onMouseLeave={() => setTip(null)}
      />
      <line
        className="room-map-edge"
        data-kind={se.edge.kind}
        x1={a.x}
        y1={a.y}
        x2={x2}
        y2={y2}
        style={{
          stroke: style.color,
          strokeWidth: ((0.5 + se.edge.weight * 1.2) * style.widthMul) / view.k,
        }}
        // Dashes are in world units, so they have to be unscaled like the width
        // or they vanish into a solid line as you zoom out.
        strokeDasharray={
          style.dash
            ? style.dash
                .split(" ")
                .map((n) => Number(n) / view.k)
                .join(" ")
            : undefined
        }
        strokeOpacity={lit ? Math.min(0.95, base + 0.4) : base}
        markerEnd={se.edge.directed ? `url(#rm-arrow-${se.edge.kind})` : undefined}
        pointerEvents="none"
      />
    </g>
  );
}
