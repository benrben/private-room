import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { toBands, type GraphNode } from "./agentNodes";
import { GLYPH, STATUS_WORD, type Edge, sameEdges } from "./agentGraphShared";

/** The drawn graph. Owns its own measurement, so the inline copy and the
 * expanded one can both exist without fighting over one set of element refs. */
export function GraphCanvas({
  main,
  children,
  selected,
  onSelect,
  elapsedFor,
  runningCount,
  lane,
  roomy,
}: {
  main: GraphNode;
  children: GraphNode[];
  selected: string | null;
  onSelect: (key: string) => void;
  elapsedFor: (key: string) => string | null;
  runningCount: number;
  lane: string;
  roomy?: boolean;
}) {
  const bands = useMemo(() => toBands(children), [children]);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const nodeEls = useRef<Map<string, HTMLElement>>(new Map());
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [edges, setEdges] = useState<Edge[]>([]);

  const setNodeRef = (key: string, el: HTMLElement | null) =>
    setGraphNodeRef(nodeEls.current, key, el);

  // Re-measure whenever the roster, its statuses or the box changes. A
  // ResizeObserver covers the cases no dependency can see: the chat pane being
  // resized, and the node text reflowing to two lines at a narrow width.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () =>
      measureGraph(canvas, nodeEls.current, main, children, setSize, setEdges);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [main, children, roomy]);

  return (
    <div className={`agraph-canvas${roomy ? " roomy" : ""}`} ref={canvasRef}>
      {/* Edges are measured from the laid-out DOM rather than assumed from a
          row count: a "N in parallel" band header shifts every row below it, so
          computed midpoints would drift off the nodes they point at.
          Decorative — the structure is in the node buttons' labels. */}
      <GraphEdges edges={edges} size={size} roomy={roomy} />
      <GraphHub
        main={main}
        selected={selected}
        onSelect={onSelect}
        runningCount={runningCount}
        lane={lane}
        setNodeRef={setNodeRef}
      />
      <GraphBands
        bands={bands}
        selected={selected}
        onSelect={onSelect}
        elapsedFor={elapsedFor}
        setNodeRef={setNodeRef}
      />
    </div>
  );
}

function setGraphNodeRef(
  nodes: Map<string, HTMLElement>,
  key: string,
  element: HTMLElement | null,
) {
  if (element) nodes.set(key, element);
  else nodes.delete(key);
}

function graphEdge(
  box: DOMRect,
  hub: DOMRect,
  node: GraphNode,
  element: HTMLElement | undefined,
): Edge | null {
  const child = element?.getBoundingClientRect();
  if (!child) return null;
  const x1 = hub.right - box.left;
  const y1 = hub.top + hub.height / 2 - box.top;
  const x2 = child.left - box.left;
  const y2 = child.top + child.height / 2 - box.top;
  return {
    key: node.key,
    status: node.status,
    x1,
    y1,
    x2,
    y2,
    dx: Math.max(10, (x2 - x1) * 0.45),
    label: node.instruction,
    lx: x2 - 10,
    ly: child.top - box.top - 5,
  };
}

function graphEdges(
  box: DOMRect,
  hub: DOMRect,
  children: GraphNode[],
  nodes: Map<string, HTMLElement>,
): Edge[] {
  return children
    .map((node) => graphEdge(box, hub, node, nodes.get(node.key)))
    .filter((edge): edge is Edge => edge !== null);
}

function updateGraphSize(
  setSize: React.Dispatch<React.SetStateAction<{ w: number; h: number }>>,
  box: DOMRect,
) {
  setSize((previous) =>
    previous.w === box.width && previous.h === box.height
      ? previous
      : { w: box.width, h: box.height },
  );
}

function measureGraph(
  canvas: HTMLDivElement,
  nodes: Map<string, HTMLElement>,
  main: GraphNode,
  children: GraphNode[],
  setSize: React.Dispatch<React.SetStateAction<{ w: number; h: number }>>,
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>,
) {
  const box = canvas.getBoundingClientRect();
  const hub = nodes.get(main.key)?.getBoundingClientRect();
  if (!hub) return;
  const next = graphEdges(box, hub, children, nodes);
  updateGraphSize(setSize, box);
  setEdges((previous) => (sameEdges(previous, next) ? previous : next));
  canvas.classList.toggle(
    "scrolls",
    canvas.scrollHeight > canvas.clientHeight + 1,
  );
}

function edgePath(edge: Edge) {
  return `M${edge.x1},${edge.y1} C${edge.x1 + edge.dx},${edge.y1} ${edge.x2 - edge.dx},${edge.y2} ${edge.x2},${edge.y2}`;
}

function edgeLabel(label: string) {
  return label.length > 42 ? `${label.slice(0, 41)}…` : label;
}

function GraphEdges({
  edges,
  size,
  roomy,
}: {
  edges: Edge[];
  size: { w: number; h: number };
  roomy?: boolean;
}) {
  return (
    <svg
      className="agraph-edges"
      width={size.w}
      height={size.h}
      viewBox={`0 0 ${size.w} ${size.h}`}
      aria-hidden
    >
      {edges.map((edge) => (
        <path
          key={edge.key}
          className={`agraph-edge ${edge.status}`}
          d={edgePath(edge)}
        />
      ))}
      {roomy && <GraphEdgeLabels edges={edges} />}
    </svg>
  );
}

function GraphEdgeLabels({ edges }: { edges: Edge[] }) {
  return edges.map(
    (edge) =>
      edge.label && (
        <text
          key={`${edge.key}-label`}
          className="agraph-edge-label"
          x={edge.lx}
          y={edge.ly}
          textAnchor="end"
        >
          {edgeLabel(edge.label)}
        </text>
      ),
  );
}

function hubSubtitle(main: GraphNode, runningCount: number, lane: string) {
  if (runningCount > 0) return `waiting on ${runningCount}`;
  if (main.status === "running") return lane || "working";
  return main.status === "pending" ? "queued" : lane || "answered";
}

function GraphHub({
  main,
  selected,
  onSelect,
  runningCount,
  lane,
  setNodeRef,
}: {
  main: GraphNode;
  selected: string | null;
  onSelect: (key: string) => void;
  runningCount: number;
  lane: string;
  setNodeRef: (key: string, element: HTMLElement | null) => void;
}) {
  return (
    <div className="agraph-hub">
      <NodeCard
        node={main}
        nodeRef={(element) => setNodeRef(main.key, element)}
        selected={selected === main.key}
        onSelect={() => onSelect(main.key)}
        elapsed={null}
        subtitle={hubSubtitle(main, runningCount, lane)}
        isHub
      />
    </div>
  );
}

function bandLabel(band: GraphNode[]) {
  return band.length > 1
    ? `${band.length} agents dispatched together`
    : `${band[0].label}, dispatched alone`;
}

function GraphBands({
  bands,
  selected,
  onSelect,
  elapsedFor,
  setNodeRef,
}: {
  bands: GraphNode[][];
  selected: string | null;
  onSelect: (key: string) => void;
  elapsedFor: (key: string) => string | null;
  setNodeRef: (key: string, element: HTMLElement | null) => void;
}) {
  return (
    <div className="agraph-children">
      {bands.map((band, index) => (
        <GraphBand
          key={index}
          band={band}
          selected={selected}
          onSelect={onSelect}
          elapsedFor={elapsedFor}
          setNodeRef={setNodeRef}
        />
      ))}
    </div>
  );
}

function GraphBand({
  band,
  selected,
  onSelect,
  elapsedFor,
  setNodeRef,
}: {
  band: GraphNode[];
  selected: string | null;
  onSelect: (key: string) => void;
  elapsedFor: (key: string) => string | null;
  setNodeRef: (key: string, element: HTMLElement | null) => void;
}) {
  const parallel = band.length > 1;
  return (
    <div
      className={`agraph-band${parallel ? " parallel" : ""}`}
      role="group"
      aria-label={bandLabel(band)}
    >
      {parallel && (
        <span className="agraph-band-tag">
          <span className="agraph-band-rail" aria-hidden />
          {band.length} in parallel
        </span>
      )}
      {band.map((node) => (
        <NodeCard
          key={node.key}
          node={node}
          nodeRef={(element) => setNodeRef(node.key, element)}
          selected={selected === node.key}
          onSelect={() => onSelect(node.key)}
          elapsed={elapsedFor(node.key)}
          subtitle={node.instruction}
        />
      ))}
    </div>
  );
}

function NodeCard({
  node,
  nodeRef,
  selected,
  onSelect,
  elapsed,
  subtitle,
  isHub,
}: {
  node: GraphNode;
  nodeRef: (el: HTMLElement | null) => void;
  selected: boolean;
  onSelect: () => void;
  elapsed: string | null;
  subtitle: string;
  isHub?: boolean;
}) {
  return (
    <button
      type="button"
      ref={nodeRef}
      className={`agraph-node ${node.status}${selected ? " selected" : ""}${isHub ? " hub" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${node.label}, ${STATUS_WORD[node.status]}. ${subtitle}`}
      title={subtitle}
    >
      <span className="agraph-glyph" aria-hidden>
        {node.status === "running" ? (
          <span className="agraph-spin" />
        ) : (
          GLYPH[node.status]
        )}
      </span>
      <span className="agraph-node-text">
        <span className="agraph-node-label">{node.label}</span>
        <span className="agraph-node-sub">{subtitle}</span>
      </span>
      {elapsed && <span className="agraph-elapsed">{elapsed}</span>}
    </button>
  );
}
