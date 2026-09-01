import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  messageFor,
  safeStorageHas,
  safeStorageRemove,
  safeStorageWrapPath,
  SERVICE,
} from "./keychain.js";

// -------------------------------------------------------------------------
// messageFor — pure, fully portable, no FFI. Ports biometrics.rs's
// `each_branch_says_what_happened` and
// `an_unavailable_keychain_still_offers_the_password` tests exactly.
// -------------------------------------------------------------------------

describe("messageFor", () => {
  it("each_branch_says_what_happened", () => {
    const ERR_SEC_USER_CANCELED = -128;
    const ERR_SEC_ITEM_NOT_FOUND = -25300;

    expect(messageFor(ERR_SEC_USER_CANCELED)).toBe("Touch ID was cancelled.");
    expect(messageFor(-25293)).toBe("Touch ID did not match.");
    expect(messageFor(ERR_SEC_ITEM_NOT_FOUND)).toBe("No Touch ID entry for this room.");
    expect(messageFor(-34018)).toContain("isn't available on this Mac");
    expect(messageFor(-9999)).toContain("[code -9999]");
  });

  // "Touch ID is unavailable" reads as "the room is gone" unless the
  // message names the way back in, and the way back in is the password.
  // Cancel, no-match and no-entry are excluded: those say Touch ID itself
  // refused or was never set up, with the password field still on screen
  // underneath.
  it("an_unavailable_keychain_still_offers_the_password", () => {
    for (const code of [-34018, -25308, -1, 0, 12345]) {
      const msg = messageFor(code);
      expect(msg, `message for ${code} leaves the user no way in: ${msg}`).toContain("password");
    }
  });
});

describe("SERVICE", () => {
  it("is the literal service name the real (shipped) app uses", () => {
    // Not TEST_SERVICE -- this constant IS the real default, which is
    // exactly why every test below passes serviceOverride and never calls
    // an exported function with this value.
    expect(SERVICE).toBe("PrivateRoom");
  });
});

// -------------------------------------------------------------------------
// safeStorage fallback (Part E) -- the pure filesystem helpers only.
//
// `safeStorageWrapPath` (pure) and `safeStorageHas`/`safeStorageRemove`
// (plain fs.existsSync/fs.rmSync, no Electron API touched) are real,
// portable, and tested for real below.
//
// `safeStorageStore` and `safeStorageRead` are NOT tested anywhere in this
// file: both call into `safeStorage`, which requires a running, ready
// Electron app (`app.isReady()`) and cannot be exercised from this plain
// Node/vitest process. Calling them here would only prove that our own
// "not inside Electron" guard throws -- not that the real encrypt/decrypt
// round-trip works. See keychain.ts's header comment on this section for
// why the lazy `createRequire`-based access is structured the way it is.
// -------------------------------------------------------------------------

describe("safeStorageWrapPath", () => {
  it("is deterministic for the same userDataDir and room path", () => {
    const dir = "/tmp/fake-userdata";
    const roomPath = "/Users/x/rooms/one.roomai";
    expect(safeStorageWrapPath(dir, roomPath)).toBe(safeStorageWrapPath(dir, roomPath));
  });

  it("differs for different room paths", () => {
    const dir = "/tmp/fake-userdata";
    expect(safeStorageWrapPath(dir, "/rooms/a.roomai")).not.toBe(safeStorageWrapPath(dir, "/rooms/b.roomai"));
  });

  it("produces a filesystem-safe .bin path under userDataDir/unlock/, even for an unfriendly room path", () => {
    const dir = "/tmp/fake-userdata";
    const wrapPath = safeStorageWrapPath(dir, "/Users/x/room with spaces & emoji 🔥.roomai");
    expect(wrapPath.startsWith(join(dir, "unlock") + "/")).toBe(true);
    expect(wrapPath.endsWith(".bin")).toBe(true);
    expect(/^[a-z0-9/_.-]+$/i.test(wrapPath)).toBe(true);
  });
});

describe("safeStorageHas / safeStorageRemove", () => {
  it("safeStorageHas is false and safeStorageRemove does not throw when nothing was ever stored", () => {
    const dir = mkdtempSync(join(tmpdir(), "keychain-safe-storage-"));
    try {
      const roomPath = "/Users/x/room-never-stored.roomai";
      expect(safeStorageHas(dir, roomPath)).toBe(false);
      expect(() => safeStorageRemove(dir, roomPath)).not.toThrow();
      expect(safeStorageHas(dir, roomPath)).toBe(false);
      // ...and removing it again is still fine (idempotent).
      expect(() => safeStorageRemove(dir, roomPath)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
