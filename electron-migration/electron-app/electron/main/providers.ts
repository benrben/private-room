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
 * sidecar's `ProviderConfig` (`sidecar/arcelle_sidecar/config.py`) declares
 * `api_key`/`base_url`/`context_window`/`supports_tools` with no pydantic
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
const PROVIDER_FETCH_TIMEOUT_MS = 30_000;

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
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<HttpJsonResponseLike>;

const realFetchJson: FetchJsonLike = (url, init) => fetch(url, init) as unknown as Promise<HttpJsonResponseLike>;

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

function jget(value: unknown, key: string): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return (value as Record<string, unknown>)[key] ?? null;
  }
  return null;
}

function jstr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function jstrArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Rust's `Value::as_u64()`: a JSON number is only an unsigned integer if it
 * really is one. A negative, fractional or non-numeric `context_length` reads
 * as "the catalog said nothing", never as a rounded guess. */
function jUnsignedInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

// ──────────────────────────────────────────────────────── module-level state
//
// Rust guards all of this with `OnceLock<RwLock<…>>`/`AtomicBool` because
// several OS threads may call in at once. Node is single-threaded — the only
// interleaving is at `await` points — so plain module state plus the single
// mutex below reproduces the same externally visible behavior.

const modelRuntimeCache = new Map<string, ModelRuntimeFacts>();

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
const rejectedKeys = new Set<string>();

/** Whether the catalog has been fetched at least once in THIS process.
 *
 * The cache above is in-memory only and used to be filled solely as a side
 * effect of the Settings model picker fetching the list, so after every
 * restart a room already set to an OpenRouter model had NO record of what
 * that model can do: `providerRuntimeConfig`'s unknown-default handed tools
 * to a text-only model (a raw provider error on the first tool call) and left
 * `contextWindow` unset, so a long chat was never compacted before being
 * billed. Opening the picker once "fixed" it, which is the shape of a bug. */
let catalogLoaded = false;

/** When the last catalog fetch was attempted, successful or not. */
let catalogAttemptedAtMs: number | null = null;

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

async function withFetchLock<T>(fn: () => Promise<T>): Promise<T> {
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
  rejectedKeys.clear();
  catalogLoaded = false;
  catalogAttemptedAtMs = null;
  fetchLockChain = Promise.resolve();
}

// ────────────────────────────────────────────── macOS Keychain (plain item)
//
// See the module doc's KEYCHAIN section for why this is a fresh, narrower
// sibling of `keychain.ts`'s biometric FFI rather than a reuse of it.

const IS_MACOS = process.platform === "darwin";
const CF_STRING_ENCODING_UTF8 = 0x08000100;

// <Security/SecBase.h> OSStatus values, restated locally so this module stays
// self-contained (the same values keychain.ts restates for its own, unrelated
// Keychain item shape).
const ERR_SEC_ITEM_NOT_FOUND = -25300;
const ERR_SEC_DUPLICATE_ITEM = -25299;
const ERR_SEC_PARAM = -50;

class KeychainStatusError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`Keychain status ${code}`);
    this.code = code;
  }
}

interface Native {
  CFRelease: (cf: unknown) => void;
  CFStringCreateWithCString: (alloc: unknown, cStr: string, encoding: number) => unknown;
  CFDataCreate: (allocator: unknown, bytes: Uint8Array, length: number) => unknown;
  // koffi hands back a plain JS `number` for `int64_t`/`uint64_t`, not a
  // BigInt — verified against the loaded library on this Mac, not assumed.
  // Declaring these as `bigint` made the zero-length guard below (`=== 0n`)
  // dead code, which is exactly the case it existed to handle.
  CFDataGetLength: (data: unknown) => number;
  CFDataGetBytePtr: (data: unknown) => unknown;
  CFDictionaryCreate: (
    allocator: unknown,
    keys: unknown[],
    values: unknown[],
    numValues: number,
    keyCallBacks: unknown,
    valueCallBacks: unknown,
  ) => unknown;
  CFGetTypeID: (cf: unknown) => number;
  CFDataGetTypeID: () => number;
  SecItemAdd: (query: unknown, result: unknown[]) => number;
  SecItemCopyMatching: (query: unknown, result: unknown[]) => number;
  SecItemDelete: (query: unknown) => number;
  SecItemUpdate: (query: unknown, attributesToUpdate: unknown) => number;
  kSecClass: unknown;
  kSecClassGenericPassword: unknown;
  kSecAttrService: unknown;
  kSecAttrAccount: unknown;
  kSecValueData: unknown;
  kSecReturnData: unknown;
  kCFBooleanTrue: unknown;
}

let cachedNative: Native | null = null;

function readConstant(lib: ReturnType<typeof koffi.load>, name: string): unknown {
  return koffi.decode(lib.symbol(name, "void *"), "void *");
}

function loadNative(): Native {
  if (cachedNative) return cachedNative;
  const CF = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const Security = koffi.load("/System/Library/Frameworks/Security.framework/Security");
  cachedNative = {
    CFRelease: CF.func("void CFRelease(void *cf)"),
    CFStringCreateWithCString: CF.func(
      "void *CFStringCreateWithCString(void *alloc, const char *cStr, uint32_t encoding)",
    ),
    CFDataCreate: CF.func("void *CFDataCreate(void *allocator, const uint8_t *bytes, int64_t length)"),
    CFDataGetLength: CF.func("int64_t CFDataGetLength(void *theData)"),
    CFDataGetBytePtr: CF.func("void *CFDataGetBytePtr(void *theData)"),
    CFDictionaryCreate: CF.func(
      "void *CFDictionaryCreate(void *allocator, void **keys, void **values, int64_t numValues, void *keyCallBacks, void *valueCallBacks)",
    ),
    CFGetTypeID: CF.func("uint64_t CFGetTypeID(void *cf)"),
    CFDataGetTypeID: CF.func("uint64_t CFDataGetTypeID(void)"),
    SecItemAdd: Security.func("int32_t SecItemAdd(void *query, _Out_ void **result)"),
    SecItemCopyMatching: Security.func("int32_t SecItemCopyMatching(void *query, _Out_ void **result)"),
    SecItemDelete: Security.func("int32_t SecItemDelete(void *query)"),
    SecItemUpdate: Security.func("int32_t SecItemUpdate(void *query, void *attributesToUpdate)"),
    kSecClass: readConstant(Security, "kSecClass"),
    kSecClassGenericPassword: readConstant(Security, "kSecClassGenericPassword"),
    kSecAttrService: readConstant(Security, "kSecAttrService"),
    kSecAttrAccount: readConstant(Security, "kSecAttrAccount"),
    kSecValueData: readConstant(Security, "kSecValueData"),
    kSecReturnData: readConstant(Security, "kSecReturnData"),
    kCFBooleanTrue: readConstant(CF, "kCFBooleanTrue"),
  };
  return cachedNative;
}

/** Tracks CF objects this call created (create-rule) so they always get
 * released, success or throw — the same pattern `keychain.ts` uses. */
class Arena {
  private owned: unknown[] = [];

  own<T>(ptr: T): T {
    this.owned.push(ptr);
    return ptr;
  }

  releaseAll(n: Native): void {
    for (let i = this.owned.length - 1; i >= 0; i--) {
      const ptr = this.owned[i];
      if (ptr) n.CFRelease(ptr);
    }
    this.owned = [];
  }
}

function buildDict(n: Native, pairs: ReadonlyArray<readonly [unknown, unknown]>): unknown {
  const keys = pairs.map((p) => p[0]);
  const values = pairs.map((p) => p[1]);
  return n.CFDictionaryCreate(null, keys, values, keys.length, null, null);
}

function cfstr(n: Native, arena: Arena, s: string): unknown {
  return arena.own(n.CFStringCreateWithCString(null, s, CF_STRING_ENCODING_UTF8));
}

function readGenericPasswordBytes(service: string, account: string): Buffer {
  const n = loadNative();
  const arena = new Arena();
  try {
    const svc = cfstr(n, arena, service);
    const acct = cfstr(n, arena, account);
    const query = arena.own(
      buildDict(n, [
        [n.kSecClass, n.kSecClassGenericPassword],
        [n.kSecAttrService, svc],
        [n.kSecAttrAccount, acct],
        [n.kSecReturnData, n.kCFBooleanTrue],
      ]),
    );
    const result: unknown[] = [null];
    const status = n.SecItemCopyMatching(query, result);
    if (status !== 0) throw new KeychainStatusError(status);
    const dataRef = result[0];
    // A status of 0 with no CFData back is not a "no key saved" case, so it
    // must not borrow that status code — report it as the malformed result
    // it is.
    if (!dataRef) throw new KeychainStatusError(ERR_SEC_PARAM);
    try {
      if (n.CFGetTypeID(dataRef) !== n.CFDataGetTypeID()) {
        throw new KeychainStatusError(ERR_SEC_PARAM);
      }
      const length = n.CFDataGetLength(dataRef);
      // A zero-length item has to be short-circuited before either call below:
      // `CFDataGetBytePtr` answers NULL for one, and `koffi.decode` refuses a
      // zero-length array outright ("Array length must be positive and
      // non-zero"). Written `<= 0` rather than `=== 0`: relational comparison
      // coerces across number/BigInt, so this stays correct whichever koffi
      // hands back, where a strict `=== 0n` silently never fired.
      //
      // Empty is a real answer, not an error — `security_framework`'s
      // `generic_password` returns an empty `Vec<u8>` here and the Rust
      // source's `String::from_utf8` turns it into `Ok("")`, which
      // `provider_connected`/`openrouter_key` then reject on the blank check.
      if (length <= 0) return Buffer.alloc(0);
      const bytePtr = n.CFDataGetBytePtr(dataRef);
      const view = koffi.decode(bytePtr, koffi.array("uint8_t", Number(length))) as Uint8Array;
      return Buffer.from(view);
    } finally {
      n.CFRelease(dataRef);
    }
  } finally {
    arena.releaseAll(n);
  }
}

function storeGenericPasswordBytes(service: string, account: string, password: Buffer): void {
  const n = loadNative();
  const arena = new Arena();
  try {
    const svc = cfstr(n, arena, service);
    const acct = cfstr(n, arena, account);
    const pwData = arena.own(n.CFDataCreate(null, password, password.length));

    const basePairs: ReadonlyArray<readonly [unknown, unknown]> = [
      [n.kSecClass, n.kSecClassGenericPassword],
      [n.kSecAttrService, svc],
      [n.kSecAttrAccount, acct],
    ];

    const addQuery = arena.own(buildDict(n, [...basePairs, [n.kSecValueData, pwData] as const]));
    const result: unknown[] = [null];
    const status = n.SecItemAdd(addQuery, result);
    if (result[0]) n.CFRelease(result[0]);

    if (status === ERR_SEC_DUPLICATE_ITEM) {
      // Mirrors security-framework's own `set_password_internal` fallback: on
      // a duplicate, update just the value data against the base query rather
      // than failing.
      const matchQuery = arena.own(buildDict(n, basePairs));
      const updateAttrs = arena.own(buildDict(n, [[n.kSecValueData, pwData] as const]));
      const updateStatus = n.SecItemUpdate(matchQuery, updateAttrs);
      if (updateStatus !== 0) throw new KeychainStatusError(updateStatus);
    } else if (status !== 0) {
      throw new KeychainStatusError(status);
    }
  } finally {
    arena.releaseAll(n);
  }
}

function deleteGenericPasswordEntry(service: string, account: string): void {
  const n = loadNative();
  const arena = new Arena();
  try {
    const svc = cfstr(n, arena, service);
    const acct = cfstr(n, arena, account);
    const query = arena.own(
      buildDict(n, [
        [n.kSecClass, n.kSecClassGenericPassword],
        [n.kSecAttrService, svc],
        [n.kSecAttrAccount, acct],
      ]),
    );
    const status = n.SecItemDelete(query);
    if (status !== 0 && status !== ERR_SEC_ITEM_NOT_FOUND) {
      throw new KeychainStatusError(status);
    }
  } finally {
    arena.releaseAll(n);
  }
}

/** `providers.rs::read_key`. `service` defaults to the real constant but is
 * overridable so a test never has to touch a real saved key. */
export function readKey(provider: string, service: string = KEYCHAIN_SERVICE): string {
  if (!IS_MACOS) {
    throw new Error("API-key storage currently requires macOS Keychain.");
  }
  let bytes: Buffer;
  try {
    bytes = readGenericPasswordBytes(service, provider);
  } catch (e) {
    const code = e instanceof KeychainStatusError ? e.code : -1;
    throw new Error(`No API key is saved for ${provider}. [code ${code}]`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The saved API key is not valid UTF-8.");
  }
}

/** `providers.rs::store_key`. */
export function storeKey(provider: string, key: string, service: string = KEYCHAIN_SERVICE): void {
  if (!IS_MACOS) {
    throw new Error("API-key storage currently requires macOS Keychain.");
  }
  try {
    storeGenericPasswordBytes(service, provider, Buffer.from(key, "utf8"));
  } catch (e) {
    const code = e instanceof KeychainStatusError ? e.code : -1;
    throw new Error(`Could not save the API key in Keychain. [code ${code}]`);
  }
}

/** `providers.rs::delete_key` — a missing entry is success, same as the Rust
 * source's `errSecItemNotFound => Ok(())` arm; non-macOS is `Ok(())` there
 * too, since nothing was ever stored. */
export function deleteKey(provider: string, service: string = KEYCHAIN_SERVICE): void {
  if (!IS_MACOS) return;
  try {
    deleteGenericPasswordEntry(service, provider);
  } catch (e) {
    const code = e instanceof KeychainStatusError ? e.code : -1;
    throw new Error(`Could not remove the API key. [code ${code}]`);
  }
}

/** The real default {@link ProviderDeps}: the actual macOS Keychain and the
 * actual network. */
export const defaultProviderDeps: ProviderDeps = {
  readKey: (provider) => readKey(provider),
  storeKey: (provider, key) => storeKey(provider, key),
  deleteKey: (provider) => deleteKey(provider),
  fetchJson: realFetchJson,
};

// ─────────────────────────────────────────────────────────────── providers

function providerSpec(provider: string): { label: string; baseUrl: string } {
  if (provider === OPENROUTER_ID) return { label: "OpenRouter", baseUrl: OPENROUTER_BASE_URL };
  throw new Error(`Unknown AI provider: ${provider}`);
}

/**
 * The model slug out of a composite `"<provider>::<slug>[::<effort>]"`
 * selection, or `undefined` when there is no second segment at all.
 *
 * The Rust source spells this `model.splitn(3, "::").nth(1)`. A plain
 * `.split("::")[1]` is exactly equivalent for index 0 or 1 — both name the
 * text between the first and second separator — and only index 2 (which
 * nothing here reads) would differ, so no `splitn` re-implementation is
 * warranted.
 */
function selectedSlug(model: string): string | undefined {
  return model.split("::")[1];
}

/** `providers.rs::provider_model_facts` — everything the live catalog knows
 * about one provider model, or `undefined` when it has no entry for it, so
 * the caller decides what "unknown" means rather than being handed a guess.
 * `capabilities.rs` turns each field into a `Support`, where that absence
 * becomes `Support::Unknown`. */
export function providerModelFacts(model: string): ModelRuntimeFacts | undefined {
  const raw = selectedSlug(model);
  if (raw === undefined) return undefined;
  return modelRuntimeCache.get(raw.trim());
}

/** `providers.rs::provider_model_vision` — does the catalog say this provider
 * model accepts image INPUT? `undefined` when the catalog has nothing for
 * it. */
export function providerModelVision(model: string): boolean | undefined {
  return providerModelFacts(model)?.vision;
}

/** `providers.rs::is_api_provider_model`. */
export function isApiProviderModel(model: string): boolean {
  return model.split("::")[0] === OPENROUTER_ID;
}

/**
 * `providers.rs::media_catalog_path` — where to ask for one media catalogue.
 *
 * The PUBLIC `/models`, deliberately — not the user-scoped `/models/user`
 * this module uses for everything else. `/models/user` ignores the filter
 * rather than honouring it (OpenRouter drops unknown query parameters
 * silently: `?bogus_param=1` answers 200 with the full 400-model list), so
 * asking it for the video catalogue returns the ordinary chat catalogue, the
 * merge finds nothing new, and the Create page shows a video tab reading zero
 * while twenty-one video models sit one endpoint away. That is precisely the
 * bug this comment exists to stop someone re-introducing by "tidying" these
 * two paths into one.
 */
export function mediaCatalogPath(modality: string): string {
  return `/models?output_modalities=${modality}`;
}

/** The ordering `models.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label
 * .to_lowercase()))` gives in Rust: a plain code-point comparison of the
 * lowercased label, NOT a locale-aware collation (which is what
 * `localeCompare` would give, and which orders non-ASCII labels
 * differently). */
function byLowercaseLabel(a: ExternalModelInfo, b: ExternalModelInfo): number {
  const al = a.label.toLowerCase();
  const bl = b.label.toLowerCase();
  if (al < bl) return -1;
  if (al > bl) return 1;
  return 0;
}

/** `providers.rs::parse_openrouter_models` — pure and network-free, exactly
 * what the Rust source's own fixture tests exercise. Every capability flag is
 * read from the catalog's own declared fields and never inferred from the
 * slug: "flux", "image" and "video" appear in the names of models that only
 * DESCRIBE pictures, and the models that do draw are not obliged to say so in
 * their id. */
export function parseOpenrouterModels(value: unknown): ExternalModelInfo[] {
  const models: ExternalModelInfo[] = [];
  const data = jget(value, "data");
  for (const raw of Array.isArray(data) ? data : []) {
    const slug = jstr(jget(raw, "id"));
    if (slug === null) continue;
    const label = jstr(jget(raw, "name")) ?? slug;
    const parameters = jstrArray(jget(raw, "supported_parameters"));
    const architecture = jget(raw, "architecture");
    const inputModalities = jstrArray(jget(architecture, "input_modalities"));
    const outputModalities = jstrArray(jget(architecture, "output_modalities"));
    const pricing = jget(raw, "pricing");
    models.push({
      slug,
      label,
      efforts: [],
      defaultEffort: null,
      contextWindow: jUnsignedInt(jget(raw, "context_length")),
      description: jstr(jget(raw, "description")),
      inputPrice: jstr(jget(pricing, "prompt")),
      outputPrice: jstr(jget(pricing, "completion")),
      inputModalities,
      outputModalities,
      tools: parameters.includes("tools"),
      vision: inputModalities.includes("image"),
      // Derived from `outputModalities`. Silence is not permission: a catalog
      // entry that declares no modalities at all must not read as "can draw".
      imageOutput: outputModalities.includes("image"),
      videoOutput: outputModalities.includes("video"),
      reasoning: parameters.includes("reasoning") || parameters.includes("include_reasoning"),
      structuredOutputs: parameters.includes("structured_outputs") || parameters.includes("response_format"),
    });
  }
  models.sort(byLowercaseLabel);
  return models;
}

/** `providers.rs::fetch_openrouter_catalog` — one authenticated catalogue
 * GET, parsed. `path` is appended verbatim. */
async function fetchOpenrouterCatalog(
  key: string,
  path: string,
  fetchJson: FetchJsonLike,
): Promise<ExternalModelInfo[]> {
  let response: HttpJsonResponseLike;
  try {
    response = await fetchJson(`${OPENROUTER_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://arcelle.app",
        "X-OpenRouter-Title": "Arcelle",
      },
      // One deadline for the whole request — connect, headers AND body —
      // matching reqwest's `.timeout(Duration::from_secs(30))`.
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Could not reach OpenRouter: ${e instanceof Error ? e.message : String(e)}`);
  }
  // `response.json().await.unwrap_or_default()` — an unreadable body is not
  // itself the error to report; the status below still decides.
  let value: unknown = null;
  try {
    value = await response.json();
  } catch {
    value = null;
  }
  if (!response.ok) {
    const message =
      jstr(jget(jget(value, "error"), "message")) ?? jstr(jget(value, "error")) ?? "OpenRouter rejected the request";
    if (response.status === 401) {
      noteKeyRejected(OPENROUTER_ID);
      throw new Error("OpenRouter rejected this API key.");
    }
    throw new Error(`OpenRouter error (${response.status}): ${message}`);
  }
  return parseOpenrouterModels(value);
}

/** `providers.rs::fetch_openrouter_models` — the user-scoped chat catalogue
 * (which doubles as the authenticated key check), then the two media
 * catalogues merged in by slug, sorted, and folded into the capability
 * cache. */
async function fetchOpenrouterModels(key: string, fetchJson: FetchJsonLike): Promise<ExternalModelInfo[]> {
  // The user-scoped catalog respects the account's provider preferences,
  // privacy settings and guardrails. It is also an authenticated key check —
  // so a bad key fails HERE, before the supplementary calls below.
  const models = await fetchOpenrouterCatalog(key, "/models/user", fetchJson);
  clearKeyRejected(OPENROUTER_ID);

  // Then the media catalogues, merged in by slug. A failure on one of these
  // is NOT fatal: the chat catalog above already succeeded, and losing the
  // whole model list because the picture models could not be listed would be
  // a far worse outcome than a Create page that is short a few rows.
  const known = new Set(models.map((m) => m.slug));
  for (const modality of MEDIA_MODALITIES) {
    try {
      const extra = await fetchOpenrouterCatalog(key, mediaCatalogPath(modality), fetchJson);
      for (const model of extra) {
        if (!known.has(model.slug)) {
          known.add(model.slug);
          models.push(model);
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`OpenRouter ${modality} catalog unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Each batch arrives sorted, but appending three of them does not stay
  // sorted — and the picker shows this list verbatim.
  models.sort(byLowercaseLabel);

  for (const model of models) {
    modelRuntimeCache.set(model.slug, {
      contextWindow: model.contextWindow,
      tools: model.tools,
      vision: model.vision,
      structuredOutputs: model.structuredOutputs,
      imageOutput: model.imageOutput,
      videoOutput: model.videoOutput,
    });
  }
  catalogLoaded = true;
  return models;
}

/** `providers.rs::openrouter_key` — the stored OpenRouter key when one is
 * connected and non-blank, returned verbatim (untrimmed, as the Rust
 * `.filter()` only inspects the trimmed form).
 *
 * Exposed so the media-limits tables can be fetched with the same credential
 * the catalogue uses, without a second Keychain vocabulary growing up beside
 * this one. */
export function openrouterKey(deps: ProviderDeps = defaultProviderDeps): string | null {
  try {
    const key = deps.readKey(OPENROUTER_ID);
    return key.trim() === "" ? null : key;
  } catch {
    return null;
  }
}

/** `providers.rs::provider_connected`. */
export function providerConnected(provider: string, deps: ProviderDeps = defaultProviderDeps): boolean {
  if (keyRejected(provider)) return false;
  try {
    return deps.readKey(provider).trim() !== "";
  } catch {
    return false;
  }
}

/** `providers.rs::list_provider_models`. */
export async function listProviderModels(
  provider: string,
  deps: ProviderDeps = defaultProviderDeps,
): Promise<ExternalModelInfo[]> {
  providerSpec(provider);
  const key = deps.readKey(provider);
  // `providerSpec` above already refused every provider but OpenRouter; this
  // mirrors the Rust source's own `_ => unreachable!()` arm, so a second
  // provider added to `providerSpec` cannot silently route to OpenRouter's
  // fetcher.
  if (provider !== OPENROUTER_ID) throw new Error(`Unreachable: unknown provider ${provider}`);
  return fetchOpenrouterModels(key, deps.fetchJson);
}

/**
 * `providers.rs::ensure_provider_catalog` — make sure this process has the
 * provider catalog before a model's declared capabilities are read. Cheap and
 * silent: a no-op unless `model` is a provider model whose entry is missing,
 * and it gives up (leaving the unknown default) rather than failing a turn if
 * the catalog cannot be fetched.
 *
 * Fetched at most once per process on success, and at most once per
 * {@link CATALOG_RETRY_AFTER_MS} while it keeps failing — single-flighted, so
 * concurrent AI calls share one attempt instead of each firing its own.
 */
export async function ensureProviderCatalog(model: string, deps: ProviderDeps = defaultProviderDeps): Promise<void> {
  if (!isApiProviderModel(model) || catalogLoaded) return;
  const selected = selectedSlug(model)?.trim();
  if (selected === undefined || selected === "") return;
  if (modelRuntimeCache.has(selected)) return;
  await withFetchLock(async () => {
    // The winner of the race may have just filled it.
    if (catalogLoaded) return;
    const sinceLastAttempt = catalogAttemptedAtMs === null ? null : Date.now() - catalogAttemptedAtMs;
    if (!catalogRetryDue(sinceLastAttempt)) return;
    catalogAttemptedAtMs = Date.now();
    try {
      // `fetchOpenrouterModels` sets `catalogLoaded` itself on success, so the
      // guard above short-circuits every later call for the process's lifetime.
      await listProviderModels(OPENROUTER_ID, deps);
    } catch {
      // `let _ = list_provider_models(…).await;` — deliberately swallowed.
    }
  });
}

// ──────────────────────────────────────────────── runtime config (sidecar)

/**
 * `providers.rs::provider_runtime_config`. Returns `null` for a non-OpenRouter
 * model (mirroring `Ok(None)`); throws for a missing/blank selection or for a
 * key that is no longer saved (mirroring `Err(String)`).
 */
export function providerRuntimeConfig(
  model: string,
  deps: ProviderDeps = defaultProviderDeps,
): ProviderRuntimeConfig | null {
  const parts = model.split("::");
  const provider = parts[0] ?? "";
  if (provider !== OPENROUTER_ID) return null;

  // Matches the Rust source exactly: the filter only checks whether the
  // TRIMMED value is non-empty, but `selected` itself stays UNTRIMMED —
  // unlike `providerModelFacts`/`ensureProviderCatalog`, which do trim before
  // their cache lookups.
  const selected = parts[1];
  if (selected === undefined || selected.trim() === "") {
    throw new Error("Choose a specific OpenRouter model first.");
  }

  const { label, baseUrl } = providerSpec(provider);
  const facts = modelRuntimeCache.get(selected);
  const contextWindow = facts ? facts.contextWindow : null;
  const supportsTools = facts ? facts.tools : true;

  // Disconnecting a provider only re-points the OPEN room at a local model.
  // Every other room still set to it lands here with no key, and the generic
  // Keychain error ("No API key is saved for openrouter") was logged and
  // replaced upstream by "AI engine unavailable — the agent sidecar could not
  // start", which blames the wrong thing entirely. Say what actually happened
  // and what fixes it.
  let apiKey: string;
  try {
    apiKey = deps.readKey(provider);
  } catch {
    throw new Error(
      `This room is set to ${label}, but no ${label} API key is saved on this Mac ` +
        `any more. Reconnect it in Settings → Cloud AI, or choose another model in ` +
        `Settings → Model.`,
    );
  }

  return { id: provider, apiKey, baseUrl, model: selected, contextWindow, supportsTools };
}

/** The EXACT JSON object the Python sidecar's `ProviderConfig` reads —
 * snake_case field names on purpose, and the only shape that may be
 * serialized into a `/run` body. See the module doc's WIRE SHAPE section. */
export function providerRuntimeConfigWire(config: ProviderRuntimeConfig): Record<string, unknown> {
  return {
    id: config.id,
    api_key: config.apiKey,
    base_url: config.baseUrl,
    model: config.model,
    context_window: config.contextWindow,
    supports_tools: config.supportsTools,
  };
}

/**
 * `providers.rs::inject_provider_runtime`. For a non-provider model the body
 * is handed straight back (the caller still owns it, and every call site
 * serializes it immediately); for a provider model a new object carrying the
 * wire-shaped `provider` key is returned.
 *
 * `body` is `unknown` rather than a `Record` on purpose: the Rust source only
 * demands an object for the provider branch, so the "must be an object" error
 * has to stay reachable rather than being compiled away.
 */
export function injectProviderRuntime(
  body: unknown,
  model: string,
  deps: ProviderDeps = defaultProviderDeps,
): unknown {
  const config = providerRuntimeConfig(model, deps);
  if (config === null) return body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Sidecar request body must be an object");
  }
  return { ...body, provider: providerRuntimeConfigWire(config) };
}

// ─────────────────────────────────────────────── Tauri-command equivalents

/** `providers.rs::list_ai_providers`. */
export function listAiProviders(deps: ProviderDeps = defaultProviderDeps): AiProviderStatus[] {
  return [{ id: OPENROUTER_ID, label: "OpenRouter", connected: providerConnected(OPENROUTER_ID, deps) }];
}

/** `providers.rs::connect_ai_provider` — the key is only saved once the
 * catalog fetch has accepted it. */
export async function connectAiProvider(
  provider: string,
  apiKey: string,
  deps: ProviderDeps = defaultProviderDeps,
): Promise<number> {
  providerSpec(provider);
  const key = apiKey.trim();
  if (key === "") throw new Error("Enter an API key.");
  // See `listProviderModels` for why this unreachable arm is kept.
  if (provider !== OPENROUTER_ID) throw new Error(`Unreachable: unknown provider ${provider}`);
  const models = await fetchOpenrouterModels(key, deps.fetchJson);
  deps.storeKey(provider, key);
  // A freshly accepted key clears any earlier rejection, so the badge is
  // green again the moment the user pastes a working one.
  clearKeyRejected(provider);
  return models.length;
}

/** `providers.rs::disconnect_ai_provider`. */
export function disconnectAiProvider(provider: string, deps: ProviderDeps = defaultProviderDeps): void {
  providerSpec(provider);
  clearKeyRejected(provider);
  deps.deleteKey(provider);
}
