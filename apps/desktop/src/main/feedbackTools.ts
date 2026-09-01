/**
 * ADD-28: send feedback as a GitHub issue — drafted locally, sent by the
 * USER's browser, never by the app. Ported from
 * `src-tauri/src/commands/feedback.rs` (146 lines, read in full).
 *
 * The only network hop this module itself makes is the LOCAL model shaping
 * pass (through the sidecar's `/feedback_draft`, like every other feature
 * endpoint since the MIGRATION); opening the actual GitHub issue is a browser
 * navigation the frontend does with the drafted `{title, body}`, which stays
 * fully out of scope here exactly as it is in the Rust source (nothing in
 * `feedback.rs` ever calls `github.com`).
 *
 * NOT model-invocable: `app_diag`/`feedback_draft` are plain
 * `#[tauri::command]`s (`lib.rs` registers them in its ordinary command list,
 * not through `exec_tool`), so — per this batch's own instructions — there is
 * no `exec_tool` arm to wire into `execTool.ts`. Confirmed by grep: neither
 * name appears in any tool spec or `exec_tool` match arm anywhere in the Rust
 * tree.
 *
 * Per this rewrite's "no ipcMain wiring in this batch" convention
 * (`recIpc.ts`, `dictStopTimeout.ts`), nothing here is registered on
 * `ipcMain` — these are plain, directly-testable functions a future IPC batch
 * can call.
 *
 * REUSED, not re-declared:
 *  - {@link FeedbackDraft}/{@link AppDiag} — already declared, camelCase and
 *    field-for-field, in `../shared/apiTypes.ts` (the `bulkReport.ts`
 *    convention for a type that already exists there).
 *  - `modelSetting` (`gatherContext.ts`) — `models.rs::model_setting`.
 *  - `runsOnThisMac`/`servedByOllamaEngine` (`capabilities.ts`) —
 *    `agent.rs::runs_on_this_mac`/`models.rs::served_by_ollama_engine`.
 *  - `isEmbeddingModel`/`DEFAULT_MODEL` (`turnContext.ts`) —
 *    `models.rs::is_embedding_model`/chat default.
 *  - `listModels` (`engineRouting.ts`) — `ollama::list_models`, as the default
 *    for the injectable `listModels` dep (see the FIDELITY NOTE below).
 *  - `resolvedBaseUrl` (`engineRouting.ts`) — `ollama::resolved_base_url`.
 *  - `sidecarJsonCancellable`/`sidecarErrorSentinel` (`sidecarJsonCancellable.ts`)
 *    — the already-ported `sidecar_json`/`SidecarError::sentinel` pair. Rust's
 *    `feedback_draft` calls the plain, non-cancellable `sidecar_json`; rather
 *    than re-deriving a THIRD copy of the POST/auth/timeout/error-classification
 *    logic that helper already owns, this module drives it with a
 *    {@link CancelFlag} that is never set, which makes it behave exactly like
 *    the non-cancellable call — the same trick a never-firing flag plays
 *    anywhere else in this codebase.
 *  - {@link RoomSource}/{@link RoomHandle} (`jobs.ts`) — the same "read the
 *    currently open room, or `null`" seam `autoIndex.ts` already uses; no
 *    room-path pin is needed here (unlike `jobs.ts`'s own runners) because the
 *    Rust source never re-checks the room after its lock guard drops either —
 *    the model is decided once, synchronously, before any `.await`.
 *
 * DUPLICATED HERE, deliberately and in a few lines, following this rewrite's
 * established "too small to justify a shared port" precedent
 * (`capabilities.ts`'s own doc lists `isCloudModel`/`primaryCliScope` as
 * exactly this):
 *  - `bestLocalDefault` (`models.rs::best_local_default`) has NO Electron port
 *    anywhere yet — every existing reference to it in this tree
 *    (`toolSpecs.ts::resolveLocalGenerateModel`) is an INJECTED dependency
 *    type, never a real implementation. Its own upstream helpers
 *    (`isEmbeddingModel`, `servedByOllamaEngine`, `DEFAULT_MODEL`) are all
 *    already real and imported below; only the tiny "installed exact-or-prefix
 *    match" glue (`models.rs::installed_default`, private even in Rust) is
 *    re-derived locally, because the one real TS copy of that logic
 *    (`turnContext.ts`'s `installedDefault`) is not exported and this port is
 *    the smaller and safer change of the two (see the function's own doc).
 *
 * FIDELITY NOTE — the "Ollama isn't running" branch. Rust's own
 * `ollama::list_models()` returns `Result<Vec<String>, String>`, and
 * `feedback_draft` maps a genuine `Err` to a DIFFERENT sentence
 * ("...isn't running") than an `Ok(vec![])` ("No local AI model is
 * installed"). The already-ported `engineRouting.ts::listModels` made a
 * documented, deliberate simplification for its other three call sites (ask,
 * list_specialists, handoff_chat all `.unwrap_or_default()` anyway) and never
 * throws — folding every failure into `[]`. Reused here as the DEFAULT for
 * consistency and to avoid a fourth copy of the sidecar `/models` POST, but it
 * means that with today's real wiring the "isn't running" message can never
 * actually surface — a real Ollama/sidecar outage reads as "No local AI model
 * is installed" instead. The distinguishing code path below is kept (not
 * collapsed away) so it activates correctly the moment `engineRouting.ts`
 * grows a throwing variant, or a caller injects one via
 * {@link FeedbackDraftDeps.listModels} — and it is unit-tested here against an
 * injected throwing `listModels`, since production wiring cannot exercise it.
 * Flagged for the port owner rather than silently accepted.
 */

import type { AppDiag, FeedbackDraft } from "../shared/apiTypes.js";
import { runsOnThisMac, servedByOllamaEngine } from "./capabilities.js";
import { CancelFlag } from "./cancel.js";
import { modelSetting } from "./gatherContext.js";
import { listModels as listModelsReal, resolvedBaseUrl } from "./engineRouting.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import {
  sidecarErrorSentinel,
  sidecarJsonCancellable,
  type SidecarPostOutcome,
} from "./sidecarJsonCancellable.js";
import { DEFAULT_MODEL, isEmbeddingModel } from "./turnContext.js";

// -------------------------------------------------------------------- repo

/** Where feedback lands. Single source of truth for the frontend too. Ported
 * verbatim from `FEEDBACK_REPO`. */
export const FEEDBACK_REPO = "benrben/private-room";

// ----------------------------------------------------------------- app_diag

/**
 * Everything `app_diag` reads off the live app/OS, injected because none of
 * it is available under plain Node/vitest: `appVersion`/`osVersion` need
 * Electron's `app`/`process.getSystemVersion()`, which only exist inside a
 * running Electron main process. Same reasoning `menu.ts` gives for its own
 * `getMainWindow` seam — "this module never reaches for [it] itself... always
 * an injected dependency, supplied by whatever the real Electron equivalent
 * turns out to be" — so there is no top-level `import { app } from "electron"`
 * here for a future wiring batch to trip over under vitest.
 */
export interface AppDiagDeps {
  /** `app.package_info().version.to_string()` — the packaged app's own
   * version. Electron's real equivalent is `app.getVersion()`. */
  appVersion: () => string;
  /** `sysinfo::System::long_os_version().unwrap_or_else(|| "macOS".into())`.
   * Electron's real equivalent is `process.getSystemVersion()`; the caller
   * supplying it is expected to keep Rust's own "macOS" fallback for when
   * detection fails, matching the doc above. */
  osVersion: () => string;
}

/**
 * Version + platform facts for the issue footer (shown to the user first,
 * included only when they leave the checkbox on). Ported from `app_diag`.
 *
 * `std::env::consts::ARCH` is `process.arch` — a plain Node builtin that
 * reads identically under Electron's main process and under vitest, so
 * (unlike {@link AppDiagDeps}'s two fields) it is read directly rather than
 * injected.
 */
export function appDiag(deps: AppDiagDeps): AppDiag {
  return {
    version: deps.appVersion(),
    os: deps.osVersion(),
    arch: process.arch,
    repo: FEEDBACK_REPO,
  };
}

// ------------------------------------------------------------- read_draft

/**
 * The `{title, body}` the sidecar's `/feedback_draft` promised — or a thrown
 * `Error` naming the sentence to show when it answered with something else.
 * Ported verbatim from `read_draft`; Rust's `Result<FeedbackDraft, String>`
 * becomes a throw here, matching this codebase's convention for a
 * `#[tauri::command]`'s `Result<T, String>` (see `recBridge.ts`'s `recStart`
 * for the same translation).
 *
 * REQUIRED, not defaulted: the sidecar always answers with both fields (it
 * falls back to the user's own words on any model misfire itself), so a
 * missing or renamed one is a broken host/sidecar contract — defaulting it to
 * `""` would hand the modal two empty boxes with no error, reading as "the AI
 * had nothing to say" and quietly wiping what the user typed.
 *
 * Exported so the test file — a separate module, unlike Rust's `#[cfg(test)]
 * mod tests { use super::*; }` — can pin the exact error wording directly,
 * the same precedent `fileTools.ts` sets for its own private-in-Rust helpers
 * (`closestSnippet`, `parseA1`).
 */
export function readDraft(v: unknown): FeedbackDraft {
  const obj = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const field = (key: "title" | "body"): string => {
    // OWN property only. Rust reads `v[key]` on a `serde_json::Value`, which
    // resolves against the reply's own map and answers `Null` for anything
    // else — it cannot return a value the sidecar never sent. A plain
    // `obj[key]` can: with `Object.prototype.title` polluted (a bug class this
    // app has shipped twice — `mcpConfig.ts`, `privacyRedact.ts`), a reply of
    // `null`, or one missing both fields, read back as a COMPLETE draft, and
    // the modal would show the user two sentences no model wrote while the
    // "this version cannot read it" refusal this function exists for never
    // fired. Same own-read discipline `privacy.ts`'s `ownValue` states.
    const value = Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
    if (typeof value !== "string") {
      throw new Error(
        `The draft came back without a ${key} — this version cannot read it. Your own words are still in the box.`
      );
    }
    return value;
  };
  // Title checked before body, matching Rust's struct-literal field order
  // (`title: field("title")?, body: field("body")?`) — the FIRST missing
  // field is the one named, on a shape with both missing.
  return { title: field("title"), body: field("body") };
}

// --------------------------------------------------------- best_local_default

/**
 * `models.rs::installed_default`, re-derived locally (see this module's own
 * doc for why): the installed tag that IS the default, exact match preferred
 * over a build-suffixed one (`qwen3.5:4b-mlx`).
 */
function installedLocalDefault(models: readonly string[]): string | undefined {
  return models.find((m) => m === DEFAULT_MODEL) ?? models.find((m) => m.startsWith(DEFAULT_MODEL));
}

/**
 * A chat-capable model that runs ON THIS MAC — not an embedding model, not an
 * external CLI, not an Ollama `:cloud` model. Ported verbatim from
 * `models.rs::best_local_default`. Prefers the tuned default in whatever build
 * form is actually installed, falls back to the first eligible installed tag,
 * then to the bare default name (so a downstream Ollama error names the
 * missing model).
 */
function bestLocalDefault(models: readonly string[]): string {
  const installed = installedLocalDefault(models);
  if (installed !== undefined) {
    return installed;
  }
  return models.find((m) => !isEmbeddingModel(m) && servedByOllamaEngine(m)) ?? DEFAULT_MODEL;
}

// ------------------------------------------------------------ feedback_draft

/** Rust's `sidecar::sidecar_json` signature, narrowed to what this module
 * calls it with — the same local alias `filePass.ts` keeps as `SidecarPostFn`
 * rather than importing that whole (unrelated) module for one type. */
type SidecarPostFn = (path: string, body: unknown, cancel: CancelFlag) => Promise<SidecarPostOutcome>;

export interface FeedbackDraftDeps {
  /** Which room, if any, is currently open — read once, synchronously, before
   * any `.await`, exactly where Rust's own room-mutex guard drops. */
  rooms: RoomSource;
  /** `ollama::list_models()`. Defaults to the real, already-ported
   * `engineRouting.ts` implementation — see this module's own FIDELITY NOTE
   * for the one behavior this default cannot reproduce. */
  listModels?: () => Promise<string[]>;
  /** `sidecar::sidecar_json("/feedback_draft", &body)`. Defaults to the real
   * {@link sidecarJsonCancellable} driven with a flag that is never set — see
   * this module's own doc for why that is a faithful, not a fabricated,
   * stand-in for Rust's non-cancellable call. */
  post?: SidecarPostFn;
}

/** A flag that is never set — the flip side of `filePass.ts`'s cancellable
 * calls, used ONLY to drive the shared cancellable POST helper as a plain,
 * uncancellable one, matching Rust's own non-cancellable `sidecar_json` call.
 * A fresh instance (rather than a shared module-level one) so no caller can
 * ever observe it having been flipped by an earlier, unrelated request. */
function neverCancelled(): CancelFlag {
  return new CancelFlag();
}

/**
 * Shape raw feedback into a GitHub-ready title + Markdown body on the LOCAL
 * model (like dictation shaping, feedback text never goes to a cloud engine).
 * Writing by hand stays first-class — this is optional help, and any model
 * failure throws a plain, actionable message instead of blocking the user.
 * Ported from `feedback_draft`.
 *
 * The empty-text guard and model resolution stay synchronous (mirroring
 * Rust's own room-lock scope, dropped before the first `.await`); the prompt,
 * schema, model call, parse and words-survive-any-misfire fallback all live
 * in the sidecar's `/feedback_draft`, exactly as in Rust.
 */
export async function feedbackDraft(deps: FeedbackDraftDeps, text: string): Promise<FeedbackDraft> {
  const trimmed = feedbackText(text);
  const models = await installedFeedbackModels(deps);
  const model = feedbackModel(deps.rooms, models);
  const outcome = await postFeedbackDraft(deps, model, trimmed);
  return feedbackOutcome(outcome, model);
}

function feedbackText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error("Write a few words about what happened first.");
  }
  return trimmed;
}

async function installedFeedbackModels(deps: FeedbackDraftDeps): Promise<string[]> {
  const listModels = deps.listModels ?? listModelsReal;
  let models: string[];
  try {
    models = await listModels();
  } catch {
    unavailableFeedbackModels();
  }
  return requireFeedbackModels(models);
}

function unavailableFeedbackModels(): never {
  throw new Error("The local AI (Ollama) isn't running — you can still write the issue yourself.");
}

function requireFeedbackModels(models: string[]): string[] {
  if (models.length === 0) {
    throw new Error("No local AI model is installed — you can still write the issue yourself.");
  }
  return models;
}

function feedbackModel(rooms: RoomSource, models: readonly string[]): string {
  const candidate = roomFeedbackModel(rooms) ?? bestLocalDefault(models);
  return runsOnThisMac(candidate) ? candidate : bestLocalDefault(models);
}

function roomFeedbackModel(rooms: RoomSource): string | null {
  const room: RoomHandle | null = rooms.current();
  return room === null ? null : modelSetting(room.db);
}

function postFeedbackDraft(deps: FeedbackDraftDeps, model: string, text: string): Promise<SidecarPostOutcome> {
  const post = deps.post ?? sidecarJsonCancellable;
  const body = { model, base_url: resolvedBaseUrl(), text };
  return post("/feedback_draft", body, neverCancelled());
}

function feedbackOutcome(outcome: SidecarPostOutcome, model: string): FeedbackDraft {
  switch (outcome.kind) {
    case "value":
      return readDraft(outcome.value);
    case "error":
      throw new Error(sidecarErrorSentinel(outcome.error, model));
    case "stopped":
      // Unreachable in practice: a freshly-constructed CancelFlag's `load()`
      // always returns false and nothing here ever calls `.store(true)` on
      // it, and Rust's own `feedback_draft` has no cancellation path to
      // mirror here either. Kept as an explicit, labeled throw (never a
      // silent fall-through) so a future change to the shared POST helper
      // that somehow reaches this arm fails loudly instead of resolving with
      // `undefined`.
      throw new Error("feedback_draft: the sidecar call reported 'stopped', which should never happen here.");
  }
}
