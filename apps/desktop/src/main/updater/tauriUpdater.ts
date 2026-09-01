/**
 * The Tauri-compatible bridge updater — top-level orchestration tying
 * `updateManifest.ts` (fetch, parse, decide), `minisignVerify.ts`
 * (authenticate) and `installBundle.ts` (extract, install, relaunch) into the
 * same check → download → verify → install flow `tauri-plugin-updater` 2.10.1
 * runs client-side.
 *
 * WHY THIS EXISTS. The bridge release has to be checkable and installable by
 * users still running the CURRENT Tauri build: their updater polls
 * `releases/latest/download/latest.json` with its own manifest and signature
 * format, and it cannot parse anything else. So the bridge keeps speaking that
 * protocol, reusing the signing key already in place. This module is the client
 * half of it, so a new Electron install and an old Tauri install consume the
 * exact same `latest.json` / `.sig` / `.tar.gz` triplet.
 *
 * THE ONE RULE THIS FILE ENFORCES: {@link downloadAndVerify} calls
 * `verifyManifestSignature` — which THROWS on any failure and never returns a
 * boolean — before its result is usable by anything else. There is no path from
 * a fetched manifest to `installAndRelaunch` that skips a signature check, and
 * the manifest itself is never treated as authenticated (it is served over
 * plain TLS with no signature of its own; only the payload bytes are signed).
 *
 * ---
 *
 * ## Future option: `electron-updater` (documented, deliberately NOT built)
 *
 * `electron-builder`'s standard auto-update library speaks Squirrel.Mac with a
 * `latest-mac.yml` manifest and its own zip/code-signature scheme — a format an
 * existing Tauri client's updater cannot parse. That is precisely why this
 * batch does not use it: the bridge release's whole job is staying legible to
 * installs that have not cut over yet. It also requires Developer ID
 * codesigning (Squirrel.Mac validates the code signature at update time), which
 * this app does not have — it is ad-hoc signed via `scripts/macsign.sh`, so
 * adopting it means buying and installing a Developer ID certificate and
 * notarizing.
 *
 * Switching later is a real and reasonable option. The sequencing matters:
 *   1. ship this minisign triplet for ~3 releases so old installs cross over;
 *   2. add `electron-updater` as the forward mechanism WHILE still publishing
 *      the triplet;
 *   3. only then drop the triplet, documenting manual-DMG recovery for
 *      stragglers.
 * `releases/latest` is global, not per-track: any release that omits the
 * triplet silently 404s every client still on the old protocol — they are not
 * told, they simply stop seeing updates. No `electron-updater` dependency,
 * config or code exists in this batch, by decision.
 *
 * ## Signing stays where it is
 *
 * There is no signing code here or anywhere else in this app, deliberately.
 * Releases are signed by `tauri signer sign` against `~/.tauri/private-room.key`
 * with the key passed only through `TAURI_SIGNING_PRIVATE_KEY` /
 * `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the environment (never argv, where
 * any process running as the same user could read it from `ps`). That key is
 * the one secret that lets someone publish an "Arcelle update" every install
 * would accept, and it must never need to be reachable from this app's runtime.
 */

import { verifyManifestSignature } from "./minisignVerify.js";
import {
  DARWIN_AARCH64_TARGET_KEYS,
  isUpdateAvailable,
  parseUpdateManifest,
  selectPlatformEntry,
  type ManifestPlatformEntry,
  type UpdateManifest,
} from "./updateManifest.js";
import { installAndRelaunch, type InstallDeps } from "./installBundle.js";

/**
 * `src-tauri/tauri.conf.json` → `plugins.updater.endpoints[0]`, verbatim. Not
 * runtime-configurable: interoperating with the legacy updater only works if
 * every install, old and new, reads the same fixed manifest URL. `https` is
 * mandatory — the Rust client refuses plain http outside debug builds, and the
 * manifest's only integrity protection is TLS.
 */
export const TAURI_UPDATE_ENDPOINT =
  "https://github.com/benrben/private-room/releases/latest/download/latest.json";

/**
 * `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`, verbatim: base64 of
 * the whole 2-line minisign public key file for key id `3630018576E29BDA`.
 * Public by construction — a minisign public key is meant to be distributed.
 * The matching PRIVATE key is not in this repo and is never loaded by this app.
 *
 * Changing this value orphans every install made since the v0.3.0 key rotation.
 */
export const TAURI_UPDATE_PUBKEY_B64 =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM2MzAwMTg1NzZFMjlCREEKUldUYW0rSjJoUUV3TnJsd1hocWdMTE9QNDdYdytoOHFRclkxVFJsVkJJRVlzbHNKZlRuU29abmcK";

/** Honest identifier — this client does not impersonate
 * `tauri-plugin-updater/2.10.1`. Nothing in the protocol depends on the UA
 * (GitHub serves the asset either way), and telling the two client families
 * apart in logs is worth more during the bridge window. */
const USER_AGENT = "arcelle-updater/1 (tauri-manifest-compatible)";

/**
 * Generous ceiling on a payload we are willing to buffer. The real v0.25.0
 * asset is 638,568,630 bytes.
 *
 * This is a liveness guard, not an integrity one: the manifest is unsigned, so
 * whoever can serve it can also name a URL, and `arrayBuffer()` would otherwise
 * buffer an unbounded stream until the process dies. `Content-Length` is
 * checked first when present (it can lie or be absent — the plugin does not
 * require it either) and the real length is re-checked after.
 */
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export class UpdateCheckError extends Error {
  constructor(
    public readonly code: "network_error" | "http_error" | "manifest_invalid",
    message: string,
  ) {
    super(message);
    this.name = "UpdateCheckError";
  }
}

export class UpdateDownloadError extends Error {
  constructor(
    public readonly code: "network_error" | "http_error" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "UpdateDownloadError";
  }
}

/** The minimal `fetch`-shaped surface this module needs, so tests inject a fake
 * instead of reaching the network — the same DI shape the rest of this
 * migration's HTTP callers use. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The outcome of a check. Every "no" carries a reason, because "the endpoint
 * said 204", "there is nothing newer" and "there is something newer but no
 * build for this machine" are three different situations and the last one is a
 * packaging bug worth noticing.
 */
export type CheckResult =
  | { available: false; reason: "no_content" }
  | { available: false; reason: "not_newer" | "no_matching_target"; manifest: UpdateManifest }
  | { available: true; manifest: UpdateManifest; platform: ManifestPlatformEntry };

/**
 * Fetch and parse `latest.json`, then decide whether it names a newer,
 * installable version for this machine. Never downloads or verifies the payload
 * — a check is meant to be cheap.
 *
 * The real client logs a non-2xx and skips the endpoint, which is why a release
 * that forgets the triplet strands old installs silently rather than alerting
 * them. This throws {@link UpdateCheckError} instead, one layer further in: a
 * caller here (unlike a caller of the Rust plugin) has no other way to tell
 * "checked, nothing newer" from "the request failed" if both collapsed into the
 * same value. Catch and downgrade at the call site to get silent-skip semantics
 * end to end.
 */
export async function checkForUpdate(
  fetchImpl: FetchLike,
  currentVersion: string,
  endpoint: string = TAURI_UPDATE_ENDPOINT,
  targetKeys?: readonly string[],
): Promise<CheckResult> {
  const response = await updateManifestResponse(fetchImpl, endpoint);
  if (isNoContentUpdateResponse(response, endpoint)) return { available: false, reason: "no_content" };
  const manifest = await parsedUpdateManifest(response, endpoint);
  return updateManifestResult(manifest, currentVersion, targetKeys ?? DARWIN_AARCH64_TARGET_KEYS);
}

async function updateManifestResponse(fetchImpl: FetchLike, endpoint: string): Promise<Response> {
  try {
    return await fetchImpl(endpoint, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      redirect: "follow",
    });
  } catch (error) {
    throw new UpdateCheckError("network_error", `could not reach ${endpoint}: ${(error as Error).message}`);
  }
}

function isNoContentUpdateResponse(response: Response, endpoint: string): boolean {
  // 204 is the protocol's explicit "nothing for you" — distinct from a failure.
  if (response.status === 204) return true;
  if (!response.ok) throw new UpdateCheckError("http_error", `${endpoint} returned HTTP ${response.status}`);
  return false;
}

async function parsedUpdateManifest(response: Response, endpoint: string): Promise<UpdateManifest> {
  try {
    return parseUpdateManifest(await response.text());
  } catch (error) {
    throw new UpdateCheckError("manifest_invalid", (error as Error).message);
  }
}

function updateManifestResult(
  manifest: UpdateManifest,
  currentVersion: string,
  targetKeys: readonly string[]
): CheckResult {
  if (!isUpdateAvailable(manifest.version, currentVersion)) {
    return { available: false, reason: "not_newer", manifest };
  }
  const platform = selectPlatformEntry(manifest, targetKeys);
  if (!platform) {
    return { available: false, reason: "no_matching_target", manifest };
  }
  return { available: true, manifest, platform };
}

/**
 * Download `platform.url` in full and verify it against `platform.signature`
 * and `pubkeyB64` BEFORE returning it — replicating `download()`'s ordering:
 * buffer the entire response, verify it, and only then let anything else see
 * it. `verifyManifestSignature` throws on any failure, so there is no path that
 * hands back an unverified buffer.
 */
export async function downloadAndVerify(
  fetchImpl: FetchLike,
  platform: ManifestPlatformEntry,
  pubkeyB64: string = TAURI_UPDATE_PUBKEY_B64,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): Promise<Buffer> {
  let resp: Response;
  try {
    resp = await fetchImpl(platform.url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
  } catch (e) {
    throw new UpdateDownloadError(
      "network_error",
      `could not download ${platform.url}: ${(e as Error).message}`,
    );
  }
  if (!resp.ok) {
    throw new UpdateDownloadError("http_error", `${platform.url} returned HTTP ${resp.status}`);
  }

  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new UpdateDownloadError(
      "too_large",
      `${platform.url} declares ${declared} bytes, over the ${maxBytes}-byte ceiling`,
    );
  }

  const payload = Buffer.from(await resp.arrayBuffer());
  if (payload.length > maxBytes) {
    throw new UpdateDownloadError(
      "too_large",
      `${platform.url} returned ${payload.length} bytes, over the ${maxBytes}-byte ceiling`,
    );
  }

  // Throws MinisignError on any failure. The payload does not get past this
  // line unless every check in minisignVerify.ts passed.
  verifyManifestSignature(payload, platform.signature, pubkeyB64);
  return payload;
}

export interface PerformUpdateDeps {
  fetchImpl: FetchLike;
  /** Persist a VERIFIED payload to a temp `.tar.gz` and return its path —
   * extraction runs `/usr/bin/tar` against a file, not an in-memory buffer. */
  writeVerifiedPayload(payload: Buffer): Promise<string>;
  install: InstallDeps;
  /** This process's own executable path (`process.execPath` in a real Electron
   * main process), used to derive the `/Applications/X.app` target
   * independently of the executable's name. */
  execPath: string;
}

export type PerformUpdateOutcome =
  | { updated: false; reason: "no_content" | "not_newer" | "no_matching_target" }
  | { updated: true; version: string };

/**
 * The full flow: check → (nothing newer? stop) → download + verify → persist →
 * extract, install, relaunch.
 *
 * Everything before "persist" can reject without touching the filesystem, and
 * everything from "persist" onward runs only on bytes that already passed
 * {@link downloadAndVerify}.
 */
export async function performUpdate(
  deps: PerformUpdateDeps,
  currentVersion: string,
  endpoint: string = TAURI_UPDATE_ENDPOINT,
  pubkeyB64: string = TAURI_UPDATE_PUBKEY_B64,
): Promise<PerformUpdateOutcome> {
  const result = await checkForUpdate(deps.fetchImpl, currentVersion, endpoint);
  if (!result.available) return { updated: false, reason: result.reason };

  const payload = await downloadAndVerify(deps.fetchImpl, result.platform, pubkeyB64);
  const tarPath = await deps.writeVerifiedPayload(payload);
  // `currentVersion` is re-checked here against the payload's OWN signed
  // Info.plist, not against the manifest that claimed it. The manifest is
  // unsigned, so `result.manifest.version` is an attacker-influenceable claim
  // and must not be what authorises the install.
  await installAndRelaunch(deps.install, tarPath, deps.execPath, { currentVersion });
  return { updated: true, version: result.manifest.version };
}
