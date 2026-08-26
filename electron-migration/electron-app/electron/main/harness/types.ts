import type {
  ApprovalDecision,
  HarnessEvent,
  HarnessName,
  PrivacyMode,
} from "../../shared/harnessTypes.js";

export type { ApprovalDecision, HarnessEvent, HarnessName, PrivacyMode } from "../../shared/harnessTypes.js";

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
