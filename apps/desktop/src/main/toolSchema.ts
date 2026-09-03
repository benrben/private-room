/**
 * Argument validation and third-party schema slimming for the agent tool
 * surface.
 *
 * Ported verbatim from `src-tauri/src/commands/agent.rs`: `builtin_param_schemas`,
 * `missing_required_arg`, `slim_schema`, plus the schema-budget constants and
 * `EMPTY_STRING_IS_MEANINGFUL`/`SCHEMA_MAP_KEYWORDS`.
 */

import {
  browseToolsSpecs,
  consultAdvisorSpec,
  jobToolsSpecs,
  mcpManagementToolsSpecs,
  externalAgentToolsSpecs,
  scriptToolsSpecs,
  skinToolsSpecs,
  studioToolsSpecs,
  transcribeToolsSpecs,
  toolsCatalog,
  uiToolsSpecs,
  workflowToolsSpecs,
  type OllamaToolSpec,
} from "./toolSpecs.js";
import { clampMarked } from "./textClamp.js";

// ------------------------------------------------------------ schema budgets

/** Longest a slimmed property description may be, in CHARACTERS. Ported from
 * `SCHEMA_DESC_MAX`. */
export const SCHEMA_DESC_MAX = 150;

/** Longest a slimmed TOOL description may be, in characters. Ported from
 * `SCHEMA_TOOL_DESC_MAX`. */
export const SCHEMA_TOOL_DESC_MAX = 300;

/** Longest enum a slimmed schema may advertise. Ported from
 * `SCHEMA_ENUM_MAX`. */
export const SCHEMA_ENUM_MAX = 64;

/** Bookends of the appended enum-truncation note. Ported from
 * `ENUM_NOTE_HEAD`/`ENUM_NOTE_TAIL`. */
const ENUM_NOTE_HEAD = " (showing ";
const ENUM_NOTE_TAIL = "that is not listed)";

/** JSON-Schema keywords whose VALUE is a map of NAME → subschema rather than
 * a subschema itself. Ported from `SCHEMA_MAP_KEYWORDS`. */
const SCHEMA_MAP_KEYWORDS: readonly string[] = [
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * CHG-29: strip a third-party JSON Schema down to what the model needs to
 * call the tool, IN PLACE. Ported verbatim from `slim_schema`, recursion
 * structure included (schema-aware over `SCHEMA_MAP_KEYWORDS` so a connector
 * argument literally named `properties`/`title`/`example` is never mistaken
 * for a JSON-Schema keyword).
 */
export function slimSchema(v: unknown): void {
  if (Array.isArray(v)) {
    slimSchemaArray(v);
    return;
  }
  if (!isPlainObject(v)) {
    return;
  }
  slimSchemaObject(v);
}

function slimSchemaArray(values: unknown[]): void {
  for (const child of values) slimSchema(child);
}

function slimSchemaObject(map: Record<string, unknown>): void {
  removeSchemaNoise(map);
  const priorTotal = takePriorEnumTotal(map);
  clampSchemaDescription(map);
  appendEnumTruncationNote(map, enumTotalAfterSlimming(map, priorTotal));
  slimSchemaChildren(map);
}

function removeSchemaNoise(map: Record<string, unknown>): void {
  for (const k of ["$schema", "title", "examples", "example", "$id", "$comment"]) {
    delete map[k];
  }
  if (map.additionalProperties !== false) delete map.additionalProperties;
  for (const k of Object.keys(map)) {
    if (k.startsWith("x-")) delete map[k];
  }
}

function takePriorEnumTotal(map: Record<string, unknown>): number | undefined {
  const description = map.description;
  if (typeof description !== "string" || !description.endsWith(ENUM_NOTE_TAIL)) return undefined;
  const noteStart = description.lastIndexOf(ENUM_NOTE_HEAD);
  if (noteStart === -1) return undefined;
  map.description = description.slice(0, noteStart);
  return recordedEnumTotal(description.slice(noteStart));
}

function recordedEnumTotal(note: string): number | undefined {
  const afterOf = note.split(" of ")[1];
  const numStr = afterOf?.split(" ")[0];
  if (numStr === undefined) return undefined;
  const parsed = Number.parseInt(numStr, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampSchemaDescription(map: Record<string, unknown>): void {
  if (typeof map.description === "string") map.description = clampMarked(map.description, SCHEMA_DESC_MAX);
}

function enumTotalAfterSlimming(map: Record<string, unknown>, priorTotal: number | undefined): number | undefined {
  if (!Array.isArray(map.enum) || map.enum.length <= SCHEMA_ENUM_MAX) return priorTotal;
  const total = map.enum.length;
  map.enum = map.enum.slice(0, SCHEMA_ENUM_MAX);
  return total;
}

function appendEnumTruncationNote(map: Record<string, unknown>, total: number | undefined): void {
  if (total === undefined) return;
  const note = `${ENUM_NOTE_HEAD}${SCHEMA_ENUM_MAX} of ${total} allowed values — ask the user if you need one ${ENUM_NOTE_TAIL}`;
  if (typeof map.description === "string") {
    map.description += note;
    return;
  }
  map.description = note.trimStart();
}

function slimSchemaChildren(map: Record<string, unknown>): void {
  for (const [k, child] of Object.entries(map)) {
    slimSchemaChild(k, child);
  }
}

function slimSchemaChild(key: string, child: unknown): void {
  if (!SCHEMA_MAP_KEYWORDS.includes(key)) {
    slimSchema(child);
    return;
  }
  slimSchemaMapValues(child);
}

function slimSchemaMapValues(value: unknown): void {
  if (!isPlainObject(value)) return;
  for (const child of Object.values(value)) slimSchema(child);
}

// ------------------------------------------------------------- param schemas

/** Every built-in tool's advertised `parameters` schema, by name. Ported from
 * `builtin_param_schemas`, built once from the SAME spec functions the bridge
 * serves so {@link missingRequiredArg} validates against exactly what the
 * model was told. */
let cachedSchemas: Map<string, Record<string, unknown>> | undefined;

export function builtinParamSchemas(): Map<string, Record<string, unknown>> {
  if (cachedSchemas !== undefined) {
    return cachedSchemas;
  }
  const out = new Map<string, Record<string, unknown>>();
  const absorb = (specs: OllamaToolSpec[]): void => {
    for (const spec of specs) {
      out.set(spec.function.name, spec.function.parameters);
    }
  };
  // `webEnabled: true` so web_search/fetch_page are covered too; this is a
  // validation table, not a catalog, so breadth is correct here.
  absorb(toolsCatalog(true));
  absorb(uiToolsSpecs());
  absorb(skinToolsSpecs());
  absorb(browseToolsSpecs());
  absorb(jobToolsSpecs());
  absorb(workflowToolsSpecs());
  absorb(scriptToolsSpecs());
  absorb(studioToolsSpecs());
  absorb(transcribeToolsSpecs());
  absorb(mcpManagementToolsSpecs());
  absorb(externalAgentToolsSpecs());
  // The advisor spec's enum is runtime-dependent, but its `required` is not —
  // a static rendering (both CLIs "installed") is the right shape here.
  const advisor = consultAdvisorSpec(["claude-cli", "codex-cli"]);
  if (advisor !== null) {
    absorb([advisor]);
  }
  cachedSchemas = out;
  return out;
}

/** Test-only: clear the memoized schema table (mirrors Rust's `OnceLock`
 * being process-lifetime — nothing to clear there, but a JS test module can
 * otherwise leak state across files that import this module fresh each
 * time vitest resets modules). */
export function resetBuiltinParamSchemasCacheForTests(): void {
  cachedSchemas = undefined;
}

/** Required params whose EMPTY STRING is a documented, meaningful value.
 * Ported verbatim from `EMPTY_STRING_IS_MEANINGFUL`. */
const EMPTY_STRING_IS_MEANINGFUL: ReadonlySet<string> = new Set(["move_file:folder"]);

/**
 * The first advertised-required argument this call failed to supply, if any.
 * Ported verbatim from `missing_required_arg`.
 *
 * TOTAL in `args`, deliberately. The Rust source reads every argument through
 * `serde_json::Value`'s `get`, which answers `None` for a Value that is not an
 * object — so `missing_required_arg("open_file", json!("hello"))` there reports
 * `name` as missing rather than failing. The JS analogue is not total for free:
 * `Object.prototype.hasOwnProperty.call(null, k)` THROWS `TypeError: Cannot
 * convert undefined or null to object`, which would turn a malformed tool call
 * into an exception at the one guard whose whole job is to answer malformed
 * tool calls. `args` is typed `Record<string, unknown>`, but the values reaching
 * it come off the wire from a model, and a type annotation is not a runtime
 * check — so a non-object is folded to "supplied nothing", exactly as Rust
 * behaves.
 */
export function missingRequiredArg(tool: string, args: Record<string, unknown>): string | null {
  const supplied = suppliedArguments(args);
  const schema = builtinParamSchemas().get(tool);
  if (schema === undefined) return null;
  const required = schema.required;
  if (!Array.isArray(required)) return null;
  const props = isPlainObject(schema.properties) ? schema.properties : undefined;
  return firstMissingRequiredArg(tool, supplied, required, props);
}

function suppliedArguments(args: Record<string, unknown>): Record<string, unknown> {
  return isPlainObject(args) ? args : {};
}

function firstMissingRequiredArg(
  tool: string,
  supplied: Record<string, unknown>,
  required: unknown[],
  props: Record<string, unknown> | undefined,
): string | null {
  for (const entry of required) {
    if (typeof entry !== "string") return null;
    const key = entry;
    const value = Object.prototype.hasOwnProperty.call(supplied, key) ? supplied[key] : undefined;
    if (requiredValueIsPresent(tool, key, value)) continue;
    return missingArgumentMessage(tool, key, props);
  }
  return null;
}

function requiredValueIsPresent(tool: string, key: string, value: unknown): boolean {
  if (missingValue(value)) return false;
  if (typeof value === "string") return requiredStringIsPresent(tool, key, value);
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function missingValue(value: unknown): boolean {
  return value === undefined || value === null;
}

function requiredStringIsPresent(tool: string, key: string, value: string): boolean {
  return EMPTY_STRING_IS_MEANINGFUL.has(`${tool}:${key}`) || value.trim().length > 0;
}

function missingArgumentMessage(tool: string, key: string, props: Record<string, unknown> | undefined): string {
  return `${key} is required${argumentHint(props, key)}. Nothing was done — call ${tool} again with ${key} set.`;
}

function argumentHint(props: Record<string, unknown> | undefined, key: string): string {
  const prop = props?.[key];
  if (!isPlainObject(prop) || typeof prop.description !== "string") return "";
  return ` — ${prop.description}`;
}
