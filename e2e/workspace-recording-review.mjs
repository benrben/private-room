#!/usr/bin/env node

/** Real Electron regression for normal-file audio after workspace conversion.
 * It exercises the custom streaming protocol, Chromium's media decoder, the
 * peaks command, and the visible WaveSurfer view without mocks. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const requireFromElectron = createRequire(
  new URL("../electron-migration/electron-app/package.json", import.meta.url),
);
const { _electron: electron } = requireFromElectron("playwright");
const temp = await mkdtemp(path.join(os.tmpdir(), "arcelle-workspace-recording-review-"));
const roomPath = path.join(temp, "Recording Room");
const appMain = path.resolve(
  "electron-migration/electron-app/dist_package/electron/main/index.js",
);
let app;

function wavTone() {
  const rate = 16_000;
  const frames = rate;
  const out = Buffer.alloc(44 + frames * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8_000), 44 + i * 2);
  }
  return out;
}

async function invoke(window, channel, args = {}) {
  return window.evaluate(
    ({ channelName, channelArgs }) => window.arcelle.invoke(channelName, channelArgs),
    { channelName: channel, channelArgs: args },
  );
}

try {
  const env = {
    ...process.env,
    ARCELLE_E2E: "1",
    ARCELLE_USER_DATA_DIR: path.join(temp, "user-data"),
    ARCELLE_SHOW_WINDOW: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [appMain], env, timeout: 30_000 });
  const window = await app.firstWindow({ timeout: 30_000 });
  await window.waitForLoadState("domcontentloaded");
  await invoke(window, "create_room", {
    path: roomPath,
    password: "workspace-recording-review-password",
    name: "Recording Room",
    format: "workspace-folder",
  });
  await writeFile(path.join(roomPath, "workspace-tone.wav"), wavTone());
  await invoke(window, "rescan_workspace_room");
  const files = await invoke(window, "list_files");
  const tone = files.find((file) => file.name === "workspace-tone.wav");
  assert(tone, "the normal WAV must be reconciled into the room");
  const content = await invoke(window, "get_file_content", { id: tone.id });
  assert.equal(content.kind, "audio");
  assert(content.mediaToken);
  const peaks = await invoke(window, "audio_peaks", { id: tone.id, buckets: 128 });
  assert.equal(peaks.peaks.length, 128);
  assert.equal(peaks.silent, false);
  assert(Math.abs(peaks.duration - 1) < 0.01);

  const played = await window.evaluate(async (token) => {
    const audio = document.createElement("audio");
    audio.muted = true;
    audio.src = `roommedia://localhost/${token}`;
    document.body.append(audio);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("media metadata timed out")), 10_000);
        audio.onloadedmetadata = () => {
          clearTimeout(timer);
          resolve();
        };
        audio.onerror = () => {
          clearTimeout(timer);
          reject(new Error(`media error ${audio.error?.code ?? "unknown"}`));
        };
        audio.load();
      });
      await audio.play();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { duration: audio.duration, currentTime: audio.currentTime };
    } finally {
      audio.pause();
      audio.remove();
    }
  }, content.mediaToken);
  assert(Math.abs(played.duration - 1) < 0.01);
  assert(played.currentTime > 0, "Chromium must decode and advance the normal file");

  await window.reload({ waitUntil: "domcontentloaded" });
  await window.locator(".workspace").waitFor();
  await window.getByRole("button", { name: "Open Library" }).click();
  await window.locator("button.file-main", { hasText: "workspace-tone" }).click();
  await window.locator(".audio-view").waitFor();
  await window.locator(".waveform-canvas").waitFor({ timeout: 10_000 });
  assert.equal(await window.getByText("The waveform could not be drawn.", { exact: true }).count(), 0);
} finally {
  if (app) await app.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
