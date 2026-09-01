import type { Lane, Step } from "./jobs.js";
import { bestDefault } from "./turnContext.js";
import { bestLocalDefault } from "./ollamaModels.js";
import { runsOnThisMac } from "./capabilities.js";
import { scriptLangOf } from "./scriptRun.js";
import { extensionOf } from "./editMatchExtraction.js";
import { NodeKind, WorkflowNode, WorkflowEdge, WorkflowDef } from "./workflowModelCore.js";

// ============================================================================
// topo_order (workflow.rs:868-906)
// ============================================================================

/** Rust's `Result<Vec<String>, Vec<String>>` as a value. */
export type TopoOrderResult =
  | { readonly ok: true; readonly order: readonly string[] }
  | { readonly ok: false; readonly cycle: readonly string[] };

export interface WorkflowTopology {
  readonly ids: string[];
  readonly indegrees: Map<string, number>;
  readonly adjacency: Map<string, string[]>;
}

export function addTopologyEdge(
  edge: WorkflowDef["edges"][number],
  ids: ReadonlySet<string>,
  indegrees: Map<string, number>,
  adjacency: Map<string, string[]>
): void {
  if (!ids.has(edge.from) || !ids.has(edge.to)) return;
  const children = adjacency.get(edge.from) ?? [];
  children.push(edge.to);
  adjacency.set(edge.from, children);
  indegrees.set(edge.to, (indegrees.get(edge.to) ?? 0) + 1);
}

export function workflowTopology(def: WorkflowDef): WorkflowTopology {
  const ids = def.nodes.map((node) => node.id);
  const idset = new Set(ids);
  const indegrees = new Map<string, number>(ids.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>();
  for (const edge of def.edges) {
    addTopologyEdge(edge, idset, indegrees, adjacency);
  }
  return { ids, indegrees, adjacency };
}

export function appendReadyChildren(
  children: readonly string[],
  indegrees: Map<string, number>,
  ready: string[]
): void {
  for (const child of children) {
    const degree = (indegrees.get(child) ?? 0) - 1;
    indegrees.set(child, degree);
    if (degree === 0) ready.push(child);
  }
}

export function topologicalOrder(topology: WorkflowTopology): string[] {
  const order: string[] = [];
  const ready = topology.ids.filter((id) => topology.indegrees.get(id) === 0);
  while (ready.length > 0) {
    const node = ready.shift() as string;
    order.push(node);
    const children = topology.adjacency.get(node);
    if (children !== undefined) {
      appendReadyChildren(children, topology.indegrees, ready);
    }
  }
  return order;
}

export function cycleNodeIds(indegrees: ReadonlyMap<string, number>): string[] {
  const cycle: string[] = [];
  for (const [id, degree] of indegrees) {
    if (degree > 0) cycle.push(id);
  }
  return cycle;
}

/**
 * Kahn topo sort over node ids; the `cycle` arm names the nodes still stuck.
 * Ported from `topo_order`.
 *
 * THE TIE-BREAK, EXACTLY. `ready` starts as the nodes' DECLARED array order,
 * filtered to in-degree 0 — so among nodes with nothing upstream, declaration
 * order wins. From there it is a plain FIFO QUEUE: Rust reads
 * `ready.first()` and then `ready.remove(0)` (dequeue the FRONT), and appends a
 * newly-unblocked node to the BACK with `ready.push(m)`, in the order ITS
 * PARENT'S EDGES were declared (`adj`'s child list follows `def.edges`, not
 * `def.nodes`). Two reimplementations that pass a one-layer test and are still
 * wrong: a STACK (`pop()`/`push()`) reverses same-wave siblings, and a
 * re-sorted/priority `ready` pulls a later wave's node ahead of an earlier
 * wave's. Step numbering is user-visible and must reproduce identically.
 */
export function topoOrder(def: WorkflowDef): TopoOrderResult {
  const topology = workflowTopology(def);
  const order = topologicalOrder(topology);

  if (order.length === topology.ids.length) {
    return { ok: true, order };
  }
  // Rust reads this list off `indeg` — `indeg.iter().filter(|(_, &d)| d > 0)` —
  // NOT off `ids`, and the difference is visible: `indeg` is a `HashMap` keyed
  // by node id, so a DUPLICATED id (its own reported error, but validation
  // still runs the topo check afterwards) collapses to ONE key and is named
  // ONCE. Filtering `ids` instead re-names it per declaration, so
  // `nodes:[x,x] + x→x` printed "cycle through: x → x" where Rust prints
  // "cycle through: x" (verified against rustc). Iterating this `Map` is the
  // same collapse, and its insertion order additionally pins the DECLARED
  // order Rust's `HashMap` leaves unspecified.
  return { ok: false, cycle: cycleNodeIds(topology.indegrees) };
}
