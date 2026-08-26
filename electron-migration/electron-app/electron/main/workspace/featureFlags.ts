export const WORKSPACE_HARNESS_FLAGS = [
  "workspace_rooms_v2",
  "workspace_conversion",
  "sealed_export_v2",
  "unified_harness",
  "codex_app_server",
  "claude_agent_sdk",
  "deep_agent_harness",
  "cloud_redacted_mirror",
] as const;

export type WorkspaceHarnessFlag = typeof WORKSPACE_HARNESS_FLAGS[number];

const DEFAULTS: Record<WorkspaceHarnessFlag, boolean> = {
  workspace_rooms_v2: true,
  workspace_conversion: true,
  sealed_export_v2: true,
  unified_harness: true,
  codex_app_server: true,
  claude_agent_sdk: true,
  deep_agent_harness: true,
  cloud_redacted_mirror: true,
};

/**
 * GA defaults enable the product surface. Runtime capability, provider
 * installation, room format, privacy, baseline, and sandbox probes still
 * fail closed before any harness or workspace operation can start.
 */
export function workspaceHarnessFlag(name: WorkspaceHarnessFlag): boolean {
  const key = `ARCELLE_${name.toUpperCase()}`;
  const value = process.env[key];
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return DEFAULTS[name];
}

export function workspaceHarnessCapabilities(): Record<WorkspaceHarnessFlag, boolean> {
  return Object.fromEntries(
    WORKSPACE_HARNESS_FLAGS.map((name) => [name, workspaceHarnessFlag(name)]),
  ) as Record<WorkspaceHarnessFlag, boolean>;
}
