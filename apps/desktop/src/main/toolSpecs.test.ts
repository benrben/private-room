import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  DOWNLOAD_TOOL_NAMES,
  MAX_ADVISOR_CALLS,
  MAX_LISTED_MEMORIES,
  MAX_MEMORY_CONTENT_CHARS,
  SKILL_AGENT_IDS,
  consultAdvisorSpec,
  downloadToolsSpecs,
  externalAgentToolsSpecs,
  jobToolsSpecs,
  maskedArgsNote,
  masksOutboundArgs,
  mcpManagementToolsSpecs,
  mediaToolsSpecs,
  organizeToolsSpecs,
  outboundUrlRefusal,
  resolveLocalGenerateModel,
  scriptToolsSpecs,
  studioToolsSpecs,
  toolsCatalog,
  transcribeToolsSpecs,
  uiToolsSpecs,
} from "./toolSpecs.js";

function names(specs: { function: { name: string } }[]): string[] {
  return specs.map((s) => s.function.name);
}

describe("tool group builders", () => {
  it("script_tools_specs names both scripts tools", () => {
    expect(names(scriptToolsSpecs())).toEqual(["list_scripts", "run_script"]);
  });

  it("studio_tools_specs names all three generators", () => {
    expect(names(studioToolsSpecs())).toEqual([
      "studio_flashcards",
      "studio_mindmap",
      "generate_podcast_script",
    ]);
  });

  it("organize_tools_specs names the whole organize box", () => {
    expect(names(organizeToolsSpecs())).toEqual([
      "organize_files",
      "trash_files",
      "set_in_library",
      "merge_files",
    ]);
  });

  it("transcribe_tools_specs names the on-device transcription tools", () => {
    expect(names(transcribeToolsSpecs())).toEqual(["stt_status", "retranscribe_file", "read_recording"]);
  });

  it("job_tools_specs names the whole-file-pass tools", () => {
    expect(names(jobToolsSpecs())).toEqual(["start_file_pass", "job_status"]);
  });

  it("mcp_management_tools_specs names the connector CRUD tools", () => {
    expect(names(mcpManagementToolsSpecs())).toEqual(["list_mcps", "read_mcp", "save_mcp", "delete_mcp"]);
  });

  it("external_agent_tools_specs names only local_generate", () => {
    expect(names(externalAgentToolsSpecs())).toEqual(["local_generate"]);
  });

  it("download_tools_specs matches DOWNLOAD_TOOL_NAMES", () => {
    expect(names(downloadToolsSpecs())).toEqual([...DOWNLOAD_TOOL_NAMES]);
  });

  it("ui_tools_specs names all four UI/perception tools", () => {
    expect(names(uiToolsSpecs())).toEqual(["ui_snapshot", "ui_act", "view_screenshot", "view_media_frame"]);
  });

  it("media_tools_specs is the view_media_frame subset of ui_tools_specs", () => {
    expect(names(mediaToolsSpecs())).toEqual(["view_media_frame"]);
    // Same spec object shape as ui_tools_specs' own entry — not a re-derived copy.
    const fromUi = uiToolsSpecs().find((s) => s.function.name === "view_media_frame");
    expect(mediaToolsSpecs()[0]).toEqual(fromUi);
  });
});

describe("a served spec never aliases module state (Rust's json! clones; a JS literal does not)", () => {
  it("save_skill's agent enum is a COPY, not the SKILL_AGENT_IDS constant itself", () => {
    const saveSkill = toolsCatalog(true).find((t) => t.function.name === "save_skill")!;
    const props = saveSkill.function.parameters.properties as Record<string, { enum?: string[] }>;
    // Same VALUES (pinned by the test further down) but not the same object:
    // `execSaveSkill` validates the model's `agent` against SKILL_AGENT_IDS,
    // and `slimSchema` — this codebase's one schema transform — edits schemas
    // IN PLACE. Handing out the constant would let one in-place edit of a
    // served catalog change what save_skill accepts, process-wide and
    // permanently.
    expect(props.agent?.enum).not.toBe(SKILL_AGENT_IDS);
    expect(props.agent?.enum).toEqual([...SKILL_AGENT_IDS]);
    // Two builds do not share it either.
    const again = toolsCatalog(true).find((t) => t.function.name === "save_skill")!;
    const againProps = again.function.parameters.properties as Record<string, { enum?: string[] }>;
    expect(againProps.agent?.enum).not.toBe(props.agent?.enum);
  });

  it("the three studio specs own three independent `refs` schemas, not one shared object", () => {
    // Rust writes the property out three times, so its three specs are
    // independent JSON values. One shared object literal here would make
    // slimming (or any in-place edit of) studio_flashcards silently rewrite
    // studio_mindmap and generate_podcast_script too.
    const specs = studioToolsSpecs();
    const refsOf = (name: string) =>
      (specs.find((s) => s.function.name === name)!.function.parameters.properties as Record<string, unknown>)
        .refs;
    const a = refsOf("studio_flashcards");
    const b = refsOf("studio_mindmap");
    const c = refsOf("generate_podcast_script");
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });
});

describe("consult_advisor_spec", () => {
  it("is null when no recognised advisor CLI is installed", () => {
    expect(consultAdvisorSpec([])).toBeNull();
    expect(consultAdvisorSpec(["some-other-cli"])).toBeNull();
  });

  it("offers only the enum values for CLIs actually installed", () => {
    const claudeOnly = consultAdvisorSpec(["claude-cli"]);
    expect(claudeOnly?.function.parameters.properties).toMatchObject({
      advisor: { enum: ["claude"] },
    });
    const both = consultAdvisorSpec(["claude-cli", "codex-cli", "unknown-cli"]);
    expect(both?.function.parameters.properties).toMatchObject({
      advisor: { enum: ["claude", "codex"] },
    });
  });

  it("always requires question", () => {
    const spec = consultAdvisorSpec(["codex-cli"]);
    expect(spec?.function.parameters.required).toEqual(["question"]);
  });
});

describe("resolve_local_generate_model", () => {
  it("keeps the explicit model when it runs on this Mac", () => {
    const got = resolveLocalGenerateModel(
      "qwen3.5:4b",
      ["qwen3.5:4b", "llama3"],
      (m) => m === "qwen3.5:4b",
      () => "llama3"
    );
    expect(got).toBe("qwen3.5:4b");
  });

  it("falls back to the local default when the explicit model is a cloud proxy", () => {
    const got = resolveLocalGenerateModel(
      "gpt-4:cloud",
      ["qwen3.5:4b"],
      (m) => !m.endsWith(":cloud"),
      (models) => models[0] ?? "none"
    );
    expect(got).toBe("qwen3.5:4b");
  });

  it("falls back when nothing explicit was given", () => {
    const got = resolveLocalGenerateModel(undefined, ["a", "b"], () => true, () => "a");
    expect(got).toBe("a");
  });
});

describe("outbound_url_refusal", () => {
  it("passes through null when the URL hides nothing", () => {
    expect(outboundUrlRefusal("https://example.com", () => null)).toBeNull();
  });

  it("names the count and points at the setting", () => {
    const msg = outboundUrlRefusal("https://example.com/?q=Ben", () => 2);
    expect(msg).toContain("2 protected name(s)");
    expect(msg).toContain("Settings → Cloud privacy");
  });
});

describe("masks_outbound_args / masked_args_note", () => {
  it("masks only a remote connector without the unmask preference", () => {
    expect(masksOutboundArgs(true, false)).toBe(true);
    expect(masksOutboundArgs(true, true)).toBe(false);
    expect(masksOutboundArgs(false, false)).toBe(false);
    expect(masksOutboundArgs(false, true)).toBe(false);
  });

  it("says nothing when nothing was hidden", () => {
    expect(maskedArgsNote("gmail", 0)).toBeNull();
  });

  it("reports the count and connector, singular vs plural", () => {
    expect(maskedArgsNote("gmail", 1)).toContain("hid 1 protected value in");
    const note = maskedArgsNote("gmail", 2)!;
    expect(note).toContain("hid 2 protected values");
    expect(note).toContain('"gmail"');
    expect(note).toContain('Send remote connectors real values');
  });
});

describe("tools_catalog", () => {
  it("omits web_search/fetch_page when web is disabled", () => {
    const names_ = names(toolsCatalog(false));
    expect(names_).not.toContain("web_search");
    expect(names_).not.toContain("fetch_page");
  });

  it("includes web_search/fetch_page when web is enabled", () => {
    const names_ = names(toolsCatalog(true));
    expect(names_).toContain("web_search");
    expect(names_).toContain("fetch_page");
  });

  it("every catalog tool name is a real BUILTIN_TOOL_NAMES entry", () => {
    for (const n of names(toolsCatalog(true))) {
      expect(BUILTIN_TOOL_NAMES).toContain(n);
    }
  });

  it("has no duplicate tool names", () => {
    const list = names(toolsCatalog(true));
    expect(new Set(list).size).toBe(list.length);
  });

  it("save_skill's agent enum is exactly SKILL_AGENT_IDS", () => {
    const saveSkill = toolsCatalog(true).find((t) => t.function.name === "save_skill")!;
    const props = saveSkill.function.parameters.properties as Record<string, { enum?: string[] }>;
    expect(props.agent?.enum).toEqual([...SKILL_AGENT_IDS]);
  });

  it("copies edit_file's description verbatim (spot check on exact wording)", () => {
    const editFile = toolsCatalog(true).find((t) => t.function.name === "edit_file")!;
    expect(editFile.function.description).toContain(
      "Copy old_text exactly as it appears — curly quotes/spacing/dashes are matched tolerantly"
    );
    expect(editFile.function.description).toContain("To change several places or files at once, use edit_files.");
  });

  it("create_file's HTML-sandbox warning is present verbatim", () => {
    const createFile = toolsCatalog(true).find((t) => t.function.name === "create_file")!;
    expect(createFile.function.description).toContain(
      "NEVER reference a CDN or any external <script src>/<link href>/remote image"
    );
  });
});

describe("constants", () => {
  it("MAX_ADVISOR_CALLS is 1", () => {
    expect(MAX_ADVISOR_CALLS).toBe(1);
  });
  it("MAX_MEMORY_CONTENT_CHARS is 500", () => {
    expect(MAX_MEMORY_CONTENT_CHARS).toBe(500);
  });
  it("MAX_LISTED_MEMORIES is 50", () => {
    expect(MAX_LISTED_MEMORIES).toBe(50);
  });
  it("BUILTIN_TOOL_NAMES has no duplicates", () => {
    expect(new Set(BUILTIN_TOOL_NAMES).size).toBe(BUILTIN_TOOL_NAMES.length);
  });
});
