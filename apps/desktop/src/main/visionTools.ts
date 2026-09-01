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
 *     route is NOT a gap either: `services/agent-sidecar/src/arcelle_sidecar/vision.py` and
 *     `server.py`'s `POST /vision_locate` are already implemented (confirmed
 *     by reading both, plus `services/agent-sidecar/tests/test_vision.py`) — Phase 2 of the
 *     migration per `services/agent-sidecar/MIGRATION-SPEC.md`. The Electron-side command
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
 * wave owns (confirmed: `models.ts` does not exist under `src/main`).
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
import { readRoomFile } from "./workspace/roomContent.js";
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
import {
  boxesSchema,
  groundingPrompt,
  isPlainObject,
  ownValue,
  parseBoxes,
} from "./visionImageGrounding.js";

export type { ImageBox, PreparedImage };
export * from "./visionImageGrounding.js";

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

async function chatModelCanGround(
  chatModel: string,
  deps: GroundingPickDeps,
): Promise<boolean> {
  if (!imageReachesModel(chatModel, deps.privacyDoorActive)) return false;
  return isYes(await visionSupport(chatModel, deps));
}

function installedFallbackCanGround(model: string, chatModel: string): boolean {
  return model !== chatModel && runsOnThisMac(model);
}

async function visionFallback(
  models: readonly string[],
  chatModel: string,
  deps: GroundingPickDeps,
): Promise<string | null> {
  for (const model of models) {
    if (!installedFallbackCanGround(model, chatModel)) continue;
    if (isYes(await visionSupport(model, deps))) return model;
  }
  return null;
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
  if (await chatModelCanGround(chatModel, deps)) return chatModel;
  return visionFallback(models, chatModel, deps);
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

function openRoom(room: RoomSource): OpenRoom {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open;
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
function numericImageBoxField(item: Record<string, unknown>, field: string): number | null {
  const value = item[field];
  return typeof value === "number" ? value : null;
}

function imageBoxCoordinates(item: Record<string, unknown>): [number, number, number, number] | null {
  const x1 = numericImageBoxField(item, "x1");
  if (x1 === null) return null;
  const y1 = numericImageBoxField(item, "y1");
  if (y1 === null) return null;
  const x2 = numericImageBoxField(item, "x2");
  if (x2 === null) return null;
  const y2 = numericImageBoxField(item, "y2");
  return y2 === null ? null : [x1, y1, x2, y2];
}

function decodedImageBox(raw: unknown): ImageBox | null {
  if (!isPlainObject(raw) || typeof raw.label !== "string") return null;
  const coordinates = imageBoxCoordinates(raw);
  if (coordinates === null) return null;
  const [x1, y1, x2, y2] = coordinates;
  return { label: raw.label, x1, y1, x2, y2 };
}

function decodeImageBoxes(raw: unknown): ImageBox[] {
  if (!Array.isArray(raw)) {
    throw new Error('The vision pass returned an unreadable result: "boxes" was not an array');
  }
  const out: ImageBox[] = [];
  for (const item of raw) {
    const box = decodedImageBox(item);
    if (box === null) {
      throw new Error("The vision pass returned an unreadable result: a box was missing a field");
    }
    out.push(box);
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
  return locateBytes(db, bytes, query, deps);
}

interface LocateModelChoice {
  chatModel: string;
  visionModel: string | null;
}

async function locateModelChoice(
  db: Database.Database,
  deps: LocateInImageDeps,
): Promise<LocateModelChoice> {
  const explicit = modelSetting(db);
  const listModels = deps.listModels ?? listModelsReal;
  const models = await listModels();
  const chatModel = explicit ?? bestDefault(models);
  const groundingDeps = deps.groundingDeps ?? realGroundingPickDeps;
  const visionModel = await groundingPick(models, chatModel, groundingDeps);
  return { chatModel, visionModel };
}

async function requiredVisionModel(
  choice: LocateModelChoice,
  deps: LocateInImageDeps,
): Promise<string> {
  if (choice.visionModel !== null) return choice.visionModel;
  const capabilitiesDeps = deps.capabilitiesDeps ?? realCapabilitiesForDeps;
  const caps = await capabilitiesFor(choice.chatModel, capabilitiesDeps);
  throw new Error(visionDoorBlock(caps) ?? NO_VISION_MODEL);
}

function visionLocateBody(
  bytes: Buffer,
  query: string,
  visionModel: string,
  chatModel: string,
) {
  const keep = visionKeepAlive(totalRamBytes(), visionModel, chatModel);
  return {
    model: visionModel,
    image_b64: bytes.toString("base64"),
    query,
    base_url: resolvedBaseUrl(),
    temperature: 0.0,
    keep_alive: keep,
  };
}

async function visionLocateValue(
  body: ReturnType<typeof visionLocateBody>,
  visionModel: string,
  deps: LocateInImageDeps,
): Promise<unknown> {
  const post = deps.post ?? sidecarJsonCancellable;
  const outcome = await post("/vision_locate", body, new CancelFlag());
  if (outcome.kind === "stopped") {
    throw new Error("The vision pass was stopped.");
  }
  if (outcome.kind === "error") {
    throw new Error(sidecarErrorSentinel(outcome.error, visionModel));
  }
  return outcome.value;
}

function decodedLocateBoxes(value: unknown): ImageBox[] {
  const boxesRaw = isPlainObject(value) ? ownValue(value, "boxes") : undefined;
  return decodeImageBoxes(boxesRaw);
}

async function locateBytes(
  db: Database.Database,
  bytes: Buffer,
  query: string,
  deps: LocateInImageDeps,
): Promise<ImageBox[]> {
  const choice = await locateModelChoice(db, deps);
  const visionModel = await requiredVisionModel(choice, deps);
  const body = visionLocateBody(bytes, query, visionModel, choice.chatModel);
  const value = await visionLocateValue(body, visionModel, deps);
  return decodedLocateBoxes(value);
}

export async function locateInImageInRoom(
  open: OpenRoom,
  fileId: string,
  query: string,
  deps: LocateInImageDeps = {},
): Promise<ImageBox[]> {
  const file = await readRoomFile(open, fileId);
  if (file.bytes === null) throw new Error("File has no stored content.");
  return locateBytes(open.db, file.bytes, query, deps);
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
      locateInImageInRoom(openRoom(room), args.fileId, args.query, deps)
  );
}
