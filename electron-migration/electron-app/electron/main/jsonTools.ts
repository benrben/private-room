/**
 * Plucking fields out of a model's JSON reply.
 *
 * Ported from `src-tauri/src/commands/json.rs` (58 lines, read in full).
 *
 * Every structured-output call hands back a JSON string, and the caller wants
 * one or two fields out of it. A bad reply is never fatal here: the field is
 * simply absent and the caller falls back (a built-in template, the raw text,
 * "(not found)"). These helpers keep that lenient contract in one place
 * instead of re-deriving it at every generation site.
 *
 * MIGRATION Phase 3 note carried over verbatim from the Rust source's own
 * comment: `json_bool_field` (memory_suggestion) and `json_str_array`
 * (suggest_file_meta) moved with their features into the sidecar, which
 * parses the bool/tag-array itself and returns typed JSON. They are gone from
 * Rust and are NOT ported here either — only the object and item pluckers
 * below stay, because their Rust callers (studios/file-meta) still shape
 * their replies this way.
 *
 * `json.rs` has no `#[tauri::command]` of its own — it is pure helper code
 * three Rust commands call into (`studio_mindmap`, `studio_flashcards`,
 * `generate_podcast_script`, plus a `chat_commands/knowledge.rs` reader).
 * None of those commands are ported yet: `execTool.ts`'s `studio_flashcards`/
 * `studio_mindmap`/`generate_podcast_script` arms are still
 * `notImplemented("the Studio generators — out of scope for this batch per
 * its own brief")`. So there is no exec_tool arm to wire from this file; it
 * exists for whoever ports those studios next.
 *
 * Every function here only READS a parsed value — none builds a fresh object
 * and assigns a room/model-controlled key onto it, so there is no
 * `{}`-literal WRITE surface to guard here (unlike `mcpConfig.ts`/
 * `privacyRedact.ts`). The READ side still needs a guard, though, and gets
 * one: see {@link ownValue}.
 */

/** A key's OWN value, never one inherited from `Object.prototype` — the read
 * half of this codebase's prototype-pollution discipline, spelled the way
 * `privacy.ts`'s own `ownValue` spells it ("Inheriting either key from a
 * polluted `Object.prototype` would answer this door's question with
 * something no caller wrote").
 *
 * A plain `obj[key]` is NOT safe here, even though nothing in this file
 * writes. `serde_json`'s `Value::get` resolves a `&str` index against the
 * parsed object's OWN map and nothing else, so Rust cannot possibly answer
 * with a value the model never sent. A plain JS member read can: this app has
 * shipped `Object.prototype` pollution twice (`mcpConfig.ts`,
 * `privacyRedact.ts`), and with `Object.prototype.html` set to a string,
 * `jsonStrField(reply, "html")` used to hand a studio generator that string
 * as if the model had produced it — a FABRICATED field on a reply that
 * genuinely had none. The `typeof v === "string"` / `Array.isArray` guards
 * below do not stop that: they only happen to exclude the BUILT-IN prototype
 * members (which are all functions), not an injected one of the right type.
 * `hasOwnProperty` closes it, and restores exact `Value::get` semantics. */
function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** `serde_json::Value::get`'s receiver test: only a JSON OBJECT resolves a
 * `&str` index. Arrays are excluded so indexing one by a string key behaves
 * like Rust's `Value::get`, which only resolves a `&str` index against
 * `Value::Object`. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** `raw.trim()` parsed as JSON and read as an object; `null` on anything that
 * isn't valid JSON or isn't a JSON object — the shared first step of
 * {@link jsonStrField} and {@link jsonArray}. */
function parseObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  return asRecord(parsed);
}

/**
 * `json_str_field` — the string at `key` of a JSON object, trimmed. `null`
 * when the reply isn't JSON, isn't an object, or has no string there. Callers
 * that treat a blank value as missing add their own emptiness check — some (a
 * file summary) would rather keep the empty string than fall back.
 */
export function jsonStrField(raw: string, key: string): string | null {
  const obj = parseObject(raw);
  if (obj === null) return null;
  const v = ownValue(obj, key);
  return typeof v === "string" ? v.trim() : null;
}

/**
 * `json_array` — the array at `key` as owned values; empty when absent. For
 * arrays of objects (cards, mind-map nodes, podcast turns) the caller shapes
 * each item, usually with {@link valueStr}.
 */
export function jsonArray(raw: string, key: string): unknown[] {
  const obj = parseObject(raw);
  if (obj === null) return [];
  const v = ownValue(obj, key);
  return Array.isArray(v) ? v : [];
}

/**
 * `value_str` — the trimmed string at `key` of an already-parsed object; `""`
 * when absent — the item-level counterpart of {@link jsonStrField}.
 */
export function valueStr(v: unknown, key: string): string {
  const obj = asRecord(v);
  if (obj === null) return "";
  const s = ownValue(obj, key);
  return typeof s === "string" ? s.trim() : "";
}
