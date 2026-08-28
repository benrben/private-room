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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

/** The one target every event in this module uses. One target, so the
 * filter below is the whole story. */
const TARGET = "arcelle";

/** The default filter. Quiet enough to ship: our own events at `info`, and
 * nothing at all from dependencies — the file has to stay readable by the
 * person attaching it to a bug report. */
const DEFAULT_FILTER = "arcelle=info";

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
    const s = this.shape;
    switch (s.kind) {
      case "id":
      case "model":
      case "state":
        return quoted(s.value);
      case "count":
      case "bytes":
      case "ms":
        return String(s.value);
      case "flag":
        return s.value ? "true" : "false";
      case "ids":
        // Entries were already shape-checked by `id()` (or replaced with
        // UNLOGGABLE), so — matching the Rust Display impl exactly — they
        // are never individually re-quoted here.
        return `[${s.value.join(" ")}]`;
      /* istanbul ignore next -- exhaustiveness guard, not a reachable branch */
      default: {
        const never: never = s;
        return never;
      }
    }
  }
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

function checkedModel(s: string): string {
  const startsBad = s.startsWith("/") || s.startsWith(".") || s.startsWith("~");
  const ok =
    s.length > 0 &&
    s.length <= 96 &&
    !startsBad &&
    !s.includes("..") &&
    !looksLikeAFilename(s) &&
    !looksLikeACredential(s) &&
    MODEL_RE.test(s);
  return ok ? s : UNLOGGABLE;
}

/** A model or provider identifier (`qwen3.5:4b`, `anthropic/claude-opus-4`,
 * `codex-cli:gpt-5`). Configuration the user chose in Settings, not
 * something that came out of a room — but still shape-checked, and still no
 * spaces, so a prose string cannot arrive here by accident. */
export function model(s: string): Val {
  return Val.make({ kind: "model", value: checkedModel(s) });
}

// --------------------------------------------------------------------- state

/**
 * Rejects the general `string` type, keeping only a string LITERAL type (or a
 * union of them) — TypeScript's closest approximation of Rust's
 * `&'static str`, which by construction can only be a literal baked into our
 * own source, never a value computed from a room. `string extends S` is true
 * only when `S` has been widened all the way to the base `string` type (i.e.
 * the argument was some runtime-computed value, not a literal expression or a
 * `const` binding TypeScript kept a literal type for), so the conditional
 * resolves to `never` in exactly that case — a compile error at the call
 * site, not a runtime check.
 *
 * This is a real, adversarially-found gap this file used to leave open: the
 * first version of `state()`/`oneOf()` took a plain `string`/`string[]` and
 * only said "we trust the caller" in a doc comment, which is a promise, not a
 * boundary — indistinguishable in practice from `Val::State(filename)`
 * compiling in the original Rust hole this module exists to close. This type
 * makes the boundary something a caller cannot spell, same standard the Rust
 * source holds itself to for `Val` — with one honest caveat: an explicit
 * `as string` (on a value already widened to `string`) still fails to
 * compile, but `as any` — TypeScript's universal type-system escape hatch —
 * defeats every check on every function in this file, not just this one, the
 * same way `unsafe` can defeat any Rust invariant. That is a property of the
 * language, not a hole specific to this function.
 */
type Literal<S extends string> = string extends S ? never : S;

/** A compile-time literal: an enum name, an outcome, a phase.
 *
 * Rust's version of this takes a `&'static str`, which by construction can
 * only be a literal baked into our own source — never something that came
 * out of a room. {@link Literal} is TypeScript's closest equivalent: a
 * literal expression (`state("done")`), a literal union
 * (`state(cond ? "a" : "b")`), or a `const` binding TypeScript inferred a
 * literal type for (`state(SOME_CONST)`) all compile; a `string`-typed
 * variable computed at runtime does not. Use {@link oneOf} instead whenever
 * the value genuinely originates at runtime. */
export function state<S extends string>(s: Literal<S>): Val {
  return Val.make({ kind: "state", value: s as string });
}

/**
 * {@link Literal}, applied to every element of a whitelist array at once.
 *
 * Rust's `one_of` takes `allowed: &[&'static str]` — the whitelist itself
 * must be built from compile-time literals, so a caller cannot smuggle room
 * content through by constructing the "whitelist" at runtime to already
 * contain the value being checked (`one_of(secret, &[secret])` cannot even
 * compile there, because a value with `'static` lifetime cannot in practice
 * be produced from a room's contents). The first TypeScript version of
 * `oneOf` typed `allowed` as a plain `readonly string[]`, which enforced
 * nothing: `oneOf(secret, [secret])` compiled and returned `secret` itself,
 * verbatim, wrapped as a `state` `Val` — a complete bypass of the one helper
 * whose entire job is turning a runtime string into something safe. Requiring
 * every element to satisfy {@link Literal} closes that: a whitelist array has
 * to be written out of literals at the call site (as every whitelist in this
 * codebase already is), so it can never contain the very value under test.
 */
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

function classifyErrKind(s: string): string {
  if (s.trim().length === 0) {
    return "none";
  }
  const t = s.toLowerCase();
  if (hasAny(t, ERRKIND_TIMEOUT)) return "timeout";
  if (hasAny(t, ERRKIND_CANCELLED)) return "cancelled";
  if (hasAny(t, ERRKIND_RATE_LIMITED)) return "rate_limited";
  if (hasAny(t, ERRKIND_DENIED)) return "denied";
  if (hasAny(t, ERRKIND_NO_CREDENTIAL)) return "no_credential";
  if (hasAny(t, ERRKIND_NOT_FOUND)) return "not_found";
  if (hasAny(t, ERRKIND_NETWORK)) return "network";
  if (hasAny(t, ERRKIND_UPSTREAM)) return "upstream_error";
  if (hasAny(t, ERRKIND_OOM)) return "out_of_memory";
  if (hasAny(t, ERRKIND_TOO_LARGE)) return "too_large";
  if (hasAny(t, ERRKIND_MALFORMED)) return "malformed";
  return "other";
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
type PlainFields = readonly (readonly [string, Val])[];

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
type CheckedFields<F extends PlainFields> = {
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

// ------------------------------------------------------------------- the file

/** Where the host's event log lives — beside the sidecar's stderr mirror
 * (ported elsewhere), so "the logs" is one folder and not a scavenger hunt. */
export function logPath(): string {
  return path.join(os.tmpdir(), "arcelle-host.log");
}

/** The previous session's host log, kept for exactly the reason the
 * sidecar's is: the interesting session is usually the one that just
 * ended. */
export function previousLogPath(): string {
  return path.join(os.tmpdir(), "arcelle-host.prev.log");
}

/** The folder holding both logs, for the Settings affordance that reveals
 * it. */
export function logDir(): string {
  return os.tmpdir();
}

function renameQuiet(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch {
    // No previous generation, or the rename failed (e.g. cross-device on an
    // odd TMPDIR setup): same doctrine as the Rust `let _ = fs::rename(...)`
    // — a rotation that cannot happen must not fail the app.
  }
}

function openFreshQuiet(p: string): number | null {
  try {
    // "w": create if missing, truncate if present, open for writing.
    return fs.openSync(p, "w");
  } catch {
    return null;
  }
}

/** One of the levels the `ARCELLE_LOG` filter can resolve to for our
 * target, ordered least to most verbose except `off` which is more
 * restrictive than all of them. Mirrors `tracing::Level` plus
 * `LevelFilter::OFF`. */
export type LogLevel = "off" | "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_RANK: Record<LogLevel, number> = {
  off: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/**
 * A size-capped file with one generation of rotation. Deliberately
 * hand-rolled rather than reaching for a rolling-log package: those never
 * delete anything, and an app that runs for days would grow a log nobody can
 * attach anywhere.
 *
 * Gates `info`/`warn`/`debug` on a settable {@link LogLevel} — mirroring the
 * real module's reliance on `tracing`'s ambient level filter for every
 * event, not only the hand-rolled fast-path check the Rust `debug` function
 * adds for itself. A fresh `Sink` defaults to `"info"` (the shipped
 * default), so `info`/`warn` fire out of the box and `debug` does not, until
 * {@link Sink.setLevel} says otherwise — including `"off"`, which silences
 * all three, matching the doc comment's claim that an explicit "be quiet" is
 * a real answer.
 */
export class Sink {
  private readonly filePath: string;
  private readonly prevPath: string;
  private fd: number | null;
  private written = 0;
  private level: LogLevel = "info";

  constructor(filePath: string, prevPath: string) {
    this.filePath = filePath;
    this.prevPath = prevPath;
    // Rotate on open, not truncate — see `previousLogPath`.
    renameQuiet(this.filePath, this.prevPath);
    this.fd = openFreshQuiet(this.filePath);
  }

  /** Set the effective level for this sink — what `init()` resolves from
   * {@link filterFrom} once `ARCELLE_LOG` has been read. */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private enabled(msgLevel: "info" | "warn" | "debug"): boolean {
    return LEVEL_RANK[this.level] >= LEVEL_RANK[msgLevel];
  }

  private rotate(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // A failing close must not fail the app.
      }
      this.fd = null;
    }
    renameQuiet(this.filePath, this.prevPath);
    this.fd = openFreshQuiet(this.filePath);
    this.written = 0;
  }

  /** The low-level append used by `info`/`warn`/`debug`, and directly by
   * tests exercising rotation. Rotates first if this write would cross the
   * cap; `written` only advances when a file handle actually exists, so a
   * sink that could never open a file (full disk, sandboxed temp dir) stays
   * a permanent, silent no-op rather than rotating on every call. */
  writeRaw(data: string): void {
    const buf = Buffer.from(data, "utf8");
    if (this.written + buf.length > MAX_LOG_BYTES) {
      this.rotate();
    }
    if (this.fd !== null) {
      try {
        fs.writeSync(this.fd, buf);
        this.written += buf.length;
      } catch {
        // A logging failure must never fail the app: a full disk or a
        // sandboxed temp dir means we lose the line, not the turn.
      }
    }
  }

  /** A decision worth keeping. `event` and every field KEY must be
   * compile-time literals — see {@link Literal} / {@link CheckedFields}. */
  info<E extends string, const F extends PlainFields>(event: Literal<E>, fields: CheckedFields<F>): void {
    if (!this.enabled("info")) {
      return;
    }
    this.writeRaw(formatLine("INFO", event as string, fields as unknown as PlainFields));
  }

  /** Something went wrong but the app carried on. */
  warn<E extends string, const F extends PlainFields>(event: Literal<E>, fields: CheckedFields<F>): void {
    if (!this.enabled("warn")) {
      return;
    }
    this.writeRaw(formatLine("WARN", event as string, fields as unknown as PlainFields));
  }

  /** Detail for a live investigation — off by default (see
   * `DEFAULT_FILTER`). The line is not even rendered unless the resolved
   * level admits `debug`, because this fires on paths that run per tool
   * call. */
  debug<E extends string, const F extends PlainFields>(event: Literal<E>, fields: CheckedFields<F>): void {
    if (!this.enabled("debug")) {
      return;
    }
    this.writeRaw(formatLine("DEBUG", event as string, fields as unknown as PlainFields));
  }

  /** Release the underlying file handle. Not part of the Rust surface
   * (there, dropping the `Sink` closes it); exposed here so tests can clean
   * up deterministically instead of waiting on GC. */
  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
  }
}

function formatLine(level: string, event: string, fields: PlainFields): string {
  // UTC timestamp, millisecond precision, `Z` suffix — Date#toISOString
  // already produces exactly the same shape as the Rust module's pinned
  // chrono format ("%Y-%m-%dT%H:%M:%S%.3fZ").
  return `${new Date().toISOString()} ${level} ${renderLine(event, fields)}\n`;
}

// --------------------------------------------------------------- the filter

function parseLevelWord(word: string): LogLevel | null {
  switch (word.trim().toLowerCase()) {
    case "off":
    case "error":
    case "warn":
    case "info":
    case "debug":
    case "trace":
      return word.trim().toLowerCase() as LogLevel;
    default:
      return null;
  }
}

interface ParsedDirectives {
  defaultLevel: LogLevel | null;
  targets: Map<string, LogLevel>;
}

/** A deliberately small stand-in for `tracing_subscriber::filter::Targets`'
 * grammar — this module's log format does not need a real `Targets` parser,
 * only the OBSERVABLE behavior {@link filterFrom} reproduces below. A
 * directive with no `=` is either a bare level word (sets the default level
 * for every target) or, failing that, a literal target name implicitly at
 * `trace` (mirroring the real crate's permissiveness: almost anything that
 * isn't a level word parses as *some* target name). A directive with `=`
 * must have a recognized level after it, or the WHOLE string fails to
 * parse — same as the real crate rejecting `arcelle=debag`. */
function tryParseDirectives(s: string): ParsedDirectives | null {
  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    return null;
  }
  const result: ParsedDirectives = { defaultLevel: null, targets: new Map() };
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      const lvl = parseLevelWord(part);
      if (lvl !== null) {
        result.defaultLevel = lvl;
      } else {
        result.targets.set(part, "trace");
      }
    } else {
      const target = part.slice(0, eq);
      const levelStr = part.slice(eq + 1);
      const lvl = parseLevelWord(levelStr);
      if (lvl === null) {
        return null;
      }
      result.targets.set(target, lvl);
    }
  }
  return result;
}

/** The resolved level for our own target under a set of directives: an
 * explicit `arcelle=<level>` wins, then a blanket default level, then
 * `"info"` as a last resort (unreachable in practice — see
 * {@link filterFrom}, which only calls this once one of the two is known to
 * be present). */
function resolveLevel(parsed: ParsedDirectives): LogLevel {
  return parsed.targets.get(TARGET) ?? parsed.defaultLevel ?? "info";
}

/** The result of resolving a requested `ARCELLE_LOG` value: whether it was
 * honored, and the effective {@link LogLevel} for our target under it. */
export interface FilterResult {
  understood: boolean;
  level: LogLevel;
}

/**
 * Resolve `ARCELLE_LOG` into an effective filter, and say whether the
 * request was honored.
 *
 * The subtlety this exists to close: the real `Targets` type accepts far
 * more than it should. `"not a filter!!"` and `"ARCELLE=debug"` (wrong case)
 * both PARSE — as a target with that literal name — so naive parsing
 * reports success and installs a filter that matches nothing we ever emit.
 * The result would be a 0-byte host log with no error anywhere, reached by
 * the single most likely user action: turning the logging up and mistyping
 * it.
 *
 * So a parsed filter is only honored if it can actually SPEAK about us: it
 * names our target (`arcelle`), or it sets a default level that reaches
 * every target. `arcelle=off` names us and is therefore respected — an
 * explicit "be quiet" is a real answer; a typo is not.
 */
export function filterFrom(requested: string | undefined | null): FilterResult {
  // `DEFAULT_FILTER` ("arcelle=info") always parses; used both when the env
  // is unset and as the fallback when a requested value is not honored.
  const defaultParsed = tryParseDirectives(DEFAULT_FILTER) as ParsedDirectives;

  if (requested === undefined || requested === null) {
    return { understood: true, level: resolveLevel(defaultParsed) };
  }
  const parsed = tryParseDirectives(requested);
  if (parsed !== null) {
    const namesTarget = parsed.targets.has(TARGET);
    const hasDefault = parsed.defaultLevel !== null;
    if (namesTarget || hasDefault) {
      return { understood: true, level: resolveLevel(parsed) };
    }
  }
  return { understood: false, level: resolveLevel(defaultParsed) };
}

// -------------------------------------------------------------------- init

let defaultSink: Sink | null = null;
let started = false;

/**
 * Install the host log. Idempotent — a second call is a no-op, so a
 * re-entrant startup path cannot fight over the one log file.
 *
 * Not unit-tested directly against the real filesystem, matching the Rust
 * source's own precedent: no test in `obs.rs` calls `init()` either, since
 * it always resolves to the machine's real temp directory with no injection
 * seam — `filterFrom` (the decision logic) and `Sink` (the file behavior)
 * are the testable pieces, and `init` is the thin, deliberately un-mocked
 * wiring between them and the live environment.
 */
export function init(appVersion: string): void {
  if (started) {
    return;
  }
  started = true;

  const requested = process.env[LOG_ENV];
  const { understood, level } = filterFrom(requested);

  const sink = new Sink(logPath(), previousLogPath());
  sink.setLevel(level);
  defaultSink = sink;

  sink.info("host.start", [
    ["version", model(appVersion)],
    ["log", state("arcelle-host.log")],
    // Whether ARCELLE_LOG was honored, in the file itself. A log that is
    // quieter than the reader expects has to say why in the one place the
    // reader is already looking.
    ["filter", state(understood ? "as asked" : "default")],
  ]);
  if (!understood) {
    sink.warn("host.log_filter_ignored", [
      ["env", state(LOG_ENV)],
      ["bytes", bytes(requested === undefined ? 0 : Buffer.byteLength(requested, "utf8"))],
    ]);
  }
}

/** A decision worth keeping. No-op until {@link init} has installed a sink —
 * the same "worst case we run with no host log" fallback the Rust source
 * falls back to when its subscriber install fails. `event` and every field
 * KEY must be compile-time literals — see {@link Literal} /
 * {@link CheckedFields} — matching Rust's `&'static str` on both. */
export function info<E extends string, const F extends PlainFields>(
  event: Literal<E>,
  fields: CheckedFields<F>,
): void {
  defaultSink?.info<E, F>(event, fields);
}

/** Something went wrong but the app carried on. */
export function warn<E extends string, const F extends PlainFields>(
  event: Literal<E>,
  fields: CheckedFields<F>,
): void {
  defaultSink?.warn<E, F>(event, fields);
}

/** Detail for a live investigation — off by default. */
export function debug<E extends string, const F extends PlainFields>(
  event: Literal<E>,
  fields: CheckedFields<F>,
): void {
  defaultSink?.debug<E, F>(event, fields);
}
