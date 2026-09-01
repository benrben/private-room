/**
 * The cloud-provider catalog: OpenRouter connect/disconnect, its live model
 * list (merged across the chat + image + video catalogues), the in-memory
 * capability cache the rest of the app reads a model's declared abilities
 * from, and the runtime config a chat turn hands the provider-aware Python
 * sidecar.
 *
 * Ported from `src-tauri/src/commands/providers.rs` (742 lines including its
 * `#[cfg(test)] mod tests`, read in full).
 *
 * ── WIRE SHAPE (the one thing easiest to get silently wrong) ───────────────
 * Rust's `ProviderRuntimeConfig` derives `Serialize` with NO
 * `#[serde(rename_all = "camelCase")]` — unlike its sibling `ProviderStatus`,
 * which does have it. So it goes onto the wire with its literal snake_case
 * field names, and the Rust source pins exactly that in
 * `runtime_config_uses_the_python_sidecar_field_names`. It has to: the
 * sidecar's `ProviderConfig` (`services/agent-sidecar/src/arcelle_sidecar/config.py`) declares
 * `api_key`/`base_url`/`context_window`/`supports_tools`/`supports_vision` with no pydantic
 * alias and `extra="ignore"`, so a camelCase object would drop every field it
 * ignores and then fail validation on the required `api_key` that never
 * arrived.
 *
 * This module therefore keeps the same idiomatic/wire split `sidecar.ts` uses
 * for `RunViaSidecarRequest`/`buildRunRequestBody`: a camelCase
 * {@link ProviderRuntimeConfig} for TS callers, and
 * {@link providerRuntimeConfigWire} — the ONLY thing that may be serialized
 * into a sidecar request body, which {@link injectProviderRuntime} uses.
 *
 * ── KEYCHAIN ───────────────────────────────────────────────────────────────
 * The Rust source's `read_key`/`store_key`/`delete_key` use
 * `security_framework::passwords::{generic_password, set_generic_password,
 * delete_generic_password}` — the PLAIN macOS Keychain API. That is a
 * different Keychain surface from `keychain.ts`'s: verified against the
 * vendored `security-framework` 3.7.0 source, `PasswordOptions::
 * new_generic_password` sets only `kSecClass`/`kSecAttrService`/
 * `kSecAttrAccount`, never `kSecUseDataProtectionKeychain` and never an
 * access-control ACL. `keychain.ts` always sets both (it manages the Touch ID
 * item), which is why every call it makes fails with `errSecMissingEntitlement`
 * in an ad-hoc-signed sandbox — see that file's header. A plain
 * generic-password item carries no such entitlement requirement, so the small
 * `koffi` binding below (SecItemAdd / SecItemCopyMatching / SecItemDelete /
 * SecItemUpdate, nothing else) is real and round-trip tested here.
 *
 * ── ONE DELIBERATE ADDITION: {@link ProviderDeps} ──────────────────────────
 * The Rust source hardwires the real Keychain and a real `reqwest::Client`
 * into six functions, and its own test suite never exercises any of them
 * against a real key or a real network. Threading an optional `deps`
 * parameter (default = real Keychain + real `fetch`) through those six
 * follows this codebase's own seam convention — `execTool.ts`'s
 * `ExecToolDeps`, `jobScheduler.ts`'s `SchedulerDeps`, `ytdlp.ts`'s
 * `FetchLike` — and is what lets the tests drive the whole
 * connect/fetch/cache round trip (including against a real local HTTP server)
 * without ever touching this Mac's actual saved OpenRouter key.
 *
 * OUT OF SCOPE, deliberately: the `#[tauri::command]` IPC registration
 * itself. `listAiProviders`/`connectAiProvider`/`disconnectAiProvider` are
 * plain exported functions here, same as this migration's other command
 * ports; no `ipcMain.handle` wiring exists for this surface yet.
 */

import koffi from "koffi";
import type { AiProviderStatus, ExternalModelInfo } from "../shared/apiTypes.js";

// ─────────────────────────────────────────────────────────────── constants

export const OPENROUTER_ID = "openrouter";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** The Keychain service every saved provider key lives under. Exported so a
 * test can pin the literal the shipped app uses, and so a test can pass a
 * DIFFERENT one to {@link readKey}/{@link storeKey}/{@link deleteKey} rather
 * than risk touching a real user's saved key. */
export const KEYCHAIN_SERVICE = "Arcelle LLM Providers";

/**
 * How long a FAILED catalog fetch is remembered before another is attempted —
 * `providers.rs::CATALOG_RETRY_AFTER` (5 minutes), in milliseconds since
 * there is no `Duration` to reach for here.
 *
 * `catalogLoaded` is set only on SUCCESS, so without this a failure meant the
 * full `/models/user` request was re-issued in front of every single AI call:
 * offline, that is the 30s request timeout added to each one; with an expired
 * key it is a fresh authenticated request that 401s every time.
 */
export const CATALOG_RETRY_AFTER_MS = 5 * 60 * 1000;

/** One authenticated catalogue GET's whole-request deadline, matching the
 * Rust client's `Duration::from_secs(30)`. */
export const PROVIDER_FETCH_TIMEOUT_MS = 30_000;

/**
 * The media catalogues OpenRouter keeps OUT of its default listing.
 *
 * Verified live 2026-08-08: `/models` (and `/models/user`) return 400 entries
 * and NOT ONE of them declares `video` output, while
 * `/models?output_modalities=video` returns 21 — Veo, Sora, Kling, Seedance,
 * Aleph, FLUX.3 Video. The image side is the same shape: 11 in the default
 * listing against 42 behind the filter, so `qwen/qwen-image-3-pro`,
 * `krea/krea-2-large`, `flux.2-pro` and the whole Recraft family were
 * invisible.
 *
 * So the catalogue has to be asked for these explicitly. Anything that reads
 * the default listing alone concludes, wrongly and with total confidence,
 * that this account cannot make pictures at all.
 */
export const MEDIA_MODALITIES = ["image", "video"] as const;

// ─────────────────────────────────────────────────────────────────── types

/**
 * What the live catalog says a provider model can do, keyed by the provider's
 * own model slug — `providers.rs`'s `ModelRuntimeFacts`. A named record
 * rather than a tuple because four booleans read together at four call sites
 * is a swap waiting to happen, and swapping `tools` for `vision` would be
 * silent.
 */
export interface ModelRuntimeFacts {
  contextWindow: number | null;
  tools: boolean;
  vision: boolean;
  structuredOutputs: boolean;
  imageOutput: boolean;
  videoOutput: boolean;
}

/** What a chat turn hands the provider-aware Python sidecar, in TS-idiomatic
 * camelCase. This is NOT the JSON shape that goes on the wire — see the
 * module doc's WIRE SHAPE section and {@link providerRuntimeConfigWire}. */
export interface ProviderRuntimeConfig {
  id: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  contextWindow: number | null;
  supportsTools: boolean;
  /** The selected provider model's catalog-declared image-input support.
   * `null` means the catalog could not be consulted, not that the model is
   * known to be blind. */
  supportsVision: boolean | null;
}

/** The minimal slice of a `fetch()` response this module needs, so a test can
 * stand in for one without constructing a real `Response`. */
export interface HttpJsonResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchJsonLike = (
  url: string,
  init: {
    headers: Record<string, string>;
    signal: AbortSignal;
    method?: "GET" | "POST";
    body?: string;
  },
) => Promise<HttpJsonResponseLike>;

export const realFetchJson: FetchJsonLike = (url, init) => fetch(url, init) as unknown as Promise<HttpJsonResponseLike>;

/** The seam this port adds over the Rust source — see the module doc. The
 * defaults in {@link defaultProviderDeps} are the real macOS Keychain and the
 * real network. */
export interface ProviderDeps {
  readKey: (provider: string) => string;
  storeKey: (provider: string, key: string) => void;
  deleteKey: (provider: string) => void;
  fetchJson: FetchJsonLike;
}

// ──────────────────────────────────────────────────────── tiny JSON reader
//
// Mirrors `serde_json::Value`'s `Index` semantics closely enough for this
// file's needs: indexing a missing key, or indexing into something that is
// not an object at all, answers "nothing here" rather than throwing —
// exactly as `value["a"]["b"]` never panics in the Rust source even when
// `"a"` is absent or is not an object.

export function jget(value: unknown, key: string): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return (value as Record<string, unknown>)[key] ?? null;
  }
  return null;
}

export function jstr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function jstrArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Rust's `Value::as_u64()`: a JSON number is only an unsigned integer if it
 * really is one. A negative, fractional or non-numeric `context_length` reads
 * as "the catalog said nothing", never as a rounded guess. */
export function jUnsignedInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

// ──────────────────────────────────────────────────────── module-level state
//
// Rust guards all of this with `OnceLock<RwLock<…>>`/`AtomicBool` because
// several OS threads may call in at once. Node is single-threaded — the only
// interleaving is at `await` points — so plain module state plus the single
// mutex below reproduces the same externally visible behavior.

export const modelRuntimeCache = new Map<string, ModelRuntimeFacts>();
/** Exact IDs in the authenticated, account-scoped chat catalog. Kept separate
 * from display labels and from supplementary public media catalog entries. */
export const selectableProviderModelIds = new Set<string>();
/** Human-readable catalog names. These are deliberately kept in a separate
 * set so an old room setting can never be mistaken for a provider model ID. */
export const providerModelDisplayLabels = new Set<string>();

/** Providers whose saved key the provider ITSELF rejected (HTTP 401) at least
 * once this session — `providers.rs`'s `rejected_keys`.
 *
 * Settings' green "Connected" badge only ever meant "a key is saved on this
 * Mac", so a cancelled or expired key left the page looking perfectly healthy
 * until a question failed with a raw provider error. Re-testing on every
 * render is not the answer (it spends the user's rate limit and would flip
 * the badge whenever the Mac is merely offline), but the moment a real
 * request comes back "this key is not valid" the app must stop claiming it is
 * connected. */
export const rejectedKeys = new Set<string>();

/** Whether the catalog has been fetched at least once in THIS process.
 *
 * The cache above is in-memory only and used to be filled solely as a side
 * effect of the Settings model picker fetching the list, so after every
 * restart a room already set to an OpenRouter model had NO record of what
 * that model can do: `providerRuntimeConfig`'s unknown-default handed tools
 * to a text-only model (a raw provider error on the first tool call) and left
 * `contextWindow` unset, so a long chat was never compacted before being
 * billed. Opening the picker once "fixed" it, which is the shape of a bug. */
export const catalogState: { loaded: boolean; attemptedAtMs: number | null } = {
  loaded: false,
  attemptedAtMs: null,
};

// ───────────────────────────────────────────────────── rejected-key helpers
//
// Private `fn`s in the Rust source, whose `mod tests { use super::*; }` sees
// them for free. TS has no equivalent, so they are exported purely so this
// module's own test file can exercise them the same way.

export function noteKeyRejected(provider: string): void {
  rejectedKeys.add(provider);
}

export function clearKeyRejected(provider: string): void {
  rejectedKeys.delete(provider);
}

export function keyRejected(provider: string): boolean {
  return rejectedKeys.has(provider);
}

// ────────────────────────────────────────────────────────── catalog policy

/** Pure retry policy, so the window is testable without a network: the first
 * attempt is always due, a later one only once the window has passed.
 * `providers.rs::catalog_retry_due`, with `Duration` replaced by a plain
 * millisecond count. */
export function catalogRetryDue(msSinceLastAttempt: number | null): boolean {
  if (msSinceLastAttempt === null) return true;
  return msSinceLastAttempt >= CATALOG_RETRY_AFTER_MS;
}

// A promise chain standing in for the Rust source's
// `static FETCHING: tokio::sync::Mutex<()>`. This process has no OS threads
// to race, but concurrent `async` callers can still interleave across an
// `await`, so they are serialized onto one queue and each re-checks the
// guards after acquiring it — exactly as the Rust does.
let fetchLockChain: Promise<void> = Promise.resolve();
// Installed-product reviews must never touch the user's login Keychain. The
// Electron data directory is not a Keychain namespace, so a temporary
// ARCELLE_USER_DATA_DIR alone does not isolate credentials. Keep E2E provider
// secrets process-local; production continues to use the real generic-password
// item below.
export const e2eProviderKeys = new Map<string, string>();
export const providerKeySessionCache = new Map<string, { key?: string; error?: string }>();

/**
 * Read one provider credential at most once per application process.
 *
 * Ad-hoc signed development/release builds can trigger a macOS Keychain ACL
 * sheet. Several capability surfaces ask only whether a provider is connected;
 * without this session cache they can show the same native sheet repeatedly.
 * A later explicit store/delete replaces the cached result immediately.
 */
export function readProviderKeyOnce(provider: string, reader: (provider: string) => string): string {
  const cached = providerKeySessionCache.get(provider);
  if (cached?.key !== undefined) return cached.key;
  if (cached?.error !== undefined) throw new Error(cached.error);
  try {
    const key = reader(provider);
    providerKeySessionCache.set(provider, { key });
    return key;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The provider credential is unavailable.";
    providerKeySessionCache.set(provider, { error: message });
    throw new Error(message);
  }
}

export async function withFetchLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = fetchLockChain;
  let release: () => void = () => {};
  fetchLockChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  // `previous` is only ever resolved (never rejected) by a `release()` in the
  // `finally` below, so awaiting it cannot strand the queue.
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Test-only. Every singleton above is process-lifetime state in the Rust
 * source too, and `cargo test` hands each `#[test]` a process-fresh copy of
 * it; one `vitest` module instance does not. Never called from production
 * code. */
export function resetProviderStateForTests(): void {
  modelRuntimeCache.clear();
  selectableProviderModelIds.clear();
  providerModelDisplayLabels.clear();
  rejectedKeys.clear();
  catalogState.loaded = false;
  catalogState.attemptedAtMs = null;
  fetchLockChain = Promise.resolve();
  e2eProviderKeys.clear();
  providerKeySessionCache.clear();
}
