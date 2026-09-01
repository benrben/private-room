import { type RecMeta, type RecSegment, type RecWord } from "../api";
import { cutShiftBefore } from "./recTiming";
import { formatTimestamp, recordingCanPlay, seekMarks } from "./recReview";
import { RecordingLiveState, NO_CAPTURE_CONTAINERS } from "./RecordingView";

export interface TurnSeg {
  seg: RecSegment;
  visible: RecWord[] | null;
  text: string;
}

/** A run of consecutive same-speaker segments, shown as one block: timestamp
 * and speaker chip once, the phrases flowing together as a paragraph. */
export interface Turn {
  key: string;
  speaker: string;
  t0: number;
  dir: "rtl" | "ltr" | "auto";
  segs: TurnSeg[];
}

export interface ExportPhrase {
  t0: number;
  t1: number;
  speaker: string;
  text: string;
}

export function keptWordsForExport(segment: RecSegment): RecWord[] | null {
  return segment.words.length ? segment.words.filter((word) => !word.del) : null;
}

export function exportText(segment: RecSegment, kept: readonly RecWord[] | null): string {
  return kept === null ? segment.text : kept.map((word) => word.w).join(" ");
}

export function exportBounds(segment: RecSegment, kept: readonly RecWord[] | null): { t0: number; t1: number } {
  if (!kept?.length) return { t0: segment.t0, t1: segment.t1 };
  return { t0: kept[0].t0, t1: kept[kept.length - 1].t1 };
}

export function exportTime(cuts: readonly { t0: number; t1: number }[], shifted: boolean, time: number): number {
  return shifted ? time - cutShiftBefore(cuts, time) : time;
}

export function keptExportPhrase(
  segment: RecSegment,
  cuts: readonly { t0: number; t1: number }[],
  speakerName: (label: string) => string,
  shifted: boolean,
): ExportPhrase | null {
  const kept = keptWordsForExport(segment);
  const text = exportText(segment, kept);
  if (!text.trim()) return null;
  const { t0, t1 } = exportBounds(segment, kept);
  return {
    t0: exportTime(cuts, shifted, t0),
    t1: exportTime(cuts, shifted, t1),
    speaker: speakerName(segment.speaker),
    text: text.trim(),
  };
}

export function keptExportPhrases(
  segments: readonly RecSegment[],
  cuts: readonly { t0: number; t1: number }[],
  speakerName: (label: string) => string,
  shifted: boolean,
): ExportPhrase[] {
  const phrases: ExportPhrase[] = [];
  for (const segment of segments) {
    const phrase = keptExportPhrase(segment, cuts, speakerName, shifted);
    if (phrase) phrases.push(phrase);
  }
  return phrases;
}

/** The turn body needs an explicit direction: its per-segment children carry
 * dir="auto" (so a mixed-language turn isolates each phrase), and HTML's
 * dir="auto" resolution skips children that have a dir attribute — the parent
 * would always fall back to LTR. So resolve "first strong letter wins" here. */
export function strongDir(text: string): "rtl" | "ltr" | null {
  const m = text.match(/\p{L}/u);
  if (!m) return null;
  return /[\u0591-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(m[0]) ? "rtl" : "ltr";
}

export function phraseForSegment(seg: RecSegment, showDeleted: boolean): TurnSeg | null {
  const visible = seg.words.length ? seg.words.filter((word) => showDeleted || !word.del) : null;
  if (visible && visible.length === 0) return null;
  const text = visible ? visible.map((word) => word.w).join(" ") : seg.text;
  if (!text) return null;
  return { seg, visible, text };
}

export function groupedTurns(segments: readonly RecSegment[], showDeleted: boolean): Turn[] {
  const turns: Turn[] = [];
  for (const seg of segments) {
    const phrase = phraseForSegment(seg, showDeleted);
    if (!phrase) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker) last.segs.push(phrase);
    else turns.push({ key: seg.id, speaker: seg.speaker, t0: seg.t0, dir: "auto", segs: [phrase] });
  }
  return turns;
}

export function directedTurns(segments: readonly RecSegment[], showDeleted: boolean): Turn[] {
  return groupedTurns(segments, showDeleted).map((turn) => ({
    ...turn,
    dir: strongDir(turn.segs.map((phrase) => phrase.text).join(" ")) ?? "auto",
  }));
}

export function cutAt(cuts: readonly { t0: number; t1: number }[], cs: number) {
  return cuts.find((cut) => cs >= cut.t0 && cs < cut.t1);
}

export function nextCut(cuts: readonly { t0: number; t1: number }[], cs: number) {
  let next: { t0: number; t1: number } | null = null;
  for (const cut of cuts) {
    if (cut.t0 > cs && (!next || cut.t0 < next.t0)) next = cut;
  }
  return next;
}

export function shouldPersistSpeakerName(name: string, current: string, guessed: boolean, hadName: boolean): boolean {
  if (name === current && !guessed) return false;
  return Boolean(name) || hadName;
}

export function speakerRenameMessage(label: string, name: string, previous: string, wasGuessed: boolean): string {
  if (!name) return `Back to "${label}".`;
  if (wasGuessed && name === previous) return `Confirmed — "${name}" it is.`;
  if (wasGuessed) return `Every line ${label} said is now "${name}" — and this room won't call that voice "${previous}" again.`;
  return `Every line ${label} said is now "${name}". New recordings will recognise this voice.`;
}

export function exportBody(kind: "text" | "srt", phrases: readonly ExportPhrase[], stamp: (cs: number) => string): string {
  if (kind === "srt") {
    return phrases.map((phrase, index) => `${index + 1}\n${stamp(phrase.t0)} --> ${stamp(Math.max(phrase.t1, phrase.t0 + 50))}\n${phrase.speaker}: ${phrase.text}\n`).join("\n");
  }
  return phrases.map((phrase) => `[${formatTimestamp(phrase.t0)}] ${phrase.speaker}: ${phrase.text}`).join("\n");
}

export function exportFileName(kind: "text" | "srt", date: string): string {
  return `Transcript ${date}.${kind === "srt" ? "srt" : "txt"}`;
}

export function exportToastText(kind: "text" | "srt", hasCuts: boolean, name: string): string {
  if (kind === "srt" && hasCuts) return `Saved "${name}" into this room — timed for the edited copy, not the original.`;
  return `Saved "${name}" into this room.`;
}

export function editedCopyAction(kind: "text" | "srt", hasCuts: boolean, run: () => void) {
  if (kind !== "srt" || !hasCuts) return undefined;
  return { label: "Export the edited copy", run };
}

export function cutSkipDelayMs(next: { t0: number }, cs: number, playbackRate: number): number {
  return (((next.t0 - cs) / 100) * 1000) / (playbackRate || 1);
}

/** Playback volume and speed for the SESSION, not for the mount.
 *
 * The viewer host remounts this component per file, so reviewing a stack of
 * meetings at 1.5\u00D7 meant setting the speed again on every one of them. Same
 * reason the mic mute lives in `liveRec` module state: the preference outlives
 * the component. Nothing is written to disk. */

export function sessionForFile(live: RecordingLiveState | null, fileId: string) {
  const mine = live?.fileId === fileId ? live : null;
  return { status: mine?.status ?? "idle" };
}

export function isLiveStatus(status: string): boolean {
  return status === "recording" || status === "paused" || status === "saving";
}

export function segmentsOf(meta: RecMeta | null): RecSegment[] {
  return meta?.segments ?? [];
}

export function playbackSource(mediaToken: string | null, isLive: boolean): string | null {
  return recordingCanPlay(mediaToken, isLive) ? `roommedia://localhost/${mediaToken}` : null;
}

export function recordingContainer(fileName: string | null): string | null {
  if (fileName === null) return null;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

export function canCaptureInto(isLive: boolean, fileName: string | null): boolean {
  const container = recordingContainer(fileName);
  return isLive || container === null || !NO_CAPTURE_CONTAINERS.has(container);
}

export function recordingCapabilities(isLive: boolean, durationCs: number, mediaToken: string | null) {
  const hasAudio = durationCs > 0;
  const canRetranscribe = !isLive && (hasAudio || !!mediaToken);
  return { hasAudio, canRetranscribe, rebuildOnlyInDrawer: canRetranscribe && !hasAudio };
}

export function retranscribePercent(retrans: { doneCs: number; totalCs: number } | null): number | null {
  if (!retrans) return null;
  return Math.min(100, Math.round((retrans.doneCs / Math.max(1, retrans.totalCs)) * 100));
}

export function pausedOrSavingState(status: string) {
  return { word: status === "paused" ? "Paused" : "Saving", mark: "nb-sem-pending" };
}

export function transcriptState(hasAudio: boolean, segments: RecSegment[]) {
  if (segments.length > 0) return { word: "Transcript ready", mark: "nb-sem-done" };
  return hasAudio
    ? { word: "No transcript yet", mark: "nb-sem-pending" }
    : { word: "Nothing recorded", mark: "nb-sem-linked" };
}

export function recordingState(status: string, recordingNow: boolean, hasAudio: boolean, segments: RecSegment[]) {
  if (recordingNow) return { word: "Recording", mark: "nb-sem-urgent" };
  if (status === "paused" || status === "saving") return pausedOrSavingState(status);
  return transcriptState(hasAudio, segments);
}

export function transcriptMarks(meta: RecMeta | null, durationCs: number) {
  return seekMarks(durationCs, meta?.highlights ?? [], meta?.chapters ?? []);
}

export function hasRecordingContent(hasAudio: boolean, segments: readonly RecSegment[]): boolean {
  return hasAudio || segments.length > 0;
}

export function ghostsForSpeaker<T extends { speaker: string | null }>(speaker: string | undefined, ghosts: readonly T[]): T[] {
  if (!speaker) return [];
  return ghosts.filter((ghost) => ghost.speaker === speaker);
}
