#!/usr/bin/env node

/** Real installed-app regression for a recording converted out of a legacy
 * database. It proves the recording row and audio become a normal workspace
 * file, then exercises RecordingView, WaveSurfer, the streaming protocol, the
 * peaks command, and Chromium playback without mocks. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const requireFromElectron = createRequire(
  new URL("../electron-migration/electron-app/package.json", import.meta.url),
);
const { _electron: electron } = requireFromElectron("playwright");
const appPath = process.env.ARCELLE_INSTALLED_APP || "/Applications/Arcelle.app";
const executablePath = path.join(appPath, "Contents", "MacOS", "Arcelle");
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "arcelle-installed-recording-review-"),
);
const inputPath = path.join(temporary, "converted-meeting.wav");
const sourcePath = path.join(temporary, "Legacy Recording.roomai");
const workspacePath = path.join(temporary, "Converted Recording Room");
const password = "workspace-recording-review-password";
let app;

async function closeAppSafely(application) {
  const processHandle = application.process();
  let timeout;
  const closed = application.close().then(() => true, () => true);
  const completed = await Promise.race([
    closed,
    new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 5_000); }),
  ]);
  clearTimeout(timeout);
  if (!completed) {
    processHandle.kill("SIGKILL");
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
}

function log(message) {
  process.stdout.write(`[recording-review] ${message}\n`);
}

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
    out.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8_000),
      44 + i * 2,
    );
  }
  return out;
}

async function invoke(window, channel, args = {}) {
  return await window.evaluate(
    async ({ channelName, channelArgs }) =>
      await window.arcelle.invoke(channelName, channelArgs),
    { channelName: channel, channelArgs: args },
  );
}

try {
  await stat(executablePath);
  log(`installed app ${executablePath}`);
  await writeFile(inputPath, wavTone());
  const env = {
    ...process.env,
    ARCELLE_E2E: "1",
    ARCELLE_USER_DATA_DIR: path.join(temporary, "user-data"),
    ARCELLE_SHOW_WINDOW: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath, env, timeout: 30_000 });
  const window = await app.firstWindow({ timeout: 30_000 });
  window.setDefaultTimeout(15_000);
  const pageErrors = [];
  const severeConsole = [];
  window.on("pageerror", (error) => pageErrors.push(String(error)));
  window.on("console", (message) => {
    if (message.type() === "error") severeConsole.push(message.text());
  });
  await window.waitForLoadState("domcontentloaded");

  await invoke(window, "create_room", {
    path: sourcePath,
    password,
    name: "Legacy Recording",
    format: "sealed-db",
  });
  const recording = await invoke(window, "import_audio_bytes", {
    name: "converted-meeting.wav",
    b64: wavTone().toString("base64"),
  });
  // Use the public recording edit surface to create the explicit recordings
  // row in the legacy room. Row existence, rather than an audio MIME type, is
  // what routes this file to RecordingView after conversion.
  await invoke(window, "rec_note_add", {
    id: recording.id,
    t0: 0,
    kind: "point",
    text: "Legacy recording conversion fixture",
  });
  await invoke(window, "close_room");

  const conversion = await invoke(window, "convert_legacy_room", {
    sourcePath,
    password,
    destinationPath: workspacePath,
  });
  assert.equal(conversion.convertedFiles, 1);
  await invoke(window, "open_room", { path: workspacePath, password });
  assert.deepEqual(
    await readFile(path.join(workspacePath, "converted-meeting.wav")),
    await readFile(inputPath),
  );
  log("legacy recording converted to an unchanged normal WAV file");

  const content = await invoke(window, "get_file_content", { id: recording.id });
  assert.equal(content.kind, "recording");
  assert(content.mediaToken);
  const recordingPayload = await invoke(window, "rec_get", { id: recording.id });
  assert.equal(recordingPayload.meta.notes.length, 1);
  assert.equal(recordingPayload.meta.notes[0].text, "Legacy recording conversion fixture");
  const peaks = await invoke(window, "audio_peaks", { id: recording.id, buckets: 128 });
  assert.equal(peaks.peaks.length, 128);
  assert.equal(peaks.silent, false);
  assert(Math.abs(peaks.duration - 1) < 0.01);

  // Room creation/opening above used the test IPC directly. Reload once so
  // the renderer boots from the now-open room and mounts its real workspace.
  // Installed reviews run with an isolated temporary Keychain, preventing an
  // unrelated provider credential sheet from blocking this navigation.
  await window.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  await window.locator(".workspace").waitFor({ state: "visible" });
  await window.locator('[data-area="recordings"]').evaluate((button) => button.click());
  const recordingRow = window.locator("button.file-main", { hasText: "converted-meeting" });
  await recordingRow.waitFor({ state: "visible" });
  await recordingRow.evaluate((button) => button.click());
  await window.waitForTimeout(1_000);
  await window.locator(".rec-view").waitFor({ state: "visible" });
  await window.locator(".waveform-canvas").waitFor({ state: "visible" });
  await window.waitForFunction(() => {
    const holder = document.querySelector(".rec-view .waveform-canvas");
    if (!holder) return false;
    const candidates = [holder, ...holder.querySelectorAll("*")];
    return candidates.some((candidate) => {
      const root = candidate.shadowRoot;
      const canvas = root?.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
    });
  }, undefined, { timeout: 15_000 });
  assert.equal(
    await window.getByText("The waveform could not be drawn.", { exact: true }).count(),
    0,
  );
  log("RecordingView rendered a real WaveSurfer canvas");

  await window.locator("audio.rec-player").evaluate((audio) => {
    audio.muted = true;
  });
  await window.getByRole("button", { name: "Play the recording" }).evaluate((button) => button.click());
  await window.waitForFunction(() => {
    const audio = document.querySelector(".rec-view audio.rec-player");
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > 0.05;
  }, undefined, { timeout: 10_000 });
  const playback = await window.locator("audio.rec-player").evaluate((audio) => ({
    currentTime: audio.currentTime,
    duration: audio.duration,
  }));
  assert(playback.currentTime > 0.05);
  assert(Math.abs(playback.duration - 1) < 0.01);
  await window.getByRole("button", { name: "Pause playback" }).evaluate((button) => button.click());
  await window.waitForFunction(() => {
    const audio = document.querySelector(".rec-view audio.rec-player");
    return audio instanceof HTMLAudioElement && audio.paused;
  });

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(severeConsole, []);
  log("converted RecordingView waveform and UI playback passed without renderer errors; PASS");
} finally {
  if (app) await closeAppSafely(app);
  await rm(temporary, { recursive: true, force: true });
}
