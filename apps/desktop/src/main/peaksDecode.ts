/** Native media transcoding and WAV decoding for waveform generation. */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { findFfmpeg } from "./mediaProbe.js";
import type { MediaKind } from "./peaksTools.js";
import { decodeWav, SAMPLE_RATE } from "./recFormat.js";

export interface DecodedPcm {
  samples: ArrayLike<number>;
  sampleRate: number;
}

export type DecodeToPcmFn = (bytes: Buffer, ext: string, kind: MediaKind) => Promise<DecodedPcm>;

export type TranscodeToWav = (
  source: string,
  wav: string,
  kind: MediaKind,
  tempDir: string,
) => Promise<void>;

const execFileAsync = promisify(execFile);

type ConverterExec = (command: string, args: readonly string[]) => Promise<void>;

export interface MacOsTranscodeDeps {
  exec?: ConverterExec;
  findFfmpeg?: () => string | null;
}

const executeConverter: ConverterExec = async (command, args) => {
  await execFileAsync(command, [...args], { maxBuffer: 1024 * 1024 });
};

interface ProcessFailure {
  code?: unknown;
  stderr?: unknown;
  message?: unknown;
}

function processFailure(error: unknown): ProcessFailure {
  return typeof error === "object" && error !== null ? (error as ProcessFailure) : {};
}

function processStartMessage(error: unknown, row: ProcessFailure): string {
  return typeof row.message === "string" ? row.message : String(error);
}

function processStderr(stderr: unknown): string {
  if (typeof stderr === "string") return stderr;
  if (Buffer.isBuffer(stderr)) return stderr.toString("utf8");
  return "";
}

function processError(prefix: string, error: unknown): Error {
  const row = processFailure(error);
  if (row.code === "ENOENT") {
    return new Error(`${prefix} failed to start: ${processStartMessage(error, row)}`);
  }
  return new Error(`${prefix}: ${processStderr(row.stderr).slice(0, 200)}`);
}

async function makePrivate(file: string): Promise<void> {
  await fs.chmod(file, 0o600).catch(() => undefined);
}

async function transcodeVideoFallback(
  source: string,
  wav: string,
  run: ConverterExec,
  findInstalledFfmpeg: () => string | null,
  avconvertError: unknown,
): Promise<void> {
  const ffmpeg = findInstalledFfmpeg();
  if (ffmpeg === null) throw processError("no readable audio track", avconvertError);
  try {
    await run(ffmpeg, [
      "-nostdin",
      "-v",
      "error",
      "-y",
      "-i",
      source,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      wav,
    ]);
    await makePrivate(wav);
  } catch (error) {
    throw processError("no readable audio track", error);
  }
}

async function videoAudioSource(
  source: string,
  wav: string,
  tempDir: string,
  run: ConverterExec,
  findInstalledFfmpeg: () => string | null,
): Promise<string | null> {
  const m4a = path.join(tempDir, "audio.m4a");
  try {
    await run("/usr/bin/avconvert", ["-p", "PresetAppleM4A", "-s", source, "-o", m4a]);
    await makePrivate(m4a);
    return m4a;
  } catch (error) {
    await transcodeVideoFallback(source, wav, run, findInstalledFfmpeg, error);
    return null;
  }
}

async function transcodeAudioSource(source: string, wav: string, run: ConverterExec): Promise<void> {
  try {
    await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", source, wav]);
    await makePrivate(wav);
  } catch (error) {
    throw processError("audio decode failed", error);
  }
}

export async function transcodeWithMacOsUsing(
  source: string,
  wav: string,
  kind: MediaKind,
  tempDir: string,
  deps: MacOsTranscodeDeps = {},
): Promise<void> {
  const run = deps.exec ?? executeConverter;
  const findInstalledFfmpeg = deps.findFfmpeg ?? findFfmpeg;
  const audioSource =
    kind === "video"
      ? await videoAudioSource(source, wav, tempDir, run, findInstalledFfmpeg)
      : source;
  if (audioSource === null) return;
  await transcodeAudioSource(audioSource, wav, run);
}

export const transcodeWithMacOs: TranscodeToWav = (source, wav, kind, tempDir) =>
  transcodeWithMacOsUsing(source, wav, kind, tempDir);

export const DECODE_NON_WAV_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: stt::decode_bytes_to_pcm (the afconvert/avconvert OS-converter " +
  "shell-out that turns any audio or video container into 16 kHz mono PCM, " +
  "src-tauri/src/stt.rs) has no Electron port yet — that is stt.rs's own subsystem, " +
  "with real subprocess and private-tempfile machinery of its own, not a helper this " +
  "file can reasonably inline. WAV bytes decode for real, via recFormat.ts's " +
  "already-ported decodeWav (this room's own recordings, and any plain imported " +
  ".wav); every other container reaches this labelled refusal rather than a " +
  "fabricated waveform.";

const NOT_A_WAV_FILE = "not a WAV file";

function wavSampleRate(bytes: Buffer): number | null {
  if (bytes.length < 44) {
    return null;
  }
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = bytes.toString("ascii", pos, pos + 4);
    const size = bytes.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt " && body + 8 <= bytes.length) {
      return bytes.readUInt32LE(body + 4);
    }
    if (id === "data") {
      break;
    }
    pos = body + size + (size & 1);
  }
  return null;
}

function safeAudioExtension(ext: string): string {
  return /^[a-z0-9]{1,10}$/iu.test(ext) ? ext : "bin";
}

async function transcodeToPcm(
  bytes: Buffer,
  ext: string,
  kind: MediaKind,
  transcode: TranscodeToWav,
): Promise<DecodedPcm> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arcelle-peaks-"));
  const source = path.join(tempDir, `source.${safeAudioExtension(ext)}`);
  const wav = path.join(tempDir, "decoded.wav");
  try {
    await fs.writeFile(source, bytes, { mode: 0o600, flag: "wx" });
    await transcode(source, wav, kind, tempDir);
    return { samples: decodeWav(await fs.readFile(wav)), sampleRate: SAMPLE_RATE };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function decodedWavError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof Error ? error : new Error(message);
}

export async function decodeAudioBytesWith(
  bytes: Buffer,
  ext: string,
  kind: MediaKind,
  transcode: TranscodeToWav,
): Promise<DecodedPcm> {
  let samples: Float32Array;
  try {
    samples = decodeWav(bytes);
  } catch (error) {
    const decodedError = decodedWavError(error);
    if (decodedError.message === NOT_A_WAV_FILE) {
      return transcodeToPcm(bytes, ext, kind, transcode);
    }
    throw decodedError;
  }
  return { samples, sampleRate: wavSampleRate(bytes) ?? SAMPLE_RATE };
}

export const decodeAudioBytes: DecodeToPcmFn = (bytes, ext, kind) =>
  decodeAudioBytesWith(bytes, ext, kind, transcodeWithMacOs);
