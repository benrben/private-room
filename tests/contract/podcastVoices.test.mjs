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

/** Line comments, gone — comments around these seams necessarily describe
 * the door, so a comment-blind grep would read documentation as code. */
const stripComments = (src) => src.replace(/\/\/[^\n]*/g, "");

const AUDIO = stripComments(read("apps/desktop/src/main/studiosPodcastAudio.ts"));
const PODCAST = read("apps/desktop/src/main/studiosPodcast.ts");
const JOBS = read("apps/desktop/src/main/creativeJobSurfaceIpc.ts");
const PANEL = read("apps/desktop/src/renderer/workspace/PodcastPanel.tsx");
const API = read("apps/desktop/src/renderer/api.ts");
const CONTRACT = read("apps/desktop/src/shared/ipc-contract.ts");
const MOCK = read("tests/support/qa-mock.js");
const CATALOG = read("apps/desktop/src/renderer/settings/voiceCatalog.ts");
const SETTINGS = read("apps/desktop/src/renderer/settings/VoiceSection.tsx");

test("every line of an episode goes through the same door one sentence does", () => {
  // `speakable_text` IS the door: the room's internet switch, then the privacy
  // redactor. Recording must call it per line and must not reach the voice
  // service around it.
  assert.match(
    AUDIO,
    /speakableText\(anyOpenDb\(rooms\), t\.line\)/,
    "the recording path must go through speakableText",
  );
  // The ONLY sidecar call in the recording path is the synthesis one, and the
  // text it sends is what came back OUT of the door.
  // Any of the `sidecar_json*` family — the synthesis call is the cancellable
  // one now (Stop must reach it mid-episode), and counting only the plain name
  // would have gone quiet on exactly the line it is here to watch.
  const renderAt = AUDIO.indexOf("export async function renderPodcastAudio");
  const renderEnd = AUDIO.indexOf("export function timedTranscript", renderAt);
  const render = AUDIO.slice(renderAt, renderEnd);
  const sidecarCalls = render.match(/sidecarJsonCancellable\(/g) || [];
  assert.equal(sidecarCalls.length, 1, "one outbound call, and it is the audited one");
  assert.match(render, /"\/tts\/podcast"/);
  // The per-host Preview is the same act on a smaller scale and rides the same
  // shared body rather than a path of its own.
  assert.match(AUDIO, /return speakOne\(db, text, voice, rate, pitch\)/);
  assert.match(
    AUDIO,
    /export async function speakOne[\s\S]{0,900}speakableText\(db, trimmed\)/,
    "the shared speak body must itself go through the door",
  );
});

test("the transcript records what was spoken, not what the script said", () => {
  // With the door on, the line that LEFT is the redacted one. Writing the
  // original beside audio of the placeholder would be the app disagreeing with
  // itself about what left this Mac.
  assert.match(AUDIO, /spoken\.push\(text\)/);
  assert.match(AUDIO, /export function timedTranscript\([\s\S]{0,500}spoken: readonly string\[\]/);
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
  assert.match(PODCAST, /structuredFirst: true/);
  assert.match(PODCAST, /afterSave: storePodcast/);
  assert.match(PODCAST, /hosts:\s*\{/, "the schema asks for the cast explicitly");
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
    assert.match(CONTRACT, new RegExp(`\\b${cmd}:`), `${cmd} is missing from the Electron contract`);
    assert.match(MOCK, new RegExp(`\\b${cmd}:`), `${cmd} has no qa-mock fixture`);
  }
  assert.match(AUDIO, /handle\("get_podcast"/);
  assert.match(AUDIO, /"set_podcast_cast"/);
  assert.match(AUDIO, /"preview_podcast_voice"/);
  assert.match(JOBS, /handle\("start_podcast_audio_job"/);
  // The mock's fixture casts its two hosts in DIFFERENT voices — one that did
  // not would make the panel look right while hiding the collision case.
  const a = MOCK.indexOf('name: "Ada", voice: "');
  const b = MOCK.indexOf('name: "Bo", voice: "');
  assert.ok(a !== -1 && b !== -1, "the fixture has a two-host cast");
  const voiceOf = (at) => MOCK.slice(at).match(/voice: "([^"]*)"/)[1];
  assert.notEqual(voiceOf(a), voiceOf(b), "the fixture's hosts differ in voice");
});

test("the cast a host is saved under is trimmed, or their lines fall to the default voice", () => {
  // The recorder joins a turn to its host by the host's name as stored — only
  // the TURN's speaker is trimmed — while `set_podcast_cast` re-folds the turns
  // onto the trimmed spelling. A cast saved as "Ada " therefore matches none of
  // Ada's own lines, and the whole episode reads her in the default voice,
  // discovered after a multi-minute cloud render. The panel is the only writer
  // of a typed name, so it trims on the way in.
  assert.match(AUDIO, /eqIgnoreAsciiCase\(h\.name, t\.speaker\.trim\(\)\)/);
  const sent = PANEL.match(/setPodcastCast\(fileId,\s*([A-Za-z_]\w*)\)/);
  assert.ok(sent, "the panel saves the cast through setPodcastCast");
  assert.match(
    PANEL,
    new RegExp(`const ${sent[1]} = [\\s\\S]{0,120}name: [^;]*\\.trim\\(\\)`),
    "the cast the panel sends must carry trimmed host names",
  );
});

test("only one voice preview can be playing, and its blob is let go", () => {
  // Two hosts may share a name, so a preview keyed by name lit Stop on the
  // wrong row and stopped a host nobody had pressed.
  assert.ok(
    !/previewing === host\.name/.test(PANEL),
    "preview state must not be keyed by a name two hosts can share",
  );
  // Synthesis is a cloud round trip: a second Preview during it used to play
  // on top of the first and orphan whichever element the ref no longer held.
  assert.match(PANEL, /previewEpoch\.current/);
  assert.ok(
    /const b64 = await api\.previewPodcastVoice\([\s\S]{0,700}?previewEpoch\.current\) return;/.test(
      PANEL,
    ),
    "a preview that comes back superseded must drop its clip",
  );
  // …and the WAV behind each preview is released rather than held for the life
  // of the window.
  assert.match(PANEL, /URL\.revokeObjectURL/);
});
