import type { MediaMeta } from "../shared/apiTypes.js";

export const EMPTY_MEDIA_META: MediaMeta = {
  durationSecs: null,
  width: null,
  height: null,
  videoCodec: null,
  frameRate: null,
  bitrateKbps: null,
  hasAudio: null,
  audioCodec: null,
};

export function isEmptyMediaMeta(meta: MediaMeta): boolean {
  return [
    meta.durationSecs,
    meta.width,
    meta.height,
    meta.videoCodec,
    meta.frameRate,
    meta.bitrateKbps,
    meta.hasAudio,
    meta.audioCodec,
  ].every((value) => value === null);
}

const CODEC_NAMES: ReadonlyMap<string, string> = new Map([
  ["avc1", "H.264"],
  ["avc3", "H.264"],
  ["hvc1", "HEVC"],
  ["hev1", "HEVC"],
  ["vp09", "VP9"],
  ["av01", "AV1"],
  ["mp4v", "MPEG-4"],
  ["jpeg", "Motion JPEG"],
  ["apch", "Apple ProRes"],
  ["apcn", "Apple ProRes"],
  ["apcs", "Apple ProRes"],
  ["apco", "Apple ProRes"],
  ["ap4h", "Apple ProRes"],
  ["ap4x", "Apple ProRes"],
  ["aac", "AAC"],
  ["mp4a", "AAC"],
  [".mp3", "MP3"],
  ["mp3", "MP3"],
  ["lpcm", "Linear PCM"],
  ["alac", "Apple Lossless"],
  ["opus", "Opus"],
]);

export function codecName(fourcc: string): string {
  return CODEC_NAMES.get(fourcc) ?? fourcc;
}

const FFMPEG_UNTAGGED = /^(\[-?\d+\])+$/;

export function fourccString(tag: string | null | undefined): string | null {
  if (tag === null || tag === undefined) return null;
  if (!printableAscii(tag) || FFMPEG_UNTAGGED.test(tag)) return null;
  const trimmed = tag.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function printableAscii(tag: string): boolean {
  for (let index = 0; index < tag.length; index += 1) {
    const code = tag.charCodeAt(index);
    if (code < 0x20 || code >= 0x7f) return false;
  }
  return true;
}

export function saneFrameRate(fps: number): number | null {
  return Number.isFinite(fps) && fps > 0 && fps <= 1000
    ? Math.round(fps * 100) / 100
    : null;
}

export function fractionOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const match = /^(-?\d+)\/(-?\d+)$/.exec(raw.trim());
  if (match === null) return null;
  const denominator = Number(match[2]);
  return denominator === 0 ? null : Number(match[1]) / denominator;
}

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}
