/**
 * Neural speech commands, and the routing half of the whole-file on-device
 * transcription lane.
 *
 * ============================================================================
 * THE `retranscribe_file` CHANNEL ROUTES; IT NO LONGER TRANSCRIBES
 * ============================================================================
 *
 * `AudioView`'s "Transcribe" button and the room's import sweep both land on
 * this channel. It used to call {@link retranscribeFile} unconditionally: one
 * `POST /stt/transcribe_file`, one flat string, one write into
 * `files.extracted_text`. That produced a transcript with NO SPEAKERS and no
 * `recordings` row — and because `fileRuntimeSurfaceIpc.ts` picks the viewer
 * by DATA (`getRecMeta(conn, id) !== null ? "recording" : viewerKind(…)`), a
 * file transcribed that way could never afterwards open in `RecordingView`.
 * The speaker-aware viewer was reachable only by recording INSIDE the app.
 *
 * Media now goes to `mediaTranscribeJob.ts::transcribeMediaWithSpeakers`,
 * which drives the sidecar's diarizing rebuild and writes `recordings.meta`
 * alongside the text. Nothing in the renderer changed: the same button, on the
 * same channel, now produces a file that opens with speaker chips you can
 * name. {@link retranscribeFile} stays for genuinely non-media files, whose
 * refusal sentence it owns, and for `liveRuntimeTools.ts`'s own seam.
 *
 * ============================================================================
 * A SILENT SUCCESS THAT WAS NOT ONE
 * ============================================================================
 *
 * {@link retranscribeFile} answers a missing speech model by emitting
 * `stt-progress` `"model-missing"` and RETURNING — so `await
 * api.retranscribeFile(id)` resolved, and every awaiting caller read that as
 * "transcribed". The viewer only noticed because it happens to branch on the
 * stage. {@link retranscribeFileRouted} keeps the event (the viewer's
 * "No speech model is installed" hint hangs off it) and then THROWS, so the
 * promise says what happened too.
 *
 * ============================================================================
 * A NOTE FOR WHOEVER READS `sttTools.ts` NEXT
 * ============================================================================
 *
 * That module's header still says "`server.py` mounts no `/transcribe` of any
 * kind (checked against the full route table)". That was already false —
 * `/stt/transcribe_file` is what {@link retranscribeFile} has been calling —
 * and `POST /rec/retranscribe` makes it doubly so. The claim is load-bearing
 * for its own scope argument, so it is flagged here rather than quietly
 * patched from a module that does not own it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { NeuralVoiceInfo } from "../shared/apiTypes.js";
import type { RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import { CancelFlag } from "./cancel.js";
import { getFileFull, getFileMeta, setFileExtractedText } from "./db-host/files.js";
import { setSetting } from "./db-host/settings.js";
import { transcribeMediaWithSpeakers, type MediaTranscribeDeps } from "./mediaTranscribeJob.js";
import { mediaKind } from "./peaksTools.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";
import { speakOne } from "./studiosPodcastAudio.js";
import { sttEffectiveModel } from "./sttTools.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function voice(value: unknown): NeuralVoiceInfo | null {
  const row = object(value);
  return typeof row.id === "string" && typeof row.gender === "string" && typeof row.locale === "string"
    ? { id: row.id, gender: row.gender, locale: row.locale }
    : null;
}

export function registerSpeechSttSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  userDataDir: string,
  resourcesPath: string | null,
  emit: EventSender,
  onIndexed?: (roomPath: string) => void,
): void {
  const room = () => {
    if (!state.room) throw new Error("No room is open.");
    return state.room;
  };
  ipcMain.handle("speak_text_neural", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const args = object(raw);
    return speakOne(
      room().conn,
      String(args.text ?? ""),
      typeof args.voice === "string" ? args.voice : undefined,
      undefined,
      undefined,
    );
  });
  ipcMain.handle("list_neural_voices", async (): Promise<NeuralVoiceInfo[]> => {
    const outcome = await sidecarJsonCancellable("/tts/voices", {}, new CancelFlag());
    if (outcome.kind === "stopped") throw new Error("Stopped.");
    if (outcome.kind === "error") throw new Error(outcome.error.error);
    const raw = object(outcome.value).voices;
    if (!Array.isArray(raw)) throw new Error("voice catalog returned no voices");
    const voices = raw.map(voice).filter((item): item is NeuralVoiceInfo => item !== null);
    if (state.room) {
      const ids = [
        ...voices.filter((item) => item.id.includes("Multilingual")),
        ...voices.filter((item) => !item.id.includes("Multilingual")),
      ].slice(0, 24).map((item) => item.id);
      if (ids.length) setSetting(state.room.conn, "voice_catalog_ids", ids.join(","));
    }
    return voices;
  });
  ipcMain.handle("retranscribe_file", (_event: IpcMainInvokeEvent, raw: unknown) =>
    retranscribeFileRouted(
      { state, userDataDir, resourcesPath, emit, onIndexed },
      String(object(raw).fileId ?? ""),
    ));
}

/**
 * `retranscribe_file`: send media to the speaker-aware job, everything else to
 * the text-only helper that owns the "this isn't audio or video" refusal.
 *
 * Media-ness is decided HERE, before either call, rather than by trying the
 * speaker-aware job and falling back on its `null`. `null` means "not media OR
 * the engine refused", and a fallback on the second case would run a second
 * full decode of a file that just failed one — minutes of work to reach the
 * same failure.
 *
 * DECIDED FAILURE BEHAVIOUR — this handler is awaited by a user who pressed a
 * button, so every way it declines to transcribe REJECTS:
 *   - no room / no such file  -> the DB read throws, unchanged;
 *   - no speech model         -> `stt-progress` `"model-missing"` (the stage
 *     the viewer's hint hangs off) AND a rejection naming where to fix it;
 *   - the job answered `null` -> a rejection. The job has already emitted a
 *     `"failed: …"` stage carrying the real reason, so this message says only
 *     the one thing the promise must not leave ambiguous: nothing changed.
 */
export async function retranscribeFileRouted(
  deps: MediaTranscribeDeps,
  fileId: string,
): Promise<void> {
  const open = deps.state.room;
  if (!open) throw new Error("No room is open.");
  // `getFileMeta`, not `getFileFull`: routing needs a name and a mime type,
  // and `getFileFull` would pull a whole video's bytes into memory to get them.
  const file = getFileMeta(open.conn, fileId);
  const extension = path.extname(file.name).slice(1).toLowerCase();
  if (mediaKind(file.mimeType, extension) === null) {
    await retranscribeFile(deps.state, deps.userDataDir, deps.resourcesPath, deps.emit, fileId, deps.onIndexed);
    return;
  }
  if (sttEffectiveModel(deps.userDataDir, deps.resourcesPath) === null) {
    // Checked here as well as inside the job because only this path has an
    // awaiting caller to be honest to; the job keeps its own check for the
    // import/download callers, which are fire-and-forget and read the stage.
    deps.emit("stt-progress", [file.name, "model-missing"]);
    throw new Error(
      "No speech model is installed, so nothing could be transcribed. " +
        "Download it in Settings → Dictation, then try again.",
    );
  }
  const meta = await transcribeMediaWithSpeakers(deps, fileId);
  if (meta === null) {
    throw new Error("This file could not be transcribed — nothing was changed.");
  }
}

type OpenRoom = NonNullable<RoomManagerState["room"]>;
type MediaKind = NonNullable<ReturnType<typeof mediaKind>>;

type RetranscriptionPreflight =
  | { kind: "model-missing"; name: string }
  | {
    bytes: Buffer | null | undefined;
    extension: string;
    kind: "ready";
    mediaKind: MediaKind;
    modelPath: string;
    name: string;
    open: OpenRoom;
  };

function openRoom(state: RoomManagerState): OpenRoom {
  if (!state.room) throw new Error("No room is open.");
  return state.room;
}

function retranscriptionPreflight(
  state: RoomManagerState,
  userDataDir: string,
  resourcesPath: string | null,
  fileId: string,
): RetranscriptionPreflight {
  const open = openRoom(state);
  const [name, mime0, bytes] = getFileFull(open.conn, fileId);
  const mime = mime0 ?? "application/octet-stream";
  const extension = path.extname(name).slice(1).toLowerCase();
  const kind = mediaKind(mime, extension);
  if (kind === null) throw new Error("This file isn't audio or video, so there's nothing to transcribe.");
  if (!bytes && open.workspace === undefined) throw new Error("This recording has no stored audio bytes.");
  const modelPath = sttEffectiveModel(userDataDir, resourcesPath);
  if (!modelPath) return { kind: "model-missing", name };
  return { bytes, extension, kind: "ready", mediaKind: kind, modelPath, name, open };
}

async function stageRetranscriptionInput(
  open: OpenRoom,
  fileId: string,
  bytes: Buffer | null | undefined,
  staged: string,
): Promise<void> {
  if (open.workspace === undefined) {
    await fs.promises.writeFile(staged, bytes!, { mode: 0o600 });
    return;
  }
  await pipeline(
    open.workspace.readStream(fileId),
    fs.createWriteStream(staged, { flags: "wx", mode: 0o600 }),
  );
}

function transcriptFromOutcome(
  outcome: Awaited<ReturnType<typeof sidecarJsonCancellable>>,
): string {
  if (outcome.kind === "stopped") throw new Error("Stopped.");
  if (outcome.kind === "error") throw new Error(outcome.error.error);
  const text = object(outcome.value).text;
  if (typeof text !== "string") throw new Error("The speech engine returned no transcript.");
  return text;
}

async function requestTranscript(
  staged: string,
  modelPath: string,
  kind: MediaKind,
): Promise<string> {
  const outcome = await sidecarJsonCancellable(
    "/stt/transcribe_file",
    { path: staged, model_path: modelPath, kind },
    new CancelFlag(),
    10 * 60 * 60 * 1000,
  );
  return transcriptFromOutcome(outcome);
}

function currentRoom(state: RoomManagerState, open: OpenRoom): OpenRoom {
  if (!state.room || state.room.path !== open.path) {
    throw new Error("The room was closed while transcription was running.");
  }
  return state.room;
}

function commitTranscript(
  state: RoomManagerState,
  open: OpenRoom,
  fileId: string,
  name: string,
  text: string,
  emit: EventSender,
  onIndexed?: (roomPath: string) => void,
): void {
  setFileExtractedText(currentRoom(state, open).conn, fileId, text);
  emit("file-updated", fileId);
  emit("room-files-changed", {});
  onIndexed?.(open.path);
  emit("stt-progress", [name, text.trim() === "" ? "none" : "done"]);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeTempDirectory(tempDir: string): Promise<void> {
  await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * The TEXT-ONLY lane: one `POST /stt/transcribe_file`, one flat string, into
 * `files.extracted_text`. No speakers, no `recordings` row.
 *
 * Still here, and still exported, for three honest reasons — not as a leftover:
 *   1. it owns the "this file isn't audio or video" refusal, which is the only
 *      thing {@link retranscribeFileRouted} has to say about a non-media file;
 *   2. `liveRuntimeTools.ts` injects it by TYPE (`retranscribe?: typeof
 *      retranscribeFile`), so its signature is a published seam;
 *   3. it is the fallback if the diarizing route is ever unavailable — a flat
 *      transcript is worth more than none.
 *
 * Prefer `mediaTranscribeJob.ts::transcribeMediaWithSpeakers` for anything that
 * IS media: this function's output can never open in `RecordingView`.
 *
 * NOTE the model-missing branch below: it emits and RETURNS, so an awaiting
 * caller sees a resolved promise. That is preserved because `AudioView` reads
 * the stage, and changing it would change three existing call sites' contract;
 * {@link retranscribeFileRouted} is where the honest rejection was added.
 */
export async function retranscribeFile(
  state: RoomManagerState,
  userDataDir: string,
  resourcesPath: string | null,
  emit: EventSender,
  fileId: string,
  onIndexed?: (roomPath: string) => void,
): Promise<void> {
  const preflight = retranscriptionPreflight(state, userDataDir, resourcesPath, fileId);
  if (preflight.kind === "model-missing") {
    emit("stt-progress", [preflight.name, "model-missing"]);
    return;
  }
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "arcelle-stt-"));
  const staged = path.join(tempDir, `source.${preflight.extension || "bin"}`);
  try {
    await stageRetranscriptionInput(preflight.open, fileId, preflight.bytes, staged);
    emit("stt-progress", [preflight.name, "started"]);
    const text = await requestTranscript(staged, preflight.modelPath, preflight.mediaKind);
    commitTranscript(state, preflight.open, fileId, preflight.name, text, emit, onIndexed);
  } catch (error) {
    emit("stt-progress", [preflight.name, `failed: ${failureMessage(error)}`]);
    throw error;
  } finally {
    await removeTempDirectory(tempDir);
  }
}

/** Transcribe in-memory media for chat's #transcribe command without first
 * committing a duplicate room file. The bytes are staged privately because
 * the sidecar endpoint intentionally accepts paths, not arbitrary host files. */
export async function transcribeMediaBytes(
  userDataDir: string,
  resourcesPath: string | null,
  bytes: Buffer,
  extension: string,
  kind: "audio" | "video",
): Promise<string> {
  const modelPath = sttEffectiveModel(userDataDir, resourcesPath);
  if (!modelPath) throw new Error("The speech model is not installed. Download it in Settings first.");
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "arcelle-stt-"));
  const staged = path.join(tempDir, `source.${extension || "bin"}`);
  try {
    await fs.promises.writeFile(staged, bytes, { mode: 0o600 });
    const outcome = await sidecarJsonCancellable(
      "/stt/transcribe_file",
      { path: staged, model_path: modelPath, kind },
      new CancelFlag(),
      10 * 60 * 60 * 1000,
    );
    if (outcome.kind === "stopped") throw new Error("Stopped.");
    if (outcome.kind === "error") throw new Error(outcome.error.error);
    const text = object(outcome.value).text;
    if (typeof text !== "string") throw new Error("The speech engine returned no transcript.");
    return text;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
