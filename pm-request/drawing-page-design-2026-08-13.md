# Sketch page + drawing agent — design changes (research only, nothing built)

**Date:** 2026-08-13 · **Status:** proposal, not green-lit
**Ask:** a new page where humans draw on a canvas, plus an agent that can read and draw on the same canvas, with an SVG-in-JSON document format that is cheap for an LLM to read and write.

Research inputs: full code map of the Create-page precedent (`df554d5`), the agent-hub registry, the shell/design-system/persistence layers, and web research on canvas libraries, licenses, and LLM-canvas prior art (all findings inlined below with sources).

---

## 1. Decisions at a glance

| Question | Decision | Why |
|---|---|---|
| Canvas engine | **Build it ourselves on SVG + React** (no tldraw, no Excalidraw embed) | tldraw SDK ≥4.0 is a paid commercial license with production key enforcement — unusable. Excalidraw is MIT but a huge bundle with CDN-font gotchas and its own store format that fights ours. The app already renders everything as SVG/DOM and has a clean pan/zoom hook to reuse. |
| Freehand strokes | **perfect-freehand** (MIT, zero deps, active) + **simplify-js** (BSD) for point reduction | The standard pipeline: input points → variable-width outline → one filled SVG path. RDP-simplify the *input* points for storage/tokens, not the outline. |
| Shape rendering | **rough.js** (MIT, <9 kB gz) with a **fixed seed per element id** | Hand-drawn look matches the notebook design system exactly, and a fixed seed honors the house rule "a box draws identically on every render" (`tokens.css:243-250`). Dormant-but-finished library; Excalidraw ships it in production. |
| Document format | **Typed elements in JSON, rendered to SVG deterministically; raw-SVG fragments only as a sanitized escape hatch** | Evidence (SVGenius, SVGEditBench v2) says LLMs collapse on raw `<path>` grammar. tldraw's agent kit and Excalidraw's AI both converged on high-level typed ops with rounded integer coordinates. SVG stays the render/export format, per the original idea — it's just not the *authoring* format for the model. |
| Storage | **A room file** (new `.sketch` kind in the `files` table), **no new DB tables** | Gets trash/restore, `file_versions` snapshots on every write, provenance, tabs, Library listing, search (via `extracted_text`) and the `roommedia://` delivery path for free. No schema migration risk. The story-tables precedent exists for cross-referencing docs; a drawing is just a document. |
| Agent placement | **Sibling worker in the `file` domain** (`creator.draw`), *not* a 7th domain | The hub hard-caps domains at 6 (`agents.py:1192-1195`) — the local 4B picks reliably among no more. House precedent for exactly this: `chat.browse` under `ask_web_agent`, `scripts.run` under `ask_file_agent`. Direct access via a `*sketch` tag. |
| Agent write surface | 3 tools: `read_drawing`, `edit_drawing` (add/update/delete ops), `create_drawing` | Small boxes win (`MAX_BOX_TOOLS = 7`); tiered reads keep tokens down; server assigns ids; integer coords. |
| Page name | Area key `sketch`, rail label **"Sketch"**, in the **Capture** rail group next to Create | The viewer registry already calls the svg kind "drawing"; "Sketch" avoids colliding with "Memory & scratch pad" wording. CSS prefix `.sk-`. |

---

## 2. What the research established

### 2.1 Library landscape (web, verified 2026-08-13)

- **tldraw — out.** Since SDK 4.0 (Sept 2025) the license is source-available, free in *development environments only*; production needs a paid key (client-side validated, works offline — but paid, custom pricing, ~$6k/yr secondhand figure). Pinning Apache-licensed 3.x is legal but a dead end.
- **Excalidraw — viable fallback, not chosen.** MIT, React 19 OK. Costs: ~47 MB unpacked package, fonts fetched from CDN unless `window.EXCALIDRAW_ASSET_PATH` is self-hosted, needs a network audit for telemetry, and its element store would fight our SVG-in-JSON document. Its **ExcalidrawElementSkeleton** DSL (`type/x/y/width/height/label/start/end`, ids and bindings auto-computed) is the best published analogue for our agent ops schema — we copy the shape of it, not the code.
- **perfect-freehand — in.** MIT, v1.2.3, zero deps, ~kB-scale, active (Apr 2026). Key options: `size`, `thinning`, `streamline`, `smoothing`, `simulatePressure` (velocity-based pressure — important because real pressure doesn't reach us, see 2.3).
- **rough.js — in.** MIT, <9 kB gz, renders to SVG, seedable for deterministic wobble. Last push July 2024 — effectively finished software; if it ever breaks we vendor it.
- **simplify-js — in.** BSD, radial-distance + Ramer-Douglas-Peucker. Practice: tolerance ~0.2–0.5 px (world units) on the raw input points before smoothing.
- **DOMPurify — optional.** MPL-2.0/Apache-2.0 dual. For our narrow case (validating fragments we asked a model to produce) a **strict allowlist parser that rejects rather than strips** is the stronger posture; reject-and-retry also teaches the agent (see 5.4).

### 2.2 LLM-canvas prior art → the ops-not-paths rule

- tldraw "Make Real" sends a **PNG screenshot**, not shapes — a VLM pattern we explicitly avoid (privacy + cost).
- The **tldraw agent starter kit** (their current AI story) converts the store to tiered simplified JSON — bounds+id+type+text for everything in view, full props only for focused shapes — and **rounds all coordinates before prompting as a documented token-reduction step**, un-rounding on apply.
- **Excalidraw AI** never lets the model emit coordinates at all (prompt → Mermaid → skeleton → elements).
- **SVGenius (ACM MM '25)** and **SVGEditBench v2**: all models degrade sharply with SVG complexity; `<path>` data is the dominant failure site; model-emitted SVG carries 10–47 % redundancy.

**Design consequence:** the agent speaks typed ops with integer coordinates; freehand strokes are exposed to it as bounds + label only (models can't meaningfully edit path data); raw SVG is an escape hatch behind a validator.

### 2.3 Platform facts (WKWebView on macOS)

- `getCoalescedEvents()`/`getPredictedEvents()` landed in **Safari 18.2 → macOS 15.2**. Feature-detect; fall back to plain `pointermove`.
- **Stylus/trackpad pressure effectively does not reach `PointerEvent.pressure`** in a macOS WKWebView (Force Touch is only `webkitForce`; the old WebKit stylus bug is WONTFIX with no confirmed macOS pen implementation). → default `simulatePressure: true`; treat `e.pressure` as real only when `pointerType === "pen" && pressure !== 0.5`; verify empirically in Tauri once building.

### 2.4 Codebase constraints that shaped the design (from the code maps)

- **The Create page has no agent at all** — it's rail-only. A drawing agent is greenfield: the full registry checklist in §6 applies.
- **6-domain hard cap** in the hub (`agents.py:1192-1195`), with sibling-worker precedent (`agents.py:534-538`, `:573-576`).
- **The planner scores a domain by its FIRST member's hints only** (`planner.py:266-269`) — as a sibling, `creator.draw` is reached via the manager's `_rank` within `ask_file_agent` and via the `*sketch` tag; the plan chip will say "file". Acceptable; documented.
- **ToolScope note:** CloudEngine now matches LocalEngine **exactly** (`room_mcp.rs:2729-2790` asserts zero set-difference; owner decision 2026-08-03). New draw tools must be granted to `LocalEngine | CloudEngine | ExternalAgent` or that test fails. The stale module doc at `room_mcp.rs:23-28` still describes the old 3-tool carve-out — worth fixing in passing.
- **Everything is a DB blob** delivered via `roommedia://`; `store_file_bytes` snapshots into `file_versions` on every content write (`files.rs:816-828`) — autosave gets versioning for free.
- **No undo/redo system exists anywhere** — the page builds its own command stack (SheetView's single-level `edits` array is the only precedent).
- **A clean pan/zoom hook already exists**: `src/viewers/roomMap/usePanZoom.ts` (cursor-anchored wheel zoom, pointer-captured drag, 3 px threshold) — extract to a shared hook rather than copy.
- **The `svg` file kind already exists and its registry label is already "drawing"** (`registry.tsx:249-253`) — export-to-SVG lands as a first-class, viewable, searchable room file with zero new plumbing.

---

## 3. Product design

### 3.1 The page

- New work area `sketch`, rail label **"Sketch"**, placed in the **Capture** group (recordings → create → **sketch** → browser). Icon: a pen-over-paper stroke icon in the house 24 px/1.6 px style (`src/icons/features.tsx`).
- Sidebar (left pane) heading: **"Library"** — same rationale as Create: a sketch is an ordinary room file. Sidebar lists `.sketch` files; the area page itself is a gallery of sketch cards (`.nb-card` + thumbnails) with one primary action: **"New sketch"**.
- Opening a sketch opens the **editor as its viewer** in the centre pane (open-file-wins ternary, `ViewerPane.tsx:864-893`). The area page is only the gallery — this matches the shell's "rail holds places, strip holds documents" doctrine.
- `area === "sketch"` joins the auto step-aside list (`Workspace.tsx:670-677`) so the canvas gets ~70 % width, and the sketch `ViewerKind` joins `FOCUSED_KINDS` (`Workspace.tsx:45-57`).

### 3.2 The editor (centre pane, all SVG/DOM — no `<canvas>`)

- **Toolbar** (`.sk-tools`, `.nb-btn-icon` buttons): Select (V), Pen (P), Rect (R), Ellipse (O), Line (L), Arrow (A), Text (T), Eraser (E). Colour = **the five marker inks** (`--mk-*-ink` tokens) — never a free colour picker; the palette *is* the design system and every choice is contrast-safe by construction. Width: three pen weights. Fill: the translucent `--mk-*` FILL track (never the only signal — selection/labels carry the meaning).
- **Canvas**: fixed logical page 1600×1000 v1 (bounded > infinite for LLM coordinate sanity; revisit later), dotted paper background from the existing grid tokens, pan/zoom via the extracted `usePanZoom` (wheel zoom anchored under cursor, space-drag or background-drag to pan, ⌘0 reset, ⌘+/⌘− steps — same keys as PdfView).
- **Freehand**: pointer capture; coalesced events when available; live raw polyline while drawing; on pointer-up → simplify-js (ε ≈ 0.4 world px) → store the *simplified input points*; render via perfect-freehand outline → single filled path.
- **Shapes/text**: drag-out rect/ellipse/line/arrow rendered through rough.js, `seed = hash(element.id)`; text in `--hand` (Kalam) at `--fs-hand`, edited in-place via a positioned textarea overlay.
- **Selection**: click / drag-marquee; dashed outline + corner handles (shape + colour, never colour alone); move by drag or arrow keys (Shift = ×10); delete/duplicate (⌘D); label editing in a small inspector strip (labels are what the agent sees — the UI should encourage them).
- **Undo/redo**: page-local command stack of document ops (the same op vocabulary the agent uses — one code path), ⌘Z/⇧⌘Z. `file_versions` remains the disaster net.
- **Autosave**: debounced ~1.5 s after last mutation through `update_file_content` (which snapshots versions); a small "Saved ✓ / Saving…" `role="status"` line. No guardLeave needed once autosave is on.
- **Live agent edits**: the page listens to `room-files-changed` (and the existing per-tool effects); if the open sketch changed underneath and there are no in-flight local edits, reload silently; if mid-gesture, apply after pointer-up. Agent-added elements get a brief `--sem-saved` (pink) pulse — pink is the house "AI/personal attribution" marker.
- **Export**: "Export as SVG" flattens the document to one standalone `.svg` room file (rough.js output + stroke paths + text), which the existing `svg` viewer/search pipeline handles untouched.
- **A11y**: every tool button `aria-pressed`, canvas region labelled, all actions keyboard-reachable, focus ring per `base.css:75-82` (and never set `border-radius` in a focus rule — `settingsA11y.css:10-16`).

### 3.3 Wording

All copy sentence-case, cause-naming, no emoji. The page never invents cloud vocabulary — if a "have the AI draw" affordance shows trust state, it reads `trustState()` (`markup.ts:57-79`). Empty gallery: "Nothing sketched yet — press **New sketch** or ask the AI to draw one."

---

## 4. Document format (`.sketch` — JSON, SVG-out)

```jsonc
{
  "version": 1,
  "canvas": { "width": 1600, "height": 1000 },          // logical units == px at zoom 1
  "elements": [
    { "id": "e7", "type": "rect",    "label": "User Authentication",
      "x": 520, "y": 180, "w": 240, "h": 96,
      "style": { "ink": "blue", "fill": "blue", "weight": 2 } },
    { "id": "e8", "type": "arrow",   "label": "login flow",
      "from": [640, 276], "to": [640, 420], "style": { "ink": "green" } },
    { "id": "e9", "type": "text",    "text": "retry w/ backoff",
      "x": 660, "y": 440, "size": "hand" },
    { "id": "e10", "type": "stroke", "label": "underline swash",
      "points": [[512,300],[518,304],[530,303]], "style": { "ink": "pink", "weight": 3 } },
    { "id": "e11", "type": "svg",    "label": "custom glyph",
      "x": 900, "y": 500, "svg": "<path d='…' fill='none' stroke='currentColor'/>" }
  ]
}
```

Rules, all enforced in one shared Rust module (`sketchdoc.rs`) used by both the page commands and the agent tools:

- **Coordinates are integers** in canvas units (the tldraw-kit token trick, applied at the storage layer so round-tripping never drifts).
- **`style.ink` / `style.fill` are the five marker names** (`pink|yellow|green|blue|red`) — semantic, theme-proof, 3 tokens each instead of a hex string.
- **Ids are server-assigned** (`e<counter>`), short by design; the model never invents ids on create.
- **`stroke.points` are the RDP-simplified input points**, not the fat outline polygon; the outline is recomputed at render time.
- **`type: "svg"` is the escape hatch** — a fragment validated by the allowlist (§5.4), positioned by `x/y` (translate), sized by its own content. Rejected fragments never enter the document.
- `extracted_text` (search + model grounding) = canvas title + all `label`s + all `text`s, one per line — a sketch becomes findable by `search_room` with zero new search code.
- Deterministic render: element order = z-order; rough.js seeded by id; identical JSON always paints identical pixels.

Format plumbing: one `FORMATS` row (`exts: ["sketch"], kind: "sketch", text: Extracted, editable: false, delivery: NoBytes`), one `ViewerKind` member, one registry row (`sketch: { label: "sketch", render: <SketchView/> }`), an `extract_sketch` labels extractor beside `extract_svg` (`extraction/data.rs:337`).

---

## 5. The agent

### 5.1 Placement

- New worker **`creator.draw`**, sibling in the **file domain** (joins `ask_file_agent`'s members beside `files.read`, `scripts.run`, `creator.studio`). Not a 7th domain — the 6-domain cap is a measured 4B ceiling, and the file domain is where artifact creation already lives.
- **Tag `sketch`** (unique, `[a-z]+`), `area: "Sketch"`, one-line `summary` — the `*sketch` composer path gives users a direct, hub-free route.
- `hints` tuned for the manager's `_rank` (draw, sketch, diagram, canvas, wireframe, "draw+file" ALL-OF stems…) so delegated instructions land on it rather than on `files.read`.
- Template: **`react_verify`** — it's a write-capable agent, and the write-claim gate (`verify_claims`) should audit "I drew it" like every other write claim. Its new tools join `WRITE_TOOLS` (`graphs.py:148`), `LEDGER_TOOLS` ⊇ check (`graph.py:1258-1279`), and `_referent_names` gets a row extracting the drawing name.

### 5.2 Tools (3 — small box, room for growth under `MAX_BOX_TOOLS = 7`)

1. **`read_drawing { name, detail? }`** — tiered, the tldraw-kit pattern:
   - default: canvas size + element list as `id · type · label · [x y w h]` (bounds rounded to 10), ~15 tokens/element;
   - `detail: [ids]`: full JSON for just those elements.
2. **`edit_drawing { name, ops: [...] }`** — the single mutating verb; ops mirror the page's own undo-stack vocabulary:
   - `{op:"add", element:{type,label,x,y,w,h,style,…}}` (id assigned, returned),
   - `{op:"update", id, set:{…}}` (move/resize/relabel/restyle/retext),
   - `{op:"delete", id}`.
   Applied atomically; result text names the drawing and lists assigned ids; emits `room-files-changed` so an open editor repaints live.
3. **`create_drawing { name, canvas?, ops? }`** — new `.sketch` file (source `generated`, provenance from the turn), optionally pre-populated.

Deliberately absent in v1: a rasterize/screenshot tool (privacy §5.3), free-form path emission (evidence §2.2), a separate delete/list tool (`list_room_files` + ops cover it).

### 5.3 Privacy

- v1 tools move **text/JSON only** — everything outbound already passes `guard_outbound` and `redact_value`, so labels/text get the same redaction as any tool result. No new seam, no new host, `test_privacy` untouched.
- If a v2 rasterize tool ever exists, it must **refuse on non-local models, never strip** — the `mark_image` / `imagegen.py` precedent (`agent.rs:3670-3676`, `imagegen.py:28-43`).

### 5.4 SVG escape-hatch validator (Rust, in `sketchdoc.rs`)

- Allowlist parse of the fragment: elements `path rect circle ellipse line polyline polygon text tspan g` only; attributes numeric/enum presentation set only.
- **Reject, don't strip** — the tool error names the offending node/attribute so the model can retry (reject-and-retry beats silent stripping in an agent loop, and matches the house "refused, not silently altered" doctrine).
- Hard-rejected: `script foreignObject use image animate set a`, any `on*`, any `href/xlink:href`, any `url(…)`, any CSS `expression`, comments/PIs/doctype.
- Frontend re-validates with the same allowlist (TS twin) before injecting into the DOM — belt and braces under the app CSP.

---

## 6. Change list (the actual "design changes")

New npm deps: `perfect-freehand`, `simplify-js` (both tiny, MIT/BSD, offline). rough.js: prefer the npm package; vendor if its dormancy ever bites.

### Frontend — new files
| File | Contents |
|---|---|
| `src/workspace/sketch/SketchGallery.tsx` | The area page: cards + "New sketch" |
| `src/viewers/SketchView.tsx` | The editor-viewer (toolbar, canvas, inspector) |
| `src/viewers/sketch/useSketchDoc.ts` | Document state, op application, undo/redo stack, autosave |
| `src/viewers/sketch/strokes.ts` | pointer→points→simplify→perfect-freehand path |
| `src/viewers/sketch/render.tsx` | element→SVG (rough.js seeded, stroke paths, text) |
| `src/viewers/sketch/svgAllowlist.ts` | TS twin of the fragment validator |
| `src/shell/usePanZoom.ts` | extracted from `src/viewers/roomMap/usePanZoom.ts` (roomMap re-imports) |
| `src/styles/sketch.css` | all classes `.sk-*` |

### Frontend — edits
| File | Edit |
|---|---|
| `src/workspace/types.ts:58,77` | `"sketch"` in `WorkArea` union + `WORK_AREAS` (+ `areaHoldsFile`/`FILE_BEARING_AREAS` — the sidebar lists sketch files) |
| `src/shell/ActivityRail.tsx:45,~226` | `AREAS` entry + `RailAreaButton` in Capture group |
| `src/workspace/Sidebar.tsx:48` | `AREA_HEADINGS.sketch = "Library"` |
| `src/workspace/ViewerPane.tsx:189,~890` | crumb label + render branch → `SketchGallery` |
| `src/Workspace.tsx:45-57,670-677` | sketch kind in `FOCUSED_KINDS`, area in step-aside |
| `src/icons/features.tsx` | `SketchIcon` |
| `src/App.css:~40` | `@import "./styles/sketch.css"` (end of feature band, before shell.css) |
| `src/viewers/registry.tsx` | `sketch` row |
| `src/apiTypes.ts` / `src/api.ts` | `SketchDoc`/op DTOs + `createSketch`, (load/save reuse existing file APIs) |
| `src/workspace/AgentGraph.tsx:31-57` | `AGENT_DESCRIPTIONS["creator.draw"]` |

### Rust host
| File | Edit |
|---|---|
| `src-tauri/src/commands/sketchdoc.rs` **(new)** | schema types, op application, id assignment, integer clamping, SVG allowlist, `extracted_text` builder — the single shared truth |
| `src-tauri/src/commands/sketch.rs` **(new)** | `create_sketch` command (page path; save/load ride `update_file_content`/existing file reads) |
| `src-tauri/src/commands.rs:43,107` | `mod` (doc-commented) + `pub use` |
| `src-tauri/src/lib.rs:~336` | register commands |
| `src-tauri/src/formats.rs:~120` | `.sketch` row (+ keep extension-beats-MIME test green) |
| `src-tauri/src/extraction/data.rs` | `extract_sketch` + dispatch |
| `src-tauri/src/commands/agent.rs` | `draw_tools_specs()` beside `:1734`; names into `BUILTIN_TOOL_NAMES:1618`; `exec_tool` arms `~:2887` (mutations via `store_file_bytes` + `room-files-changed`); worker id into `SKILL_AGENT_IDS:1599` |
| `src-tauri/src/room_mcp.rs` | `include_draw_tools()` = `LocalEngine\|CloudEngine\|ExternalAgent`; `scoped_specs:1171` branch; regenerate tool-catalog snapshot (`UPDATE_TOOL_SNAPSHOT=1`); fix stale module doc `:23-28` in passing |
| DB | **no schema change** — this is deliberate |

### Sidecar
| File | Edit |
|---|---|
| `arcelle_sidecar/routing.py` | `DRAW_TOOL_NAMES` |
| `arcelle_sidecar/agents.py` | `AgentSpec("creator.draw", …, template="react_verify", tag="sketch", hints=…)` into `REGISTRY`; member added under `ask_file_agent` in `AGENT_TOOL_DOMAINS:1097` (no new domain — blurbs/order untouched) |
| `arcelle_sidecar/prompts.py` | `DRAW_PROMPT` (names only its own tools; read-before-edit; labels mandatory; integer coords) |
| `arcelle_sidecar/labels.py:15` | step-chip labels ("Read the sketch", "Drew on the sketch", "Started a sketch") |
| `arcelle_sidecar/graph.py:1258-1288` | `LEDGER_TOOLS` + `_referent_names` rows |
| `arcelle_sidecar/graphs.py:148,1290` | `edit_drawing`/`create_drawing` into `WRITE_TOOLS`; `GRAPH_CREATOR_DRAW` entry |
| `sidecar/AGENTS.md` | regenerate: `uv run python devtools/draw_agents_doc.py > AGENTS.md` |

### Tests & QA (all five house locations)
- Rust: inline `mod tests` in `sketchdoc.rs` (op application, id assignment, allowlist reject-not-strip, integer clamp, extracted-text) + `formats`/`extraction` rows.
- Sidecar: `tests/test_draw_agent.py`; add tool names to `tests/conftest.py` `BUILTIN_TOOL_NAMES`; the derived suites (`test_manager`, `test_labels`, `test_capability_truth`, `test_agents_doc`, `test_skill_agent_parity`) then enforce the rest.
- Page logic: `e2e/page-script/sketch.test.mjs` (pure doc/op/undo model — keep it out of React, like `selectors.ts`).
- QA mock: every new Tauri command into `qa/qa-mock.js` (hard gate via `check-mock-coverage`).
- e2e look: `e2e/qa-specs/sketch-look.e2e.mjs` + one-liners in `areas-and-viewers.e2e.mjs`, `capture-specs/screens.mjs`, `contrast.mjs`.
- `qa/UA-FEATURE-CHECKLIST.md`: new §32 "Sketch" — and note **the Create page still owes its own section** (gap found during this research).

---

## 7. Phasing

1. **P1 — the page, human-only** (~2/3 of the work): format + `sketchdoc.rs` + viewer/editor (pen, shapes, text, select, pan/zoom, undo, autosave, export-SVG) + gallery + registration + tests. Ships alone as a useful feature.
2. **P2 — the agent**: 3 tools, `creator.draw`, registry/roster/labels/ledger plumbing, live-repaint in the editor, sidecar + parity tests.
3. **P3 — polish / later**: raster-render tool for local vision grounding (refuse-on-cloud), mermaid→sketch import (Excalidraw's trick), image embeds, infinite canvas, multi-page sketchbooks.

## 8. Risks & open questions

- **4B coordinate quality is unproven.** Integer coords on a fixed 1600×1000 page + label-anchored reads are the mitigations; if quality disappoints, add a `place: "below e7"` relative-placement op (deterministic layout in Rust) before ever considering raw coordinates removal.
- **Pressure**: assume none (WKWebView); `simulatePressure` covers it. Verify once, empirically, in the running app.
- **rough.js dormancy**: acceptable (finished algorithmic lib, Excalidraw depends on it); vendoring is the exit.
- **Version bloat from autosave**: every autosave snapshots `file_versions`; debounce keeps it ~1 snapshot/pause. Check whether `file_versions` has a cap; if not, consider one for `.sketch` (open question).
- **Planner never plans the file domain** (its first member has no hints — deliberate). Sketch requests reach the agent via hub delegation ranking or the `*sketch` tag; the plan chip won't say "sketch". Cosmetic, documented.
- **Concurrent edits** (user drawing while agent edits the same sketch): v1 rule = agent ops apply between gestures; if the user has unsaved-but-not-yet-autosaved ops, ops rebase by id (adds always safe; update/delete on a locally-deleted id → no-op with a note in the tool result).
