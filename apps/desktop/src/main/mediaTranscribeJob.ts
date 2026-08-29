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

import { existsSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Agent as UndiciAgent } from "undici";

import { getFileFull, inTransaction, setFileExtractedText } from "./db-host/files.js";
import { getRecMeta, setRecMeta } from "./db-host/recordings.js";
import { knownVoices, type KnownVoice } from "./db-host/voices.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import * as obs from "./obs.js";
import { mediaKind } from "./peaksTools.js";
import { beginRetranscribe, coerceRecMeta, endRetranscribe, parseRecMeta } from "./recBridge.js";
import { defaultRecMeta, transcriptText, type RecMeta } from "./recFormat.js";
import type { RoomManagerState } from "./roomManager.js";
import { authedHeaders, busy, ensureUp, splitCompleteLines } from "./sidecar.js";
import { sttEffectiveModel } from "./sttTools.js";
import type { EventSender } from "./turn.js";

// =============================================================================
// ---- the diarize weights ----------------------------------------------------
// =============================================================================

/** The bundled speaker-embedding weights — NVIDIA NeMo TitaNet-small, ONNX,
 * 192-dim embeddings. The same name is used in `userData/models/` (a
 * user-supplied copy) and in the packaged `Resources/models/`. */
export const DIARIZE_MODEL_FILE = "nemo_en_titanet_small.onnx";

/** A user-supplied copy under Electron's `userData`, mirroring
 * {@link sttModelPath}'s own convention. `userDataDir` is passed in rather
 * than read from `electron` here so this module stays a plain, testable Node
 * module — the convention `sttTools.ts`/`privacy.ts`/`keychain.ts` already
 * set. */
export function diarizeModelPath(userDataDir: string): string {
  return path.join(userDataDir, "models", DIARIZE_MODEL_FILE);
}

/** The copy shipped inside the packaged app — `process.resourcesPath` plus the
 * same `models/` segment `bundledSttModelPath` uses. */
export function bundledDiarizeModelPath(resourcesPath: string): string {
  return path.join(resourcesPath, "models", DIARIZE_MODEL_FILE);
}

/** How far up from this module the dev-tree walk looks for `resources/models/`.
 * Source layout puts this file at `apps/desktop/src/main/` (2 up) and the
 * compiled dev build at `apps/desktop/dist_package/src/main/` (3 up); the
 * spare levels cost one `existsSync` each and survive a build-layout tweak. */
const DEV_RESOURCE_WALK_LEVELS = 5;

/**
 * Candidate `<…>/resources/models/<DIARIZE_MODEL_FILE>` paths in the source
 * tree, walking up from wherever this module actually loaded from.
 *
 * WHY THIS EXISTS AT ALL — and why {@link sttEffectiveModel} has no twin of it:
 * `resourcesPath` is `app.isPackaged ? process.resourcesPath : null`
 * (`index.ts`), so in EVERY development run it is `null`. Without a dev
 * fallback, `diarizeEffectiveModel` would answer `null` on every developer's
 * machine, `/rec/start` and `/rec/retranscribe` would both be handed
 * `diarizeModelPath: null`, the sidecar would fall back to its 21-dim DSP
 * embedding, `identityPrint` (which requires the 192-dim neural print) would
 * return `null`, and voice enrolment would appear — to the developer testing
 * it — to be a feature that simply does not work. The whisper weights are a
 * 574 MB download nobody runs without, so their absence in dev is loud; the
 * diarize weights are 40 MB sitting IN THE REPO, so their absence is silent.
 * That asymmetry is the whole reason for this walk.
 *
 * The `resources/models/` segment is required, which is also what keeps this
 * away from `apps/desktop/scripts/fixtures_a/models/`, a packaging FIXTURE
 * holding a one-line text stub under this exact file name.
 */
function devResourceCandidates(): string[] {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (let level = 0; level <= DEV_RESOURCE_WALK_LEVELS; level += 1) {
    out.push(path.join(dir, "resources", "models", DIARIZE_MODEL_FILE));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * The speaker-embedding weights to actually diarize with, or `null` when there
 * are none.
 *
 * The precedence mirrors {@link sttEffectiveModel} exactly — a user-supplied
 * copy in `userData/models/` wins (they may have swapped one in), then the
 * copy bundled in the packaged app — with the dev-tree fallback
 * ({@link devResourceCandidates}) appended for the reason documented there.
 * `exists` is injectable for the same reason `sttEffectiveModel`'s is: so the
 * precedence itself is testable without staging 40 MB of weights.
 */
export function diarizeEffectiveModel(
  userDataDir: string,
  resourcesPath: string | null,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const downloaded = diarizeModelPath(userDataDir);
  if (exists(downloaded)) {
    return downloaded;
  }
  if (resourcesPath !== null) {
    const bundled = bundledDiarizeModelPath(resourcesPath);
    if (exists(bundled)) {
      return bundled;
    }
  }
  for (const candidate of devResourceCandidates()) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

// =============================================================================
// ---- the streaming client ---------------------------------------------------
// =============================================================================

/**
 * Node's global fetch (undici) tears a body down after 300s of silence BETWEEN
 * chunks. A rebuild legitimately goes quiet for longer than that: the
 * whole-file speaker pass runs for tens of seconds with no inner checkpoint on
 * a long meeting, and a slow decode of a two-hour file can straddle the budget
 * between two progress lines. Torn down there, the transcript is lost with the
 * Python side still burning CPU on it. Same reasoning, same settings, as
 * `sidecar.ts`'s `RUN_STREAM_DISPATCHER` — duplicated rather than exported
 * because that constant is private to the `/run` client and this is a
 * different stream with the same requirement.
 */
const RETRANSCRIBE_DISPATCHER = new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0 });

/** One terminal outcome of the NDJSON stream — the three lines
 * `POST /rec/retranscribe` can end on, plus the transport failures that end it
 * without any line at all. */
export type StreamOutcome =
  | { kind: "done"; meta: RecMeta; neural: boolean }
  | { kind: "stopped" }
  | { kind: "error"; code: string; error: string };

function streamError(code: string, error: string): StreamOutcome {
  return { kind: "error", code, error };
}

/** Read the `{code, error}` envelope off a non-2xx, best-effort. */
async function refusalOf(resp: Response): Promise<StreamOutcome> {
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return streamError(
    typeof o.code === "string" ? o.code : "REC_RETRANSCRIBE_FAILED",
    typeof o.error === "string" ? o.error : `the speech engine refused this (HTTP ${resp.status})`,
  );
}

/**
 * Feed one parsed NDJSON line through the protocol. Returns the terminal
 * outcome when this line ends the stream, or `null` to keep reading.
 *
 * Pure and exported so the line protocol is testable without a socket — the
 * same split `sidecar.ts::processLine` makes for the `/run` stream.
 */
export function retranscribeLine(
  parsed: Record<string, unknown>,
  onProgress: (doneCs: number, totalCs: number) => void,
): StreamOutcome | null {
  switch (parsed.kind) {
    case "progress": {
      const doneCs = parsed.doneCs;
      const totalCs = parsed.totalCs;
      if (typeof doneCs === "number" && typeof totalCs === "number") {
        onProgress(doneCs, totalCs);
      }
      return null;
    }
    case "done": {
      let meta: RecMeta;
      try {
        meta = coerceRecMeta(parsed.meta);
      } catch (err) {
        // A "done" whose meta will not coerce is worse than no answer: it is
        // the exact shape `RecordingView` reads `.durationCs` off the
        // statement after awaiting. Refuse it here rather than persist it.
        return streamError(
          "REC_RETRANSCRIBE_BAD_META",
          `the rebuilt transcript came back unreadable (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      return { kind: "done", meta, neural: parsed.neural === true };
    }
    case "stopped":
      return { kind: "stopped" };
    case "error":
      return streamError(
        typeof parsed.code === "string" ? parsed.code : "REC_RETRANSCRIBE_FAILED",
        typeof parsed.error === "string" ? parsed.error : "the rebuild failed",
      );
    default:
      return null;
  }
}

/**
 * `POST /rec/retranscribe` and read its NDJSON stream to its terminal line.
 *
 * `base` is explicit — exactly as `sidecar.ts::streamRun` takes it, for the
 * same reason: the wire protocol can then be driven against a plain
 * `node:http` responder in a test without going anywhere near the sidecar's
 * process lifecycle.
 *
 * A stream that ENDS WITH NO TERMINAL LINE is an error, never a success: a
 * severed connection mid-rebuild would otherwise read as "the recording is
 * empty" and overwrite a good transcript with silence.
 */
export async function postRetranscribeStream(
  base: string,
  body: unknown,
  onProgress: (doneCs: number, totalCs: number) => void,
): Promise<StreamOutcome> {
  let resp: Response;
  try {
    resp = await fetch(`${base}/rec/retranscribe`, {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
      // The standalone `undici` package's `Dispatcher` type and the
      // `undici-types` bundled into @types/node are two separately-versioned
      // copies of one shape — real at runtime, a false mismatch at the type
      // level. Same cast, same reason, as `sidecar.ts::streamRun`.
      dispatcher: RETRANSCRIBE_DISPATCHER,
    } as unknown as RequestInit);
  } catch (err) {
    return streamError("SIDECAR_DOWN", err instanceof Error ? err.message : String(err));
  }
  if (!resp.ok) {
    return refusalOf(resp);
  }
  if (resp.body === null) {
    return streamError("REC_RETRANSCRIBE_FAILED", "the speech engine answered with no body");
  }

  const reader = resp.body.getReader();
  let buffered = Buffer.alloc(0);
  let terminal: StreamOutcome | null = null;
  try {
    for (;;) {
      let step: { done: boolean; value?: Uint8Array };
      try {
        step = await reader.read();
      } catch (err) {
        return streamError(
          "REC_RETRANSCRIBE_FAILED",
          `the connection to the speech engine broke mid-rebuild (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
      if (step.done) {
        break;
      }
      if (step.value === undefined) {
        continue;
      }
      buffered = Buffer.concat([buffered, Buffer.from(step.value)]);
      const split = splitCompleteLines(buffered);
      buffered = split.rest;
      for (const line of split.lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Skip a malformed line rather than abort, matching the `/run`
          // client. A stream made ENTIRELY of malformed lines still fails,
          // because it reaches the end with no terminal line.
          continue;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          continue;
        }
        terminal = retranscribeLine(parsed as Record<string, unknown>, onProgress);
        if (terminal !== null) {
          break;
        }
      }
      if (terminal !== null) {
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already released by a normal end-of-stream — best effort.
    }
  }
  return (
    terminal ??
    streamError(
      "REC_RETRANSCRIBE_TRUNCATED",
      "the speech engine closed the connection before the rebuild finished",
    )
  );
}

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
}

/**
 * Fold the speaker names as they are ON DISK NOW into the ones the rebuild
 * produced — the port of `recording_cmds.rs::merge_typed_since` (GH #5).
 *
 * Only what was typed SINCE the rebuild started may come back. The rest of the
 * stored map is the pre-rebuild one, and the rebuild has already moved every
 * name onto the label its voice ended up with — so re-adding
 * `{"Speaker 2": "Dana"}` on top of the rebuilt `{"Speaker 1": "Dana"}` puts
 * one person on two speakers, which is the very symptom GH #5 is about. An
 * entry counts as typed-since when the snapshot did not already hold that
 * exact name for that label, and it is added only where the rebuild left the
 * label unnamed: a name the rebuild placed itself is the one that follows the
 * voice.
 *
 * Returns the names it brought back, so the caller can strip them out of the
 * rebuild's GUESSES — a name the user typed is never one the app inferred.
 */
export function mergeTypedSince(
  rebuilt: Record<string, string>,
  prior: Record<string, string>,
  current: Record<string, string>,
): Set<string> {
  const typed = new Set<string>();
  for (const [label, name] of Object.entries(current)) {
    if (prior[label] === name || Object.prototype.hasOwnProperty.call(rebuilt, label)) {
      continue;
    }
    typed.add(name);
    rebuilt[label] = name;
  }
  return typed;
}

/**
 * Reconcile the meta the sidecar rebuilt against the meta on disk right now.
 *
 * Pure, so the two rules that are easy to get silently wrong are testable
 * without a room:
 *   1. the GH #5 name fold (see {@link mergeTypedSince}), including stripping
 *      a user-typed name out of `recognized` and dropping a guess about a
 *      label the rebuild did not mint at all;
 *   2. carrying `cuts`/`chapters`/`highlights`/`notes` forward, which the
 *      reduced wire `prior` cannot round-trip (see this module's header).
 */
export function reconcileRebuilt(rebuilt: RecMeta, stored: RecMeta, priorNames: Record<string, string>): RecMeta {
  const speakerNames = { ...rebuilt.speakerNames };
  const typed = mergeTypedSince(speakerNames, priorNames, stored.speakerNames);
  const named = new Set(Object.values(speakerNames));
  return {
    ...rebuilt,
    speakerNames,
    // A name typed while the rebuild ran is the user's, so it must not stay
    // listed as something the app guessed: the screen would call their own
    // correction a guess, and the next pass would feel free to withdraw it.
    // …and a guess whose label the rebuild did not mint at all is about
    // nobody in this transcript.
    recognized: rebuilt.recognized.filter((n) => !typed.has(n) && named.has(n)),
    cuts: stored.cuts,
    chapters: stored.chapters,
    highlights: stored.highlights,
    notes: stored.notes,
    // Deliberately NOT carried: the transcript has just been rewritten, so any
    // reading pass made from the old one is stale by definition.
    readOf: null,
  };
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
  const open = deps.state.room;
  if (open === null) {
    return null;
  }

  // Pinned WITH the path, not instead of it. `roomManager.ts` bumps
  // `roomEpoch` "the instant the room handle drops", precisely because a
  // checkpoint rollback closes and reopens the room AT THE SAME PATH — so a
  // path-only pin cannot tell a rollback from nothing having happened, and a
  // rebuild that was mid-await would land its transcript on the restored
  // database. Every other writer that defers a write across an await
  // (`videoTools.ts`, `privacy.ts`, `mcpSurfaceIpc.ts`) pins both; this one
  // awaits for minutes, so it is the least excusable place to pin one.
  const epoch = deps.state.roomEpoch;

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
    // No such (live) file. Nothing to name in an event, and nothing to do.
    return null;
  }

  const extension = path.extname(name).slice(1).toLowerCase();
  const kind = mediaKind(mime, extension);
  if (kind === null) {
    // Not audio or video. Silent by design: `retranscribe_file` turns this
    // into its own "this file isn't audio or video" refusal, and the import
    // sweep asks about every file it lands.
    return null;
  }

  const fail = (reason: string): null => {
    deps.emit("stt-progress", [name, `failed: ${reason}`]);
    return null;
  };

  if (bytes === null && open.workspace === undefined) {
    return fail("this recording has no stored audio");
  }
  const modelPath = sttEffectiveModel(deps.userDataDir, deps.resourcesPath);
  if (modelPath === null) {
    deps.emit("stt-progress", [name, "model-missing"]);
    return null;
  }
  const diarizeModel = diarizeEffectiveModel(deps.userDataDir, deps.resourcesPath);
  if (diarizeModel === null) {
    // Degrade, loudly in the log. See this module's header: the transcript is
    // still worth having, but nobody on it can be enrolled as a saved voice.
    obs.warn("rec.retranscribe.no_diarize_model", [["file", obs.id(fileId)]]);
  }

  // One rebuild per file at a time, and the transcript-editing commands refuse
  // against the same set — `recBridge.ts` owns it (the port of Rust's
  // `RecState.retranscribing`).
  if (!beginRetranscribe(fileId)) {
    return fail("this recording is already being re-transcribed");
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "arcelle-stt-")).catch(() => null);
  if (tempDir === null) {
    endRetranscribe(fileId);
    return fail("a private staging folder could not be created");
  }
  // The staged name keeps the source extension (falling back to `.bin`), the
  // same shape `retranscribeFile` stages under. The sidecar's path allowlist
  // cares only about the PARENT directory — `arcelle-stt-*` sitting directly
  // inside the system temp dir — so the file name itself is a courtesy to the
  // container sniffer, not a security boundary.
  const staged = path.join(tempDir, `source.${extension || "bin"}`);

  try {
    if (open.workspace === undefined) {
      // Non-null by the guard above (a non-workspace room with no stored bytes
      // already refused); the same `bytes!` shape `retranscribeFile` uses at
      // the identical point.
      await fs.promises.writeFile(staged, bytes!, { mode: 0o600 });
    } else {
      await pipeline(
        open.workspace.readStream(fileId),
        fs.createWriteStream(staged, { flags: "wx", mode: 0o600 }),
      );
    }

    // The meta as it was when the rebuild started: the sidecar needs the names
    // and the guesses, and `reconcileRebuilt` needs this exact snapshot as the
    // yardstick for spotting a rename typed while the rebuild ran.
    const priorJson = getRecMeta(open.conn, fileId);
    let prior: RecMeta;
    try {
      prior = parseRecMeta(priorJson);
    } catch (err) {
      obs.warn("rec.retranscribe.unreadable_prior", [
        ["file", obs.id(fileId)],
        ["err", obs.errKind(err instanceof Error ? err.message : String(err))],
      ]);
      prior = defaultRecMeta();
    }

    // The voices this room already knows, so a rebuild recognises people
    // exactly as a fresh recording does. Best-effort, the same
    // `known_voices(..).unwrap_or_default()` shape `recStart` uses: a failed
    // read means this pass names nobody automatically, never that it fails.
    let known: KnownVoice[];
    try {
      known = knownVoices(open.conn);
    } catch {
      known = [];
    }

    deps.emit("stt-progress", [name, "started"]);

    // `ensureUp` BEFORE `busy`, in that order, matching
    // `sidecarJsonCancellable`: `ensureUp` consults the in-flight count to
    // decide whether a non-answering sidecar may be replaced, and holding a
    // guard across it would tell it that a request of ours is already riding
    // on the process it is about to judge.
    let base: string;
    try {
      base = await ensureUp();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    let sawProgress = false;
    // Held for the WHOLE stream — a rebuild runs for minutes, and a concurrent
    // `ensureUp` must be able to see that the sidecar is serving something
    // before it decides to SIGTERM it.
    const guard = busy();
    let outcome: StreamOutcome;
    try {
      outcome = await postRetranscribeStream(
        base,
        {
          filePath: staged,
          modelPath,
          diarizeModelPath: diarizeModel,
          // The kind is SENT, not left to the sidecar's suffix guess, exactly
          // as the text-only `/stt/transcribe_file` lane this replaces sent it.
          // The room's mime type is the authority; the staged name is
          // `source.<ext>`, and `ext` is empty for a file whose name carries
          // none (downloads, pasted media) — guessed "audio" there, a video's
          // audio track is never lifted out of its container and the whole
          // rebuild fails with "no readable audio track" on a file that plays.
          kind,
          maxSpeakers: prior.maxSpeakers,
          knownVoices: known,
          // `null` when this file was never a recording — the sidecar builds a
          // default `RecMeta` for that case, and saying "there is no prior" is
          // more honest than sending two empty containers that look like one.
          //
          // `cuts` MUST travel with the naming overlay. `retranscribe` re-marks
          // every freshly derived word that falls inside a carried-over cut as
          // deleted; without them the rebuild silently resurrects content the
          // user cut — back into the transcript, the search index and every AI
          // prompt. Pasting the spans back onto the returned meta afterwards
          // does not do it: `segmentVisibleText` filters on the per-word `del`
          // flag, which only the sidecar can set.
          prior:
            priorJson === null
              ? null
              : { speakerNames: prior.speakerNames, recognized: prior.recognized, cuts: prior.cuts },
        },
        (doneCs, totalCs) => {
          // `rec-retranscribe` is `RecordingView`'s existing progress bar; the
          // `stt-progress` stage change is what releases `AudioView`'s button
          // out of "Queued". Both are already-allowlisted channels.
          deps.emit("rec-retranscribe", { fileId, doneCs, totalCs });
          if (!sawProgress) {
            sawProgress = true;
            deps.emit("stt-progress", [name, "processing"]);
          }
        },
      );
    } finally {
      guard.release();
    }

    if (outcome.kind === "stopped") {
      return fail("the rebuild was stopped before it finished — nothing was changed");
    }
    if (outcome.kind === "error") {
      return fail(outcome.error);
    }
    if (diarizeModel !== null && !outcome.neural) {
      // We handed over weights and got DSP embeddings back: the model did not
      // load. The transcript is still usable, but nobody on it can be enrolled
      // as a saved voice, and that would otherwise look like a broken feature
      // rather than a broken file.
      obs.warn("rec.retranscribe.diarize_not_neural", [["file", obs.id(fileId)]]);
    }

    // Re-read the room FRESH. A rebuild runs for minutes; the room it started
    // in may have been closed or swapped, and writing into a different room's
    // database is worse than not writing at all. The EPOCH is checked as well
    // as the path: a checkpoint rollback reopens the same path over a
    // different database, which a path pin alone reads as "still the same
    // room" (see the pin above).
    const now = deps.state.room;
    if (now === null || now.path !== open.path || deps.state.roomEpoch !== epoch) {
      return fail("the room was closed while the transcript was being rebuilt");
    }

    let stored: RecMeta;
    try {
      stored = parseRecMeta(getRecMeta(now.conn, fileId));
    } catch {
      // Unreadable now for the same reason it was unreadable before; the
      // rebuild is what replaces it.
      stored = prior;
    }
    const meta = reconcileRebuilt(outcome.meta, stored, prior.speakerNames);
    // A file that was never captured here did not come from a live recording,
    // and this header is read by people and by every AI pass over the room, so
    // it has to be true. `"(transcribed from recording)"` is the room's existing
    // wording for the imported lane — `chatActions` already strips exactly that
    // prefix when it hands a transcript to a model.
    const text = transcriptText(meta, priorJson === null ? "(transcribed from recording)" : undefined);

    // Same bytes, new transcript — snapshotted first, so the old transcript
    // stays recoverable through History (the toast `RecordingView` shows after
    // a rebuild promises exactly that).
    //
    // ONLY WHEN THERE IS A TRANSCRIPT TO LOSE. A History entry copies the
    // file's WHOLE bytes (`snapshotFileVersion` inlines `original_bytes`; the
    // workspace path puts the file into the object store), and this lane now
    // runs over imports and downloads — so an unconditional snapshot would
    // duplicate a two-hour video inside the room the first time anyone pressed
    // Transcribe, to preserve an empty transcript. `RecordingView` draws the
    // same distinction in its own toast: it promises History only when there
    // were segments to replace, and says "Transcript written from the audio"
    // otherwise.
    const replacing = priorJson !== null || (priorText ?? "").trim() !== "";
    if (replacing && now.workspace !== undefined) {
      await now.workspace.snapshotVersion(fileId, "Re-transcribed").catch(() => undefined);
    }
    inTransaction(now.conn, () => {
      if (replacing && now.workspace === undefined) {
        snapshotFileVersion(now.conn, fileId, "Re-transcribed");
      }
      setFileExtractedText(now.conn, fileId, text);
      // THE HINGE: this row is what makes the file open in RecordingView
      // (`fileRuntimeSurfaceIpc` picks the viewer on the row's existence, not
      // on the MIME type).
      //
      // AUDIO ONLY, DELIBERATELY. `RecordingView` draws a waveform and a
      // transcript; it has no <video> element. Writing this row for a video
      // would trade the file's PICTURE for speaker chips — a downloaded talk
      // would still play its sound and silently lose its image. A video keeps
      // the `video` viewer kind and therefore its player, and still gains the
      // diarized transcript: `transcriptText` renders "[m:ss] Speaker 2: …",
      // which is exactly the shape `AudioView` already parses into per-line
      // speaker labels. Full speaker chips for video need a viewer that can
      // show both, which is out of scope for this wave.
      if (kind === "audio") {
        setRecMeta(now.conn, fileId, JSON.stringify(meta));
      }
    });

    deps.emit("rec-retranscribe", { fileId, doneCs: meta.durationCs, totalCs: meta.durationCs });
    deps.emit("file-updated", fileId);
    deps.emit("room-files-changed", {});
    try {
      deps.onIndexed?.(now.path);
    } catch {
      // Best-effort, like every other `onIndexed` call site.
    }
    // "none" is decided on the SEGMENTS, not on the rendered text: every
    // transcript carries a provenance header, so `text.trim()` is never empty
    // here the way `/stt/transcribe_file`'s raw string is.
    deps.emit("stt-progress", [name, meta.segments.length === 0 ? "none" : "done"]);
    return meta;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    endRetranscribe(fileId);
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
