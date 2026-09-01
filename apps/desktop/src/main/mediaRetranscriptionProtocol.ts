/** Diarization model discovery, retranscription streaming, and metadata reconciliation. */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent as UndiciAgent } from "undici";

import { coerceRecMeta } from "./recBridge.js";
import type { RecMeta } from "./recFormat.js";
import { authedHeaders, splitCompleteLines } from "./sidecar.js";


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
  let dir = path.dirname(fileURLToPath(import.meta.url));
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
    case "progress":
      return progressLine(parsed, onProgress);
    case "done":
      return doneLine(parsed);
    case "stopped":
      return { kind: "stopped" };
    case "error":
      return errorLine(parsed);
    default:
      return null;
  }
}

function progressLine(
  parsed: Record<string, unknown>,
  onProgress: (doneCs: number, totalCs: number) => void,
): null {
  const doneCs = parsed.doneCs;
  const totalCs = parsed.totalCs;
  if (typeof doneCs === "number" && typeof totalCs === "number") {
    onProgress(doneCs, totalCs);
  }
  return null;
}

function doneLine(parsed: Record<string, unknown>): StreamOutcome {
  try {
    return { kind: "done", meta: coerceRecMeta(parsed.meta), neural: parsed.neural === true };
  } catch (err) {
    // A "done" whose meta will not coerce is worse than no answer: it is the
    // exact shape `RecordingView` reads `.durationCs` off after awaiting.
    return streamError(
      "REC_RETRANSCRIBE_BAD_META",
      `the rebuilt transcript came back unreadable (${errorMessage(err)})`,
    );
  }
}

function errorLine(parsed: Record<string, unknown>): StreamOutcome {
  const code = typeof parsed.code === "string" ? parsed.code : "REC_RETRANSCRIBE_FAILED";
  const error = typeof parsed.error === "string" ? parsed.error : "the rebuild failed";
  return streamError(code, error);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type FetchResult = { kind: "response"; response: Response } | { kind: "outcome"; outcome: StreamOutcome };
type StreamBodyResult = { kind: "body"; body: ReadableStream<Uint8Array> } | { kind: "outcome"; outcome: StreamOutcome };
type StreamReadResult =
  | { kind: "chunk"; value: Uint8Array }
  | { kind: "end" }
  | { kind: "outcome"; outcome: StreamOutcome };
type StreamProgress =
  | { kind: "continue"; buffered: Buffer }
  | { kind: "end" }
  | { kind: "outcome"; outcome: StreamOutcome };

async function requestRetranscription(base: string, body: unknown): Promise<FetchResult> {
  try {
    const response = await fetch(`${base}/rec/retranscribe`, {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
      // The standalone `undici` package's `Dispatcher` type and the
      // `undici-types` bundled into @types/node are separately-versioned
      // copies of one shape — real at runtime, a false type mismatch.
      dispatcher: RETRANSCRIBE_DISPATCHER,
    } as unknown as RequestInit);
    return { kind: "response", response };
  } catch (err) {
    return { kind: "outcome", outcome: streamError("SIDECAR_DOWN", errorMessage(err)) };
  }
}

async function retranscriptionStreamBody(response: Response): Promise<StreamBodyResult> {
  if (!response.ok) {
    return { kind: "outcome", outcome: await refusalOf(response) };
  }
  if (response.body === null) {
    return {
      kind: "outcome",
      outcome: streamError("REC_RETRANSCRIBE_FAILED", "the speech engine answered with no body"),
    };
  }
  return { kind: "body", body: response.body };
}

function isProtocolRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedRetranscribeLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isProtocolRecord(parsed) ? parsed : null;
  } catch {
    // Skip a malformed line rather than abort, matching the `/run` client.
    return null;
  }
}

function terminalOutcome(
  lines: string[],
  onProgress: (doneCs: number, totalCs: number) => void,
): StreamOutcome | null {
  for (const line of lines) {
    const parsed = parsedRetranscribeLine(line);
    if (parsed === null) continue;
    const outcome = retranscribeLine(parsed, onProgress);
    if (outcome !== null) return outcome;
  }
  return null;
}

async function readNextChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<StreamReadResult> {
  try {
    const step = await reader.read();
    if (step.done) return { kind: "end" };
    return { kind: "chunk", value: step.value ?? new Uint8Array() };
  } catch (err) {
    return {
      kind: "outcome",
      outcome: streamError(
        "REC_RETRANSCRIBE_FAILED",
        `the connection to the speech engine broke mid-rebuild (${errorMessage(err)})`,
      ),
    };
  }
}

async function nextStreamProgress(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: Buffer,
  onProgress: (doneCs: number, totalCs: number) => void,
): Promise<StreamProgress> {
  const read = await readNextChunk(reader);
  if (read.kind === "end" || read.kind === "outcome") return read;
  const split = splitCompleteLines(Buffer.concat([buffered, Buffer.from(read.value)]));
  const outcome = terminalOutcome(split.lines, onProgress);
  return outcome === null
    ? { kind: "continue", buffered: split.rest }
    : { kind: "outcome", outcome };
}

async function cancelStreamReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Already released by a normal end-of-stream — best effort.
  }
}

async function readRetranscriptionStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (doneCs: number, totalCs: number) => void,
): Promise<StreamOutcome> {
  const reader = body.getReader();
  let buffered = Buffer.alloc(0);
  try {
    for (;;) {
      const progress = await nextStreamProgress(reader, buffered, onProgress);
      if (progress.kind === "outcome") return progress.outcome;
      if (progress.kind === "end") break;
      buffered = progress.buffered;
    }
  } finally {
    await cancelStreamReader(reader);
  }
  return streamError(
    "REC_RETRANSCRIBE_TRUNCATED",
    "the speech engine closed the connection before the rebuild finished",
  );
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
  const requested = await requestRetranscription(base, body);
  if (requested.kind === "outcome") return requested.outcome;
  const stream = await retranscriptionStreamBody(requested.response);
  if (stream.kind === "outcome") return stream.outcome;
  return readRetranscriptionStream(stream.body, onProgress);
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
