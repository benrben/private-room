#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveInstalledOllamaModel } from "../support/installedAgentModel.mjs";

const requireFromElectron = createRequire(
  new URL("../../apps/desktop/package.json", import.meta.url),
);
const { _electron: electron } = requireFromElectron("playwright");

const appPath = process.env.ARCELLE_INSTALLED_APP || "/Applications/Arcelle.app";
const executablePath = path.join(appPath, "Contents", "MacOS", "Arcelle");
const provider = process.env.ARCELLE_AGENT_PROVIDER || "ollama-local";
const configuredModel = process.env.ARCELLE_AGENT_MODEL
  || process.env.ARCELLE_LOCAL_AGENT_MODEL;
let model = configuredModel;
const privacyMode = process.env.ARCELLE_AGENT_PRIVACY_MODE
  || (provider === "ollama-local" ? "local" : "cloud-direct");
const expectedHarness = {
  "ollama-local": "arcelle-deep",
  codex: "codex-app-server",
  claude: "claude-agent-sdk",
}[provider];
if (!model && provider !== "ollama-local") {
  throw new Error("Set ARCELLE_AGENT_MODEL when reviewing a non-local provider.");
}
const password = "converted-agent-review-password";
const temporary = await mkdtemp(path.join(os.tmpdir(), "arcelle-installed-conversion-agent-"));
const sourcePath = path.join(temporary, "Legacy Agent Review.roomai");
const workspacePath = path.join(temporary, "Converted Agent Review");
let app;

async function missing(candidate) {
  try {
    await stat(candidate);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

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
  const fixtures = [
    ["notes.txt", "Converted baseline.\n"],
    ["rename-me.txt", "Rename baseline.\n"],
    ["move-me.txt", "Move baseline.\n"],
    ["delete-me.txt", "Delete baseline.\n"],
  ];
  for (const [name, content] of fixtures) {
    const legacyFile = await invoke(window, "save_generated_file", { name, content });
    assert.equal(typeof legacyFile.id, "string");
  }
  await invoke(window, "close_room");

  const conversion = await invoke(window, "convert_legacy_room", {
    sourcePath,
    password,
    destinationPath: workspacePath,
  });
  assert.equal(conversion.convertedFiles, fixtures.length);
  await stat(path.join(workspacePath, ".arcelle", "room.db"));
  assert.equal(await readFile(path.join(workspacePath, "notes.txt"), "utf8"), "Converted baseline.\n");
  const privateCanaryPath = path.join(workspacePath, ".arcelle", "agent-private-canary.txt");
  await writeFile(privateCanaryPath, "PRIVATE CANARY\n", { mode: 0o600 });
  await invoke(window, "open_room", { path: workspacePath, password });
  log("legacy room converted and opened as a normal-files workspace");

  if (provider === "ollama-local") {
    const ai = await invoke(window, "ai_status");
    model = resolveInstalledOllamaModel(ai, configuredModel);
    log(`using installed local Ollama model ${model}`);
  }

  const capabilities = await invoke(window, "harness_capabilities");
  assert.equal(capabilities.roomFormat, "workspace-folder");
  assert.equal(capabilities.providers[provider].enabled, true, JSON.stringify(capabilities.providers[provider]));
  if (expectedHarness) assert.equal(capabilities.providers[provider].harness, expectedHarness);

  await window.evaluate(() => {
    globalThis.__conversionAgentEvents = [];
    globalThis.__conversionAgentApprovalErrors = [];
    window.arcelle.on("harness-event", (event) => {
      globalThis.__conversionAgentEvents.push(event);
      if (event.type === "approval_requested") {
        void window.arcelle.invoke("harness_approve", {
          runId: event.runId,
          requestId: event.requestId,
          decision: "allow-run",
        }).catch((error) => {
          globalThis.__conversionAgentApprovalErrors.push(String(error));
        });
      }
    });
  });
  const runAgent = async (text) => {
    const started = await invoke(window, "harness_start", {
      provider,
      ...(model ? { model } : {}),
      privacyMode,
      writeEnabled: true,
      text,
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
    const runEvents = events.filter((event) => event.runId === started.runId);
    log(`normalized events: ${runEvents.map((event) => {
      if (event.type === "tool_started" || event.type === "tool_completed") {
        return `${event.type}:${event.tool || "unknown"}${event.error ? `:${event.error}` : ""}`;
      }
      if (event.type === "run_completed") return `${event.type}:${event.status}`;
      return event.type;
    }).join(", ")}`);
    const terminal = runEvents.findLast(
      (event) => event.type === "run_completed" || event.type === "run_failed",
    );
    assert.equal(terminal?.type, "run_completed", JSON.stringify(terminal));
    return started;
  };

  // Keep deletion in a dedicated real-agent turn. Small local models and
  // native agents otherwise sometimes decide that four completed operations
  // are enough and merely describe the fifth. This directly proves that the
  // provider can discover and execute the recoverable delete tool.
  const deleteTool = provider === "ollama-local" || provider === "ollama-cloud" || provider === "openrouter"
    ? { name: "workspace_delete", arguments: { path: "delete-me.txt" } }
    : { name: "mcp__room__trash_files", arguments: { names: ["delete-me.txt"] } };
  const deleteRun = await runAgent(
    `Call the registered tool ${deleteTool.name} exactly once with JSON ${JSON.stringify(deleteTool.arguments)}. ` +
      "This must move delete-me.txt to recoverable Arcelle Trash. Do not move, rename, recreate, or only describe the file. Do not change any other file.",
  );
  assert.equal(await missing(path.join(workspacePath, "delete-me.txt")), true);

  const operationRun = await runAgent(
    "Use your own workspace file tools and complete every operation below. " +
      "(1) Append the exact line REAL AGENT EDIT CONFIRMED. to notes.txt. " +
      "(2) Create Organized/new-file.txt containing exactly NEW FILE CONFIRMED. followed by a newline. " +
      "(3) Rename rename-me.txt to renamed.txt in the workspace root without changing its bytes. " +
      "(4) Move move-me.txt to Archive/move-me.txt without changing its bytes. " +
      "Do not change any other file. Complete the file operations; do not only describe them.",
  );
  const approvalErrors = await window.evaluate(() => globalThis.__conversionAgentApprovalErrors);
  assert.deepEqual(approvalErrors, []);
  assert.match(
    await readFile(path.join(workspacePath, "notes.txt"), "utf8"),
    /REAL AGENT EDIT CONFIRMED/,
  );
  assert.equal(await readFile(path.join(workspacePath, "Organized", "new-file.txt"), "utf8"), "NEW FILE CONFIRMED.\n");
  assert.equal(await readFile(path.join(workspacePath, "renamed.txt"), "utf8"), "Rename baseline.\n");
  assert.equal(await readFile(path.join(workspacePath, "Archive", "move-me.txt"), "utf8"), "Move baseline.\n");
  assert.equal(await missing(path.join(workspacePath, "rename-me.txt")), true);
  assert.equal(await missing(path.join(workspacePath, "move-me.txt")), true);
  assert.equal(await readFile(privateCanaryPath, "utf8"), "PRIVATE CANARY\n");
  const history = await invoke(window, "harness_list_runs");
  const durableOperation = history.find((run) => run.runId === operationRun.runId);
  const durableDelete = history.find((run) => run.runId === deleteRun.runId);
  assert.equal(durableOperation?.writeEnabled, true);
  assert.equal(durableOperation?.baselineCompleted, true);
  assert.equal(durableDelete?.writeEnabled, true);
  assert.equal(durableDelete?.baselineCompleted, true);
  const changeKinds = new Set([
    ...(durableOperation?.changes.map((change) => change.change) ?? []),
    ...(durableDelete?.changes.map((change) => change.change) ?? []),
  ]);
  for (const expected of ["created", "modified", "moved", "deleted"]) {
    assert.equal(changeKinds.has(expected), true, JSON.stringify({ durableOperation, durableDelete }));
  }
  log(`real ${provider} agent edited, created, renamed, moved, and deleted normal files${model ? ` with ${model}` : ""}`);

  const operationRollback = await invoke(window, "harness_rollback", { runId: operationRun.runId });
  assert.deepEqual(operationRollback.conflicts, []);
  const deleteRollback = await invoke(window, "harness_rollback", { runId: deleteRun.runId });
  assert.deepEqual(deleteRollback.conflicts, []);
  assert.equal(await readFile(path.join(workspacePath, "notes.txt"), "utf8"), "Converted baseline.\n");
  assert.equal(await readFile(path.join(workspacePath, "rename-me.txt"), "utf8"), "Rename baseline.\n");
  assert.equal(await readFile(path.join(workspacePath, "move-me.txt"), "utf8"), "Move baseline.\n");
  assert.equal(await readFile(path.join(workspacePath, "delete-me.txt"), "utf8"), "Delete baseline.\n");
  assert.equal(await missing(path.join(workspacePath, "Organized", "new-file.txt")), true);
  assert.equal(await missing(path.join(workspacePath, "renamed.txt")), true);
  assert.equal(await missing(path.join(workspacePath, "Archive", "move-me.txt")), true);
  assert.equal(await readFile(privateCanaryPath, "utf8"), "PRIVATE CANARY\n");
  assert.deepEqual(pageErrors, []);
  log("rollback restored the converted file exactly; PASS");
} finally {
  if (app) await app.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
