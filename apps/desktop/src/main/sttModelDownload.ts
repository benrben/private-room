import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { MAX_MODEL_BYTES, MIN_MODEL_BYTES, MODEL_SIZE_MB, MODEL_URL, NOT_A_MODEL, STT_ALREADY_DOWNLOADING, STT_DOWNLOAD_STOPPED, SttModelState, bundledSttModelPath, looksLikeGgmlModel, partPath, sttModelPath } from "./sttTools.js";



// ============================================================================
// ---- stt_download_model (stt_cmds.rs:114-204) -------------------------------
// ============================================================================

/** The two seams a test fakes — network, and filesystem presence. Everything
 * else (the actual writes) goes through real `node:fs/promises` against a real
 * path, matching this codebase's "fake the transport, keep the real disk logic"
 * convention (`recBridge.ts`'s `createRecBridgeCtx` doc). */
export interface SttDownloadDeps {
  exists: (p: string) => boolean;
  fetchImpl: typeof fetch;
}


export const defaultSttDownloadDeps: SttDownloadDeps = {
  exists: existsSync,
  fetchImpl: fetch,
};


export type SttDownloadProgress = (got: number, total: number, percent: number) => void;


/** {@link sttDownloadModelAt}'s rarely-passed knobs. `minBytes`/`maxBytes`
 * default to the real {@link MIN_MODEL_BYTES}/{@link MAX_MODEL_BYTES} and are
 * overridable ONLY so a test can exercise the real validation logic without
 * moving 574 MB — the same "production callers never pass it" contract
 * `pullCancellableAt`'s own `stallTimeoutMs` parameter documents. */
export interface SttDownloadOpts {
  deps?: SttDownloadDeps;
  minBytes?: number;
  maxBytes?: number;
}
export interface ResolvedSttDownloadOpts {
  deps: SttDownloadDeps;
  minBytes: number;
  maxBytes: number;
}
export function resolvedSttDownloadOpts(opts: SttDownloadOpts): ResolvedSttDownloadOpts {
  return {
    deps: opts.deps ?? defaultSttDownloadDeps,
    minBytes: opts.minBytes ?? MIN_MODEL_BYTES,
    maxBytes: opts.maxBytes ?? MAX_MODEL_BYTES,
  };
}


/**
 * Rust writes each chunk with `std::io::Write::write_all`, which LOOPS until
 * every byte is on disk. `FileHandle.write` does not: one `write(2)` can come
 * back short (a full disk, a large chunk against some filesystems) without
 * raising, and `got` counts bytes RECEIVED, not bytes stored — so a silently
 * truncated file could still clear `got >= MIN_MODEL_BYTES`, still carry valid
 * magic in its first four bytes, and get renamed into place as a "model" that
 * whisper.cpp then fails to load. This restores `write_all`'s contract.
 *
 * Exported only so its loop can be driven directly against a short-writing fake
 * — a real `write(2)` short write cannot be provoked from userland on demand.
 */
export interface PartialWriter {
  write(buffer: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>;
}


export async function writeAll(fh: PartialWriter, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await fh.write(chunk, offset, chunk.length - offset);
    if (bytesWritten <= 0) {
      throw new Error("writing the dictation model made no progress — is the disk full?");
    }
    offset += bytesWritten;
  }
}
export function declaredModelLength(headers: Headers): number | null {
  const header = headers.get("content-length");
  if (header === null) {
    return null;
  }
  const trimmed = header.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}
export async function modelDownloadResponse(url: string, deps: SttDownloadDeps): Promise<Response> {
  try {
    return await deps.fetchImpl(url);
  } catch (err) {
    throw new Error(`download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
export function downloadTotal(resp: Response, maxBytes: number): number {
  const declaredLength = declaredModelLength(resp.headers);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new Error(NOT_A_MODEL);
  }
  return declaredLength ?? MODEL_SIZE_MB * 1024 * 1024;
}
export function downloadBody(resp: Response): ReadableStream<Uint8Array> {
  if (resp.body === null) {
    throw new Error("download failed: the server returned no body");
  }
  return resp.body;
}
export async function nextModelChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  try {
    return await reader.read();
  } catch (err) {
    throw new Error(`download interrupted: ${err instanceof Error ? err.message : String(err)}`);
  }
}
export function modelChunkHead(head: Buffer, headLength: number, chunk: Buffer): number {
  if (headLength >= head.length) {
    return headLength;
  }
  const take = Math.min(head.length - headLength, chunk.length);
  chunk.copy(head, headLength, 0, take);
  return headLength + take;
}
export function downloadProgress(
  got: number,
  total: number,
  lastPercent: number,
  onProgress: SttDownloadProgress | undefined
): number {
  const percent = Math.floor((got * 100) / Math.max(total, 1));
  if (percent !== lastPercent) {
    onProgress?.(got, total, percent);
  }
  return percent;
}
export interface ModelDownloadBytes {
  got: number;
  head: Buffer;
  headLength: number;
}
export async function streamModelDownload(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: SttModelState,
  fh: PartialWriter,
  total: number,
  maxBytes: number,
  onProgress: SttDownloadProgress | undefined
): Promise<ModelDownloadBytes> {
  let got = 0;
  let lastPercent = 0;
  const head = Buffer.alloc(4);
  let headLength = 0;

  for (;;) {
    const { done, value } = await nextModelChunk(reader);
    if (done) {
      return { got, head, headLength };
    }
    if (state.cancelRequested) {
      throw new Error(STT_DOWNLOAD_STOPPED);
    }
    const chunk = Buffer.from(value);
    got += chunk.length;
    if (got > maxBytes) {
      throw new Error(NOT_A_MODEL);
    }
    headLength = modelChunkHead(head, headLength, chunk);
    await writeAll(fh, chunk);
    lastPercent = downloadProgress(got, total, lastPercent, onProgress);
  }
}
export async function releaseModelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // A complete body already released its reader; cancellation is best effort.
  }
}
export function validDownloadedModel(download: ModelDownloadBytes, minBytes: number): boolean {
  return download.got >= minBytes && looksLikeGgmlModel(download.head.subarray(0, download.headLength));
}


/**
 * `stt_download_model`'s streaming core, against an EXPLICIT `url`/`dest` — the
 * testable split this migration's `…At` convention establishes
 * (`pullCancellableAt`, `sidecarPostAt`), so a real `node:http` server can drive
 * the whole transfer with no HuggingFace access and no sidecar involved (this
 * download never touches the sidecar — see the module doc).
 *
 * Streams to `dest + ".part"` and renames on success, so a cancelled or failed
 * download never leaves a half model behind; the `.part` is removed on every
 * non-success exit.
 *
 * Cancellation is checked exactly where Rust's `while let Some(chunk) =
 * stream.next().await` loop checks it: after a chunk has been read, before it is
 * written — so a Stop landing while a chunk is already in flight still discards
 * that chunk rather than partially trusting it.
 *
 * This function does NOT own {@link SttModelState.downloading}; it only reads
 * `cancelRequested`. The single-flight gate lives in {@link sttDownloadModel},
 * matching Rust's own split between the command and its inner async block.
 */
export async function sttDownloadModelAt(
  url: string,
  dest: string,
  state: SttModelState,
  onProgress?: SttDownloadProgress,
  opts: SttDownloadOpts = {}
): Promise<void> {
  const { deps, minBytes, maxBytes } = resolvedSttDownloadOpts(opts);
  const part = partPath(dest);

  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    const resp = await modelDownloadResponse(url, deps);
    if (!resp.ok) {
      throw new Error(`download failed: HTTP ${resp.status}`);
    }

    // Rust reads `resp.content_length()`, an `Option<u64>`: a header that is not
    // a plain non-negative integer parses to `None` and takes the fallback
    // denominator below. `Number()` alone accepts `"-1"`, `""` (→ 0) and
    // `"1e3"`, and a negative or zero `total` then rides out on the progress
    // channel as `{total: -1, percent: 6400}` — a denominator the renderer's
    // bar divides by. Digits only, exactly like `str::parse::<u64>()`.
    // An implausible declared size is refused before a byte is written.
    // Rust's `content_length().unwrap_or(MODEL_SIZE_MB * 1024 * 1024)`: an
    // undeclared length falls back to the expected size purely so the percent
    // has a denominator; a declared 0 stays 0 and is floored at 1 below, as
    // Rust's own `total.max(1)` does.
    const total = downloadTotal(resp, maxBytes);
    const body = downloadBody(resp);

    const fh = await fsp.open(part, "w");
    const reader = body.getReader();
    let download: ModelDownloadBytes;
    try {
      download = await streamModelDownload(reader, state, fh, total, maxBytes, onProgress);
    } finally {
      // Rust drops the body on every exit. Node's reader needs an explicit
      // release so a cancelled model transfer does not remain on the wire.
      await releaseModelReader(reader);
      await fh.close();
    }

    // Only NOW is it renamed into the path `sttEffectiveModel` prefers over the
    // bundled copy. Nothing checked what arrived before this guard existed, so
    // an error page served with a 200 became "installed: true" and every
    // transcription afterwards failed on a file the app had told the user it
    // had.
    if (!validDownloadedModel(download, minBytes)) {
      throw new Error(NOT_A_MODEL);
    }
    await fsp.rename(part, dest);
  } catch (err) {
    await fsp.rm(part, { force: true }).catch(() => undefined);
    throw err;
  }
}


/**
 * `stt_cmds.rs::stt_download_model`, the production entry point: the "nothing
 * to download" short circuit (bundled or already downloaded), the single-flight
 * `STT_DOWNLOADING` gate, and the real {@link MODEL_URL}.
 * {@link sttDownloadModelAt} is where the transfer and its validation live.
 *
 * A second call while one is in flight throws and touches NOTHING else — the
 * download actually running owns its own cleanup and its own flags, exactly as
 * Rust's `STT_DOWNLOADING.swap(true, ..)` early-return does.
 */
export async function sttDownloadModel(
  userDataDir: string,
  resourcesPath: string | null,
  state: SttModelState,
  onProgress?: SttDownloadProgress,
  deps: SttDownloadDeps = defaultSttDownloadDeps
): Promise<void> {
  const dest = sttModelPath(userDataDir);
  const bundled = resourcesPath !== null ? bundledSttModelPath(resourcesPath) : null;
  if (deps.exists(dest) || (bundled !== null && deps.exists(bundled))) {
    // Nothing to download — but a `.part` left behind by a download the user
    // quit out of would otherwise sit there for good.
    await fsp.rm(partPath(dest), { force: true }).catch(() => undefined);
    return;
  }
  if (state.downloading) {
    throw new Error(STT_ALREADY_DOWNLOADING);
  }
  state.downloading = true;
  // A Stop pressed against the PREVIOUS download must not kill this one.
  state.cancelRequested = false;
  try {
    await sttDownloadModelAt(MODEL_URL, dest, state, onProgress, { deps });
  } finally {
    state.cancelRequested = false;
    state.downloading = false;
  }
}


// ============================================================================
// ---- stt_delete_model (stt_cmds.rs:206-259) ---------------------------------
// ============================================================================

/**
 * `stt_delete_model`'s FILE half — deletes the downloaded model and its `.part`
 * leftover, so `installed` genuinely flips back to false. The context-release
 * half (`free_deleted_model`/`stt::unload_model`) has no home in this process;
 * see the module doc's "ONE HONEST GAP".
 *
 * `force: true` only suppresses "already absent" (ENOENT) — a real removal
 * failure (permissions, a busy mount) still propagates, matching Rust's
 * `remove_file(&path)?` guarded by its own existence check. The `.part` sweep
 * stays best-effort, matching Rust's `let _ = remove_file(..)`.
 */
export async function sttDeleteModel(userDataDir: string): Promise<void> {
  const dest = sttModelPath(userDataDir);
  await fsp.rm(dest, { force: true });
  await fsp.rm(partPath(dest), { force: true }).catch(() => undefined);
}
