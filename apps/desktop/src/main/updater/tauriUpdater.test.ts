import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MinisignError } from "./minisignVerify.js";
import {
  MAX_PAYLOAD_BYTES,
  TAURI_UPDATE_ENDPOINT,
  TAURI_UPDATE_PUBKEY_B64,
  UpdateCheckError,
  UpdateDownloadError,
  checkForUpdate,
  downloadAndVerify,
  performUpdate,
  type FetchLike,
} from "./tauriUpdater.js";
import { InstallError, type InstallDeps } from "./installBundle.js";

/** Await a call that MUST reject, and return its error typed. Unlike
 * `.catch(e => e as E)`, this fails loudly if the call unexpectedly resolves
 * instead of quietly handing the assertions a success value. */
async function rejectsWith<E>(p: Promise<unknown>): Promise<E> {
  try {
    await p;
  } catch (e) {
    return e as E;
  }
  throw new Error("expected the call to reject, but it resolved");
}

// ------------------------------------------------------ signed test fixture

const PAYLOAD = Buffer.from("pretend this is Arcelle.app.tar.gz".repeat(500));

/**
 * A complete, genuinely signed update: a THROWAWAY Ed25519 keypair, a real
 * minisign container built with the prehashed construction, and the base64
 * wrappers the manifest and config actually carry. The app's real signing key is
 * never involved, and verification is never stubbed.
 */
function signedFixture(payload = PAYLOAD) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  const keyId = Buffer.from("0123456789abcdef", "hex");

  const pubFile = `untrusted comment: minisign public key: TEST\n${Buffer.concat([
    Buffer.from("Ed", "latin1"),
    keyId,
    rawPub,
  ]).toString("base64")}\n`;

  const digest = createHash("blake2b512").update(payload).digest();
  const signature = cryptoSign(null, digest, privateKey);
  const trustedComment = "timestamp:1787348505\tfile:Arcelle.app.tar.gz";
  const globalSignature = cryptoSign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]),
    privateKey,
  );
  const sigFile =
    `untrusted comment: signature from test key\n` +
    `${Buffer.concat([Buffer.from("ED", "latin1"), keyId, signature]).toString("base64")}\n` +
    `trusted comment: ${trustedComment}\n` +
    `${globalSignature.toString("base64")}\n`;

  return {
    payload,
    pubkeyB64: Buffer.from(pubFile, "utf8").toString("base64"),
    signatureB64: Buffer.from(sigFile, "utf8").toString("base64"),
  };
}

const PAYLOAD_URL = "https://github.test/releases/download/v9.0.0/Arcelle.app.tar.gz";
const ENDPOINT = "https://github.test/latest.json";

function manifestJson(
  fixture: ReturnType<typeof signedFixture>,
  version = "9.0.0",
  key = "darwin-aarch64",
) {
  return JSON.stringify({
    version,
    notes: "Bridge release.",
    pub_date: "2026-08-21T21:42:18Z",
    platforms: { [key]: { url: PAYLOAD_URL, signature: fixture.signatureB64 } },
  });
}

/** A `fetch` double that answers by URL. Anything unmapped is a 404, so a test
 * can never accidentally reach the network. */
function fakeFetch(routes: Record<string, () => Response>): {
  fetch: FetchLike;
  seen: [string, RequestInit | undefined][];
} {
  const seen: [string, RequestInit | undefined][] = [];
  return {
    seen,
    fetch: async (url, init) => {
      seen.push([url, init]);
      const route = Object.hasOwn(routes, url) ? routes[url] : undefined;
      return route ? route() : new Response("not found", { status: 404 });
    },
  };
}

const ok = (body: string) => () => new Response(body, { status: 200 });

// --------------------------------------------------------------- constants

describe("wire constants", () => {
  const confPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../../src-tauri/tauri.conf.json",
  );
  const confExists = fs.existsSync(confPath);

  it.skipIf(!confExists)("match the live tauri.conf.json exactly", () => {
    // While any install is still on the Tauri build, both clients must read the
    // same manifest URL and trust the same key. Drift here is a silent
    // stranding, so it is pinned against the real config rather than a copy.
    const conf = JSON.parse(fs.readFileSync(confPath, "utf8")) as {
      plugins: { updater: { endpoints: string[]; pubkey: string } };
    };
    expect(TAURI_UPDATE_ENDPOINT).toBe(conf.plugins.updater.endpoints[0]);
    expect(TAURI_UPDATE_PUBKEY_B64).toBe(conf.plugins.updater.pubkey);
  });

  it("decode to the production key id and an https GitHub endpoint", () => {
    expect(TAURI_UPDATE_ENDPOINT).toBe(
      "https://github.com/benrben/private-room/releases/latest/download/latest.json",
    );
    expect(Buffer.from(TAURI_UPDATE_PUBKEY_B64, "base64").toString("utf8")).toContain(
      "minisign public key: 3630018576E29BDA",
    );
  });
});

// ------------------------------------------------------------------ check

describe("checkForUpdate", () => {
  const fixture = signedFixture();

  it("offers a strictly newer version with its platform entry", async () => {
    const { fetch, seen } = fakeFetch({ [ENDPOINT]: ok(manifestJson(fixture)) });
    const result = await checkForUpdate(fetch, "0.25.0", ENDPOINT);
    expect(result.available).toBe(true);
    expect(result.available && result.platform.url).toBe(PAYLOAD_URL);
    expect(result.available && result.manifest.version).toBe("9.0.0");

    const headers = seen[0]![1]?.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/json");
    expect(headers["User-Agent"]).toContain("arcelle-updater");
    // Honest identification: this client does not claim to be the Rust one.
    expect(headers["User-Agent"]).not.toContain("tauri-plugin-updater/");
  });

  it("treats 204 as an explicit 'nothing new'", async () => {
    const { fetch } = fakeFetch({ [ENDPOINT]: () => new Response(null, { status: 204 }) });
    expect(await checkForUpdate(fetch, "0.25.0", ENDPOINT)).toEqual({
      available: false,
      reason: "no_content",
    });
  });

  it("reports 'not_newer' for the same or an older version", async () => {
    for (const version of ["0.25.0", "0.24.9"]) {
      const { fetch } = fakeFetch({ [ENDPOINT]: ok(manifestJson(fixture, version)) });
      const result = await checkForUpdate(fetch, "0.25.0", ENDPOINT);
      expect(result.available, version).toBe(false);
      expect(!result.available && result.reason).toBe("not_newer");
    }
  });

  it("reports 'no_matching_target' when the darwin-aarch64 key is missing", async () => {
    // The silent-stranding failure the bridge exists to avoid: a release that
    // drops the key offers nothing, and says nothing.
    const { fetch } = fakeFetch({ [ENDPOINT]: ok(manifestJson(fixture, "9.0.0", "linux-x86_64")) });
    const result = await checkForUpdate(fetch, "0.25.0", ENDPOINT);
    expect(!result.available && result.reason).toBe("no_matching_target");
  });

  it("surfaces HTTP and network failures instead of hiding them as 'no update'", async () => {
    const { fetch } = fakeFetch({});
    const httpErr = await rejectsWith<UpdateCheckError>(checkForUpdate(fetch, "0.25.0", ENDPOINT));
    expect(httpErr.code).toBe("http_error");

    const throwing: FetchLike = async () => {
      throw new Error("ENOTFOUND");
    };
    const netErr = await rejectsWith<UpdateCheckError>(checkForUpdate(throwing, "0.25.0", ENDPOINT));
    expect(netErr.code).toBe("network_error");
  });

  it("surfaces a malformed manifest as manifest_invalid", async () => {
    for (const body of [
      "<html>",
      '{"version":"nope","platforms":{}}',
      '{"version":"1.0.0","pub_date":"soon","platforms":{}}',
    ]) {
      const { fetch } = fakeFetch({ [ENDPOINT]: ok(body) });
      const err = await rejectsWith<UpdateCheckError>(checkForUpdate(fetch, "0.25.0", ENDPOINT));
      expect(err.code, body).toBe("manifest_invalid");
    }
  });
});

// --------------------------------------------------------- download + verify

describe("downloadAndVerify", () => {
  const fixture = signedFixture();
  const entry = { url: PAYLOAD_URL, signature: fixture.signatureB64 };

  it("returns the payload when the signature is genuine", async () => {
    const { fetch } = fakeFetch({ [PAYLOAD_URL]: () => new Response(fixture.payload, { status: 200 }) });
    const got = await downloadAndVerify(fetch, entry, fixture.pubkeyB64);
    expect(got.equals(fixture.payload)).toBe(true);
  });

  it("throws on a single tampered byte", async () => {
    const tampered = Buffer.from(fixture.payload);
    tampered[10] = tampered[10]! ^ 0xff;
    const { fetch } = fakeFetch({ [PAYLOAD_URL]: () => new Response(tampered, { status: 200 }) });
    await expect(downloadAndVerify(fetch, entry, fixture.pubkeyB64)).rejects.toThrow(MinisignError);
  });

  it("throws when the payload is signed by a different key", async () => {
    const other = signedFixture();
    const { fetch } = fakeFetch({ [PAYLOAD_URL]: () => new Response(fixture.payload, { status: 200 }) });
    await expect(
      downloadAndVerify(fetch, { url: PAYLOAD_URL, signature: other.signatureB64 }, fixture.pubkeyB64),
    ).rejects.toThrow(MinisignError);
  });

  it("rejects a payload over the size ceiling, by header and by actual length", async () => {
    const byHeader = fakeFetch({
      [PAYLOAD_URL]: () =>
        new Response(fixture.payload, {
          status: 200,
          headers: { "content-length": String(MAX_PAYLOAD_BYTES + 1) },
        }),
    });
    const headerErr = await rejectsWith<UpdateDownloadError>(
      downloadAndVerify(byHeader.fetch, entry, fixture.pubkeyB64),
    );
    expect(headerErr.code).toBe("too_large");

    const byLength = fakeFetch({ [PAYLOAD_URL]: () => new Response(fixture.payload, { status: 200 }) });
    const lengthErr = await rejectsWith<UpdateDownloadError>(
      downloadAndVerify(byLength.fetch, entry, fixture.pubkeyB64, 10),
    );
    expect(lengthErr.code).toBe("too_large");
  });

  it("reports an HTTP failure with its own error type", async () => {
    const { fetch } = fakeFetch({});
    const httpErr = await rejectsWith<UpdateDownloadError>(
      downloadAndVerify(fetch, entry, fixture.pubkeyB64),
    );
    expect(httpErr.code).toBe("http_error");
  });

  it("reports a payload network failure with its own error type", async () => {
    const offline: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const error = await rejectsWith<UpdateDownloadError>(downloadAndVerify(offline, entry, fixture.pubkeyB64));
    expect(error.code).toBe("network_error");
    expect(error.message).toContain("ECONNRESET");
  });
});

// ------------------------------------------------------- security invariant

describe("performUpdate", () => {
  /** Install deps that record every call, so a test can assert the pipeline was
   * not merely unsuccessful but never entered. */
  function spyInstall(bundleVersion = "9.0.0") {
    const calls: string[] = [];
    const deps: InstallDeps = {
      fs: {
        mkdtemp: async (p) => {
          calls.push("mkdtemp");
          return `/tmp/${p}1`;
        },
        rm: async () => {
          calls.push("rm");
        },
        rename: async () => {
          calls.push("rename");
        },
        pathExists: async () => true,
        touch: async () => {
          calls.push("touch");
        },
      },
      proc: {
        run: async (cmd, args) => {
          calls.push(`run:${path.basename(cmd)}`);
          // `plutil -extract <key> raw -o - <plist>` — answer per key, the way a
          // real Info.plist does. A single canned answer for every key would let
          // the identity gate "pass" on a bundle that never declared anything.
          if (args[0] === "-extract") {
            const plist: Record<string, string> = {
              CFBundleExecutable: "Arcelle",
              CFBundleIdentifier: "com.benreich.privateroom",
              CFBundleShortVersionString: bundleVersion,
            };
            const key = args[1]!;
            if (!Object.hasOwn(plist, key)) throw new Error(`plutil exited 1: no value at ${key}`);
            return plist[key]!;
          }
          return "";
        },
        spawnDetached: () => calls.push("spawn"),
      },
      quit: () => calls.push("quit"),
    };
    return { deps, calls };
  }

  const execPath = "/Applications/Arcelle.app/Contents/MacOS/arcelle";

  it("runs the whole flow on a genuine payload", async () => {
    const fixture = signedFixture();
    const { fetch } = fakeFetch({
      [ENDPOINT]: ok(manifestJson(fixture)),
      [PAYLOAD_URL]: () => new Response(fixture.payload, { status: 200 }),
    });
    const { deps, calls } = spyInstall();
    const write = vi.fn(async () => "/tmp/payload.tar.gz");

    const outcome = await performUpdate(
      { fetchImpl: fetch, writeVerifiedPayload: write, install: deps, execPath },
      "0.25.0",
      ENDPOINT,
      fixture.pubkeyB64,
    );
    expect(outcome).toEqual({ updated: true, version: "9.0.0" });
    expect(write).toHaveBeenCalledOnce();
    expect(calls).toContain("run:tar");
    expect(calls).toContain("spawn");
    expect(calls).toContain("quit");
  });

  it("SECURITY INVARIANT: passes the REAL running version to the identity gate", async () => {
    // The downgrade-replay vector: the manifest is unsigned, so it can claim
    // 9.0.0 while pointing at a genuinely signed OLD release. The signature
    // verifies -- it really was signed. Only the payload's own signed
    // Info.plist version catches it, and only if performUpdate hands the gate
    // the version this process is ACTUALLY running rather than some constant.
    const fixture = signedFixture();
    const { fetch } = fakeFetch({
      [ENDPOINT]: ok(manifestJson(fixture)),
      [PAYLOAD_URL]: () => new Response(fixture.payload, { status: 200 }),
    });
    const { deps, calls } = spyInstall("0.24.0");

    const err = await rejectsWith<InstallError>(
      performUpdate(
        {
          fetchImpl: fetch,
          writeVerifiedPayload: async () => "/tmp/payload.tar.gz",
          install: deps,
          execPath,
        },
        "0.25.0",
        ENDPOINT,
        fixture.pubkeyB64,
      ),
    );
    expect(err.code).toBe("bundle_identity_rejected");
    expect(err.message).toMatch(/"0\.24\.0".*not newer.*"0\.25\.0"/s);
    // The old app was never displaced and the replacement never launched.
    expect(calls).not.toContain("rename");
    expect(calls).not.toContain("spawn");
    expect(calls).not.toContain("quit");
  });

  it("SECURITY INVARIANT: a tampered payload makes install and relaunch UNREACHABLE", async () => {
    // Not "also errors somewhere" — nothing in the install pipeline may run at
    // all, and the bytes must never even be written to disk.
    const fixture = signedFixture();
    const tampered = Buffer.from(fixture.payload);
    tampered[0] = tampered[0]! ^ 0x01;
    const { fetch } = fakeFetch({
      [ENDPOINT]: ok(manifestJson(fixture)),
      [PAYLOAD_URL]: () => new Response(tampered, { status: 200 }),
    });
    const { deps, calls } = spyInstall();
    const write = vi.fn(async () => "/tmp/payload.tar.gz");

    await expect(
      performUpdate(
        { fetchImpl: fetch, writeVerifiedPayload: write, install: deps, execPath },
        "0.25.0",
        ENDPOINT,
        fixture.pubkeyB64,
      ),
    ).rejects.toThrow(MinisignError);

    expect(write).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("SECURITY INVARIANT: a manifest signed by the wrong key installs nothing", async () => {
    // The manifest is unsigned, so whoever serves it controls `signature` and
    // `url` alike. Only the payload check stands between that and an install.
    const real = signedFixture();
    const attacker = signedFixture(Buffer.from("malware"));
    const { fetch } = fakeFetch({
      [ENDPOINT]: ok(manifestJson(attacker)),
      [PAYLOAD_URL]: () => new Response(attacker.payload, { status: 200 }),
    });
    const { deps, calls } = spyInstall();
    const write = vi.fn(async () => "/tmp/payload.tar.gz");

    await expect(
      performUpdate(
        { fetchImpl: fetch, writeVerifiedPayload: write, install: deps, execPath },
        "0.25.0",
        ENDPOINT,
        real.pubkeyB64, // the app's pinned key, not the attacker's
      ),
    ).rejects.toThrow(MinisignError);
    expect(write).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("stops early, without downloading, when there is nothing newer", async () => {
    const fixture = signedFixture();
    const { fetch, seen } = fakeFetch({ [ENDPOINT]: ok(manifestJson(fixture, "0.1.0")) });
    const { deps, calls } = spyInstall();

    const outcome = await performUpdate(
      {
        fetchImpl: fetch,
        writeVerifiedPayload: async () => "/tmp/x",
        install: deps,
        execPath,
      },
      "0.25.0",
      ENDPOINT,
      fixture.pubkeyB64,
    );
    expect(outcome).toEqual({ updated: false, reason: "not_newer" });
    expect(seen).toHaveLength(1); // manifest only — the payload was never fetched
    expect(calls).toEqual([]);
  });
});
