#!/usr/bin/env node

/** Real installed-app regression for a sketch moved out of a legacy database.
 * It proves the converted JSON is loaded from the normal file, rendered by the
 * real canvas, safely saved with an expected-document guard, and exported as a
 * normal SVG file. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const requireFromElectron = createRequire(
  new URL("../../apps/desktop/package.json", import.meta.url),
);
const { _electron: electron } = requireFromElectron("playwright");
const appPath = process.env.ARCELLE_INSTALLED_APP || "/Applications/Arcelle.app";
const executablePath = path.join(appPath, "Contents", "MacOS", "Arcelle");
const temporary = await mkdtemp(path.join(os.tmpdir(), "arcelle-installed-sketch-"));
const sourcePath = path.join(temporary, "Legacy Sketch.roomai");
const workspacePath = path.join(temporary, "Converted Sketch Room");
const password = "installed-sketch-review-password";
const before = `${JSON.stringify({
  version: 1,
  width: 1600,
  height: 1000,
  seq: 1,
  elements: [{
    id: "e1", type: "rect", x: 20, y: 20, w: 120, h: 70,
    ink: "blue", label: "Installed conversion",
  }],
}, null, 2)}\n`;
let app;

function log(message) {
  process.stdout.write(`[installed-sketch-review] ${message}\n`);
}

async function invoke(window, channel, args = {}) {
  return await window.evaluate(
    async ({ requestedChannel, requestedArgs }) =>
      await window.arcelle.invoke(requestedChannel, requestedArgs),
    { requestedChannel: channel, requestedArgs: args },
  );
}

try {
  await stat(executablePath);
  log(`installed app ${executablePath}`);
  const env = {
    ...process.env,
    ARCELLE_E2E: "1",
    ARCELLE_USER_DATA_DIR: path.join(temporary, "user-data"),
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
    name: "Legacy Sketch",
    format: "sealed-db",
  });
  const sketch = await invoke(window, "create_sketch", { name: "Converted flow" });
  await invoke(window, "save_sketch", {
    id: sketch.id,
    doc: before,
    snapshot: false,
  });
  await invoke(window, "close_room");
  await invoke(window, "convert_legacy_room", {
    sourcePath,
    password,
    destinationPath: workspacePath,
  });
  await invoke(window, "open_room", { path: workspacePath, password });

  const sketchPath = path.join(workspacePath, "Converted flow.sketch");
  assert.equal(await readFile(sketchPath, "utf8"), before);
  const content = await invoke(window, "get_file_content", { id: sketch.id });
  assert.equal(content.kind, "sketch");
  assert.equal(content.text, before);

  await window.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  const reloadedRoom = await invoke(window, "room_info");
  assert.equal(reloadedRoom.path, workspacePath);
  const listedAfterReload = await invoke(window, "list_files");
  log(`files after reload: ${listedAfterReload.map((file) => `${file.id}:${file.name}`).join(", ")}`);
  assert.ok(
    listedAfterReload.some((file) => file.id === sketch.id && file.name === "Converted flow.sketch"),
    "the renderer's public file inventory lost the converted section-only sketch",
  );
  await window.locator(".workspace").waitFor();
  await window.locator('[data-area="sketch"]').evaluate((button) => button.click());
  const sketchList = window.getByRole("list", { name: "Sketches in this room" });
  await sketchList.waitFor();
  log(`sketch list: ${JSON.stringify((await sketchList.innerText()).trim())}`);
  await window.locator('[title="Open Converted flow.sketch"]').evaluate((row) => row.click());
  await window.locator(".sk-page").waitFor();
  await window.getByRole("img", { name: "Drawing canvas, 1 object" }).waitFor();
  await window.getByText("Installed conversion", { exact: true }).first().waitFor();

  const after = before.replace("Installed conversion", "Saved after conversion");
  await invoke(window, "save_sketch", {
    id: sketch.id,
    doc: after,
    snapshot: true,
    expectedDoc: before,
  });
  assert.equal(await readFile(sketchPath, "utf8"), after);
  // The canvas schedules an idle save. Wait beyond that debounce and prove a
  // stale editor cannot silently replace the agent/API write after this call
  // has already reported success.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(await readFile(sketchPath, "utf8"), after);
  const exported = await invoke(window, "export_sketch_svg", { id: sketch.id });
  assert.match(await readFile(path.join(workspacePath, exported.name), "utf8"), /Saved after conversion/);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(await readFile(sketchPath, "utf8"), after);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(severeConsole, []);
  log("converted sketch loaded, rendered, stayed stable after autosave, saved, and exported; PASS");
} finally {
  if (app) await app.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
