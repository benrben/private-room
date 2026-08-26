#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ELECTRON_APP = path.join(ROOT, "electron-migration", "electron-app");
const SIDECAR = path.join(ROOT, "sidecar");
const SIDECAR_PYTHON = path.join(SIDECAR, ".venv", "bin", "python");
const ENTRY = path.join(ELECTRON_APP, "dist_package", "electron", "main", "index.js");
const requireFromElectron = createRequire(path.join(ELECTRON_APP, "package.json"));
const { _electron: electron } = requireFromElectron("playwright");

const EXPECTED_COMMANDS = [
  "add-file", "remember", "find", "highlight", "extract", "summarize", "compare",
  "transcribe", "sketch", "minutes", "to-sheet", "translate", "research", "checkpoint",
];
const STEP_TIMEOUT_MS = Number(process.env.ARCELLE_E2E_STEP_TIMEOUT_MS || 20_000);
const MAX_MEMORY_GROWTH_MB = Number(process.env.ARCELLE_E2E_MAX_MEMORY_GROWTH_MB || 128);

const temp = await mkdtemp(path.join(os.tmpdir(), "arcelle-electron-deep-"));
const port = await freePort();
const childLogs = [];
let mock;
let app;

function log(message) {
  process.stdout.write(`[e2e] ${message}\n`);
}

function capture(stream, prefix) {
  if (!stream) return;
  stream.on("data", (chunk) => {
    const text = String(chunk);
    childLogs.push(text);
    if (process.env.ARCELLE_E2E_VERBOSE === "1") process.stdout.write(`[${prefix}] ${text}`);
  });
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      const selected = address.port;
      server.close((error) => (error ? reject(error) : resolve(selected)));
    });
  });
}

async function waitForLog(fragment, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (childLogs.join("").includes(fragment)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${fragment}\n${childLogs.join("").slice(-4_000)}`);
}

async function invoke(window, channel, args) {
  return await withDeadline(window.evaluate(
    async ({ channel: requestedChannel, args: requestedArgs }) =>
      await window.arcelle.invoke(requestedChannel, requestedArgs),
    { channel, args },
  ), STEP_TIMEOUT_MS, `IPC ${channel}`);
}

async function withDeadline(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function mockStats() {
  const response = await fetch(`http://127.0.0.1:${port}/__e2e/stats`);
  return await response.json();
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not become true within ${timeoutMs}ms`);
}

async function memorySnapshot() {
  const rows = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((metric) => ({
    type: metric.type,
    workingSetKb: metric.memory.workingSetSize,
  })));
  return {
    mb: rows.reduce((total, row) => total + row.workingSetKb, 0) / 1024,
    processes: rows.length,
  };
}

async function rejectsWithoutMissingHandler(window, channel, args) {
  try {
    await invoke(window, channel, args);
    return null;
  } catch (error) {
    const message = String(error?.message ?? error);
    assert.doesNotMatch(message, /unknown command|not implemented|no handler registered/i);
    return message;
  }
}

try {
  mock = spawn(process.execPath, [path.join(HERE, "mock-ollama.mjs")], {
    env: { ...process.env, MOCK_OLLAMA_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  capture(mock.stdout, "mock");
  capture(mock.stderr, "mock:error");
  await waitForLog("[mock-ollama] listening");

  const electronEnv = {
    ...process.env,
    ARCELLE_E2E: "1",
    ARCELLE_USER_DATA_DIR: path.join(temp, "user-data"),
    ARCELLE_SIDECAR_PYTHON: SIDECAR_PYTHON,
    ARCELLE_SIDECAR_DIR: SIDECAR,
    ARCELLE_OLLAMA_URL: `http://127.0.0.1:${port}`,
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  app = await electron.launch({ args: [ENTRY], env: electronEnv, timeout: 30_000 });
  capture(app.process().stdout, "electron");
  capture(app.process().stderr, "electron:error");
  const window = await app.firstWindow({ timeout: 30_000 });
  await window.waitForLoadState("domcontentloaded");

  const bridge = await window.evaluate(() => ({
    title: document.title,
    hasRoot: document.querySelector("#root") !== null,
    hasInvoke: typeof window.arcelle?.invoke === "function",
  }));
  assert.equal(bridge.hasRoot, true);
  assert.equal(bridge.hasInvoke, true);
  log(`renderer + preload: ${bridge.title || "Arcelle"}`);

  await waitForLog("ARCELLE_MAIN_READY ");
  const markerLine = childLogs.join("").split(/\r?\n/).find((line) => line.includes("ARCELLE_MAIN_READY "));
  assert(markerLine);
  const marker = JSON.parse(markerLine.slice(markerLine.indexOf("ARCELLE_MAIN_READY ") + 19));
  assert.equal(marker.completenessOk, true);
  assert(marker.registeredChannelCount >= marker.totalCommandCount);
  log(`IPC registry: ${marker.registeredChannelCount}/${marker.totalCommandCount}, complete`);

  const roomPath = path.join(temp, "deep-e2e.roomai");
  const room = await invoke(window, "create_room", {
    path: roomPath,
    password: "public-e2e-password",
    name: "Arcelle Deep E2E",
  });
  assert.equal(room.name, "Arcelle Deep E2E");
  assert.equal((await invoke(window, "room_info")).path, roomPath);
  log("encrypted room create/open: passed");

  // Reload once so App's real session-restore path mounts Workspace around the
  // room opened above. From this point the sweep is driving the same renderer
  // surfaces as a person who unlocked a room, not only the IPC bridge.
  await window.reload({ waitUntil: "domcontentloaded" });
  await window.locator(".workspace").waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });

  // Keep the same isolated, fully opened room available for macOS Computer
  // Use. This avoids typing a room password through UI automation while still
  // exercising the real packaged renderer, preload, Electron main process,
  // encrypted database, and sidecar. Ctrl-C resumes normal cleanup (including
  // deletion of the disposable room) through this file's finally block.
  if (process.env.ARCELLE_E2E_MANUAL === "1") {
    log(`MANUAL_READY room=${roomPath}`);
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    log("manual session closed");
    process.exitCode = 0;
  } else {

  // GH #32: moving a window from a large display to a laptop-sized one sends
  // a native resize, not a route change. Prove the live BrowserWindow crosses
  // both responsive breakpoints, leaves the workspace reachable with no
  // horizontal overflow, and restores the reader's side panes when widened.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 760);
  });
  await waitFor(() => window.evaluate(() => window.innerWidth > 1080), "wide window layout");
  assert.equal(await window.locator(".pane-library").getAttribute("aria-hidden"), "false");
  assert.equal(await window.locator(".pane-ai").getAttribute("aria-hidden"), "false");

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(900, 620);
  });
  await waitFor(
    () => window.evaluate(() => window.matchMedia("(max-width: 1080px)").matches),
    "laptop-sized single-pane layout",
  );
  await waitFor(
    () => window.locator(".pane-library").getAttribute("aria-hidden").then((v) => v === "true"),
    "collapsed narrow side panes",
  );
  const narrowLayout = await window.evaluate(() => ({
    centerHidden: document.querySelector(".pane-center")?.getAttribute("aria-hidden"),
    libraryHidden: document.querySelector(".pane-library")?.getAttribute("aria-hidden"),
    aiHidden: document.querySelector(".pane-ai")?.getAttribute("aria-hidden"),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  assert.equal(narrowLayout.centerHidden, "false");
  assert.equal(narrowLayout.libraryHidden, "true");
  assert.equal(narrowLayout.aiHidden, "true");
  assert(narrowLayout.overflow <= 1, `GH #32: narrow window overflows by ${narrowLayout.overflow}px`);

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 760);
  });
  await waitFor(() => window.evaluate(() => window.innerWidth > 1080), "restored wide layout");
  await waitFor(
    () => window.locator(".pane-library").getAttribute("aria-hidden").then((v) => v === "false"),
    "restored wide side panes",
  );
  assert.equal(await window.locator(".pane-library").getAttribute("aria-hidden"), "false");
  assert.equal(await window.locator(".pane-ai").getAttribute("aria-hidden"), "false");
  log("GH #32: native wide → laptop → wide resize adapted and restored every pane");

  const homeButton = window.locator('button[data-area="home"]');
  const libraryButton = window.locator('button[data-area="files"]');
  const recordingsButton = window.locator('button[data-area="recordings"]');
  assert.equal(await homeButton.count(), 1, "GH #21: Home is missing from the destination rail");
  assert.equal(await libraryButton.count(), 1, "GH #23: Library is missing from the destination rail");
  assert.equal(await recordingsButton.count(), 1, "GH #22: Recordings is missing from the destination rail");

  await libraryButton.click();
  await waitFor(async () => (await libraryButton.getAttribute("aria-current")) === "true", "Library destination");
  assert.equal(await window.getByText("Add page or source", { exact: true }).count(), 1);

  await recordingsButton.click();
  assert.equal(await window.getByText("New live recording", { exact: true }).count(), 1);
  assert.equal(await window.getByText("Voice note", { exact: true }).count(), 1);

  const modelButton = window.locator("button.model-pill");
  await modelButton.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await modelButton.click();
  assert.equal(await window.getByRole("tab", { name: "On this Mac" }).count(), 1);
  assert.equal(await window.getByRole("tab", { name: "Cloud" }).count(), 1);
  await window.locator(".menu-backdrop").click({ position: { x: 2, y: 2 } });

  await window.getByRole("button", { name: "Open room settings (⌘,)" }).click();
  const downloadChoices = window.locator("#download-model-choice");
  await downloadChoices.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  assert((await downloadChoices.locator("option").count()) >= 8, "GH #25: known model/version choices are missing");
  await window.getByRole("tab", { name: "Voice" }).click();
  const micCleanup = window.locator('[data-testid="mic-voice-processing"]');
  await micCleanup.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  assert.equal(await micCleanup.isChecked(), false, "GH #30: a new room must not seize macOS voice processing");
  await window.getByRole("button", { name: "Close settings" }).click();

  const toastMetrics = await window.evaluate(() => {
    const toast = document.createElement("div");
    toast.className = "toast error";
    toast.innerHTML =
      '<span class="toast-mark">Failed</span>' +
      '<span class="toast-text">A deliberately long error message must keep a readable line length instead of collapsing to one or two words per row.</span>' +
      '<button class="toast-action">Open privacy</button>' +
      '<button class="toast-close">×</button>';
    document.body.appendChild(toast);
    const text = toast.querySelector(".toast-text");
    const result = {
      display: getComputedStyle(toast).display,
      template: getComputedStyle(toast).gridTemplateColumns,
      width: text?.getBoundingClientRect().width ?? 0,
    };
    toast.remove();
    return result;
  });
  assert.equal(toastMetrics.display, "grid");
  assert(toastMetrics.template.split(" ").length >= 3);
  assert(toastMetrics.width >= 250, `GH #20: toast text is still only ${toastMetrics.width}px wide`);
  log("open-issue UI sweep: Home, Library, Recordings, model tiers/downloads, mic default, and toast layout passed");

  const commands = await invoke(window, "list_chat_commands");
  assert.deepEqual(commands.map(({ name }) => name).sort(), [...EXPECTED_COMMANDS].sort());
  const dispatchResults = [];
  for (const command of EXPECTED_COMMANDS) {
    const chat = await invoke(window, "create_chat");
    const args = command === "checkpoint" ? "deep command sweep" : "";
    const error = await rejectsWithoutMissingHandler(window, "run_command", {
      chatId: chat.id,
      command,
      args,
      refs: [],
      raw: `#${command}${args ? ` ${args}` : ""}`,
      askId: `command-${command}-${Date.now()}`,
    });
    dispatchResults.push({ command, outcome: error ? "validated-error" : "success" });
  }
  assert.equal(dispatchResults.length, EXPECTED_COMMANDS.length);
  assert.equal(dispatchResults.find(({ command }) => command === "checkpoint")?.outcome, "success");
  log(`commands: all ${EXPECTED_COMMANDS.length} catalog routes dispatched`);

  const file = await invoke(window, "save_generated_file", {
    name: "notes.txt",
    content: "Apollo landed twelve people on the Moon between 1969 and 1972.",
  });
  assert.equal((await invoke(window, "get_file_content", { id: file.id })).text.includes("Apollo"), true);
  assert((await invoke(window, "list_files")).some(({ id }) => id === file.id));
  assert((await invoke(window, "search_all", { query: "Apollo" })).files.some(({ id }) => id === file.id));

  const folder = await invoke(window, "create_folder", { name: "Research" });
  await invoke(window, "move_file_to_folder", { fileId: file.id, folderId: folder.id });
  assert((await invoke(window, "list_folders")).some(({ id }) => id === folder.id));

  const memory = await invoke(window, "add_memory", { content: "Moon research matters", category: "project" });
  await invoke(window, "update_memory", {
    id: memory.id,
    content: "Apollo research matters",
    category: "project",
  });
  assert((await invoke(window, "list_memories")).some(({ content }) => content === "Apollo research matters"));

  const rememberChat = await invoke(window, "create_chat");
  const remembered = await invoke(window, "run_command", {
    chatId: rememberChat.id,
    command: "remember",
    args: "The deep E2E command path is active",
    refs: [],
    raw: "#remember The deep E2E command path is active",
    askId: `command-remember-positive-${Date.now()}`,
  });
  assert.match(remembered.content, /Saved to memory/i);
  assert((await invoke(window, "list_memories")).some(({ content }) => content === "The deep E2E command path is active"));

  const findChat = await invoke(window, "create_chat");
  const found = await invoke(window, "run_command", {
    chatId: findChat.id,
    command: "find",
    args: "Apollo",
    refs: [],
    raw: "#find Apollo",
    askId: `command-find-positive-${Date.now()}`,
  });
  assert.match(found.content, /Apollo/i);

  const chat = await invoke(window, "create_chat");
  await invoke(window, "rename_chat", { id: chat.id, title: "Agent journey" });
  assert((await invoke(window, "list_chats")).some(({ id, title }) => id === chat.id && title === "Agent journey"));
  log("files, folders, search, memory, and chat persistence: passed");

  const specialists = await invoke(window, "list_specialists");
  assert(specialists.length >= 4);
  const fileSpecialist = specialists.find(({ key, agent }) => key === "file" || agent === "files.read");
  assert(fileSpecialist, `File specialist missing: ${JSON.stringify(specialists)}`);

  const answer = await invoke(window, "ask", {
    chatId: chat.id,
    question: "What does this room say about Apollo?",
    attachments: [],
    askId: `agent-supervisor-${Date.now()}`,
    viewing: null,
    privacyBypass: null,
  });
  assert.match(answer.content, /landed twelve people on the Moon/i);
  const messages = await invoke(window, "get_messages", { chatId: chat.id });
  assert(messages.some(({ role, content }) => role === "user" && content.includes("Apollo")));
  assert(messages.some(({ role, content }) => role === "assistant" && /twelve people/i.test(content)));

  const taggedChat = await invoke(window, "create_chat");
  const tagged = await invoke(window, "ask", {
    chatId: taggedChat.id,
    question: "*file Find the Apollo fact in this room.",
    attachments: [],
    askId: `agent-tag-${Date.now()}`,
    viewing: null,
    privacyBypass: null,
  });
  assert.match(tagged.content, /FOUND:.*Apollo/is);

  const routedKeys = new Set([fileSpecialist.key]);
  for (const specialist of specialists) {
    if (routedKeys.has(specialist.key)) continue;
    log(`agent route: *${specialist.key}`);
    const routeChat = await invoke(window, "create_chat");
    const routed = await invoke(window, "ask", {
      chatId: routeChat.id,
      question: `*${specialist.key} E2E route probe. Return a short status without changing anything.`,
      attachments: [],
      askId: `agent-${specialist.key}-${Date.now()}`,
      viewing: null,
      privacyBypass: null,
    });
    assert.equal(typeof routed.content, "string");
    assert(routed.content.trim().length > 0, `Empty response from *${specialist.key}`);
    routedKeys.add(specialist.key);
  }
  assert.equal(routedKeys.size, new Set(specialists.map(({ key }) => key)).size);
  log(`agents: ${specialists.length} discovered; supervisor delegation and every *specialist route passed`);

  const stalledChat = await invoke(window, "create_chat");
  const stalledAskId = `agent-cancel-${Date.now()}`;
  const stalled = window.evaluate(
    async ({ chatId, askId }) => await window.arcelle.invoke("ask", {
      chatId,
      question: "E2E_STALL cancellation probe",
      attachments: [],
      askId,
      viewing: null,
      privacyBypass: null,
    }),
    { chatId: stalledChat.id, askId: stalledAskId },
  );
  await waitFor(async () => (await mockStats()).activeStalls > 0, "stalled model request");
  const stop = await invoke(window, "cancel_ask", { askId: stalledAskId });
  assert.equal(stop.known, true);
  await withDeadline(stalled.catch(() => null), 5_000, "cancelled ask");
  await waitFor(async () => (await mockStats()).activeStalls === 0, "cancelled model connection cleanup");
  log("liveness: a deliberately stalled model call cancelled and released its connection");

  const probes = [
    ["app", "app_diag"],
    ["recents", "list_recent"],
    ["trash", "list_trashed_files"],
    ["privacy", "privacy_status"],
    ["workflows", "list_workflows"],
    ["workflow templates", "workflow_templates"],
    ["jobs", "list_jobs"],
    ["scripts", "list_scripts"],
    ["skills", "list_skills"],
    ["skill agents", "skill_agent_ids"],
    ["MCP status", "mcp_status"],
    ["MCP config", "mcp_get_config"],
    ["browser info", "browser_info"],
    ["browser tabs", "browser_tabs"],
    ["browser journal", "browser_journal", { limit: 10 }],
    ["recording", "rec_live_status"],
    ["voices", "voices_list"],
    ["AI", "ai_status"],
    ["dictation", "stt_status"],
    ["graph", "room_graph"],
    ["roles", "list_roles"],
  ];
  for (const [feature, channel, args] of probes) {
    const value = await invoke(window, channel, args);
    assert.notEqual(value, undefined, `${feature} returned undefined`);
  }
  log(`feature families: ${probes.length} live IPC probes passed`);

  for (let i = 0; i < 3; i += 1) {
    await invoke(window, "list_files");
    await invoke(window, "search_all", { query: "Apollo" });
  }
  const memoryBefore = await memorySnapshot();
  let memoryMiddle = memoryBefore;
  for (let i = 0; i < 12; i += 1) {
    const churnChat = await invoke(window, "create_chat");
    await invoke(window, "run_command", {
      chatId: churnChat.id,
      command: "find",
      args: "Apollo",
      refs: [],
      raw: "#find Apollo",
      askId: `memory-command-${i}-${Date.now()}`,
    });
    await invoke(window, "delete_chat", { id: churnChat.id });
    await invoke(window, "list_files");
    await invoke(window, "list_memories");
    if (i === 5) memoryMiddle = await memorySnapshot();
  }
  const memoryAfter = await memorySnapshot();
  const totalGrowth = memoryAfter.mb - memoryBefore.mb;
  const tailGrowth = memoryAfter.mb - memoryMiddle.mb;
  assert(totalGrowth <= MAX_MEMORY_GROWTH_MB, `Electron memory grew ${totalGrowth.toFixed(1)} MB`);
  assert(tailGrowth <= MAX_MEMORY_GROWTH_MB / 2, `Electron memory kept growing in the tail (${tailGrowth.toFixed(1)} MB)`);
  assert(memoryAfter.processes <= memoryBefore.processes + 1, "Electron leaked child processes during repeated journeys");
  const stats = await mockStats();
  assert.equal(stats.activeStalls, 0);
  assert.equal(stats.unknownRequests, 0, "the model double received an endpoint with no fixture");
  log(`memory: ${memoryBefore.mb.toFixed(1)} → ${memoryAfter.mb.toFixed(1)} MB after 12 repeated command journeys`);
  log("deep Electron E2E passed");
  }
} catch (error) {
  process.stderr.write(`\nDeep Electron E2E failed: ${error?.stack ?? error}\n`);
  const tail = childLogs.join("").slice(-8_000);
  if (tail) process.stderr.write(`\nChild-process log tail:\n${tail}\n`);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  if (mock && mock.exitCode === null) mock.kill("SIGTERM");
  await rm(temp, { recursive: true, force: true });
}
