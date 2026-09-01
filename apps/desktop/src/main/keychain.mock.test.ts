import { beforeEach, describe, expect, it, vi } from "vitest";

const koffiMock = vi.hoisted(() => ({
  array: vi.fn(() => "uint8-array"),
  decode: vi.fn(),
}));

vi.mock("koffi", () => ({ default: koffiMock }));

import { createKeychainFfiForTests, deleteEntry, type Native } from "./keychain.js";

type FakeData = { kind: "data"; bytes: Uint8Array };
type Dictionary = { keys: unknown[]; values: unknown[] };

interface NativeOptions {
  access?: unknown;
  addResult?: unknown;
  addStatus?: number;
  copyResult?: unknown;
  copyStatus?: number;
  dataTypeId?: bigint;
  deleteStatus?: number;
  updateStatus?: number;
}

interface NativeHarness {
  dictionaries: Dictionary[];
  native: Native;
  released: unknown[];
}

function nativeHarness(options: NativeOptions = {}): NativeHarness {
  const dictionaries: Dictionary[] = [];
  const released: unknown[] = [];
  const native: Native = {
    CFRelease: (value) => {
      released.push(value);
    },
    CFStringCreateWithCString: (_allocator, text) => ({ kind: "string", text }),
    CFDataCreate: (_allocator, bytes, length) => ({ kind: "data", bytes: bytes.slice(0, length) }),
    CFDataGetLength: (value) => BigInt((value as FakeData).bytes.length),
    CFDataGetBytePtr: (value) => (value as FakeData).bytes,
    CFDictionaryCreate: (_allocator, keys, values) => {
      const dictionary = { keys, values };
      dictionaries.push(dictionary);
      return dictionary;
    },
    CFGetTypeID: () => options.dataTypeId ?? 1n,
    CFDataGetTypeID: () => 1n,
    SecItemAdd: (_query, result) => {
      result[0] = options.addResult ?? null;
      return options.addStatus ?? 0;
    },
    SecItemCopyMatching: (_query, result) => {
      result[0] = options.copyResult ?? null;
      return options.copyStatus ?? -25300;
    },
    SecItemDelete: () => options.deleteStatus ?? 0,
    SecItemUpdate: () => options.updateStatus ?? 0,
    SecAccessControlCreateWithFlags: () => options.access === undefined ? { kind: "access" } : options.access,
    kSecClass: "class",
    kSecClassGenericPassword: "generic-password",
    kSecAttrService: "service",
    kSecAttrAccount: "account",
    kSecValueData: "password-data",
    kSecReturnData: "return-data",
    kSecReturnAttributes: "return-attributes",
    kSecUseDataProtectionKeychain: "data-protection",
    kSecUseAuthenticationUI: "authentication-ui",
    kSecUseAuthenticationUISkip: "skip-authentication-ui",
    kSecAttrAccessControl: "access-control",
    kSecAttrLabel: "label",
    kSecAttrAccessibleWhenUnlockedThisDeviceOnly: "device-only",
    kCFBooleanTrue: true,
  };
  return { dictionaries, native, released };
}

describe("mocked keychain FFI operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates a duplicate password and releases the Security result and created references", () => {
    const addResult = { kind: "add-result" };
    const harness = nativeHarness({ addResult, addStatus: -25299 });

    createKeychainFfiForTests(harness.native).store("/rooms/one.roomai", "pässword", "test-service");

    expect(harness.released).toContain(addResult);
    expect(harness.dictionaries).toHaveLength(3);
    expect(harness.released).toHaveLength(9);
  });

  it("surfaces a non-duplicate add error after releasing the returned Security value", () => {
    const addResult = { kind: "add-result" };
    const harness = nativeHarness({ addResult, addStatus: -34018 });

    expect(() => createKeychainFfiForTests(harness.native).store("/rooms/one.roomai", "password")).toThrow(
      "Touch ID isn't available on this Mac right now. You can still unlock with your password.",
    );
    expect(harness.released).toContain(addResult);
  });

  it("preserves the access-control creation error without issuing a keychain write", () => {
    const harness = nativeHarness({ access: null });

    expect(() => createKeychainFfiForTests(harness.native).store("/rooms/one.roomai", "password")).toThrow(
      "Could not create biometric access control (-50).",
    );
    expect(harness.dictionaries).toHaveLength(0);
    expect(harness.released).toHaveLength(0);
  });

  it("decodes a UTF-8 secret and releases its returned CFData", () => {
    const data: FakeData = { kind: "data", bytes: Buffer.from("pässword", "utf8") };
    const harness = nativeHarness({ copyResult: data, copyStatus: 0 });
    koffiMock.decode.mockReturnValue(data.bytes);

    expect(createKeychainFfiForTests(harness.native).read("/rooms/one.roomai", "test-service")).toBe("pässword");

    expect(koffiMock.array).toHaveBeenCalledWith("uint8_t", data.bytes.length);
    expect(harness.released).toContain(data);
  });

  it("releases a non-CFData result before surfacing the parameter error", () => {
    const wrongType = { kind: "attributes" };
    const harness = nativeHarness({ copyResult: wrongType, copyStatus: 0, dataTypeId: 2n });

    expect(() => createKeychainFfiForTests(harness.native).read("/rooms/one.roomai")).toThrow(
      "Touch ID isn't available right now. You can still unlock with your password. [code -50]",
    );
    expect(harness.released).toContain(wrongType);
  });

  it("rejects invalid UTF-8 bytes and still releases the returned CFData", () => {
    const data: FakeData = { kind: "data", bytes: Uint8Array.of(0xff, 0xfe) };
    const harness = nativeHarness({ copyResult: data, copyStatus: 0 });
    koffiMock.decode.mockReturnValue(data.bytes);

    expect(() => createKeychainFfiForTests(harness.native).read("/rooms/one.roomai")).toThrow(
      "Stored secret was not valid UTF-8.",
    );
    expect(harness.released).toContain(data);
  });

  it("maps a cancelled prompt status without attempting to decode a result", () => {
    const harness = nativeHarness({ copyStatus: -128 });

    expect(() => createKeychainFfiForTests(harness.native).read("/rooms/one.roomai")).toThrow(
      "Touch ID was cancelled.",
    );
    expect(koffiMock.decode).not.toHaveBeenCalled();
  });

  it("deletes the matching data-protection entry through an injected native seam", () => {
    const harness = nativeHarness();
    const loadNative = vi.fn(() => harness.native);

    deleteEntry("/rooms/one.roomai", "test-service", { isMacOS: () => true, loadNative });

    expect(loadNative).toHaveBeenCalledOnce();
    expect(harness.dictionaries).toHaveLength(1);
    expect(harness.dictionaries[0]).toEqual({
      keys: ["class", "service", "account", "data-protection"],
      values: [
        "generic-password",
        { kind: "string", text: "test-service" },
        { kind: "string", text: "/rooms/one.roomai" },
        true,
      ],
    });
    expect(harness.released).toHaveLength(3);
  });

  it("treats a missing entry as deleted, surfaces other statuses, and skips non-macOS", () => {
    const missing = nativeHarness({ deleteStatus: -25300 });
    expect(() =>
      deleteEntry("/rooms/missing.roomai", undefined, { isMacOS: () => true, loadNative: () => missing.native }),
    ).not.toThrow();

    const failed = nativeHarness({ deleteStatus: -25293 });
    expect(() =>
      deleteEntry("/rooms/locked.roomai", undefined, { isMacOS: () => true, loadNative: () => failed.native }),
    ).toThrow("Touch ID did not match.");
    expect(failed.released).toHaveLength(3);

    const loadNative = vi.fn(() => nativeHarness().native);
    deleteEntry("/rooms/not-mac.roomai", undefined, { isMacOS: () => false, loadNative });
    expect(loadNative).not.toHaveBeenCalled();
  });
});
