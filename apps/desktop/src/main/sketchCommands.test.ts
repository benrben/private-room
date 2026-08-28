/**
 * Tests for `sketchCommands.ts` — the Sketch page's commands and the two
 * agent tools, ported from `src-tauri/src/commands/sketch.rs`.
 *
 * Every one of `sketch.rs`'s own `mod tests` cases is here, driven through
 * the PUBLIC surface (`createSketch`/`writeSketch`/`execDraw`/
 * `execReadDrawing`/the exports) rather than by exporting its private
 * helpers (`resolve`/`draw_target`/`take_empty_sketch`/`load`/`save`) just
 * to reach them: Rust's `mod tests` gets free access to its parent's private
 * items and TypeScript does not, and driving the same scenarios through the
 * real boundary is the better test anyway.
 *
 * NOT PORTED HERE: the three tests that exercise `draw_tools_specs()` —
 * already ported, by an earlier batch, as `toolSpecs.ts`'s
 * `drawToolsSpecs()`/`DRAW_TOOL_NAMES`, with its own tests. The one thing
 * those tests own that this file's subject also names is `DRAW_FOLLOWUP`
 * (`no_description_sends_the_model_after_a_tool_that_is_not_there` holds it
 * to the same rule as the descriptions), so that check IS ported below.
 *
 * FIXTURE ROOMS are real `.roomai` files via `createRoom`
 * (better-sqlite3-multiple-ciphers), matching `fileTools.test.ts` and
 * `db-host/files.test.ts`: every fixture file goes through the real
 * `insertFile`/`updateFileContent`, so what these tests read back is exactly
 * what the app writes.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { getFileBytes, getFileExtractedText, getFileName, insertFile, listFiles } from "./db-host/files.js";
import { listFileVersions } from "./db-host/fileVersionsList.js";
import { setSetting } from "./db-host/settings.js";
import { clearPolicy, setPolicyForTests } from "./privacy.js";
import { applyScript, defaultSketch, type Sketch, sketchFromJson, sketchToJson } from "./sketchDoc.js";
import {
  createSketch,
  DRAW_FOLLOWUP,
  execDraw,
  execReadDrawing,
  exportSketchPng,
  exportSketchSvg,
  SKETCH_EXT,
  type SketchToolOutcome,
  writeSketch,
} from "./sketchCommands.js";
import { DRAW_TOOL_NAMES } from "./toolSpecs.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  clearPolicy();
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "sketch-cmds-"));
  return createRoom(path.join(tmpDir, `t-${randomUUID()}.roomai`), "correct horse battery staple", "Test Room");
}

function addSketch(db: Database.Database, name: string, doc: Sketch = defaultSketch()): string {
  const full = name.endsWith(`.${SKETCH_EXT}`) ? name : `${name}.${SKETCH_EXT}`;
  return insertFile(db, full, "application/json", Buffer.from(sketchToJson(doc), "utf8"), null, "upload").id;
}

function drawn(script: string): Sketch {
  const doc = defaultSketch();
  const out = applyScript(doc, script);
  if (!out.ok) {
    throw new Error(out.error);
  }
  return doc;
}

function sketchNames(db: Database.Database): string[] {
  return listFiles(db)
    .map((f) => f.name)
    .filter((n) => n.endsWith(`.${SKETCH_EXT}`))
    .sort();
}

function loadDoc(db: Database.Database, id: string): Sketch {
  return sketchFromJson((getFileBytes(db, id) as Buffer).toString("utf8"));
}

function text(out: SketchToolOutcome): string {
  if (!out.ok) {
    throw new Error(`expected ok, got: ${out.error}`);
  }
  return out.text;
}

function error(out: SketchToolOutcome): string {
  if (out.ok) {
    throw new Error(`expected a refusal, got: ${out.text}`);
  }
  return out.error;
}

const noVision = (): { pendingImages: string[]; visionChat: boolean } => ({ pendingImages: [], visionChat: false });
const withVision = (): { pendingImages: string[]; visionChat: boolean } => ({ pendingImages: [], visionChat: true });

// ---------------------------------------------------------------------------
// Naming and creation
// ---------------------------------------------------------------------------

describe("createSketch and naming", () => {
  it("a name gains the extension but never twice", () => {
    const db = freshRoom();
    expect(createSketch(db, "Login flow").name).toBe("Login flow.sketch");
    expect(createSketch(db, "Plain.sketch").name).toBe("Plain.sketch");
    expect(createSketch(db, "  ").name).toBe("Sketch.sketch");
  });

  it("a second drawing with the same name gets its own", () => {
    const db = freshRoom();
    expect(createSketch(db, "Flow").name).not.toBe(createSketch(db, "Flow").name);
  });

  it("a new drawing is section-only — Sketches, not the Home library", () => {
    const db = freshRoom();
    const meta = createSketch(db, "Flow");
    const listed = listFiles(db).find((f) => f.id === meta.id);
    expect(listed?.originDestination).toBe("sketch");
    expect(listed?.libraryVisibility).toBe("sectionOnly");
    expect(meta.mimeType).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// Resolving a drawing by name (sketch.rs's `resolve`/`resolve_named`)
// ---------------------------------------------------------------------------

describe("resolving a drawing by name", () => {
  it("the only drawing in the room needs no name", async () => {
    const db = freshRoom();
    addSketch(db, "Only one");
    expect(text(await execReadDrawing(db, {}, noVision()))).toContain('Drawing "Only one.sketch"');
  });

  it("asking for nothing with several drawings lists them instead of guessing", async () => {
    const db = freshRoom();
    addSketch(db, "First");
    addSketch(db, "Second");
    const err = error(await execReadDrawing(db, { name: "" }, noVision()));
    expect(err).toContain("First");
    expect(err).toContain("Second");
  });

  it("an ambiguous fragment is refused rather than resolved to the newest", async () => {
    // The room's generic `findFileLike` would silently pick the newest of
    // these; for a drawing the agent itself just made, that is a
    // wrong-target write.
    const db = freshRoom();
    addSketch(db, "Login flow");
    addSketch(db, "Login flow old");
    expect(error(await execReadDrawing(db, { name: "Login" }, noVision()))).toContain("matches 2");
  });

  it("the extension is optional and matching is case-insensitive", async () => {
    const db = freshRoom();
    addSketch(db, "Login flow");
    for (const name of ["Login flow", "Login flow.sketch", "login FLOW"]) {
      expect(text(await execReadDrawing(db, { name }, noVision()))).toContain('Drawing "Login flow.sketch"');
    }
  });

  it("an empty room says how to start rather than that nothing matched", async () => {
    expect(error(await execReadDrawing(freshRoom(), { name: "anything" }, noVision()))).toContain("no drawings yet");
  });

  it("only sketch files are candidates", async () => {
    const db = freshRoom();
    insertFile(db, "notes.md", "text/markdown", Buffer.from("hi"), "hi", "upload");
    expect(error(await execReadDrawing(db, { name: "notes" }, noVision()))).toContain("no drawings yet");
  });
});

// ---------------------------------------------------------------------------
// execDraw (tool_draw)
// ---------------------------------------------------------------------------

describe("execDraw", () => {
  it("draws on the sketch it names, indexing its labels and not its coordinates", () => {
    const db = freshRoom();
    const meta = createSketch(db, "Flow");
    const msg = text(execDraw(db, { name: "Flow", script: 'rect 250 400 320 130 blue "Login form"' }));
    expect(msg).toContain("added e1");
    expect(msg).toContain('on "Flow.sketch"');
    expect(msg).toContain("holds 1 thing(s)");

    const indexed = getFileExtractedText(db, meta.id) ?? "";
    expect(indexed).toContain("Login form");
    expect(indexed).not.toContain("320");
    expect(loadDoc(db, meta.id).elements).toHaveLength(1);
  });

  it("starts a new drawing when the name is new", () => {
    const db = freshRoom();
    addSketch(db, "Something", drawn('rect 10 10 100 100 blue "busy"'));
    const msg = text(execDraw(db, { name: "Order flow", script: 'rect 10 10 100 100 blue "box"' }));
    expect(msg).toMatch(/^Started "Order flow\.sketch" and /);
    expect(sketchNames(db)).toEqual(["Order flow.sketch", "Something.sketch"]);
  });

  it("requires a name", () => {
    expect(error(execDraw(freshRoom(), { name: "  ", script: "rect 10 10 10 10 blue" }))).toMatch(/Say which sketch/);
  });

  it("a bad script is refused and changes nothing on disk", () => {
    const db = freshRoom();
    const meta = createSketch(db, "Flow");
    const err = error(execDraw(db, { name: "Flow", script: "sqaure 10 10 20 20" }));
    expect(err).toContain("sqaure");
    expect(loadDoc(db, meta.id).elements).toHaveLength(0);
  });

  it("a blank sketch is claimed rather than left behind as litter", () => {
    // Live QA 2026-08-13: press "New sketch", then ask for a diagram. The
    // blank page stayed blank on screen, the diagram landed in a second file,
    // and the first was orphaned.
    const db = freshRoom();
    const blank = createSketch(db, "Sketch");
    const msg = text(execDraw(db, { name: "Order flow", script: 'rect 10 10 100 100 blue "box"' }));
    expect(msg).not.toMatch(/^Started/);
    expect(sketchNames(db)).toEqual(["Order flow.sketch"]);
    expect(getFileName(db, blank.id)).toBe("Order flow.sketch");
  });

  it("a drawing with work on it is never repurposed", () => {
    const db = freshRoom();
    createSketch(db, "Real work");
    execDraw(db, { name: "Real work", script: 'rect 10 10 100 100 blue "mine"' });
    expect(text(execDraw(db, { name: "Something else", script: 'rect 10 10 100 100 red "new"' }))).toMatch(/^Started/);
    expect(sketchNames(db)).toEqual(["Real work.sketch", "Something else.sketch"]);
  });

  it("the newest blank page is the one claimed", () => {
    const db = freshRoom();
    const oldBlank = createSketch(db, "Old blank");
    const justMade = createSketch(db, "Just made");
    execDraw(db, { name: "Flow", script: 'rect 10 10 100 100 blue "box"' });
    expect(getFileName(db, justMade.id)).toBe("Flow.sketch");
    expect(getFileName(db, oldBlank.id)).toBe("Old blank.sketch");
  });

  it("an ambiguous name reports itself instead of starting a third drawing", () => {
    const db = freshRoom();
    addSketch(db, "Login flow", drawn('rect 100 100 200 100 blue "box"'));
    addSketch(db, "Login flow old", drawn('rect 100 100 200 100 blue "box"'));
    const before = sketchNames(db);
    expect(error(execDraw(db, { name: "Login", script: 'rect 10 10 100 100 blue "box"' }))).toContain("matches 2 drawings");
    expect(sketchNames(db)).toEqual(before);
  });

  it("worth-fixing layout notes and the follow-up instruction ride the tool result", () => {
    const db = freshRoom();
    createSketch(db, "Flow");
    const msg = text(execDraw(db, { name: "Flow", script: "rect 100 100 300 200 blue\nrect 150 150 300 200 green" }));
    expect(msg).toContain("Worth fixing:");
    expect(msg).toContain("overlap");
    expect(msg).toContain(DRAW_FOLLOWUP);
  });

  it("the follow-up instruction names only tools the model actually holds", () => {
    // `see_drawing` was deleted and the draw RESULT went on naming it, so
    // every layout report ended by telling the model to call a tool it did
    // not have. Any snake_case word here reads as a tool name.
    for (const word of DRAW_FOLLOWUP.split(/[^A-Za-z0-9_]/)) {
      if (word.includes("_")) {
        expect(DRAW_TOOL_NAMES, `"${word}" reads as a tool name`).toContain(word);
      }
    }
  });

  it("moving a connector says it follows its shapes rather than claiming a move", () => {
    const db = freshRoom();
    createSketch(db, "Flow");
    execDraw(db, { name: "Flow", script: 'rect 100 100 200 100 blue "A"\nrect 700 100 200 100 blue "B"\nlink e1 e2' });
    const msg = text(execDraw(db, { name: "Flow", script: "move e3 40 0" }));
    expect(msg).toContain("connector");
    expect(msg).toContain("e1");
    expect(msg).toContain("e3");
  });

  it("emits agent-open-file, sketch-drawn and room-files-changed, in that order", () => {
    const db = freshRoom();
    const meta = createSketch(db, "Flow");
    const seen: Array<[string, unknown]> = [];
    execDraw(db, { name: "Flow", script: 'rect 10 10 100 100 blue "box"' }, (event, payload) => seen.push([event, payload]));
    expect(seen.map(([e]) => e)).toEqual(["agent-open-file", "sketch-drawn", "room-files-changed"]);
    expect(seen[0]?.[1]).toEqual({ id: meta.id });
    const drawnEvent = seen[1]?.[1] as { fileId: string; name: string; added: string[]; steps: string[]; doc: string };
    expect(drawnEvent.fileId).toBe(meta.id);
    expect(drawnEvent.name).toBe("Flow.sketch");
    expect(drawnEvent.added).toEqual(["e1"]);
    expect(drawnEvent.steps[0]).toContain("drew rect e1");
    // The WHOLE document rides along, so the editor need not re-read the file
    // (and lose a stroke the user made in between).
    expect(sketchFromJson(drawnEvent.doc).elements).toHaveLength(1);
  });

  it("a throwing emit callback never turns a successful draw into a failure", () => {
    const db = freshRoom();
    createSketch(db, "Flow");
    const out = execDraw(db, { name: "Flow", script: "rect 10 10 100 100 blue \"box\"" }, () => {
      throw new Error("renderer gone");
    });
    expect(out.ok).toBe(true);
  });

  it("a script that changes nothing does not write a version", () => {
    const db = freshRoom();
    const meta = createSketch(db, "Flow");
    execDraw(db, { name: "Flow", script: 'rect 10 10 100 100 blue "box"' });
    const before = listFileVersions(db, meta.id).length;
    execDraw(db, { name: "Flow", script: "canvas 1600 1000" });
    expect(listFileVersions(db, meta.id)).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// execReadDrawing (tool_read_drawing)
// ---------------------------------------------------------------------------

describe("execReadDrawing", () => {
  it("describes the page as the same script `draw` writes, plus layout problems", async () => {
    const db = freshRoom();
    addSketch(db, "Flow", drawn("rect 100 100 300 200 blue\nrect 150 150 300 200 green"));
    const out = text(await execReadDrawing(db, { name: "Flow" }, noVision()));
    expect(out).toContain('Drawing "Flow.sketch"');
    expect(out).toContain("e1 rect 100 100 300 200 blue");
    expect(out).toContain("Problems with the layout:");
    expect(out).toContain("overlap");
  });

  it("a tidy, non-empty drawing says nothing measures wrong", async () => {
    const db = freshRoom();
    addSketch(db, "Flow", drawn('rect 100 100 300 150 blue "One"\nrect 900 100 300 150 green "Two"\nlink e1 e2'));
    expect(text(await execReadDrawing(db, { name: "Flow" }, noVision()))).toContain("Nothing measures wrong");
  });

  it("an empty page says so and never tries to attach a picture", async () => {
    const db = freshRoom();
    addSketch(db, "Blank");
    const effects = withVision();
    const out = text(await execReadDrawing(db, { name: "Blank" }, effects));
    expect(out).toContain("(the page is empty)");
    expect(effects.pendingImages).toHaveLength(0);
  });

  it("never attaches a picture when the engine cannot read images", async () => {
    const db = freshRoom();
    addSketch(db, "Flow", drawn('rect 100 100 300 150 blue "One"'));
    const effects = noVision();
    await execReadDrawing(db, { name: "Flow" }, effects);
    expect(effects.pendingImages).toHaveLength(0);
  });

  it("attaches a real PNG for a vision-capable local chat model", async () => {
    const db = freshRoom();
    addSketch(db, "Flow", drawn('rect 100 100 300 150 blue "One"'));
    // No `model` setting → `modelSetting` is null → local by definition
    // (Rust's `is_none_or(runs_on_this_mac)`), so no privacy door applies.
    const effects = withVision();
    const out = text(await execReadDrawing(db, { name: "Flow" }, effects));
    expect(effects.pendingImages).toHaveLength(1);
    expect(out).toContain("attached as a picture");
    expect(Buffer.from(effects.pendingImages[0] as string, "base64").subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
  });

  it("withholds the picture from a non-local model behind an active privacy door", async () => {
    const db = freshRoom();
    addSketch(db, "Flow", drawn('rect 100 100 300 150 blue "One"'));
    setSetting(db, "model", "qwen3.5:70b-cloud");
    setPolicyForTests(true);
    const effects = withVision();
    const out = text(await execReadDrawing(db, { name: "Flow" }, effects));
    expect(effects.pendingImages).toHaveLength(0);
    expect(out).toContain("this room's privacy door keeps images on this Mac");
    // The measurements are still there — the text half is the greater half.
    expect(out).toContain("e1 rect 100 100 300 150 blue");
  });

  it("an unresolvable name is refused with the room's real drawing list", async () => {
    const db = freshRoom();
    addSketch(db, "Flow");
    expect(error(await execReadDrawing(db, { name: "nope" }, noVision()))).toContain("Flow.sketch");
  });
});

// ---------------------------------------------------------------------------
// writeSketch (save_sketch's body — the page's own autosave path)
// ---------------------------------------------------------------------------

describe("writeSketch", () => {
  it("drawing for a while leaves one version, not one per stroke", () => {
    // Live QA 2026-08-13: "its saved each change its not good, this is why
    // its stucks". Every autosave used to copy the whole document into
    // version history — a hundred blob writes in two minutes of drawing.
    const db = freshRoom();
    const id = addSketch(db, "Flow");
    const doc = defaultSketch();
    for (let i = 0; i < 25; i++) {
      applyScript(doc, `rect ${i * 20} 10 80 60 blue "b${i}"`);
      // Only the first save of the session takes history, exactly as the
      // editor calls it.
      writeSketch(db, id, sketchToJson(doc), i === 0);
    }
    expect(listFileVersions(db, id)).toHaveLength(1);
    expect(loadDoc(db, id).elements).toHaveLength(25);
  });

  it("the session snapshot holds what the page looked like before", () => {
    const db = freshRoom();
    const id = addSketch(db, "Flow");
    writeSketch(db, id, sketchToJson(drawn('rect 10 10 80 60 blue "first"')), true);
    const versions = listFileVersions(db, id);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.cause).toBe("Before you drew");
  });

  it("a malformed document is refused instead of becoming the file", () => {
    const db = freshRoom();
    const id = addSketch(db, "Flow");
    writeSketch(db, id, sketchToJson(drawn('rect 10 10 80 60 blue "keep me"')), false);
    expect(() => writeSketch(db, id, "{ not json", false)).toThrow();
    // …and a document that parses as JSON but not as a drawing is refused too.
    expect(() => writeSketch(db, id, '{"elements":[]}', false)).toThrow();
    expect(loadDoc(db, id).elements[0]?.label).toBe("keep me");
  });

  it("saving indexes the labels and not the document source", () => {
    const db = freshRoom();
    const id = addSketch(db, "Flow");
    writeSketch(db, id, sketchToJson(drawn('rect 250 400 320 130 blue "Login form"')), false);
    const indexed = getFileExtractedText(db, id) ?? "";
    expect(indexed).toContain("Login form");
    expect(indexed).not.toContain("320");
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe("exports", () => {
  it("export_sketch_svg produces a real .svg sibling", () => {
    const db = freshRoom();
    const id = addSketch(db, "Flow", drawn('rect 100 100 300 150 blue "Login form"'));
    const meta = exportSketchSvg(db, id);
    expect(meta.name).toBe("Flow.svg");
    expect(meta.mimeType).toBe("image/svg+xml");
    const svg = (getFileBytes(db, meta.id) as Buffer).toString("utf8");
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain("Login form");
  });

  it("the exported SVG's index text is empty until extraction gains its .svg branch", () => {
    // NOT the Rust behaviour, and pinned here so the day it changes is
    // visible: `extraction::extract_text` reads an SVG's `<text>` bodies via
    // `extraction/data.rs`'s `extract_svg`, which `editMatch.ts` has not
    // ported. `exportSketchSvg` still calls the shared `extractText`, so this
    // assertion flips on its own the moment that branch lands — see that
    // function's own doc.
    const db = freshRoom();
    const id = addSketch(db, "Flow", drawn('rect 100 100 300 150 blue "Login form"'));
    expect(getFileExtractedText(db, exportSketchSvg(db, id).id)).toBeNull();
  });

  it("export_sketch_png produces a real PNG sibling carrying the labels", async () => {
    const db = freshRoom();
    const id = addSketch(db, "Flow", drawn('rect 100 100 300 150 blue "Login form"'));
    const meta = await exportSketchPng(db, id);
    expect(meta.name).toBe("Flow.png");
    expect(meta.mimeType).toBe("image/png");
    expect((getFileBytes(db, meta.id) as Buffer).subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(getFileExtractedText(db, meta.id) ?? "").toContain("Login form");
  });

  it("an empty drawing's export carries no search text rather than an empty string", async () => {
    const db = freshRoom();
    const id = addSketch(db, "Blank");
    const meta = await exportSketchPng(db, id);
    expect(getFileExtractedText(db, meta.id)).toBeNull();
  });

  it("exporting twice does not collide on the name", () => {
    const db = freshRoom();
    const id = addSketch(db, "Flow", drawn('rect 100 100 300 150 blue "One"'));
    expect(exportSketchSvg(db, id).name).toBe("Flow.svg");
    expect(exportSketchSvg(db, id).name).not.toBe("Flow.svg");
  });
});
