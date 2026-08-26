/** Neural speech commands and the whole-file on-device transcription lane. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { NeuralVoiceInfo } from "../shared/apiTypes.js";
import type { RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import { CancelFlag } from "./cancel.js";
import { getFileFull, setFileExtractedText } from "./db-host/files.js";
import { setSetting } from "./db-host/settings.js";
import { mediaKind } from "./peaksTools.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";
import { speakOne } from "./studiosPodcastAudio.js";
import { sttEffectiveModel } from "./sttTools.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function voice(value: unknown): NeuralVoiceInfo | null {
  const row = object(value);
  return typeof row.id === "string" && typeof row.gender === "string" && typeof row.locale === "string"
    ? { id: row.id, gender: row.gender, locale: row.locale }
    : null;
}

export function registerSpeechSttSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  userDataDir: string,
  resourcesPath: string | null,
  emit: EventSender,
  onIndexed?: (roomPath: string) => void,
): void {
  const room = () => {
    if (!state.room) throw new Error("No room is open.");
    return state.room;
  };
  ipcMain.handle("speak_text_neural", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const args = object(raw);
    return speakOne(
      room().conn,
      String(args.text ?? ""),
      typeof args.voice === "string" ? args.voice : undefined,
      undefined,
      undefined,
    );
  });
  ipcMain.handle("list_neural_voices", async (): Promise<NeuralVoiceInfo[]> => {
    const outcome = await sidecarJsonCancellable("/tts/voices", {}, new CancelFlag());
    if (outcome.kind === "stopped") throw new Error("Stopped.");
    if (outcome.kind === "error") throw new Error(outcome.error.error);
    const raw = object(outcome.value).voices;
    if (!Array.isArray(raw)) throw new Error("voice catalog returned no voices");
    const voices = raw.map(voice).filter((item): item is NeuralVoiceInfo => item !== null);
    if (state.room) {
      const ids = [
        ...voices.filter((item) => item.id.includes("Multilingual")),
        ...voices.filter((item) => !item.id.includes("Multilingual")),
      ].slice(0, 24).map((item) => item.id);
      if (ids.length) setSetting(state.room.conn, "voice_catalog_ids", ids.join(","));
    }
    return voices;
  });
  ipcMain.handle("retranscribe_file", (_event: IpcMainInvokeEvent, raw: unknown) =>
    retranscribeFile(state, userDataDir, resourcesPath, emit, String(object(raw).fileId ?? ""), onIndexed));
}

export async function retranscribeFile(
  state: RoomManagerState,
  userDataDir: string,
  resourcesPath: string | null,
  emit: EventSender,
  fileId: string,
  onIndexed?: (roomPath: string) => void,
): Promise<void> {
    const open = state.room;
    if (!open) throw new Error("No room is open.");
    const [name, mime0, bytes] = getFileFull(open.conn, fileId);
    const mime = mime0 ?? "application/octet-stream";
    const extension = path.extname(name).slice(1).toLowerCase();
    const kind = mediaKind(mime, extension);
    if (kind === null) throw new Error("This file isn't audio or video, so there's nothing to transcribe.");
    if (!bytes) throw new Error("This recording has no stored audio bytes.");
    const modelPath = sttEffectiveModel(userDataDir, resourcesPath);
    if (!modelPath) {
      emit("stt-progress", [name, "model-missing"]);
      return;
    }
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "arcelle-stt-"));
    const staged = path.join(tempDir, `source.${extension || "bin"}`);
    try {
      await fs.promises.writeFile(staged, bytes, { mode: 0o600 });
      emit("stt-progress", [name, "started"]);
      const outcome = await sidecarJsonCancellable(
        "/stt/transcribe_file",
        { path: staged, model_path: modelPath, kind },
        new CancelFlag(),
        10 * 60 * 60 * 1000,
      );
      if (outcome.kind === "stopped") throw new Error("Stopped.");
      if (outcome.kind === "error") throw new Error(outcome.error.error);
      const text = object(outcome.value).text;
      if (typeof text !== "string") throw new Error("The speech engine returned no transcript.");
      if (!state.room || state.room.path !== open.path) throw new Error("The room was closed while transcription was running.");
      setFileExtractedText(state.room.conn, fileId, text);
      emit("file-updated", fileId);
      emit("room-files-changed", {});
      onIndexed?.(open.path);
      emit("stt-progress", [name, text.trim() === "" ? "none" : "done"]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit("stt-progress", [name, `failed: ${message}`]);
      throw error;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

/** Transcribe in-memory media for chat's #transcribe command without first
 * committing a duplicate room file. The bytes are staged privately because
 * the sidecar endpoint intentionally accepts paths, not arbitrary host files. */
export async function transcribeMediaBytes(
  userDataDir: string,
  resourcesPath: string | null,
  bytes: Buffer,
  extension: string,
  kind: "audio" | "video",
): Promise<string> {
  const modelPath = sttEffectiveModel(userDataDir, resourcesPath);
  if (!modelPath) throw new Error("The speech model is not installed. Download it in Settings first.");
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "arcelle-stt-"));
  const staged = path.join(tempDir, `source.${extension || "bin"}`);
  try {
    await fs.promises.writeFile(staged, bytes, { mode: 0o600 });
    const outcome = await sidecarJsonCancellable(
      "/stt/transcribe_file",
      { path: staged, model_path: modelPath, kind },
      new CancelFlag(),
      10 * 60 * 60 * 1000,
    );
    if (outcome.kind === "stopped") throw new Error("Stopped.");
    if (outcome.kind === "error") throw new Error(outcome.error.error);
    const text = object(outcome.value).text;
    if (typeof text !== "string") throw new Error("The speech engine returned no transcript.");
    return text;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
