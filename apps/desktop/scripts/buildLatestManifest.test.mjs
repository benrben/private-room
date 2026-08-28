/**
 * Proves `buildLatestManifest_a.mjs`'s output round-trips through the REAL
 * client-side code that will ever read it: `parseUpdateManifest` +
 * `selectPlatformEntry` (`updateManifest.ts`) and `verifyManifestSignature`
 * (`minisignVerify.ts`) -- signed with a THROWAWAY, disposable Ed25519
 * keypair generated inside this test, using minisign's exact container
 * construction (`Ed`/`ED` tag, key id, BLAKE2b-512 prehash, global signature
 * over `signature ‖ trustedComment`). The real production key
 * (`~/.tauri/private-room.key`) is never read, referenced, or needed --
 * this batch's safety rules forbid touching it, and this proof doesn't need
 * to: `minisignVerify.ts` verifies against WHATEVER public key the manifest
 * claims, so a throwaway key exercises the exact same code paths a real
 * release does.
 *
 * The keypair/signing construction below is intentionally the same shape as
 * `minisignVerify.test.ts`'s own `throwawayKey()` helper (not imported --
 * that helper lives in a `.test.ts` file, not the module under test, so
 * re-deriving it here keeps this file's proof self-contained rather than
 * reaching into another file's test-only internals).
 */
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildLatestManifestJson,
  decodeTauriSignatureFile,
  rfc3339Now,
} from "./buildLatestManifest.mjs";
import { isUpdateAvailable, parseUpdateManifest, selectPlatformEntry } from "../src/main/updater/updateManifest.js";
import { verifyManifestSignature } from "../src/main/updater/minisignVerify.js";

function throwawayKey(keyIdHex = "aabbccddeeff0011") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  const keyId = Buffer.from(keyIdHex, "hex");
  const pubInner = Buffer.concat([Buffer.from("Ed", "latin1"), keyId, rawPub]);
  const publicKeyFile = `untrusted comment: minisign public key: THROWAWAY\n${pubInner.toString("base64")}\n`;
  return {
    publicKeyB64: Buffer.from(publicKeyFile, "utf8").toString("base64"),
    signPayload(payload, trustedComment) {
      const message = createHash("blake2b512").update(payload).digest();
      const signature = cryptoSign(null, message, privateKey);
      const sigInner = Buffer.concat([Buffer.from("ED", "latin1"), keyId, signature]);
      const globalSignature = cryptoSign(null, Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]), privateKey);
      return (
        `untrusted comment: signature from throwaway key\n${sigInner.toString("base64")}\n` +
        `trusted comment: ${trustedComment}\n${globalSignature.toString("base64")}\n`
      );
    },
  };
}

describe("buildLatestManifestJson — round trip through the real client code", () => {
  const compiledUpdater = fileURLToPath(
    new URL("../dist_package/src/main/updater/updateManifest.js", import.meta.url),
  );

  it.runIf(existsSync(compiledUpdater))(
    "runs the standalone Node CLI against the emitted updater modules",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "arcelle-manifest-cli-"));
      try {
        const key = throwawayKey();
        const raw = key.signPayload(Buffer.from("payload"), "timestamp:1787000000\tfile:Arcelle.app.tar.gz");
        const sig = join(dir, "payload.sig");
        const out = join(dir, "latest.json");
        writeFileSync(sig, Buffer.from(raw, "utf8").toString("base64"), "utf8");
        const script = fileURLToPath(new URL("./buildLatestManifest.mjs", import.meta.url));
        const result = spawnSync(
          process.execPath,
          [
            script,
            "--version", "0.26.0",
            "--notes", "CLI smoke",
            "--tauri-sig-file", sig,
            "--out", out,
            "--pub-date", "2026-08-27T12:00:00Z",
          ],
          { encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        const manifest = JSON.parse(readFileSync(out, "utf8"));
        expect(manifest.version).toBe("0.26.0");
        expect(manifest.platforms["darwin-aarch64"].signature).toBeTruthy();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("decodes Tauri CLI's one-line .sig exactly once before manifest encoding", () => {
    const key = throwawayKey();
    const raw = key.signPayload(Buffer.from("payload"), "timestamp:1787000000\tfile:Arcelle.app.tar.gz");
    const tauriSigFile = Buffer.from(raw, "utf8").toString("base64");
    expect(decodeTauriSignatureFile(tauriSigFile)).toBe(raw);
    expect(() => decodeTauriSignatureFile(raw)).toThrow(/base64|signature/i);
    expect(() => decodeTauriSignatureFile("")).toThrow(/empty/);
  });

  it("produces a manifest the real parser + real signature verifier both accept, with the plain darwin-aarch64 key winning selectPlatformEntry", () => {
    const key = throwawayKey();
    const payload = Buffer.from("pretend this is Arcelle.app.tar.gz's real bytes", "utf8");
    const sigFileText = key.signPayload(payload, "timestamp:1787000000\tfile:Arcelle.app.tar.gz");

    const json = buildLatestManifestJson({
      version: "0.26.0",
      notes: 'Bridge release. "Quoted" & special <chars> to prove JSON escaping.',
      pubDate: "2026-08-30T12:00:00Z",
      signatureFileText: sigFileText,
    });

    // release.sh's own contract: build with JSON.stringify, never string
    // interpolation, so quotes/special chars in notes can't break the file.
    expect(() => JSON.parse(json)).not.toThrow();
    const parsedRaw = JSON.parse(json);
    expect(parsedRaw.notes).toContain('"Quoted"');
    expect(Object.keys(parsedRaw.platforms)).toEqual(["darwin-aarch64"]);
    expect(parsedRaw.platforms["darwin-aarch64"].url).toBe(
      "https://github.com/benrben/private-room/releases/download/v0.26.0/Arcelle.app.tar.gz",
    );

    // Now hand it to the REAL client parser.
    const manifest = parseUpdateManifest(json);
    expect(manifest.form).toBe("static");
    expect(manifest.version).toBe("0.26.0");

    const entry = selectPlatformEntry(manifest);
    expect(entry).not.toBeNull();
    expect(entry.url).toBe(parsedRaw.platforms["darwin-aarch64"].url);

    // And the REAL signature verifier, against the throwaway pubkey -- must
    // accept the real payload bytes and reject tampered ones.
    expect(() => verifyManifestSignature(payload, entry.signature, key.publicKeyB64)).not.toThrow();
    const tampered = Buffer.concat([payload, Buffer.from("x")]);
    expect(() => verifyManifestSignature(tampered, entry.signature, key.publicKeyB64)).toThrow();

    // isUpdateAvailable — the same comparison assertBundleIdentity reuses.
    expect(isUpdateAvailable(manifest.version, "0.25.0")).toBe(true);
    expect(isUpdateAvailable(manifest.version, "0.26.0")).toBe(false);
  });

  it("refuses to build a manifest with a calendar-invalid pub_date (Date.parse's own blind spot)", () => {
    const key = throwawayKey();
    const sigFileText = key.signPayload(Buffer.from("x"), "timestamp:1\tfile:Arcelle.app.tar.gz");
    // 2026 is not a leap year: Feb 30th doesn't exist. `new Date(...)` /
    // `Date.parse` silently roll this over to March 2nd; the real Rust
    // client's OffsetDateTime::parse rejects it outright.
    expect(() =>
      buildLatestManifestJson({
        version: "0.26.0",
        notes: "x",
        pubDate: "2026-02-30T00:00:00Z",
        signatureFileText: sigFileText,
      }),
    ).toThrow(/not valid RFC 3339/);
  });

  it("rejects a missing signatureFileText / version rather than silently publishing a broken manifest", () => {
    expect(() => buildLatestManifestJson({ version: "0.26.0", notes: "x", signatureFileText: "" })).toThrow(
      /signatureFileText is required/,
    );
    expect(() => buildLatestManifestJson({ notes: "x", signatureFileText: "y" })).toThrow(/version is required/);
  });

  it("rfc3339Now() always produces a value isValidRfc3339 (transitively, via buildLatestManifestJson) accepts", () => {
    const key = throwawayKey();
    const sigFileText = key.signPayload(Buffer.from("x"), "timestamp:1\tfile:Arcelle.app.tar.gz");
    expect(() =>
      buildLatestManifestJson({ version: "1.2.3", notes: "x", signatureFileText: sigFileText, pubDate: rfc3339Now() }),
    ).not.toThrow();
  });
});
