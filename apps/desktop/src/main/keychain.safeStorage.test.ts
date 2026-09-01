import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRequire: vi.fn(),
  decryptString: vi.fn(),
  electronRequire: vi.fn(),
  encryptString: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("koffi", () => ({ default: {} }));
vi.mock("node:module", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:module")>()),
  createRequire: mocks.createRequire,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
}));

import {
  safeStorageRead,
  safeStorageStore,
  safeStorageWrapPath,
} from "./keychain.js";

const USER_DATA_DIR = "/fabricated/user-data";
const ROOM_PATH = "/fabricated/room with spaces.roomai";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createRequire.mockReturnValue(mocks.electronRequire);
  mocks.electronRequire.mockReturnValue({
    safeStorage: {
      decryptString: mocks.decryptString,
      encryptString: mocks.encryptString,
    },
  });
  mocks.encryptString.mockReturnValue(Buffer.from("fabricated-encrypted-password"));
  mocks.decryptString.mockReturnValue("fabricated password");
  mocks.existsSync.mockReturnValue(true);
});

describe("safeStorage fallback", () => {
  it("encrypts a fabricated password before writing its deterministic wrap file", () => {
    const wrapPath = safeStorageWrapPath(USER_DATA_DIR, ROOM_PATH);

    safeStorageStore(USER_DATA_DIR, ROOM_PATH, "fabricated password");

    expect(mocks.electronRequire).toHaveBeenCalledWith("electron");
    expect(mocks.mkdirSync).toHaveBeenCalledWith("/fabricated/user-data/unlock", { recursive: true });
    expect(mocks.encryptString).toHaveBeenCalledWith("fabricated password");
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      wrapPath,
      Buffer.from("fabricated-encrypted-password"),
    );
  });

  it("decrypts fabricated stored bytes after the wrap file exists", () => {
    const wrapPath = safeStorageWrapPath(USER_DATA_DIR, ROOM_PATH);
    const encrypted = Buffer.from("fabricated-stored-bytes");
    mocks.readFileSync.mockReturnValue(encrypted);

    expect(safeStorageRead(USER_DATA_DIR, ROOM_PATH)).toBe("fabricated password");

    expect(mocks.existsSync).toHaveBeenCalledWith(wrapPath);
    expect(mocks.readFileSync).toHaveBeenCalledWith(wrapPath);
    expect(mocks.decryptString).toHaveBeenCalledWith(encrypted);
  });

  it("refuses a missing fabricated wrap file before reading or decrypting it", () => {
    const wrapPath = safeStorageWrapPath(USER_DATA_DIR, ROOM_PATH);
    mocks.existsSync.mockReturnValue(false);

    expect(() => safeStorageRead(USER_DATA_DIR, ROOM_PATH)).toThrow(
      `No safeStorage entry for this room at ${wrapPath}.`,
    );
    expect(mocks.readFileSync).not.toHaveBeenCalled();
    expect(mocks.decryptString).not.toHaveBeenCalled();
  });

  it("refuses a fabricated Electron module without safeStorage before filesystem work", () => {
    mocks.electronRequire.mockReturnValue({});

    expect(() => safeStorageStore(USER_DATA_DIR, ROOM_PATH, "fabricated password")).toThrow(
      "safeStorage is only available inside a running Electron app.",
    );
    expect(mocks.mkdirSync).not.toHaveBeenCalled();
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
  });
});
