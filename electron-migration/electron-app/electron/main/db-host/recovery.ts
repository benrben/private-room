/**
 * Recovery key (sidecar, A3) — ported from `src-tauri/src/db/versions.rs`
 * lines 185-397 (`RECOVERY_PBKDF2_ITERS`, `RECOVERY_ALPHABET`,
 * `recovery_sidecar_path`, `RecoveryWrap`, `derive_recovery_key`,
 * `generate_recovery_code`, `normalize_code`, `write_recovery`,
 * `write_sidecar_atomically`, `has_recovery`, `remove_recovery`,
 * `recover_password`, `open_with_recovery`).
 *
 * An optional recovery code that can re-open a room when the password is
 * lost. The subtle part is WHERE to keep the wrapped password. It CANNOT
 * live inside the room's own database: that database is encrypted with the
 * very password we're trying to recover, so a wrap stored inside it would
 * already need the thing you've forgotten to be read at all — a
 * chicken-and-egg. So the wrap lives in a small plaintext SIDECAR file
 * beside the room ("<room>.recovery"). That is safe because the wrap itself
 * is encrypted: the password is sealed with AES-256-GCM under a key
 * stretched from the high-entropy recovery code by PBKDF2-HMAC-SHA256
 * (200k iters). Without the code the sidecar is useless. Purely additive —
 * a room with no sidecar simply has no recovery (A4).
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import type Database from "better-sqlite3-multiple-ciphers";
import { openRoom } from "./open.js";

/** PBKDF2 iteration count for deriving the recovery key from the code. */
export const RECOVERY_PBKDF2_ITERS = 200_000;

/**
 * Human-friendly, unambiguous alphabet for recovery codes: base32-ish with
 * the look-alike characters (I, L, O, 0, 1) left out so a hand-copied code
 * is hard to mistype.
 */
export const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** The sidecar path for a room: the room file's path with ".recovery" appended. */
export function recoverySidecarPath(roomPath: string): string {
  return `${roomPath}.recovery`;
}

/**
 * On-disk shape of the sidecar: base64 salt/nonce/ciphertext plus a version
 * so the format can evolve. `ct` is the GCM body followed by its 16-byte tag.
 */
interface RecoveryWrap {
  v: number;
  salt: string;
  nonce: string;
  ct: string;
}

/**
 * Structural check standing in for serde's `RecoveryWrap` deserialization.
 * `v` must be a non-negative INTEGER — Rust's field is a `u32`, so a
 * fractional or negative number there fails serde outright (⇒ "unreadable"
 * file) rather than surviving to the `v != 1` check (⇒ "written by a newer
 * version"); this mirrors that by rejecting non-integers here too.
 */
function isRecoveryWrapShape(value: unknown): value is RecoveryWrap {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const o = value as Record<string, unknown>;
  return (
    typeof o.v === "number" &&
    Number.isInteger(o.v) &&
    o.v >= 0 &&
    typeof o.salt === "string" &&
    typeof o.nonce === "string" &&
    typeof o.ct === "string"
  );
}

/** Stretch a (normalized) recovery code + salt into a 32-byte AES key. */
function deriveRecoveryKey(codeNormalized: string, salt: Buffer): Buffer {
  return pbkdf2Sync(codeNormalized, salt, RECOVERY_PBKDF2_ITERS, 32, "sha256");
}

/**
 * A fresh recovery code: 6 groups of 4 alphabet chars joined by '-'
 * (e.g. `K7QF-3M2X-...`), 24 random characters in all.
 *
 * The draw is REJECTION-SAMPLED, not `byte % 31`. 256 is not a multiple of
 * the 31-character alphabet, so the modulo mapped 9 byte values onto each
 * of the first eight letters and 8 onto the rest — every character of the
 * one secret this app asks you to copy onto paper was ~12% likelier to be
 * A–H. Drawing again whenever the byte lands in the ragged tail (>= 248)
 * makes the distribution exactly uniform; the expected number of extra
 * bytes is under 1 per code.
 */
export function generateRecoveryCode(): string {
  const n = RECOVERY_ALPHABET.length; // 31
  const limit = 256 - (256 % n); // 248
  const chars: string[] = [];
  while (chars.length < 24) {
    const buf = randomBytes(32);
    for (const b of buf) {
      if (b < limit) {
        chars.push(RECOVERY_ALPHABET.charAt(b % n));
        if (chars.length === 24) {
          break;
        }
      }
    }
  }
  const groups: string[] = [];
  for (let i = 0; i < 24; i += 4) {
    groups.push(chars.slice(i, i + 4).join(""));
  }
  return groups.join("-");
}

/**
 * Normalize a user-typed code before use: drop dashes/spaces/anything that
 * is not a letter or digit, and uppercase — so `k7qf 3m2x` matches
 * `K7QF-3M2X`.
 */
export function normalizeCode(code: string): string {
  let out = "";
  for (const c of code) {
    if (/[a-zA-Z0-9]/.test(c)) {
      out += c.toUpperCase();
    }
  }
  return out;
}

/**
 * Create a recovery code for `roomPath`, seal `password` under it, and
 * write the sidecar. Returns the human-readable code (with dashes) to show
 * ONCE.
 */
export async function writeRecovery(roomPath: string, password: string): Promise<string> {
  const code = generateRecoveryCode();
  const normalized = normalizeCode(code);

  const salt = randomBytes(16);
  const nonce = randomBytes(12);

  const key = deriveRecoveryKey(normalized, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.from(password, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([body, tag]);

  const wrap: RecoveryWrap = {
    v: 1,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    ct: combined.toString("base64"),
  };
  await writeSidecarAtomically(recoverySidecarPath(roomPath), JSON.stringify(wrap));
  return code;
}

/**
 * Write the recovery sidecar the way the checkpoint manifest and the
 * recents list are written: into a temp file beside it, flushed to disk,
 * then renamed over the old one.
 *
 * A plain truncate-in-place write would leave a 0-byte or half-written wrap
 * on a crash/power-loss/full-disk in that window — and the wrap is the ONLY
 * copy of the sealed password. `hasRecovery` just tests that the path
 * exists, so the unlock screen would go on offering a recovery code that
 * can never work, and you would find out on the one day it mattered. The
 * most likely moment for that crash is a password change, which re-writes
 * this file over a working one. The temp file sits beside the sidecar so
 * the rename stays on one volume (rename across volumes is not atomic, and
 * is not even allowed).
 */
export async function writeSidecarAtomically(path: string, json: string): Promise<void> {
  const tmp = `${path}.tmp`;
  // If the temp file cannot even be created (e.g. the directory does not
  // exist), nothing has been written yet — propagate directly, no cleanup
  // to do, and the existing sidecar (if any) is untouched.
  const handle = await fsp.open(tmp, "w");
  try {
    await handle.writeFile(json, "utf8");
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  // Rust's counterpart calls `drop(f)` here, which closes the fd but
  // (per `std::fs::File`'s Drop impl) silently swallows a close error —
  // the data is already `fsync`'d, so a spurious close() failure must not
  // stop the rename that makes the write visible. Mirror that by ignoring
  // the close error here too, matching the catch branch above.
  await handle.close().catch(() => {});
  try {
    await fsp.rename(tmp, path);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** True when a recovery sidecar exists for this room. */
export function hasRecovery(roomPath: string): boolean {
  return existsSync(recoverySidecarPath(roomPath));
}

/**
 * Delete a room's recovery sidecar. Used when re-wrapping after a password
 * change fails: a sidecar wrapping the OLD password must not stay behind,
 * or the unlock gate would keep offering a recovery code that can never
 * work. Rejects (matching Rust's `fs::remove_file` ENOENT) if there is no
 * sidecar to remove.
 */
export async function removeRecovery(roomPath: string): Promise<void> {
  await fsp.unlink(recoverySidecarPath(roomPath));
}

/** Strict, RFC 4648 padded base64 charset/shape: groups of 4 from the
 * alphabet, with only a final group allowed 1-2 trailing '=' pads. */
const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Strict base64 decode matching Rust's `base64::STANDARD` engine, which
 * rejects THREE kinds of corruption that Node's lenient `Buffer.from(str,
 * "base64")` silently tolerates: invalid characters, misplaced/miscounted
 * padding, and a non-canonical final symbol whose unused low bits are
 * non-zero. The regex catches the first two; the round-trip (decode, then
 * re-encode and compare) catches the third, because a decoder can only ever
 * reconstruct the canonical (zero-padded-bits) encoding of the bytes it
 * produced — a corrupt trailing symbol never survives that round trip.
 */
function decodeBase64Strict(value: string): Buffer {
  if (!STRICT_BASE64_RE.test(value)) {
    throw new Error("invalid base64");
  }
  const buf = Buffer.from(value, "base64");
  if (buf.toString("base64") !== value) {
    throw new Error("invalid base64");
  }
  return buf;
}

const CORRUPT = "The recovery file is corrupt.";

/**
 * Recover the ROOM PASSWORD from its recovery sidecar + code, WITHOUT
 * opening the room. The app's recovery-unlock command needs the plaintext
 * password to hold in memory (for rekey / change-password / duplicate), so
 * this is split out from `openWithRecovery`. A wrong code (or a
 * missing/corrupt sidecar) rejects — never a crash.
 */
export async function recoverPassword(roomPath: string, code: string): Promise<string> {
  let json: string;
  try {
    json = await fsp.readFile(recoverySidecarPath(roomPath), "utf8");
  } catch {
    throw new Error("No recovery key was set up for this room.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("The recovery file is unreadable.");
  }
  if (!isRecoveryWrapShape(parsed)) {
    throw new Error("The recovery file is unreadable.");
  }
  const wrap = parsed;
  if (wrap.v !== 1) {
    throw new Error("This recovery file was written by a newer version.");
  }

  let salt: Buffer;
  let nonce: Buffer;
  let combined: Buffer;
  try {
    salt = decodeBase64Strict(wrap.salt);
    nonce = decodeBase64Strict(wrap.nonce);
    combined = decodeBase64Strict(wrap.ct);
  } catch {
    throw new Error(CORRUPT);
  }
  if (nonce.length !== 12 || combined.length < 16) {
    throw new Error(CORRUPT);
  }

  const normalized = normalizeCode(code);
  const key = deriveRecoveryKey(normalized, salt);
  const body = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);

  let decrypted: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    decrypted = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error("That recovery code is not correct.");
  }

  try {
    // `fatal: true` rejects invalid UTF-8 instead of silently substituting
    // U+FFFD, mirroring Rust's `String::from_utf8` returning `Err`.
    return new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
  } catch {
    throw new Error("That recovery code is not correct.");
  }
}

/**
 * Re-open a room using its recovery code: recover the password, then open
 * the room normally. A wrong code (or a missing/corrupt sidecar) rejects —
 * never a crash.
 */
export async function openWithRecovery(
  roomPath: string,
  code: string
): Promise<Database.Database> {
  const password = await recoverPassword(roomPath, code);
  return openRoom(roomPath, password);
}
