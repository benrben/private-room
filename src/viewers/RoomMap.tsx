import { useMemo, useRef, useState } from "react";
// CONTRACT-NOTE: G3 will add a `GraphIcon` (constellation) to ../icons. Until
// then this import is the only thing tying RoomMap to that file; if it lands
// under a different name, swap it here.
import { GraphIcon } from "../icons";
import "./roomMap.css";
import type { SimNode, SimEdge, Tip, LabelBox, RoomMapProps } from "./roomMap/types";
import {
  EMPTY_TEXT,
  LABEL_MIN_R_PX,
  LABEL_FONT,
  LABEL_CHAR_W,
  LABEL_MAX,
  NAME_MAX,
} from "./roomMap/constants";
import { nodeRadius } from "./roomMap/layout";
import { EDGE_KINDS, EDGE_STYLE, styleFor, edgeRank, type EdgeFilter } from "./roomMap/edges";
import { useRoomGraph } from "./roomMap/useRoomGraph";
import { usePanZoom } from "./roomMap/usePanZoom";
import Edge from "./roomMap/Edge";
import NodeStar from "./roomMap/NodeStar";
import Label from "./roomMap/Label";
import Tooltip from "./roomMap/Tooltip";

// Re-export the graph types so external imports from this path keep resolving.
export type { GraphNode, GraphEdge, RoomGraph, RoomMapProps } from "./roomMap/types";

/* ------------------------------------------------------------------ *
 * Room map — the constellation view.
 *
 * Reads room_graph() (mean-embedding similarity between files) and lays the
 * files out as violet stars on the ink canvas, drawing a faint line between
 * files the model found related. Hovering a line explains *why* they're
 * linked (the edge's `shared` reasons); clicking a star opens that file.
 *
 * This is a FULL-CANVAS view: the root fills 100%/100% of whatever container
 * hosts it (A2 renders it in the center pane). We measure the stage with a
 * ResizeObserver and lay the graph out to the actual pixel size, then support
 *   • wheel / trackpad zoom toward the cursor,
 *   • click-drag pan on empty canvas,
 *   • persistent labels (selected node + neighbours + the larger stars, more
 *     of them as you zoom in) so you don't have to hover to read the room,
 *   • a "reset view" affordance to re-fit if pan/zoom gets lost.
 *
 * No layout library is bundled (checked package.json — no d3-force), so the
 * spring layout below is a small hand-rolled Fruchterman-Reingold: cheap,
 * deterministic (no Math.random), and capped so a few hundred nodes still
 * settle smoothly.
 *
 * The stateful machinery lives in two hooks under ./roomMap:
 *   • useRoomGraph — the room_graph() fetch, the measure/re-fit observer, the
 *     settle loop, and the derived graph data (capped edges, degree, …).
 *   • usePanZoom   — the view transform + wheel/zoom/pan/reset handlers.
 * This shell owns the shared refs, threads the hooks together (pan-zoom's
 * setView re-frames the graph; the graph's setFocus resets selection), and
 * renders.
 * ------------------------------------------------------------------ */

export default function RoomMap({ onOpenFile }: RoomMapProps) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  // A canvas of stars is unreachable without a mouse; the same connections are
  // also offered as a plain, tabbable list.
  const [listView, setListView] = useState(false);
  // Sticky selection: survives mouse-leave so its label + neighbour labels
  // persist without needing hover. Cleared by clicking empty canvas / reset.
  const [focus, setFocus] = useState<string | null>(null);
  // Density control. A typed graph without a filter is still a hairball, so the
  // reader can switch a kind off and raise the strength bar. Nothing starts
  // hidden: in a room with no web saves and no full passes the fact types are
  // all empty, and defaulting the one inferred kind OFF would open the map as a
  // field of unconnected dots — which reads as broken, not as honest.
  const [hidden, setHidden] = useState<string[]>([]);
  const [minWeight, setMinWeight] = useState(0);
  const filter = useMemo<EdgeFilter>(() => ({ hidden, minWeight }), [hidden, minWeight]);
  // Open by default: six kinds of line are only readable with a key on screen,
  // and the key IS the control.
  const [showLegend, setShowLegend] = useState(true);

  const stageRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  // True once the user pans/zooms, so the settle loop and resize handler stop
  // stealing the view back to the auto-fit. Cleared on reset / new graph.
  const userAdjustedRef = useRef(false);
  // Live layout — mutated in place by the animation loop; render reads it.
  const layoutRef = useRef<{ nodes: SimNode[]; edges: SimEdge[] } | null>(null);

  // Pan / zoom in screen space. Owns `view` + drag refs; deselects on
  // empty-canvas click and clears the tooltip on drag start.
  const { view, setView, svgRef, onWheel, zoomBy, resetView, onBgDown, onBgMove, onBgUp } =
    usePanZoom({ sizeRef, userAdjustedRef, layoutRef, setFocus, setTip });

  // The graph fetch + layout. Threads pan-zoom's setView (re-frame on
  // measure/settle) and selection's setFocus (reset on a fresh graph).
  const {
    graph,
    status,
    error,
    reload,
    size,
    cappedEdges,
    visibleEdges,
    edgeCounts,
    fileNodeCount,
    atFileLimit,
    degree,
    adjacency,
    topNode,
    nonce,
  } = useRoomGraph({ filter, stageRef, sizeRef, userAdjustedRef, layoutRef, setView, setFocus });

  const focusId = focus ?? topNode;
  const focusNeighbors = focusId ? adjacency.get(focusId) ?? null : null;

  function showTip(e: React.MouseEvent, title: string, lines: string[]) {
    const rect = stageRef.current?.getBoundingClientRect();
    setTip({
      left: e.clientX - (rect?.left ?? 0) + 14,
      top: e.clientY - (rect?.top ?? 0) + 14,
      title,
      lines,
    });
  }

  // ---------------- derived render data ----------------
  const layout = layoutRef.current;
  const showEmpty = graph != null && fileNodeCount < 2;
  const hasStage = size.w > 0 && size.h > 0;

  // Persistent, de-cluttered labels (computed in screen space each frame).
  const labels = useMemo<LabelBox[]>(() => {
    if (!layout || !hasStage) return [];
    interface Cand {
      n: SimNode;
      sx: number;
      sy: number;
      rScreen: number;
      prio: number;
      deg: number;
    }
    const cands: Cand[] = [];
    for (const n of layout.nodes) {
      const sx = n.x * view.k + view.x;
      const sy = n.y * view.k + view.y;
      if (sx < -60 || sx > size.w + 60 || sy < -30 || sy > size.h + 30) continue; // offscreen
      const deg = degree.get(n.id) ?? 0;
      const rScreen = nodeRadius(deg) * view.k;
      let prio = 0;
      if (n.id === focusId) prio = 3;
      else if (focusNeighbors?.has(n.id)) prio = 2;
      else if (rScreen >= LABEL_MIN_R_PX) prio = 1; // more of these appear as you zoom in
      if (prio === 0) continue;
      cands.push({ n, sx, sy, rScreen, prio, deg });
    }
    cands.sort((a, b) => b.prio - a.prio || b.deg - a.deg);

    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const out: LabelBox[] = [];
    for (const c of cands) {
      if (out.length >= LABEL_MAX) break;
      const name = c.n.name.length > NAME_MAX ? c.n.name.slice(0, NAME_MAX - 1) + "…" : c.n.name;
      const tw = name.length * LABEL_CHAR_W + 12;
      const th = 17;
      const off = Math.max(c.rScreen, 3) + 6;
      // Prefer the right of the star; flip left if it would fall off-canvas.
      let boxX = c.sx + off;
      if (boxX + tw > size.w - 4) boxX = c.sx - off - tw;
      if (boxX < 4) boxX = 4;
      const boxY = c.sy - th / 2;
      const box = { x: boxX, y: boxY, w: tw, h: th };
      const overlaps = placed.some(
        (p) => !(box.x > p.x + p.w || box.x + box.w < p.x || box.y > p.y + p.h || box.y + box.h < p.y),
      );
      // Always keep the selection + its neighbours; skip crowded zoom-labels.
      if (overlaps && c.prio < 2) continue;
      placed.push(box);
      out.push({
        id: c.n.id,
        name,
        textX: boxX + 6,
        textY: c.sy + LABEL_FONT * 0.35,
        boxX,
        boxY,
        boxW: tw,
        boxH: th,
        prio: c.prio,
        kind: c.n.kind,
      });
    }
    return out;
    // `nonce` forces a recompute each settle frame (layout mutates via ref).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, size, hasStage, focusId, focusNeighbors, degree, nonce]);

  // The same graph as plain text: every file, its folder and what it links to.
  // The canvas is mouse-only by nature, so this is the keyboard / screen-reader
  // route to the exact same information.
  // The same graph as plain text, links GROUPED BY KIND — now that a line can
  // mean six different things, a list that only said "linked to X" would be
  // strictly less informative than the canvas it stands in for.
  const listRows = useMemo(() => {
    const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
    const perNode = new Map<string, Map<string, string[]>>();
    const note = (from: string, to: string, kind: string) => {
      const kinds = perNode.get(from) ?? new Map<string, string[]>();
      perNode.set(from, kinds);
      const names = kinds.get(kind) ?? [];
      kinds.set(kind, names);
      names.push(byId.get(to)?.name ?? to);
    };
    for (const e of visibleEdges) {
      note(e.a, e.b, e.kind);
      note(e.b, e.a, e.kind);
    }
    return (graph?.nodes ?? [])
      .filter((n) => n.kind === "file")
      .map((n) => {
        const kinds = perNode.get(n.id) ?? new Map<string, string[]>();
        const groups = [...kinds.entries()]
          .sort((x, y) => edgeRank(x[0]) - edgeRank(y[0]))
          .map(([kind, names]) => ({
            kind,
            label: styleFor(kind).label,
            names: [...names].sort((a, b) => a.localeCompare(b)),
          }));
        return {
          id: n.id,
          name: n.name,
          folder: n.folder || "Top level",
          groups,
          total: groups.reduce((sum, g) => sum + g.names.length, 0),
        };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }, [graph, visibleEdges]);

  return (
    <div className="room-map" style={{ position: "relative", width: "100%", height: "100%" }}>
      <div className="room-map-toolbar">
        <GraphIcon size={16} />
        <span className="room-map-title">Room map</span>
        {graph && !showEmpty && (
          <span
            className="room-map-count"
            title={
              // Being AT the ceiling doesn't prove anything was left out — a
              // room of exactly this many files is mapped in full — so say what
              // is true either way rather than accusing the room of hiding
              // files it may not have.
              atFileLimit
                ? `This map covers the ${fileNodeCount} newest files in the room; if there are more than that, the older ones aren't on it.`
                : undefined
            }
          >
            · {atFileLimit ? "newest " : ""}
            {fileNodeCount} file{fileNodeCount === 1 ? "" : "s"} · {visibleEdges.length} link
            {visibleEdges.length === 1 ? "" : "s"}
            {/* Say what is being withheld. A count that silently shrank when a
                kind was switched off would read as links disappearing. */}
            {cappedEdges.length > visibleEdges.length &&
              ` (${cappedEdges.length - visibleEdges.length} hidden)`}
          </span>
        )}
        {graph && !showEmpty && (
          <button
            type="button"
            className="subtle rm-listtoggle"
            aria-pressed={showLegend}
            title="Choose which kinds of link the map shows"
            onClick={() => setShowLegend((v) => !v)}
          >
            Links
          </button>
        )}
        {graph && !showEmpty && (
          <button
            type="button"
            className="subtle rm-toolbtn"
            aria-pressed={listView}
            title="Show the same files and connections as a plain, keyboard-reachable list"
            onClick={() => setListView((v) => !v)}
          >
            {listView ? "Map" : "List"}
          </button>
        )}
      </div>

      {/* Density control. Not `.room-map-legend` — that class carries
          `pointer-events: none`, so its toggles would be unclickable. */}
      {graph && !showEmpty && showLegend && (
        <div className="rm-legend" role="group" aria-label="Link kinds">
          {EDGE_KINDS.map((kind) => {
            const style = EDGE_STYLE[kind];
            const count = edgeCounts[kind] ?? 0;
            const on = !hidden.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                className="rm-legend-item"
                aria-pressed={on}
                disabled={count === 0}
                title={
                  count === 0
                    ? `Nothing in this room is linked this way — ${style.lead.toLowerCase()}`
                    : style.lead
                }
                onClick={() =>
                  setHidden((cur) =>
                    cur.includes(kind) ? cur.filter((k) => k !== kind) : [...cur, kind],
                  )
                }
              >
                <svg width="18" height="8" aria-hidden="true">
                  {/* `stroke` via `style`, not the presentation attribute: the
                      value is a var() custom property, and a presentation
                      attribute is the weakest thing in the cascade — the same
                      trap that made every edge on the map render as one violet
                      hairline. An inline declaration cannot be outranked. */}
                  <line
                    x1="1"
                    y1="4"
                    x2="17"
                    y2="4"
                    style={{ stroke: style.color, strokeWidth: 1.6 * style.widthMul }}
                    strokeDasharray={style.dash ?? undefined}
                  />
                </svg>
                {style.label}
                <span className="rm-legend-count">{count}</span>
              </button>
            );
          })}
          <label className="rm-legend-strength">
            Strength
            <input
              type="range"
              min={0}
              max={0.9}
              step={0.1}
              value={minWeight}
              onChange={(e) => setMinWeight(Number(e.target.value))}
              title="Hide the weakest links"
            />
            <span className="rm-legend-count">{Math.round(minWeight * 100)}%</span>
          </label>
        </div>
      )}

      <div className="room-map-stage" ref={stageRef}>
        {status && <div className="viewer-status">{status}</div>}
        {/* A raw exception where the status line goes leaves the reader stuck;
            say what happened in plain words and offer the retry. */}
        {error && (
          <div className="room-map-error" role="alert">
            <p>
              The room map couldn’t be built. Nothing in the room was changed —
              this is only the map.
            </p>
            <p className="room-map-error-detail">{error}</p>
            <button type="button" className="subtle" onClick={reload}>
              Try again
            </button>
          </div>
        )}

        {error ? null : showEmpty ? (
          <div className="room-map-empty">{EMPTY_TEXT}</div>
        ) : listView ? (
          <div className="room-map-list">
            <ul>
              {listRows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className="rm-list-name"
                    onClick={() => onOpenFile?.(row.id)}
                    disabled={!onOpenFile}
                  >
                    {row.name}
                  </button>
                  <span className="rm-list-folder">{row.folder}</span>
                  <div className="rm-list-links">
                    {row.groups.length === 0 ? (
                      "No connections found"
                    ) : (
                      <ul className="rm-list-kinds">
                        {row.groups.map((g) => (
                          <li key={g.kind}>
                            <span className="rm-list-kind">{g.label}:</span>{" "}
                            {g.names.join(", ")}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          hasStage && (
            <svg
              ref={svgRef}
              className="room-map-svg"
              width={size.w}
              height={size.h}
              viewBox={`0 0 ${size.w} ${size.h}`}
              onWheel={onWheel}
            >
              {/* Arrowheads for the directed kinds. `userSpaceOnUse` means the
                  marker is measured in the zoomed group's world units, so the
                  size has to be divided by the scale or the heads balloon as
                  you zoom out. */}
              <defs>
                {EDGE_KINDS.filter((k) => EDGE_STYLE[k].directed).map((k) => (
                  <marker
                    key={k}
                    id={`rm-arrow-${k}`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth={7 / view.k}
                    markerHeight={7 / view.k}
                    markerUnits="userSpaceOnUse"
                    orient="auto"
                  >
                    <path d="M0,1 L10,5 L0,9 z" style={{ fill: EDGE_STYLE[k].color }} />
                  </marker>
                ))}
              </defs>

              {/* Backdrop: the only surface that pans / deselects. */}
              <rect
                x={0}
                y={0}
                width={size.w}
                height={size.h}
                fill="transparent"
                onPointerDown={onBgDown}
                onPointerMove={onBgMove}
                onPointerUp={onBgUp}
                onPointerCancel={onBgUp}
              />

              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                {/* edges first, under the stars */}
                {layout &&
                  layout.edges.map((se, i) =>
                    // A filtered-out link is not drawn AND does not pull on the
                    // layout (runTick skips it) — but it stays in the array, so
                    // switching a kind back on is a repaint, not a re-seed.
                    se.hidden ? null : (
                      <Edge
                        key={`e${i}`}
                        se={se}
                        a={layout.nodes[se.ai]}
                        b={layout.nodes[se.bi]}
                        view={view}
                        hovered={hovered}
                        focusId={focusId}
                        degree={degree}
                        showTip={showTip}
                        setTip={setTip}
                      />
                    ),
                  )}

                {/* nodes on top */}
                {layout &&
                  layout.nodes.map((n) => (
                    <NodeStar
                      key={n.id}
                      n={n}
                      degree={degree}
                      hovered={hovered}
                      focusId={focusId}
                      focusNeighbors={focusNeighbors}
                      view={view}
                      onOpenFile={onOpenFile}
                      setHovered={setHovered}
                      setFocus={setFocus}
                      showTip={showTip}
                      setTip={setTip}
                    />
                  ))}
              </g>

              {/* Persistent labels — drawn in screen space so they stay a
                  constant, readable size at any zoom, over an ink-safe pill. */}
              <g className="room-map-labels" pointerEvents="none">
                {labels.map((l) => (
                  <Label key={`l${l.id}`} l={l} />
                ))}
              </g>
            </svg>
          )
        )}

        {/* Reset / zoom affordances — pan+zoom can wander, so offer a re-fit. */}
        {!showEmpty && !listView && !error && hasStage && (
          <div className="rm-controls">
            <button
              type="button"
              className="rm-btn"
              title="Zoom in"
              aria-label="Zoom in"
              onClick={() => zoomBy(1.25)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className="rm-btn"
              title="Zoom out"
              aria-label="Zoom out"
              onClick={() => zoomBy(1 / 1.25)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className="rm-btn rm-btn-reset"
              title="Reset view (fit to screen)"
              aria-label="Reset view"
              onClick={resetView}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}

        {tip && <Tooltip tip={tip} />}
      </div>
    </div>
  );
}
