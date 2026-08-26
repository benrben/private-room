import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { insertFile } from "../db-host/files.js";
import { createRoom as createLegacyRoom } from "../db-host/open.js";
import { createWorkflow, getWorkflow } from "../db-host/workflows.js";
import { getRecMeta, setRecMeta } from "../db-host/recordings.js";
import { Redactor, type PrivacyRule } from "../privacyRedact.js";
import { defaultRecMeta, encodeWav } from "../recFormat.js";
import { CloudRedactedMirror } from "../harness/cloudMirror.js";
import { WorkspaceContentStore } from "./contentStore.js";
import { createWorkspaceRoom } from "./roomLayout.js";
import { createSealedPackage, inspectSealedPackage } from "./sealedPackage.js";
import { WorkspaceService } from "./workspaceService.js";

const roots: string[] = [];
const password = "correct horse battery staple";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freshRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `arcelle-${label}-`));
  roots.push(root);
  return root;
}

function repeatedChunks(count: number, size: number): Readable {
  return Readable.from((async function* () {
    for (let index = 0; index < count; index += 1) yield Buffer.alloc(size, index & 0xff);
  })());
}

describe("workspace harness acceptance fixtures", () => {
  it("keeps a real legacy blob fixture and streams a large workspace fixture", async () => {
    const root = await freshRoot("storage-fixtures");
    const legacyPath = path.join(root, "Legacy.roomai");
    const legacy = createLegacyRoom(legacyPath, password, "Legacy");
    const legacyFile = insertFile(
      legacy,
      "legacy.txt",
      "text/plain",
      Buffer.from("legacy bytes"),
      "legacy bytes",
      "upload",
    );
    expect(legacy.prepare("SELECT storage_kind, original_bytes FROM files WHERE id = ?")
      .get(legacyFile.id)).toEqual({ storage_kind: "blob", original_bytes: Buffer.from("legacy bytes") });
    legacy.close();

    const workspaceRoot = path.join(root, "Workspace");
    const created = createWorkspaceRoom(workspaceRoot, password, "Workspace");
    const workspace = new WorkspaceService(created.db, workspaceRoot);
    const store = new WorkspaceContentStore(workspace);
    try {
      const chunkCount = 12;
      const chunkSize = 1024 * 1024;
      const entry = await workspace.createFile(
        "Media/large-video.fixture",
        repeatedChunks(chunkCount, chunkSize),
        "fixture",
      );
      const stream = await store.readStream(entry.fileId);
      const hash = createHash("sha256");
      let total = 0;
      let largestRead = 0;
      for await (const raw of stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        total += chunk.length;
        largestRead = Math.max(largestRead, chunk.length);
        hash.update(chunk);
      }
      expect(total).toBe(chunkCount * chunkSize);
      expect(largestRead).toBeLessThan(total);
      expect(hash.digest("hex")).toBe(entry.sha256);
      expect(created.db.prepare("SELECT original_bytes FROM files WHERE id = ?").pluck().get(entry.fileId))
        .toBeNull();
    } finally {
      created.db.close();
    }
  });

  it("builds recording and workflow fixtures with normal output files and private metadata", async () => {
    const root = await freshRoot("private-state-fixtures");
    const workspaceRoot = path.join(root, "Workspace");
    const created = createWorkspaceRoom(workspaceRoot, password, "Workspace");
    const workspace = new WorkspaceService(created.db, workspaceRoot);
    try {
      const recording = await workspace.createFile(
        "Recordings/meeting.wav",
        Readable.from([encodeWav(new Float32Array(16_000))]),
        "recordings",
      );
      const meta = defaultRecMeta();
      meta.durationCs = 100;
      meta.segments.push({
        id: "segment-1",
        source: "mic",
        speaker: "You",
        t0: 0,
        t1: 100,
        text: "Fixture transcript",
        words: [{ w: "Fixture", t0: 0, t1: 50 }, { w: "transcript", t0: 50, t1: 100 }],
      });
      setRecMeta(created.db, recording.fileId, JSON.stringify(meta));
      created.db.prepare("UPDATE files SET extracted_text = ? WHERE id = ?")
        .run("Fixture transcript", recording.fileId);

      const workflowId = createWorkflow(
        created.db,
        "Fixture workflow",
        "Writes one report",
        "🧪",
        { version: 1, nodes: [{ id: "save", type: "save_file" }], edges: [] },
        "user",
        { scope: "general" },
      );
      const output = await workspace.createFile(
        "Workflow outputs/report.md",
        Readable.from(["# Fixture report\n"]),
        "generated",
      );

      expect(JSON.parse(getRecMeta(created.db, recording.fileId) ?? "null")).toMatchObject({
        durationCs: 100,
        segments: [{ text: "Fixture transcript" }],
      });
      expect(getWorkflow(created.db, workflowId)).toMatchObject({ name: "Fixture workflow", status: "draft" });
      expect(await readFile(path.join(workspaceRoot, "Workflow outputs/report.md"), "utf8"))
        .toBe("# Fixture report\n");
      const rows = created.db.prepare(
        "SELECT id, original_bytes FROM files WHERE id IN (?, ?) ORDER BY id",
      ).all(recording.fileId, output.fileId) as Array<{ id: string; original_bytes: Buffer | null }>;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.original_bytes === null)).toBe(true);
    } finally {
      created.db.close();
    }
  });

  it("builds a privacy mirror and verified checkpoint from the same workspace fixture", async () => {
    const root = await freshRoot("privacy-checkpoint-fixtures");
    const workspaceRoot = path.join(root, "Workspace");
    const runtimeRoot = path.join(root, "Runtime");
    const created = createWorkspaceRoom(workspaceRoot, password, "Workspace");
    const workspace = new WorkspaceService(created.db, workspaceRoot);
    const rules: PrivacyRule[] = [["Ben Reich", "[Person A]"]];
    const mirror = new CloudRedactedMirror(
      workspace,
      runtimeRoot,
      created.descriptor.roomId,
      "fixture-run",
      { redactor: new Redactor(rules), rules },
    );
    try {
      await workspace.createFile(
        "notes.txt",
        Readable.from(["Ben Reich approved the fixture"]),
        "fixture",
      );
      const mirrorInfo = await mirror.create();
      expect(await readFile(path.join(mirrorInfo.workspacePath, "notes.txt"), "utf8"))
        .toBe("[Person A] approved the fixture");

      const checkpointPath = path.join(root, "Fixture.roomck");
      const info = await createSealedPackage(
        workspace,
        created.descriptor.roomId,
        password,
        checkpointPath,
        password,
        "checkpoint",
      );
      expect(info).toMatchObject({ purpose: "checkpoint", fileCount: 1 });
      expect(inspectSealedPackage(checkpointPath, password)).toMatchObject({
        purpose: "checkpoint",
        roomId: created.descriptor.roomId,
        fileCount: 1,
      });
    } finally {
      await mirror.cleanup();
      created.db.close();
    }
  });
});
