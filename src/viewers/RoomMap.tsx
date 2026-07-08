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
  // Sticky selection: survives mouse-leave so its label + neighbour labels
  // persist without needing hover. Cleared by clicking empty canvas / reset.
  const [focus, setFocus] = useState<string | null>(null);

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
  const { graph, status, size, cappedEdges, fileNodeCount, degree, adjacency, topNode, nonce } =
    useRoomGraph({ stageRef, sizeRef, userAdjustedRef, layoutRef, setView, setFocus });

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

  return (
    <div className="room-map" style={{ position: "relative", width: "100%", height: "100%" }}>
      <div className="room-map-toolbar">
        <GraphIcon size={16} />
        <span className="room-map-title">Room map</span>
        {graph && !showEmpty && (
          <span className="room-map-count">
            · {fileNodeCount} file{fileNodeCount === 1 ? "" : "s"} · {cappedEdges.length} link
            {cappedEdges.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="room-map-stage" ref={stageRef}>
        {status && <div className="viewer-status">{status}</div>}

        {showEmpty ? (
          <div className="room-map-empty">{EMPTY_TEXT}</div>
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
                  layout.edges.map((se, i) => {
                    const a = layout.nodes[se.ai];
                    const b = layout.nodes[se.bi];
                    return (
                      <Edge
                        key={`e${i}`}
                        se={se}
                        a={a}
                        b={b}
                        view={view}
                        hovered={hovered}
                        focusId={focusId}
                        showTip={showTip}
                        setTip={setTip}
                      />
                    );
                  })}

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
        {!showEmpty && hasStage && (
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
