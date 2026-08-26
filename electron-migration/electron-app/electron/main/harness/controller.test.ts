import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Redactor, type PrivacyRule } from "../privacyRedact.js";
import { createRoomManagerState } from "../roomManager.js";
import { createWorkspaceRoom } from "../workspace/roomLayout.js";
import { WorkspaceService } from "../workspace/workspaceService.js";
import { HarnessController } from "./controller.js";
import type { HarnessContext, HarnessRun, HarnessRuntime } from "./types.js";

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

  it("applies a redacted mirror edit locally before the terminal event", async () => {
    const f = await fixture();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    try {
      const runtime = new EditingRuntime();
      const controller = new HarnessController(
        f.state,
        f.root,
        (event, payload) => { emitted.push({ event, payload }); },
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
      const runtime = new EditingRuntime();
      const controller = new HarnessController(f.state, f.root, () => undefined, {
        runtimes: { codex: runtime, claude: runtime },
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
});
