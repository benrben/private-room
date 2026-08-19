import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, roomGraph } from "../../api";
import type { RoomGraph, GraphEdge, SimNode, SimEdge, View } from "./types";
import { AREA_PER_NODE, COOL, GRAPH_MAX_FILES } from "./constants";
import { seedFrom, mulberry32, runTick, computeFit } from "./layout";
import { rankEdges, filterEdges, countByKind, type EdgeFilter } from "./edges";

interface RoomGraphParams {
  filter: EdgeFilter;
  stageRef: React.RefObject<HTMLDivElement | null>;
  sizeRef: React.MutableRefObject<{ w: number; h: number }>;
  userAdjustedRef: React.MutableRefObject<boolean>;
  layoutRef: React.MutableRefObject<{ nodes: SimNode[]; edges: SimEdge[] } | null>;
  setView: (v: View) => void;
  setFocus: React.Dispatch<React.SetStateAction<string | null>>;
}

export interface RoomGraphApi {
  graph: RoomGraph | null;
  status: string;
  /** Set when the map couldn't be built — the raw reason, for the details
   * line under a plain-English message + Retry. */
  error: string | null;
  reload: () => void;
  size: { w: number; h: number };
  /** Every drawable edge, ranked and capped — the LAYOUT's input. Deliberately
   * independent of the type filter so a legend toggle can't re-seed the map. */
  cappedEdges: GraphEdge[];
  /** The subset the reader asked to see — what is drawn and counted. */
  visibleEdges: GraphEdge[];
  /** How many edges of each kind exist before filtering, for the legend. */
  edgeCounts: Record<string, number>;
  fileNodeCount: number;
  /** True when the map is AT the backend's newest-N-files ceiling. It is NOT
   * proof that anything was left out: the payload can't tell a room of exactly
   * N from a room of a thousand, so the header must only claim what this
   * means — the map covers the newest N — and never that older files exist. */
  atFileLimit: boolean;
  degree: Map<string, number>;
  adjacency: Map<string, Set<string>>;
  topNode: string | null;
  nonce: number;
}

/** Everything about a fetched graph that the map actually draws. A file write
 * anywhere in the room re-fetches; if this is unchanged there is nothing to
 * redraw, and re-seeding the layout would throw away the reader's pan, zoom
 * and selection for no reason. */
function graphSignature(g: RoomGraph): string {
  return JSON.stringify([
    g.nodes.map((n) => [n.id, n.name, n.kind, n.folder ?? "", n.summary ?? ""]),
    // `kind` is part of the signature: a rebuild that only retyped an edge
    // (a full pass finishing turns a "reads alike" guess into a "made from"
    // fact) changes what the map SAYS, so it has to redraw.
    g.edges.map((e) => [e.a, e.b, e.weight, e.kind, e.directed, e.shared]),
  ]);
}

/** Room-file bursts (an import, an agent writing a dozen files) fire many
 * change events in a row — coalesce them into one fetch. */
const RELOAD_DEBOUNCE_MS = 400;

/* The room_graph() fetch, the stage-measure/re-fit ResizeObserver, and the
 * spring-layout settle loop — plus the derived graph data (capped edges,
 * degree, adjacency, hub node). The shell owns the shared refs (size /
 * userAdjusted / layout) and threads pan-zoom's setView + selection's setFocus
 * in, so this hook can re-frame and reset selection on graph/measure changes. */
export function useRoomGraph({
  filter,
  stageRef,
  sizeRef,
  userAdjustedRef,
  layoutRef,
  setView,
  setFocus,
}: RoomGraphParams): RoomGraphApi {
  const [graph, setGraph] = useState<RoomGraph | null>(null);
  const [status, setStatus] = useState("Mapping the room…");
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [nonce, bump] = useState(0);
  const rerender = () => bump((v) => v + 1);
  /** Signature of the graph currently on screen — a re-fetch that matches it
   * is dropped, so an unrelated file write can't reset the view. */
  const sigRef = useRef<string | null>(null);
  /** The live filter, readable from the layout effect without becoming one of
   * its dependencies (see the simEdges build below). */
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = useCallback(() => {
    setError(null);
    setStatus("Mapping the room…");
    setReloadNonce((n) => n + 1);
  }, []);

  // ---- fetch the graph on mount, and whenever the room's files change ----
  useEffect(() => {
    // PER-RUN, deliberately not a ref: the effect re-runs on the Retry button's
    // nonce, and a component-level flag reset to true at the top of each run
    // undoes the previous run's cleanup — a debounced fetch still in flight
    // would then land (or re-raise its error) on top of the retry's result.
    let alive = true;
    let timer = 0;
    const load = () => {
      roomGraph()
        .then((g) => {
          if (!alive) return;
          setStatus("");
          setError(null);
          const sig = graphSignature(g);
          if (sig === sigRef.current) return; // nothing on the map changed
          sigRef.current = sig;
          setGraph(g);
        })
        .catch((e) => {
          if (!alive) return;
          setStatus("");
          setError(String(e));
        });
    };
    load();
    const again = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, RELOAD_DEBOUNCE_MS);
    };
    const unFiles = api.onRoomFilesChanged(again);
    // The map draws memories as stars and links them to the files they came
    // from, so a memory the agent added or forgot changes the picture exactly
    // as a file write does. Without this the star for a memory that no longer
    // exists stayed on the map — still hoverable, still reporting its text —
    // until an unrelated file write happened to re-fetch the graph.
    const unMemories = api.onMemoriesChanged(again);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      unFiles.then((fn) => fn());
      unMemories.then((fn) => fn());
    };
  }, [reloadNonce]);

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

  // Valid edges, ranked by (trust, strength) and capped — the only ones we
  // simulate. The cap only eats inferred links, so a "made from" fact is never
  // dropped to make room for a stronger-looking guess.
  const cappedEdges = useMemo<GraphEdge[]>(
    () => (graph ? rankEdges(graph.edges, new Set(graph.nodes.map((n) => n.id))) : []),
    [graph],
  );

  // What the reader has asked to see. Everything below reads THIS list — what
  // is drawn, the degree that sizes a star, the neighbour highlight, the count
  // line — so the map can never claim a connection it isn't showing.
  const visibleEdges = useMemo(
    () => filterEdges(cappedEdges, filter),
    [cappedEdges, filter],
  );
  const edgeCounts = useMemo(() => countByKind(cappedEdges), [cappedEdges]);

  const fileNodeCount = useMemo(
    () => (graph ? graph.nodes.filter((n) => n.kind === "file").length : 0),
    [graph],
  );

  // ---- (re)build the layout and run the settle animation on graph change ----
  useEffect(() => {
    if (!graph) return;
    // Every node the payload holds is laid out. There is no second cap here:
    // the backend already maps only the newest GRAPH_MAX_FILES files and the
    // same number of memories, so a "if a room is enormous" branch could never
    // run — and if it had, it would have dropped nodes without dropping their
    // edges, leaving the header, the degrees and the neighbour lists counting
    // links to stars that are not on the map.
    const nodes = graph.nodes;
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
    // Read the filter through a ref, NOT as a dependency: this effect re-seeds
    // every node onto the starting circle and restarts the settle animation, so
    // making it depend on the reader's legend toggles would scatter the map on
    // every click.
    const shown = new Set(filterEdges(cappedEdges, filterRef.current));
    const simEdges: SimEdge[] = cappedEdges
      .filter((e) => idx.has(e.a) && idx.has(e.b))
      .map((e) => ({ ai: idx.get(e.a)!, bi: idx.get(e.b)!, edge: e, hidden: !shown.has(e) }));

    layoutRef.current = { nodes: sim, edges: simEdges };
    // Re-frame only when the reader hasn't grabbed the canvas: a graph change
    // is not a reason to throw away their pan/zoom. Likewise the selection
    // survives unless the file it pointed at is gone from the map.
    const present = new Set(sim.map((n) => n.id));
    setFocus((cur) => (cur && present.has(cur) ? cur : null));
    if (!userAdjustedRef.current) {
      setView(computeFit(sim, sizeRef.current.w, sizeRef.current.h));
    }

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

  // Hiding a kind is a REPAINT, not a rebuild: flip the flag on the existing
  // sim edges in place and re-render. Removing them from the array instead
  // would change the layout effect's input and throw the reader's map away.
  useEffect(() => {
    const live = layoutRef.current;
    if (!live) return;
    const shown = new Set(visibleEdges);
    for (const se of live.edges) se.hidden = !shown.has(se.edge);
    rerender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEdges]);

  // Degree per node (from the edges actually SHOWN) → star size + label
  // priority. Reading the visible set is what keeps a hub from staying fat
  // after the links that made it a hub were switched off.
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of visibleEdges) {
      d.set(e.a, (d.get(e.a) ?? 0) + 1);
      d.set(e.b, (d.get(e.b) ?? 0) + 1);
    }
    return d;
  }, [visibleEdges]);

  // Adjacency for neighbour highlighting + neighbour labels.
  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of visibleEdges) {
      (m.get(e.a) ?? m.set(e.a, new Set()).get(e.a)!).add(e.b);
      (m.get(e.b) ?? m.set(e.b, new Set()).get(e.b)!).add(e.a);
    }
    return m;
  }, [visibleEdges]);

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

  return {
    graph,
    status,
    error,
    reload,
    size,
    cappedEdges,
    visibleEdges,
    edgeCounts,
    fileNodeCount,
    atFileLimit: fileNodeCount >= GRAPH_MAX_FILES,
    degree,
    adjacency,
    topNode,
    nonce,
  };
}
