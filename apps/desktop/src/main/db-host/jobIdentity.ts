/** Stable identity for detecting duplicate parked units of work. */

const UNIT_SEP = "\u001f";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalArrayValue(value: unknown): string {
  return value === undefined ? "null" : canonicalJson(value);
}

function omittedJsonObjectValue(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function canonicalObject(value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (omittedJsonObjectValue(child)) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(child)}`);
  }
  return `{${parts.join(",")}}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalArrayValue).join(",")}]`;
  if (isRecord(value)) return canonicalObject(value);
  return JSON.stringify(value) ?? "null";
}

function workflowIdentity(plan: unknown): string | null {
  if (!isRecord(plan)) return null;
  const workflowId = plan["workflow_id"];
  if (typeof workflowId !== "string" || workflowId === "") return null;
  return `workflow${UNIT_SEP}${workflowId}`;
}

function automaticSummaryIdentity(plan: unknown): string | null {
  if (!isRecord(plan) || plan["auto"] !== true) return null;
  return `deep_summary${UNIT_SEP}auto`;
}

function specialWorkIdentity(kind: string, plan: unknown): string | null {
  if (kind === "workflow") return workflowIdentity(plan);
  if (kind === "deep_summary") return automaticSummaryIdentity(plan);
  return null;
}

export function workIdentity(kind: string, title: string, plan: unknown): string {
  const special = specialWorkIdentity(kind, plan);
  if (special !== null) return special;
  return `${kind}${UNIT_SEP}${title}${UNIT_SEP}${canonicalJson(plan)}`;
}
