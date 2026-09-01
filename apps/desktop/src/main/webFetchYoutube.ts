import { bodyCapped, fetchPage, guardedGet, htmlTitle } from "./webFetchCore.js";

function stripAllPrefix(s: string, prefix: string): string {
  let out = s;
  while (out.startsWith(prefix)) {
    out = out.slice(prefix.length);
  }
  return out;
}

function isYoutubeId(s: string): boolean {
  return s.length >= 8 && s.length <= 16 && /^[A-Za-z0-9_-]+$/.test(s);
}

function parsedYoutubeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function normalizedYoutubeHost(host: string): string {
  return stripAllPrefix(stripAllPrefix(host, "www."), "m.");
}

function youtubePathSegments(parsed: URL): string[] {
  return parsed.pathname.split("/").filter((segment) => segment !== "");
}

function youtubeIdOrNull(id: string | null | undefined): string | null {
  return id !== null && id !== undefined && isYoutubeId(id) ? id : null;
}

function isYoutubeWebsite(host: string): boolean {
  return host === "youtube.com" || host === "youtube-nocookie.com";
}

function isYoutubeWatchPath(segments: readonly string[]): boolean {
  return segments.length === 0 || segments[0] === "watch";
}

function isYoutubeVideoRoute(segment: string | undefined): boolean {
  return segment !== undefined && ["shorts", "embed", "live"].includes(segment);
}

function youtubeWebsiteId(parsed: URL, segments: readonly string[]): string | null {
  if (isYoutubeWatchPath(segments)) {
    return youtubeIdOrNull(parsed.searchParams.get("v"));
  }
  if (!isYoutubeVideoRoute(segments[0])) {
    return null;
  }
  return youtubeIdOrNull(segments[1]);
}

/** Video id when `url` is a YouTube watch/short/embed/youtu.be link, else
 * `null` — the switch `import_link` uses to route to the transcript path.
 * Ported from `youtube_video_id`. */
export function youtubeVideoId(url: string): string | null {
  const parsed = parsedYoutubeUrl(url);
  if (parsed === null) {
    return null;
  }
  const host = normalizedYoutubeHost(parsed.hostname);
  const segments = youtubePathSegments(parsed);
  if (host === "youtu.be") {
    return youtubeIdOrNull(segments[0]);
  }
  if (!isYoutubeWebsite(host)) {
    return null;
  }
  return youtubeWebsiteId(parsed, segments);
}

interface CaptionArrayState {
  depth: number;
  inString: boolean;
  escaping: boolean;
}

function consumeCaptionStringCharacter(state: CaptionArrayState, character: string): void {
  if (state.escaping) {
    state.escaping = false;
    return;
  }
  if (character === "\\") {
    state.escaping = true;
    return;
  }
  if (character === '"') {
    state.inString = false;
  }
}

function captionArrayEndsAt(state: CaptionArrayState, character: string): boolean {
  if (state.inString) {
    consumeCaptionStringCharacter(state, character);
    return false;
  }
  if (character === '"') {
    state.inString = true;
    return false;
  }
  if (character === "[") {
    state.depth += 1;
    return false;
  }
  if (character !== "]") {
    return false;
  }
  state.depth -= 1;
  return state.depth === 0;
}

function captionArrayEnd(rest: string, start: number): number {
  const state: CaptionArrayState = { depth: 0, inString: false, escaping: false };
  for (let index = start; index < rest.length; index += 1) {
    if (captionArrayEndsAt(state, rest[index]!)) {
      return index;
    }
  }
  return -1;
}

function parsedCaptionArray(rest: string, start: number, end: number): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(rest.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Slice the `"captionTracks":[...]` array out of a watch page. The page is a
 * JS soup, so this walks the array with string/escape awareness rather than
 * trusting a regex, then hands the exact slice to `JSON.parse`. Ported from
 * `extract_caption_tracks`. */
export function extractCaptionTracks(html: string): unknown[] | null {
  const key = '"captionTracks":';
  const at = html.indexOf(key);
  if (at === -1) {
    return null;
  }
  const rest = html.slice(at + key.length);
  const start = rest.indexOf("[");
  if (start === -1) {
    return null;
  }
  const end = captionArrayEnd(rest, start);
  if (end === -1) {
    return null;
  }
  return parsedCaptionArray(rest, start, end);
}

function tsMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const rem = s % 3600;
  const m = Math.floor(rem / 60);
  const sec = rem % 60;
  const pad2 = (n: number): string => n.toString().padStart(2, "0");
  return h > 0 ? `[${h}:${pad2(m)}:${pad2(sec)}]` : `[${m}:${pad2(sec)}]`;
}

/** Turn a timedtext `fmt=json3` payload into "[m:ss] line" text — the same
 * timestamp contract the on-device transcriber writes. Ported from
 * `timedtext_json3_to_lines`. */
function unknownRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function timedtextEvents(json: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(json);
    const record = unknownRecord(value);
    return record !== null && Array.isArray(record.events) ? record.events : null;
  } catch {
    return null;
  }
}

function timedtextSegmentText(segments: readonly unknown[]): string {
  let text = "";
  for (const segment of segments) {
    const record = unknownRecord(segment);
    if (typeof record?.utf8 === "string") {
      text += record.utf8;
    }
  }
  return text.replace(/\n/g, " ").trim();
}

function timedtextLine(event: unknown): string | null {
  const record = unknownRecord(event);
  if (record === null || "aAppend" in record) {
    return null;
  }
  if (!Array.isArray(record.segs)) {
    return null;
  }
  const text = timedtextSegmentText(record.segs);
  if (text === "") {
    return null;
  }
  const milliseconds = typeof record.tStartMs === "number" ? record.tStartMs : 0;
  return `${tsMs(milliseconds)} ${text}`;
}

export function timedtextJson3ToLines(json: string): string | null {
  const events = timedtextEvents(json);
  if (events === null) {
    return null;
  }
  const lines: string[] = [];
  for (const event of events) {
    const line = timedtextLine(event);
    if (line !== null) {
      lines.push(line);
    }
  }
  return lines.length === 0 ? null : lines.join("\n");
}

function transcriptTitle(body: string, url: string): string {
  const title = htmlTitle(body);
  return title !== null ? title.replace(/ - YouTube$/, "") : url;
}

function isManualCaptionTrack(track: unknown): boolean {
  const record = unknownRecord(track);
  return record !== null && record.kind !== "asr";
}

function selectedCaptionTrack(tracks: readonly unknown[]): Record<string, unknown> | null {
  return unknownRecord(tracks.find(isManualCaptionTrack) ?? tracks[0]);
}

function captionBaseUrl(track: Record<string, unknown> | null): string {
  if (track === null) {
    throw new Error("This video has no captions/transcript to import.");
  }
  if (typeof track.baseUrl !== "string") {
    throw new Error("This video's captions could not be read.");
  }
  return track.baseUrl;
}

function timedtextUrl(base: string): string {
  return `${base}${base.includes("?") ? "&" : "?"}fmt=json3`;
}

/**
 * Fetch a YouTube video's own caption track as a timestamped transcript — no
 * video download, no extra tools. Manual captions win over auto-generated
 * ("asr") ones when both exist. Ported from `youtube_transcript`.
 *
 * The `baseUrl` comes out of an untrusted watch page, so the second fetch goes
 * through the full {@link guardedGet} exactly like the first — a caption track
 * pointing at `http://localhost:11434/` is refused, not followed.
 */
export async function youtubeTranscript(url: string): Promise<{ title: string; transcript: string }> {
  const first = await guardedGet(url);
  // YouTube serves UTF-8 unconditionally; no charset sniffing needed here.
  const body = (await bodyCapped(first, true)).toString("utf8");
  const title = transcriptTitle(body, url);
  const tracks = extractCaptionTracks(body);
  if (tracks === null) {
    throw new Error("This video has no captions/transcript to import.");
  }
  const base = captionBaseUrl(selectedCaptionTrack(tracks));
  const second = await guardedGet(timedtextUrl(base));
  const timedtext = (await bodyCapped(second, false)).toString("utf8");
  const transcript = timedtextJson3ToLines(timedtext);
  if (transcript === null) {
    throw new Error("This video's captions came back empty.");
  }
  return { title, transcript };
}

// -------------------------------------------------------- result previews (BROWSE-3b)

/** How much of a result page to read while enriching it. Everything we want —
 * `og:image`, `meta description`, `<title>`, the icon link — lives in `<head>`,
 * so a quarter-megabyte is generous. Ported from `MAX_PREVIEW_HTML_BYTES`. */
