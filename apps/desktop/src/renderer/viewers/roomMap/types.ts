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
/** WHAT a link claims. Mirrors EDGE_KINDS in
 *  src-tauri/src/commands/moonshot/graph.rs; the first five are relations the
 *  room can prove from what it stored, `similar` is the only inferred one. */
export type EdgeKind =
  | "derived"
  | "same_page"
  | "mentions"
  | "cited"
  | "same_site"
  | "similar";

export interface GraphEdge {
  a: string;
  b: string;
  weight: number;
  /** One of EdgeKind. Typed as string because the payload comes from the
   *  backend: an unrecognised kind must render as the weakest thing it could
   *  be (see `styleFor`), not crash the map. */
  kind: string;
  /** True when the relation reads a → b (a produced b, or a names b). */
  directed: boolean;
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
 *  kind, weight + `shared` reasons. `hidden` is set by the type/strength
 *  filter: a hidden edge is neither drawn nor allowed to pull on the layout,
 *  but it stays in the array so filtering never re-seeds the simulation. */
export interface SimEdge {
  ai: number;
  bi: number;
  edge: GraphEdge;
  hidden?: boolean;
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
