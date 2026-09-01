import { useEffect, useRef } from "react";
import type { AgentNodeStatus } from "../apiTypes";
import { prefersReducedMotion } from "../rooms/helpers";
import type { GraphNode } from "./agentNodes";
import { AGENT_DESCRIPTIONS, GLYPH, STATUS_WORD } from "./agentGraphShared";

interface InspectorProps {
  autoScroll?: boolean;
  node: GraphNode;
  nodes: GraphNode[];
  isHub: boolean;
  elapsed: string | null;
  steps: { label: string; ok: boolean }[];
  lane: string;
  report?: { text: string; ok: boolean };
  onClose: () => void;
}

export function Inspector({
  autoScroll,
  node,
  nodes,
  isHub,
  elapsed,
  steps,
  lane,
  report,
  onClose,
}: InspectorProps) {
  const children = nodes.slice(0, -1);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useInspectorAutoScroll(panelRef, autoScroll, node.key);
  return (
    <div className="agraph-inspect" ref={panelRef}>
      <InspectorHeader node={node} onClose={onClose} />
      <InspectorDescription agent={node.agent} />
      {isHub ? (
        <HubFacts children={children} lane={lane} />
      ) : (
        <AgentFacts
          node={node}
          children={children}
          elapsed={elapsed}
          report={report}
        />
      )}
      <InspectorSteps isHub={isHub} status={node.status} steps={steps} />
    </div>
  );
}

function useInspectorAutoScroll(
  panelRef: React.RefObject<HTMLDivElement | null>,
  autoScroll: boolean | undefined,
  key: string,
) {
  useEffect(() => {
    if (!autoScroll) return;
    panelRef.current?.scrollIntoView({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [autoScroll, key, panelRef]);
}

function InspectorHeader({
  node,
  onClose,
}: Pick<InspectorProps, "node" | "onClose">) {
  return (
    <div className="agraph-inspect-head">
      <span className="agraph-inspect-title">{node.label}</span>
      <code className="agraph-inspect-id">{node.agent}</code>
      <span className={`agraph-inspect-status ${node.status}`}>
        <span aria-hidden>{GLYPH[node.status]} </span>
        {STATUS_WORD[node.status]}
      </span>
      <button
        type="button"
        className="agraph-inspect-close"
        onClick={onClose}
        aria-label="Close agent details"
      >
        ✕
      </button>
    </div>
  );
}

function InspectorDescription({ agent }: { agent: string }) {
  const description = AGENT_DESCRIPTIONS[agent];
  return description && <p className="agraph-inspect-desc">{description}</p>;
}

function hubDispatchDescription(children: GraphNode[]) {
  const running = children.filter((child) => child.status === "running").length;
  const count = `${children.length} specialist${children.length === 1 ? "" : "s"} dispatched`;
  return running ? `${count}, ${running} still running` : count;
}

function HubFacts({ children, lane }: { children: GraphNode[]; lane: string }) {
  return (
    <dl className="agraph-inspect-facts">
      <dt>This turn</dt>
      <dd>{hubDispatchDescription(children)}</dd>
      {lane && (
        <>
          <dt>Lane</dt>
          <dd>{lane}</dd>
        </>
      )}
      <dt>Delegations</dt>
      <dd>
        {children.map((child) => (
          <DelegationChip key={child.key} node={child} />
        ))}
      </dd>
    </dl>
  );
}

function DelegationChip({ node }: { node: GraphNode }) {
  return (
    <span className={`agraph-mini-chip ${node.status}`}>
      <span aria-hidden>{GLYPH[node.status]} </span>
      {node.label}
    </span>
  );
}

function batchDescription(node: GraphNode, children: GraphNode[]) {
  const batchSize = children.filter(
    (child) => child.batch === node.batch,
  ).length;
  if (batchSize === 1) return `round ${node.batch! + 1}, on its own`;
  const otherAgents = batchSize - 1;
  return `round ${node.batch! + 1}, alongside ${otherAgents} other agent${otherAgents === 1 ? "" : "s"}`;
}

function AgentFacts({
  node,
  children,
  elapsed,
  report,
}: Pick<InspectorProps, "node" | "elapsed" | "report"> & {
  children: GraphNode[];
}) {
  return (
    <dl className="agraph-inspect-facts">
      <dt>Instruction</dt>
      <dd className="agraph-inspect-instruction">{node.instruction}</dd>
      {node.batch !== null && (
        <>
          <dt>Dispatched</dt>
          <dd>{batchDescription(node, children)}</dd>
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
        <AgentReport status={node.status} report={report} />
      </dd>
    </dl>
  );
}

const REPORT_FALLBACK: Record<AgentNodeStatus, string> = {
  pending: "Not started",
  running: "Still working",
  done: "Reported back to the Main agent",
  failed: "No report — the agent did not finish",
};

function AgentReport({
  status,
  report,
}: {
  status: AgentNodeStatus;
  report?: { text: string; ok: boolean };
}) {
  if (!report) return REPORT_FALLBACK[status];
  return (
    <div className={`agraph-report${report.ok ? "" : " failed"}`} dir="auto">
      {report.text}
    </div>
  );
}

function InspectorSteps({
  isHub,
  status,
  steps,
}: {
  isHub: boolean;
  status: AgentNodeStatus;
  steps: { label: string; ok: boolean }[];
}) {
  return (
    <div className="agraph-inspect-steps">
      <span className="agraph-inspect-steps-cap">
        {isHub ? "Turn steps" : "Its tool steps"}
      </span>
      {steps.length === 0 ? (
        <EmptySteps status={status} />
      ) : (
        <StepChips steps={steps} />
      )}
    </div>
  );
}

function EmptySteps({ status }: { status: AgentNodeStatus }) {
  return (
    <span className="agraph-inspect-empty">
      {status === "pending" ? "Not started yet." : "No tools yet."}
    </span>
  );
}

function StepChips({ steps }: { steps: { label: string; ok: boolean }[] }) {
  return steps.map((step, index) => (
    <span key={index} className={`step-chip${step.ok ? "" : " failed"}`}>
      {step.ok ? "" : "⚠ "}
      {step.label}
    </span>
  ));
}
