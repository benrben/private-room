/**
 * `latest.json` parsing, version comparison and platform-target selection for
 * the Tauri-compatible bridge updater — a faithful port of
 * `tauri-plugin-updater` 2.10.1's HAND-WRITTEN `Deserialize for RemoteRelease`
 * (`updater.rs:1383-1429`), its `parse_version` helper, and its `get_urls`
 * target-key walk (`updater.rs:567-596`).
 *
 * Both a legacy Tauri client and this Electron client have to agree on what a
 * manifest MEANS, or a manifest that satisfies one and not the other silently
 * strands whichever disagrees. So the rules here are matched to the Rust in
 * both directions — too strict rejects a release a Tauri client would take;
 * too loose accepts a shape the Rust parser refuses, which matters the moment
 * this module is used to validate a manifest before publishing it (a mistake
 * there fails ALL users, not just this one).
 *
 * THE MANIFEST IS NOT AUTHENTICATED. Only TLS protects it — no field here is
 * covered by any signature, including `version` and the per-platform `url`.
 * Never write logic that treats a manifest field as trusted; the payload
 * signature (`minisignVerify.ts`, run before a single byte is used) is the only
 * integrity boundary in this protocol.
 */

/** One platform's payload location + whole-`.sig`-file signature. */
export interface ManifestPlatformEntry {
  url: string;
  signature: string;
}

/**
 * A parsed `latest.json`. The two shapes are mutually exclusive in the Rust
 * parser and stay so here rather than being flattened behind a synthetic key:
 * `platforms` present ⇒ Static (top-level `url`/`signature` ignored);
 * `platforms` absent ⇒ Dynamic, where the server already resolved the target
 * and both top-level fields become required. This app only ever PUBLISHES the
 * Static form.
 */
export type UpdateManifest = {
  /** `trim_start_matches('v')` applied, otherwise verbatim. */
  version: string;
  notes?: string;
  pubDate?: string;
} & (
  | { form: "static"; platforms: Map<string, ManifestPlatformEntry> }
  | { form: "dynamic"; platform: ManifestPlatformEntry }
);

export class ManifestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestParseError";
  }
}

// ------------------------------------------------------------------ semver

/** Canonical SemVer 2.0.0 regex from semver.org, used verbatim. The Rust side
 * parses with the `semver` crate, which enforces the same grammar (numeric
 * identifiers without leading zeros, non-empty dot-separated prerelease and
 * build identifiers drawn from `[0-9A-Za-z-]`). */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated identifiers in order; `[]` means "no prerelease", which has
   * HIGHER precedence than any prerelease of the same `major.minor.patch`. */
  prerelease: string[];
}

/**
 * `trim_start_matches('v')` — Rust trims EVERY leading `v`, not just one, so
 * `"vv1.2.3"` parses as `1.2.3` there and must here too.
 */
export function trimLeadingV(input: string): string {
  let i = 0;
  while (i < input.length && input[i] === "v") i++;
  return input.slice(i);
}

/**
 * Strict SemVer 2.0.0 parse of an ALREADY-`v`-trimmed string. Throws on
 * anything the `semver` crate would reject, because "non-semver ⇒ the whole
 * manifest fails" is the real client's behaviour, not a warning it recovers
 * from.
 */
export function parseSemVer(input: string): SemVer {
  const m = SEMVER_RE.exec(input);
  if (!m) throw new ManifestParseError(`not a valid semver version: ${JSON.stringify(input)}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split("."),
  };
}

/** Numeric identifiers are those made only of digits — already known to have no
 * leading zero, since {@link parseSemVer} rejected those. */
const ALL_DIGITS_RE = /^\d+$/;

function compareIdentifier(a: string, b: string): number {
  const aNum = ALL_DIGITS_RE.test(a);
  const bNum = ALL_DIGITS_RE.test(b);
  if (aNum && bNum) return compareNumericIdentifier(a, b);
  return compareMixedOrTextIdentifier(a, b, aNum, bNum);
}

function compareNumericIdentifier(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (an === bn) return 0;
  return an < bn ? -1 : 1;
}

function compareMixedOrTextIdentifier(a: string, b: string, aNum: boolean, bNum: boolean): number {
  // SemVer §11.4.3: numeric identifiers always have LOWER precedence than
  // alphanumeric ones.
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer 2.0.0 precedence (§11). Build metadata is ignored entirely, matching
 * both the spec and the `semver` crate's `Ord`. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  const core = compareSemVerCore(a, b);
  if (core !== 0) return core;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function compareSemVerCore(a: SemVer, b: SemVer): number {
  const pairs: ReadonlyArray<readonly [number, number]> = [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ];
  for (const [left, right] of pairs) {
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function prereleaseAbsenceResult(a: string[], b: string[]): number {
  // §11.3: a prerelease has LOWER precedence than the same core version without.
  if (a.length === 0 && b.length > 0) return 1;
  if (a.length > 0 && b.length === 0) return -1;
  return 0;
}

function comparePrereleaseIdentifiers(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined) return -1; // fewer identifiers ⇒ lower precedence
    if (bi === undefined) return 1;
    const c = compareIdentifier(ai, bi);
    if (c !== 0) return c;
  }
  return 0;
}

function comparePrerelease(a: string[], b: string[]): number {
  const absence = prereleaseAbsenceResult(a, b);
  if (absence !== 0 || a.length === 0) return absence;
  return comparePrereleaseIdentifiers(a, b);
}

/**
 * `should_update = release.version > current_version`, exactly — strict
 * greater-than over parsed semver, with the same leading-`v` trim applied to
 * both sides. Throws {@link ManifestParseError} if either side is not semver.
 */
export function isUpdateAvailable(manifestVersion: string, currentVersion: string): boolean {
  const manifest = parseSemVer(trimLeadingV(manifestVersion));
  const current = parseSemVer(trimLeadingV(currentVersion));
  return compareSemVer(manifest, current) > 0;
}

// ----------------------------------------------------------------- rfc 3339

const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return isThirtyDayMonth(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isThirtyDayMonth(month: number): boolean {
  return month === 4 || month === 6 || month === 9 || month === 11;
}

/**
 * RFC 3339 `date-time` validation, including calendar validity.
 *
 * This is a HARD failure in the real client, not a soft one: `pub_date` is fed
 * to `OffsetDateTime::parse(.., Rfc3339)` and any error is mapped to
 * `DeError::custom`, which fails the WHOLE manifest — so a badly-formatted date
 * means no update for anyone, not merely a missing date. A shape check alone
 * would pass `2026-13-45T99:99:99Z`, which Rust rejects; a `Date.parse` check
 * alone would pass `2026-02-30T00:00:00Z`, which JavaScript silently rolls over
 * to March 2nd and Rust also rejects. Hence explicit component ranges.
 *
 * Second `60` is allowed (RFC 3339 permits a leap second) — being marginally
 * more permissive than the Rust parser here can only ever mean accepting a date
 * our own release script would never emit.
 */
export function isValidRfc3339(s: string): boolean {
  const parts = parseRfc3339Parts(s);
  return parts !== null && hasValidRfc3339DateTime(parts) && hasValidRfc3339Offset(parts);
}

interface Rfc3339Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetHour: number | null;
  offsetMinute: number | null;
}

function parseRfc3339Parts(value: string): Rfc3339Parts | null {
  const match = RFC3339_RE.exec(value);
  if (match === null) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    offsetHour: match[7] === undefined ? null : Number(match[8]),
    offsetMinute: match[7] === undefined ? null : Number(match[9]),
  };
}

function hasValidRfc3339DateTime(parts: Rfc3339Parts): boolean {
  return hasValidRfc3339CalendarDate(parts) && hasValidRfc3339Clock(parts);
}

function hasValidRfc3339CalendarDate(parts: Rfc3339Parts): boolean {
  if (parts.month < 1) return false;
  if (parts.month > 12) return false;
  if (parts.day < 1) return false;
  return parts.day <= daysInMonth(parts.year, parts.month);
}

function hasValidRfc3339Clock(parts: Rfc3339Parts): boolean {
  if (parts.hour > 23) return false;
  if (parts.minute > 59) return false;
  return parts.second <= 60;
}

function hasValidRfc3339Offset(parts: Rfc3339Parts): boolean {
  if (parts.offsetHour === null || parts.offsetMinute === null) return true;
  return parts.offsetHour <= 23 && parts.offsetMinute <= 59;
}

// ---------------------------------------------------------------- manifest

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read one field of a parsed-JSON object by a FIXED name, without ever falling
 * through to `Object.prototype`. `JSON.parse` creates `__proto__` as an own
 * data property, so a hostile manifest can carry keys that shadow or resolve
 * against the prototype chain; own-property-only reads make the whole class of
 * question moot.
 */
function field(obj: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(obj, name) ? obj[name] : undefined;
}

/** serde maps JSON `null` to `None` for an `Option<T>`, so a null field is
 * "absent", not "present and wrong". */
function isAbsent(v: unknown): boolean {
  return v === undefined || v === null;
}

function requireUrl(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ManifestParseError(`manifest ${label} must be a string url`);
  }
  try {
    // Rust types this field as `Url`, so an unparseable value fails the whole
    // manifest at deserialize time.
    new URL(value);
  } catch {
    throw new ManifestParseError(`manifest ${label} is not a parseable url: ${JSON.stringify(value)}`);
  }
  return value;
}

function parsePlatformEntry(value: unknown, key: string): ManifestPlatformEntry {
  if (!isPlainObject(value)) {
    throw new ManifestParseError(`manifest platforms[${JSON.stringify(key)}] must be an object`);
  }
  const url = requireUrl(field(value, "url"), `platforms[${JSON.stringify(key)}].url`);
  const signature = field(value, "signature");
  if (typeof signature !== "string") {
    throw new ManifestParseError(
      `manifest platforms[${JSON.stringify(key)}].signature must be a string`,
    );
  }
  // Extra fields are ignored: `ReleaseManifestPlatform` has no
  // `deny_unknown_fields`, so additive fields on the wire stay safe.
  return { url, signature };
}

/**
 * Parse a `latest.json` document under exactly the rules the Rust
 * `Deserialize` impl enforces:
 *
 *  - `version` (serde alias `name`) is REQUIRED and must be a string; it is
 *    `v`-trimmed then parsed as strict semver, and a failure fails the whole
 *    manifest.
 *  - `notes` is `Option<String>`: absent/null is fine, a non-string is a hard
 *    error (serde would refuse to deserialize it).
 *  - `pub_date` is `Option<String>` further parsed as RFC 3339; a malformed
 *    value fails the WHOLE manifest.
 *  - `url` is `Option<Url>` and `signature` is `Option<String>` — deserialized
 *    (and therefore validated) even in the Static form, before the shape is
 *    decided.
 *  - `platforms` present ⇒ Static; absent/null ⇒ Dynamic, which then REQUIRES
 *    both top-level `url` and `signature`.
 *  - unknown fields anywhere are ignored.
 */
export function parseUpdateManifest(rawJson: string): UpdateManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new ManifestParseError(`manifest is not valid JSON: ${(e as Error).message}`);
  }
  return parseUpdateManifestValue(parsed);
}

function manifestObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ManifestParseError("manifest must be a JSON object");
  }
  return value;
}

function manifestVersion(value: Record<string, unknown>): string {
  const rawVersion = field(value, "version") ?? field(value, "name");
  if (typeof rawVersion !== "string") {
    throw new ManifestParseError("manifest requires a string 'version' (or 'name') field");
  }
  const version = trimLeadingV(rawVersion);
  parseSemVer(version);
  return version;
}

function manifestNotes(value: Record<string, unknown>): string | undefined {
  const notes = field(value, "notes");
  if (isAbsent(notes)) return undefined;
  if (typeof notes !== "string") {
    throw new ManifestParseError("manifest 'notes' must be a string");
  }
  return notes;
}

function manifestPublicationDate(value: Record<string, unknown>): string | undefined {
  const pubDate = field(value, "pub_date");
  if (isAbsent(pubDate)) return undefined;
  if (typeof pubDate !== "string") {
    throw new ManifestParseError(
      `manifest 'pub_date' must be RFC 3339 (e.g. "2026-08-21T21:42:18Z"), got ${JSON.stringify(pubDate)}`,
    );
  }
  if (!isValidRfc3339(pubDate)) {
    throw new ManifestParseError(
      `manifest 'pub_date' must be RFC 3339 (e.g. "2026-08-21T21:42:18Z"), got ${JSON.stringify(pubDate)}`,
    );
  }
  return pubDate;
}

function optionalTopLevelUrl(value: unknown): string | undefined {
  if (isAbsent(value)) return undefined;
  return requireUrl(value, "'url'");
}

function optionalTopLevelSignature(value: unknown): string | undefined {
  if (isAbsent(value)) return undefined;
  if (typeof value !== "string") {
    throw new ManifestParseError("manifest 'signature' must be a string");
  }
  return value;
}

interface TopLevelPlatformFields {
  url: string | undefined;
  signature: string | undefined;
}

function topLevelPlatformFields(value: Record<string, unknown>): TopLevelPlatformFields {
  return {
    url: optionalTopLevelUrl(field(value, "url")),
    signature: optionalTopLevelSignature(field(value, "signature")),
  };
}

function staticPlatforms(value: unknown): Map<string, ManifestPlatformEntry> | undefined {
  if (isAbsent(value)) return undefined;
  if (!isPlainObject(value)) {
    throw new ManifestParseError("manifest 'platforms' must be an object");
  }
  // Wire keys can include `__proto__` or `constructor`; a Map keeps both as
  // ordinary own entries instead of following or changing a prototype.
  const platforms = new Map<string, ManifestPlatformEntry>();
  for (const [key, entry] of Object.entries(value)) {
    platforms.set(key, parsePlatformEntry(entry, key));
  }
  return platforms;
}

function dynamicManifest(
  version: string,
  notes: string | undefined,
  pubDate: string | undefined,
  fields: TopLevelPlatformFields,
): UpdateManifest {
  if (fields.url === undefined) {
    throw new ManifestParseError("the `url` field was not set on the updater response");
  }
  if (fields.signature === undefined) {
    throw new ManifestParseError("the `signature` field was not set on the updater response");
  }
  return {
    version,
    notes,
    pubDate,
    form: "dynamic",
    platform: { url: fields.url, signature: fields.signature },
  };
}

/** {@link parseUpdateManifest} for an already-decoded JSON value. */
export function parseUpdateManifestValue(parsed: unknown): UpdateManifest {
  const manifest = manifestObject(parsed);
  const version = manifestVersion(manifest);
  const notes = manifestNotes(manifest);
  const pubDate = manifestPublicationDate(manifest);
  const fields = topLevelPlatformFields(manifest);
  const platforms = staticPlatforms(field(manifest, "platforms"));
  if (platforms !== undefined) {
    return { version, notes, pubDate, form: "static", platforms };
  }
  return dynamicManifest(version, notes, pubDate, fields);
}

// ------------------------------------------------------------- target keys

/**
 * The ordered platform-key candidates `get_urls` builds when no explicit
 * `target` override is configured. `bundle_type()` unconditionally returns
 * `App` on macOS (`tauri-utils` `platform.rs:362-363`), so the installer name
 * is always `"app"` and the list is `["darwin-<arch>-app", "darwin-<arch>"]`,
 * FIRST PRESENT WINS.
 *
 * The shipped manifest carries only the plain `darwin-aarch64` key, so that
 * second candidate is the one that actually resolves. It must stay present in
 * every release for the whole bridge period, or old Tauri clients and this one
 * alike find no matching platform and treat it as "no update available" —
 * silently.
 */
export function macosTargetKeys(arch: string = process.arch): readonly string[] {
  const tauriArch = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return [`darwin-${tauriArch}-app`, `darwin-${tauriArch}`];
}

/** The concrete list for the only architecture this app ships. */
export const DARWIN_AARCH64_TARGET_KEYS: readonly string[] = macosTargetKeys("arm64");

/**
 * Resolve this machine's platform entry out of a parsed manifest — first
 * matching key in `targetKeys` order for the Static form, the single
 * server-resolved entry for the Dynamic form, or `null` when nothing matches.
 *
 * `null` is not an error: the real client treats an endpoint with no usable
 * target as "nothing to offer" rather than surfacing a failure.
 */
export function selectPlatformEntry(
  manifest: UpdateManifest,
  targetKeys: readonly string[] = DARWIN_AARCH64_TARGET_KEYS,
): ManifestPlatformEntry | null {
  if (manifest.form === "dynamic") return manifest.platform;
  for (const key of targetKeys) {
    const entry = manifest.platforms.get(key);
    if (entry) return entry;
  }
  return null;
}
