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
  workspace_conversion: false,
  sealed_export_v2: false,
  unified_harness: false,
  codex_app_server: false,
  claude_agent_sdk: false,
  deep_agent_harness: false,
  cloud_redacted_mirror: false,
};

/** Environment override for development and staged releases. */
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
