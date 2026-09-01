/**
 * Port of `src-tauri/src/commands/office.rs` (449 lines, read in full) — two
 * high-fidelity office-document PREVIEW commands: `slide_preview` (one
 * `.pptx`/`.ppt` slide, drawn by macOS Quick Look) and `office_html` (a
 * legacy `.doc`/`.rtf`, drawn by macOS's own Word importer, `textutil`).
 *
 * SCOPE CHECK DONE BEFORE WRITING THIS FILE, per this batch's instructions —
 * office.rs's actual NEW surface, once the already-ported neighbors are
 * subtracted:
 *   - `editMatchExtraction.ts`/`editMatchCells.ts`/`editMatchDocx.ts`/
 *     `editMatchHtml.ts` are `edit_match.rs`'s document-EDITING machinery
 *     (finding and splicing an old_text/new_text pair inside a docx/xlsx/html
 *     file). office.rs never edits anything — both its commands are
 *     read-only previews — so none of that matcher/fold-table logic applies
 *     here. The one thing genuinely shared is the ZIP layer: `editMatchZip.ts`
 *     (`parseZip`/`readZipEntryText`/`buildZip`), reused below exactly as
 *     `docxEdit.ts`/`editMatchDocx.ts` reuse it, rather than a second
 *     zip reader being written for this file.
 *   - `formats.rs` (behind `safetyTools.ts`) is the "what viewer does this
 *     file open in" CLASSIFICATION table (`slides`/`worddoc` are two of its
 *     rows). It answers "which command to call"; office.rs is the two
 *     commands themselves. No code to reuse there either — the two modules
 *     are caller and callee, not siblings.
 *   - `previewTools.ts` (`commands/preview.rs`'s `quicklook_preview`) turns
 *     out to share a REAL dependency with `slide_preview`: both call
 *     `crate::quicklook::preview_png(name, bytes)` — the exact same PyObjC
 *     Quick Look render this migration's inventory assigns to the Python
 *     sidecar (`arcelle_sidecar/media/quicklook.py`, confirmed ported there;
 *     confirmed NO `/quicklook` HTTP route exists on `server.py` yet, so
 *     Electron main cannot reach it for real). Rather than defining a SECOND
 *     "inject the Quick Look render" seam that could silently drift from
 *     `previewTools.ts`'s, {@link slidePreview} imports and reuses its exact
 *     {@link PreviewRenderFn} type and {@link previewRenderNotImplemented}
 *     default.
 *
 * THE OTHER DEPENDENCY office.rs NEEDS — `crate::textutil::convert(name,
 * bytes, "html")` + `crate::textutil::resolve_field_codes(html, true)`
 * (`textutil.rs`, 296 lines) — TURNED OUT TO BE A REAL PORT, not a stub: a
 * sibling workflow landed `textUtil.ts` (a direct, tested `/usr/bin/textutil`
 * `execFile` bridge, confirmed by reading it in full) in this same tree while
 * this file was being written. Unlike Quick Look (a PyObjC/ObjC-only API,
 * unreachable from plain Node), `/usr/bin/textutil` is an ordinary fixed-path
 * CLI, so `textUtil.ts` is a REAL, WORKING implementation — reused directly
 * here, per this batch's reuse-not-duplicate rule, rather than a second
 * "inject the HTML render" seam that could only ever drift from it. `office_html`
 * therefore needs no injectable seam at all: {@link officeHtml} calls
 * {@link textutilHtml} (this file's port of `office.rs`'s own private
 * `textutil_html` helper) directly, exactly as the Rust source's
 * `office_html` command calls its same-file helper directly.
 *
 * WHAT IS A REAL, FULL PORT BELOW (no seam, exercised by real tests against
 * real fixtures): the `<p:sldIdLst>` splice that makes per-slide rendering
 * possible at all (`findTagBody`/`splitSelfClosing`/`slideCountOf`/
 * `deckWithSlideFirst`), the sha256-keyed, oldest-eviction slide cache
 * ({@link SlideCache}/{@link evictToFit}), the room lookup, the empty-bytes
 * short-circuit, the legacy-`.ppt`-counts-as-one-page rule, AND the whole of
 * `office_html` (real `textutil` conversion, real field-code resolution).
 * Only `slide_preview`'s actual PIXEL render is a stub — the one genuinely
 * unported half.
 *
 * NOT MODEL TOOLS: neither `slide_preview` nor `office_html` has an
 * `exec_tool` arm in `agent.rs`, nor an entry in `toolSpecs.ts`/
 * `toolSchema.ts` (confirmed by grep) — both exist purely for the file
 * viewer UI, exactly like the Rust `#[tauri::command]`s they port. Nothing
 * in this file touches `execTool.ts`.
 *
 * THE `usize` GAP, same shape `peaksTools.ts`'s `clampBuckets` closes for
 * `buckets`: Tauri's own deserialization refuses a negative/non-integer
 * `index` before `slide_preview` ever runs (`usize` cannot hold one), so
 * Rust's body only ever sees a valid array index. Electron's IPC bridge
 * enforces no such boundary, so {@link slidePreview} rejects synchronously,
 * before any room/DB work, for anything that isn't a non-negative integer —
 * closing a gap Rust's type system closes for free, not opening a new one
 * (an unguarded negative index would otherwise reach `deckWithSlideFirst`'s
 * array indexing as `undefined` and splice a corrupt slide list rather than
 * failing cleanly).
 *
 * `Map`, NOT a `{}` LITERAL, for {@link SlideCache}'s cache (RULE 2 of this
 * batch): the key embeds `id`, a room-controlled file id.
 *
 * NO IPC WIRING in this batch, same as `dictStopTimeout.ts`/`recIpc.ts`/
 * `previewTools.ts`/`docxEdit.ts`: Phase 2 (renderer/preload) needs an
 * explicit owner go-ahead before touching the live shipping app.
 * {@link registerOfficeIpc} exists, ready to be wired, but nothing calls it
 * yet. Both channel names and argument/result shapes are already pinned on
 * `ipc-contract.ts` (`slide_preview`/`office_html`), so nothing here invents
 * a wire shape. `SlideCache`'s teardown (`rooms.rs`'s `clear_slides` on room
 * close) also has no Electron caller yet — `roomManager.ts`'s own doc lists
 * `SlideCache` among the six caches its `clearEphemeralCaches` seam is
 * waiting on; {@link clearSlides} is exported for whichever future
 * room-lifecycle batch wires it in.
 */

import { createHash } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { getFileFull } from "./db-host/files.js";
import { readRoomFile } from "./workspace/roomContent.js";
import { buildZip, parseZip, readZipEntryText, type ZipEntry, type ZipWriteEntry } from "./editMatchZip.js";
import { previewRenderNotImplemented, type PreviewRenderFn } from "./previewTools.js";
import { convert as textutilConvert, resolveFieldCodes } from "./textUtil.js";
import type { OpenRoom } from "./turnEngine.js";
import type { SlideImage } from "../shared/apiTypes.js";

export type { PreviewRenderFn };

// ------------------------------------------------------------- room plumbing

/** The slice of the (not-yet-ported) `AppState` this command needs: whichever
 * room is open RIGHT NOW. Reuses `turnEngine.ts`'s {@link OpenRoom} rather
 * than inventing a second "how do I reach the open room" convention — same
 * local-copy convention `recIpc.ts`/`previewTools.ts`/`docxEdit.ts` each
 * already follow for their own `RoomSource`. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

/** `AppState::with_room`'s own refusal, spelled the way every other ported
 * command already spells it. */
const NO_ROOM_OPEN = "No room is open.";

function openRoom(room: RoomSource): OpenRoom {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open;
}

// ============================================================================
// Slide images (ported from office.rs's "HIGH-FIDELITY OFFICE RENDERING" half)
// ============================================================================

const PRESENTATION_PART = "ppt/presentation.xml";

/**
 * Byte range of an element's BODY (between `<tag …>` and `</tag>`). Ported
 * verbatim from `office.rs`'s `find_tag_body`. Works on JS string indices
 * (UTF-16 code units) rather than Rust's UTF-8 byte offsets — both are only
 * ever used to slice and re-concatenate the SAME string they were found in,
 * so the two indexing schemes never need to agree with each other, only with
 * themselves.
 */
function findTagBody(xml: string, tag: string): [number, number] | undefined {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const at = xml.indexOf(open);
  if (at === -1) {
    return undefined;
  }
  const gt = xml.indexOf(">", at);
  if (gt === -1) {
    return undefined;
  }
  const body = gt + 1;
  const end = xml.indexOf(close, body);
  if (end === -1) {
    return undefined;
  }
  return [body, end];
}

/**
 * Every `<tag …/>` (or `<tag …></tag>`) element in a fragment, as substrings.
 * Ported verbatim from `office.rs`'s `split_self_closing`.
 *
 * The long spelling is a WHOLE element: PowerPoint writes
 * `<p:sldId id="256" r:id="rId1"><p:extLst>…</p:extLst></p:sldId>`, and
 * carrying only its opening tag through would leave the rewritten
 * `<p:sldIdLst>` unbalanced.
 */
function splitSelfClosing(fragment: string, tag: string): string[] {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = fragment.indexOf(open, from);
    if (start === -1) {
      break;
    }
    const gtAt = fragment.indexOf(">", start);
    if (gtAt === -1) {
      break;
    }
    const gt = gtAt + 1;
    let end: number;
    if (fragment.slice(start, gt).endsWith("/>")) {
      end = gt;
    } else {
      const closeAt = fragment.indexOf(close, gt);
      if (closeAt === -1) {
        // An element whose closing tag is missing is not one that can be
        // moved, so the scan stops rather than emitting half of it.
        break;
      }
      end = closeAt + close.length;
    }
    out.push(fragment.slice(start, end));
    from = end;
  }
  return out;
}

/** How many slides a deck has. Ported verbatim from `office.rs`'s
 * `slide_count_of`. A legacy binary `.ppt` (an OLE compound file, not a zip
 * of XML) has no `<p:sldIdLst>` to read and returns 0 here — {@link slidePreview}
 * is what turns that 0 into "one drawable page", exactly as the Rust source
 * does. */
export function slideCountOf(bytes: Uint8Array): number {
  const xml = readZipEntryText(bytes, PRESENTATION_PART);
  if (xml === undefined) {
    return 0;
  }
  const body = findTagBody(xml, "p:sldIdLst");
  if (body === undefined) {
    return 0;
  }
  const [s, e] = body;
  return splitSelfClosing(xml.slice(s, e), "p:sldId").length;
}

interface PresentationSlideList {
  xml: string;
  listStart: number;
  listEnd: number;
  ids: string[];
}

function presentationSlideList(bytes: Uint8Array): PresentationSlideList {
  const xml = readZipEntryText(bytes, PRESENTATION_PART);
  if (xml === undefined) {
    throw new Error("This file is not a readable .pptx presentation.");
  }
  const body = findTagBody(xml, "p:sldIdLst");
  if (body === undefined) {
    throw new Error("This presentation does not list its slides, so its pages can't be drawn.");
  }
  const [listStart, listEnd] = body;
  const ids = splitSelfClosing(xml.slice(listStart, listEnd), "p:sldId");
  if (ids.length === 0) {
    throw new Error("This presentation has no slides.");
  }
  return { xml, listStart, listEnd, ids };
}

/**
 * Rewrite a deck so slide `index` is the FIRST slide. Ported verbatim from
 * `office.rs`'s `deck_with_slide_first`.
 *
 * This is the trick that makes per-slide rendering possible at all: Quick
 * Look renders page one of a document and offers no way to ask for another,
 * but a `.pptx` states its own running order in `<p:sldIdLst>` inside
 * `ppt/presentation.xml`. Moving the wanted slide to the front of that list —
 * and changing nothing else — makes the slide asked for the one Quick Look
 * draws. Slides are REORDERED rather than deleted: dropping the others would
 * mean pruning their relationships, notes and media too.
 *
 * Every other zip entry is copied through with `raw` ({@link ZipWriteEntry}) —
 * `editMatchZip.ts`'s equivalent of the Rust source's `raw_copy_file` — so no
 * media, layout, master or theme part is recompressed or re-encoded.
 *
 * Throws (matching the Rust `Result::Err` this un-does via `?`) when `bytes`
 * isn't a readable `.pptx`, the presentation lists no slides, or `index` is
 * out of range for it. In practice {@link slidePreview}'s own guard (`index
 * >= slides`, where `slides` comes from {@link slideCountOf} on these exact
 * bytes) means the out-of-range and no-slides cases can never actually reach
 * here through that call site — kept as real thrown errors anyway, both
 * because this function has its own direct tests and because a future caller
 * must not be able to silently corrupt a deck by skipping that guard.
 */
export function deckWithSlideFirst(bytes: Uint8Array, index: number): Buffer {
  const { xml, listStart, listEnd, ids } = presentationSlideList(bytes);
  if (index >= ids.length) {
    throw new Error(`This presentation has ${ids.length} slides.`);
  }
  // Slide `index` first, the rest in their original order behind it.
  let reordered = ids[index] as string;
  for (let i = 0; i < ids.length; i++) {
    if (i !== index) {
      reordered += ids[i];
    }
  }
  const patched = xml.slice(0, listStart) + reordered + xml.slice(listEnd);

  const archive: ZipEntry[] = parseZip(bytes);
  const writeEntries: ZipWriteEntry[] = archive.map((entry) =>
    entry.name === PRESENTATION_PART
      ? { name: entry.name, data: Buffer.from(patched, "utf8") }
      : { name: entry.name, raw: entry }
  );
  return buildZip(writeEntries);
}

/** Which deck these bytes are, so a rewritten file (same id, new bytes)
 * cannot be answered with the previous one's cached slides. Ported from
 * `office.rs`'s `deck_digest` (`sha2::Sha256`, lower-hex). */
function deckDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Slides held at once. A deck's worth of PNGs is a few MB; past this the
 * oldest go rather than growing without bound. Ported from `office.rs`'s
 * `MAX_CACHED_SLIDES`. */
export const MAX_CACHED_SLIDES = 60;

/** One cached slide render, with the insertion sequence it was cached at —
 * what orders eviction at the ceiling. */
export interface SlideCacheEntry {
  readonly seq: number;
  readonly pngB64: string;
}

/**
 * Rendered slides, keyed by `<file id>:<index>:<digest of the bytes>`. Ported
 * from `office.rs`'s `SlideCache` — see this module's doc for why a `Map`,
 * not a `{}` literal (RULE 2: `id` is room-controlled).
 *
 * `seq` is ported explicitly, rather than relying on a JS `Map`'s own
 * insertion-order iteration (which would in fact give the identical answer
 * here, since a cache HIT never rewrites an existing key and every MISS
 * writes a brand-new one): mirroring the Rust `AtomicU64` counter keeps
 * {@link evictToFit} a direct, literal port with its own Rust-parity unit
 * tests, rather than an implicit fact about `Map` ordering a future edit
 * could break without anything here noticing.
 */
export interface SlideCache {
  readonly map: Map<string, SlideCacheEntry>;
  /** The next insertion sequence number. Only ever read/incremented via
   * {@link nextSlideSeq} — never touched directly, the same discipline the
   * Rust source's `AtomicU64` enforces structurally. */
  inserted: number;
}

/** A fresh, empty cache — the TS equivalent of `SlideCache::default()`. */
export function createSlideCache(): SlideCache {
  return { map: new Map(), inserted: 0 };
}

/** `clear_slides` — drop every cached render. Called when the room they were
 * drawn from closes; not wired to anything in this batch (see this module's
 * doc). */
export function clearSlides(cache: SlideCache): void {
  cache.map.clear();
}

function nextSlideSeq(cache: SlideCache): number {
  const seq = cache.inserted;
  cache.inserted += 1;
  return seq;
}

/**
 * Make room for one more entry by dropping the OLDEST, one at a time. Ported
 * verbatim from `office.rs`'s `evict_to_fit`.
 *
 * Emptying the map at the ceiling — which an earlier version of the Rust
 * source used to do — meant a deck longer than the ceiling paid a fresh
 * Quick Look render for every slide from then on, including the one the
 * reader had just come from. Exported for its own direct Rust-parity tests.
 */
export function evictToFit(map: Map<string, SlideCacheEntry>, ceiling: number): void {
  while (map.size >= ceiling) {
    let oldestKey: string | undefined;
    let oldestSeq = Infinity;
    for (const [key, entry] of map) {
      if (entry.seq < oldestSeq) {
        oldestSeq = entry.seq;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) {
      break;
    }
    map.delete(oldestKey);
  }
}

interface SlidePreviewPlan {
  bytes: Buffer;
  ooxml: number;
  slides: number;
  key: string;
}

function assertSlideIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `slide_preview's index must be a non-negative integer (Tauri's usize deserialization ` +
        `would refuse anything else before the command ever ran); got ${index}.`
    );
  }
}

function planSlidePreview(id: string, index: number, storedBytes: Buffer | null): SlidePreviewPlan | null {
  const bytes = storedBytes ?? Buffer.alloc(0);
  if (bytes.length === 0) return null;
  const ooxml = slideCountOf(bytes);
  const slides = Math.max(ooxml, 1);
  if (index >= slides) return null;
  return { bytes, ooxml, slides, key: `${id}:${index}:${deckDigest(bytes)}` };
}

function cachedSlide(plan: SlidePreviewPlan, cache: SlideCache): SlideImage | undefined {
  const hit = cache.map.get(plan.key);
  return hit === undefined ? undefined : { pngB64: hit.pngB64, slides: plan.slides };
}

function bytesToRender(plan: SlidePreviewPlan, index: number): Buffer {
  return index === 0 || plan.ooxml === 0
    ? Buffer.from(plan.bytes)
    : deckWithSlideFirst(plan.bytes, index);
}

function cacheSlide(plan: SlidePreviewPlan, cache: SlideCache, png: Buffer): SlideImage {
  const pngB64 = png.toString("base64");
  const seq = nextSlideSeq(cache);
  evictToFit(cache.map, MAX_CACHED_SLIDES);
  cache.map.set(plan.key, { seq, pngB64 });
  return { pngB64, slides: plan.slides };
}

async function previewSlideBytes(
  name: string,
  id: string,
  index: number,
  storedBytes: Buffer | null,
  cache: SlideCache,
  render: PreviewRenderFn,
): Promise<SlideImage | null> {
  const plan = planSlidePreview(id, index, storedBytes);
  if (plan === null) return null;
  const cached = cachedSlide(plan, cache);
  if (cached !== undefined) return cached;
  const png = await render(name, bytesToRender(plan, index));
  return png === null ? null : cacheSlide(plan, cache, png);
}

/**
 * One slide of a `.pptx`, drawn by macOS at full fidelity. Ported from
 * `office.rs`'s `slide_preview` `#[tauri::command]`.
 *
 * `null` (Rust's `Ok(None)`) is a normal answer for an empty-bytes file or an
 * out-of-range `index` — never a fabricated image. `render` is
 * `previewTools.ts`'s {@link PreviewRenderFn} (see this module's doc for why
 * it is reused rather than re-declared): the actual Quick Look render is the
 * one genuinely unported half, defaulting to
 * {@link previewRenderNotImplemented}'s labelled rejection.
 *
 * A legacy binary `.ppt` has no `<p:sldIdLst>` to read or reorder — it is an
 * OLE compound file, not a zip of XML — so it is treated as a one-page
 * document (`ooxml === 0` ⇒ `slides = 1`, and the ORIGINAL bytes, un-reordered,
 * are handed to `render`) rather than reported as undrawable.
 *
 * THE `usize` GUARD (see this module's doc): thrown synchronously, before any
 * room/DB work, for a negative or non-integer `index` — the same shape
 * `peaksTools.ts`'s `clampBuckets` doc describes for `buckets`, except here
 * the honest choice is to REJECT rather than silently clamp, because Tauri's
 * own deserialization failure for a bad `usize` is itself a rejected
 * `invoke()`, not a resolved fallback value.
 */
export async function slidePreview(
  db: Database.Database,
  id: string,
  index: number,
  cache: SlideCache,
  render: PreviewRenderFn = previewRenderNotImplemented
): Promise<SlideImage | null> {
  assertSlideIndex(index);
  const [name, , storedBytes] = getFileFull(db, id);
  return previewSlideBytes(name, id, index, storedBytes, cache, render);
}

/** Same renderer path, with current bytes loaded from the room's source of truth. */
export async function slidePreviewInRoom(
  open: OpenRoom,
  id: string,
  index: number,
  cache: SlideCache,
  render: PreviewRenderFn = previewRenderNotImplemented,
): Promise<SlideImage | null> {
  assertSlideIndex(index);
  const file = await readRoomFile(open, id);
  return previewSlideBytes(file.name, id, index, file.bytes, cache, render);
}

// ============================================================================
// Word-as-HTML (ported from office.rs's "Word as HTML" half)
// ============================================================================

/**
 * `crate::textutil::convert(name, bytes, "html")` then, if that produced
 * anything, `crate::textutil::resolve_field_codes(&html, true)` — ported
 * verbatim from `office.rs`'s own private `textutil_html` helper. Both halves
 * are REAL, tested ports (`textUtil.ts`'s `convert`/`resolveFieldCodes` — see
 * this module's doc), so unlike `slide_preview`'s Quick Look half this needs
 * no injectable seam: `office_html` calls this directly, exactly as the Rust
 * source's `office_html` command calls its own same-file helper directly.
 *
 * Rust's `tauri::async_runtime::spawn_blocking` wrapper around this call has
 * no analogue here: `textUtil.ts`'s `convert` is already `async` (built on
 * `execFile`/`fs/promises`), so it never blocks Node's event loop the way the
 * Rust source's synchronous subprocess call would block a sync fn — nothing
 * here needs to ask for a separate thread the way the Rust source does.
 */
async function textutilHtml(name: string, bytes: Buffer): Promise<string | null> {
  const html = await textutilConvert(name, bytes, "html");
  if (html === null) {
    return null;
  }
  return resolveFieldCodes(html, true);
}

/**
 * A legacy `.doc` (and `.rtf`) rendered as formatted HTML by macOS's own Word
 * importer, rather than shown as recovered plain text. Ported from
 * `office.rs`'s `office_html` `#[tauri::command]`.
 *
 * `null` (Rust's `Ok(None)`) is the answer for a file with no stored bytes at
 * all, or for a format `textutil` cannot import — never a fabricated
 * document.
 */
export async function officeHtml(db: Database.Database, id: string): Promise<string | null> {
  const [name, , storedBytes] = getFileFull(db, id);
  const bytes = storedBytes ?? Buffer.alloc(0);
  if (bytes.length === 0) {
    return null;
  }
  return textutilHtml(name, bytes);
}

export async function officeHtmlInRoom(open: OpenRoom, id: string): Promise<string | null> {
  const file = await readRoomFile(open, id);
  const bytes = file.bytes ?? Buffer.alloc(0);
  return bytes.length === 0 ? null : textutilHtml(file.name, bytes);
}

// ============================================================================
// IPC registration (not wired into any bootstrap — see this module's doc)
// ============================================================================

/**
 * Registers {@link slidePreview} and {@link officeHtml} on the `slide_preview`
 * and `office_html` channels — the Rust `#[tauri::command]` names
 * `ipc-contract.ts` already pins and `src/api.ts`'s `invoke(...)` calls
 * already use, so the renderer side needs no rename. `ipcMain` is accepted as
 * a parameter, typed against the real `electron` module without importing it
 * at runtime, so this file resolves and tests under plain Node/vitest exactly
 * like `registerPreviewIpc`/`registerDocxEditIpc` do.
 *
 * Exported and directly testable, but — same as every other file in this
 * batch — NOT called from any live main-process entrypoint. Wiring it in is
 * Phase 2 work pending an explicit owner go-ahead.
 */
export function registerOfficeIpc(
  ipcMain: Pick<IpcMain, "handle">,
  room: RoomSource,
  cache: SlideCache,
  renderSlide?: PreviewRenderFn
): void {
  ipcMain.handle(
    "slide_preview",
    (_event: IpcMainInvokeEvent, args: { id: string; index: number }) =>
      slidePreviewInRoom(openRoom(room), args.id, args.index, cache, renderSlide)
  );
  ipcMain.handle(
    "office_html",
    (_event: IpcMainInvokeEvent, args: { id: string }) => officeHtmlInRoom(openRoom(room), args.id)
  );
}
