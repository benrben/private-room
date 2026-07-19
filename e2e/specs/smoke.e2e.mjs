// HLT-8 end-to-end smoke test: create -> import -> view -> ask (mocked) ->
// annotation chip. Drives the REAL app UI through tauri-driver, with Ollama
// faked by e2e/mock-ollama.mjs (wired via PRIVATE_ROOM_OLLAMA_URL).
//
// Native file dialogs cannot be driven by WebDriver, so we stub exactly that
// one seam inside the webview: we wrap window.__TAURI_INTERNALS__.invoke (the
// bridge every Tauri IPC call flows through, present in v2 regardless of
// withGlobalTauri) so the dialog plugin's `save`/`open` return paths we choose.
// Every other command still hits the real Rust backend.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "fixtures");
const NOTES = path.join(fixtures, "notes.txt");
const CSV = path.join(fixtures, "data.csv");

// A fresh temp path for the encrypted room this run creates.
const roomPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "pr-e2e-")),
  "smoke-room.roomai",
);

// Injected into the page: intercept the two native dialogs, pass everything
// else through to the real backend.
function installDialogStub(savePath, openPaths) {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || internals.__e2ePatched) return;
  const original = internals.invoke.bind(internals);
  internals.__e2ePatched = true;
  internals.invoke = (cmd, payload, options) => {
    if (cmd === "plugin:dialog|save") return Promise.resolve(savePath);
    if (cmd === "plugin:dialog|open") return Promise.resolve(openPaths);
    return original(cmd, payload, options);
  };
}

describe("Private Room — demo happy path", () => {
  it("create -> import -> ask (mocked) -> annotation chip", async () => {
    // 1. Start screen.
    const createBtn = await $("button=Create New Room");
    await createBtn.waitForExist({ timeout: 30_000 });

    // Stub the dialogs (save -> room path, open -> the two fixtures).
    await browser.execute(installDialogStub, roomPath, [NOTES, CSV]);

    // 2. Create the room.
    await createBtn.click();

    const pwInputs = await $$('input[type="password"]');
    await pwInputs[0].waitForExist({ timeout: 10_000 });
    await pwInputs[0].setValue("hunter2-e2e");
    await pwInputs[1].setValue("hunter2-e2e");
    await (await $("button=Create & Enter")).click();

    // 3. Workspace is open once the composer exists.
    const composer = await $('textarea[placeholder="Ask anything about this room…"]');
    await composer.waitForExist({ timeout: 30_000 });

    // 4. Import the two fixtures via "Add page or source" → "Upload files"
    //    (dialog stubbed).
    await (await $(".add-source-button")).click();
    await (await $("button*=Upload files")).click();
    const notesRow = await $(".file-name=notes.txt");
    await notesRow.waitForExist({ timeout: 20_000 });
    await expect(await $(".file-name=data.csv")).toExist();

    // 5. Ask a question. The mock replies with an annotate_file tool call
    //    (round 1) then a final answer (round 2).
    await composer.setValue("What did the Apollo program achieve?");
    await (await $(".composer .send-btn")).click();

    // 6. Assert: an assistant answer bubble AND the 📍 annotation chip appear.
    const chip = await $(".annot-chip");
    await chip.waitForExist({ timeout: 60_000 });

    const answer = await $(".msg.assistant .msg-content");
    await expect(answer).toBeExisting();
    await expect(await answer.getText()).toContain("Apollo");

    const chipText = await chip.getText();
    await expect(chipText).toContain("notes.txt");
  });
});
