import { useRef, useState } from "react";
import type { View, Tip, SimNode, SimEdge } from "./types";
import { clamp, computeFit } from "./layout";
import { MIN_SCALE, MAX_SCALE } from "./constants";

interface PanZoomParams {
  sizeRef: React.MutableRefObject<{ w: number; h: number }>;
  userAdjustedRef: React.MutableRefObject<boolean>;
  layoutRef: React.MutableRefObject<{ nodes: SimNode[]; edges: SimEdge[] } | null>;
  setFocus: (id: string | null) => void;
  setTip: (t: Tip | null) => void;
}

export interface PanZoomApi {
  view: View;
  setView: React.Dispatch<React.SetStateAction<View>>;
  svgRef: React.RefObject<SVGSVGElement | null>;
  svgPoint: (clientX: number, clientY: number) => { x: number; y: number };
  onWheel: (e: React.WheelEvent) => void;
  zoomBy: (factor: number) => void;
  resetView: () => void;
  onBgDown: (e: React.PointerEvent) => void;
  onBgMove: (e: React.PointerEvent) => void;
  onBgUp: (e: React.PointerEvent) => void;
}

/* Pan / zoom in screen space (viewBox is 1:1 with client px). Owns the view
 * transform + the drag refs; reads the shell's shared size/userAdjusted/layout
 * refs so wheel/zoom/reset stay in sync with the settle loop, and threads the
 * shell's setFocus/setTip so a click-drag on empty canvas can deselect. */
export function usePanZoom({
  sizeRef,
  userAdjustedRef,
  layoutRef,
  setFocus,
  setTip,
}: PanZoomParams): PanZoomApi {
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);

  function svgPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const p = svgPoint(e.clientX, e.clientY);
    userAdjustedRef.current = true;
    setView((v) => {
      const nk = clamp(v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12), MIN_SCALE, MAX_SCALE);
      // keep the world point under the cursor fixed
      const wx = (p.x - v.x) / v.k;
      const wy = (p.y - v.y) / v.k;
      return { k: nk, x: p.x - wx * nk, y: p.y - wy * nk };
    });
  }
  function zoomBy(factor: number) {
    userAdjustedRef.current = true;
    setView((v) => {
      const nk = clamp(v.k * factor, MIN_SCALE, MAX_SCALE);
      const cx = sizeRef.current.w / 2;
      const cy = sizeRef.current.h / 2;
      const wx = (cx - v.x) / v.k;
      const wy = (cy - v.y) / v.k;
      return { k: nk, x: cx - wx * nk, y: cy - wy * nk };
    });
  }
  function resetView() {
    userAdjustedRef.current = false;
    setFocus(null);
    const l = layoutRef.current;
    if (l) setView(computeFit(l.nodes, sizeRef.current.w, sizeRef.current.h));
  }

  function onBgDown(e: React.PointerEvent) {
    if (e.target !== e.currentTarget) return; // only the backdrop pans
    panRef.current = { x: e.clientX, y: e.clientY };
    movedRef.current = false;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setTip(null);
  }
  function onBgMove(e: React.PointerEvent) {
    const start = panRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!movedRef.current && Math.hypot(dx, dy) > 3) movedRef.current = true;
    panRef.current = { x: e.clientX, y: e.clientY };
    userAdjustedRef.current = true;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  }
  function onBgUp(e: React.PointerEvent) {
    const wasPanning = panRef.current != null;
    panRef.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    // A click on empty canvas (no drag) deselects.
    if (wasPanning && !movedRef.current) setFocus(null);
  }

  return {
    view,
    setView,
    svgRef,
    svgPoint,
    onWheel,
    zoomBy,
    resetView,
    onBgDown,
    onBgMove,
    onBgUp,
  };
}
