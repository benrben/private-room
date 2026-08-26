#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const requireFromElectron = createRequire(
  new URL("../electron-migration/electron-app/package.json", import.meta.url),
);
const { _electron: electron } = requireFromElectron("playwright");

const appPath = process.env.ARCELLE_INSTALLED_APP || "/Applications/Arcelle.app";
const executablePath = path.join(appPath, "Contents", "MacOS", "Arcelle");
const temp = await mkdtemp(path.join(os.tmpdir(), "arcelle-installed-workspace-review-"));
const screenshots = process.env.ARCELLE_REVIEW_SCREENSHOTS
  || path.join(os.tmpdir(), "arcelle-installed-workspace-screens");
const roomPath = path.join(temp, "Workspace Review");
const extractedPath = path.join(temp, "Extracted Files");
const sealedPath = path.join(temp, "workspace-review.arcelle");
const password = "workspace-review-password";
const severeConsole = [];
const pageErrors = [];
let app;

await rm(screenshots, { recursive: true, force: true });
await mkdir(screenshots, { recursive: true, mode: 0o700 });

function log(message) {
  process.stdout.write(`[installed-review] ${message}\n`);
}

async function invoke(window, channel, args) {
  return await window.evaluate(
    async ({ requestedChannel, requestedArgs }) =>
      await window.arcelle.invoke(requestedChannel, requestedArgs),
    { requestedChannel: channel, requestedArgs: args },
  );
}

async function shot(window, name) {
  const destination = path.join(screenshots, `${name}.png`);
  await window.screenshot({ path: destination, fullPage: true });
  log(`screenshot ${destination}`);
}

try {
  const env = {
    ...process.env,
    ARCELLE_E2E: "1",
    ARCELLE_USER_DATA_DIR: path.join(temp, "user-data"),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  app = await electron.launch({ executablePath, env, timeout: 30_000 });
  const window = await app.firstWindow({ timeout: 30_000 });
  window.on("console", (message) => {
    if (message.type() === "error") severeConsole.push(message.text());
  });
  window.on("pageerror", (error) => pageErrors.push(String(error)));
  await window.waitForLoadState("domcontentloaded");

  await window.getByText("Your documents stay as normal files.", { exact: false }).waitFor();
  assert.equal(await window.getByRole("button", { name: "Create New Room" }).count(), 1);
  await shot(window, "01-start");
  log("installed renderer, preload, and start-screen storage disclosure passed");

  const room = await invoke(window, "create_room", {
    path: roomPath,
    password,
    name: "Workspace Review",
    format: "workspace-folder",
  });
  assert.equal(room.storageKind, "workspace");
  await stat(path.join(roomPath, ".arcelle", "room.json"));
  await stat(path.join(roomPath, ".arcelle", "room.db"));

  await writeFile(path.join(roomPath, "notes.md"), "# Workspace review\n\nNormal file bytes.\n");
  await mkdir(path.join(roomPath, "Research"));
  await writeFile(path.join(roomPath, "Research", "data.csv"), "name,value\nalpha,1\n");
  const watcher = await invoke(window, "rescan_workspace_room");
  assert.equal(watcher.state, "ready");

  await window.reload({ waitUntil: "domcontentloaded" });
  await window.locator(".workspace").waitFor({ state: "visible" });
  await window.getByRole("button", { name: "Open Library" }).click();
  await window.getByText("notes.md", { exact: true }).waitFor();
  await window.getByText("data.csv", { exact: true }).waitFor();
  assert((await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
  await shot(window, "02-workspace-library");
  log("normal-file reconciliation, library projection, and layout passed");

  await window.getByRole("button", { name: "Open room settings (⌘,)" }).click();
  await window.getByText("What each AI can do", { exact: true }).waitFor();
  await window.getByText("Workspace agent diagnostics", { exact: true }).waitFor();
  const capabilities = await invoke(window, "harness_capabilities");
  assert.equal(capabilities.roomFormat, "workspace-folder");
  assert.equal(typeof capabilities.providers.codex.available, "boolean");
  assert.equal(typeof capabilities.providers.claude.available, "boolean");
  await shot(window, "03-settings-agents");

  await window.getByRole("button", { name: "Privacy & recovery" }).click();
  await window.getByText("normal files", { exact: false }).first().waitFor();
  await shot(window, "04-settings-privacy");
  await window.getByRole("button", { name: "History & storage" }).click();
  await window.getByRole("button", { name: "Rescan room" }).waitFor();
  await shot(window, "05-settings-history");
  await window.press("body", "Escape");
  log(`provider diagnostics passed: ${JSON.stringify(capabilities.providers)}`);

  await window.evaluate(() => {
    globalThis.__arcelleReviewProgress = [];
    window.arcelle.on("workspace-operation-progress", (progress) => {
      globalThis.__arcelleReviewProgress.push(progress);
    });
  });
  await invoke(window, "create_room_checkpoint", { name: "Installed review" });
  const progress = await window.evaluate(() => globalThis.__arcelleReviewProgress);
  assert(progress.some((item) => item.operation === "checkpoint"));
  assert(progress.some((item) => item.phase === "completed"));

  const sealed = await invoke(window, "create_sealed_package", {
    destinationPath: sealedPath,
    exportPassword: null,
    purpose: "installed-review",
  });
  assert.equal(sealed.fileCount, 2);
  const inspection = await invoke(window, "inspect_sealed_package", {
    packagePath: sealedPath,
    password,
  });
  assert.deepEqual(
    inspection.files.map((file) => file.relativePath).sort(),
    ["Research/data.csv", "notes.md"],
  );
  const notesEntry = inspection.files.find((file) => file.relativePath === "notes.md");
  assert(notesEntry);
  const extraction = await invoke(window, "extract_sealed_files", {
    packagePath: sealedPath,
    password,
    fileIds: [notesEntry.fileId],
    destinationPath: extractedPath,
  });
  assert.equal(extraction.fileCount, 1);
  assert.match(await readFile(path.join(extractedPath, "notes.md"), "utf8"), /Normal file bytes/);
  log("checkpoint progress, sealed inspection, and selected extraction passed");

  await window.getByRole("button", { name: "Activity" }).click();
  await window.getByRole("region", { name: "Workspace agents" }).waitFor();
  await window.getByText("Workspace agent", { exact: true }).waitFor();
  await shot(window, "06-agent-activity");

  await window.getByRole("button", { name: /Lock this room/ }).click();
  await window.getByText("This password unlocks chats, memory, search, and history.", { exact: false }).waitFor();
  await window.getByText("normal files in this workspace remain readable in Finder", { exact: false }).waitFor();
  await shot(window, "07-workspace-unlock");
  await window.getByPlaceholder("Password").fill(password);
  await window.getByRole("button", { name: "Unlock", exact: true }).click();
  await window.locator(".workspace").waitFor({ state: "visible" });
  log("lock, honest workspace disclosure, SQLCipher unlock, and reopen passed");

  await shot(window, "08-reopened-workspace");
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(severeConsole, []);
  log("PASS: installed workspace UI review completed without renderer errors");
} finally {
  if (app) await app.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}

