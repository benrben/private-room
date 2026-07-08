import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../../api";
import type { RoomGraph, GraphEdge, SimNode, SimEdge, View } from "./types";
import { MAX_EDGES, MAX_NODES, AREA_PER_NODE, COOL } from "./constants";
import { seedFrom, mulberry32, runTick, computeFit } from "./layout";

interface RoomGraphParams {
  stageRef: React.RefObject<HTMLDivElement | null>;
  sizeRef: React.MutableRefObject<{ w: number; h: number }>;
  userAdjustedRef: React.MutableRefObject<boolean>;
  layoutRef: React.MutableRefObject<{ nodes: SimNode[]; edges: SimEdge[] } | null>;
  setView: (v: View) => void;
  setFocus: (id: string | null) => void;
}

export interface RoomGraphApi {
  graph: RoomGraph | null;
  status: string;
  size: { w: number; h: number };
  cappedEdges: GraphEdge[];
  fileNodeCount: number;
  degree: Map<string, number>;
  adjacency: Map<string, Set<string>>;
  topNode: string | null;
  nonce: number;
}

/* The room_graph() fetch, the stage-measure/re-fit ResizeObserver, and the
 * spring-layout settle loop — plus the derived graph data (capped edges,
 * degree, adjacency, hub node). The shell owns the shared refs (size /
 * userAdjusted / layout) and threads pan-zoom's setView + selection's setFocus
 * in, so this hook can re-frame and reset selection on graph/measure changes. */
export function useRoomGraph({
  stageRef,
  sizeRef,
  userAdjustedRef,
  layoutRef,
  setView,
  setFocus,
}: RoomGraphParams): RoomGraphApi {
  const [graph, setGraph] = useState<RoomGraph | null>(null);
  const [status, setStatus] = useState("Mapping the room…");
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [nonce, bump] = useState(0);
  const rerender = () => bump((v) => v + 1);

  // ---- fetch the graph on mount, and whenever the room's files change ----
  useEffect(() => {
    let alive = true;
    const load = () => {
      // CONTRACT-NOTE: no api.roomGraph() wrapper yet — call the command
      // directly. Fold into api.ts when it lands.
      invoke<RoomGraph>("room_graph")
        .then((g) => {
          if (!alive) return;
          setGraph(g);
          setStatus("");
        })
        .catch((e) => {
          if (!alive) return;
          setStatus(String(e));
        });
    };
    load();
    const un = api.onRoomFilesChanged(load);
    return () => {
      alive = false;
      un.then((fn) => fn());
    };
  }, []);

  // ---- measure the stage; lay out to (and re-fit at) the real pixel size ----
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      const w = Math.max(0, Math.round(cr.width));
      const h = Math.max(0, Math.round(cr.height));
      sizeRef.current = { w, h };
      setSize({ w, h });
      if (!userAdjustedRef.current && layoutRef.current) {
        setView(computeFit(layoutRef.current.nodes, w, h));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Valid, weight-ranked, capped edges — the only ones we draw/simulate.
  const cappedEdges = useMemo<GraphEdge[]>(() => {
    if (!graph) return [];
    const ids = new Set(graph.nodes.map((n) => n.id));
    return graph.edges
      .filter((e) => e.a !== e.b && ids.has(e.a) && ids.has(e.b))
      .sort((x, y) => y.weight - x.weight)
      .slice(0, MAX_EDGES);
  }, [graph]);

  const fileNodeCount = useMemo(
    () => (graph ? graph.nodes.filter((n) => n.kind === "file").length : 0),
    [graph],
  );

  // ---- (re)build the layout and run the settle animation on graph change ----
  useEffect(() => {
    if (!graph) return;
    // Cap to the highest-degree nodes if a room is enormous.
    let nodes = graph.nodes;
    if (nodes.length > MAX_NODES) {
      const deg = new Map<string, number>();
      for (const e of cappedEdges) {
        deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
        deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
      }
      nodes = [...nodes]
        .sort((x, y) => (deg.get(y.id) ?? 0) - (deg.get(x.id) ?? 0))
        .slice(0, MAX_NODES);
    }
    const count = nodes.length;
    if (count === 0) {
      layoutRef.current = null;
      return;
    }

    // Seeded circle layout as the starting point.
    const radius = 40 * Math.sqrt(count);
    const sim: SimNode[] = nodes.map((node, i) => {
      const rnd = mulberry32(seedFrom(node.id));
      const ang = (i / count) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
      const rad = radius * (0.55 + 0.45 * rnd());
      return { ...node, x: Math.cos(ang) * rad, y: Math.sin(ang) * rad };
    });

    const idx = new Map(sim.map((n, i) => [n.id, i]));
    const simEdges: SimEdge[] = cappedEdges
      .filter((e) => idx.has(e.a) && idx.has(e.b))
      .map((e) => ({ ai: idx.get(e.a)!, bi: idx.get(e.b)!, edge: e }));

    layoutRef.current = { nodes: sim, edges: simEdges };
    // Fresh graph → drop any manual pan/zoom and re-frame to fit.
    userAdjustedRef.current = false;
    setFocus(null);
    setView(computeFit(sim, sizeRef.current.w, sizeRef.current.h));

    const k = Math.sqrt(AREA_PER_NODE);
    let temp = k * 2;
    let raf = 0;
    let alive = true;
    const step = () => {
      if (!alive) return;
      runTick(sim, simEdges, temp, k);
      temp *= COOL;
      // Keep the graph framed while it settles, unless the user grabbed it.
      if (!userAdjustedRef.current) {
        setView(computeFit(sim, sizeRef.current.w, sizeRef.current.h));
      }
      rerender();
      if (temp > 0.6) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, cappedEdges]);

  // Degree per node (from rendered edges) → star size + label priority.
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of cappedEdges) {
      d.set(e.a, (d.get(e.a) ?? 0) + 1);
      d.set(e.b, (d.get(e.b) ?? 0) + 1);
    }
    return d;
  }, [cappedEdges]);

  // Adjacency for neighbour highlighting + neighbour labels.
  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of cappedEdges) {
      (m.get(e.a) ?? m.set(e.a, new Set()).get(e.a)!).add(e.b);
      (m.get(e.b) ?? m.set(e.b, new Set()).get(e.b)!).add(e.a);
    }
    return m;
  }, [cappedEdges]);

  // The most-connected file — used as a sensible default "selection" so the
  // room reads (hub + neighbours labelled) before the user touches anything.
  const topNode = useMemo(() => {
    let best: string | null = null;
    let bestD = -1;
    for (const n of graph?.nodes ?? []) {
      if (n.kind !== "file") continue;
      const d = degree.get(n.id) ?? 0;
      if (d > bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  }, [graph, degree]);

  return { graph, status, size, cappedEdges, fileNodeCount, degree, adjacency, topNode, nonce };
}
