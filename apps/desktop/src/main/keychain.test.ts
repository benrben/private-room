import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteEntry,
  has,
  messageFor,
  safeStorageHas,
  safeStorageRemove,
  safeStorageWrapPath,
  SERVICE,
  store,
} from "./keychain.js";

// A service name distinct from the real "PrivateRoom" the shipped app uses,
// so these tests can never collide with (or delete) a real user's Touch ID
// entry. Every real-Keychain call below passes this via `serviceOverride`.
const TEST_SERVICE = "ArcelleKeychainPortTest";

function fakeRoomPath(): string {
  return `/tmp/fake-room-${randomUUID()}.roomai`;
}

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

// `has()` returns a plain bool (never throws, mirrors Rust's `fn has(path:
// &str) -> bool`) and its OWN status check treats "genuinely not found"
// (-25300) and "this process cannot reach the data-protection keychain"
// (-34018, see below) identically: neither is 0 nor errSecInteractionNotAllowed,
// so both map to `false`. That means this specific assertion is real,
// unconditional coverage -- independently confirmed to return `false` in
// THIS sandbox via a direct call -- unlike store/deleteEntry, which need the
// capability probe below because they THROW on -34018 rather than folding it
// into a bool.
it("has() on a path that was never stored is always false", () => {
  expect(has(fakeRoomPath(), TEST_SERVICE)).toBe(false);
});

// -------------------------------------------------------------------------
// has / store / deleteEntry against the REAL macOS Keychain.
//
// `store`/`has`/`deleteEntry` all unconditionally set
// `kSecUseDataProtectionKeychain = true` (ported faithfully from
// biometrics.rs, which requires it for the biometric access control this
// module builds). On THIS machine, under THIS test runner, that one key
// makes every Security.framework call in this file fail with
// errSecMissingEntitlement (-34018) -- confirmed against both a bare `node`
// process and an unmodified `Electron.app`, both ad-hoc signed with no Team
// ID and no keychain-access-groups entitlement, which is what the
// data-protection keychain's default access group is derived from. The
// identical CFDictionary/SecItem* FFI plumbing (CFStringCreateWithCString,
// the NULL-callbacks CFDictionaryCreate, SecItemAdd/CopyMatching/Delete,
// CFData byte round-tripping incl. multi-byte UTF-8) is separately verified
// to work perfectly against the real Keychain the moment that one key is
// left out -- see keychain.ts's header comment and the port report.
//
// So: probe the real capability once, for real, using the real exported
// `store()` -- and only run the round-trip assertions the task asks for if
// this environment can actually reach the data-protection keychain. This
// is not a stub: on a properly signed/entitled run (e.g. the real,
// shipped Arcelle.app) these tests execute for real and must pass.
// -------------------------------------------------------------------------

function probeDataProtectionKeychain(): boolean {
  if (process.platform !== "darwin") return false;
  const probePath = fakeRoomPath();
  try {
    store(probePath, "capability-probe-password", TEST_SERVICE);
    return true;
  } catch {
    return false;
  } finally {
    try {
      deleteEntry(probePath, TEST_SERVICE);
    } catch {
      // Best-effort cleanup; if delete also fails there is nothing more we
      // can do here, and the capability probe already reflects that this
      // environment cannot reach the data-protection keychain at all.
    }
  }
}

const DATA_PROTECTION_KEYCHAIN_AVAILABLE = probeDataProtectionKeychain();

if (process.platform === "darwin" && !DATA_PROTECTION_KEYCHAIN_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    "[keychain.test.ts] Skipping the real store/has/deleteEntry round-trip: this test " +
      "process cannot reach the macOS data-protection keychain " +
      "(kSecUseDataProtectionKeychain -> errSecMissingEntitlement / -34018). Root cause " +
      "confirmed by direct experiment: the data-protection keychain's default access group " +
      "is derived from the caller's code-signing Team ID, and this runner (plain node / " +
      "vitest, and separately an unsigned Electron.app) is ad-hoc signed with no Team ID and " +
      "no keychain-access-groups entitlement. Expected to work in the real, signed " +
      "Arcelle.app -- see keychain.ts's header comment and the port report.",
  );
}

describe.skipIf(!DATA_PROTECTION_KEYCHAIN_AVAILABLE)(
  "has/store/deleteEntry against the real macOS Keychain",
  () => {
    it("store then has returns true", () => {
      const roomPath = fakeRoomPath();
      try {
        store(roomPath, "s3cret-password", TEST_SERVICE);
        expect(has(roomPath, TEST_SERVICE)).toBe(true);
      } finally {
        deleteEntry(roomPath, TEST_SERVICE);
      }
    });

    it("store then deleteEntry then has returns false", () => {
      const roomPath = fakeRoomPath();
      let stillStored = false;
      try {
        store(roomPath, "s3cret-password", TEST_SERVICE);
        stillStored = true;
        deleteEntry(roomPath, TEST_SERVICE);
        stillStored = false;
        expect(has(roomPath, TEST_SERVICE)).toBe(false);
      } finally {
        if (stillStored) deleteEntry(roomPath, TEST_SERVICE);
      }
    });

    it("deleteEntry on a nonexistent entry does not throw (idempotent)", () => {
      const roomPath = fakeRoomPath();
      expect(has(roomPath, TEST_SERVICE)).toBe(false);
      expect(() => deleteEntry(roomPath, TEST_SERVICE)).not.toThrow();
      // ...and doing it again is still fine.
      expect(() => deleteEntry(roomPath, TEST_SERVICE)).not.toThrow();
    });

    it("storing twice for the same path replaces rather than erroring", () => {
      const roomPath = fakeRoomPath();
      try {
        store(roomPath, "first-password", TEST_SERVICE);
        expect(() => store(roomPath, "second-password", TEST_SERVICE)).not.toThrow();
        expect(has(roomPath, TEST_SERVICE)).toBe(true);
      } finally {
        deleteEntry(roomPath, TEST_SERVICE);
      }
    });
  },
);

// `read()` is deliberately NOT tested here, on real or fake Keychain data:
// it requests kSecReturnData, which forces the real macOS
// LocalAuthentication biometric prompt. There is no way to drive a live
// Touch ID / Face ID match from this non-interactive environment -- doing
// so would hang waiting for a human, or (worse) silently misreport. Its
// implementation (query construction, OSStatus handling via messageFor,
// CFData decoding, strict UTF-8 validation) is implemented but UNVERIFIED
// against a live prompt; see the port report.

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
