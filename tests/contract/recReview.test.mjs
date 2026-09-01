/* Reviewing a finished recording — the three P1s a hands-on QA pass found on
 * 2026-08-15, and the rules that answer them.
 *
 *   1. TWO PLAYERS. The page drew its own transport AND a native
 *      `<audio controls>`, the second kept for the volume, speed and keyboard
 *      scrubbing the first lacked. Nobody could say which one owned playback.
 *   2. REVIEW MIXED WITH CAPTURE. A finished recording showed the Mac's-audio
 *      checkbox, the speaker note and the live-translate box for ever.
 *   3. A TRANSCRIPT THAT COULD NOT BE REVIEWED. One dense block per speaker,
 *      nothing to search it by, and a highlight row that was a time range and
 *      no words at all.
 *
 * The decisions all three turn on now live in `src/viewers/recReview.ts`, so
 * most of what follows runs the real functions. What is left is structural —
 * "there is no second player", "the settings are drawn once" — and those are
 * read off the source, because a claim about what is NOT on a page cannot be
 * made by calling anything.
 *
 * The module is TypeScript, so it is transpiled in memory the same way
 * sketch.test.mjs handles its subject.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadTypescriptModule } from "../support/source-modules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const SRC = join(root, "apps/desktop/src/renderer/viewers/recReview.ts");

const R = await import(loadTypescriptModule(SRC));

const VIEW = readFileSync(join(root, "apps/desktop/src/renderer/viewers/RecordingView.tsx"), "utf8");
const SURFACE = readFileSync(join(root, "apps/desktop/src/renderer/viewers/RecordingSurface.tsx"), "utf8");
const CONTROLLER = readFileSync(join(root, "apps/desktop/src/renderer/viewers/recordingController.ts"), "utf8");
const BASE = readFileSync(join(root, "apps/desktop/src/renderer/viewers/recordingControllerBase.ts"), "utf8");
const PRESENTATION = readFileSync(join(root, "apps/desktop/src/renderer/viewers/recordingPresentation.tsx"), "utf8");
const MODEL = readFileSync(join(root, "apps/desktop/src/renderer/viewers/recordingModel.ts"), "utf8");

function stylesheet(entry, seen = new Set()) {
  if (seen.has(entry)) return "";
  seen.add(entry);
  const css = readFileSync(join(root, entry), "utf8");
  return [
    css,
    ...[...css.matchAll(/@import\s+["']([^"']+)["'];/g)].map(([, specifier]) =>
      stylesheet(join(dirname(entry), specifier), seen),
    ),
  ].join("\n");
}

const CSS = stylesheet("apps/desktop/src/renderer/styles/recording.css");

/* =====================================================================
 * P1 — ONE TRANSPORT
 * ===================================================================== */

test("the recording page has no second, native player on it", () => {
  // THE DEFECT. `controls` is what drew the second transport; the element it
  // was on is the single truth the wave, the transcript, the cut-skipping and
  // the clock all drive, so it has to stay — undrawn.
  // The element itself, not the paragraph of prose above that explains it.
  const at = SURFACE.indexOf("<audio ");
  const audio = SURFACE.slice(at, SURFACE.indexOf("/>", at));
  assert.ok(at > 0, "the element must still be rendered");
  assert.ok(
    !/^\s*controls\s*$/m.test(audio),
    "a native controls bar is a second transport on the same page",
  );
  assert.match(audio, /className="rec-player"/);
  // Hidden by CSS, never by leaving it out of the tree: removing the element
  // is what would actually stop the audio.
  const block = CSS.slice(CSS.indexOf(".rec-player {"), CSS.indexOf("}", CSS.indexOf(".rec-player {")));
  assert.match(block, /display: none/);
});

test("the one transport owns volume, speed and seeking, each with a name", () => {
  // The three things the native player was being kept for. Real form
  // controls, so the keyboard works without a line of key handling.
  assert.match(SURFACE, /aria-label="Volume"/);
  assert.match(SURFACE, /aria-label="Playback speed"/);
  assert.match(SURFACE, /aria-label="Seek in the recording"/);
  assert.match(SURFACE, /type="range" className="rec-seek"/);
  assert.match(SURFACE, /PLAYBACK_RATES\.map/);
});

test("the transport's controls ask the element and believe its answer", () => {
  // The same rule the play button already followed: the <audio> element is the
  // truth. A slider that set its own state first could show a level the audio
  // is not at — which is the two-players confusion again, in one control.
  assert.match(SURFACE, /onVolumeChange=\{\(e\) => setVolume\(clampVolume\(e\.currentTarget\.volume\)\)\}/);
  assert.match(SURFACE, /setRate\(e\.currentTarget\.playbackRate\)/);
  const ask = CONTROLLER.slice(CONTROLLER.indexOf("function askVolume"), CONTROLLER.indexOf("function askVolume") + 400);
  assert.ok(!/setVolume\(/.test(ask), "askVolume must not set the state itself");
});

test("dragging the bar moves the playhead without starting playback", () => {
  // `seek` plays, which is right for a timestamp you clicked and wrong for a
  // bar you are dragging: scrubbing a paused recording to look at a moment
  // must not start it.
  const scrub = CONTROLLER.slice(CONTROLLER.indexOf("function scrubTo"), CONTROLLER.indexOf("function showInTranscript"));
  assert.ok(!/\.play\(\)/.test(scrub), "scrubbing must never call play()");
  assert.match(scrub, /setPlayCs/, "a paused element fires no timeupdate, so the clock is set here");
  assert.match(SURFACE, /onChange=\{\(e\) => scrubTo\(Number\(e\.target\.value\)\)\}/);
});

test("the marks are on the track the seeking happens on", () => {
  assert.equal(typeof R.seekMarks, "function");
  assert.match(SURFACE, /marks\.map\(/);
  assert.match(CSS, /\.rec-seekmarks \{[^}]*pointer-events: none/s);
});

test("a recording with no length has nothing to mark", () => {
  assert.deepEqual(R.seekMarks(0, [{ id: "h1", t0: 10, t1: 20 }], []), []);
});

test("a converted recording's real file remains playable when old duration metadata is zero", () => {
  assert.equal(R.recordingCanPlay("workspace-media-token", false), true);
  assert.equal(R.recordingCanPlay(null, false), false);
  assert.equal(R.recordingCanPlay("workspace-media-token", true), false);
  assert.match(PRESENTATION, /const canPlay = !!src;/);
  assert.doesNotMatch(PRESENTATION, /const canPlay = !!src && durationCs > 0/);
});

test("a mark's place is a percentage of the whole recording, never past its ends", () => {
  const marks = R.seekMarks(
    10_000,
    [{ id: "h1", t0: 5000, t1: 5500 }, { id: "h2", t0: 99_999, t1: 100_000 }],
    [{ id: "c1", t0: 0, title: "Opening" }],
  );
  assert.deepEqual(
    marks.map((m) => [m.kind, m.atPct]),
    [["chapter", 0], ["highlight", 50], ["highlight", 100]],
    "sorted along the track, and clamped to it",
  );
  assert.match(marks[0].title, /Opening/, "a mark says what it is, for the hover");
  assert.match(marks[1].title, /Highlight 0:50–0:55/);
});

test("the seek bar tells a screen reader a time, not a percentage", () => {
  assert.equal(R.seekLabel(8300, 20_000), "1:23 of 3:20");
});

test("the speeds are a spoken-word range and read as multipliers", () => {
  assert.deepEqual([...R.PLAYBACK_RATES], [0.75, 1, 1.25, 1.5, 2]);
  assert.equal(R.rateLabel(1), "1×");
  assert.equal(R.rateLabel(1.25), "1.25×");
});

test("volume is whatever the element will accept and nothing else", () => {
  // The element throws outside 0–1, and the slider hands over whatever the
  // platform parsed out of its own value.
  assert.equal(R.clampVolume(1.4), 1);
  assert.equal(R.clampVolume(-3), 0);
  assert.equal(R.clampVolume(Number.NaN), 1, "an unparseable value is not silence");
  assert.equal(R.clampVolume(0.35), 0.35);
});

/* =====================================================================
 * P1 — REVIEW IS NOT CAPTURE CONFIGURATION
 * ===================================================================== */

test("a live session is its own stage, whatever else is in the file", () => {
  assert.equal(R.captureStage("recording", true), "recording");
  assert.equal(R.captureStage("paused", false), "paused");
  assert.equal(R.captureStage("saving", true), "saving");
});

test("an idle file is FINISHED once anything has been recorded into it", () => {
  // THE DEFECT. The view only ever asked `isLive`, which cannot tell a file
  // nobody has recorded into from one that is finished — so both got the row
  // of capture settings, for ever.
  assert.equal(R.captureStage("idle", false), "fresh");
  assert.equal(R.captureStage("idle", true), "finished");
});

test("only a finished recording puts its capture choices behind the button", () => {
  assert.equal(R.needsPreflight("finished"), true);
  assert.equal(R.showsChoicesInline("finished"), false);
  for (const stage of ["fresh", "recording", "paused", "saving"]) {
    assert.equal(R.needsPreflight(stage), false, `${stage} must not need a preflight`);
    assert.equal(
      R.showsChoicesInline(stage),
      true,
      `${stage} keeps its controls where they can be reached`,
    );
  }
});

test("the capture settings are relocated, not deleted, and written once", () => {
  // Every one of them still exists, and each appears in exactly one place in
  // the source — two copies of a checkbox bound to one state is two controls
  // that can look different from each other.
  for (const label of [
    "Include the Mac’s audio (meetings)",
    "Speakers detected automatically — name them later",
    "Live translate",
  ]) {
    const hits = PRESENTATION.split(label).length - 1;
    assert.equal(hits, 1, `"${label}" is drawn ${hits} times, not once`);
  }
  // `capturable` joined this gate when imported and downloaded media started
  // getting a `recordings` row of their own (see the capture-controls test
  // below): the stage says WHEN these are drawn, and `capturable` says whether
  // this file has a capture to configure at all.
  assert.match(
    SURFACE,
    /if \(!capturable \|\| !showsChoicesInline\(stage\)\) return null;/,
    "the inline row is gated by the stage",
  );
  assert.match(SURFACE, /if \(!capturable \|\| !needsPreflight\(stage\) \|\| !preflight\) return null;/);
  assert.match(SURFACE, /\{captureChoices\}/);
});

test("the record button says it is a disclosure when that is what it is", () => {
  assert.match(SURFACE, /aria-expanded=\{primary\.expands \? preflight : undefined\}/);
  assert.match(PRESENTATION, /const expands = needsPreflight\(stage\)/);
  // …and starting the session closes it, or the capture settings would be
  // back beside a running capture's transport.
  const start = CONTROLLER.slice(CONTROLLER.indexOf("async function start()"));
  assert.match(start.slice(0, 400), /setPreflight\(false\)/);
});

test("live and paused keep every control they had", () => {
  // The fix moved settings off the REVIEW screen. A live meeting still needs
  // its live-transcription toggle and its live-translate box mid-flight.
  const options = SURFACE.slice(SURFACE.indexOf("function SessionOptions"), SURFACE.indexOf("function CapturePreflight"));
  assert.match(options, /showsChoicesInline\(stage\)/);
  assert.match(options, /<LiveTranscriptionToggle/);
  assert.match(options, /\{liveTranslateOpt\}/);
  assert.match(SURFACE, /function LiveTranscriptionToggle[\s\S]*?if \(!isLive\) return null;[\s\S]*?Live transcription/);
});

test("a file this app cannot record into is never offered a record button", () => {
  // A `recordings` row stopped being proof that Arcelle MADE the file: an
  // imported or downloaded media file gets one too, so it opens in this
  // speaker-aware view instead of the plain player. Everything on this page
  // carries over to such a file except capture — `rec_start` splices the new
  // audio onto samples it decodes out of the stored file with `decodeWav`, so
  // "Continue recording" on an imported .mp3 is the page's one red primary
  // button offering an act whose only possible answer is the engine's error
  // string, above a preflight promising "nothing already recorded is lost"
  // about a file nothing ever recorded into.
  //
  // Every branch of the rule is pinned, because each one is a decision: a live
  // session on this file is proof by demonstration; a name that has not arrived
  // (or a `rec_get` that failed) and a name with no extension at all are both
  // UNKNOWN and keep the control, since losing the record button on a real
  // recording is a far worse failure than an error toast on an import. Only a
  // name positively stating some other container takes the cluster away.
  assert.match(
    MODEL,
    /return isLive \|\| container === null \|\| !NO_CAPTURE_CONTAINERS\.has\(container\);/,
    "the container the name claims decides it",
  );
  // A LIST of containers, never `!== "wav"`. A file's name is free text a
  // person types: "Dr. Cohen call", "Q3 kickoff v1.2" and "2026.08.28 standup"
  // all end in a dotted token, and reading those as containers ("cohen call",
  // "2", "28 standup") took the record button off three perfectly ordinary
  // recordings — the failure this whole rule calls the worse one.
  const containers = VIEW.slice(
    VIEW.indexOf("const NO_CAPTURE_CONTAINERS"),
    VIEW.indexOf("]);", VIEW.indexOf("const NO_CAPTURE_CONTAINERS")),
  );
  assert.ok(containers.length > 0, "the list is still there to be read");
  assert.match(containers, /"mp3"/, "an imported podcast cannot be recorded into");
  assert.match(containers, /"mp4"/, "nor a downloaded video");
  assert.doesNotMatch(
    containers,
    /"wav"/,
    "WAV is the one container rec_start's decoder can continue",
  );
  // Read off the name `rec_get` was already returning and the view was
  // throwing away — no new IPC, no new field on RecMeta.
  assert.match(BASE, /setFileName\(r\.name\)/);
  assert.match(SURFACE, /if \(status === "saving" \|\| !capturable\) return null;/, "the record button");
  assert.match(SURFACE, /if \(!capturable \|\| !showsChoicesInline\(stage\)\) return null;/, "the capture settings");
  // …and the copy that points at them: the "fresh" empty state is one long
  // instruction to press a record button that is not there.
  assert.match(SURFACE, /if \(stage === "fresh" && capturable\) return <FreshTranscriptMessage/);
  assert.match(SURFACE, /return stage === "finished" \|\| !capturable;/);
});

/* =====================================================================
 * P1 — A TRANSCRIPT AND HIGHLIGHTS THAT SUPPORT REVIEW
 * ===================================================================== */

const turn = (key, ...phrases) => ({
  key,
  segs: phrases.map(([id, text]) => ({ seg: { id }, text })),
});

test("an empty search is not a search", () => {
  const turns = [turn("t1", ["s1", "hello"])];
  const out = R.searchTranscript(turns, "   ");
  assert.equal(out.searching, false);
  assert.equal(out.turns, turns, "the same array — nothing re-renders for a search nobody ran");
  assert.equal(out.phrases, 0);
});

test("a search keeps the turn but points at the phrase", () => {
  // The phrase is what the page seeks to and what the reader is looking for;
  // the turn around it is the context that makes the sentence make sense.
  const turns = [
    turn("t1", ["s1", "we should ship on Thursday"], ["s2", "or Friday"]),
    turn("t2", ["s3", "nothing to do with it"]),
  ];
  const out = R.searchTranscript(turns, "THURSDAY");
  assert.deepEqual(out.turns.map((t) => t.key), ["t1"], "case cannot matter");
  assert.deepEqual([...out.hits], ["s1"], "only the phrase that matched is marked");
  assert.equal(out.phrases, 1);
  assert.equal(out.searching, true);
});

test("the count is of phrases, so a turn full of hits says so", () => {
  const turns = [turn("t1", ["s1", "budget"], ["s2", "the budget again"], ["s3", "no"])];
  assert.equal(R.searchTranscript(turns, "budget").phrases, 2);
});

test("a search that finds nothing finds nothing, loudly", () => {
  const out = R.searchTranscript([turn("t1", ["s1", "hello"])], "zebra");
  assert.deepEqual(out.turns, []);
  assert.equal(out.phrases, 0);
  assert.equal(out.searching, true, "an empty transcript and an empty result are not the same");
  // …and the page says which of the two it is looking at.
  assert.match(SURFACE, /No phrase in this transcript contains/);
});

test("the playhead's phrase is the last one that has started", () => {
  const segs = [{ id: "a", t0: 0 }, { id: "b", t0: 500 }, { id: "c", t0: 900 }];
  assert.equal(R.segmentAt(segs, 0), "a", "a phrase starting exactly now is the current one");
  assert.equal(R.segmentAt(segs, 499), "a");
  assert.equal(R.segmentAt(segs, 500), "b");
  assert.equal(R.segmentAt(segs, 100_000), "c");
  assert.equal(R.segmentAt([{ id: "a", t0: 300 }], 0), null, "before the first word, nothing");
  assert.equal(R.segmentAt([], 100), null);
});

test("one rule decides where the playhead is, so a jump cannot land a line off", () => {
  const uses = CONTROLLER.match(/segmentAt\(segments,/g) ?? [];
  assert.ok(uses.length >= 3, `only ${uses.length} places ask segmentAt`);
  const onTime = CONTROLLER.slice(CONTROLLER.indexOf("function onTime()"), CONTROLLER.indexOf("function seek("));
  assert.match(onTime, /segmentAt\(segments, cs\)/, "timeupdate must use it too");
});

test("the transcript is a line per phrase, each with its own time and its own play", () => {
  // THE DEFECT: one dense block per speaker, a single timestamp at the top,
  // and no way to start from any phrase but the first.
  const list = SURFACE.slice(SURFACE.indexOf("function TranscriptStamp"), SURFACE.indexOf("function ReadTab"));
  assert.match(list, /className="rec-line/);
  assert.match(list, /data-seg=\{seg\.id\}/, "a line has to be findable to be jumped to");
  assert.match(list, /<TranscriptStamp t0=\{seg\.t0\}/);
  assert.match(list, /aria-label=\{`Play from \$\{formatTimestamp\(t0\)\}`\}/);
  assert.match(list, /onClick=\{\(\) => seek\(t0\)\}/);
  assert.match(list, /activeSeg === seg\.id \? " is-active" : ""/);
  // The speaker is still said once per turn, not once per line.
  assert.equal(list.split("<SpeakerChip").length - 1, 1);
});

test("the rename hint is said DURING a live meeting, not only after one", () => {
  // THE DEFECT. Naming a voice is the one edit whose whole affordance is a
  // tooltip on the chip, and the paragraph that says so out loud hung off
  // `!isLive` — so it was invisible for exactly as long as the meeting lasted,
  // which is when a person actually knows who is talking. Nothing about
  // renaming is gated on the session: the same chip is drawn either way, and
  // `rename_speaker` is one of the live-safe ops the session socket accepts.
  const at = SURFACE.indexOf('<p className="rec-read-note">');
  assert.ok(at > 0, "the hint is still on the page");
  const gate = SURFACE.slice(SURFACE.indexOf("function TranscriptNote"), at);
  assert.match(gate, /if \(segments\.length === 0\) return null;/, "drawn as soon as there are words");
  assert.doesNotMatch(gate, /isLive/, "a live session must not hide the rename hint");
  const note = SURFACE.slice(at, SURFACE.indexOf("</p>", at));
  assert.match(note, /Click a speaker’s name to say who they were\./);
  // The OTHER half of the same paragraph keeps its gate, and must: the backend
  // refuses rec_delete_range and rec_correct_range while the file has a live
  // session, so the selection bar this sentence points at never appears. One
  // paragraph, two different claims — un-gating both would trade an invisible
  // affordance for an advertised one that does nothing.
  assert.match(
    note,
    /<TranscriptEditingHint/,
    "the editing half stays behind canEdit",
  );
  assert.match(
    SURFACE,
    /function TranscriptEditingHint[\s\S]*?if \(!canEdit\) return null;[\s\S]*?Select words above to correct them/,
    "the editing half stays behind canEdit",
  );
});

test("selecting words to correct or delete still works on a line", () => {
  // The whole transcript-editing feature reads these two attributes off the
  // word spans; breaking them while resegmenting would take correcting,
  // deleting, marking and noting with it.
  assert.match(SURFACE, /data-t0=\{word\.t0\}/);
  assert.match(SURFACE, /data-t1=\{word\.t1\}/);
  assert.match(CONTROLLER, /querySelectorAll<HTMLElement>\("\[data-t0\]"\)/);
});

test("a highlight quotes the phrases it overlaps and nothing else", () => {
  const quotes = [
    { t0: 0, t1: 400, text: "Before the mark." },
    { t0: 500, t1: 900, text: "We agreed to ship on Thursday." },
    { t0: 900, t1: 1200, text: "Dana will write the note." },
    { t0: 2000, t1: 2400, text: "After the mark." },
  ];
  const q = R.highlightQuote(quotes, 600, 1000);
  assert.match(q.title, /We agreed to ship on Thursday\./);
  assert.match(q.excerpt, /Dana will write the note\./);
  assert.ok(!/Before the mark/.test(q.title + q.excerpt), "a phrase that ended first is not in it");
  assert.ok(!/After the mark/.test(q.title + q.excerpt), "nor one that had not started");
});

test("a mark over words nobody transcribed says so instead of quoting nothing", () => {
  // Silence, music, or live transcription switched off. An empty quotation
  // under a real timestamp reads as a transcript that lost the words.
  assert.equal(R.highlightQuote([{ t0: 0, t1: 100, text: "hello" }], 5000, 6000), null);
  assert.equal(R.highlightQuote([], 0, 100), null);
  assert.equal(R.highlightQuote([{ t0: 0, t1: 100, text: "   " }], 0, 100), null);
  assert.match(VIEW, /Nothing transcribed in this stretch/);
});

test("a one-sentence mark gets a title and no repeated excerpt", () => {
  const q = R.highlightQuote([{ t0: 0, t1: 100, text: "Short and done." }], 0, 100);
  assert.equal(q.title, "Short and done.");
  assert.equal(q.excerpt, "", "the same sentence twice is not a title and an excerpt");
});

test("a first sentence too long to be a heading keeps its words in the excerpt", () => {
  const long =
    "We went round the whole question of the migration again and nobody was willing to commit to a date before the audit finishes.";
  const q = R.highlightQuote([{ t0: 0, t1: 100, text: long }], 0, 100);
  assert.ok(q.title.length <= 60, `the title is a heading, not a paragraph: ${q.title}`);
  assert.match(q.title, /…$/);
  assert.ok(q.title.endsWith("…") && !q.title.endsWith(" …"), "the cut lands on a word boundary");
  assert.ok(q.excerpt.includes("audit finishes"), "the cut words have to exist somewhere");
});

test("the highlight row carries the words, the time, who wrote it, and both acts", () => {
  const panel = VIEW.slice(VIEW.indexOf("function HighlightRows"), VIEW.indexOf("function HighlightExcerpt"));
  assert.match(panel, /highlightQuote\(quotes, highlight\.t0, highlight\.t1\)/, "quoted, never invented");
  assert.match(panel, /rec-hl-title/);
  assert.match(panel, /formatTimestamp\(highlight\.t0\)}–\{formatTimestamp\(highlight\.t1\)/);
  assert.match(panel, /onJump\(highlight\.t0\)/, "read it in the transcript…");
  assert.match(panel, /Show in transcript/);
  // …or hear it: the row's timestamp is its play control, and there is only
  // the one — a second play button beside it is the two-transports mistake in
  // miniature.
  assert.match(VIEW, /aria-label=\{`Play from \$\{formatTimestamp\(t0\)\}`\}/);
  // Provenance survived the rewrite: the room's own findings still say so.
  assert.match(VIEW, /data-by=\{by \?\? "room"\}/);
  assert.match(VIEW, /aria-label=" \(the room wrote this\)"/);
});

test("the words a highlight quotes are the words on screen", () => {
  // Taken off the turns, where "Show deleted" and the delete edits have
  // already been applied — never off `seg.text`, which still holds every
  // deleted word. A quote nobody can find in the transcript is a fabrication.
  const quotes = CONTROLLER.slice(CONTROLLER.indexOf("const quotes = useMemo"), CONTROLLER.indexOf("// ---- playback"));
  assert.match(quotes, /turns\.flatMap/);
  assert.ok(!/seg\.text/.test(quotes), "seg.text still contains the deleted words");
});

test("jumping to a moment reads it rather than playing it", () => {
  const jump = CONTROLLER.slice(
    CONTROLLER.indexOf("function showInTranscript"),
    CONTROLLER.indexOf("function askVolume"),
  );
  assert.ok(!/\.play\(\)/.test(jump), "'Show in transcript' must not start the audio");
  assert.match(jump, /setQuery\(""\)/, "a jump into a phrase the filter hides lands on nothing");
  assert.match(jump, /setTab\("transcript"\)/);
  assert.match(jump, /setFindSeg\(segmentAt\(segments, cs\)\)/);
});

/* =====================================================================
 * THE HOUSE RULES
 * ===================================================================== */

test("nothing new on this page moves by itself", () => {
  // The standing rule: ambient motion has been reverted twice. The only two
  // animations in this file are the capture dot (the recording indicator) and
  // the still-speaking caret, plus the reduced-motion `animation: none` that
  // switches the first one off.
  const anims = CSS.match(/^\s*animation:/gm) ?? [];
  assert.equal(anims.length, 3, `${anims.length} animations in recording.css — two, and an off switch`);
  assert.match(CSS, /@keyframes rec-pulse/);
  assert.match(CSS, /@keyframes rec-caret/);
});

test("the one scroll this adds respects a reader who asked for stillness", () => {
  assert.match(CONTROLLER, /prefersReducedMotion\(\) \? "auto" : "smooth"/);
});

test("the timestamp on every part of the page is drawn by one function", () => {
  assert.equal(R.formatTimestamp(0), "0:00");
  assert.equal(R.formatTimestamp(-500), "0:00", "a negative time is not a negative clock");
  assert.equal(R.formatTimestamp(6100), "1:01");
  assert.equal(R.formatTimestamp(360_000), "1:00:00");
  assert.ok(
    !/function formatTimestamp/.test(`${VIEW}\n${SURFACE}\n${CONTROLLER}\n${PRESENTATION}`),
    "the view must import it, not keep a second copy that can drift",
  );
});
