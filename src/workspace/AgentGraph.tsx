/** The live agent graph for a chat turn.
 *
 * Arcelle's chat is a hub: `chat.answer` (the Main agent) holds no room tools
 * at all, only `ask_*_agent` delegation tools. Each delegation runs a
 * specialist's own compiled sub-graph and returns nothing but a report. Since
 * delegations in one round run in PARALLEL, the honest picture is a hub with
 * children — several lit at once, each finishing on its own clock — which a
 * flat left-to-right strip cannot draw.
 *
 * Layout is hub-and-spoke: the Main agent roots the left, every dispatched
 * specialist sits in one column to its right, and children dispatched in the
 * same round share a `batch` band. One column (rather than a column per batch)
 * keeps every edge short and non-crossing — all edges originate at the hub,
 * because the hub is what dispatched them, including later batches.
 *
 * Hand-rolled: HTML nodes over an SVG edge layer, no graph library. The nodes
 * are real buttons, so they get focus, hover, ellipsis and the app's tokens for
 * free; only the curves need SVG. Every colour is a token — light and dark both
 * resolve — and no state is signalled by colour alone: each carries its own
 * glyph and outline weight.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentNodeStatus, AskPlanStep, AskActiveAgent } from "../apiTypes";
import { MAIN_KEY, chipClass, toBands, toNodes, type GraphNode } from "./agentNodes";

/** Mirror of the sidecar's `agents.REGISTRY` descriptions (agents.py), for the
 * inspector. Duplicated rather than fetched on purpose: the app is offline-first
 * and this is stable copy, not state — a round trip to render a tooltip would be
 * the wrong trade. Anything missing degrades to the label alone. */
const AGENT_DESCRIPTIONS: Record<string, string> = {
  "chat.answer":
    "The user's single interlocutor: calls specialist agents for anything that needs the room or tools, answers directly what it knows, and composes every final answer itself.",
  "files.read":
    "Read, search, open and edit the room's files — the default specialist.",
  "scripts.run":
    "See and run this room's .py/.js scripts (the user approves each new one).",
  "chat.web": "Find or fetch current information from the internet.",
  "chat.browse":
    "Open and operate a web page in the private browser — navigate, read, click and fill in.",
  "app.ui": "See and operate this app's own interface for the user.",
  "jobs.run":
    "Cover an ENTIRE file with a durable background job; report job status.",
  "jobs.workflows": "Author, test, schedule or run saved multi-step workflows.",
  "skills.use": "Find, read and run Agent Skills.",
  "skills.author":
    "Create, modify or delete Agent Skills (drafts, human-reviewed).",
  "connectors.admin":
    "Inspect or configure MCP connector integrations (drafts only).",
  "connectors.use":
    "Reach the user's connected third-party tools (email, calendar, chat…).",
  "media.transcribe": "Transcribe or re-transcribe audio/video on-device.",
  "media.video":
    "Watch a room video: look at what is on screen at a moment.",
  "creator.studio":
    "Generate flashcards, mind maps or podcast scripts from room content.",
};

const GLYPH: Record<AgentNodeStatus, string> = {
  pending: "○",
  running: "◐",
  done: "✓",
  failed: "⚠",
};
const STATUS_WORD: Record<AgentNodeStatus, string> = {
  pending: "queued",
  running: "running",
  done: "done",
  failed: "failed",
};

function elapsedLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms - m * 60_000) / 1000)}s`;
}

/** Per-node start/end stamps, kept in a ref because they are observations about
 * this render session, not state the backend sends: the protocol says WHAT a
 * node is doing, never for how long. The store can be supplied by the caller so
 * a finished turn's clocks outlive the live bubble that measured them. */
export type AgentTiming = { start: number; end?: number };

/** One hub->child spoke, in canvas pixels. */
interface Edge {
  key: string;
  status: AgentNodeStatus;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dx: number;
  label: string;
  /** Where the edge label sits — just above and left of the child it points
   * at, so labels stack one per row and never collide with a spoke. */
  lx: number;
  ly: number;
}

/** Cheap structural equality, so re-measuring an unchanged layout commits no
 * state. Sub-pixel jitter is rounded away: `getBoundingClientRect` returns
 * fractional values that can flip on a scrollbar appearing, and a 0.01px
 * difference must not count as "the graph moved". */
function sameEdges(a: Edge[], b: Edge[]): boolean {
  if (a.length !== b.length) return false;
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  return a.every((e, i) => {
    const o = b[i];
    return (
      e.key === o.key &&
      e.status === o.status &&
      e.label === o.label &&
      near(e.x1, o.x1) &&
      near(e.y1, o.y1) &&
      near(e.x2, o.x2) &&
      near(e.y2, o.y2)
    );
  });
}

export function AgentGraph({
  plan,
  active,
  agentSteps,
  agentReports,
  steps,
  lane,
  timings: timingStore,
  live = true,
}: {
  plan: AskPlanStep[];
  active: AskActiveAgent | null;
  /** Tool steps filed under the node that ran them. */
  agentSteps: Record<string, { label: string; ok: boolean }[]>;
  /** What each specialist reported back, keyed by node. */
  agentReports?: Record<string, { text: string; ok: boolean }>;
  /** The flat step list — the inspector's fallback for the hub, and the source
   * for steps that arrived with no node attribution. */
  steps: { label: string; ok: boolean }[];
  lane: string;
  /** Where per-node clocks live. Passing one lets the caller keep them after
   * the turn ends; omitted, the graph keeps its own for as long as it exists. */
  timings?: { current: Record<string, AgentTiming> };
  /** False for a finished turn's replay: no clocks are started or stopped and
   * nothing ticks, so a past graph never re-renders the transcript. */
  live?: boolean;
}) {
  const nodes = useMemo(() => toNodes(plan, active, live), [plan, active, live]);
  const main = nodes[nodes.length - 1];
  // Memoised, not sliced inline: this feeds the measuring layout effect's
  // dependencies, and a fresh array identity every render would re-run the
  // measure, which sets state, which renders again — an infinite loop.
  const children = useMemo(() => nodes.slice(0, -1), [nodes]);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const ownTimings = useRef<Record<string, AgentTiming>>({});
  const timings = timingStore ?? ownTimings;
  const [, tick] = useState(0);

  const anyRunning = live && nodes.some((n) => n.status === "running");

  // Stamp transitions into/out of `running`. Done in an effect rather than
  // during render so a re-render for any other reason cannot restart a clock.
  useEffect(() => {
    if (!live) return;
    const now = performance.now();
    for (const node of nodes) {
      const t = timings.current[node.key];
      if (node.status === "running" && !t) {
        timings.current[node.key] = { start: now };
      } else if (node.status !== "running" && node.status !== "pending" && t && !t.end) {
        t.end = now;
      }
    }
  }, [nodes, live, timings]);

  // Only tick while something is actually running — an idle graph must not
  // re-render the chat once a second forever.
  useEffect(() => {
    if (!anyRunning) return;
    const id = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, [anyRunning]);

  // Escape closes the expanded overlay, as every other layer in this app does.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const elapsedFor = (key: string): string | null => {
    const t = timings.current[key];
    if (!t) return null;
    return elapsedLabel((t.end ?? performance.now()) - t.start);
  };

  // Single-agent turn: ONE agent held the whole turn and dispatched nothing —
  // the Main agent answering alone, or the specialist a `*` tag routed the turn
  // straight to (`graph._run_tagged`). There is no graph to draw, so keep the
  // flat chip exactly as it was — this is the overwhelmingly common turn and it
  // must not grow a diagram. The label is the roster's, so the tagged case says
  // "File agent" rather than naming a hub that never ran.
  if (children.length === 0) {
    return (
      <div className="agent-strip" role="status" aria-label="Agents working on this request">
        <span className="agent-strip-caption">Agent</span>
        <span className="agent-pipe">
          <span className={`agent-chip ${chipClass(main?.status)}`}>
            {main?.status === "running" && <span className="agent-dot" aria-hidden />}
            {/* Never state by colour alone — the same rule the diagram's nodes
                follow. A failed one-agent turn reads as failed with the styles
                off, and `role="img"` gives a screen reader the word. */}
            {main?.status === "failed" && (
              <span role="img" aria-label={STATUS_WORD.failed}>
                {GLYPH.failed}
              </span>
            )}
            {main?.label ?? "Main agent"}
          </span>
        </span>
      </div>
    );
  }

  const runningCount = children.filter((n) => n.status === "running").length;
  const doneCount = children.filter((n) => n.status === "done").length;
  const selectedNode = nodes.find((n) => n.key === selected) ?? null;
  const toggle = (key: string) => setSelected((cur) => (cur === key ? null : key));

  /** What this node reported. The live `ask-report` event is the real answer;
   * the roster's own `report` covers the one case that never produces an event
   * — a delegation to a domain this room cannot serve, refused before it ran. */
  const reportFor = (node: GraphNode): { text: string; ok: boolean } | undefined => {
    const live = agentReports?.[node.key];
    if (live) return live;
    const refused = plan.find((p) => p.key === node.key)?.report;
    return refused ? { text: refused, ok: false } : undefined;
  };

  const inspectorFor = (node: GraphNode, autoScroll: boolean) => (
    <Inspector
      autoScroll={autoScroll}
      node={node}
      nodes={nodes}
      isHub={node.key === main.key}
      elapsed={elapsedFor(node.key)}
      steps={
        node.key === main.key
          ? (agentSteps[MAIN_KEY] ?? steps)
          : (agentSteps[node.key] ?? [])
      }
      lane={lane}
      report={reportFor(node)}
      onClose={() => setSelected(null)}
    />
  );

  const canvasProps = {
    main,
    children,
    selected,
    onSelect: toggle,
    elapsedFor,
    runningCount,
    lane,
  };

  return (
    <div className="agraph">
      <div className="agraph-head">
        <span className="agent-strip-caption">Agents</span>
        <span className="agraph-summary">
          {runningCount > 0
            ? `${runningCount} running`
            : `${doneCount}/${children.length} done`}
        </span>
        <button
          type="button"
          className="agraph-expand"
          onClick={() => setExpanded(true)}
          aria-haspopup="dialog"
        >
          Expand
        </button>
      </div>
      {/* One quiet live region instead of per-node ones: a screen reader should
          hear "3 agents running", not eight chips re-announcing themselves. */}
      <p className="agraph-sr" role="status">
        {runningCount > 0
          ? `${runningCount} of ${children.length} specialist agents running`
          : `${doneCount} of ${children.length} specialist agents finished`}
      </p>
      <GraphCanvas {...canvasProps} />
      {!expanded && selectedNode && inspectorFor(selectedNode, true)}

      {/* Expanded: an overlay, not an in-place resize. The chat pane is often
          ~290px wide, where a roomier graph (edge labels, full instructions)
          simply does not fit — it collided with itself. The overlay is the only
          place the wide layout is honest, so that is where it lives. */}
      {expanded && (
        <div
          className="agraph-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setExpanded(false);
          }}
        >
          <div
            className="agraph-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Agents working on this request"
          >
            <div className="agraph-modal-head">
              <span className="agraph-modal-title">Agents on this turn</span>
              <span className="agraph-summary">
                {runningCount > 0
                  ? `${runningCount} running`
                  : `${doneCount}/${children.length} done`}
              </span>
              <button
                type="button"
                className="agraph-expand"
                onClick={() => setExpanded(false)}
              >
                Close
              </button>
            </div>
            <div className="agraph-modal-body">
              <GraphCanvas {...canvasProps} roomy />
              {selectedNode && inspectorFor(selectedNode, false)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The drawn graph. Owns its own measurement, so the inline copy and the
 * expanded one can both exist without fighting over one set of element refs. */
function GraphCanvas({
  main,
  children,
  selected,
  onSelect,
  elapsedFor,
  runningCount,
  lane,
  roomy,
}: {
  main: GraphNode;
  children: GraphNode[];
  selected: string | null;
  onSelect: (key: string) => void;
  elapsedFor: (key: string) => string | null;
  runningCount: number;
  lane: string;
  roomy?: boolean;
}) {
  const bands = useMemo(() => toBands(children), [children]);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const nodeEls = useRef<Map<string, HTMLElement>>(new Map());
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [edges, setEdges] = useState<Edge[]>([]);

  const setNodeRef = (key: string, el: HTMLElement | null) => {
    if (el) nodeEls.current.set(key, el);
    else nodeEls.current.delete(key);
  };

  // Re-measure whenever the roster, its statuses or the box changes. A
  // ResizeObserver covers the cases no dependency can see: the chat pane being
  // resized, and the node text reflowing to two lines at a narrow width.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const box = canvas.getBoundingClientRect();
      const hub = nodeEls.current.get(main.key)?.getBoundingClientRect();
      if (!hub) return;
      const next: Edge[] = [];
      for (const child of children) {
        const el = nodeEls.current.get(child.key)?.getBoundingClientRect();
        if (!el) continue;
        const x1 = hub.right - box.left;
        const y1 = hub.top + hub.height / 2 - box.top;
        const x2 = el.left - box.left;
        const y2 = el.top + el.height / 2 - box.top;
        // Control-point reach: a curve that leaves the hub horizontally and
        // arrives horizontally, so the fan reads as one hand of spokes.
        const dx = Math.max(10, (x2 - x1) * 0.45);
        next.push({
          key: child.key,
          status: child.status,
          x1,
          y1,
          x2,
          y2,
          dx,
          label: child.instruction,
          // Label placement is anchored to the CHILD's row, not to the curve.
          // Riding the curve reads nicely in the abstract and fails in
          // practice: every spoke leaves the hub from one point, so labels
          // bunch up near it, and on a steep or near-horizontal spoke the line
          // runs straight through the words (a halo only masks the glyphs, not
          // the gaps between them). Sitting just above each child's top edge,
          // every label gets its own row and clears the curve — which arrives
          // horizontally at the child's mid-height — by half a node.
          lx: x2 - 10,
          ly: el.top - box.top - 5,
        });
      }
      // Only commit a CHANGED geometry. The ResizeObserver fires on layout the
      // measurement itself can cause, so an unconditional set is a render loop
      // even with stable dependencies.
      setSize((prev) =>
        prev.w === box.width && prev.h === box.height
          ? prev
          : { w: box.width, h: box.height },
      );
      setEdges((prev) => (sameEdges(prev, next) ? prev : next));
      // Only fade the bottom edge when there is genuinely more below; a
      // permanent mask would dim the last row of every graph that fits.
      canvas.classList.toggle("scrolls", canvas.scrollHeight > canvas.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [main, children, roomy]);

  return (
    <div className={`agraph-canvas${roomy ? " roomy" : ""}`} ref={canvasRef}>
      {/* Edges are measured from the laid-out DOM rather than assumed from a
          row count: a "N in parallel" band header shifts every row below it, so
          computed midpoints would drift off the nodes they point at.
          Decorative — the structure is in the node buttons' labels. */}
      <svg
        className="agraph-edges"
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        aria-hidden
      >
        {/* Every spoke first, THEN every label: SVG paints in document order,
            so interleaving them lets a later edge draw straight through an
            earlier edge's words. */}
        {edges.map((e) => (
          <path
            key={e.key}
            className={`agraph-edge ${e.status}`}
            d={`M${e.x1},${e.y1} C${e.x1 + e.dx},${e.y1} ${e.x2 - e.dx},${e.y2} ${e.x2},${e.y2}`}
          />
        ))}
        {roomy &&
          edges.map(
            (e) =>
              e.label && (
                <text
                  key={`${e.key}-label`}
                  className="agraph-edge-label"
                  x={e.lx}
                  y={e.ly}
                  textAnchor="end"
                >
                  {e.label.length > 42 ? `${e.label.slice(0, 41)}…` : e.label}
                </text>
              ),
          )}
      </svg>
      <div className="agraph-hub">
        <NodeCard
          node={main}
          nodeRef={(el) => setNodeRef(main.key, el)}
          selected={selected === main.key}
          onSelect={() => onSelect(main.key)}
          elapsed={null}
          subtitle={
            runningCount > 0
              ? `waiting on ${runningCount}`
              : main.status === "running"
                ? lane || "working"
                : // A finished turn's hub is settled to "done" (nothing runs in
                  // an archived diagram) — saying "queued" under a ✓ would
                  // contradict the glyph next to it.
                  main.status === "pending"
                  ? "queued"
                  : lane || "answered"
          }
          isHub
        />
      </div>
      <div className="agraph-children">
        {bands.map((band, bi) => (
          <div
            key={bi}
            className={`agraph-band${band.length > 1 ? " parallel" : ""}`}
            role="group"
            aria-label={
              band.length > 1
                ? `${band.length} agents dispatched together`
                : `${band[0].label}, dispatched alone`
            }
          >
            {band.length > 1 && (
              <span className="agraph-band-tag">
                <span className="agraph-band-rail" aria-hidden />
                {band.length} in parallel
              </span>
            )}
            {band.map((node) => (
              <NodeCard
                key={node.key}
                node={node}
                nodeRef={(el) => setNodeRef(node.key, el)}
                selected={selected === node.key}
                onSelect={() => onSelect(node.key)}
                elapsed={elapsedFor(node.key)}
                subtitle={node.instruction}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function NodeCard({
  node,
  nodeRef,
  selected,
  onSelect,
  elapsed,
  subtitle,
  isHub,
}: {
  node: GraphNode;
  nodeRef: (el: HTMLElement | null) => void;
  selected: boolean;
  onSelect: () => void;
  elapsed: string | null;
  subtitle: string;
  isHub?: boolean;
}) {
  return (
    <button
      type="button"
      ref={nodeRef}
      className={`agraph-node ${node.status}${selected ? " selected" : ""}${isHub ? " hub" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${node.label}, ${STATUS_WORD[node.status]}. ${subtitle}`}
      title={subtitle}
    >
      <span className="agraph-glyph" aria-hidden>
        {node.status === "running" ? (
          <span className="agraph-spin" />
        ) : (
          GLYPH[node.status]
        )}
      </span>
      <span className="agraph-node-text">
        <span className="agraph-node-label">{node.label}</span>
        <span className="agraph-node-sub">{subtitle}</span>
      </span>
      {elapsed && <span className="agraph-elapsed">{elapsed}</span>}
    </button>
  );
}

function Inspector({
  autoScroll,
  node,
  nodes,
  isHub,
  elapsed,
  steps,
  lane,
  report,
  onClose,
}: {
  /** Inline only: opening the panel grows the chat bubble, usually past the
   * bottom of the viewport — and since the growth came from a click, the
   * list's own pin-to-bottom effect never fires. In the overlay there is
   * nothing to scroll, so it is off there. */
  autoScroll?: boolean;
  node: GraphNode;
  nodes: GraphNode[];
  isHub: boolean;
  elapsed: string | null;
  steps: { label: string; ok: boolean }[];
  lane: string;
  /** What this agent handed back to the Main agent — the report itself, or the
   * reason it failed. Undefined for a node that has not reported yet. */
  report?: { text: string; ok: boolean };
  onClose: () => void;
}) {
  const children = nodes.slice(0, -1);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!autoScroll) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panelRef.current?.scrollIntoView({
      block: "nearest",
      behavior: still ? "auto" : "smooth",
    });
  }, [autoScroll, node.key]);
  return (
    <div className="agraph-inspect" ref={panelRef}>
      <div className="agraph-inspect-head">
        <span className="agraph-inspect-title">{node.label}</span>
        <code className="agraph-inspect-id">{node.agent}</code>
        <span className={`agraph-inspect-status ${node.status}`}>
          <span aria-hidden>{GLYPH[node.status]} </span>
          {STATUS_WORD[node.status]}
        </span>
        <button type="button" className="agraph-inspect-close" onClick={onClose} aria-label="Close agent details">
          ✕
        </button>
      </div>
      {AGENT_DESCRIPTIONS[node.agent] && (
        <p className="agraph-inspect-desc">{AGENT_DESCRIPTIONS[node.agent]}</p>
      )}
      {/* Clicking the hub means "show me the whole turn", not "show me one
          delegation" — so it reports the roster rather than its own kickoff. */}
      {isHub ? (
        <dl className="agraph-inspect-facts">
          <dt>This turn</dt>
          <dd>
            {children.length} specialist{children.length === 1 ? "" : "s"} dispatched
            {children.some((c) => c.status === "running")
              ? `, ${children.filter((c) => c.status === "running").length} still running`
              : ""}
          </dd>
          {lane && (
            <>
              <dt>Lane</dt>
              <dd>{lane}</dd>
            </>
          )}
          <dt>Delegations</dt>
          <dd>
            {children.map((c) => (
              <span key={c.key} className={`agraph-mini-chip ${c.status}`}>
                <span aria-hidden>{GLYPH[c.status]} </span>
                {c.label}
              </span>
            ))}
          </dd>
        </dl>
      ) : (
        <dl className="agraph-inspect-facts">
          <dt>Instruction</dt>
          <dd className="agraph-inspect-instruction">{node.instruction}</dd>
          {node.batch !== null && (
            <>
              <dt>Dispatched</dt>
              <dd>
                round {node.batch + 1}
                {children.filter((c) => c.batch === node.batch).length > 1
                  ? `, alongside ${children.filter((c) => c.batch === node.batch).length - 1} other agent${
                      children.filter((c) => c.batch === node.batch).length > 2 ? "s" : ""
                    }`
                  : ", on its own"}
              </dd>
            </>
          )}
          {elapsed && (
            <>
              <dt>Elapsed</dt>
              <dd>{elapsed}</dd>
            </>
          )}
          <dt>{report && !report.ok ? "Why it failed" : "Report"}</dt>
          <dd>
            {/* THE REPORT ITSELF, not a note saying one happened.
                A specialist's words reach the screen once, as live text, and
                the next round wipes them — so a child's answer flashed up and
                was gone, and a child that FAILED never explained itself at
                all: this row read "No report — the agent did not finish" and
                that was the entire account. */}
            {report ? (
              <div
                className={`agraph-report${report.ok ? "" : " failed"}`}
                dir="auto"
              >
                {report.text}
              </div>
            ) : node.status === "running" ? (
              "Still working"
            ) : node.status === "failed" ? (
              "No report — the agent did not finish"
            ) : node.status === "done" ? (
              "Reported back to the Main agent"
            ) : (
              "Not started"
            )}
          </dd>
        </dl>
      )}
      <div className="agraph-inspect-steps">
        <span className="agraph-inspect-steps-cap">
          {isHub ? "Turn steps" : "Its tool steps"}
        </span>
        {steps.length === 0 ? (
          <span className="agraph-inspect-empty">
            {node.status === "pending" ? "Not started yet." : "No tools yet."}
          </span>
        ) : (
          steps.map((s, i) => (
            <span key={i} className={`step-chip${s.ok ? "" : " failed"}`}>
              {s.ok ? "" : "⚠ "}
              {s.label}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
