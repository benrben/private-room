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
    for (const child of v) {
      slimSchema(child);
    }
    return;
  }
  if (!isPlainObject(v)) {
    return;
  }
  const map = v;
  for (const k of ["$schema", "title", "examples", "example", "$id", "$comment"]) {
    delete map[k];
  }
  // Keep `additionalProperties: false` (load-bearing), drop the rest.
  if (map.additionalProperties !== false) {
    delete map.additionalProperties;
  }
  for (const k of Object.keys(map)) {
    if (k.startsWith("x-")) {
      delete map[k];
    }
  }

  // Peel off a note THIS function appended on an earlier pass before touching
  // the description, remembering the real total — see the Rust source's own
  // comment: without this, re-slimming clamps the note off the end while the
  // already-capped enum produces no replacement, silently losing the warning.
  let priorTotal: number | undefined;
  if (typeof map.description === "string" && map.description.endsWith(ENUM_NOTE_TAIL)) {
    const i = map.description.lastIndexOf(ENUM_NOTE_HEAD);
    if (i !== -1) {
      const tail = map.description.slice(i);
      const afterOf = tail.split(" of ")[1];
      const numStr = afterOf?.split(" ")[0];
      const parsed = numStr !== undefined ? Number.parseInt(numStr, 10) : NaN;
      priorTotal = Number.isFinite(parsed) ? parsed : undefined;
      map.description = map.description.slice(0, i);
    }
  }

  if (typeof map.description === "string") {
    map.description = clampMarked(map.description, SCHEMA_DESC_MAX);
  }

  // Announce a truncated enum in the description, so a model that needs a
  // missing value can ask instead of assuming the list it can see is the
  // whole list.
  let truncatedTotal: number | undefined;
  if (Array.isArray(map.enum) && map.enum.length > SCHEMA_ENUM_MAX) {
    truncatedTotal = map.enum.length;
    map.enum = map.enum.slice(0, SCHEMA_ENUM_MAX);
  } else {
    truncatedTotal = priorTotal;
  }
  if (truncatedTotal !== undefined) {
    const note = `${ENUM_NOTE_HEAD}${SCHEMA_ENUM_MAX} of ${truncatedTotal} allowed values — ask the user if you need one ${ENUM_NOTE_TAIL}`;
    if (typeof map.description === "string") {
      map.description += note;
    } else {
      map.description = note.trimStart();
    }
  }

  for (const [k, child] of Object.entries(map)) {
    // A "map of subschemas" keyword's KEYS are names the connector chose, not
    // JSON-Schema keywords: descend one level further so the stripping above
    // never runs against them.
    if (SCHEMA_MAP_KEYWORDS.includes(k)) {
      if (isPlainObject(child)) {
        for (const sub of Object.values(child)) {
          slimSchema(sub);
        }
      }
      continue;
    }
    slimSchema(child);
  }
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
  const supplied: Record<string, unknown> = isPlainObject(args) ? args : {};
  const schema = builtinParamSchemas().get(tool);
  if (schema === undefined) {
    return null;
  }
  const required = schema.required;
  if (!Array.isArray(required)) {
    return null;
  }
  const props = isPlainObject(schema.properties) ? schema.properties : undefined;
  for (const entry of required) {
    if (typeof entry !== "string") {
      return null;
    }
    const key = entry;
    const emptyOk = EMPTY_STRING_IS_MEANINGFUL.has(`${tool}:${key}`);
    const value = Object.prototype.hasOwnProperty.call(supplied, key) ? supplied[key] : undefined;
    let present: boolean;
    if (value === undefined || value === null) {
      present = false;
    } else if (typeof value === "string") {
      present = emptyOk || value.trim().length > 0;
    } else if (Array.isArray(value)) {
      present = value.length > 0;
    } else if (isPlainObject(value)) {
      present = Object.keys(value).length > 0;
    } else {
      // Numbers and booleans are meaningful at any value, including 0/false.
      present = true;
    }
    if (present) {
      continue;
    }
    const hint =
      props !== undefined &&
      isPlainObject(props[key]) &&
      typeof (props[key] as Record<string, unknown>).description === "string"
        ? ` — ${(props[key] as Record<string, unknown>).description as string}`
        : "";
    return `${key} is required${hint}. Nothing was done — call ${tool} again with ${key} set.`;
  }
  return null;
}
