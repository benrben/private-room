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
 * THE DRAWING LIVES BEHIND "Expand", not in the transcript. Inline, the turn is
 * a caption, a count and a row of specialist chips; the hub-and-spoke picture
 * needs width the ~290px AI pane does not have, and the transcript would pay
 * for it under every past answer.
 *
 * Hand-rolled: HTML nodes over an SVG edge layer, no graph library. The nodes
 * are real buttons, so they get focus, hover, ellipsis and the app's tokens for
 * free; only the curves need SVG. Every colour is a token — light and dark both
 * resolve — and no state is signalled by colour alone: each carries its own
 * glyph and outline weight.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { AgentNodeStatus, AskPlanStep, AskActiveAgent } from "../apiTypes";
import { useFocusTrap } from "../settings/useFocusTrap";
import {
  MAIN_KEY,
  chipClass,
  toNodes,
  type GraphNode,
} from "./agentNodes";
import { GLYPH, STATUS_WORD, elapsedLabel } from "./agentGraphShared";
import { GraphCanvas } from "./AgentGraphCanvas";
import { Inspector } from "./AgentGraphInspector";

/** Per-node start/end stamps, kept in a ref because they are observations about
 * this render session, not state the backend sends: the protocol says WHAT a
 * node is doing, never for how long. The store can be supplied by the caller so
 * a finished turn's clocks outlive the live bubble that measured them. */
export type AgentTiming = { start: number; end?: number };

/** One hub->child spoke, in canvas pixels. */
export interface AgentGraphProps {
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
}

function startTiming(
  timings: Record<string, AgentTiming>,
  node: GraphNode,
  now: number,
) {
  if (!timings[node.key]) timings[node.key] = { start: now };
}

function shouldEndTiming(
  status: AgentNodeStatus,
  timing: AgentTiming | undefined,
): timing is AgentTiming {
  return (
    status !== "pending" && status !== "running" && !!timing && !timing.end
  );
}

function stampTiming(
  timings: Record<string, AgentTiming>,
  node: GraphNode,
  now: number,
) {
  if (node.status === "running") {
    startTiming(timings, node, now);
    return;
  }
  const timing = timings[node.key];
  if (shouldEndTiming(node.status, timing)) timing.end = now;
}

function stampTimings(
  nodes: GraphNode[],
  timings: Record<string, AgentTiming>,
  now: number,
) {
  for (const node of nodes) stampTiming(timings, node, now);
}

function useAgentTimings(
  nodes: GraphNode[],
  live: boolean,
  timingStore?: { current: Record<string, AgentTiming> },
) {
  const ownTimings = useRef<Record<string, AgentTiming>>({});
  const timings = timingStore ?? ownTimings;
  const [, tick] = useState(0);
  const anyRunning = live && nodes.some((node) => node.status === "running");

  useEffect(() => {
    if (live) stampTimings(nodes, timings.current, performance.now());
  }, [nodes, live, timings]);

  useEffect(() => {
    if (!anyRunning) return;
    const id = window.setInterval(() => tick((count) => count + 1), 500);
    return () => window.clearInterval(id);
  }, [anyRunning]);

  return useCallback(
    (key: string): string | null => {
      const timing = timings.current[key];
      return timing
        ? elapsedLabel((timing.end ?? performance.now()) - timing.start)
        : null;
    },
    [timings],
  );
}

function graphSummary(running: number, done: number, total: number): string {
  return running > 0 ? `${running} running` : `${done}/${total} done`;
}

function graphLiveSummary(
  running: number,
  done: number,
  total: number,
): string {
  return running > 0
    ? `${running} of ${total} specialist agents running`
    : `${done} of ${total} specialist agents finished`;
}

function reportFor(
  node: GraphNode,
  plan: AskPlanStep[],
  reports?: Record<string, { text: string; ok: boolean }>,
): { text: string; ok: boolean } | undefined {
  const report = reports?.[node.key];
  if (report) return report;
  const refused = plan.find((step) => step.key === node.key)?.report;
  return refused ? { text: refused, ok: false } : undefined;
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
}: AgentGraphProps) {
  const nodes = useMemo(
    () => toNodes(plan, active, live),
    [plan, active, live],
  );
  const main = nodes[nodes.length - 1];
  // Memoised, not sliced inline: this feeds the measuring layout effect's
  // dependencies, and a fresh array identity every render would re-run the
  // measure, which sets state, which renders again — an infinite loop.
  const children = useMemo(() => nodes.slice(0, -1), [nodes]);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const elapsedFor = useAgentTimings(nodes, live, timingStore);

  // Single-agent turn: ONE agent held the whole turn and dispatched nothing —
  // the Main agent answering alone, or the specialist a `*` tag routed the turn
  // straight to (`graph._run_tagged`). There is no graph to draw, so keep the
  // flat chip exactly as it was — this is the overwhelmingly common turn and it
  // must not grow a diagram. The label is the roster's, so the tagged case says
  // "File agent" rather than naming a hub that never ran.
  if (children.length === 0) return <SingleAgentStrip node={main} />;

  const runningCount = children.filter(
    (node) => node.status === "running",
  ).length;
  const doneCount = children.filter((node) => node.status === "done").length;
  const selectedNode = nodes.find((n) => n.key === selected) ?? null;
  const toggle = (key: string) =>
    setSelected((cur) => (cur === key ? null : key));

  return (
    <AgentGraphBody
      children={children}
      main={main}
      selected={selected}
      selectedNode={selectedNode}
      elapsedFor={elapsedFor}
      runningCount={runningCount}
      doneCount={doneCount}
      lane={lane}
      expanded={expanded}
      onExpand={() => setExpanded(true)}
      onCloseExpand={() => setExpanded(false)}
      onSelect={toggle}
      onCloseInspector={() => setSelected(null)}
      plan={plan}
      agentSteps={agentSteps}
      agentReports={agentReports}
      steps={steps}
    />
  );
}

function SingleAgentStrip({ node }: { node: GraphNode | undefined }) {
  return (
    <div
      className="agent-strip"
      role="status"
      aria-label="Agents working on this request"
    >
      <span className="agent-strip-caption">Agent</span>
      <span className="agent-pipe">
        <span className={`agent-chip ${chipClass(node?.status)}`}>
          {node?.status === "running" && (
            <span className="agent-dot" aria-hidden />
          )}
          {node?.status === "failed" && (
            <span role="img" aria-label={STATUS_WORD.failed}>
              {GLYPH.failed}
            </span>
          )}
          {node?.label ?? "Main agent"}
        </span>
      </span>
    </div>
  );
}

interface AgentGraphBodyProps {
  main: GraphNode;
  children: GraphNode[];
  selected: string | null;
  selectedNode: GraphNode | null;
  elapsedFor: (key: string) => string | null;
  runningCount: number;
  doneCount: number;
  lane: string;
  expanded: boolean;
  onExpand: () => void;
  onCloseExpand: () => void;
  onSelect: (key: string) => void;
  onCloseInspector: () => void;
  plan: AskPlanStep[];
  agentSteps: Record<string, { label: string; ok: boolean }[]>;
  agentReports?: Record<string, { text: string; ok: boolean }>;
  steps: { label: string; ok: boolean }[];
}

function AgentGraphBody(props: AgentGraphBodyProps) {
  const summary = graphSummary(
    props.runningCount,
    props.doneCount,
    props.children.length,
  );
  return (
    <div className="agraph">
      <GraphHeader summary={summary} onExpand={props.onExpand} />
      <p className="agraph-sr" role="status">
        {graphLiveSummary(
          props.runningCount,
          props.doneCount,
          props.children.length,
        )}
      </p>
      <AgentRoster
        children={props.children}
        selected={props.selected}
        elapsedFor={props.elapsedFor}
        onSelect={props.onSelect}
      />
      {!props.expanded && (
        <InspectorSlot {...props} autoScroll node={props.selectedNode} />
      )}
      {props.expanded && <ExpandedGraph {...props} summary={summary} />}
    </div>
  );
}

function GraphHeader({
  summary,
  onExpand,
}: {
  summary: string;
  onExpand: () => void;
}) {
  return (
    <div className="agraph-head">
      <span className="agent-strip-caption">Agents</span>
      <span className="agraph-summary">{summary}</span>
      <button
        type="button"
        className="agraph-expand"
        onClick={onExpand}
        aria-haspopup="dialog"
      >
        Expand
      </button>
    </div>
  );
}

function AgentRoster({
  children,
  selected,
  elapsedFor,
  onSelect,
}: Pick<
  AgentGraphBodyProps,
  "children" | "selected" | "elapsedFor" | "onSelect"
>) {
  return (
    <div className="agraph-roster">
      {children.map((node) => (
        <RosterNode
          key={node.key}
          node={node}
          selected={selected === node.key}
          elapsed={elapsedFor(node.key)}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function RosterNode({
  node,
  selected,
  elapsed,
  onSelect,
}: {
  node: GraphNode;
  selected: boolean;
  elapsed: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <button
      type="button"
      className={`agraph-mini-chip ${node.status}`}
      onClick={() => onSelect(node.key)}
      aria-pressed={selected}
      aria-label={`${node.label}, ${STATUS_WORD[node.status]}. ${node.instruction}`}
      title={node.instruction}
    >
      <span aria-hidden>{GLYPH[node.status]} </span>
      {node.label}
      {elapsed && <span className="agraph-elapsed">&nbsp;{elapsed}</span>}
    </button>
  );
}

function inspectorSteps(
  node: GraphNode,
  main: GraphNode,
  agentSteps: Record<string, { label: string; ok: boolean }[]>,
  fallback: { label: string; ok: boolean }[],
) {
  return node.key === main.key
    ? (agentSteps[MAIN_KEY] ?? fallback)
    : (agentSteps[node.key] ?? []);
}

function InspectorSlot({
  node,
  autoScroll,
  main,
  children,
  elapsedFor,
  agentSteps,
  steps,
  lane,
  agentReports,
  plan,
  onCloseInspector,
}: Pick<
  AgentGraphBodyProps,
  | "main"
  | "children"
  | "elapsedFor"
  | "agentSteps"
  | "steps"
  | "lane"
  | "agentReports"
  | "plan"
  | "onCloseInspector"
> & { node: GraphNode | null; autoScroll: boolean }) {
  if (!node) return null;
  return (
    <Inspector
      autoScroll={autoScroll}
      node={node}
      nodes={[...children, main]}
      isHub={node.key === main.key}
      elapsed={elapsedFor(node.key)}
      steps={inspectorSteps(node, main, agentSteps, steps)}
      lane={lane}
      report={reportFor(node, plan, agentReports)}
      onClose={onCloseInspector}
    />
  );
}

function ExpandedGraph(props: AgentGraphBodyProps & { summary: string }) {
  const canvasProps = {
    main: props.main,
    children: props.children,
    selected: props.selected,
    onSelect: props.onSelect,
    elapsedFor: props.elapsedFor,
    runningCount: props.runningCount,
    lane: props.lane,
  };
  return createPortal(
    <div
      className="agraph-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onCloseExpand();
      }}
    >
      <ExpandedPanel onClose={props.onCloseExpand}>
        <div className="agraph-modal-head">
          <span className="agraph-modal-title">Agents on this turn</span>
          <span className="agraph-summary">{props.summary}</span>
          <button
            type="button"
            className="agraph-expand"
            onClick={props.onCloseExpand}
          >
            Close
          </button>
        </div>
        <div className="agraph-modal-body">
          <GraphCanvas {...canvasProps} roomy />
          <InspectorSlot
            {...props}
            autoScroll={false}
            node={props.selectedNode}
          />
        </div>
      </ExpandedPanel>
    </div>,
    document.body,
  );
}

/** The expanded graph's panel, a component of its own so `useFocusTrap`'s mount
 * and unmount effects line up with the overlay opening and closing rather than
 * with the chat bubble that owns it. */
function ExpandedPanel({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const { modalRef, onModalKeyDown } = useFocusTrap(onClose);
  return (
    <div
      ref={modalRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        // The app-level Escape (effects.ts) closes the open FILE. This dialog is
        // in front of it, so the key it answers must not carry past it.
        if (e.key === "Escape") e.stopPropagation();
        onModalKeyDown(e);
      }}
      className="agraph-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Agents working on this request"
    >
      {children}
    </div>
  );
}
