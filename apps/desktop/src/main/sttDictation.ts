import type Database from "better-sqlite3-multiple-ciphers";
import type { DictSessionInfo } from "../shared/apiTypes.js";
import { generate } from "./ollamaGenerate.js";
import { resolvedBaseUrl, stripThinkSpans } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { runsOnThisMac } from "./capabilities.js";
import { bestLocalDefault } from "./ollamaModels.js";
import { authToken, authedHeaders, busy, ensureUp } from "./sidecar.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { DICT_STOP_BASE_SECS, DICT_STOP_PER_AUDIO_SEC } from "./dictStopTimeout.js";
import { isRecord, sttEffectiveModel } from "./sttTools.js";



// ============================================================================
// ---- dictation shaping (stt_cmds.rs:688-866) --------------------------------
// ============================================================================
// Ported from alfred's proven dictation pipeline (voicebridge.py): the same
// battle-tested prompt texts. Two findings inherited from alfred: (1) whisper
// *-turbo models silently cannot translate, so translation happens HERE via the
// LLM, never in the Whisper step; (2) on any LLM failure the raw transcript
// must survive — callers fall back to it. Cloud engines are never used for
// shaping: dictated words stay on this Mac.

/** `stt_cmds.rs::DICT_TRANSLATE`, verbatim (the Rust literal's `\`-continued
 * lines joined exactly as rustc joins them — pinned byte-for-byte by this
 * module's test). */
export const DICT_TRANSLATE =
  "Translate it into fluent, natural English. If it is already English, keep it unchanged. " +
  "Preserve meaning and tone.";


/** `stt_cmds.rs::DICT_REWRITE`, verbatim. */
export const DICT_REWRITE =
  "Clean up this raw voice transcription: remove filler words (um, uh, like), false starts, " +
  "and repetitions; fix grammar, spelling, and punctuation; preserve the speaker's meaning, " +
  "intent, and tone. Do not add new information and do not answer any question contained in " +
  "the text.";


/** `stt_cmds.rs::DICT_TAIL`, verbatim. */
export const DICT_TAIL =
  "Output ONLY the resulting text, with no preamble, labels, explanations, or surrounding quotes.";


/** `stt_cmds.rs::DICT_PROMPT_OPTIMIZER`, verbatim — alfred's Prompt Optimizer,
 * a standalone rewrite instruction (it REPLACES the cleanup instruction instead
 * of extending it). */
export const DICT_PROMPT_OPTIMIZER =
  "You are a prompt optimizer. Given any user input, automatically rewrite it into a clear, " +
  "effective prompt. Never ask follow-up questions — infer everything from the input alone " +
  "and preserve the user's full original intent (every requirement, entity, constraint, and " +
  "nuance must survive the rewrite; never add goals they didn't imply).\n\nINTERNAL STEPS " +
  "(do not show these):\n1. Deconstruct: extract the core intent, key entities, context, " +
  "output requirements, and constraints.\n2. Develop: silently classify the request type and " +
  "apply the fitting approach (creative → multi-perspective; technical → constraint-based " +
  "precision; educational → clear structure and examples; complex → step-by-step framing). " +
  "Add a role/expertise framing and logical structure where it helps.\n3. Auto-detect level: " +
  "SHORT for simple requests (a tight one-paragraph prompt), DETAILED for complex ones (role, " +
  "context, task breakdown, output format).\n\nOUTPUT:\nReturn only the rewritten prompt — no " +
  "preamble, no explanation of changes, no questions.";
export

/**
 * `stt_cmds.rs::dict_mode_guidance` — intent guidance appended to the cleanup
 * instruction (alfred's BUILTIN_MODES). Returns `[guidance, replacesCleanup]`,
 * or `null` for `"off"`/an unknown mode (Rust's `_ => None`).
 *
 * A `Map` of fixed literals, never a lookup into an object keyed by the
 * caller's string: `mode` reaches this from the renderer, and a `"__proto__"`
 * key on a plain object literal is a prototype-pollution hazard this codebase
 * has already been bitten by.
 */
const DICT_MODE_GUIDANCE = new Map<string, readonly [string, boolean]>([
  ["raw", ["", false]],
  [
    "email",
    [
      "Shape it as the body of a clear, courteous email. Do not invent a subject line, " +
        "greeting, or signature unless they were dictated.",
      false,
    ],
  ],
  ["message", ["Shape it as a concise, natural chat/Slack message.", false]],
  [
    "commit",
    [
      "Shape it as a git commit message: a short imperative summary line (<=72 chars), " +
        "then a blank line, then bullet points if warranted.",
      false,
    ],
  ],
  ["notes", ["Shape it as clean, organized notes (short paragraphs or bullets).", false]],
  ["prompt", [DICT_PROMPT_OPTIMIZER, true]],
]);


export function dictModeGuidance(mode: string): readonly [string, boolean] | null {
  const guidance = DICT_MODE_GUIDANCE.get(mode);
  return guidance === undefined ? null : [guidance[0], guidance[1]];
}


/**
 * `stt_cmds.rs::dict_pass_text` — what a shaping pass hands back as the user's
 * dictated words.
 *
 * `ollama::generate`/{@link generate} returns the model's RAW text, and a
 * thinking model prefixes it with `<think>…</think>`. This text is typed into
 * the composer AS the user's own sentence, so an unstripped monologue is
 * dictation putting the model's private reasoning in the user's mouth — and, in
 * `prompt` mode, in the next thing they send.
 */
export function dictPassText(raw: string): string {
  return stripThinkSpans(raw).trim();
}


/** The `generate` call {@link runDictPass} makes — `ollamaGenerate.ts::generate`'s
 * own shape, injectable so a test never opens a connection. */
export type DictGenerateFn = (
  model: string,
  messages: readonly SidecarChatMessage[],
  temperature: number | null,
  keepAlive: string
) => Promise<string>;


/**
 * `stt_cmds.rs::run_dict_pass` — one dictation-shaping model call. A single
 * instruction gets a plain prompt; multiple instructions keep the numbered
 * "operations in order" shape. Defaults to the REAL {@link generate} at
 * `Some(0.2)`/`"5m"`, matching Rust's call exactly.
 */
export async function runDictPass(
  model: string,
  steps: readonly string[],
  text: string,
  generateFn: DictGenerateFn = generate
): Promise<string> {
  const only = steps.length === 1 ? steps[0] : undefined;
  const prompt =
    only !== undefined
      ? `${only}\n\n${DICT_TAIL}\n\nINPUT TEXT:\n${text}`
      : "You are a text post-processor. Apply the following operations to the INPUT TEXT, " +
        `in order:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
        `${DICT_TAIL}\n\nINPUT TEXT:\n${text}`;
  const messages: SidecarChatMessage[] = [{ role: "user", content: prompt }];
  // MIGRATION Phase 2a: non-streamed sidecar `/generate` (no tools, no Stop) —
  // the same reasoning `stt_cmds.rs`'s own comment gives at this call site.
  const raw = await generateFn(model, messages, 0.2, "5m");
  return dictPassText(raw);
}


/** `shape_text`'s message when `ollama::list_models()` FAILED — the sidecar or
 * Ollama is unreachable. Verbatim from `stt_cmds.rs:785`. */
export const OLLAMA_NOT_RUNNING =
  "The local AI (Ollama) isn't running — raw transcript kept.";


/** `shape_text`'s message when the list came back EMPTY. Verbatim from
 * `stt_cmds.rs:787`. Rust keeps these two apart on purpose: "it's down" and
 * "you have nothing installed" are different things to do about it. */
export const NO_LOCAL_MODEL_INSTALLED =
  "No local AI model is installed — raw transcript kept.";
export

/**
 * `ollama::list_models()`'s REAL `Result` contract, read directly rather than
 * through `engineRouting.ts`'s `listModels` (which folds EVERY failure into
 * `[]` by documented design). Folding here would erase the distinction Rust's
 * two error strings above carry, and this is not a new pattern:
 * `ollamaModels.ts` already keeps its own private duplicate of this exact
 * `/models` POST for `aiStatus`, for precisely the same reason ("`aiStatus`
 * needs the raw Ok/Err split") and likewise does not export it. Call site #2 of
 * an established pattern, not a second public list-models API.
 */
async function rawListModels(): Promise<string[]> {
  const base = await ensureUp();
  const guard = busy();
  try {
    const resp = await fetch(`${base}/models`, {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ base_url: resolvedBaseUrl() }),
    });
    if (!resp.ok) {
      throw new Error(`sidecar /models status ${resp.status}`);
    }
    const value: unknown = await resp.json();
    const models = isRecord(value) ? value.models : undefined;
    return Array.isArray(models) ? models.filter((m): m is string => typeof m === "string") : [];
  } finally {
    guard.release();
  }
}


/** What {@link shapeText} needs. Every field defaults to the real,
 * already-ported implementation — see the module doc for why each one exists in
 * this tree while `stt/dictation.py` says Python is still missing it. */
export interface ShapeTextDeps {
  /** `ollama::list_models().await` — THROWS on failure, unlike the folded
   * `engineRouting.ts` version. Real default: {@link rawListModels}. */
  listModelsRaw: () => Promise<string[]>;
  /** `commands::model_setting(&room.conn)`. Real default:
   * `gatherContext.ts::modelSetting`. */
  modelSetting: (db: Database.Database) => string | null;
  /** `capabilities::runs_on_this_mac`. */
  runsOnThisMac: (model: string) => boolean;
  /** `models::best_local_default`. */
  bestLocalDefault: (models: readonly string[]) => string;
  /** `ollama::generate`. */
  generate: DictGenerateFn;
}


export const defaultShapeTextDeps: ShapeTextDeps = {
  listModelsRaw: rawListModels,
  modelSetting,
  runsOnThisMac,
  bestLocalDefault,
  generate: (model, messages, temperature, keepAlive) =>
    generate(model, messages, temperature, keepAlive),
};
export function shapeStepsFor(mode: string): string[] {
  const guidance = dictModeGuidance(mode);
  if (guidance === null) {
    return [];
  }
  const [instruction, replacesCleanup] = guidance;
  if (replacesCleanup) {
    return [instruction];
  }
  return instruction === "" ? [DICT_REWRITE] : [DICT_REWRITE, instruction];
}
export async function installedDictationModels(deps: ShapeTextDeps): Promise<string[]> {
  let models: string[];
  try {
    models = await deps.listModelsRaw();
  } catch {
    throw new Error(OLLAMA_NOT_RUNNING);
  }
  if (models.length === 0) {
    throw new Error(NO_LOCAL_MODEL_INSTALLED);
  }
  return models;
}
export function configuredDictationModel(
  db: Database.Database | null,
  models: readonly string[],
  deps: ShapeTextDeps
): string {
  const configured = db === null ? null : deps.modelSetting(db);
  return configured ?? deps.bestLocalDefault(models);
}
export function localDictationModel(
  db: Database.Database | null,
  models: readonly string[],
  deps: ShapeTextDeps
): string {
  const configured = configuredDictationModel(db, models, deps);
  return deps.runsOnThisMac(configured) ? configured : deps.bestLocalDefault(models);
}
export async function translatedDictationText(
  model: string,
  text: string,
  generateFn: DictGenerateFn
): Promise<string> {
  const translated = (await runDictPass(model, [DICT_TRANSLATE], text, generateFn)).trim();
  return translated === "" ? text : translated;
}
export async function shapedDictationText(
  model: string,
  steps: readonly string[],
  text: string,
  generateFn: DictGenerateFn
): Promise<string> {
  if (steps.length === 0) {
    return text;
  }
  const shaped = (await runDictPass(model, steps, text, generateFn)).trim();
  return shaped === "" ? text : shaped;
}


/**
 * `stt_cmds.rs::shape_text` — post-process dictated text on the LOCAL model: an
 * optional translate-to-English pass, then an optional intent rewrite.
 * `mode="off"`/unknown with `translate=false` returns the text unchanged with no
 * model call at all.
 *
 * ADD-22: translate runs as its OWN pass first, because one instruction at a
 * time is far more reliable for a small model than translate+cleanup+shape
 * crammed into one prompt.
 *
 * `db` is the currently open room's database, or `null` between rooms — Rust's
 * `state.room.lock()` read is SOFT there too (`guard.as_ref().and_then(..)`): a
 * room is preferred when one happens to be open, never required.
 *
 * Shaping ALWAYS runs on a genuinely local model, whatever the chat model is
 * set to. That is the Settings screen's explicit promise and the ONE deliberate
 * exception to engine parity — external CLIs AND `:cloud` proxies are both
 * swapped out (`runsOnThisMac` excludes both; the old Rust check missed
 * `:cloud` and silently shipped dictated words to Ollama's servers).
 *
 * A FAILED translate PROPAGATES rather than being swallowed: shaping the
 * untranslated words instead would hand back a cleaned-up sentence in the
 * language it was spoken in, presented as a translation — the one outcome that
 * misrepresents what happened, and the exact bug Rust's own comment at this
 * call site exists to prevent. Keeping the exact transcript (and saying so) is
 * the caller's job, not this function's.
 */
export async function shapeText(
  db: Database.Database | null,
  text: string,
  translate: boolean,
  mode: string,
  deps: ShapeTextDeps = defaultShapeTextDeps
): Promise<string> {
  const shapeSteps = shapeStepsFor(mode);
  if (!translate && shapeSteps.length === 0) {
    return text;
  }

  const models = await installedDictationModels(deps);
  const model = localDictationModel(db, models, deps);

  // Pass 1: translate on its own.
  const current = translate
    ? await translatedDictationText(model, text, deps.generate)
    : text;
  // Pass 2: cleanup + optional mode shaping (or the prompt optimizer).
  return shapedDictationText(model, shapeSteps, current, deps.generate);
}


// ============================================================================
// ---- dict_start bootstrap + retired audio/control IPC -----------------------
// ============================================================================

/** Why these four throw — see the module doc's "RETIRED" section. */
export const DICT_RETIRED_REASON =
  'Dictation audio no longer streams through Electron: the renderer connects directly to "WS ' +
  '/dict/session" on the Python sidecar (electron-python-migration-plan-2026-08-22.md line 349; ' +
  "services/agent-sidecar/src/arcelle_sidecar/stt/dictation.py. dict_push_audio/dict_stop/dict_cancel " +
  "are retired IPC handlers, kept only so a stale renderer bundle fails loudly with " +
  'an instruction instead of "no handler registered" — the same treatment recBridge.ts gives ' +
  "rec_push_audio. dictStopTimeout.ts still owns the one piece of this flow Electron keeps: " +
  "dict_stop_timeout's formula, for the renderer's own stop-wait.";


export interface DictSessionDeps {
  ensureUp: () => Promise<string>;
  authToken: () => string;
}
export const defaultDictSessionDeps: DictSessionDeps = { ensureUp, authToken };


/** Provision the authenticated direct socket without proxying any audio
 * through Electron. The main process remains the only place allowed to read
 * the sidecar token and resolve the on-disk model path. */
export async function dictStart(
  userDataDir: string,
  resourcesPath: string | null,
  deps: DictSessionDeps = defaultDictSessionDeps
): Promise<DictSessionInfo> {
  const modelPath = sttEffectiveModel(userDataDir, resourcesPath);
  if (modelPath === null) throw new Error("STT_MODEL_MISSING");
  const base = new URL(await deps.ensureUp());
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/dict/session";
  base.search = "";
  base.searchParams.set("token", deps.authToken());
  base.searchParams.set("modelPath", modelPath);
  return {
    url: base.toString(),
    stopBaseMs: DICT_STOP_BASE_SECS * 1000,
    stopPerAudioSecondMs: DICT_STOP_PER_AUDIO_SEC * 1000,
  };
}


/** Retired: see {@link DICT_RETIRED_REASON}. */
export async function dictPushAudio(_rate: number, _dataB64: string): Promise<never> {
  throw new Error(DICT_RETIRED_REASON);
}


/** Retired: see {@link DICT_RETIRED_REASON}. */
export async function dictStop(): Promise<never> {
  throw new Error(DICT_RETIRED_REASON);
}


/** Retired: see {@link DICT_RETIRED_REASON}. */
export async function dictCancel(): Promise<never> {
  throw new Error(DICT_RETIRED_REASON);
}
