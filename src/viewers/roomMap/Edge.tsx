import type { SimNode, SimEdge, View, Tip } from "./types";
import { VIOLET } from "./constants";

interface EdgeProps {
  se: SimEdge;
  a: SimNode;
  b: SimNode;
  view: View;
  hovered: string | null;
  focusId: string | null;
  showTip: (e: React.MouseEvent, title: string, lines: string[]) => void;
  setTip: (t: Tip | null) => void;
}

/** One edge (link) between two stars, with a fat invisible hit line that
 *  explains *why* the two files are linked on hover. */
export default function Edge({ se, a, b, view, hovered, focusId, showTip, setTip }: EdgeProps) {
  const lit =
    hovered === a.id ||
    hovered === b.id ||
    focusId === a.id ||
    focusId === b.id;
  const base = 0.08 + se.edge.weight * 0.32;
  const title = `${a.name} ↔ ${b.name}`;
  const lines =
    se.edge.shared.length > 0
      ? se.edge.shared
      : [`${Math.round(se.edge.weight * 100)}% similar`];
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
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke={VIOLET}
        strokeWidth={(0.5 + se.edge.weight * 1.2) / view.k}
        strokeOpacity={lit ? Math.min(0.95, base + 0.45) : base}
        pointerEvents="none"
      />
    </g>
  );
}
