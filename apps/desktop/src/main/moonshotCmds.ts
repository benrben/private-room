/**
 * The MOONSHOT dispatcher — ported from `src-tauri/src/commands/moonshot.rs`
 * (129 lines, read in full). "Moonshot" is the app-to-file-format
 * repositioning strategy shipped 2026-07-06: a `.roomai` file should be a
 * self-sufficient artifact, not a database only this app's UI can open. In
 * the Rust source `moonshot.rs` itself is a thin `mod`-and-`pub use`
 * aggregator over SIX submodules, each its own porting task:
 *
 *   - `moonshot/ai_actions.rs` (539 lines) — D5/D12: the 14 one-click AI
 *     actions (flashcards, mind map, podcast script, summarize, …) and the
 *     studios that run them.
 *   - `moonshot/discovery.rs` (107 lines) — Wave 1a: `~/.arcelle/leash.json`,
 *     the self-configuration record an external agent reads to find the
 *     Leash server below.
 *   - `moonshot/front_page.rs` (227 lines) — D4: the instant, model-free
 *     landing view (recent files/chats/memories + cached suggestions).
 *   - `moonshot/graph.rs` (1163 lines) — D3: the room graph (files/memories
 *     as nodes, six kinds of inferred/proven edges).
 *   - `moonshot/roles.rs` (132 lines) — D11: the static "room role" persona
 *     catalog (tutor, critic, opposing counsel, scribe, …).
 *   - `moonshot/server.rs` (462 lines) — D9: the Leash, a persistent local
 *     MCP server an external agent (Claude Code, Codex, …) can attach to for
 *     read-only or full room access.
 *
 * All six now have an Electron port — `moonshotAiActions.ts`,
 * `moonshotDiscovery.ts`, `moonshotFrontPage.ts`, `moonshotGraph.ts`,
 * `moonshotRoles.ts`, `moonshotServer.ts`, landed alongside this file. Each is
 * its own module, exactly as Rust keeps them as six `mod`s; this file ports
 * ONLY `moonshot.rs`'s own code, the three pieces that exist directly in the
 * dispatcher rather than in a submodule:
 *
 * The four submodules that need a model or a room take THIS file's
 * {@link RoomSource} and {@link resolveStructuredModel} directly — that is the
 * whole point of porting the dispatcher's shared helper for real. If a seventh
 * moonshot module ever appears, it imports from here; it does not re-derive.
 *
 *   1. {@link resolveStructuredModel} — `resolve_structured_model`, the
 *      shared engine-routing helper every structured side-call (studios, AI
 *      actions, front-page suggestions, feedback drafts) resolves its model
 *      through. `pub(crate)` in Rust, so nothing calls it from outside this
 *      crate; ported here as a real, working function (every one of its own
 *      dependencies — `modelSetting`, `isExternalEngine`, `listModels`,
 *      `bestLocalDefault` — already has a real Electron port) so the day one
 *      of the six submodules above gets ported, it can import this directly
 *      instead of re-deriving a private copy the way `feedbackTools.ts` and
 *      `recBridge.ts` were forced to (see this file's REUSED note below).
 *   2. {@link recommendedModels} — D1, `#[tauri::command] recommended_models`.
 *   3. {@link ensureEmbedModel} — D2, `#[tauri::command] ensure_embed_model`.
 *
 * Both (2) and (3) are plain Settings-screen commands invoked directly by the
 * renderer's `invoke(...)` — confirmed against `toolSpecs.ts`/`toolSchema.ts`/
 * `execTool.ts` on both the Rust side (neither name appears in `agent.rs`'s
 * `match tool_name`) and this migration's own `execTool.ts`/`toolSpecs.ts`
 * (neither name appears there either). Nothing here is model-invocable, so
 * nothing was added to `execTool.ts`.
 *
 * ============================================================================
 * WHAT'S REAL VS. THE ONE HONEST GAP
 * ============================================================================
 * {@link resolveStructuredModel} and {@link recommendedModels} are fully real
 * — no stubs, no injected fakes required for correctness (only for testing
 * without a live sidecar). {@link ensureEmbedModel} is real for everything
 * except the final `spawn_embedding_backfill(&app)` call: that function DOES
 * have a real Electron port (`retrievalBackfill.ts::spawnEmbeddingBackfill`),
 * but building the per-room `EmbedBackfillState`/`EmbedBackfillDeps` it needs
 * is integration work this dispatcher-level file cannot do on its own —
 * `roomManager.ts` hit exactly the same wall for the exact same call and
 * solved it the exact same way: an optional injected callback that defaults
 * to an honest SKIPPED log rather than a thrown NOT_IMPLEMENTED, because
 * Rust's own call is `tauri::async_runtime::spawn`, fire-and-forget — a
 * missing background kick must not fail the whole command, and
 * `ensure_embed_model` returns `Ok(())` unconditionally in the Rust source.
 * See {@link EnsureEmbedModelDeps.spawnEmbeddingBackfill}.
 *
 * ============================================================================
 * REUSED, NOT RE-PORTED
 * ============================================================================
 *   - `gatherContext.ts::modelSetting` — `models.rs::model_setting`.
 *   - `turnContext.ts::isExternalEngine` — `external.rs::is_external_engine`.
 *   - `engineRouting.ts::listModels` — `ollama::list_models`. Its documented
 *     fold-every-failure-into-`[]` simplification is a NO-OP fidelity concern
 *     here: Rust's own `resolve_structured_model` does `.ok()?` (an `Err`
 *     becomes `None`) and its own `ensure_embed_model` does
 *     `.unwrap_or_default()` (an `Err` becomes `[]`) — both already collapse
 *     an error and an empty success to the same outcome this port produces.
 *   - `ollamaModels.ts::bestLocalDefault` — `models.rs::best_local_default`.
 *     `feedbackTools.ts` and `recBridge.ts` each carry an older, smaller
 *     stand-in for this exact seam (a private duplicate and an injected-only
 *     dependency, respectively) written before this real port existed; a
 *     future consolidation pass should point them at this one instead of
 *     leaving three copies of "how do we pick the local chat model" in the
 *     tree — out of scope for this batch, which touches only `moonshot.rs`.
 *   - `ollamaModels.ts::pullCancellable` — `ollama::pull_cancellable`.
 *     Rust's `ensure_embed_model` calls the UNCANCELLABLE `ollama::pull`,
 *     which is itself defined as `pull_cancellable` driven with a flag that
 *     is never set (`ollama.rs:562-567`); this port makes the identical
 *     substitution with a freshly constructed {@link CancelFlag}, matching
 *     `feedbackTools.ts`'s own `neverCancelled()` precedent for the same
 *     Rust pattern.
 *   - `db-host/meta.ts::setMeta` — `db::set_meta`.
 *   - `turnEngine.ts::OpenRoom` / the local {@link RoomSource} shape —
 *     `recIpc.ts`'s and `turnEngine.ts`'s own "read the currently open room,
 *     right now" convention, not `jobs.ts`'s differently-named one: this file
 *     is a command-and-IPC layer like `recIpc.ts`/`ollamaModels.ts`, not a
 *     background job runner.
 *
 * {@link registerMoonshotIpc} is NOT invoked from any bootstrap, per
 * `recIpc.ts`'s precedent: it exists, it is tested directly, and a
 * renderer-side owner wires it when Phase 2 starts.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";

import { setMeta } from "./db-host/meta.js";
import { CancelFlag } from "./cancel.js";
import { listModels as listModelsReal } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import {
  bestLocalDefault,
  pullCancellable as pullCancellableReal,
  type PullOutcome,
  type PullProgressListener,
} from "./ollamaModels.js";
import { isExternalEngine } from "./turnContext.js";
import type { OpenRoom } from "./turnEngine.js";

// ============================================================================
// Room access — matches `recIpc.ts`'s own `RoomSource` shape verbatim.
// ============================================================================

/** The slice of room state every command in this file needs: whichever room
 * is open RIGHT NOW, read once and synchronously — mirroring Rust's
 * `state.room.lock().unwrap()` guard, which is taken and dropped BEFORE the
 * first `.await` in both `resolve_structured_model` and `ensure_embed_model`,
 * so a room closed or swapped mid-call can never retroactively change what
 * was already decided. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

// ============================================================================
// resolve_structured_model — the shared engine-routing helper.
// ============================================================================

export interface ResolveStructuredModelDeps {
  /** `ollama::list_models()`. Defaults to the real, already-ported
   * `engineRouting.ts` implementation. */
  listModels?: () => Promise<string[]>;
}

/**
 * Resolve the chat model for a structured side-call (studios, AI actions,
 * front page, feedback drafts), honoring the room's explicit `model` setting.
 * Ported from `resolve_structured_model`.
 *
 * Engine parity: the CHOSEN engine is used as-is — an external engine
 * (`claude-cli`/`codex-cli`/`openrouter`, or an Ollama `:cloud` relay) is
 * returned immediately without ever calling `listModels`, because it needs no
 * locally installed model to resolve. Otherwise, `undefined` when Ollama is
 * unreachable or has no models installed (Rust: `None`), so callers can
 * degrade to empty/partial output rather than fabricate a model name.
 */
export async function resolveStructuredModel(
  rooms: RoomSource,
  deps: ResolveStructuredModelDeps = {}
): Promise<string | undefined> {
  const explicit = structuredModelSetting(rooms);
  const external = externalStructuredModel(explicit);
  if (external !== null) return external;
  const listModels = deps.listModels ?? listModelsReal;
  const models = await listModels();
  return resolvedLocalModel(explicit, models);
}

function structuredModelSetting(rooms: RoomSource): string | null {
  const room = rooms.currentRoom();
  return room === null ? null : modelSetting(room.db);
}

function externalStructuredModel(explicit: string | null): string | null {
  return explicit !== null && isExternalEngine(explicit) ? explicit : null;
}

function resolvedLocalModel(explicit: string | null, models: readonly string[]): string | undefined {
  if (models.length === 0) return undefined;
  return explicit ?? bestLocalDefault(models);
}

// ============================================================================
// D1: recommended_models
// ============================================================================

/** `ollama.rs`'s own `EMBED_MODEL`. Copied verbatim rather than imported —
 * `turnContext.ts` and `retrievalBackfill.ts` already establish this as the
 * convention for this one small constant rather than a shared re-export. */
const EMBED_MODEL = "nomic-embed-text";

export interface RecommendedModels {
  embed: string;
  vision: string;
}

/**
 * D1: the two SPECIAL models Settings offers to pull — the grounding
 * (vision) model and the embedding model. Pure/static, ported verbatim from
 * `recommended_models`: `vision` matches the grounding router's Qwen-VL pick,
 * `embed` is the shared constant.
 *
 * There is deliberately no `chat` field: the Rust doc comment records that one
 * used to exist, was sent on every Settings open, and no screen ever read it
 * (the first-run chooser has its own richer roster; Settings only ever reads
 * `embed`/`vision`) — so it stays gone here too.
 */
export function recommendedModels(): RecommendedModels {
  return { embed: EMBED_MODEL, vision: "qwen2.5vl" };
}

// ============================================================================
// D2: ensure_embed_model
// ============================================================================

export interface EnsureEmbedModelDeps {
  /** `ollama::list_models()`. Defaults to the real, already-ported
   * `engineRouting.ts` implementation. */
  listModels?: () => Promise<string[]>;
  /** `ollama::pull(EMBED_MODEL, on_progress)`, itself `pull_cancellable`
   * driven with a flag that is never set. Defaults to the real, already-ported
   * `ollamaModels.ts` implementation. */
  pullCancellable?: (
    model: string,
    cancel: CancelFlag,
    onProgress: PullProgressListener
  ) => Promise<PullOutcome>;
  /**
   * `spawn_embedding_backfill(&app)` — kicks off the lazy background embed
   * pass for the room now that the embedding model is confirmed available.
   * The REAL implementation is `retrievalBackfill.ts::spawnEmbeddingBackfill`,
   * which needs a per-room `EmbedBackfillState`/`EmbedBackfillDeps` this
   * dispatcher-level file has no way to construct on its own —
   * `roomManager.ts` documents the identical gap for the identical call
   * (its own `deps.spawnEmbeddingBackfill?: () => void`). Absent, this logs
   * a SKIPPED line (not a thrown NOT_IMPLEMENTED): Rust's own call is
   * fire-and-forget and `ensure_embed_model` returns `Ok(())` regardless of
   * whether the backfill kick lands.
   */
  spawnEmbeddingBackfill?: () => void;
}

/** Bucket-1 refusal wording (the real logic exists; this call just was not
 * handed the dependency it needs), matching `roomManager.ts`'s own
 * `logSkipped` precedent — a deliberately different sentence from a
 * NOT_IMPLEMENTED, which would claim there is no port to reach for. */
function logSpawnEmbeddingBackfillSkipped(): void {
  console.error(
    "SKIPPED: spawn_embedding_backfill — retrievalBackfill.ts::spawnEmbeddingBackfill is real, but " +
      "moonshotCmds.ts was not handed a per-room EmbedBackfillState/EmbedBackfillDeps to drive it with."
  );
}

/**
 * D2: make sure the embedding model is present so semantic retrieval and the
 * room graph work, then kick the background backfill. Ported from
 * `ensure_embed_model`.
 *
 * Best-effort throughout, matching the Rust source exactly: if Ollama is down
 * or the pull fails, this still resolves (never rejects) — keyword retrieval
 * keeps working either way. Reports THROTTLED progress through `onProgress`
 * (Rust: `window.emit("pull-progress", …)`), and stamps `meta` once the model
 * is confirmed available so a room records what indexed it — nomic-embed-text
 * is 768-dimensional, the fixed value Rust also hardcodes. Meta writes are
 * swallowed on failure (`let _ = db::set_meta(...)`), and skipped entirely
 * when no room is open (`if let Some(room) = ...`), never thrown.
 */
export async function ensureEmbedModel(
  rooms: RoomSource,
  onProgress: PullProgressListener,
  deps: EnsureEmbedModelDeps = {}
): Promise<void> {
  const available = await embedModelAvailable(onProgress, deps);
  if (available) stampEmbedModel(rooms);
  startEmbeddingBackfill(deps);
}

async function embedModelAvailable(
  onProgress: PullProgressListener,
  deps: EnsureEmbedModelDeps
): Promise<boolean> {
  const listModels = deps.listModels ?? listModelsReal;
  const models = await listModels();
  if (models.some((model) => model.startsWith(EMBED_MODEL))) return true;
  const pullCancellable = deps.pullCancellable ?? pullCancellableReal;
  const outcome = await pullCancellable(EMBED_MODEL, new CancelFlag(), onProgress);
  return outcome.kind === "ok";
}

function stampEmbedModel(rooms: RoomSource): void {
  const room = rooms.currentRoom();
  if (room === null) return;
  trySetMeta(room.db, "embed_model", EMBED_MODEL);
  trySetMeta(room.db, "embed_dim", "768");
}

function startEmbeddingBackfill(deps: EnsureEmbedModelDeps): void {
  if (deps.spawnEmbeddingBackfill !== undefined) {
    deps.spawnEmbeddingBackfill();
    return;
  }
  logSpawnEmbeddingBackfillSkipped();
}

/** `let _ = db::set_meta(&room.conn, ...)` — a failed stamp must never make
 * `ensure_embed_model` itself fail; the model is still available either way. */
function trySetMeta(db: Database.Database, key: string, value: string): void {
  try {
    setMeta(db, key, value);
  } catch {
    // Intentionally ignored, matching Rust's `let _ =`.
  }
}

// ============================================================================
// IPC shim — written, NOT wired into any bootstrap file.
// ============================================================================

export interface MoonshotIpcDeps {
  rooms: RoomSource;
  ensureEmbedModelDeps?: EnsureEmbedModelDeps;
}

/**
 * Register the two `moonshot.rs` channels on `ipcMain`. Channel names are the
 * Rust `#[tauri::command]` names, so a future renderer needs no rename — the
 * same convention `recIpc.ts`/`ollamaModels.ts` follow.
 *
 * `ensure_embed_model`'s progress rides on the INVOKING window, mirroring the
 * Rust command's own `window: tauri::Window` parameter and its
 * `window.emit("pull-progress", …)` — `IpcMainInvokeEvent.sender` is the
 * WebContents that called `invoke()`, the direct Electron analogue, matching
 * `ollamaModels.ts::registerOllamaModelsIpc`'s `pull_model` handler exactly.
 *
 * NOT called from any bootstrap file by this batch (Phase 2 needs an explicit
 * owner go-ahead), exactly like `registerRecIpc`/`registerOllamaModelsIpc`.
 */
export function registerMoonshotIpc(ipcMain: Pick<IpcMain, "handle">, deps: MoonshotIpcDeps): void {
  ipcMain.handle("recommended_models", () => recommendedModels());
  ipcMain.handle("ensure_embed_model", async (event: IpcMainInvokeEvent) => {
    await ensureEmbedModel(
      deps.rooms,
      (status, percent) => {
        event.sender.send("pull-progress", { status, percent });
      },
      deps.ensureEmbedModelDeps
    );
  });
}
