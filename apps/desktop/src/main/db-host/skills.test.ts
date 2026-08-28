/**
 * Vitest port of the `skills.rs` tests (`src-tauri/src/db/skills.rs`, `mod
 * tests`):
 *
 *   - skills_are_separate_from_room_files_and_resources_cascade
 *   - a_skill_name_that_differs_only_in_capitals_is_refused
 *   - writing_to_a_deleted_skill_fails_instead_of_claiming_success
 *   - deleting_a_resource_that_was_never_there_is_refused_not_reported_as_done
 *   - a_missing_resource_is_explained_in_words_and_lists_what_is_there
 *
 * DEVIATION from the Rust test module: it reuses `crate::db::mem()`, a
 * full-`SCHEMA` in-memory connection shared across the whole `db` module.
 * This port uses a REAL fixture room via `createRoom` (this repo's
 * established convention) — including for the cascade test, which depends on
 * `foreign_keys = ON` (which `createRoom` sets) actually being in effect for
 * `skill_resources`' `ON DELETE CASCADE` to fire at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoom } from "./open.js";
import {
  createSkill,
  deleteSkill,
  deleteSkillResource,
  findSkill,
  getSkill,
  getSkillResource,
  listSkillResources,
  listSkills,
  setSkillEnabled,
  updateSkill,
  upsertSkillResource,
} from "./skills.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-skills-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

describe("skills vs. room files, and the resource cascade", () => {
  it("skills_are_separate_from_room_files_and_resources_cascade", () => {
    const db = freshRoom();
    const id = createSkill(
      db,
      "review-contract",
      "Review contracts",
      "Do the work.",
      true,
      "user",
      "files.read"
    );
    upsertSkillResource(db, id, "references/policy.md", "reference", Buffer.from("policy"));
    expect(listSkills(db, false)[0]?.resourceCount).toBe(1);

    const fileCount = db.prepare("SELECT count(*) as n FROM files").get() as { n: number };
    expect(fileCount.n, "a skill must not become a room file").toBe(0);

    deleteSkill(db, id);
    const resourceCount = db.prepare("SELECT count(*) as n FROM skill_resources").get() as {
      n: number;
    };
    expect(resourceCount.n).toBe(0);

    db.close();
  });
});

describe("listSkills (not in the Rust suite; added for coverage)", () => {
  it("enabledOnly is the level-1 filter, and the list is ordered by name whatever the capitals", () => {
    // `enabledOnly` decides which skills' metadata is placed in EVERY ordinary
    // model turn — the Rust suite only ever calls `list_skills(conn, false)`,
    // so the flag it takes was never once observed to do anything.
    const db = freshRoom();
    // One capitalized name in the middle, on purpose: plain BINARY ordering
    // sorts every capital ahead of every lowercase letter, so it would hoist
    // "Mango" to the top and order the list by how each name was typed rather
    // than by what it says. Three all-lowercase names could not tell the two
    // collations apart.
    createSkill(db, "zebra", "d", "Do the work.", true, "user", "");
    createSkill(db, "apple", "d", "Do the work.", false, "user", "");
    createSkill(db, "Mango", "d", "Do the work.", true, "user", "");

    expect(listSkills(db, false).map((s) => s.name)).toEqual(["apple", "Mango", "zebra"]);
    expect(listSkills(db, true).map((s) => s.name)).toEqual(["Mango", "zebra"]);

    // …and the summary reports the flag it filtered on, rather than the
    // disabled skill riding along claiming to be on.
    expect(listSkills(db, false).map((s) => s.enabled)).toEqual([false, true, true]);

    // Turning one on moves it into the enabled list, through the same column.
    setSkillEnabled(db, findSkill(db, "apple")?.id as string, true);
    expect(listSkills(db, true).map((s) => s.name)).toEqual(["apple", "Mango", "zebra"]);

    db.close();
  });

  it("resourceCount is each skill's OWN file count", () => {
    // The existing cascade test asserts a count of 1 on a room holding exactly
    // one resource, so it could not tell the subquery from a constant.
    const db = freshRoom();
    const two = createSkill(db, "carries-two", "d", "Do the work.", true, "user", "");
    createSkill(db, "carries-none", "d", "Do the work.", true, "user", "");
    upsertSkillResource(db, two, "a.md", "reference", Buffer.from("a"));
    upsertSkillResource(db, two, "b.md", "reference", Buffer.from("b"));

    expect(
      Object.fromEntries(listSkills(db, false).map((s) => [s.name, s.resourceCount]))
    ).toEqual({ "carries-none": 0, "carries-two": 2 });

    db.close();
  });
});

describe("findSkill (not in the Rust suite; added for coverage)", () => {
  it("answers to an id as well as to a name, and to neither with null", () => {
    // Every caller that resolves what the model asked for goes through here,
    // and it takes `name_or_id` — but the Rust suite only ever passes a name,
    // so the `id = ?` half of that OR was never exercised.
    const db = freshRoom();
    const id = createSkill(db, "review", "d", "Do the work.", true, "user", "");

    expect(findSkill(db, id)?.name).toBe("review");
    expect(findSkill(db, "REVIEW")?.id).toBe(id);
    expect(findSkill(db, "no-such-skill")).toBeNull();

    db.close();
  });
});

describe("case-only name clashes", () => {
  // Two skills whose names differ only in capitals are indistinguishable to
  // `findSkill`, which matches `lower(name)` and takes the first row — so the
  // room can hold "Legal" and "legal" and the wrong one quietly runs.
  it("a_skill_name_that_differs_only_in_capitals_is_refused", () => {
    const db = freshRoom();
    const id = createSkill(db, "Legal", "Contracts", "Do the work.", true, "user", "");
    expect(
      () => createSkill(db, "legal", "Other", "Something else.", true, "user", ""),
      "a case-only duplicate was accepted"
    ).toThrow("already exists");

    // A rename is still allowed to change only the capitalization…
    updateSkill(db, id, "LEGAL", "Contracts", "Do the work.", "");
    expect(findSkill(db, "legal")?.name).toBe("LEGAL");

    // …but must not collide with a DIFFERENT skill.
    const other = createSkill(db, "Tax", "Tax", "Do the work.", true, "user", "");
    expect(() => updateSkill(db, other, "legal", "Tax", "Do the work.", "")).toThrow();

    db.close();
  });
});

describe("writes to a deleted skill fail instead of claiming success", () => {
  // AUDIT 175. `UPDATE … WHERE id=?` against a row that is no longer there
  // changes nothing and reports success, so a skill deleted while its editor
  // was open answered "Saved" and kept none of what was typed. Turning one on
  // behaved the same way, and both told the assistant its write had landed.
  it("writing_to_a_deleted_skill_fails_instead_of_claiming_success", () => {
    const db = freshRoom();
    const id = createSkill(db, "gone", "d", "Do the work.", true, "user", "");
    deleteSkill(db, id);

    expect(
      () => updateSkill(db, id, "gone", "d", "Edited text.", ""),
      "saving a deleted skill reported success"
    ).toThrow("no longer exists");
    expect(
      () => setSkillEnabled(db, id, false),
      "disabling a deleted skill reported success"
    ).toThrow("no longer exists");

    // A live skill is untouched by the guard.
    const live = createSkill(db, "here", "d", "Do the work.", false, "user", "");
    updateSkill(db, live, "here", "d", "Edited text.", "");
    setSkillEnabled(db, live, true);
    expect(getSkill(db, live).enabled).toBe(true);

    db.close();
  });
});

describe("resource deletes are also refused, not reported as done", () => {
  // The same defect one level down: a resource DELETE that matched no row
  // reported success, and the tool above it told the model it had removed a
  // file the skill never had.
  it("deleting_a_resource_that_was_never_there_is_refused_not_reported_as_done", () => {
    const db = freshRoom();
    const id = createSkill(db, "review", "d", "Do the work.", true, "user", "");
    upsertSkillResource(db, id, "references/policy.md", "reference", Buffer.from("policy"));

    expect(
      () => deleteSkillResource(db, id, "references/old-policy.md"),
      "deleting a path the skill never had reported success"
    ).toThrow("no file at references/old-policy.md");

    // The file that IS there still goes, and only once.
    deleteSkillResource(db, id, "references/policy.md");
    expect(() => deleteSkillResource(db, id, "references/policy.md")).toThrow();
    expect(listSkillResources(db, id)).toEqual([]);

    db.close();
  });
});

describe("skill resources (not in the Rust suite; added for coverage)", () => {
  it("upserting the same path replaces its bytes rather than adding a second row", () => {
    // The UPSERT is what makes "save this file again" work at all. Nothing in
    // the Rust suite writes the same path twice, so the `DO UPDATE SET` half of
    // the statement — the half that carries the new CONTENT — was never run.
    const db = freshRoom();
    const id = createSkill(db, "review", "d", "Do the work.", true, "user", "");
    upsertSkillResource(db, id, "references/policy.md", "reference", Buffer.from("first draft"));
    upsertSkillResource(db, id, "references/policy.md", "script", Buffer.from("second draft"));

    const all = listSkillResources(db, id);
    expect(all.length, "the second save added a row instead of replacing one").toBe(1);
    expect(all[0]?.content.toString()).toBe("second draft");
    expect(all[0]?.kind).toBe("script");
    expect(listSkills(db, false)[0]?.resourceCount).toBe(1);

    db.close();
  });

  it("lists a skill's files in path order, whatever order they were added in", () => {
    // A skill's file list is read by the model as "what travels with me", and
    // `missingResource` prints it verbatim when a path is wrong. Insertion
    // order would make that sentence differ between two identical skills.
    const db = freshRoom();
    const id = createSkill(db, "review", "d", "Do the work.", true, "user", "");
    upsertSkillResource(db, id, "notes.md", "reference", Buffer.from("n"));
    upsertSkillResource(db, id, "References/policy.md", "reference", Buffer.from("p"));
    upsertSkillResource(db, id, "assets/logo.svg", "asset", Buffer.from("l"));

    // COLLATE NOCASE, so a capitalized folder sorts by its letters — BINARY
    // would hoist "References/" above both lowercase paths.
    expect(listSkillResources(db, id).map((r) => r.path)).toEqual([
      "assets/logo.svg",
      "notes.md",
      "References/policy.md",
    ]);

    db.close();
  });
});

describe("a missing resource is explained in words, and lists what is there", () => {
  // A skill whose SKILL.md names a file nobody bundled: the model was handed
  // SQLite's "Query returned no rows" as the whole answer.
  it("a_missing_resource_is_explained_in_words_and_lists_what_is_there", () => {
    const db = freshRoom();
    const id = createSkill(db, "review", "d", "Do the work.", true, "user", "");
    upsertSkillResource(db, id, "references/policy.md", "reference", Buffer.from("policy"));

    let err: Error | undefined;
    try {
      getSkillResource(db, id, "references/risk-policy.md");
    } catch (e) {
      err = e as Error;
    }
    expect(err, "a missing resource read as a row").toBeDefined();
    expect(err?.message).not.toContain("Query returned no rows");
    expect(err?.message).toContain('"review" has no file at references/risk-policy.md');
    expect(err?.message, `what it does carry is missing: ${err?.message}`).toContain(
      "references/policy.md"
    );

    // A skill that bundles nothing says that rather than listing an empty set.
    const bare = createSkill(db, "bare", "d", "Do the work.", true, "user", "");
    expect(() => getSkillResource(db, bare, "notes.md")).toThrow("no files travel with it");

    // And a resource that IS there is still returned.
    expect(getSkillResource(db, id, "references/policy.md").content.toString()).toBe("policy");

    db.close();
  });
});
