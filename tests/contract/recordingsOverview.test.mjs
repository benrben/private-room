/* THE RECORDINGS OVERVIEW — that it stopped being the sidebar, and that every
 * fact it states is one it read.
 *
 * P2 (QA, 2026-08-15): the centre pane repeated the contextual sidebar. The two
 * capture buttons and the whole filterable list of recordings were drawn twice
 * on one screen, so neither copy was authoritative and the widest surface in the
 * app spent itself on navigation the second column already provided.
 *
 * That regresses invisibly — a list re-added to the centre still renders, it is
 * just the wrong list — so the render tests below assert the ABSENCE: the
 * sidebar's verbs are not offered here, and a recording that is neither the
 * newest nor waiting on a transcript does not appear at all.
 *
 * The rest pins the decisions the page makes before it renders anything: which
 * of the three capture phases the room is in, what counts as "waiting on a
 * transcript", and how a tally is phrased. Those are pure and exported from
 * RecordingsPage.tsx, and they are imported here from the SHIPPED file — the
 * same type-stripping trick activityPane.test.mjs uses — never from a copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../../apps/desktop/src/renderer");

/* ---------- loading the real TSX under plain node ---------- */

const BARE = {
  react: import.meta.resolve("react"),
  "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
};

const asData = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

const FROM_RE = /(?:import|export)\s+([\s\S]*?)\s+from\s+"([^"]+)";/g;
// A side-effect import — the page pulls in its own stylesheet, which Vite
// understands and node does not. Dropped rather than stubbed: a stylesheet has
// no bindings, so there is nothing for the rest of the module to bind to.
const CSS_IMPORT_RE = /^\s*import\s+"[^"]+\.css";\s*$/gm;

function bindingsOf(clause) {
  const names = [];
  const braced = clause.match(/\{([\s\S]*)\}/);
  if (braced) {
    for (const raw of braced[1].split(",")) {
      const n = raw.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.push(n);
    }
  }
  const head = clause.replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim();
  return { names, hasDefault: Boolean(head) };
}

/** Every binding an inert function — a valid React component and a callable
 *  that returns nothing. */
function stubModule(clause) {
  const { names, hasDefault } = bindingsOf(clause);
  return asData(
    [
      "const inert = () => null;",
      ...names.map((n) => `export const ${n} = inert;`),
      hasDefault ? "export default inert;" : "",
    ].join("\n"),
  );
}

function loadReal(absPath, stubbed, cache = new Map()) {
  const hit = cache.get(absPath);
  if (hit) return hit;
  const jsx = absPath.endsWith(".tsx");
  let js = ts.transpileModule(readFileSync(absPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    },
  }).outputText;

  js = js.replace(CSS_IMPORT_RE, "");
  js = js.replace(FROM_RE, (whole, clause, spec) => {
    const swap = (url) => whole.replace(`"${spec}"`, JSON.stringify(url));
    if (BARE[spec]) return swap(BARE[spec]);
    if (spec.startsWith("@tauri-apps/")) return swap(stubModule(clause));
    if (spec.startsWith(".")) {
      const base = resolve(dirname(absPath), spec);
      const target = [".ts", ".tsx", "/index.ts"]
        .map((ext) => base + ext)
        .find(existsSync);
      assert.ok(target, `cannot resolve ${spec} from ${absPath}`);
      if (stubbed.has(target)) return swap(stubModule(clause));
      return swap(loadReal(target, stubbed, cache));
    }
    return swap(stubModule(clause));
  });

  const url = asData(js);
  cache.set(absPath, url);
  return url;
}

// The adaptive dek is its own feature with its own test (adaptiveText.test.mjs)
// and its own network path. Stubbed to null, which is a value it really
// returns — the page then shows its static fallback, which is the state this
// test wants to read anyway.
const STUBS = new Set([join(SRC, "workspace/adaptiveText.ts")]);
const mod = await import(loadReal(join(SRC, "workspace/RecordingsPage.tsx"), STUBS));

const RecordingsPage = mod.default;
const {
  ATTENTION_COPY,
  ATTENTION_SHOWN,
  ATTENTION_WORD,
  attentionReason,
  captureDetail,
  captureNow,
  countLabel,
  failureDetail,
  needsAttention,
  newestAlreadyOnPage,
  saveDetail,
  shelfChip,
  shelfTally,
  transcribedPhrase,
  transcribingNow,
} = mod;

/* ---------- fixtures ---------- */

const rec = (id, over = {}) => ({
  id,
  name: `${id}.m4a`,
  mimeType: "audio/mp4",
  sizeBytes: 1024 * 1024,
  source: "recording",
  hasText: true,
  createdAt: "2026-08-01T10:00:00.000Z",
  folderId: null,
  partiallyIndexed: false,
  aiSummary: null,
  originDestination: "recordings",
  libraryVisibility: "sectionOnly",
  ...over,
});

const wsState = (over = {}) => ({
  files: [],
  recLive: null,
  recSave: null,
  sttStatus: {},
  openFile: null,
  ...over,
});

const noop = () => {};
const actions = () => ({ viewFile: noop, startLiveRecording: noop });

const render = (s) =>
  renderToStaticMarkup(
    createElement(RecordingsPage, { s, a: actions(), info: { path: "/room" } }),
  );

const count = (hay, needle) => hay.split(needle).length - 1;

/* ---------- 1. it is no longer the sidebar ---------- */

test("the overview does not repeat the sidebar's capture verbs", () => {
  // RecordingsNav owns "New live recording" and "Voice note". Drawn here too,
  // neither copy is the authoritative one — which is the whole P2.
  const html = render(wsState({ files: [rec("alpha"), rec("beta")] }));
  assert.ok(!/Voice note/.test(html), "the voice-note verb belongs to the column");
  assert.ok(
    !/New live recording|Start a live recording/.test(html),
    "so does starting a capture, once the room has recordings",
  );
});

test("the overview does not repeat the sidebar's list of every recording", () => {
  // Six recordings, all written up: only the newest has any business in the
  // centre. The other five are the column's job, and drawing them here is the
  // regression this test exists to catch.
  const files = [
    rec("newest", { createdAt: "2026-08-06T10:00:00.000Z" }),
    rec("older-a", { createdAt: "2026-08-05T10:00:00.000Z" }),
    rec("older-b", { createdAt: "2026-08-04T10:00:00.000Z" }),
    rec("older-c", { createdAt: "2026-08-03T10:00:00.000Z" }),
    rec("older-d", { createdAt: "2026-08-02T10:00:00.000Z" }),
    rec("older-e", { createdAt: "2026-08-01T10:00:00.000Z" }),
  ];
  const html = render(wsState({ files }));
  assert.equal(count(html, "newest"), 1, "the way back in is drawn once");
  for (const id of ["older-a", "older-b", "older-c", "older-d", "older-e"]) {
    assert.equal(count(html, id), 0, `${id} is the sidebar's row, not the centre's`);
  }
});

test("a waiting recording IS named here — that is what the centre adds", () => {
  const files = [
    rec("written", { createdAt: "2026-08-06T10:00:00.000Z" }),
    rec("silent", { hasText: false, createdAt: "2026-08-05T10:00:00.000Z" }),
  ];
  const html = render(wsState({ files }));
  assert.ok(html.includes("silent"), "the one thing needing a look is named");
  assert.ok(html.includes(ATTENTION_WORD["not-yet"]));
});

test("the waiting list defers to the column past its cap, and says so", () => {
  const files = Array.from({ length: ATTENTION_SHOWN + 3 }, (_, i) =>
    rec(`w${i}`, { hasText: false, createdAt: `2026-08-0${(i % 9) + 1}T10:00:00.000Z` }),
  );
  const html = render(wsState({ files }));
  const shown = files.filter((f) => html.includes(f.id)).length;
  // The newest is also drawn as "Most recent", so it can appear in both
  // sections — the cap is about the waiting LIST, not the whole page.
  assert.ok(shown <= ATTENTION_SHOWN + 1, `drew ${shown} rows past a cap of ${ATTENTION_SHOWN}`);
  assert.ok(html.includes("3 more"), "the overflow is counted out loud, never cropped in silence");
});

test("the empty room offers exactly one way to begin", () => {
  const html = render(wsState({ files: [] }));
  assert.equal(count(html, "<button"), 1, "one call to action, not the sidebar's pair");
  assert.ok(html.includes("Start a live recording"));
  assert.ok(!/Voice note/.test(html), "the second verb would be the duplicated pair again");
});

test("an empty room states no figures at all", () => {
  // "0 recordings / 0 written up / 0 B" is three true statements that together
  // read as a report on a shelf nobody has. Withheld, like the circled count.
  const html = render(wsState({ files: [] }));
  assert.ok(!html.includes("What is here"));
  assert.ok(!html.includes("stored in this room"));
});

/* ---------- 2. what the room is doing right now ---------- */

test("a live capture is announced, with a way into it", () => {
  const html = render(
    wsState({
      files: [rec("meeting", { hasText: false })],
      recLive: { fileId: "meeting", status: "recording" },
    }),
  );
  assert.ok(html.includes("Recording now"));
  assert.ok(html.includes("Open the recording"), "a status with no way in is a dead panel");
});

test("the capture in flight is not ALSO listed as needing attention", () => {
  // It has no transcript because it is still being made. Listing it under
  // "waiting" asks the reader to act on work already under way.
  const html = render(
    wsState({
      files: [rec("meeting", { hasText: false })],
      recLive: { fileId: "meeting", status: "recording" },
    }),
  );
  assert.ok(!html.includes(ATTENTION_WORD["not-yet"]), html);
});

test("a save says the audio is already durable", () => {
  const html = render(
    wsState({
      files: [rec("meeting", { hasText: false })],
      recLive: { fileId: "meeting", status: "saving" },
      recSave: { stage: "transcribing", remaining: 4, startedAt: "2026-08-06T10:00:00.000Z" },
    }),
  );
  assert.ok(html.includes("Saving"));
  assert.ok(html.includes("Audio saved"), "'Saving' alone reads as 'not safe yet'");
  assert.ok(html.includes("4 to go"), "the drain's own counter, not a guess");
});

test("background transcription of imported media is reported", () => {
  const html = render(
    wsState({
      files: [rec("lecture", { hasText: false })],
      sttStatus: { "lecture.m4a": "processing" },
    }),
  );
  assert.ok(html.includes("Writing up"));
  assert.ok(
    !html.includes(ATTENTION_WORD["not-yet"]),
    "work in flight is not work waiting",
  );
});

/* ---------- 3. the capture phase, decided ---------- */

test("captureNow reads nothing as nothing", () => {
  assert.equal(captureNow(null, null), null);
  assert.equal(captureNow(null, { stage: "writing", remaining: 0, startedAt: "" }), null);
});

test("captureNow tells the three phases apart", () => {
  assert.equal(captureNow({ fileId: "f", status: "recording" }, null).phase, "recording");
  assert.equal(captureNow({ fileId: "f", status: "paused" }, null).phase, "paused");
  assert.equal(captureNow({ fileId: "f", status: "saving" }, null).phase, "saving");
});

test("either save signal alone means saving — the two arrive a beat apart", () => {
  // recSave lands before recLive flips (and the other way round on some paths).
  // Reading only one leaves a gap where the room looks like it is still just
  // recording in the middle of a save.
  const drain = { stage: "transcribing", remaining: 2, startedAt: "" };
  assert.equal(captureNow({ fileId: "f", status: "recording" }, drain).phase, "saving");
  assert.equal(captureNow({ fileId: "f", status: "saving" }, null).phase, "saving");
});

test("the phase always carries the file it is about", () => {
  assert.equal(captureNow({ fileId: "tape-7", status: "recording" }, null).fileId, "tape-7");
});

test("saveDetail names the stage the drain reported, and never claims more", () => {
  assert.match(saveDetail({ stage: "writing", remaining: 0, startedAt: "" }), /writing into the room/);
  assert.match(saveDetail({ stage: "transcribing", remaining: 3, startedAt: "" }), /3 to go/);
  // remaining 0 while still "transcribing": there is no count to state, so the
  // sentence states none rather than "0 to go".
  assert.ok(!/0 to go/.test(saveDetail({ stage: "transcribing", remaining: 0, startedAt: "" })));
  assert.match(saveDetail(null), /Audio saved/);
});

test("every capture phase has a sentence, and only saving reads the drain", () => {
  for (const phase of ["recording", "paused", "saving"]) {
    assert.ok(captureDetail(phase, null).length > 0, `${phase} has nothing to say`);
  }
  const drain = { stage: "writing", remaining: 0, startedAt: "" };
  assert.equal(captureDetail("saving", drain), saveDetail(drain));
  assert.notEqual(captureDetail("recording", drain), saveDetail(drain));
});

/* ---------- 4. what counts as waiting on a transcript ---------- */

test("a transcribed recording is never waiting", () => {
  assert.equal(attentionReason(rec("a"), undefined, null), null);
});

test("the durable signal is hasText — a restart forgets every stt event", () => {
  // sttStatus is filled by events and is empty after a relaunch, which is
  // exactly when someone comes back to ask what happened. Without hasText as
  // the source, the list would be empty every morning.
  assert.equal(attentionReason(rec("a", { hasText: false }), undefined, null), "not-yet");
});

test("the session's stage supplies the REASON when it has one", () => {
  const f = rec("a", { hasText: false });
  assert.equal(attentionReason(f, "model-missing", null), "model-missing");
  assert.equal(attentionReason(f, "failed: unsupported container", null), "failed");
  assert.equal(attentionReason(f, "none", null), "no-speech");
});

test("work in flight is excluded, both kinds of it", () => {
  const f = rec("a", { hasText: false });
  assert.equal(attentionReason(f, "processing", null), null, "being decoded now");
  assert.equal(attentionReason(f, undefined, "a"), null, "being captured or saved now");
});

test("needsAttention puts the worst reason first, then the newest", () => {
  const files = [
    rec("plain", { hasText: false, createdAt: "2026-08-01T00:00:00.000Z" }),
    rec("broken", { hasText: false, createdAt: "2026-08-02T00:00:00.000Z" }),
    rec("nomodel", { hasText: false, createdAt: "2026-08-03T00:00:00.000Z" }),
    rec("quiet", { hasText: false, createdAt: "2026-08-04T00:00:00.000Z" }),
    rec("newer-plain", { hasText: false, createdAt: "2026-08-05T00:00:00.000Z" }),
  ];
  const got = needsAttention(files, {
    "broken.m4a": "failed: could not decode",
    "nomodel.m4a": "model-missing",
    "quiet.m4a": "none",
  }, null);
  assert.deepEqual(
    got.map((w) => w.file.id),
    ["nomodel", "broken", "quiet", "newer-plain", "plain"],
  );
});

test("a failure carries the backend's own words, and nothing else invents any", () => {
  const files = [
    rec("broken", { hasText: false }),
    rec("plain", { hasText: false }),
  ];
  const got = needsAttention(files, { "broken.m4a": "failed: unsupported container" }, null);
  const broken = got.find((w) => w.file.id === "broken");
  assert.equal(broken.detail, "unsupported container");
  assert.equal(got.find((w) => w.file.id === "plain").detail, "");
});

test("failureDetail only speaks for a failure", () => {
  assert.equal(failureDetail("failed: no decoder"), "no decoder");
  assert.equal(failureDetail("failed:"), "");
  assert.equal(failureDetail("none"), "");
  assert.equal(failureDetail(undefined), "");
});

test("every reason has a word and a line of guidance", () => {
  for (const reason of ["model-missing", "failed", "no-speech", "not-yet"]) {
    assert.ok(ATTENTION_WORD[reason], `${reason} has no word`);
    assert.ok(ATTENTION_COPY[reason], `${reason} has no guidance`);
  }
});

test("transcribingNow keys on the file NAME, because stt-progress carries no id", () => {
  const files = [rec("a"), rec("b")];
  assert.deepEqual(
    transcribingNow(files, { "a.m4a": "processing", "b.m4a": "done" }).map((f) => f.id),
    ["a"],
  );
  assert.deepEqual(transcribingNow(files, { a: "processing" }).map((f) => f.id), []);
});

/* ---------- 5. the tally, and how it is phrased ---------- */

test("the tally counts and sums what the file list holds", () => {
  const t = shelfTally([
    rec("a", { sizeBytes: 1000 }),
    rec("b", { sizeBytes: 2000, hasText: false }),
    rec("c", { sizeBytes: 3000 }),
  ]);
  assert.deepEqual(t, { count: 3, transcribed: 2, bytes: 6000 });
});

test("an empty shelf tallies to zeroes, not to NaN", () => {
  assert.deepEqual(shelfTally([]), { count: 0, transcribed: 0, bytes: 0 });
});

test("countLabel is singular for one", () => {
  assert.equal(countLabel(1), "recording");
  assert.equal(countLabel(0), "recordings");
  assert.equal(countLabel(2), "recordings");
});

test("the transcribed label states the ratio so nobody has to subtract", () => {
  assert.match(transcribedPhrase({ count: 12, transcribed: 9, bytes: 0 }), /of 12/);
  assert.match(transcribedPhrase({ count: 12, transcribed: 12, bytes: 0 }), /all of them/);
  assert.match(transcribedPhrase({ count: 12, transcribed: 0, bytes: 0 }), /none of 12/);
});

test("the rendered figures are the tally's, digit for digit", () => {
  const files = [
    rec("a", { sizeBytes: 1024 }),
    rec("b", { sizeBytes: 1024, hasText: false }),
    rec("c", { sizeBytes: 1024, hasText: false }),
  ];
  const html = render(wsState({ files }));
  assert.ok(html.includes(">3<"), "the count");
  assert.ok(html.includes(">1<"), "how many are written up");
  assert.ok(html.includes("3.0 KB"), "the summed bytes, through the app's one formatter");
});

test("no length is claimed anywhere — the file list carries no duration", () => {
  // The standing honesty rule for this page: a total in minutes could only be
  // guessed from byte counts, and a guess is indistinguishable from a fact once
  // it is on screen. (A card's `formatWhen` date carries a clock time, which is
  // a recorded fact and not a length — so the figures row is checked for a
  // colon separately from the page-wide vocabulary check.)
  const html = render(wsState({ files: [rec("a"), rec("b", { hasText: false })] }));
  assert.ok(!/\b(minutes?|hours?|duration|length|long)\b/i.test(html), html);
  const figs = html.slice(
    html.indexOf('<div class="rec-over-figs">'),
    html.indexOf('<div class="rec-home-shelf-head"><span class="group-heading">Most recent'),
  );
  assert.ok(figs.includes("rec-over-fig"), "the figures row must be in the slice");
  assert.ok(!figs.includes(":"), `a mm:ss total would be a guess: ${figs}`);
});

/* ---------- 6. one status word per recording, decided once ---------- */

test("a card never contradicts the live panel about the same recording", () => {
  // The first cut of this page read `hasText` on the card and the capture
  // state in the panel, so the very recording announced as "Writing up" sat
  // under a chip reading "No transcript yet".
  const f = rec("lecture", { hasText: false });
  assert.equal(shelfChip(f, null, "processing").word, "Writing up");
  const now = captureNow({ fileId: "lecture", status: "recording" }, null);
  assert.equal(shelfChip(f, now, undefined).word, "Recording now");
});

test("the loud marker tape is spent only on a capture that is running", () => {
  const f = rec("a", { hasText: false });
  const running = captureNow({ fileId: "a", status: "recording" }, null);
  const paused = captureNow({ fileId: "a", status: "paused" }, null);
  const saving = captureNow({ fileId: "a", status: "saving" }, null);
  assert.equal(shelfChip(f, running, undefined).loud, true);
  assert.equal(shelfChip(f, paused, undefined).loud, false);
  assert.equal(shelfChip(f, saving, undefined).loud, false);
  assert.equal(shelfChip(f, null, undefined).loud, false);
  assert.equal(shelfChip(rec("a"), null, undefined).loud, false);
});

test("the capture in flight only claims the file it is actually about", () => {
  const now = captureNow({ fileId: "other", status: "recording" }, null);
  assert.equal(shelfChip(rec("a"), now, undefined).word, "Transcribed");
});

test("every chip carries a word — colour is never the only signal", () => {
  const cases = [
    shelfChip(rec("a"), null, undefined),
    shelfChip(rec("a", { hasText: false }), null, undefined),
    shelfChip(rec("a", { hasText: false }), null, "processing"),
    shelfChip(rec("a"), captureNow({ fileId: "a", status: "paused" }, null), undefined),
  ];
  for (const c of cases) {
    assert.ok(c.word.length > 0, JSON.stringify(c));
    assert.ok(c.mark.startsWith("nb-sem-"), JSON.stringify(c));
  }
});

/* ---------- 7. the page does not repeat ITSELF either ---------- */

test("the newest recording is drawn once, not once per section", () => {
  // It is both the newest AND the one waiting on a transcript. Two cards for
  // one file is the same fault as repeating the sidebar, one scale down — and
  // the waiting card is already a way into it, so nothing is lost.
  const html = render(wsState({ files: [rec("only", { hasText: false })] }));
  assert.equal(count(html, ">only<"), 1);
  assert.ok(html.includes("Waiting on a transcript"));
  assert.ok(!html.includes("Most recent"), "the second section would draw it again");
});

test("the newest recording is drawn once when it is the live capture", () => {
  const html = render(
    wsState({
      files: [rec("meeting", { hasText: false })],
      recLive: { fileId: "meeting", status: "recording" },
    }),
  );
  assert.equal(count(html, ">meeting<"), 1, "the live panel already names it");
});

test("newestAlreadyOnPage answers for both sections that can claim it", () => {
  const waitingFor = (id) => [{ file: rec(id), reason: "not-yet", detail: "" }];
  const now = captureNow({ fileId: "x", status: "recording" }, null);
  assert.equal(newestAlreadyOnPage("x", now, []), true);
  assert.equal(newestAlreadyOnPage("x", null, waitingFor("x")), true);
  assert.equal(newestAlreadyOnPage("x", null, waitingFor("y")), false);
  assert.equal(newestAlreadyOnPage("x", null, []), false);
});

test("Most recent IS drawn when nothing else has claimed the newest", () => {
  const html = render(
    wsState({
      files: [
        rec("fresh", { createdAt: "2026-08-09T10:00:00.000Z" }),
        rec("stale", { hasText: false, createdAt: "2026-08-01T10:00:00.000Z" }),
      ],
    }),
  );
  assert.ok(html.includes("Most recent"));
  assert.equal(count(html, ">fresh<"), 1);
});
