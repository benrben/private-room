/**
 * Tests for `studiosFlashcards.ts` — the port of
 * `src-tauri/src/commands/studios/flashcards.rs`.
 *
 * The three `describe("renderFlashcardsHtml")` cases marked "Rust source"
 * port `flashcards.rs`'s own `#[cfg(test)] mod tests` verbatim — same
 * fixtures, same assertions, same reasons (see each test's own comment for
 * the defect it once caught). `fillTemplate` is NOT re-tested here: it is
 * `studiosCmds.ts`'s export (this file's own module doc explains why it is
 * imported rather than re-declared), and `studiosCmds.ts`'s own tests cover
 * it directly.
 *
 * `renderFlashcardsHtml`/`fallbackFlashcards`/`flashcardsSpec` need no
 * fixture room — pure functions over strings and already-parsed data.
 * `studioFlashcards`/`execStudioFlashcards`, by contrast, DO run against a
 * REAL fixture room (`createRoom`/`insertFile`, same convention
 * `docsHtml.test.ts` establishes): they drive `studiosCmds.ts`'s actual
 * `runStudio` pipeline end to end, through real DB reads
 * (`gatherScopeText`/`gatherFilesText`, `findFileLike`) and a real
 * `Artifact.commit`, faking only the two things that would otherwise reach a
 * real network — the model call (`RunStudioDeps.chatStructured`) and the
 * installed-model probe (`RunStudioDeps.listModels`).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import {
  EXEC_STUDIO_FLASHCARDS_GAP,
  execStudioFlashcards,
  fallbackFlashcards,
  flashcardsSpec,
  FLASHCARDS_TEMPLATE,
  renderFlashcardsHtml,
  resolveFlashcardsRefs,
  STUDIO_FLASHCARDS_PROMPT,
  studioFlashcards,
  type StudioCard,
} from "./studiosFlashcards.js";
import { createCancelState, type CancelState } from "./cancel.js";
import { NOTEBOOK_CSS } from "./docsHtml.js";
import { createRoom } from "./db-host/open.js";
import { getFileBytes, insertFile } from "./db-host/files.js";
import type { RoomHandle, RoomSource, RunStudioDeps, StudioSpec } from "./studiosCmds.js";
import type { SidecarChatMessage } from "./sidecar.js";
import type { StructuredOpts } from "./ollamaGenerate.js";

// ============================================================================
// fixture room + fake model calls — shared by the `studioFlashcards`/
// `execStudioFlashcards` end-to-end tests below
// ============================================================================

/** A minimal, real fixture room (real SQLCipher DB, real schema) — the same
 * `createRoom` convention `docsHtml.test.ts` establishes. Callers get the
 * `RoomHandle` `studiosCmds.ts`'s `RoomSource` needs (`db` + `path` + `name`),
 * plus a `dispose()` to clean up the temp directory. */
function openFixtureRoom(name = "Test Room"): RoomHandle & { dispose(): void } {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "studios-flashcards-"));
  const filePath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  const db = createRoom(filePath, "correct horse battery staple", name);
  return {
    db,
    path: filePath,
    name,
    dispose(): void {
      try {
        db.close();
      } catch {
        // best-effort
      }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function roomSourceOf(room: RoomHandle): RoomSource {
  return { current: () => room };
}

/** `schema.properties.html` exists — `generateStudioHtml`'s own schema shape
 * — vs. `flashcardsSpec().fallbackSchema`'s `properties.cards`. Used by the
 * fake `chatStructured` below to answer the HTML-authoring call differently
 * from the structured-fallback call without a second injected seam. */
function schemaWants(schema: unknown, key: string): boolean {
  if (typeof schema !== "object" || schema === null || !("properties" in schema)) {
    return false;
  }
  const props = (schema as { properties?: unknown }).properties;
  return typeof props === "object" && props !== null && key in props;
}

/** A fake `RunStudioDeps.chatStructured` that answers the two calls
 * `runStudioCore` can make: `generateStudioHtml`'s `{html}` schema and
 * `studioStructured`'s `{cards}` schema (`flashcardsSpec().fallbackSchema`).
 * `htmlAnswer: null` simulates a model that returned nothing usable as HTML
 * (too short / no HTML markers), which is what pushes `runStudioCore` onto
 * the fallback path — the real `cleanStudioHtml` decides that, not this fake. */
function fakeChatStructured(
  htmlAnswer: string | null,
  cardsAnswer: readonly StudioCard[]
): (
  model: string,
  messages: readonly SidecarChatMessage[],
  temperature: number | null,
  keepAlive: string,
  schema: unknown,
  opts?: StructuredOpts
) => Promise<string> {
  return async (_model, _messages, _temperature, _keepAlive, schema) => {
    if (schemaWants(schema, "html")) {
      return JSON.stringify({ html: htmlAnswer ?? "too short" });
    }
    return JSON.stringify({ cards: cardsAnswer });
  };
}

/** A `RunStudioDeps` over a real fixture room, with fake (never-network)
 * model calls — `listModels` resolves one installed local tag so
 * `resolveStructuredModel` (real, `studiosCmds.ts`) picks it via
 * `bestLocalDefault`, exactly as it would against a real Ollama. */
function fakeRunStudioDeps(
  room: RoomHandle,
  htmlAnswer: string | null,
  cardsAnswer: readonly StudioCard[],
  cancelState: CancelState = createCancelState()
): RunStudioDeps {
  return {
    rooms: roomSourceOf(room),
    cancelState,
    listModels: async () => ["qwen3.5:4b"],
    chatStructured: fakeChatStructured(htmlAnswer, cardsAnswer),
  };
}

// ============================================================================
// renderFlashcardsHtml — flashcards.rs's own tests, ported verbatim, plus more
// ============================================================================

describe("renderFlashcardsHtml", () => {
  it("Rust source: is static and script-safe, escaping model-authored card text", () => {
    // D5: the deck is one self-contained HTML doc built as STATIC markup —
    // no <script> at all (so it renders in WKWebView's sandbox), and any
    // markup in card text is HTML-escaped rather than injected.
    const cards: StudioCard[] = [{ q: "What is <b>this</b>?", a: "</script> injected", hint: "a hint" }];
    const html = renderFlashcardsHtml("My Deck", cards);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>My Deck — Flashcards</title>");
    // No script tag anywhere — the whole point of the static rewrite.
    expect(html).not.toContain("<script");
    // Card text is escaped, never live markup.
    expect(html).toContain("What is &lt;b&gt;this&lt;/b&gt;?");
    expect(html).toContain("&lt;/script&gt; injected");
    expect(html).not.toContain("</script> injected");
    expect(html).toContain("Hint: a hint");
    expect(html).toContain("1 card");
  });

  it("Rust source: a long card wraps inside its card instead of escaping it", () => {
    // The three layout rules a deck of real study material depends on. The
    // deck is a static page with no script and no external stylesheet, so
    // the only place this can be pinned is the markup it ships.
    const cards: StudioCard[] = [
      {
        q: "Explain https://example.com/a/very/long/unbreakable/path?with=query",
        a: "A long answer, several lines of it, more than a 12rem card can show at once.",
        hint: "",
      },
    ];
    const html = renderFlashcardsHtml("Deck", cards);

    // 1. The column floor must collapse below the page width — a bare
    //    `minmax(15rem,1fr)` lays out a 15rem column inside a narrower pane
    //    and the cards run off the right edge.
    expect(html).toContain("minmax(min(15rem,100%),1fr)");

    // 2. Overflow inside a CENTRED flex column starts above the scroll
    //    origin and cannot be scrolled back to, so the first lines of a long
    //    answer were unreachable. Auto margins centre without that.
    expect(html).not.toContain("justify-content:center");
    expect(html).toContain(".face>:first-child{margin-top:auto}");
    expect(html).toContain(".face>:last-child{margin-bottom:auto}");

    // 3. An unbreakable run (URL, formula) must wrap rather than push the
    //    text out of the card.
    expect(html).toContain("overflow-wrap:anywhere");
  });

  it("Rust source: a file named after a template slot does not corrupt the page", () => {
    // The title is substituted first; chained `.replace()` then filled the
    // slot the title itself spelled, dumping the whole deck into <title>.
    const cards: StudioCard[] = [{ q: "Q", a: "A", hint: "" }];
    const html = renderFlashcardsHtml("__CARDS__", cards);
    expect(html).toContain("<title>__CARDS__ — Flashcards</title>");
    const head = html.split("</title>")[0]!;
    expect(head).not.toContain("<label");
    // The deck lands in the deck, exactly once.
    expect(html.match(/class="card"/g)?.length).toBe(1);
  });

  it("renders the empty-deck placeholder rather than an empty grid", () => {
    const html = renderFlashcardsHtml("Empty Deck", []);
    expect(html).toContain('<p class="empty">No cards were generated.</p>');
    expect(html).toContain("0 cards");
  });

  it("pluralizes the card count correctly at the boundary", () => {
    const one = renderFlashcardsHtml("Deck", [{ q: "Q", a: "A", hint: "" }]);
    expect(one).toContain(">1 card ·");
    const two = renderFlashcardsHtml("Deck", [
      { q: "Q1", a: "A1", hint: "" },
      { q: "Q2", a: "A2", hint: "" },
    ]);
    expect(two).toContain(">2 cards ·");
  });

  it("omits the hint paragraph entirely when hint is blank or whitespace-only", () => {
    const html = renderFlashcardsHtml("Deck", [{ q: "Q", a: "A", hint: "   " }]);
    expect(html).not.toContain("Hint:");
  });

  it("numbers cards Q1, Q2, Q3... in order", () => {
    const html = renderFlashcardsHtml("Deck", [
      { q: "First", a: "A1", hint: "" },
      { q: "Second", a: "A2", hint: "" },
      { q: "Third", a: "A3", hint: "" },
    ]);
    const q1At = html.indexOf(">Q1<");
    const q2At = html.indexOf(">Q2<");
    const q3At = html.indexOf(">Q3<");
    expect(q1At).toBeGreaterThan(-1);
    expect(q2At).toBeGreaterThan(q1At);
    expect(q3At).toBeGreaterThan(q2At);
  });

  it("fills __NOTEBOOK__/__TITLE__/__COUNT__/__CARDS__ with no leftover slots", () => {
    const html = renderFlashcardsHtml("Weekly Vocab", [{ q: "Q", a: "A", hint: "" }]);
    expect(html).not.toContain("__NOTEBOOK__");
    expect(html).not.toContain("__TITLE__");
    expect(html).not.toContain("__COUNT__");
    expect(html).not.toContain("__CARDS__");
    expect(html).toContain("<h1>Weekly Vocab</h1>");
    // The notebook's design tokens landed for real, not as a placeholder.
    expect(html).toContain(":root{");
  });

  it("FLASHCARDS_TEMPLATE itself declares exactly the four slots renderFlashcardsHtml fills", () => {
    expect(FLASHCARDS_TEMPLATE).toContain("__NOTEBOOK__");
    expect(FLASHCARDS_TEMPLATE).toContain("__TITLE__");
    expect(FLASHCARDS_TEMPLATE).toContain("__COUNT__");
    expect(FLASHCARDS_TEMPLATE).toContain("__CARDS__");
  });
});

// ============================================================================
// fallbackFlashcards — parses the model's structured JSON
// ============================================================================

describe("fallbackFlashcards", () => {
  it("keeps a card that has both a question and an answer", () => {
    const raw = JSON.stringify({ cards: [{ q: "Q1", a: "A1", hint: "H1" }] });
    const html = fallbackFlashcards(raw, "Scope Label");
    expect(html).toContain("Q1");
    expect(html).toContain("A1");
    expect(html).toContain("Hint: H1");
  });

  it("drops a card missing a question or an answer", () => {
    const raw = JSON.stringify({
      cards: [
        { q: "", a: "A1" }, // no question -> dropped
        { q: "Q2", a: "" }, // no answer -> dropped
        { q: "Q3", a: "A3" }, // kept
      ],
    });
    const html = fallbackFlashcards(raw, "Label");
    expect(html.match(/class="card"/g)?.length).toBe(1);
    expect(html).toContain("Q3");
  });

  it("defaults a missing hint to empty rather than the literal word 'undefined'", () => {
    const raw = JSON.stringify({ cards: [{ q: "Q", a: "A" }] });
    const html = fallbackFlashcards(raw, "Label");
    expect(html).not.toContain("Hint:");
    expect(html).not.toContain("undefined");
  });

  it("throws when the model returned no usable cards", () => {
    const raw = JSON.stringify({ cards: [] });
    expect(() => fallbackFlashcards(raw, "Label")).toThrow(
      "The model didn't return any usable flashcards — try a different file."
    );
  });

  it("throws the same way on a non-JSON reply", () => {
    expect(() => fallbackFlashcards("sorry, I can't do that", "Label")).toThrow(
      "The model didn't return any usable flashcards — try a different file."
    );
  });
});

// ============================================================================
// flashcardsSpec — the artifact spec, field for field against flashcards.rs
// ============================================================================

describe("flashcardsSpec", () => {
  const spec: StudioSpec = flashcardsSpec();

  it("matches STUDIO_FLASHCARDS_PROMPT for its default instruction", () => {
    expect(spec.defaultPrompt).toBe(STUDIO_FLASHCARDS_PROMPT);
    expect(STUDIO_FLASHCARDS_PROMPT).toBe("Make up to 12 flashcards that test real understanding of this material.");
  });

  it("carries the exact page_role prose from flashcards.rs", () => {
    expect(spec.pageRole).toBe(
      "You are a front-end developer building an interactive flashcards study page. Show a deck of " +
        "cards the reader flips (click, or Space/Enter, or the arrow keys) to reveal the answer, with " +
        "an optional hint, a card counter, and next/previous controls. Base every card only on the " +
        "provided material — test real understanding, not formatting trivia."
    );
  });

  it("carries the exact working/fallback-step/fallback-system/fallback-intro/filename-prefix strings", () => {
    expect(spec.workingLabel).toBe("Designing your deck");
    expect(spec.fallbackStep).toBe("Extracting question/answer pairs…");
    expect(spec.fallbackSystem).toBe(
      "You turn study material into flashcards. Write clear question/answer pairs (and a short " +
        "optional hint) that test understanding of the material — not trivia about its formatting. " +
        "Base every card only on the provided text."
    );
    expect(spec.fallbackIntro).toBe("Base every card only on this material about");
    expect(spec.filenamePrefix).toBe("Flashcards");
  });

  it("uses fallback temperature 0.3 and never runs the structured path first", () => {
    expect(spec.fallbackTemp).toBe(0.3);
    expect(spec.structuredFirst).toBe(false);
    expect(spec.afterSave).toBeUndefined();
  });

  it("renders through fallbackFlashcards itself, not a look-alike copy", () => {
    expect(spec.render).toBe(fallbackFlashcards);
  });

  it("declares the fallback schema flashcards.rs's serde_json::json! literal describes", () => {
    expect(spec.fallbackSchema).toEqual({
      type: "object",
      properties: {
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              q: { type: "string" },
              a: { type: "string" },
              hint: { type: "string" },
            },
            required: ["q", "a"],
          },
        },
      },
      required: ["cards"],
    });
  });

  it("is a FACTORY — two calls return independent objects, not aliases", () => {
    // The Rust source's own comment on `studio_tools_specs` explains why this
    // matters for the three studio specs sharing a mutable-in-place schema
    // transform; flashcards_spec is a plain fn returning a fresh struct in
    // Rust, so the TS port must not memoize/share the object either.
    const a = flashcardsSpec();
    const b = flashcardsSpec();
    expect(a).not.toBe(b);
    expect(a.fallbackSchema).not.toBe(b.fallbackSchema);
  });
});

// ============================================================================
// studioFlashcards — the Tauri command, real end to end against a fixture room
// ============================================================================

describe("studioFlashcards", () => {
  let room: RoomHandle & { dispose(): void };

  afterEach(() => {
    room?.dispose();
  });

  it("authors a real flashcards page from the model's HTML and saves it into the room", async () => {
    room = openFixtureRoom();
    insertFile(room.db, "Biology notes.md", "text/markdown", Buffer.from("mitochondria"), "Mitochondria are the powerhouse of the cell.", "typed");
    const html =
      '<!doctype html><html><head><title>Bio</title></head><body><label class="card">' +
      "<span class=\"txt\">What powers the cell?</span></label></body></html>";
    const deps = fakeRunStudioDeps(room, html, []);

    const meta = await studioFlashcards(deps, null, null, null, null);

    expect(meta.name).toBe("Flashcards - Test Room.html");
    expect(meta.mimeType).toBe("text/html");
    const saved = getFileBytes(room.db, meta.id);
    expect(saved?.toString("utf8")).toBe(html);
  });

  it("falls back to the built-in template when the model's HTML isn't usable", async () => {
    room = openFixtureRoom();
    insertFile(room.db, "Biology notes.md", "text/markdown", Buffer.from("x"), "Mitochondria are the powerhouse of the cell.", "typed");
    const cards: StudioCard[] = [{ q: "What powers the cell?", a: "Mitochondria", hint: "" }];
    // `null` -> the fake's "too short" answer, which real `cleanStudioHtml`
    // refuses (under 60 bytes, no HTML markers) — the same trigger
    // `run_studio_core`'s own fallback branch reacts to.
    const deps = fakeRunStudioDeps(room, null, cards);

    const meta = await studioFlashcards(deps, null, "Focus on cell biology", null, null);

    const saved = getFileBytes(room.db, meta.id);
    const savedHtml = saved?.toString("utf8") ?? "";
    expect(savedHtml.startsWith("<!doctype html>")).toBe(true);
    expect(savedHtml).toContain("What powers the cell?");
    expect(savedHtml).toContain("Mitochondria");
  });

  it("scopes to one file when `scope` names a file id", async () => {
    room = openFixtureRoom();
    const target = insertFile(room.db, "Chapter 3.md", "text/markdown", Buffer.from("x"), "Photosynthesis converts light into chemical energy.", "typed");
    insertFile(room.db, "Chapter 4.md", "text/markdown", Buffer.from("x"), "Unrelated material about tectonic plates.", "typed");
    const cards: StudioCard[] = [{ q: "What does photosynthesis convert?", a: "Light into chemical energy", hint: "" }];
    const deps = fakeRunStudioDeps(room, null, cards);

    const meta = await studioFlashcards(deps, target.id, null, null, null);

    expect(meta.name).toBe("Flashcards - Chapter 3.html");
  });

  it("propagates gatherScopeText's own refusal for an empty room", async () => {
    room = openFixtureRoom();
    const deps = fakeRunStudioDeps(room, null, []);
    await expect(studioFlashcards(deps, null, null, null, null)).rejects.toThrow(
      "This room has no readable text to work with yet."
    );
  });

  it("registers the op id for the run's duration, then cleans it up on return (CancelGuard-equivalent)", async () => {
    room = openFixtureRoom();
    insertFile(room.db, "Notes.md", "text/markdown", Buffer.from("x"), "Some material to build cards from.", "typed");
    const cancelState = createCancelState();
    const seenDuringRun: boolean[] = [];
    const deps: RunStudioDeps = {
      rooms: roomSourceOf(room),
      cancelState,
      listModels: async () => ["qwen3.5:4b"],
      chatStructured: async (_model, _messages, _temperature, _keepAlive, schema) => {
        // The one point mid-run where `registerStudioCancel`'s registration
        // is guaranteed to have already happened (the model call is awaited
        // after it) and not yet torn down (the `finally` hasn't run yet).
        seenDuringRun.push(cancelState.cancels.has("op-9"));
        return schemaWants(schema, "html")
          ? JSON.stringify({ html: "<!doctype html><html><body>content long enough to pass the floor</body></html>" })
          : JSON.stringify({ cards: [] });
      },
    };

    expect(cancelState.cancels.has("op-9")).toBe(false);
    await studioFlashcards(deps, null, null, null, "op-9");
    expect(seenDuringRun).toContain(true); // registered WHILE the run was in flight
    expect(cancelState.cancels.has("op-9")).toBe(false); // and removed once it returned
  });
});

// ============================================================================
// resolveFlashcardsRefs — agent.rs's exec_tool ref-NAME-to-id resolution
// ============================================================================

describe("resolveFlashcardsRefs", () => {
  let room: RoomHandle & { dispose(): void };
  let fileId: string;

  afterEach(() => {
    room?.dispose();
  });

  function setup(): Database.Database {
    room = openFixtureRoom();
    fileId = insertFile(room.db, "Q3 report.pdf", "application/pdf", Buffer.from("x"), "text", "typed").id;
    return room.db;
  }

  it("returns null for a missing or non-array refs argument", () => {
    const db = setup();
    expect(resolveFlashcardsRefs(db, undefined)).toBeNull();
    expect(resolveFlashcardsRefs(db, "not-an-array")).toBeNull();
  });

  it("returns null (whole room) for an empty array", () => {
    const db = setup();
    expect(resolveFlashcardsRefs(db, [])).toBeNull();
  });

  it("passes an already-valid file id through untouched", () => {
    const db = setup();
    expect(resolveFlashcardsRefs(db, [fileId])).toEqual([fileId]);
  });

  it("resolves a file NAME to its id — the round trip a model actually uses", () => {
    const db = setup();
    expect(resolveFlashcardsRefs(db, ["Q3 report.pdf"])).toEqual([fileId]);
  });

  it("resolves a partial match too, matching find_file_like's own fuzziness", () => {
    const db = setup();
    expect(resolveFlashcardsRefs(db, ["Q3 report"])).toEqual([fileId]);
  });

  it("drops blank/whitespace-only entries before resolving", () => {
    const db = setup();
    expect(resolveFlashcardsRefs(db, ["  ", "Q3 report.pdf", ""])).toEqual([fileId]);
  });

  it("proceeds with whatever resolved when only SOME names miss", () => {
    const db = setup();
    expect(resolveFlashcardsRefs(db, ["Q3 report.pdf", "nonexistent.pdf"])).toEqual([fileId]);
  });

  it("throws a combined 'no file matching A or B' refusal when EVERY name misses", () => {
    const db = setup();
    expect(() => resolveFlashcardsRefs(db, ["nope.pdf", "also-missing.pdf"])).toThrow(
      /No file matching "nope\.pdf" or "also-missing\.pdf" in this room\./
    );
  });
});

// ============================================================================
// execStudioFlashcards — agent.rs's exec_tool arm, real end to end
// ============================================================================

describe("execStudioFlashcards", () => {
  let room: RoomHandle & { dispose(): void };

  afterEach(() => {
    room?.dispose();
  });

  it("builds a deck from the whole room when refs are omitted, and replies with the saved name", async () => {
    room = openFixtureRoom();
    insertFile(room.db, "Notes.md", "text/markdown", Buffer.from("x"), "The mitochondria is the powerhouse of the cell.", "typed");
    const cards: StudioCard[] = [{ q: "What powers the cell?", a: "Mitochondria", hint: "" }];
    const deps = fakeRunStudioDeps(room, null, cards);

    const reply = await execStudioFlashcards(deps, null, {});

    expect(reply).toContain('Saved "Flashcards - Test Room.html" into the room.');
    expect(reply).toContain("ARCELLE_ARTIFACT_RECEIPT");
  });

  it("resolves refs by NAME, exactly as the model supplies them from list_room_files", async () => {
    room = openFixtureRoom();
    insertFile(room.db, "Chapter 3.md", "text/markdown", Buffer.from("x"), "Photosynthesis converts light into chemical energy.", "typed");
    const cards: StudioCard[] = [{ q: "Q", a: "A", hint: "" }];
    const deps = fakeRunStudioDeps(room, null, cards);

    const reply = await execStudioFlashcards(deps, null, { refs: ["Chapter 3.md"] });

    expect(reply).toContain('Saved "Flashcards - Chapter 3.html" into the room.');
    expect(reply).toContain("ARCELLE_ARTIFACT_RECEIPT");
  });

  it("threads instructions through to the model prompt path (no crash, no ignored argument)", async () => {
    room = openFixtureRoom();
    insertFile(room.db, "Notes.md", "text/markdown", Buffer.from("x"), "Material.", "typed");
    const seenInstructions: string[] = [];
    const deps: RunStudioDeps = {
      rooms: roomSourceOf(room),
      cancelState: createCancelState(),
      listModels: async () => ["qwen3.5:4b"],
      chatStructured: async (_model, messages) => {
        seenInstructions.push(messages[1]?.content ?? "");
        return JSON.stringify({ html: "<!doctype html><html><body>a generated page long enough to pass</body></html>" });
      },
    };

    await execStudioFlashcards(deps, null, { instructions: "Focus on chapter 3" });

    expect(seenInstructions[0]).toContain("Focus on chapter 3");
  });

  it("throws 'No room is open.' when the RoomSource has none", async () => {
    const deps: RunStudioDeps = { rooms: { current: () => null }, cancelState: createCancelState() };
    await expect(execStudioFlashcards(deps, null, {})).rejects.toThrow("No room is open.");
  });

  it("refuses honestly (never fabricates a deck) when every named ref misses", async () => {
    room = openFixtureRoom();
    insertFile(room.db, "Notes.md", "text/markdown", Buffer.from("x"), "Material.", "typed");
    const deps = fakeRunStudioDeps(room, null, []);
    await expect(execStudioFlashcards(deps, null, { refs: ["nonexistent.pdf"] })).rejects.toThrow(
      /No file matching "nonexistent\.pdf" in this room\./
    );
  });
});

// ============================================================================
// EXEC_STUDIO_FLASHCARDS_GAP — what execTool.ts's arm still cannot do, and why
// ============================================================================

describe("EXEC_STUDIO_FLASHCARDS_GAP", () => {
  it("names what is real (execStudioFlashcards, runStudio) and what is still missing (a live RoomSource/CancelState)", () => {
    expect(EXEC_STUDIO_FLASHCARDS_GAP).toContain("execStudioFlashcards");
    expect(EXEC_STUDIO_FLASHCARDS_GAP).toContain("IS ported");
    expect(EXEC_STUDIO_FLASHCARDS_GAP).toContain("RoomSource");
    expect(EXEC_STUDIO_FLASHCARDS_GAP).toContain("CancelState");
  });
});

// ============================================================================
// the shared exec_tool arm — ONE copy, not a flashcards-shaped fork
// ============================================================================

describe("the exec_tool arm is shared, not forked per artifact", () => {
  it("resolveFlashcardsRefs IS studiosCmds.ts's resolveStudioRefs — the same function, not a look-alike", async () => {
    // `agent.rs` ~4299 dispatches `studio_flashcards | studio_mindmap |
    // generate_podcast_script` through ONE match arm whose only per-artifact
    // difference is `spec`. This file kept a private copy of that arm's
    // refs-resolution block, which is how the mind-map and podcast arms ended
    // up unable to run at all. Identity, not behavioral equivalence, is the
    // assertion: two copies that agree today drift tomorrow.
    const { resolveStudioRefs } = await import("./studiosCmds.js");
    expect(resolveFlashcardsRefs).toBe(resolveStudioRefs);
  });

  it("execStudioFlashcards dispatches the flashcards spec through that same arm", async () => {
    const room = openFixtureRoom("Deck Room");
    try {
      insertFile(room.db, "src.md", "text/markdown", Buffer.from("m"), "Material to study.", "upload");
      const deps = fakeRunStudioDeps(room, null, [{ q: "Q?", a: "A.", hint: "" }]);
      const reply = await execStudioFlashcards(deps, null, {});
      expect(reply).toContain('Saved "Flashcards - Deck Room.html" into the room.');
      expect(reply).toContain("ARCELLE_ARTIFACT_RECEIPT");
    } finally {
      room.dispose();
    }
  });
});

// ============================================================================
// adversarial: model-authored card text that spells a template slot
// ============================================================================

describe("renderFlashcardsHtml: adversarial slot-named card text", () => {
  it("a card whose ANSWER is literally __NOTEBOOK__ never splices the stylesheet into the deck", () => {
    // `fill_template`'s one-pass rule is usually demonstrated on the TITLE
    // (flashcards.rs's own test). The deck is substituted LAST, so a card
    // spelling an EARLIER slot is the harder direction: under chained
    // `.replace()` the answer text would have had the whole of NOTEBOOK_CSS
    // pasted into it, inside a `<span class="txt">`.
    const html = renderFlashcardsHtml("Deck", [
      { q: "__COUNT__", a: "__NOTEBOOK__", hint: "__TITLE__" },
    ]);
    expect(html).toContain('<span class="txt">__NOTEBOOK__</span>');
    expect(html).toContain('<span class="txt">__COUNT__</span>');
    expect(html).toContain("Hint: __TITLE__");
    // The real stylesheet appears exactly once — in the <style> block, never
    // inside a card face.
    const styleEnd = html.indexOf("</style>");
    expect(html.indexOf(NOTEBOOK_CSS)).toBeLessThan(styleEnd);
    expect(html.indexOf(NOTEBOOK_CSS, styleEnd)).toBe(-1);
    // And the deck is still one card, not a page that swallowed itself.
    expect(html.match(/class="card"/g)).toHaveLength(1);
  });
});
