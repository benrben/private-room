import koffi from "koffi";
import type { AiProviderStatus, ExternalModelInfo } from "../shared/apiTypes.js";
import { KEYCHAIN_SERVICE, realFetchJson, ProviderDeps, e2eProviderKeys, providerKeySessionCache, readProviderKeyOnce } from "./providersCore.js";

// ────────────────────────────────────────────── macOS Keychain (plain item)
//
// See the module doc's KEYCHAIN section for why this is a fresh, narrower
// sibling of `keychain.ts`'s biometric FFI rather than a reuse of it.

export const IS_MACOS = process.platform === "darwin";
export const CF_STRING_ENCODING_UTF8 = 0x08000100;

// <Security/SecBase.h> OSStatus values, restated locally so this module stays
// self-contained (the same values keychain.ts restates for its own, unrelated
// Keychain item shape).
export const ERR_SEC_ITEM_NOT_FOUND = -25300;
export const ERR_SEC_DUPLICATE_ITEM = -25299;
export const ERR_SEC_PARAM = -50;

export class KeychainStatusError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`Keychain status ${code}`);
    this.code = code;
  }
}

export interface Native {
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

export function readConstant(lib: ReturnType<typeof koffi.load>, name: string): unknown {
  return koffi.decode(lib.symbol(name, "void *"), "void *");
}

export function loadNative(): Native {
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
export class Arena {
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

export function buildDict(n: Native, pairs: ReadonlyArray<readonly [unknown, unknown]>): unknown {
  const keys = pairs.map((p) => p[0]);
  const values = pairs.map((p) => p[1]);
  return n.CFDictionaryCreate(null, keys, values, keys.length, null, null);
}

export function cfstr(n: Native, arena: Arena, s: string): unknown {
  return arena.own(n.CFStringCreateWithCString(null, s, CF_STRING_ENCODING_UTF8));
}

export function readGenericPasswordBytes(service: string, account: string, n: Native = loadNative()): Buffer {
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

export function storeGenericPasswordBytes(service: string, account: string, password: Buffer, n: Native = loadNative()): void {
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

export function deleteGenericPasswordEntry(service: string, account: string, n: Native = loadNative()): void {
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

/** Injectable Keychain boundary for the small credential wrappers below.
 * Production keeps the platform check and native implementation; tests can
 * provide an in-memory implementation without loading or touching Keychain. */
export interface ProviderKeychainDeps {
  readonly isMacOS: boolean;
  readPasswordBytes(service: string, account: string): Buffer;
  storePasswordBytes(service: string, account: string, password: Buffer): void;
  deletePasswordEntry(service: string, account: string): void;
  errorCode(error: unknown): number;
}

export function keychainErrorCode(error: unknown): number {
  return error instanceof KeychainStatusError ? error.code : -1;
}

export const nativeProviderKeychainDeps: ProviderKeychainDeps = {
  isMacOS: IS_MACOS,
  readPasswordBytes: readGenericPasswordBytes,
  storePasswordBytes: storeGenericPasswordBytes,
  deletePasswordEntry: deleteGenericPasswordEntry,
  errorCode: keychainErrorCode,
};

export function createProviderKeychainFfiForTests(native: Native): ProviderKeychainDeps {
  return {
    isMacOS: true,
    readPasswordBytes: (service, account) => readGenericPasswordBytes(service, account, native),
    storePasswordBytes: (service, account, password) => storeGenericPasswordBytes(service, account, password, native),
    deletePasswordEntry: (service, account) => deleteGenericPasswordEntry(service, account, native),
    errorCode: keychainErrorCode,
  };
}

/** `providers.rs::read_key`. `service` defaults to the real constant but is
 * overridable so a test never has to touch a real saved key. */
export function readKey(
  provider: string,
  service: string = KEYCHAIN_SERVICE,
  keychain: ProviderKeychainDeps = nativeProviderKeychainDeps,
): string {
  if (!keychain.isMacOS) {
    throw new Error("API-key storage currently requires macOS Keychain.");
  }
  let bytes: Buffer;
  try {
    bytes = keychain.readPasswordBytes(service, provider);
  } catch (e) {
    const code = keychain.errorCode(e);
    throw new Error(`No API key is saved for ${provider}. [code ${code}]`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The saved API key is not valid UTF-8.");
  }
}

/** `providers.rs::store_key`. */
export function storeKey(
  provider: string,
  key: string,
  service: string = KEYCHAIN_SERVICE,
  keychain: ProviderKeychainDeps = nativeProviderKeychainDeps,
): void {
  if (!keychain.isMacOS) {
    throw new Error("API-key storage currently requires macOS Keychain.");
  }
  try {
    keychain.storePasswordBytes(service, provider, Buffer.from(key, "utf8"));
  } catch (e) {
    const code = keychain.errorCode(e);
    throw new Error(`Could not save the API key in Keychain. [code ${code}]`);
  }
}

/** `providers.rs::delete_key` — a missing entry is success, same as the Rust
 * source's `errSecItemNotFound => Ok(())` arm; non-macOS is `Ok(())` there
 * too, since nothing was ever stored. */
export function deleteKey(
  provider: string,
  service: string = KEYCHAIN_SERVICE,
  keychain: ProviderKeychainDeps = nativeProviderKeychainDeps,
): void {
  if (!keychain.isMacOS) return;
  try {
    keychain.deletePasswordEntry(service, provider);
  } catch (e) {
    const code = keychain.errorCode(e);
    throw new Error(`Could not remove the API key. [code ${code}]`);
  }
}

export function storeDefaultProviderKey(
  provider: string,
  key: string,
  keychain: ProviderKeychainDeps = nativeProviderKeychainDeps,
): void {
  if (process.env.ARCELLE_E2E === "1") {
    e2eProviderKeys.set(provider, key);
    return;
  }
  storeKey(provider, key, KEYCHAIN_SERVICE, keychain);
  providerKeySessionCache.set(provider, { key });
}

export function deleteDefaultProviderKey(
  provider: string,
  keychain: ProviderKeychainDeps = nativeProviderKeychainDeps,
): void {
  if (process.env.ARCELLE_E2E === "1") {
    e2eProviderKeys.delete(provider);
    return;
  }
  deleteKey(provider, KEYCHAIN_SERVICE, keychain);
  providerKeySessionCache.delete(provider);
}

/** The real default {@link ProviderDeps}: the actual macOS Keychain and the
 * actual network. */
export const defaultProviderDeps: ProviderDeps = {
  readKey: (provider) => {
    if (process.env.ARCELLE_E2E === "1") {
      const key = e2eProviderKeys.get(provider);
      if (key === undefined) throw new Error(`No API key is saved for ${provider}. [code ${ERR_SEC_ITEM_NOT_FOUND}]`);
      return key;
    }
    return readProviderKeyOnce(provider, readKey);
  },
  storeKey: storeDefaultProviderKey,
  deleteKey: deleteDefaultProviderKey,
  fetchJson: realFetchJson,
};
