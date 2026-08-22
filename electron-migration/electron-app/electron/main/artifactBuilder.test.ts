/**
 * Vitest port of the in-scope slice of `src-tauri/src/commands/artifact.rs`'s
 * `#[cfg(test)] mod tests` — the ones that exercise `new`/`by`/`during_run`/
 * `from_files`/`cancel_with`/`commit`, the subset {@link Artifact} actually
 * ports (see that file's own header for what was deliberately left out —
 * `note`/`via_tool`/`indexed_as`/`cancel_maybe`, none of which `file_pass.rs`
 * calls):
 *
 *   - a_cancelled_artifact_is_never_written_and_says_so
 *   - a_child_of_a_cancelled_run_writes_no_artifact
 *   - a_cancel_that_arrives_after_the_commit_does_not_unsay_it
 *   - regenerating_an_artifact_versions_it_and_records_who_made_it (adapted:
 *     the Rust test uses the `note()` constructor, unported here, so this
 *     uses `new()` with an explicit mime instead — same funnel, same
 *     assertions)
 *   - source_files_are_recorded_as_ids_only
 *   - an_empty_generation_is_refused_rather_than_saved_as_a_blank_file
 *
 * NOT PORTED (both need `restore_version_into`, out of this batch's scope):
 * `a_user_can_go_back_to_an_earlier_generation_and_the_credit_goes_back_too`,
 * `restoring_a_hand_typed_state_clears_the_ai_credit`.
 *
 * REAL fixture rooms via `createRoom`, matching this directory's convention.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag, Node } from "./cancel.js";
import { Artifact } from "./artifactBuilder.js";
import { createRoom } from "./db-host/open.js";
import { fileProvenance } from "./db-host/artifacts.js";
import { listFiles } from "./db-host/files.js";
import { listFileVersions } from "./db-host/fileVersionsList.js";

let tmpDir: string | null = null;
let open: Database.Database | null = null;

afterEach(() => {
  open?.close();
  open = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "artifact-builder-b-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  open = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return open;
}

describe("Artifact.commit", () => {
  it("a_cancelled_artifact_is_never_written_and_says_so", () => {
    const db = freshRoom();
    const stop = new CancelFlag();
    stop.store(true);
    expect(() =>
      Artifact.new("Minutes.md", "text/markdown", "the meeting notes").by("#minutes").cancelWith(stop).commit(db)
    ).toThrowError(/nothing was written/);
    expect(listFiles(db)).toEqual([]);
  });

  it("a_child_of_a_cancelled_run_writes_no_artifact", () => {
    // Owner replacement #3: cancelling a PARENT blocks the child's artifact
    // write, it does not merely sever its delivery.
    const db = freshRoom();
    const run = Node.root("this answer");
    const studio = run.child("Flashcards");
    run.cancel();

    expect(() =>
      Artifact.new("Flashcards - lease.html", "text/html", "<html>deck</html>")
        .by("Flashcards")
        .cancelWith(studio.flag())
        .commit(db)
    ).toThrowError(/nothing was written/);
    expect(listFiles(db)).toEqual([]);
  });

  it("a_cancel_that_arrives_after_the_commit_does_not_unsay_it", () => {
    // The flag is read ONCE, before the commit. A file that really is in the
    // room is reported as such.
    const db = freshRoom();
    const stop = new CancelFlag();
    const w = Artifact.new("Minutes.md", "text/markdown", "body").cancelWith(stop).commit(db);
    stop.store(true);
    expect(listFiles(db).find((f) => f.id === w.meta.id)?.name).toBe("Minutes.md");
  });

  it("regenerating_an_artifact_versions_it_and_records_who_made_it", () => {
    const db = freshRoom();
    const first = Artifact.new("Weekly brief.md", "text/markdown", "week one")
      .by("Documents agent")
      .duringRun("job-7")
      .commit(db);
    expect(first.versioned).toBe(false);
    expect(first.meta.name).toBe("Weekly brief.md");

    const again = Artifact.new("Weekly brief.md", "text/markdown", "week two")
      .by("Documents agent")
      .duringRun("job-8")
      .commit(db);
    expect(again.versioned, "a regeneration is a version").toBe(true);
    expect(again.meta.id).toBe(first.meta.id);
    expect(listFiles(db)).toHaveLength(1); // and never a second row

    const prov = fileProvenance(db, first.meta.id);
    expect(prov?.runId).toBe("job-8");
    expect(prov?.agent).toBe("Documents agent");

    const versions = listFileVersions(db, first.meta.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.provenance?.runId).toBe("job-7");
  });

  it("source_files_are_recorded_as_ids_only", () => {
    const db = freshRoom();
    const src = Artifact.new("Lease.txt", "text/plain", "the tenant pays rent on the first").commit(db).meta.id;
    const w = Artifact.new("Lease summary.md", "text/markdown", "a summary")
      .by("#summarize")
      .fromFiles([src])
      .commit(db);
    const prov = fileProvenance(db, w.meta.id);
    expect(prov?.sourceFileIds).toEqual([src]);
    // Nothing about the source's CONTENT rides along.
    const raw = db
      .prepare("SELECT provenance FROM files WHERE id = ? AND trashed_at IS NULL")
      .get(w.meta.id) as { provenance: string };
    expect(raw.provenance).not.toContain("tenant");
  });

  it("an_empty_generation_is_refused_rather_than_saved_as_a_blank_file", () => {
    const db = freshRoom();
    expect(() => Artifact.new("Report.md", "text/markdown", "").commit(db)).toThrowError(
      /Nothing was generated/
    );
    expect(listFiles(db)).toEqual([]);
  });
});
