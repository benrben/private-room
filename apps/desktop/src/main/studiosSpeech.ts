/** Privacy-gated text-to-speech preparation shared by Studio audio paths. */

import type Database from "better-sqlite3-multiple-ciphers";
import { webAccessEnabled } from "./browser/webAccess.js";
import { CancelFlag } from "./cancel.js";
import { remoteSeamRedactor } from "./privacy.js";
import { emptyPrivacyReport } from "./privacyRedact.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";

export const MAX_SPEAK_CHARS = 1_000;

export const SPEECH_OFFLINE_MESSAGE =
  "Reading an answer aloud sends that sentence to an online voice service, and this room's " +
  "internet switch is off (Settings → Online features). Nothing was sent.";

export function speakableText(db: Database.Database, text: string): string {
  if (!webAccessEnabled(db)) {
    throw new Error(SPEECH_OFFLINE_MESSAGE);
  }
  return redactForSpeech(text);
}

export function redactForSpeech(text: string): string {
  const policy = remoteSeamRedactor();
  if (policy === null) {
    return text;
  }
  return policy.redactor.redact(text, emptyPrivacyReport());
}

function speakPrecheck(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error("nothing to speak");
  }
  if (Array.from(trimmed).length > MAX_SPEAK_CHARS) {
    throw new Error("text too long to speak in one chunk");
  }
  return trimmed;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export type SidecarOutcome = Awaited<ReturnType<typeof sidecarJsonCancellable>>;

function addSpeechOption(
  body: Record<string, unknown>,
  key: "voice" | "rate" | "pitch",
  value: string | undefined,
): void {
  const trimmed = value?.trim();
  if (trimmed !== undefined && trimmed !== "") body[key] = trimmed;
}

function speechBody(
  text: string,
  voice: string | undefined,
  rate: string | undefined,
  pitch: string | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { text };
  addSpeechOption(body, "voice", voice);
  addSpeechOption(body, "rate", rate);
  addSpeechOption(body, "pitch", pitch);
  return body;
}

export function successfulSidecarValue(
  outcome: SidecarOutcome,
  stoppedMessage: string,
): unknown {
  if (outcome.kind === "error") throw new Error(outcome.error.error);
  if (outcome.kind === "stopped") throw new Error(stoppedMessage);
  return outcome.value;
}

function speechAudio(outcome: SidecarOutcome): string {
  const response = asRecord(successfulSidecarValue(outcome, "Stopped."));
  const audioB64 =
    response !== null && typeof response.audio_b64 === "string" ? response.audio_b64 : null;
  if (audioB64 === null) throw new Error("neural voice returned no audio");
  return audioB64;
}

export async function speakOne(
  db: Database.Database,
  text: string,
  voice: string | undefined,
  rate: string | undefined,
  pitch: string | undefined,
): Promise<string> {
  const trimmed = speakPrecheck(text);
  const outbound = speakableText(db, trimmed);
  const outcome = await sidecarJsonCancellable(
    "/tts",
    speechBody(outbound, voice, rate, pitch),
    new CancelFlag(),
  );
  return speechAudio(outcome);
}
