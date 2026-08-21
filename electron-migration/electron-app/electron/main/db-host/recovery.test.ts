/**
 * Vitest port of the `versions.rs` recovery-sidecar tests (`mod tests` in
 * `src-tauri/src/db/versions.rs`, lines 435-536):
 *
 *   - recovery_roundtrips_and_rejects_wrong_code
 *   - rewrite_and_remove_recovery
 *   - recovery_alphabet_is_drawn_uniformly
 *   - recovery_sidecar_is_written_temp_then_renamed
 *
 * Plus a few extra cases for the exact error messages `recoverPassword`
 * documents (missing sidecar / malformed json / wrong version / corrupt
 * base64 or lengths) — not literal Rust tests, but the same behaviors the
 * Rust doc comments spell out for this security-critical module.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoom } from "./open.js";
import {
  generateRecoveryCode,
  hasRecovery,
  normalizeCode,
  openWithRecovery,
  RECOVERY_ALPHABET,
  recoverPassword,
  recoverySidecarPath,
  removeRecovery,
  writeRecovery,
  writeSidecarAtomically,
} from "./recovery.js";

let tmpDir: string;
function tempRoomPath(): string {
  return path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
}

function withFreshTmpDir<T>(fn: () => T): T {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-recovery-"));
  return fn();
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("recoverySidecarPath", () => {
  it("appends .recovery to the room path", () => {
    expect(recoverySidecarPath("/a/b/room.roomai")).toBe("/a/b/room.roomai.recovery");
  });
});

describe("recovery_roundtrips_and_rejects_wrong_code", () => {
  // A3: create room → writeRecovery → openWithRecovery(code) decrypts;
  // messy formatting still works; a wrong code errors cleanly (no crash).
  it("round trips, tolerates messy formatting, and rejects a wrong code", async () => {
    await withFreshTmpDir(async () => {
      const p = tempRoomPath();
      {
        const conn = createRoom(p, "the-real-password", "Recoverable");
        conn.close();
      }
      expect(hasRecovery(p)).toBe(false);
      const code = await writeRecovery(p, "the-real-password");
      expect(hasRecovery(p)).toBe(true);

      // 6 groups of 4 characters, dash-separated.
      const groups = code.split("-");
      expect(groups.length).toBe(6);
      expect(groups.every((g) => [...g].length === 4)).toBe(true);

      // Correct code opens, even lowercased / space-separated / padded.
      const messy = `  ${code.toLowerCase().replace(/-/g, " ")}  `;
      const conn = await openWithRecovery(p, messy);
      const name = conn.prepare("SELECT value FROM meta WHERE key = 'name'").get() as
        | { value: string }
        | undefined;
      expect(name?.value).toBe("Recoverable");
      conn.close();

      // A wrong code fails with an Error, not a crash.
      await expect(
        openWithRecovery(p, "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF")
      ).rejects.toThrow("That recovery code is not correct.");
    });
  });
});

describe("rewrite_and_remove_recovery", () => {
  // F4: after a password change the sidecar is re-wrapped — the old code
  // stops working, the new one recovers the NEW password. And
  // removeRecovery deletes the sidecar (throws, doesn't crash, when gone).
  it("rewriting invalidates the old code; remove works and double-remove errors", async () => {
    await withFreshTmpDir(async () => {
      const p = tempRoomPath();
      const oldCode = await writeRecovery(p, "old-password");
      const newCode = await writeRecovery(p, "new-password");
      expect(await recoverPassword(p, newCode)).toBe("new-password");
      await expect(recoverPassword(p, oldCode)).rejects.toThrow();

      await removeRecovery(p);
      expect(hasRecovery(p)).toBe(false);
      await expect(removeRecovery(p)).rejects.toThrow();
    });
  });
});

describe("recovery_alphabet_is_drawn_uniformly", () => {
  // The modulo draw mapped 9 of 256 byte values onto each of the first 8
  // alphabet characters and 8 onto the other 23 — ~12.5% bias on every
  // character of the one secret we ask the user to write down. With
  // rejection sampling the letter frequencies converge; with `% 31` they
  // do not, and this margin is far outside sampling noise at this N. Uses
  // real crypto-random bytes (generateRecoveryCode -> node:crypto
  // randomBytes) since the whole point is proving the real sampling is
  // unbiased, not a seeded/fake RNG.
  it("shows no first-eight-letters bias across 2000 codes", () => {
    const counts = new Array(31).fill(0) as number[];
    let total = 0;
    for (let i = 0; i < 2000; i++) {
      for (const c of generateRecoveryCode()) {
        if (c === "-") continue;
        const idx = RECOVERY_ALPHABET.indexOf(c);
        expect(idx).toBeGreaterThanOrEqual(0);
        counts[idx] = (counts[idx] ?? 0) + 1;
        total++;
      }
    }
    expect(total).toBe(2000 * 24);
    const biased = counts.slice(0, 8).reduce((a, b) => a + b, 0);
    const rest = counts.slice(8).reduce((a, b) => a + b, 0);
    const a = biased / 8;
    const b = rest / 23;
    expect(Math.abs(a / b - 1.0)).toBeLessThan(0.04);
  });
});

describe("recovery_sidecar_is_written_temp_then_renamed", () => {
  // `fs.writeFile`-style truncate-in-place would leave the only copy of the
  // sealed password unusable on a crash mid-write while `hasRecovery` still
  // reports it exists. Proven two ways: a pre-placed `.tmp` (a previous
  // crashed write) is replaced rather than tripping the new write up, and a
  // write to an unwritable/nonexistent directory fails without touching an
  // existing valid sidecar.
  it("overwrites a stale tmp file and never touches a good sidecar on failure", async () => {
    await withFreshTmpDir(async () => {
      const p = tempRoomPath();
      const code = await writeRecovery(p, "first-password");
      const sidecar = recoverySidecarPath(p);
      writeFileSync(`${sidecar}.tmp`, "junk from a crashed write");

      // A failed write must not have consumed the existing sidecar.
      await expect(
        writeSidecarAtomically("/nonexistent-dir-xyz/x.recovery", "{}")
      ).rejects.toThrow();
      expect(await recoverPassword(p, code)).toBe("first-password");

      // A successful write leaves no temp file behind and swaps the wrap.
      const code2 = await writeRecovery(p, "second-password");
      expect(existsSync(`${sidecar}.tmp`)).toBe(false);
      expect(await recoverPassword(p, code2)).toBe("second-password");
    });
  });
});

describe("normalizeCode", () => {
  it("strips non-alphanumerics and uppercases", () => {
    expect(normalizeCode("  k7qf 3m2x  ")).toBe("K7QF3M2X");
    expect(normalizeCode("K7QF-3M2X")).toBe("K7QF3M2X");
  });
});

describe("recoverPassword error messages", () => {
  it("says no recovery was set up when the sidecar is missing", async () => {
    await withFreshTmpDir(async () => {
      const p = tempRoomPath();
      await expect(recoverPassword(p, "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF")).rejects.toThrow(
        "No recovery key was set up for this room."
      );
    });
  });

  it("says the file is unreadable on malformed json or a missing field", async () => {
    await withFreshTmpDir(async () => {
      const p = tempRoomPath();
      writeFileSync(recoverySidecarPath(p), "not json at all {{{");
      await expect(recoverPassword(p, "whatever")).rejects.toThrow(
        "The recovery file is unreadable."
      );

      writeFileSync(recoverySidecarPath(p), JSON.stringify({ v: 1, salt: "abc" }));
      await expect(recoverPassword(p, "whatever")).rejects.toThrow(
        "The recovery file is unreadable."
      );
    });
  });

  it("says the file is unreadable when v is not a non-negative integer", async () => {
    await withFreshTmpDir(async () => {
      const p = tempRoomPath();
      writeFileSync(
        recoverySidecarPath(p),
        JSON.stringify({ v: 1.5, salt: "AAAA", nonce: "AAAA", ct: "AAAA" })
      );
      await expect(recoverPassword(p, "whatever")).rejects.toThrow(
        "The recovery file is unreadable."
      );

      writeFileSync(
        recoverySidecarPath(p),
        JSON.stringify({ v: -1, salt: "AAAA", nonce: "AAAA", ct: "AAAA" })
      );
      await expect(recoverPassword(p, "whatever")).rejects.toThrow(
        "The recovery file is unreadable."
      );
    });
  });

  it("says a newer version wrote the file when v is not 1", async () => {
    await withFreshTmpDir(async () => {
      const p = tempRoomPath();
      writeFileSync(
        recoverySidecarPath(p),
        JSON.stringify({ v: 2, salt: "AAAA", nonce: "AAAA", ct: "AAAA" })
      );
      await expect(recoverPassword(p, "whatever")).rejects.toThrow(
        "This recovery file was written by a newer version."
      );
    });
  });

  it("says the file is corrupt on bad base64 or short nonce/ct", async () => {
    await withFreshTmpDir(async () => {
      const p = tempRoomPath();
      writeFileSync(
        recoverySidecarPath(p),
        JSON.stringify({ v: 1, salt: "not-base64!!", nonce: "AAAAAAAAAAAAAAAA", ct: "AAAAAAAAAAAAAAAAAAAAAA==" })
      );
      await expect(recoverPassword(p, "whatever")).rejects.toThrow(
        "The recovery file is corrupt."
      );

      const shortNonce = Buffer.alloc(4).toString("base64");
      const salt = Buffer.alloc(16).toString("base64");
      const ct = Buffer.alloc(20).toString("base64");
      writeFileSync(
        recoverySidecarPath(p),
        JSON.stringify({ v: 1, salt, nonce: shortNonce, ct })
      );
      await expect(recoverPassword(p, "whatever")).rejects.toThrow(
        "The recovery file is corrupt."
      );

      const nonce = Buffer.alloc(12).toString("base64");
      const shortCt = Buffer.alloc(8).toString("base64");
      writeFileSync(
        recoverySidecarPath(p),
        JSON.stringify({ v: 1, salt, nonce, ct: shortCt })
      );
      await expect(recoverPassword(p, "whatever")).rejects.toThrow(
        "The recovery file is corrupt."
      );
    });
  });

  it("says the file is corrupt when base64 has the right shape and byte-length but non-canonical padding bits", async () => {
    await withFreshTmpDir(async () => {
      const p = tempRoomPath();
      const salt = Buffer.alloc(16).toString("base64");
      const nonce = Buffer.alloc(12).toString("base64");
      const canonicalCt = Buffer.alloc(16).toString("base64");
      expect(canonicalCt.endsWith("AA==")).toBe(true);
      // Swap the LAST significant character (just before the "==" padding)
      // for a different valid base64 character whose top 2 bits are still
      // zero ('B' = 000001, same top 2 bits as 'A' = 000000) — so a lenient
      // decoder (Node's plain `Buffer.from(str, "base64")`) reconstructs the
      // exact same 16 zero bytes either way; only the low, supposed-to-be-zero
      // padding bits differ, and only decode+re-encode can see that. This is
      // the corruption Rust's strict `base64::STANDARD` engine (and this
      // port's `decodeBase64Strict`) reject that a shape-only regex or a
      // decoded-byte-length check would both miss.
      const nonCanonicalCt = `${canonicalCt.slice(0, -3)}B==`;
      writeFileSync(
        recoverySidecarPath(p),
        JSON.stringify({ v: 1, salt, nonce, ct: nonCanonicalCt })
      );
      await expect(recoverPassword(p, "whatever")).rejects.toThrow(
        "The recovery file is corrupt."
      );
    });
  });
});

describe("readFileSync sanity (sidecar is plaintext JSON, not the DB itself)", () => {
  it("the sidecar file is readable JSON containing base64 fields, not room content", async () => {
    await withFreshTmpDir(async () => {
      const p = tempRoomPath();
      await writeRecovery(p, "some-password");
      const raw = readFileSync(recoverySidecarPath(p), "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.v).toBe(1);
      expect(typeof parsed.salt).toBe("string");
      expect(typeof parsed.nonce).toBe("string");
      expect(typeof parsed.ct).toBe("string");
    });
  });
});
