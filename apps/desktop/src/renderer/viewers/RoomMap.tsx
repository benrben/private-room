import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GraphIcon } from "../icons";
import "./roomMap.css";
import type { LabelBox, RoomGraph, RoomMapProps, SimEdge, SimNode, Tip, View } from "./roomMap/types";
import { EMPTY_TEXT, LABEL_CHAR_W, LABEL_FONT, LABEL_H, LABEL_MARK_W, LABEL_MAX, LABEL_MIN_R_PX, LABEL_PAD, NAME_MAX } from "./roomMap/constants";
import { nodeRadius } from "./roomMap/layout";
import { EDGE_KINDS, EDGE_STYLE, edgeRank, styleFor, type EdgeFilter } from "./roomMap/edges";
import { useRoomGraph } from "./roomMap/useRoomGraph";
import { usePanZoom } from "./roomMap/usePanZoom";
import Edge from "./roomMap/Edge";
import Label from "./roomMap/Label";
import NodeStar from "./roomMap/NodeStar";
import Tooltip from "./roomMap/Tooltip";

export type { GraphEdge, GraphNode, RoomGraph, RoomMapProps } from "./roomMap/types";

const TIP_MAX_W = 260;
const TIP_PAD_X = 20;
const TIP_PAD_Y = 14;
const TIP_LINE_H = 19;
const TIP_LINE_GAP = 2;
const TIP_OFFSET = 14;

interface LabelCandidate {
  n: SimNode;
  sx: number;
  sy: number;
  rScreen: number;
  prio: number;
  deg: number;
}

interface Box { x: number; y: number; w: number; h: number }
interface ListGroup { kind: string; label: string; names: string[] }
interface ListRow { id: string; name: string; folder: string; openable: boolean; groups: ListGroup[]; total: number }
type GraphState = ReturnType<typeof useRoomGraph>;
type PanZoom = ReturnType<typeof usePanZoom>;

interface MapModel extends GraphState, PanZoom {
  focus: string | null;
  hasStage: boolean;
  hidden: string[];
  hovered: string | null;
  labels: LabelBox[];
  layout: { nodes: SimNode[]; edges: SimEdge[] } | null;
  listRows: ListRow[];
  listView: boolean;
  minWeight: number;
  onOpenFile?: (id: string) => void;
  rebuilt: boolean;
  refit: () => void;
  selectedNeighbors: Set<string> | null;
  setHidden: React.Dispatch<React.SetStateAction<string[]>>;
  setFocus: React.Dispatch<React.SetStateAction<string | null>>;
  setHovered: React.Dispatch<React.SetStateAction<string | null>>;
  setListView: React.Dispatch<React.SetStateAction<boolean>>;
  setMinWeight: React.Dispatch<React.SetStateAction<number>>;
  setShowLegend: React.Dispatch<React.SetStateAction<boolean>>;
  setTip: React.Dispatch<React.SetStateAction<Tip | null>>;
  showEmpty: boolean;
  showLegend: boolean;
  showTip: (event: React.MouseEvent, title: string, lines: string[]) => void;
  stageRef: React.RefObject<HTMLDivElement | null>;
  tip: Tip | null;
}

function onCanvas(at: number, length: number, span: number): number {
  const edge = 4;
  return Math.max(edge, Math.min(at, span - length - edge));
}

function textWidth(text: string): number { return text.length * LABEL_CHAR_W; }

function countTipRows(textW: number): (total: number, text: string) => number {
  return (total, text) => total + Math.max(1, Math.ceil(textWidth(text) / textW));
}

function tipBox(title: string, lines: string[]): { w: number; h: number } {
  const widest = Math.max(1, textWidth(title), ...lines.map(textWidth));
  const textW = Math.min(TIP_MAX_W, widest);
  const rows = [title, ...lines].reduce(countTipRows(textW), 0);
  return { w: textW + TIP_PAD_X, h: TIP_PAD_Y + rows * TIP_LINE_H + lines.length * TIP_LINE_GAP };
}

function mousePosition(event: React.MouseEvent, rect: DOMRect | undefined): { x: number; y: number } {
  if (!rect) return { x: event.clientX, y: event.clientY };
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function tipCoordinate(point: number, boxLength: number, limit: number | undefined): number {
  const offset = point + TIP_OFFSET;
  if (limit === undefined || offset + boxLength <= limit) return offset;
  return Math.max(4, point - TIP_OFFSET - boxLength);
}

function tipPosition(event: React.MouseEvent, title: string, lines: string[], stage: HTMLDivElement | null): Tip {
  const rect = stage?.getBoundingClientRect();
  const point = mousePosition(event, rect);
  const box = tipBox(title, lines);
  return { left: tipCoordinate(point.x, box.w, rect?.width), top: tipCoordinate(point.y, box.h, rect?.height), title, lines };
}

function useTooltip(stageRef: React.RefObject<HTMLDivElement | null>, setTip: React.Dispatch<React.SetStateAction<Tip | null>>) {
  return useCallback((event: React.MouseEvent, title: string, lines: string[]) => setTip(tipPosition(event, title, lines, stageRef.current)), [setTip, stageRef]);
}

function labelPriority(node: SimNode, focusId: string | null, neighbors: Set<string> | null, radius: number): number {
  if (node.id === focusId) return 3;
  if (neighbors?.has(node.id)) return 2;
  return radius >= LABEL_MIN_R_PX ? 1 : 0;
}

function nodeIsVisible(x: number, y: number, radius: number, size: { w: number; h: number }): boolean {
  return x + radius >= 0 && x - radius <= size.w && y + radius >= 0 && y - radius <= size.h;
}

function toLabelCandidate(node: SimNode, view: View, size: { w: number; h: number }, degree: Map<string, number>, focusId: string | null, neighbors: Set<string> | null): LabelCandidate | null {
  const sx = node.x * view.k + view.x;
  const sy = node.y * view.k + view.y;
  const deg = degree.get(node.id) ?? 0;
  const rScreen = nodeRadius(deg) * view.k;
  if (!nodeIsVisible(sx, sy, rScreen, size)) return null;
  const prio = labelPriority(node, focusId, neighbors, rScreen);
  return prio ? { n: node, sx, sy, rScreen, prio, deg } : null;
}

function compareCandidates(a: LabelCandidate, b: LabelCandidate): number {
  if (a.prio !== b.prio) return b.prio - a.prio;
  if (a.deg !== b.deg) return b.deg - a.deg;
  return compareIds(a.n.id, b.n.id);
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function labelName(name: string): string { return name.length <= NAME_MAX ? name : `${name.slice(0, NAME_MAX - 1)}…`; }
function labelWidth(candidate: LabelCandidate): number { return labelName(candidate.n.name).length * LABEL_CHAR_W + LABEL_PAD * 2 + (candidate.n.kind === "memory" ? LABEL_MARK_W : 0); }

function labelSpots(candidate: LabelCandidate, width: number): { x: number; y: number }[] {
  const off = Math.max(candidate.rScreen, 3) + 6;
  return [
    { x: candidate.sx + off, y: candidate.sy - LABEL_H / 2 },
    { x: candidate.sx - off - width, y: candidate.sy - LABEL_H / 2 },
    { x: candidate.sx + off * 0.5, y: candidate.sy + off },
    { x: candidate.sx - off * 0.5 - width, y: candidate.sy + off },
    { x: candidate.sx + off * 0.5, y: candidate.sy - off - LABEL_H },
    { x: candidate.sx - off * 0.5 - width, y: candidate.sy - off - LABEL_H },
  ];
}

function clampedBoxes(candidate: LabelCandidate, width: number, size: { w: number; h: number }): Box[] {
  return labelSpots(candidate, width).map((spot) => ({ x: onCanvas(spot.x, width, size.w), y: onCanvas(spot.y, LABEL_H, size.h), w: width, h: LABEL_H }));
}

function boxesOverlap(a: Box, b: Box): boolean { return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y; }

function firstFreeBox(boxes: Box[], placed: Box[]): Box | null {
  for (const box of boxes) if (placed.every((other) => !boxesOverlap(box, other))) return box;
  return null;
}

function fallbackBox(box: Box | null, priority: number, boxes: Box[]): Box | null {
  if (box || priority < 2) return box;
  return boxes[0] ?? null;
}

function makeLabel(candidate: LabelCandidate, placed: Box[], size: { w: number; h: number }): LabelBox | null {
  const width = labelWidth(candidate);
  const boxes = clampedBoxes(candidate, width, size);
  const box = fallbackBox(firstFreeBox(boxes, placed), candidate.prio, boxes);
  if (!box) return null;
  const markWidth = candidate.n.kind === "memory" ? LABEL_MARK_W : 0;
  return { id: candidate.n.id, name: labelName(candidate.n.name), textX: box.x + LABEL_PAD + markWidth, textY: box.y + LABEL_H / 2 + LABEL_FONT * 0.35, boxX: box.x, boxY: box.y, boxW: width, boxH: LABEL_H, prio: candidate.prio, kind: candidate.n.kind };
}

function labelCandidates(layout: { nodes: SimNode[]; edges: SimEdge[] }, view: View, size: { w: number; h: number }, degree: Map<string, number>, focusId: string | null, neighbors: Set<string> | null): LabelCandidate[] {
  const candidates: LabelCandidate[] = [];
  for (const node of layout.nodes) {
    const candidate = toLabelCandidate(node, view, size, degree, focusId, neighbors);
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort(compareCandidates);
}

function canBuildLabels(layout: { nodes: SimNode[]; edges: SimEdge[] } | null, size: { w: number; h: number }): layout is { nodes: SimNode[]; edges: SimEdge[] } {
  return layout !== null && size.w > 0 && size.h > 0;
}

function appendLabel(labels: LabelBox[], placed: Box[], candidate: LabelCandidate, size: { w: number; h: number }): boolean {
  if (labels.length >= LABEL_MAX) return false;
  const label = makeLabel(candidate, placed, size);
  if (!label) return true;
  placed.push({ x: label.boxX, y: label.boxY, w: label.boxW, h: label.boxH });
  labels.push(label);
  return true;
}

function buildLabels(layout: { nodes: SimNode[]; edges: SimEdge[] } | null, view: View, size: { w: number; h: number }, degree: Map<string, number>, focusId: string | null, neighbors: Set<string> | null): LabelBox[] {
  if (!canBuildLabels(layout, size)) return [];
  const placed: Box[] = [];
  const labels: LabelBox[] = [];
  for (const candidate of labelCandidates(layout, view, size, degree, focusId, neighbors)) {
    if (!appendLabel(labels, placed, candidate, size)) break;
  }
  return labels;
}

function printedNodeName(nodes: Map<string, RoomGraph["nodes"][number]>, id: string): string {
  const node = nodes.get(id);
  if (!node) return id;
  return node.kind === "memory" ? `Memory: ${node.name}` : node.name;
}

function addListNote(perNode: Map<string, Map<string, string[]>>, nodes: Map<string, RoomGraph["nodes"][number]>, from: string, to: string, kind: string) {
  const kinds = perNode.get(from) ?? new Map<string, string[]>();
  perNode.set(from, kinds);
  const names = kinds.get(kind) ?? [];
  kinds.set(kind, names);
  names.push(printedNodeName(nodes, to));
}

function makeListGroups(kinds: Map<string, string[]>): ListGroup[] {
  return [...kinds.entries()].sort((left, right) => edgeRank(left[0]) - edgeRank(right[0])).map(([kind, names]) => ({ kind, label: styleFor(kind).label, names: [...names].sort((a, b) => a.localeCompare(b)) }));
}

function makeListRow(node: RoomGraph["nodes"][number], perNode: Map<string, Map<string, string[]>>): ListRow {
  const groups = makeListGroups(perNode.get(node.id) ?? new Map<string, string[]>());
  return { id: node.id, name: node.name, folder: node.kind === "memory" ? "Memory" : node.folder || "Top level", openable: node.kind === "file", groups, total: groups.reduce((total, group) => total + group.names.length, 0) };
}

function compareListRows(a: ListRow, b: ListRow): number { return a.total !== b.total ? b.total - a.total : a.name.localeCompare(b.name); }

function buildListRows(graph: RoomGraph | null, visibleEdges: GraphState["visibleEdges"]): ListRow[] {
  const nodes = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
  const perNode = new Map<string, Map<string, string[]>>();
  for (const edge of visibleEdges) {
    addListNote(perNode, nodes, edge.a, edge.b, edge.kind);
    addListNote(perNode, nodes, edge.b, edge.a, edge.kind);
  }
  return (graph?.nodes ?? []).map((node) => makeListRow(node, perNode)).sort(compareListRows);
}

function useRebuilt(graph: RoomGraph | null, userAdjustedRef: React.MutableRefObject<boolean>, resetView: () => void) {
  const [rebuilt, setRebuilt] = useState(false);
  const seenGraphRef = useRef<RoomGraph | null>(null);
  useEffect(() => {
    if (!graph) return;
    const previous = seenGraphRef.current;
    seenGraphRef.current = graph;
    if (previous && userAdjustedRef.current) setRebuilt(true);
  }, [graph, userAdjustedRef]);
  const refit = useCallback(() => { setRebuilt(false); resetView(); }, [resetView]);
  return { rebuilt, refit };
}

function useMapFilter(hidden: string[], minWeight: number): EdgeFilter {
  return useMemo(() => ({ hidden, minWeight }), [hidden, minWeight]);
}

function neighborState(focus: string | null, topNode: string | null, adjacency: Map<string, Set<string>>) {
  const labelFocusId = focus ?? topNode;
  const labelNeighbors = labelFocusId ? adjacency.get(labelFocusId) ?? null : null;
  const selectedNeighbors = focus ? adjacency.get(focus) ?? null : null;
  return { labelFocusId, labelNeighbors, selectedNeighbors };
}

function mapHasStage(size: { w: number; h: number }): boolean { return size.w > 0 && size.h > 0; }

function mapIsEmpty(graph: RoomGraph | null, fileNodeCount: number): boolean {
  if (graph === null) return false;
  if (fileNodeCount === 0) return true;
  return graph.nodes.length < 2;
}

function useMapLabels(layout: React.MutableRefObject<{ nodes: SimNode[]; edges: SimEdge[] } | null>, panZoom: PanZoom, graphState: GraphState, focusId: string | null, neighbors: Set<string> | null): LabelBox[] {
  return useMemo(
    () => buildLabels(layout.current, panZoom.view, graphState.size, graphState.degree, focusId, neighbors),
    [panZoom.view, graphState.size, graphState.degree, focusId, neighbors, graphState.nonce],
  );
}

function useListRows(graph: RoomGraph | null, visibleEdges: GraphState["visibleEdges"]): ListRow[] {
  return useMemo(() => buildListRows(graph, visibleEdges), [graph, visibleEdges]);
}

function useRoomMapModel(onOpenFile: RoomMapProps["onOpenFile"]): MapModel {
  const [tip, setTip] = useState<Tip | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [listView, setListView] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [minWeight, setMinWeight] = useState(0);
  const [showLegend, setShowLegend] = useState(true);
  const filter = useMapFilter(hidden, minWeight);
  const stageRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const userAdjustedRef = useRef(false);
  const layoutRef = useRef<{ nodes: SimNode[]; edges: SimEdge[] } | null>(null);
  const panZoom = usePanZoom({ sizeRef, userAdjustedRef, layoutRef, setFocus, setTip });
  const graphState = useRoomGraph({ filter, stageRef, sizeRef, userAdjustedRef, layoutRef, setView: panZoom.setView, setFocus });
  const neighbors = neighborState(focus, graphState.topNode, graphState.adjacency);
  const { rebuilt, refit } = useRebuilt(graphState.graph, userAdjustedRef, panZoom.resetView);
  const labels = useMapLabels(layoutRef, panZoom, graphState, neighbors.labelFocusId, neighbors.labelNeighbors);
  const listRows = useListRows(graphState.graph, graphState.visibleEdges);
  const showTip = useTooltip(stageRef, setTip);
  const showEmpty = mapIsEmpty(graphState.graph, graphState.fileNodeCount);
  return { ...graphState, ...panZoom, focus, hasStage: mapHasStage(graphState.size), hidden, hovered, labels, layout: layoutRef.current, listRows, listView, minWeight, onOpenFile, rebuilt, refit, selectedNeighbors: neighbors.selectedNeighbors, setFocus, setHidden, setHovered, setListView, setMinWeight, setShowLegend, setTip, showEmpty, showLegend, showTip, stageRef, tip };
}

function countTitle(model: MapModel): string | undefined {
  if (!model.atFileLimit) return undefined;
  return `This map covers the ${model.fileNodeCount} newest files in the room; if there are more than that, the older ones aren't on it.`;
}

function pluralSuffix(count: number): string { return count === 1 ? "" : "s"; }
function newestPrefix(atLimit: boolean): string { return atLimit ? "newest " : ""; }

function hiddenEdgeText(model: MapModel): string | null {
  const hidden = model.cappedEdges.length - model.visibleEdges.length;
  return hidden > 0 ? ` (${hidden} hidden)` : null;
}

function RoomMapCount({ model }: { model: MapModel }) {
  if (!model.graph || model.showEmpty) return null;
  return <span className="room-map-count" title={countTitle(model)}>· {newestPrefix(model.atFileLimit)}{model.fileNodeCount} file{pluralSuffix(model.fileNodeCount)} · {model.visibleEdges.length} link{pluralSuffix(model.visibleEdges.length)}{hiddenEdgeText(model)}</span>;
}

function toggleClass(base: string, on: boolean): string { return on ? `${base} is-on` : base; }
function mapCanShowControls(model: MapModel): boolean { return model.graph !== null && !model.showEmpty; }

function LegendToggle({ model }: { model: MapModel }) {
  return <button type="button" className={toggleClass("nb-chip nb-chip-btn rm-toolchip rm-listtoggle", model.showLegend)} aria-pressed={model.showLegend} title="Choose which kinds of link the map shows" onClick={() => model.setShowLegend((value) => !value)}>Links</button>;
}

function RebuiltNotice({ model }: { model: MapModel }) {
  if (!model.rebuilt || model.listView) return null;
  return <button type="button" className="nb-chip nb-chip-btn rm-toolchip" title="The room changed, so the map was laid out again — the stars have moved. Fit it back to the screen." onClick={model.refit}>Map rebuilt — reset view</button>;
}

function ListToggle({ model }: { model: MapModel }) {
  const text = model.listView ? "Map" : "List";
  return <button type="button" className={toggleClass("nb-chip nb-chip-btn rm-toolchip rm-toolbtn", model.listView)} aria-pressed={model.listView} title="Show the same files and connections as a plain, keyboard-reachable list" onClick={() => model.setListView((value) => !value)}>{text}</button>;
}

function RoomMapToolbarButtons({ model }: { model: MapModel }) {
  if (!mapCanShowControls(model)) return null;
  return <><LegendToggle model={model} /><RebuiltNotice model={model} /><ListToggle model={model} /></>;
}

function RoomMapToolbar({ model }: { model: MapModel }) { return <div className="room-map-toolbar"><GraphIcon size={16} /><span className="room-map-title">Room map</span><RoomMapCount model={model} /><RoomMapToolbarButtons model={model} /></div>; }

function LegendChip({ kind, model }: { kind: string; model: MapModel }) {
  const style = styleFor(kind);
  const count = model.edgeCounts[kind] ?? 0;
  const on = !model.hidden.includes(kind);
  const title = count === 0 ? `Nothing in this room is linked this way — ${style.lead.toLowerCase()}` : style.lead;
  return <button type="button" className={`nb-chip nb-chip-btn rm-legend-chip${on ? " is-on" : ""}`} aria-pressed={on} disabled={count === 0} title={title} onClick={() => model.setHidden((current) => current.includes(kind) ? current.filter((value) => value !== kind) : [...current, kind])}><svg className="rm-legend-swatch" width="26" height="10" aria-hidden="true"><line x1="2.5" y1="5" x2="23.5" y2="5" style={{ stroke: style.color, strokeWidth: 1.5 * style.widthMul }} strokeDasharray={style.dash ?? undefined} strokeLinecap="round" /></svg>{style.label}<span className="rm-legend-count">{count}</span></button>;
}

function RoomMapLegend({ model }: { model: MapModel }) {
  if (!model.graph || model.showEmpty || !model.showLegend) return null;
  return <div className="rm-legend" role="group" aria-label="Link kinds">{EDGE_KINDS.map((kind) => <LegendChip key={kind} kind={kind} model={model} />)}<label className="rm-legend-strength"><span className="rm-legend-strength-label">Strength</span><input type="range" min={0} max={0.9} step={0.1} value={model.minWeight} onChange={(event) => model.setMinWeight(Number(event.target.value))} title="Hide the weakest links" /><span className="rm-legend-count">{Math.round(model.minWeight * 100)}%</span></label></div>;
}

function RoomMapError({ error, reload }: { error: string; reload: () => void }) { return <div className="room-map-error" role="alert"><p>The room map couldn’t be built. Nothing in the room was changed — this is only the map.</p><p className="room-map-error-detail">{error}</p><button type="button" className="nb-btn rm-retry" onClick={reload}>Try again</button></div>; }
function MapFeedback({ model }: { model: MapModel }) { return <>{model.status && <div className="viewer-status">{model.status}</div>}{model.error && <RoomMapError error={model.error} reload={model.reload} />}</>; }

function RoomMapListRow({ row, onOpenFile }: { row: ListRow; onOpenFile?: (id: string) => void }) { return <li><button type="button" className="rm-list-name" onClick={() => row.openable && onOpenFile?.(row.id)} disabled={!row.openable || !onOpenFile}>{row.name}</button><span className="rm-list-folder">{row.folder}</span><div className="rm-list-links">{row.groups.length === 0 ? "No connections found" : <ul className="rm-list-kinds">{row.groups.map((group) => <li key={group.kind}><span className="rm-list-kind">{group.label}:</span> {group.names.join(", ")}</li>)}</ul>}</div></li>; }
function RoomMapList({ model }: { model: MapModel }) { return <div className="room-map-list"><ul className="nb-list rm-list">{model.listRows.map((row) => <RoomMapListRow key={row.id} row={row} onOpenFile={model.onOpenFile} />)}</ul></div>; }

function ArrowMarkers({ view }: { view: View }) { return <defs>{EDGE_KINDS.filter((kind) => EDGE_STYLE[kind].directed).map((kind) => <marker key={kind} id={`rm-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth={7 / view.k} markerHeight={7 / view.k} markerUnits="userSpaceOnUse" orient="auto"><path d="M0,1 L10,5 L0,9 z" style={{ fill: EDGE_STYLE[kind].color }} /></marker>)}</defs>; }
function MapEdges({ model }: { model: MapModel }) { if (!model.layout) return null; return <>{model.layout.edges.map((edge, index) => edge.hidden ? null : <Edge key={`e${index}`} se={edge} a={model.layout!.nodes[edge.ai]} b={model.layout!.nodes[edge.bi]} view={model.view} hovered={model.hovered} focusId={model.focus} degree={model.degree} showTip={model.showTip} setTip={model.setTip} />)}</>; }
function MapNodes({ model }: { model: MapModel }) { if (!model.layout) return null; return <>{model.layout.nodes.map((node) => <NodeStar key={node.id} n={node} degree={model.degree} hovered={model.hovered} focusId={model.focus} focusNeighbors={model.selectedNeighbors} view={model.view} onOpenFile={model.onOpenFile} setHovered={model.setHovered} setFocus={model.setFocus} showTip={model.showTip} setTip={model.setTip} />)}</>; }

function RoomMapCanvas({ model }: { model: MapModel }) {
  if (!model.hasStage) return null;
  return <svg ref={model.svgRef} className="room-map-svg" width={model.size.w} height={model.size.h} viewBox={`0 0 ${model.size.w} ${model.size.h}`} onWheel={model.onWheel}><ArrowMarkers view={model.view} /><rect x={0} y={0} width={model.size.w} height={model.size.h} fill="transparent" onPointerDown={model.onBgDown} onPointerMove={model.onBgMove} onPointerUp={model.onBgUp} onPointerCancel={model.onBgUp} /><g transform={`translate(${model.view.x} ${model.view.y}) scale(${model.view.k})`}><MapEdges model={model} /><MapNodes model={model} /></g><g className="room-map-labels" pointerEvents="none">{model.labels.map((label) => <Label key={`l${label.id}`} l={label} />)}</g></svg>;
}

function MapDisplay({ model }: { model: MapModel }) {
  if (model.error) return null;
  if (model.showEmpty) return <div className="room-map-empty rm-empty">{EMPTY_TEXT}</div>;
  if (model.listView) return <RoomMapList model={model} />;
  return <RoomMapCanvas model={model} />;
}

function ZoomIcon({ path }: { path: string }) { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d={path} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>; }
function ResetIcon() { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>; }

function RoomMapControls({ model }: { model: MapModel }) {
  if (model.showEmpty || model.listView || model.error || !model.hasStage) return null;
  return <div className="rm-controls"><button type="button" className="nb-btn nb-btn-icon rm-btn" title="Zoom in" aria-label="Zoom in" onClick={() => model.zoomBy(1.25)}><ZoomIcon path="M8 3.5v9M3.5 8h9" /></button><button type="button" className="nb-btn nb-btn-icon rm-btn" title="Zoom out" aria-label="Zoom out" onClick={() => model.zoomBy(1 / 1.25)}><ZoomIcon path="M3.5 8h9" /></button><button type="button" className="nb-btn nb-btn-icon rm-btn rm-btn-reset" title="Reset view (fit to screen)" aria-label="Reset view" onClick={model.refit}><ResetIcon /></button></div>;
}

function RoomMapStage({ model }: { model: MapModel }) { return <div className="room-map-stage" ref={model.stageRef}><MapFeedback model={model} /><MapDisplay model={model} /><RoomMapControls model={model} />{model.tip && <Tooltip tip={model.tip} />}</div>; }
function RoomMapContent({ model }: { model: MapModel }) { return <div className="room-map" style={{ position: "relative", width: "100%", height: "100%" }}><RoomMapToolbar model={model} /><RoomMapLegend model={model} /><RoomMapStage model={model} /></div>; }

export default function RoomMap({ onOpenFile }: RoomMapProps) { return <RoomMapContent model={useRoomMapModel(onOpenFile)} />; }
