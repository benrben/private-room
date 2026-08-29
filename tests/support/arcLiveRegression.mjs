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
const DEFAULT_MODEL = "qwen3.5:4b";
const BLIND_MODEL = "qwen3.5-blind:4b";

// A 2-second, 1920x1080 H.264 fixture generated once with ffmpeg: red at
// 0.0-0.4s and blue from 0.5s onward, at ten frames per second. Embedding its
// tiny payload
// keeps the always-run deep E2E deterministic, offline, and independent of a
// system ffmpeg installation while still exercising Chromium's real decoder.
const GOLDEN_VIDEO_B64 =
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAQobW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAA1N0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAB4AAAAQ4AAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAIAAABAAAAAALLbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAUABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACdm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAjZzdGJsAAAAwnN0c2QAAAAAAAAAAQAAALJhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAB4AEOABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAOGF2Y0MBZAAo/+EAG2dkACis2UB4AiflwEQAAAMABAAAAwBQPGDGWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAshAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAFAAABAAAAAAYc3RzcwAAAAAAAAACAAAAAQAAAAsAAACoY3R0cwAAAAAAAAATAAAAAQAACAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAgAACAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAACAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAABQAAAABAAAAZHN0c3oAAAAAAAAAAAAAABQAAARhAAAARwAAAEQAAABEAAAARAAAAF0AAABIAAAARgAAAEQAAABNAAABtQAAAEgAAABEAAAARAAAAEQAAABNAAAARgAAAEQAAABEAAAATQAAABRzdGNvAAAAAAAAAAEAAARYAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMAAAAAhmcmVlAAALKW1kYXQAAAKsBgX//6jcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MTUgbG9va2FoZWFkX3RocmVhZHM9MiBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTEwIGtleWludF9taW49NiBzY2VuZWN1dD0wIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9MTAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAABrWWIhAAQ//7mwPmWVQ1Xf/1pPSv4zSLlJeKTDK3g+nEAy5DQ8ufAAAADAAADAAADAAADAABeW2FVK1Oh+7/xAAADAAADAACMAAADABowAAAKMAAABbwAAAMD6AAAAwMkAAADA4gAAAMD+AAABMgAAAhoAAAQEAAAGKAAADsAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMBAQAAAENBmiRsQ3/+p4QAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAABnwAAAAQEGeQniHfwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAABoUAAABAAZ5hdEN/AAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAAJOAAAAEABnmNqQ38AAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAk5AAAAWUGaaEuoQhBaIc8D8BPgKAB/AfgH7A/AUQCCH/6qVQAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwNXAAAAREGehkURLD//7YlvEAtwAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAEnAAAAQgGepXRDf+6ccJghIAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwADewAAAEABnqdqQ38AAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAk4AAAASUGaqUmoQWyZTAhv//6nhAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAGfAAAAGxZYiCAAT//urj/MstsBc2CqWqI419bldTT0hMRL3GW2p9uFceuz1gAAADAAADAAADAAADAAA4hToQ1URw4f6DwAAAAwAAAwAfgAAABlwAAAMCKgAAAwELAAADANQAAAMAyQAAAwDiAAADAP4AAAMBMgAAAwIaAAAEBAAABigAAA7AAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAABAQQAAAERBmiRsQQ/+qlUAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMDVgAAAEBBnkJ4h38AAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAaEAAAAQAGeYXRDfwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAACTkAAABAAZ5jakN/AAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAAJOQAAAElBmmhJqEFomUwId//+qZYAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAA0JAAAAQkGehkURLDv/AAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAAGhAAAAEABnqV0Q38AAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAk4AAAAQAGep2pDfwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAACTkAAABJQZqpSahBbJlMCG///qeEAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAAZ8A==";

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

  // ARC-011 / ARC-024: build a real nested-path MP4, import it, and move the
  // public room file into a folder so the model must use its qualified name.
  // An ordinary-language Main turn delegates to Video, which calls the real
  // renderer-backed MCP tool. The Ollama double decodes the provider-bound PNG
  // and refuses to emit Main's OK marker unless the child report's pixels,
  // receipt dimensions, SHA-256, and timestamp all agree.
  const goldenSource = path.join(temp, "arc-golden-video", "fixtures", "timestamp-colors.mp4");
  await mkdir(path.dirname(goldenSource), { recursive: true });
  await writeFile(goldenSource, Buffer.from(GOLDEN_VIDEO_B64, "base64"));
  const goldenReport = await invoke(window, "import_files", { paths: [goldenSource] });
  assert.equal(goldenReport.errors.length, 0);
  assert.equal(goldenReport.imported.length, 1);
  const goldenFolder = await invoke(window, "create_folder", { name: "ARC Golden Video" });
  await invoke(window, "move_file_to_folder", {
    fileId: goldenReport.imported[0].id,
    folderId: goldenFolder.id,
  });
  const videoChat = await invoke(window, "create_chat");
  const videoAnswer = await invoke(window, "ask", {
    chatId: videoChat.id,
    question: "ARC_GOLDEN_VIDEO inspect @ARC Golden Video/timestamp-colors.mp4 at 1.05 seconds and report what color fills the visible frame.",
    attachments: [],
    askId: `arc-011-${Date.now()}`,
    viewing: null,
    privacyBypass: null,
  });
  const goldenMatch = (videoAnswer.content ?? "").match(
    /ARC_GOLDEN_VIDEO_MAIN_OK timestamp=([0-9.]+) sha256=([a-f0-9]{64}) dimensions=(\d+)x(\d+) center=(\d+),(\d+),(\d+)/,
  );
  assert(goldenMatch, `ARC-011 Main did not synthesize the verified Video child report: ${videoAnswer.content ?? ""}`);
  const [, timestamp, sha256, width, height, red, green, blue] = goldenMatch;
  assert(Math.abs(Number(timestamp) - 1.05) <= 0.35, `ARC-011 presented timestamp drifted: ${timestamp}s`);
  assert.equal(sha256.length, 64);
  assert.equal(Number(width), 1280);
  assert.equal(Number(height), 720);
  assert(Number(red) < 60 && Number(green) < 60 && Number(blue) > 190,
    `ARC-011 expected a blue center pixel, got ${red},${green},${blue}`);
  log("ARC-011/024: Main delegated a live nested video frame and synthesized its verified 1280x720 blue PNG child report");

  // The same ordinary-language route must fail closed when Ollama's own model
  // metadata authoritatively says it cannot accept images. Main still has the
  // File domain, so this specifically guards against silently substituting a
  // files.read child for the unavailable Video specialist.
  const previousModel = await invoke(window, "get_setting", { key: "model" });
  await invoke(window, "set_setting", { key: "model", value: BLIND_MODEL });
  try {
    const blindChat = await invoke(window, "create_chat");
    const blindAnswer = await invoke(window, "ask", {
      chatId: blindChat.id,
      question: "ARC_BLIND_VIDEO inspect ARC Golden Video/timestamp-colors.mp4 at 1.05 seconds and describe only the visible frame.",
      attachments: [],
      askId: `arc-024-blind-${Date.now()}`,
      viewing: null,
      privacyBypass: null,
    });
    assert.match(
      blindAnswer.content ?? "",
      /ARC_BLIND_VIDEO_REFUSED_OK no-frame no-image no-file-substitution/,
      `ARC-024 blind model did not fail closed through Main: ${blindAnswer.content ?? ""}`,
    );
  } finally {
    // A never-explicit room has no delete-setting IPC. Restoring the same
    // selected default explicitly is behaviorally identical for later turns.
    await invoke(window, "set_setting", {
      key: "model",
      value: typeof previousModel === "string" && previousModel ? previousModel : DEFAULT_MODEL,
    });
  }
  log("ARC-024: Main refused blind-model video perception before any frame, image payload, or File substitution");

  // ARC-031: sketches already have their own exact vector/layout report, but a
  // vision-capable sketch specialist must also receive the real raster. Drive
  // both model tool rounds and let the Ollama double decode the provider-bound
  // PNG rather than accepting read_drawing's text as visual proof.
  const sketchChat = await invoke(window, "create_chat");
  const sketchAnswer = await invoke(window, "ask", {
    chatId: sketchChat.id,
    question: "*sketch ARC_SKETCH_PIXELS draw a blue full-page sketch, then look at the finished drawing and report its visible pixels.",
    attachments: [],
    askId: `arc-031-${Date.now()}`,
    viewing: null,
    privacyBypass: null,
  });
  const sketchMatch = (sketchAnswer.content ?? "").match(
    /ARC_SKETCH_PIXELS_OK sha256=([a-f0-9]{64}) dimensions=(\d+)x(\d+) center=(\d+),(\d+),(\d+)/,
  );
  assert(sketchMatch, `ARC-031 sketch specialist did not inspect its real raster: ${sketchAnswer.content ?? ""}`);
  assert.equal(Number(sketchMatch[2]), 1024);
  assert.equal(Number(sketchMatch[3]), 640);
  assert(Number(sketchMatch[4]) >= 190 && Number(sketchMatch[4]) <= 235);
  assert(Number(sketchMatch[5]) >= 205 && Number(sketchMatch[5]) <= 245);
  assert(Number(sketchMatch[6]) >= 235 && Number(sketchMatch[6]) > Number(sketchMatch[5]));
  log("ARC-031: Sketch agent drew, rasterized, attached, and inspected a real blue 1024x640 PNG");

  const fileSketchChat = await invoke(window, "create_chat");
  const fileSketchAnswer = await invoke(window, "ask", {
    chatId: fileSketchChat.id,
    question: "*file ARC_FILE_SKETCH_PIXELS inspect @ARC Pixel Sketch.sketch and report only what its visible pixels show.",
    attachments: [],
    askId: `arc-032-sketch-${Date.now()}`,
    viewing: null,
    privacyBypass: null,
  });
  const fileSketchMatch = (fileSketchAnswer.content ?? "").match(
    /ARC_FILE_SKETCH_PIXELS_OK sha256=([a-f0-9]{64}) dimensions=(\d+)x(\d+) center=(\d+),(\d+),(\d+)/,
  );
  assert(fileSketchMatch, `ARC-032 File specialist did not inspect real sketch pixels: ${fileSketchAnswer.content ?? ""}`);
  assert.equal(Number(fileSketchMatch[2]), 1024);
  assert.equal(Number(fileSketchMatch[3]), 640);
  log("ARC-032: File agent inspected the Drawing agent's exact sketch PNG through the shared raster path");

  // ARC-032: import a normal image and require the direct File specialist to
  // use its pixel tool. The mock provider validates both the PNG's centre
  // colour and the receipt hash/dimensions against the bytes it received.
  const fileImagePath = path.join(temp, "arc-file-pixels.png");
  const fileImagePng = await sharp({
    create: { width: 320, height: 180, channels: 3, background: { r: 20, g: 210, b: 50 } },
  }).png().toBuffer();
  await writeFile(fileImagePath, fileImagePng);
  const fileImageReport = await invoke(window, "import_files", { paths: [fileImagePath] });
  assert.equal(fileImageReport.errors.length, 0);
  assert.equal(fileImageReport.imported.length, 1);
  const fileImageChat = await invoke(window, "create_chat");
  const fileImageAnswer = await invoke(window, "ask", {
    chatId: fileImageChat.id,
    question: "*file ARC_FILE_PIXELS inspect @arc-file-pixels.png and report only what its visible pixels show.",
    attachments: [],
    askId: `arc-032-${Date.now()}`,
    viewing: null,
    privacyBypass: null,
  });
  const fileImageMatch = (fileImageAnswer.content ?? "").match(
    /ARC_FILE_PIXELS_OK sha256=([a-f0-9]{64}) dimensions=(\d+)x(\d+) center=(\d+),(\d+),(\d+)/,
  );
  assert(fileImageMatch, `ARC-032 File specialist did not inspect real image pixels: ${fileImageAnswer.content ?? ""}`);
  assert.equal(Number(fileImageMatch[2]), 320);
  assert.equal(Number(fileImageMatch[3]), 180);
  assert(Number(fileImageMatch[4]) < 80 && Number(fileImageMatch[5]) > 170 && Number(fileImageMatch[6]) < 100);
  log("ARC-032: File agent decoded a real green PNG with hash-pinned pixel evidence");

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

  return { goldenSource };
}
