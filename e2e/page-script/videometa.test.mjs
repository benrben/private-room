/* The technical strip under a video player.
 *
 * `src/viewers/mediaMeta.ts` is where "the container never said" has to survive
 * the trip to the screen. It is pure, so it is tested here against the REAL
 * TypeScript source (type-stripped in memory, the trick viewerparse.test.mjs
 * uses) rather than through a rendered component.
 *
 * The rule these tests exist to hold: a field the probe could not read renders
 * as the word "unknown" and is marked `known: false`. It never falls back to 0
 * fps, 0 × 0, or a codec someone thought was likely — on screen, a plausible
 * default is indistinguishable from a measurement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

async function load(relPath) {
  const source = readFileSync(join(root, relPath), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

const { videoFacts, describeSpan, formatDuration } = await load(
  "src/viewers/mediaMeta.ts",
);

/** The fully-unknown probe result: every field null. */
const NOTHING = {
  durationSecs: null,
  width: null,
  height: null,
  videoCodec: null,
  frameRate: null,
  bitrateKbps: null,
  hasAudio: null,
  audioCodec: null,
};

const byLabel = (facts) =>
  Object.fromEntries(facts.map((f) => [f.label, f]));

test("a fully-read video reports every field as a fact", () => {
  const f = byLabel(
    videoFacts(
      {
        ...NOTHING,
        durationSecs: 751,
        width: 1920,
        height: 1080,
        videoCodec: "H.264",
        frameRate: 24,
        bitrateKbps: 1354,
        hasAudio: true,
        audioCodec: "AAC",
      },
      null,
    ),
  );
  assert.equal(f.Length.value, "12:31");
  assert.equal(f.Size.value, "1920 × 1080");
  assert.equal(f.Video.value, "H.264");
  assert.equal(f["Frame rate"].value, "24 fps");
  assert.equal(f.Audio.value, "AAC");
  assert.equal(f.Bitrate.value, "1354 kbps");
  assert.ok(
    Object.values(f).every((x) => x.known),
    "everything the container stated must be marked known",
  );
});

test("a field the container never stated reads 'unknown', not a default", () => {
  const f = byLabel(videoFacts(NOTHING, null));
  for (const label of ["Length", "Size", "Video", "Frame rate", "Audio"]) {
    assert.equal(f[label].value, "unknown", `${label} invented a value`);
    assert.equal(f[label].known, false, `${label} claimed to be known`);
  }
  // Bitrate is the one field that is omitted rather than shown as unknown: a
  // sixth "unknown" costs more attention than the field is worth.
  assert.equal(f.Bitrate, undefined);
});

test("no probe at all is the same honest answer as an empty probe", () => {
  // A room saved before the column existed hands the viewer `null`. It must
  // not collapse into zeros on the way to the strip.
  const f = byLabel(videoFacts(null, null));
  assert.equal(f.Size.value, "unknown");
  assert.equal(f["Frame rate"].value, "unknown");
  assert.equal(f.Video.value, "unknown");
});

test("a silent video says 'none', which is not the same as 'unknown'", () => {
  // hasAudio === false is a FINDING. Flattening it into the same word as
  // hasAudio === null would throw away the answer the probe actually got.
  const silent = byLabel(videoFacts({ ...NOTHING, hasAudio: false }, null));
  assert.equal(silent.Audio.value, "none");
  assert.equal(silent.Audio.known, true);
  const unknown = byLabel(videoFacts({ ...NOTHING, hasAudio: null }, null));
  assert.equal(unknown.Audio.value, "unknown");
  assert.equal(unknown.Audio.known, false);
  // An audio track whose codec we couldn't name is still an audio track.
  const named = byLabel(videoFacts({ ...NOTHING, hasAudio: true }, null));
  assert.equal(named.Audio.value, "yes");
  assert.equal(named.Audio.known, true);
});

test("a half-size never becomes a size", () => {
  // Width without height is not a resolution, and "1920 × 0" would be a lie.
  const f = byLabel(videoFacts({ ...NOTHING, width: 1920 }, null));
  assert.equal(f.Size.value, "unknown");
});

test("the player's own duration stands in when the container gave none", () => {
  // The <video> element measured the same bytes, so this is a second reading
  // rather than a guess — but the probe's answer wins where both exist.
  assert.equal(byLabel(videoFacts(NOTHING, 90)).Length.value, "1:30");
  assert.equal(
    byLabel(videoFacts({ ...NOTHING, durationSecs: 30 }, 90)).Length.value,
    "0:30",
  );
});

test("frame rates keep the precision the file stated and no more", () => {
  const fps = (n) => byLabel(videoFacts({ ...NOTHING, frameRate: n }, null))["Frame rate"].value;
  assert.equal(fps(29.97), "29.97 fps");
  assert.equal(fps(30), "30 fps"); // not "30.00 fps"
  assert.equal(fps(240), "240 fps");
});

test("durations grow an hours field instead of rolling over", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(59.6), "1:00");
  assert.equal(formatDuration(3599), "59:59");
  assert.equal(formatDuration(3600), "1:00:00");
  assert.equal(formatDuration(3725), "1:02:05");
});

test("a trim span only describes itself once it is a real span", () => {
  assert.equal(describeSpan(7.3, 19), "0:07 → 0:19 (11.7s)");
  assert.equal(describeSpan(0, 90), "0:00 → 1:30 (90s)");
  // Nothing to describe → the button stays disabled.
  assert.equal(describeSpan(null, 19), null);
  assert.equal(describeSpan(7, null), null);
  assert.equal(describeSpan(19, 7), null, "an inverted span is not a span");
  assert.equal(describeSpan(7, 7.05), null, "a sub-frame span is not a span");
  assert.equal(describeSpan(Number.NaN, 19), null);
});
