import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { emptyPrivacyReport, type StreamRedactor } from "../privacyRedact.js";
import { CloudRedactedMirror } from "./cloudMirror.js";
import { HarnessOrchestrator, type HarnessFinalStatus } from "./orchestrator.js";
import { RunProtection, type RollbackResult, type RunChangeSummary } from "./runProtection.js";
import { validateModelSelection } from "../modelCatalogSurfaceIpc.js";
import type { ApprovalDecision, HarnessEvent, PrivacyMode } from "./types.js";
import type { HarnessHistoryRun } from "../../shared/harnessTypes.js";
import { redactHarnessTextDelta } from "./controller.js";
import type { NativeHarnessProvider, NativeHarnessRoom, HarnessProvider, HarnessStartRequest, MirrorRun, StartedHarnessRun, PumpState } from "./controller.js";
import { HarnessControllerCore } from "./controllerCore.js";

export class HarnessController extends HarnessControllerCore {


  protected async validateStartRequest(
    request: HarnessStartRequest,
    native: boolean,
    selectedModel: string,
  ): Promise<NativeHarnessRoom> {
    if (!this.flag(this.providerFlag(request.provider))) {
      throw new Error(`The ${request.provider} native harness feature is disabled.`);
    }
    if (native && !this.isolationProven) {
      throw new Error("Native harness mode is disabled because outside-workspace isolation is not proven.");
    }
    this.validatePrivacyMode(request.provider, native, selectedModel, request.privacyMode);
    const room = this.startRoom();
    if (!native) await this.validateSelectableModel(request.provider, selectedModel);
    return room;
  }


  protected async validateSelectableModel(provider: HarnessProvider, selectedModel: string): Promise<void> {
    const validation = await this.validateModelSelection(provider, selectedModel);
    if (!validation.selectable) {
      throw new Error(validation.reason ?? `The exact ${provider} model ID is unavailable.`);
    }
  }


  protected createStartedRun(room: NativeHarnessRoom): StartedHarnessRun {
    const runId = randomUUID();
    const runtimePath = path.join(this.runtimeRoot(), room.descriptor.roomId, runId);
    this.runRoots.set(runId, runtimePath);
    return { runId, room, runtimePath, workspacePath: room.descriptor.rootPath };
  }


  protected async prepareRunWorkspace(
    request: HarnessStartRequest,
    started: StartedHarnessRun,
  ): Promise<StartedHarnessRun> {
    if (request.privacyMode !== "cloud-redacted") {
      await mkdir(started.runtimePath, { recursive: true, mode: 0o700 });
      return started;
    }
    if (!this.flag("cloud_redacted_mirror")) throw new Error("Cloud Privacy workspace mirrors are disabled.");
    const policy = this.policy();
    if (policy === null) throw new Error("Turn on Cloud Privacy before starting a redacted cloud run.");
    const mirror = new CloudRedactedMirror(
      started.room.workspace,
      this.runtimeRoot(),
      started.room.descriptor.roomId,
      started.runId,
      { redactor: policy.redactor, rules: policy.rules },
    );
    const info = await mirror.create();
    this.mirrors.set(started.runId, { mirror, writeEnabled: request.writeEnabled });
    return { ...started, workspacePath: info.workspacePath };
  }


  protected async verifyNativeStart(
    request: HarnessStartRequest,
    native: boolean,
    started: StartedHarnessRun,
  ): Promise<void> {
    if (!native) return;
    const safe = await this.verifyExposure(
      started.workspacePath,
      request.provider as NativeHarnessProvider,
      started.runtimePath,
      request.writeEnabled,
    );
    if (safe) return;
    await this.removeRunRuntime(started.runId);
    throw new Error("The native harness exposure failed its sandbox self-test.");
  }


  protected outputRedactor(privacyMode: PrivacyMode): StreamRedactor | null {
    const outputPolicy = privacyMode === "cloud-direct" ? null : this.policy();
    return outputPolicy?.redactor.stream(emptyPrivacyReport()) ?? null;
  }


  protected recordTerminalEvent(state: PumpState, event: HarnessEvent): boolean {
    if (event.type !== "run_completed" && event.type !== "run_failed") return false;
    state.terminal = event;
    return true;
  }


  protected emitVisibleEvent(
    runId: string,
    state: PumpState,
    event: HarnessEvent,
    redactor: StreamRedactor | null,
  ): void {
    if (event.type === "text_delta") state.lastTextEvent = event;
    const visible = redactHarnessTextDelta(event, redactor);
    if (visible !== null) this.emit("harness-event", visible);
  }


  protected flushOutputRedactor(runId: string, state: PumpState, redactor: StreamRedactor | null): void {
    const tail = redactor?.flush() ?? "";
    if (tail === "") return;
    this.emit("harness-event", state.lastTextEvent === null
      ? { type: "text_delta", runId, text: tail }
      : { ...state.lastTextEvent, text: tail });
  }


  protected async completePump(runId: string, state: PumpState, redactor: StreamRedactor | null): Promise<void> {
    try {
      this.flushOutputRedactor(runId, state, redactor);
    } finally {
      await this.removeRunRuntime(runId);
      this.pumps.delete(runId);
    }
  }


  protected async pumpEvents(
    runId: string,
    started: { events: AsyncIterable<HarnessEvent> },
    orchestrator: HarnessOrchestrator,
    redactor: StreamRedactor | null,
  ): Promise<void> {
    const state: PumpState = { terminal: null, lastTextEvent: null };
    try {
      for await (const event of started.events) {
        if (event.type === "run_started") orchestrator.recordHarness(runId, event.harness);
        if (this.recordTerminalEvent(state, event)) continue;
        this.emitVisibleEvent(runId, state, event, redactor);
      }
    } finally {
      await this.completePump(runId, state, redactor);
    }
    if (state.terminal !== null) this.emit("harness-event", state.terminal);
  }


  protected async startWithOrchestrator(
    request: HarnessStartRequest,
    selectedModel: string,
    started: StartedHarnessRun,
    orchestrator: HarnessOrchestrator,
  ): Promise<string> {
    try {
      const redactor = this.outputRedactor(request.privacyMode);
      const run = await orchestrator.start({
        ...request,
        model: selectedModel,
        runId: started.runId,
        roomId: started.room.descriptor.roomId,
        workspacePath: started.workspacePath,
        runtimePath: started.runtimePath,
        exposureVerified: true,
      });
      const pump = this.pumpEvents(started.runId, run, orchestrator, redactor);
      this.pumps.set(started.runId, pump);
      return started.runId;
    } catch (error) {
      await this.removeRunRuntime(started.runId);
      throw error;
    }
  }


  async start(request: HarnessStartRequest): Promise<string> {
    this.ensureUnifiedHarnessEnabled();
    const selected = await this.selectedHarnessModel(request);
    const room = await this.validateStartRequest(request, selected.native, selected.model);
    const created = this.createStartedRun(room);
    const started = await this.prepareRunWorkspace(request, created);
    await this.verifyNativeStart(request, selected.native, started);
    const orchestrator = this.ensureOrchestrator();
    return this.startWithOrchestrator(request, selected.model, started, orchestrator);
  }

  approve(runId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    if (requestId === `mass-change-${runId}`) {
      const pending = this.pendingSafetyApprovals.get(runId);
      if (pending === undefined) throw new Error("That mass-change approval is no longer pending.");
      pending.resolve(decision === "allow-once" || decision === "allow-run");
      return Promise.resolve();
    }
    if (this.orchestrator === null) throw new Error("No harness run is active.");
    return this.orchestrator.approve(runId, requestId, decision);
  }


  async cancel(runId: string): Promise<void> {
    this.pendingMirrorApprovals.get(runId)?.resolve(false);
    this.pendingSafetyApprovals.get(runId)?.resolve(false);
    await this.orchestrator?.cancel(runId);
  }


  approveCloudWriteback(runId: string, approved: boolean): void {
    const pending = this.pendingMirrorApprovals.get(runId);
    if (pending === undefined) throw new Error("That cloud write-back approval is no longer pending.");
    pending.resolve(approved);
  }


  rollback(runId: string): Promise<RollbackResult> {
    return this.ensureOrchestrator().rollback(runId);
  }


  restoreBaselineAsCopies(runId: string, paths: string[]): Promise<string[]> {
    return this.ensureOrchestrator().restoreBaselineAsCopies(runId, paths);
  }


  listHistory(): Promise<HarnessHistoryRun[]> {
    const room = this.state.room;
    if (room?.workspace === undefined || room.descriptor?.kind !== "workspace-folder") {
      return Promise.resolve([]);
    }
    // `runRoots` includes the baseline/runtime preparation window before the
    // orchestrator marks a run active. A concurrent refresh must not recover
    // that genuinely live row as interrupted.
    return this.ensureOrchestrator().listHistory(
      [...this.runRoots.keys()],
      room.readOnly !== true,
    );
  }


  async stopAll(timeoutMs = 10_000): Promise<void> {
    const ids = this.orchestrator?.activeRunIds() ?? [];
    await Promise.allSettled(ids.map((id) => this.cancel(id)));
    const pumps = [...this.pumps.values()];
    if (pumps.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pumps),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    await Promise.allSettled([...this.runRoots.keys()].map((id) => this.removeRunRuntime(id)));
  }


  /** Forced synchronous teardown: signal providers and remove cloud exposure now. */
  stopAllNoWait(): void {
    for (const id of this.orchestrator?.activeRunIds() ?? []) {
      this.pendingMirrorApprovals.get(id)?.resolve(false);
      this.pendingSafetyApprovals.get(id)?.resolve(false);
      void this.orchestrator?.cancel(id).catch(() => undefined);
    }
    for (const id of this.runRoots.keys()) void this.removeRunRuntime(id).catch(() => undefined);
  }


  cleanupAbandoned(): Promise<number> {
    // No run survives an app process restart, so every existing run folder is
    // abandoned regardless of age.
    return CloudRedactedMirror.cleanupAbandoned(this.runtimeRoot(), 0);
  }


  protected awaitMirrorApproval(runId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingMirrorApprovals.set(runId, { resolve });
    });
  }


  protected emitMirrorChanges(
    runId: string,
    updated: string[],
    created: string[],
    send: (event: HarnessEvent) => void,
  ): void {
    for (const relativePath of [...updated, ...created]) {
      send({
        type: "file_changed",
        runId,
        relativePath,
        change: created.includes(relativePath) ? "created" : "modified",
      });
    }
  }


  protected async writeBackMirror(
    runId: string,
    entry: MirrorRun,
    send: (event: HarnessEvent) => void,
  ): Promise<HarnessFinalStatus> {
    let result = await entry.mirror.writeBack(false);
    if (result.requiresReview.length > 0) {
      send({
        type: "approval_requested",
        runId,
        requestId: `cloud-writeback-${runId}`,
        tool: "cloud_writeback",
        detail: "Cloud output duplicated protected placeholders. Review is required before applying it.",
      });
      const approved = await this.awaitMirrorApproval(runId);
      this.pendingMirrorApprovals.delete(runId);
      if (!approved) {
        return "cancelled";
      }
      result = await entry.mirror.writeBack(true);
    }
    this.emitMirrorChanges(runId, result.updated, result.created, send);
    return "completed";
  }


  protected async finishMirror(
    runId: string,
    status: HarnessFinalStatus,
    send: (event: HarnessEvent) => void,
  ): Promise<HarnessFinalStatus> {
    const entry = this.mirrors.get(runId);
    if (entry === undefined) return status;
    try {
      if (status !== "completed" || !entry.writeEnabled) return status;
      return this.writeBackMirror(runId, entry, send);
    } finally {
      this.pendingMirrorApprovals.delete(runId);
      await this.removeMirror(runId);
    }
  }


  protected async reviewMassChanges(
    protection: RunProtection,
    runId: string,
    status: HarnessFinalStatus,
    send: (event: HarnessEvent) => void,
  ): Promise<HarnessFinalStatus> {
    // Reconciliation is also the authoritative change detector when provider
    // hooks miss a write. Publish its stable file ids to the renderer before
    // the terminal event, so an open viewer (especially an autosaving Sketch)
    // reloads the bytes the agent actually left on disk. Failed/cancelled runs
    // may leave reviewable changes too, so they need the same refresh.
    const summary = await protection.captureFinalState(runId);
    if (status !== "completed" || summary.count <= 20) {
      this.refreshChangedFiles(summary);
      return status;
    }
    send({
      type: "approval_requested",
      runId,
      requestId: `mass-change-${runId}`,
      tool: "workspace_mass_change",
      detail: `The agent changed ${summary.count} files. Approve to keep them, or deny to restore the protected baseline.`,
    });
    const approved = await new Promise<boolean>((resolve) => {
      this.pendingSafetyApprovals.set(runId, { resolve });
    });
    this.pendingSafetyApprovals.delete(runId);
    if (approved) {
      this.refreshChangedFiles(summary);
      return status;
    }
    await protection.rollback(runId);
    this.refreshChangedFiles(summary);
    return "cancelled";
  }


  protected refreshChangedFiles(summary: RunChangeSummary): void {
    if (summary.count === 0) return;
    const room = this.state.room;
    if (room?.workspace === undefined) return;
    this.emit("room-files-changed", undefined);
    const present = room.workspace.db.prepare(
      "SELECT 1 FROM files WHERE id = ? AND trashed_at IS NULL",
    );
    for (const change of summary.changedFiles) {
      // Deleted files have no content to reload. After a denied mass-change,
      // this same check naturally includes restored baseline files and skips
      // newly-created files that rollback moved to Arcelle trash.
      if (present.get(change.fileId) !== undefined) {
        this.emit("file-updated", change.fileId);
      }
    }
  }


  protected async removeMirror(runId: string): Promise<void> {
    const entry = this.mirrors.get(runId);
    this.mirrors.delete(runId);
    if (entry !== undefined) await entry.mirror.cleanup();
  }


  protected async removeRunRuntime(runId: string): Promise<void> {
    this.pendingSafetyApprovals.delete(runId);
    const runRoot = this.runRoots.get(runId);
    this.runRoots.delete(runId);
    if (this.mirrors.has(runId)) await this.removeMirror(runId);
    else if (runRoot !== undefined) {
      // macOS can briefly report ENOTEMPTY while a just-exited provider's file
      // descriptors settle. Node only retries recursive removal when
      // maxRetries is explicit; keep this bounded and local to the per-run
      // directory rather than leaking a transient cleanup race to the UI.
      await rm(runRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  }
}
