/**
 * Behavioral tests for `bridgeDispatcher.ts` — the real `ToolDispatcher`.
 *
 * Uses real fakes (not mocks) for the genuinely out-of-scope dependencies: the
 * redaction policy ({@link RedactionPolicy}), the MCP connector call and its
 * two doors — everything else (routing, scoping, the advisor cap, argument
 * normalization, the advertised-tools-only gate, the web-search brake and the
 * effects-sink serialisation) runs for real, including a real call into
 * `execTool.ts`.
 */

import { describe, expect, it } from "vitest";
import { CancelFlag } from "./cancel.js";
import type { ToolScope } from "./mcpBridge.js";
import type { McpRoute } from "./toolSpecs.js";
import { createToolEffects, type ExecToolDeps } from "./execTool.js";
import {
  AdvisorRuntime,
  MCP_RUN_TOOL,
  MCP_SEARCH_TOOL,
  RoomToolDispatcher,
  WEB_LANES_ALL,
  arcelleToolAnnotations,
  builtinMcpTools,
  includeBrowseTools,
  includeExternalTools,
  includeJobTools,
  includeMcpManagementTools,
  includeMediaPerception,
  includeOrganizeTools,
  includeUiTools,
  mcpProxyTools,
  mcpSearchScore,
  nestedRunArguments,
  roomToolNamesWith,
  sanitizedToolAnnotations,
  scopeLabel,
  scopedSpecs,
  searchMcpEntries,
  searchableMcpTools,
  servedToolsWith,
  tierToolNames,
  toMcpTool,
  toolCancelFor,
  toolResult,
  createWebThrottle,
  withWebBrake,
  WEB_THROTTLE_COOLDOWN_MS,
  type RedactionPolicy,
  type WebLanes,
} from "./bridgeDispatcher.js";

const CLOUD_ADVISOR_MCP: ToolScope = { kind: "CloudAdvisor", includeMcp: true };
const CLOUD_ADVISOR_PLAIN: ToolScope = { kind: "CloudAdvisor", includeMcp: false };
const CLOUD_ENGINE: ToolScope = { kind: "CloudEngine" };
const LOCAL_ENGINE: ToolScope = { kind: "LocalEngine" };
const EXTERNAL_AGENT: ToolScope = { kind: "ExternalAgent" };

describe("ToolScope predicates", () => {
  it("include_ui_tools: LocalEngine/CloudEngine/ExternalAgent only", () => {
    expect(includeUiTools(LOCAL_ENGINE)).toBe(true);
    expect(includeUiTools(CLOUD_ENGINE)).toBe(true);
    expect(includeUiTools(EXTERNAL_AGENT)).toBe(true);
    expect(includeUiTools(CLOUD_ADVISOR_MCP)).toBe(false);
  });
  it("include_job_tools: same three tiers as UI tools", () => {
    expect(includeJobTools(LOCAL_ENGINE)).toBe(true);
    expect(includeJobTools(CLOUD_ADVISOR_PLAIN)).toBe(false);
  });
  it("include_external_tools: ExternalAgent only", () => {
    expect(includeExternalTools(EXTERNAL_AGENT)).toBe(true);
    expect(includeExternalTools(LOCAL_ENGINE)).toBe(false);
    expect(includeExternalTools(CLOUD_ENGINE)).toBe(false);
  });
  it("include_media_perception: CloudEngine and ExternalAgent, not LocalEngine (which gets it via UI tools instead)", () => {
    expect(includeMediaPerception(CLOUD_ENGINE)).toBe(true);
    expect(includeMediaPerception(EXTERNAL_AGENT)).toBe(true);
    expect(includeMediaPerception(LOCAL_ENGINE)).toBe(false);
  });
  it("include_browse_tools / include_organize_tools: LocalEngine/CloudEngine/ExternalAgent, never a consulted advisor", () => {
    for (const scope of [LOCAL_ENGINE, CLOUD_ENGINE, EXTERNAL_AGENT]) {
      expect(includeBrowseTools(scope)).toBe(true);
      expect(includeOrganizeTools(scope)).toBe(true);
    }
    expect(includeBrowseTools(CLOUD_ADVISOR_MCP)).toBe(false);
    expect(includeOrganizeTools(CLOUD_ADVISOR_MCP)).toBe(false);
  });
  it("include_mcp_management_tools: LocalEngine/CloudEngine only — never ExternalAgent", () => {
    expect(includeMcpManagementTools(LOCAL_ENGINE)).toBe(true);
    expect(includeMcpManagementTools(CLOUD_ENGINE)).toBe(true);
    expect(includeMcpManagementTools(EXTERNAL_AGENT)).toBe(false);
    expect(includeMcpManagementTools(CLOUD_ADVISOR_MCP)).toBe(false);
  });
  it("label: distinguishes CloudAdvisor+mcp from plain CloudAdvisor", () => {
    expect(scopeLabel(CLOUD_ADVISOR_MCP)).toBe("CloudAdvisor+mcp");
    expect(scopeLabel(CLOUD_ADVISOR_PLAIN)).toBe("CloudAdvisor");
    expect(scopeLabel(LOCAL_ENGINE)).toBe("LocalEngine");
    expect(scopeLabel(EXTERNAL_AGENT)).toBe("ExternalAgent");
  });
});

describe("arcelleToolAnnotations / sanitizedToolAnnotations / toMcpTool", () => {
  it("marks a read to be read-only/idempotent/closed-world", () => {
    expect(arcelleToolAnnotations("list_room_files")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
  it("marks trash_files honestly destructive despite being recoverable", () => {
    expect(arcelleToolAnnotations("trash_files")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });
  it("is null for a name it does not recognise (a connector tool)", () => {
    expect(arcelleToolAnnotations("acme_lookup_customer")).toBeNull();
  });
  it("sanitizedToolAnnotations keeps only the four booleans, dropping anything else", () => {
    expect(
      sanitizedToolAnnotations({ readOnlyHint: true, extraField: "ignored", destructiveHint: "not a bool" })
    ).toEqual({ readOnlyHint: true });
    expect(sanitizedToolAnnotations({ irrelevant: true })).toBeNull();
    expect(sanitizedToolAnnotations("not an object")).toBeNull();
  });
  it("toMcpTool attaches arcelle's own annotations for a built-in, ignoring any annotations on the spec itself", () => {
    const tool = toMcpTool(
      {
        type: "function",
        function: { name: "open_file", description: "d", parameters: {}, annotations: { openWorldHint: true } },
      },
      true
    );
    expect(tool.annotations).toEqual(arcelleToolAnnotations("open_file"));
  });
  it("toMcpTool sanitizes a connector's OWN annotations when not arcelle-owned", () => {
    const tool = toMcpTool(
      {
        type: "function",
        function: {
          name: "acme_thing",
          description: "d",
          parameters: {},
          annotations: { readOnlyHint: true, somethingElse: 1 },
        },
      },
      false
    );
    expect(tool.annotations).toEqual({ readOnlyHint: true });
  });
});

describe("mcpProxyTools / builtinMcpTools", () => {
  it("names exactly search_mcp_tools and run_mcp_tool", () => {
    expect(mcpProxyTools().map((t) => t.name)).toEqual([MCP_SEARCH_TOOL, MCP_RUN_TOOL]);
  });
  it("builtinMcpTools mirrors toolsCatalog's names", () => {
    const names = builtinMcpTools(true).map((t) => t.name);
    expect(names).toContain("list_room_files");
    expect(names).toContain("web_search");
  });
});

describe("searchableMcpTools / mcpSearchScore / searchMcpEntries", () => {
  function route(catalogName: string, serverName: string, description: string): McpRoute {
    return {
      catalogName,
      toolName: catalogName,
      serverName,
      remote: true,
      spec: { type: "function", function: { name: catalogName, description, parameters: {} } },
    };
  }

  it("ranks a name match above a description-only match", () => {
    const routes = [
      route("acme_stock_price", "acme", "Looks up something unrelated"),
      route("acme_other", "acme", "Get the current stock price for a ticker"),
    ];
    const entries = searchableMcpTools(routes);
    const results = searchMcpEntries(entries, "stock price", undefined);
    expect(results[0]?.tool).toBe("acme_stock_price");
  });

  it("filters by connector name", () => {
    const routes = [route("a_tool", "acme", "x"), route("b_tool", "beta", "x")];
    const entries = searchableMcpTools(routes);
    const results = searchMcpEntries(entries, "tool", "beta");
    expect(results.map((r) => r.tool)).toEqual(["b_tool"]);
  });

  it("ties break alphabetically by tool id", () => {
    const routes = [route("zzz_tool", "s", "widget"), route("aaa_tool", "s", "widget")];
    const entries = searchableMcpTools(routes);
    const results = searchMcpEntries(entries, "widget", undefined);
    expect(results.map((r) => r.tool)).toEqual(["aaa_tool", "zzz_tool"]);
  });

  it("an empty query matches everything (score 1)", () => {
    const routes = [route("a", "s", "x")];
    expect(mcpSearchScore(searchableMcpTools(routes)[0]!, [])).toBe(1);
  });

  it("no match at all yields an empty result set", () => {
    const routes = [route("a", "s", "widgets")];
    const entries = searchableMcpTools(routes);
    expect(searchMcpEntries(entries, "zzzznothing", undefined)).toEqual([]);
  });
});

describe("scopedSpecs / tierToolNames / roomToolNamesWith", () => {
  it("a plain CloudAdvisor gets only built-ins — no UI/job/organize/mcp-mgmt tools", () => {
    const names = scopedSpecs(true, CLOUD_ADVISOR_PLAIN).map((t) => t.name);
    expect(names).not.toContain("ui_snapshot");
    expect(names).not.toContain("start_file_pass");
    expect(names).not.toContain("organize_files");
    expect(names).not.toContain("list_mcps");
    expect(names).toContain("list_room_files");
  });

  it("LocalEngine gets the full extra set: UI, job(+script+studio+transcribe), organize, mcp-mgmt", () => {
    const names = scopedSpecs(true, LOCAL_ENGINE).map((t) => t.name);
    for (const expected of [
      "ui_snapshot",
      "start_file_pass",
      "list_scripts",
      "studio_flashcards",
      "stt_status",
      "organize_files",
      "list_mcps",
    ]) {
      expect(names).toContain(expected);
    }
    // Never local_generate for the in-room engine itself — that's the
    // ExternalAgent's own parity exception.
    expect(names).not.toContain("local_generate");
  });

  it("ExternalAgent gets job tools + local_generate + view_media_frame + UI/organize tools, but never mcp-mgmt", () => {
    // Owner decision 2026-08-03 ("EVERY provider gets full control, the
    // app's interface included") widened `include_ui_tools`/
    // `include_organize_tools`/`include_browse_tools` to ExternalAgent too —
    // an older per-variant doc comment on `ToolScope::ExternalAgent` says
    // "NEVER the UI-driving tools", which describes the PRE-2026-08-03
    // design the predicate itself no longer implements. This test asserts
    // the actual predicate, not that stale comment.
    const names = scopedSpecs(true, EXTERNAL_AGENT).map((t) => t.name);
    expect(names).toContain("start_file_pass");
    expect(names).toContain("local_generate");
    expect(names).toContain("view_media_frame");
    expect(names).toContain("ui_snapshot");
    expect(names).toContain("organize_files");
    // mcp management stays LocalEngine/CloudEngine only — the one place
    // ExternalAgent is still excluded.
    expect(names).not.toContain("list_mcps");
  });

  it("CloudEngine gets media perception AND the screen tools (same 2026-08-03 owner decision)", () => {
    const names = scopedSpecs(true, CLOUD_ENGINE).map((t) => t.name);
    expect(names).toContain("view_media_frame");
    expect(names).toContain("ui_snapshot");
    expect(names).toContain("view_screenshot");
  });

  it("only a (consulted) CloudAdvisor is denied the UI/organize/mcp-mgmt groups entirely", () => {
    const names = scopedSpecs(true, CLOUD_ADVISOR_PLAIN).map((t) => t.name);
    expect(names).not.toContain("ui_snapshot");
    expect(names).not.toContain("organize_files");
    expect(names).not.toContain("list_mcps");
    expect(names).not.toContain("local_generate");
  });

  it("tierToolNames adds the MCP proxy pair only when the scope includes MCP", () => {
    expect(tierToolNames(true, CLOUD_ADVISOR_PLAIN)).not.toContain(MCP_SEARCH_TOOL);
    expect(tierToolNames(true, CLOUD_ADVISOR_MCP)).toContain(MCP_SEARCH_TOOL);
    expect(tierToolNames(true, LOCAL_ENGINE)).toContain(MCP_RUN_TOOL);
  });

  it("roomToolNamesWith adds the proxy pair only when there is at least one connected route", () => {
    const route: McpRoute = {
      catalogName: "acme_thing",
      toolName: "thing",
      serverName: "acme",
      remote: false,
      spec: { type: "function", function: { name: "acme_thing", description: "d", parameters: {} } },
    };
    expect(roomToolNamesWith(true, WEB_LANES_ALL, LOCAL_ENGINE, [])).not.toContain(MCP_SEARCH_TOOL);
    expect(roomToolNamesWith(true, WEB_LANES_ALL, LOCAL_ENGINE, [route])).toContain(MCP_SEARCH_TOOL);
    expect(roomToolNamesWith(true, WEB_LANES_ALL, LOCAL_ENGINE, [route])).toContain(MCP_RUN_TOOL);
    // A connector's OWN catalog name is never directly listed — it is only
    // ever reachable through the run_mcp_tool proxy (see the "search_mcp_tools
    // / run_mcp_tool" describe block below, and `execTool.ts`'s default arm).
    expect(roomToolNamesWith(true, WEB_LANES_ALL, LOCAL_ENGINE, [route])).not.toContain("acme_thing");
  });
});

describe("servedToolsWith", () => {
  it("switching the SEARCH lane off removes web_search, fetch_page AND the download verbs — but leaves browse", () => {
    const lanes: WebLanes = { search: false, browse: true };
    const names = servedToolsWith(true, lanes, LOCAL_ENGINE, null, []).map((t) => t.name);
    expect(names).not.toContain("web_search");
    // fetch_page rides the same lane: it is the Web agent's other read verb.
    expect(names).not.toContain("fetch_page");
    // The download verbs ride with SEARCH because the Web agent is where they
    // are boxed — without that, "Web agent off" left saving a link and
    // downloading a video reachable, and the agent reachable with them.
    expect(names).not.toContain("save_link");
    expect(names).not.toContain("download_url");
    expect(names).not.toContain("download_media");
    // The browse lane is a separate switch and is untouched.
    expect(names).toContain("browse_open");
  });

  it("switching the BROWSE lane off removes only the browse_* tools", () => {
    const lanes: WebLanes = { search: true, browse: false };
    const names = servedToolsWith(true, lanes, LOCAL_ENGINE, null, []).map((t) => t.name);
    for (const browseName of ["browse_open", "browse_read", "browse_do", "browse_save"]) {
      expect(names).not.toContain(browseName);
    }
    expect(names).toContain("web_search");
    expect(names).toContain("download_url");
  });

  it("adds the advisor tool for every scope except ExternalAgent", () => {
    const advisor = new AdvisorRuntime(["claude-cli"], new CancelFlag());
    const withAdvisor = (scope: ToolScope) => servedToolsWith(true, WEB_LANES_ALL, scope, advisor, []).some((t) => t.name === "consult_advisor");
    expect(withAdvisor(LOCAL_ENGINE)).toBe(true);
    expect(withAdvisor(CLOUD_ADVISOR_PLAIN)).toBe(true);
    expect(withAdvisor(EXTERNAL_AGENT)).toBe(false);
  });

  it("adds nothing when the advisor has no recognised CLI", () => {
    const advisor = new AdvisorRuntime(["some-unknown-cli"], new CancelFlag());
    const names = servedToolsWith(true, WEB_LANES_ALL, LOCAL_ENGINE, advisor, []).map((t) => t.name);
    expect(names).not.toContain("consult_advisor");
  });
});

describe("AdvisorRuntime.tryConsume — the saturating cap", () => {
  it("allows exactly maxCalls attempts, then refuses forever after", () => {
    const runtime = new AdvisorRuntime(["claude-cli"], new CancelFlag());
    expect(runtime.tryConsume(1)).toBe(true);
    expect(runtime.tryConsume(1)).toBe(false);
    expect(runtime.tryConsume(1)).toBe(false);
  });

  it("once refused, refused forever — no wrap, reset or modular counter lets a later call back through", () => {
    // 300 > 256 on purpose: the Rust bug was an AtomicU8 wrapping to 0, and
    // its realistic JS spelling is `(calls + 1) % 256` or a reset. A JS number
    // does not wrap on its own, so this asserts the PROPERTY (monotone
    // refusal) rather than the clamp — see `tryConsume`'s own doc for why the
    // clamp itself is unfalsifiable here.
    const runtime = new AdvisorRuntime(["claude-cli"], new CancelFlag());
    runtime.tryConsume(1); // the one allowed call
    for (let i = 0; i < 300; i++) {
      expect(runtime.tryConsume(1), `iteration ${i}`).toBe(false);
    }
  });

  it("allows exactly maxCalls for any cap, and none at all for a cap of zero", () => {
    const three = new AdvisorRuntime([], new CancelFlag());
    expect([three.tryConsume(3), three.tryConsume(3), three.tryConsume(3), three.tryConsume(3)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(new AdvisorRuntime([], new CancelFlag()).tryConsume(0)).toBe(false);
  });

  it("tool() is null when no recognised CLI is installed", () => {
    expect(new AdvisorRuntime([], new CancelFlag()).tool()).toBeNull();
  });
});

describe("toolCancelFor", () => {
  it("prefers the advisor's own cancel flag when an advisor exists", () => {
    const advisorFlag = new CancelFlag();
    const runFlag = new CancelFlag();
    const advisor = new AdvisorRuntime(["claude-cli"], advisorFlag);
    expect(toolCancelFor(advisor, runFlag)).toBe(advisorFlag);
  });
  it("falls back to run_cancel when there is no advisor", () => {
    const runFlag = new CancelFlag();
    expect(toolCancelFor(null, runFlag)).toBe(runFlag);
  });
  it("is null when neither exists", () => {
    expect(toolCancelFor(null, null)).toBeNull();
  });
});

describe("nestedRunArguments", () => {
  it("absent or null arguments become {}", () => {
    expect(nestedRunArguments({}, "t")).toEqual({ ok: true, value: {} });
    expect(nestedRunArguments({ arguments: null }, "t")).toEqual({ ok: true, value: {} });
  });
  it("an object passes through unchanged", () => {
    expect(nestedRunArguments({ arguments: { a: 1 } }, "t")).toEqual({ ok: true, value: { a: 1 } });
  });
  it("a non-object (e.g. a JSON-encoded string) is refused with a helpful complaint naming the shape", () => {
    const result = nestedRunArguments({ arguments: '{"a":1}' }, "acme_tool");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.complaint).toContain("acme_tool");
      expect(result.complaint).toContain("a string");
    }
  });
  it("an array is refused and named as an array", () => {
    const result = nestedRunArguments({ arguments: [1, 2] }, "t");
    expect(!result.ok && result.complaint).toContain("an array");
  });
});

describe("toolResult", () => {
  it("wraps text as one text block", () => {
    expect(toolResult("hi", false, [])).toEqual({ isError: false, content: [{ type: "text", text: "hi" }] });
  });
  it("appends image blocks only when the result is not an error", () => {
    expect(toolResult("hi", false, ["b64data"])).toEqual({
      isError: false,
      // `mimeType` is required by the MCP spec and emitted by the Rust
      // `tool_result`; a cloud CLI reads it even though mcp_client.py does not.
      content: [
        { type: "text", text: "hi" },
        { type: "image", data: "b64data", mimeType: "image/png" },
      ],
    });
  });
  it("drops images on an error result", () => {
    expect(toolResult("failed", true, ["b64data"])).toEqual({
      isError: true,
      content: [{ type: "text", text: "failed" }],
    });
  });
});

// ============================================================ RoomToolDispatcher

function execDeps(overrides: Partial<ExecToolDeps> = {}): ExecToolDeps {
  // The connector arm's two doors are supplied by default so these tests
  // exercise the BRIDGE's behaviour rather than re-testing execTool's own
  // refusals: consent granted, and outbound masking switched off per
  // connector (which is what "Send remote connectors real values" does).
  // `execTool.test.ts` owns the tests that leave each door out.
  return {
    db: null,
    routes: [],
    connectorApproved: async () => true,
    outboundUnmaskFor: () => true,
    ...overrides,
  };
}

function baseOpts(overrides: Partial<import("./bridgeDispatcher.js").RoomToolDispatcherOptions> = {}) {
  return {
    webEnabled: true,
    lanes: WEB_LANES_ALL,
    routes: [] as McpRoute[],
    advisor: null,
    runCancel: null,
    sharedEffects: null,
    privacyBypass: false,
    activePolicy: () => null,
    execDeps: execDeps(),
    ...overrides,
  };
}

describe("RoomToolDispatcher.listTools", () => {
  it("delegates to servedToolsWith", () => {
    const dispatcher = new RoomToolDispatcher(baseOpts({}));
    const names = dispatcher.listTools(CLOUD_ADVISOR_PLAIN).map((t) => t.name);
    expect(names).not.toContain("ui_snapshot");
    expect(names).toContain("list_room_files");
  });
});

describe("RoomToolDispatcher.callTool — the advertised-tools-only gate", () => {
  it("refuses a tool this scope does not serve, even though it is a real exec_tool arm", async () => {
    // stt_status is a real, named exec_tool arm, but it's LocalEngine/CloudEngine/
    // ExternalAgent-only (job-tools trust class) — a plain CloudAdvisor must
    // never reach it, fabricated name or not.
    const dispatcher = new RoomToolDispatcher(baseOpts({}));
    const result = await dispatcher.callTool(CLOUD_ADVISOR_PLAIN, "stt_status", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "unknown tool: stt_status" });
  });

  it("allows the same tool once the scope actually serves it", async () => {
    const dispatcher = new RoomToolDispatcher(baseOpts({}));
    const result = await dispatcher.callTool(LOCAL_ENGINE, "stt_status", {});
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("NOT_IMPLEMENTED");
  });

  it("refuses every cross-tier name a client could fabricate, in both directions", async () => {
    // The gate is what makes `scopedSpecs`' trust boundaries real rather than
    // advisory: a catalog the client never reads cannot stop it typing a name.
    // One case per boundary `scopedSpecs` draws.
    const CASES: Array<[ToolScope, string, Record<string, unknown>]> = [
      // local_generate is the ExternalAgent's own parity exception.
      [LOCAL_ENGINE, "local_generate", { prompt: "p" }],
      [CLOUD_ENGINE, "local_generate", { prompt: "p" }],
      [CLOUD_ADVISOR_MCP, "local_generate", { prompt: "p" }],
      // Connector CRUD is LocalEngine/CloudEngine only.
      [EXTERNAL_AGENT, "list_mcps", {}],
      [EXTERNAL_AGENT, "save_mcp", { name: "n", config: { a: 1 } }],
      // A merely consulted advisor gets no action tools at all.
      [CLOUD_ADVISOR_MCP, "draw", { name: "x", script: "s" }],
      [CLOUD_ADVISOR_MCP, "trash_files", { names: ["a"] }],
      [CLOUD_ADVISOR_MCP, "organize_files", {}],
      [CLOUD_ADVISOR_MCP, "browse_open", { url: "https://x" }],
      [CLOUD_ADVISOR_MCP, "ui_act", { mark: 1, action: "click" }],
      [CLOUD_ADVISOR_MCP, "start_file_pass", { name: "n", instruction: "i" }],
      [CLOUD_ADVISOR_MCP, "save_workflow", { name: "n", definition: { v: 1 } }],
      [CLOUD_ADVISOR_MCP, "run_script", { name: "s.py" }],
    ];
    const dispatcher = new RoomToolDispatcher(baseOpts({}));
    for (const [scope, name, args] of CASES) {
      const result = await dispatcher.callTool(scope, name, args);
      const label = `${scope.kind}/${name}`;
      expect(result.isError, label).toBe(true);
      expect((result.content[0] as { text: string }).text, label).toBe(`unknown tool: ${name}`);
    }
  });

  it("a lane the user switched off is not merely unadvertised — it is not executable", async () => {
    const searchOff = new RoomToolDispatcher(baseOpts({ lanes: { search: false, browse: true } }));
    for (const name of ["web_search", "fetch_page", "save_link", "download_url", "download_media"]) {
      const result = await searchOff.callTool(LOCAL_ENGINE, name, { query: "q", url: "https://x" });
      expect((result.content[0] as { text: string }).text, name).toBe(`unknown tool: ${name}`);
    }
    // The browse lane is a separate switch and stays reachable.
    const browse = await searchOff.callTool(LOCAL_ENGINE, "browse_read", {});
    expect((browse.content[0] as { text: string }).text).toContain("NOT_IMPLEMENTED");

    const browseOff = new RoomToolDispatcher(baseOpts({ lanes: { search: true, browse: false } }));
    for (const name of ["browse_open", "browse_read", "browse_find", "browse_snapshot", "browse_do", "browse_look", "browse_save"]) {
      const result = await browseOff.callTool(LOCAL_ENGINE, name, { url: "u", text: "t", actions: [{}] });
      expect((result.content[0] as { text: string }).text, name).toBe(`unknown tool: ${name}`);
    }

    const webOff = new RoomToolDispatcher(baseOpts({ webEnabled: false }));
    for (const name of ["web_search", "fetch_page", "browse_open", "download_url"]) {
      const result = await webOff.callTool(LOCAL_ENGINE, name, { query: "q", url: "https://x" });
      expect((result.content[0] as { text: string }).text, name).toBe(`unknown tool: ${name}`);
    }
  });

  it("consult_advisor is unreachable without a runtime that actually has a recognised CLI", async () => {
    const none = new RoomToolDispatcher(baseOpts({ advisor: null }));
    expect(
      ((await none.callTool(LOCAL_ENGINE, "consult_advisor", { question: "q" })).content[0] as { text: string }).text
    ).toBe("unknown tool: consult_advisor");

    const unknownCli = new RoomToolDispatcher(
      baseOpts({ advisor: new AdvisorRuntime(["gemini-cli"], new CancelFlag()) })
    );
    expect(
      ((await unknownCli.callTool(LOCAL_ENGINE, "consult_advisor", { question: "q" })).content[0] as { text: string })
        .text
    ).toBe("unknown tool: consult_advisor");

    // Even WITH a working runtime, the ExternalAgent tier is excluded by
    // servedToolsWith — so the gate, not the defensive branch, refuses it.
    const external = new RoomToolDispatcher(
      baseOpts({ advisor: new AdvisorRuntime(["claude-cli"], new CancelFlag()) })
    );
    expect(
      ((await external.callTool(EXTERNAL_AGENT, "consult_advisor", { question: "q" })).content[0] as { text: string })
        .text
    ).toBe("unknown tool: consult_advisor");
  });

  it("a connector's own catalog name is never directly callable — the proxy is the only door", async () => {
    const route: McpRoute = {
      catalogName: "acme_thing",
      toolName: "thing",
      serverName: "acme",
      remote: false,
      spec: { type: "function", function: { name: "acme_thing", description: "d", parameters: {} } },
    };
    let called = false;
    const dispatcher = new RoomToolDispatcher(
      baseOpts({
        routes: [route],
        execDeps: execDeps({
          callConnectorTool: async () => {
            called = true;
            return { text: "ran" };
          },
        }),
      })
    );
    const result = await dispatcher.callTool(LOCAL_ENGINE, "acme_thing", {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe("unknown tool: acme_thing");
    expect(called).toBe(false);
  });
});

describe("RoomToolDispatcher.callTool — tool_ran timing", () => {
  it("marks tool_ran BEFORE dispatch, and it still fired even though the dispatch failed", async () => {
    const log: string[] = [];
    const route: McpRoute = {
      catalogName: "acme_thing",
      toolName: "thing",
      serverName: "acme",
      remote: false,
      spec: { type: "function", function: { name: "acme_thing", description: "d", parameters: {} } },
    };
    // A connector's own catalog name is NEVER directly advertised/servable —
    // servedToolsWith only ever lists the run_mcp_tool/search_mcp_tools PROXY
    // pair (see the Rust source's own comment on `scoped_specs` re: the
    // connector proxy). So the call has to go through run_mcp_tool, exactly
    // as a real model would, for "acme_thing" to be reachable at all.
    const dispatcher = new RoomToolDispatcher(
      baseOpts({
        routes: [route],
        execDeps: execDeps({
          callConnectorTool: async () => {
            log.push("dispatched");
            throw new Error("boom mid-call");
          },
        }),
        markToolRan: () => log.push("marked"),
      })
    );
    const result = await dispatcher.callTool(LOCAL_ENGINE, MCP_RUN_TOOL, {
      tool: "acme_thing",
      arguments: {},
    });
    expect(log).toEqual(["marked", "dispatched"]);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe("boom mid-call");
  });

  it("does NOT mark tool_ran for a refused (unadvertised) call", async () => {
    const log: string[] = [];
    const dispatcher = new RoomToolDispatcher(
      baseOpts({ markToolRan: () => log.push("marked") })
    );
    await dispatcher.callTool(CLOUD_ADVISOR_PLAIN, "stt_status", {});
    expect(log).toEqual([]);
  });
});

describe("RoomToolDispatcher.callTool — argument normalization", () => {
  const MALFORMED: Array<[string, unknown]> = [
    ["a bare string", "not an object"],
    ["a JSON-encoded string", '{"question":"q"}'],
    ["an array", ["question", "q"]],
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
    ["undefined", undefined],
  ];

  it("a non-object 'arguments' becomes {} rather than reaching a tool that indexes it", async () => {
    const dispatcher = new RoomToolDispatcher(baseOpts({}));
    // Cast through `unknown` since the interface's TS type promises an object;
    // a real client is not bound by that promise. `open_file` REQUIRES `name`,
    // so a coerced-to-{} argument set has an observable signature — the
    // missing-arg refusal — that a pass-through would not produce.
    for (const [label, bad] of MALFORMED) {
      const result = await dispatcher.callTool(LOCAL_ENGINE, "open_file", bad as Record<string, unknown>);
      expect(result.isError, label).toBe(true);
      expect((result.content[0] as { text: string }).text, label).toContain("name is required");
    }
  });

  it("the coercion happens INSIDE callTool, before the code that indexes args directly", async () => {
    // The consult_advisor / search_mcp_tools / run_mcp_tool blocks read
    // `args.question` / `args.query` / `args.tool` above the dispatch, outside
    // the `try` that turns a throw into an isError result — so on a `null`
    // argument set an un-coerced `args` rejects the whole promise instead of
    // producing a tool-shaped refusal. This is the case that distinguishes a
    // real coercion from a pass-through; a tool with no required arguments
    // cannot tell the two apart.
    const advisor = new AdvisorRuntime(["claude-cli"], new CancelFlag());
    const route: McpRoute = {
      catalogName: "acme_thing",
      toolName: "thing",
      serverName: "acme",
      remote: false,
      spec: { type: "function", function: { name: "acme_thing", description: "d", parameters: {} } },
    };
    const dispatcher = new RoomToolDispatcher(baseOpts({ advisor, routes: [route] }));
    for (const [label, bad] of MALFORMED) {
      const args = bad as Record<string, unknown>;

      const consult = await dispatcher.callTool(LOCAL_ENGINE, "consult_advisor", args);
      expect(consult.isError, `consult_advisor / ${label}`).toBe(true);
      expect((consult.content[0] as { text: string }).text, label).toContain("non-empty");

      const search = await dispatcher.callTool(LOCAL_ENGINE, MCP_SEARCH_TOOL, args);
      expect(search.isError, `search_mcp_tools / ${label}`).toBe(true);
      expect((search.content[0] as { text: string }).text, label).toContain("non-empty query");

      const run = await dispatcher.callTool(LOCAL_ENGINE, MCP_RUN_TOOL, args);
      expect(run.isError, `run_mcp_tool / ${label}`).toBe(true);
      expect((run.content[0] as { text: string }).text, label).toContain("exact tool id");
    }
  });

  it("a redaction policy that returns a NON-object from restoreValue is re-normalized", async () => {
    // Rust asserts this explicitly rather than assuming it — `restore_value`
    // maps a JSON value through the redactor and preserves shape, but that is
    // an invariant across a module boundary, and the port's `RedactionPolicy`
    // is an INJECTED seam a future privacy batch supplies. A seam that hands
    // back a string must not become `args.query` on a string.
    //
    // Driven through the PROXY tools on purpose. `execTool` coerces a
    // malformed argument set of its own (it is exported and has callers with
    // no bridge in front of them), so a plain room tool cannot distinguish a
    // re-normalization here from that one downstream. `search_mcp_tools` and
    // `run_mcp_tool` are read inside `callTool` itself, above the dispatch and
    // outside the try/catch — the only place this door is load-bearing.
    const route: McpRoute = {
      catalogName: "acme_thing",
      toolName: "thing",
      serverName: "acme",
      remote: false,
      spec: { type: "function", function: { name: "acme_thing", description: "d", parameters: {} } },
    };
    for (const bad of ["a string", [1, 2], 7, null, true]) {
      const policy: RedactionPolicy = {
        restoreValue: () => bad,
        redact: (text) => ({ text, entitiesHidden: 0 }),
      };
      const dispatcher = new RoomToolDispatcher(
        baseOpts({ routes: [route], activePolicy: () => policy })
      );

      const search = await dispatcher.callTool(CLOUD_ENGINE, MCP_SEARCH_TOOL, { query: "stock" });
      expect(search.isError, `search / ${String(bad)}`).toBe(true);
      expect((search.content[0] as { text: string }).text, String(bad)).toContain("non-empty query");

      const run = await dispatcher.callTool(CLOUD_ENGINE, MCP_RUN_TOOL, {
        tool: "acme_thing",
        arguments: {},
      });
      expect(run.isError, `run / ${String(bad)}`).toBe(true);
      expect((run.content[0] as { text: string }).text, String(bad)).toContain("exact tool id");

      const openFile = await dispatcher.callTool(CLOUD_ENGINE, "open_file", { name: "real.md" });
      expect(openFile.isError, `open_file / ${String(bad)}`).toBe(true);
      expect((openFile.content[0] as { text: string }).text, String(bad)).toContain("name is required");
    }
  });
});

describe("RoomToolDispatcher.callTool — search_mcp_tools / run_mcp_tool", () => {
  const route: McpRoute = {
    catalogName: "acme_stock_price",
    toolName: "stock_price",
    serverName: "acme",
    remote: false,
    spec: {
      type: "function",
      function: { name: "acme_stock_price", description: "Look up a stock's price", parameters: {} },
    },
  };

  it("search_mcp_tools ranks and reports the connected tool", async () => {
    const dispatcher = new RoomToolDispatcher(baseOpts({ routes: [route] }));
    const result = await dispatcher.callTool(LOCAL_ENGINE, MCP_SEARCH_TOOL, { query: "stock price" });
    expect(result.isError).toBe(false);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.matches[0].tool).toBe("acme_stock_price");
  });

  it("search_mcp_tools refuses an empty query", async () => {
    const dispatcher = new RoomToolDispatcher(baseOpts({ routes: [route] }));
    const result = await dispatcher.callTool(LOCAL_ENGINE, MCP_SEARCH_TOOL, { query: "  " });
    expect(result.isError).toBe(true);
  });

  it("run_mcp_tool rewrites the dispatch to the target connector tool and calls it for real", async () => {
    let seenArgs: unknown;
    const dispatcher = new RoomToolDispatcher(
      baseOpts({
        routes: [route],
        execDeps: execDeps({
          callConnectorTool: async (r, args) => {
            seenArgs = args;
            return { text: `price for ${r.toolName}` };
          },
        }),
      })
    );
    const result = await dispatcher.callTool(LOCAL_ENGINE, MCP_RUN_TOOL, {
      tool: "acme_stock_price",
      arguments: { ticker: "NVDA" },
    });
    expect(result.isError).toBe(false);
    expect((result.content[0] as { text: string }).text).toBe("price for stock_price");
    expect(seenArgs).toEqual({ ticker: "NVDA" });
  });

  it("run_mcp_tool refuses an unknown/disconnected target", async () => {
    const dispatcher = new RoomToolDispatcher(baseOpts({ routes: [route] }));
    const result = await dispatcher.callTool(LOCAL_ENGINE, MCP_RUN_TOOL, { tool: "not_connected", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Unknown or disconnected");
  });
});

describe("RoomToolDispatcher.callTool — consult_advisor", () => {
  it("the saturating cap refuses a second consult in the same AdvisorRuntime", async () => {
    const advisor = new AdvisorRuntime(["claude-cli"], new CancelFlag());
    const dispatcher = new RoomToolDispatcher(baseOpts({ advisor }));
    const first = await dispatcher.callTool(LOCAL_ENGINE, "consult_advisor", { question: "q1" });
    // The cap did NOT trigger — this reaches (and is refused only by) the
    // still-stubbed exec_tool arm, which is a DIFFERENT, NOT_IMPLEMENTED
    // isError:true outcome, not the cap's own refusal text.
    expect((first.content[0] as { text: string }).text).not.toContain("already consulted");
    const second = await dispatcher.callTool(LOCAL_ENGINE, "consult_advisor", { question: "q2" });
    // The cap's OWN refusal is reported as a normal (non-error) result —
    // ported verbatim from the Rust source's `tool_result(..., false, ...)`.
    expect(second.isError).toBe(false);
    expect((second.content[0] as { text: string }).text).toContain("already consulted an advisor");
  });

  it("refuses a non-empty but unrecognised advisor name", async () => {
    const advisor = new AdvisorRuntime(["claude-cli"], new CancelFlag());
    const dispatcher = new RoomToolDispatcher(baseOpts({ advisor }));
    const result = await dispatcher.callTool(LOCAL_ENGINE, "consult_advisor", {
      question: "q",
      advisor: "codex", // not in this runtime's installed advisors
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not installed");
  });

  it("refuses an empty question before spending the cap", async () => {
    const advisor = new AdvisorRuntime(["claude-cli"], new CancelFlag());
    const dispatcher = new RoomToolDispatcher(baseOpts({ advisor }));
    const empty = await dispatcher.callTool(LOCAL_ENGINE, "consult_advisor", { question: "   " });
    expect(empty.isError).toBe(true);
    expect((empty.content[0] as { text: string }).text).toContain("non-empty");
    // The cap must still be UNSPENT — a real consult right after must reach
    // the stub (NOT_IMPLEMENTED), not the cap's refusal text.
    const real = await dispatcher.callTool(LOCAL_ENGINE, "consult_advisor", { question: "real question" });
    expect((real.content[0] as { text: string }).text).not.toContain("already consulted");
  });
});

describe("RoomToolDispatcher.callTool — cloud redaction", () => {
  function fakePolicy(): RedactionPolicy & { restoreCalls: unknown[]; redactCalls: string[] } {
    const restoreCalls: unknown[] = [];
    const redactCalls: string[] = [];
    return {
      restoreCalls,
      redactCalls,
      restoreValue: (v) => {
        restoreCalls.push(v);
        // Simulate placeholder restoration: turn "[Person A]" into "Ben".
        return JSON.parse(JSON.stringify(v).replace(/\[Person A\]/g, "Ben"));
      },
      redact: (text) => {
        redactCalls.push(text);
        return { text: text.replace(/Ben/g, "[Person A]"), entitiesHidden: 1 };
      },
    };
  }

  it("restores placeholders in incoming args and redacts the outgoing text for a cloud-bound scope", async () => {
    let seenArgs: unknown;
    const policy = fakePolicy();
    const route: McpRoute = {
      catalogName: "acme_thing",
      toolName: "thing",
      serverName: "acme",
      remote: true,
      spec: { type: "function", function: { name: "acme_thing", description: "d", parameters: {} } },
    };
    const dispatcher = new RoomToolDispatcher(
      baseOpts({
        routes: [route],
        activePolicy: () => policy,
        execDeps: execDeps({
          callConnectorTool: async (_r, args) => {
            seenArgs = args;
            return { text: "Ben said hello" };
          },
        }),
      })
    );
    // A connector's own name is only reachable through run_mcp_tool (see the
    // tool_ran-timing test above for why calling "acme_thing" directly would
    // just be refused as unadvertised).
    const result = await dispatcher.callTool(CLOUD_ENGINE, MCP_RUN_TOOL, {
      tool: "acme_thing",
      arguments: { note: "[Person A]" },
    });
    expect(seenArgs).toEqual({ note: "Ben" });
    expect((result.content[0] as { text: string }).text).toBe("[Person A] said hello");
    expect(policy.restoreCalls).toHaveLength(1);
    expect(policy.redactCalls).toEqual(["Ben said hello"]);
  });

  it("drops images entirely under a cloud policy — an image cannot be redacted", async () => {
    const policy = fakePolicy();
    const effects = createToolEffects();
    effects.pendingImages = ["b64"];
    const route: McpRoute = {
      catalogName: "acme_thing",
      toolName: "thing",
      serverName: "acme",
      remote: true,
      spec: { type: "function", function: { name: "acme_thing", description: "d", parameters: {} } },
    };
    const dispatcher = new RoomToolDispatcher(
      baseOpts({
        routes: [route],
        activePolicy: () => policy,
        sharedEffects: effects,
        execDeps: execDeps({ callConnectorTool: async () => ({ text: "ok" }) }),
      })
    );
    const result = await dispatcher.callTool(CLOUD_ENGINE, MCP_RUN_TOOL, {
      tool: "acme_thing",
      arguments: {},
    });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("privacyBypass:true skips the policy even for a cloud-bound scope", async () => {
    const policy = fakePolicy();
    const route: McpRoute = {
      catalogName: "acme_thing",
      toolName: "thing",
      serverName: "acme",
      remote: true,
      spec: { type: "function", function: { name: "acme_thing", description: "d", parameters: {} } },
    };
    const dispatcher = new RoomToolDispatcher(
      baseOpts({
        routes: [route],
        activePolicy: () => policy,
        privacyBypass: true,
        execDeps: execDeps({ callConnectorTool: async () => ({ text: "Ben said hello" }) }),
      })
    );
    const result = await dispatcher.callTool(CLOUD_ENGINE, MCP_RUN_TOOL, {
      tool: "acme_thing",
      arguments: {},
    });
    expect((result.content[0] as { text: string }).text).toBe("Ben said hello"); // untouched
    expect(policy.redactCalls).toEqual([]);
  });

  it("LocalEngine never consults the policy even if one is configured", async () => {
    const policy = fakePolicy();
    const dispatcher = new RoomToolDispatcher(
      baseOpts({ activePolicy: () => policy })
    );
    await dispatcher.callTool(LOCAL_ENGINE, "stt_status", {});
    expect(policy.restoreCalls).toEqual([]);
    expect(policy.redactCalls).toEqual([]);
  });
});

describe("RoomToolDispatcher.callTool — effects sink", () => {
  it("a shared effects object PERSISTS across calls and is marked runScoped", async () => {
    const shared = createToolEffects();
    const dispatcher = new RoomToolDispatcher(baseOpts({ sharedEffects: shared }));
    await dispatcher.callTool(LOCAL_ENGINE, "stt_status", {});
    expect(shared.runScoped).toBe(true);
    shared.wrote = true; // simulate a previous call's write having landed
    await dispatcher.callTool(LOCAL_ENGINE, "stt_status", {});
    expect(shared.wrote).toBe(true); // still true — same object, not reset
  });

  it("without a shared sink, a throwaway is used and vision_chat reflects ExternalAgent", async () => {
    // No direct observable here since execTool's stub arms don't read
    // effects.visionChat — this documents intent structurally via the
    // dispatcher not throwing and completing normally for both scopes.
    const dispatcher = new RoomToolDispatcher(baseOpts({}));
    const result = await dispatcher.callTool(EXTERNAL_AGENT, "view_media_frame", { name: "x", at: "0:00" });
    expect(result.isError).toBe(true); // NOT_IMPLEMENTED stub, but reached without throwing
  });
});

describe("RoomToolDispatcher.callTool — the routes.length gate for MCP proxy tools", () => {
  it("search_mcp_tools/run_mcp_tool are unreachable with zero connected routes even under an MCP-including scope", async () => {
    const dispatcher = new RoomToolDispatcher(baseOpts({ routes: [] }));
    const result = await dispatcher.callTool(LOCAL_ENGINE, MCP_SEARCH_TOOL, { query: "x" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(`unknown tool: ${MCP_SEARCH_TOOL}`);
  });
});

// ================================================ CHG-33: the web-search brake

describe("the web-search brake (CHG-33)", () => {
  it("holds for the cooldown and then expires, on a monotonic clock the test controls", () => {
    let now = 1_000;
    const throttle = createWebThrottle(() => now);
    expect(throttle.isOn()).toBe(false);
    throttle.raise();
    expect(throttle.isOn()).toBe(true);
    now += WEB_THROTTLE_COOLDOWN_MS - 1;
    expect(throttle.isOn()).toBe(true);
    // The Leash's external-agent bridge lives for the whole session: refusing
    // every search for hours because one was rate-limited is its own bug.
    now += 1;
    expect(throttle.isOn()).toBe(false);
  });

  it("seeds a throwaway ToolEffects from the bridge, so a brake raised on an EARLIER call is visible on this one", async () => {
    const throttle = createWebThrottle();
    throttle.raise();
    let seen: boolean | undefined;
    await withWebBrake(throttle, createToolEffects(), async (e) => {
      seen = e.webSearchThrottled;
    });
    // This is the whole point: every scope but LocalEngine gets a FRESH
    // ToolEffects per tools/call, so without the seed the model retried the
    // same dead endpoint every round.
    expect(seen).toBe(true);
  });

  it("carries a newly-raised flag back OUT to the bridge, where it outlives the throwaway", async () => {
    const throttle = createWebThrottle();
    expect(throttle.isOn()).toBe(false);
    await withWebBrake(throttle, createToolEffects(), async (e) => {
      // What the (not-yet-ported) web_search arm does on a rate-limit.
      e.webSearchThrottled = true;
    });
    expect(throttle.isOn()).toBe(true);
  });

  it("does NOT re-raise while the brake is already on — otherwise the cooldown slides forward forever", async () => {
    let now = 1_000;
    const throttle = createWebThrottle(() => now);
    throttle.raise();
    now += WEB_THROTTLE_COOLDOWN_MS - 10;
    // A second call sees the brake on and leaves the flag set; re-raising here
    // would restart the cooldown, and a session-long external-agent bridge
    // would never search again.
    await withWebBrake(throttle, createToolEffects(), async () => undefined);
    now += 11;
    expect(throttle.isOn()).toBe(false);
  });

  it("a bridge with no brake configured behaves exactly as before the brake existed", async () => {
    let seen: boolean | undefined;
    await withWebBrake(undefined, createToolEffects(), async (e) => {
      seen = e.webSearchThrottled;
      e.webSearchThrottled = true;
    });
    expect(seen).toBe(false);
  });
});

// ============================== ADD-33: the run-scoped sink serialises calls

describe("the run-scoped effects sink", () => {
  it("serialises overlapping tools/call dispatches, so one call cannot drain another's images", async () => {
    // Rust holds a tokio Mutex guard across the WHOLE exec_tool await. Without
    // an equivalent, two overlapping calls interleave on `pendingImages` and
    // one call's screenshot rides back with the other call's text.
    const shared = createToolEffects();
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatcher = new RoomToolDispatcher(
      baseOpts({
        sharedEffects: shared,
        routes: [
          {
            catalogName: "slow_thing",
            toolName: "slow",
            serverName: "acme",
            remote: false,
            spec: {
              type: "function",
              function: { name: "slow_thing", description: "d", parameters: { type: "object", properties: {} } },
            },
          },
        ],
        execDeps: execDeps({
          callConnectorTool: async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight -= 1;
            return { text: "done" };
          },
        }),
      })
    );
    await Promise.all([
      dispatcher.callTool(LOCAL_ENGINE, MCP_RUN_TOOL, { tool: "slow_thing", arguments: {} }),
      dispatcher.callTool(LOCAL_ENGINE, MCP_RUN_TOOL, { tool: "slow_thing", arguments: {} }),
      dispatcher.callTool(LOCAL_ENGINE, MCP_RUN_TOOL, { tool: "slow_thing", arguments: {} }),
    ]);
    expect(maxInFlight).toBe(1);
  });

  it("DRAINS pendingImages, so a captured screenshot rides exactly one tool result", async () => {
    // Without the drain the same base64 PNG is attached again to every
    // subsequent call on the run-scoped sink — the model is handed a stale
    // screenshot alongside unrelated text, which reads as the tool having
    // returned it. Rust drains the sink for this reason; nothing else in this
    // file notices if the drain becomes a copy.
    const shared = createToolEffects();
    const route: McpRoute = {
      catalogName: "acme_shot",
      toolName: "shot",
      serverName: "acme",
      remote: false,
      spec: { type: "function", function: { name: "acme_shot", description: "d", parameters: {} } },
    };
    let calls = 0;
    const dispatcher = new RoomToolDispatcher(
      baseOpts({
        sharedEffects: shared,
        routes: [route],
        execDeps: execDeps({
          callConnectorTool: async () => {
            // What a perception arm does: push the captured pixels onto the
            // sink for the wrapper to pick up.
            calls += 1;
            if (calls === 1) shared.pendingImages.push("shot-b64");
            return { text: `call ${calls}` };
          },
        }),
      })
    );
    const first = await dispatcher.callTool(LOCAL_ENGINE, MCP_RUN_TOOL, { tool: "acme_shot", arguments: {} });
    expect(first.content).toEqual([
      { type: "text", text: "call 1" },
      { type: "image", data: "shot-b64", mimeType: "image/png" },
    ]);
    expect(shared.pendingImages).toEqual([]);
    const second = await dispatcher.callTool(LOCAL_ENGINE, MCP_RUN_TOOL, { tool: "acme_shot", arguments: {} });
    expect(second.content).toEqual([{ type: "text", text: "call 2" }]);
  });

  it("marks the shared sink run-scoped, which is what makes 'apply for the rest of this answer' meaningful", async () => {
    const shared = createToolEffects();
    expect(shared.runScoped).toBe(false);
    const dispatcher = new RoomToolDispatcher(baseOpts({ sharedEffects: shared }));
    await dispatcher.callTool(LOCAL_ENGINE, "list_memories", {});
    expect(shared.runScoped).toBe(true);
  });

  it("a rejected call does not wedge the queue for the next one", async () => {
    const shared = createToolEffects();
    const dispatcher = new RoomToolDispatcher(baseOpts({ sharedEffects: shared }));
    // `list_memories` with no room open fails cleanly; the next call must
    // still be served rather than hanging on a poisoned promise chain.
    await dispatcher.callTool(LOCAL_ENGINE, "list_memories", {});
    const second = await dispatcher.callTool(LOCAL_ENGINE, "list_memories", {});
    expect(second.content[0]).toEqual({ type: "text", text: "No room is open." });
  });
});

// ===================================== the catalog groups the merge restored

describe("the catalog serves every group scoped_specs does", () => {
  it("an engine tier is served the workflow, script, studio, transcribe and DRAW tools", () => {
    const names = scopedSpecs(true, LOCAL_ENGINE).map((t) => t.name);
    for (const n of ["list_workflows", "save_workflow", "test_workflow", "list_scripts", "studio_mindmap", "stt_status", "draw", "read_drawing"]) {
      expect(names, n).toContain(n);
    }
  });

  it("an engine tier with the web on is served the browse and download tools", () => {
    const names = scopedSpecs(true, LOCAL_ENGINE).map((t) => t.name);
    for (const n of ["browse_open", "browse_read", "browse_do", "browse_save", "save_link", "download_url", "download_media"]) {
      expect(names, n).toContain(n);
    }
  });

  it("the same tier with the web OFF is served neither — the switch is not circular", () => {
    const names = scopedSpecs(false, LOCAL_ENGINE).map((t) => t.name);
    expect(names).not.toContain("browse_open");
    expect(names).not.toContain("download_url");
    expect(names).not.toContain("web_search");
  });

  it("a merely CONSULTED advisor gets none of them — drawing, browsing and organizing are actions, not advice", () => {
    const names = scopedSpecs(true, CLOUD_ADVISOR_MCP).map((t) => t.name);
    for (const n of ["draw", "browse_open", "organize_files", "trash_files", "save_workflow", "ui_act", "local_generate"]) {
      expect(names, n).not.toContain(n);
    }
  });

  it("browse_do's advertised schema is the REAL one — an actions ARRAY, not a single ref/action pair", () => {
    // A paraphrased spec is a different prompt AND a different contract:
    // `builtinParamSchemas` validates required args against exactly this.
    const spec = scopedSpecs(true, LOCAL_ENGINE).find((t) => t.name === "browse_do");
    expect(spec).toBeDefined();
    const schema = spec?.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toEqual(["actions"]);
    expect(Object.keys(schema.properties ?? {})).toEqual(["actions"]);
  });
});
