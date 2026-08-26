export type HarnessName = "codex-app-server" | "claude-agent-sdk" | "arcelle-deep" | "legacy-cli";
export type PrivacyMode = "local" | "cloud-direct" | "cloud-redacted";

export interface HarnessContext {
  runId: string;
  roomId: string;
  /** A verified filesystem exposure. It can be the real room or a mirror. */
  workspacePath: string;
  model: string;
  provider: string;
  privacyMode: PrivacyMode;
  writeEnabled: boolean;
  /** True only after the private-path and sandbox self-tests pass. */
  exposureVerified: boolean;
  systemPrompt?: string;
}

export interface HarnessInput {
  text: string;
  threadId?: string;
}

export type ApprovalDecision = "allow-once" | "allow-run" | "deny" | "cancel";

export type HarnessEvent =
  | { type: "run_started"; runId: string; harness: HarnessName }
  | { type: "agent_started"; runId: string; agentId: string; label?: string }
  | { type: "plan_updated"; runId: string; text: string }
  | { type: "text_delta"; runId: string; text: string; agentId?: string }
  | { type: "tool_requested"; runId: string; requestId: string; tool: string; input: unknown }
  | { type: "approval_requested"; runId: string; requestId: string; tool: string; detail: string }
  | { type: "tool_started"; runId: string; tool: string; toolId?: string }
  | { type: "tool_completed"; runId: string; tool: string; toolId?: string; result?: unknown; error?: string }
  | { type: "file_changed"; runId: string; relativePath: string; change: string }
  | { type: "usage_updated"; runId: string; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: "agent_completed"; runId: string; agentId: string }
  | { type: "run_failed"; runId: string; error: string }
  | { type: "run_completed"; runId: string; status: "completed" | "cancelled" };

export interface HarnessRun {
  events: AsyncIterable<HarnessEvent>;
  cancel(): Promise<void>;
  approve(requestId: string, decision: ApprovalDecision): Promise<void>;
}

export interface HarnessRuntime {
  readonly name: HarnessName;
  available(): Promise<boolean>;
  startTurn(context: HarnessContext, input: HarnessInput): Promise<HarnessRun>;
}
