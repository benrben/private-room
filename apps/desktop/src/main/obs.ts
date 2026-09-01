/**
 * The host's own event log — what Arcelle DECIDED, in a file you can attach
 * to a bug report.
 *
 * Ported from `src-tauri/src/obs.rs`. This file carries the REUSABLE CORE:
 * the opaque value type, the shape checks, the error classifier, the logfmt
 * renderer, the rotating file sink, the `ARCELLE_LOG` filter, and `init` /
 * `info` / `warn` / `debug`. The many specific "instrumented decision"
 * functions near the end of the Rust module (`tool_catalog`, `run_start`,
 * `job_status`, `cancel_requested`, `turn_fields`, …) are cross-cutting call
 * sites that belong to individual features and are ported incrementally
 * alongside those features, not here. The Tauri `reveal_logs` IPC command is
 * likewise out of scope: it is an Electron/IPC concern for whichever module
 * owns the Settings affordance, not core logic.
 *
 * # The privacy boundary is the point of this module
 *
 * Rooms are encrypted; nothing that lives inside one may reach a log file
 * sitting in the OS temp directory. That includes FILE NAMES — the privacy
 * door deliberately does not redact them, because a filename in an
 * encrypted-room app is user content. So this module does not offer a way to
 * log an arbitrary string. There is no `info("...", [["path", someString]])`;
 * the only things that can become a log value are:
 *
 * - {@link id} — an opaque handle, and only if it *is* one:
 *   `[A-Za-z0-9_-]{1,64}`, nothing else. A filename ("Q3 notes.pdf",
 *   "diary.pdf") fails on the space or the dot and is recorded as
 *   {@link UNLOGGABLE}.
 * - {@link oneOf} — a runtime string collapsed onto a caller-supplied
 *   whitelist. A value that is not in the whitelist becomes
 *   {@link UNEXPECTED}, never itself. The whitelist itself must be built from
 *   compile-time literals (see {@link LiteralArray}), so a caller cannot
 *   smuggle the value under test into an "allowed" list constructed at
 *   runtime.
 * - {@link state} — a string that must be a literal from our own source, not
 *   room content — enforced at compile time by {@link Literal}, TypeScript's
 *   closest equivalent of Rust's `&'static str` (see the deviations list
 *   below for exactly what that does and does not cover).
 * - `event` (on {@link render} and the module-level {@link info} /
 *   {@link warn} / {@link debug}) and every field NAME must likewise be
 *   compile-time literals — see {@link CheckedFields}. This is the direct
 *   TypeScript equivalent of the Rust module's own "Event names and field
 *   names are `&'static str` for the same reason": a `Val`'s shape checks
 *   only ever governed the VALUE half of a field, never the key or the event
 *   name, so without this, `render(someFilename, [[someOtherString, v]])`
 *   would place both strings straight into the log, unchecked, no matter how
 *   careful every `Val` factory was.
 * - {@link count} / {@link bytes} / {@link ms} / {@link flag} — numbers and
 *   booleans.
 * - {@link model} — the narrow exception: a model/provider identifier, which
 *   is configuration rather than room content, under its own tight charset.
 * - {@link errKind} — an error message classified onto one of
 *   {@link ERR_KINDS}. The message itself never travels — see
 *   `classifyErrKind` for why scrubbing it token-by-token was tried, tested
 *   and abandoned in the Rust source.
 *
 * `Val` is OPAQUE ON PURPOSE, and this is the whole design rather than a
 * detail of it. Its internal `Shape` union is a module-private type never
 * exported by name or value, and the class has a `private` constructor — the
 * only way to build one from outside this file is to call {@link id},
 * {@link ids}, {@link model}, {@link state}, {@link oneOf}, {@link count},
 * {@link bytes}, {@link ms}, {@link flag} or {@link errKind}, every one of
 * which either shape-checks its input or cannot take an arbitrary string at
 * all. `Val`'s TYPE is exported (other modules need it to declare field
 * lists), but the class VALUE is not (`export type { Val }` only) — so
 * `new Val(...)` cannot be spelled outside this file, not even by importing
 * the binding, because type-only imports are erased entirely before the code
 * ever runs.
 *
 * One thing shape checking genuinely CANNOT do is separate a bearer token
 * from a uuid — both are runs of random alphanumerics. What keeps
 * credentials out is that no factory here takes one blindly; {@link id} and
 * {@link model} additionally refuse the well-known secret prefixes as a
 * second line, and say so rather than claiming to be a guarantee (see
 * `looksLikeACredential`).
 *
 * ## Deliberate deviations from the Rust source
 *
 * - TypeScript has no module-private-enum-inside-a-newtype trick and no
 *   `&'static str`. The closest available approximation is a private class
 *   constructor plus a type-only `Val` export, PLUS the {@link Literal} /
 *   {@link LiteralArray} / {@link CheckedFields} generic-type tricks that
 *   `state()`, `oneOf()`, `render()` and the module-level `info`/`warn`/
 *   `debug` all use to reject a plain `string` (or an array/field-list built
 *   from one) at compile time, keeping only literal expressions, unions of
 *   literals, and `const` bindings TypeScript inferred a literal type for.
 *   This is NOT identical to Rust's guarantee: an explicit `as any` — or any
 *   other deliberate type-system escape hatch — still defeats it, the same
 *   way `unsafe` can defeat any Rust invariant; the boundary holds against
 *   ordinary, well-typed code, which is exactly the class of mistake it
 *   exists to catch (a typo'd argument order, a variable passed where a
 *   literal was meant). An earlier version of this file left `state()` and
 *   `oneOf()`'s whitelist as plain, unchecked `string`/`string[]` — an
 *   adversarial pass found that `oneOf(secret, [secret])` compiled and
 *   returned `secret` itself, and that `render()`'s `event` and field-key
 *   parameters had no check at all (not even the honor-system disclaimer
 *   `state()` carried), so `render(filename, [[otherString, v]])` placed both
 *   strings straight into the log. Both are closed now; see the doc comments
 *   on {@link Literal}, {@link LiteralArray} and {@link CheckedFields}.
 * - Rust's `tracing`/`tracing-subscriber` machinery (the `Targets` filter
 *   grammar, the `MakeWriter` trait, the global `Dispatch`) has no Node
 *   equivalent and is not reimplemented in full. {@link filterFrom}
 *   reproduces the OBSERVABLE behavior only: an unset env is honored
 *   silently; a value that neither sets a blanket default level nor names
 *   our own target is NOT honored and falls back to the default (logged as a
 *   warn); a value that does either of those is honored, including an
 *   explicit "off" — and "off" is wired all the way through to
 *   {@link Sink}, so it actually silences `info`/`warn`/`debug` alike, not
 *   only the `debug` fast path, matching the doc comment's claim that an
 *   explicit "be quiet" is a real answer.
 * - `count`/`bytes`/`ms` take a plain `number` where Rust's `usize`/`u64`/
 *   `Duration` cannot be negative or non-finite at the type level; this
 *   clamps defensively (`nonNegativeInt`) rather than let a stray `NaN` or
 *   negative reach the log. `ms` additionally takes milliseconds directly
 *   rather than a `Duration` object, since Node has no such type.
 * - `Sink` and the path helpers (`logPath`, `previousLogPath`, `logDir`) are
 *   exported even though Rust's `Sink` struct is module-private — Rust's own
 *   test suite reaches it via `use super::*;` from a `#[cfg(test)] mod tests`
 *   living in the SAME file, which a separate TypeScript test file cannot do.
 *   Exporting it is the closest equivalent; it carries no ability to
 *   construct a `Val` from an arbitrary string, so the privacy boundary on
 *   VALUES is unaffected — and `Sink.info`/`warn`/`debug` carry the same
 *   {@link Literal} / {@link CheckedFields} constraint on `event` and field
 *   KEYS as the module-level functions do, so exporting `Sink` does not open
 *   a separate, unchecked way to reach the file either. `Sink.close()` is
 *   likewise new — Rust relies on `Drop` to release the file handle; Node has
 *   no destructor, so tests need an explicit way to do it deterministically.
 * - The instrumented "decision" call sites (`tool_catalog`, `run_start`,
 *   `job_status`, `cancel_requested`, `turn_fields`, …) and the Tauri-bound
 *   `reveal_logs` command are explicitly OUT of scope for this port — they
 *   belong to the individual features that will use them, ported
 *   incrementally alongside those features.
 */

export {
  Sink,
  debug,
  filterFrom,
  info,
  init,
  logDir,
  logPath,
  previousLogPath,
  warn,
  type FilterResult,
  type LogLevel,
} from "./obsSink.js";

// --------------------------------------------------------------- constants

/** What a value that failed its shape check is recorded as. Deliberately not
 * silence: "this field existed and was refused" is different from "this
 * field was absent", and the anti-fabrication doctrine applies to our own
 * log too. */
export const UNLOGGABLE = "<unloggable>";

/** What a runtime string that is not in its caller's whitelist is recorded
 * as. */
export const UNEXPECTED = "<unexpected>";

/** The environment variable that overrides the default filter, in the usual
 * `target=level` syntax (`ARCELLE_LOG=arcelle=debug`, `ARCELLE_LOG=trace`). */
export const LOG_ENV = "ARCELLE_LOG";

/** Keep one live log plus one previous generation, same doctrine as the
 * sidecar's stderr mirror: the run that just died is usually the one worth
 * reading, and truncating on launch destroys it. */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

/** The closed set of error kinds. Every one is a literal, which is what
 * makes {@link errKind} safe by construction. Exact list and order as the
 * Rust `ERR_KINDS` (this is DECLARATION order, not the priority order the
 * classifier checks in — see {@link errKind}). */
export const ERR_KINDS = [
  "none",
  "timeout",
  "network",
  "not_found",
  "denied",
  "rate_limited",
  "upstream_error",
  "malformed",
  "no_credential",
  "out_of_memory",
  "too_large",
  "cancelled",
  "other",
] as const;

// ------------------------------------------------------------------ Val

/** The private interior of {@link Val}. Never exported, by name or value —
 * this is what makes `Val` unconstructible outside this file. */
type Shape =
  | { readonly kind: "id"; readonly value: string }
  | { readonly kind: "model"; readonly value: string }
  | { readonly kind: "state"; readonly value: string }
  | { readonly kind: "count"; readonly value: number }
  | { readonly kind: "bytes"; readonly value: number }
  | { readonly kind: "ms"; readonly value: number }
  | { readonly kind: "flag"; readonly value: boolean }
  | { readonly kind: "ids"; readonly value: readonly string[] };

/**
 * A value that is allowed to reach the log file.
 *
 * OPAQUE ON PURPOSE — see the module doc comment. The constructor is
 * `private`; the only way to build one is through the module-level factory
 * functions below, every one of which either shape-checks its input or
 * cannot accept a free-form string at all.
 *
 * It would have been shorter to just export a public field holding the raw
 * string. That is exactly the hole this type exists to close: a caller
 * being asked not to spell `new Val(someFilename)` is not a boundary, it is
 * a request to be careful. Not exporting `Val` as a value (only as a type)
 * removes the spelling entirely.
 */
class Val {
  private constructor(private readonly shape: Shape) {}

  /** The only factory reachable from the rest of this file. Every exported
   * helper below builds a `Shape` and hands it here. */
  static make(shape: Shape): Val {
    return new Val(shape);
  }

  toString(): string {
    return renderValue(this.shape);
  }
}

type QuotedShape = Extract<Shape, { readonly kind: "id" | "model" | "state" }>;
type NumericShape = Extract<Shape, { readonly kind: "count" | "bytes" | "ms" }>;
type IdListShape = Extract<Shape, { readonly kind: "ids" }>;

function isQuotedShape(shape: Shape): shape is QuotedShape {
  return shape.kind === "id" || shape.kind === "model" || shape.kind === "state";
}

function isNumericShape(shape: Shape): shape is NumericShape {
  return shape.kind === "count" || shape.kind === "bytes" || shape.kind === "ms";
}

function renderIds(shape: IdListShape): string {
  return `[${shape.value.join(" ")}]`;
}

function unreachableShape(shape: never): never {
  return shape;
}

function renderValue(shape: Shape): string {
  if (isQuotedShape(shape)) return quoted(shape.value);
  if (isNumericShape(shape)) return String(shape.value);
  if (shape.kind === "flag") return shape.value ? "true" : "false";
  if (shape.kind === "ids") return renderIds(shape);
  return unreachableShape(shape);
}

export type { Val };

/** logfmt quoting: only when the value would otherwise break `k=v` parsing.
 * JSON-stringify style — not Rust's `{:?}` escaping, which differs in its
 * exact escape sequences but agrees on WHEN to quote. */
function quoted(s: string): string {
  if (s.length === 0 || s.includes(" ") || s.includes("=") || s.includes('"')) {
    return JSON.stringify(s);
  }
  return s;
}

// ------------------------------------------------------------- credential guard

/** Well-known secret prefixes, refused by {@link id} and {@link model}.
 *
 * This is a BLOCKLIST and therefore not a guarantee. A bearer token is a run
 * of random alphanumerics, exactly like a uuid — no shape check can tell
 * them apart. What actually keeps credentials out of the log is that none of
 * the helpers below take one; this list is the second line, catching the
 * copy-paste mistake that would otherwise reach the file. */
const CREDENTIAL_PREFIXES: readonly string[] = [
  "sk-",
  "sk_",
  "pk_",
  "rk_",
  "ghp_",
  "gho_",
  "ghu_",
  "github_pat_",
  "xoxb-",
  "xoxp-",
  "xapp-",
  "AKIA",
  "ASIA",
  "AIza",
  "hf_",
  "eyJ",
  "Bearer",
];

function looksLikeACredential(s: string): boolean {
  return CREDENTIAL_PREFIXES.some((p) => s.startsWith(p));
}

// ------------------------------------------------------------------- id / ids

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function checkedId(s: string): string {
  const ok = ID_RE.test(s) && !looksLikeACredential(s);
  return ok ? s : UNLOGGABLE;
}

/** An opaque handle — a run id, chat id, job id, room id, tool name.
 *
 * Shape-checked, not trusted: `[A-Za-z0-9_-]{1,64}` and nothing else. That
 * admits every id this app mints (uuid simple form, nanoid, our tool names)
 * and refuses essentially every filename, because a filename either carries
 * a space, a dot before its extension, or a path separator. A value that
 * fails is recorded as {@link UNLOGGABLE} — the field still appears, so the
 * log never pretends the caller passed nothing. */
export function id(s: string): Val {
  return Val.make({ kind: "id", value: checkedId(s) });
}

/** {@link id} over a list — a served tool catalog, an advisor roster. Each
 * entry is checked on its own, so one odd connector tool name does not blank
 * the rest. */
export function ids(items: readonly string[]): Val {
  return Val.make({ kind: "ids", value: items.map(checkedId) });
}

// --------------------------------------------------------------------- model

const MODEL_RE = /^[A-Za-z0-9\-_.:/+]+$/;

/** The one shape a model id and a filename share, closed here because the
 * boundary test found it: "diary.pdf" has no space, no path separator and no
 * leading dot, so the charset check alone waves it straight through.
 *
 * A model id's dotted segment is a VERSION — `qwen3.5:4b`, `llama3.2`,
 * `nomic-embed-text-v1.5` — so it ends in digits or carries a `:`/`/` after
 * the dot. A file extension is short and purely alphabetic. That is the
 * whole discriminator, and it costs nothing to be wrong in the safe
 * direction: a model genuinely named `foo.bar` is recorded as
 * {@link UNLOGGABLE}, which is a missing diagnostic, not a leak. */
function looksLikeAFilename(s: string): boolean {
  const dot = s.lastIndexOf(".");
  if (dot === -1) {
    return false;
  }
  const ext = s.slice(dot + 1);
  return ext.length >= 1 && ext.length <= 5 && /^[A-Za-z]+$/.test(ext);
}

function hasValidModelLength(s: string): boolean {
  return s.length > 0 && s.length <= 96;
}

function startsLikeModelPath(s: string): boolean {
  return s.startsWith("/") || s.startsWith(".") || s.startsWith("~");
}

function isSafeModel(s: string): boolean {
  if (!hasValidModelLength(s)) return false;
  if (startsLikeModelPath(s) || s.includes("..")) return false;
  if (looksLikeAFilename(s)) return false;
  if (looksLikeACredential(s)) return false;
  return MODEL_RE.test(s);
}

function checkedModel(s: string): string {
  return isSafeModel(s) ? s : UNLOGGABLE;
}

/** A model or provider identifier (`qwen3.5:4b`, `anthropic/claude-opus-4`,
 * `codex-cli:gpt-5`). Configuration the user chose in Settings, not
 * something that came out of a room — but still shape-checked, and still no
 * spaces, so a prose string cannot arrive here by accident. */
export function model(s: string): Val {
  return Val.make({ kind: "model", value: checkedModel(s) });
}

// --------------------------------------------------------------------- state

/** Reject a widened runtime string while accepting literals and literal unions. */
export type Literal<S extends string> = string extends S ? never : S;

/** A compile-time enum name, outcome, or phase; use {@link oneOf} for runtime values. */
export function state<S extends string>(s: Literal<S>): Val {
  return Val.make({ kind: "state", value: s as string });
}

/** Require every whitelist entry to remain a compile-time literal. */
type LiteralArray<A extends readonly string[]> = string extends A[number] ? never : A;

/** A RUNTIME string collapsed onto a caller-supplied whitelist.
 *
 * This is how a string that happens to be a closed-set state ("running",
 * "paused", "done") reaches the log without opening a hole: anything not in
 * `allowed` becomes {@link UNEXPECTED}. A room's contents cannot match a
 * whitelist, so they cannot get through — and, per {@link LiteralArray}, the
 * whitelist itself cannot be built from room content either. */
export function oneOf<const A extends readonly string[]>(s: string, allowed: LiteralArray<A>): Val {
  const list = allowed as readonly string[];
  const found = list.find((a) => a === s);
  return Val.make({ kind: "state", value: found ?? UNEXPECTED });
}

// ------------------------------------------------------------ numbers / flags

/** usize/u64/Duration have no negative or non-finite values at the type
 * level in Rust; `number` in TypeScript does, so this clamps defensively
 * rather than let a stray `NaN` or negative reach the log. Documented,
 * deliberate deviation — it changes no behavior for any value these helpers
 * are actually called with in practice. */
function nonNegativeInt(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.trunc(n));
}

export function count(n: number): Val {
  return Val.make({ kind: "count", value: nonNegativeInt(n) });
}

export function bytes(n: number): Val {
  return Val.make({ kind: "bytes", value: nonNegativeInt(n) });
}

/** Milliseconds, not a `Duration` — Node has no such type. See the
 * deviations list in the module doc comment. */
export function ms(durationMs: number): Val {
  return Val.make({ kind: "ms", value: nonNegativeInt(durationMs) });
}

export function flag(b: boolean): Val {
  return Val.make({ kind: "flag", value: b });
}

// -------------------------------------------------------------------- errKind

const ERRKIND_TIMEOUT = ["timed out", "timeout", "deadline"];
const ERRKIND_CANCELLED = ["stopped by the user", "cancel", "aborted"];
const ERRKIND_RATE_LIMITED = ["429", "rate limit", "quota", "too many requests"];
const ERRKIND_DENIED = ["401", "403", "permission", "denied", "forbidden", "unauthor"];
const ERRKIND_NO_CREDENTIAL = ["api key", "no key", "credential", "keychain", "not signed in"];
const ERRKIND_NOT_FOUND = ["404", "no such file", "not found", "does not exist"];
const ERRKIND_NETWORK = [
  "connection",
  "connect",
  "dns",
  "unreachable",
  "sending request",
  "network",
  "offline",
  "broken pipe",
];
const ERRKIND_UPSTREAM = ["500", "502", "503", "504", "bad gateway", "server error"];
const ERRKIND_OOM = ["out of memory", "oom", "allocation"];
const ERRKIND_TOO_LARGE = ["context", "too long", "too large", "token limit", "exceeds"];
const ERRKIND_MALFORMED = ["json", "parse", "decode", "invalid", "malformed", "schema"];

function hasAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

type ErrorRule = readonly [kind: string, needles: readonly string[]];

const ERROR_RULES: readonly ErrorRule[] = [
  ["timeout", ERRKIND_TIMEOUT],
  ["cancelled", ERRKIND_CANCELLED],
  ["rate_limited", ERRKIND_RATE_LIMITED],
  ["denied", ERRKIND_DENIED],
  ["no_credential", ERRKIND_NO_CREDENTIAL],
  ["not_found", ERRKIND_NOT_FOUND],
  ["network", ERRKIND_NETWORK],
  ["upstream_error", ERRKIND_UPSTREAM],
  ["out_of_memory", ERRKIND_OOM],
  ["too_large", ERRKIND_TOO_LARGE],
  ["malformed", ERRKIND_MALFORMED],
];

function firstErrorRule(message: string): string | null {
  for (const [kind, needles] of ERROR_RULES) {
    if (hasAny(message, needles)) return kind;
  }
  return null;
}

function classifyErrKind(s: string): string {
  if (s.trim().length === 0) return "none";
  return firstErrorRule(s.toLowerCase()) ?? "other";
}

/** Reduce an error message to its KIND — one of {@link ERR_KINDS}, never the
 * text.
 *
 * The first version of this scrubbed the message token by token, keeping
 * short alphanumeric words. Its own boundary test killed it: the filename
 * "Q3 board minutes.pdf" survives as "Q3 board", because the words in a
 * filename are short alphanumeric words. An error message can carry room
 * content in ANY position — a path, a title the model quoted back, a row of
 * a spreadsheet — so no amount of filtering makes the text itself safe.
 *
 * So the text does not travel. It is CLASSIFIED, and only the class
 * travels. Deliberately no digest either: an 8-hex fingerprint of an error
 * would let anyone holding the log confirm a guessed filename by hashing it,
 * which is a smaller hole than a plaintext leak but is still a hole.
 *
 * The priority order below is exactly the Rust if/else-if chain: timeout,
 * then cancelled, then rate_limited, then denied, then no_credential, then
 * not_found, then network, then upstream_error, then out_of_memory, then
 * too_large, then malformed, then other. A message matching more than one
 * category takes the FIRST one it matches in this order. */
export function errKind(s: string): Val {
  return Val.make({ kind: "state", value: classifyErrKind(s) });
}

// ---------------------------------------------------------------------- emit

/** The plain (unchecked) shape of a field list: a run of `[key, Val]` pairs.
 * Used internally, after a checked entry point ({@link render}, the
 * module-level `info`/`warn`/`debug`) has already forced its own caller to
 * supply literal keys — see {@link CheckedFields}. */
export type PlainFields = readonly (readonly [string, Val])[];

/**
 * {@link Literal}, applied to the KEY half of one `[key, Val]` field tuple,
 * leaving the value half untouched (a `Val` is already privacy-safe by
 * construction — only the key needs checking here).
 */
type CheckedField<Entry> = Entry extends readonly [infer K, infer V]
  ? K extends string
    ? readonly [Literal<K>, V]
    : Entry
  : Entry;

/**
 * {@link CheckedField}, mapped across every entry of a field-list tuple —
 * TypeScript's closest equivalent of Rust's `&[(&'static str, Val)]`: every
 * field KEY must be a compile-time literal, matching the event name's own
 * {@link Literal} constraint on {@link render}. `[I in keyof F]` is a
 * homomorphic mapped type, so it preserves `F`'s tuple shape (each position
 * keeps its own literal key type) rather than collapsing every entry to one
 * shared type the way a plain array element check would.
 *
 * This closes a real, adversarially-found gap: the first version of
 * `render()` typed both `event` and every field key as plain `string`, with
 * NO check at all — not even the honor-system disclaimer `state()` carried.
 * `render(roomContentFilename, [[roomContentAnotherString, count(1)]])`
 * compiled and placed both strings verbatim, unquoted, into the log line —
 * a total bypass of every `Val` shape check, because those checks only ever
 * governed the VALUE half of a field, never the event name or the key. Rust
 * closes this with `&'static str` on both `event` and every field name (see
 * the module doc: "Event names and field names are `&'static str` for the
 * same reason"); this is that same closure, ported.
 */
export type CheckedFields<F extends PlainFields> = {
  readonly [I in keyof F]: CheckedField<F[I]>;
};

/** Render one event as a logfmt line: `event k1=v1 k2=v2`. Split out from the
 * sink so the privacy boundary can be asserted without any file I/O.
 *
 * `event` and every field KEY must be compile-time literals (see
 * {@link Literal}, {@link CheckedFields}) — only a `Val`'s VALUE may be
 * something computed at runtime, and only through one of the checked
 * factories above. */
export function render<E extends string, const F extends PlainFields>(
  event: Literal<E>,
  fields: CheckedFields<F>,
): string {
  return renderLine(event as string, fields as unknown as PlainFields);
}

/** The actual line-building logic behind {@link render}. Deliberately takes
 * plain, unchecked types: every caller of this internal function — `render`
 * above, and `formatLine` below on behalf of `Sink` — reaches it only after
 * ITS OWN literal-checked public signature has already forced its caller to
 * supply compile-time literals, so re-deriving the same generic check here
 * would only rename the boundary, not add one. Never exported. */
function renderLine(event: string, fields: PlainFields): string {
  let line = event;
  for (const [k, v] of fields) {
    line += ` ${k}=${v.toString()}`;
  }
  return line;
}
