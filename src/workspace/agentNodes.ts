/** The agent diagram's roster model: sidecar roster -> drawable nodes.
 *
 * Pure, and deliberately in its own module rather than inside AgentGraph.tsx:
 * this is the part with rules worth pinning in a test (`e2e/page-script/
 * agentNodes.test.mjs`), and a file that imports React cannot be loaded by the
 * plain-Node test runner.
 */
import type { AgentNodeStatus, AskPlanStep, AskActiveAgent } from "../apiTypes";

/** The Main agent's node key — fixed by the sidecar (`graph.MAIN_NODE_KEY`). */
export const MAIN_KEY = "main";

export interface GraphNode {
  key: string;
  agent: string;
  label: string;
  instruction: string;
  status: AgentNodeStatus;
  /** null on the hub; children sharing a number were dispatched together. */
  batch: number | null;
}

/** What a node's last-seen status means once the turn is OVER.
 *
 * A finished turn has nothing running, but the sidecar never sends a terminal
 * "everything is done" roster: for a delegated turn it re-marks the hub active
 * after each batch of children is collected (graph.py `_emit_pipeline(...,
 * active_step=len(roster) + 1)`), and that snapshot is the one an archived
 * diagram is frozen from. Drawn as-is it spins the Main agent forever under an
 * answer that landed minutes ago, next to a header reading "N/N done" — and a
 * long chat accumulates one per delegated turn.
 *
 * The hub demonstrably finished: it composed the answer this diagram hangs
 * under. A CHILD still marked running is one the turn was stopped on top of,
 * which is the state the sidecar itself records for a cancelled child
 * (`entry["status"] = "failed"`, with no emit left to carry it) — so "no
 * report, it did not finish" is the honest reading, not "done".
 */
function settled(status: AgentNodeStatus, isMain: boolean): AgentNodeStatus {
  if (status !== "running") return status;
  return isMain ? "done" : "failed";
}

/** Roster + active marker -> nodes.
 *
 * `status` normally comes straight off the entry, because every `ask-plan` is a
 * complete snapshot. The fallback path matters anyway: a frontend newer than the
 * bundled sidecar (routine during development, and possible after a partial
 * update) gets rosters with no status at all, and must still render something
 * truthful from the single active marker alone.
 *
 * `live` false is a finished turn's replay — see `settled`.
 */
export function toNodes(
  plan: AskPlanStep[],
  active: AskActiveAgent | null,
  live = true,
): GraphNode[] {
  const activeSteps = new Set(
    active?.active_steps?.length ? active.active_steps : active ? [active.step] : [],
  );
  return plan.map((entry, i) => {
    const isMain = i === plan.length - 1;
    const fallback: AgentNodeStatus = activeSteps.has(i + 1)
      ? "running"
      : active && i + 1 < active.step
        ? "done"
        : "pending";
    const status = entry.status ?? fallback;
    return {
      key: entry.key ?? (isMain ? MAIN_KEY : `${entry.agent}#${i}`),
      agent: entry.agent,
      label: entry.label,
      instruction: entry.instruction,
      status: live ? status : settled(status, isMain),
      // Without backend batching every child reads as one group, which is the
      // honest degradation: "these were dispatched, grouping unknown".
      batch: entry.batch ?? (isMain ? null : 0),
    };
  });
}

/** Consecutive children sharing a batch, in roster (call) order. */
export function toBands(children: GraphNode[]): GraphNode[][] {
  const bands: GraphNode[][] = [];
  for (const node of children) {
    const last = bands[bands.length - 1];
    if (last && last[0].batch === node.batch) last.push(node);
    else bands.push([node]);
  }
  return bands;
}
