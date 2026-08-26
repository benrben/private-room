import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Redactor, type PrivacyRule } from "../privacyRedact.js";
import { createRoomManagerState } from "../roomManager.js";
import { createWorkspaceRoom, openWorkspaceRoom } from "../workspace/roomLayout.js";
import { WorkspaceService } from "../workspace/workspaceService.js";
import { HarnessController } from "./controller.js";
import { RuntimeWithFallback } from "./legacyCli.js";
import type { HarnessContext, HarnessRun, HarnessRuntime } from "./types.js";
import type { WorkspaceOperationProgressEvent } from "../../shared/workspaceProgress.js";

const roots: string[] = [];
const RULES: PrivacyRule[] = [["Ben Reich", "[Person A]"]];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class EditingRuntime implements HarnessRuntime {
  readonly name = "legacy-cli" as const;
  async available(): Promise<boolean> { return true; }
  async startTurn(context: HarnessContext): Promise<HarnessRun> {
    const file = path.join(context.workspacePath, "notes.txt");
    const redacted = await readFile(file, "utf8");
    await writeFile(file, `${redacted}\nReviewed`, "utf8");
    async function* events() {
      yield { type: "run_started", runId: context.runId, harness: "legacy-cli" } as const;
      yield { type: "run_completed", runId: context.runId, status: "completed" } as const;
    }
    return { events: events(), cancel: async () => undefined, approve: async () => undefined };
  }
}

class MassEditingRuntime implements HarnessRuntime {
  readonly name = "legacy-cli" as const;
  async available(): Promise<boolean> { return true; }
  async startTurn(context: HarnessContext): Promise<HarnessRun> {
    for (let index = 0; index < 21; index += 1) {
      await writeFile(path.join(context.workspacePath, `bulk-${index}.txt`), `change ${index}`, "utf8");
    }
    async function* events() {
      yield { type: "run_started", runId: context.runId, harness: "legacy-cli" } as const;
      yield { type: "run_completed", runId: context.runId, status: "completed" } as const;
    }
    return { events: events(), cancel: async () => undefined, approve: async () => undefined };
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-harness-controller-"));
  roots.push(root);
  const roomPath = path.join(root, "Room");
  const source = path.join(root, "source.txt");
  await writeFile(source, "Ben Reich signed", "utf8");
  const created = createWorkspaceRoom(roomPath, "correct horse battery staple", "Room");
  const workspace = new WorkspaceService(created.db, roomPath);
  await workspace.importFile(source, "notes.txt");
  const state = createRoomManagerState();
  state.room = {
    conn: created.db,
    path: roomPath,
    name: "Room",
    password: "correct horse battery staple",
    descriptor: created.descriptor,
    workspace,
  };
  return { root, roomPath, created, state };
}

describe("HarnessController", () => {
  it("rebinds history to the new SQLCipher connection after reopening the same room", async () => {
    const f = await fixture();
    let activeDb = f.created.db;
    try {
      const runtime = new EditingRuntime();
      const controller = new HarnessController(f.state, f.root, () => undefined, {
        runtimes: {
          codex: runtime,
          claude: runtime,
          "ollama-local": runtime,
          "ollama-cloud": runtime,
          openrouter: runtime,
        },
        flag: () => true,
        outsideWorkspaceIsolation: false,
      });
      await expect(controller.listHistory()).resolves.toEqual([]);

      activeDb.close();
      const reopened = openWorkspaceRoom(f.roomPath, "correct horse battery staple");
      activeDb = reopened.db;
      f.state.room = {
        conn: reopened.db,
        path: f.roomPath,
        name: "Room",
        password: "correct horse battery staple",
        descriptor: reopened.descriptor,
        workspace: new WorkspaceService(reopened.db, f.roomPath),
      };

      await expect(controller.listHistory()).resolves.toEqual([]);
    } finally {
      if (activeDb.open) activeDb.close();
    }
  });

  it("runs local Ollama through the unified lifecycle without native-process isolation", async () => {
    const f = await fixture();
    const events: Array<{ type?: string; status?: string; runId?: string }> = [];
    const workspaceProgress: WorkspaceOperationProgressEvent[] = [];
    let terminalRuntimePresent: boolean | undefined;
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    try {
      const runtime = new EditingRuntime();
      const controller = new HarnessController(f.state, f.root, (event, payload) => {
        const row = payload as { type?: string; status?: string; runId?: string };
        events.push(row);
        if (event === "workspace-operation-progress") {
          workspaceProgress.push(payload as WorkspaceOperationProgressEvent);
        }
        if (event === "harness-event" && row.type === "run_completed" && row.runId) {
          terminalRuntimePresent = existsSync(path.join(
            f.root,
            "Arcelle Runtime",
            f.created.descriptor.roomId,
            row.runId,
          ));
          complete();
        }
      }, {
        // Keep this unit test hermetic. Capability reporting covers every
        // provider, so leaving the other four defaults here probes installed
        // Codex/Claude processes and generates a schema under full-suite load.
        runtimes: {
          codex: runtime,
          claude: runtime,
          "ollama-local": runtime,
          "ollama-cloud": runtime,
          openrouter: runtime,
        },
        flag: () => true,
        outsideWorkspaceIsolation: false,
      });
      const caps = await controller.capabilities();
      expect(caps.providers["ollama-local"]).toMatchObject({ enabled: true, installed: true });
      await controller.start({
        provider: "ollama-local",
        model: "qwen3:14b",
        privacyMode: "local",
        writeEnabled: true,
        text: "edit",
      });
      await completed;
      expect(events.find((event) => event.type === "run_completed")?.status).toBe("completed");
      expect(terminalRuntimePresent).toBe(false);
      expect(workspaceProgress.filter((event) => event.phase === "snapshotting").map((event) => event.completed))
        .toEqual([0, 1]);
      expect(workspaceProgress.at(-1)).toMatchObject({
        operation: "write-baseline", phase: "completed", status: "completed",
      });
      expect(await readFile(path.join(f.roomPath, "notes.txt"), "utf8")).toContain("Reviewed");
    } finally {
      f.created.db.close();
    }
  });

  it("probes independent harness providers concurrently", async () => {
    const f = await fixture();
    let probesStarted = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class GatedRuntime extends EditingRuntime {
      override async available(): Promise<boolean> {
        probesStarted += 1;
        await gate;
        return true;
      }
    }
    try {
      const runtime = new GatedRuntime();
      const controller = new HarnessController(f.state, f.root, () => undefined, {
        runtimes: {
          codex: runtime,
          claude: runtime,
          "ollama-local": runtime,
          "ollama-cloud": runtime,
          openrouter: runtime,
        },
        flag: () => true,
        outsideWorkspaceIsolation: false,
      });
      const checking = controller.capabilities();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(probesStarted).toBe(5);
      release();
      await expect(checking).resolves.toMatchObject({
        providers: { "ollama-local": { enabled: true, installed: true } },
      });
    } finally {
      release();
      f.created.db.close();
    }
  });

  it("keeps production native mode disabled until outside-workspace isolation is proven", async () => {
    const f = await fixture();
    try {
      const controller = new HarnessController(f.state, f.root, () => undefined, {
        runtimes: { codex: new EditingRuntime() },
        flag: () => true,
        outsideWorkspaceIsolation: false,
      });
      const capabilities = await controller.capabilities();
      expect(capabilities.outsideWorkspaceIsolation).toBe(false);
      expect(capabilities.providers.codex).toMatchObject({ enabled: false, installed: true });
      await expect(controller.start({
        provider: "codex",
        model: "test",
        privacyMode: "cloud-redacted",
        writeEnabled: true,
        text: "edit",
      })).rejects.toThrow(/isolation is not proven/i);
    } finally {
      f.created.db.close();
    }
  });

  it("reports and enables the restricted fallback when native startup probing fails", async () => {
    const f = await fixture();
    const probeRuntime = (
      name: HarnessRuntime["name"],
      exposure: boolean,
    ): HarnessRuntime => ({
      name,
      available: async () => true,
      verifyExposure: async () => exposure,
      startTurn: async () => {
        async function* events() { /* not used */ }
        return { events: events(), cancel: async () => undefined, approve: async () => undefined };
      },
    });
    try {
      const fallback = new RuntimeWithFallback(
        probeRuntime("codex-app-server", false),
        probeRuntime("legacy-cli", true),
      );
      const available = probeRuntime("legacy-cli", true);
      const controller = new HarnessController(f.state, f.root, () => undefined, {
        runtimes: {
          codex: fallback,
          claude: available,
          "ollama-local": available,
          "ollama-cloud": available,
          openrouter: available,
        },
        flag: () => true,
        outsideWorkspaceIsolation: true,
      });
      const capabilities = await controller.capabilities();
      expect(capabilities.providers.codex).toMatchObject({
        enabled: true,
        installed: true,
        harness: "legacy-cli",
        reason: expect.stringMatching(/native codex harness failed.*restricted CLI fallback/i),
      });
    } finally {
      f.created.db.close();
    }
  });

  it("applies a redacted mirror edit locally before the terminal event", async () => {
    const f = await fixture();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    try {
      const runtime = new EditingRuntime();
      const controller = new HarnessController(
        f.state,
        f.root,
        (event, payload) => {
          if (event === "harness-event") emitted.push({ event, payload });
        },
        {
          runtimes: { codex: runtime },
          policy: () => ({
            active: true,
            rules: RULES,
            concepts: [],
            guardModel: "local",
            redactor: new Redactor(RULES),
          }),
          flag: () => true,
          outsideWorkspaceIsolation: true,
          verifyExposure: async () => true,
        },
      );
      await controller.start({
        provider: "codex",
        model: "test",
        privacyMode: "cloud-redacted",
        writeEnabled: true,
        text: "edit",
      });
      for (let count = 0; count < 100 && !emitted.some(({ payload }) =>
        (payload as { type?: string }).type === "run_completed"); count += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await readFile(path.join(f.roomPath, "notes.txt"), "utf8"))
        .toBe("Ben Reich signed\nReviewed");
      const types = emitted.map(({ payload }) => (payload as { type: string }).type);
      expect(types).toEqual(["run_started", "file_changed", "run_completed"]);
      expect(await readdir(path.join(f.root, "Arcelle Runtime", f.created.descriptor.roomId))).toEqual([]);
    } finally {
      f.created.db.close();
    }
  });

  it("reports provider capability from the real per-provider sandbox probe", async () => {
    const f = await fixture();
    try {
      const backing = new EditingRuntime();
      const runtime = (name: HarnessRuntime["name"]): HarnessRuntime => ({
        name,
        available: () => backing.available(),
        startTurn: (context) => backing.startTurn(context),
      });
      const controller = new HarnessController(f.state, f.root, () => undefined, {
        runtimes: {
          codex: runtime("codex-app-server"),
          claude: runtime("claude-agent-sdk"),
        },
        flag: () => true,
        outsideWorkspaceIsolation: true,
        verifyExposure: async (_workspace, provider) => provider === "codex",
      });
      const capabilities = await controller.capabilities();
      expect(capabilities.providers.codex).toMatchObject({ enabled: true, installed: true, reason: null });
      expect(capabilities.providers.claude).toMatchObject({ enabled: false, installed: true });
      expect(capabilities.providers.claude!.reason).toMatch(/sandbox capability test/i);
    } finally {
      f.created.db.close();
    }
  });

  it("holds a run with more than twenty changed paths for approval and rolls it back when denied", async () => {
    const f = await fixture();
    const events: Array<{ type?: string; requestId?: string; status?: string }> = [];
    try {
      const controller = new HarnessController(f.state, f.root, (event, payload) => {
        if (event === "harness-event") {
          events.push(payload as { type?: string; requestId?: string; status?: string });
        }
      }, {
        runtimes: { codex: new MassEditingRuntime() },
        flag: () => true,
        outsideWorkspaceIsolation: true,
        verifyExposure: async () => true,
      });
      const runId = await controller.start({
        provider: "codex",
        model: "test",
        privacyMode: "cloud-direct",
        writeEnabled: true,
        text: "bulk edit",
      });
      for (let count = 0; count < 500 && !events.some((event) => event.requestId === `mass-change-${runId}`); count += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(events.some((event) => event.type === "run_completed")).toBe(false);
      await controller.approve(runId, `mass-change-${runId}`, "deny");
      for (let count = 0; count < 500 && !events.some((event) => event.type === "run_completed"); count += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(events.find((event) => event.type === "run_completed")?.status).toBe("cancelled");
      expect((await readdir(f.roomPath)).filter((name) => name.startsWith("bulk-"))).toEqual([]);
    } finally {
      f.created.db.close();
    }
  });
});
