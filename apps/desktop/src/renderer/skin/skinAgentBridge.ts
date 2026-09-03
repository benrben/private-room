import type { AgentUiRequest } from "../api";
import { parseSkinPatch } from "./skinModel";
import {
  saveAndApplySkin,
  skinSnapshot,
  skinValidationSummary,
  undoDraft,
  updateSkinDraft,
} from "./skinStore";

export type SkinAgentRequestKind = Extract<AgentUiRequest["kind"],
  "skin_read" | "skin_update" | "skin_undo" | "skin_validate" | "skin_save"
>;

export function handleSkinAgentRequest(
  kind: SkinAgentRequestKind,
  args: Record<string, unknown>,
): Record<string, unknown> {
  try {
    const handler = SKIN_AGENT_HANDLERS[kind];
    return handler ? handler(args) : { error: `Unknown skin request kind "${String(kind)}".` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const SKIN_AGENT_HANDLERS: Record<SkinAgentRequestKind, (args: Record<string, unknown>) => Record<string, unknown>> = {
  skin_read: readSkinForAgent,
  skin_update: updateSkinForAgent,
  skin_undo: undoSkinForAgent,
  skin_validate: validationForAgent,
  skin_save: saveSkinForAgent,
};

function readSkinForAgent(_args: Record<string, unknown>): Record<string, unknown> {
  const workspace = skinSnapshot();
  const { draft } = workspace;
  const validation = skinValidationSummary();
  return {
    revision: draft.revision,
    mode: draft.mode,
    agent_can_edit: draft.mode === "agent" || draft.mode === "together",
    agent_can_save: draft.agentMaySave,
    dirty: draft.dirty,
    draft_name: workspace.draftName,
    valid: validation.valid,
    issues: validation.issues,
    config: draft.config,
    recent_changes: draft.history.slice(-10).map((entry) => ({
      revision: entry.revision,
      actor: entry.actor,
      label: entry.label,
    })),
  };
}

function validationForAgent(_args: Record<string, unknown>): Record<string, unknown> {
  const validation = skinValidationSummary();
  return { revision: skinSnapshot().draft.revision, ...validation };
}

function updateSkinForAgent(args: Record<string, unknown>): Record<string, unknown> {
  const expectedRevision = requiredRevision(args);
  const label = requiredString(args, "label");
  const patch = parseSkinPatch(args.patch);
  const result = updateSkinDraft({ actor: "agent", expectedRevision, label, patch });
  if (!result.ok) return failure(result);
  return {
    updated: true,
    revision: result.state.revision,
    dirty: result.state.dirty,
    valid: true,
    label: result.state.history.at(-1)?.label ?? label,
  };
}

function undoSkinForAgent(args: Record<string, unknown>): Record<string, unknown> {
  const result = undoDraft("agent", requiredRevision(args));
  if (!result.ok) return failure(result);
  return { undone: true, revision: result.state.revision, dirty: result.state.dirty };
}

function saveSkinForAgent(args: Record<string, unknown>): Record<string, unknown> {
  const result = saveAndApplySkin("agent", requiredString(args, "name"), requiredRevision(args));
  if (!result.ok) return failure(result);
  return {
    saved: true,
    applied: true,
    id: result.saved.id,
    name: result.saved.name,
    revision: result.state.revision,
  };
}

function requiredRevision(args: Record<string, unknown>): number {
  const value = args.expected_revision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("expected_revision must be a non-negative integer from read_skin.");
  }
  return value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`);
  return value;
}

function failure(result: { ok: false; code: string; error: string; currentRevision?: number; issues?: string[] }): Record<string, unknown> {
  return {
    error: result.error,
    code: result.code,
    ...(result.currentRevision === undefined ? {} : { current_revision: result.currentRevision }),
    ...(result.issues === undefined ? {} : { issues: result.issues }),
  };
}
