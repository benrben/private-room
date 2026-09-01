/**
 * THE SPEAKER-AWARE WHOLE-FILE TRANSCRIPTION JOB — one lane for every route
 * into it (the explicit `rec_retranscribe` button, an imported media file, a
 * downloaded one, a trimmed clip, chat's paste-a-recording path).
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 *
 * `speechSttSurfaceIpc.ts::retranscribeFile` — this module's text-only
 * ancestor — POSTs `/stt/transcribe_file` and writes the flat string it gets
 * back into `files.extracted_text`. That is the whole of it. Two consequences
 * followed, and both were invisible:
 *
 *   1. NO SPEAKERS. `/stt/transcribe_file` runs Whisper alone; the diarizing
 *      pipeline (VAD phrasing, per-phrase voiceprints, one whole-file
 *      `split_by_voice`, saved-voice recognition) lives in the sidecar's
 *      `rec/engine.py::retranscribe` and had no HTTP route. So every imported
 *      or downloaded recording was speakerless forever, and Settings → Saved
 *      voices had nothing to learn from.
 *   2. NO `recordings` ROW, therefore THE WRONG VIEWER — permanently.
 *      `fileRuntimeSurfaceIpc.ts` picks the viewer by DATA, not by extension:
 *      `getRecMeta(conn, id) !== null ? "recording" : viewerKind(name, mime)`.
 *      A file with flat extracted text and no meta row can only ever open in
 *      the plain `AudioView`, whose transcript is a regex parse of that text.
 *
 * So the fix is not a new component and not a new viewer: it is WRITING THE
 * `recordings` ROW. `setRecMeta` is the hinge — the same file then opens in
 * the full speaker-aware `RecordingView` (speaker chips, click-to-rename,
 * saved-voice teaching, waveform lanes) with no renderer change at all.
 *
 * THE ROW IS WRITTEN FOR AUDIO ONLY. `RecordingView` has no <video> element,
 * so giving a video that row would trade its PICTURE for speaker chips: a
 * downloaded talk would keep its sound and silently lose its image. A video
 * therefore keeps its own viewer and still gains the diarized transcript,
 * because `transcriptText` renders `"[m:ss] Speaker 2: …"` — the exact shape
 * `AudioView` already parses back into per-line speaker labels. Chips for
 * video need a viewer that shows both, which this wave does not build.
 *
 * ============================================================================
 * WHAT IT PERSISTS, AND WHY BOTH
 * ============================================================================
 *
 * `recordings.meta`   — the structure: segments, word timings, speaker labels,
 *                       cuts. This is what `RecordingView` draws.
 * `files.extracted_text` — the SAME transcript rendered by
 *                       {@link transcriptText} as `"[m:ss] Who: text"`. This is
 *                       the only path by which speaker labels reach search,
 *                       RAG and every AI action; the meta blob is not indexed.
 *
 * Writing one without the other is the exact corruption the old
 * `rec_retranscribe` override shipped: flat text over a stale meta, orphaning
 * every segment, speaker, word, cut and note the screen was still drawing
 * from. They go in one transaction here for that reason.
 *
 * ============================================================================
 * DECIDED FAILURE BEHAVIOUR (every I/O path, stated rather than discovered)
 * ============================================================================
 *
 *  - NOT A MEDIA FILE / no room open / no such file  -> `null`, no event. The
 *    caller decides what that means; `retranscribe_file` turns it into a real
 *    refusal, the import path ignores it.
 *  - NO SPEECH MODEL                -> `stt-progress` `"model-missing"`, `null`.
 *  - NO DIARIZE MODEL               -> RUN ANYWAY, degraded, and say so in the
 *    log. A transcript with one speaker beats no transcript; but voiceprints
 *    fall back to a 21-dim DSP embedding that `identityPrint` (192 dims)
 *    rejects, so saved-voice enrolment silently cannot work on the result.
 *    That is worth a log line, not a refusal.
 *  - SIDECAR REFUSAL / TRUNCATED STREAM / STOPPED -> `stt-progress`
 *    `"failed: …"`, `null`, and NOTHING is written: the stored transcript is
 *    exactly as it was.
 *  - ROOM CLOSED, SWAPPED OR ROLLED BACK WHILE RUNNING -> refuse the write. A
 *    rebuild that started in room A must never land in room B — and a
 *    checkpoint rollback REOPENS THE SAME PATH over a different database, so
 *    the room epoch is pinned alongside the path.
 *  - UNREADABLE PRIOR META          -> rebuild from an empty one rather than
 *    refuse. `recBridge.ts::unreadableMeta` tells the user in as many words to
 *    "rebuild the transcript from the audio"; refusing to do that because the
 *    unreadable blob is unreadable would make the app's own advice
 *    unfollowable. The blob is snapshotted into History first, so it is not
 *    lost.
 *  - This function NEVER THROWS. Every caller is either fire-and-forget or
 *    wants to branch on `null` itself.
 *
 * ============================================================================
 * WHAT THE WIRE CANNOT CARRY, AND WHO RESTORES IT
 * ============================================================================
 *
 * `POST /rec/retranscribe` takes a REDUCED prior — `{speakerNames, recognized}`
 * plus a top-level `maxSpeakers` — not a whole `RecMeta`. But
 * `rec/engine.py::retranscribe` documents that the old meta's `cuts`,
 * `chapters`, `highlights` and `notes` SURVIVE a rebuild (the audio is
 * unchanged, so every time they are anchored on is still exactly true), and it
 * implements that by deep-copying them off the prior it was handed. Handed a
 * reduced prior, it can only copy empty lists back.
 *
 * So this module carries those four forward from the STORED meta itself, read
 * fresh at write time. That is not a guess: it is the same value the sidecar
 * would have copied had the wire carried it. Without this, pressing
 * "Transcribe again" on a recording with studio cuts and typed notes would
 * silently delete them. `readOf` deliberately does NOT survive — the
 * transcript is being rewritten, so the room's reading of it is stale by
 * definition (`retranscribe`'s own docstring).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { getFileFull, inTransaction, setFileExtractedText } from "./db-host/files.js";
import { getRecMeta, setRecMeta } from "./db-host/recordings.js";
import { knownVoices, type KnownVoice } from "./db-host/voices.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import * as obs from "./obs.js";
import { mediaKind, type MediaKind } from "./peaksTools.js";
import { beginRetranscribe, endRetranscribe, parseRecMeta } from "./recBridge.js";
import { defaultRecMeta, transcriptText, type RecMeta } from "./recFormat.js";
import type { RoomManagerState } from "./roomManager.js";
import { busy, ensureUp } from "./sidecar.js";
import { sttEffectiveModel } from "./sttTools.js";
import type { EventSender } from "./turn.js";
import type { VideoVisualIndexClient } from "./videoVisualIndex.js";
import {
  diarizeEffectiveModel,
  postRetranscribeStream,
  reconcileRebuilt,
  type StreamOutcome,
} from "./mediaRetranscriptionProtocol.js";

export * from "./mediaRetranscriptionProtocol.js";


// =============================================================================
// ---- the job ----------------------------------------------------------------
// =============================================================================

export interface MediaTranscribeDeps {
  state: RoomManagerState;
  userDataDir: string;
  resourcesPath: string | null;
  emit: EventSender;
  /** Best-effort re-index of the room the file belongs to, once its new
   * transcript is durable. Optional and swallowed, like every other
   * `onIndexed`/`notifyFilesChanged` seam in this tree. */
  onIndexed?: (roomPath: string) => void;
  /** Best-effort local derived-pixel cache. Called only for ordinary
   * workspace-backed videos, never for sealed/legacy embedded room blobs. */
  warmVisualIndex?: VideoVisualIndexClient["warm"];
}

async function warmWorkspaceVideoWithoutSpeechModel(
  open: NonNullable<RoomManagerState["room"]>,
  fileId: string,
  extension: string,
  sourceSha256: string,
  warm: VideoVisualIndexClient["warm"],
): Promise<void> {
  if (open.workspace === undefined) return;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "arcelle-visual-index-")).catch(() => null);
  if (tempDir === null) return;
  const staged = path.join(tempDir, `source.${extension || "bin"}`);
  try {
    await pipeline(
      open.workspace.readStream(fileId),
      fs.createWriteStream(staged, { flags: "wx", mode: 0o600 }),
    );
    await warm(staged, sourceSha256);
  } catch {
    // A derived visual cache is an acceleration. It must never turn a valid
    // import into a failed media job or weaken the ordinary renderer fallback.
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}


interface MediaTranscriptionSource {
  open: NonNullable<RoomManagerState["room"]>;
  epoch: number;
  name: string;
  bytes: Buffer | null;
  priorText: string | null;
  extension: string;
  kind: MediaKind;
}

interface PreparedTranscription {
  source: MediaTranscriptionSource;
  modelPath: string;
  diarizeModel: string | null;
  visualSourceSha256: string | null;
  tempDir: string;
}

type StagingReservation = { tempDir: string } | { reason: string };
type SidecarBase = { base: string } | { error: string };
type RebuildResult = { outcome: StreamOutcome; prior: RecMeta; priorJson: string | null } | { error: string };

function loadMediaTranscriptionSource(state: RoomManagerState, fileId: string): MediaTranscriptionSource | null {
  const open = state.room;
  if (open === null) return null;
  const epoch = state.roomEpoch;
  let name: string;
  let mime: string;
  let bytes: Buffer | null;
  let priorText: string | null;
  try {
    const [rowName, rowMime, rowBytes, rowText] = getFileFull(open.conn, fileId);
    name = rowName;
    mime = rowMime ?? "application/octet-stream";
    bytes = rowBytes;
    priorText = rowText;
  } catch {
    return null;
  }
  const extension = path.extname(name).slice(1).toLowerCase();
  const kind = mediaKind(mime, extension);
  if (kind === null) return null;
  return { open, epoch, name, bytes, priorText, extension, kind };
}

function transcriptionFailure(deps: MediaTranscribeDeps, name: string, reason: string): null {
  deps.emit("stt-progress", [name, `failed: ${reason}`]);
  return null;
}

function workspaceVideoSha256(source: MediaTranscriptionSource, fileId: string): string | null {
  if (source.kind !== "video" || source.open.workspace === undefined) return null;
  return (source.open.conn.prepare(
    `SELECT content_sha256 FROM files
     WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL`,
  ).get(fileId) as { content_sha256: string | null } | undefined)?.content_sha256 ?? null;
}

async function warmVideoWithoutSpeechModel(
  deps: MediaTranscribeDeps,
  source: MediaTranscriptionSource,
  fileId: string,
  sourceSha256: string | null,
): Promise<void> {
  if (sourceSha256 === null || source.open.workspace === undefined || deps.warmVisualIndex === undefined) return;
  await warmWorkspaceVideoWithoutSpeechModel(
    source.open,
    fileId,
    source.extension,
    sourceSha256,
    deps.warmVisualIndex,
  );
}

function warnMissingDiarizeModel(diarizeModel: string | null, fileId: string): void {
  if (diarizeModel === null) {
    obs.warn("rec.retranscribe.no_diarize_model", [["file", obs.id(fileId)]]);
  }
}

async function reserveTranscriptionStaging(fileId: string): Promise<StagingReservation> {
  if (!beginRetranscribe(fileId)) return { reason: "this recording is already being re-transcribed" };
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "arcelle-stt-")).catch(() => null);
  if (tempDir === null) {
    endRetranscribe(fileId);
    return { reason: "a private staging folder could not be created" };
  }
  return { tempDir };
}

async function prepareTranscription(
  deps: MediaTranscribeDeps,
  source: MediaTranscriptionSource,
  fileId: string,
): Promise<PreparedTranscription | null> {
  if (source.bytes === null && source.open.workspace === undefined) {
    return transcriptionFailure(deps, source.name, "this recording has no stored audio");
  }
  const visualSourceSha256 = workspaceVideoSha256(source, fileId);
  const modelPath = sttEffectiveModel(deps.userDataDir, deps.resourcesPath);
  if (modelPath === null) {
    await warmVideoWithoutSpeechModel(deps, source, fileId, visualSourceSha256);
    deps.emit("stt-progress", [source.name, "model-missing"]);
    return null;
  }
  const diarizeModel = diarizeEffectiveModel(deps.userDataDir, deps.resourcesPath);
  warnMissingDiarizeModel(diarizeModel, fileId);
  const reservation = await reserveTranscriptionStaging(fileId);
  if ("reason" in reservation) return transcriptionFailure(deps, source.name, reservation.reason);
  return { source, modelPath, diarizeModel, visualSourceSha256, tempDir: reservation.tempDir };
}

async function stageTranscriptionSource(prepared: PreparedTranscription, fileId: string): Promise<string> {
  const staged = path.join(prepared.tempDir, `source.${prepared.source.extension || "bin"}`);
  if (prepared.source.open.workspace === undefined) {
    await fs.promises.writeFile(staged, prepared.source.bytes!, { mode: 0o600 });
  } else {
    await pipeline(
      prepared.source.open.workspace.readStream(fileId),
      fs.createWriteStream(staged, { flags: "wx", mode: 0o600 }),
    );
  }
  return staged;
}

async function warmStagedVideo(prepared: PreparedTranscription, staged: string, deps: MediaTranscribeDeps): Promise<void> {
  if (
    prepared.visualSourceSha256 !== null
    && prepared.source.open.workspace !== undefined
    && deps.warmVisualIndex !== undefined
  ) {
    await deps.warmVisualIndex(staged, prepared.visualSourceSha256).catch(() => null);
  }
}

function priorRecordingMeta(conn: NonNullable<RoomManagerState["room"]>["conn"], fileId: string): { prior: RecMeta; priorJson: string | null } {
  const priorJson = getRecMeta(conn, fileId);
  try {
    return { prior: parseRecMeta(priorJson), priorJson };
  } catch (err) {
    obs.warn("rec.retranscribe.unreadable_prior", [
      ["file", obs.id(fileId)],
      ["err", obs.errKind(err instanceof Error ? err.message : String(err))],
    ]);
    return { prior: defaultRecMeta(), priorJson };
  }
}

function roomKnownVoices(conn: NonNullable<RoomManagerState["room"]>["conn"]): KnownVoice[] {
  try {
    return knownVoices(conn);
  } catch {
    return [];
  }
}

async function sidecarBase(): Promise<SidecarBase> {
  try {
    return { base: await ensureUp() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function retranscribeRequest(
  staged: string,
  prepared: PreparedTranscription,
  prior: RecMeta,
  priorJson: string | null,
  known: KnownVoice[],
): Record<string, unknown> {
  return {
    filePath: staged,
    modelPath: prepared.modelPath,
    diarizeModelPath: prepared.diarizeModel,
    kind: prepared.source.kind,
    maxSpeakers: prior.maxSpeakers,
    knownVoices: known,
    prior: priorJson === null
      ? null
      : { speakerNames: prior.speakerNames, recognized: prior.recognized, cuts: prior.cuts },
  };
}

async function requestRebuild(
  deps: MediaTranscribeDeps,
  prepared: PreparedTranscription,
  fileId: string,
  staged: string,
): Promise<RebuildResult> {
  const { prior, priorJson } = priorRecordingMeta(prepared.source.open.conn, fileId);
  const known = roomKnownVoices(prepared.source.open.conn);
  deps.emit("stt-progress", [prepared.source.name, "started"]);
  const server = await sidecarBase();
  if ("error" in server) return server;
  let sawProgress = false;
  const guard = busy();
  try {
    const outcome = await postRetranscribeStream(
      server.base,
      retranscribeRequest(staged, prepared, prior, priorJson, known),
      (doneCs, totalCs) => {
        deps.emit("rec-retranscribe", { fileId, doneCs, totalCs });
        if (!sawProgress) {
          sawProgress = true;
          deps.emit("stt-progress", [prepared.source.name, "processing"]);
        }
      },
    );
    return { outcome, prior, priorJson };
  } finally {
    guard.release();
  }
}

function rebuildFailure(outcome: Exclude<StreamOutcome, { kind: "done" }>): string {
  if (outcome.kind === "stopped") return "the rebuild was stopped before it finished — nothing was changed";
  return outcome.error;
}

function warnNonNeuralDiarization(diarizeModel: string | null, outcome: StreamOutcome, fileId: string): void {
  if (diarizeModel !== null && outcome.kind === "done" && !outcome.neural) {
    obs.warn("rec.retranscribe.diarize_not_neural", [["file", obs.id(fileId)]]);
  }
}

function currentSourceRoom(deps: MediaTranscribeDeps, source: MediaTranscriptionSource): NonNullable<RoomManagerState["room"]> | null {
  const now = deps.state.room;
  if (now === null || now.path !== source.open.path || deps.state.roomEpoch !== source.epoch) return null;
  return now;
}

function storedRecordingMeta(
  conn: NonNullable<RoomManagerState["room"]>["conn"],
  fileId: string,
  prior: RecMeta,
): RecMeta {
  try {
    return parseRecMeta(getRecMeta(conn, fileId));
  } catch {
    return prior;
  }
}

async function snapshotWorkspaceTranscript(
  now: NonNullable<RoomManagerState["room"]>,
  fileId: string,
  replacing: boolean,
): Promise<void> {
  if (replacing && now.workspace !== undefined) {
    await now.workspace.snapshotVersion(fileId, "Re-transcribed").catch(() => undefined);
  }
}

function persistTranscript(
  now: NonNullable<RoomManagerState["room"]>,
  fileId: string,
  text: string,
  meta: RecMeta,
  replacing: boolean,
  kind: MediaKind,
): void {
  inTransaction(now.conn, () => {
    if (replacing && now.workspace === undefined) {
      snapshotFileVersion(now.conn, fileId, "Re-transcribed");
    }
    setFileExtractedText(now.conn, fileId, text);
    if (kind === "audio") setRecMeta(now.conn, fileId, JSON.stringify(meta));
  });
}

function emitTranscriptionCompletion(
  deps: MediaTranscribeDeps,
  source: MediaTranscriptionSource,
  fileId: string,
  meta: RecMeta,
  roomPath: string,
): void {
  deps.emit("rec-retranscribe", { fileId, doneCs: meta.durationCs, totalCs: meta.durationCs });
  deps.emit("file-updated", fileId);
  deps.emit("room-files-changed", {});
  try {
    deps.onIndexed?.(roomPath);
  } catch {
    // Best-effort, like every other `onIndexed` call site.
  }
  deps.emit("stt-progress", [source.name, meta.segments.length === 0 ? "none" : "done"]);
}

async function persistRebuiltTranscript(
  deps: MediaTranscribeDeps,
  prepared: PreparedTranscription,
  fileId: string,
  now: NonNullable<RoomManagerState["room"]>,
  rebuilt: RecMeta,
  prior: RecMeta,
  priorJson: string | null,
): Promise<RecMeta> {
  const stored = storedRecordingMeta(now.conn, fileId, prior);
  const meta = reconcileRebuilt(rebuilt, stored, prior.speakerNames);
  const text = transcriptText(meta, priorJson === null ? "(transcribed from recording)" : undefined);
  const replacing = priorJson !== null || (prepared.source.priorText ?? "").trim() !== "";
  await snapshotWorkspaceTranscript(now, fileId, replacing);
  persistTranscript(now, fileId, text, meta, replacing, prepared.source.kind);
  emitTranscriptionCompletion(deps, prepared.source, fileId, meta, now.path);
  return meta;
}

async function runPreparedTranscription(
  deps: MediaTranscribeDeps,
  prepared: PreparedTranscription,
  fileId: string,
): Promise<RecMeta | null> {
  try {
    const staged = await stageTranscriptionSource(prepared, fileId);
    await warmStagedVideo(prepared, staged, deps);
    const rebuild = await requestRebuild(deps, prepared, fileId, staged);
    if ("error" in rebuild) return transcriptionFailure(deps, prepared.source.name, rebuild.error);
    if (rebuild.outcome.kind !== "done") {
      return transcriptionFailure(deps, prepared.source.name, rebuildFailure(rebuild.outcome));
    }
    warnNonNeuralDiarization(prepared.diarizeModel, rebuild.outcome, fileId);
    const now = currentSourceRoom(deps, prepared.source);
    if (now === null) return transcriptionFailure(deps, prepared.source.name, "the room was closed while the transcript was being rebuilt");
    return persistRebuiltTranscript(deps, prepared, fileId, now, rebuild.outcome.meta, rebuild.prior, rebuild.priorJson);
  } catch (err) {
    return transcriptionFailure(deps, prepared.source.name, err instanceof Error ? err.message : String(err));
  } finally {
    endRetranscribe(fileId);
    await fs.promises.rm(prepared.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Transcribe one media file WITH SPEAKERS and persist both halves of the
 * result. The single entry point; see this module's header for the contract,
 * the persistence rules and the decided failure behaviour.
 *
 * Returns the rebuilt meta on success and `null` on every refusal. It never
 * throws: `rec_retranscribe` wants to turn `null` into a message its toast can
 * show, the import path wants to ignore it, and a rejected promise crossing
 * IPC would give both the same opaque string.
 */
export async function transcribeMediaWithSpeakers(
  deps: MediaTranscribeDeps,
  fileId: string,
): Promise<RecMeta | null> {
  const source = loadMediaTranscriptionSource(deps.state, fileId);
  if (source === null) return null;
  const prepared = await prepareTranscription(deps, source, fileId);
  if (prepared === null) return null;
  return runPreparedTranscription(deps, prepared, fileId);
}
