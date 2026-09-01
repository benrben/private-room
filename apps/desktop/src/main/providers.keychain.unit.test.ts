import { describe, expect, it, vi } from "vitest";
import {
  createProviderKeychainFfiForTests,
  deleteDefaultProviderKey,
  deleteKey,
  readKey,
  storeDefaultProviderKey,
  storeKey,
  type ProviderKeychainDeps,
} from "./providers.js";

function keychainFake(overrides: Partial<ProviderKeychainDeps> = {}) {
  const readPasswordBytes = vi.fn<(service: string, account: string) => Buffer>();
  const storePasswordBytes = vi.fn<(service: string, account: string, password: Buffer) => void>();
  const deletePasswordEntry = vi.fn<(service: string, account: string) => void>();
  const errorCode = vi.fn<(error: unknown) => number>(() => -1);
  const deps: ProviderKeychainDeps = {
    isMacOS: true,
    readPasswordBytes,
    storePasswordBytes,
    deletePasswordEntry,
    errorCode,
    ...overrides,
  };
  return { deps, readPasswordBytes, storePasswordBytes, deletePasswordEntry, errorCode };
}

describe("provider Keychain wrappers with fabricated storage", () => {
  it("reads UTF-8 bytes through the supplied Keychain boundary", () => {
    const fake = keychainFake();
    fake.readPasswordBytes.mockReturnValue(Buffer.from("sk-\ud83d\udd25-\u05e7\u05d5\u05d3", "utf8"));

    expect(readKey("test-provider", "fake-keychain-service", fake.deps)).toBe("sk-\ud83d\udd25-\u05e7\u05d5\u05d3");
    expect(fake.readPasswordBytes).toHaveBeenCalledWith("fake-keychain-service", "test-provider");
  });

  it("keeps an empty saved key as an empty string", () => {
    const fake = keychainFake();
    fake.readPasswordBytes.mockReturnValue(Buffer.alloc(0));

    expect(readKey("test-provider", "fake-keychain-service", fake.deps)).toBe("");
  });

  it("reports malformed bytes and fake Keychain errors without leaking their implementation", () => {
    const malformed = keychainFake();
    malformed.readPasswordBytes.mockReturnValue(Buffer.from([0xc3, 0x28]));
    expect(() => readKey("test-provider", "fake-keychain-service", malformed.deps))
      .toThrow("The saved API key is not valid UTF-8.");

    const unavailable = keychainFake();
    unavailable.readPasswordBytes.mockImplementation(() => {
      throw new Error("fabricated Keychain unavailable");
    });
    unavailable.errorCode.mockReturnValue(-25300);
    expect(() => readKey("test-provider", "fake-keychain-service", unavailable.deps))
      .toThrow("No API key is saved for test-provider. [code -25300]");
  });

  it("stores the exact UTF-8 bytes through the supplied Keychain boundary", () => {
    const fake = keychainFake();

    storeKey("test-provider", "sk-\ud83d\udd25-\u05e7\u05d5\u05d3", "fake-keychain-service", fake.deps);

    expect(fake.storePasswordBytes).toHaveBeenCalledWith(
      "fake-keychain-service",
      "test-provider",
      Buffer.from("sk-\ud83d\udd25-\u05e7\u05d5\u05d3", "utf8"),
    );
  });

  it("rejects non-macOS calls without asking the fabricated Keychain", () => {
    const fake = keychainFake({ isMacOS: false });

    expect(() => readKey("test-provider", "fake-keychain-service", fake.deps))
      .toThrow("API-key storage currently requires macOS Keychain.");
    expect(() => storeKey("test-provider", "test-key", "fake-keychain-service", fake.deps))
      .toThrow("API-key storage currently requires macOS Keychain.");
    expect(fake.readPasswordBytes).not.toHaveBeenCalled();
    expect(fake.storePasswordBytes).not.toHaveBeenCalled();
  });

  it("wraps a fake write failure with the stable save error", () => {
    const fake = keychainFake();
    fake.storePasswordBytes.mockImplementation(() => {
      throw new Error("fabricated Keychain unavailable");
    });
    fake.errorCode.mockReturnValue(-25299);

    expect(() => storeKey("test-provider", "test-key", "fake-keychain-service", fake.deps))
      .toThrow("Could not save the API key in Keychain. [code -25299]");
  });

  it("deletes through the supplied boundary and reports its stable error code", () => {
    const success = keychainFake();
    deleteKey("test-provider", "fake-keychain-service", success.deps);
    expect(success.deletePasswordEntry).toHaveBeenCalledWith("fake-keychain-service", "test-provider");

    const failure = keychainFake();
    failure.deletePasswordEntry.mockImplementation(() => {
      throw new Error("fabricated delete failure");
    });
    failure.errorCode.mockReturnValue(-25293);
    expect(() => deleteKey("test-provider", "fake-keychain-service", failure.deps))
      .toThrow("Could not remove the API key. [code -25293]");
  });

  it("drives the non-E2E default wrappers through a fabricated Keychain", () => {
    const previous = process.env.ARCELLE_E2E;
    delete process.env.ARCELLE_E2E;
    const fake = keychainFake();
    try {
      storeDefaultProviderKey("test-provider", "test-key", fake.deps);
      deleteDefaultProviderKey("test-provider", fake.deps);
    } finally {
      if (previous === undefined) delete process.env.ARCELLE_E2E;
      else process.env.ARCELLE_E2E = previous;
    }
    expect(fake.storePasswordBytes).toHaveBeenCalledWith(
      "Arcelle LLM Providers",
      "test-provider",
      Buffer.from("test-key"),
    );
    expect(fake.deletePasswordEntry).toHaveBeenCalledWith("Arcelle LLM Providers", "test-provider");
  });
});

function nativeHarness(options: { copyType?: bigint; addStatus?: number; deleteStatus?: number } = {}) {
  const released: unknown[] = [];
  const dataRef = { kind: "fabricated-data" };
  const native = {
    CFDataCreate: vi.fn(() => dataRef),
    CFDataGetBytePtr: vi.fn(() => Buffer.alloc(0)),
    CFDataGetLength: vi.fn(() => 0n),
    CFDataGetTypeID: vi.fn(() => 1n),
    CFDictionaryCreate: vi.fn(() => ({ kind: "dictionary" })),
    CFGetTypeID: vi.fn(() => options.copyType ?? 1n),
    CFRelease: vi.fn((value: unknown) => released.push(value)),
    CFStringCreateWithCString: vi.fn((_allocator: unknown, text: string) => ({ kind: "string", text })),
    SecItemAdd: vi.fn(() => options.addStatus ?? 0),
    SecItemCopyMatching: vi.fn((_query: unknown, result: unknown[]) => {
      result[0] = dataRef;
      return 0;
    }),
    SecItemDelete: vi.fn(() => options.deleteStatus ?? 0),
    SecItemUpdate: vi.fn(() => 0),
    kSecClass: "class",
    kSecClassGenericPassword: "generic-password",
    kSecAttrService: "service",
    kSecAttrAccount: "account",
    kSecValueData: "value-data",
    kSecReturnData: "return-data",
    kCFBooleanTrue: true,
  };
  return { deps: createProviderKeychainFfiForTests(native as never), native, released, dataRef };
}

describe("provider native Keychain adapter with fabricated CoreFoundation values", () => {
  it("rejects a non-data copy result after releasing it", () => {
    const harness = nativeHarness({ copyType: 2n });
    expect(() => harness.deps.readPasswordBytes("service", "account")).toThrow();
    expect(harness.released).toContain(harness.dataRef);
  });

  it("surfaces native add and delete failures with their exact status", () => {
    const add = nativeHarness({ addStatus: -50 });
    expect(() => add.deps.storePasswordBytes("service", "account", Buffer.from("secret"))).toThrow();
    expect(add.deps.errorCode(catchError(() => add.deps.storePasswordBytes("service", "account", Buffer.from("secret")))))
      .toBe(-50);

    const remove = nativeHarness({ deleteStatus: -25293 });
    const error = catchError(() => remove.deps.deletePasswordEntry("service", "account"));
    expect(remove.deps.errorCode(error)).toBe(-25293);
  });
});

function catchError(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected fabricated operation to throw");
}
