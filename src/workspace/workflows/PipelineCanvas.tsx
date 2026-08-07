import { useId, useMemo } from "react";
import type { WorkflowDef, WorkflowNodeEvent } from "../../api";
import { kindLabel, nodeTitle } from "./kinds";

const NODE_W = 150;
/** Tall enough for the three lines a block actually holds — the kind, up to two
 * lines of label, and the live status word. It was 62, which fits one line of
 * label and nothing else: a two-line step name spilled out of its own block and
 * over the row beneath it. Every other measurement below is derived, so this is
 * the only number that had to move; the matching line-heights are pinned in
 * workflows.css and the two have to be changed together. */
const NODE_H = 82;
const GAP_X = 70;
const GAP_Y = 26;
const PAD = 24;
/** The drawn "+" affordances. 24px is the floor for anything clickable, and
 * halving it is how a button gets centred on the edge it hangs off. */
const ADD_SIZE = 24;

type NodeStatus = Record<string, WorkflowNodeEvent>;

type Props = {
  def: WorkflowDef;
  status?: NodeStatus; // live per-node status during a run
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onAddAfter?: (id: string | null) => void; // null = add a first/tail node
  onAddBranch?: (id: string) => void; // add a PARALLEL sibling child (fan-out)
  editable?: boolean;
};

/** Longest-path layering from roots over the topo order → a mostly-linear
 * left-to-right layout. Deterministic; positions are always computed (free-form
 * drag is v2). */
function layout(def: WorkflowDef) {
  const nodes = def.nodes;
  const idIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>();
  for (const e of def.edges) {
    if (!idIndex.has(e.from) || !idIndex.has(e.to)) continue;
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  // Kahn topo, tracking layer as the longest path from a root.
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  const ready = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const q = [...ready];
  const seen = new Set<string>();
  while (q.length) {
    const id = q.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const to of adj.get(id) ?? []) {
      layer.set(to, Math.max(layer.get(to) ?? 0, (layer.get(id) ?? 0) + 1));
      const d = (indeg.get(to) ?? 0) - 1;
      indeg.set(to, d);
      if (d <= 0) q.push(to);
    }
  }
  // Any node left in a cycle (never reached) just stacks after the max layer.
  const maxLayer = Math.max(0, ...[...layer.values()]);
  for (const n of nodes) if (!seen.has(n.id)) layer.set(n.id, maxLayer + 1);

  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    byLayer.set(l, [...(byLayer.get(l) ?? []), n.id]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, ids] of byLayer) {
    ids.forEach((id, row) => {
      pos.set(id, {
        x: PAD + l * (NODE_W + GAP_X),
        y: PAD + row * (NODE_H + GAP_Y),
      });
    });
  }
  const cols = Math.max(1, ...[...byLayer.keys()].map((l) => l + 1));
  const rows = Math.max(1, ...[...byLayer.values()].map((v) => v.length));
  return {
    pos,
    width: PAD * 2 + cols * NODE_W + (cols - 1) * GAP_X,
    height: PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y,
  };
}

export function PipelineCanvas({
  def,
  status,
  selectedId,
  onSelect,
  onAddAfter,
  onAddBranch,
  editable,
}: Props) {
  const { pos, width, height } = useMemo(() => layout(def), [def]);
  // A marker can only be referenced by id, and two canvases mounted at once
  // would otherwise share one. Colons are legal in an id but awkward inside a
  // url() fragment, so they come out.
  const uid = useId().replace(/:/g, "");
  const arrowId = `wf-pipe-arrow-${uid}`;
  const arrowLiveId = `wf-pipe-arrow-live-${uid}`;

  return (
    <div className="pipeline-wrap">
      <div className="pipeline-canvas" style={{ width, height }}>
        {/* Deliberately NOT aria-hidden: the branch labels drawn on the edges
            ("then", "else", a route's own outcome names) are the only place a
            reader is told which way a condition went, and hiding the whole
            drawing to hide its arrowheads would take those with it. */}
        <svg className="pipeline-edges" width={width} height={height}>
          {/* The pipeline connector's head: two barbs, open and round-capped,
              so it reads as a pen stroke rather than a filled UI triangle. It
              is stroked in CSS (one marker per edge state) because a marker
              does not inherit the referencing path's colour, and the
              `context-stroke` keyword that would fix that is younger than the
              WebKit builds this app ships against. userSpaceOnUse keeps the
              head 7px whatever the line weight is. */}
          <defs>
            <marker
              id={arrowId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path className="pipeline-arrow" d="M2.4 1.3 9 5 2.2 8.7" />
            </marker>
            <marker
              id={arrowLiveId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path className="pipeline-arrow live" d="M2.4 1.3 9 5 2.2 8.7" />
            </marker>
          </defs>
          {def.edges.map((e, i) => {
            const from = pos.get(e.from);
            const to = pos.get(e.to);
            if (!from || !to) return null;
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            const live = status?.[e.from]?.status === "done";
            return (
              <g key={i}>
                <path
                  className={`pipeline-edge${live ? " live" : ""}`}
                  markerEnd={`url(#${live ? arrowLiveId : arrowId})`}
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                />
                {e.branch && (
                  <text className="pipeline-edge-branch" x={mx} y={(y1 + y2) / 2 - 5} textAnchor="middle">
                    {e.branch}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {def.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const st = status?.[n.id]?.status;
          const cls = ["pipeline-node", st ?? "", selectedId === n.id ? "selected" : ""]
            .filter(Boolean)
            .join(" ");
          const kindText = kindLabel(n.kind);
          return (
            <div
              key={n.id}
              className={cls}
              style={{ left: p.x, top: p.y, height: NODE_H }}
              role="button"
              tabIndex={0}
              aria-pressed={selectedId === n.id}
              aria-label={`${kindText} step: ${nodeTitle(n)}${st ? `, ${st}` : ""}`}
              onClick={() => onSelect?.(n.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect?.(n.id);
                }
              }}
              title={status?.[n.id]?.peek ?? undefined}
            >
              <div className="pipeline-node-kind">{kindText}</div>
              <div className="pipeline-node-label">{nodeTitle(n)}</div>
              {st && <div className="pipeline-node-status">{st}</div>}
            </div>
          );
        })}
        {editable &&
          def.nodes.map((n) => {
            const p = pos.get(n.id)!;
            return (
              <span key={`add-${n.id}`}>
                <button
                  className="pipeline-add"
                  title="Add a step after this one"
                  aria-label="Add a step after this one"
                  style={{
                    left: p.x + NODE_W - ADD_SIZE / 2,
                    top: p.y + NODE_H / 2 - ADD_SIZE / 2,
                    zIndex: 3,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddAfter?.(n.id);
                  }}
                >
                  +
                </button>
                {onAddBranch && (
                  <button
                    className="pipeline-add pipeline-branch"
                    title="Add a parallel branch from this step"
                    aria-label="Add a parallel branch from this step"
                    style={{
                      left: p.x + NODE_W - ADD_SIZE / 2,
                      top: p.y + NODE_H - ADD_SIZE / 2,
                      zIndex: 3,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddBranch(n.id);
                    }}
                  >
                    ⑂
                  </button>
                )}
              </span>
            );
          })}
        {editable && def.nodes.length === 0 && (
          <button
            className="pipeline-add"
            title="Add a step"
            aria-label="Add a step"
            style={{ left: PAD, top: PAD + NODE_H / 2 - ADD_SIZE / 2 }}
            onClick={() => onAddAfter?.(null)}
          >
            +
          </button>
        )}
      </div>
    </div>
  );
}
