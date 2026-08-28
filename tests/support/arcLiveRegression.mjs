/* Live ARC acceptance slice for `tests/e2e/desktop/electron-deep.mjs`.
 *
 * The exhaustive algorithms live in Vitest and the 30-item boundary inventory
 * lives in `arcElectronBoundary.test.mjs`.  This helper keeps the highest-risk
 * seams genuinely end-to-end: a real renderer and autocomplete menu, preload,
 * Electron IPC, encrypted room, sidecar, deterministic Ollama double, normal
 * workspace files, and the durable viewer state after a reload.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const requireFromElectron = createRequire(
  new URL("../../apps/desktop/package.json", import.meta.url),
);
const sharp = requireFromElectron("sharp");

const CANONICAL_SPECIALISTS = [
  "file", "scripts", "transcribe", "video", "studio", "sketch", "web", "browse",
  "app", "jobs", "workflows", "skills", "skillbuilder", "connector", "connectorsetup",
];

export async function runArcLiveRegression({ window, invoke, waitFor, temp, log }) {
  // ARC-001 / ARC-028: the bridge and the actual '*' menu expose one stable
  // 15-row catalog. Missing prerequisites disable rows instead of deleting them.
  const specialists = await invoke(window, "list_specialists");
  assert.deepEqual(specialists.map((row) => row.key), CANONICAL_SPECIALISTS);
  const byKey = new Map(specialists.map((row) => [row.key, row]));
  for (const key of ["web", "browse"]) {
    assert.equal(byKey.get(key)?.capability, "unavailable", `ARC-001: *${key} was not disabled`);
    assert.equal(byKey.get(key)?.capabilityReason, "Turn on room internet");
  }
  assert.equal(byKey.get("connector")?.capability, "unavailable");
  assert.equal(byKey.get("connector")?.capabilityReason, "Install and enable a connector");

  await window.getByTitle("Send this turn to one specialist agent").click();
  const specialistOptions = window.locator('#ac-listbox [role="option"]');
  await waitFor(async () => (await specialistOptions.count()) === 15, "ARC-001 specialist menu");
  assert.equal(await window.getByText("15 specialists", { exact: true }).count(), 1);
  for (const key of ["web", "browse", "connector"]) {
    const row = specialistOptions.filter({
      has: window.getByText(`*${key}`, { exact: true }),
    });
    assert.equal(await row.count(), 1);
    assert.equal(await row.isDisabled(), true);
  }
  await window.locator("textarea.composer-input").first().press("Escape");
  log("ARC-001/028: canonical disabled specialist rows crossed bridge and renderer");

  const seed = await invoke(window, "save_generated_file", {
    name: "arc-evidence.txt",
    content: "UNRELATED_ARC_ROOM_EVIDENCE must never attach to closed-evidence or tagged inventory turns.",
  });

  // ARC-006: a slash skill that explicitly closes tools/files crosses the host
  // with an empty source set, even though the room contains a tempting match.
  const noEvidenceSkill = await invoke(window, "create_skill", {
    name: "arc-no-evidence",
    description: "Return a fixed marker without room evidence.",
    instructions: "Do not use tools. Do not read, search, cite, or attach room files. Return ARC_NO_EVIDENCE_OK.",
    agent: null,
  });
  await invoke(window, "set_skill_enabled", { id: noEvidenceSkill, enabled: true });
  const noEvidenceChat = await invoke(window, "create_chat");
  const noEvidence = await invoke(window, "ask", {
    chatId: noEvidenceChat.id,
    question: "/arc-no-evidence Return ARC_NO_EVIDENCE_OK without tools or sources.",
    attachments: [],
    askId: `arc-006-${Date.now()}`,
    viewing: null,
    privacyBypass: null,
  });
  assert.deepEqual(noEvidence.sources ?? [], []);

  // ARC-010: a command-domain failure is a durable message on its own turn,
  // not merely a rejected IPC call followed by a detached toast.
  const errorChat = await invoke(window, "create_chat");
  const turnError = await invoke(window, "run_command", {
    chatId: errorChat.id,
    command: "find",
    args: "",
    refs: [],
    raw: "#find",
    askId: `arc-010-${Date.now()}`,
  });
  assert.equal(turnError.kind, "turn_error");
  const errorMessages = await invoke(window, "get_messages", { chatId: errorChat.id });
  assert.equal(errorMessages.at(-1)?.kind, "turn_error");
  assert.match(errorMessages.at(-1)?.content ?? "", /usage|keyword|find/i);
  log("ARC-006/010: closed-evidence turn and inline command error persisted honestly");

  // ARC-017: package directories are rejected by a full-batch preflight. A
  // second valid-looking package in the same request cannot leave one residue.
  const numbersPath = path.join(temp, "arc-017-sample.numbers");
  const rtfdPath = path.join(temp, "arc-017-sample.rtfd");
  await mkdir(numbersPath);
  await mkdir(rtfdPath);
  await writeFile(path.join(numbersPath, "Index.zip"), "package fixture");
  await writeFile(path.join(rtfdPath, "TXT.rtf"), "{\\rtf1 package fixture}");
  const beforePackages = await invoke(window, "list_files");
  const packageReport = await invoke(window, "import_files", { paths: [numbersPath, rtfdPath] });
  assert.deepEqual(packageReport.imported, []);
  assert.equal(packageReport.errors.length, 2);
  assert.equal((await invoke(window, "list_files")).length, beforePackages.length);

  // ARC-016 / ARC-019: use a real decodable 1200px JPEG under a RAW extension.
  // The host extracts and persists it, reload proves durability, and the real
  // ImageView displays the honest provenance caption while preserving the RAW
  // original's name as the public room file.
  const rawPath = path.join(temp, "arc-016-sample.cr2");
  const rawJpeg = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 50, g: 90, b: 130 } },
  }).jpeg({ quality: 88 }).toBuffer();
  await writeFile(rawPath, rawJpeg);
  const rawReport = await invoke(window, "import_files", { paths: [rawPath] });
  assert.equal(rawReport.errors.length, 0);
  assert.equal(rawReport.imported.length, 1);
  const rawId = rawReport.imported[0].id;
  let rawContent = await invoke(window, "get_file_content", { id: rawId });
  assert.equal(rawContent.name, "arc-016-sample.cr2");
  assert.equal(rawContent.mime, "image/jpeg");
  assert.equal(rawContent.derivedPreview?.kind, "stored-preview");
  await window.reload({ waitUntil: "domcontentloaded" });
  await window.locator(".workspace").waitFor({ state: "visible" });
  rawContent = await invoke(window, "get_file_content", { id: rawId });
  assert.equal(rawContent.derivedPreview?.kind, "stored-preview");

  await window.locator('button[data-area="files"]').click();
  const rawRow = window.locator(".file-row", { hasText: "arc-016-sample" });
  await rawRow.waitFor({ state: "visible" });
  await rawRow.locator("button.file-main").click();
  const previewCaption = window.locator(".derived-preview-caption");
  await previewCaption.waitFor({ state: "visible" });
  assert.match(await previewCaption.innerText(), /Stored preview/);
  assert.match(await previewCaption.innerText(), /Export saves the original file unchanged/);
  log("ARC-016/019: durable RAW JPEG and visible provenance caption passed after reload");

  // ARC-022 / ARC-014: compound archives remain distinguishable and every
  // visible count comes from list_files, which excludes the hidden RAW preview.
  const tarPath = path.join(temp, "arc-022-sample.tar");
  const targzPath = path.join(temp, "arc-022-sample.tar.gz");
  await writeFile(tarPath, "not a real tar; naming fixture only");
  await writeFile(targzPath, "not a real gzip; naming fixture only");
  const archiveReport = await invoke(window, "import_files", { paths: [tarPath, targzPath] });
  assert.equal(archiveReport.errors.length, 0);
  await waitFor(
    async () => (await window.locator(".file-row", { hasText: "arc-022-sample.tar.gz" }).count()) === 1,
    "ARC-022 compound archive labels",
  );
  assert.equal(await window.locator(".file-row", { hasText: "arc-022-sample.tar" }).count(), 2);
  const publicFiles = await invoke(window, "list_files");
  const statusText = `${publicFiles.length} room file${publicFiles.length === 1 ? "" : "s"}`;
  await waitFor(
    async () => (await window.locator(".pr-statusbar").innerText()).includes(statusText),
    "ARC-014 public footer count",
  );
  log("ARC-014/022: compound names and reconciled public count passed");

  // ARC-005 / ARC-023: drive the actual Studio specialist through sidecar and
  // host. The deterministic model authors HTML, the workspace path commits it,
  // and success is accepted only with a readable hash receipt.
  const studioChat = await invoke(window, "create_chat");
  const beforeStudio = await invoke(window, "list_files");
  const studio = await invoke(window, "ask", {
    chatId: studioChat.id,
    question: "*studio Create flashcards from arc-evidence.txt and save them.",
    attachments: [seed.id],
    askId: `arc-023-${Date.now()}`,
    viewing: null,
    privacyBypass: null,
  });
  assert.match(studio.content, /ARCELLE_ARTIFACT_RECEIPT/);
  const afterStudio = await invoke(window, "list_files");
  assert.equal(afterStudio.length, beforeStudio.length + 1);
  const studioFile = afterStudio.find((file) => !beforeStudio.some((before) => before.id === file.id));
  assert(studioFile);
  const studioContent = await invoke(window, "get_file_content", { id: studioFile.id });
  assert.equal(typeof studioContent.text, "string");
  assert((studioContent.text ?? "").length > 0);

  // ARC-026 / ARC-030: a Skills-specialist turn inventories a disabled draft
  // assigned to File, then returns with no ambient room-file citations.
  const crossSkillName = "arc-cross-assigned";
  await invoke(window, "create_skill", {
    name: crossSkillName,
    description: "Cross-assignment inventory fixture.",
    instructions: "Return the exact cross-assignment marker.",
    agent: "files.read",
  });
  const skillsChat = await invoke(window, "create_chat");
  const skillsAnswer = await invoke(window, "ask", {
    chatId: skillsChat.id,
    question: `*skills List and exactly read ${crossSkillName}. Do not read unrelated room files.`,
    attachments: [],
    askId: `arc-026-${Date.now()}`,
    viewing: null,
    privacyBypass: null,
  });
  assert.match(skillsAnswer.content, /ARC_SKILL_FOUND:arc-cross-assigned/);
  assert.deepEqual(skillsAnswer.sources ?? [], []);
  log("ARC-005/023/026/030: Studio receipt and cross-assigned source-free Skills turn passed");
}
