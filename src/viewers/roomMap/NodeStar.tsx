import type { SimNode, View, Tip } from "./types";
import { nodeRadius, handCircle } from "./layout";

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

/** One node — an inked disc for a file, a ringed dot for a memory — with its
 *  hit target and hover/click wiring (all handlers threaded from the shell).
 *
 *  NODES ARE INK, NOT COLOUR. Both kinds are drawn in the pen, and which one a
 *  node is comes from its SHAPE: a filled disc is a file, an open ring around a
 *  dot is a memory, and the same ring is repeated in front of a memory's label.
 *  That leaves every hue on this map free to mean one thing — what a LINE
 *  between two nodes claims — instead of hue being asked to say two unrelated
 *  things at once. It also retires the last two colour literals the map
 *  carried (a violet wash and a neon green), which is where its glow came from.
 *
 *  Paint lives in roomMap.css, keyed off the classes below. Only stroke WIDTHS
 *  are set here, because they have to be divided by the zoom to stay a constant
 *  weight on screen, and only the browser knows the current scale at draw time.
 *
 *  Note that the class values are what protect these shapes from
 *  `.room-map-node { fill: … }` in misc-moonshot.css: that rule paints the
 *  wrapping <g>, and fill INHERITS, so a shape that declared nothing would pick
 *  the accent up. A rule matching the shape itself always beats a value
 *  inherited from its parent. */
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
      className={`room-map-node ${isFile ? "is-file" : "is-memory"}${
        active ? " is-active" : neighbour ? " is-neighbour" : ""
      }`}
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
      <circle className="rm-node-hit" r={hit} />
      {/* The selected node is CIRCLED, the way you would circle it on paper.
          A drawn shape, not a colour swap and not a glow — so the selection
          survives greyscale, and it is also the keyboard indicator, since
          focusing a node selects it (onFocus above). */}
      {active && (
        <path
          className="rm-node-circled"
          d={handCircle(r * 1.85)}
          strokeWidth={1.7 / view.k}
          aria-hidden="true"
        />
      )}
      {isFile ? (
        <circle className="rm-node-disc" r={r} strokeWidth={1.4 / view.k} />
      ) : (
        <>
          <circle className="rm-node-ring" r={r * 0.95} strokeWidth={1.4 / view.k} />
          <circle className="rm-node-core" r={r * 0.36} />
        </>
      )}
    </g>
  );
}
