import { isRecordingFile, type FileMeta } from "../api";
import type { WSState } from "./state";

export interface RecordingOverview {
  recs: FileMeta[];
  newest: FileMeta | null;
  now: CaptureNow | null;
  writingUp: FileMeta[];
  waiting: RecordingAttention[];
  waitingShown: RecordingAttention[];
  tally: ShelfTally;
  newestDrawnElsewhere: boolean;
}

/** Collect page facts once so display components share ordering and status. */
export function recordingOverview(
  s: Pick<WSState, "files" | "recLive" | "recSave" | "sttStatus">,
): RecordingOverview {
  const recs = s.files
    .filter(isRecordingFile)
    .slice()
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  const newest = recs[0] ?? null;
  const now = captureNow(s.recLive, s.recSave);
  const writingUp = transcribingNow(recs, s.sttStatus);
  const waiting = needsAttention(recs, s.sttStatus, now?.fileId ?? null);
  const waitingShown = waiting.slice(0, ATTENTION_SHOWN);
  const tally = shelfTally(recs);
  const newestDrawnElsewhere =
    newest !== null && newestAlreadyOnPage(newest.id, now, waitingShown);

  return {
    recs,
    newest,
    now,
    writingUp,
    waiting,
    waitingShown,
    tally,
    newestDrawnElsewhere,
  };
}

/** The live capture session held by workspace state. */
export interface LiveCapture {
  fileId: string;
  status: string;
}

/** The stop-to-saved drain. Its presence means audio is already durable. */
export interface SaveDrain {
  stage: "transcribing" | "writing";
  remaining: number;
  startedAt: string;
}

export type CapturePhase = "recording" | "paused" | "saving";

export interface CaptureNow {
  phase: CapturePhase;
  fileId: string;
}

/** Resolve the live and save-drain signals into one current capture phase. */
export function captureNow(
  recLive: LiveCapture | null,
  recSave: SaveDrain | null,
): CaptureNow | null {
  if (!recLive) return null;
  if (recSave != null || recLive.status === "saving") {
    return { phase: "saving", fileId: recLive.fileId };
  }
  if (recLive.status === "paused") return { phase: "paused", fileId: recLive.fileId };
  return { phase: "recording", fileId: recLive.fileId };
}

export const CAPTURE_WORD: Record<CapturePhase, string> = {
  recording: "Recording now",
  paused: "Paused",
  saving: "Saving",
};

export const CAPTURE_MARK: Record<CapturePhase, string> = {
  recording: "nb-sem-urgent",
  paused: "nb-sem-pending",
  saving: "nb-sem-linked",
};

export function saveDetail(recSave: SaveDrain | null): string {
  if (recSave?.stage === "writing") return "Audio saved — writing into the room…";
  if (recSave && recSave.remaining > 0) {
    return `Audio saved — transcribing (${recSave.remaining} to go)`;
  }
  return "Audio saved — finishing the transcript…";
}

export function captureDetail(
  phase: CapturePhase,
  recSave: SaveDrain | null,
): string {
  if (phase === "saving") return saveDetail(recSave);
  if (phase === "paused") {
    return "The microphone is closed. Nothing is lost — resume it in the recording itself.";
  }
  return "The microphone is open. Open the recording to watch it, stop it, or name a speaker.";
}

/** Imported media currently being transcribed in the background. */
export function transcribingNow(
  recs: FileMeta[],
  sttStatus: Record<string, string>,
): FileMeta[] {
  return recs.filter((file) => sttStatus[file.name] === "processing");
}

export type AttentionReason = "model-missing" | "failed" | "no-speech" | "not-yet";

export interface RecordingAttention {
  file: FileMeta;
  reason: AttentionReason;
  detail: string;
}

const ATTENTION_RANK: Record<AttentionReason, number> = {
  "model-missing": 0,
  failed: 1,
  "no-speech": 2,
  "not-yet": 3,
};

export const ATTENTION_SHOWN = 5;

export const ATTENTION_WORD: Record<AttentionReason, string> = {
  "model-missing": "No speech model",
  failed: "Could not be read",
  "no-speech": "No speech found",
  "not-yet": "No transcript yet",
};

export const ATTENTION_COPY: Record<AttentionReason, string> = {
  "model-missing":
    "Install a speech model in Settings and this will transcribe itself.",
  failed: "Converting the file to a common format usually fixes this.",
  "no-speech": "The audio was read all the way through and held no speech.",
  "not-yet": "Nothing has transcribed it yet. Open it to transcribe it.",
};

/** Extract the backend's own explanation from a failed stage. */
export function failureDetail(stage: string | undefined): string {
  if (!stage?.startsWith("failed")) return "";
  return stage.slice("failed:".length).trim();
}

export function attentionReason(
  file: FileMeta,
  stage: string | undefined,
  busyFileId: string | null,
): AttentionReason | null {
  if (isTranscriptPendingElsewhere(file, stage, busyFileId)) return null;
  return attentionStageReason(stage);
}

function isTranscriptPendingElsewhere(
  file: FileMeta,
  stage: string | undefined,
  busyFileId: string | null,
): boolean {
  return file.hasText || file.id === busyFileId || stage === "processing";
}

const ATTENTION_STAGE_REASON: Record<string, AttentionReason> = {
  "model-missing": "model-missing",
  none: "no-speech",
};

function attentionStageReason(stage: string | undefined): AttentionReason {
  if (stage?.startsWith("failed")) return "failed";
  return ATTENTION_STAGE_REASON[stage ?? ""] ?? "not-yet";
}

/** Recordings waiting for a transcript, worst reason then newest first. */
export function needsAttention(
  recs: FileMeta[],
  sttStatus: Record<string, string>,
  busyFileId: string | null,
): RecordingAttention[] {
  const waiting: RecordingAttention[] = [];
  for (const file of recs) {
    const stage = sttStatus[file.name];
    const reason = attentionReason(file, stage, busyFileId);
    if (reason === null) continue;
    waiting.push({ file, reason, detail: failureDetail(stage) });
  }
  return waiting.sort(
    (x, y) =>
      ATTENTION_RANK[x.reason] - ATTENTION_RANK[y.reason] ||
      y.file.createdAt.localeCompare(x.file.createdAt),
  );
}

export function newestAlreadyOnPage(
  newestId: string,
  now: CaptureNow | null,
  shownWaiting: RecordingAttention[],
): boolean {
  if (now?.fileId === newestId) return true;
  return shownWaiting.some((waiting) => waiting.file.id === newestId);
}

export interface ShelfChip {
  word: string;
  mark: string;
  loud: boolean;
}

/** Give a shelf card one status consistent with the live panel. */
export function shelfChip(
  file: FileMeta,
  now: CaptureNow | null,
  stage: string | undefined,
): ShelfChip {
  if (now?.fileId === file.id) {
    return {
      word: CAPTURE_WORD[now.phase],
      mark: CAPTURE_MARK[now.phase],
      loud: now.phase === "recording",
    };
  }
  if (stage === "processing") {
    return { word: "Writing up", mark: "nb-sem-linked", loud: false };
  }
  if (file.hasText) {
    return { word: "Transcribed", mark: "nb-sem-done", loud: false };
  }
  return { word: "No transcript yet", mark: "nb-sem-pending", loud: false };
}

export interface ShelfTally {
  count: number;
  transcribed: number;
  bytes: number;
}

export function shelfTally(recs: FileMeta[]): ShelfTally {
  return {
    count: recs.length,
    transcribed: recs.filter((file) => file.hasText).length,
    bytes: recs.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}

export function countLabel(count: number): string {
  return count === 1 ? "recording" : "recordings";
}

export function transcribedPhrase(tally: ShelfTally): string {
  if (tally.count === 0) return "transcribed";
  if (tally.transcribed === tally.count) return "transcribed — all of them";
  if (tally.transcribed === 0) return `transcribed — none of ${tally.count} yet`;
  return `transcribed of ${tally.count}`;
}
