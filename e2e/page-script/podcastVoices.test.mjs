/* THE DRIFT TESTS for podcast voices.
 *
 * One of these is far more important than the others.
 *
 * THE DOOR. Speaking sends text to Microsoft's Edge TTS service. The
 * spoken-answer path has always gone through `speakable_text`, which refuses
 * when the room's internet switch is off and masks the sentence through the
 * privacy redactor. Recording an EPISODE sends every line of a script written
 * from the user's own documents — the same seam, orders of magnitude wider. A
 * second path that reached the sidecar directly would compile, pass every unit
 * test, and quietly become the app's largest unguarded outbound seam. Nothing
 * but a test that reads the source can say it didn't happen.
 *
 * The rest guard the two things that make the feature honest rather than
 * merely working: the panel states the redaction consequence BEFORE the button
 * (ten minutes of "Person A" discovered on playback is not a thing to find out
 * afterwards), and the podcast page stops advertising audio as a future
 * feature now that it is a button.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

/** Rust line comments, gone — the comments around these seams necessarily
 * DESCRIBE the door, so a comment-blind grep reads documentation as code. */
const stripComments = (src) => src.replace(/\/\/[^\n]*/g, "");

const AUDIO = stripComments(read("src-tauri/src/commands/studios/podcast_audio.rs"));
const SPEECH = stripComments(read("src-tauri/src/commands/speech_cmds.rs"));
const PODCAST = read("src-tauri/src/commands/studios/podcast.rs");
const PANEL = read("src/workspace/PodcastPanel.tsx");
const API = read("src/api.ts");
const LIB = read("src-tauri/src/lib.rs");
const MOCK = read("qa/qa-mock.js");
const CATALOG = read("src/settings/voiceCatalog.ts");
const SETTINGS = read("src/settings/VoiceSection.tsx");

test("every line of an episode goes through the same door one sentence does", () => {
  // `speakable_text` IS the door: the room's internet switch, then the privacy
  // redactor. Recording must call it per line and must not reach the voice
  // service around it.
  assert.match(
    AUDIO,
    /speech_cmds::speakable_text\(/,
    "the recording path must go through speakable_text",
  );
  // The ONLY sidecar call in the recording path is the synthesis one, and the
  // text it sends is what came back OUT of the door.
  const sidecarCalls = AUDIO.match(/sidecar_json\(/g) || [];
  assert.equal(sidecarCalls.length, 1, "one outbound call, and it is the audited one");
  assert.match(AUDIO, /"\/tts\/podcast"/);
  // The per-host Preview is the same act on a smaller scale and rides the same
  // shared body rather than a path of its own.
  assert.match(AUDIO, /speech_cmds::speak_one\(/);
  assert.match(
    SPEECH,
    /pub\(crate\) async fn speak_one[\s\S]{0,600}speakable_text\(/,
    "the shared speak body must itself go through the door",
  );
});

test("the transcript records what was spoken, not what the script said", () => {
  // With the door on, the line that LEFT is the redacted one. Writing the
  // original beside audio of the placeholder would be the app disagreeing with
  // itself about what left this Mac.
  assert.match(AUDIO, /spoken\.push\(text\)/);
  assert.match(AUDIO, /fn timed_transcript\([\s\S]{0,400}spoken: &\[String\]/);
});

test("the panel states the redaction consequence before the Record button", () => {
  // Ten minutes of "Person A said" discovered on playback is the failure this
  // paragraph exists to prevent, so it has to be ABOVE the button, not in a
  // tooltip on it.
  const privacyAt = PANEL.indexOf("privacy door is on");
  const recordAt = PANEL.indexOf("Record the episode");
  assert.ok(privacyAt !== -1, "the panel must name the redaction consequence");
  assert.ok(recordAt !== -1);
  assert.ok(privacyAt < recordAt, "…and must say it before the button");
  // Same for the plain fact that recording is a cloud act at all.
  const cloudAt = PANEL.indexOf("Recording uses a cloud voice");
  assert.ok(cloudAt !== -1 && cloudAt < recordAt);
  // An offline room cannot record, and the button says so rather than failing.
  assert.match(PANEL, /disabled=\{!s\.webOn \|\| dirty\}/);
});

test("the generated page no longer promises audio as a future feature", () => {
  // The page used to print "Audio narration is coming in a later version". It
  // has arrived; a generated artifact that keeps advertising a missing feature
  // is a lie the app prints for the user itself.
  assert.ok(
    !PODCAST.includes("coming in a later version"),
    "the podcast template must not still promise future audio",
  );
  assert.match(PODCAST, /Voices<\/b> to cast each host/);
});

test("the podcast studio is structured-first so its turns survive as data", () => {
  // Turns that exist only as markup cannot be spoken. This is the inversion the
  // whole feature rests on, and it is one bool away from silently reverting.
  assert.match(PODCAST, /structured_first: true/);
  assert.match(PODCAST, /after_save: Some\(store_podcast\)/);
  assert.match(PODCAST, /"hosts":/, "the schema asks for the cast explicitly");
});

test("both voice pickers name voices through one module", () => {
  // Two places naming the same voice differently reads as two voices, and the
  // user picks the wrong one to fix a mismatch that isn't real.
  assert.match(SETTINGS, /from "\.\/voiceCatalog"/);
  assert.match(PANEL, /from "\.\.\/settings\/voiceCatalog"/);
  for (const fn of ["voiceName", "languageLabel", "optionLabel", "groupVoices"]) {
    assert.match(CATALOG, new RegExp(`export function ${fn}`), `${fn} is the shared one`);
  }
  // Neither picker may re-derive a voice's display name locally.
  for (const [name, src] of [["Settings", SETTINGS], ["the podcast panel", PANEL]]) {
    assert.ok(
      !/function voiceName\(/.test(src),
      `${name} must not define its own voiceName`,
    );
  }
});

test("a fresh cast never gives two hosts the same voice", () => {
  // Two hosts in one voice is not a two-voice podcast — it is one narrator
  // reading a dialogue, which is the thing this feature exists to stop being.
  assert.match(CATALOG, /export function suggestDistinctVoices/);
  assert.match(CATALOG, /!picked\.includes\(v\.id\)/);
  // …and it prefers the other gender first, the strongest "different person" cue.
  assert.match(CATALOG, /v\.gender !== lastGender/);
});

test("every podcast command is registered, invoked and faked", () => {
  for (const cmd of [
    "get_podcast",
    "set_podcast_cast",
    "preview_podcast_voice",
    "start_podcast_audio_job",
  ]) {
    assert.match(API, new RegExp(`"${cmd}"`), `${cmd} is not invoked from api.ts`);
    assert.match(LIB, new RegExp(`commands::${cmd},`), `${cmd} is missing from lib.rs`);
    assert.match(MOCK, new RegExp(`\\b${cmd}:`), `${cmd} has no qa-mock fixture`);
  }
  // The mock's fixture casts its two hosts in DIFFERENT voices — one that did
  // not would make the panel look right while hiding the collision case.
  const a = MOCK.indexOf('name: "Ada", voice: "');
  const b = MOCK.indexOf('name: "Bo", voice: "');
  assert.ok(a !== -1 && b !== -1, "the fixture has a two-host cast");
  const voiceOf = (at) => MOCK.slice(at).match(/voice: "([^"]*)"/)[1];
  assert.notEqual(voiceOf(a), voiceOf(b), "the fixture's hosts differ in voice");
});
