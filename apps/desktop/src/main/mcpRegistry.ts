/**
 * The connector marketplace: search the live MCP registry and normalize its
 * entries into an {@link InstallSpec} the room can install. Ported from
 * `src-tauri/src/commands/mcp_registry.rs`.
 *
 * This is the app's ONLY outbound "phone home", so it is gated behind an
 * explicit per-Mac opt-in file ({@link mcpRegistryOptinFile}): browsing the
 * registry is a network action and the privacy-first product must not do it
 * silently. {@link normalizeServers} is pure, so the shape we depend on is
 * pinned without a network round-trip.
 *
 * PER-MAC, NOT PER-ROOM: the flag lives in the app's own data folder, the same
 * trust model as `mcp_approvals.json` in `mcpConfig.ts` — the room's author is
 * the attacker, so a decision to let this Mac reach the internet must never be
 * able to travel inside a `.roomai` and flip itself on. That also rules out
 * `db-host/settings.ts`'s `getSetting`/`setSetting`, which is the ROOM's
 * settings table. Like every other per-Mac file in this migration, the
 * `userDataDir` is a parameter rather than an `app.getPath('userData')` call
 * here, so this stays a plain testable Node module. The on-disk format is the
 * Rust source's own, NOT `mcpConfig.ts`'s `readMcpFlag`/`writeMcpFlag` JSON
 * boolean: the literal byte `"1"`, and disable DELETES the file — reusing the
 * JSON pair would read an on-disk `"1"` as `false`.
 *
 * Installing an entry does NOT get its own privileged path: the frontend turns
 * an {@link InstallSpec} into the standard `mcpServers` fragment and calls
 * `mcp_apply_config` ({@link applyMcpConfig} in `mcpConfig.ts`, which takes the
 * whole config as JSON text), so the SEC-1 approval + fingerprint gate still
 * fires for anything a marketplace click would start. That conversion is
 * renderer code (`src/settings/McpMarketplace.tsx`'s `specToEntry`), so the one
 * thing this file owes it is the exact `InstallSpec` shape — which is why
 * `InstallSpec`/`CatalogEntry` are IMPORTED from `../shared/apiTypes.ts` rather
 * than redeclared: that module is what `ipc-contract.ts` already types
 * `mcp_registry_search`'s result against, so the boundary shape cannot drift
 * from what the drawer reads (`envKeys`/`headerKeys`, `altInstall: T | null`).
 *
 * NOT PORTED (documented, not silently dropped): the IPC/UI wiring. Rust's
 * three `#[tauri::command]`s are the three exported entry points here
 * ({@link mcpRegistrySearch}, {@link mcpRegistryOptinStatus},
 * {@link setMcpRegistryOptin}); nothing registers them yet, matching the rest
 * of this migration's ported command files.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { checkPublicHttpUrl } from "./browser/guard.js";
import { asStr, at, field, idx, jsonRecord } from "./mcpRegistryJson.js";
import { bodyCappedTo, guardedGet } from "./webFetch.js";
import type { CatalogEntry, InstallSpec } from "../shared/apiTypes.js";

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------ constants

/** The official Model Context Protocol registry's frozen, versioned API.
 * Returns `{ "servers": [...] }`. */
export const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";

/** Production reads occasionally take 20–30 seconds (and have reached roughly
 * 45 seconds during load spikes). Fifteen seconds made every retry fail before
 * a healthy-but-slow response could arrive. */
export const REGISTRY_TIMEOUT_MS = 45_000;

/** Two long attempts cover a transient connection failure without making an
 * actual outage hold the marketplace open for three minutes. */
export const REGISTRY_ATTEMPTS = 2;

/** The minimal shape this file needs from a `fetch` response, so a test can
 * inject a fake without building a real `Response`. The global `fetch`'s
 * `Response` satisfies it structurally. */
export interface RegistryHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** The minimal shape of `fetch` itself, for the same injectable-seam reason. */
export type RegistryFetchFn = (url: string, init?: RequestInit) => Promise<RegistryHttpResponse>;

/**
 * Send a request with a few retries + backoff — the registry endpoint is
 * intermittently slow to establish a connection (the first attempt often fails,
 * a retry succeeds), so a single shot is unreliable. A fresh
 * `AbortController`/timeout is armed per attempt, standing in for Rust's
 * per-attempt `req.try_clone()` (a URL + init are re-usable plain values, not a
 * consumed builder). Faithful to `send_with_retries` down to its one quirk: the
 * backoff after the FINAL failed attempt still runs before the loop exits.
 */
export async function sendWithRetries(
  url: string,
  init: RequestInit,
  fetchFn: RegistryFetchFn = fetch
): Promise<RegistryHttpResponse> {
  let last = "no attempt made";
  for (let attempt = 0; attempt < REGISTRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
    try {
      return await fetchFn(url, { ...init, signal: controller.signal });
    } catch (e) {
      last = e instanceof Error && e.name === "AbortError" ? "the request timed out" : errMessage(e);
      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(last);
}

// ------------------------------------------------------------ normalization

/** ASCII-only lowercasing — Rust's `to_ascii_lowercase`/`eq_ignore_ascii_case`
 * leave every non-ASCII character alone, which JS's `toLowerCase` does not. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Split a reverse-DNS registry id into (publisher, display name). The display
 * name is what follows the slash, unless that's a generic token ("mcp",
 * "server", …), in which case the publisher reads better on the card. Ported
 * from `split_namespace`. */
export function splitNamespace(id: string): [publisher: string, name: string] {
  const slash = id.indexOf("/");
  const ns = slash === -1 ? "" : id.slice(0, slash);
  const rawName = slash === -1 ? id : id.slice(slash + 1);
  const publisher = publisherFromNs(ns);
  const name = isGenericName(rawName) && publisher !== "" ? publisher : rawName;
  return [publisher, name];
}

/** The org from a reverse-DNS namespace. `io.github.<owner>` /
 * `io.gitlab.<owner>` → the owner; otherwise the segment right after the
 * leading TLD (`com.notion` → "notion", `ac.inference.sh` → "inference").
 * Ported from `publisher_from_ns`. */
function publisherFromNs(ns: string): string {
  const segs = ns.split(".").filter((s) => s !== "");
  const hostedPublisher = hostedNamespacePublisher(segs);
  return hostedPublisher ?? segs[1] ?? segs[0] ?? "";
}

function hostedNamespacePublisher(segs: readonly string[]): string | null {
  const [tld, host, owner] = segs;
  const isHosted = tld === "io" && (host === "github" || host === "gitlab");
  return isHosted && owner !== undefined ? owner : null;
}

const GENERIC_NAMES = new Set(["mcp", "server", "mcp-server", "mcpserver", "mcp_server", "main", "app", "index"]);

/** A display name too generic to identify the server on its own. Ported from
 * `is_generic_name`. */
function isGenericName(name: string): boolean {
  return GENERIC_NAMES.has(asciiLower(name));
}

/** The registry's trust signal: does the publisher (namespace owner) also own
 * the source repository? `io.github.microsoft/*` published from
 * `github.com/microsoft/*` proves control of the namespace. Ported from
 * `namespace_owns_repo`. */
export function namespaceOwnsRepo(publisher: string, repo: string | null): boolean {
  if (publisher === "" || repo === null) return false;
  // The owner is the path segment right after the host in a repo URL.
  const schemeEnd = repo.indexOf("://");
  const rest = schemeEnd === -1 ? repo : repo.slice(schemeEnd + 3);
  const owner = rest.split("/")[1] ?? "";
  return owner !== "" && asciiLower(owner) === asciiLower(publisher);
}

/** Default args for a known runner + package name. Ported from `runner_args`. */
function runnerArgs(runner: string, pkg: string): string[] {
  if (runner === "npx") return ["-y", pkg];
  if (runner === "docker") return ["run", "-i", "--rm", pkg];
  // uvx / uv / pipx / bunx: just the package.
  return [pkg];
}

/** Collect `name` fields from an array of `{name, ...}` records (used for env
 * vars and header hints). Empty for anything else. Ported from `named_keys`. */
function namedKeys(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const e of v) {
    const name = asStr(idx(e, "name"));
    if (name !== null) out.push(name);
  }
  return out;
}

/** Turn a package record into a runnable command. Honors an explicit
 * `runtimeHint`, else maps the registry type to its usual runner. Accepts both
 * the current schema (`identifier`/`registryType`/`runtimeHint`) and older
 * snake_case (`name`/`registry_name`/`runtime_hint`). Ported from
 * `derive_stdio`. */
function stdioRunner(runtimeHint: string, registryType: string): string {
  if (runtimeHint !== "") return runtimeHint;
  if (registryType === "pypi") return "uvx";
  return registryType === "oci" || registryType === "docker" ? "docker" : "npx";
}

function deriveStdio(p: unknown): InstallSpec | null {
  const pkg = asStr(field(p, ["identifier", "name"]));
  if (pkg === null) return null;
  const registry = asStr(field(p, ["registryType", "registry_name"])) ?? "";
  const hint = asStr(field(p, ["runtimeHint", "runtime_hint"])) ?? "";
  const command = stdioRunner(hint, registry);
  return {
    kind: "stdio",
    command,
    args: runnerArgs(command, pkg),
    envKeys: namedKeys(field(p, ["environmentVariables", "environment_variables"])),
  };
}

/** Is this an endpoint we can actually install and show? Registry records are
 * unchecked third-party text, and a listing whose `url` is missing its scheme
 * (or isn't http(s) at all) is not installable — worse, the details drawer
 * parses it with `new URL(...)`, so one malformed catalogue entry took the whole
 * window blank. Skipping the record is the honest outcome. Ported from
 * `is_installable_endpoint`. */
export function isInstallableEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "";
}

/** The remote endpoint install, if the record declares one. Ported from
 * `derive_remote`. */
function deriveRemote(s: unknown): InstallSpec | null {
  const r = at(s, "remotes", 0);
  const url = asStr(idx(r, "url"));
  if (url === null || !isInstallableEndpoint(url)) return null;
  return { kind: "http", url, headerKeys: namedKeys(idx(r, "headers")) };
}

function remoteTransport(s: unknown): string {
  const t = asStr(field(at(s, "remotes", 0), ["type", "transport_type"])) ?? "http";
  return t === "sse" ? "sse" : "http"; // streamable-http / http / anything else
}

/**
 * Resolve how a connector installs, returning `[primary, alternative]`.
 *
 * PRIVACY FIRST: when a record offers BOTH a local package and a remote
 * endpoint (many do — e.g. run the `uvx` package on your Mac *or* hit the
 * vendor's hosted server), the primary is the LOCAL one so nothing leaves the
 * Mac by default, and the remote is returned as the alternative the drawer can
 * offer ("use the cloud version"). This reverses the earlier remote-first
 * choice, which had us install a vendor's (sometimes dead) hosted host over a
 * perfectly good local package. When only one transport exists it's the primary
 * and there's no alternative. `null` only when neither is derivable. Ported from
 * `derive_installs`.
 */
function deriveInstalls(s: unknown): [InstallSpec, InstallSpec | null] | null {
  const local = deriveStdio(at(s, "packages", 0));
  const remote = deriveRemote(s);
  if (local !== null && remote !== null) return [local, remote]; // both → local default, cloud alt
  if (local !== null) return [local, null];
  if (remote !== null) return [remote, null];
  return null;
}

function serverValue(entry: unknown): unknown {
  // The current registry wraps each item: `{ "server": {...}, "_meta": {...} }`.
  // Older docs put the fields at the top level, so fall back to the item.
  // `hasOwnProperty`-checked rather than "is it usable": Rust's
  // `.get("server").is_some()` is true for an explicit `"server": null` too, and
  // that record must come out empty rather than quietly reading the envelope's
  // own fields instead.
  const record = jsonRecord(entry);
  return record !== null && Object.prototype.hasOwnProperty.call(record, "server")
    ? idx(record, "server")
    : entry;
}

type InstallDetails = Pick<CatalogEntry, "install" | "altInstall" | "remote" | "transport">;

function installDetails(s: unknown): InstallDetails | null {
  const installs = deriveInstalls(s);
  if (installs === null) return null;
  const [install, altInstall] = installs;
  const remote = install.kind === "http";
  return { install, altInstall, remote, transport: remote ? remoteTransport(s) : "stdio" };
}

function entryTitle(s: unknown): string | null {
  const title = asStr(idx(s, "title"))?.trim() ?? "";
  return title === "" ? null : title;
}

function catalogEntry(
  s: unknown,
  id: string,
  publisher: string,
  name: string,
  details: InstallDetails,
): CatalogEntry {
  const repository = asStr(at(s, "repository", "url"));
  return {
    id,
    name,
    title: entryTitle(s),
    // The raw icon URL; `inlineIcons` later replaces it with a data: URI (or
    // clears it) since the CSP won't load a remote image.
    icon: asStr(at(s, "icons", 0, "src")),
    description: asStr(idx(s, "description")) ?? "",
    publisher,
    verified: namespaceOwnsRepo(publisher, repository),
    repository,
    ...details,
  };
}

function normalizeOne(entry: unknown): CatalogEntry | null {
  const s = serverValue(entry);

  const id = asStr(idx(s, "name"));
  if (id === null) return null;
  const [publisher, name] = splitNamespace(id);
  const details = installDetails(s);
  return details === null ? null : catalogEntry(s, id, publisher, name, details);
}

/** Normalize a whole `{"servers": [...]}` registry payload. Tolerant: a record
 * we can't derive an install for (no packages, no remotes) is skipped rather
 * than failing the whole search. Ported from `normalize_servers`. */
export function normalizeServers(payload: unknown): CatalogEntry[] {
  const servers = idx(payload, "servers");
  // The registry lists a server once per published version, so the same `id`
  // recurs — keep the first (newest) and drop the rest, or the grid shows three
  // identical cards.
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const raw of Array.isArray(servers) ? servers : []) {
    const e = normalizeOne(raw);
    if (e === null || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

// -------------------------------------------------------------------- icons

/**
 * Is this icon address one we are willing to open a connection to?
 *
 * The URL comes from a registry record a stranger published, so it is exactly
 * the shape the fetch tool's guard exists for: `http://127.0.0.1:11434/api/tags`
 * or `http://192.168.1.1/` would otherwise be GET'd by the app, from inside the
 * user's network, just for browsing the marketplace. Ported from
 * `icon_url_allowed`, over the same guard Rust reuses
 * (`crate::web::check_public_http_url`).
 */
export function iconUrlAllowed(url: string): boolean {
  try {
    checkPublicHttpUrl(url);
    return true;
  } catch {
    return false;
  }
}

/** Skip anything too big to sit inline in a data URI. Ported from `fetch_icon`'s
 * own cap, which is the card icon's budget and NOT `webFetch.ts`'s 200 KB
 * result-preview budget — the reason this fetches through `guardedGet` directly
 * instead of calling `fetchImage`. */
const ICON_MAX_BYTES = 300_000;
const ICON_TOO_LARGE = "The icon is larger than a card can inline.";

/**
 * Rust gives each icon a 6-second request budget, which is what keeps one
 * unreachable icon host from holding a whole browse open. `guardedGet` owns its
 * socket and takes no abort signal, so the budget here is a race rather than a
 * cancellation: the abandoned request still ends on its own (per-hop timeout,
 * byte cap) and its result is dropped.
 */
const ICON_BUDGET_MS = 6_000;

function contentType(headers: IncomingHttpHeaders): string {
  const raw = headers["content-type"];
  const value = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  return value.split(";")[0]?.trim() ?? "";
}

async function fetchIconOnce(url: string): Promise<string | null> {
  // `guardedGet` re-runs the literal-address check AND re-resolves + pins every
  // redirect hop. Rust's icon client could only manage the literal half (a
  // `redirect::Policy` closure must answer synchronously, so it cannot await a
  // DNS lookup); this side has no such constraint, and `browser/guard.ts` says
  // in writing that the check-without-pinning variant is strictly weaker.
  const resp = await guardedGet(url);
  const mime = contentType(resp.headers);
  if (!mime.startsWith("image/")) {
    resp.stream.resume();
    resp.stream.destroy();
    return null;
  }
  const bytes = await bodyCappedTo(resp, ICON_MAX_BYTES, false, ICON_TOO_LARGE);
  if (bytes.length === 0) return null;
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Fetch one icon and return it as a `data:` URI, or `null` on any problem.
 * Best-effort: only public http(s) image responses under the size cap are
 * inlined. Ported from `fetch_icon` + `icon_client`. */
export async function fetchIcon(url: string): Promise<string | null> {
  if (!iconUrlAllowed(url)) return null;
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ICON_BUDGET_MS);
  });
  try {
    return await Promise.race([fetchIconOnce(url).catch(() => null), budget]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many icon hosts we are willing to be talking to at the same instant.
 *
 * Unbounded was one connection per listing — a 200-result browse opened 200
 * simultaneous connections to 200 different companies, each of which sees the
 * user's IP. This is the app's only fan-out to strangers, so it goes in small
 * waves instead.
 */
export const ICON_CONCURRENCY = 6;

/** The wave loop itself, over an injected fetch — so the bound that keeps this
 * off 200 strangers at once, and the wave-by-wave write-back that has to keep
 * each icon with its own listing, are both testable without a network. Mutates
 * `entries` in place, matching Rust's `&mut [CatalogEntry]`. Ported from
 * `inline_icons_with`. */
export async function inlineIconsWith(
  entries: CatalogEntry[],
  fetchOne: (url: string) => Promise<string | null>
): Promise<void> {
  for (let start = 0; start < entries.length; start += ICON_CONCURRENCY) {
    const wave = entries.slice(start, start + ICON_CONCURRENCY);
    const results = await Promise.all(wave.map((e) => (e.icon !== null ? fetchOne(e.icon) : Promise.resolve(null))));
    wave.forEach((e, i) => {
      e.icon = results[i] ?? null;
    });
  }
}

/** Replace each entry's raw icon URL with an inlined `data:` URI (or clear it),
 * so the webview never contacts an icon host and the CSP stays intact. Ported
 * from `inline_icons`. */
export async function inlineIcons(entries: CatalogEntry[]): Promise<void> {
  await inlineIconsWith(entries, fetchIcon);
}

// ---------------------------------------------------------------- opt-in gate

/** PRIV: the registry opt-in lives in the app's own data folder (per-Mac, never
 * inside a room file) — see this file's header. Ported from
 * `registry_optin_file`, minus its per-call `create_dir_all`: Electron's
 * `userData` directory exists by the time anything here runs, and every other
 * per-Mac path builder in this migration (`mcpConfig.ts`'s `mcpApprovalsFile`)
 * stays pure and leaves the `mkdir` to the write. */
export function mcpRegistryOptinFile(userDataDir: string): string {
  return path.join(userDataDir, "mcp_registry_optin");
}

function readFileIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Whether the user has turned on registry browsing (the outbound fetch).
 * Ported from `mcp_registry_optin_status`/`registry_opted_in`. */
export function mcpRegistryOptinStatus(userDataDir: string): boolean {
  const raw = readFileIfExists(mcpRegistryOptinFile(userDataDir));
  return raw !== null && raw.trim() === "1";
}

/** Turn registry browsing on or off. On = the app may reach the registry to list
 * connectors; off deletes the flag so it's air-gapped again. Ported from
 * `set_mcp_registry_optin`: the literal byte `"1"`, and a delete (not a `"0"`)
 * on disable. */
export function setMcpRegistryOptin(userDataDir: string, enabled: boolean): void {
  const file = mcpRegistryOptinFile(userDataDir);
  if (enabled) {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(file, "1");
    return;
  }
  try {
    rmSync(file, { force: true });
  } catch {
    // Rust: `let _ = std::fs::remove_file(path);` — off is off either way.
  }
}

// -------------------------------------------------------------------- search

/** Injected dependencies for {@link mcpRegistrySearch}, so a test never touches
 * the real network. Production callers pass nothing. */
export interface McpRegistrySearchDeps {
  fetchFn?: RegistryFetchFn;
  fetchIconFn?: (url: string) => Promise<string | null>;
}

function registrySearchUrl(query: string | undefined, limit: number | undefined): string {
  // Rust's `limit` is a `usize`, so a negative number cannot reach its `.min(200)`
  // at all; the floor is what stands in for that here.
  const n = Math.max(0, Math.min(limit ?? 80, 200));
  const params = new URLSearchParams({ limit: String(n) });
  const trimmed = query?.trim();
  if (trimmed) params.set("search", trimmed);
  return `${REGISTRY_URL}?${params.toString()}`;
}

async function registryResponse(
  url: string,
  fetchFn: RegistryFetchFn | undefined,
): Promise<RegistryHttpResponse> {
  try {
    return await sendWithRetries(url, { headers: { Accept: "application/json" } }, fetchFn);
  } catch (e) {
    throw new Error(
      `The connector registry did not respond after two attempts (${errMessage(e)}). ` +
        "The official registry may be busy; check your internet connection or try again shortly."
    );
  }
}

async function registryPayload(response: RegistryHttpResponse): Promise<unknown> {
  if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch (e) {
    throw new Error(`Registry sent a reply we couldn't read: ${errMessage(e)}`);
  }
}

/**
 * Search the live registry and return normalized listings. Throws (surfaced to
 * the UI) when browsing is off — the frontend then shows the opt-in gate.
 *
 * `query` filters SERVER-SIDE via the registry's own `search` param: the catalog
 * has far more servers than one page, so filtering a fixed page client-side
 * would miss most matches (e.g. "yahoo" lives past the first page). No query →
 * browse the newest `limit` servers. Ported from `mcp_registry_search`.
 */
export async function mcpRegistrySearch(
  userDataDir: string,
  query?: string,
  limit?: number,
  deps: McpRegistrySearchDeps = {}
): Promise<CatalogEntry[]> {
  if (!mcpRegistryOptinStatus(userDataDir)) {
    throw new Error("Browsing the connector registry reaches the internet. Turn it on to search.");
  }
  const response = await registryResponse(registrySearchUrl(query, limit), deps.fetchFn);
  const payload = await registryPayload(response);
  const entries = normalizeServers(payload);
  // Icons go out on their own path: the registry's own address is ours and may
  // redirect freely, but these URLs are attacker-chosen and every hop of theirs
  // is re-checked.
  await inlineIconsWith(entries, deps.fetchIconFn ?? fetchIcon);
  return entries;
}
