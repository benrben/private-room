/* The spoken voice's sentence chunker (src/workspace/voice.ts).
 *
 * Every guard in `extractSentences`/`emit`/`breakPoint`/`stripForSpeech` exists
 * because something was once read aloud wrong: a JSON annotation payload spoken
 * as words, a CJK answer arriving as one chunk the synthesizer silently refused,
 * "3.5b" cut in half at the decimal point. None of it had a test, so the next
 * change to the voice had nothing to land on.
 *
 * The chunker is pure string work, so it is sliced out of the real source and
 * executed for real — the localModel.test.mjs / adaptiveText.test.mjs idiom. No
 * exports are added to production for testability, and the module's own state
 * (`carry`, `sentenceQueue`, `pending`) comes along with the slice, so the tests
 * drive it exactly as a turn does.
 *
 * The one seam that IS stubbed is `pump()`, the synthesis pump: it reaches the
 * network through `api.speakTextNeural`. Everything above it — what gets cut,
 * where, and what is dropped — is the real shipped code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const VOICE_SOURCE = read("src/workspace/voice.ts");

// ---- slice: the chunker, from stripForSpeech to the synthesis pump ---------

const start = VOICE_SOURCE.indexOf("function stripForSpeech");
const end = VOICE_SOURCE.indexOf("// ---- synthesis pump");
assert.ok(
  start > 0 && end > start,
  "expected the chunker between stripForSpeech and the synthesis-pump banner — did voice.ts get reshuffled?",
);

// The constants the slice reads, taken from the source rather than restated:
// a test that hardcodes 60/300/25 would keep passing after somebody retunes them.
const constOf = (name) => {
  const m = VOICE_SOURCE.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(m, `expected a numeric ${name} in voice.ts`);
  return Number(m[1]);
};
const MIN_CHUNK_CHARS = constOf("MIN_CHUNK_CHARS");
const MIN_FIRST_CHUNK_CHARS = constOf("MIN_FIRST_CHUNK_CHARS");
const FORCE_FLUSH_CHARS = constOf("FORCE_FLUSH_CHARS");

const harness = `
const MIN_CHUNK_CHARS = ${MIN_CHUNK_CHARS};
const MIN_FIRST_CHUNK_CHARS = ${MIN_FIRST_CHUNK_CHARS};
const FORCE_FLUSH_CHARS = ${FORCE_FLUSH_CHARS};
let pending = "";
let carry = "";
let sentenceQueue = [];
let firstChunkSent = false;
function pump() {}
`;
const exports = `
export function feed(text, force) { pending += text; extractSentences(force); }
export function drain() { const out = sentenceQueue.slice(); reset(); return out; }
export function reset() { pending = ""; carry = ""; sentenceQueue = []; firstChunkSent = false; }
export function held() { return pending; }
`;
const js = ts.transpileModule(harness + VOICE_SOURCE.slice(start, end) + exports, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { feed, drain, reset, held } = await import(
  `data:text/javascript,${encodeURIComponent(js)}`
);

/** Everything a whole turn would queue for synthesis. */
function spoken(text) {
  reset();
  feed(text, true);
  return drain();
}

// ---- what the slice cannot execute, pinned as source text ------------------

test("every path that starts new speech resets the first-chunk floor", () => {
  // The harness declares its own `firstChunkSent`, so it cannot exercise the
  // three lifecycle functions that reset it in production — and a floor left
  // raised would silently un-do the fast opener, while one left LOWERED would
  // ship a fragment mid-answer. Pinned as text, the same way the Rust coupling
  // below is.
  for (const fn of ["beginTurn", "roundBoundary", "cancelAll"]) {
    const at = VOICE_SOURCE.indexOf(`export function ${fn}(`);
    assert.ok(at > 0, `expected ${fn}() in voice.ts`);
    const body = VOICE_SOURCE.slice(at, VOICE_SOURCE.indexOf("\n}", at));
    assert.ok(
      body.includes("firstChunkSent = false"),
      `${fn}() starts or ends a turn's speech and must reset firstChunkSent`,
    );
  }
});

// ---- the cross-language coupling nobody was guarding -----------------------

test("the offline branch still matches the words the Rust actually sends", () => {
  // `reportVoiceProblem` decides between "your internet switch is off — here is
  // where" and "the voice service didn't answer" by matching a SUBSTRING of a
  // message composed in another language, in another file. Reword the Rust and
  // the user is quietly pointed at a network problem instead of the one-click
  // setting that caused it — with nothing failing to say so.
  const rust = read("src-tauri/src/commands/speech_cmds.rs");
  const needle = VOICE_SOURCE.match(/reason\.includes\("([^"]+)"\)/);
  assert.ok(needle, "expected voice.ts to branch on a substring of the host's refusal");
  const offline = rust.match(/SPEECH_OFFLINE_MESSAGE: &str =\s*([\s\S]*?);/);
  assert.ok(offline, "expected SPEECH_OFFLINE_MESSAGE in speech_cmds.rs");
  assert.ok(
    offline[1].includes(needle[1]),
    `voice.ts matches on "${needle[1]}", which SPEECH_OFFLINE_MESSAGE no longer contains — ` +
      "the offline case would be reported as a service failure",
  );
});

// ---- what must never be read aloud ----------------------------------------

test("a complete fenced block is never spoken", () => {
  const out = spoken(
    'Here is the shape.\n```json\n{"boxes":[{"x":1,"y":2}]}\n```\nThat is all of it.',
  ).join(" ");
  assert.ok(out.includes("Here is the shape"), "the prose around a fence still gets spoken");
  assert.ok(out.includes("That is all of it"), "prose AFTER a fence is not lost with it");
  assert.ok(!out.includes("boxes"), "viewer-markup JSON must never be read out as words");
  assert.ok(!out.includes("{"), "no fence content survives into speech");
});

test("an UNCLOSED fence is held back, then dropped at end of turn", () => {
  reset();
  // Mid-stream: the fence has opened and not closed. Nothing after it may be
  // spoken yet — the closing ``` may still be coming. The prose before it is
  // long enough to clear the first-chunk floor, so it ships on its own.
  feed('Let me draw what you just described.\n```json\n{"boxes":[', false);
  const midTurn = drain().join(" ");
  assert.ok(midTurn.includes("Let me draw what you just described"), "prose before the fence is spoken immediately");
  assert.ok(!midTurn.includes("boxes"), "an open fence's contents are held, not spoken");

  // End of turn with the fence still open: the payload is DROPPED, not flushed.
  reset();
  feed("Let me draw that.\n```json\n{\"boxes\":[", true);
  const forced = drain().join(" ");
  assert.ok(!forced.includes("boxes"), "a still-open fence is dropped at end of turn, never spoken");
});

// ---- where the cuts fall ---------------------------------------------------

test("a decimal point is not a sentence end", () => {
  const out = spoken("The model is qwen3.5b and it fits in 7.5 GB of memory here.");
  assert.equal(out.length, 1, `"3.5"/"7.5" must not split the sentence — got ${JSON.stringify(out)}`);
  assert.ok(out[0].includes("qwen3.5b"), "the version number survives intact");
});

test("CJK sentence enders split, so an answer is never one oversized chunk", () => {
  // No spaces and no Western punctuation: without 。！？ in the ender set this
  // arrives as a single chunk the synthesizer refuses, and the answer is
  // silently never spoken.
  const cjk = "这是第一句话。".repeat(12);
  const out = spoken(cjk);
  assert.ok(out.length > 1, "CJK text must be split into speakable chunks");
  for (const chunk of out) {
    assert.ok(
      chunk.length <= FORCE_FLUSH_CHARS + MIN_CHUNK_CHARS,
      `chunk of ${chunk.length} chars is past the force-flush size: ${chunk.slice(0, 40)}…`,
    );
  }
});

test("a runaway sentence with no punctuation is still cut", () => {
  // A clause that never ends must not grow past the synthesizer's limit, where
  // it would be rejected without a sound.
  const runaway = `${"wordy ".repeat(200)}.`;
  const out = spoken(runaway);
  assert.ok(out.length > 1, "an unpunctuated runaway must be force-flushed, not held whole");
  for (const chunk of out) {
    assert.ok(
      chunk.length <= FORCE_FLUSH_CHARS + MIN_CHUNK_CHARS,
      `chunk of ${chunk.length} chars is past the force-flush size`,
    );
  }
});

test("markdown is spoken as prose, not as syntax", () => {
  const out = spoken("## The **plan**\n\n- Read [the lease](file.pdf) first.\n").join(" ");
  assert.ok(out.includes("The plan"), "heading and emphasis markers are stripped");
  assert.ok(out.includes("the lease"), "a link keeps its label");
  assert.ok(!out.includes("file.pdf"), "a link's target is not read out");
  assert.ok(!out.includes("#") && !out.includes("*"), "no markdown syntax survives into speech");
});

// ---- the first chunk of a turn --------------------------------------------

test("a short opener is spoken immediately instead of waiting for padding", () => {
  reset();
  // Below the ordinary floor, at or above the first-chunk floor: this is the
  // sentence that decides how long the room takes to say ANYTHING.
  const opener = "Sure, let me check that for you.";
  assert.ok(
    opener.length >= MIN_FIRST_CHUNK_CHARS && opener.length < MIN_CHUNK_CHARS,
    `fixture must sit between the two floors (${MIN_FIRST_CHUNK_CHARS}/${MIN_CHUNK_CHARS}), got ${opener.length}`,
  );
  feed(opener, false);
  assert.deepEqual(
    drain(),
    [opener],
    "the first chunk of a turn goes to synthesis without waiting for a second sentence",
  );
});

test("later short sentences still merge, so the voice keeps its prosody", () => {
  reset();
  // The opener ships alone (above). The NEXT short sentence must not: it stays
  // in the carry until it is worth speaking, which is what keeps the voice from
  // reading a list of fragments.
  feed("Sure, let me check that for you.", false);
  feed(" Yes.", false);
  const out = drain();
  assert.deepEqual(
    out,
    ["Sure, let me check that for you."],
    `only the opener ships early; a later short sentence merges forward — got ${JSON.stringify(out)}`,
  );
});
