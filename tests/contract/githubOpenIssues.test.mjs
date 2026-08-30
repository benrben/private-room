/* Regression map for every open GitHub issue audited through 2026-08-30.
 *
 * The expensive behavioral cases for long-translation and yt-dlp live beside
 * their Electron implementations (recBridge.test.ts and ytdlp.test.ts). This
 * file pins the user-visible wiring that is otherwise easy to lose in a UI
 * refactor: destinations, controls, consent choices, and safe defaults.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("GH #19: Ignore dismisses only the memory suggestion and cannot submit the composer", () => {
  const chat = read("apps/desktop/src/renderer/workspace/ChatPane.tsx");
  const start = chat.indexOf("Worth remembering?");
  const end = chat.indexOf("Always save", start);
  const card = chat.slice(start, end);
  assert.ok(start >= 0 && end > start, "memory suggestion card disappeared");
  assert.match(card, /type="button"[\s\S]*?onClick=\{\(\) => s\.setMemSuggestion\(null\)\}[\s\S]*?>\s*Ignore/);
});

test("GH #20: long toast copy owns a flexible column instead of a 1–2 word sliver", () => {
  const frame = read("apps/desktop/src/renderer/styles/settings.css");
  const chrome = read("apps/desktop/src/renderer/styles/misc.css");
  assert.match(frame, /\.toast\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto;/);
  assert.match(frame, /\.toast-text\s*\{[\s\S]*?grid-column:\s*2;[\s\S]*?min-width:\s*0;/);
  assert.match(frame, /width:\s*min\(420px,\s*calc\(100vw - 32px\)\);/);
  assert.match(chrome, /\.toast \.toast-action\s*\{[\s\S]*?grid-column:\s*2;[\s\S]*?grid-row:\s*2;/);
});

test("GH #21 and #23: Home and Library are first-class sidebar destinations", () => {
  const nav = read("apps/desktop/src/renderer/shell/navPrefs.tsx");
  assert.match(nav, /key:\s*"home",\s*label:\s*"Home"/);
  assert.match(nav, /key:\s*"files",\s*label:\s*"Library"/);
  assert.match(nav, /DEFAULT_PINNED[^=]*=\s*\["home",\s*"files",\s*"recordings",\s*"browser",\s*"sketch"\]/);
});

test("GH #22: Recordings exposes capture, import guidance, a complete list, and row deletion", () => {
  const sidebar = read("apps/desktop/src/renderer/workspace/Sidebar.tsx");
  const start = sidebar.indexOf("function RecordingsNav");
  const end = sidebar.indexOf("/* ---------- Workflows lens", start);
  const recordings = sidebar.slice(start, end);
  assert.match(recordings, /New live recording/);
  assert.match(recordings, /Voice note/);
  assert.match(recordings, /import audio\/video files/);
  assert.match(recordings, /recs\.map\(\(f\) => \(\s*<FileRow/);
  const fileRow = read("apps/desktop/src/renderer/workspace/FileRow.tsx");
  const overlays = read("apps/desktop/src/renderer/workspace/Overlays.tsx");
  assert.match(fileRow, /title="More actions"/);
  assert.match(overlays, /Remove \$\{s\.ctxMenu\.files\.length\} files from room/);
  assert.match(overlays, /void a\.removeFile\(ids\[0\]\)/);
});

test("GH #24: the long Hebrew translation regression exercises all 45 minutes", () => {
  const testSource = read("apps/desktop/src/main/recBridge.test.ts");
  assert.match(testSource, /GH #24: translates a 45-minute transcript through every batch/);
  assert.match(testSource, /expect\(calls\)\.toBe\(4\)/);
  assert.match(testSource, /\[44:00\] You: Hebrew line 45/);
});

test("GH #25: local model management has known-version choices, capabilities, and deletion", () => {
  const models = read("apps/desktop/src/renderer/settings/ModelSection.tsx");
  assert.match(models, /data-testid="download-model-choice"/);
  assert.match(models, /qwen3\.5:0\.8b/);
  assert.match(models, /qwen3\.5:9b/);
  assert.match(models, /gemma3:4b/);
  assert.match(models, /cap\.tools/);
  assert.match(models, /cap\.vision/);
  assert.match(models, /<DeleteControl/);
  assert.match(models, /confirmRemoveModel\(m\)/);
});

test("GH #27: the shared model picker separates local models from cloud engines", () => {
  const picker = read("apps/desktop/src/renderer/workspace/EngineModelPicker.tsx");
  assert.match(picker, /role="tab"[\s\S]*?>\s*On this Mac\s*<\/button>/);
  assert.match(picker, /role="tab"[\s\S]*?>\s*Cloud\s*<\/button>/);
  assert.match(picker, /Claude Code, Codex, Antigravity/);
  assert.match(picker, /ai\.external\.map\(\(engine\)/);
});

test("GH #28: an edit prompt can grant a persistent per-room permission", () => {
  const overlays = read("apps/desktop/src/renderer/workspace/Overlays.tsx");
  const actions = read("apps/desktop/src/renderer/workspace/miscActions.ts");
  assert.match(overlays, /Always allow in this room/);
  const start = actions.indexOf("async function alwaysAllowEdits");
  const end = actions.indexOf("function revealMemory", start);
  const implementation = actions.slice(start, end);
  assert.ok(start >= 0 && end > start, "permanent edit-permission action disappeared");
  assert.match(implementation, /await api\.setSetting\("edit_approval", "off"\)/);
  assert.match(implementation, /await api\.resolveEditApproval\(req\.id, "once"\)/);
  assert.ok(
    implementation.indexOf("setSetting") < implementation.indexOf("resolveEditApproval"),
    "the current edit must not be applied unless the standing room permission saved first",
  );
});

test("GH #29: the GUI downloader detects Homebrew ffmpeg and requests mergeable streams", () => {
  const downloader = read("apps/desktop/src/main/ytdlp.ts");
  const tests = read("apps/desktop/src/main/ytdlp.test.ts");
  assert.match(downloader, /"\/opt\/homebrew\/bin\/ffmpeg"/);
  assert.match(downloader, /bv\*\[vcodec\^=avc1\]\+ba/);
  assert.match(downloader, /args\.push\("--ffmpeg-location", ffmpeg\)/);
  assert.match(tests, /GH #29: finds Apple Silicon Homebrew ffmpeg even when the GUI PATH omits Homebrew/);
});

test("GH #4/#30: new rooms coexist while an opted-in room cleans echo without automatic gain", () => {
  const mic = read("apps/desktop/src/renderer/workspace/liveRec.ts");
  const effects = read("apps/desktop/src/renderer/workspace/effects.ts");
  const settings = read("apps/desktop/src/renderer/settings/MicSection.tsx");
  const qaMock = read("tests/support/qa-mock.js");
  assert.match(mic, /let voiceProcessing = false;/);
  assert.match(mic, /echoCancellation:\s*voiceProcessing/);
  assert.match(mic, /noiseSuppression:\s*voiceProcessing/);
  assert.match(mic, /autoGainControl:\s*false/);
  assert.match(effects, /getSetting\("mic_voice_processing"\)[\s\S]*?micVoiceProcessingFromSetting\(v\)/);
  assert.match(settings, /new room does not take over macOS voice processing/);
  assert.match(qaMock, /mic_voice_processing:\s*"1"/);
});

test("GH #31: transcription keeps clear speech and rejects periodic stock hallucinations", () => {
  const hallucinations = read("services/agent-sidecar/tests/test_hallucination.py");
  const recording = read("services/agent-sidecar/tests/test_rec_engine.py");
  const decoder = read("services/agent-sidecar/src/arcelle_sidecar/stt/live.py");
  assert.match(hallucinations, /is_stock_hallucination\("Thank you\."\)/);
  assert.match(hallucinations, /is_stock_hallucination\("Thank you\. Thank you\. Thank you\."\)/);
  assert.match(decoder, /is_stock_hallucination\(text\) and mean_p < STOCK_MAX_CONFIDENCE/);
  assert.match(recording, /test_retranscribe_rebuilds_a_corrupted_transcript_and_preserves_the_users_edits/);
  assert.match(recording, /assert "quick brown fox" in lowered/);
  assert.match(recording, /assert "tomorrow" in lowered or "agenda" in lowered/);
  assert.match(recording, /assert ticks\[-1\] == \(meta\.duration_cs, meta\.duration_cs\)/);
});

test("GH #32: a native display-size change enters one-pane mode and restores the wide layout", () => {
  const layout = read("apps/desktop/src/renderer/shell/useLayout.ts");
  const deep = read("tests/e2e/desktop/electron-deep.mjs");
  assert.match(layout, /const NARROW_QUERY = "\(max-width: 1080px\)"/);
  assert.match(layout, /mq\.addEventListener\("change", onChange\)/);
  assert.match(layout, /if \(isNarrow\) \{[\s\S]*?return \[pick \?\? "center"\]/);
  assert.match(deep, /GH #32: native wide → laptop → wide resize adapted and restored every pane/);
  assert.match(deep, /BrowserWindow\.getAllWindows\(\)\[0\]\?\.setSize\(900, 620\)/);
  assert.match(deep, /narrowLayout\.overflow <= 1/);
});

test("GH #33: installed remote connectors expose OAuth and dual-stack discovery can reach IPv4", () => {
  const connectors = read("apps/desktop/src/renderer/workspace/ConnectorsView.tsx");
  const guard = read("apps/desktop/src/main/browser/guard.ts");
  const oauthTests = read("apps/desktop/src/main/mcpOauth.test.ts");
  assert.match(connectors, /function RemoteOauthControls/);
  assert.match(connectors, /s\.remote && <RemoteOauthControls server=\{s\.name\}/);
  assert.match(connectors, /Connect account \(sign in\)/);
  assert.match(connectors, /api\.mcpOauthAuthorize\(server\)/);
  assert.match(guard, /addrs\.find\(\(a\) => a\.family === 4\) \?\? addrs\[0\]/);
  assert.match(oauthTests, /discovers, registers, and drives the whole authorize flow to a stored token/);
});

test("GH #40: the signed updater does not ask Electron's BoringSSL for BLAKE2b", () => {
  const verifier = read("apps/desktop/src/main/updater/minisignVerify.ts");
  const electronTest = read("apps/desktop/src/main/index.electron.test.ts");
  assert.match(verifier, /import \{ blake2b \} from "@noble\/hashes\/blake2\.js"/);
  assert.doesNotMatch(
    verifier,
    /import\s*\{[^}]*createHash[^}]*\}\s*from\s*"node:crypto"/,
  );
  assert.match(electronTest, /GH #40: verifies a prehashed update signature in the real Electron main process/);
});
