/** Episode encoding and timestamped transcript formatting. */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PodcastTurn } from "./db-host/podcasts.js";

const execFileAsync = promisify(execFile);

export async function encodeEpisode(
  wav: Buffer,
): Promise<{ bytes: Buffer; mime: string; ext: string }> {
  const dir = path.join(os.tmpdir(), `arcelle-podcast-${randomUUID()}`);
  const cleanup = async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  await fsp.mkdir(dir, { recursive: true });
  const src = path.join(dir, "episode.wav");
  const dst = path.join(dir, "episode.m4a");
  try {
    await fsp.writeFile(src, wav);
  } catch (err) {
    await cleanup();
    throw err instanceof Error ? err : new Error(String(err));
  }
  let out: Buffer | null = null;
  try {
    await execFileAsync(
      "/usr/bin/afconvert",
      ["-f", "m4af", "-d", "aac", "-b", "64000", "-s", "3", src, dst],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    out = await fsp.readFile(dst);
  } catch {
    out = null;
  }
  await cleanup();
  if (out !== null && out.length > 0) {
    return { bytes: out, mime: "audio/mp4", ext: "m4a" };
  }
  return { bytes: wav, mime: "audio/wav", ext: "wav" };
}

export function timedTranscript(
  title: string,
  turns: readonly PodcastTurn[],
  spoken: readonly string[],
  offsets: readonly number[],
  capped: number,
): string {
  let out = `Podcast episode "${title}" — synthetic voices reading a script generated in this room. Not a recording of people.\n`;
  if (capped > 0) {
    out += `Only the first ${turns.length} turns were recorded — ${capped} more were not.\n`;
  }
  turns.forEach((turn, index) => {
    const line = spoken[index] ?? turn.line;
    const ms = offsets[index];
    if (ms !== undefined) {
      const secs = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(secs / 60);
      const seconds = String(secs % 60).padStart(2, "0");
      out += `[${minutes}:${seconds}] ${turn.speaker}: ${line}\n`;
    } else {
      out += `${turn.speaker}: ${line}\n`;
    }
  });
  return out;
}
