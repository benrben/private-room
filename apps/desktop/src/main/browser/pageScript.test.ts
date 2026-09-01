// Contract tests for the agent page script.
//
// Direct port of the `PAGE_JS.contains(...)` tests in src-tauri/src/browser.rs
// (`page_script_exposes_the_bridge_contract`,
// `the_page_script_reports_what_the_rust_side_reads_off_it`,
// `the_page_script_identifies_its_document_so_a_navigation_is_not_a_failure`).
// These pin names the HOST side reads by name: a rename on either side breaks
// the whole browser and would only show at runtime as "page isn't ready".
//
// Kept as string scans on purpose, exactly like the originals. See
// pageScript.behavior.test.ts for the real-execution tests that cover what a
// string scan cannot.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAGE_SCRIPT_FILES, PAGE_SCRIPT_PATH, PAGE_SCRIPT_PATHS } from "./pageScript.js";
import { READY_JS, buildCallJs } from "./evalBridge.js";

const PAGE_JS = PAGE_SCRIPT_PATHS.map((scriptPath) => readFileSync(scriptPath, "utf8")).join("\n");

describe("page_script_exposes_the_bridge_contract", () => {
  it("is where pageScript.ts says it is", () => {
    expect(PAGE_SCRIPT_PATHS.every(existsSync)).toBe(true);
    expect(PAGE_SCRIPT_PATHS.at(-1)).toBe(PAGE_SCRIPT_PATH);
  });

  it("exposes the call entry point and every op the bridge dispatches", () => {
    expect(PAGE_JS).toContain("window.__arcelleBrowse");
    expect(PAGE_JS).toContain("call: call");
    for (const op of ['"snapshot"', '"read"', '"find"', '"begin"', '"take"', '"info"']) {
      expect(PAGE_JS, `page script is missing op ${op}`).toContain(op);
    }
  });

  it("is reached by the exact property name the bridge's own expressions use", () => {
    // Both halves of the contract, read off the code that will actually run
    // rather than restated here — a rename that missed one side fails HERE
    // rather than on a live page.
    expect(buildCallJs("snapshot", {})).toContain("window.__arcelleBrowse.call");
    expect(READY_JS).toContain("window.__arcelleBrowse");
    expect(READY_JS).toContain("!window.__arcelleSuperseded");
    expect(READY_JS).toContain('"ping"');
  });
});

describe("the_page_script_reports_what_the_rust_side_reads_off_it", () => {
  it("reports a continuation offset in its own (UTF-16) units", () => {
    // Recounting by Unicode CODE POINT on the reading side disagreed with
    // JavaScript's UTF-16 code units by one per emoji, and the next chunk
    // repeated text already read.
    expect(PAGE_JS).toContain("nextOffset:");
    // …and it must not cut a surrogate pair in half.
    expect(PAGE_JS).toContain("isHighSurrogate");
    expect(PAGE_JS).toContain("isLowSurrogate");
  });

  it("counts the video/3D areas a screenshot returns blank", () => {
    expect(PAGE_JS).toContain("mediaAreas: mediaAreas()");
  });

  it("has find() reuse the CURRENT numbering rather than re-snapshotting", () => {
    // A snapshot clears every mark and bumps the generation; re-scanning inside
    // the cheap lookup would silently invalidate every ref the model was just
    // handed.
    expect(PAGE_JS).toContain("currentElements");
  });
});

describe("the_page_script_identifies_its_document_so_a_navigation_is_not_a_failure", () => {
  it("carries a per-document nonce and reports it on info()", () => {
    expect(PAGE_JS).toContain("var DOC_ID");
    expect(PAGE_JS).toContain("doc: DOC_ID");
    // Per-DOCUMENT, not a module constant a new document would reuse.
    expect(PAGE_JS).toContain("Math.random()");
  });

  it("still reports a missing ticket as an error — the guard DOC_ID protects", () => {
    expect(PAGE_JS).toContain("Unknown ticket");
  });
});

describe("the Electron export footer — this port's one adaptation to the file", () => {
  it("bridges call() into the main world when running as a real preload", () => {
    // A preload runs in an ISOLATED world under contextIsolation, so a bare
    // assignment would publish the bridge somewhere the host's main-world
    // executeJavaScript could never see it.
    expect(PAGE_JS).toContain('require("electron").contextBridge.exposeInMainWorld("__arcelleBrowse"');
  });

  it("still falls back to a plain window export, which is what the harness takes", () => {
    expect(PAGE_JS).toContain("window.__arcelleBrowse = api;");
  });

  it("does NOT carry the wry-specific window.open workaround", () => {
    // NO_POPUPS_JS existed because wry had no new-window handler at all.
    // popup.ts replaces it with setWindowOpenHandler, which covers strictly
    // more; carrying both would mean two things fighting over one click.
    expect(PAGE_JS).not.toContain("__arcelleInPlace");
    expect(PAGE_JS).not.toContain("window.open = function");
  });
});

describe("the ordered preload assembly", () => {
  it("initializes one private scope and exposes the public bridge only from the final fragment", () => {
    expect(PAGE_SCRIPT_FILES).toEqual([
      "pageCore.js",
      "pageSnapshot.js",
      "pageRead.js",
      "pageActions.js",
      "page.js",
    ]);

    const fragments = PAGE_SCRIPT_PATHS.map((scriptPath) => readFileSync(scriptPath, "utf8"));
    expect(fragments[0]).toContain("var scope = {};");
    expect(fragments[0]).toContain("window.__arcellePageScope = scope;");
    for (const fragment of fragments.slice(1)) {
      expect(fragment).toContain("var scope = window.__arcellePageScope;");
      expect(fragment).toContain("if (!scope) return;");
    }
    for (const fragment of fragments.slice(0, -1)) {
      expect(fragment).not.toContain('require("electron").contextBridge.exposeInMainWorld');
    }
    expect(fragments.at(-1)).toContain('require("electron").contextBridge.exposeInMainWorld');
  });
});
