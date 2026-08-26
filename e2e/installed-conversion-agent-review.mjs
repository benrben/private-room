#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const requireFromElectron = createRequire(
  new URL("../electron-migration/electron-app/package.json", import.meta.url),
);
const { _electron: electron } = requireFromElectron("playwright");

const appPath = process.env.ARCELLE_INSTALLED_APP || "/Applications/Arcelle.app";
const executablePath = path.join(appPath, "Contents", "MacOS", "Arcelle");
const model = process.env.ARCELLE_LOCAL_AGENT_MODEL || "qwen3.5:4b-mlx";
const password = "converted-agent-review-password";
const temporary = await mkdtemp(path.join(os.tmpdir(), "arcelle-installed-conversion-agent-"));
const sourcePath = path.join(temporary, "Legacy Agent Review.roomai");
const workspacePath = path.join(temporary, "Converted Agent Review");
let app;

function log(message) {
  process.stdout.write(`[conversion-agent-review] ${message}\n`);
}

async function invoke(window, channel, args = {}) {
  return await window.evaluate(
    async ({ requestedChannel, requestedArgs }) =>
      await window.arcelle.invoke(requestedChannel, requestedArgs),
    { requestedChannel: channel, requestedArgs: args },
  );
}

try {
  const env = {
    ...process.env,
    ARCELLE_E2E: "1",
    ARCELLE_USER_DATA_DIR: path.join(temporary, "user-data"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath, env, timeout: 30_000 });
  const window = await app.firstWindow({ timeout: 30_000 });
  const pageErrors = [];
  window.on("pageerror", (error) => pageErrors.push(String(error)));
  await window.waitForLoadState("domcontentloaded");

  await invoke(window, "create_room", {
    path: sourcePath,
    password,
    name: "Legacy Agent Review",
    format: "sealed-db",
  });
  const legacyFile = await invoke(window, "save_generated_file", {
    name: "notes.txt",
    content: "Converted baseline.\n",
  });
  assert.equal(typeof legacyFile.id, "string");
  await invoke(window, "close_room");

  const conversion = await invoke(window, "convert_legacy_room", {
    sourcePath,
    password,
    destinationPath: workspacePath,
  });
  assert.equal(conversion.convertedFiles, 1);
  await stat(path.join(workspacePath, ".arcelle", "room.db"));
  assert.equal(await readFile(path.join(workspacePath, "notes.txt"), "utf8"), "Converted baseline.\n");
  await invoke(window, "open_room", { path: workspacePath, password });
  log("legacy room converted and opened as a normal-files workspace");

  const capabilities = await invoke(window, "harness_capabilities");
  assert.equal(capabilities.roomFormat, "workspace-folder");
  assert.equal(capabilities.providers["ollama-local"].enabled, true);
  assert.equal(capabilities.providers["ollama-local"].harness, "arcelle-deep");

  await window.evaluate(() => {
    globalThis.__conversionAgentEvents = [];
    window.arcelle.on("harness-event", (event) => {
      globalThis.__conversionAgentEvents.push(event);
    });
  });
  const started = await invoke(window, "harness_start", {
    provider: "ollama-local",
    model,
    privacyMode: "local",
    writeEnabled: true,
    text:
      "Use your workspace file tools. Read notes.txt, then append the exact line " +
      "REAL AGENT EDIT CONFIRMED. Do not change any other file.",
  });
  assert.equal(typeof started.runId, "string");
  await window.waitForFunction(
    (runId) => globalThis.__conversionAgentEvents.some(
      (event) => event.runId === runId && (event.type === "run_completed" || event.type === "run_failed"),
    ),
    started.runId,
    { timeout: 10 * 60_000 },
  );
  const events = await window.evaluate(() => globalThis.__conversionAgentEvents);
  const terminal = events.findLast(
    (event) => event.runId === started.runId && (event.type === "run_completed" || event.type === "run_failed"),
  );
  assert.equal(terminal?.type, "run_completed", JSON.stringify(terminal));
  assert.match(
    await readFile(path.join(workspacePath, "notes.txt"), "utf8"),
    /REAL AGENT EDIT CONFIRMED/,
  );
  log(`real local Deep Agent edited the converted normal file with ${model}`);

  const rolledBack = await invoke(window, "harness_rollback", { runId: started.runId });
  assert.deepEqual(rolledBack.conflicts, []);
  assert.equal(await readFile(path.join(workspacePath, "notes.txt"), "utf8"), "Converted baseline.\n");
  assert.deepEqual(pageErrors, []);
  log("rollback restored the converted file exactly; PASS");
} finally {
  if (app) await app.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
