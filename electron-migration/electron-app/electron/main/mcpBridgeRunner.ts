/**
 * A tiny process entrypoint that boots {@link McpBridge} with a FAKE
 * {@link ToolDispatcher}, for the cross-language wire-compat test at
 * `sidecar/tests/test_mcp_bridge_wire_compat.py`.
 *
 * Not part of the app itself — see `mcpBridge.ts`'s module doc for exactly
 * what real wiring this batch deliberately excludes (the real tool catalog,
 * `exec_tool` dispatch, and the `Bridge`/`start` process lifecycle). What
 * this exists to prove is the TRANSPORT, against the REAL, UNMODIFIED
 * `arcelle_sidecar.mcp_client.McpClient` rather than a reimplementation of
 * it: two real processes, one real loopback socket.
 *
 * Run with `npx vite-node electron/main/mcpBridgeRunner.ts` — this workspace
 * ships `vite-node` via its `vitest`/`vite` dependency, and neither `tsx` nor
 * `ts-node` is installed, so that is the mechanism that runs a `.ts` file
 * directly here without reaching the network.
 *
 * Configuration is by environment variable, not argv — mirroring how the real
 * sidecar receives its bearer token (`sidecar.ts`'s `authedHeaders` doc:
 * never on the command line, where a `ps` from another user account could
 * read it):
 *
 *   MCP_BRIDGE_TOKEN      required — the bearer token this run accepts.
 *   MCP_BRIDGE_CANCELLED  "1" to start with the run's cancel flag ALREADY
 *                         tripped, proving the synthesized-refusal path
 *                         (`tools/call` -> isError:true "Stopped by the
 *                         user…") without needing a live toggle mid-test —
 *                         the Python test simply starts a second instance of
 *                         this runner for that case.
 *
 * Prints `MCP_BRIDGE_PORT=<port>` on stdout once listening — the same
 * handshake shape `sidecar.ts`'s `parsePortLine` reads from the real
 * sidecar's own child process, so the Python test can learn the ephemeral
 * port without a bind-and-release race — then blocks until killed
 * (SIGTERM/SIGINT stop the bridge and exit cleanly).
 */

import { McpBridge } from "./mcpBridge.js";
import type { CancelFlagLike, ToolDispatcher, ToolScope, ToolSpec } from "./mcpBridge.js";

const token = process.env.MCP_BRIDGE_TOKEN;
if (token === undefined || token === "") {
  console.error("MCP_BRIDGE_TOKEN is required");
  process.exit(1);
}

const cancelled = process.env.MCP_BRIDGE_CANCELLED === "1";

/** The fixed two-tool catalog the Python cross-language test drives through
 * the real `McpClient`. */
const FAKE_TOOLS: ToolSpec[] = [
  {
    name: "echo",
    description: "Echoes back its `text` argument.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "boom",
    description: "Always fails, for isError:true coverage.",
    inputSchema: { type: "object", properties: {} },
  },
];

const dispatcher: ToolDispatcher = {
  listTools: () => FAKE_TOOLS,
  callTool: async (_scope, name, args) => {
    if (name === "echo") {
      return { isError: false, content: [{ type: "text", text: String(args.text ?? "") }] };
    }
    if (name === "boom") {
      return { isError: true, content: [{ type: "text", text: "boom failed on purpose" }] };
    }
    return { isError: true, content: [{ type: "text", text: `unknown tool: ${name}` }] };
  },
};

const scope: ToolScope = { kind: "LocalEngine" };
const alwaysCancelled: CancelFlagLike = { load: () => true };

const bridge = new McpBridge({
  token,
  scope,
  dispatcher,
  cancelFlag: cancelled ? alwaysCancelled : undefined,
  serverVersion: "0.0.0-wire-compat",
});

async function main(): Promise<void> {
  const port = await bridge.listen(0);
  // The handshake line the Python test's subprocess reader waits for.
  console.log(`MCP_BRIDGE_PORT=${port}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

async function shutdown(): Promise<void> {
  await bridge.stop();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
