/**
 * Tests for `studiosCmds.ts` — the Studios feature's top-level dispatcher and
 * shared plumbing. Ported directly from `src-tauri/src/commands/studios.rs`'s
 * own `#[cfg(test)] mod tests` where a Rust test exists (fill_template x2,
 * the preview-store eviction, the locking sweep, the palette-fidelity
 * check), plus real coverage for everything else this file adds: the
 * room-backed text gathering, the shared `run_studio`/`run_studio_core`
 * pipeline (against a real fixture room, per this batch's own instructions),
 * `resolveStructuredModel`'s composed real pieces, and the cancel-tree
 * `dispose()` deviation `cancel.ts`'s own module doc requires of this file.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { fileByExactName, getFileMeta, insertFile, setFileExtractedText, type FileMeta } from "./db-host/files.js";
import { getPodcast as getPodcastRow } from "./db-host/podcasts.js";
import { setSetting } from "./db-host/settings.js";
import {
  childOfRun,
  createCancelState,
  nodeFor,
  registerRun,
  CancelFlag,
  type CancelState,
} from "./cancel.js";
import { NOTEBOOK_CSS } from "./docsHtml.js";
import * as obs from "./obs.js";
import {
  cleanStudioHtml,
  cleanupBrowserPreviews,
  execStudio,
  cleanupBrowserPreviewsOlderThan,
  createHtmlPreviews,
  fillTemplate,
  gatherFilesText,
  gatherScopeText,
  generateStudioHtml,
  makeRunStudio,
  openHtmlInBrowser,
  PREVIEW_MAX,
  registerStudioCancel,
  resolveStudioRefs,
  resolveStructuredModel,
  runStudio,
  runStudioCore,
  safeScopeName,
  SELF_CONTAINED_HTML_RULES,
  stagePreviewHtmlCore,
  studioInstruction,
  studioPrompts,
  studioSpecFor,
  studioTitle,
  sweepPreviewsOlderThan,
  type HtmlPreviews,
  type RoomHandle,
  type RoomSource,
  type RunStudioDeps,
  type StudioLog,
  type StudioSpec,
} from "./studiosCmds.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";

// ============================================================================
// fixture room
// ============================================================================

let tmpDir: string;

afterEach(() => {
  vi.useRealTimers();
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(name = "Test Room"): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "studios-cmds-"));
  const roomPath = path.join(tmpDir, `t-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", name);
}

function freshWorkspaceRoom(name = "Workspace Room"): { db: Database.Database; root: string; workspace: WorkspaceService } {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "studios-cmds-workspace-"));
  const root = path.join(tmpDir, "Room");
  const { db } = createWorkspaceRoom(root, "correct horse battery staple", name);
  return { db, root, workspace: new WorkspaceService(db, root) };
}

function addFile(db: Database.Database, name: string, text: string | null, mime = "text/plain"): string {
  return insertFile(db, name, mime, Buffer.from(text ?? "", "utf8"), text, "upload").id;
}

/** A `RoomSource` whose `current()` room can be swapped mid-test (for the
 * room-pin checks) or set to `null` (no room open). */
function fakeRoomSource(initial: RoomHandle | null): RoomSource & { set(room: RoomHandle | null): void } {
  let current = initial;
  return {
    current: () => current,
    set: (room: RoomHandle | null) => {
      current = room;
    },
  };
}

function captureLog(): { log: StudioLog; events: string[] } {
  const events: string[] = [];
  const record = (event: string): void => {
    events.push(event);
  };
  return { log: { warn: record as unknown as typeof obs.warn }, events };
}

// ============================================================================
// fill_template — studios.rs's own two unit tests, ported directly
// ============================================================================

describe("fillTemplate", () => {
  it("never rescans what it substituted", () => {
    // A file named after one of the template's own slots used to splice the
    // later slot's content into the title (chained `.replace()` rescans).
    const out = fillTemplate("<title>__TITLE__</title><div>__CARDS__</div>", [
      ["__TITLE__", "__CARDS__"],
      ["__CARDS__", "<b>deck</b>"],
    ]);
    expect(out).toBe("<title>__CARDS__</title><div><b>deck</b></div>");
  });

  it("fills every occurrence and leaves unknown slots", () => {
    const out = fillTemplate("__A__ and __A__ and __MISSING__", [["__A__", "x"]]);
    expect(out).toBe("x and x and __MISSING__");
  });
});

// ============================================================================
// safe_scope_name
// ============================================================================

describe("safeScopeName", () => {
  it("folds path/reserved characters to spaces and squashes whitespace", () => {
    expect(safeScopeName('a/b\\c:d*e?f"g<h>i|j\nk\tl')).toBe("a b c d e f g h i j k l");
  });

  it("falls back to \"room\" for an empty or all-reserved label", () => {
    expect(safeScopeName("")).toBe("room");
    expect(safeScopeName("///:::")).toBe("room");
  });

  it("truncates to 60 CODE POINTS, not UTF-16 units — a surrogate pair is never split", () => {
    // An astral emoji is 2 UTF-16 code units but 1 code point; a byte/UTF-16
    // truncation at 60 would risk slicing it in half and leaving a dangling
    // lone surrogate in the file name.
    const label = "🎈".repeat(65);
    const out = safeScopeName(label);
    expect(Array.from(out)).toHaveLength(60);
    expect(out).toBe("🎈".repeat(60));
  });

  it("leaves an ordinary short label alone", () => {
    expect(safeScopeName("clean-code notes")).toBe("clean-code notes");
  });
});

// ============================================================================
// studio_instruction / studio_prompts
// ============================================================================

describe("studioInstruction", () => {
  it("uses the supplied, trimmed instruction when non-empty", () => {
    expect(studioInstruction("  do it well  ", "default")).toBe("do it well");
  });

  it("falls back to the default for null or whitespace-only", () => {
    expect(studioInstruction(null, "default")).toBe("default");
    expect(studioInstruction("   ", "default")).toBe("default");
  });
});

describe("studioPrompts", () => {
  it("returns the three default, user-editable prompts", () => {
    const p = studioPrompts();
    expect(p.flashcards).toContain("flashcards");
    expect(p.mindmap).toContain("mind map");
    expect(p.podcast).toContain("podcast script");
  });
});

// ============================================================================
// gather_scope_text / gather_files_text — against a real fixture room
// ============================================================================

describe("gatherScopeText", () => {
  it("reads one file's text, titled from its name, clamped to 12,000 bytes", () => {
    const db = freshRoom();
    const id = addFile(db, "Q3 report.md", "The quarter went well.");
    const [label, text] = gatherScopeText(db, id, "Test Room");
    expect(label).toBe("Q3 report");
    expect(text).toBe("The quarter went well.");
  });

  it("throws naming the file when its text is empty", () => {
    const db = freshRoom();
    const id = addFile(db, "empty.md", "   ");
    expect(() => gatherScopeText(db, id, "Test Room")).toThrow('"empty.md" has no readable text');
  });

  it("throws when the scoped file id names nothing", () => {
    const db = freshRoom();
    expect(() => gatherScopeText(db, "no-such-id", "Test Room")).toThrow();
  });

  it("scope=null concatenates every readable file under a room-name header, skipping the app's own summary", () => {
    const db = freshRoom();
    addFile(db, "one.md", "First file's text.");
    addFile(db, "two.md", "Second file's text.");
    // The app's own generated summary must not summarize itself.
    insertFile(db, "Room summary.html", "text/html", Buffer.from("<p>x</p>"), "<p>x</p>", "generated");
    const [label, text] = gatherScopeText(db, null, "My Room");
    expect(label).toBe("My Room");
    expect(text).toContain("## one.md");
    expect(text).toContain("First file's text.");
    expect(text).toContain("## two.md");
    expect(text).not.toContain("Room summary");
  });

  it("throws when the room has no readable text at all", () => {
    const db = freshRoom();
    expect(() => gatherScopeText(db, null, "Empty Room")).toThrow("no readable text to work with yet");
  });

  it("skips blank files and stops before reading beyond the whole-room byte budget", () => {
    const db = freshRoom();
    addFile(db, "after-limit.md", "this must not be gathered");
    for (let index = 0; index < 9; index += 1) {
      addFile(db, `part-${index}.md`, "x".repeat(1_500));
    }
    addFile(db, "blank.md", "   ");

    const [, text] = gatherScopeText(db, null, "Room");

    expect(text).not.toContain("blank.md");
    expect(text).not.toContain("after-limit.md");
  });
});

describe("gatherFilesText", () => {
  it("labels a single file by its title", () => {
    const db = freshRoom();
    const id = addFile(db, "notes.md", "Some notes.");
    const [label, text] = gatherFilesText(db, [id]);
    expect(label).toBe("notes");
    expect(text).toContain("Some notes.");
  });

  it("labels several files as \"N files\" and skips ids that resolve to nothing or empty text", () => {
    const db = freshRoom();
    const a = addFile(db, "a.md", "A's text.");
    const b = addFile(db, "b.md", "B's text.");
    const empty = addFile(db, "c.md", "  ");
    const [label, text] = gatherFilesText(db, [a, b, empty, "missing-id"]);
    expect(label).toBe("2 files");
    expect(text).toContain("A's text.");
    expect(text).toContain("B's text.");
  });

  it("throws when nothing in the list has readable text", () => {
    const db = freshRoom();
    expect(() => gatherFilesText(db, ["nope"])).toThrow("no readable text to work with");
  });

  it("stops once previously gathered referenced files reach the byte budget", () => {
    const db = freshRoom();
    const ids = Array.from({ length: 6 }, (_, index) => addFile(db, `part-${index}.md`, "x".repeat(3_000)));
    const [, text] = gatherFilesText(db, ids);
    expect(text).toContain("part-3.md");
    expect(text).not.toContain("part-4.md");
  });
});

// ============================================================================
// SELF_CONTAINED_HTML_RULES — palette fidelity against docsHtml.ts's
// NOTEBOOK_CSS, ported from studios.rs's own the_prompt_palette_matches_the_
// notebook test
// ============================================================================

describe("SELF_CONTAINED_HTML_RULES", () => {
  it("names the notebook's real --page/--ink/--mk-berry-ink hex values in both themes", () => {
    const darkAt = NOTEBOOK_CSS.indexOf('html[data-theme="dark"]{');
    expect(darkAt).toBeGreaterThan(-1);
    const light = NOTEBOOK_CSS.slice(0, darkAt);
    const dark = NOTEBOOK_CSS.slice(darkAt);
    const valueOf = (block: string, token: string): string => {
      const at = block.indexOf(`${token}:`);
      expect(at).toBeGreaterThan(-1);
      const rest = block.slice(at + token.length + 1);
      return rest.slice(0, rest.indexOf(";")).trim();
    };
    for (const [, block] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const token of ["--page", "--ink", "--mk-berry-ink"]) {
        const hex = valueOf(block, token);
        expect(SELF_CONTAINED_HTML_RULES).toContain(hex);
      }
    }
  });
});

// ============================================================================
// clean_studio_html
// ============================================================================

describe("cleanStudioHtml", () => {
  it("strips a ```html fence despite the schema", () => {
    const out = cleanStudioHtml('```html\n<!doctype html><html><body>' + "x".repeat(60) + "</body></html>\n```");
    expect(out).not.toBeNull();
    expect(out).not.toContain("```");
  });

  it("rejects text too short or with no HTML markers", () => {
    expect(cleanStudioHtml("hi")).toBeNull();
    expect(cleanStudioHtml("x".repeat(100))).toBeNull();
  });

  it("wraps a bare fragment in a document shell when it has no <html>", () => {
    const out = cleanStudioHtml(`<div>${"x".repeat(60)}</div>`);
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).toContain("<!doctype html>");
    expect(out!.toLowerCase()).toContain("<html>");
  });

  it("leaves an already-whole document alone", () => {
    const doc = `<!doctype html><html><body><style>${"x".repeat(60)}</style></body></html>`;
    expect(cleanStudioHtml(doc)).toBe(doc);
  });
});

// ============================================================================
// generate_studio_html
// ============================================================================

describe("generateStudioHtml", () => {
  it("extracts the html field and cleans it", async () => {
    const html = `<!doctype html><html><body>${"y".repeat(60)}</body></html>`;
    const chatStructured = vi.fn(
      async (_model: string, _messages: readonly { content: string }[], _temp: number | null) =>
        JSON.stringify({ html })
    );
    const out = await generateStudioHtml(
      "qwen3.5:4b",
      "You author a page.",
      "Make it nice",
      "My Topic",
      "source text",
      new CancelFlag(),
      chatStructured as never
    );
    expect(out).toBe(html);
    expect(chatStructured).toHaveBeenCalledTimes(1);
    const [model, messages, temp] = chatStructured.mock.calls[0]!;
    expect(model).toBe("qwen3.5:4b");
    expect(temp).toBe(0.4);
    expect(messages[0]!.content).toContain(SELF_CONTAINED_HTML_RULES);
  });

  it("returns null when the model's html field isn't usable HTML", async () => {
    const chatStructured = vi.fn(async () => JSON.stringify({ html: "sorry, I can't" }));
    const out = await generateStudioHtml(
      "qwen3.5:4b",
      "role",
      "instr",
      "label",
      "text",
      new CancelFlag(),
      chatStructured as never
    );
    expect(out).toBeNull();
  });
});

// ============================================================================
// stage_preview_html_core — ported from studios.rs's own eviction test
// ============================================================================

describe("stagePreviewHtmlCore", () => {
  it("drops the OLDEST entry, not the whole store, once full", () => {
    const previews = createHtmlPreviews();
    const tokens: string[] = [];
    for (let i = 0; i < PREVIEW_MAX + 3; i++) {
      tokens.push(stagePreviewHtmlCore(previews, `<p>${i}</p>`));
    }
    expect(previews.map.size).toBe(PREVIEW_MAX);
    expect(previews.map.has(tokens[tokens.length - 1]!)).toBe(true);
    expect(previews.map.has(tokens[0]!)).toBe(false);
  });
});

// ============================================================================
// open_html_in_browser / cleanup sweeps
// ============================================================================

describe("openHtmlInBrowser", () => {
  it("writes the HTML to a temp file named after the (safe-folded) title and opens it", async () => {
    const opened: string[] = [];
    const path_ = await openHtmlInBrowser("My/Deck.html", "<p>hi</p>", async (p) => {
      opened.push(p);
    });
    expect(opened).toEqual([path_]);
    expect(path.basename(path_)).toMatch(/^My Deck-\d+\.html$/);
    expect(statSync(path_).isFile()).toBe(true);
    rmSync(path.dirname(path_), { recursive: true, force: true });
  });

  it("falls back to \"preview\" when no name is given", async () => {
    const p = await openHtmlInBrowser(null, "<p>hi</p>", async () => {});
    expect(path.basename(p)).toMatch(/^preview-\d+\.html$/);
    rmSync(path.dirname(p), { recursive: true, force: true });
  });

  it("wraps an opener failure in the Rust source's own sentence", async () => {
    await expect(
      openHtmlInBrowser("x", "<p>hi</p>", async () => {
        throw new Error("no default browser");
      })
    ).rejects.toThrow("Couldn't open your browser: no default browser");
  });

});

describe("sweepPreviewsOlderThan / cleanupBrowserPreviewsOlderThan", () => {
  it("sweeps a handed-over preview but spares one just opened", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "studios-preview-sweep-"));
    const stale = path.join(dir, "old-1.html");
    const fresh = path.join(dir, "new-1.html");
    writeFileSync(stale, "<p>room content</p>");
    writeFileSync(fresh, "<p>room content</p>");
    const longAgo = new Date(Date.now() - 600_000);
    utimesSync(stale, longAgo, longAgo);

    sweepPreviewsOlderThan(dir, 60_000);

    expect(() => statSync(stale)).toThrow();
    expect(statSync(fresh).isFile()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing (never throws) when the directory was never created", () => {
    expect(() => cleanupBrowserPreviewsOlderThan(60_000)).not.toThrow();
  });

  it("leaves unreadable and non-removable entries alone while continuing the best-effort sweep", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "studios-preview-errors-"));
    const dangling = path.join(dir, "dangling.html");
    const staleDirectory = path.join(dir, "stale-directory.html");
    symlinkSync(path.join(dir, "gone.html"), dangling);
    mkdirSync(staleDirectory);
    const longAgo = new Date(Date.now() - 600_000);
    utimesSync(staleDirectory, longAgo, longAgo);

    expect(() => sweepPreviewsOlderThan(path.join(dir, "missing"), 0)).not.toThrow();
    expect(() => sweepPreviewsOlderThan(dir, 0)).not.toThrow();
    expect(statSync(staleDirectory).isDirectory()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("cleans the startup preview folder without making cleanup failures fatal", () => {
    cleanupBrowserPreviews();
    expect(() => cleanupBrowserPreviews()).not.toThrow();
  });
});

describe("stagePreviewHtmlCore defensive store boundary", () => {
  it("does not loop forever if a malformed full store reports no keys", () => {
    const map = {
      get size(): number {
        return PREVIEW_MAX;
      },
      keys: (): IterableIterator<string> => [][Symbol.iterator](),
      delete: vi.fn(),
      set: vi.fn(),
    } as unknown as Map<string, string>;
    const previews = { next: 0, map } as HtmlPreviews;
    expect(stagePreviewHtmlCore(previews, "<p>safe</p>")).toBe("0");
  });
});

// ============================================================================
// register_studio_cancel
// ============================================================================

describe("registerStudioCancel", () => {
  it("registers the flag and the node under the supplied op id", () => {
    const state = createCancelState();
    const node = registerStudioCancel(state, "op-1", null, "Flashcards");
    expect(state.cancels.get("op-1")).toBe(node.flag());
    expect(nodeFor(state, "op-1")).toBe(node);
  });

  it("is a root when parentRun is null, and does nothing to the registry when opId is null", () => {
    const state = createCancelState();
    const node = registerStudioCancel(state, null, null, "Mind map");
    expect(node.label()).toBe("Mind map");
    expect(state.cancels.size).toBe(0);
  });

  it("becomes a child of the parent run, and inherits an already-cancelled parent", () => {
    const state = createCancelState();
    const parent = registerRun(state, "parent-1", "Parent run");
    parent.cancel();
    const node = registerStudioCancel(state, null, "parent-1", "Podcast script");
    expect(node.cancelled()).toBe(true);
  });
});

// ============================================================================
// resolve_structured_model
// ============================================================================

describe("resolveStructuredModel", () => {
  it("returns the room's explicit external-engine model without calling listModels", async () => {
    const db = freshRoom();
    setSetting(db, "model", "claude-cli");
    const listModels = vi.fn(async () => ["should not be called"]);
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const model = await resolveStructuredModel(rooms, listModels);
    expect(model).toBe("claude-cli");
    expect(listModels).not.toHaveBeenCalled();
  });

  it("returns the room's explicit LOCAL model when it is installed", async () => {
    const db = freshRoom();
    setSetting(db, "model", "qwen3.5:4b");
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const model = await resolveStructuredModel(rooms, async () => ["qwen3.5:4b", "llama3:8b"]);
    expect(model).toBe("qwen3.5:4b");
  });

  it("falls back to the best local default when no explicit model is set", async () => {
    const rooms = fakeRoomSource(null);
    const model = await resolveStructuredModel(rooms, async () => ["qwen3.5:4b"]);
    expect(model).toBe("qwen3.5:4b");
  });

  it("returns null when Ollama has no models installed", async () => {
    const rooms = fakeRoomSource(null);
    expect(await resolveStructuredModel(rooms, async () => [])).toBeNull();
  });

  it("returns null (not a throw) when listModels rejects — the documented fidelity seam", async () => {
    const rooms = fakeRoomSource(null);
    const model = await resolveStructuredModel(rooms, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(model).toBeNull();
  });
});

// ============================================================================
// the shared run_studio / run_studio_core pipeline
// ============================================================================

function testSpec(overrides: Partial<StudioSpec> = {}): StudioSpec {
  return {
    defaultPrompt: "default instruction",
    pageRole: "You author a whole page.",
    workingLabel: "Building it",
    fallbackStep: "Extracting the shape…",
    fallbackSchema: { type: "object", properties: { items: { type: "array" } } },
    fallbackSystem: "fallback system",
    fallbackIntro: "Base it on",
    fallbackTemp: 0.3,
    render: (raw) => `<!doctype html><html><body>rendered:${raw}</body></html>`,
    filenamePrefix: "Test Artifact",
    structuredFirst: false,
    afterSave: undefined,
    ...overrides,
  };
}

function testDeps(rooms: RoomSource, over: Partial<RunStudioDeps> = {}): RunStudioDeps {
  return {
    rooms,
    cancelState: createCancelState(),
    listModels: async () => ["qwen3.5:4b"],
    ...over,
  };
}

describe("runStudioCore / runStudio — the shared pipeline", () => {
  it("authors HTML via the primary path and saves it, room-files-changed/agent-open-file both firing", async () => {
    const db = freshRoom("My Room");
    addFile(db, "src.md", "Source material.");
    const rooms = fakeRoomSource({ db, path: "room.roomai", name: "My Room" });
    const emitted: Array<[string, unknown]> = [];
    const html = `<!doctype html><html><body>${"z".repeat(60)}</body></html>`;
    const chatStructured = vi.fn(async () => JSON.stringify({ html }));
    const deps = testDeps(rooms, { emit: (e, p) => emitted.push([e, p]), chatStructured: chatStructured as never });

    const meta = await runStudio(deps, testSpec(), null, null, null, null, null);

    expect(meta.name).toBe("Test Artifact - My Room.html");
    const stored = getFileMeta(db, meta.id);
    expect(stored.name).toBe(meta.name);
    expect(emitted.some(([e]) => e === "room-files-changed")).toBe(true);
    expect(emitted.some(([e]) => e === "agent-open-file")).toBe(true);
    expect(emitted[0]).toEqual(["studio-step", { step: "Reading the material…", local: true }]);
  });

  it("keeps running when cosmetic Studio events throw", async () => {
    const db = freshRoom("Room");
    addFile(db, "src.md", "text");
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const deps = testDeps(rooms, {
      emit: () => {
        throw new Error("window closed");
      },
      chatStructured: (async () => JSON.stringify({ html: `<!doctype html><html><body>${"e".repeat(60)}</body></html>` })) as never,
    });

    await expect(runStudio(deps, testSpec(), null, null, null, null, null)).resolves.toMatchObject({ name: "Test Artifact - Room.html" });
  });

  it("refuses to save into a room closed after generation but before the artifact commit", async () => {
    const db = freshRoom("Room");
    addFile(db, "src.md", "text");
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const deps = testDeps(rooms, {
      chatStructured: (async () => {
        rooms.set(null);
        return JSON.stringify({ html: `<!doctype html><html><body>${"e".repeat(60)}</body></html>` });
      }) as never,
    });

    await expect(runStudioCore(deps, testSpec(), null, null, null, new CancelFlag(), null)).rejects.toThrow("No room is open.");
  });

  it("commits generated Studio pages through a workspace room's filesystem service", async () => {
    const { db, root, workspace } = freshWorkspaceRoom();
    const source = await workspace.createFile("src.md", Readable.from([Buffer.from("workspace source")]), "upload");
    setFileExtractedText(db, source.fileId, "workspace source");
    const rooms = fakeRoomSource({ db, path: root, name: "Workspace Room", workspace });
    const deps = testDeps(rooms, {
      chatStructured: (async () => JSON.stringify({ html: `<!doctype html><html><body>${"w".repeat(60)}</body></html>` })) as never,
    });

    const meta = await runStudio(deps, testSpec(), null, null, null, null, null);

    expect(statSync(path.join(root, meta.name)).isFile()).toBe(true);
  });

  it("falls back to the structured render when the model's HTML isn't usable", async () => {
    const db = freshRoom("My Room");
    addFile(db, "src.md", "Source material.");
    const rooms = fakeRoomSource({ db, path: "room.roomai", name: "My Room" });
    const calls: string[] = [];
    const chatStructured = vi.fn(async (_model: string, messages: { content: string }[]) => {
      const isPrimary = messages[0]!.content.includes(SELF_CONTAINED_HTML_RULES);
      calls.push(isPrimary ? "primary" : "fallback");
      return isPrimary ? JSON.stringify({ html: "not usable html" }) : JSON.stringify({ items: ["a"] });
    });
    const emitted: Array<[string, unknown]> = [];
    const deps = testDeps(rooms, {
      emit: (e, p) => emitted.push([e, p]),
      chatStructured: chatStructured as never,
    });

    const meta = await runStudio(deps, testSpec(), null, null, null, null, null);

    expect(calls).toEqual(["primary", "fallback"]);
    expect(meta.name).toBe("Test Artifact - My Room.html");
    expect(emitted.some(([e, p]) => e === "studio-step" && (p as { step: string }).step === "Extracting the shape…")).toBe(
      true
    );
  });

  it("throws the room-not-open sentence when no room is open", async () => {
    const rooms = fakeRoomSource(null);
    const deps = testDeps(rooms);
    await expect(runStudio(deps, testSpec(), null, null, null, null, null)).rejects.toThrow("No room is open.");
  });

  it("throws ROLLBACK_BUSY and never even registers a cancel node when the room is rolling back", async () => {
    const rooms: RoomSource = { current: () => null, rollingBack: () => true };
    const state = createCancelState();
    const deps = testDeps(rooms, { cancelState: state });
    await expect(runStudio(deps, testSpec(), null, null, null, null, null)).rejects.toThrow(/rolling back/);
    expect(state.cancelTree.size).toBe(0);
  });

  it("throws \"the local AI isn't running\" when no model resolves", async () => {
    const db = freshRoom();
    addFile(db, "src.md", "text");
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const deps = testDeps(rooms, { listModels: async () => [] });
    await expect(runStudio(deps, testSpec(), null, null, null, null, null)).rejects.toThrow(
      "The local AI (Ollama) isn't running"
    );
  });

  it("refuses with \"the room this job belongs to was closed\" when a pinned room swaps mid-run", async () => {
    const db = freshRoom("Room A");
    addFile(db, "src.md", "text");
    const rooms = fakeRoomSource({ db, path: "room-a.roomai", name: "Room A" });
    const otherDb = freshRoom("Room B");
    const chatStructured = vi.fn(async () => {
      // Simulate the room swapping under the job WHILE the model call is in
      // flight — exactly the window `run_studio_core`'s post-generation pin
      // recheck exists for.
      rooms.set({ db: otherDb, path: "room-b.roomai", name: "Room B" });
      return JSON.stringify({ html: `<!doctype html><html><body>${"q".repeat(60)}</body></html>` });
    });
    const deps = testDeps(rooms, { chatStructured: chatStructured as never });

    await expect(runStudioCore(deps, testSpec(), null, null, null, new CancelFlag(), "room-a.roomai")).rejects.toThrow(
      "the room this job belongs to was closed"
    );
  });

  it("refuses before model work when a pinned job begins in a different room", async () => {
    const db = freshRoom("Room A");
    addFile(db, "src.md", "text");
    const rooms = fakeRoomSource({ db, path: "room-a.roomai", name: "Room A" });
    const listModels = vi.fn(async () => ["qwen3.5:4b"]);
    await expect(runStudioCore(testDeps(rooms, { listModels }), testSpec(), null, null, null, new CancelFlag(), "room-b.roomai")).rejects.toThrow(
      "the room this job belongs to was closed"
    );
    expect(listModels).not.toHaveBeenCalled();
  });

  it("emits the cloud disclosure when the room explicitly selects an external engine", async () => {
    const db = freshRoom("Room");
    addFile(db, "src.md", "text");
    setSetting(db, "model", "claude-cli");
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const emitted: Array<[string, unknown]> = [];
    const deps = testDeps(rooms, {
      emit: (event, payload) => emitted.push([event, payload]),
      chatStructured: (async () => JSON.stringify({ html: `<!doctype html><html><body>${"c".repeat(60)}</body></html>` })) as never,
    });

    await runStudio(deps, testSpec(), null, null, null, null, null);

    expect(emitted).toContainEqual([
      "studio-step",
      { step: "Building it — your cloud AI is writing (content leaves this Mac)…", local: false },
    ]);
  });

  it("throws \"Stopped.\" when cancelled between HTML generation and commit", async () => {
    const db = freshRoom("Room");
    addFile(db, "src.md", "text");
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const cancel = new CancelFlag();
    const chatStructured = vi.fn(async () => {
      cancel.store(true);
      return JSON.stringify({ html: `<!doctype html><html><body>${"q".repeat(60)}</body></html>` });
    });
    const deps = testDeps(rooms, { chatStructured: chatStructured as never });
    await expect(runStudioCore(deps, testSpec(), null, null, null, cancel, null)).rejects.toThrow("Stopped.");
  });

  it("refuses the LAST-look commit guard with the artifact named, once cancelled just before saving", async () => {
    const db = freshRoom("Room");
    addFile(db, "src.md", "text");
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const cancel = new CancelFlag();
    // structuredFirst renders synchronously right after the model call, so
    // flipping the flag inside chatStructured lands exactly between render
    // and the guard_commit check this test targets.
    const chatStructured = vi.fn(async () => {
      cancel.store(true);
      return JSON.stringify({ items: ["a"] });
    });
    const deps = testDeps(rooms, { chatStructured: chatStructured as never });
    const spec = testSpec({ structuredFirst: true });
    await expect(runStudioCore(deps, spec, null, null, null, cancel, null)).rejects.toThrow(
      'Stopped — the studio page was not saved.'
    );
    // Nothing was written.
    expect(db.prepare("SELECT count(*) AS n FROM files WHERE name LIKE 'Test Artifact%'").get()).toEqual({ n: 0 });
  });

  it("structuredFirst: true skips HTML authoring entirely and calls afterSave with the raw JSON", async () => {
    const db = freshRoom("Room");
    addFile(db, "src.md", "text");
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const chatStructured = vi.fn(async () => JSON.stringify({ items: ["a", "b"] }));
    const afterSave = vi.fn();
    const deps = testDeps(rooms, { chatStructured: chatStructured as never });
    const spec = testSpec({ structuredFirst: true, afterSave });

    const meta = await runStudio(deps, spec, null, null, null, null, null);

    expect(chatStructured).toHaveBeenCalledTimes(1); // never tries the HTML-authoring path
    expect(afterSave).toHaveBeenCalledTimes(1);
    const [, fileId, raw] = afterSave.mock.calls[0]!;
    expect(fileId).toBe(meta.id);
    expect(JSON.parse(raw as string)).toEqual({ items: ["a", "b"] });
  });

  it("a failing afterSave hook is logged, not thrown — the page it saved stays saved", async () => {
    const db = freshRoom("Room");
    addFile(db, "src.md", "text");
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const chatStructured = vi.fn(async () => JSON.stringify({ items: ["a"] }));
    const { log, events } = captureLog();
    const deps = testDeps(rooms, { chatStructured: chatStructured as never, log });
    const spec = testSpec({
      structuredFirst: true,
      afterSave: () => {
        throw new Error("db exploded");
      },
    });

    const meta = await runStudio(deps, spec, null, null, null, null, null);

    expect(meta.name).toBe("Test Artifact - Room.html"); // the page IS saved
    expect(events).toContain("studio.structure_not_stored");
  });

  it("uses gatherFilesText and stamps fromFiles when refs are supplied", async () => {
    const db = freshRoom("Room");
    const id = addFile(db, "src.md", "Source material.");
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const chatStructured = vi.fn(async () => JSON.stringify({ html: `<!doctype html><html><body>${"r".repeat(60)}</body></html>` }));
    const deps = testDeps(rooms, { chatStructured: chatStructured as never });

    const meta = await runStudio(deps, testSpec(), null, null, [id], null, null);

    expect(meta.name).toBe("Test Artifact - src.html");
    const row = db.prepare("SELECT provenance FROM files WHERE id = ?").get(meta.id) as
      | { provenance: string | null }
      | undefined;
    expect(row?.provenance).toContain(id);
  });

  // ---------------------------------------------------------- cancel-tree dispose()

  it("disposes its cancel node on every return path — a finished child leaves nothing behind to cancel", async () => {
    const db = freshRoom("Room");
    addFile(db, "src.md", "text");
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const state = createCancelState();
    const parent = registerRun(state, "parent-1", "Parent run");
    const chatStructured = vi.fn(async () => JSON.stringify({ html: `<!doctype html><html><body>${"d".repeat(60)}</body></html>` }));
    const deps = testDeps(rooms, { cancelState: state, chatStructured: chatStructured as never });

    await runStudio(deps, testSpec(), null, null, null, null, "parent-1");

    // If the child had leaked, cancelling the parent AFTER the run finished
    // would still report the child's label as newly-stopped work — a lie
    // about what this Stop actually reached.
    const report = parent.cancel();
    expect(report.stopped).toEqual(["Parent run"]);
  });

  it("disposes its cancel node even when the run throws", async () => {
    const rooms = fakeRoomSource(null); // no room open -> throws immediately
    const state = createCancelState();
    const parent = registerRun(state, "parent-2", "Parent run 2");
    const deps = testDeps(rooms, { cancelState: state });

    await expect(runStudio(deps, testSpec(), null, null, null, null, "parent-2")).rejects.toThrow();

    const report = parent.cancel();
    expect(report.stopped).toEqual(["Parent run 2"]);
  });

  it("removes the flat cancels-map registration for opId on every return path", async () => {
    const rooms = fakeRoomSource(null);
    const state = createCancelState();
    const deps = testDeps(rooms, { cancelState: state });
    await expect(runStudio(deps, testSpec(), null, null, null, "op-x", null)).rejects.toThrow();
    expect(state.cancels.has("op-x")).toBe(false);
    expect(nodeFor(state, "op-x")).toBeUndefined();
  });

  it("makeRunStudio produces the curried (spec, scope, instructions, refs, opId, parentRun) shape", async () => {
    const db = freshRoom("Room");
    addFile(db, "src.md", "text");
    const rooms = fakeRoomSource({ db, path: "p", name: "Room" });
    const chatStructured = vi.fn(async () => JSON.stringify({ html: `<!doctype html><html><body>${"m".repeat(60)}</body></html>` }));
    const deps = testDeps(rooms, { chatStructured: chatStructured as never });
    const run = makeRunStudio(deps);

    const meta = await run(testSpec(), null, null, null, null, null);
    expect(meta.name).toBe("Test Artifact - Room.html");
  });
});

// ============================================================================
// register_studio_cancel + a child of a live parent, verified via childOfRun
// (sanity: studiosCmds.ts's childOfRun usage matches cancel.ts's own contract)
// ============================================================================

describe("registerStudioCancel + childOfRun contract", () => {
  it("a Studio started with no parentRun is its own root, unaffected by an unrelated cancel", () => {
    const state = createCancelState();
    const unrelated = childOfRun(state, null, "Unrelated");
    unrelated.cancel();
    const node = registerStudioCancel(state, null, null, "Flashcards");
    expect(node.cancelled()).toBe(false);
  });
});

// ============================================================================
// studio_spec_for / studio_title
// ============================================================================

describe("studioSpecFor", () => {
  it("returns null for every kind when no factories are registered — honest, not fabricated", () => {
    expect(studioSpecFor("flashcards")).toBeNull();
    expect(studioSpecFor("mindmap")).toBeNull();
    expect(studioSpecFor("podcast")).toBeNull();
  });

  it("returns null for an unknown kind regardless of the registry", () => {
    expect(studioSpecFor("sketch", { flashcards: () => testSpec() })).toBeNull();
  });

  it("calls the registered factory for a known kind", () => {
    const spec = testSpec({ filenamePrefix: "Flashcards" });
    const factory = vi.fn(() => spec);
    expect(studioSpecFor("flashcards", { flashcards: factory })).toBe(spec);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe("studioTitle", () => {
  it("maps every known kind and defaults to \"Studio\"", () => {
    expect(studioTitle("flashcards")).toBe("Flashcards");
    expect(studioTitle("mindmap")).toBe("Mind map");
    expect(studioTitle("podcast")).toBe("Podcast script");
    expect(studioTitle("anything-else")).toBe("Studio");
  });
});

// silence unused-import complaints for types referenced only in annotations
void (null as unknown as HtmlPreviews);

// ============================================================================
// exec_tool's SHARED studio arm — agent.rs ~4299 is ONE arm for all three
// tools, so `resolveStudioRefs`/`execStudio` are one function each, taking the
// spec. (Audit 2026-08-23: they were flashcards-only, and the mind-map and
// podcast arms refused unconditionally even with live deps — see execStudio's
// own doc.)
// ============================================================================

describe("resolveStudioRefs / execStudio — the one shared exec_tool arm", () => {
  function liveDeps(db: Database.Database, name = "Interop Room"): RunStudioDeps {
    return testDeps(fakeRoomSource({ db, path: "interop.roomai", name }), {
      chatStructured: (async (
        _model: string,
        _messages: unknown,
        _temperature: unknown,
        _keepAlive: unknown,
        schema: unknown
      ) => {
        const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
        // Force every artifact onto its own structured path: too short and no
        // markup, so the REAL `cleanStudioHtml` rejects it (this fake never
        // decides that itself).
        if ("html" in props) return JSON.stringify({ html: "nope" });
        if ("cards" in props) return JSON.stringify({ cards: [{ q: "Why?", a: "Because." }] });
        if ("nodes" in props) {
          return JSON.stringify({ root: "Centre", nodes: [{ label: "Branch", parent: "Centre" }] });
        }
        return JSON.stringify({
          title: "Ep",
          hosts: [{ name: "Ada" }, { name: "Bo" }],
          turns: [
            { speaker: "Ada", line: "Welcome in." },
            { speaker: "Bo", line: "Glad to be here." },
          ],
        });
      }) as never,
    });
  }

  it("resolves a file NAME to its id, passes an id through, and refuses only when EVERY name missed", () => {
    const db = freshRoom();
    const id = addFile(db, "clean-code.md", "All about clean code.");
    expect(resolveStudioRefs(db, undefined)).toBeNull();
    expect(resolveStudioRefs(db, [])).toBeNull();
    expect(resolveStudioRefs(db, [id])).toEqual([id]);
    expect(resolveStudioRefs(db, ["clean-code"])).toEqual([id]);
    // A partial match still proceeds with what resolved.
    expect(resolveStudioRefs(db, ["clean-code", "ghost.md"])).toEqual([id]);
    // Every name missed: ONE refusal naming all of them, joined with " or " —
    // `findFileLike`'s own per-fragment message would name only the first.
    expect(() => resolveStudioRefs(db, ["ghost.md", "phantom.md"])).toThrow(
      /No file matching "ghost\.md" or "phantom\.md" in this room\./
    );
  });

  it("drives EVERY real spec — flashcards, mind map AND podcast — through the same arm", async () => {
    // The regression this pins: `execStudio` used to exist only in a
    // flashcards-shaped copy, so a fully-bootstrapped app could build a deck
    // and could NOT build a mind map or a podcast script. Rust has one arm.
    const { flashcardsSpec } = await import("./studiosFlashcards.js");
    const { mindmapSpec } = await import("./studiosMindmap.js");
    const { podcastSpec } = await import("./studiosPodcast.js");
    const db = freshRoom("Interop Room");
    addFile(db, "src.md", "Source material worth studying.");
    const deps = liveDeps(db);

    for (const [spec, expected] of [
      [flashcardsSpec(), "Flashcards - Interop Room.html"],
      [mindmapSpec(), "Mind map - Interop Room.html"],
      [podcastSpec(), "Podcast script - Interop Room.html"],
    ] as const) {
      const reply = await execStudio(deps, spec, null, {});
      expect(reply).toContain(`Saved "${expected}" into the room.`);
      const rawReceipt = reply.split("ARCELLE_ARTIFACT_RECEIPT ")[1];
      expect(rawReceipt).toBeTruthy();
      const receipt = JSON.parse(rawReceipt!);
      expect(receipt.name).toBe(expected);
      expect(receipt.fileId).toBe(fileByExactName(db, expected)?.id);
      expect(receipt.size).toBeGreaterThan(0);
      expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
      // …and the page is really in the room, not just named in a reply.
      expect(fileByExactName(db, expected)?.name).toBe(expected);
    }
    // The podcast's `after_save` hook ran for real against this room's own
    // `podcasts` table — the one spec whose structure has to outlive its page.
    const script = fileByExactName(db, "Podcast script - Interop Room.html");
    const stored = getPodcastRow(db, script!.id);
    expect(stored?.turns.map((t) => t.speaker)).toEqual(["Ada", "Bo"]);
    expect(stored?.cast.map((h) => h.name)).toEqual(["Ada", "Bo"]);
  });

  it("threads parentRun through, so a Stop on the asking run cancels the build it triggered", async () => {
    // Owner replacement #3 — the whole reason the exec_tool arm does not go
    // through the three `parent_run: None` Tauri wrappers.
    const { mindmapSpec } = await import("./studiosMindmap.js");
    const db = freshRoom("Interop Room");
    addFile(db, "src.md", "Source material.");
    const cancelState = createCancelState();
    const run = registerRun(cancelState, "run-7", "the answer");
    const deps = { ...liveDeps(db), cancelState };

    let sawFlagged = false;
    const spec = {
      ...mindmapSpec(),
      render: (raw: string, label: string) => {
        // Stop the PARENT while the child build is mid-flight.
        run.cancel();
        sawFlagged = true;
        return mindmapSpec().render(raw, label);
      },
    };
    await expect(execStudio(deps, spec, "run-7", {})).rejects.toThrow(/studio page/);
    expect(sawFlagged).toBe(true);
    // Nothing was written: the commit guard is what a parent's Stop reaches.
    expect(fileByExactName(db, "Mind map - Interop Room.html")).toBeNull();
  });

  it("times out a stalled Studio model and never writes an artifact", async () => {
    vi.useFakeTimers();
    const { flashcardsSpec } = await import("./studiosFlashcards.js");
    const db = freshRoom("Timeout Room");
    addFile(db, "src.md", "Source material.");
    const deps = testDeps(fakeRoomSource({ db, path: "timeout.roomai", name: "Timeout Room" }), {
      studioTimeoutMs: 50,
      chatStructured: (() => new Promise<string>(() => {})) as never,
    });
    const pending = execStudio(deps, flashcardsSpec(), null, {});
    const rejected = expect(pending).rejects.toThrow("Studio timed out before an artifact was saved");
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    expect(fileByExactName(db, "Flashcards - Timeout Room.html")).toBeNull();
  });

  it("throws 'No room is open.' rather than resolving refs against nothing", async () => {
    const { flashcardsSpec } = await import("./studiosFlashcards.js");
    const deps = testDeps(fakeRoomSource(null));
    await expect(execStudio(deps, flashcardsSpec(), null, { refs: ["x"] })).rejects.toThrow("No room is open.");
  });
});

// ============================================================================
// studioSpecFor — the read-side prototype-pollution guard
// ============================================================================

describe("studioSpecFor: prototype safety", () => {
  it("answers null for a kind nobody registered, even on a polluted Object.prototype", () => {
    // `factories[kind]` is a plain member read on an object literal whose
    // default is `{}`, and `kind` is a stored job-plan string. With
    // `Object.prototype.mindmap` set, this used to hand back a FABRICATED
    // spec on a registry that genuinely had none — the same read-side hole
    // `jsonTools.ts`'s `ownValue` doc records for `jsonStrField(reply,
    // "html")`. Rust's `match kind {...}` has no such surface.
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.mindmap = () => testSpec({ filenamePrefix: "FABRICATED" });
    try {
      expect(studioSpecFor("mindmap")).toBeNull();
      expect(studioSpecFor("mindmap", {})).toBeNull();
      // A genuinely registered factory still wins.
      expect(studioSpecFor("mindmap", { mindmap: () => testSpec({ filenamePrefix: "Real" }) })?.filenamePrefix).toBe(
        "Real"
      );
    } finally {
      delete proto.mindmap;
    }
  });
});

describe("openHtmlInBrowser filesystem failures", () => {
  it("reports distinct preview-folder and preview-file errors", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return { ...actual, mkdir: async () => Promise.reject(new Error("mkdir denied")) };
    });
    try {
      const isolated = await import("./studiosCmds.js");
      await expect(isolated.openHtmlInBrowser("x", "<p>hi</p>", async () => {})).rejects.toThrow(
        "Couldn't create the preview folder: mkdir denied"
      );
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return { ...actual, writeFile: async () => Promise.reject(new Error("disk full")) };
    });
    try {
      const isolated = await import("./studiosCmds.js");
      await expect(isolated.openHtmlInBrowser("x", "<p>hi</p>", async () => {})).rejects.toThrow(
        "Couldn't write the preview file: disk full"
      );
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      rmSync(path.join(os.tmpdir(), "arcelle-preview"), { recursive: true, force: true });
    }
  });
});

describe("studiosCmds OS and receipt boundaries", () => {
  it("waits for the mocked operating-system browser launch without spawning a real browser", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: () => {
          const child = new EventEmitter();
          queueMicrotask(() => child.emit("spawn"));
          return child;
        },
      };
    });
    try {
      const isolated = await import("./studiosCmds.js");
      const filePath = await isolated.openHtmlInBrowser("system-open", "<p>hi</p>");
      expect(path.basename(filePath)).toMatch(/^system-open-\d+\.html$/);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
      rmSync(path.join(os.tmpdir(), "arcelle-preview"), { recursive: true, force: true });
    }
  });

  it("keeps startup preview cleanup best-effort when the filesystem refuses removal", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return { ...actual, rmSync: () => { throw new Error("permission denied"); } };
    });
    try {
      const isolated = await import("./studiosCmds.js");
      expect(() => isolated.cleanupBrowserPreviews()).not.toThrow();
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("refuses a Studio success whose saved artifact cannot be reopened for its receipt", async () => {
    vi.resetModules();
    vi.doMock("./workspace/roomContent.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./workspace/roomContent.js")>();
      return {
        ...actual,
        readRoomFile: async () => ({ bytes: null }),
      };
    });
    try {
      const isolated = await import("./studiosCmds.js");
      const db = freshRoom("Receipt Room");
      addFile(db, "src.md", "text");
      const rooms = fakeRoomSource({ db, path: "receipt.roomai", name: "Receipt Room" });
      const deps = testDeps(rooms, {
        chatStructured: (async () => JSON.stringify({ html: `<!doctype html><html><body>${"r".repeat(60)}</body></html>` })) as never,
      });
      await expect(isolated.execStudio(deps, testSpec(), null, {})).rejects.toThrow(
        'Studio artifact "Test Artifact - Receipt Room.html" could not be verified after it was saved.'
      );
    } finally {
      vi.doUnmock("./workspace/roomContent.js");
      vi.resetModules();
    }
  });
});
