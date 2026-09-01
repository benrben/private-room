import { useRef } from "react";
import type { SimNode, View, Tip } from "./types";
import { nodeRadius, handCircle } from "./layout";

/** How far a press may travel and still count as a click on this star — the
 * same 3px the backdrop's pan uses to tell a drag from a click. */
const DRAG_SLOP = 3;

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

interface NodeFacts {
  degree: number;
  radius: number;
  isFile: boolean;
  active: boolean;
  neighbour: boolean;
  openable: boolean;
  tipLines: string[];
  hitRadius: number;
  label: string;
}

function nodeDegree(degree: Map<string, number>, id: string) {
  return degree.get(id) ?? 0;
}

function nodeState(n: SimNode, hovered: string | null, focusId: string | null) {
  return hovered === n.id || focusId === n.id;
}

function isNeighbour(neighbors: Set<string> | null, id: string) {
  return neighbors?.has(id) ?? false;
}

function isOpenable(isFile: boolean, onOpenFile?: (id: string) => void) {
  return isFile && onOpenFile != null;
}

function tipLines(n: SimNode) {
  if (n.kind === "memory") return ["Memory"];
  return [n.folder || "Top level"];
}

function nodeName(n: SimNode, isFile: boolean) {
  return isFile ? n.name : `Memory: ${n.name}`;
}

function folderName(n: SimNode, isFile: boolean) {
  if (!isFile) return null;
  return n.folder || "Top level";
}

function connectionName(degree: number) {
  return `${degree} connection${degree === 1 ? "" : "s"}`;
}

function openingHint(openable: boolean) {
  return openable ? "press Enter to open" : null;
}

function ariaLabel(
  n: SimNode,
  degree: number,
  isFile: boolean,
  openable: boolean,
) {
  return [
    nodeName(n, isFile),
    folderName(n, isFile),
    connectionName(degree),
    openingHint(openable),
  ]
    .filter(Boolean)
    .join(", ");
}

function factsFor(props: NodeStarProps): NodeFacts {
  const degree = nodeDegree(props.degree, props.n.id);
  const radius = nodeRadius(degree);
  const isFile = props.n.kind === "file";
  const active = nodeState(props.n, props.hovered, props.focusId);
  const neighbour = isNeighbour(props.focusNeighbors, props.n.id);
  const openable = isOpenable(isFile, props.onOpenFile);
  return {
    degree,
    radius,
    isFile,
    active,
    neighbour,
    openable,
    tipLines: tipLines(props.n),
    hitRadius: Math.max(radius * 1.6, 11 / props.view.k),
    label: ariaLabel(props.n, degree, isFile, openable),
  };
}

function stateClass(active: boolean, neighbour: boolean) {
  if (active) return " is-active";
  if (neighbour) return " is-neighbour";
  return "";
}

function nodeClass(facts: NodeFacts) {
  const kind = facts.isFile ? "is-file" : "is-memory";
  return `room-map-node ${kind}${stateClass(facts.active, facts.neighbour)}`;
}

function activateNode(
  n: SimNode,
  openable: boolean,
  setFocus: (id: string | null) => void,
  onOpenFile?: (id: string) => void,
) {
  setFocus(n.id);
  if (openable) onOpenFile?.(n.id);
}

function movedSincePress(
  start: { x: number; y: number } | null,
  e: React.MouseEvent,
) {
  if (!start) return false;
  return Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_SLOP;
}

function isActivationKey(key: string) {
  return key === "Enter" || key === " ";
}

function useNodeInteraction(props: NodeStarProps, facts: NodeFacts) {
  const pressAt = useRef<{ x: number; y: number } | null>(null);
  const activate = () =>
    activateNode(props.n, facts.openable, props.setFocus, props.onOpenFile);
  const onNodeClick = (e: React.MouseEvent) => {
    const start = pressAt.current;
    pressAt.current = null;
    if (movedSincePress(start, e)) return;
    activate();
  };
  const onNodeEnter = (e: React.MouseEvent) => {
    props.setHovered(props.n.id);
    props.setFocus(props.n.id);
    props.showTip(e, props.n.name, facts.tipLines);
  };
  const onNodeLeave = () => {
    props.setHovered(null);
    props.setTip(null);
  };
  const onNodeKeyDown = (e: React.KeyboardEvent) => {
    if (!isActivationKey(e.key)) return;
    e.preventDefault();
    activate();
  };
  const onPointerDown = (e: React.PointerEvent) => {
    pressAt.current = { x: e.clientX, y: e.clientY };
  };
  return {
    onNodeClick,
    onNodeEnter,
    onNodeLeave,
    onNodeKeyDown,
    onPointerDown,
    onNodeMove: (e: React.MouseEvent) =>
      props.showTip(e, props.n.name, facts.tipLines),
    onNodeFocus: () => {
      props.setHovered(props.n.id);
      props.setFocus(props.n.id);
    },
  };
}

function SelectionCircle({
  active,
  radius,
  view,
}: Pick<NodeFacts, "active" | "radius"> & { view: View }) {
  if (!active) return null;
  return (
    <path
      className="rm-node-circled"
      d={handCircle(radius * 1.85)}
      strokeWidth={1.7 / view.k}
      aria-hidden="true"
    />
  );
}

function NodeGlyph({
  isFile,
  radius,
  view,
}: Pick<NodeFacts, "isFile" | "radius"> & { view: View }) {
  if (isFile) {
    return (
      <circle className="rm-node-disc" r={radius} strokeWidth={1.4 / view.k} />
    );
  }
  return (
    <>
      <circle
        className="rm-node-ring"
        r={radius * 0.95}
        strokeWidth={1.4 / view.k}
      />
      <circle className="rm-node-core" r={radius * 0.36} />
    </>
  );
}

/** One node — an inked disc for a file, a ringed dot for a memory — with its
 * hit target and hover/click wiring (all handlers threaded from the shell). */
export default function NodeStar(props: NodeStarProps) {
  const facts = factsFor(props);
  const interaction = useNodeInteraction(props, facts);
  return (
    <g
      className={nodeClass(facts)}
      transform={`translate(${props.n.x} ${props.n.y})`}
      style={{ cursor: facts.openable ? "pointer" : "default" }}
      role="button"
      tabIndex={0}
      aria-label={facts.label}
      onMouseEnter={interaction.onNodeEnter}
      onMouseMove={interaction.onNodeMove}
      onMouseLeave={interaction.onNodeLeave}
      onFocus={interaction.onNodeFocus}
      onBlur={interaction.onNodeLeave}
      onKeyDown={interaction.onNodeKeyDown}
      onPointerDown={interaction.onPointerDown}
      onClick={interaction.onNodeClick}
    >
      <circle className="rm-node-hit" r={facts.hitRadius} />
      <SelectionCircle
        active={facts.active}
        radius={facts.radius}
        view={props.view}
      />
      <NodeGlyph
        isFile={facts.isFile}
        radius={facts.radius}
        view={props.view}
      />
    </g>
  );
}
