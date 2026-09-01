/**
 * Record a podcast script as audio: each host in their own voice, joined into
 * one m4a room file with a seekable transcript. Ported from
 * `src-tauri/src/commands/studios/podcast_audio.rs` (561 lines, read in full,
 * including its `#[cfg(test)] mod tests` — every test reproduced in
 * `studiosPodcastAudio.test.ts`).
 *
 * THE PRIVACY SEAM, FIRST, BECAUSE IT IS THE BIGGEST ONE HERE (the Rust
 * source's own module doc, verbatim in spirit): speaking sends text to
 * Microsoft's Edge TTS service. THIS path sends an entire episode — every
 * line of a script written FROM the user's own documents — in one go. It goes
 * through the same door every spoken sentence does, per line, for exactly
 * that reason: a second, looser door on a much larger seam would be the worst
 * possible place to have one.
 *
 * ============================================================================
 * WHAT IS REAL, AND WHY THIS FILE HAS NO `NOT_IMPLEMENTED` IN IT
 * ============================================================================
 * `jobs.ts`'s own module doc (written by an earlier batch, before this one)
 * calls the TTS voice service "wholly unported (studio/TTS is a future
 * batch)" and stubs `RenderPodcastAudio` accordingly. That was re-checked here
 * rather than assumed, per this task's own instruction, and found stale:
 *
 *   - The Python sidecar has REAL, working TTS routes today —
 *     `arcelle_sidecar/tts.py` (edge-tts bundled) plus `server.py`'s
 *     `POST /tts`, `POST /tts/podcast`, `POST /tts/voices` — verified by
 *     reading both files, not by grepping for a route name.
 *   - `sidecarJsonCancellable.ts` is a REAL, already-tested, generic
 *     cancellable POST to any sidecar feature endpoint, and SEVEN already-
 *     committed modules (`ollamaGenerate.ts`, `storyTools.ts`, `filePass.ts`,
 *     `visionTools.ts`, `workflowEngine.ts`, `webSearch.ts`,
 *     `chatCommandsKnowledge.ts`) call it DIRECTLY for their own sidecar
 *     endpoints — no injectable indirection — and prove it against a real
 *     local `node:http` server in their tests (`storyTools.test.ts`'s own
 *     module doc names this as `sidecarJsonCancellable.test.ts`'s own
 *     convention). This file follows that exact, established pattern for
 *     `/tts/podcast` and `/tts`, rather than inventing a second one.
 *   - The privacy door's two dependencies — {@link webAccessEnabled}
 *     (`browser/webAccess.ts`) and `remoteSeamRedactor`/`Redactor.redact`
 *     (`privacy.ts`/`privacyRedact.ts`) — are both already real, tested, and
 *     the codebase's ONE source of truth for those checks.
 *
 * So `render_podcast_audio`'s entire pipeline — reading the script, the
 * privacy door per line, the `/tts/podcast` POST, decoding the audio,
 * encoding it to m4a, building the seekable transcript, naming and saving the
 * file — is ported FOR REAL. `get_podcast`/`set_podcast_cast`/
 * `preview_podcast_voice` are likewise real. See {@link speakableText}'s own
 * doc for the one small slice of `speech_cmds.rs` this file carries (that
 * module itself has no port yet — only the two functions this file's own
 * Rust source imports from it).
 *
 * NOT PORTED, deliberately out of scope for THIS Rust file:
 *   - `speech_cmds.rs`'s OWN `#[tauri::command]`s (`speak_text_neural`,
 *     `list_neural_voices`) and its voice-catalog caching
 *     (`VOICE_CATALOG_KEY`/`remember_voice_ids`/`cached_voice_ids`) — none of
 *     them are called by `podcast_audio.rs`. A future batch porting
 *     `speech_cmds.rs` in full should absorb {@link speakableText}/
 *     {@link speakOne}/{@link redactForSpeech} from here rather than
 *     re-deriving them (the `mediaKind` precedent `peaksTools.ts` documents).
 *   - `studios.rs` itself (`run_studio`/`StudioSpec`/`flashcards.rs`/
 *     `mindmap.rs`/`podcast.rs`'s script generation). UPDATE, and the reason
 *     this bullet is worth re-reading: it WAS unported when this file was
 *     written (grepped, zero hits), and a CONCURRENT batch landed it during
 *     the same run — `studiosCmds.ts`, plus `studiosFlashcards.ts`/
 *     `studiosMindmap.ts`/`studiosPodcast.ts`. Nothing here calls
 *     `run_studio` (this file works from an already-saved `podcasts` row, not
 *     a fresh studio build), but {@link safeScopeName} — which this file's
 *     `next_take_name` genuinely needs and which `podcast_audio.rs` reads out
 *     of `studios.rs` via `use super::*` — is now IMPORTED from
 *     `studiosCmds.ts` rather than kept as the local copy this bullet used to
 *     justify. See that re-export's own doc.
 *
 * NOT MODEL-INVOCABLE: `exec_tool`'s Rust match-arm list and this migration's
 * `toolSpecs.ts`/`toolSchema.ts`/`execTool.ts` were all grepped for
 * `podcast_audio`/`render_podcast_audio`/`preview_podcast_voice` — no hits.
 * `generate_podcast_script` (a DIFFERENT Rust file, `podcast.rs`'s script
 * AUTHORING) is the only podcast-flavoured tool arm, already wired by an
 * earlier batch; nothing here touches `execTool.ts`.
 *
 * ROOM ACCESS — two DIFFERENT room-lookup shapes, matching the Rust source's
 * own two shapes exactly:
 *   - {@link renderPodcastAudio} spans a genuine async gap (the network
 *     synthesis call) during which the room may be closed or swapped, so it
 *     takes `jobs.ts`'s {@link RoomSource}/`pinnedDb` — the room-PATH-pin
 *     discipline `render_podcast_audio`'s own `room_path.is_some_and(|rp|
 *     room.path != rp)` checks apply at Phase 1 (the read) and Phase 3 (the
 *     write), and {@link anyOpenDb} for the per-turn privacy-door check
 *     inside the loop, which in Rust goes through `speakable_text`'s OWN
 *     `state.with_room` — "some room is open", NOT re-pinned to the specific
 *     `room_path`. That asymmetry is real Rust behavior (a room swapped
 *     mid-loop would not be caught until Phase 3's write), reproduced here
 *     rather than "fixed", per this port's fidelity rule.
 *   - {@link getPodcast}/{@link setPodcastCast}/{@link previewPodcastVoice}
 *     are single-shot command handlers: they take the room's ALREADY-
 *     UNWRAPPED `Database.Database`, resolved once by
 *     {@link registerStudiosPodcastAudioIpc} — `previewTools.ts`'s
 *     `quicklookPreview`/`storyTools.ts`'s convention.
 *
 * `registerStudiosPodcastAudioIpc` is exported and directly testable, but —
 * same as `previewTools.ts`/`storyTools.ts`/`recIpc.ts` — NOT called from any
 * live main-process entrypoint by this batch (rule of this migration).
 */

import { Readable } from "node:stream";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag, guardCommit } from "./cancel.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import {
  getFileMeta,
  insertFile,
  setFileExtractedText,
  type FileMeta,
} from "./db-host/files.js";
import {
  eqIgnoreAsciiCase,
  getPodcast as dbGetPodcast,
  savePodcast,
  setPodcastAudio,
  type Podcast,
  type PodcastHost,
  type PodcastTurn,
} from "./db-host/podcasts.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";
import { encodeEpisode, timedTranscript } from "./studiosPodcastEncoding.js";
import { nextTakeName } from "./studiosPodcastNaming.js";
import {
  asRecord,
  speakOne,
  speakableText,
  successfulSidecarValue,
  type SidecarOutcome,
} from "./studiosSpeech.js";

export { encodeEpisode, timedTranscript } from "./studiosPodcastEncoding.js";
export { nextTakeName } from "./studiosPodcastNaming.js";
export {
  MAX_SPEAK_CHARS,
  redactForSpeech,
  SPEECH_OFFLINE_MESSAGE,
  speakOne,
  speakableText,
} from "./studiosSpeech.js";

// =============================================================================
// `studios.rs::safe_scope_name`
// =============================================================================

/**
 * Fold a scope label into a file-name-safe fragment (`next_take_name`'s own
 * dependency). RE-EXPORTED from `studiosCmds.ts`, the port of `studios.rs`
 * itself, rather than defined here.
 *
 * This file originally carried a local copy, correctly, because at the time
 * `studios.rs` genuinely had no port ("confirmed unported by grepping this
 * migration tree for `StudioSpec`/`safeScopeName`/`fillTemplate`: zero hits"
 * — this module's own doc, now stale). A concurrent batch landed
 * `studiosCmds.ts` in the same run. The two copies were byte-for-byte
 * equivalent, but two copies of one Rust function inside one feature is the
 * exact drift this migration has already been bitten by, and `podcast_audio
 * .rs` reads `safe_scope_name` out of `studios.rs` via `use super::*` — so
 * the import here IS the Rust call graph, not a convenience.
 */
export { safeScopeName } from "./studiosCmds.js";

// =============================================================================
// render_podcast_audio
// =============================================================================

/** Ceiling on one episode. Each turn is at least one network round-trip, so
 * this is minutes of work either way; past this it is a runaway rather than a
 * podcast. Reported, never silently truncated. Ported from
 * `MAX_PODCAST_TURNS`. */
export const MAX_PODCAST_TURNS = 400;

/** Where `studio-step` progress events go — Rust's `window.emit("studio-step",
 * …)`. No Electron `BrowserWindow` wiring exists in this rewrite yet; a
 * future batch's implementation is a thin `webContents.send` adapter, the
 * same posture `jobs.ts`'s own {@link RoomSource}/`ProgressSink` document. */
export interface StudioStepSink {
  emit(payload: { step: string; local: boolean }): void;
  /**
   * Rust's `let _ = window.emit("room-files-changed", ())`, the LAST line of
   * `render_podcast_audio` before it returns the new `FileMeta`. This is not a
   * progress aside: it is the signal that makes the finished episode appear in
   * the Library at all. Dropping it (as this port originally did) leaves a
   * recorded podcast invisible until the user navigates away and back — the
   * file is really there, the list just never reloaded.
   *
   * REQUIRED, not optional, deliberately: an optional method silently
   * reintroduces the same bug for any caller that forgets it, and the whole
   * point of the seam is that a caller cannot forget. {@link
   * NULL_STUDIO_STEP_SINK} is the explicit "I am not observing anything" opt
   * out, matching `studiosCmds.ts`'s own `emitSafely(emit, "room-files-
   * changed", undefined)` on the sibling studio-save path.
   */
  filesChanged(): void;
}

/** A sink that discards every event — the default for a caller that does not
 * care to observe progress (e.g. a test exercising the end result only). */
export const NULL_STUDIO_STEP_SINK: StudioStepSink = { emit: () => {}, filesChanged: () => {} };

/** `AppState::with_room`'s own refusal, spelled the way every other port in
 * this codebase spells it (`previewTools.ts`, `recIpc.ts`, `execTool.ts`). */
const NO_ROOM_OPEN = "No room is open.";

/** The room the caller pinned this run to, or ANY currently open room when
 * `roomPath` is `null` — Rust's `room_path.is_some_and(|rp| room.path != rp)`
 * check, applied at a `state.with_room` boundary. Used at Phase 1 (the read)
 * and Phase 3 (the write) of {@link renderPodcastAudio}. */
function pinnedRoom(rooms: RoomSource, roomPath: string | null): RoomHandle {
  const room = rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  if (roomPath !== null && room.path !== roomPath) {
    throw new Error("the room this job belongs to was closed");
  }
  return room;
}

/** "Some room is open", WITHOUT the `roomPath` pin — Rust's `speakable_text`
 * reaches the room only through the generic `state.with_room`, which never
 * checks `room_path`. Used for the per-turn privacy-door check inside
 * {@link renderPodcastAudio}'s loop; see this module's own doc for why that
 * asymmetry is real Rust behavior, reproduced here rather than fixed. */
function anyOpenDb(rooms: RoomSource): Database.Database {
  const room = rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return room.db;
}

/** Rust's `base64::engine::general_purpose::STANDARD.decode`, with a
 * light-weight validity check standing in for `Err(e)` — Node's
 * `Buffer.from(s, "base64")` never throws on malformed input, so a
 * charset check is the closest honest equivalent of "the voice service
 * returned unreadable audio". */
function decodeBase64Strict(s: string): Buffer {
  if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(s)) {
    throw new Error("the voice service returned unreadable audio: invalid base64");
  }
  return Buffer.from(s, "base64");
}

interface PreparedPodcastAudio {
  title: string;
  turns: PodcastTurn[];
  outbound: Array<{ text: string; voice: string; rate: string; pitch: string }>;
  spoken: string[];
  capped: number;
}

interface SynthesizedPodcastAudio {
  wav: Buffer;
  offsets: number[];
}

interface EncodedPodcastAudio {
  bytes: Buffer;
  mime: string;
  ext: string;
  transcript: string;
}

function podcastForRender(db: Database.Database, scriptFileId: string): Podcast {
  const podcast = dbGetPodcast(db, scriptFileId);
  if (podcast === null) {
    throw new Error(
      "This file has no podcast script attached. Scripts made before voices existed have to be " +
        "generated again before they can be recorded."
    );
  }
  if (podcast.turns.length === 0) throw new Error("This script has no lines to read.");
  return podcast;
}

function episodeTurns(podcast: Podcast): { turns: PodcastTurn[]; capped: number } {
  return {
    turns: podcast.turns.slice(0, MAX_PODCAST_TURNS),
    capped: Math.max(0, podcast.turns.length - MAX_PODCAST_TURNS),
  };
}

function outboundPodcastTurn(
  db: Database.Database,
  cast: readonly PodcastHost[],
  turn: PodcastTurn,
): { text: string; voice: string; rate: string; pitch: string } {
  const text = speakableText(db, turn.line);
  const matchedHost = cast.find((host) => eqIgnoreAsciiCase(host.name, turn.speaker.trim()));
  return {
    text,
    voice: matchedHost?.voice ?? "",
    rate: matchedHost?.rate ?? "",
    pitch: matchedHost?.pitch ?? "",
  };
}

function prepareOutboundPodcastTurns(
  rooms: RoomSource,
  cast: readonly PodcastHost[],
  turns: readonly PodcastTurn[],
): { outbound: PreparedPodcastAudio["outbound"]; spoken: string[] } {
  const outbound: PreparedPodcastAudio["outbound"] = [];
  const spoken: string[] = [];
  for (const turn of turns) {
    // "Some room is open" — NOT re-pinned to `roomPath`; see this module's
    // own doc for why that matches Rust's `speakable_text` exactly.
    const rendered = outboundPodcastTurn(anyOpenDb(rooms), cast, turn);
    outbound.push(rendered);
    // The TRANSCRIPT records what was actually said, which after redaction is
    // not always what the script says.
    spoken.push(rendered.text);
  }
  return { outbound, spoken };
}

function preparePodcastAudio(
  rooms: RoomSource,
  scriptFileId: string,
  roomPath: string | null,
): PreparedPodcastAudio {
  const podcast = podcastForRender(pinnedRoom(rooms, roomPath).db, scriptFileId);
  const { turns, capped } = episodeTurns(podcast);
  const { outbound, spoken } = prepareOutboundPodcastTurns(rooms, podcast.cast, turns);
  return { title: podcast.title, turns, outbound, spoken, capped };
}

function synthesizePodcastOutcome(outcome: SidecarOutcome): SynthesizedPodcastAudio {
  const response = asRecord(successfulSidecarValue(outcome, "Stopped — the podcast recording was not saved.")) ?? {};
  const wavB64 = typeof response.audio_b64 === "string" ? response.audio_b64 : null;
  if (wavB64 === null) throw new Error("the voice service returned no audio");
  const offsetsRaw = Array.isArray(response.offsets_ms) ? response.offsets_ms : [];
  return {
    wav: decodeBase64Strict(wavB64),
    offsets: offsetsRaw.filter((offset): offset is number => typeof offset === "number"),
  };
}

function recordingStep(turnCount: number): { step: string; local: boolean } {
  return {
    step: `Recording ${turnCount} turns — each line is sent to the cloud voice service…`,
    local: false,
  };
}

async function encodePodcastAudio(
  prepared: PreparedPodcastAudio,
  synthesized: SynthesizedPodcastAudio,
  cancel: CancelFlag,
  sink: StudioStepSink,
): Promise<EncodedPodcastAudio> {
  guardOrThrow(cancel, "the podcast recording");
  sink.emit({ step: "Encoding the episode…", local: true });
  const { bytes, mime, ext } = await encodeEpisode(synthesized.wav);
  return {
    bytes,
    mime,
    ext,
    transcript: timedTranscript(prepared.title, prepared.turns, prepared.spoken, synthesized.offsets, prepared.capped),
  };
}

function notifyPodcastFilesChanged(sink: StudioStepSink): void {
  try {
    sink.filesChanged();
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

async function storeRenderedPodcastAudio(
  rooms: RoomSource,
  scriptFileId: string,
  roomPath: string | null,
  cancel: CancelFlag,
  prepared: PreparedPodcastAudio,
  encoded: EncodedPodcastAudio,
  sink: StudioStepSink,
): Promise<FileMeta> {
  guardOrThrow(cancel, "the podcast recording");
  const room = pinnedRoom(rooms, roomPath);
  const name = nextTakeName(room.db, prepared.title, encoded.ext);
  const meta = await storePodcastAudioOutput(room, name, encoded.mime, encoded.bytes, encoded.transcript);
  setPodcastAudio(room.db, scriptFileId, meta.id);
  notifyPodcastFilesChanged(sink);
  return meta;
}

/**
 * Render `scriptFileId`'s script to audio and save it in the room. Returns
 * the new audio file's metadata. Ported from `render_podcast_audio`.
 *
 * `roomPath`: `null` when the caller has no specific room to pin to (the Rust
 * default for a foreground call); a path when this runs as a background job
 * (`jobs.rs`'s `spawn_podcast_audio`, the only real caller in the Rust
 * source) — a job that runs for minutes must not gather from, or write its
 * result into, a room the user swapped away from mid-run.
 */
export async function renderPodcastAudio(
  rooms: RoomSource,
  scriptFileId: string,
  cancel: CancelFlag,
  roomPath: string | null,
  sink: StudioStepSink = NULL_STUDIO_STEP_SINK
): Promise<FileMeta> {
  // Phase 1 (locked): read the script, the cast, and the outbound text.
  const prepared = preparePodcastAudio(rooms, scriptFileId, roomPath);

  guardOrThrow(cancel, "the podcast recording");
  sink.emit(recordingStep(prepared.turns.length));

  // Phase 2 (unlocked): the long one. Minutes of network work, so no room
  // access happens here at all — a job that pinned the room for ten minutes
  // would freeze every other operation in the app.
  const outcome = await sidecarJsonCancellable("/tts/podcast", { turns: prepared.outbound, gap_ms: 420 }, cancel);
  const synthesized = synthesizePodcastOutcome(outcome);
  const encoded = await encodePodcastAudio(prepared, synthesized, cancel, sink);
  // Phase 3 (locked): the write. Re-pinned and re-guarded immediately before
  // the side effect — a Stop pressed during the long call above must not land
  // a file after the UI has said the run stopped.
  return storeRenderedPodcastAudio(rooms, scriptFileId, roomPath, cancel, prepared, encoded, sink);
}

/** Publish the finished episode through the room's active content backend. */
export async function storePodcastAudioOutput(
  room: RoomHandle,
  name: string,
  mime: string,
  bytes: Uint8Array,
  transcript: string,
): Promise<FileMeta> {
  if (room.workspace === undefined) {
    return insertFile(room.db, name, mime, bytes, transcript, "generated");
  }
  const entry = await room.workspace.createFile(name, Readable.from([Buffer.from(bytes)]), "generated");
  setFileExtractedText(room.db, entry.fileId, transcript);
  room.db.prepare("UPDATE files SET mime_type = ? WHERE id = ?").run(mime, entry.fileId);
  return getFileMeta(room.db, entry.fileId);
}

/** {@link guardCommit} as a throw — Rust's `crate::cancel::guard_commit(&cancel,
 * what)?` collapsing a `GuardResult` into the `?`-propagated `Err`. */
function guardOrThrow(cancel: CancelFlag, what: string): void {
  const g = guardCommit(cancel, what);
  if (!g.ok) {
    throw new Error(g.error);
  }
}
// =============================================================================
// commands: get_podcast / set_podcast_cast / preview_podcast_voice
// =============================================================================

/** The script attached to a file, if it has one. Ported from
 * `#[tauri::command] get_podcast`. */
export function getPodcast(db: Database.Database, fileId: string): Podcast | null {
  return dbGetPodcast(db, fileId);
}

/**
 * Carry every turn onto the new spelling of its host's name.
 *
 * BY POSITION, because the panel edits the cast in place: host N's new name
 * belongs to whoever host N used to be, and matching by name would make
 * renaming impossible (the old name no longer appears anywhere). The mapping
 * is built in full BEFORE any turn is touched, and each turn is rewritten
 * once, against the name it originally carried — rewriting once per host
 * instead let a later host's rule fire on a name an earlier host had just
 * written, collapsing every line onto one speaker. Ported verbatim from
 * `refold_speakers`.
 */
export function refoldSpeakers(
  oldCast: readonly PodcastHost[],
  newCast: readonly PodcastHost[],
  turns: readonly PodcastTurn[]
): PodcastTurn[] {
  const renames: Array<[string, string]> = [];
  newCast.forEach((host, i) => {
    const old = oldCast[i];
    if (old !== undefined) {
      renames.push([old.name.trim(), host.name.trim()]);
    }
  });
  return turns.map((t) => {
    const hit = renames.find(([old]) => eqIgnoreAsciiCase(t.speaker, old));
    return hit === undefined ? t : { speaker: hit[1], line: t.line };
  });
}

/**
 * Re-cast: the user's choice of voice, name and prosody per host. Does not
 * touch a previously rendered episode. Ported from
 * `#[tauri::command] set_podcast_cast`.
 */
export function setPodcastCast(db: Database.Database, fileId: string, cast: readonly PodcastHost[]): Podcast {
  const current = dbGetPodcast(db, fileId);
  if (current === null) {
    throw new Error("This file has no podcast script attached.");
  }
  // A host with no name cannot be joined to a line, so it can only ever
  // silence one. Refused here rather than stored and puzzled over later.
  if (cast.some((h) => h.name.trim() === "")) {
    throw new Error("Every host needs a name.");
  }
  // Two hosts under one name cannot both be reached: a line is joined to a
  // voice by name, so the second host would never read a word.
  //
  // BOTH sides are trimmed, matching Rust's `e.name.trim().
  // eq_ignore_ascii_case(h.name.trim())`. Trimming only `h` (as this port
  // first did) let `"Ada "` and `"Ada"` through as two distinct hosts — and
  // `render_podcast_audio` joins a line to a voice with
  // `h.name.eq_ignore_ascii_case(t.speaker.trim())`, which `"Ada "` can never
  // satisfy, so the padded host is silent and the other one reads the whole
  // episode. That is precisely the one-narrator outcome this check exists to
  // refuse.
  cast.forEach((h, i) => {
    if (cast.slice(0, i).some((e) => eqIgnoreAsciiCase(e.name.trim(), h.name.trim()))) {
      throw new Error("Two hosts can't share a name — the lines are matched by name.");
    }
  });
  const turns = refoldSpeakers(current.cast, cast, current.turns);
  savePodcast(db, fileId, current.title, turns, cast);
  if (current.audioFileId !== null) {
    setPodcastAudio(db, fileId, current.audioFileId);
  }
  const after = dbGetPodcast(db, fileId);
  if (after === null) {
    throw new Error("the script vanished");
  }
  return after;
}

/** Speak one host's line as a preview, in that host's own voice. Rides
 * {@link speakOne}'s door exactly like every other spoken sentence — the
 * preview is not a special case. Ported from
 * `#[tauri::command] preview_podcast_voice`. */
export async function previewPodcastVoice(
  db: Database.Database,
  text: string,
  voice?: string,
  rate?: string,
  pitch?: string
): Promise<string> {
  return speakOne(db, text, voice, rate, pitch);
}

// =============================================================================
// IPC registration (NOT wired into any bootstrap file — see module doc)
// =============================================================================

function openDb(rooms: RoomSource): Database.Database {
  const room = rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return room.db;
}

/**
 * Registers `get_podcast`, `set_podcast_cast` and `preview_podcast_voice` on
 * the channel names `../shared/ipc-contract.ts` already pins (so a future
 * preload/renderer batch needs no renaming on either side). `render_podcast_
 * audio` itself is `pub(crate) async fn` in Rust, not a `#[tauri::command]` —
 * it is called by `jobs.rs`'s `spawn_podcast_audio` / `start_podcast_audio_
 * job`, so it is exported as a plain function ({@link renderPodcastAudio})
 * rather than registered here; wiring it into `jobs.ts`'s `RenderPodcastAudio`
 * seam is a future batch's job, not this file's.
 */
export function registerStudiosPodcastAudioIpc(ipcMain: Pick<IpcMain, "handle">, rooms: RoomSource): void {
  ipcMain.handle("get_podcast", (_event: IpcMainInvokeEvent, args: { fileId: string }) =>
    getPodcast(openDb(rooms), args.fileId)
  );
  ipcMain.handle(
    "set_podcast_cast",
    (_event: IpcMainInvokeEvent, args: { fileId: string; cast: PodcastHost[] }) =>
      setPodcastCast(openDb(rooms), args.fileId, args.cast)
  );
  ipcMain.handle(
    "preview_podcast_voice",
    (_event: IpcMainInvokeEvent, args: { text: string; voice: string; rate: string; pitch: string }) =>
      previewPodcastVoice(openDb(rooms), args.text, args.voice, args.rate, args.pitch)
  );
}
