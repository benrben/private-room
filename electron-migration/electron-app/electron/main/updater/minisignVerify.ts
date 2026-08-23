/**
 * Minisign signature verification — the security-critical half of the
 * Tauri-compatible bridge updater.
 *
 * This is a behavioural port of the ONE algorithm the cutover depends on:
 * `tauri-plugin-updater` 2.10.1's `verify_signature` (`updater.rs:1440-1467`),
 * which delegates to `minisign-verify` 0.2.5's `Signature::decode` /
 * `PublicKey::decode` / `PublicKey::verify` (`lib.rs:228-371`). Both crate
 * versions were read in full from the vendored sources this repo's
 * `Cargo.lock` pins, and every rule below cites what that code actually does
 * rather than what minisign documents in general.
 *
 * Every install made since the v0.3.0 key rotation trusts this exact algorithm
 * to decide what code gets written into `/Applications`. Reimplementing it
 * loosely — accepting a key-id mismatch, skipping the trusted-comment global
 * signature, treating a parse failure as "probably fine" — silently widens what
 * an attacker who can serve the (UNSIGNED, TLS-only) manifest can install.
 *
 * Two verification layers, BOTH required:
 *   1. the per-file signature authenticates the payload bytes.
 *   2. the global signature authenticates the per-file signature together with
 *      its trusted comment (which records `timestamp:… file:…`). Without it, a
 *      valid (payload, signature) pair could be replayed under a forged
 *      comment.
 *
 * NO THIRD-PARTY CRYPTO DEPENDENCY. `node:crypto` (OpenSSL) already exposes
 * both primitives: `blake2b512` as a built-in digest, and Ed25519 verify via
 * `crypto.verify(null, …)` once the raw 32-byte key is wrapped in its fixed
 * SPKI DER envelope. The only hand-written part here is byte-slicing minisign's
 * container format — parsing, not cryptography. No curve arithmetic, no hash
 * function, no signature scheme is implemented in this file.
 *
 * ⚠️ CORRECTION TO THE MIGRATION PLAN (`pm-request/electron-python-migration-
 * plan-2026-08-22.md` §8, L264): the plan says to verify "via
 * `libsodium-wrappers` (Ed25519ph + Blake2b)". That is wrong and would verify
 * nothing real. Minisign's "prehashed" mode is PLAIN Ed25519 over a BLAKE2b-512
 * digest. RFC 8032 Ed25519ph is a DIFFERENT construction (SHA-512 prehash plus
 * a `SigEd25519 no Ed25519 collisions` dom2 domain-separation prefix folded
 * into the signature). Never reach for a `*_ph` /
 * `crypto_sign_init/update/final_verify` API for this.
 */

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

/**
 * Thrown for every verification failure. `code` lets a caller distinguish
 * "wrong key" from "bad signature" from "malformed input" without parsing the
 * message — mirroring the distinct outcomes `minisign-verify` produces
 * (`UnexpectedKeyId` / `InvalidSignature` / `InvalidEncoding` /
 * `UnsupportedAlgorithm`).
 *
 * Nothing in this module returns a boolean "is it valid" — every failure path
 * throws. A boolean a caller can `if (!ok)` past and forget is exactly the
 * shape of bug that turns a signature check into a decoration.
 */
export class MinisignError extends Error {
  constructor(
    public readonly code:
      | "malformed_public_key"
      | "malformed_signature"
      | "unsupported_algorithm"
      | "unexpected_key_id"
      | "signature_verification_failed",
    message: string,
  ) {
    super(message);
    this.name = "MinisignError";
  }
}

/** A parsed minisign public key: the opaque `keyId` used only to match a
 * signature to the key that should check it, and the raw 32-byte Ed25519 key. */
export interface ParsedPublicKey {
  /** 8 bytes, compared byte-for-byte — never interpreted as a number. The
   * production key's id prints as `3630018576E29BDA` in the comment but is
   * stored little-endian (`da9be27685013036`); nothing here depends on that. */
  keyId: Buffer;
  publicKey: Buffer;
}

/** A parsed minisign signature file. */
export interface ParsedSignature {
  keyId: Buffer;
  /** `ED` ⇒ payload is BLAKE2b-512 hashed first. `Ed` ⇒ legacy, signed
   * directly. Both are accepted; see {@link parseSignatureFile}. */
  prehashed: boolean;
  signature: Buffer;
  /** The bytes AFTER the 17-character `"trusted comment: "` prefix, matching
   * `Signature::trusted_comment()`'s `&self.trusted_comment[17..]`. */
  trustedComment: string;
  globalSignature: Buffer;
}

/** RFC 8410 SPKI DER prefix for a raw Ed25519 public key:
 * `SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING (32 bytes) }`. Constant
 * for every Ed25519 key, so prepending it is pure re-framing for
 * `createPublicKey`'s SPKI-only import — not a cryptographic operation. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const TRUSTED_COMMENT_PREFIX = "trusted comment: ";

/** Algorithm tag bytes minisign writes. `PublicKey::from_base64` accepts EITHER
 * in a key file; `Signature::decode` maps `Ed` to legacy and `ED` to prehashed.
 * Real production artifacts carry `Ed` in the key and `ED` in the signature —
 * that mismatch is normal, and only the key IDs are ever compared. */
const ALG_LEGACY = "Ed";
const ALG_PREHASHED = "ED";

/**
 * Split exactly like Rust's `str::lines()`, which is what
 * `Signature::decode` / `PublicKey::decode` iterate: split on `\n`, strip a
 * `\r` only when it immediately preceded that `\n`, and treat a final newline
 * as a terminator rather than the start of an empty last line.
 *
 * Lines beyond the ones a parser reads are IGNORED, not rejected — the Rust
 * decoders simply stop calling `.next()`. Being stricter here would make this
 * module reject a container the client it must interoperate with accepts, which
 * is a correctness bug in a compatibility layer even though it sounds safer.
 */
function splitRustLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      const rest = text.slice(start);
      if (rest.length > 0) out.push(rest);
      return out;
    }
    const line = text.slice(start, nl);
    out.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    start = nl + 1;
  }
}

/**
 * Strict, canonical base64 decode.
 *
 * Node's `Buffer.from(s, "base64")` is lenient: it silently SKIPS characters it
 * does not recognise (whitespace, newlines, stray punctuation), accepts the
 * URL-safe alphabet interchangeably, and tolerates missing padding. Both
 * decoders on the Rust side reject all of that — the outer layer uses
 * `base64::engine::general_purpose::STANDARD` (canonical alphabet, required
 * padding, `decode_allow_trailing_bits: false`) and the inner minisign lines use
 * `minisign-verify`'s vendored ct-codecs decoder, which likewise rejects
 * non-canonical trailing bits (`base64.rs:118`) and any trailing garbage.
 *
 * Re-encoding and comparing is exactly equivalent to "was this canonical,
 * correctly-padded, standard-alphabet base64": Node's encoder only ever emits
 * that form, so a value that round-trips must have been in it. This is the
 * §3.5 encoding trap — a `signature` field that picked up a trailing newline
 * decodes fine in Node and fails in Rust, and the two must not disagree.
 */
function decodeBase64Strict(
  field: string,
  code: "malformed_public_key" | "malformed_signature",
  label: string,
): Buffer {
  const buf = Buffer.from(field, "base64");
  if (buf.toString("base64") !== field) {
    throw new MinisignError(code, `${label}: not canonical base64`);
  }
  return buf;
}

/** UTF-8 decode that REJECTS invalid sequences instead of substituting U+FFFD.
 * `base64_to_string` in the plugin runs `std::str::from_utf8` and fails with
 * `Error::SignatureUtf8` on bad bytes; a lossy decode here would instead mangle
 * the trusted comment and then fail the global-signature check with a
 * misleading reason. */
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

/**
 * Decode the OUTER base64 layer that both `tauri.conf.json`'s `pubkey` and
 * `latest.json`'s `platforms[…].signature` are wrapped in: base64 of the ENTIRE
 * minisign container file (literally `cat minisign.pub` / `cat file.sig`).
 * Exposed separately so a caller holding an already-decoded on-disk `.pub`/
 * `.sig` can skip this layer.
 */
export function decodeOuterBase64(
  field: string,
  code: "malformed_public_key" | "malformed_signature",
  label: string,
): string {
  const bytes = decodeBase64Strict(field, code, label);
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    throw new MinisignError(code, `${label}: base64 payload is not valid UTF-8`);
  }
}

/**
 * Parse a minisign PUBLIC KEY FILE — the 2-line `untrusted comment: …` /
 * base64 format — from its already-decoded text. Mirrors `PublicKey::decode`
 * feeding `PublicKey::from_base64`.
 */
export function parsePublicKeyFile(fileText: string): ParsedPublicKey {
  const lines = splitRustLines(fileText);
  if (lines.length < 2) {
    throw new MinisignError("malformed_public_key", "public key file must have at least 2 lines");
  }
  const inner = decodeBase64Strict(lines[1]!, "malformed_public_key", "public key line 2");
  if (inner.length !== 42) {
    throw new MinisignError(
      "malformed_public_key",
      `public key inner bytes must be 42 (alg 2 + keyId 8 + key 32), got ${inner.length}`,
    );
  }
  // `PublicKey::from_base64` accepts BOTH tags here (`lib.rs:296-299`); the tag
  // in a KEY file says nothing about how its signatures were made, and rejecting
  // `ED` would make this module refuse a key the real client would load.
  const alg = inner.subarray(0, 2).toString("latin1");
  if (alg !== ALG_LEGACY && alg !== ALG_PREHASHED) {
    throw new MinisignError(
      "unsupported_algorithm",
      `unsupported public key algorithm ${JSON.stringify(alg)}`,
    );
  }
  return {
    keyId: Buffer.from(inner.subarray(2, 10)),
    publicKey: Buffer.from(inner.subarray(10, 42)),
  };
}

/**
 * Parse a minisign SIGNATURE FILE — the 4-line untrusted comment / base64
 * signature / `trusted comment: …` / base64 global signature format — from its
 * already-decoded text. Mirrors `Signature::decode`.
 */
export function parseSignatureFile(fileText: string): ParsedSignature {
  const lines = splitRustLines(fileText);
  if (lines.length < 4) {
    throw new MinisignError("malformed_signature", "signature file must have at least 4 lines");
  }
  const inner = decodeBase64Strict(lines[1]!, "malformed_signature", "signature line 2");
  if (inner.length !== 74) {
    throw new MinisignError(
      "malformed_signature",
      `signature inner bytes must be 74 (alg 2 + keyId 8 + sig 64), got ${inner.length}`,
    );
  }

  const alg = inner.subarray(0, 2).toString("latin1");
  let prehashed: boolean;
  if (alg === ALG_PREHASHED) {
    prehashed = true;
  } else if (alg === ALG_LEGACY) {
    // Legacy signatures are accepted because the plugin calls
    // `public_key.verify(data, &signature, true)` — `allow_legacy = true`
    // (`updater.rs:1461`). Refusing them would be stricter than the client this
    // must interoperate with.
    prehashed = false;
  } else {
    throw new MinisignError(
      "unsupported_algorithm",
      `unsupported signature algorithm ${JSON.stringify(alg)}`,
    );
  }

  const trustedCommentLine = lines[2]!;
  if (!trustedCommentLine.startsWith(TRUSTED_COMMENT_PREFIX)) {
    throw new MinisignError(
      "malformed_signature",
      `signature line 3 must start with ${JSON.stringify(TRUSTED_COMMENT_PREFIX)}`,
    );
  }

  const globalSignature = decodeBase64Strict(lines[3]!, "malformed_signature", "signature line 4");
  if (globalSignature.length !== 64) {
    throw new MinisignError(
      "malformed_signature",
      `global signature must be 64 bytes, got ${globalSignature.length}`,
    );
  }

  return {
    keyId: Buffer.from(inner.subarray(2, 10)),
    prehashed,
    signature: Buffer.from(inner.subarray(10, 74)),
    trustedComment: trustedCommentLine.slice(TRUSTED_COMMENT_PREFIX.length),
    globalSignature: Buffer.from(globalSignature),
  };
}

function edPublicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) {
    throw new MinisignError(
      "malformed_public_key",
      `raw Ed25519 key must be 32 bytes, got ${raw.length}`,
    );
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/** Ed25519 verify. `null` as the digest name is how `node:crypto` is asked for
 * plain (single-pass) Ed25519 — the same construction `ed25519::verify` in
 * `minisign-verify` performs. */
function ed25519Verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean {
  return cryptoVerify(null, message, edPublicKeyFromRaw(publicKey), signature);
}

/**
 * Verify an update payload against a minisign signature file and public key
 * file, replicating `PublicKey::verify` + `verify_ed25519` exactly:
 *
 *   1. `signature.keyId === publicKey.keyId` (byte equality) — else
 *      `unexpected_key_id`, matching `Error::UnexpectedKeyId`.
 *   2. `message = prehashed ? BLAKE2b-512(payload) : payload`.
 *   3. Ed25519-verify `message` against the per-file signature.
 *   4. Ed25519-verify `signature ‖ utf8(trustedComment)` against the global
 *      signature.
 *
 * All four must pass. Throws {@link MinisignError} on any failure; on success
 * returns `undefined` — a normal return IS the "verified" signal, deliberately
 * leaving no boolean for a caller to mis-negate.
 *
 * @param payload the exact bytes to authenticate. For the updater this is the
 *   COMPLETE downloaded `Arcelle.app.tar.gz` response body, buffered in full
 *   before any of it is trusted — matching `updater.rs:712`, which verifies
 *   before extracting anything.
 */
export function verifyMinisign(
  payload: Buffer,
  signatureFileText: string,
  publicKeyFileText: string,
): void {
  const pub = parsePublicKeyFile(publicKeyFileText);
  const sig = parseSignatureFile(signatureFileText);

  if (!pub.keyId.equals(sig.keyId)) {
    throw new MinisignError(
      "unexpected_key_id",
      "The signature was created with a different key than the one provided",
    );
  }

  const message = sig.prehashed ? createHash("blake2b512").update(payload).digest() : payload;
  if (!ed25519Verify(message, sig.signature, pub.publicKey)) {
    throw new MinisignError("signature_verification_failed", "The signature verification failed");
  }

  const globalMessage = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!ed25519Verify(globalMessage, sig.globalSignature, pub.publicKey)) {
    throw new MinisignError(
      "signature_verification_failed",
      "The signature verification failed (trusted comment)",
    );
  }
}

/**
 * {@link verifyMinisign} over the shapes the update flow actually holds: a
 * manifest platform entry's `signature` and `tauri.conf.json`'s `pubkey`, both
 * still outer-base64-encoded.
 */
export function verifyManifestSignature(
  payload: Buffer,
  manifestSignatureB64: string,
  pubkeyB64: string,
): void {
  const sigText = decodeOuterBase64(manifestSignatureB64, "malformed_signature", "manifest signature field");
  const pubText = decodeOuterBase64(pubkeyB64, "malformed_public_key", "pubkey field");
  verifyMinisign(payload, sigText, pubText);
}
