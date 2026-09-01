/**
 * Vitest port of `src-tauri/src/commands/edit_gate.rs`'s own `mod tests` —
 * every test in that module is ported here (fixtures adapted to
 * `db-host/files.ts`'s naming, `db::list_file_versions` stood in for with a
 * local raw-SQL helper exactly as `editMatch.test.ts`'s own doc explains),
 * PLUS a new section covering {@link gatedWrite}/{@link editCallApproved}
 * end to end — Rust's own test module stops at the pure helpers because the
 * two orchestration functions need a live async runtime and a
 * `tauri::Window`/`State`, which this port's injected {@link GatedWriteDeps}
 * makes cheap to fake for real instead.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoom } from "./db-host/open.js";
import { getFileBytes, getFileName, insertFile, renameFile, trashFile } from "./db-host/files.js";
import { setSetting } from "./db-host/settings.js";
import { buildZip } from "./editMatchZip.js";
import {
  EditError,
  hashBytes,
  planBatch,
  planSetCells,
  planSingleEdit,
  storeFileBytes,
  type BatchOp,
  type PlannedWrite,
  type PreviewEdit,
} from "./editMatch.js";
import {
  EDIT_APPROVAL_TIMEOUT_MS,
  NO_LONGER_WAITING,
  REPLACE_ALL_PREVIEW_THRESHOLD,
  applyWithStaleness,
  applyWorkspaceWithStaleness,
  approvalNeeded,
  buildPreview,
  decisionFromStr,
  deliverEditDecision,
  editCallApproved,
  finish,
  gatedWrite,
  isLargeScaleEdit,
  registerEditGateIpc,
  resolveEditApproval,
  type EditPreview,
  type GatedWriteDeps,
  type GateOutcome,
  type OpenRoom,
  type RoomSource,
} from "./editGate.js";
import type { EditDecision } from "./roomManager.js";
import type { ToolEffects } from "./execTool.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";

/** Every temp dir this file made, so a test that opens TWO rooms (the
 * room-switch adversarial case below) still cleans both up. */
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "edit-gate-"));
  tmpDirs.push(tmpDir);
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function freshWorkspace(): { db: Database.Database; workspace: WorkspaceService } {
  const parent = mkdtempSync(path.join(os.tmpdir(), "edit-gate-workspace-"));
  tmpDirs.push(parent);
  const root = path.join(parent, "Room");
  const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Test Room");
  return { db, workspace: new WorkspaceService(db, root) };
}

function workspacePlan(
  fileId: string,
  realName: string,
  before: Buffer,
  newBytes: Buffer | null,
  renameTo: string | null = null,
  staleness: Buffer | null = hashBytes(before),
): PlannedWrite {
  return {
    fileId,
    realName,
    newBytes,
    renameTo,
    method: "exact",
    count: 1,
    staleness,
    before: before.toString("utf8"),
    after: newBytes?.toString("utf8") ?? before.toString("utf8"),
    clipped: false,
  };
}

function workspaceVersionCount(db: Database.Database, fileId: string): number {
  return (db.prepare("SELECT count(*) AS count FROM file_versions WHERE file_id = ?").get(fileId) as {
    count: number;
  }).count;
}

/** Matches the Rust test module's own `seed_text_file`. */
function seedTextFile(db: Database.Database, name: string, content: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(content, "utf8"), content, "upload").id;
}

/** Stand-in for `db::list_file_versions` — see `editMatch.test.ts`'s own
 * module doc for why this reads the table directly rather than importing a
 * port that deliberately does not exist. */
function listFileVersions(db: Database.Database, fileId: string): Array<{ cause: string }> {
  return db
    .prepare("SELECT cause FROM file_versions WHERE file_id = ? ORDER BY saved_at DESC, rowid DESC")
    .all(fileId) as Array<{ cause: string }>;
}

/** The JS analogue of `crate::extraction::fake_office_zip`. */
function fakeOfficeZip(entry: string, xml: string): Buffer {
  return buildZip([{ name: entry, data: Buffer.from(xml, "utf8") }]);
}

function expectEditError(fn: () => unknown): EditError {
  try {
    fn();
  } catch (e) {
    if (e instanceof EditError) {
      return e;
    }
    throw e;
  }
  throw new Error("expected an EditError to be thrown");
}

/** Matches the Rust test module's own `effects_with`. */
function effectsWith(runScoped: boolean, granted: boolean): Pick<ToolEffects, "runScoped" | "editApprovedThisTurn"> {
  return { runScoped, editApprovedThisTurn: granted };
}

/** A minimal `ToolEffects` for the {@link gatedWrite} integration tests —
 * every field defaulted the way `createToolEffects()` (`execTool.ts`) would,
 * duplicated here rather than imported so this file has no runtime
 * dependency on `execTool.ts`'s full surface. */
function fullEffects(overrides: Partial<ToolEffects> = {}): ToolEffects {
  return {
    boxes: null,
    annotation: null,
    wrote: false,
    webSearchThrottled: false,
    advisorCalls: 0,
    pendingImages: [],
    mediaFrames: [],
    visionChat: false,
    editOutcomes: [],
    runScoped: false,
    editApprovedThisTurn: false,
    tokenUsage: null,
    agentPlan: null,
    ...overrides,
  };
}

/** Matches the Rust test module's own `plan_with_count`. */
function planWithCount(count: number): PlannedWrite {
  return {
    fileId: "id",
    realName: "n.md",
    newBytes: Buffer.from("x"),
    renameTo: null,
    method: "exact",
    count,
    staleness: null,
    before: "",
    after: "",
    clipped: false,
  };
}

// ------------------------------------------------------- scale / cadence / decision

describe("isLargeScaleEdit (ported from edit_gate.rs's large_scale_edit_is_judged_by_summed_count_only_for_edit_tools)", () => {
  it("is judged by summed count, only for the two edit tools", () => {
    // At/under the threshold, never forced.
    expect(isLargeScaleEdit("edit_file", [planWithCount(10)])).toBe(false);
    // Over it, forced — the replace-all-of-50 case A2 closes.
    expect(isLargeScaleEdit("edit_file", [planWithCount(11)])).toBe(true);
    expect(isLargeScaleEdit("edit_file", [planWithCount(50)])).toBe(true);
    // edit_files sums across files (each touched file is count: 1 in
    // practice, but the check itself just sums whatever it's given).
    expect(isLargeScaleEdit("edit_files", Array.from({ length: 11 }, () => planWithCount(1)))).toBe(true);
    expect(isLargeScaleEdit("edit_files", Array.from({ length: 10 }, () => planWithCount(1)))).toBe(false);
    // write_file's count is a CHARACTER count, not occurrences — a normal
    // rewrite of any real length must never trip this.
    expect(isLargeScaleEdit("write_file", [planWithCount(50_000)])).toBe(false);
    // set_cells is untouched by A2 too — only the two edit tools scale-check.
    expect(isLargeScaleEdit("set_cells", [planWithCount(50)])).toBe(false);
  });

  it("REPLACE_ALL_PREVIEW_THRESHOLD is 10", () => {
    expect(REPLACE_ALL_PREVIEW_THRESHOLD).toBe(10);
  });
});

describe("approvalNeeded (ported from edit_gate.rs's approval_needed_follows_cadence)", () => {
  it("follows the off/edit/turn cadence", () => {
    // Off / absent / unknown → never prompt.
    for (const s of [null, "off", "whatever"]) {
      expect(approvalNeeded(s, effectsWith(true, false))).toBe(false);
    }
    // Every-edit → always prompt.
    expect(approvalNeeded("edit", effectsWith(true, false))).toBe(true);
    expect(approvalNeeded("edit", effectsWith(true, true))).toBe(true);
    // Once-per-answer on the run-scoped sink: prompt until granted.
    expect(approvalNeeded("turn", effectsWith(true, false))).toBe(true);
    expect(approvalNeeded("turn", effectsWith(true, true))).toBe(false);
    // Sink-less (cloud/external) scope: the turn flag can't persist, so
    // "turn" degrades to per-edit prompting — always prompt.
    expect(approvalNeeded("turn", effectsWith(false, true))).toBe(true);
  });
});

describe("decisionFromStr (ported from edit_gate.rs's decision_string_maps_once_turn_deny)", () => {
  it("maps once/turn/anything-else", () => {
    const once = decisionFromStr("once");
    expect(once.approved && !once.restOfTurn).toBe(true);
    const turn = decisionFromStr("turn");
    expect(turn.approved && turn.restOfTurn).toBe(true);
    const deny = decisionFromStr("deny");
    expect(!deny.approved && !deny.restOfTurn).toBe(true);
    // Any unknown string is a decline, never a silent yes.
    expect(decisionFromStr("").approved).toBe(false);
    expect(decisionFromStr("garbage").approved).toBe(false);
  });
});

// ---------------------------------------------------------------- deliver/resolve

describe(
  "deliverEditDecision (ported from edit_gate.rs's answering_a_diff_card_that_gave_up_reports_it, " +
    "minus the tokio-oneshot 'receiver dropped' branch this Map-of-callbacks design has no equivalent " +
    "of — see editGate.ts's module doc)",
  () => {
    it("delivers a live card once, and reports the same NO_LONGER_WAITING error on every answer after", () => {
      const pending = new Map<string, (decision: EditDecision) => void>();
      const received: EditDecision[] = [];
      pending.set("live", (d) => received.push(d));

      const first = deliverEditDecision(pending, "live", decisionFromStr("once"));
      expect(first).toEqual({ ok: true });
      expect(received).toEqual([{ approved: true, restOfTurn: false }]);
      // The entry is consumed — answering it a second time is an error, not
      // a silent no-op.
      const second = deliverEditDecision(pending, "live", decisionFromStr("once"));
      expect(second).toEqual({ ok: false, error: NO_LONGER_WAITING });

      // An id that was never pending answers the same way.
      const unknown = deliverEditDecision(pending, "never-existed", decisionFromStr("turn"));
      expect(unknown).toEqual({ ok: false, error: NO_LONGER_WAITING });

      expect(pending.size).toBe(0);
    });
  }
);

describe("resolveEditApproval", () => {
  it("throws NO_LONGER_WAITING for an id that is not (or no longer) pending", () => {
    const pending = new Map<string, (decision: EditDecision) => void>();
    expect(() => resolveEditApproval(pending, "missing", "once")).toThrowError(NO_LONGER_WAITING);
  });

  it("delivers a live card without throwing", () => {
    const pending = new Map<string, (decision: EditDecision) => void>();
    let got: EditDecision | undefined;
    pending.set("id-1", (d) => (got = d));
    expect(() => resolveEditApproval(pending, "id-1", "turn")).not.toThrow();
    expect(got).toEqual({ approved: true, restOfTurn: true });
  });
});

// ----------------------------------------------------------------- applyWithStaleness

describe("applyWithStaleness (ported from edit_gate.rs's stale_apply_refuses_and_leaves_file_untouched)", () => {
  it("refuses and leaves the file untouched when the bytes changed under the pending approval", () => {
    const db = freshRoom();
    const id = insertFile(db, "n.md", "text/plain", Buffer.from("before edits"), "before edits", "upload").id;
    // Phase 1: compute the plan (against the current bytes + hash).
    const edit: PreviewEdit = { name: "n.md", oldText: "before", newText: "AFTER", all: false };
    const plans = planSingleEdit(db, edit);
    // A concurrent change lands while the approval card is open.
    storeFileBytes(db, id, Buffer.from("before edits (touched)"), "before edits (touched)", "You saved");
    const beforeVersions = listFileVersions(db, id).length;
    // Phase 3: the staleness token no longer matches → strict refusal.
    const err = expectEditError(() => applyWithStaleness(db, plans, "AI edit"));
    expect(err.outcome).toBe("stale");
    // The concurrent bytes are intact; no new snapshot from the refused apply.
    expect(getFileBytes(db, id)!.toString("utf8")).toBe("before edits (touched)");
    expect(listFileVersions(db, id).length).toBe(beforeVersions);
  });
});

describe("applyWorkspaceWithStaleness", () => {
  it("preflights, versions, writes, and renames real workspace files before committing them", async () => {
    const { db, workspace } = freshWorkspace();
    const textBefore = Buffer.from("before binary");
    const invalidBefore = Buffer.from([0xc3, 0x28]);
    const renameBefore = Buffer.from("rename only");
    const text = await workspace.createFile("folder/note.bin", Readable.from([textBefore]), "upload");
    const invalid = await workspace.createFile("bad.bin", Readable.from([invalidBefore]), "upload");
    const renameOnly = await workspace.createFile("move.txt", Readable.from([renameBefore]), "upload");
    const textAfter = Buffer.from("after binary");
    const invalidAfter = Buffer.from([0xc3, 0x28]);

    await applyWorkspaceWithStaleness(db, workspace, [
      workspacePlan(text.fileId, "note.bin", textBefore, textAfter, "archived.bin"),
      workspacePlan(invalid.fileId, "bad.bin", invalidBefore, invalidAfter),
      workspacePlan(renameOnly.fileId, "move.txt", renameBefore, null, "moved.txt", null),
    ], "AI edit");

    await expect(workspace.readBuffer(text.fileId)).resolves.toEqual(textAfter);
    await expect(workspace.readBuffer(invalid.fileId)).resolves.toEqual(invalidAfter);
    expect(db.prepare("SELECT name, relative_path FROM files WHERE id = ?").get(text.fileId)).toEqual({
      name: "archived.bin",
      relative_path: "folder/archived.bin",
    });
    expect(db.prepare("SELECT name FROM files WHERE id = ?").get(renameOnly.fileId)).toEqual({ name: "moved.txt" });
    expect(workspaceVersionCount(db, text.fileId)).toBe(1);
    expect(workspaceVersionCount(db, invalid.fileId)).toBe(1);
    expect(workspaceVersionCount(db, renameOnly.fileId)).toBe(0);
    expect(db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(text.fileId)).toEqual({
      extracted_text: "after binary",
    });
    expect(db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(invalid.fileId)).toEqual({
      extracted_text: "",
    });
  });

  it("rejects stale workspace identity before snapshotting or changing any file", async () => {
    const { db, workspace } = freshWorkspace();
    const before = Buffer.from("before");
    const entry = await workspace.createFile("note.md", Readable.from([before]), "upload");
    db.prepare("UPDATE files SET name = 'renamed.md' WHERE id = ?").run(entry.fileId);

    await expect(applyWorkspaceWithStaleness(
      db,
      workspace,
      [workspacePlan(entry.fileId, "note.md", before, Buffer.from("after"))],
      "AI edit",
    )).rejects.toMatchObject({ outcome: "stale" });
    expect(workspaceVersionCount(db, entry.fileId)).toBe(0);
  });

  it("rejects stale workspace bytes before snapshotting or changing any file", async () => {
    const { db, workspace } = freshWorkspace();
    const before = Buffer.from("before");
    const touched = Buffer.from("touched elsewhere");
    const entry = await workspace.createFile("note.md", Readable.from([before]), "upload");
    await workspace.writeAtomic(entry.fileId, Readable.from([touched]), hashBytes(before).toString("hex"));

    await expect(applyWorkspaceWithStaleness(
      db,
      workspace,
      [workspacePlan(entry.fileId, "note.md", before, Buffer.from("after"))],
      "AI edit",
    )).rejects.toMatchObject({ outcome: "stale" });
    await expect(workspace.readBuffer(entry.fileId)).resolves.toEqual(touched);
    expect(workspaceVersionCount(db, entry.fileId)).toBe(0);
  });

  it("rolls back earlier workspace writes and moves when a later plan fails", async () => {
    const { db, workspace } = freshWorkspace();
    const firstBefore = Buffer.from("first before");
    const renameBefore = Buffer.from("rename before");
    const failingBefore = Buffer.from("failing before");
    const first = await workspace.createFile("first.md", Readable.from([firstBefore]), "upload");
    const renameOnly = await workspace.createFile("move.md", Readable.from([renameBefore]), "upload");
    const failing = await workspace.createFile("failing.md", Readable.from([failingBefore]), "upload");
    db.prepare("UPDATE files SET extracted_text = 'indexed before' WHERE id = ?").run(first.fileId);
    const realWrite = workspace.writeAtomic.bind(workspace);
    vi.spyOn(workspace, "writeAtomic").mockImplementation(async (fileId, content, expectedHash, agentRunId) => {
      if (fileId === failing.fileId) throw new Error("later workspace write failed");
      return realWrite(fileId, content, expectedHash, agentRunId);
    });
    vi.spyOn(workspace, "deleteVersion").mockRejectedValue(new Error("transient cleanup failed"));

    await expect(applyWorkspaceWithStaleness(db, workspace, [
      workspacePlan(first.fileId, "first.md", firstBefore, Buffer.from("first after"), "first-renamed.md"),
      workspacePlan(renameOnly.fileId, "move.md", renameBefore, null, "moved.md", null),
      workspacePlan(failing.fileId, "failing.md", failingBefore, Buffer.from("failing after")),
    ], "AI edit")).rejects.toThrow("later workspace write failed");

    await expect(workspace.readBuffer(first.fileId)).resolves.toEqual(firstBefore);
    expect(db.prepare("SELECT name, extracted_text FROM files WHERE id = ?").get(first.fileId)).toEqual({
      name: "first.md",
      extracted_text: "indexed before",
    });
    expect(db.prepare("SELECT name FROM files WHERE id = ?").get(renameOnly.fileId)).toEqual({ name: "move.md" });
    expect(workspaceVersionCount(db, first.fileId)).toBe(1);
    expect(workspaceVersionCount(db, failing.fileId)).toBe(1);
  });

  it("reports incomplete rollback when a saved workspace version cannot be restored", async () => {
    const { db, workspace } = freshWorkspace();
    const firstBefore = Buffer.from("first before");
    const failingBefore = Buffer.from("failing before");
    const first = await workspace.createFile("first.md", Readable.from([firstBefore]), "upload");
    const failing = await workspace.createFile("failing.md", Readable.from([failingBefore]), "upload");
    const realWrite = workspace.writeAtomic.bind(workspace);
    vi.spyOn(workspace, "writeAtomic").mockImplementation(async (fileId, content, expectedHash, agentRunId) => {
      if (fileId === failing.fileId) throw new Error("later workspace write failed");
      return realWrite(fileId, content, expectedHash, agentRunId);
    });
    vi.spyOn(workspace, "versionSnapshot").mockRejectedValue(new Error("snapshot vanished"));

    await expect(applyWorkspaceWithStaleness(db, workspace, [
      workspacePlan(first.fileId, "first.md", firstBefore, Buffer.from("first after")),
      workspacePlan(failing.fileId, "failing.md", failingBefore, Buffer.from("failing after")),
    ], "AI edit")).rejects.toMatchObject({
      outcome: "error",
      message: expect.stringContaining("could not safely restore"),
    });
  });
});

describe(
  "applyWithStaleness — rename-only plans (ported from edit_gate.rs's " +
    "an_approved_rename_refuses_once_the_file_is_no_longer_that_file)",
  () => {
    it("refuses once the file is no longer that file, and re-applies once it is again", () => {
      // The gap this pins: a rename-only plan carries no byte token, so phase
      // 3 had NOTHING to check — the rename landed on whatever that id had
      // become while the card sat open, a change nobody was shown.
      const db = freshRoom();
      const id = insertFile(db, "notes.md", "text/plain", Buffer.from("body"), "body", "upload").id;
      const ops: BatchOp[] = [{ op: "rename", name: "notes.md", newName: "archive.md" }];
      const plans = planBatch(db, ops);
      expect(plans[0]!.staleness).toBeNull();

      // The user renames it themselves while the approval card is open.
      renameFile(db, id, "minutes.md");
      const err = expectEditError(() => applyWithStaleness(db, plans, "AI edit"));
      expect(err.outcome).toBe("stale");
      expect(getFileName(db, id)).toBe("minutes.md");

      // Untouched, the same plan still applies — the check is staleness, not a ban.
      renameFile(db, id, "notes.md");
      applyWithStaleness(db, plans, "AI edit");
      expect(getFileName(db, id)).toBe("archive.md");
    });
  }
);

describe(
  "applyWithStaleness — trashed files (ported from edit_gate.rs's a_trashed_file_is_never_written_by_a_pending_approval)",
  () => {
    it("is never written by a pending approval", () => {
      const db = freshRoom();
      const id = insertFile(db, "n.md", "text/plain", Buffer.from("before edits"), "before edits", "upload").id;
      const edit: PreviewEdit = { name: "n.md", oldText: "before", newText: "AFTER", all: false };
      const plans = planSingleEdit(db, edit);
      trashFile(db, id, { kind: "user" });
      const err = expectEditError(() => applyWithStaleness(db, plans, "AI edit"));
      expect(err.outcome).toBe("stale");
    });
  }
);

describe(
  "buildPreview + real plans (ported from edit_gate.rs's preview_builds_content_for_docx_and_cells)",
  () => {
    it("builds docx and cells preview content from extracted text, never raw markup", () => {
      const db = freshRoom();
      // docx: before/after are EXTRACTED text, not raw XML.
      const docx = fakeOfficeZip("word/document.xml", `<w:document><w:p><w:t>Fee is 5% today</w:t></w:p></w:document>`);
      insertFile(db, "c.docx", "application/vnd.openxmlformats", docx, "Fee is 5% today", "upload");
      const edit: PreviewEdit = { name: "c.docx", oldText: "5%", newText: "7%", all: false };
      const plans = planSingleEdit(db, edit);
      const preview = buildPreview("edit_file", plans, false);
      expect(preview.files[0]!.before).toContain("Fee is 5%");
      expect(preview.files[0]!.after).toContain("7%");
      expect(preview.files[0]!.before).not.toContain("<w:t>");
      expect(preview.files[0]!.name).toBe("c.docx");
      expect(preview.tool).toBe("edit_file");
      expect(preview.allowTurn).toBe(false);

      // csv cells: before/after synthesized from the file text (no cell reader).
      insertFile(db, "b.csv", "text/csv", Buffer.from("a,1\nb,2\n"), "a,1\nb,2\n", "upload");
      const cells = planSetCells(db, "b.csv", null, [["B1", "9"]]);
      const cellsPreview = buildPreview("set_cells", cells, false);
      expect(cellsPreview.files[0]!.before).toContain("a,1");
      expect(cellsPreview.files[0]!.after).toContain("a,9");
    });
  }
);

// ------------------------------------------------------------------ gatedWrite

/** A `RoomSource` fixed to one open room, toggleable to simulate the room
 * closing between phase 1 and phase 3 (the exact gap `gatedWrite`'s module
 * doc calls out — the approval await is where this can genuinely happen). */
function toggleableRoomSource(db: Database.Database, path = "test.roomai"): RoomSource & { close(): void } {
  let open = true;
  return {
    currentRoom: (): OpenRoom | null => (open ? { db, path } : null),
    close: () => {
      open = false;
    },
  };
}

function depsFor(
  rooms: RoomSource,
  overrides: Partial<GatedWriteDeps> = {}
): GatedWriteDeps & { emitted: Array<[string, unknown]> } {
  const emitted: Array<[string, unknown]> = [];
  return {
    rooms,
    editPending: new Map(),
    emit: (event, payload) => emitted.push([event, payload]),
    emitted,
    ...overrides,
  };
}

describe("gatedWrite — gate off (default), byte-identical to the pre-Wave-2 path", () => {
  it("applies immediately, emits the post-write events, and sets effects.wrote", () => {
    const db = freshRoom();
    const id = seedTextFile(db, "n.md", "cost is 5.");
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects();
    const edit: PreviewEdit = { name: "n.md", oldText: "5", newText: "7", all: false };

    return gatedWrite("edit_file", "AI edit", deps, effects, (conn) => planSingleEdit(conn, edit)).then(
      (outcome: GateOutcome) => {
        expect(outcome.kind).toBe("applied");
        expect(getFileBytes(db, id)!.toString("utf8")).toBe("cost is 7.");
        expect(effects.wrote).toBe(true);
        expect(deps.emitted).toContainEqual(["room-files-changed", undefined]);
        expect(deps.emitted).toContainEqual(["file-updated", id]);
        // No approval card was ever opened.
        expect(deps.editPending.size).toBe(0);
      }
    );
  });

  it("returns a structured error when the immediate database commit fails", async () => {
    const db = freshRoom();
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects();
    const impossible = workspacePlan("missing-file-id", "missing.md", Buffer.from("before"), Buffer.from("after"));

    const outcome = await gatedWrite("write_file", "AI rewrite", deps, effects, () => [impossible]);

    expect(outcome).toEqual({ kind: "error", error: expect.any(EditError) });
    expect(effects.wrote).toBe(false);
    expect(deps.emitted).toEqual([]);
  });

  it("still forces a preview when a single call is a mass replace (A2), even with the gate off", () => {
    const db = freshRoom();
    const id = seedTextFile(db, "n.md", "old");
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects();
    // Injected compute bypasses real matching so the scale check alone is
    // exercised — `count` is what `isLargeScaleEdit` reads.
    const bigPlan: PlannedWrite = {
      fileId: id,
      realName: "n.md",
      newBytes: Buffer.from("new"),
      renameTo: null,
      method: "exact",
      count: 11,
      staleness: hashBytes(Buffer.from("old")),
      before: "old",
      after: "new",
      clipped: false,
    };

    const outcomePromise = gatedWrite("edit_file", "AI edit", deps, effects, () => [bigPlan]);
    // Synchronous up to the pending approval — see editGate.ts's module doc.
    expect(deps.editPending.size).toBe(1);
    expect(deps.emitted[0]![0]).toBe("edit-approve-request");
    const [approvalId] = [...deps.editPending.keys()];
    resolveEditApproval(deps.editPending, approvalId!, "once");
    return outcomePromise.then((outcome) => {
      expect(outcome.kind).toBe("applied");
      expect(getFileBytes(db, id)!.toString("utf8")).toBe("new");
    });
  });
});

describe('gatedWrite — cadence "edit": every call prompts', () => {
  it("applies once the user approves, re-checking staleness against the CURRENT bytes", async () => {
    const db = freshRoom();
    const id = seedTextFile(db, "n.md", "cost is 5.");
    setSetting(db, "edit_approval", "edit");
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects();
    const edit: PreviewEdit = { name: "n.md", oldText: "5", newText: "7", all: false };

    const outcomePromise = gatedWrite("edit_file", "AI edit", deps, effects, (conn) => planSingleEdit(conn, edit));
    expect(deps.editPending.size).toBe(1);
    const [approvalId] = [...deps.editPending.keys()];
    resolveEditApproval(deps.editPending, approvalId!, "once");
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("applied");
    expect(getFileBytes(db, id)!.toString("utf8")).toBe("cost is 7.");
  });

  it("applies an approved write through the workspace storage adapter", async () => {
    const { db, workspace } = freshWorkspace();
    const before = Buffer.from("workspace before");
    const entry = await workspace.createFile("note.md", Readable.from([before]), "upload");
    setSetting(db, "edit_approval", "edit");
    const deps = depsFor({ currentRoom: () => ({ db, path: workspace.root, workspace }) });
    const effects = fullEffects();
    const after = Buffer.from("workspace after");

    const pending = gatedWrite("write_file", "AI rewrite", deps, effects, () => [
      workspacePlan(entry.fileId, "note.md", before, after),
    ]);
    const [approvalId] = [...deps.editPending.keys()];
    resolveEditApproval(deps.editPending, approvalId!, "once");

    await expect(pending).resolves.toMatchObject({ kind: "applied" });
    await expect(workspace.readBuffer(entry.fileId)).resolves.toEqual(after);
    expect(effects.wrote).toBe(true);
  });

  it("refuses when the file changed while the card was open, and leaves it untouched", async () => {
    const db = freshRoom();
    const id = seedTextFile(db, "n.md", "cost is 5.");
    setSetting(db, "edit_approval", "edit");
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects();
    const edit: PreviewEdit = { name: "n.md", oldText: "5", newText: "7", all: false };

    const outcomePromise = gatedWrite("edit_file", "AI edit", deps, effects, (conn) => planSingleEdit(conn, edit));
    const [approvalId] = [...deps.editPending.keys()];
    // A concurrent change lands while the card is open.
    storeFileBytes(db, id, Buffer.from("cost is 5. (touched)"), "cost is 5. (touched)", "You saved");
    resolveEditApproval(deps.editPending, approvalId!, "once");
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("error");
    expect((outcome as { kind: "error"; error: EditError }).error.outcome).toBe("stale");
    expect(getFileBytes(db, id)!.toString("utf8")).toBe("cost is 5. (touched)");
    expect(effects.wrote).toBe(false);
  });

  it("declines and leaves the file untouched when the user says no", async () => {
    const db = freshRoom();
    const id = seedTextFile(db, "n.md", "cost is 5.");
    setSetting(db, "edit_approval", "edit");
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects();
    const edit: PreviewEdit = { name: "n.md", oldText: "5", newText: "7", all: false };

    const outcomePromise = gatedWrite("edit_file", "AI edit", deps, effects, (conn) => planSingleEdit(conn, edit));
    const [approvalId] = [...deps.editPending.keys()];
    resolveEditApproval(deps.editPending, approvalId!, "deny");
    const outcome = await outcomePromise;
    expect(outcome).toEqual({
      kind: "declined",
      message:
        "The user declined the proposed change after seeing the preview, so nothing was " +
        "modified. Ask what they'd like instead.",
    });
    expect(getFileBytes(db, id)!.toString("utf8")).toBe("cost is 5.");
    expect(effects.wrote).toBe(false);
  });

  it("reports a no-answer timeout distinctly from a decline, and prunes the pending entry", async () => {
    const db = freshRoom();
    seedTextFile(db, "n.md", "cost is 5.");
    setSetting(db, "edit_approval", "edit");
    const deps = depsFor(toggleableRoomSource(db), { timeoutMs: 5 });
    const effects = fullEffects();
    const edit: PreviewEdit = { name: "n.md", oldText: "5", newText: "7", all: false };

    const outcome = await gatedWrite("edit_file", "AI edit", deps, effects, (conn) => planSingleEdit(conn, edit));
    expect(outcome.kind).toBe("declined");
    expect((outcome as { kind: "declined"; message: string }).message).toContain("Nobody answered");
    expect(deps.editPending.size).toBe(0);
  });

  it("refuses when the room closed while the card was open (phase 3 has nowhere to apply to)", async () => {
    const db = freshRoom();
    seedTextFile(db, "n.md", "cost is 5.");
    setSetting(db, "edit_approval", "edit");
    const room = toggleableRoomSource(db);
    const deps = depsFor(room);
    const effects = fullEffects();
    const edit: PreviewEdit = { name: "n.md", oldText: "5", newText: "7", all: false };

    const outcomePromise = gatedWrite("edit_file", "AI edit", deps, effects, (conn) => planSingleEdit(conn, edit));
    const [approvalId] = [...deps.editPending.keys()];
    room.close();
    resolveEditApproval(deps.editPending, approvalId!, "once");
    const outcome = await outcomePromise;
    expect(outcome).toEqual({ kind: "error", error: expect.objectContaining({ message: "No room is open." }) });
  });
});

describe('gatedWrite — cadence "turn": once per answer, only on the run-scoped sink', () => {
  it('"Apply for the rest of this answer" sets editApprovedThisTurn, which then skips the prompt', async () => {
    const db = freshRoom();
    const id = seedTextFile(db, "n.md", "alpha beta");
    setSetting(db, "edit_approval", "turn");
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects({ runScoped: true });

    // First call: prompts, and the user grants "rest of this answer".
    const first = gatedWrite("edit_file", "AI edit", deps, effects, (conn) =>
      planSingleEdit(conn, { name: "n.md", oldText: "alpha", newText: "ALPHA", all: false })
    );
    expect(deps.editPending.size).toBe(1);
    const [firstApprovalId] = [...deps.editPending.keys()];
    resolveEditApproval(deps.editPending, firstApprovalId!, "turn");
    const firstOutcome = await first;
    expect(firstOutcome.kind).toBe("applied");
    expect(effects.editApprovedThisTurn).toBe(true);

    // Second call, same effects object: no prompt this time.
    const second = await gatedWrite("edit_file", "AI edit", deps, effects, (conn) =>
      planSingleEdit(conn, { name: "n.md", oldText: "beta", newText: "BETA", all: false })
    );
    expect(second.kind).toBe("applied");
    expect(deps.editPending.size).toBe(0);
    expect(getFileBytes(db, id)!.toString("utf8")).toBe("ALPHA BETA");
  });

  it("does NOT let the turn flag stick for a sink-less (non-run-scoped) caller", async () => {
    const db = freshRoom();
    seedTextFile(db, "n.md", "alpha");
    setSetting(db, "edit_approval", "turn");
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects({ runScoped: false });

    const outcomePromise = gatedWrite("edit_file", "AI edit", deps, effects, (conn) =>
      planSingleEdit(conn, { name: "n.md", oldText: "alpha", newText: "ALPHA", all: false })
    );
    const [approvalId] = [...deps.editPending.keys()];
    resolveEditApproval(deps.editPending, approvalId!, "turn");
    await outcomePromise;
    expect(effects.editApprovedThisTurn).toBe(false);
  });
});

describe("gatedWrite — errors that never reach an approval card", () => {
  it('answers "No room is open." with no room, before compute ever runs', async () => {
    const deps = depsFor({ currentRoom: () => null });
    const effects = fullEffects();
    const compute = vi.fn(() => {
      throw new Error("must not be called");
    });
    const outcome = await gatedWrite("edit_file", "AI edit", deps, effects, compute);
    expect(outcome).toEqual({ kind: "error", error: expect.objectContaining({ message: "No room is open." }) });
    expect(compute).not.toHaveBeenCalled();
  });

  it("passes a thrown EditError through unwrapped, with its own outcome tag intact", async () => {
    const db = freshRoom();
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects();
    const boom = new EditError("could not find that text", "not_found");
    const outcome = await gatedWrite("edit_file", "AI edit", deps, effects, () => {
      throw boom;
    });
    expect(outcome).toEqual({ kind: "error", error: boom });
  });

  it("reports empty plans as \"Nothing to change.\"", async () => {
    const db = freshRoom();
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects();
    const outcome = await gatedWrite("edit_file", "AI edit", deps, effects, () => []);
    expect(outcome).toEqual({ kind: "error", error: expect.objectContaining({ message: "Nothing to change.", outcome: "error" }) });
  });

  it(
    "a well-formed batch caller tags a plain planBatch failure with EditError.batchFailure " +
      "(outcome 'failed'), exactly as agent.rs's edit_files arm does at the call site",
    async () => {
      const db = freshRoom();
      const deps = depsFor(toggleableRoomSource(db));
      const effects = fullEffects();
      const ops: BatchOp[] = [{ op: "edit", name: "does-not-exist.md", oldText: "x", newText: "y" }];
      const outcome = await gatedWrite("edit_files", "AI edit (batch x)", deps, effects, (conn) => {
        try {
          return planBatch(conn, ops);
        } catch (e) {
          throw EditError.batchFailure(e instanceof Error ? e.message : String(e));
        }
      });
      expect(outcome.kind).toBe("error");
      expect((outcome as { kind: "error"; error: EditError }).error.outcome).toBe("failed");
    }
  );

  it(
    "a caller that does NOT convert a plain compute failure gets the generic 'error' tag, " +
      "not the caller's intended one — the safety net, not the real behavior",
    async () => {
      const db = freshRoom();
      const deps = depsFor(toggleableRoomSource(db));
      const effects = fullEffects();
      const ops: BatchOp[] = [{ op: "edit", name: "does-not-exist.md", oldText: "x", newText: "y" }];
      const outcome = await gatedWrite("edit_files", "AI edit (batch x)", deps, effects, (conn) => planBatch(conn, ops));
      expect(outcome.kind).toBe("error");
      expect((outcome as { kind: "error"; error: EditError }).error.outcome).toBe("error");
    }
  );
});

// ============================================================================
// Adversarial: three refusals the gate MUST make and that neither
// `edit_gate.rs`'s own tests nor the ported ones above reach — a partially
// stale BATCH, an approval that lands after the app switched rooms, and the
// exact scale threshold at which a preview starts being forced.
// ============================================================================

describe("adversarial — a partially stale batch is refused ATOMICALLY", () => {
  it("one stale plan in a two-file batch applies NOTHING; the other file keeps its old bytes and gains no version", async () => {
    // `apply_with_staleness` checks EVERY plan before `commit_plans` runs. A
    // per-plan check-then-write loop would have written a.md and only then
    // discovered b.md was stale — half of an approval the user was shown as
    // one atomic change.
    const db = freshRoom();
    const a = seedTextFile(db, "a.md", "alpha one");
    const b = seedTextFile(db, "b.md", "beta one");
    setSetting(db, "edit_approval", "edit");
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects();
    const ops: BatchOp[] = [
      { op: "edit", name: "a.md", oldText: "alpha", newText: "ALPHA" },
      { op: "edit", name: "b.md", oldText: "beta", newText: "BETA" },
    ];

    const outcomePromise = gatedWrite("edit_files", "AI edit (batch z)", deps, effects, (conn) => planBatch(conn, ops));
    const [approvalId] = [...deps.editPending.keys()];
    const aVersionsBefore = listFileVersions(db, a).length;
    // Only the SECOND file moves under the open card.
    storeFileBytes(db, b, Buffer.from("beta one (touched)"), "beta one (touched)", "You saved");
    resolveEditApproval(deps.editPending, approvalId!, "once");
    const outcome = await outcomePromise;

    expect(outcome.kind).toBe("error");
    expect((outcome as { kind: "error"; error: EditError }).error.outcome).toBe("stale");
    expect(getFileBytes(db, a)!.toString("utf8")).toBe("alpha one");
    expect(listFileVersions(db, a).length).toBe(aVersionsBefore);
    expect(getFileBytes(db, b)!.toString("utf8")).toBe("beta one (touched)");
    expect(effects.wrote).toBe(false);
  });
});

describe("adversarial — the app switched rooms while the approval card was open", () => {
  it("an approved edit never lands on a same-named file in a DIFFERENT room", async () => {
    // The gap this pins is the one `editGate.ts`'s module doc claims phase 3
    // already covers "for free": the plan carries a FILE ID, and a room that
    // never had that id cannot resolve it to `realName` — so the identity
    // check refuses before any byte check runs. If phase 3 had matched on
    // NAME, or had reused phase 1's room handle, an approved "n.md" edit
    // would have landed on a completely different document.
    const roomA = freshRoom();
    const roomB = freshRoom();
    const aId = insertFile(roomA, "n.md", "text/plain", Buffer.from("cost is 5."), "cost is 5.", "upload").id;
    const bId = insertFile(roomB, "n.md", "text/plain", Buffer.from("cost is 5."), "cost is 5.", "upload").id;
    setSetting(roomA, "edit_approval", "edit");

    let current: OpenRoom | null = { db: roomA, path: "a.roomai" };
    const deps = depsFor({ currentRoom: () => current });
    const effects = fullEffects();
    const edit: PreviewEdit = { name: "n.md", oldText: "5", newText: "7", all: false };

    const outcomePromise = gatedWrite("edit_file", "AI edit", deps, effects, (conn) => planSingleEdit(conn, edit));
    const [approvalId] = [...deps.editPending.keys()];
    current = { db: roomB, path: "b.roomai" };
    resolveEditApproval(deps.editPending, approvalId!, "once");
    const outcome = await outcomePromise;

    expect(outcome.kind).toBe("error");
    expect((outcome as { kind: "error"; error: EditError }).error.outcome).toBe("stale");
    expect(getFileBytes(roomA, aId)!.toString("utf8")).toBe("cost is 5.");
    expect(getFileBytes(roomB, bId)!.toString("utf8")).toBe("cost is 5.");
    expect(effects.wrote).toBe(false);
  });
});

describe("adversarial — the A2 scale threshold's exact boundary, through gatedWrite", () => {
  function planOf(fileId: string, count: number, currentBytes: Buffer): PlannedWrite {
    return {
      fileId,
      realName: "n.md",
      newBytes: Buffer.from("new"),
      renameTo: null,
      method: "exact",
      count,
      staleness: hashBytes(currentBytes),
      before: "old",
      after: "new",
      clipped: false,
    };
  }

  it("a summed count of exactly 10 still applies instantly with the gate off — the card starts at 11", async () => {
    const db = freshRoom();
    const id = seedTextFile(db, "n.md", "old");
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects();
    const outcome = await gatedWrite("edit_file", "AI edit", deps, effects, () => [
      planOf(id, REPLACE_ALL_PREVIEW_THRESHOLD, Buffer.from("old")),
    ]);
    expect(outcome.kind).toBe("applied");
    // No card was ever opened, and nothing was emitted before the write.
    expect(deps.editPending.size).toBe(0);
    expect(deps.emitted.map(([e]) => e)).not.toContain("edit-approve-request");
    expect(getFileBytes(db, id)!.toString("utf8")).toBe("new");
  });

  it("write_file's CHARACTER count never forces a card, at any size — only the two edit tools scale-check", async () => {
    // A 50,000-character rewrite is an ordinary `write_file`. Scale-checking
    // it would put a diff card in front of every single rewrite the model
    // makes, with the gate off, which is exactly what A2's carve-out prevents.
    const db = freshRoom();
    const id = seedTextFile(db, "n.md", "old");
    const deps = depsFor(toggleableRoomSource(db));
    const effects = fullEffects();
    const outcome = await gatedWrite("write_file", "AI rewrite", deps, effects, () => [
      planOf(id, 50_000, Buffer.from("old")),
    ]);
    expect(outcome.kind).toBe("applied");
    expect(deps.editPending.size).toBe(0);
    expect(deps.emitted.map(([e]) => e)).not.toContain("edit-approve-request");
  });
});

// ------------------------------------------------------------ editCallApproved

describe("editCallApproved", () => {
  it("sets editApprovedThisTurn only for a run-scoped approval with rest_of_turn", async () => {
    const deps = depsFor(toggleableRoomSource(freshRoom()));
    const preview: EditPreview = { tool: "edit_file", allowTurn: true, files: [] };
    const effects = { runScoped: true, editApprovedThisTurn: false };
    const promise = editCallApproved(deps, effects, preview);
    const [id] = [...deps.editPending.keys()];
    resolveEditApproval(deps.editPending, id!, "turn");
    expect(await promise).toBe("approved");
    expect(effects.editApprovedThisTurn).toBe(true);
  });

  it("emits edit-approve-request with the preview's shape", async () => {
    const deps = depsFor(toggleableRoomSource(freshRoom()));
    const preview: EditPreview = {
      tool: "write_file",
      allowTurn: false,
      files: [{ name: "a.md", before: "x", after: "y", clipped: false }],
    };
    const promise = editCallApproved(deps, { runScoped: false, editApprovedThisTurn: false }, preview);
    const [id] = [...deps.editPending.keys()];
    expect(deps.emitted[0]).toEqual(["edit-approve-request", { id, tool: "write_file", allowTurn: false, files: preview.files }]);
    resolveEditApproval(deps.editPending, id!, "once");
    expect(await promise).toBe("approved");
  });

  it("resolves no_answer on timeout and removes the pending entry", async () => {
    const deps = depsFor(toggleableRoomSource(freshRoom()), { timeoutMs: 5 });
    const preview: EditPreview = { tool: "edit_file", allowTurn: false, files: [] };
    const verdict = await editCallApproved(deps, { runScoped: false, editApprovedThisTurn: false }, preview);
    expect(verdict).toBe("no_answer");
    expect(deps.editPending.size).toBe(0);
  });

  it("EDIT_APPROVAL_TIMEOUT_MS is 180 seconds", () => {
    expect(EDIT_APPROVAL_TIMEOUT_MS).toBe(180_000);
  });
});

// ------------------------------------------------------------------------ finish

describe("finish", () => {
  it("sets effects.wrote and emits room-files-changed once, file-updated per plan", () => {
    const emitted: Array<[string, unknown]> = [];
    const effects = { wrote: false };
    finish({ emit: (e, p) => emitted.push([e, p]) }, effects, [
      { ...planWithCount(1), fileId: "f1" },
      { ...planWithCount(1), fileId: "f2" },
    ]);
    expect(effects.wrote).toBe(true);
    expect(emitted).toEqual([
      ["room-files-changed", undefined],
      ["file-updated", "f1"],
      ["file-updated", "f2"],
    ]);
  });

  it("swallows an emit that throws, matching Rust's `let _ = window.emit(...)`", () => {
    const effects = { wrote: false };
    expect(() => finish({ emit: () => { throw new Error("boom"); } }, effects, [])).not.toThrow();
    expect(effects.wrote).toBe(true);
  });
});

// ------------------------------------------------------------------ registerEditGateIpc

describe("registerEditGateIpc", () => {
  it("registers exactly the resolve_edit_approval channel and reaches real logic", async () => {
    const handle = vi.fn();
    const editPending = new Map<string, (decision: EditDecision) => void>();
    let got: EditDecision | undefined;
    editPending.set("card-1", (d) => (got = d));

    registerEditGateIpc({ handle } as unknown as { handle: typeof handle }, editPending);

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0]).toBe("resolve_edit_approval");
    const listener = handle.mock.calls[0]![1] as (...args: unknown[]) => unknown;
    await listener({}, { id: "card-1", decision: "turn" });
    expect(got).toEqual({ approved: true, restOfTurn: true });
  });

  it("reports NO_LONGER_WAITING the same way every other channel reports its own gone-stale card", () => {
    const handle = vi.fn();
    registerEditGateIpc({ handle } as unknown as { handle: typeof handle }, new Map());
    const listener = handle.mock.calls[0]![1] as (...args: unknown[]) => unknown;
    expect(() => listener({}, { id: "missing", decision: "once" })).toThrowError(NO_LONGER_WAITING);
  });
});
