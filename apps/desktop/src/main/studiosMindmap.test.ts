/**
 * Tests for `studiosMindmap.ts` — the port of
 * `src-tauri/src/commands/studios/mindmap.rs`.
 *
 * `mindmap_html_is_static_nested_details_and_tolerates_a_cycle` ports the
 * Rust file's own `#[cfg(test)] mod tests` case verbatim (same fixture, same
 * assertions). `fillTemplate` gets its own direct coverage porting
 * `studios.rs`'s two `fill_template` unit tests
 * (`fill_template_never_rescans_what_it_substituted`,
 * `fill_template_fills_every_occurrence_and_leaves_unknown_slots`) — that
 * module has no Electron port of its own yet (see this file's own module
 * doc), so this is the only place either gets exercised on the TS side.
 *
 * NO FIXTURE ROOM/DB HERE, DELIBERATELY: `mindmap.rs` itself never touches
 * `Connection` — every function it declares (`MindNode`, `mindmap_spec`,
 * `fallback_mindmap`, `render_mindmap_html`) is pure, taking only strings and
 * already-parsed data. The DB-reading half of the real pipeline
 * (`gather_scope_text`/`gather_files_text`) lives in the unported
 * `studios.rs`, not here — see this file's own module doc. A fixture room
 * would only be theatre for a file this module never calls.
 */

import { describe, expect, it } from "vitest";
import {
  fallbackMindmap,
  fillTemplate,
  mindmapSpec,
  MINDMAP_TEMPLATE,
  renderMindmapHtml,
  RUN_STUDIO_NOT_IMPLEMENTED,
  RUN_STUDIO_PIPELINE_GAP,
  runStudioNotImplemented,
  STUDIO_MINDMAP_PROMPT,
  studioMindmap,
  type MindNode,
  type RunStudioFn,
  type StudioSpec,
} from "./studiosMindmap.js";
import type { FileMeta } from "./db-host/files.js";

// ============================================================================
// fillTemplate — studios.rs's own two unit tests, ported directly
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
// renderMindmapHtml — mindmap.rs's own test, ported verbatim, plus more
// ============================================================================

describe("renderMindmapHtml", () => {
  it("builds a static nested <details> tree and tolerates a cycle", () => {
    // D5: the tree is static <details>/<summary> (native disclosure, no JS)
    // and tolerates a cycle without recursing forever.
    const nodes: MindNode[] = [
      { label: "Child A", parent: "Root" },
      { label: "Grandchild", parent: "Child A" },
      { label: "Child B", parent: "" }, // empty parent -> root
      // a self-referential cycle must not hang
      { label: "Loop", parent: "Loop" },
    ];
    const html = renderMindmapHtml("My Map", "Root", nodes);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("<script");
    expect(html).toContain("<details");
    expect(html).toContain("<summary>Root</summary>");
    expect(html).toContain("Child A");
    expect(html).toContain("Grandchild");
    expect(html).toContain("Child B");
  });

  it("nests a grandchild inside its parent's own <details>, not as a root sibling", () => {
    const nodes: MindNode[] = [
      { label: "Child A", parent: "Root" },
      { label: "Grandchild", parent: "Child A" },
    ];
    const html = renderMindmapHtml("Map", "Root", nodes);
    const childAAt = html.indexOf("<summary>Child A</summary>");
    const grandchildAt = html.indexOf("Grandchild");
    const childADetailsClose = html.indexOf("</details>", childAAt);
    expect(childAAt).toBeGreaterThan(-1);
    expect(grandchildAt).toBeGreaterThan(childAAt);
    expect(grandchildAt).toBeLessThan(childADetailsClose);
  });

  it("real two-node cycles (not just a self-loop) terminate via the seen-set guard", () => {
    // A -> B -> A: a genuine cycle reachable from the root, distinct from
    // mindmap.rs's own self-referential-label test case.
    const nodes: MindNode[] = [
      { label: "A", parent: "Root" },
      { label: "B", parent: "A" },
      { label: "A", parent: "B" },
    ];
    const html = renderMindmapHtml("Map", "Root", nodes);
    // The second "A" (as a child of B) hits the seen-set guard and renders
    // as a leaf instead of recursing into "B" again.
    expect(html).toContain('<span class="leaf">A</span>');
    // The exact tree fragment, not just the whole page (which also carries
    // ~13KB of fixed NOTEBOOK_CSS/page chrome, so an absolute length bound on
    // the full document would not actually prove anything about recursion).
    expect(html).toContain(
      '<ul class="tree"><li><details open><summary>Root</summary><ul><li><details open>' +
        '<summary>A</summary><ul><li><details><summary>B</summary><ul><li>' +
        '<span class="leaf">A</span></li></ul></details></li></ul></details></li></ul></details></li></ul>'
    );
  });

  it("caps recursion past depth 8 without hanging", () => {
    // A chain 10 nodes deep: root(0) -> n0(1) -> n1(2) -> ... -> n8(9) -> n9(10).
    const nodes: MindNode[] = [];
    let parent = "Root";
    for (let i = 0; i < 10; i++) {
      nodes.push({ label: `n${i}`, parent });
      parent = `n${i}`;
    }
    const html = renderMindmapHtml("Deep", "Root", nodes);
    // n8 sits at depth 9 (> 8), so it is cut off as a leaf before its own
    // children are ever looked at — n9 (depth 10) never appears at all.
    expect(html).toContain('<span class="leaf">n8</span>');
    expect(html).not.toContain("n9");
  });

  it("escapes labels — a model-authored label is never live HTML", () => {
    const nodes: MindNode[] = [{ label: '<img src=x onerror=alert(1)>&"', parent: "Root" }];
    const html = renderMindmapHtml("Map", "Root", nodes);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&amp;&quot;");
  });

  it("a childless node renders as a leaf span, not an empty <details>", () => {
    const html = renderMindmapHtml("Map", "Root", []);
    // The exact tree fragment — not a bare `not.toContain("<details")` over
    // the WHOLE page, which would also match the CSS's own explanatory
    // comment ("render_mindmap_html emits <li><details><summary>…") baked
    // into every page regardless of what the tree actually renders.
    expect(html).toContain('<ul class="tree"><li><span class="leaf">Root</span></li></ul>');
  });

  it("opens the root and its first ring by default, but not deeper branches", () => {
    const nodes: MindNode[] = [
      { label: "Branch", parent: "Root" },
      { label: "Twig", parent: "Branch" }, // depth 2 — has its own child, so it renders <details>
      { label: "Leaflet", parent: "Twig" },
    ];
    const html = renderMindmapHtml("Map", "Root", nodes);
    expect(html).toContain('<details open><summary>Root</summary>');
    expect(html).toContain('<details open><summary>Branch</summary>');
    // depth 2 ("Twig") has children too but is NOT auto-opened.
    expect(html).toContain('<details><summary>Twig</summary>');
  });

  it("fills __NOTEBOOK__/__TITLE__/__TREE__ into MINDMAP_TEMPLATE with no leftover slots", () => {
    const html = renderMindmapHtml("Weekly Plan", "Root", [{ label: "A", parent: "Root" }]);
    expect(html).not.toContain("__NOTEBOOK__");
    expect(html).not.toContain("__TITLE__");
    expect(html).not.toContain("__TREE__");
    expect(html).toContain("<title>Weekly Plan — Mind map</title>");
    expect(html).toContain("<h1>Weekly Plan</h1>");
    // The notebook's design tokens landed for real, not as a placeholder.
    expect(html).toContain(":root{");
  });

  it("MINDMAP_TEMPLATE itself declares exactly the three slots renderMindmapHtml fills", () => {
    expect(MINDMAP_TEMPLATE).toContain("__NOTEBOOK__");
    expect(MINDMAP_TEMPLATE).toContain("__TITLE__");
    expect(MINDMAP_TEMPLATE).toContain("__TREE__");
  });
});

// ============================================================================
// fallbackMindmap — parses the model's structured JSON
// ============================================================================

describe("fallbackMindmap", () => {
  it("uses the model's own root when it gave one", () => {
    const raw = JSON.stringify({ root: "Custom Root", nodes: [{ label: "A", parent: "Custom Root" }] });
    const html = fallbackMindmap(raw, "Scope Label");
    expect(html).toContain("<summary>Custom Root</summary>");
  });

  it("defaults the root to the trimmed scope label when the model omits it", () => {
    const raw = JSON.stringify({ nodes: [{ label: "A", parent: "" }] });
    const html = fallbackMindmap(raw, "  Scope Label  ");
    expect(html).toContain("<summary>Scope Label</summary>");
  });

  it("defaults the root to the scope label when the model sent an empty string", () => {
    const raw = JSON.stringify({ root: "", nodes: [{ label: "A", parent: "" }] });
    const html = fallbackMindmap(raw, "Scope Label");
    expect(html).toContain("<summary>Scope Label</summary>");
  });

  it("drops a node with no usable label", () => {
    const raw = JSON.stringify({
      root: "Root",
      nodes: [
        { label: "  ", parent: "Root" }, // whitespace-only -> filtered
        { label: "Kept", parent: "Root" },
      ],
    });
    const html = fallbackMindmap(raw, "Label");
    expect(html).toContain("Kept");
    expect(html.match(/class="leaf"/g)?.length).toBe(1);
  });

  it("throws when the model returned no usable nodes", () => {
    const raw = JSON.stringify({ root: "Root", nodes: [] });
    expect(() => fallbackMindmap(raw, "Label")).toThrow(
      "The model didn't return a usable mind map — try a different file."
    );
  });

  it("throws the same way on a non-JSON reply", () => {
    expect(() => fallbackMindmap("sorry, I can't do that", "Label")).toThrow(
      "The model didn't return a usable mind map — try a different file."
    );
  });
});

// ============================================================================
// mindmapSpec — the artifact spec, field for field against mindmap.rs
// ============================================================================

describe("mindmapSpec", () => {
  const spec: StudioSpec = mindmapSpec();

  it("matches STUDIO_MINDMAP_PROMPT for its default instruction", () => {
    expect(spec.defaultPrompt).toBe(STUDIO_MINDMAP_PROMPT);
    expect(STUDIO_MINDMAP_PROMPT).toBe("Build a mind map: one central topic and a short tree of the key ideas.");
  });

  it("carries the exact page_role prose from mindmap.rs", () => {
    expect(spec.pageRole).toBe(
      "You are a front-end developer building an interactive mind-map page. Draw one " +
        "central topic with a tree of branches; let the reader expand and collapse nodes by clicking, " +
        "and gently pan the canvas if you can. Keep labels short. Base it only on the provided material."
    );
  });

  it("carries the exact working/fallback-step/fallback-system/fallback-intro/filename-prefix strings", () => {
    expect(spec.workingLabel).toBe("Drawing your mind map");
    expect(spec.fallbackStep).toBe("Extracting the topic tree…");
    expect(spec.fallbackSystem).toBe(
      "You organize material into a mind map: one central root topic and a tree of nodes, " +
        "each naming its parent (the root, or another node's exact label). Keep labels short. " +
        "Base it only on the provided text."
    );
    expect(spec.fallbackIntro).toBe("Base it only on this material about");
    expect(spec.filenamePrefix).toBe("Mind map");
  });

  it("uses fallback temperature 0.3 and never runs the structured path first", () => {
    expect(spec.fallbackTemp).toBe(0.3);
    expect(spec.structuredFirst).toBe(false);
    expect(spec.afterSave).toBeUndefined();
  });

  it("renders through fallbackMindmap itself, not a look-alike copy", () => {
    expect(spec.render).toBe(fallbackMindmap);
  });

  it("declares the fallback schema mindmap.rs's serde_json::json! literal describes", () => {
    expect(spec.fallbackSchema).toEqual({
      type: "object",
      properties: {
        root: { type: "string" },
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              parent: { type: "string" },
            },
            required: ["label", "parent"],
          },
        },
      },
      required: ["root", "nodes"],
    });
  });

  it("is a FACTORY — two calls return independent objects, not aliases", () => {
    // The Rust source's own comment on `studio_tools_specs` explains why this
    // matters for the three studio specs sharing a mutable-in-place schema
    // transform; mindmap_spec is a plain fn returning a fresh struct in Rust,
    // so the TS port must not memoize/share the object either.
    const a = mindmapSpec();
    const b = mindmapSpec();
    expect(a).not.toBe(b);
    expect(a.fallbackSchema).not.toBe(b.fallbackSchema);
  });
});

// ============================================================================
// studioMindmap — the Tauri command's shape, as an injectable seam
// ============================================================================

describe("studioMindmap", () => {
  it("refuses honestly when no runStudio pipeline is wired", async () => {
    await expect(studioMindmap(null, null, null, null)).rejects.toThrow(RUN_STUDIO_NOT_IMPLEMENTED);
  });

  it("the default seam's rejection matches runStudioNotImplemented directly", async () => {
    await expect(runStudioNotImplemented(mindmapSpec(), null, null, null, null, null)).rejects.toThrow(
      RUN_STUDIO_NOT_IMPLEMENTED
    );
  });

  it("the exported gap message names both what is real and what is missing", () => {
    expect(RUN_STUDIO_PIPELINE_GAP).toContain("studios.rs's shared run_studio pipeline");
    expect(RUN_STUDIO_PIPELINE_GAP).toContain("IS ported and tested");
    expect(RUN_STUDIO_NOT_IMPLEMENTED).toBe(`NOT_IMPLEMENTED: ${RUN_STUDIO_PIPELINE_GAP}`);
  });

  it("calls an injected runStudio with mindmap_spec(), the given args, and parentRun always null", async () => {
    const fakeMeta: FileMeta = {
      id: "file-1",
      name: "Mind map - Q3 plan.html",
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

    const meta = await studioMindmap("file-abc", "Focus on Q3", ["file-1", "file-2"], "op-9", fakeRunStudio);

    expect(meta).toBe(fakeMeta);
    expect(calls).toHaveLength(1);
    const [spec, scope, instructions, refs, opId, parentRun] = calls[0]!;
    expect((spec as StudioSpec).filenamePrefix).toBe("Mind map");
    expect(scope).toBe("file-abc");
    expect(instructions).toBe("Focus on Q3");
    expect(refs).toEqual(["file-1", "file-2"]);
    expect(opId).toBe("op-9");
    // Owner replacement #3: a Studio button in the UI is its own root,
    // nobody's child — studio_mindmap hard-codes None/null here always. An
    // agent-triggered build must call runStudio directly with its own
    // parentRun instead of going through this wrapper (see this file's
    // module doc).
    expect(parentRun).toBeNull();
  });
});

// ============================================================================
// adversarial: the `seen` set is the CURRENT DFS PATH, not every label visited
// ============================================================================

describe("renderMindmapHtml: adversarial tree shapes", () => {
  it("a DIAMOND renders its shared child in FULL under both parents", () => {
    // Rust's guard is `!seen.insert(label)` on the way down and
    // `seen.remove(label)` on the way back up — a PATH set. A port that kept
    // one global visited-set would collapse the second occurrence of a shared
    // label to a bare `<span class="leaf">`, silently dropping that whole
    // subtree from the map, and every existing cycle test would still pass
    // because a cycle looks identical to a re-visit from the outside.
    const html = renderMindmapHtml("Map", "Root", [
      { label: "Left", parent: "Root" },
      { label: "Right", parent: "Root" },
      { label: "Shared", parent: "Left" },
      { label: "Shared", parent: "Right" },
      { label: "Detail", parent: "Shared" },
    ]);
    // "Shared" opens a <details> (it has a child) under BOTH branches…
    expect(html.match(/<summary>Shared<\/summary>/g)).toHaveLength(2);
    // …and its own child is reachable through both, not just the first.
    expect(html.match(/<span class="leaf">Detail<\/span>/g)).toHaveLength(2);
    expect(html).not.toContain('<span class="leaf">Shared</span>');
  });

  it("a three-node cycle that does NOT pass through the root still terminates", () => {
    // A -> B -> C -> A, hung off the root. The self-loop case mindmap.rs
    // tests never exercises the `seen.remove` half at all.
    const html = renderMindmapHtml("Map", "Root", [
      { label: "A", parent: "Root" },
      { label: "B", parent: "A" },
      { label: "C", parent: "B" },
      { label: "A", parent: "C" },
    ]);
    // The cycle closes on a leaf rather than recursing: A appears as a
    // <summary> on the way down and as a leaf where it would have repeated.
    expect(html).toContain("<summary>A</summary>");
    expect(html).toContain('<span class="leaf">A</span>');
    expect(html).toContain("<summary>B</summary>");
    expect(html).toContain("<summary>C</summary>");
  });

  it("a node naming the ROOT as its own parent is never wired as the root's child", () => {
    // `if n.label != parent` — a model that echoes the root back as a node
    // would otherwise put the root inside itself.
    const html = renderMindmapHtml("Map", "Root", [{ label: "Root", parent: "" }]);
    expect(html).toContain('<ul class="tree"><li><span class="leaf">Root</span></li></ul>');
    // The rendered TREE holds no disclosure at all (the <style> block's own
    // prose mentions the tag, so the whole page is the wrong thing to scan).
    const tree = html.slice(html.indexOf('<ul class="tree"'));
    expect(tree).not.toContain("<details");
  });
});

// ============================================================================
// mindmapSpec through the REAL shared pipeline
// ============================================================================

describe("mindmapSpec drives studiosCmds.ts's real runStudio pipeline", () => {
  it("saves a real, collapsible mind-map page into a real room via the structured fallback", async () => {
    // The spec was only ever asserted field-by-field before. This proves it is
    // actually RUNNABLE by the shared pipeline — the seam where a spec that
    // type-checks can still be wired wrong (a render that throws on the shape
    // its own fallbackSchema asks for, a filenamePrefix that does not survive
    // safeScopeName, an afterSave the pipeline would call with the wrong db).
    const { mkdtempSync, rmSync } = await import("node:fs");
    const os = (await import("node:os")).default;
    const path = (await import("node:path")).default;
    const { randomUUID } = await import("node:crypto");
    const { createRoom } = await import("./db-host/open.js");
    const { insertFile, fileByExactName, getFileBytes } = await import("./db-host/files.js");
    const { createCancelState } = await import("./cancel.js");
    const { runStudio } = await import("./studiosCmds.js");

    const dir = mkdtempSync(path.join(os.tmpdir(), "studios-mindmap-e2e-"));
    const roomPath = path.join(dir, `t-${randomUUID()}.roomai`);
    const db = createRoom(roomPath, "correct horse battery staple", "Map Room");
    try {
      insertFile(db, "src.md", "text/markdown", Buffer.from("m"), "Material about clean code.", "upload");
      const meta = await runStudio(
        {
          rooms: { current: () => ({ db, path: roomPath, name: "Map Room" }) },
          cancelState: createCancelState(),
          listModels: async () => ["qwen3.5:4b"],
          chatStructured: (async (_m: string, _msgs: unknown, _t: unknown, _k: unknown, schema: unknown) => {
            const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
            // Unusable HTML pushes the pipeline onto the structured fallback —
            // the real `cleanStudioHtml` makes that call, not this fake.
            return "html" in props
              ? JSON.stringify({ html: "no" })
              : JSON.stringify({
                  root: "Clean code",
                  nodes: [
                    { label: "Naming", parent: "Clean code" },
                    { label: "Intention-revealing", parent: "Naming" },
                  ],
                });
          }) as never,
        },
        mindmapSpec(),
        null,
        null,
        null,
        null,
        null
      );
      expect(meta.name).toBe("Mind map - Map Room.html");
      expect(fileByExactName(db, meta.name)?.id).toBe(meta.id);
      const raw = getFileBytes(db, meta.id);
      expect(raw).not.toBeNull();
      const page = Buffer.from(raw!).toString("utf8");
      expect(page).toContain("<summary>Clean code</summary>");
      expect(page).toContain("<summary>Naming</summary>");
      expect(page).toContain('<span class="leaf">Intention-revealing</span>');
      expect(page).not.toContain("__TREE__");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
