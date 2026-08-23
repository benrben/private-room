/**
 * Port of `src-tauri/src/commands/vision.rs` (415 lines, read in full) — image
 * grounding: fitting an image onto the model's square working canvas, the
 * Qwen-VL box-finding prompt/schema, the coordinate-scale-ambiguity parser,
 * and the `locate_in_image` command the viewer's "find X in this image"
 * affordance calls.
 *
 * ══════════════════ OVERLAP CHECKED FIRST, PER THE BATCH BRIEF ═══════════════
 * `vision.rs` is NOT a green field. Two of its five pieces are ALREADY ported
 * elsewhere, verbatim, with their own test coverage — re-porting them here
 * would be exactly the "second X shape" this migration's other module docs
 * keep warning against:
 *
 *   - `is_locate_intent` → `turnContext.ts`'s {@link isLocateIntent}
 *     (`turnContext.ts:618`, doc-labelled "`vision.rs::is_locate_intent`"),
 *     already exercised by `turnContext.test.ts`'s `isLocateIntent` suite
 *     against the same cases this file's own Rust `#[cfg(test)]` module
 *     pins. NOT reproduced or re-exported here — a caller wanting it imports
 *     `turnContext.ts` directly, the same as `turnEngine.ts` already does.
 *   - `prepare_image`'s RESULT SHAPE → `turnContext.ts`'s {@link PreparedImage}
 *     (`bytes`/`width`/`height`), plus that file's own `passthroughPrepareImage`
 *     — an explicitly-labelled NO-OP standing in for this exact function,
 *     documented there as "no Node image library is wired into this migration
 *     yet". That statement is now STALE: `storyTools.ts` (a later batch) wired
 *     `sharp` in for real. {@link prepareImage} below is that missing real
 *     implementation, returning the SAME `PreparedImage` shape (imported, not
 *     re-declared) so a future batch can swap `turnEngine.ts`'s
 *     `groundingPass` seam from the passthrough onto this without touching the
 *     shape it returns.
 *
 * The engine-capability plumbing `locate_in_image` leans on for its "who can
 * even look at this picture" decision is ALSO already real, and is imported
 * rather than re-derived: `capabilities.ts`'s `visionSupport`/
 * `imageReachesModel`/`runsOnThisMac`/`capabilitiesFor`/`visionDoorBlock` (the
 * project's one declared answer to "what can this engine do", per that file's
 * own module doc) and `turnContext.ts`'s `bestDefault`.
 *
 * ══════════════════ WHAT THIS FILE PORTS FOR REAL ═════════════════════════
 *   - `VISION_SQUARE`, {@link groundingPrompt}, {@link boxesSchema} — pure
 *     constants/formatting, no dependency at all.
 *   - {@link parseBoxes}/{@link boxesFromItems} — the coordinate-scale-
 *     ambiguity parser (pixel vs. Google's 0-1000 vs. already-normalized
 *     0-1), including the "scan up to 8 `[` positions, keep the first that
 *     yields a real box list" prose-survival trick `parse_boxes` uses. Pure
 *     JSON math, no native dependency; ported verbatim.
 *   - {@link prepareImage} — REAL, via `sharp` (already an
 *     `electron-app/package.json` dependency, and already this migration's
 *     precedent for the `image` crate — see `storyTools.ts`'s own "FOUR
 *     DEPENDENCIES, FOUR ANSWERS" note). `sharp`'s `fit: "fill"` matches
 *     Rust's `resize_exact` (stretch to the exact square, aspect ratio
 *     discarded on purpose — see `vision.rs`'s own "Marking fix" comment);
 *     `kernel: "linear"` is the closest published match to
 *     `FilterType::Triangle` (both are the bilinear/tent filter — `image`'s
 *     own docs describe `Triangle` as "linear filter"). The OS-header-only
 *     size fallback (Rust's `imagesize::blob_size`, for bytes `image` cannot
 *     decode but whose declared dimensions are still readable) is answered by
 *     `sharp(bytes).metadata()`, which reads a container's header the same
 *     way without a full decode — no second library needed for it.
 *   - {@link groundPreparedImage} — REAL, built on `ollamaGenerate.ts`'s
 *     already-real {@link chatStructured} (confirmed present — its own module
 *     doc names `commands/vision.rs:221` as one of `chat_structured`'s real
 *     Rust call sites) and `sidecar.ts`'s `SidecarChatMessage.images` field
 *     (already carries the base64-PNG-array shape Ollama expects on a user
 *     turn). Nothing here is stubbed.
 *   - {@link locateInImage} — REAL end to end. The sidecar's `/vision_locate`
 *     route is NOT a gap either: `sidecar/arcelle_sidecar/vision.py` and
 *     `server.py`'s `POST /vision_locate` are already implemented (confirmed
 *     by reading both, plus `sidecar/tests/test_vision.py`) — Phase 2 of the
 *     migration per `sidecar/MIGRATION-SPEC.md`. The Electron-side command
 *     reads the room's file bytes, picks a vision model, and POSTs to that
 *     real endpoint via `sidecarJsonCancellable.ts` (already-real, generic
 *     sidecar-feature-POST helper), exactly mirroring what `vision.rs`'s own
 *     comment says the Rust command itself now does ("Rust keeps: the DB
 *     read... and the vision-model pick... The prepare_image..., grounding
 *     prompt, boxes schema, structured call and coordinate parse all now
 *     live in the sidecar's /vision_locate").
 *
 * ══════════════════ ONE DUPLICATION, NAMED RATHER THAN HIDDEN ═════════════
 * `locate_in_image`'s own body directly calls FOUR small things that live in
 * `commands/models.rs`, not `vision.rs` — a file no batch in this migration
 * wave owns (confirmed: `models.ts` does not exist under `electron/main`).
 * Each is pure, has no native dependency, and is small enough to duplicate
 * honestly rather than hide behind an injected NOT_IMPLEMENTED — the same
 * choice `storyTools.ts`/`filePass.ts`/`recRead.ts` already made for
 * `models.rs::KEEP_ALIVE_WARM` ("a plain literal, not a re-port of that whole
 * module"), extended here to the couple of functions `vision.rs` actually
 * calls:
 *   - {@link totalRamBytes}/{@link visionKeepAlive}/`KEEP_ALIVE_WARM`/
 *     `KEEP_ALIVE_SHORT`/`HIGH_RAM_THRESHOLD_BYTES` — `os.totalmem()` is a
 *     direct, always-available equivalent of `sysinfo::System::total_memory`;
 *     no caching wrapper is reproduced (Rust's `OnceLock` exists only because
 *     re-querying `sysinfo` has a real cost — `os.totalmem()` is a cheap
 *     syscall wrapper with nothing worth memoizing).
 *   - {@link groundingPick} — pure orchestration over the already-real
 *     `visionSupport`/`imageReachesModel`/`runsOnThisMac`; nothing about it
 *     is a native dependency, so stubbing it (rather than porting the dozen
 *     real lines) would manufacture a gap that does not exist. A future
 *     `models.ts` batch that ports `commands/models.rs` in full should
 *     collapse this copy into an import from there, not the reverse — the
 *     same relationship `ollamaGenerate.ts`'s `recoverJson` doc already
 *     states for its own deliberate duplicate.
 *
 * Both are exported so a future `models.ts` batch — or a batch wiring
 * `turnEngine.ts`'s `groundingPass` seam onto this file's real
 * `groundPreparedImage` — has them ready without a second re-port.
 *
 * ══════════════════ NOT A MODEL TOOL ═══════════════════════════════════════
 * Confirmed by grep over `src-tauri/src/commands/agent.rs`'s `exec_tool`
 * match arms and this migration's `toolSpecs.ts`/`toolSchema.ts`/
 * `execTool.ts`: `locate_in_image` has no `exec_tool` arm anywhere — it is a
 * plain `#[tauri::command]` the VIEWER calls directly (the "find X in this
 * image" UI action), never something the agent loop dispatches. Nothing here
 * touches `execTool.ts`.
 *
 * The ONE thing in the whole `vision.rs` dependency graph that IS a model
 * tool is `mark_image` — but that exec_tool arm lives in `agent.rs`, not
 * `vision.rs`, and is ALREADY ported (and ALREADY wired into `execTool.ts`)
 * as `organizeTools.ts`'s `execMarkImage`. Its own doc names the exact gap
 * this file closes the *raw material* for: "`ollama.rs`'s whole
 * model-execution surface has no Electron port yet ... Batch D". That
 * surface (`chat_structured`) landed since, in `ollamaGenerate.ts`, and this
 * file now makes `prepareImage`/`groundPreparedImage` real too — but
 * `organizeTools.ts` is a different, already-committed file outside this
 * batch's stated scope (port `vision.rs` to a new `visionTools.ts`), so it is
 * left untouched here. Wiring `execMarkImage`'s `NOT_IMPLEMENTED` arm onto
 * {@link prepareImage}/{@link groundPreparedImage} is a small, well-labelled
 * follow-up for whoever owns that file next.
 *
 * ══════════════════ ROOM ACCESS ════════════════════════════════════════════
 * Mirrors `previewTools.ts`/`peaksTools.ts`: {@link RoomSource} reuses
 * `turnEngine.ts`'s `OpenRoom` rather than a fourth "how do I reach the open
 * room" convention; {@link locateInImage} takes the room's
 * ALREADY-UNWRAPPED `Database.Database`, resolved once by
 * {@link registerVisionIpc} via the same `openDb`/`"No room is open."` shape.
 *
 * ══════════════════ NO IPC WIRING IN THIS BATCH ════════════════════════════
 * Same posture as `previewTools.ts`/`peaksTools.ts`/`recIpc.ts`:
 * {@link registerVisionIpc} exists, ready to be wired, but nothing in this
 * migration's bootstrap calls it yet — Phase 2 (renderer/preload) needs an
 * explicit owner go-ahead before touching the live shipping app.
 */

import os from "node:os";
import sharp from "sharp";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag } from "./cancel.js";
import {
  capabilitiesFor,
  imageReachesModel,
  isYes,
  runsOnThisMac,
  visionDoorBlock,
  visionSupport,
  type CapabilitiesForDeps,
  type VisionSupportDeps,
} from "./capabilities.js";
import { getFileBytes } from "./db-host/files.js";
import { listModels as listModelsReal, resolvedBaseUrl, stripThinkSpans } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { chatStructured, type StructuredOpts } from "./ollamaGenerate.js";
import { ollamaCapabilities, ollamaNativeContextLength } from "./ollamaModels.js";
import { activePolicy } from "./privacy.js";
import { defaultProviderDeps, ensureProviderCatalog, providerModelFacts, providerModelVision } from "./providers.js";
import {
  sidecarErrorSentinel,
  sidecarJsonCancellable,
  type SidecarPostOutcome,
} from "./sidecarJsonCancellable.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { bestDefault, type PreparedImage } from "./turnContext.js";
import type { OpenRoom } from "./turnEngine.js";
import type { ImageBox } from "../shared/apiTypes.js";

export type { ImageBox, PreparedImage };

// ============================================================================
// constants + pure formatting (vision.rs top of file)
// ============================================================================

/** Ported verbatim from `vision::VISION_SQUARE`. The square canvas every
 * image is fitted to before grounding — see {@link prepareImage}'s doc for
 * why a square (rather than the image's own aspect ratio) is what keeps a
 * small vision model's box coordinates from drifting downward. */
export const VISION_SQUARE = 1000;

/**
 * The grounding prompt Qwen-VL models were trained on. Ported verbatim from
 * `grounding_prompt` (the Rust source's backslash-newline string
 * continuations collapse to a single space-preserving string — reproduced
 * here as plain concatenation so the wire text matches exactly).
 */
export function groundingPrompt(query: string, w: number, h: number): string {
  return (
    `Outline the position of each instance of the following in this ${w.toFixed(0)}x${h.toFixed(0)} ` +
    `pixel image: ${query}\n` +
    `Output ONLY a JSON array, no other text, in the format ` +
    `[{"bbox_2d": [x1, y1, x2, y2], "label": "<short name>"}]. ` +
    `One element per match, each with a distinct descriptive label. ` +
    `If it is not in the image, output [].`
  );
}

/** ADD-22: JSON schema handed to Ollama `format` for the grounding pass, so a
 * small vision model can only ever emit a well-formed box array. Ported
 * verbatim from `boxes_schema`. */
export function boxesSchema(): unknown {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        bbox_2d: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
        label: { type: "string" },
      },
      required: ["bbox_2d", "label"],
    },
  };
}

// ============================================================================
// parse_boxes / boxes_from_items
// ============================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An OWN-property read — the guard this file's sibling modules
 * (`privacy.ts`'s `ownValue`, `ollamaGenerate.ts`'s `ownValue`) already use
 * for exactly the same reason: a model-controlled JSON object must never be
 * allowed to answer through an INHERITED `Object.prototype` entry. */
function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * The index one past the JSON value that STARTS at `s[open]` (which must be
 * `"["` or `"{"`), found by walking bracket depth while respecting string
 * quoting/escaping — or `null` if the brackets never balance before the
 * string ends.
 *
 * This is the structural half of what Rust's
 * `serde_json::Deserializer::from_str(&cleaned[start..]).into_iter::<Value>().next()`
 * does: a streaming deserializer parses exactly ONE balanced JSON value
 * starting at a position and stops, ignoring any trailing prose — it does
 * NOT require the rest of the string to be valid JSON, or even present. A
 * bracket-depth walk that respects quoting finds the same boundary, because
 * JSON's grammar is exactly "balanced brackets/braces, with quoting inside
 * strings" — so slicing `s[open..=end]` and handing it to a strict
 * `JSON.parse` reproduces the streaming parser's own value boundary.
 */
function matchingBracketEnd(s: string, open: number): number | null {
  const close = s[open] === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "[" || c === "{") {
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        return c === close ? i : null;
      }
    }
  }
  return null;
}

/**
 * Requested `"bbox_2d"` is absolute pixels (Qwen-VL's native grounding
 * format), `"bbox"` an alias for it. `"box_2d"` is Google-style
 * `[ymin, xmin, ymax, xmax]` 0-1000. `"box"` is the same axis order as
 * `bbox_2d` but not treated as pixels. Ported verbatim from
 * `boxes_from_items`.
 */
export function boxesFromItems(items: readonly unknown[], imgW: number, imgH: number): ImageBox[] {
  const boxes: ImageBox[] = [];
  for (const raw of items) {
    const item = isPlainObject(raw) ? raw : {};
    const labelRaw = ownValue(item, "label");
    const nameRaw = ownValue(item, "name");
    const label = typeof labelRaw === "string" ? labelRaw : typeof nameRaw === "string" ? nameRaw : "match";

    const bbox2d = ownValue(item, "bbox_2d");
    const bboxAlias = ownValue(item, "bbox");
    const box2d = ownValue(item, "box_2d");
    const boxAlias = ownValue(item, "box");
    let coords: unknown[];
    let yFirst: boolean;
    let pixels: boolean;
    if (Array.isArray(bbox2d)) {
      coords = bbox2d;
      yFirst = false;
      pixels = true;
    } else if (Array.isArray(bboxAlias)) {
      coords = bboxAlias;
      yFirst = false;
      pixels = true;
    } else if (Array.isArray(box2d)) {
      coords = box2d;
      yFirst = true;
      pixels = false;
    } else if (Array.isArray(boxAlias)) {
      coords = boxAlias;
      yFirst = false;
      pixels = false;
    } else {
      continue;
    }
    if (coords.length !== 4) {
      continue;
    }
    // `vals.len() != 4` after `filter_map(as_f64)` — every one of the 4 must
    // be a genuine JSON number, or the whole element is skipped.
    if (coords.some((c) => typeof c !== "number" || !Number.isFinite(c))) {
      continue;
    }
    const vals = coords as number[];

    let a: number;
    let b: number;
    let c: number;
    let d: number;
    if (yFirst) {
      [a, b, c, d] = [vals[1]!, vals[0]!, vals[3]!, vals[2]!];
    } else {
      [a, b, c, d] = [vals[0]!, vals[1]!, vals[2]!, vals[3]!];
    }

    // Scale to 0..1. Pixel keys use the image dims — unless the values
    // overshoot them, which means the model answered in its own
    // 0-1000-normalized space (qwen2.5vl does this on small images).
    const max = Math.max(...vals);
    const outOfRange = Math.max(a, c) > imgW * 1.05 || Math.max(b, d) > imgH * 1.05;
    let sx: number;
    let sy: number;
    if (max <= 1.0) {
      sx = 1.0;
      sy = 1.0;
    } else if (pixels && !outOfRange) {
      sx = Math.max(imgW, 1.0);
      sy = Math.max(imgH, 1.0);
    } else {
      sx = 1000.0;
      sy = 1000.0;
    }
    a /= sx;
    c /= sx;
    b /= sy;
    d /= sy;
    if (a > c) {
      [a, c] = [c, a];
    }
    if (b > d) {
      [b, d] = [d, b];
    }
    const clamp = (v: number): number => Math.min(Math.max(v, 0), 1);
    a = clamp(a);
    b = clamp(b);
    c = clamp(c);
    d = clamp(d);
    if (c - a < 0.001 || d - b < 0.001) {
      continue;
    }
    boxes.push({ label, x1: a, y1: b, x2: c, y2: d });
  }
  return boxes;
}

/**
 * CHG-21: drop any `<think>…</think>` spans some models leak, then scan each
 * `'['` as a candidate JSON array (up to 8, matching Rust's `.take(8)`),
 * returning the first array that yields at least one box. Robust to
 * leading/trailing prose containing brackets, unlike a single
 * first-`[`-to-last-`]` slice. Ported verbatim from `parse_boxes`.
 *
 * `strip_think_spans` is `ollama::strip_think_spans` — `vision.rs` itself
 * re-exports it with `pub(crate) use crate::ollama::strip_think_spans;`
 * rather than defining its own copy, and this port does the same by
 * importing `engineRouting.ts`'s already-real {@link stripThinkSpans}.
 */
export function parseBoxes(raw: string, imgW: number, imgH: number): ImageBox[] {
  const cleaned = stripThinkSpans(raw);
  const positions: number[] = [];
  for (let i = 0; i < cleaned.length && positions.length < 8; i++) {
    if (cleaned[i] === "[") {
      positions.push(i);
    }
  }
  for (const start of positions) {
    const end = matchingBracketEnd(cleaned, start);
    if (end === null) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    const boxes = boxesFromItems(value, imgW, imgH);
    if (boxes.length > 0) {
      return boxes;
    }
  }
  return [];
}

// ============================================================================
// prepare_image — REAL, via sharp (see module doc)
// ============================================================================

/**
 * Normalize an image for the model: transcode to PNG and fit it onto a fixed
 * `VISION_SQUARE`×`VISION_SQUARE` canvas. Returns the {@link PreparedImage}
 * shape `turnContext.ts` already declares for this exact seam.
 *
 * STRETCHED to a square rather than kept at its own aspect ratio — Rust's own
 * "Marking fix" comment explains why: this removes both the pixel-vs-0..1000
 * scale ambiguity (on a 1000×1000 image both conventions normalize
 * identically) and the vision model's own internal square-padding, which
 * otherwise squeezes a non-square image toward the middle and drags boxes
 * down. Boxes are drawn back over the ORIGINAL image using NORMALIZED
 * coordinates, so the per-axis stretch cancels out exactly.
 *
 * `fit: "fill"` is `resize_exact` (stretch, discard aspect ratio); `kernel:
 * "linear"` is the closest published match to `FilterType::Triangle` (the
 * `image` crate's own docs describe `Triangle` as "linear filter" — both are
 * the bilinear/tent kernel). Falls back to `sharp(bytes).metadata()` — a
 * header-only read, the same operation `imagesize::blob_size` performs, for
 * bytes `sharp` cannot fully decode but can still identify — and only then
 * to a flat `VISION_SQUARE`×`VISION_SQUARE` guess, mirroring Rust's own
 * two-step fallback exactly.
 */
export async function prepareImage(bytes: Buffer): Promise<PreparedImage> {
  const square = VISION_SQUARE;
  try {
    const out = await sharp(bytes)
      .resize(VISION_SQUARE, VISION_SQUARE, { fit: "fill", kernel: "linear" })
      .png()
      .toBuffer();
    return { bytes: out, width: square, height: square };
  } catch {
    try {
      const meta = await sharp(bytes).metadata();
      if (typeof meta.width === "number" && typeof meta.height === "number") {
        return { bytes, width: meta.width, height: meta.height };
      }
    } catch {
      // Genuinely unreadable — fall through to the flat guess below, exactly
      // as Rust's `unwrap_or((square, square))` does.
    }
    return { bytes, width: square, height: square };
  }
}

// ============================================================================
// models.rs duplication — see module doc's "ONE DUPLICATION" section
// ============================================================================

/** HLT-5: keep the chat model resident this long so follow-up questions are
 * snappy. Ported from `commands::models::KEEP_ALIVE_WARM`. */
export const KEEP_ALIVE_WARM = "30m";
/** HLT-5: release a distinct vision model quickly on low-RAM machines.
 * Ported from `commands::models::KEEP_ALIVE_SHORT`. */
export const KEEP_ALIVE_SHORT = "2m";
/** HLT-5: machines at or above this stay warm even for a second model.
 * Ported from `commands::models::HIGH_RAM_THRESHOLD_BYTES`. */
export const HIGH_RAM_THRESHOLD_BYTES = 32 * 1024 * 1024 * 1024;

/** `sysinfo::System::total_memory`'s direct Node equivalent — no caching
 * wrapper reproduced; see module doc. Ported from `total_ram_bytes`. */
export function totalRamBytes(): number {
  return os.totalmem();
}

/**
 * HLT-5: how long a vision/grounding call should keep its model resident.
 * Ported verbatim from `vision_keep_alive`.
 */
export function visionKeepAlive(totalRam: number, visionModel: string, chatModel: string): string {
  return visionModel === chatModel || totalRam >= HIGH_RAM_THRESHOLD_BYTES ? KEEP_ALIVE_WARM : KEEP_ALIVE_SHORT;
}

/** Everything {@link groundingPick} needs beyond the pure declaration table —
 * a strict extension of `capabilities.ts`'s own {@link VisionSupportDeps}. */
export interface GroundingPickDeps extends VisionSupportDeps {
  /** `privacy::active_policy().is_some()` — is this room's privacy door on? */
  privacyDoorActive(): boolean;
}

/**
 * Which model draws the boxes for this room's image — ASKED, not guessed.
 * Ported verbatim from `models::grounding_pick`. See module doc for why this
 * function (owned by `models.rs`, not `vision.rs`) is duplicated here rather
 * than stubbed: it is pure orchestration over already-real capability
 * lookups, with no native dependency of its own.
 *
 * Order of truth, capability only: (1) the room's OWN chosen model, when its
 * engine says it takes images AND an image can actually reach it; (2) any
 * OTHER installed model that reports vision, on-Mac only; (3) `null`.
 */
export async function groundingPick(
  models: readonly string[],
  chatModel: string,
  deps: GroundingPickDeps
): Promise<string | null> {
  if (imageReachesModel(chatModel, deps.privacyDoorActive) && isYes(await visionSupport(chatModel, deps))) {
    return chatModel;
  }
  for (const m of models) {
    if (m === chatModel || !runsOnThisMac(m)) {
      continue;
    }
    if (isYes(await visionSupport(m, deps))) {
      return m;
    }
  }
  return null;
}

// ============================================================================
// ground_prepared_image
// ============================================================================

/** {@link groundPreparedImage}'s optional knobs — reuses `ollamaGenerate.ts`'s
 * {@link StructuredOpts} directly (not re-declared) since this function is a
 * thin wrapper over {@link chatStructured} and takes exactly the same two
 * knobs. */
export type GroundPreparedImageOpts = StructuredOpts;

/**
 * Shared inline image-grounding used by the agent's `mark_image` tool and its
 * post-answer auto-ground pass: run the vision model on a PREPARED
 * (square-stretched) image and parse the boxes. Ported verbatim from
 * `ground_prepared_image`, now built on the real {@link chatStructured}
 * rather than an injected seam.
 */
export async function groundPreparedImage(
  vmodel: string,
  chatModel: string,
  prepared: Buffer,
  query: string,
  w: number,
  h: number,
  opts: GroundPreparedImageOpts = {}
): Promise<ImageBox[]> {
  const messages: SidecarChatMessage[] = [
    {
      role: "user",
      content: groundingPrompt(query, w, h),
      images: [prepared.toString("base64")],
    },
  ];
  // HLT-5: short keep_alive for this vision pass on low-RAM Macs.
  const keep = visionKeepAlive(totalRamBytes(), vmodel, chatModel);
  const raw = await chatStructured(vmodel, messages, 0.0, keep, boxesSchema(), opts);
  return parseBoxes(raw, w, h);
}

// ============================================================================
// locate_in_image
// ============================================================================

/** The slice of the (not-yet-ported) `AppState` this command needs:
 * whichever room is open RIGHT NOW. Reuses `turnEngine.ts`'s `OpenRoom`
 * rather than a fourth "how do I reach the open room" convention — same
 * reasoning `previewTools.ts`'s/`peaksTools.ts`'s own `RoomSource` gives. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

/** `AppState::with_room`'s own refusal, spelled the way `previewTools.ts`
 * and `peaksTools.ts` already spell it. */
const NO_ROOM_OPEN = "No room is open.";

function openDb(room: RoomSource): Database.Database {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open.db;
}

/** `sidecarJsonCancellable`'s own signature — the seam {@link locateInImage}
 * accepts an override of, for tests only (the same local alias
 * `webSearch.ts`'s own `SidecarPostFn` already establishes for the identical
 * shape). */
type SidecarPostFn = (
  path: string,
  body: unknown,
  cancel: CancelFlag,
  timeoutMs?: number
) => Promise<SidecarPostOutcome>;

/**
 * The real {@link CapabilitiesForDeps} — every seam `capabilities.ts` needs,
 * wired to this migration's already-real implementations: `ollamaModels.ts`
 * for the per-model Ollama metadata calls, `providers.ts` for the API
 * provider catalog, `privacy.ts`'s {@link activePolicy} for the door.
 *
 * `codexContextWindow` alone stays an honest "we do not know": `codex debug
 * models`'s own catalog reader (`external.rs::codex_context_window`) has no
 * Electron port anywhere in this tree — `externalAdvisor.ts` names the gap
 * explicitly. `undefined` is not a fabricated success here; it is exactly
 * the value `capabilities.ts`'s own contract defines for "unknown"
 * (`contextWindow: number | null` — "null is we do not know, never a
 * made-up default"), and `locate_in_image` never reads `contextWindow` at
 * all — only {@link visionDoorBlock}'s `vision`/`imageReaches` fields matter
 * here.
 */
const realCapabilitiesForDeps: CapabilitiesForDeps = {
  ollamaCapabilities,
  ollamaNativeContextLength,
  ensureProviderCatalog: (model) => ensureProviderCatalog(model, defaultProviderDeps),
  providerModelFacts,
  codexContextWindow: async () => undefined,
  privacyDoorActive: () => activePolicy() !== null,
};

const realGroundingPickDeps: GroundingPickDeps = {
  ollamaCapabilities,
  ensureProviderCatalog: (model) => ensureProviderCatalog(model, defaultProviderDeps),
  providerModelVision,
  privacyDoorActive: () => activePolicy() !== null,
};

/** The sentinel the viewer maps to the one-click vision-helper pull it
 * already implements. Ported verbatim from `vision.rs`'s own literal. */
export const NO_VISION_MODEL = "NO_VISION_MODEL";

/** Everything {@link locateInImage} needs beyond `db`/`fileId`/`query`, all
 * defaulted to this migration's real implementations — a caller (or a test)
 * overrides only the seam it cares about. */
export interface LocateInImageDeps {
  listModels?: () => Promise<string[]>;
  groundingDeps?: GroundingPickDeps;
  capabilitiesDeps?: CapabilitiesForDeps;
  post?: SidecarPostFn;
}

/** `serde_json::from_value::<Vec<ImageBox>>(v["boxes"].clone())` — ALL of the
 * array or NONE of it: one malformed element fails the whole decode, the
 * same all-or-nothing shape this port uses everywhere a Rust `Vec<T>` decode
 * sits behind a `?`. NOT `unwrap_or_default`, deliberately (see `vision.rs`'s
 * own comment, reproduced on {@link locateInImage}): a shape drift across the
 * language boundary must surface as an error, never as a silent empty
 * answer that reads as a fact about the user's picture. */
function decodeImageBoxes(raw: unknown): ImageBox[] {
  if (!Array.isArray(raw)) {
    throw new Error('The vision pass returned an unreadable result: "boxes" was not an array');
  }
  const out: ImageBox[] = [];
  for (const item of raw) {
    if (
      !isPlainObject(item) ||
      typeof item.label !== "string" ||
      typeof item.x1 !== "number" ||
      typeof item.y1 !== "number" ||
      typeof item.x2 !== "number" ||
      typeof item.y2 !== "number"
    ) {
      throw new Error("The vision pass returned an unreadable result: a box was missing a field");
    }
    out.push({ label: item.label, x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2 });
  }
  return out;
}

/**
 * Ported from `commands::locate_in_image`. Takes the room's
 * ALREADY-UNWRAPPED `Database.Database` — {@link registerVisionIpc} resolves
 * it once per call, matching `previewTools.ts`'s/`peaksTools.ts`'s
 * convention.
 *
 * Throws (matching the Rust `?`/`with_room` chain) when no room is open (via
 * the caller's `openDb`), when `fileId` names no stored bytes, when nothing
 * installed can see (the sentinel {@link NO_VISION_MODEL} — or the more
 * specific privacy-door sentence when {@link visionDoorBlock} has one), or
 * when the sidecar call itself fails or answers a shape this version cannot
 * read.
 */
export async function locateInImage(
  db: Database.Database,
  fileId: string,
  query: string,
  deps: LocateInImageDeps = {}
): Promise<ImageBox[]> {
  const bytes = getFileBytes(db, fileId);
  if (bytes === null) {
    throw new Error("File has no stored content.");
  }
  const explicit = modelSetting(db);

  const listModels = deps.listModels ?? listModelsReal;
  const models = await listModels();
  const chatModel = explicit ?? bestDefault(models);

  const groundingDeps = deps.groundingDeps ?? realGroundingPickDeps;
  const vmodel = await groundingPick(models, chatModel, groundingDeps);
  if (vmodel === null) {
    // PREFLIGHT: nothing could be picked. `NO_VISION_MODEL` says only "download
    // a vision helper" — the right advice for exactly one of the reasons a pick
    // fails. Ask the declared record for the more specific reason (a capable
    // engine the privacy door would blind) and fall back to the sentinel only
    // when "nothing here can see images" really is the whole story.
    const capabilitiesDeps = deps.capabilitiesDeps ?? realCapabilitiesForDeps;
    const caps = await capabilitiesFor(chatModel, capabilitiesDeps);
    throw new Error(visionDoorBlock(caps) ?? NO_VISION_MODEL);
  }

  // HLT-5: release the vision model quickly on low-RAM machines.
  const keep = visionKeepAlive(totalRamBytes(), vmodel, chatModel);
  const body = {
    model: vmodel,
    image_b64: bytes.toString("base64"),
    query,
    base_url: resolvedBaseUrl(),
    temperature: 0.0,
    keep_alive: keep,
  };
  const post = deps.post ?? sidecarJsonCancellable;
  const outcome = await post("/vision_locate", body, new CancelFlag());
  if (outcome.kind === "stopped") {
    // Unreachable in production — the flag passed above is never triggered by
    // anything (`vision.rs`'s own command threads no cancel token through
    // this call either) — but the union is handled exhaustively rather than
    // asserted away, matching `webSearch.ts`'s `searchPage` for the same
    // never-cancelled call shape.
    throw new Error("The vision pass was stopped.");
  }
  if (outcome.kind === "error") {
    throw new Error(sidecarErrorSentinel(outcome.error, vmodel));
  }
  const value = outcome.value;
  const boxesRaw = isPlainObject(value) ? ownValue(value, "boxes") : undefined;
  return decodeImageBoxes(boxesRaw);
}

/**
 * Registers {@link locateInImage} on the `locate_in_image` channel — the
 * Rust `#[tauri::command]` name (and `../shared/ipc-contract.ts`'s
 * already-pinned channel) the renderer already expects, so no rename is
 * needed on that side. `ipcMain` is accepted as a parameter, typed against
 * the real `electron` module without importing it at runtime, so this file
 * resolves and tests under plain Node/vitest exactly like
 * `registerPreviewIpc`/`registerPeaksIpc` do.
 *
 * Exported and directly testable, but — same as those two — NOT called from
 * any live main-process entrypoint by this batch. Wiring it in is Phase 2
 * work pending an explicit owner go-ahead.
 */
export function registerVisionIpc(
  ipcMain: Pick<IpcMain, "handle">,
  room: RoomSource,
  deps?: LocateInImageDeps
): void {
  ipcMain.handle(
    "locate_in_image",
    (_event: IpcMainInvokeEvent, args: { fileId: string; query: string }) =>
      locateInImage(openDb(room), args.fileId, args.query, deps)
  );
}
