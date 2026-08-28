import { describe, expect, it } from "vitest";
import {
  SCHEMA_DESC_MAX,
  SCHEMA_ENUM_MAX,
  SCHEMA_TOOL_DESC_MAX,
  builtinParamSchemas,
  missingRequiredArg,
  resetBuiltinParamSchemasCacheForTests,
  slimSchema,
} from "./toolSchema.js";
import { scopedSpecs } from "./bridgeDispatcher.js";

describe("the schema TABLE's own membership", () => {
  /**
   * `missingRequiredArg` is a no-op for any tool absent from
   * `builtinParamSchemas`, and nothing else notices: a call with no arguments
   * at all still reaches its arm, so a group silently dropped from the table
   * looks exactly like a group that never had required arguments. This pins
   * the membership itself.
   *
   * THE GAP IS REAL AND DELIBERATE. Three groups the bridge serves —
   * `organize_tools_specs`, `download_tools_specs`, `draw_tools_specs` — are
   * absorbed by neither the Rust `builtin_param_schemas` nor this port, so the
   * central guard genuinely does not cover the nine tools below. Rust's own
   * sweep test (`every_advertised_required_argument_is_actually_enforced`)
   * iterates the table and therefore cannot see past it either. Listing them
   * here by name is the point: it is a known hole, not coverage, and Batch D
   * must port each arm's own argument validation rather than assume this guard
   * caught it.
   */
  const KNOWN_UNVALIDATED = [
    "organize_files",
    "trash_files",
    "set_in_library",
    "merge_files",
    "save_link",
    "download_url",
    "download_media",
    "draw",
    "read_drawing",
  ];

  it("covers every served tool except the nine the Rust source also leaves out", () => {
    const served = new Set(
      [
        ...scopedSpecs(true, { kind: "LocalEngine" }),
        ...scopedSpecs(true, { kind: "ExternalAgent" }),
        ...scopedSpecs(true, { kind: "CloudEngine" }),
      ].map((t) => t.name)
    );
    const table = builtinParamSchemas();
    const uncovered = [...served].filter((n) => !table.has(n)).sort();
    expect(uncovered).toEqual([...KNOWN_UNVALIDATED].sort());
  });

  it("each unvalidated tool is genuinely unguarded — stated as behaviour, not as a list", () => {
    // If a future change absorbs these groups, this test goes red and the
    // KNOWN_UNVALIDATED list above must shrink with it. Either direction is a
    // deliberate edit; neither can happen silently.
    for (const tool of KNOWN_UNVALIDATED) {
      expect(missingRequiredArg(tool, {}), tool).toBeNull();
    }
  });

  it("the groups that ARE in the table stay in it (a dropped absorb() call is otherwise invisible)", () => {
    const table = builtinParamSchemas();
    for (const tool of [
      "open_file", // toolsCatalog
      "web_search", // toolsCatalog, web half
      "ui_act", // uiToolsSpecs
      "browse_do", // browseToolsSpecs
      "start_file_pass", // jobToolsSpecs
      "save_workflow", // workflowToolsSpecs
      "run_script", // scriptToolsSpecs
      "studio_flashcards", // studioToolsSpecs
      "retranscribe_file", // transcribeToolsSpecs
      "save_mcp", // mcpManagementToolsSpecs
      "local_generate", // externalAgentToolsSpecs
      "consult_advisor", // consultAdvisorSpec
    ]) {
      expect(table.has(tool), tool).toBe(true);
    }
    // …and the guard really fires for one from each of those groups, so
    // "present in the table" is not satisfied by an empty schema.
    expect(missingRequiredArg("browse_do", {})).toContain("actions is required");
    expect(missingRequiredArg("save_workflow", {})).toContain("name is required");
    expect(missingRequiredArg("local_generate", {})).toContain("prompt is required");
  });
});

describe("missingRequiredArg is TOTAL in its arguments", () => {
  /**
   * The Rust source reads arguments through `serde_json::Value::get`, which
   * answers `None` for any non-object Value — so a malformed `arguments`
   * becomes "nothing was supplied", never a failure of the guard itself. JS
   * indexing is not total: `Object.prototype.hasOwnProperty.call(null, k)`
   * throws, which would turn the one function whose job is to answer a
   * malformed tool call into the thing that crashes on one.
   */
  it("treats a bare string / array / number / boolean / null / undefined as 'supplied nothing'", () => {
    for (const bad of ["a string", '{"name":"x"}', ["name", "x"], 42, 0, true, null, undefined]) {
      const msg = missingRequiredArg("open_file", bad as unknown as Record<string, unknown>);
      expect(msg, JSON.stringify(bad ?? String(bad))).toContain("name is required");
    }
  });

  it("still answers null for a tool with no required list, whatever the arguments are", () => {
    for (const bad of [null, undefined, "s", [1], 3]) {
      expect(missingRequiredArg("list_memories", bad as unknown as Record<string, unknown>)).toBeNull();
    }
  });
});

describe("missingRequiredArg", () => {
  it("flags an absent required string", () => {
    const msg = missingRequiredArg("open_file", {});
    expect(msg).toContain("name is required");
    expect(msg).toContain("call open_file again with name set");
  });

  it("flags a blank (whitespace-only) required string the same as absent", () => {
    const msg = missingRequiredArg("open_file", { name: "   " });
    expect(msg).not.toBeNull();
  });

  it("flags null the same as absent", () => {
    expect(missingRequiredArg("open_file", { name: null })).not.toBeNull();
  });

  it("accepts a non-empty required string", () => {
    expect(missingRequiredArg("open_file", { name: "notes.md" })).toBeNull();
  });

  it("treats an empty array as a failure", () => {
    expect(missingRequiredArg("edit_files", { edits: [] })).not.toBeNull();
  });

  it("accepts a non-empty array", () => {
    expect(missingRequiredArg("edit_files", { edits: [{ name: "a.md" }] })).toBeNull();
  });

  it("treats an empty object as a failure, a non-empty one as supplied", () => {
    expect(missingRequiredArg("save_mcp", { name: "x", config: {} })).not.toBeNull();
    expect(missingRequiredArg("save_mcp", { name: "x", config: { command: "y" } })).toBeNull();
  });

  it("EMPTY_STRING_IS_MEANINGFUL: move_file's folder may be an empty string", () => {
    expect(missingRequiredArg("move_file", { name: "a.md", folder: "" })).toBeNull();
  });

  it("does not apply the empty-string exception to an unrelated tool's same-named param", () => {
    // rename_file also has a required string param, but it is NOT folder and
    // is NOT move_file — the exception must be keyed by (tool, key), not key
    // alone.
    expect(missingRequiredArg("rename_file", { name: "a.md", new_name: "" })).not.toBeNull();
  });

  it("numbers and booleans are meaningful at any value, including 0/false", () => {
    expect(missingRequiredArg("ui_act", { mark: 0, action: "click" })).toBeNull();
  });

  it("includes the parameter's own schema description as a hint", () => {
    const msg = missingRequiredArg("edit_file", { name: "a.md" });
    expect(msg).toContain("old_text is required");
    expect(msg).toContain("Exact text currently in the file");
  });

  it("is null for a tool this batch does not have a schema for (a connector route)", () => {
    expect(missingRequiredArg("acme_lookup_customer", {})).toBeNull();
  });

  it("returns the FIRST missing required arg, not all of them (edit_file's own required order is name, old_text, new_text)", () => {
    expect(missingRequiredArg("edit_file", {})).toContain("name is required");
    expect(missingRequiredArg("edit_file", { name: "a.md" })).toContain("old_text is required");
    expect(missingRequiredArg("edit_file", { name: "a.md", old_text: "x" })).toContain(
      "new_text is required"
    );
  });
});

describe("slimSchema", () => {
  it("removes vendor-only noise keywords", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      title: "Should be removed",
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://example.com/schema",
      $comment: "internal note",
      examples: [{ a: 1 }],
      example: { a: 1 },
      properties: {},
    };
    slimSchema(schema);
    expect(schema.title).toBeUndefined();
    expect(schema.$schema).toBeUndefined();
    expect(schema.$id).toBeUndefined();
    expect(schema.$comment).toBeUndefined();
    expect(schema.examples).toBeUndefined();
    expect(schema.example).toBeUndefined();
  });

  it("keeps additionalProperties:false but drops any other value", () => {
    const a: Record<string, unknown> = { type: "object", additionalProperties: false };
    slimSchema(a);
    expect(a.additionalProperties).toBe(false);

    const b: Record<string, unknown> = { type: "object", additionalProperties: true };
    slimSchema(b);
    expect(b.additionalProperties).toBeUndefined();

    const c: Record<string, unknown> = { type: "object", additionalProperties: { type: "string" } };
    slimSchema(c);
    expect(c.additionalProperties).toBeUndefined();
  });

  it("strips x- prefixed vendor keys", () => {
    const schema: Record<string, unknown> = { type: "object", "x-vendor-hint": "secret" };
    slimSchema(schema);
    expect(schema["x-vendor-hint"]).toBeUndefined();
  });

  it("clamps a long description with a visible marker, never silently", () => {
    const longDesc = "a".repeat(SCHEMA_DESC_MAX + 50);
    const schema: Record<string, unknown> = { type: "string", description: longDesc };
    slimSchema(schema);
    const desc = schema.description as string;
    expect(desc.length).toBeLessThanOrEqual(SCHEMA_DESC_MAX);
    expect(desc.endsWith("…")).toBe(true);
  });

  it("truncates an oversized enum and announces the truncation in the description", () => {
    const values = Array.from({ length: SCHEMA_ENUM_MAX + 20 }, (_, i) => `v${i}`);
    const schema: Record<string, unknown> = { type: "string", enum: values };
    slimSchema(schema);
    expect((schema.enum as string[]).length).toBe(SCHEMA_ENUM_MAX);
    expect(schema.description as string).toContain(`showing ${SCHEMA_ENUM_MAX} of ${values.length}`);
    expect(schema.description as string).toContain("that is not listed)");
  });

  it("does not touch an enum at or under the cap", () => {
    const values = Array.from({ length: SCHEMA_ENUM_MAX }, (_, i) => `v${i}`);
    const schema: Record<string, unknown> = { type: "string", enum: [...values] };
    slimSchema(schema);
    expect(schema.enum).toEqual(values);
    expect(schema.description).toBeUndefined();
  });

  it("re-slimming an already-slimmed oversized enum does not lose or duplicate the truncation note", () => {
    const values = Array.from({ length: SCHEMA_ENUM_MAX + 37 }, (_, i) => `v${i}`);
    const schema: Record<string, unknown> = { type: "string", enum: values };
    slimSchema(schema);
    const firstPassDesc = schema.description;
    slimSchema(schema); // slim again, as a fresh mcp_routes() build would each turn
    expect(schema.description).toBe(firstPassDesc);
    expect((schema.enum as string[]).length).toBe(SCHEMA_ENUM_MAX);
  });

  it("descends into properties/items but does not mistake a connector's OWN field named 'title'/'properties' for a keyword", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: {
        title: { type: "string", description: "The document's title field" },
        properties: { type: "string", description: "A field literally called properties" },
      },
      required: ["title"],
    };
    slimSchema(schema);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    // The connector's own "title" ARGUMENT survives — only a schema-level
    // `title` KEYWORD (a sibling of `type`) is stripped.
    expect(props.title).toBeDefined();
    expect(props.title?.description).toBe("The document's title field");
    expect(props.properties).toBeDefined();
  });

  it("recurses through arrays", () => {
    const schema = [{ type: "string", title: "x" }, { type: "number", title: "y" }];
    slimSchema(schema);
    expect((schema[0] as Record<string, unknown>).title).toBeUndefined();
    expect((schema[1] as Record<string, unknown>).title).toBeUndefined();
  });

  it("is a no-op on a non-object, non-array value", () => {
    // Must not throw.
    expect(() => slimSchema("just a string")).not.toThrow();
    expect(() => slimSchema(42)).not.toThrow();
    expect(() => slimSchema(null)).not.toThrow();
  });
});

describe("SCHEMA_TOOL_DESC_MAX", () => {
  it("is 300", () => {
    expect(SCHEMA_TOOL_DESC_MAX).toBe(300);
  });
});

describe("resetBuiltinParamSchemasCacheForTests", () => {
  it("does not change the answer (schemas are static across builds)", () => {
    const before = missingRequiredArg("open_file", {});
    resetBuiltinParamSchemasCacheForTests();
    const after = missingRequiredArg("open_file", {});
    expect(after).toBe(before);
  });
});
