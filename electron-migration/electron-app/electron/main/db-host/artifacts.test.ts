/**
 * Vitest port of `src-tauri/src/db/artifacts.rs`'s `mod tests`, 1:1:
 *
 *   - a_staged_write_that_never_commits_leaves_the_room_untouched
 *   - a_cancelled_write_leaves_the_previous_artifact_whole
 *   - regeneration_makes_v2_instead_of_overwriting_or_duplicating
 *   - a_users_own_file_is_never_versioned_over
 *   - regenerating_beside_a_users_file_versions_the_copy_it_already_made
 *   - a_name_that_comes_back_in_a_different_case_is_the_same_artifact
 *   - renaming_an_artifact_takes_it_out_of_the_generators_reach
 *   - provenance_is_recorded_for_the_head_and_carried_onto_the_version
 *   - empty_and_nameless_artifacts_are_refused_at_the_door
 *   - provenance_with_nothing_in_it_records_nothing
 *
 * …plus three the Rust suite does not have: the `MAX_ARTIFACT_BYTES` cap, and
 * the two halves of the provenance JSON codec (`provenanceToJson`'s
 * omit-if-empty shape and `provenanceFromJson`'s serde-matching strictness),
 * which exist in TypeScript only because `#[serde(skip_serializing_if)]` and
 * `serde_json::from_str(…).ok()` do not.
 *
 * ADAPTED: the Rust tests call `list_file_versions`/`get_version` to inspect
 * what `commitStaged` snapshotted. Neither is ported in this batch (see
 * `versions.ts`'s header) — every assertion that used them reads
 * `file_versions` back with raw SQL instead, the same stand-in convention
 * `files.test.ts`'s own header documents.
 *
 * REAL FIXTURE ROOMS: every test opens a real `.roomai` file through
 * `createRoom`, using the REAL `insertFile`/`getFileExtractedText`/
 * `getFileFull`/`listFiles`/`renameFile` from `files.ts`.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import { getFileExtractedText, getFileFull, insertFile, listFiles, renameFile } from "./files.js";
import { setFileProvenance } from "./versions.js";
import {
  commitStaged,
  discardStaged,
  fileProvenance,
  provenanceFromJson,
  provenanceToJson,
  stageArtifact,
  sweepStagedArtifacts,
  MAX_ARTIFACT_BYTES,
  type Provenance,
} from "./artifacts.js";

let tmpDir: string | null = null;
let open: Database.Database | null = null;

// Closing in the teardown (rather than at the end of each test body) so a
// failing assertion cannot leak the handle into the next test.
afterEach(() => {
  open?.close();
  open = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-artifacts-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  open = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return open;
}

function prov(): Provenance {
  return {
    runId: "run-1",
    agent: "Documents agent",
    tool: "create_file",
    sourceFileIds: ["src-1"],
  };
}

interface RawVersion {
  id: string;
  cause: string;
  bytes: Buffer;
  text: string | null;
  provenance: string | null;
}

/** Raw stand-in for the not-yet-ported `list_file_versions`, newest first. */
function rawVersions(db: Database.Database, fileId: string): RawVersion[] {
  return db
    .prepare(
      `SELECT id, cause, bytes, text, provenance FROM file_versions
       WHERE file_id = ? ORDER BY saved_at DESC, rowid DESC`
    )
    .all(fileId) as RawVersion[];
}

describe("artifacts", () => {
  it("a_staged_write_that_never_commits_leaves_the_room_untouched", () => {
    // The crash/cancel case: bytes are staged, then the run dies. The library
    // must not have gained or changed anything.
    const db = freshRoom();
    const before = listFiles(db).length;
    const staged = stageArtifact(
      db,
      "Report.html",
      "text/html",
      Buffer.from("<p>half a document</p>"),
      "half a document",
      prov()
    );
    expect(listFiles(db), "staging adds no file").toHaveLength(before);

    // A crash: nothing calls commit or discard. The next room open sweeps.
    expect(sweepStagedArtifacts(db)).toBe(1);
    expect(listFiles(db)).toHaveLength(before);
    // And the staging id is gone, so a late commit cannot resurrect it.
    expect(() => commitStaged(db, staged.id)).toThrow(/no longer staged/);
  });

  it("a_cancelled_write_leaves_the_previous_artifact_whole", () => {
    const db = freshRoom();
    const first = stageArtifact(
      db,
      "Notes.md",
      "text/markdown",
      Buffer.from("v1 body"),
      "v1 body",
      prov()
    );
    const [v1, versioned] = commitStaged(db, first.id);
    expect(versioned, "the first commit is a new file, not a version").toBe(false);

    // A second run stages a regeneration, then is cancelled before commit.
    const second = stageArtifact(
      db,
      "Notes.md",
      "text/markdown",
      Buffer.from("v2 body"),
      "v2 body",
      prov()
    );
    discardStaged(db, second.id);

    const [, , bytes, text] = getFileFull(db, v1.id);
    expect(bytes?.toString("utf8"), "the original bytes survive a cancelled rerun").toBe("v1 body");
    expect(text).toBe("v1 body");
    expect(rawVersions(db, v1.id), "and no version was cut").toHaveLength(0);
    expect(listFiles(db), "no 'Notes (2).md' either").toHaveLength(1);
  });

  it("regeneration_makes_v2_instead_of_overwriting_or_duplicating", () => {
    const db = freshRoom();
    const a = stageArtifact(db, "Deck.html", "text/html", Buffer.from("deck one"), "deck one", prov());
    const [file] = commitStaged(db, a.id);

    const b = stageArtifact(db, "Deck.html", "text/html", Buffer.from("deck two"), "deck two", prov());
    const [again, versioned] = commitStaged(db, b.id);

    expect(versioned).toBe(true);
    expect(again.id, "same file — not a second row").toBe(file.id);
    expect(again.name, "and not 'Deck (2).html'").toBe("Deck.html");
    expect(listFiles(db)).toHaveLength(1);

    // The earlier deck is still reachable, and the current one is the new.
    const versions = rawVersions(db, file.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.cause).toBe("AI regenerated");
    expect(versions[0]!.bytes.toString("utf8")).toBe("deck one");
    expect(versions[0]!.text).toBe("deck one");
    expect(getFileExtractedText(db, file.id)).toBe("deck two");
  });

  it("a_users_own_file_is_never_versioned_over", () => {
    // Only files the app GENERATED are regenerated in place. A name held by
    // something a person imported gets the duplicate-numbering treatment, so an
    // unattended AI write cannot rewrite the user's own document.
    const db = freshRoom();
    const mine = insertFile(db, "Plan.md", "text/markdown", Buffer.from("my plan"), "my plan", "upload");
    const s = stageArtifact(db, "Plan.md", "text/markdown", Buffer.from("ai plan"), "ai plan", prov());
    const [made, versioned] = commitStaged(db, s.id);

    expect(versioned).toBe(false);
    expect(made.id).not.toBe(mine.id);
    expect(made.name).toBe("Plan (2).md");
    expect(getFileExtractedText(db, mine.id)).toBe("my plan");
    expect(rawVersions(db, mine.id)).toHaveLength(0);
  });

  it("regenerating_beside_a_users_file_versions_the_copy_it_already_made", () => {
    // The case the "(2)" answer above only half-solves. Once the artifact has
    // stepped aside to "Plan (2).md", every LATER run has to find that file
    // again — matching on the requested name and nothing else would mint
    // "Plan (3).md", "Plan (4).md" … one per run, which is exactly the
    // duplicate the funnel exists to prevent.
    const db = freshRoom();
    insertFile(db, "Plan.md", "text/markdown", Buffer.from("my plan"), "my plan", "upload");
    const ids: string[] = [];
    for (let pass = 0; pass < 3; pass += 1) {
      const body = `ai plan ${pass}`;
      const s = stageArtifact(db, "Plan.md", "text/markdown", Buffer.from(body), body, prov());
      const [meta, versioned] = commitStaged(db, s.id);
      expect(meta.name, `pass ${pass} stepped aside AGAIN`).toBe("Plan (2).md");
      expect(versioned, `pass ${pass} versioned = ${versioned}`).toBe(pass > 0);
      ids.push(meta.id);
    }
    expect(ids[0], "three runs, one artifact").toBe(ids[2]);
    expect(listFiles(db), "the user's file and the artifact — no more").toHaveLength(2);
    expect(getFileExtractedText(db, ids[0]!)).toBe("ai plan 2");
    // And every earlier generation is still reachable.
    expect(rawVersions(db, ids[0]!)).toHaveLength(2);
  });

  it("a_name_that_comes_back_in_a_different_case_is_the_same_artifact", () => {
    // Models do not capitalise deterministically. `availableName` already
    // treats "deck.html" and "Deck.html" as the same name (the library lists
    // both and nobody can tell them apart), so the version match has to agree —
    // otherwise a stray capital is enough to spawn "deck (2).html".
    const db = freshRoom();
    const a = stageArtifact(db, "Deck.html", "text/html", Buffer.from("one"), "one", prov());
    const [first] = commitStaged(db, a.id);
    const b = stageArtifact(db, "deck.html", "text/html", Buffer.from("two"), "two", prov());
    const [again, versioned] = commitStaged(db, b.id);

    expect(versioned).toBe(true);
    expect(again.id).toBe(first.id);
    expect(listFiles(db), "no 'deck (2).html'").toHaveLength(1);
  });

  it("renaming_an_artifact_takes_it_out_of_the_generators_reach", () => {
    // Giving a generated file your own name is how you adopt it. The next run
    // must mint its own file rather than version over the copy you kept —
    // History is a net, but it is not consent to keep rewriting a document the
    // user has claimed.
    const db = freshRoom();
    const a = stageArtifact(db, "Minutes.md", "text/markdown", Buffer.from("first"), "first", prov());
    const [mine] = commitStaged(db, a.id);
    renameFile(db, mine.id, "Board minutes — August.md");

    const b = stageArtifact(db, "Minutes.md", "text/markdown", Buffer.from("second"), "second", prov());
    const [fresh, versioned] = commitStaged(db, b.id);

    expect(versioned).toBe(false);
    expect(fresh.id).not.toBe(mine.id);
    expect(fresh.name).toBe("Minutes.md");
    expect(getFileExtractedText(db, mine.id), "the file the user renamed was left alone").toBe(
      "first"
    );
    expect(rawVersions(db, mine.id)).toHaveLength(0);
  });

  it("provenance_is_recorded_for_the_head_and_carried_onto_the_version", () => {
    const db = freshRoom();
    const one: Provenance = {
      runId: "run-1",
      agent: "Documents agent",
      sourceFileIds: ["src-a"],
    };
    const two: Provenance = {
      runId: "run-2",
      agent: "Research agent",
      sourceFileIds: ["src-b", "src-c"],
    };
    const a = stageArtifact(db, "Brief.md", "text/markdown", Buffer.from("one"), "one", one);
    const [file] = commitStaged(db, a.id);
    expect(fileProvenance(db, file.id)).toEqual(one);

    const b = stageArtifact(db, "Brief.md", "text/markdown", Buffer.from("two"), "two", two);
    commitStaged(db, b.id);
    expect(fileProvenance(db, file.id), "head moves to run-2").toEqual(two);

    // The snapshot kept run-1 with the bytes run-1 made.
    const versions = rawVersions(db, file.id);
    expect(versions).toHaveLength(1);
    expect(provenanceFromJson(versions[0]!.provenance as string)).toEqual(one);
    // …and stored in serde's shape: `tool` was never set, so it is absent from
    // the JSON rather than written as null.
    expect(JSON.parse(versions[0]!.provenance as string)).toEqual({
      runId: "run-1",
      agent: "Documents agent",
      sourceFileIds: ["src-a"],
    });
  });

  it("empty_and_nameless_artifacts_are_refused_at_the_door", () => {
    const db = freshRoom();
    expect(() =>
      stageArtifact(db, "Empty.md", "text/markdown", Buffer.alloc(0), null, prov())
    ).toThrow(/Nothing was generated/);
    expect(() => stageArtifact(db, "   ", "text/plain", Buffer.from("x"), null, prov())).toThrow(
      /needs a file name/
    );
    expect(listFiles(db), "a refused write creates nothing").toHaveLength(0);
    expect(sweepStagedArtifacts(db), "and stages nothing").toBe(0);
  });

  it("provenance_with_nothing_in_it_records_nothing", () => {
    // An empty attribution must read as "not recorded", not as an attribution
    // to nobody — the History strip keys off NULL to stay quiet.
    const db = freshRoom();
    const s = stageArtifact(db, "Bare.md", "text/markdown", Buffer.from("x"), "x", {});
    const [file] = commitStaged(db, s.id);
    expect(fileProvenance(db, file.id)).toBeNull();
    const stored = db.prepare("SELECT provenance FROM files WHERE id = ?").get(file.id) as {
      provenance: string | null;
    };
    expect(stored.provenance).toBeNull();
  });

  // Not in the Rust suite — the cap branch has no test there at all.
  it("refuses an artifact past MAX_ARTIFACT_BYTES without touching the room", () => {
    const db = freshRoom();
    const huge = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    expect(() =>
      stageArtifact(db, "Big.bin", "application/octet-stream", huge, null, prov())
    ).toThrow(/came out at 64 MB, past the 64 MB limit/);
    expect(listFiles(db)).toHaveLength(0);
    expect(sweepStagedArtifacts(db)).toBe(0);
  });
});

// These two exist because TypeScript has no `#[serde(skip_serializing_if)]`
// and no `from_str(…).ok()` — the shape they reproduce is what a `.roomai`
// written by the Rust app already holds on disk.
describe("provenance JSON codec", () => {
  it("omits every empty field, and records nothing at all when all are empty", () => {
    expect(provenanceToJson({})).toBeNull();
    expect(provenanceToJson({ sourceFileIds: [] })).toBeNull();
    expect(JSON.parse(provenanceToJson({ runId: "r1" }) as string)).toEqual({ runId: "r1" });
    expect(
      JSON.parse(provenanceToJson({ agent: "Documents agent", sourceFileIds: [] }) as string)
    ).toEqual({ agent: "Documents agent" });
  });

  it("round-trips a full provenance", () => {
    const p = prov();
    expect(provenanceFromJson(provenanceToJson(p) as string)).toEqual(p);
  });

  it("reads absence, not a throw, out of anything that is not a Provenance", () => {
    // `serde_json::from_str::<Provenance>(j).ok()` answers None for every one
    // of these, and a corrupt attribution must never be the reason a file
    // fails to open.
    expect(provenanceFromJson("not json at all")).toBeNull();
    expect(provenanceFromJson("[1,2,3]")).toBeNull();
    expect(provenanceFromJson("null")).toBeNull();
    expect(provenanceFromJson('{"runId": 7}')).toBeNull();
    expect(provenanceFromJson('{"sourceFileIds": "src-1"}')).toBeNull();
    expect(provenanceFromJson('{"sourceFileIds": ["ok", 3]}')).toBeNull();
  });

  it("drops unknown keys instead of carrying them back out", () => {
    // serde ignores fields it does not know. A `JSON.parse(j) as Provenance`
    // would keep them, and the next write would hand them straight back to
    // disk under this app's name.
    expect(provenanceFromJson('{"runId":"r1","secretNote":"the user typed this"}')).toEqual({
      runId: "r1",
    });
  });

  it("reads a null field as not-recorded", () => {
    expect(provenanceFromJson('{"runId":"r1","agent":null,"tool":null}')).toEqual({ runId: "r1" });
    expect(provenanceFromJson("{}")).toEqual({});
  });

  it("survives a provenance column written by hand", () => {
    // The end-to-end version of the above: `setFileProvenance` takes raw JSON
    // (that is how restore-a-version copies an old attribution across), so
    // `fileProvenance` has to cope with whatever is actually in the column.
    const db = freshRoom();
    const file = insertFile(db, "brief.md", "text/markdown", Buffer.from("x"), "x", "generated");
    setFileProvenance(db, file.id, '{"agent":"Documents agent","sourceFileIds":["a","b"]}');
    expect(fileProvenance(db, file.id)).toEqual({
      agent: "Documents agent",
      sourceFileIds: ["a", "b"],
    });

    setFileProvenance(db, file.id, "{ this is not json");
    expect(fileProvenance(db, file.id)).toBeNull();
  });

  it("gives a trashed file's provenance to nobody", () => {
    const db = freshRoom();
    const s = stageArtifact(db, "Brief.md", "text/markdown", Buffer.from("x"), "x", prov());
    const [file] = commitStaged(db, s.id);
    expect(fileProvenance(db, file.id)).toEqual(prov());

    db.prepare(
      "UPDATE files SET trashed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
    ).run(file.id);
    expect(fileProvenance(db, file.id)).toBeNull();
  });
});
