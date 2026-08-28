import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../modelCatalogSurfaceIpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modelCatalogSurfaceIpc.js")>();
  return {
    ...actual,
    validateModelSelection: vi.fn(async () => ({ selectable: true, reason: null })),
  };
});
import { Redactor, type PrivacyRule } from "../privacyRedact.js";
import { createRoomManagerState } from "../roomManager.js";
import { createWorkspaceRoom, openWorkspaceRoom } from "../workspace/roomLayout.js";
import { WorkspaceService } from "../workspace/workspaceService.js";
import { HarnessController } from "./controller.js";
import { RuntimeWithFallback } from "./legacyCli.js";
import type { HarnessContext, HarnessName, HarnessRun, HarnessRuntime } from "./types.js";
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

class LegacyBlobCreatingRuntime implements HarnessRuntime {
  readonly name = "legacy-cli" as const;
  constructor(private readonly db: Database.Database) {}
  async available(): Promise<boolean> { return true; }
  async startTurn(context: HarnessContext): Promise<HarnessRun> {
    this.db.prepare(
      `INSERT INTO files(id, name, mime_type, size_bytes, source, original_bytes, extracted_text, storage_kind)
       VALUES (?, 'Agent report.md', 'text/markdown', ?, 'generated', ?, ?, 'blob')`,
    ).run(
      `legacy-agent-${context.runId}`,
      Buffer.byteLength("# Agent report\n"),
      Buffer.from("# Agent report\n"),
      "# Agent report\n",
    );
    async function* events() {
      yield { type: "run_started", runId: context.runId, harness: "legacy-cli" } as const;
      yield { type: "run_completed", runId: context.runId, status: "completed" } as const;
    }
    return { events: events(), cancel: async () => undefined, approve: async () => undefined };
  }
}

class CapturingRuntime implements HarnessRuntime {
  readonly name = "legacy-cli" as const;
  context: HarnessContext | null = null;
  starts = 0;
  async available(): Promise<boolean> { return true; }
  async startTurn(context: HarnessContext): Promise<HarnessRun> {
    this.context = context;
    this.starts += 1;
    async function* events() {
      yield { type: "run_started", runId: context.runId, harness: "legacy-cli" } as const;
      yield { type: "run_completed", runId: context.runId, status: "completed" } as const;
    }
    return { events: events(), cancel: async () => undefined, approve: async () => undefined };
  }
}

class SplitProtectedOutputRuntime implements HarnessRuntime {
  constructor(readonly name: HarnessName) {}
  async available(): Promise<boolean> { return true; }
  async startTurn(context: HarnessContext): Promise<HarnessRun> {
    const harness = this.name;
    async function* events() {
      yield { type: "run_started", runId: context.runId, harness } as const;
      yield { type: "text_delta", runId: context.runId, text: "Call Ben " } as const;
      yield { type: "text_delta", runId: context.runId, text: "Reich now." } as const;
      yield { type: "run_completed", runId: context.runId, status: "completed" } as const;
    }
    return {
      events: events(),
      cancel: async () => undefined,
      approve: async () => undefined,
    };
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
  const imported = await workspace.importFile(source, "notes.txt");
  const state = createRoomManagerState();
  state.room = {
    conn: created.db,
    path: roomPath,
    name: "Room",
    password: "correct horse battery staple",
    descriptor: created.descriptor,
    workspace,
  };
  return { root, roomPath, created, state, fileId: imported.fileId };
}

describe("HarnessController", () => {
  it.each([
    {
      label: "Deep",
      provider: "ollama-local" as const,
      harness: "arcelle-deep" as const,
      model: "qwen3:14b",
      privacyMode: "local" as const,
    },
    {
      label: "native",
      provider: "codex" as const,
      harness: "codex-app-server" as const,
      model: "test",
      privacyMode: "cloud-redacted" as const,
    },
  ])("stream-redacts protected output split across $label harness deltas", async (row) => {
    const f = await fixture();
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    const visible: string[] = [];
    try {
      const runtime = new SplitProtectedOutputRuntime(row.harness);
      const controller = new HarnessController(f.state, f.root, (event, payload) => {
        if (event !== "harness-event") return;
        const item = payload as { type?: string; text?: string };
        if (item.type === "text_delta") visible.push(item.text ?? "");
        if (item.type === "run_completed") complete();
      }, {
        runtimes: { [row.provider]: runtime },
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
        listOllamaModels: async () => ["qwen3:14b"],
      });
      await controller.start({
        provider: row.provider,
        model: row.model,
        privacyMode: row.privacyMode,
        writeEnabled: false,
        text: "review",
      });
      await completed;
      expect(visible.join("")).toBe("Call [Person A] now.");
      expect(visible.join("")).not.toContain("Ben Reich");
    } finally {
      f.created.db.close();
    }
  });

  it("keeps protected output unchanged only for explicit cloud-direct harness runs", async () => {
    const f = await fixture();
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    const visible: string[] = [];
    try {
      const runtime = new SplitProtectedOutputRuntime("codex-app-server");
      const controller = new HarnessController(f.state, f.root, (event, payload) => {
        if (event !== "harness-event") return;
        const item = payload as { type?: string; text?: string };
        if (item.type === "text_delta") visible.push(item.text ?? "");
        if (item.type === "run_completed") complete();
      }, {
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
      });
      await controller.start({
        provider: "codex",
        model: "test",
        privacyMode: "cloud-direct",
        writeEnabled: false,
        text: "review",
      });
      await completed;
      expect(visible.join("")).toBe("Call Ben Reich now.");
    } finally {
      f.created.db.close();
    }
  });

  it.each(["codex", "claude"] as const)(
    "uses the installed %s default when the UI sends its default alias",
    async (provider) => {
      const f = await fixture();
      let completed!: () => void;
      const terminal = new Promise<void>((resolve) => { completed = resolve; });
      try {
        const runtime = new CapturingRuntime();
        const controller = new HarnessController(f.state, f.root, (event, payload) => {
          if (event === "harness-event" && (payload as { type?: string }).type === "run_completed") completed();
        }, {
          runtimes: { [provider]: runtime },
          flag: () => true,
          outsideWorkspaceIsolation: true,
          verifyExposure: async () => true,
        });
        await controller.start({
          provider,
          model: " Default ",
          privacyMode: "cloud-direct",
          writeEnabled: false,
          text: "review",
        });
        await terminal;
        expect(runtime.context?.model).toBe("");
      } finally {
        f.created.db.close();
      }
    },
  );

  it.each(["ollama-local", "ollama-cloud", "openrouter"] as const)(
    "requires a specific model for the %s Deep Harness",
    async (provider) => {
      const f = await fixture();
      try {
        const runtime = new CapturingRuntime();
        const controller = new HarnessController(f.state, f.root, () => undefined, {
          runtimes: { [provider]: runtime },
          flag: () => true,
          outsideWorkspaceIsolation: false,
        });
        await expect(controller.start({
          provider,
          model: " default ",
          privacyMode: provider === "ollama-local" ? "local" : "cloud-direct",
          writeEnabled: false,
          text: "review",
        })).rejects.toThrow(`Choose a specific model for the ${provider} harness.`);
        expect(runtime.starts).toBe(0);
      } finally {
        f.created.db.close();
      }
    },
  );

  it("does not send a failed exact model ID to the provider runtime", async () => {
    const f = await fixture();
    try {
      const runtime = new CapturingRuntime();
      const controller = new HarnessController(f.state, f.root, () => undefined, {
        runtimes: { "ollama-cloud": runtime },
        flag: () => true,
        outsideWorkspaceIsolation: false,
        listOllamaModels: async () => ["bad:cloud"],
        validateModelSelection: async () => ({
          selectable: false,
          reason: "Ollama could not validate the exact model ID “bad:cloud”.",
        }),
      });
      await expect(controller.start({
        provider: "ollama-cloud",
        model: "bad:cloud",
        privacyMode: "cloud-direct",
        writeEnabled: false,
        text: "review",
      })).rejects.toThrow("exact model ID “bad:cloud”");
      expect(runtime.starts).toBe(0);
    } finally {
      f.created.db.close();
    }
  });

  it.each([
    {
      name: "canonicalizes a cloud model even when the Ollama catalog uses display casing",
      provider: "ollama-cloud" as const,
      requested: " gpt-oss:120b-cloud ",
      catalog: ["Gpt-oss:120b-cloud"],
      expected: "gpt-oss:120b-cloud",
    },
    {
      name: "uses the Ollama catalog spelling for a local model",
      provider: "ollama-local" as const,
      requested: " QWEN3.5:4B ",
      catalog: ["qwen3.5:4b"],
      expected: "qwen3.5:4b",
    },
    {
      name: "preserves an unmatched custom local model",
      provider: "ollama-local" as const,
      requested: " MyCustom:Latest ",
      catalog: [],
      expected: "MyCustom:Latest",
    },
    {
      name: "preserves a namespaced local model when it is not in the catalog",
      provider: "ollama-local" as const,
      requested: " hf.co/Owner/Repo:Q4 ",
      catalog: [],
      expected: "hf.co/Owner/Repo:Q4",
    },
    {
      name: "does not guess between ambiguous catalog spellings",
      provider: "ollama-local" as const,
      requested: " Model:Latest ",
      catalog: ["model:latest", "MODEL:LATEST"],
      expected: "Model:Latest",
    },
    {
      name: "uses the safe registry fallback for an unmatched cloud tag",
      provider: "ollama-cloud" as const,
      requested: " Gpt-OSS:120B-Cloud ",
      catalog: [],
      expected: "gpt-oss:120b-cloud",
    },
  ])("$name", async ({ provider, requested, catalog, expected }) => {
    const f = await fixture();
    let completed!: () => void;
    const terminal = new Promise<void>((resolve) => { completed = resolve; });
    try {
      const runtime = new CapturingRuntime();
      const controller = new HarnessController(f.state, f.root, (event, payload) => {
        if (event === "harness-event" && (payload as { type?: string }).type === "run_completed") completed();
      }, {
        runtimes: { [provider]: runtime },
        flag: () => true,
        outsideWorkspaceIsolation: false,
        listOllamaModels: async () => catalog,
      });
      await controller.start({
        provider,
        model: requested,
        privacyMode: provider === "ollama-local" ? "local" : "cloud-direct",
        writeEnabled: false,
        text: "review",
      });
      await terminal;
      expect(runtime.context?.model).toBe(expected);
    } finally {
      f.created.db.close();
    }
  });

  it.each([
    {
      name: "preserves a local model when the Ollama catalog fails",
      provider: "ollama-local" as const,
      requested: "MyCustom:Latest",
      expected: "MyCustom:Latest",
    },
    {
      name: "uses the safe registry fallback when the Ollama Cloud catalog fails",
      provider: "ollama-cloud" as const,
      requested: "Gpt-OSS:120B-Cloud",
      expected: "gpt-oss:120b-cloud",
    },
  ])("$name", async ({ provider, requested, expected }) => {
    const f = await fixture();
    let completed!: () => void;
    const terminal = new Promise<void>((resolve) => { completed = resolve; });
    try {
      const runtime = new CapturingRuntime();
      const controller = new HarnessController(f.state, f.root, (event, payload) => {
        if (event === "harness-event" && (payload as { type?: string }).type === "run_completed") completed();
      }, {
        runtimes: { [provider]: runtime },
        flag: () => true,
        outsideWorkspaceIsolation: false,
        listOllamaModels: async () => { throw new Error("catalog offline"); },
      });
      await controller.start({
        provider,
        model: requested,
        privacyMode: provider === "ollama-local" ? "local" : "cloud-direct",
        writeEnabled: false,
        text: "review",
      });
      await terminal;
      expect(runtime.context?.model).toBe(expected);
    } finally {
      f.created.db.close();
    }
  });

  it("does not query Ollama or change an OpenRouter model name", async () => {
    const f = await fixture();
    let catalogCalls = 0;
    let completed!: () => void;
    const terminal = new Promise<void>((resolve) => { completed = resolve; });
    try {
      const runtime = new CapturingRuntime();
      const controller = new HarnessController(f.state, f.root, (event, payload) => {
        if (event === "harness-event" && (payload as { type?: string }).type === "run_completed") completed();
      }, {
        runtimes: { openrouter: runtime },
        flag: () => true,
        outsideWorkspaceIsolation: false,
        listOllamaModels: async () => { catalogCalls += 1; return []; },
      });
      await controller.start({
        provider: "openrouter",
        model: " Owner/Mixed-Case-Model ",
        privacyMode: "cloud-direct",
        writeEnabled: false,
        text: "review",
      });
      await terminal;
      expect(runtime.context?.model).toBe("Owner/Mixed-Case-Model");
      expect(catalogCalls).toBe(0);
    } finally {
      f.created.db.close();
    }
  });

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
    const emittedNames: string[] = [];
    const updatedIds: string[] = [];
    const workspaceProgress: WorkspaceOperationProgressEvent[] = [];
    let terminalRuntimePresent: boolean | undefined;
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    try {
      const runtime = new EditingRuntime();
      const controller = new HarnessController(f.state, f.root, (event, payload) => {
        emittedNames.push(event);
        if (event === "file-updated") updatedIds.push(String(payload));
        const row = payload as { type?: string; status?: string; runId?: string };
        if (event === "harness-event") events.push(row);
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
      expect(emittedNames).toContain("room-files-changed");
      expect(emittedNames).toContain("file-updated");
      expect(updatedIds).toEqual([f.fileId]);
      expect(emittedNames.indexOf("file-updated")).toBeLessThan(
        emittedNames.lastIndexOf("harness-event"),
      );
    } finally {
      f.created.db.close();
    }
  });

  it("materializes a legacy agent blob before reporting the run complete", async () => {
    const f = await fixture();
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    try {
      const runtime = new LegacyBlobCreatingRuntime(f.created.db);
      const controller = new HarnessController(f.state, f.root, (event, payload) => {
        const item = payload as { type?: string };
        if (event === "harness-event" && item.type === "run_completed") complete();
      }, {
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
      await controller.start({
        provider: "ollama-local",
        model: "qwen3:14b",
        privacyMode: "local",
        writeEnabled: true,
        text: "create a report",
      });
      await completed;
      expect(await readFile(path.join(f.roomPath, "Agent report.md"), "utf8"))
        .toBe("# Agent report\n");
      expect(f.created.db.prepare(
        `SELECT storage_kind, original_bytes, relative_path FROM files
         WHERE name = 'Agent report.md' AND trashed_at IS NULL`,
      ).get()).toEqual({
        storage_kind: "workspace",
        original_bytes: null,
        relative_path: "Agent report.md",
      });
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

  it("reports leased read-only rooms honestly and refuses runs before history writes", async () => {
    const f = await fixture();
    try {
      f.state.room!.readOnly = true;
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
        outsideWorkspaceIsolation: true,
        verifyExposure: async () => true,
      });

      const capabilities = await controller.capabilities();
      for (const provider of Object.values(capabilities.providers)) {
        expect(provider).toMatchObject({ enabled: false, reason: expect.stringMatching(/writer lease/i) });
      }
      await expect(controller.start({
        provider: "ollama-local",
        model: "qwen3:14b",
        privacyMode: "local",
        writeEnabled: false,
        text: "read notes",
      })).rejects.toThrow(/writer lease/i);
    } finally {
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
