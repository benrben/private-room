import type { OrganizeEntry } from "./organize.js";

export type OrganizeToolOutcome =
  | { ok: true; text: string }
  | { ok: false; error: string };

export function ok(text: string): OrganizeToolOutcome {
  return { ok: true, text };
}

export function fail(error: string): OrganizeToolOutcome {
  return { ok: false, error };
}

/** A clearly-labeled "the real subsystem behind this isn't ported yet" result,
 * matching `execTool.ts`'s own `notImplemented` shape exactly — never a silent
 * success, never a thrown exception. */
export function notImplemented(reason: string): OrganizeToolOutcome {
  return fail(`NOT_IMPLEMENTED: ${reason}`);
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `args["k"].as_str().unwrap_or_default()`. */
export function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** `args["k"].as_bool().unwrap_or(fallback)`. */
export function asBoolDefault(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful call into a failed one. Narrowest possible contract, same
 * as `fileTools.ts`'s own `EmitFn`. */
export type EmitFn = (event: string, payload: unknown) => void;

export function emitSafely(
  emit: EmitFn | undefined,
  event: string,
  payload: unknown,
): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

/** `extraction::extension_of` — a `std::path::Path` extension: none for a
 * dotfile or a name with no dot, lower-cased. A local copy, the same choice
 * `organize.ts`, `docsHtml.ts` and `turnEngine.ts` already made for this exact
 * function; they all collapse onto one `extraction.ts` when that module lands.
 * Only `rename_file` and `create_file`'s extension default need it here. */
export function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

/**
 * `serde_json::from_value::<Vec<String>>(v).unwrap_or_default()` — ALL of `v`
 * or NONE of it.
 *
 * A JSON array deserializes as `Vec<String>` only when EVERY element is a
 * string; one wrong-typed element fails the whole array in serde, which
 * `unwrap_or_default()` then folds to an empty vec. Mirrored as
 * all-or-nothing rather than "keep the strings, drop the rest", so a malformed
 * call degrades exactly the way Rust's does — into the arm's own "needs at
 * least one …" refusal — instead of silently acting on a partial list the
 * model never intended.
 */
export function parseStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) {
    return [];
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") {
      return [];
    }
    out.push(item);
  }
  return out;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const INVALID_ORGANIZE_FIELD = Symbol("invalid organize field");
type OrganizeField = string | null | undefined | typeof INVALID_ORGANIZE_FIELD;

export function organizeField(record: Record<string, unknown>, key: string): OrganizeField {
  const value = record[key];
  return value === undefined || value === null || typeof value === "string" ? value : INVALID_ORGANIZE_FIELD;
}

export function organizeFieldsAreValid(fields: readonly OrganizeField[]): boolean {
  return !fields.includes(INVALID_ORGANIZE_FIELD);
}

export function organizeEntryFromFields(
  name: OrganizeField,
  folder: OrganizeField,
  newName: OrganizeField,
): OrganizeEntry {
  return {
    ...(name === undefined ? {} : { name: name as string }),
    ...(folder === undefined ? {} : { folder: folder as string | null }),
    ...(newName === undefined ? {} : { newName: newName as string | null }),
  };
}

export function parseOrganizeEntry(value: unknown): OrganizeEntry | null {
  if (!isRecord(value)) return null;
  const name = organizeField(value, "name");
  const folder = organizeField(value, "folder");
  const newName = organizeField(value, "new_name");
  if (!organizeFieldsAreValid([name, folder, newName])) return null;
  if (name === null) return null;
  return organizeEntryFromFields(name, folder, newName);
}

/**
 * `serde_json::from_value::<Vec<OrganizeEntry>>(args["files"].clone()).unwrap_or_default()`,
 * with the same all-or-nothing failure shape as {@link parseStringArray} and
 * one translation on top of it: the raw tool-call key is `new_name` (Rust's
 * struct field is literally that), while `organize.ts`'s `OrganizeEntry` is
 * `newName`. See the module doc's "ARGS TRANSLATION" note.
 *
 * A JSON `null` for `folder`/`newName` is kept as `null` rather than dropped,
 * because Rust's `Option<String>` fields distinguish absent ("don't touch
 * this") from present-and-empty ("move it to the top level") — the whole
 * reason `organize.rs` made them `Option` in the first place. `name` is a
 * plain `String` with `#[serde(default)]`, so a `null` there fails the parse.
 */
export function parseOrganizeEntries(v: unknown): OrganizeEntry[] {
  if (!Array.isArray(v)) return [];
  const out: OrganizeEntry[] = [];
  for (const item of v) {
    const entry = parseOrganizeEntry(item);
    if (entry === null) return [];
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------- mark_image

/**
 * Ported from `exec_tool`'s `"mark_image"` arm. Real: the image lookup and the
 * CHG-17 already-marked reuse. Labelled `NOT_IMPLEMENTED`: the grounding pass
 * itself — see the module doc's "THE ONE HONEST GAP".
 */
