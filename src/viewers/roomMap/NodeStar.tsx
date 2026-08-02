import type { SimNode, View, Tip } from "./types";
import { nodeRadius, starPoints } from "./layout";
import { VIOLET, VIOLET_SOFT, MEMORY } from "./constants";

interface NodeStarProps {
  n: SimNode;
  degree: Map<string, number>;
  hovered: string | null;
  focusId: string | null;
  focusNeighbors: Set<string> | null;
  view: View;
  onOpenFile?: (id: string) => void;
  setHovered: (id: string | null) => void;
  setFocus: (id: string | null) => void;
  showTip: (e: React.MouseEvent, title: string, lines: string[]) => void;
  setTip: (t: Tip | null) => void;
}

/** One node — a violet file star or a green memory ring — with its halo,
 *  hit target, and hover/click wiring (all handlers threaded from the shell). */
export default function NodeStar({
  n,
  degree,
  hovered,
  focusId,
  focusNeighbors,
  view,
  onOpenFile,
  setHovered,
  setFocus,
  showTip,
  setTip,
}: NodeStarProps) {
  const deg = degree.get(n.id) ?? 0;
  const r = nodeRadius(deg);
  const isFile = n.kind === "file";
  const active = hovered === n.id || focusId === n.id;
  const neighbour = focusNeighbors?.has(n.id) ?? false;
  const openable = isFile && onOpenFile != null;
  const tipLines = [n.kind === "memory" ? "Memory" : n.folder || "Top level"];
  if (n.summary) tipLines.push(n.summary);
  // Generous invisible hit target so small stars are clickable.
  const hit = Math.max(r * 1.6, 11 / view.k);
  // Reachable by Tab and named for a screen reader — without this the map is
  // empty space to anyone who can't use a mouse.
  const label = [
    isFile ? n.name : `Memory: ${n.name}`,
    isFile ? n.folder || "Top level" : null,
    `${deg} connection${deg === 1 ? "" : "s"}`,
    openable ? "press Enter to open" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const activate = () => {
    setFocus(n.id);
    if (openable) onOpenFile?.(n.id);
  };
  return (
    <g
      className={`room-map-node ${isFile ? "is-file" : "is-memory"}`}
      transform={`translate(${n.x} ${n.y})`}
      style={{ cursor: openable ? "pointer" : "default" }}
      role="button"
      tabIndex={0}
      aria-label={label}
      onMouseEnter={(ev) => {
        setHovered(n.id);
        setFocus(n.id); // sticky: label + neighbours persist
        showTip(ev, n.name, tipLines);
      }}
      onMouseMove={(ev) => showTip(ev, n.name, tipLines)}
      onMouseLeave={() => {
        setHovered(null);
        setTip(null);
      }}
      onFocus={() => {
        setHovered(n.id);
        setFocus(n.id);
      }}
      onBlur={() => {
        setHovered(null);
        setTip(null);
      }}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          activate();
        }
      }}
      onClick={activate}
    >
      <circle r={hit} fill="transparent" />
      {isFile ? (
        <>
          {/* soft halo → the star "glows" without an SVG filter */}
          <circle
            r={r * (active ? 2.7 : neighbour ? 2.3 : 2.0)}
            fill={VIOLET_SOFT}
          />
          <polygon
            points={starPoints(r * (active ? 1.28 : 1))}
            fill={VIOLET}
            stroke={active ? "#fff" : "none"}
            strokeWidth={active ? 0.8 / view.k : 0}
          />
        </>
      ) : (
        <>
          <circle r={r * 1.9} fill="rgba(76, 195, 138, 0.14)" />
          <circle
            r={r * 0.9}
            fill="none"
            stroke={MEMORY}
            strokeWidth={1.4 / view.k}
          />
          <circle r={r * 0.34} fill={MEMORY} />
        </>
      )}
    </g>
  );
}
