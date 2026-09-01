/* Permanent ARC-001..030 Electron/renderer boundary contracts.
 *
 * These tests run in CI under `npm run test:page`.  They deliberately pin the
 * hand-off points between the real renderer, preload/API vocabulary, Electron
 * host, and deterministic live-Electron regression helper.  The deeper host
 * algorithms keep their exhaustive Vitest coverage; this file makes it
 * impossible to remove the user-visible/cross-process half while those unit
 * tests continue to pass in isolation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readReachableSource } from "../support/source-modules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

function has(relativePath, ...patterns) {
  const source = readReachableSource(relativePath);
  for (const pattern of patterns) {
    assert.match(source, pattern, `${relativePath} is missing ${pattern}`);
  }
}

function liveArc(id) {
  has("tests/support/arcLiveRegression.mjs", new RegExp(`ARC-${id}`));
  has("tests/e2e/desktop/electron-deep.mjs", /runArcLiveRegression/);
}

test("[ARC-001] canonical roster stays visible with disabled prerequisite rows", () => {
  has("services/agent-sidecar/src/arcelle_sidecar/agent_specialists.py", /def specialist_catalog\(/, /"capabilityReason"/, /"localHandoff"/);
  has("apps/desktop/src/renderer/workspace/ComposerPane.tsx", /aria-disabled=\{item\.disabled \|\| undefined\}/, /className=\{`ac-item/);
  liveArc("001");
});

test("[ARC-002] final-response redaction is provider-independent", () => {
  has("services/agent-sidecar/src/arcelle_sidecar/server_run.py", /policy\.output_redactor\(\)/, /redactor\.feed/);
  has("services/agent-sidecar/tests/test_server.py", /test_run_output_gate_redacts_local_final_and_unmapped_canary/);
});

test("[ARC-003] provider selection preserves and probes exact model IDs", () => {
  has("apps/desktop/src/main/providers.ts", /probeOpenrouterModelSelection/, /openrouterProbeRequest\(key, exactId\)/, /model,\s*messages:/, /max_tokens:\s*1/);
  has("apps/desktop/src/main/modelCatalogSurfaceIpc.ts", /createModelSelectionValidator/, /probeProviderModel\?\.\(exactId\)/);
});

test("[ARC-004] effective capabilities disable impossible cloud mutations", () => {
  has("apps/desktop/src/main/bridgeDispatcher.ts", /MIRROR_UNROUTED_WORKSPACE_MUTATIONS/, /view_media_frame/, /test_workflow/);
  has("apps/desktop/src/renderer/workspace/composer.ts", /capability === "unavailable"/, /localHandoff/);
});

test("[ARC-005] artifact success requires a readable mutation receipt", () => {
  has("apps/desktop/src/main/liveAppServices.ts", /createLiveStudioDeps/, /workspace/);
  has("apps/desktop/src/main/studiosCmds.ts", /ARCELLE_ARTIFACT_RECEIPT/, /Saved/);
  has("apps/desktop/src/main/execTool.ts", /const receipt = await execStudioFlashcards/, /effects\.wrote = true/);
  liveArc("005");
});

test("[ARC-006] no-tools requests cross the host with no room evidence", () => {
  has("apps/desktop/src/main/gatherContext.ts", /no-tools-no-sources/, /hardNoEvidence/, /sources:\s*\[\]/);
  liveArc("006");
});

test("[ARC-007] comparison claims remain scoped to per-file evidence", () => {
  has("apps/desktop/src/main/chatCommandsGenerate.ts", /verifiedComparisonClaims/, /normalizedEvidenceText/, /named source/);
  has("apps/desktop/src/main/chatCommandsGenerate.test.ts", /compares two files only from verified per-file quotes/);
});

test("[ARC-008] build and E2E release gates remain wired", () => {
  has(".github/workflows/ci.yml", /npm run build/, /npm run e2e/);
  has("package.json", /"build"/, /"e2e"/);
});

test("[ARC-009] Electron helper suite remains a release gate", () => {
  has(".github/workflows/ci.yml", /npm run test:electron/);
  has("package.json", /"test:electron"/);
});

test("[ARC-010] command failures persist as inline turn errors", () => {
  has("apps/desktop/src/main/db-host/messages.ts", /kind = 'turn_error'/);
  has("apps/desktop/src/renderer/workspace/ChatPane.tsx", /message\.kind === "turn_error"/, /is-turn-error/);
  liveArc("010");
});

test("[ARC-011] video interpretation carries the exact frame receipt", () => {
  has("apps/desktop/src/renderer/viewers/frameGrab.ts", /frameSha256/, /atSeconds/, /exact PNG attached to the model/);
  has("apps/desktop/src/main/execTool.ts", /MediaFrameReceipt/, /effects\.mediaFrames\.push\(result\.receipt\)/);
});

test("[ARC-012] extraction fields exclude source residue without truncating prose", () => {
  has("apps/desktop/src/main/chatCommandsKnowledge.ts", /extractFieldNames/, /fromClauses/, /const residue/);
  has("apps/desktop/src/main/chatCommandsKnowledge.test.ts", /revenue from subscriptions/, /findings\.md/);
});

test("[ARC-013] private workspace state is repaired to owner-only permissions", () => {
  has("apps/desktop/src/main/workspace/roomLayout.ts", /enforcePrivateDatabasePermissions/, /chmodSync\(dbPath, 0o600\)/);
  has("apps/desktop/src/main/workspace/hardeningAcceptance.test.ts", /owner-only/);
});

test("[ARC-014] visible file counters share the reconciled public inventory", () => {
  has("apps/desktop/src/renderer/Workspace.tsx", /fileCount=\{s\.files\.length\}/);
  has("apps/desktop/src/renderer/shell/StatusBar.tsx", /internal preview artifacts are not counted/);
  liveArc("014");
});

test("[ARC-015] PSD pixels use the initialized decoder path", () => {
  const worker = read("apps/desktop/src/renderer/viewers/rasterDecode.worker.ts");
  assert.ok(worker.indexOf("initializeCanvas(") >= 0);
  assert.ok(worker.indexOf("initializeCanvas(") < worker.indexOf("const psd = readPsd("));
});

test("[ARC-016] RAW previews enforce decoded 1000px durable output", () => {
  has("apps/desktop/src/main/rawPreview.ts", /MIN_RAW_PREVIEW_WIDTH = 1000/, /parsed\.width < minimumWidth/);
  has("apps/desktop/src/main/fileRuntimeSurfaceIpc.ts", /snapshotRawFallback/, /jpeg/, /metadata/);
  liveArc("016");
});

test("[ARC-017] package imports refuse atomically without residue", () => {
  has("apps/desktop/src/main/fileRuntimeSurfaceIpc.ts", /preflightImportPaths/, /\.numbers/, /\.rtfd/);
  liveArc("017");
});

test("[ARC-018] Office conversion remains consent-gated and durable", () => {
  has("apps/desktop/src/main/officeConvert.ts", /officeConvertible/, /OfficeConverter/);
  has("apps/desktop/src/main/fileRuntimeSurfaceIpc.ts", /officePdf/, /showMessageBox/);
});

test("[ARC-019] fallback previews expose persistent honest provenance", () => {
  has("apps/desktop/src/main/fileRuntimeSurfaceIpc.ts", /stored-snapshot/, /stored-preview/);
  has("apps/desktop/src/renderer/viewers/derivedPreviewStatus.ts", /Stored snapshot preview/, /Export saves the original file unchanged/);
  liveArc("019");
});

test("[ARC-020] MKV waveform fallback and FLAC transcription are wired", () => {
  has("apps/desktop/src/main/peaksTools.ts", /ffmpeg/, /-map/, /0:a:0/);
  has("apps/desktop/src/main/fileRuntimeSurfaceIpc.ts", /shouldAutoTranscribeImport/, /retranscribeImportedFile/);
});

test("[ARC-021] book and MSG warnings stay parser-specific", () => {
  has("apps/desktop/src/renderer/viewers/bookEncoding.ts", /utf-8/);
  has("apps/desktop/src/renderer/viewers/TextEncoding.tsx", /\.msg/, /structured OLE container/);
});

test("[ARC-022] compound archive names and public counts remain unambiguous", () => {
  has("apps/desktop/src/renderer/workspace/composer.ts", /\.tar\\\.\(\?:gz\|bz2\|xz\|zst\)/, /ambiguousDisplayNames/);
  has("apps/desktop/src/renderer/shell/StatusBar.tsx", /room file/);
  liveArc("022");
});

test("[ARC-023] Studio commits through the live workspace receipt path", () => {
  has("apps/desktop/src/main/liveAppServices.ts", /createLiveStudioDeps/, /commitToWorkspace/);
  has("apps/desktop/src/main/workspace/generatedOutputCutover.test.ts", /commits Studio artifacts to normal files/);
  liveArc("023");
});

test("[ARC-024] image-blind providers lose Video before dispatch", () => {
  has("apps/desktop/src/main/coreSurfaceIpc.ts", /imageChannel/, /view_media_frame/, /view_screenshot/);
  has("apps/desktop/src/main/coreSurfaceIpc.test.ts", /Antigravity/, /view_media_frame/);
});

test("[ARC-025] workflow mutation and validation obey effective privacy capability", () => {
  has("apps/desktop/src/main/bridgeDispatcher.ts", /save_workflow/, /test_workflow/, /Cloud Privacy/);
  has("apps/desktop/src/main/specialists.test.ts", /unavailable/);
});

test("[ARC-026] Skills inventory can exactly read cross-assigned drafts", () => {
  has("apps/desktop/src/main/execTool.ts", /skills\.use/, /skills\.author/, /listSkills/);
  has("apps/desktop/src/main/execTool.test.ts", /draft assigned to another specialist/);
  liveArc("026");
});

test("[ARC-027] re-transcription returns a durable terminal receipt", () => {
  has("apps/desktop/src/main/liveRuntimeTools.ts", /TRANSCRIPTION_RECEIPT/, /completed/, /no-speech/);
  has("apps/desktop/src/main/liveRuntimeTools.test.ts", /durable completion receipt/);
});

test("[ARC-028] Web Browse and Connector rows name exact prerequisites", () => {
  has("services/agent-sidecar/src/arcelle_sidecar/agent_specialists.py", /Turn on room internet/, /Install and enable a connector/);
  has("apps/desktop/src/renderer/workspace/composer.ts", /capabilityReason/, /disabled: sp\.capability === "unavailable"/);
  liveArc("028");
});

test("[ARC-029] Antigravity empty output gets one bounded diagnostic retry", () => {
  has("apps/desktop/src/main/externalAdvisor.ts", /antigravity-cli/, /const first = await runSuccessfulCli\(engine, runOnce\)/, /const retry = await runSuccessfulCli\(engine, runOnce\)/, /failed after one bounded retry/);
  has("apps/desktop/src/main/externalAdvisor.test.ts", /retries Antigravity once when it exits successfully without a terminal answer/);
});

test("[ARC-030] directly tagged specialists do not inherit unrelated sources", () => {
  has("apps/desktop/src/main/gatherContext.ts", /isDirectSpecialistQuestion/, /\[\], false/);
  has("apps/desktop/src/main/gatherContext.test.ts", /without unrelated ambient room sources/);
  liveArc("030");
});
