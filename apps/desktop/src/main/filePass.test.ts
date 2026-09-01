/**
 * Vitest port of `src-tauri/src/commands/jobs/file_pass.rs`'s `#[cfg(test)]
 * mod tests` — the pure-plan tests plus the whole "MIGRATION BASELINE" block
 * (its own header: "Everything below pins behaviour the pure-plan tests
 * above never touch: the `Step.kind` dispatch, the publish side effect, the
 * coverage arithmetic, and the resume contract. These must pass IDENTICALLY
 * before and after the move."):
 *
 *   - stitch_plan_is_a_chain_plus_publish
 *   - merge_plan_is_maps_then_ordered_sections_then_publish
 *   - merge_plan_sections_cover_every_window_once
 *   - plan_without_digest_still_deserializes
 *   - a_re_driven_node_carries_on_with_its_own_parked_child
 *   - a_child_whose_plan_will_not_parse_is_never_resumed_over
 *   - step_kind_is_a_live_dispatch_discriminant_not_a_constant
 *   - an_unknown_step_kind_is_a_hard_error
 *   - publish_replays_onto_the_same_file_instead_of_duplicating_it
 *   - stitch_publish_body_is_byte_exact
 *   - merge_publish_coverage_counts_map_rows_and_over_claims_empty_windows
 *   - merge_publish_full_coverage_line_and_missing_section_placeholder
 *   - a_wholly_collapsed_merge_pass_still_publishes_a_placeholder_document
 *   - publish_only_errors_when_the_step_carries_no_sections_at_all
 *   - compose_stores_a_skipped_section_without_calling_the_model
 *   - a_cancelled_map_step_stops_before_the_model_and_leaves_no_artifact
 *   - map_guards_reject_a_stale_plan_before_any_model_call
 *   - every_room_touching_step_parks_when_the_room_swapped
 *   - pass_artifact_wire_format_is_the_migration_contract
 *   - only_engine_death_parks_the_pass
 *   - resume_rederives_the_steps_and_the_lane_follows_the_current_engine
 *   - the_section_constant_is_an_unstored_part_of_the_plan
 *   - progress_labels_cover_the_stitch_publish_arm
 *   - progress_labels_name_the_exact_window
 *
 * NOT PORTED: `file_pass_end_to_end_with_real_model` is `#[ignore]`d in Rust
 * itself ("needs a running Ollama with a local model") and is not part of
 * the suite that runs normally; it needs a live sidecar/Ollama this test
 * file does not stand up.
 *
 * REAL fixture rooms via `createRoom`, matching this directory's convention
 * (see `organizeTools.test.ts`'s own header) — `mock_room`'s Rust
 * `tauri::test::mock_builder()` becomes {@link TestRoomSource}, a tiny
 * `RoomSource` double that can be pointed at a DIFFERENT path than the room
 * it holds, which is exactly what "the room swapped mid-run" needs.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag } from "./cancel.js";
import { createRoom } from "./db-host/open.js";
import { checkpointJob, createChildJob, createJob, setJobStatus } from "./db-host/jobs.js";
import { getFileExtractedText, insertFile, listFiles, type FileMeta } from "./db-host/files.js";
import { listFileVersions } from "./db-host/fileVersionsList.js";
import { getJob } from "./db-host/jobs.js";
import { resetBaseUrlOverrideForTests, resolvedBaseUrl, setBaseUrlOverride } from "./engineRouting.js";
import { sliceUtf8, smartFilter } from "./extractionWindow.js";
import { planDispatch, type RoomSource, type Step, type StepResult } from "./jobs.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import type { SidecarPostOutcome } from "./sidecarJsonCancellable.js";
import {
  buildPassSteps,
  driveFilePass,
  executePassStep,
  isFatal,
  loadArtifact,
  parsePassPlan,
  passProgressLabel,
  PASS_SECTION_WINDOWS,
  PASS_WINDOW_CHARS,
  PASS_WINDOW_OVERLAP,
  resumableChild,
  storeArtifact,
  type DriveFilePassDeps,
  type FilePassStepDeps,
  type PassArtifact,
  type PassPlan,
  type PublishedRef,
} from "./filePass.js";

// ------------------------------------------------------------- fixtures

let tmpDir: string | null = null;
let openDb: Database.Database | null = null;

afterEach(() => {
  openDb?.close();
  openDb = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

/** The Rust suite's `mock_room`: a `RoomSource` holding ONE real room at a
 * given path, swappable at will so "the room swapped mid-run" can point
 * `roomPath` at a path the source does NOT currently hold. */
class TestRoomSource implements RoomSource {
  private room: { db: Database.Database; path: string; workspace?: WorkspaceService } | null = null;

  open(db: Database.Database, roomPath: string, workspace?: WorkspaceService): void {
    this.room = { db, path: roomPath, workspace };
  }

  current(): { db: Database.Database; path: string; workspace?: WorkspaceService } | null {
    return this.room;
  }
}

function freshRoom(roomPath: string): { rooms: TestRoomSource; db: Database.Database } {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "file-pass-b-"));
  const roomFile = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  const db = createRoom(roomFile, "correct horse battery staple", "Test Room");
  openDb = db;
  const rooms = new TestRoomSource();
  rooms.open(db, roomPath);
  return { rooms, db };
}

function planFor(mode: string, windows: Array<[number, number]>, textLen: number): PassPlan {
  return {
    fileId: "file-1",
    fileName: "book.txt",
    instruction: "summarize",
    mode,
    textLen,
    windows,
  };
}

function art(result: string, skipped: boolean): PassArtifact {
  return { result, thread: "", skipped };
}

/** Drive one step against a test room, returning its result and whatever it
 * recorded in the `published` ref — the TS stand-in for the Rust suite's own
 * `run_step` helper. */
async function runStep(
  rooms: RoomSource,
  jobId: string,
  roomPath: string,
  plan: PassPlan,
  filtered: string,
  step: Step,
  cancel: CancelFlag,
  deps: Partial<FilePassStepDeps> = {}
): Promise<{ result: StepResult; meta: FileMeta | null }> {
  const published: PublishedRef = { value: null };
  const fullDeps: FilePassStepDeps = { rooms, ...deps };
  const result = await executePassStep(fullDeps, jobId, roomPath, plan, "test-model", filtered, step, cancel, published);
  return { result, meta: published.value };
}

// ------------------------------------------------------------- pure plan tests

describe("buildPassSteps", () => {
  it("stitch_plan_is_a_chain_plus_publish", () => {
    const steps = buildPassSteps(4, "stitch", "local_llm");
    expect(steps).toHaveLength(5);
    expect(steps[0]?.dependsOn).toEqual([]);
    expect(steps[2]?.dependsOn).toEqual([1]);
    const publish = steps[steps.length - 1] as Step;
    expect(publish.kind).toBe("publish");
    expect(publish.lane).toBe("cpu");
    expect(publish.dependsOn).toEqual([3]);
  });

  it("merge_plan_is_maps_then_ordered_sections_then_publish", () => {
    // 50 windows, sections of PASS_SECTION_WINDOWS(6) -> 9 section composes
    // (the last covers the tail of 2), then one publish.
    const n = 50;
    const steps = buildPassSteps(n, "merge", "local_llm");
    const sections = Math.ceil(n / PASS_SECTION_WINDOWS);
    expect(sections).toBe(9);
    const composes = steps.filter((s) => s.kind === "compose");
    expect(composes).toHaveLength(sections);
    expect(composes[0]?.dependsOn).toEqual(Array.from({ length: PASS_SECTION_WINDOWS }, (_, i) => i));
    expect((composes[0]?.params as Record<string, unknown>).section).toBe(0);
    expect((composes[0]?.params as Record<string, unknown>).total).toBe(sections);
    expect(composes[0]?.lane).toBe("local_llm");
    const lastStart = (sections - 1) * PASS_SECTION_WINDOWS;
    expect(composes[composes.length - 1]?.dependsOn).toEqual(
      Array.from({ length: n - lastStart }, (_, i) => lastStart + i)
    );
    const publish = steps[steps.length - 1] as Step;
    expect(publish.kind).toBe("publish");
    expect(publish.lane).toBe("cpu");
    expect(publish.dependsOn).toEqual(composes.map((s) => s.id));
    expect(steps.every((s) => s.kind !== "merge")).toBe(true);
    for (const s of steps) {
      for (const d of s.dependsOn) {
        expect(d, `step ${s.id} depends on later step ${d}`).toBeLessThan(s.id);
      }
    }
    steps.forEach((s, i) => expect(s.id).toBe(i));
  });

  it("merge_plan_sections_cover_every_window_once", () => {
    let steps = buildPassSteps(1, "merge", "cloud");
    expect(steps.map((s) => s.kind)).toEqual(["map", "compose", "publish"]);
    expect(steps[1]?.dependsOn).toEqual([0]);
    expect((steps[1]?.params as Record<string, unknown>).total).toBe(1);

    steps = buildPassSteps(7, "merge", "cloud");
    const composes = steps.filter((s) => s.kind === "compose");
    expect(composes).toHaveLength(2);
    expect(composes[0]?.dependsOn).toEqual([0, 1, 2, 3, 4, 5]);
    expect(composes[1]?.dependsOn).toEqual([6]);
    const covered = composes.flatMap((s) => s.dependsOn);
    expect(covered).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("NO GLOBAL FOLD — at any size, no step is ever handed more than one section's windows", () => {
    // The load-bearing constraint of this whole module, and the one the Rust
    // source's own header records as a real prior failure: the reduce used to
    // be map -> merge tree -> ONE compose over the whole file, and a small
    // local model collapsed the big folds (an 850 KB book's merge came back
    // empty), losing most chapters.
    //
    // A structural tripwire, not a spot check: for every window count, EVERY
    // model-lane step sees at most PASS_SECTION_WINDOWS windows, the sections
    // partition 0..n exactly once in order, and the only step that touches all
    // of them is the CPU-lane publish, which makes no model call at all.
    for (const n of [1, 2, 5, 6, 7, 11, 12, 13, 27, 50, 200, 625]) {
      const steps = buildPassSteps(n, "merge", "local_llm");
      const modelSteps = steps.filter((s) => s.lane !== "cpu");
      expect(modelSteps.every((s) => s.kind === "map" || s.kind === "compose")).toBe(true);
      const composes = steps.filter((s) => s.kind === "compose");
      const covered: number[] = [];
      for (const c of composes) {
        const windows = (c.params as { windows: number[] }).windows;
        expect(windows.length, `n=${n}: a compose was handed ${windows.length} windows`).toBeLessThanOrEqual(
          PASS_SECTION_WINDOWS
        );
        expect(c.dependsOn).toEqual(windows);
        covered.push(...windows);
      }
      expect(covered, `n=${n}: sections must partition every window exactly once, in order`).toEqual(
        Array.from({ length: n }, (_, i) => i)
      );
      // Exactly one step depends on everything above the maps — and it is CPU.
      const publish = steps[steps.length - 1] as Step;
      expect(publish.kind).toBe("publish");
      expect(publish.lane).toBe("cpu");
      expect(steps.filter((s) => s.dependsOn.length > PASS_SECTION_WINDOWS)).toEqual(
        composes.length > PASS_SECTION_WINDOWS ? [publish] : []
      );
    }
    // Stitch has no reduce step of ANY kind — the deliverable is the ordered
    // concatenation of the map outputs.
    for (const n of [1, 7, 50]) {
      const steps = buildPassSteps(n, "stitch", "local_llm");
      expect(steps.filter((s) => s.lane !== "cpu").every((s) => s.kind === "map")).toBe(true);
    }
  });
});

describe("parsePassPlan", () => {
  it("plan_without_digest_still_deserializes", () => {
    // Plans persisted before `textSha256` existed must keep loading — a
    // paused pass from an older build resumes on the length check alone.
    const v = {
      fileId: "f",
      fileName: "book.txt",
      instruction: "summarize",
      mode: "merge",
      textLen: 10,
      windows: [[0, 10]],
    };
    const plan = parsePassPlan(v);
    expect(plan.textSha256).toBeUndefined();
  });

  it("rejects malformed containers and window shapes before a resume can use them", () => {
    const valid = {
      fileId: "f", fileName: "book.txt", instruction: "summarize", mode: "merge", textLen: 10,
      windows: [[0, 10]],
    };
    expect(() => parsePassPlan(null)).toThrow("invalid PassPlan: not an object");
    expect(() => parsePassPlan({ ...valid, windows: "not windows" })).toThrow('"windows" is not an array');
    expect(() => parsePassPlan({ ...valid, windows: [[0, "end"]] })).toThrow("a window is not a [number, number] pair");
  });
});

describe("the_section_constant_is_an_unstored_part_of_the_plan", () => {
  it("pins PASS_SECTION_WINDOWS/PASS_WINDOW_CHARS/PASS_WINDOW_OVERLAP and the step counts they imply", () => {
    // TRIPWIRE. `windows` and `mode` are persisted; PASS_SECTION_WINDOWS is
    // NOT — yet it decides how many compose steps exist and therefore every
    // step id above the maps. Bumping this constant requires a plan version
    // + migration, not just an edit.
    expect(PASS_SECTION_WINDOWS).toBe(6);
    for (const n of [1, 5, 6, 7, 12, 13, 50]) {
      const steps = buildPassSteps(n, "merge", "local_llm");
      expect(steps).toHaveLength(n + Math.ceil(n / PASS_SECTION_WINDOWS) + 1);
    }
    for (const n of [1, 4, 50]) {
      expect(buildPassSteps(n, "stitch", "local_llm")).toHaveLength(n + 1);
    }
    expect(PASS_WINDOW_CHARS).toBe(32_000);
    expect(PASS_WINDOW_OVERLAP).toBe(400);
  });
});

// ------------------------------------------------------------- resumable_child

describe("resumableChild", () => {
  it("a_re_driven_node_carries_on_with_its_own_parked_child", () => {
    const { db } = freshRoom("/tmp/unused.roomai");
    const parent = createJob(db, "workflow", "Morning digest", {}, 2);
    const plan = planFor("merge", [[0, 32_000], [31_600, 60_000]], 60_000);
    const planJson = JSON.parse(JSON.stringify(plan)) as unknown;
    const child = createChildJob(db, "file_pass", "Full pass — book.txt", planJson, 5, parent);
    checkpointJob(db, child, 20, {});
    setJobStatus(db, child, "paused", null);

    expect(resumableChild(db, parent, planJson)).toEqual({ id: child, cursor: 20 });

    // A different file (or instruction, or mode) is different work: its
    // artifacts do not align with these step ids.
    const elsewhere = JSON.parse(
      JSON.stringify({ ...planFor("merge", [[0, 32_000], [31_600, 60_000]], 60_000), fileId: "file-2" })
    ) as unknown;
    expect(resumableChild(db, parent, elsewhere)).toBeNull();

    // Another workflow's child is not ours, however identical the plan.
    const stranger = createJob(db, "workflow", "Weekly digest", {}, 2);
    expect(resumableChild(db, stranger, planJson)).toBeNull();

    // A finished child is this node's completed work: re-driving it would
    // seed every step as done and publish nothing.
    setJobStatus(db, child, "done", null);
    expect(resumableChild(db, parent, planJson)).toBeNull();
  });

  it("a_child_whose_plan_will_not_parse_is_never_resumed_over", () => {
    const { db } = freshRoom("/tmp/unused.roomai");
    const parent = createJob(db, "workflow", "Digest", {}, 1);
    const plan = JSON.parse(JSON.stringify(planFor("stitch", [[0, 10]], 10))) as unknown;
    const child = createChildJob(db, "file_pass", "Full pass — book.txt", plan, 2, parent);
    db.prepare("UPDATE jobs SET plan = 'not json' WHERE id = ?").run(child);
    expect(resumableChild(db, parent, plan)).toBeNull();
  });
});

// ------------------------------------------------------------- step dispatch

describe("executePassStep dispatch", () => {
  it("step_kind_is_a_live_dispatch_discriminant_not_a_constant", () => {
    // file_pass is the ONLY job kind whose steps carry three different `kind`
    // values; a migration that models `kind` as a per-job constant silently
    // breaks this kind, so pin the exact strings and their positions.
    const merge = buildPassSteps(13, "merge", "local_llm");
    const kinds = merge.map((s) => s.kind);
    expect(kinds.slice(0, 13)).toEqual(Array(13).fill("map"));
    expect(kinds.slice(13)).toEqual(["compose", "compose", "compose", "publish"]);
    const stitch = buildPassSteps(3, "stitch", "local_llm");
    expect(stitch.map((s) => s.kind)).toEqual(["map", "map", "map", "publish"]);
    expect(stitch.every((s) => s.kind !== "compose")).toBe(true);
  });

  it("an_unknown_step_kind_is_a_hard_error", async () => {
    const { rooms } = freshRoom("/tmp/r1.roomai");
    const plan = planFor("merge", [[0, 4]], 4);
    const step: Step = { id: 0, lane: "cpu", kind: "workflow_node", params: null, dependsOn: [] };
    const { result } = await runStep(rooms, "job", "/tmp/r1.roomai", plan, "text", step, new CancelFlag());
    expect(result).toEqual({ ok: false, error: "unknown pass step kind: workflow_node" });
  });

  it("treats a non-object map params payload as the same absent-window fallback Rust uses", async () => {
    const room = "/tmp/params.roomai";
    const { rooms } = freshRoom(room);
    const plan = planFor("merge", [[0, 4]], 4);
    const step: Step = { id: 0, lane: "local_llm", kind: "map", params: null, dependsOn: [] };
    const seen: Array<Record<string, unknown>> = [];
    const { result } = await runStep(rooms, "job", room, plan, "text", step, new CancelFlag(), {
      post: async (_endpoint, body) => {
        seen.push(body as Record<string, unknown>);
        return { kind: "value", value: { result: "notes", thread: "", skipped: false } };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(seen[0]?.part).toBe(0);
  });
});

// ------------------------------------------------------------- publish

describe("executePassStep: publish", () => {
  it("publish_replays_onto_the_same_file_instead_of_duplicating_it", async () => {
    // `insertFile` mints a fresh uuid, so publish used to leave a SECOND
    // identical "Full pass — …" file whenever it re-ran. It now records the
    // file it wrote in its own artifact and overwrites that file on a
    // replay, which is versioned, so the previous deliverable is still
    // recoverable through Time Machine.
    const room = "/tmp/r2.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 4]], 4);
    const steps = buildPassSteps(1, "merge", "local_llm");
    const job = createJob(db, "file_pass", "Full pass — book.txt", JSON.parse(JSON.stringify(plan)), steps.length);
    storeArtifact(db, job, 0, art("notes", false));
    storeArtifact(db, job, 1, art("<h2>Section</h2>", false));
    const cancel = new CancelFlag();
    const publish = steps[steps.length - 1] as Step;

    const r1 = await runStep(rooms, job, room, plan, "text", publish, cancel, {
      emit: () => { throw new Error("closed window"); },
    });
    expect(r1.result.ok).toBe(true);
    const r2 = await runStep(rooms, job, room, plan, "text", publish, cancel);
    expect(r2.result.ok).toBe(true);

    const m1 = r1.meta as FileMeta;
    const m2 = r2.meta as FileMeta;
    expect(m1, "publish records the file it wrote").not.toBeNull();
    expect(m2, "the replay records the SAME file").not.toBeNull();
    expect(m1.name).toBe("Full pass — book.txt.html");
    expect(m2.id, "a replay must not mint a second deliverable").toBe(m1.id);
    const sameName = listFiles(db).filter((f) => f.name === m1.name);
    expect(sameName, "two runs of publish leave ONE file in the room").toHaveLength(1);
    // The overwrite is snapshotted, so the first deliverable is recoverable.
    expect(listFileVersions(db, m1.id), "the replay's overwrite is undoable").toHaveLength(1);
    // The publish step's own artifact carries the file id that makes it so.
    const recorded = loadArtifact(db, job, publish.id)?.fileId;
    expect(recorded).toBe(m1.id);
  });

  it("starts a fresh deliverable when a replay artifact points at a deleted file", async () => {
    const room = "/tmp/stale-publish.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 4]], 4);
    const steps = buildPassSteps(1, "merge", "local_llm");
    const publish = steps.at(-1)!;
    const job = createJob(db, "file_pass", "Full pass", JSON.parse(JSON.stringify(plan)), steps.length);
    storeArtifact(db, job, 0, art("notes", false));
    storeArtifact(db, job, 1, art("<h2>Section</h2>", false));
    storeArtifact(db, job, publish.id, { result: "old", thread: "", skipped: false, fileId: "deleted-file" });

    const { result, meta } = await runStep(rooms, job, room, plan, "text", publish, new CancelFlag());
    expect(result).toEqual({ ok: true });
    expect(meta?.id).not.toBe("deleted-file");
    expect(loadArtifact(db, job, publish.id)?.fileId).toBe(meta?.id);
  });

  it("publishes and replays a workspace pass as one normal versioned file", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "file-pass-workspace-"));
    const roomPath = path.join(tmpDir, "Room");
    const created = createWorkspaceRoom(roomPath, "correct horse battery staple", "Room");
    openDb = created.db;
    const workspace = new WorkspaceService(created.db, roomPath);
    const source = await workspace.createFile("book.txt", Readable.from(["source"]), "upload");
    const rooms = new TestRoomSource();
    rooms.open(created.db, roomPath, workspace);
    const plan = { ...planFor("merge", [[0, 4]], 4), fileId: source.fileId };
    const steps = buildPassSteps(1, "merge", "local_llm");
    const job = createJob(created.db, "file_pass", "Full pass", plan, steps.length);
    storeArtifact(created.db, job, 0, art("notes", false));
    storeArtifact(created.db, job, 1, art("<h2>Section</h2>", false));
    const publish = steps.at(-1)!;

    const first = await runStep(rooms, job, roomPath, plan, "text", publish, new CancelFlag());
    const second = await runStep(rooms, job, roomPath, plan, "text", publish, new CancelFlag());
    expect(first.result.ok).toBe(true);
    expect(second.result.ok).toBe(true);
    expect(second.meta?.id).toBe(first.meta?.id);
    const row = created.db.prepare(
      "SELECT relative_path, original_bytes, storage_kind FROM files WHERE id = ?",
    ).get(first.meta!.id) as { relative_path: string; original_bytes: Buffer | null; storage_kind: string };
    expect(row.storage_kind).toBe("workspace");
    expect(row.original_bytes).toBeNull();
    expect(readFileSync(path.join(roomPath, row.relative_path), "utf8")).toContain("<h2>Section</h2>");
    expect(created.db.prepare("SELECT count(*) AS n FROM file_versions WHERE file_id = ?")
      .get(first.meta!.id)).toEqual({ n: 1 });
  });

  it("stitch_publish_body_is_byte_exact", async () => {
    // The stitch deliverable is pure string assembly — no model — so it is
    // fully pinnable: markdown, the missing-part placeholder (1-BASED), the
    // "---" rule and the italicised coverage line, and the .md name/mime.
    const room = "/tmp/r3.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("stitch", [[0, 10], [9, 20], [19, 30]], 30);
    const steps = buildPassSteps(3, "stitch", "local_llm");
    const job = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), steps.length);
    storeArtifact(db, job, 0, art("  part one  ", false));
    storeArtifact(db, job, 1, art("", true)); // the model gave up here
    storeArtifact(db, job, 2, art("part three", false));
    const { result, meta } = await runStep(rooms, job, room, plan, "text", steps[steps.length - 1] as Step, new CancelFlag());
    expect(result.ok).toBe(true);
    const m = meta as FileMeta;
    expect(m.name).toBe("Full pass — book.txt.md");
    expect(m.mimeType).toBe("text/markdown");
    expect(m.source).toBe("generated");
    const body = getFileExtractedText(db, m.id);
    expect(body).toBe(
      "part one\n\n[part 2 could not be processed]\n\npart three\n\n---\n\n" +
        "_Read 2 of 3 parts of “book.txt” (30 characters); 1 part(s) could not be " +
        "processed and are marked in place._\n"
    );
  });

  it("merge_publish_coverage_counts_map_rows_and_over_claims_empty_windows", async () => {
    // Coverage is computed from the MAP artifacts (0..n), never from the
    // sections. Two rules that differ and must both survive the migration:
    //   * a MISSING map row counts as skipped;
    //   * an artifact with skipped=false but an EMPTY result counts as
    //     COVERED here, while `compose` counts that same row as `missing`.
    const room = "/tmp/r4.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 10], [9, 20], [19, 30]], 30);
    const steps = buildPassSteps(3, "merge", "local_llm"); // 3 maps, 1 compose, publish
    const job = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), steps.length);
    storeArtifact(db, job, 0, art("real notes", false));
    storeArtifact(db, job, 1, art("", false)); // empty, NOT flagged
    // window 2 has NO row at all
    storeArtifact(db, job, 3, art("<h2>S</h2>", false));
    const { result, meta } = await runStep(rooms, job, room, plan, "text", steps[steps.length - 1] as Step, new CancelFlag());
    expect(result.ok).toBe(true);
    const doc = getFileExtractedText(db, (meta as FileMeta).id) as string;
    // 1 skipped (the missing row) — the empty-but-unflagged window 1 is
    // counted as READ even though compose treated it as missing.
    expect(doc, `coverage line changed: ${doc}`).toContain(
      "Read 2 of 3 parts of “book.txt” (30 characters); 1 part(s) could not be processed and are marked in place."
    );
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<hr/>");
  });

  it("merge_publish_full_coverage_line_and_missing_section_placeholder", async () => {
    const room = "/tmp/r5.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 10], [9, 20]], 20);
    // Force TWO sections by hand (the real grouping needs >6 windows).
    const publish: Step = { id: 4, lane: "cpu", kind: "publish", params: { sections: [2, 3] }, dependsOn: [2, 3] };
    const job = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), 5);
    storeArtifact(db, job, 0, art("a", false));
    storeArtifact(db, job, 1, art("b", false));
    storeArtifact(db, job, 2, art("<h2>One</h2>", false));
    storeArtifact(db, job, 3, art("", true)); // section 2 collapsed
    const { result, meta } = await runStep(rooms, job, room, plan, "text", publish, new CancelFlag());
    expect(result.ok).toBe(true);
    const doc = getFileExtractedText(db, (meta as FileMeta).id) as string;
    // Every map row is present and unflagged -> the "complete coverage" line.
    expect(doc, `coverage line changed: ${doc}`).toContain(
      "Read all 2 parts of “book.txt” — 20 characters, complete coverage."
    );
    // A collapsed section is marked IN PLACE, keeping the document ordered.
    expect(doc).toContain("<h2>One</h2>");
    expect(doc).toContain("<p><em>[a section could not be composed]</em></p>");
  });

  it("a_wholly_collapsed_merge_pass_still_publishes_a_placeholder_document", async () => {
    // The "no readable sections" guard is all but DEAD: an unusable section
    // pushes a placeholder into html_body, so a pass whose every section
    // collapsed still writes a file containing nothing but placeholders and
    // a coverage line.
    const room = "/tmp/r6.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 10]], 10);
    const steps = buildPassSteps(1, "merge", "local_llm");
    const job = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), steps.length);
    storeArtifact(db, job, 0, art("notes", false));
    storeArtifact(db, job, 1, art("   ", false)); // whitespace only
    const { result, meta } = await runStep(rooms, job, room, plan, "text", steps[steps.length - 1] as Step, new CancelFlag());
    expect(result.ok, `a collapsed section publishes anyway: ${JSON.stringify(result)}`).toBe(true);
    const doc = getFileExtractedText(db, (meta as FileMeta).id) as string;
    expect(doc).toContain("<p><em>[a section could not be composed]</em></p>");
    // …and the coverage line still calls it COMPLETE, because coverage reads
    // the MAP rows and map 0 succeeded.
    expect(doc).toContain("Read all 1 parts of “book.txt” — 10 characters, complete coverage.");
  });

  it("publish_only_errors_when_the_step_carries_no_sections_at_all", async () => {
    // The reachable half of that guard: a publish step whose `sections`
    // param is missing/misshapen. Nothing is written, so THIS error is
    // safely replayable — unlike a successful publish.
    const room = "/tmp/r6b.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 10]], 10);
    const job = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), 3);
    const publish: Step = { id: 2, lane: "cpu", kind: "publish", params: { inputs: [0] }, dependsOn: [1] };
    const before = listFiles(db).length;
    const { result, meta } = await runStep(rooms, job, room, plan, "text", publish, new CancelFlag());
    expect(result).toEqual({ ok: false, error: "the pass produced no readable sections to publish" });
    expect(meta).toBeNull();
    expect(listFiles(db)).toHaveLength(before);
  });

  it("a stitch publish whose `inputs` param is MISSHAPEN still stitches every window in order", async () => {
    // Rust reads it as `step.params["inputs"].as_array().map(..)
    // .unwrap_or_else(|| (0..n).collect())`. `as_array()` returns `None` for a
    // missing key AND for a present-but-not-an-array one, so BOTH fall back to
    // every window in order.
    //
    // Reading only "missing" as the fallback (`"inputs" in params ? ... : ...`)
    // makes a misshapen param mean "stitch NOTHING": the pass reports success,
    // publishes a file, and that file is the coverage line alone — every word
    // the model produced silently dropped, with a "complete coverage"
    // sentence under it. That is the worst failure this module has, so it is
    // pinned here.
    const room = "/tmp/r6c.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("stitch", [[0, 10], [9, 20]], 20);
    for (const misshapen of [2, "0,1", { from: 0 }, null]) {
      const publish: Step = { id: 2, lane: "cpu", kind: "publish", params: { inputs: misshapen }, dependsOn: [1] };
      // A fresh job per case, so the idempotent-replay branch never masks it.
      const caseJob = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), 3);
      storeArtifact(db, caseJob, 0, art("one", false));
      storeArtifact(db, caseJob, 1, art("two", false));
      const { result, meta } = await runStep(rooms, caseJob, room, plan, "text", publish, new CancelFlag());
      expect(result.ok, `inputs=${JSON.stringify(misshapen)}: ${JSON.stringify(result)}`).toBe(true);
      expect(getFileExtractedText(db, (meta as FileMeta).id)).toBe(
        "one\n\ntwo\n\n---\n\n_Read all 2 parts of “book.txt” — 20 characters, complete coverage._\n"
      );
    }
  });
});

// ------------------------------------------------------------- compose

describe("executePassStep: compose", () => {
  it("compose_stores_a_skipped_section_without_calling_the_model", async () => {
    // The early return at the top of the compose arm: when NO window in the
    // group yields usable notes, compose writes a skipped artifact and never
    // touches the sidecar. The "usable" test is STRICTER than publish's skip
    // count.
    const room = "/tmp/r7.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 10], [9, 20]], 20);
    const steps = buildPassSteps(2, "merge", "local_llm");
    const job = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), steps.length);
    storeArtifact(db, job, 0, art("", false)); // empty, unflagged
    storeArtifact(db, job, 1, art("x", true)); // flagged skipped
    const compose = steps[2] as Step;
    expect(compose.kind).toBe("compose");
    const { result } = await runStep(rooms, job, room, plan, "text", compose, new CancelFlag(), {
      post: () => {
        throw new Error("must not call the sidecar");
      },
    });
    expect(result.ok, `compose must degrade, not fail: ${JSON.stringify(result)}`).toBe(true);
    const stored = loadArtifact(db, job, compose.id) as PassArtifact;
    expect(stored.skipped).toBe(true);
    expect(stored.result).toBe("");
    expect(stored.thread).toBe("");
  });
});

// ------------------------------------------------------------- map / cancel / guards

describe("executePassStep: map", () => {
  it("a_cancelled_map_step_stops_before_the_model_and_leaves_no_artifact", async () => {
    // Stop is checked INSIDE the cancellable POST before the request, so a
    // cancelled map returns the STOPPED sentinel and writes nothing.
    const room = "/tmp/r8.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 4], [3, 8]], 8);
    const steps = buildPassSteps(2, "merge", "local_llm");
    const job = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), steps.length);
    storeArtifact(db, job, 0, art("prior notes", false));
    const cancel = new CancelFlag();
    cancel.store(true);
    // No `post` override here, deliberately: this relies on the REAL
    // `sidecarJsonCancellable`'s own top-of-function cancel check (checked
    // BEFORE it ever calls `ensureUp`/`fetch`), exactly mirroring how the
    // Rust test relies on `sidecar_json_cancellable`'s identical guard rather
    // than faking the sidecar client away.
    const { result } = await runStep(rooms, job, room, plan, "abcdefgh", steps[1] as Step, cancel);
    expect(result).toEqual({ ok: false, error: "STOPPED" });
    expect(loadArtifact(db, job, 1)).toBeNull();
  });

  it("map_guards_reject_a_stale_plan_before_any_model_call", async () => {
    const room = "/tmp/r9.roomai";
    const { rooms } = freshRoom(room);
    const plan = planFor("merge", [[0, 4]], 4);
    const cancel = new CancelFlag();
    const failIfCalled: FilePassStepDeps["post"] = () => {
      throw new Error("must not call the sidecar");
    };
    // A window id the plan doesn't have (a re-derived plan that shrank).
    const badId: Step = { id: 0, lane: "local_llm", kind: "map", params: { window: 7 }, dependsOn: [] };
    let { result } = await runStep(rooms, "j", room, plan, "abcd", badId, cancel, { post: failIfCalled });
    expect(result).toEqual({ ok: false, error: "window 7 is not in the plan" });

    // A span the CURRENT text can't satisfy — the second line of defence
    // behind the resume-time text_len/text_sha256 check.
    const okId: Step = { id: 0, lane: "local_llm", kind: "map", params: { window: 0 }, dependsOn: [] };
    ({ result } = await runStep(rooms, "j", room, plan, "ab", okId, cancel, { post: failIfCalled }));
    expect(result).toEqual({
      ok: false,
      error: "the file's text no longer matches this pass — start a new pass",
    });
  });

  it("every_room_touching_step_parks_when_the_room_swapped", async () => {
    // roomPath pins each step to the room the pass started in.
    const { rooms } = freshRoom("/tmp/open.roomai");
    const gone = "/tmp/closed.roomai";
    const plan = planFor("merge", [[0, 4], [3, 8]], 8);
    const steps = buildPassSteps(2, "merge", "local_llm");
    const cancel = new CancelFlag();
    const expected = { ok: false, error: "The room this job belongs to is no longer open." };
    const failIfCalled: FilePassStepDeps["post"] = () => {
      throw new Error("must not call the sidecar");
    };
    // map 1 reads the previous window's thread from the room first.
    expect((await runStep(rooms, "j", gone, plan, "abcdefgh", steps[1] as Step, cancel, { post: failIfCalled })).result).toEqual(expected);
    // compose gathers its group's notes from the room.
    expect((await runStep(rooms, "j", gone, plan, "abcdefgh", steps[2] as Step, cancel, { post: failIfCalled })).result).toEqual(expected);
    // publish writes into the room.
    expect((await runStep(rooms, "j", gone, plan, "abcdefgh", steps[3] as Step, cancel, { post: failIfCalled })).result).toEqual(expected);
  });

  it("sends the window slice, the prior thread and a warm keep_alive, then stores what came back", async () => {
    // The `/file_pass_map` request body IS a cross-language contract (the
    // sidecar's own handler reads every one of these keys), so pin it. The
    // window text is sliced out of the plan's BYTE span, and `base_url` comes
    // from `engineRouting.resolvedBaseUrl()` — not a hard-coded 127.0.0.1,
    // which would send every window of a pass in a LAN-Ollama room to the
    // wrong engine.
    const room = "/tmp/rmap.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 4], [3, 8]], 8);
    const steps = buildPassSteps(2, "merge", "local_llm");
    const job = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), steps.length);
    storeArtifact(db, job, 0, { result: "notes for 0", thread: "carried", skipped: false });
    const bodies: Array<Record<string, unknown>> = [];
    // C1's "closet supercomputer" override ON, so a hard-coded local default
    // in the port is visible here rather than accidentally right.
    setBaseUrlOverride("http://closet.local:11434");
    let result: StepResult;
    try {
      expect(resolvedBaseUrl()).toBe("http://closet.local:11434");
      ({ result } = await runStep(rooms, job, room, plan, "abcdefgh", steps[1] as Step, new CancelFlag(), {
        post: async (endpoint, body) => {
          expect(endpoint).toBe("/file_pass_map");
          bodies.push(body as Record<string, unknown>);
          return { kind: "value", value: { result: "notes for 1", thread: "carried>1", skipped: false } };
        },
      }));
    } finally {
      resetBaseUrlOverrideForTests();
    }
    expect(result.ok).toBe(true);
    const body = bodies[0] as Record<string, unknown>;
    expect(body.window_text, "the window is sliced from its own byte span").toBe("defgh");
    expect(body.thread, "the previous window's thread keeps the read continuous").toBe("carried");
    expect(body.part).toBe(1);
    expect(body.total).toBe(2);
    expect(body.start).toBe(3);
    expect(body.end).toBe(8);
    expect(body.text_len).toBe(8);
    expect(body.mode).toBe("merge");
    expect(body.file_name).toBe("book.txt");
    expect(body.instruction).toBe("summarize");
    expect(body.model).toBe("test-model");
    expect(body.keep_alive, "KEEP_ALIVE_WARM").toBe("30m");
    expect(body.base_url, "engineRouting.resolvedBaseUrl(), never a hard-coded local default").toBe(
      "http://closet.local:11434"
    );
    expect(loadArtifact(db, job, 1)).toEqual({ result: "notes for 1", thread: "carried>1", skipped: false });
  });

  it("a malformed sidecar reply becomes an EMPTY, UNFLAGGED artifact — which publish then over-claims", async () => {
    // Rust's `serde_json::from_value(v).unwrap_or_default()`: a reply whose
    // `skipped` is the STRING "yes" fails to deserialize, and the default is
    // `{result:"", thread:"", skipped:FALSE}` — so the window is recorded as
    // read. `merge_publish_coverage_counts_map_rows_and_over_claims_empty_
    // windows` pins the consequence; this pins the cause, which is the half a
    // migration is most likely to "fix" into `skipped: true`.
    const room = "/tmp/rmap2.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 8]], 8);
    const steps = buildPassSteps(1, "merge", "local_llm");
    const job = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), steps.length);
    const { result } = await runStep(rooms, job, room, plan, "abcdefgh", steps[0] as Step, new CancelFlag(), {
      post: async () => ({ kind: "value", value: { skipped: "yes" } }),
    });
    expect(result.ok).toBe(true);
    expect(loadArtifact(db, job, 0)).toEqual({ result: "", thread: "", skipped: false });
  });

  it("a fatal engine sentinel parks the step; any other failure degrades the window and keeps the thread", async () => {
    // `is_fatal` is what decides durability: fatal -> the job parks resumable
    // and NO artifact is written (so the window re-runs on Resume); anything
    // else marks this one window skipped, keeps the thread flowing, and the
    // pass carries on with an honest coverage line.
    const room = "/tmp/rmap3.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 4], [3, 8]], 8);
    const steps = buildPassSteps(2, "merge", "local_llm");
    const job = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), steps.length);
    storeArtifact(db, job, 0, { result: "notes", thread: "carried", skipped: false });

    const fatal = await runStep(rooms, job, room, plan, "abcdefgh", steps[1] as Step, new CancelFlag(), {
      post: async () => ({ kind: "error", error: { code: "MODEL_MISSING", error: "not pulled", status: 404 } }),
    });
    expect(fatal.result).toEqual({ ok: false, error: "MODEL_MISSING:test-model" });
    expect(loadArtifact(db, job, 1), "a parked step leaves nothing behind to resume over").toBeNull();

    const transient = await runStep(rooms, job, room, plan, "abcdefgh", steps[1] as Step, new CancelFlag(), {
      post: async () => ({ kind: "error", error: { code: "ENGINE_ERROR", error: "boom", status: 500 } }),
    });
    expect(transient.result.ok).toBe(true);
    expect(loadArtifact(db, job, 1)).toEqual({ result: "", thread: "carried", skipped: true });
  });

  it("reads a step param the way `as_u64()` does — a float or a negative is not an index", async () => {
    // `step.params["window"].as_u64().unwrap_or(0)`: Rust reads a NON-NEGATIVE
    // INTEGER or nothing at all. A port that accepted any `number` turns a
    // drifted param into "window -1 is not in the plan" — a parked job — where
    // Rust quietly reads window 0.
    const room = "/tmp/rmap4.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 8]], 8);
    const job = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), 3);
    for (const bad of [-1, 1.5, "0", null]) {
      const step: Step = { id: 0, lane: "local_llm", kind: "map", params: { window: bad }, dependsOn: [] };
      const seen: Array<Record<string, unknown>> = [];
      const { result } = await runStep(rooms, job, room, plan, "abcdefgh", step, new CancelFlag(), {
        post: async (_endpoint, body) => {
          seen.push(body as Record<string, unknown>);
          return { kind: "value", value: { result: "n", thread: "", skipped: false } };
        },
      });
      expect(result.ok, `window ${JSON.stringify(bad)} should have fallen back to 0`).toBe(true);
      expect(seen[0]?.part).toBe(0);
    }
  });
});

// ------------------------------------------------------------- wire contract

describe("pass_artifact_wire_format_is_the_migration_contract", () => {
  it("emits exactly result/thread/skipped/file_id, snake_case, with the right defaults and tolerances", () => {
    // A Python step writing job_artifacts must emit exactly these keys — see
    // filePass.ts's own module doc for why the wire form stays snake_case.
    const room = "/tmp/wire.roomai";
    const { db } = freshRoom(room);
    const job = createJob(db, "file_pass", "t", {}, 1);
    storeArtifact(db, job, 0, { result: "r", thread: "t", skipped: true });
    const raw = db.prepare("SELECT content FROM job_artifacts WHERE job_id = ? AND step_id = 0").get(job) as {
      content: string;
    };
    expect(JSON.parse(raw.content)).toEqual({ result: "r", thread: "t", skipped: true });
    const a = loadArtifact(db, job, 0) as PassArtifact;
    expect([a.result, a.thread, a.skipped]).toEqual(["r", "t", true]);

    storeArtifact(db, job, 1, art("r", false));
    const raw2 = db.prepare("SELECT content FROM job_artifacts WHERE job_id = ? AND step_id = 1").get(job) as {
      content: string;
    };
    expect(JSON.parse(raw2.content)).toEqual({ result: "r", thread: "", skipped: false });

    // Partial + unknown-field tolerance.
    db.prepare("INSERT OR REPLACE INTO job_artifacts(job_id, step_id, content) VALUES (?, 2, ?)").run(
      job,
      JSON.stringify({ result: "only", extra: "ignored" })
    );
    const p = loadArtifact(db, job, 2) as PassArtifact;
    expect(p.skipped).toBe(false);
    expect(p.thread).toBe("");

    // `file_id` remains the wire-only spelling: a real publish artifact
    // round-trips it, `null` remains an omitted optional field, and a
    // present-but-wrong type is a deserialize failure rather than a guess.
    db.prepare("INSERT OR REPLACE INTO job_artifacts(job_id, step_id, content) VALUES (?, 4, ?)").run(
      job,
      JSON.stringify({ result: "published", file_id: "deliverable-1" })
    );
    expect(loadArtifact(db, job, 4)).toMatchObject({
      result: "published", thread: "", skipped: false, fileId: "deliverable-1",
    });
    db.prepare("INSERT OR REPLACE INTO job_artifacts(job_id, step_id, content) VALUES (?, 5, ?)").run(
      job,
      JSON.stringify({ file_id: null })
    );
    expect(loadArtifact(db, job, 5)).toEqual({ result: "", thread: "", skipped: false });

    // The malformed-reply fallback the map arm actually uses.
    db.prepare("INSERT OR REPLACE INTO job_artifacts(job_id, step_id, content) VALUES (?, 3, ?)").run(
      job,
      JSON.stringify({ skipped: "yes" })
    );
    expect(loadArtifact(db, job, 3)).toBeNull();
    db.prepare("INSERT OR REPLACE INTO job_artifacts(job_id, step_id, content) VALUES (?, 6, ?)").run(
      job,
      JSON.stringify({ file_id: 7 })
    );
    expect(loadArtifact(db, job, 6)).toBeNull();
    db.prepare("INSERT OR REPLACE INTO job_artifacts(job_id, step_id, content) VALUES (?, 7, 'not json')").run(job);
    expect(loadArtifact(db, job, 7)).toBeNull();
    db.prepare("INSERT OR REPLACE INTO job_artifacts(job_id, step_id, content) VALUES (?, 8, ?)").run(job, JSON.stringify("not an object"));
    expect(loadArtifact(db, job, 8)).toBeNull();
  });
});

describe("only_engine_death_parks_the_pass", () => {
  it("is_fatal decides durability", () => {
    expect(isFatal("OLLAMA_DOWN")).toBe(true);
    expect(isFatal("MODEL_MISSING")).toBe(true);
    expect(isFatal("MODEL_MISSING:qwen3:4b")).toBe(true);
    expect(isFatal("STOPPED")).toBe(false);
    expect(isFatal("Local AI error (500): boom")).toBe(false);
    expect(isFatal("ollama_down")).toBe(false); // exact match only
    expect(isFatal("The AI model returned nothing. If this room uses a cloud model…")).toBe(false);
  });
});

describe("resume_rederives_the_steps_and_the_lane_follows_the_current_engine", () => {
  it("only the lane may differ across a resume with a different engine", () => {
    const n = 20;
    const local = buildPassSteps(n, "merge", "local_llm");
    const cloud = buildPassSteps(n, "merge", "cloud");
    expect(local).toHaveLength(cloud.length);
    for (let i = 0; i < local.length; i++) {
      expect(local[i]?.id).toBe(cloud[i]?.id);
      expect(local[i]?.kind).toBe(cloud[i]?.kind);
      expect(local[i]?.params).toEqual(cloud[i]?.params);
      expect(local[i]?.dependsOn).toEqual(cloud[i]?.dependsOn);
    }
    expect(local[0]?.lane).toBe("local_llm");
    expect(cloud[0]?.lane).toBe("cloud");
    expect(local[local.length - 1]?.lane).toBe("cpu");
    expect(cloud[cloud.length - 1]?.lane).toBe("cpu");
    // And that lane change is OBSERVABLE: with every map done, the local
    // lane composes one section at a time while the cloud lane fans out.
    const done = new Set<number>(Array.from({ length: n }, (_, i) => i));
    const empty = new Set<number>();
    expect(planDispatch(local, done, empty)).toHaveLength(1);
    expect(planDispatch(cloud, done, empty)).toHaveLength(4);
  });
});

describe("passProgressLabel", () => {
  it("progress_labels_cover_the_stitch_publish_arm", () => {
    const plan = planFor("stitch", [[0, 10], [9, 20]], 20);
    const steps = buildPassSteps(2, "stitch", "local_llm");
    expect(passProgressLabel(plan, steps, 0)).toBe("Reading part 1 of 2 — characters 0–10");
    expect(passProgressLabel(plan, steps, 2)).toBe("Saving the result into the room…");
    // Past the end of the plan (a resumed job whose cursor is already total).
    expect(passProgressLabel(plan, steps, 3)).toBe("Finishing…");
  });

  it("progress_labels_name_the_exact_window", () => {
    const plan: PassPlan = {
      fileId: "f",
      fileName: "book.txt",
      instruction: "summarize",
      mode: "merge",
      textLen: 40_000,
      windows: [[0, 16_000], [15_600, 31_600], [31_200, 40_000]],
    };
    const steps = buildPassSteps(3, "merge", "local_llm");
    expect(passProgressLabel(plan, steps, 0)).toBe("Reading part 1 of 3 — characters 0–16000");
    expect(passProgressLabel(plan, steps, 2)).toBe("Reading part 3 of 3 — characters 31200–40000");
    // After the maps: 3 windows fit in one section, then the save.
    expect(passProgressLabel(plan, steps, 3)).toBe("Writing section 1 of 1…");
    expect(passProgressLabel(plan, steps, 4)).toContain("Saving");
  });
});

// ------------------------------------------------------------- driveFilePass
//
// Own coverage (not a Rust `#[cfg(test)]` port — none of file_pass.rs's own
// tests drive `drive_file_pass` directly; only the `#[ignore]`d real-Ollama
// end-to-end test does, via `execute_pass_step` in a loop, not through
// `drive_file_pass`). This exercises the wiring `driveFilePass` adds on top:
// the child-job row, `resolveEngine`'s injected seam, and — the module's
// central design constraint — a document long enough to need MULTIPLE
// section-composes, proving no single call ever holds the whole file.

/** A document long enough (>2x PASS_WINDOW_CHARS) to need three map windows,
 * with a distinct, greppable fact in each third — the same shape the real
 * end-to-end Rust test uses to prove nothing gets lost between windows. */
function threeActDocument(): string {
  const act = (title: string, fact: string): string =>
    `${title}\n${fact}\n${"Routine detail filling out this act of the story. ".repeat(1600)}\n\n`;
  return (
    act("ACT ONE", "The lighthouse keeper's name is Odalys Ferrant.") +
    act("ACT TWO", "The missing ship was called the Cassiopeia Reach.") +
    act("ACT THREE", "The harbor town is named Vessport.")
  );
}

function fakeSectionAwarePost(sectionCalls: number[]): FilePassStepDeps["post"] {
  return async (endpoint: string, body: unknown): Promise<SidecarPostOutcome> => {
    const b = body as Record<string, unknown>;
    if (endpoint === "/file_pass_map") {
      return {
        kind: "value",
        value: {
          result: `notes for window ${b.part} (${(b.window_text as string).slice(0, 24)}…)`,
          thread: `${b.thread}>${b.part}`,
          skipped: false,
        },
      };
    }
    if (endpoint === "/file_pass_section") {
      sectionCalls.push(b.section as number);
      // Each compose call sees only ITS OWN group's notes, never the whole
      // document — asserted below via `sections.length`.
      expect((b.sections as unknown[]).length).toBeLessThanOrEqual(PASS_SECTION_WINDOWS);
      return { kind: "value", value: { result: `<h2>Section ${b.section}</h2>`, thread: "", skipped: false } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
}

describe("driveFilePass", () => {
  it("runs map -> per-section compose -> publish end to end, never folding the whole file into one call", async () => {
    const room = "/tmp/drive.roomai";
    const { rooms, db } = freshRoom(room);
    const text = threeActDocument();
    const file = insertFile(db, "expedition.txt", "text/plain", Buffer.from(text, "utf8"), text, "upload");
    // Confirm the fixture actually needs more than one window (the whole
    // point of this test), without hard-coding the exact count.
    const n = Math.ceil(Buffer.byteLength(text, "utf8") / PASS_WINDOW_CHARS) + 1;
    expect(n).toBeGreaterThan(1);

    const parent = createJob(db, "workflow", "Test workflow", {}, 1);
    const sectionCalls: number[] = [];
    const emitted: string[] = [];
    const cancel = new CancelFlag();
    const deps: DriveFilePassDeps = {
      rooms,
      emit: (event) => emitted.push(event),
      post: fakeSectionAwarePost(sectionCalls),
      resolveEngine: async () => ({ model: "test-model", lane: "local_llm" }),
    };

    const { message, meta } = await driveFilePass(deps, parent, room, file.id, file.name, "  ", "merge", cancel);

    expect(message).toBe(`Saved a full pass of "${file.name}" as "Full pass — ${file.name}.html".`);
    expect(meta).not.toBeNull();
    expect(meta?.name).toBe(`Full pass — ${file.name}.html`);
    expect(emitted).toContain("room-files-changed");

    const doc = getFileExtractedText(db, (meta as FileMeta).id) as string;
    expect(doc).toContain("complete coverage");
    // The compose calls are EXACTLY the plan's sections — `>= 1` would have
    // passed for a single global fold over the whole file, which is the one
    // thing this test is named for.
    const planned = parsePassPlan(
      JSON.parse((db.prepare("SELECT plan FROM jobs WHERE parent_job_id = ?").get(parent) as { plan: string }).plan)
    );
    const expectedSections = Math.ceil(planned.windows.length / PASS_SECTION_WINDOWS);
    expect(expectedSections, "the fixture must span more than one section").toBeGreaterThan(1);
    expect(sectionCalls).toEqual(Array.from({ length: expectedSections }, (_, i) => i));
    // …and publish concatenated them IN ORDER.
    expect([...doc.matchAll(/<h2>Section (\d+)<\/h2>/g)].map((m) => Number(m[1]))).toEqual(
      Array.from({ length: expectedSections }, (_, i) => i)
    );

    // The child job row is real, wired to its parent, and finished.
    const rows = db.prepare("SELECT id, parent_job_id, status, kind FROM jobs WHERE parent_job_id = ?").all(parent) as Array<{
      id: string;
      parent_job_id: string;
      status: string;
      kind: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("file_pass");
    expect(rows[0]?.status).toBe("done");
    const child = getJob(db, rows[0]?.id as string);
    expect(child.total).toBeGreaterThan(0);
    expect(child.cursor).toBe(child.total);
  });

  it("an empty instruction defaults to a full summarize, matching the Rust fallback", async () => {
    const room = "/tmp/drive2.roomai";
    const { rooms, db } = freshRoom(room);
    const text = "A short file that fits in a single window.";
    const file = insertFile(db, "short.txt", "text/plain", Buffer.from(text, "utf8"), text, "upload");
    const parent = createJob(db, "workflow", "Test workflow", {}, 1);
    let sawInstruction: string | null = null;
    const deps: DriveFilePassDeps = {
      rooms,
      post: async (endpoint, body) => {
        const b = body as Record<string, unknown>;
        sawInstruction = b.instruction as string;
        if (endpoint === "/file_pass_map") {
          return { kind: "value", value: { result: "notes", thread: "", skipped: false } };
        }
        return { kind: "value", value: { result: "<h2>S</h2>", thread: "", skipped: false } };
      },
      resolveEngine: async () => ({ model: "test-model", lane: "local_llm" }),
    };
    await driveFilePass(deps, parent, room, file.id, file.name, "   ", "merge", new CancelFlag());
    expect(sawInstruction).toBe("Summarize this file completely and thoroughly.");
  });

  it("finishes the pass when best-effort child status and checkpoint writes fail", async () => {
    const room = "/tmp/drive-best-effort.roomai";
    const { rooms, db } = freshRoom(room);
    const text = "content";
    const file = insertFile(db, "f.txt", "text/plain", Buffer.from(text, "utf8"), text, "upload");
    const parent = createJob(db, "workflow", "Test workflow", {}, 1);
    const flakyDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== "prepare") return Reflect.get(target, key, receiver);
        return (sql: string) => {
          if (sql.includes("UPDATE jobs SET status") || sql.includes("UPDATE jobs SET cursor")) {
            throw new Error("room database closed during best-effort update");
          }
          return target.prepare(sql);
        };
      },
    }) as Database.Database;
    const flakyRooms: RoomSource = {
      current: () => {
        const current = rooms.current();
        return current === null ? null : { ...current, db: flakyDb };
      },
    };
    const deps: DriveFilePassDeps = {
      rooms: flakyRooms,
      post: async (endpoint) => endpoint === "/file_pass_map"
        ? { kind: "value", value: { result: "notes", thread: "", skipped: false } }
        : { kind: "value", value: { result: "<h2>S</h2>", thread: "", skipped: false } },
      resolveEngine: async () => ({ model: "test-model", lane: "local_llm" }),
    };

    await expect(
      driveFilePass(deps, parent, room, file.id, file.name, "summarize", "merge", new CancelFlag()),
    ).resolves.toMatchObject({ meta: { name: "Full pass — f.txt.html" } });
  });

  it("surfaces the NOT_IMPLEMENTED seam when no engine resolver is supplied", async () => {
    const room = "/tmp/drive3.roomai";
    const { rooms, db } = freshRoom(room);
    const text = "content";
    const file = insertFile(db, "f.txt", "text/plain", Buffer.from(text, "utf8"), text, "upload");
    const parent = createJob(db, "workflow", "Test workflow", {}, 1);
    await expect(
      driveFilePass({ rooms }, parent, room, file.id, file.name, "summarize", "merge", new CancelFlag())
    ).rejects.toThrow(/NOT_IMPLEMENTED: resolve_pass_engine/);
  });

  it("a file with no readable text is refused before any child job is created", async () => {
    const room = "/tmp/drive4.roomai";
    const { rooms, db } = freshRoom(room);
    // A file whose extracted text is null (e.g. an image) — the "has no
    // readable text for a pass" guard.
    const file = insertFile(db, "photo.png", "image/png", Buffer.from([1, 2, 3]), null, "upload");
    const parent = createJob(db, "workflow", "Test workflow", {}, 1);
    await expect(
      driveFilePass({ rooms }, parent, room, file.id, file.name, "summarize", "merge", new CancelFlag())
    ).rejects.toThrow(/has no readable text for a pass/);
    expect(db.prepare("SELECT count(*) AS n FROM jobs WHERE parent_job_id = ?").get(parent)).toEqual({ n: 0 });
  });

  it("plans in UTF-8 BYTE space — windows, textLen and the digest all match Rust's &str semantics", async () => {
    // `PassPlan.windows` are the byte spans `filtered.get(start..end)` indexes
    // with, `textLen` is `filtered.len()` (BYTES), and `textSha256` is a
    // digest of `s.as_bytes()`. A port that reached for `string.slice()` and
    // `string.length` (UTF-16 code units) produces a plan that LOOKS right on
    // ASCII and mis-slices every window of any file with an accent, a curly
    // quote, Hebrew or an emoji in it — and the coverage line it publishes
    // under-counts the characters it claims to have read.
    //
    // The plan is persisted, so this is not recoverable later: a pass resumed
    // against a re-derived plan in the other index space silently reads
    // different text than the one that wrote the artifacts.
    const room = "/tmp/drive5.roomai";
    const { rooms, db } = freshRoom(room);
    const text = "Il était une fois — une très longue histoire française. ".repeat(2_000);
    const file = insertFile(db, "conte.txt", "text/plain", Buffer.from(text, "utf8"), text, "upload");
    const parent = createJob(db, "workflow", "Test workflow", {}, 1);
    const deps: DriveFilePassDeps = {
      rooms,
      post: async (endpoint): Promise<SidecarPostOutcome> =>
        endpoint === "/file_pass_map"
          ? { kind: "value", value: { result: "notes", thread: "", skipped: false } }
          : { kind: "value", value: { result: "<h2>S</h2>", thread: "", skipped: false } },
      resolveEngine: async () => ({ model: "test-model", lane: "local_llm" }),
    };
    await driveFilePass(deps, parent, room, file.id, file.name, "summarize", "merge", new CancelFlag());

    const row = db.prepare("SELECT plan FROM jobs WHERE parent_job_id = ?").get(parent) as { plan: string };
    const plan = parsePassPlan(JSON.parse(row.plan));
    const filtered = smartFilter(text);
    expect(plan.textLen).toBe(Buffer.byteLength(filtered, "utf8"));
    expect(plan.textLen, "bytes, not UTF-16 code units").toBeGreaterThan(filtered.length);
    expect(plan.textSha256).toBe(createHash("sha256").update(Buffer.from(filtered, "utf8")).digest("hex"));
    expect(plan.windows.length, "the fixture must need several windows").toBeGreaterThan(1);
    // Coverage: window 0 starts at byte 0, the last ends at the last byte, and
    // every span is a legal char-boundary slice (never a split é).
    expect(plan.windows[0]?.[0]).toBe(0);
    expect(plan.windows[plan.windows.length - 1]?.[1]).toBe(plan.textLen);
    for (const [s, e] of plan.windows) {
      expect(sliceUtf8(filtered, s, e), `window ${s}..${e} lands mid-character`).not.toBeNull();
    }
    // And no gaps: each window starts at or before the previous window's end.
    for (let i = 1; i < plan.windows.length; i++) {
      expect((plan.windows[i] as [number, number])[0]).toBeLessThanOrEqual(
        (plan.windows[i - 1] as [number, number])[1]
      );
    }
  });
});

// ------------------------------------------------------------- the reduce, adversarially
//
// The two properties above are pinned STRUCTURALLY (`buildPassSteps` groups
// windows into sections; `NO GLOBAL FOLD` walks every size). What follows
// pins them BEHAVIOURALLY, end to end through `driveFilePass` with real
// content flowing: a document big enough for many sections, a fake engine
// that neither invents nor drops anything, and an assertion that every fact
// in the source reaches the published deliverable, in order.
//
// Both of these were written after mutation-testing the suite above: with
// `publish` emitting the composed sections in REVERSE order, and with
// `compose` silently dropping each section's first window (a sixth of the
// book), every other test in this file still passed. Those are exactly the
// "an 850 KB book lost most of its chapters" failures this module's design
// exists to prevent, so they get tests that can actually fail for them.

/** A document with `nFacts` uniquely greppable facts spread evenly through
 * it, each followed by filler chosen to survive `smartFilter` untouched
 * (every line distinct, so the identical-run collapse never fires; ordinary
 * prose, so `looksLikeNoise` never fires). Sized to need MANY sections. */
function manySectionDocument(nFacts: number): string {
  const lines: string[] = [];
  for (let k = 0; k < nFacts; k++) {
    lines.push(`FACT-${k}: the beacon at station ${k} was lit by keeper number ${k}.`);
    for (let l = 0; l < 60; l++) {
      lines.push(`Station ${k} line ${l}: routine detail recorded in the station log that day.`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function factsIn(s: string): number[] {
  return [...s.matchAll(/FACT-(\d+)/g)].map((m) => Number(m[1]));
}

interface SectionCall {
  section: number;
  total: number;
  notes: string[];
}

/**
 * A FAITHFUL fake engine: `/file_pass_map` returns notes carrying every fact
 * its window actually contained, and `/file_pass_section` returns HTML that
 * is exactly the concatenation of the notes IT WAS HANDED. The fake invents
 * nothing and drops nothing, so anything missing from the published document
 * was dropped by `filePass.ts` itself.
 */
function faithfulPost(
  mapCalls: number[],
  sectionCalls: SectionCall[],
  onMap?: (part: number) => SidecarPostOutcome | null
): NonNullable<FilePassStepDeps["post"]> {
  return async (endpoint, body): Promise<SidecarPostOutcome> => {
    const b = body as Record<string, unknown>;
    if (endpoint === "/file_pass_map") {
      const part = b.part as number;
      mapCalls.push(part);
      const override = onMap?.(part);
      if (override !== null && override !== undefined) {
        return override;
      }
      const facts = factsIn(b.window_text as string);
      return {
        kind: "value",
        value: {
          result: `NOTES(window ${part}) ${facts.map((f) => `FACT-${f}`).join(" ")}`,
          thread: `${b.thread as string}>${part}`,
          skipped: false,
        },
      };
    }
    if (endpoint === "/file_pass_section") {
      const notes = b.sections as string[];
      sectionCalls.push({ section: b.section as number, total: b.total as number, notes: [...notes] });
      return {
        kind: "value",
        value: { result: `<section data-sec="${b.section as number}">${notes.join(" | ")}</section>`, thread: "", skipped: false },
      };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
}

/** Every fact index the source document contains, in order. */
function allFacts(nFacts: number): number[] {
  return Array.from({ length: nFacts }, (_, k) => k);
}

/** The distinct facts of `doc`, in the order they first appear. */
function factOrder(doc: string): number[] {
  const seen: number[] = [];
  for (const f of factsIn(doc)) {
    if (!seen.includes(f)) {
      seen.push(f);
    }
  }
  return seen;
}

describe("the reduce is per-SECTION, and no section's content is lost on the way out", () => {
  it("a many-section document publishes every fact, in order, and no model call ever holds the whole file", async () => {
    const room = "/tmp/adv-fold.roomai";
    const { rooms, db } = freshRoom(room);
    const nFacts = 220;
    const text = manySectionDocument(nFacts);
    // The whole point of the fixture: several sections, not one.
    expect(Buffer.byteLength(text, "utf8") / PASS_WINDOW_CHARS).toBeGreaterThan(4 * PASS_SECTION_WINDOWS);
    const file = insertFile(db, "stations.txt", "text/plain", Buffer.from(text, "utf8"), text, "upload");
    const parent = createJob(db, "workflow", "wf", {}, 1);

    const mapCalls: number[] = [];
    const sectionCalls: SectionCall[] = [];
    const { meta } = await driveFilePass(
      { rooms, post: faithfulPost(mapCalls, sectionCalls), resolveEngine: async () => ({ model: "m", lane: "local_llm" }) },
      parent, room, file.id, file.name, "summarize", "merge", new CancelFlag()
    );

    const plan = parsePassPlan(
      JSON.parse((db.prepare("SELECT plan FROM jobs WHERE parent_job_id = ?").get(parent) as { plan: string }).plan)
    );
    const n = plan.windows.length;
    const totalSections = Math.ceil(n / PASS_SECTION_WINDOWS);
    expect(totalSections, "the fixture must need several sections").toBeGreaterThanOrEqual(5);

    // 1. Every window was read once, in order, and no compose call ever saw
    //    more than one section's notes.
    expect(mapCalls).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(sectionCalls.map((c) => c.section)).toEqual(Array.from({ length: totalSections }, (_, i) => i));
    for (const c of sectionCalls) {
      expect(c.notes.length, `section ${c.section} was handed ${c.notes.length} notes`).toBeLessThanOrEqual(
        PASS_SECTION_WINDOWS
      );
      expect(c.total).toBe(totalSections);
    }
    // …and together the sections cover the map outputs exactly once, in order.
    expect(sectionCalls.flatMap((c) => c.notes.map((s) => Number(/window (\d+)/.exec(s)?.[1])))).toEqual(
      Array.from({ length: n }, (_, i) => i)
    );

    // 2. EVERY fact survives to the deliverable — including FACT-0, the exact
    //    content a global fold loses by the time the last section is written.
    const doc = getFileExtractedText(db, (meta as FileMeta).id) as string;
    const lost = allFacts(nFacts).filter((k) => !doc.includes(`FACT-${k} `) && !doc.includes(`FACT-${k}<`));
    expect(lost, `facts lost between the map phase and publish: ${lost.slice(0, 20).join(",")}`).toEqual([]);

    // 3. …in document order, and with the sections concatenated in order.
    expect(factOrder(doc), "facts must reach the page in document order").toEqual(allFacts(nFacts));
    expect([...doc.matchAll(/data-sec="(\d+)"/g)].map((m) => Number(m[1]))).toEqual(
      Array.from({ length: totalSections }, (_, i) => i)
    );
    expect(doc).toContain("complete coverage");
  }, 60_000);
});

describe("a Stop mid-pass leaves no partial write, and the resume keeps the early sections", () => {
  it("cancelling during the map phase publishes nothing; the resume carries the same child row to a complete document", async () => {
    const room = "/tmp/adv-cancel.roomai";
    const { rooms, db } = freshRoom(room);
    const nFacts = 220;
    const text = manySectionDocument(nFacts);
    const file = insertFile(db, "stations.txt", "text/plain", Buffer.from(text, "utf8"), text, "upload");
    const parent = createJob(db, "workflow", "wf", {}, 1);

    // Leg 1: Stop lands on window 4 — the sidecar client returns its STOPPED
    // sentinel, exactly as a real Stop mid-request does.
    const cancel = new CancelFlag();
    const stopAt = 4;
    const leg1Maps: number[] = [];
    const leg1Sections: SectionCall[] = [];
    await expect(
      driveFilePass(
        {
          rooms,
          post: faithfulPost(leg1Maps, leg1Sections, (part) => {
            if (part !== stopAt) return null;
            cancel.store(true);
            return { kind: "stopped" };
          }),
          resolveEngine: async () => ({ model: "m", lane: "local_llm" }),
        },
        parent, room, file.id, file.name, "summarize", "merge", cancel
      )
    ).rejects.toThrow("STOPPED");

    // Nothing was published, and no compose ever ran.
    expect(listFiles(db).filter((f) => f.name.startsWith("Full pass —"))).toHaveLength(0);
    expect(leg1Sections).toHaveLength(0);
    // ONE child row, parked resumable, its cursor exactly the steps that
    // genuinely finished — the cancelled step left nothing behind to resume
    // over, so it re-runs.
    const rows = db.prepare("SELECT id, status, cursor FROM jobs WHERE parent_job_id = ?").all(parent) as Array<{
      id: string;
      status: string;
      cursor: number;
    }>;
    expect(rows).toHaveLength(1);
    const child = rows[0] as { id: string; status: string; cursor: number };
    expect(["paused", "error"]).toContain(child.status);
    expect(child.cursor).toBe(stopAt);
    for (let i = 0; i < child.cursor; i++) {
      expect(loadArtifact(db, child.id, i), `window ${i}'s notes must survive the Stop`).not.toBeNull();
    }
    expect(loadArtifact(db, child.id, stopAt), "the cancelled step wrote nothing").toBeNull();

    // Leg 2: resume. The same child row carries on from its cursor.
    const leg2Maps: number[] = [];
    const leg2Sections: SectionCall[] = [];
    const { meta } = await driveFilePass(
      { rooms, post: faithfulPost(leg2Maps, leg2Sections), resolveEngine: async () => ({ model: "m", lane: "local_llm" }) },
      parent, room, file.id, file.name, "summarize", "merge", new CancelFlag()
    );
    const rows2 = db.prepare("SELECT id, status FROM jobs WHERE parent_job_id = ?").all(parent) as Array<{
      id: string;
      status: string;
    }>;
    expect(rows2, "a resume must not mint a second child row").toHaveLength(1);
    expect(rows2[0]?.id).toBe(child.id);
    expect(rows2[0]?.status).toBe("done");
    expect(leg2Maps[0], "the resume restarts at the cursor, not at window 0").toBe(stopAt);

    // Exactly one deliverable, and the facts read in leg 1 are still in it.
    expect(listFiles(db).filter((f) => f.name.startsWith("Full pass —"))).toHaveLength(1);
    const doc = getFileExtractedText(db, (meta as FileMeta).id) as string;
    const lost = allFacts(nFacts).filter((k) => !doc.includes(`FACT-${k} `) && !doc.includes(`FACT-${k}<`));
    expect(lost, `facts lost across the Stop/resume: ${lost.slice(0, 20).join(",")}`).toEqual([]);
    expect(factOrder(doc)).toEqual(allFacts(nFacts));
  }, 60_000);

  it("a Stop landing INSIDE publish — at any of its three cancel reads — writes nothing and stages nothing", async () => {
    // Publish makes no model call, so there is no `sidecarJsonCancellable` to
    // catch a Stop for it. Its three gates are all it has: the one at the top
    // of the step, the one in `writeDeliverable`, and the one `Artifact.commit`
    // takes between staging and committing. A flag that flips at exactly the
    // Nth read is the only way to drive each of them in turn.
    const room = "/tmp/adv-pub.roomai";
    const { rooms, db } = freshRoom(room);
    const plan = planFor("merge", [[0, 4]], 4);
    const steps = buildPassSteps(1, "merge", "local_llm");
    const publish = steps[steps.length - 1] as Step;

    class FlipAtNthRead extends CancelFlag {
      private reads = 0;
      constructor(private readonly flipAt: number) {
        super();
      }
      override load(): boolean {
        this.reads += 1;
        return this.reads >= this.flipAt;
      }
    }

    const seedJob = (): string => {
      const id = createJob(db, "file_pass", "t", JSON.parse(JSON.stringify(plan)), steps.length);
      storeArtifact(db, id, 0, art("notes", false));
      storeArtifact(db, id, 1, art("<h2>S</h2>", false));
      return id;
    };
    const stagedCount = (): number =>
      (db.prepare("SELECT count(*) AS n FROM staged_artifacts").get() as { n: number }).n;

    for (const flipAt of [1, 2, 3]) {
      const job = seedJob();
      const filesBefore = listFiles(db).length;
      const stagedBefore = stagedCount();
      const published: PublishedRef = { value: null };
      const result = await executePassStep(
        { rooms }, job, room, plan, "m", "text", publish, new FlipAtNthRead(flipAt), published
      );
      expect(result.ok, `flipAt=${flipAt} must refuse to publish`).toBe(false);
      expect(published.value, `flipAt=${flipAt}: nothing may be reported as published`).toBeNull();
      expect(listFiles(db), `flipAt=${flipAt}: no file may land in the room`).toHaveLength(filesBefore);
      expect(stagedCount(), `flipAt=${flipAt}: no staged row may be left behind`).toBe(stagedBefore);
      expect(loadArtifact(db, job, publish.id), `flipAt=${flipAt}: no publish artifact`).toBeNull();
    }

    // Control: the identical step with a flag that never trips DOES publish —
    // so the three cases above failed for the cancel, not for the fixture.
    const job = seedJob();
    const published: PublishedRef = { value: null };
    const ok = await executePassStep({ rooms }, job, room, plan, "m", "text", publish, new CancelFlag(), published);
    expect(ok.ok).toBe(true);
    expect(published.value?.name).toBe("Full pass — book.txt.html");
  });
});
