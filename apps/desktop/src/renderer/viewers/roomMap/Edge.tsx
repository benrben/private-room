import { useEffect } from "react";
import type { SimNode, SimEdge, View, Tip } from "./types";
import { styleFor, edgeLines, edgeInk } from "./edges";
import { nodeRadius } from "./layout";

/** Which link the map's one tooltip is currently describing, or null.
 *
 *  The tip is a SNAPSHOT of a title and its evidence lines, and only a pointer
 *  event ever cleared it — so a line that stopped being drawn without the mouse
 *  moving (switching its kind off from the legend chip is the plain way to do
 *  it: the hit line unmounts, no mouseleave fires) left the map narrating a
 *  link it no longer shows. One slot, because there is one tooltip. */
let tipOwner: string | null = null;

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
 *  asked for. An inline declaration wins whatever the stylesheet says.
 *
 *  A pencil line, not a wire: round caps and joins, so a stroke ends the way a
 *  pencil lifts rather than being cut square, and the dotted kinds land as a
 *  trail of round dots instead of a row of ticks. Both ends of the geometry are
 *  the nodes' exact positions — the drawing is hand-made, the coordinates are
 *  not, and nothing here nudges a line off the two points it connects. */
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
  const lit = edgeIsLit(a, b, hovered, focusId);
  const style = styleFor(se.edge.kind);
  const title = `${a.name} ${se.edge.directed ? "→" : "↔"} ${b.name}`;
  const lines = edgeLines(se.edge);
  // Not the array index the parent keys on: a repaint reuses the component at
  // index i for a different link, and the tip must not survive that either.
  const identity = `${se.edge.a}|${se.edge.b}|${se.edge.kind}`;
  useOwnedTipCleanup(identity, setTip);
  const target = edgeTarget(a, b, se, degree);

  return (
    <g>
      <EdgeHitLine a={a} b={b} view={view} identity={identity} title={title} lines={lines} showTip={showTip} setTip={setTip} />
      <VisibleEdge a={a} target={target} se={se} view={view} color={style.color} widthMultiplier={style.widthMul} dash={style.dash} lit={lit} />
    </g>
  );
}

function edgeIsLit(a: SimNode, b: SimNode, hovered: string | null, focusId: string | null): boolean {
  return hovered === a.id || hovered === b.id || focusId === a.id || focusId === b.id;
}

function useOwnedTipCleanup(identity: string, setTip: (tip: Tip | null) => void) {
  useEffect(() => () => clearOwnedTip(identity, setTip), [identity, setTip]);
}

function clearOwnedTip(identity: string, setTip: (tip: Tip | null) => void) {
  if (tipOwner !== identity) return;
  tipOwner = null;
  setTip(null);
}

function edgeTarget(a: SimNode, b: SimNode, se: SimEdge, degree: Map<string, number>) {
  if (!se.edge.directed) return { x: b.x, y: b.y };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy) || 1;
  const back = nodeRadius(degree.get(b.id) ?? 0) + 3.5;
  if (distance <= back) return { x: b.x, y: b.y };
  return { x: b.x - (dx / distance) * back, y: b.y - (dy / distance) * back };
}

function EdgeHitLine({ a, b, view, identity, title, lines, showTip, setTip }: {
  a: SimNode;
  b: SimNode;
  view: View;
  identity: string;
  title: string;
  lines: string[];
  showTip: EdgeProps["showTip"];
  setTip: EdgeProps["setTip"];
}) {
  return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={7 / view.k} style={{ cursor: "help" }} onMouseEnter={(event) => showOwnedTip(event, identity, title, lines, showTip)} onMouseMove={(event) => showOwnedTip(event, identity, title, lines, showTip)} onMouseLeave={() => clearOwnedTip(identity, setTip)} />;
}

function showOwnedTip(event: React.MouseEvent, identity: string, title: string, lines: string[], showTip: EdgeProps["showTip"]) {
  tipOwner = identity;
  showTip(event, title, lines);
}

function VisibleEdge({ a, target, se, view, color, widthMultiplier, dash, lit }: {
  a: SimNode;
  target: { x: number; y: number };
  se: SimEdge;
  view: View;
  color: string;
  widthMultiplier: number;
  dash: string | null;
  lit: boolean;
}) {
  return <line className="room-map-edge" data-kind={se.edge.kind} x1={a.x} y1={a.y} x2={target.x} y2={target.y} style={{ stroke: color, strokeWidth: ((0.7 + se.edge.weight * 1.1) * widthMultiplier) / view.k }} strokeDasharray={scaledDash(dash, view.k)} strokeLinecap="round" strokeLinejoin="round" strokeOpacity={edgeInk(se.edge, lit)} markerEnd={se.edge.directed ? `url(#rm-arrow-${se.edge.kind})` : undefined} pointerEvents="none" />;
}

function scaledDash(dash: string | null, zoom: number): string | undefined {
  if (!dash) return undefined;
  return dash.split(" ").map((value) => Number(value) / zoom).join(" ");
}
