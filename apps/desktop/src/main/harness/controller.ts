import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { EventSender } from "../turn.js";
import { activePolicy, type PolicyState } from "../privacy.js";
import { emptyPrivacyReport, type StreamRedactor } from "../privacyRedact.js";
import type { Room, RoomManagerState } from "../roomManager.js";
import type { LiveAppServices } from "../liveAppServices.js";
import { runsOnThisMac } from "../capabilities.js";
import { listModels as listOllamaModels } from "../engineRouting.js";
import { registryName } from "../ollamaModels.js";
import { roomServerDispatcherFactory } from "../roomServerLive.js";
import { WEB_LANES_ALL } from "../toolSpecs.js";
import {
  workspaceHarnessCapabilities,
  workspaceHarnessFlag,
  type WorkspaceHarnessFlag,
} from "../workspace/featureFlags.js";
import { ClaudeAgentSdkRuntime } from "./claudeAgentSdk.js";
import { CloudRedactedMirror } from "./cloudMirror.js";
import { CodexAppServerRuntime } from "./codexAppServer.js";
import {
  RestrictedLegacyCliRuntime,
  RuntimeWithFallback,
  type LegacyCliRuntimeOptions,
} from "./legacyCli.js";
import { DeepAgentRuntime } from "./deepAgentRuntime.js";
import { HarnessOrchestrator, type HarnessFinalStatus } from "./orchestrator.js";
import {
  RunProtection,
  type RollbackResult,
  type RunChangeSummary,
} from "./runProtection.js";
import { nativeWorkspaceSandboxSupported, verifyNativeHarnessExecutable } from "./seatbelt.js";
import { nativeCliExecutable, nativeHarnessModel } from "./nativeCli.js";
import { validateModelSelection } from "../modelCatalogSurfaceIpc.js";
import { createNativeRoomMcpFactory } from "./nativeRoomMcp.js";
import type {
  ApprovalDecision,
  HarnessEvent,
  HarnessName,
  HarnessRuntime,
  PrivacyMode,
} from "./types.js";
import type { HarnessHistoryRun } from "../../shared/harnessTypes.js";

type NativeHarnessProvider = "codex" | "claude";
type NativeHarnessRoom = Room & {
  workspace: NonNullable<Room["workspace"]>;
  descriptor: NonNullable<Room["descriptor"]> & {
    kind: "workspace-folder";
    rootPath: string;
  };
  readOnly?: false;
};

interface NativeProviderProbe {
  sandboxReady: boolean;
  harness: HarnessRuntime["name"] | null;
}

export type HarnessProvider = "codex" | "claude" | "ollama-local" | "ollama-cloud" | "openrouter";

export interface HarnessStartRequest {
  provider: HarnessProvider;
  model: string;
  privacyMode: PrivacyMode;
  writeEnabled: boolean;
  text: string;
  threadId?: string;
  systemPrompt?: string;
}

export interface HarnessCapabilityReport {
  flags: Record<WorkspaceHarnessFlag, boolean>;
  roomFormat: "workspace-folder" | "sealed-db" | null;
  outsideWorkspaceIsolation: boolean;
  providers: Record<string, {
    enabled: boolean;
    installed: boolean;
    reason: string | null;
    harness: HarnessName | null;
  }>;
}

interface MirrorRun {
  mirror: CloudRedactedMirror;
  writeEnabled: boolean;
}

interface PendingMirrorApproval {
  resolve(approved: boolean): void;
}

interface StartedHarnessRun {
  runId: string;
  room: NativeHarnessRoom;
  runtimePath: string;
  workspacePath: string;
}

interface PumpState {
  terminal: HarnessEvent | null;
  lastTextEvent: Extract<HarnessEvent, { type: "text_delta" }> | null;
}

/** Redact provider output at the provider-neutral boundary.
 *
 * Native and Deep runtimes stream the same event shape, so enforcing here
 * prevents a new runtime from bypassing the privacy gate. The stream redactor
 * deliberately spans delta boundaries ("Ben " + "Reich"). */
function redactHarnessTextDelta(
  event: HarnessEvent,
  redactor: StreamRedactor | null,
): HarnessEvent | null {
  if (event.type !== "text_delta" || redactor === null) return event;
  const text = redactor.feed(event.text);
  return text === "" ? null : { ...event, text };
}

export interface HarnessControllerOptions {
  runtimes?: Partial<Record<HarnessProvider, HarnessRuntime>>;
  services?: LiveAppServices;
  policy?: () => PolicyState | null;
  flag?: (name: WorkspaceHarnessFlag) => boolean;
  /**
   * Must prove both private-path denial and outside-workspace denial.
   * Production deliberately supplies no verifier until that stronger sandbox
   * exists. The old `.arcelle`-only canary is not enough.
   */
  verifyExposure?: (
    workspacePath: string,
    provider: "codex" | "claude",
    runtimePath: string,
    writeEnabled: boolean,
  ) => Promise<boolean>;
  outsideWorkspaceIsolation?: boolean;
  listOllamaModels?: () => Promise<string[]>;
  validateModelSelection?: typeof validateModelSelection;
}

interface ResolvedControllerOptions {
  policy: () => PolicyState | null;
  flag: (name: WorkspaceHarnessFlag) => boolean;
  verifyExposure: HarnessControllerOptions["verifyExposure"];
  listOllamaModels: () => Promise<string[]>;
  validateModelSelection: typeof validateModelSelection;
  outsideWorkspaceIsolation: boolean;
}

function resolvedControllerOptions(options: HarnessControllerOptions): ResolvedControllerOptions {
  return {
    policy: options.policy ?? activePolicy,
    flag: options.flag ?? workspaceHarnessFlag,
    verifyExposure: options.verifyExposure,
    listOllamaModels: options.listOllamaModels ?? listOllamaModels,
    validateModelSelection: options.validateModelSelection ?? validateModelSelection,
    outsideWorkspaceIsolation: options.outsideWorkspaceIsolation ?? nativeWorkspaceSandboxSupported(),
  };
}

function configuredRuntime<T extends HarnessRuntime>(provided: T | undefined, fallback: () => T): T {
  return provided ?? fallback();
}

function controllerRuntimes(
  state: RoomManagerState,
  emit: EventSender,
  runtimes: HarnessControllerOptions["runtimes"],
  services: LiveAppServices | undefined,
): Record<HarnessProvider, HarnessRuntime> {
  const fallbackDispatcher = roomServerDispatcherFactory(state, emit, services);
  const fallbackOptions: LegacyCliRuntimeOptions = {
    baseDispatcher: (context, workspace) =>
      fallbackDispatcher(false, { kind: "CloudEngine" }, WEB_LANES_ALL, {
        workspace,
        privacyBypass: context.privacyMode === "cloud-direct",
      }),
  };
  const nativeRoomMcp = createNativeRoomMcpFactory(
    state,
    (context, workspace) => fallbackDispatcher(
      false,
      { kind: "CloudEngine" },
      WEB_LANES_ALL,
      {
        workspace,
        privacyBypass: context.privacyMode === "cloud-direct",
      },
    ),
  );
  return {
    codex: configuredRuntime(runtimes?.codex, () => new RuntimeWithFallback(
      new CodexAppServerRuntime(undefined, undefined, undefined, undefined, nativeRoomMcp),
      new RestrictedLegacyCliRuntime("codex", state, fallbackOptions),
    )),
    claude: configuredRuntime(runtimes?.claude, () => new RuntimeWithFallback(
      new ClaudeAgentSdkRuntime(undefined, nativeRoomMcp),
      new RestrictedLegacyCliRuntime("claude", state, fallbackOptions),
    )),
    "ollama-local": configuredRuntime(runtimes?.["ollama-local"], () => new DeepAgentRuntime(state, emit, services)),
    "ollama-cloud": configuredRuntime(runtimes?.["ollama-cloud"], () => new DeepAgentRuntime(state, emit, services)),
    openrouter: configuredRuntime(runtimes?.openrouter, () => new DeepAgentRuntime(state, emit, services)),
  };
}
export { HarnessController } from "./controllerRuntime.js";


export { resolvedControllerOptions, controllerRuntimes, redactHarnessTextDelta };

export type { NativeHarnessProvider, NativeHarnessRoom, NativeProviderProbe, MirrorRun, PendingMirrorApproval, StartedHarnessRun, PumpState };
