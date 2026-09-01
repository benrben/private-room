/**
 * Tests for the bridge updater's signature verification.
 *
 * Two kinds of evidence, deliberately:
 *
 *  1. REAL PRODUCTION VECTORS. The public key below is `tauri.conf.json`'s
 *     `plugins.updater.pubkey` verbatim, and the signature is
 *     `src-tauri/target/release/bundle/macos/Arcelle.app.tar.gz.sig` verbatim —
 *     the actual v0.25.0 release signature, 404 bytes, no trailing newline.
 *     Both are public data. These pin the container parsing and the
 *     trusted-comment/global-signature check against artifacts a real user's
 *     updater has already accepted.
 *
 *  2. FULL ROUND TRIPS with a THROWAWAY keypair generated inside the test. The
 *     payload half cannot be exercised with production vectors without the
 *     638MB tarball, so these sign real bytes with a real (disposable) Ed25519
 *     key using minisign's exact construction, and then verify them through the
 *     shipped code. The app's real signing key is never involved — this module
 *     has no signing path at all, and verification is never stubbed or skipped
 *     to make a test pass.
 */

import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MinisignError,
  decodeOuterBase64,
  parsePublicKeyFile,
  parseSignatureFile,
  verifyManifestSignature,
  verifyMinisign,
} from "./minisignVerify.js";

// --------------------------------------------------------- real production

/** `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. */
const REAL_PUBKEY_B64 =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM2MzAwMTg1NzZFMjlCREEKUldUYW0rSjJoUUV3TnJsd1hocWdMTE9QNDdYdytoOHFRclkxVFJsVkJJRVlzbHNKZlRuU29abmcK";

/** The real v0.25.0 `Arcelle.app.tar.gz.sig`, base64 of the whole file. */
const REAL_SIGNATURE_B64 =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUYW0rSjJoUUV3TnBuNURWenRHWnhOSDZSSUhtQnVHbFlKZCtaL0p3UnFwTU1yRUlVZktpbDJza0R1cWhNNjV1S3ZyMUZnMlUvVVNFWXNwM1lDNVFMZ1NkclZObmVsZXdRPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg3MzQ4NTA1CWZpbGU6QXJjZWxsZS5hcHAudGFyLmd6ClppR0VERGJXNmRaRy9weW9HQ0cvVWI1UFRhejdlRDkwM2NnaVo3ZHFmaHIva2s0MUdKKzczRlRoNlJUR1VXSjNXRmhuRDhSVjY0NStMT09OVFpwcUF3PT0K";

describe("real production artifacts", () => {
  const pubText = decodeOuterBase64(REAL_PUBKEY_B64, "malformed_public_key", "pubkey");
  const sigText = decodeOuterBase64(REAL_SIGNATURE_B64, "malformed_signature", "signature");

  it("parses the shipped public key: Ed tag, key id 3630018576E29BDA little-endian", () => {
    const pub = parsePublicKeyFile(pubText);
    expect(pub.keyId.toString("hex")).toBe("da9be27685013036");
    expect(pub.publicKey).toHaveLength(32);
    expect(pubText).toContain("minisign public key: 3630018576E29BDA");
  });

  it("parses the shipped signature: ED (prehashed), same key id, real trusted comment", () => {
    const sig = parseSignatureFile(sigText);
    expect(sig.prehashed).toBe(true);
    expect(sig.keyId.toString("hex")).toBe("da9be27685013036");
    expect(sig.signature).toHaveLength(64);
    expect(sig.globalSignature).toHaveLength(64);
    // A real TAB, not an escaped one — the byte the global signature covers.
    expect(sig.trustedComment).toBe("timestamp:1787348505\tfile:Arcelle.app.tar.gz");
  });

  it("the pubkey's Ed and the signature's ED tags differ, and only key ids are compared", () => {
    const pubInner = Buffer.from(pubText.split("\n")[1]!, "base64");
    const sigInner = Buffer.from(sigText.split("\n")[1]!, "base64");
    expect(pubInner.subarray(0, 2).toString("latin1")).toBe("Ed");
    expect(sigInner.subarray(0, 2).toString("latin1")).toBe("ED");
    expect(parsePublicKeyFile(pubText).keyId.equals(parseSignatureFile(sigText).keyId)).toBe(true);
  });

  it("rejects a payload that is not the signed tarball", () => {
    // The 638MB payload is not in the repo, so the positive payload case is
    // covered by the throwaway round trips below. This proves the real
    // signature does not accept arbitrary bytes.
    expect(() =>
      verifyManifestSignature(Buffer.from("not the real tarball"), REAL_SIGNATURE_B64, REAL_PUBKEY_B64),
    ).toThrow(MinisignError);
  });

  it("re-encodes to exactly the on-disk .sig bytes (no trailing whitespace)", () => {
    expect(Buffer.from(sigText, "utf8").toString("base64")).toBe(REAL_SIGNATURE_B64);
    // The on-disk .sig is itself already base64 of the 4 lines: 404 bytes of
    // base64 over 303 bytes of text, and no trailing newline in the field.
    expect(REAL_SIGNATURE_B64).toHaveLength(404);
    expect(Buffer.from(REAL_SIGNATURE_B64, "base64")).toHaveLength(303);
    expect(REAL_SIGNATURE_B64.trim()).toBe(REAL_SIGNATURE_B64);
  });

  it("a signature field with a trailing newline is rejected, not silently cleaned up", () => {
    // The §3.5 encoding trap: Node's lenient base64 decoder would skip the
    // newline; the Rust client's would fail. They must not disagree.
    expect(() =>
      verifyManifestSignature(Buffer.alloc(1), `${REAL_SIGNATURE_B64}\n`, REAL_PUBKEY_B64),
    ).toThrow(/canonical base64/);
  });
});

// ------------------------------------------------------- throwaway keypair

interface Throwaway {
  publicKeyFile: string;
  keyId: Buffer;
  signPayload(payload: Buffer, opts?: { prehashed?: boolean; trustedComment?: string }): string;
}

/**
 * A disposable minisign identity. Generates a fresh Ed25519 keypair and emits
 * real 4-line signature files using minisign's exact construction:
 * `Ed25519(BLAKE2b-512(payload))` for `ED`, `Ed25519(payload)` for `Ed`, plus a
 * global signature over `signature ‖ trustedComment`.
 */
function throwawayKey(keyIdHex = "0123456789abcdef"): Throwaway {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  const keyId = Buffer.from(keyIdHex, "hex");

  const pubInner = Buffer.concat([Buffer.from("Ed", "latin1"), keyId, rawPub]);
  const publicKeyFile = `untrusted comment: minisign public key: THROWAWAY\n${pubInner.toString("base64")}\n`;

  return {
    publicKeyFile,
    keyId,
    signPayload(payload, opts = {}) {
      const prehashed = opts.prehashed ?? true;
      const trustedComment = opts.trustedComment ?? "timestamp:1 file:test.tar.gz";
      const message = prehashed ? createHash("blake2b512").update(payload).digest() : payload;
      const signature = cryptoSign(null, message, privateKey);
      const sigInner = Buffer.concat([
        Buffer.from(prehashed ? "ED" : "Ed", "latin1"),
        keyId,
        signature,
      ]);
      const globalSignature = cryptoSign(
        null,
        Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]),
        privateKey,
      );
      return (
        `untrusted comment: signature from throwaway key\n` +
        `${sigInner.toString("base64")}\n` +
        `trusted comment: ${trustedComment}\n` +
        `${globalSignature.toString("base64")}\n`
      );
    },
  };
}

describe("verifyMinisign round trips", () => {
  const payload = Buffer.from("a plausible stand-in for Arcelle.app.tar.gz".repeat(1000));

  it("accepts a correctly prehashed (ED) signature", () => {
    const key = throwawayKey();
    expect(() => verifyMinisign(payload, key.signPayload(payload), key.publicKeyFile)).not.toThrow();
  });

  it("accepts a legacy (Ed) signature, because the plugin passes allow_legacy=true", () => {
    const key = throwawayKey();
    const sig = key.signPayload(payload, { prehashed: false });
    expect(parseSignatureFile(sig).prehashed).toBe(false);
    expect(() => verifyMinisign(payload, sig, key.publicKeyFile)).not.toThrow();
  });

  it("rejects a single flipped bit in the payload", () => {
    const key = throwawayKey();
    const sig = key.signPayload(payload);
    const tampered = Buffer.from(payload);
    tampered[500] = tampered[500]! ^ 0x01;
    expect(() => verifyMinisign(tampered, sig, key.publicKeyFile)).toThrow(
      /The signature verification failed/,
    );
  });

  it("rejects an appended byte", () => {
    const key = throwawayKey();
    const sig = key.signPayload(payload);
    expect(() => verifyMinisign(Buffer.concat([payload, Buffer.of(0)]), sig, key.publicKeyFile)).toThrow(
      MinisignError,
    );
  });

  it("rejects a signature made with a different key, even with a matching key id", () => {
    const real = throwawayKey("aaaaaaaaaaaaaaaa");
    const attacker = throwawayKey("aaaaaaaaaaaaaaaa");
    const forged = attacker.signPayload(payload);
    // Key ids are equal, so this gets past step 1 and must fail on the maths.
    expect(parseSignatureFile(forged).keyId.equals(parsePublicKeyFile(real.publicKeyFile).keyId)).toBe(
      true,
    );
    let code: string | undefined;
    try {
      verifyMinisign(payload, forged, real.publicKeyFile);
    } catch (e) {
      code = (e as MinisignError).code;
    }
    expect(code).toBe("signature_verification_failed");
  });

  it("rejects a mismatched key id before doing any maths", () => {
    const real = throwawayKey("1111111111111111");
    const other = throwawayKey("2222222222222222");
    let code: string | undefined;
    try {
      verifyMinisign(payload, other.signPayload(payload), real.publicKeyFile);
    } catch (e) {
      code = (e as MinisignError).code;
    }
    expect(code).toBe("unexpected_key_id");
  });

  it("rejects a tampered trusted comment even when the payload signature is genuine", () => {
    // The whole point of the global-signature check: without it, a valid
    // (payload, signature) pair could be replayed under a forged comment.
    const key = throwawayKey();
    const sig = key.signPayload(payload, { trustedComment: "timestamp:1 file:real.tar.gz" });
    const forged = sig.replace(
      "trusted comment: timestamp:1 file:real.tar.gz",
      "trusted comment: timestamp:9 file:evil.tar.gz",
    );
    expect(forged).not.toBe(sig);
    expect(() => verifyMinisign(payload, forged, key.publicKeyFile)).toThrow(/trusted comment/);
  });

  it("rejects an ED signature presented as Ed (and vice versa)", () => {
    const key = throwawayKey();
    const sig = key.signPayload(payload, { prehashed: true });
    const lines = sig.split("\n");
    const inner = Buffer.from(lines[1]!, "base64");
    inner.write("Ed", 0, "latin1"); // claim legacy for a prehashed signature
    lines[1] = inner.toString("base64");
    expect(() => verifyMinisign(payload, lines.join("\n"), key.publicKeyFile)).toThrow(MinisignError);
  });

  it("verifies through the outer-base64 wrapper the manifest actually carries", () => {
    const key = throwawayKey();
    const sigB64 = Buffer.from(key.signPayload(payload), "utf8").toString("base64");
    const pubB64 = Buffer.from(key.publicKeyFile, "utf8").toString("base64");
    expect(() => verifyManifestSignature(payload, sigB64, pubB64)).not.toThrow();
    expect(() => verifyManifestSignature(Buffer.from("other"), sigB64, pubB64)).toThrow(MinisignError);
  });

  it("verifies an empty payload (a real hash input, not a special case)", () => {
    const key = throwawayKey();
    const empty = Buffer.alloc(0);
    expect(() => verifyMinisign(empty, key.signPayload(empty), key.publicKeyFile)).not.toThrow();
    expect(() => verifyMinisign(Buffer.of(1), key.signPayload(empty), key.publicKeyFile)).toThrow();
  });
});

// ------------------------------------------------------------ container

describe("container parsing", () => {
  const key = throwawayKey();

  it("accepts an ED-tagged public key file, matching PublicKey::from_base64", () => {
    // `from_base64` accepts BOTH tags in a key file; the tag there says nothing
    // about how the key's signatures were made.
    const inner = Buffer.from(key.publicKeyFile.split("\n")[1]!, "base64");
    inner.write("ED", 0, "latin1");
    const text = `untrusted comment: x\n${inner.toString("base64")}\n`;
    expect(parsePublicKeyFile(text).keyId).toHaveLength(8);
  });

  it("rejects an unknown public key algorithm tag", () => {
    const inner = Buffer.from(key.publicKeyFile.split("\n")[1]!, "base64");
    inner.write("XX", 0, "latin1");
    expect(() => parsePublicKeyFile(`untrusted comment: x\n${inner.toString("base64")}\n`)).toThrow(
      /unsupported public key algorithm/,
    );
  });

  it("rejects an unknown signature algorithm tag", () => {
    const lines = key.signPayload(Buffer.of(1)).split("\n");
    const inner = Buffer.from(lines[1]!, "base64");
    inner.write("XX", 0, "latin1");
    lines[1] = inner.toString("base64");
    expect(() => parseSignatureFile(lines.join("\n"))).toThrow(/unsupported signature algorithm/);
  });

  it("ignores lines past the ones the format defines, matching Rust's .lines()", () => {
    const sig = key.signPayload(Buffer.of(1)) + "an extra trailing line\n";
    expect(() => parseSignatureFile(sig)).not.toThrow();
    expect(() => parsePublicKeyFile(`${key.publicKeyFile}extra\n`)).not.toThrow();
  });

  it("handles CRLF line endings the way Rust's .lines() does", () => {
    const payload = Buffer.of(7, 7, 7);
    const crlf = key.signPayload(payload).replace(/\n/g, "\r\n");
    expect(() => verifyMinisign(payload, crlf, key.publicKeyFile.replace(/\n/g, "\r\n"))).not.toThrow();
  });

  it("requires the literal 'trusted comment: ' prefix on line 3", () => {
    // Anchored on the newline: line 1's "untrusted comment: " contains
    // "trusted comment: " as a substring, so an unanchored replace hits it.
    const sig = key.signPayload(Buffer.of(1)).replace("\ntrusted comment: ", "\nTrusted comment: ");
    expect(() => parseSignatureFile(sig)).toThrow(/must start with/);
  });

  it("rejects a truncated file", () => {
    expect(() => parsePublicKeyFile("untrusted comment: x\n")).toThrow(/at least 2 lines/);
    expect(() => parseSignatureFile("untrusted comment: x\nAAAA\ntrusted comment: c\n")).toThrow(
      /at least 4 lines/,
    );
  });

  it("rejects wrong inner lengths", () => {
    const short = Buffer.from("too short").toString("base64");
    expect(() => parsePublicKeyFile(`untrusted comment: x\n${short}\n`)).toThrow(/must be 42/);
    expect(() =>
      parseSignatureFile(`untrusted comment: x\n${short}\ntrusted comment: c\n${short}\n`),
    ).toThrow(/must be 74/);
  });

  it("rejects a wrong-length global signature", () => {
    const sig = key.signPayload(Buffer.of(1)).split("\n");
    sig[3] = Buffer.alloc(32).toString("base64");
    expect(() => parseSignatureFile(sig.join("\n"))).toThrow(/must be 64 bytes/);
  });

  it("reports a malformed public key with the public-key error code", () => {
    // The code is part of the API — a caller distinguishing "wrong key" from
    // "bad signature" must not be told a key problem is a signature problem.
    let code: string | undefined;
    try {
      decodeOuterBase64("not base64!!", "malformed_public_key", "pubkey");
    } catch (e) {
      code = (e as MinisignError).code;
    }
    expect(code).toBe("malformed_public_key");
  });

  it("rejects non-canonical base64 that Node would silently clean up", () => {
    const line = key.publicKeyFile.split("\n")[1]!;
    for (const mangled of [
      line.replace(/.$/, ""), // dropped padding
      `${line.slice(0, 8)} ${line.slice(8)}`, // embedded space
      line.replace(/\+/g, "-"), // url-safe alphabet
    ]) {
      if (mangled === line) continue;
      expect(() => parsePublicKeyFile(`untrusted comment: x\n${mangled}\n`)).toThrow(MinisignError);
    }
  });

  it("rejects outer base64 whose bytes are not valid UTF-8", () => {
    const notUtf8 = Buffer.from([0xff, 0xfe, 0xfd, 0xfc]).toString("base64");
    expect(() => decodeOuterBase64(notUtf8, "malformed_signature", "sig")).toThrow(/not valid UTF-8/);
  });
});
