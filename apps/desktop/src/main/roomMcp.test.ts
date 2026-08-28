/**
 * Tests for `roomMcp.ts` — the three remaining pieces of `room_mcp.rs`. See
 * that file's module doc for what the rest of `room_mcp.rs` is already covered
 * by and where.
 *
 * Real things wherever a real thing exists: a real `RoomToolDispatcher` for
 * the live-lane re-read, a real fixture room for the lane settings, and a real
 * loopback bind (`createRoomBridge`) with a real HTTP round-trip for the
 * nested advisor bridge — so a passing test means a listening server, not an
 * object of the right shape. Only the log sink is faked, so the exact
 * `(event, fields)` pair can be asserted without a `Sink`/`init`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

import * as obs from "./obs.js";
import type { Val } from "./obs.js";
import { TurnId } from "./turn.js";
import { CancelFlag } from "./cancel.js";
import { createRoom } from "./db-host/open.js";
import { setSetting } from "./db-host/settings.js";
import type { ToolDispatcher, ToolScope, ToolSpec } from "./mcpBridge.js";
import { RoomToolDispatcher, type RoomToolDispatcherOptions } from "./bridgeDispatcher.js";
import { createRoomBridge, startRoomBridgeNotImplemented, type BridgeStarter } from "./moonshotServer.js";
import { WEB_LANES_ALL, type WebLanes } from "./toolSpecs.js";
import type { ExecToolDeps } from "./execTool.js";
import {
  TOOL_SCOPE_LABELS,
  adaptRunningBridge,
  bridgeStarterFor,
  intersectWebLanes,
  liveLanesDispatcherOptions,
  logCatalog,
  openRoomWebLanes,
  prepareAdvisorRuntime,
  toolCatalog,
  toolDispatched,
  turnFields,
  withCatalogTelemetry,
  type RoomMcpLog,
} from "./roomMcp.js";

// --------------------------------------------------------------- fixtures

const tmpDirs: string[] = [];

function freshRoom(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "room-mcp-"));
  tmpDirs.push(dir);
  return createRoom(path.join(dir, `t-${randomUUID()}.roomai`), "correct horse battery staple", "Test Room");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One captured log call, rendered the same way `obs.ts`'s own `render` does
 * (`event k=v k=v`), so the assertions pin the exact line rather than a shape
 * that could drift. */
interface Captured {
  level: "info" | "debug";
  line: string;
  keys: string[];
}

function captureLog(): { log: RoomMcpLog; lines: Captured[]; last: () => Captured } {
  const lines: Captured[] = [];
  const record =
    (level: "info" | "debug") =>
    (event: string, fields: readonly (readonly [string, Val])[]): void => {
      lines.push({
        level,
        line: [event, ...fields.map(([k, v]) => `${k}=${v.toString()}`)].join(" "),
        keys: fields.map(([k]) => k),
      });
    };
  return {
    log: {
      info: record("info") as unknown as typeof obs.info,
      debug: record("debug") as unknown as typeof obs.debug,
    },
    lines,
    last: () => {
      const entry = lines[lines.length - 1];
      if (entry === undefined) {
        throw new Error("no call was recorded");
      }
      return entry;
    },
  };
}

const FAKE_DISPATCHER: ToolDispatcher = {
  listTools: () => [],
  callTool: async () => ({ isError: false, content: [{ type: "text", text: "" }] }),
};

const spec = (name: string): ToolSpec => ({ name, inputSchema: { type: "object", properties: {} } });

// ============================================================================
// turnFields
// ============================================================================

describe("turnFields", () => {
  it("carries the run/chat ids off a real turn", () => {
    const [run, chat] = turnFields(new TurnId("run42", "chat7"));
    expect(run[0]).toBe("run");
    expect(run[1].toString()).toBe("run42");
    expect(chat[0]).toBe("chat");
    expect(chat[1].toString()).toBe("chat7");
  });

  it("says '-' for a caller with no turn, rather than omitting the field", () => {
    const [run, chat] = turnFields(null);
    expect(run[1].toString()).toBe("-");
    expect(chat[1].toString()).toBe("-");
  });
});

// ============================================================================
// toolCatalog / toolDispatched / logCatalog
// ============================================================================

describe("toolCatalog", () => {
  it("records the tier, the served count AND the names — not just a count", () => {
    // Rust's own reason for this event: "an engine handed an empty tool bridge
    // does not report 'my bridge is empty' — it rationalises, and the
    // rationalisation becomes the bug report."
    const { log, last } = captureLog();
    toolCatalog("LocalEngine", ["open_file", "web_search"], new TurnId("run42", "chat7"), log);
    expect(last().level).toBe("info");
    expect(last().line).toBe(
      "tools.catalog run=run42 chat=chat7 scope=LocalEngine served=2 names=[open_file web_search]"
    );
  });

  it("an EMPTY catalog reads as empty, not as silence", () => {
    const { log, last } = captureLog();
    toolCatalog("CloudEngine", [], null, log);
    expect(last().line).toBe("tools.catalog run=- chat=- scope=CloudEngine served=0 names=[]");
  });

  it("every real scope label round-trips through the whitelist unmangled", () => {
    const { log, lines } = captureLog();
    for (const label of TOOL_SCOPE_LABELS) {
      toolCatalog(label, [], null, log);
    }
    expect(lines.map((l) => l.line.split(" ")[3])).toEqual(
      TOOL_SCOPE_LABELS.map((l) => `scope=${l}`)
    );
  });

  it("a scope label outside the known set never reaches the log verbatim", () => {
    const { log, last } = captureLog();
    toolCatalog("something-a-model-could-never-legitimately-produce", [], null, log);
    expect(last().line).toContain(`scope=${obs.UNEXPECTED}`);
    expect(last().line).not.toContain("something-a-model");
  });

  it("defaults to the real obs sink when no log is injected (does not throw)", () => {
    expect(() => toolCatalog("LocalEngine", ["open_file"], null)).not.toThrow();
  });
});

describe("toolDispatched", () => {
  it("records the tool name and verdict at debug", () => {
    const { log, last } = captureLog();
    toolDispatched("ExternalAgent", "search_room", false, 128, new TurnId("run1", "chat1"), log);
    expect(last().level).toBe("debug");
    expect(last().line).toBe(
      "tools.call run=run1 chat=chat1 scope=ExternalAgent tool=search_room error=false resultBytes=128"
    );
  });

  it("marks a failed call, still with no argument content", () => {
    const { log, last } = captureLog();
    toolDispatched("LocalEngine", "create_file", true, 0, null, log);
    expect(last().line).toBe(
      "tools.call run=- chat=- scope=LocalEngine tool=create_file error=true resultBytes=0"
    );
  });

  it("the tool's ARGUMENTS have no field to arrive through at all", () => {
    const { log, last } = captureLog();
    toolDispatched("LocalEngine", "open_file", false, 10, null, log);
    expect([...last().keys].sort()).toEqual(["chat", "error", "resultBytes", "run", "scope", "tool"]);
  });

  it("defaults to the real obs sink (does not throw)", () => {
    expect(() => toolDispatched("LocalEngine", "open_file", false, 10, null)).not.toThrow();
  });
});

describe("logCatalog", () => {
  it("is room_mcp.rs's thin wrapper: the scope's label plus the served names", () => {
    const { log, last } = captureLog();
    logCatalog({ kind: "LocalEngine" }, [spec("open_file"), spec("web_search")], null, log);
    expect(last().line).toBe(
      "tools.catalog run=- chat=- scope=LocalEngine served=2 names=[open_file web_search]"
    );
  });

  it("distinguishes CloudAdvisor with and without mcp, exactly as scopeLabel does", () => {
    const { log, lines } = captureLog();
    logCatalog({ kind: "CloudAdvisor", includeMcp: true }, [], null, log);
    logCatalog({ kind: "CloudAdvisor", includeMcp: false }, [], null, log);
    expect(lines[0]!.line).toContain("scope=CloudAdvisor+mcp");
    expect(lines[1]!.line).toContain("scope=CloudAdvisor served=0");
  });
});

describe("withCatalogTelemetry", () => {
  it("logs the catalog a REAL dispatcher served, at Rust's own call site", () => {
    const { log, last } = captureLog();
    const wrapped = withCatalogTelemetry(
      new RoomToolDispatcher(baseOpts()),
      new TurnId("run9", "chat9"),
      log
    );
    const tools = wrapped.listTools({ kind: "CloudAdvisor", includeMcp: false });
    expect(tools.length).toBeGreaterThan(0);
    expect(last().line).toContain("tools.catalog run=run9 chat=chat9 scope=CloudAdvisor");
    expect(last().line).toContain(`served=${tools.length}`);
    expect(last().line).toContain("list_room_files");
    // The UI tools are not in a plain CloudAdvisor's catalog, so the recorded
    // names must not claim otherwise — the event is only worth having if it
    // reports what was really served.
    expect(last().line).not.toContain("ui_snapshot");
  });

  it("returns the inner dispatcher's list unchanged and forwards callTool", async () => {
    const { log, lines } = captureLog();
    const inner: ToolDispatcher = {
      listTools: () => [spec("open_file")],
      callTool: async (_scope, name) => ({ isError: false, content: [{ type: "text", text: name }] }),
    };
    const wrapped = withCatalogTelemetry(inner, null, log);
    expect(wrapped.listTools({ kind: "LocalEngine" })).toEqual([spec("open_file")]);
    const result = await wrapped.callTool({ kind: "LocalEngine" }, "open_file", {});
    expect(result).toEqual({ isError: false, content: [{ type: "text", text: "open_file" }] });
    // callTool is forwarded, not instrumented — see `toolDispatched`'s doc for
    // why the per-call event cannot be wired from a decorator faithfully.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toContain("tools.catalog");
  });
});

// ============================================================================
// the per-request live web lanes
// ============================================================================

describe("intersectWebLanes", () => {
  it("a live switch can only take a lane away, never add one back", () => {
    // The caller's narrowing (a workflow node) survives a live all-on room.
    expect(intersectWebLanes({ search: false, browse: true }, WEB_LANES_ALL)).toEqual({
      search: false,
      browse: true,
    });
    // …and the live room can narrow further.
    expect(intersectWebLanes(WEB_LANES_ALL, { search: true, browse: false })).toEqual({
      search: true,
      browse: false,
    });
    expect(intersectWebLanes({ search: true, browse: false }, { search: false, browse: true })).toEqual({
      search: false,
      browse: false,
    });
  });
});

describe("openRoomWebLanes", () => {
  it("no room open means BOTH LANES ON — WebLanes::default(), not all-false", () => {
    // Getting this backwards is silent: a bridge serving no web tools looks
    // exactly like a room that is offline.
    expect(openRoomWebLanes(() => null)).toEqual(WEB_LANES_ALL);
  });

  it("reads the open room's own switches", () => {
    const db = freshRoom();
    expect(openRoomWebLanes(() => ({ db }))).toEqual({ search: true, browse: true });
    setSetting(db, "web_agent_search", "off");
    expect(openRoomWebLanes(() => ({ db }))).toEqual({ search: false, browse: true });
    setSetting(db, "web_agent_browse", "off");
    expect(openRoomWebLanes(() => ({ db }))).toEqual({ search: false, browse: false });
  });
});

function execDeps(): ExecToolDeps {
  return {
    db: null,
    routes: [],
    connectorApproved: async () => true,
    outboundUnmaskFor: () => true,
  };
}

function baseOpts(overrides: Partial<RoomToolDispatcherOptions> = {}): RoomToolDispatcherOptions {
  return {
    webEnabled: true,
    lanes: WEB_LANES_ALL,
    routes: [],
    advisor: null,
    runCancel: null,
    sharedEffects: null,
    privacyBypass: false,
    activePolicy: () => null,
    execDeps: execDeps(),
    ...overrides,
  };
}

describe("liveLanesDispatcherOptions", () => {
  it("a lane flipped in Settings takes effect on the NEXT request, on a live dispatcher", () => {
    // The Rust bug this closes: "an external agent holds ONE connection for
    // the whole session, so a bridge that answered tools/list at connect time
    // kept serving the web and browser tools for the rest of it."
    const db = freshRoom();
    const dispatcher = new RoomToolDispatcher(
      liveLanesDispatcherOptions(baseOpts(), () => openRoomWebLanes(() => ({ db })))
    );
    const scope: ToolScope = { kind: "ExternalAgent" };

    const before = dispatcher.listTools(scope).map((t) => t.name);
    expect(before).toContain("web_search");
    expect(before).toContain("browse_open");

    setSetting(db, "web_agent_search", "off");

    const after = dispatcher.listTools(scope).map((t) => t.name);
    expect(after).not.toContain("web_search");
    expect(after).not.toContain("fetch_page");
    // The download verbs ride with the search lane (`DOWNLOAD_TOOL_NAMES`).
    expect(after).not.toContain("download_url");
    // The browse lane is untouched, so its tools stay.
    expect(after).toContain("browse_open");
  });

  it("a switched-off lane is not merely unadvertised — it stops being CALLABLE mid-session", async () => {
    const db = freshRoom();
    const dispatcher = new RoomToolDispatcher(
      liveLanesDispatcherOptions(baseOpts(), () => openRoomWebLanes(() => ({ db })))
    );
    const scope: ToolScope = { kind: "ExternalAgent" };
    setSetting(db, "web_agent_browse", "off");
    const result = await dispatcher.callTool(scope, "browse_open", { url: "https://example.com" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe("unknown tool: browse_open");
  });

  it("keeps the CALLER's own narrowing even when the live room has both lanes on", () => {
    const db = freshRoom();
    const dispatcher = new RoomToolDispatcher(
      liveLanesDispatcherOptions(baseOpts({ lanes: { search: true, browse: false } }), () =>
        openRoomWebLanes(() => ({ db }))
      )
    );
    const names = dispatcher.listTools({ kind: "ExternalAgent" }).map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).not.toContain("browse_open");
  });

  it("leaves every other option untouched", () => {
    const base = baseOpts({ webEnabled: false, privacyBypass: true });
    const live = liveLanesDispatcherOptions(base, () => WEB_LANES_ALL);
    expect(live.webEnabled).toBe(false);
    expect(live.privacyBypass).toBe(true);
    expect(live.execDeps).toBe(base.execDeps);
  });

  it("re-reads on EVERY access, not once", () => {
    let reads = 0;
    const live = liveLanesDispatcherOptions(baseOpts(), () => {
      reads++;
      return WEB_LANES_ALL;
    });
    void live.lanes;
    void live.lanes;
    expect(reads).toBe(2);
  });
});

// ============================================================================
// prepareAdvisorRuntime
// ============================================================================

/** A `BridgeStarter` that really binds loopback, so the happy path proves a
 * live listener rather than an object of the right shape. */
const realStartBridge: BridgeStarter = bridgeStarterFor(() => FAKE_DISPATCHER);

function countingStarter(): { starter: BridgeStarter; calls: number } {
  const state = { calls: 0 };
  const starter: BridgeStarter = (...args) => {
    state.calls++;
    return realStartBridge(...args);
  };
  return {
    starter,
    get calls(): number {
      return state.calls;
    },
  };
}

describe("prepareAdvisorRuntime — the advisors.is_empty() short-circuit", () => {
  it("returns (null, null) and never starts anything", async () => {
    const counting = countingStarter();
    const result = await prepareAdvisorRuntime({
      webEnabled: true,
      advisors: [],
      advisorToolsEnabled: true,
      cancel: new CancelFlag(),
      startBridge: counting.starter,
    });
    expect(result).toEqual({ advisorRuntime: null, nestedBridge: null });
    expect(counting.calls).toBe(0);
  });
});

describe("prepareAdvisorRuntime — the advisorToolsEnabled + claude-cli gate", () => {
  it("starts no nested bridge when the sub-option is off", async () => {
    const counting = countingStarter();
    const result = await prepareAdvisorRuntime({
      webEnabled: true,
      advisors: ["claude-cli"],
      advisorToolsEnabled: false,
      cancel: new CancelFlag(),
      startBridge: counting.starter,
    });
    expect(result.nestedBridge).toBeNull();
    expect(result.advisorRuntime?.advisors).toEqual(["claude-cli"]);
    expect(counting.calls).toBe(0);
  });

  it("starts no nested bridge when the only configured advisor is codex", async () => {
    const counting = countingStarter();
    const result = await prepareAdvisorRuntime({
      webEnabled: true,
      advisors: ["codex-cli"],
      advisorToolsEnabled: true,
      cancel: new CancelFlag(),
      startBridge: counting.starter,
    });
    expect(result.nestedBridge).toBeNull();
    expect(counting.calls).toBe(0);
    // …and the runtime still works: a codex-only room's consult_advisor tool
    // must not depend on whether a nested bridge exists.
    expect(result.advisorRuntime?.tool()?.name).toBe("consult_advisor");
  });

  it("the cancel flag handed in IS the runtime's own", async () => {
    const cancel = new CancelFlag();
    const result = await prepareAdvisorRuntime({
      webEnabled: true,
      advisors: ["codex-cli"],
      advisorToolsEnabled: false,
      cancel,
    });
    expect(result.advisorRuntime?.cancel).toBe(cancel);
  });
});

describe("prepareAdvisorRuntime — a failed nested start is swallowed (Rust's .ok())", () => {
  it("against the real honest-stub default: nestedBridge is null, never thrown", async () => {
    // No `startBridge` at all — exercises the real default,
    // `startRoomBridgeNotImplemented`, which always rejects.
    const result = await prepareAdvisorRuntime({
      webEnabled: true,
      advisors: ["claude-cli"],
      advisorToolsEnabled: true,
      cancel: new CancelFlag(),
    });
    expect(result.nestedBridge).toBeNull();
    // consult_advisor still works over the plain pipe — a failed nested bridge
    // must not fail the whole turn.
    expect(result.advisorRuntime?.tool()?.name).toBe("consult_advisor");
  });

  it("swallows a starter that throws SYNCHRONOUSLY, not only one that rejects", async () => {
    const throwsSync: BridgeStarter = () => {
      throw new Error("boom, synchronously");
    };
    const result = await prepareAdvisorRuntime({
      webEnabled: true,
      advisors: ["claude-cli"],
      advisorToolsEnabled: true,
      cancel: new CancelFlag(),
      startBridge: throwsSync,
    });
    expect(result.nestedBridge).toBeNull();
    expect(result.advisorRuntime).not.toBeNull();
  });

  it("the default really is the same rejecting stub setRoomServer uses", async () => {
    await expect(
      startRoomBridgeNotImplemented(true, { kind: "LocalEngine" }, { lanes: WEB_LANES_ALL })
    ).rejects.toThrow(/NOT_IMPLEMENTED/);
  });
});

describe("prepareAdvisorRuntime — the happy path binds a real, listening bridge", () => {
  it("starts CloudAdvisor{includeMcp:true} on a fresh ephemeral port with a fresh token", async () => {
    const seen: Array<{ webEnabled: boolean; scope: ToolScope; lanes: WebLanes; port?: number; token?: string }> = [];
    const starter: BridgeStarter = (webEnabled, scope, opts) => {
      seen.push({ webEnabled, scope, lanes: opts.lanes, port: opts.port, token: opts.token });
      return realStartBridge(webEnabled, scope, opts);
    };
    const result = await prepareAdvisorRuntime({
      webEnabled: true,
      advisors: ["codex-cli", "claude-cli"],
      advisorToolsEnabled: true,
      cancel: new CancelFlag(),
      startBridge: starter,
    });
    const bridge = result.nestedBridge;
    expect(bridge).not.toBeNull();
    try {
      // StartOpts::default(): no fixed port, no fixed token, both lanes on.
      expect(seen).toEqual([
        {
          webEnabled: true,
          scope: { kind: "CloudAdvisor", includeMcp: true },
          lanes: WEB_LANES_ALL,
          port: undefined,
          token: undefined,
        },
      ]);
      expect(bridge!.port).toBeGreaterThan(0);
      expect(bridge!.token).not.toBe("");
      // A real loopback listener answering, not a fabricated handle.
      const authed = await fetch(`http://127.0.0.1:${bridge!.port}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bridge!.token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(authed.status).toBe(200);
      expect(await authed.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
      // …and it is genuinely token-guarded.
      const bare = await fetch(`http://127.0.0.1:${bridge!.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      });
      expect(bare.status).toBe(401);
    } finally {
      await bridge!.stopAndWait();
    }
  });

  it("the nested bridge gets NO advisor runtime of its own — the recursion boundary", async () => {
    // Rust's boundary is structural: nothing calls `prepare_advisor_runtime`
    // for the nested bridge, so `consult_advisor` is never in its catalog and
    // a fabricated call cannot recurse. The scope handed to the starter is the
    // whole of what the nested bridge knows.
    const built: ToolScope[] = [];
    const starter = bridgeStarterFor((_webEnabled, scope) => {
      built.push(scope);
      return FAKE_DISPATCHER;
    });
    const result = await prepareAdvisorRuntime({
      webEnabled: false,
      advisors: ["claude-cli"],
      advisorToolsEnabled: true,
      cancel: new CancelFlag(),
      startBridge: starter,
    });
    try {
      expect(built).toEqual([{ kind: "CloudAdvisor", includeMcp: true }]);
    } finally {
      await result.nestedBridge?.stopAndWait();
    }
  });
});

// ============================================================================
// bridgeStarterFor / adaptRunningBridge
// ============================================================================

describe("bridgeStarterFor", () => {
  it("passes webEnabled, scope and lanes through to the dispatcher factory — none is ignored", async () => {
    const seen: Array<[boolean, ToolScope, WebLanes]> = [];
    const starter = bridgeStarterFor((webEnabled, scope, lanes) => {
      seen.push([webEnabled, scope, lanes]);
      return FAKE_DISPATCHER;
    });
    const bridge = await starter(false, { kind: "ExternalAgent" }, { lanes: { search: false, browse: true } });
    try {
      expect(seen).toEqual([[false, { kind: "ExternalAgent" }, { search: false, browse: true }]]);
      expect(bridge.scope).toEqual({ kind: "ExternalAgent" });
      expect(bridge.stable).toBe(false);
    } finally {
      await bridge.stopAndWait();
    }
  });

  it("honours a requested fixed token, so a persistent identity survives", async () => {
    const starter = bridgeStarterFor(() => FAKE_DISPATCHER);
    const bridge = await starter(true, { kind: "ExternalAgent" }, { lanes: WEB_LANES_ALL, token: "fixed-token" });
    try {
      expect(bridge.token).toBe("fixed-token");
    } finally {
      await bridge.stopAndWait();
    }
  });
});

describe("adaptRunningBridge", () => {
  it("builds the AdvisorBridge shape runExternalCli needs, from a real RunningBridge", async () => {
    const bridge = await createRoomBridge({
      scope: { kind: "CloudAdvisor", includeMcp: true },
      dispatcher: FAKE_DISPATCHER,
    });
    try {
      const adapted = adaptRunningBridge(bridge);
      expect(adapted.token).toBe(bridge.token);
      expect(adapted.mcpUrl()).toBe(`http://127.0.0.1:${bridge.port}/mcp`);
      // Byte-for-byte Bridge::mcp_config_json's shape.
      expect(JSON.parse(adapted.mcpConfigJson())).toEqual({
        mcpServers: {
          room: {
            type: "http",
            url: adapted.mcpUrl(),
            headers: { Authorization: `Bearer ${bridge.token}` },
          },
        },
      });
      expect(adapted.mcpConfigJson()).toBe(bridge.mcpConfigJson());
    } finally {
      await bridge.stopAndWait();
    }
  });
});
