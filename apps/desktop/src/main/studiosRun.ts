/** Cohesive extraction from studiosCmds.ts; its public API remains on that module. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { Artifact, type Written } from "./artifactBuilder.js";
import {
  childOfRun,
  forget,
  guardCommit,
  remember,
  type CancelFlag,
  type CancelState,
  type GuardResult,
  type Node as CancelNode,
} from "./cancel.js";
import {
  fileNamesHint,
  findFileLike,
  getFileExtractedText,
  getFileName,
  listFiles,
  type FileMeta,
} from "./db-host/files.js";
import { titleFromName } from "./docsHtml.js";
import { byteLength } from "./extractionWindow.js";
import { listModels as listModelsReal } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { jsonStrField } from "./jsonTools.js";
import * as obs from "./obs.js";
import { chatStructured as chatStructuredReal } from "./ollamaGenerate.js";
import { bestLocalDefault, KEEP_ALIVE_WARM } from "./ollamaModels.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { clampBytes } from "./textClamp.js";
import { declaredFor } from "./capabilities.js";
import { isExternalEngine, ROLLBACK_BUSY } from "./turnContext.js";
import { isSummaryFile } from "./summarizeTools.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import { readRoomFile } from "./workspace/roomContent.js";
import { generateStudioHtml, registerStudioCancel, resolveStructuredModel, studioInstruction } from "./studiosModels.js";
import { EmitFn, NO_ROOM_OPEN, ROOM_CLOSED, RoomHandle, RoomSource, emitSafely, errMessage, fillTemplate, gatherFilesText, gatherScopeText, safeScopeName, saveAndOpen } from "./studiosScope.js";
// ============================================================================
// the shared studio pipeline
// ============================================================================

/**
 * The per-artifact differences between the Studio generators (flashcards,
 * mind map, podcast script). Everything else — cancel wiring, room-locked
 * text gathering, model resolution, the HTML-authoring primary path, the JSON
 * fallback, and save/open — is identical and lives in {@link runStudio}.
 * Field-for-field port of the Rust `StudioSpec` struct; see its own doc
 * comments there for what each carries.
 */
export interface StudioSpec {
  defaultPrompt: string;
  pageRole: string;
  workingLabel: string;
  fallbackStep: string | null;
  fallbackSchema: Record<string, unknown>;
  fallbackSystem: string;
  fallbackIntro: string;
  fallbackTemp: number;
  /** Parse the fallback JSON and render the built-in template. THROWS
   * (mirrors `Result<String,String>`) when the model returned nothing
   * usable. */
  render: (raw: string, label: string) => string;
  filenamePrefix: string;
  /** Only the podcast sets this — see the Rust source's own long comment on
   * why (turns must survive as DATA, and it is also the more reliable path
   * on a small model). */
  structuredFirst: boolean;
  /** Called after the artifact is saved, with (db, new file id, raw model
   * JSON). THROWS on failure — the caller treats that as best-effort and
   * only logs it. Only ever set together with `structuredFirst`. */
  afterSave?: (db: Database.Database, fileId: string, raw: string) => void;
}

/** `{warn: typeof obs.warn}` — `recRead.ts`'s own `RecReadLog`/`REAL_LOG`
 * shape, duplicated per that file's convention. */
export interface StudioLog {
  warn: typeof obs.warn;
}
export const REAL_LOG: StudioLog = obs;

/** Ask the model for this artifact's STRUCTURED shape (`spec.fallbackSchema`).
 * Ported verbatim from `studio_structured`. */
export async function studioStructured(
  model: string,
  spec: StudioSpec,
  instr: string,
  label: string,
  text: string,
  cancel: CancelFlag,
  chatStructuredFn: typeof chatStructuredReal
): Promise<string> {
  const messages: SidecarChatMessage[] = [
    { role: "system", content: spec.fallbackSystem },
    { role: "user", content: `${instr}\n\n${spec.fallbackIntro} "${label}":\n\n${text}` },
  ];
  return chatStructuredFn(model, messages, spec.fallbackTemp, KEEP_ALIVE_WARM, spec.fallbackSchema, { cancel });
}

export function checkGuard(g: GuardResult): void {
  if (!g.ok) {
    throw new Error(g.error);
  }
}

/** Everything {@link runStudio}/{@link runStudioCore} need beyond their own
 * arguments. */
export interface RunStudioDeps {
  rooms: RoomSource;
  cancelState: CancelState;
  emit?: EmitFn;
  /** Test seam for {@link resolveStructuredModel}'s underlying `list_models`
   * call. Defaults to the real `engineRouting.ts` implementation. */
  listModels?: () => Promise<string[]>;
  /** Test seam for the underlying structured model call — both the
   * HTML-authoring primary path and the JSON fallback/structured-first path
   * use it. Defaults to the real `chatStructured` (`ollamaGenerate.ts`). */
  chatStructured?: typeof chatStructuredReal;
  /** Wall-clock ceiling for one foreground Studio build. The model client
   * still receives the shared cancel flag, so timing out also stops its
   * network/CLI work and the final commit guard prevents a late write. */
  studioTimeoutMs?: number;
  /** Best-effort structured-storage failure log. Defaults to the real `obs`
   * sink (a no-op until `obs.init` has installed one). */
  log?: StudioLog;
}

/**
 * ADD-31/Owner replacement #3: register this operation's Stop flag as a CHILD
 * of `parentRun` (when one asked for this build), run the shared pipeline, and
 * dispose the node on every return path. Ported from `run_studio`, plus the
 * `dispose()` call this port's cancel-tree deviation requires — see this
 * module's own doc.
 */
export async function runStudio(
  deps: RunStudioDeps,
  spec: StudioSpec,
  scope: string | null,
  instructions: string | null,
  refs: readonly string[] | null,
  opId: string | null,
  parentRun: string | null
): Promise<FileMeta> {
  // Wave 3 (Idea 9): a Studio run writes a file at the end — don't start one
  // while a rollback is swapping the DB.
  if (deps.rooms.rollingBack?.() ?? false) {
    throw new Error(ROLLBACK_BUSY);
  }
  const node = registerStudioCancel(deps.cancelState, opId, parentRun, spec.filenamePrefix);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutMs = deps.studioTimeoutMs ?? 120_000;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        node.flag().store(true);
        reject(new Error("Studio timed out before an artifact was saved. Nothing was written; try again or use a faster model."));
      }, timeoutMs);
    });
    return await Promise.race([
      runStudioCore(deps, spec, scope, instructions, refs, node.flag(), null),
      timedOut,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    // `CancelGuard::drop` (commands.rs:481-495): remove the flat registration
    // on every exit path.
    if (opId !== null) {
      deps.cancelState.cancels.delete(opId);
      forget(deps.cancelState, opId);
    }
    // The cancel-tree deviation this module's own doc names: unlink the node
    // from its parent NOW, deterministically — Rust's `Weak` link decays on
    // its own once `_done`'s `Arc` drops; this port's strong link does not.
    node.dispose();
  }
}

/**
 * `run_studio`'s Tauri-command shape, curried over its `window`/`state`
 * equivalent — the ONE calling convention `studiosMindmap.ts`, `studiosPodcast
 * .ts` (and, transitively, `studiosFlashcards.ts`) each independently
 * predicted and built their own `studioMindmap`/`generatePodcastScript`/
 * `studioFlashcards` wrappers against, before this file existed (each one's
 * own module doc calls it "this port's best-effort prediction of that future
 * shared type's shape, so a `studios.rs` port can adopt [a spec's] return
 * value with no changes to this file"). {@link StudioSpec}/{@link
 * RunStudioFn}/{@link fillTemplate}/the three `STUDIO_*_PROMPT` constants now
 * live HERE, canonically — `studiosMindmap.ts`/`studiosPodcast.ts` import and
 * re-export them rather than keeping their own local predictions (see each
 * file's own updated module doc).
 */
export type RunStudioFn = (
  spec: StudioSpec,
  scope: string | null,
  instructions: string | null,
  refs: readonly string[] | null,
  opId: string | null,
  parentRun: string | null
) => Promise<FileMeta>;

/** Bind {@link runStudio} to one fixed `deps`, producing the curried
 * {@link RunStudioFn} shape `studioFlashcards`/`studioMindmap`/
 * `generatePodcastScript`'s own `runStudio` seam expects. The three still
 * default that seam to their own `runStudioNotImplemented` — deliberately
 * unchanged by this file: `deps` needs a real, live `RoomSource`/
 * `CancelState`, which only an app-wide host bootstrap can construct, exactly
 * like `execTool.ts`'s already-established `downloadJob`/`workflowRun` seams
 * for other job-queue-backed arms. Wiring `makeRunStudio(realDeps)` into
 * those three defaults is that future bootstrap's one-line job. */
export function makeRunStudio(deps: RunStudioDeps): RunStudioFn {
  return (spec, scope, instructions, refs, opId, parentRun) =>
    runStudio(deps, spec, scope, instructions, refs, opId, parentRun);
}

export interface StudioMaterial {
  label: string;
  text: string;
  hasRefs: boolean;
}

export interface StudioModel {
  name: string;
  local: boolean;
  chatStructured: typeof chatStructuredReal;
}

export interface StudioContent {
  content: string;
  structuredRaw: string | null;
}

export function studioRoom(rooms: RoomSource, roomPath: string | null): RoomHandle {
  const room = rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  if (roomPath !== null && room.path !== roomPath) {
    throw new Error(ROOM_CLOSED);
  }
  return room;
}

export function hasStudioRefs(refs: readonly string[] | null): refs is readonly string[] {
  return refs !== null && refs.length > 0;
}

export function studioMaterial(
  deps: RunStudioDeps,
  scope: string | null,
  refs: readonly string[] | null,
  roomPath: string | null
): StudioMaterial {
  const room = studioRoom(deps.rooms, roomPath);
  const hasRefs = hasStudioRefs(refs);
  const [label, text] = hasRefs ? gatherFilesText(room.db, refs) : gatherScopeText(room.db, scope, room.name);
  return { label, text, hasRefs };
}

export async function studioModel(deps: RunStudioDeps): Promise<StudioModel> {
  const name = await resolveStructuredModel(deps.rooms, deps.listModels ?? listModelsReal);
  if (name === null) {
    throw new Error("The local AI (Ollama) isn't running — start it and try again.");
  }
  return { name, local: declaredFor(name).local, chatStructured: deps.chatStructured ?? chatStructuredReal };
}

export function emitStudioModelStep(emit: EmitFn | undefined, spec: StudioSpec, local: boolean): void {
  emitSafely(emit, "studio-step", {
    step: local
      ? `${spec.workingLabel} — a local model can take a few minutes…`
      : `${spec.workingLabel} — your cloud AI is writing (content leaves this Mac)…`,
    local,
  });
}

export function stoppedStudioRun(cancel: CancelFlag): void {
  if (cancel.load()) {
    throw new Error("Stopped.");
  }
}

export async function structuredStudioContent(
  model: StudioModel,
  spec: StudioSpec,
  instr: string,
  material: StudioMaterial,
  cancel: CancelFlag
): Promise<StudioContent> {
  const raw = await studioStructured(model.name, spec, instr, material.label, material.text, cancel, model.chatStructured);
  checkGuard(guardCommit(cancel, "the studio page"));
  return { content: spec.render(raw, material.label), structuredRaw: raw };
}

export async function fallbackStudioContent(
  model: StudioModel,
  spec: StudioSpec,
  instr: string,
  material: StudioMaterial,
  cancel: CancelFlag,
  emit: EmitFn | undefined
): Promise<StudioContent> {
  stoppedStudioRun(cancel);
  if (spec.fallbackStep !== null) {
    emitSafely(emit, "studio-step", { step: spec.fallbackStep, local: true });
  }
  const raw = await studioStructured(model.name, spec, instr, material.label, material.text, cancel, model.chatStructured);
  stoppedStudioRun(cancel);
  return { content: spec.render(raw, material.label), structuredRaw: null };
}

export async function primaryStudioContent(
  deps: RunStudioDeps,
  model: StudioModel,
  spec: StudioSpec,
  instr: string,
  material: StudioMaterial,
  cancel: CancelFlag
): Promise<StudioContent> {
  const generated = await generateStudioHtml(
    model.name,
    spec.pageRole,
    instr,
    material.label,
    material.text,
    cancel,
    model.chatStructured
  );
  if (generated !== null) {
    stoppedStudioRun(cancel);
    return { content: generated, structuredRaw: null };
  }
  return fallbackStudioContent(model, spec, instr, material, cancel, deps.emit);
}

export function pinStudioWrite(rooms: RoomSource, roomPath: string | null): void {
  if (roomPath !== null) {
    const room = rooms.current();
    if (room === null || room.path !== roomPath) {
      throw new Error(ROOM_CLOSED);
    }
  }
}

export async function saveStudioArtifact(
  deps: RunStudioDeps,
  spec: StudioSpec,
  material: StudioMaterial,
  refs: readonly string[] | null,
  content: string,
  cancel: CancelFlag
): Promise<Written> {
  const name = `${spec.filenamePrefix} - ${safeScopeName(material.label)}.html`;
  let art = Artifact.new(name, "text/html", content).by(spec.filenamePrefix).cancelWith(cancel);
  if (material.hasRefs && refs !== null) {
    art = art.fromFiles(refs);
  }
  return saveAndOpen(deps.rooms, deps.emit, art);
}

export function warnStudioStructureFailure(deps: RunStudioDeps, spec: StudioSpec, error: unknown): void {
  (deps.log ?? REAL_LOG).warn("studio.structure_not_stored", [
    ["artifact", obs.id(spec.filenamePrefix)],
    ["error", obs.errKind(errMessage(error))],
  ]);
}

export function saveStudioStructure(
  deps: RunStudioDeps,
  spec: StudioSpec,
  meta: FileMeta,
  structuredRaw: string | null
): void {
  if (spec.afterSave === undefined || structuredRaw === null) {
    return;
  }
  try {
    const room = studioRoom(deps.rooms, null);
    spec.afterSave(room.db, meta.id, structuredRaw);
  } catch (error) {
    warnStudioStructureFailure(deps, spec, error);
  }
}

/**
 * The shared Studio pipeline, driven by an explicit `cancel` flag so a
 * background job's own flag can Stop it (a future job-runner batch's
 * territory; the foreground path above passes its chat-registry flag
 * instead). `roomPath`, when set, pins every room access: a job that runs for
 * minutes must not gather from — or write its result into — a room the user
 * swapped away from mid-run. Ported verbatim from `run_studio_core`.
 */
export async function runStudioCore(
  deps: RunStudioDeps,
  spec: StudioSpec,
  scope: string | null,
  instructions: string | null,
  refs: readonly string[] | null,
  cancel: CancelFlag,
  roomPath: string | null
): Promise<FileMeta> {
  const instr = studioInstruction(instructions, spec.defaultPrompt);
  emitSafely(deps.emit, "studio-step", { step: "Reading the material…", local: true });
  const material = studioMaterial(deps, scope, refs, roomPath);
  const model = await studioModel(deps);
  emitStudioModelStep(deps.emit, spec, model.local);
  const result = spec.structuredFirst
    ? await structuredStudioContent(model, spec, instr, material, cancel)
    : await primaryStudioContent(deps, model, spec, instr, material, cancel);
  pinStudioWrite(deps.rooms, roomPath);
  checkGuard(guardCommit(cancel, "the studio page"));
  const written = await saveStudioArtifact(deps, spec, material, refs, result.content, cancel);
  saveStudioStructure(deps, spec, written.meta, result.structuredRaw);
  return written.meta;
}
