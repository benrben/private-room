import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  const data = { bytes: new Uint8Array([102, 97, 107, 101, 45, 112, 97, 115, 115, 119, 111, 114, 100]) };
  const CFRelease = vi.fn();
  const CFStringCreateWithCString = vi.fn((_allocator: unknown, text: string) => ({ text }));
  const CFDataCreate = vi.fn((_allocator: unknown, bytes: Uint8Array) => ({ bytes }));
  const CFDataGetLength = vi.fn((value: { bytes: Uint8Array }) => BigInt(value.bytes.length));
  const CFDataGetBytePtr = vi.fn((value: { bytes: Uint8Array }) => value.bytes);
  const CFDictionaryCreate = vi.fn((_allocator: unknown, keys: unknown[], values: unknown[]) => ({ keys, values }));
  const CFGetTypeID = vi.fn(() => 1n);
  const CFDataGetTypeID = vi.fn(() => 1n);
  const SecItemAdd = vi.fn((_query: unknown, result: unknown[]) => {
    result[0] = null;
    return 0;
  });
  const SecItemCopyMatching = vi.fn((_query: unknown, result: unknown[]) => {
    result[0] = data;
    return 0;
  });
  const SecItemDelete = vi.fn(() => 0);
  const SecItemUpdate = vi.fn(() => 0);
  const SecAccessControlCreateWithFlags = vi.fn(() => ({ access: true }));

  const core = {
    func: vi.fn((signature: string) => {
      if (signature.includes("CFRelease")) return CFRelease;
      if (signature.includes("CFStringCreateWithCString")) return CFStringCreateWithCString;
      if (signature.includes("CFDataCreate")) return CFDataCreate;
      if (signature.includes("CFDataGetLength")) return CFDataGetLength;
      if (signature.includes("CFDataGetBytePtr")) return CFDataGetBytePtr;
      if (signature.includes("CFDictionaryCreate")) return CFDictionaryCreate;
      if (signature.includes("CFGetTypeID")) return CFGetTypeID;
      if (signature.includes("CFDataGetTypeID")) return CFDataGetTypeID;
      throw new Error(`unexpected fabricated CoreFoundation symbol: ${signature}`);
    }),
    symbol: vi.fn((name: string) => `core:${name}`),
  };
  const security = {
    func: vi.fn((signature: string) => {
      if (signature.includes("SecItemAdd")) return SecItemAdd;
      if (signature.includes("SecItemCopyMatching")) return SecItemCopyMatching;
      if (signature.includes("SecItemDelete")) return SecItemDelete;
      if (signature.includes("SecItemUpdate")) return SecItemUpdate;
      if (signature.includes("SecAccessControlCreateWithFlags")) return SecAccessControlCreateWithFlags;
      throw new Error(`unexpected fabricated Security symbol: ${signature}`);
    }),
    symbol: vi.fn((name: string) => `security:${name}`),
  };
  const load = vi.fn((framework: string) => framework.includes("CoreFoundation") ? core : security);
  const decode = vi.fn((value: unknown) => value);
  return {
    CFDataCreate,
    CFDataGetBytePtr,
    CFDataGetLength,
    CFDataGetTypeID,
    CFDictionaryCreate,
    CFGetTypeID,
    CFRelease,
    CFStringCreateWithCString,
    SecAccessControlCreateWithFlags,
    SecItemAdd,
    SecItemCopyMatching,
    SecItemDelete,
    SecItemUpdate,
    core,
    data,
    decode,
    load,
    security,
  };
});

vi.mock("koffi", () => ({
  default: {
    array: vi.fn(() => "fabricated-uint8-array"),
    decode: fakes.decode,
    load: fakes.load,
  },
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

async function keychainFor(platform: "darwin" | "linux"): Promise<typeof import("./keychain.js")> {
  vi.resetModules();
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return await import("./keychain.js");
  } finally {
    if (platformDescriptor !== undefined) Object.defineProperty(process, "platform", platformDescriptor);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (platformDescriptor !== undefined) Object.defineProperty(process, "platform", platformDescriptor);
});

describe("Keychain platform guard and native wrappers", () => {
  it("refuses a fabricated non-macOS store before loading any native framework", async () => {
    const keychain = await keychainFor("linux");

    expect(() => keychain.store("/fabricated/room.roomai", "fabricated-password")).toThrow(
      "Touch ID is only available on macOS.",
    );
    expect(fakes.load).not.toHaveBeenCalled();
  });

  it("stores through the fabricated native wrapper after the macOS guard", async () => {
    const keychain = await keychainFor("darwin");

    keychain.store("/fabricated/room.roomai", "fabricated-password", "fabricated-service");

    expect(fakes.SecItemDelete).toHaveBeenCalledOnce();
    expect(fakes.SecItemAdd).toHaveBeenCalledOnce();
    expect(fakes.CFStringCreateWithCString).toHaveBeenCalledWith(null, "fabricated-service", expect.any(Number));
    expect(fakes.load).toHaveBeenCalledTimes(2);
  });

  it("continues with the default fabricated service when replacing the old entry fails", async () => {
    const keychain = await keychainFor("darwin");
    fakes.SecItemDelete.mockReturnValueOnce(-25293);

    keychain.store("/fabricated/room.roomai", "fabricated-password");

    expect(fakes.SecItemAdd).toHaveBeenCalledOnce();
    expect(fakes.CFStringCreateWithCString).toHaveBeenCalledWith(null, "PrivateRoom", expect.any(Number));
  });

  it("reads fabricated CFData through the macOS wrapper without a system prompt", async () => {
    const keychain = await keychainFor("darwin");

    expect(keychain.read("/fabricated/room.roomai", "fabricated-service")).toBe("fake-password");

    expect(fakes.SecItemCopyMatching).toHaveBeenCalledOnce();
    expect(fakes.CFRelease).toHaveBeenCalledWith(fakes.data);
    expect(fakes.load).toHaveBeenCalledTimes(2);
  });

  it("reads fabricated CFData with the default service", async () => {
    const keychain = await keychainFor("darwin");

    expect(keychain.read("/fabricated/default-service.roomai")).toBe("fake-password");

    expect(fakes.CFStringCreateWithCString).toHaveBeenCalledWith(null, "PrivateRoom", expect.any(Number));
  });
});
