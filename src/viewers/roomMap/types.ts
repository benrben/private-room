// Graph shapes for the Room Map. Data comes from api.roomGraph(); these local
// interfaces are the layout module's working copies (SimNode/SimEdge build on
// them).
export interface GraphNode {
  id: string;
  name: string;
  folder?: string | null;
  summary?: string | null;
  kind: "file" | "memory";
}
export interface GraphEdge {
  a: string;
  b: string;
  weight: number;
  shared: string[];
}
export interface RoomGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface RoomMapProps {
  /** Called with a file node's id when its star is clicked, so the shell can
   *  open that file. Memory nodes are not openable. */
  onOpenFile?: (id: string) => void;
}

/** A node with a live position in layout ("world") space. */
export type SimNode = GraphNode & { x: number; y: number };
/** An edge resolved to layout-array indices, keeping the source edge for its
 *  weight + `shared` reasons. */
export interface SimEdge {
  ai: number;
  bi: number;
  edge: GraphEdge;
}
/** The screen transform: world→screen is `screen = world * k + (x, y)`. */
export interface View {
  k: number;
  x: number;
  y: number;
}

export interface Tip {
  left: number;
  top: number;
  title: string;
  lines: string[];
}
/** A resolved, de-cluttered on-canvas label (screen coords). */
export interface LabelBox {
  id: string;
  name: string;
  textX: number;
  textY: number;
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
  prio: number; // 3 selected · 2 neighbour · 1 zoom-based
  kind: "file" | "memory";
}
