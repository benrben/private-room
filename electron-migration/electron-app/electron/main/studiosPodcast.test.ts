/**
 * Tests for `studiosPodcast.ts` — the port of
 * `src-tauri/src/commands/studios/podcast.rs`.
 *
 * `podcast_html_points_at_the_voices_panel_and_names_its_speakers` and
 * `the_page_prints_each_speaker_once_not_twice` port `podcast.rs`'s own
 * `#[cfg(test)] mod tests` cases verbatim (same fixtures, same assertions).
 * `the_podcast_studio_is_the_only_structured_first_artifact` ports the
 * cross-file half of that test that `mindmapSpec` makes checkable
 * (`flashcards_spec` has no Electron port yet, so that half of the original
 * Rust assertion has no TS counterpart here). `fillTemplate` gets its own
 * direct coverage porting `studios.rs`'s two `fill_template` unit tests, same
 * as `studiosMindmap.test.ts` — that module has no Electron port of its own
 * (see this file's own module doc).
 *
 * `storePodcast` gets a REAL FIXTURE ROOM, unlike `studiosMindmap.ts`'s pure
 * functions: it is genuinely real end-to-end here (see this file's module
 * doc), reading/writing the `podcasts` table through `db-host/podcasts.ts`,
 * so its own tests open a real `.roomai` file through `createRoom` — this
 * repo's established convention (`db-host/podcasts.test.ts`,
 * `db-host/story.test.ts`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { fileByExactName, getFileBytes, insertFile } from "./db-host/files.js";
import { createCancelState } from "./cancel.js";
import { runStudio } from "./studiosCmds.js";
import { getSetting, setSetting } from "./db-host/settings.js";
import { getPodcast } from "./db-host/podcasts.js";
import { mindmapSpec } from "./studiosMindmap.js";
import { flashcardsSpec } from "./studiosFlashcards.js";
import {
  defaultVoiceIds,
  fallbackPodcast,
  generatePodcastScript,
  PODCAST_TEMPLATE,
  podcastSpec,
  renderPodcastHtml,
  RUN_STUDIO_NOT_IMPLEMENTED,
  RUN_STUDIO_PIPELINE_GAP,
  runStudioNotImplemented,
  storePodcast,
  STUDIO_PODCAST_PROMPT,
  type PodcastTurn,
  type RunStudioFn,
  type StudioSpec,
} from "./studiosPodcast.js";
import type { FileMeta } from "./db-host/files.js";

// `fillTemplate` (studios.rs's own small pure helper) is NOT exported from
// studiosPodcast.ts — private, per that file's own doc — so unlike
// `studiosMindmap.test.ts`'s direct unit tests for its copy, this file
// exercises it only indirectly through `renderPodcastHtml` below (the
// `__NOTEBOOK__`/`__TITLE__`/`__ROWS__` slot-filling tests in that describe
// block ARE fillTemplate's coverage here).

let tmpDir: string;
let openDb: Database.Database | null = null;

afterEach(() => {
  openDb?.close();
  openDb = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "studios-podcast-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  openDb = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return openDb;
}

function turn(speaker: string, line: string): PodcastTurn {
  return { speaker, line };
}

// ============================================================================
// renderPodcastHtml — podcast.rs's own test, ported verbatim, plus more
// ============================================================================

describe("renderPodcastHtml", () => {
  it("points at the Voices panel and names its speakers", () => {
    // The page used to promise "audio narration is coming in a later
    // version". It has arrived, so the note now says where the button is — a
    // generated page that keeps advertising a missing feature is a lie the
    // app prints for the user itself.
    const turns = [turn("Ada", "Welcome in."), turn("Bo", "Glad to be here.")];
    const html = renderPodcastHtml("Episode 1", turns);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html, "the note names the panel that records it").toContain("Voices");
    expect(html, "the page must not still promise audio as a future feature").not.toContain("later version");
    expect(html).toContain("Ada");
    expect(html).toContain("Bo");
    // Second distinct speaker lands on the "b" side.
    expect(html).toContain("turn b");
  });

  it("puts the FIRST distinct speaker on side a, regardless of who speaks first next time", () => {
    const turns = [turn("Bo", "Hi."), turn("Ada", "Hello."), turn("Bo", "Again.")];
    const html = renderPodcastHtml("Ep", turns);
    const boAt = html.indexOf('<div class="turn a">');
    const adaAt = html.indexOf('<div class="turn b">');
    expect(boAt).toBeGreaterThan(-1);
    expect(adaAt).toBeGreaterThan(-1);
  });

  it("escapes speaker names and lines — a model-authored turn is never live HTML", () => {
    const turns = [turn('<img src=x onerror=alert(1)>', 'he said "hi" & left')];
    const html = renderPodcastHtml("Ep", turns);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("he said &quot;hi&quot; &amp; left");
  });

  it("fills __NOTEBOOK__/__TITLE__/__ROWS__ into PODCAST_TEMPLATE with no leftover slots", () => {
    const html = renderPodcastHtml("Weekly Sync", [turn("Ada", "Hi.")]);
    expect(html).not.toContain("__NOTEBOOK__");
    expect(html).not.toContain("__TITLE__");
    expect(html).not.toContain("__ROWS__");
    expect(html).toContain("<title>Weekly Sync — Podcast script</title>");
    expect(html).toContain("<h1>Weekly Sync</h1>");
    // The notebook's design tokens landed for real, not as a placeholder.
    expect(html).toContain(":root{");
  });

  it("PODCAST_TEMPLATE itself declares exactly the three slots renderPodcastHtml fills", () => {
    expect(PODCAST_TEMPLATE).toContain("__NOTEBOOK__");
    expect(PODCAST_TEMPLATE).toContain("__TITLE__");
    expect(PODCAST_TEMPLATE).toContain("__ROWS__");
  });
});

// ============================================================================
// fallbackPodcast — parses the model's structured JSON
// ============================================================================

describe("fallbackPodcast", () => {
  it("the page prints each speaker once, not twice", () => {
    // The page has a margin column for the speaker, so a name left inside the
    // line prints it twice — "Alex" beside "Alex: welcome in". This is the
    // same defect as the host reading their own name aloud, on the surface
    // the user sees first.
    const raw = JSON.stringify({
      title: "Ep",
      hosts: [{ name: "Alex" }, { name: "Jordan" }],
      turns: [
        { speaker: "Alex", line: "Alex: welcome in" },
        { speaker: "Jordan", line: "Jordan: glad to be here" },
      ],
    });
    const html = fallbackPodcast(raw, "Ep");
    expect(html, "the speaker label must not survive into the line").not.toContain("Alex: welcome in");
    expect(html, "the spoken words remain").toContain(">welcome in<");
    expect(html, "…and the name still labels the turn").toContain(">Alex<");

    // Ordinary prose keeps its colon.
    const prose = JSON.stringify({
      title: "Ep",
      hosts: [{ name: "Alex" }],
      turns: [{ speaker: "Alex", line: "Here's the thing: it works" }],
    });
    expect(fallbackPodcast(prose, "Ep")).toContain("Here's the thing: it works");
  });

  it("defaults the title to the trimmed scope label when the model omits it", () => {
    const raw = JSON.stringify({ turns: [{ speaker: "Ada", line: "Hi." }] });
    const html = fallbackPodcast(raw, "  Scope Label  ");
    expect(html).toContain("<h1>Scope Label</h1>");
  });

  it("defaults the title when the model sent an empty string", () => {
    const raw = JSON.stringify({ title: "", turns: [{ speaker: "Ada", line: "Hi." }] });
    const html = fallbackPodcast(raw, "Scope Label");
    expect(html).toContain("<h1>Scope Label</h1>");
  });

  it("a turn with no speaker falls back to \"Host\"", () => {
    const raw = JSON.stringify({ title: "Ep", turns: [{ speaker: "", line: "Anyone home?" }] });
    const html = fallbackPodcast(raw, "Ep");
    expect(html).toContain(">Host<");
  });

  it("drops a turn whose line strips to nothing (a label with no speech)", () => {
    const raw = JSON.stringify({
      title: "Ep",
      turns: [
        { speaker: "Alex", line: "Alex:" }, // strips to "" -> dropped
        { speaker: "Alex", line: "Kept." },
      ],
    });
    const html = fallbackPodcast(raw, "Ep");
    expect(html).toContain("Kept.");
    expect(html.match(/class="turn /g)?.length).toBe(1);
  });

  it("throws when the model returned no usable turns", () => {
    const raw = JSON.stringify({ title: "Ep", turns: [] });
    expect(() => fallbackPodcast(raw, "Ep")).toThrow("The model didn't return a usable script — try a different file.");
  });

  it("throws the same way on a non-JSON reply", () => {
    expect(() => fallbackPodcast("sorry, I can't do that", "Ep")).toThrow(
      "The model didn't return a usable script — try a different file."
    );
  });
});

// ============================================================================
// podcastSpec — the artifact spec, field for field against podcast.rs
// ============================================================================

describe("podcastSpec", () => {
  const spec: StudioSpec = podcastSpec();

  it("matches STUDIO_PODCAST_PROMPT for its default instruction", () => {
    expect(spec.defaultPrompt).toBe(STUDIO_PODCAST_PROMPT);
    expect(STUDIO_PODCAST_PROMPT).toBe(
      "Write a two-host podcast script that discusses the key points in a natural back-and-forth."
    );
  });

  it("carries the exact page_role prose from podcast.rs", () => {
    expect(spec.pageRole).toBe(
      "You are a front-end developer building a podcast transcript page for a warm, two-host " +
        "conversation that explains the material. Lay every turn out as its speaker's name beside " +
        "what they said, keep the two voices easy to tell apart by name. Base every line only on the " +
        "provided material."
    );
  });

  it("carries the exact working label, fallback system/intro, and filename prefix", () => {
    expect(spec.workingLabel).toBe("Writing the conversation");
    expect(spec.fallbackStep).toBeNull();
    expect(spec.fallbackSystem).toBe(
      "You write a short two-host podcast script that explains material in a warm, conversational " +
        "back-and-forth. Name the two hosts in `hosts`, then use those EXACT names as the speaker of " +
        "every turn — never a variation, a nickname or a title. Each turn is what one host actually " +
        "says out loud, so write it to be READ ALOUD: no stage directions, no markdown, no bracketed " +
        "asides, and NEVER begin a line with the speaker's own name — `line` holds only the spoken " +
        'words, never "Ada:". Keep each turn to a couple of sentences and alternate between the ' +
        "hosts. Base everything on the provided text."
    );
    expect(spec.fallbackIntro).toBe("Base it only on this material about");
    expect(spec.filenamePrefix).toBe("Podcast script");
  });

  it("uses fallback temperature 0.5 and renders through fallbackPodcast itself", () => {
    expect(spec.fallbackTemp).toBe(0.5);
    expect(spec.render).toBe(fallbackPodcast);
  });

  it("declares the fallback schema podcast.rs's serde_json::json! literal describes", () => {
    expect(spec.fallbackSchema).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        hosts: {
          type: "array",
          description: "The two recurring hosts, exactly as they are named in every turn",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              persona: { type: "string" },
            },
            required: ["name"],
          },
        },
        turns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              speaker: { type: "string", description: "Which host is talking — the name only" },
              line: {
                type: "string",
                description: 'Only the words this host speaks. Do NOT prefix it with their name — no "Ada:"',
              },
            },
            required: ["speaker", "line"],
          },
        },
      },
      required: ["title", "hosts", "turns"],
    });
  });

  it("is the only structured-first artifact (podcast.rs's own cross-file test, ported in full)", () => {
    // The inversion is the podcast's alone: its turns must survive as data
    // because voices are assigned per speaker. Flashcards and mind maps are
    // pages, and nothing reads their parts back. All three siblings now have
    // Electron ports (studiosFlashcards.ts / studiosMindmap.ts, landed
    // alongside this batch), so — unlike an earlier draft of this test — the
    // full three-way Rust assertion is checkable here, not just the mindmap
    // half of it.
    expect(podcastSpec().structuredFirst).toBe(true);
    expect(podcastSpec().afterSave).toBeDefined();
    expect(flashcardsSpec().structuredFirst).toBe(false);
    expect(mindmapSpec().structuredFirst).toBe(false);
    // The schema asks for the cast explicitly — the join key every voice
    // lookup depends on.
    expect((podcastSpec().fallbackSchema.properties as Record<string, unknown>).hosts).toBeDefined();
  });

  it("is a FACTORY — two calls return independent objects, not aliases", () => {
    const a = podcastSpec();
    const b = podcastSpec();
    expect(a).not.toBe(b);
    expect(a.fallbackSchema).not.toBe(b.fallbackSchema);
  });
});

// ============================================================================
// defaultVoiceIds — speech_cmds.rs's cached_voice_ids, read through get_setting
// ============================================================================

describe("defaultVoiceIds", () => {
  it("is empty when the room has never opened Settings -> Spoken voice", () => {
    const db = freshRoom();
    expect(defaultVoiceIds(db)).toEqual([]);
  });

  it("leads with the room's own chosen voice", () => {
    const db = freshRoom();
    setSetting(db, "voice_neural_id", "en-US-AriaNeural");
    expect(defaultVoiceIds(db)).toEqual(["en-US-AriaNeural"]);
  });

  it("appends the cached catalog after the chosen voice, deduped", () => {
    const db = freshRoom();
    setSetting(db, "voice_neural_id", "v-chosen");
    setSetting(db, "voice_catalog_ids", "v-chosen, v2 ,v3,,  v4  ");
    expect(defaultVoiceIds(db)).toEqual(["v-chosen", "v2", "v3", "v4"]);
  });

  it("uses only the cached catalog when no voice has been explicitly chosen", () => {
    const db = freshRoom();
    setSetting(db, "voice_catalog_ids", "v1,v2");
    expect(defaultVoiceIds(db)).toEqual(["v1", "v2"]);
  });
});

// ============================================================================
// storePodcast — the after_save hook, real end-to-end against a fixture room
// ============================================================================

describe("storePodcast", () => {
  it("persists the turns and a cast seeded from the room's own voices", () => {
    const db = freshRoom();
    const file = insertFile(db, "Podcast script - Ep 1.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    setSetting(db, "voice_neural_id", "v-chosen");

    const raw = JSON.stringify({
      title: "Episode 1",
      hosts: [{ name: "Ada" }, { name: "Bo" }],
      turns: [
        { speaker: "Ada", line: "Ada: welcome in" },
        { speaker: "Bo", line: "Bo: glad to be here" },
      ],
    });
    storePodcast(db, file.id, raw);

    const got = getPodcast(db, file.id);
    expect(got?.title).toBe("Episode 1");
    // The speaker label was stripped on the way in.
    expect(got?.turns.map((t) => t.line)).toEqual(["welcome in", "glad to be here"]);
    expect(got?.turns.map((t) => t.speaker)).toEqual(["Ada", "Bo"]);
    // The cast's first host got the room's own chosen voice.
    expect(got?.cast.map((h) => h.name)).toEqual(["Ada", "Bo"]);
    expect(got?.cast[0]?.voice).toBe("v-chosen");
  });

  it("titles an untitled script \"Podcast\", not the scope label (the after_save hook has no label)", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    const raw = JSON.stringify({ turns: [{ speaker: "Ada", line: "Hi." }] });
    storePodcast(db, file.id, raw);
    expect(getPodcast(db, file.id)?.title).toBe("Podcast");
  });

  it("a turn with no speaker falls back to \"Host\"", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    const raw = JSON.stringify({ title: "Ep", turns: [{ speaker: "", line: "Anyone home?" }] });
    storePodcast(db, file.id, raw);
    expect(getPodcast(db, file.id)?.turns[0]?.speaker).toBe("Host");
  });

  it("the declared hosts roster leads the cast even when a host never got a line", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    const raw = JSON.stringify({
      title: "Ep",
      hosts: [{ name: "Ada" }, { name: "Silent Sam" }],
      turns: [{ speaker: "Ada", line: "Just me today." }],
    });
    storePodcast(db, file.id, raw);
    const got = getPodcast(db, file.id);
    // The declared roster is seeded into the cast ordering even though
    // "Silent Sam" has no turns of their own.
    expect(got?.cast.map((h) => h.name)).toEqual(["Ada", "Silent Sam"]);
    expect(got?.turns).toEqual([{ speaker: "Ada", line: "Just me today." }]);
  });

  it("throws when every turn strips to nothing usable", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    const raw = JSON.stringify({ title: "Ep", turns: [{ speaker: "Alex", line: "Alex:" }] });
    expect(() => storePodcast(db, file.id, raw)).toThrow("the script had no usable turns");
  });

  it("throws on a non-JSON reply the same way", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    expect(() => storePodcast(db, file.id, "not json")).toThrow("the script had no usable turns");
  });

  it("re-running over the same file id REPLACES the script (ON CONFLICT), not duplicates it", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    storePodcast(db, file.id, JSON.stringify({ title: "First", turns: [{ speaker: "Ada", line: "v1" }] }));
    storePodcast(db, file.id, JSON.stringify({ title: "Second", turns: [{ speaker: "Ada", line: "v2" }] }));
    const got = getPodcast(db, file.id);
    expect(got?.title).toBe("Second");
    expect(got?.turns).toEqual([{ speaker: "Ada", line: "v2" }]);
  });
});

// ============================================================================
// generatePodcastScript — the Tauri command's shape, as an injectable seam
// ============================================================================

describe("generatePodcastScript", () => {
  it("refuses honestly when no runStudio pipeline is wired", async () => {
    await expect(generatePodcastScript(null, null, null, null)).rejects.toThrow(RUN_STUDIO_NOT_IMPLEMENTED);
  });

  it("the default seam's rejection matches runStudioNotImplemented directly", async () => {
    await expect(runStudioNotImplemented(podcastSpec(), null, null, null, null, null)).rejects.toThrow(
      RUN_STUDIO_NOT_IMPLEMENTED
    );
  });

  it("the exported gap message names both what is real and what is missing", () => {
    expect(RUN_STUDIO_PIPELINE_GAP).toContain("studios.rs's shared run_studio pipeline");
    expect(RUN_STUDIO_PIPELINE_GAP).toContain("IS ported and tested");
    expect(RUN_STUDIO_NOT_IMPLEMENTED).toBe(`NOT_IMPLEMENTED: ${RUN_STUDIO_PIPELINE_GAP}`);
  });

  it("calls an injected runStudio with podcast_spec(), the given args, and parentRun always null", async () => {
    const fakeMeta: FileMeta = {
      id: "file-1",
      name: "Podcast script - Q3 recap.html",
      mimeType: "text/html",
      sizeBytes: 42,
      source: "agent",
      hasText: true,
      createdAt: "2026-08-22T00:00:00.000Z",
      folderId: null,
      partiallyIndexed: false,
      originUrl: null,
      aiSummary: null,
      originDestination: "library",
      libraryVisibility: "linked",
    };
    const calls: unknown[][] = [];
    const fakeRunStudio: RunStudioFn = async (spec, scope, instructions, refs, opId, parentRun) => {
      calls.push([spec, scope, instructions, refs, opId, parentRun]);
      return fakeMeta;
    };

    const meta = await generatePodcastScript("file-abc", "Focus on Q3", ["file-1", "file-2"], "op-9", fakeRunStudio);

    expect(meta).toBe(fakeMeta);
    expect(calls).toHaveLength(1);
    const [spec, scope, instructions, refs, opId, parentRun] = calls[0]!;
    expect((spec as StudioSpec).filenamePrefix).toBe("Podcast script");
    expect(scope).toBe("file-abc");
    expect(instructions).toBe("Focus on Q3");
    expect(refs).toEqual(["file-1", "file-2"]);
    expect(opId).toBe("op-9");
    // Owner replacement #3: a Studio button in the UI is its own root,
    // nobody's child — generate_podcast_script hard-codes None/null here
    // always. An agent-triggered build must call runStudio directly with its
    // own parentRun instead of going through this wrapper (see this file's
    // module doc).
    expect(parentRun).toBeNull();
  });
});

// ============================================================================
// podcastSpec through the REAL shared pipeline — the structured-first
// inversion and the after_save hook, end to end against a real room
// ============================================================================

describe("podcastSpec drives studiosCmds.ts's real runStudio pipeline", () => {
  /** Records every schema the pipeline asks the model for, so the test can
   * assert what was NEVER asked as well as what was. */
  function recordingModel(seen: string[]): never {
    return (async (_m: string, _msgs: unknown, _t: unknown, _k: unknown, schema: unknown) => {
      const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
      seen.push(Object.keys(props).sort().join(","));
      if ("html" in props) {
        // A perfectly GOOD page — if the pipeline ever asks for one, it will
        // happily use it, and the assertion below is what catches that.
        return JSON.stringify({ html: `<!doctype html><html><body>${"x".repeat(80)}</body></html>` });
      }
      return JSON.stringify({
        title: "On Clean Code",
        hosts: [{ name: "Ada" }, { name: "Bo" }],
        turns: [
          { speaker: "Ada", line: "Ada: welcome in." },
          { speaker: "bo ", line: "Glad to be here." },
        ],
      });
    }) as never;
  }

  it("never asks the model to author HTML, and persists the cast/turns via after_save", async () => {
    // `structured_first` is the whole point of this artifact: turns that only
    // exist as markup cannot be spoken. A pipeline that asked for HTML first
    // would produce an unrecordable episode on the happy path — and the model
    // fake above returns a page GOOD enough to be accepted, so the only thing
    // stopping it is the spec's own inversion.
    const db = freshRoom();
    const roomPath = "podcast-e2e.roomai";
    insertFile(db, "src.md", "text/markdown", Buffer.from("m"), "Material about clean code.", "upload");
    const seen: string[] = [];
    const meta: FileMeta = await runStudio(
      {
        rooms: { current: () => ({ db, path: roomPath, name: "Test Room" }) },
        cancelState: createCancelState(),
        listModels: async () => ["qwen3.5:4b"],
        chatStructured: recordingModel(seen),
      },
      podcastSpec(),
      null,
      null,
      null,
      null,
      null
    );

    expect(seen).toEqual(["hosts,title,turns"]);
    expect(seen).not.toContain("html");
    expect(meta.name).toBe("Podcast script - Test Room.html");

    // The page is the built-in transcript template, with the speaker label
    // stripped out of the line it was doubled into.
    const raw = getFileBytes(db, meta.id);
    expect(raw).not.toBeNull();
    const page = Buffer.from(raw!).toString("utf8");
    expect(page).toContain("<title>On Clean Code — Podcast script</title>");
    expect(page).toContain(">welcome in.<");
    expect(page).not.toContain("Ada: welcome in.");

    // …and the STRUCTURE outlived it: `after_save` wrote the podcasts row,
    // with every turn folded onto the cast's own spelling ("bo " -> "Bo").
    const stored = getPodcast(db, meta.id);
    expect(stored?.title).toBe("On Clean Code");
    expect(stored?.turns.map((t) => t.speaker)).toEqual(["Ada", "Bo"]);
    expect(stored?.cast.map((h) => h.name)).toEqual(["Ada", "Bo"]);
    expect(stored?.audioFileId).toBeNull();
  });

  it("refuses BEFORE writing anything when every turn strips to nothing", async () => {
    // `render` runs before the save, so its refusal must leave the room
    // untouched: never a transcript page with no transcript in it, and never
    // an `after_save` warning about extras for a page that does not exist.
    const db = freshRoom();
    insertFile(db, "src.md", "text/markdown", Buffer.from("m"), "Material.", "upload");
    const warnings: string[] = [];
    const meta: FileMeta = await runStudio(
      {
        rooms: { current: () => ({ db, path: "x.roomai", name: "Test Room" }) },
        cancelState: createCancelState(),
        listModels: async () => ["qwen3.5:4b"],
        log: { warn: ((event: string) => warnings.push(event)) as never },
        chatStructured: (async () =>
          // Every turn is nothing but its own speaker label, so every line
          // strips to "" and `fallbackPodcast` refuses.
          JSON.stringify({ title: "T", hosts: [], turns: [{ speaker: "Ada", line: "Ada:" }] })) as never,
      },
      podcastSpec(),
      null,
      null,
      null,
      null,
      null
    ).then(
      (m) => m,
      (e: Error) => e as unknown as FileMeta
    );

    expect(meta).toBeInstanceOf(Error);
    expect((meta as unknown as Error).message).toContain("didn't return a usable script");
    expect(warnings).toEqual([]);
    expect(fileByExactName(db, "Podcast script - Test Room.html")).toBeNull();
  });
});
