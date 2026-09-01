// ADD-11 (Electron port) — Touch ID unlock.
//
// Ported from src-tauri/src/biometrics.rs. Stores a room's password in the
// macOS Keychain guarded by biometrics, so the room can be unlocked with a
// fingerprint instead of typing. The secret lives ONLY in the Keychain
// (never in the room file or any plain file), protected by a
// `SecAccessControl` with the `biometryCurrentSet` constraint: it can only
// be read after a live Touch ID / Face ID match against the *currently
// enrolled* set. Re-enrolling a finger invalidates the item, which is what
// we want.
//
// Items are generic passwords keyed by:
//   service = "PrivateRoom", account = <room file path>
// in the data-protection keychain (required for biometric access control).
//
// --- Why koffi instead of a native module -----------------------------
// Node has no built-in binding to Security.framework, so every call below
// goes through koffi's C FFI straight into the two system frameworks:
//   /System/Library/Frameworks/CoreFoundation.framework/CoreFoundation
//   /System/Library/Frameworks/Security.framework/Security
// The kSec*/kCF* constants used as dictionary keys and values are not
// numbers — they are process-wide CFStringRef/CFBooleanRef singletons
// exported BY those framework binaries. `lib.symbol(name, "void *")` gets a
// handle to the exported variable's own address; `koffi.decode(handle,
// "void *")` dereferences it once to get the actual pointer value the
// framework hands out everywhere else it uses that constant (confirmed
// empirically against the real frameworks on this machine — see the report
// that accompanied this port for the exact verification steps).
//
// --- The NULL-callbacks CFDictionary trick ------------------------------
// CFDictionaryCreate normally wants `keyCallBacks`/`valueCallBacks` structs
// (kCFTypeDictionaryKeyCallBacks / kCFTypeDictionaryValueCallBacks) so the
// dictionary can retain/release/compare its contents. Passing NULL for both
// is documented Apple behavior ("all callback functions ... are assumed to
// be NULL") and turns the dictionary into a plain pointer-identity map: no
// retain on insert, no release on deallocation, comparison by pointer only.
// That is exactly what a short-lived query dictionary needs here — we hold
// every value alive in JS for the call's duration and release the ones we
// created ourselves right after, and pointer-identity comparison is fine
// because the kSec* keys are framework singletons compared by the very same
// pointer value on both sides. This sidesteps ever needing the exact struct
// layout of CFDictionaryKeyCallBacks/CFDictionaryValueCallBacks from koffi.
//
// --- What is verified vs. not, in THIS dev sandbox ----------------------
// A plain (non-data-protection) generic password round-trips perfectly
// through this exact FFI plumbing on the real Keychain on this machine:
// SecItemAdd/SecItemCopyMatching/SecItemDelete all return real OSStatus
// codes, and CFData decodes back to the exact original UTF-8 bytes
// (including multi-byte characters). But every function below always sets
// `kSecUseDataProtectionKeychain = true` (as biometrics.rs does — the
// biometric ACL requires it), and on this machine that specific key makes
// EVERY Security.framework call fail with errSecMissingEntitlement (-34018)
// — from a bare `node` process, from an unsigned `Electron.app`, doesn't
// matter. That is not a bug in this file: the data-protection keychain's
// default access group is derived from the caller's code-signing identity
// (Team ID), and ad-hoc signing without a Team ID has none to derive.
// Confirmed by direct experiment (see the port report): for a PLAIN item
// with no access control, the identical CFDictionary/SecItem* plumbing
// succeeds (status 0) the instant `kSecUseDataProtectionKeychain` is
// omitted, and fails (status -34018) the instant it's added back — with
// everything else held constant. Separately confirmed: attaching a
// `kSecAttrAccessControl` built with `SecAccessControlCreateWithFlags`
// (biometryCurrentSet) is ALSO independently sufficient to trigger the same
// -34018, even with `kSecUseDataProtectionKeychain` left out of the query
// entirely — so `store()`'s specific failure in this sandbox is
// over-determined: either its access-control attribute or its explicit
// data-protection flag would sink it on its own. Removing just one would
// not be enough to unblock the biometric path here even in principle; both
// point to the same underlying cause (no Team ID / keychain-access-groups
// entitlement to derive a data-protection access group from), which is why
// this is expected to work in the real, properly-signed Arcelle.app (which
// already ships this exact feature in Rust), but cannot be exercised from a
// plain `vitest` process in this sandbox.

import koffi from "koffi";

export {
  safeStorageHas,
  safeStorageRead,
  safeStorageRemove,
  safeStorageStore,
  safeStorageWrapPath,
} from "./keychainSafeStorage.js";

/** Keychain service; the account is the room's file path. */
export const SERVICE = "PrivateRoom";

// Not exported by any Node package; taken from <Security/SecBase.h>.
const ERR_SEC_USER_CANCELED = -128;
const ERR_SEC_AUTH_FAILED = -25293;
// Restated here (rather than imported from somewhere) so the message
// mapping below is a plain function of an OSStatus number — mirrors the
// Rust source's own comment on why ERR_SEC_ITEM_NOT_FOUND is a local const.
const ERR_SEC_ITEM_NOT_FOUND = -25300;
const ERR_SEC_DUPLICATE_ITEM = -25299;
const ERR_SEC_INTERACTION_NOT_ALLOWED = -25308;
const ERR_SEC_MISSING_ENTITLEMENT = -34018;
// <Security/SecBase.h> errSecParam — used only for the two failure shapes
// that have no real OSStatus of their own (access-control creation failing,
// and a Keychain read handing back something that isn't CFData), exactly as
// the Rust source hardcodes `Error::from_code(errSecParam)` in both spots.
const ERR_SEC_PARAM = -50;

/**
 * Turn a Security.framework OSStatus into a message the UI can show. Cancel,
 * no-match and no-entry map to gentle text so the unlock screen falls back
 * to a password. Anything else means the Keychain itself is unavailable,
 * and those messages have to name the password: a bare status code on the
 * unlock screen reads as the room being gone.
 */
export function messageFor(code: number): string {
  switch (code) {
    case ERR_SEC_USER_CANCELED:
      return "Touch ID was cancelled.";
    case ERR_SEC_AUTH_FAILED:
      return "Touch ID did not match.";
    case ERR_SEC_ITEM_NOT_FOUND:
      return "No Touch ID entry for this room.";
    // errSecMissingEntitlement — the Keychain is unavailable to this build
    // (unsigned/sandboxed run, or no Secure Enclave). Speak plainly and keep
    // the raw code out of the user's face; password still works.
    case ERR_SEC_MISSING_ENTITLEMENT:
      return "Touch ID isn't available on this Mac right now. You can still unlock with your password.";
    // Any other OSStatus: a friendly line, with the raw code tucked at the
    // end in brackets for support without leading with jargon.
    default:
      return `Touch ID isn't available right now. You can still unlock with your password. [code ${code}]`;
  }
}

// ------------------------------------------------------------------------
// macOS Security.framework / CoreFoundation FFI (koffi)
// ------------------------------------------------------------------------

const IS_MACOS = process.platform === "darwin";
const NON_MACOS_MESSAGE = "Touch ID is only available on macOS.";

// <Security/SecAccessControl.h> kSecAccessControlBiometryCurrentSet — value
// confirmed against security-framework-sys's own extern const (1 << 3), not
// guessed: security-framework-sys-2.17.0/src/access_control.rs defines
// `pub const kSecAccessControlBiometryCurrentSet: CFOptionFlags = 1 << 3;`.
const KSEC_ACCESS_CONTROL_BIOMETRY_CURRENT_SET = 1 << 3;
const CF_STRING_ENCODING_UTF8 = 0x08000100;

type NativeLib = ReturnType<typeof koffi.load>;

export interface Native {
  CFRelease: (cf: unknown) => void;
  CFStringCreateWithCString: (alloc: unknown, cStr: string, encoding: number) => unknown;
  CFDataCreate: (allocator: unknown, bytes: Uint8Array, length: number) => unknown;
  CFDataGetLength: (data: unknown) => bigint;
  CFDataGetBytePtr: (data: unknown) => unknown;
  CFDictionaryCreate: (
    allocator: unknown,
    keys: unknown[],
    values: unknown[],
    numValues: number,
    keyCallBacks: unknown,
    valueCallBacks: unknown,
  ) => unknown;
  CFGetTypeID: (cf: unknown) => bigint;
  CFDataGetTypeID: () => bigint;
  SecItemAdd: (query: unknown, result: unknown[]) => number;
  SecItemCopyMatching: (query: unknown, result: unknown[]) => number;
  SecItemDelete: (query: unknown) => number;
  SecItemUpdate: (query: unknown, attributesToUpdate: unknown) => number;
  SecAccessControlCreateWithFlags: (
    allocator: unknown,
    protection: unknown,
    flags: bigint,
    error: unknown[],
  ) => unknown;
  kSecClass: unknown;
  kSecClassGenericPassword: unknown;
  kSecAttrService: unknown;
  kSecAttrAccount: unknown;
  kSecValueData: unknown;
  kSecReturnData: unknown;
  kSecReturnAttributes: unknown;
  kSecUseDataProtectionKeychain: unknown;
  kSecUseAuthenticationUI: unknown;
  kSecUseAuthenticationUISkip: unknown;
  kSecAttrAccessControl: unknown;
  kSecAttrLabel: unknown;
  kSecAttrAccessibleWhenUnlockedThisDeviceOnly: unknown;
  kCFBooleanTrue: unknown;
}

let cachedNative: Native | null = null;

/**
 * Read an exported CFStringRef/CFBooleanRef global. `lib.symbol()` returns a
 * handle to the *address of the variable itself*; these constants are
 * pointer-sized values stored at that address, so one `koffi.decode` gets
 * the actual CFTypeRef the framework uses everywhere else.
 */
function readConstant(lib: NativeLib, name: string): unknown {
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
    SecAccessControlCreateWithFlags: Security.func(
      "void *SecAccessControlCreateWithFlags(void *allocator, void *protection, uint64_t flags, _Out_ void **error)",
    ),
    kSecClass: readConstant(Security, "kSecClass"),
    kSecClassGenericPassword: readConstant(Security, "kSecClassGenericPassword"),
    kSecAttrService: readConstant(Security, "kSecAttrService"),
    kSecAttrAccount: readConstant(Security, "kSecAttrAccount"),
    kSecValueData: readConstant(Security, "kSecValueData"),
    kSecReturnData: readConstant(Security, "kSecReturnData"),
    kSecReturnAttributes: readConstant(Security, "kSecReturnAttributes"),
    kSecUseDataProtectionKeychain: readConstant(Security, "kSecUseDataProtectionKeychain"),
    kSecUseAuthenticationUI: readConstant(Security, "kSecUseAuthenticationUI"),
    kSecUseAuthenticationUISkip: readConstant(Security, "kSecUseAuthenticationUISkip"),
    kSecAttrAccessControl: readConstant(Security, "kSecAttrAccessControl"),
    kSecAttrLabel: readConstant(Security, "kSecAttrLabel"),
    kSecAttrAccessibleWhenUnlockedThisDeviceOnly: readConstant(
      Security,
      "kSecAttrAccessibleWhenUnlockedThisDeviceOnly",
    ),
    kCFBooleanTrue: readConstant(CF, "kCFBooleanTrue"),
  };
  return cachedNative;
}

/** Tracks CF objects this call created (create-rule) so they always get
 * released, success or throw. Framework singleton constants (the kSec- and
 * kCF-prefixed globals) are never tracked here — they are process-lifetime
 * globals owned by the framework, never ours to release. */
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

function requireMacOS(): void {
  if (!IS_MACOS) throw new Error(NON_MACOS_MESSAGE);
}

function withArena<T>(n: Native, work: (arena: Arena) => T): T {
  const arena = new Arena();
  try {
    return work(arena);
  } finally {
    arena.releaseAll(n);
  }
}

function releaseResult(n: Native, result: unknown[]): void {
  if (result[0]) n.CFRelease(result[0]);
}

function createBiometricAccessControl(n: Native, arena: Arena): unknown {
  // Rust's create_with_protection() passes ptr::null_mut() for the error
  // out-param and, on a null result, hardcodes errSecParam (-50) as the
  // reported code rather than reading whatever SecAccessControlCreateWithFlags
  // actually wrote — ported exactly, including the discarded error.
  const errorOut: unknown[] = [null];
  const access = n.SecAccessControlCreateWithFlags(
    null,
    n.kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    BigInt(KSEC_ACCESS_CONTROL_BIOMETRY_CURRENT_SET),
    errorOut,
  );
  if (!access) {
    throw new Error(`Could not create biometric access control (${ERR_SEC_PARAM}).`);
  }
  return arena.own(access);
}

function storeBasePairs(
  n: Native,
  service: unknown,
  account: unknown,
  access: unknown,
  label: unknown,
): ReadonlyArray<readonly [unknown, unknown]> {
  return [
    [n.kSecClass, n.kSecClassGenericPassword],
    [n.kSecAttrService, service],
    [n.kSecAttrAccount, account],
    [n.kSecAttrAccessControl, access],
    [n.kSecAttrLabel, label],
    [n.kSecUseDataProtectionKeychain, n.kCFBooleanTrue],
  ];
}

function addOrUpdatePassword(
  n: Native,
  arena: Arena,
  basePairs: ReadonlyArray<readonly [unknown, unknown]>,
  passwordData: unknown,
): void {
  const addQuery = arena.own(buildDict(n, [...basePairs, [n.kSecValueData, passwordData] as const]));
  const result: unknown[] = [null];
  const status = n.SecItemAdd(addQuery, result);
  releaseResult(n, result);

  if (status === ERR_SEC_DUPLICATE_ITEM) {
    // Mirrors security-framework's set_password_internal fallback: on a
    // duplicate, update just the value data against the base query
    // instead of failing. store() already deletes first, so this should
    // be unreachable outside of a race — kept for fidelity and safety.
    const matchQuery = arena.own(buildDict(n, basePairs));
    const updateAttrs = arena.own(buildDict(n, [[n.kSecValueData, passwordData] as const]));
    const updateStatus = n.SecItemUpdate(matchQuery, updateAttrs);
    if (updateStatus !== 0) throw new Error(messageFor(updateStatus));
    return;
  }

  if (status !== 0) throw new Error(messageFor(status));
}

function storeWithNative(n: Native, arena: Arena, roomPath: string, password: string, service: string): void {
  const access = createBiometricAccessControl(n, arena);
  const serviceRef = cfstr(n, arena, service);
  const accountRef = cfstr(n, arena, roomPath);
  const label = cfstr(n, arena, "Arcelle — Touch ID unlock");
  const passwordBytes = Buffer.from(password, "utf8");
  const passwordData = arena.own(n.CFDataCreate(null, passwordBytes, passwordBytes.length));
  addOrUpdatePassword(n, arena, storeBasePairs(n, serviceRef, accountRef, access, label), passwordData);
}

function readDataRef(n: Native, arena: Arena, roomPath: string, service: string): unknown {
  const serviceRef = cfstr(n, arena, service);
  const accountRef = cfstr(n, arena, roomPath);
  const query = arena.own(
    buildDict(n, [
      [n.kSecClass, n.kSecClassGenericPassword],
      [n.kSecAttrService, serviceRef],
      [n.kSecAttrAccount, accountRef],
      [n.kSecReturnData, n.kCFBooleanTrue],
      [n.kSecUseDataProtectionKeychain, n.kCFBooleanTrue],
    ]),
  );
  const result: unknown[] = [null];
  // This call is the one that triggers the real Touch ID / Face ID prompt
  // (kSecReturnData forces LocalAuthentication to evaluate the item's access
  // control before handing back the secret).
  const status = n.SecItemCopyMatching(query, result);
  if (status !== 0) throw new Error(messageFor(status));
  if (!result[0]) throw new Error(messageFor(ERR_SEC_PARAM));
  return result[0];
}

function decodeDataRef(n: Native, dataRef: unknown): string {
  try {
    // Defensive type check, mirroring get_password_and_release: we asked
    // for kSecReturnData so this should always be CFData, but Rust checks
    // rather than assumes.
    if (n.CFGetTypeID(dataRef) !== n.CFDataGetTypeID()) {
      throw new Error(messageFor(ERR_SEC_PARAM));
    }
    const length = n.CFDataGetLength(dataRef);
    if (length === 0n) return "";
    const bytePtr = n.CFDataGetBytePtr(dataRef);
    const view = koffi.decode(bytePtr, koffi.array("uint8_t", Number(length))) as Uint8Array;
    const bytes = Buffer.from(view);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Stored secret was not valid UTF-8.");
    }
  } finally {
    n.CFRelease(dataRef);
  }
}

function readWithNative(n: Native, arena: Arena, roomPath: string, service: string): string {
  return decodeDataRef(n, readDataRef(n, arena, roomPath, service));
}

/**
 * Creates isolated operations for deterministic FFI unit tests. It never
 * calls `loadNative`, the platform keychain, or Electron; callers provide a
 * complete fake `Native` implementation instead.
 */
export function createKeychainFfiForTests(native: Native): {
  store(roomPath: string, password: string, service?: string): void;
  read(roomPath: string, service?: string): string;
} {
  return {
    store(roomPath, password, service = SERVICE) {
      withArena(native, (arena) => storeWithNative(native, arena, roomPath, password, service));
    },
    read(roomPath, service = SERVICE) {
      return withArena(native, (arena) => readWithNative(native, arena, roomPath, service));
    },
  };
}

/**
 * Does a biometric entry exist for this room? Queries attributes ONLY (no
 * `kSecReturnData`) and skips any auth UI, so it never triggers a prompt —
 * safe to call the moment the unlock screen appears.
 */
export function has(roomPath: string, serviceOverride?: string): boolean {
  if (!IS_MACOS) return false;
  const n = loadNative();
  const arena = new Arena();
  try {
    const svc = cfstr(n, arena, serviceOverride ?? SERVICE);
    const acct = cfstr(n, arena, roomPath);
    const query = arena.own(
      buildDict(n, [
        [n.kSecClass, n.kSecClassGenericPassword],
        [n.kSecAttrService, svc],
        [n.kSecAttrAccount, acct],
        [n.kSecReturnAttributes, n.kCFBooleanTrue],
        [n.kSecUseDataProtectionKeychain, n.kCFBooleanTrue],
        [n.kSecUseAuthenticationUI, n.kSecUseAuthenticationUISkip],
      ]),
    );
    const result: unknown[] = [null];
    const status = n.SecItemCopyMatching(query, result);
    // Release anything handed back (attributes dictionary), matching the
    // Rust source's RAII wrap-under-create-rule-then-drop.
    if (result[0]) n.CFRelease(result[0]);
    // Present-but-locked (InteractionNotAllowed) still means the item exists.
    return status === 0 || status === ERR_SEC_INTERACTION_NOT_ALLOWED;
  } finally {
    arena.releaseAll(n);
  }
}

/**
 * Store `password` for `roomPath`, guarded by `biometryCurrentSet`, in the
 * data-protection keychain, marked "this device only" so it never syncs.
 * Any existing entry is replaced. Creating does not require a prompt.
 */
export function store(roomPath: string, password: string, serviceOverride?: string): void {
  requireMacOS();

  // Replace cleanly: drop any prior item first so we never hit the
  // authenticated update path on a biometric item. Mirrors the Rust
  // source's `let _ = delete(path);` — errors from this are ignored.
  try {
    deleteEntry(roomPath, serviceOverride);
  } catch {
    // ignored, exactly like the Rust source
  }

  const n = loadNative();
  withArena(n, (arena) => storeWithNative(n, arena, roomPath, password, serviceOverride ?? SERVICE));
}

/**
 * Trigger the system biometric prompt and return the stored password.
 * Requesting the data forces the LocalAuthentication prompt; cancel / no
 * match surface as a clear error so the UI can fall back to typing.
 */
export function read(roomPath: string, serviceOverride?: string): string {
  requireMacOS();
  const n = loadNative();
  return withArena(n, (arena) => readWithNative(n, arena, roomPath, serviceOverride ?? SERVICE));
}

interface DeleteEntryDeps {
  isMacOS(): boolean;
  loadNative(): Native;
}

const defaultDeleteEntryDeps: DeleteEntryDeps = {
  isMacOS: () => IS_MACOS,
  loadNative,
};

/** Delete the entry for `roomPath`. Missing is success (idempotent). */
export function deleteEntry(
  roomPath: string,
  serviceOverride?: string,
  deps: DeleteEntryDeps = defaultDeleteEntryDeps,
): void {
  if (!deps.isMacOS()) return; // matches the Rust source's non-macOS `Ok(())`
  const n = deps.loadNative();
  const arena = new Arena();
  try {
    const svc = cfstr(n, arena, serviceOverride ?? SERVICE);
    const acct = cfstr(n, arena, roomPath);
    const query = arena.own(
      buildDict(n, [
        [n.kSecClass, n.kSecClassGenericPassword],
        [n.kSecAttrService, svc],
        [n.kSecAttrAccount, acct],
        [n.kSecUseDataProtectionKeychain, n.kCFBooleanTrue],
      ]),
    );
    const status = n.SecItemDelete(query);
    if (status !== 0 && status !== ERR_SEC_ITEM_NOT_FOUND) {
      throw new Error(messageFor(status));
    }
  } finally {
    arena.releaseAll(n);
  }
}
