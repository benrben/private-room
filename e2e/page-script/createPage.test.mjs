/* The Create page's two load-bearing promises.
 *
 * 1. THE GATE. A model reaches the shelf only when a live catalog says it
 *    produces pixels. The failure this guards against is specific and cheap to
 *    reintroduce: matching on the slug. "image", "vision" and "flux" all appear
 *    in the ids of models that merely READ pictures, so a name test would put
 *    `qwen2.5vl` on the shelf, where picking it spends the user's money on a
 *    call that comes back with words.
 *
 * 2. THE WIRING. A rail area is four separate registrations plus a queue arm,
 *    and any one of them missing produces a different broken shape: a crash on
 *    `areaDef`, a missing breadcrumb, a page that never renders, or — the
 *    quiet one — a job that starts once and can never be resumed or pumped.
 *    None of those is a type error, so they are asserted here against the real
 *    sources, frontend and Rust alike. That is this repo's house style for
 *    cross-language invariants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../..");

const load = (rel) => {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
};
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const {
  visibleModels,
  selectedModel,
  tallies,
  emptyReason,
  emptyShelfLine,
  legalSeconds,
  takesFirstFrame,
} =
  await load("src/workspace/create/selectors.ts");

/** A model row shaped like `list_create_models` returns one. */
const model = (slug, over = {}) => ({
  model: `openrouter::${slug}`,
  slug,
  label: slug,
  engine: "openrouter",
  engineLabel: "OpenRouter",
  local: false,
  description: null,
  image: false,
  video: false,
  outputPrice: null,
  ...over,
});

const PAINTER = model("vendor/painter", { image: true });
const MOVER = model("vendor/seedance-2.0", { video: true });
const BOTH = model("vendor/both", { image: true, video: true });
// The trap: "image" in the name, reads pictures, cannot make one.
const READER = model("qwen/qwen-image-vision");

test("only models that MAKE pictures reach the images shelf", () => {
  const shelf = visibleModels([PAINTER, MOVER, READER], "image", "");
  assert.deepEqual(
    shelf.map((m) => m.slug),
    ["vendor/painter"],
  );
  // Stated as its own assertion because this is the whole point of the page:
  // a slug containing "image" is not permission to offer it.
  assert.ok(
    !shelf.some((m) => m.slug.includes("qwen-image")),
    "a model named …image… that only READS pictures must never be offered",
  );
});

test("only models that MAKE video reach the video shelf", () => {
  assert.deepEqual(
    visibleModels([PAINTER, MOVER, READER], "video", "").map((m) => m.slug),
    ["vendor/seedance-2.0"],
  );
});

test("a model that does both appears on both shelves", () => {
  // The catalog is allowed to say a model does two things; hiding half of that
  // would make the gallery disagree with the ledger's own counts.
  assert.equal(visibleModels([BOTH], "image", "").length, 1);
  assert.equal(visibleModels([BOTH], "video", "").length, 1);
});

test("the name filter never widens the gate", () => {
  // Searching for "image" must not surface the reader that the gate excluded.
  assert.deepEqual(
    visibleModels([PAINTER, READER], "image", "image").map((m) => m.slug),
    [],
  );
  assert.deepEqual(
    visibleModels([PAINTER, READER], "image", "painter").map((m) => m.slug),
    ["vendor/painter"],
  );
});

test("switching tabs never leaves the bench on a hidden model", () => {
  const videoShelf = visibleModels([PAINTER, MOVER], "video", "");
  // The picked model is an IMAGE model; the video tab must fall back rather
  // than compose for something the gallery is no longer showing.
  const picked = selectedModel(videoShelf, PAINTER.model);
  assert.equal(picked?.slug, "vendor/seedance-2.0");
  // Nothing on the shelf is an honest null, not a stale hold-over.
  assert.equal(selectedModel([], PAINTER.model), null);
});

test("the ledger's 'can't' figure is the sum of the reasons it lists", () => {
  // Two numbers for the same fact on one screen is the bug this prevents:
  // `scanned - models.length` would drift from the disclosure's own rows.
  const counts = tallies({
    models: [PAINTER, MOVER],
    scanned: 34,
    excluded: [
      { engineLabel: "OpenRouter", reason: "Text only.", count: 29, examples: [] },
      { engineLabel: "Claude Code", reason: "Vision in, no image out.", count: 1, examples: [] },
    ],
    anyProvider: true,
    error: null,
  });
  assert.deepEqual(counts, { image: 1, video: 1, cannot: 30, can: 2, scanned: 34 });
});

test("an empty shelf says which of the three things went wrong", () => {
  const base = { models: [], scanned: 0, excluded: [], anyProvider: false, error: null };
  assert.equal(emptyReason(null), "loading");
  assert.equal(emptyReason(base), "no-provider");
  assert.equal(emptyReason({ ...base, anyProvider: true, scanned: 9 }), "none-can-draw");
  assert.equal(emptyReason({ ...base, error: "offline" }), "error");
  // A stocked shelf owes no empty state at all.
  assert.equal(emptyReason({ ...base, models: [PAINTER] }), null);
});

test("an empty shelf never blames the catalogue for a filter miss", () => {
  // With a search term typed, "no model makes video" is a claim about the
  // catalogue that the catalogue never made — the shelf is empty because the
  // FILTER is narrow, and the two have different fixes.
  assert.match(emptyShelfLine("video", "seedance"), /Nothing matches/);
  assert.match(emptyShelfLine("image", "krea"), /Nothing matches/);
  // With no filter it points at the catalogue, NOT at what providers serve.
  // The old wording asserted that no provider offers a video model at all,
  // which was false and confidently so: it was written from the default
  // `/models` listing, which omits every media model. There are 21.
  assert.match(emptyShelfLine("video", ""), /catalogue reloads/);
  assert.match(emptyShelfLine("video", "   "), /catalogue reloads/);
  assert.doesNotMatch(emptyShelfLine("video", ""), /No connected provider/);
  assert.match(emptyShelfLine("image", ""), /catalogue reloads/);
});

/* ---------- the wiring, across both languages ---------- */

test("the create area is registered everywhere a rail area must be", () => {
  const types = read("src/workspace/types.ts");
  assert.match(types, /\|\s*"create"/, "missing from the WorkArea union");
  assert.match(types, /"create",/, "missing from WORK_AREAS (the runtime list)");

  // areaDef() THROWS for a union member with no AREAS row — a runtime crash,
  // not a type error, so the compiler cannot catch this one.
  assert.match(
    read("src/shell/ActivityRail.tsx"),
    /key:\s*"create"/,
    "missing from ActivityRail's AREAS — areaDef would throw",
  );
  assert.match(
    read("src/workspace/ViewerPane.tsx"),
    /area === "create"/,
    "ViewerPane has no branch, so the area would render the empty state",
  );
  assert.match(
    read("src/workspace/ViewerPane.tsx"),
    /create:\s*"Create"/,
    "missing from AREA_CRUMBS",
  );
});

test("the create job kind is dispatchable and resumable, not just startable", () => {
  // The quiet failure: a job that starts once, then can never be pumped off
  // the queue or resumed after a crash. Neither shows up as a type error.
  assert.match(
    read("src-tauri/src/commands/jobs/queue.rs"),
    /"create" => start_create_row/,
    "queue.rs has no dispatch arm — a queued generation could never start",
  );
  assert.match(
    read("src-tauri/src/commands/jobs.rs"),
    /\|\s*"create"/,
    "jobs.rs resume whitelist is missing 'create'",
  );
});

test("both create commands are registered with the host", () => {
  // The frontend calls these by name through `invoke`; an unregistered command
  // is a runtime rejection, which is exactly what the mock-coverage gate and
  // this assertion exist to catch early.
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /commands::list_create_models/);
  assert.match(lib, /commands::start_create_job/);
});

test("generation capability is its own question, separate from vision", () => {
  const caps = read("src-tauri/src/commands/capabilities.rs");
  assert.match(caps, /ImageGeneration/);
  assert.match(caps, /VideoGeneration/);
  // The catalog field the whole gate reads from.
  assert.match(
    read("src-tauri/src/commands/providers.rs"),
    /output_modalities/,
    "the OpenRouter parse must read output_modalities, not infer from the slug",
  );
});

/* ---------------------------------------------------------- what a model
   will actually accept. Read from the provider, never guessed — an illegal
   duration does not make a shorter clip, it makes a refusal, and on the
   models with a per-generation floor it can make a charge for nothing. */

const VEO = {
  ...PAINTER,
  model: "openrouter::google/veo-3.1",
  slug: "google/veo-3.1",
  image: false,
  video: true,
  limits: {
    durations: [4, 6, 8],
    resolutions: ["720p", "1080p", "4K"],
    aspectRatios: ["16:9", "9:16"],
    frameImages: ["first_frame", "last_frame"],
    maxReferences: null,
    generateAudio: true,
  },
};

const ALEPH = {
  ...VEO,
  model: "openrouter::runway/aleph-2",
  slug: "runway/aleph-2",
  limits: {
    durations: [],
    resolutions: [],
    aspectRatios: ["16:9"],
    frameImages: [],
    maxReferences: null,
    generateAudio: false,
  },
};

test("only the lengths a model publishes are ever offered", () => {
  assert.deepEqual(legalSeconds(VEO), [4, 6, 8]);
  // 5 is not on Veo's list — offering it would spend a call to be refused.
  assert.ok(!legalSeconds(VEO).includes(5));
});

test("an unpublished length list offers nothing rather than inventing one", () => {
  // Empty means "the provider declined to say", so the caller sends no
  // duration and the model's own default stands.
  assert.deepEqual(legalSeconds(ALEPH), []);
  assert.deepEqual(legalSeconds(null), []);
});

test("a model that takes no starting picture is not offered one", () => {
  // Runway Aleph 2 and Sora 2 Pro publish no frame slots. A picture attached
  // to them is silently ignored — the user pays and gets an unrelated clip.
  assert.equal(takesFirstFrame(VEO), true);
  // An EMPTY list is a published answer, not a missing one. Live, every video
  // model that accepts a frame lists its slots and the two that do not send
  // `supported_frame_images: null` — so empty means no.
  assert.equal(takesFirstFrame(ALEPH), false);
  // A model with NO ENTRY AT ALL is the genuinely unknown case, and stays
  // permissive: refusing a legal feature because the table failed to load is
  // the worse of the two errors.
  assert.equal(takesFirstFrame({ ...VEO, limits: null }), true);
  assert.equal(takesFirstFrame(null), true);
});
