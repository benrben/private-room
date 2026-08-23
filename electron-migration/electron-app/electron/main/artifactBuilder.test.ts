/**
 * Vitest port of `src-tauri/src/commands/artifact.rs`'s `#[cfg(test)] mod
 * tests`, now COMPLETE — every test in that module has a home here or in
 * {@link Artifact}'s own doc-referenced callers:
 *
 *   - a_cancelled_artifact_is_never_written_and_says_so
 *   - a_child_of_a_cancelled_run_writes_no_artifact
 *   - a_cancel_that_arrives_after_the_commit_does_not_unsay_it
 *   - regenerating_an_artifact_versions_it_and_records_who_made_it (adapted:
 *     the Rust test uses the `note()` constructor; this one keeps using
 *     `new()` with an explicit mime, since that was already exercising the
 *     same funnel and the same assertions before `note()` was ported)
 *   - source_files_are_recorded_as_ids_only
 *   - an_empty_generation_is_refused_rather_than_saved_as_a_blank_file
 *   - a_user_can_go_back_to_an_earlier_generation_and_the_credit_goes_back_too
 *   - restoring_a_hand_typed_state_clears_the_ai_credit
 *
 * The last two were held back by an earlier batch pending `restore_version_
 * into` (`commands/safety.rs`), which a later batch shipped as `restoreVersion
 * Into` in `safetyTools.ts` — this batch (porting `artifact.rs` itself) is
 * what closes the loop and adds them.
 *
 * `via_tool`/`cancel_maybe` remain deliberately absent from {@link Artifact}:
 * verified during this batch that their one Rust call site
 * (`agent.rs`'s `create_file` arm, `.via_tool("create_file").cancel_maybe(..)`)
 * is already ported — as `organizeTools.ts`'s own local `commitArtifact`,
 * built directly over the staging primitives rather than through this class
 * (see that file's header). Adding the two methods here anyway would be a
 * second, uncalled path to the same outcome, not a real port.
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
import { getFileExtractedText, insertFile, listFiles } from "./db-host/files.js";
import { listFileVersions } from "./db-host/fileVersionsList.js";
import { restoreVersionInto } from "./safetyTools.js";

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

  it("a_user_can_go_back_to_an_earlier_generation_and_the_credit_goes_back_too", () => {
    // The net under an AI that writes without asking: the run that replaced
    // your document is undoable, and after the undo the file no longer
    // claims to have been written by the run whose words are gone.
    const db = freshRoom();
    const v1 = Artifact.new("Brief.md", "text/markdown", "the first brief")
      .by("Research agent")
      .duringRun("run-1")
      .commit(db);
    Artifact.new("Brief.md", "text/markdown", "a rewrite nobody asked for")
      .by("Documents agent")
      .duringRun("run-2")
      .commit(db);
    expect(getFileExtractedText(db, v1.meta.id)).toBe("a rewrite nobody asked for");

    const older = listFileVersions(db, v1.meta.id);
    expect(older).toHaveLength(1);
    const restored = restoreVersionInto(db, older[0]!.id);

    expect(restored).toBe(v1.meta.id);
    expect(getFileExtractedText(db, v1.meta.id)).toBe("the first brief");
    const head = fileProvenance(db, v1.meta.id);
    expect(head?.agent).toBe("Research agent");
    expect(head?.runId).toBe("run-1");
    // And the restore is itself undoable — the rewrite is now the version.
    const after = listFileVersions(db, v1.meta.id);
    expect(after).toHaveLength(2);
    expect(after[0]!.cause).toBe("Restored");
    expect(
      after[0]!.provenance?.runId,
      "the snapshot taken on the way past keeps the rewrite's own credit"
    ).toBe("run-2");
  });

  it("note() defaults an extension-less name to .md and derives the mime from the final name", () => {
    // ADVERSARIAL ADDITION (verification pass): `Artifact.note` was ported but
    // had NO test at all — the Rust original's own
    // `regenerating_a_note_versions_it_and_records_who_made_it` asserts
    // `assert_eq!(first.meta.name, "Weekly brief.md", "extension-less names
    // default to .md")` through `Artifact::note`, and the TS port of that test
    // sidestepped it by spelling `.md` out itself with `Artifact.new`. The
    // extension default is exactly the invariant `note()` exists to own ("so
    // `create_note` and `save_and_open` cannot disagree about what an
    // extension-less name means"), so it needs its own assertion.
    const db = freshRoom();
    const bare = Artifact.note("Weekly brief", "week one").by("#minutes").commit(db);
    expect(bare.meta.name).toBe("Weekly brief.md");
    expect(bare.meta.mimeType).toBe("text/markdown");

    // A name that already carries an extension keeps it, and the mime follows
    // that extension rather than the .md default.
    expect(Artifact.note("Deck.html", "<p>hi</p>").commit(db).meta.mimeType).toBe("text/html");
    expect(Artifact.note("table.CSV", "a,b\n").commit(db).meta.mimeType).toBe("text/csv");
    // …and an extension the table has no entry for is `text/plain`, exactly
    // what `mime_guess::from_path(..).first_or(TEXT_PLAIN)` answers in Rust.
    expect(Artifact.note("mystery.xyz", "?").commit(db).meta.mimeType).toBe("text/plain");
  });

  it("note() survives a file name whose extension is an Object.prototype key", () => {
    // ADVERSARIAL ADDITION (verification pass) — a REAL bug this found, of
    // exactly the class this migration's rule 2 exists for. `note()` derives
    // its mime through `docsHtml.ts`'s `noteMime`, which was an UNGUARDED
    // lookup on a plain `{}` literal: `MIME_BY_EXT[extensionOf(name)] ??
    // "text/plain"`. The file name is model-controlled (`#minutes`/`#sketch`/
    // `#to-sheet` all pass one straight in, and `create_file`'s own arm
    // computes the same expression), so a name ending `.constructor` returned
    // the `Object` FUNCTION rather than a mime — `?? "text/plain"` never fires
    // for a non-nullish value — and the commit died inside better-sqlite3 with
    // "SQLite3 can only bind numbers, strings, bigints, buffers, and null".
    // `.__proto__` returned `Object.prototype` the same way. Rust's
    // `mime_guess::from_path` has no prototype chain to leak and answers
    // `text/plain` for both.
    const db = freshRoom();
    for (const [name, expected] of [
      ["Report.constructor", "Report.constructor"],
      ["Report.__proto__", "Report.__proto__"],
      ["Report.toString", "Report.toString"],
      ["Report.hasOwnProperty", "Report.hasOwnProperty"],
    ] as const) {
      const w = Artifact.note(name, "body").by("#minutes").commit(db);
      expect(w.meta.name).toBe(expected);
      expect(w.meta.mimeType).toBe("text/plain");
    }
  });

  it("duringRun(null) CLEARS a run id the chain already set, matching Rust's unconditional assignment", () => {
    // ADVERSARIAL ADDITION (verification pass) — a real, if latent, fidelity
    // gap this found. Rust's `during_run` is an UNCONDITIONAL assignment
    // (`self.prov.run_id = run_id.map(str::to_string)`), so `None` clears; the
    // port only assigned on the non-null branch, so a later `duringRun(null)`
    // silently kept the earlier id. That is the difference between "no run
    // wrote this" and a file credited to a run it did not come from — the
    // exact class of untruth the provenance funnel exists to prevent — and it
    // is one line away from being reachable by any caller that builds the
    // chain conditionally (`.duringRun(ctx.turn.runId)` after a default).
    const db = freshRoom();
    const w = Artifact.new("Note.md", "text/markdown", "body")
      .by("Documents agent")
      .duringRun("run-1")
      .duringRun(null)
      .commit(db);
    const prov = fileProvenance(db, w.meta.id);
    expect(prov?.agent).toBe("Documents agent");
    expect(prov?.runId).toBeUndefined();
    // And the stored JSON does not carry the key at all, matching Rust's
    // `skip_serializing_if = "Option::is_none"`.
    const raw = db
      .prepare("SELECT provenance FROM files WHERE id = ? AND trashed_at IS NULL")
      .get(w.meta.id) as { provenance: string };
    expect(raw.provenance).not.toContain("run-1");
    expect(raw.provenance).not.toContain("runId");
  });

  it("indexedAs indexes the supplied text rather than the artifact's own bytes", () => {
    // ADVERSARIAL ADDITION (verification pass): `indexedAs` was ported (it is
    // what `#sketch` needs — a `.sketch` is a JSON document, and indexing that
    // source would put coordinates and colour names into search results and
    // into the model's retrieved context) but nothing asserted it. Without it
    // `commit` passes `content` twice over, which is precisely the state this
    // file's own header says the method was added to fix, and no test would
    // have noticed the regression.
    const db = freshRoom();
    const sketchJson = '{"shapes":[{"kind":"rect","x":12,"y":40,"fill":"#ff00aa"}]}';
    const w = Artifact.note("Diagram.sketch", sketchJson)
      .indexedAs("A pink rectangle labelled Budget")
      .by("#sketch")
      .commit(db);

    expect(getFileExtractedText(db, w.meta.id)).toBe("A pink rectangle labelled Budget");
    // The raw bytes are still the document itself — only the INDEX differs.
    const row = db.prepare("SELECT original_bytes FROM files WHERE id = ?").get(w.meta.id) as {
      original_bytes: Buffer;
    };
    expect(row.original_bytes.toString("utf8")).toBe(sketchJson);
    expect(getFileExtractedText(db, w.meta.id)).not.toContain("#ff00aa");
  });

  it("restoring_a_hand_typed_state_clears_the_ai_credit", () => {
    // A person's own file has no provenance. If the AI rewrites it and the
    // person restores their version, the file must stop being attributed to
    // the AI — a stale credit here is the same lie as a missing one.
    const db = freshRoom();
    const mine = insertFile(db, "Plan.md", "text/markdown", Buffer.from("my plan"), "my plan", "generated");
    Artifact.new("Plan.md", "text/markdown", "the AI's plan").by("Documents agent").commit(db);
    expect(fileProvenance(db, mine.id)).not.toBeNull();

    const v = listFileVersions(db, mine.id);
    restoreVersionInto(db, v[0]!.id);
    expect(getFileExtractedText(db, mine.id)).toBe("my plan");
    expect(
      fileProvenance(db, mine.id),
      "no run wrote what is on screen now, so nothing is credited"
    ).toBeNull();
  });
});
