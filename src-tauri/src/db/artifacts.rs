use super::*;

// ---------------------------------------------------------------- ART-1: staged artifact writes
//
// "Ask before AI edits files" is OFF by the owner's decision, so the app writes
// generated documents into the room without asking first. Two things have to be
// true for that to be safe rather than merely convenient:
//
//   1. a write that does not FINISH must not be visible at all — no truncated
//      document, no half-written page the library shows as if it were the work;
//   2. a write that finishes over an earlier artifact must not destroy it.
//
// This module is (1). Bytes are staged in `staged_artifacts`, validated there,
// and only a single transaction moves them into `files`. (2) is the versioning
// in `commit_staged`, which routes a regeneration through the existing ADD-2
// snapshot path instead of `available_name`'s duplicate-numbering.

/// The largest artifact the funnel will stage. A generated document is text a
/// model produced; anything past this is a runaway loop, not a deliverable, and
/// staging it would only move the problem into the room's page cache. Imports
/// and downloads have their own (much larger) caps and do not come through here.
const MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;

/// What produced a generated artifact. Ids and names ONLY — a run id, the
/// agent/tool that wrote it, the ids of the files it read. Never a line of the
/// content itself and never anything the user typed: this is recorded so the
/// History strip can say where a version came from, and provenance that carried
/// room content would be a copy of the room in a place nothing encrypts twice.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// The job/ask run this write belongs to, when the caller has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Which agent or command produced it ("Documents agent", "#minutes").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The tool call that wrote it, when one did ("create_file").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Ids of the room files this artifact was made FROM.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_file_ids: Vec<String>,
}

impl Provenance {
    /// A provenance with nothing in it records nothing: `None` is stored so the
    /// History strip stays silent rather than showing an empty attribution.
    ///
    /// `pub(crate)` for the one write that cannot go through the funnel: the
    /// shared scratch pad is get-or-create over ANY source, so it records its
    /// provenance by hand (see `agent.rs`, "create_file").
    pub(crate) fn to_json(&self) -> Option<String> {
        if self == &Provenance::default() {
            return None;
        }
        serde_json::to_string(self).ok()
    }
}

/// A staged artifact: the id of its staging row plus the name it wants. The
/// bytes stay in the database — the caller never has to hold them a second time
/// to commit them.
#[derive(Debug)]
pub struct Staged {
    pub id: String,
    pub name: String,
}

/// Stage an artifact's bytes and validate them. Nothing in `files` changes here,
/// so every failure below leaves the room exactly as it was.
///
/// Validation is deliberately about the WRITE, not about taste: an empty
/// artifact and a nameless one are the two ways a generator reports work it did
/// not do, and both must fail loudly at the door rather than land as a real file
/// somebody later has to disprove.
pub fn stage_artifact(
    conn: &Connection,
    name: &str,
    mime: &str,
    bytes: &[u8],
    text: Option<&str>,
    provenance: &Provenance,
) -> Result<Staged, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("An artifact needs a file name before it can be saved.".into());
    }
    if bytes.is_empty() {
        return Err(format!(
            "Nothing was generated for \"{name}\" — it was not saved. \
             (An empty file would look like finished work.)"
        ));
    }
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Err(format!(
            "\"{name}\" came out at {} MB, past the {} MB limit for a generated file — \
             it was not saved.",
            bytes.len() / 1_048_576,
            MAX_ARTIFACT_BYTES / 1_048_576
        ));
    }
    let id = Uuid::new_v4().to_string();
    execute_one(
        conn,
        "INSERT INTO staged_artifacts(id, name, mime, bytes, text, provenance)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, mime, bytes, text, provenance.to_json()],
    )?;
    Ok(Staged { id, name: name.to_string() })
}

/// Throw a staged artifact away, committing nothing. Used when the run that
/// staged it was cancelled or failed after staging.
pub fn discard_staged(conn: &Connection, staging_id: &str) -> Result<(), String> {
    execute_one(conn, "DELETE FROM staged_artifacts WHERE id = ?1", [staging_id])
}

/// Commit a staged artifact into the room, atomically.
///
/// Regeneration is a VERSION, not a duplicate. When a non-trashed GENERATED file
/// already holds this exact name, the new bytes go through the ADD-2 write path
/// (`snapshot_file_version` + `update_file_content`), so the previous artifact
/// becomes v-1 in History and the user still has one file. When the name is held
/// by something a PERSON put in the room, or by nothing at all, the artifact is
/// inserted under the next free name — versioning over a user's own file would
/// be an AI silently rewriting work it did not make.
///
/// Returns the committed file and whether this was a new version of an existing
/// artifact (true) or a fresh file (false).
///
/// The whole move is one transaction: the snapshot, the content write, the
/// provenance, and the removal of the staging row either all happen or none do.
/// A crash mid-commit therefore leaves the old artifact intact AND the staging
/// row still there for the sweep — never a file half-way between two versions.
pub fn commit_staged(conn: &Connection, staging_id: &str) -> Result<(FileMeta, bool), String> {
    let staged: (String, String, Vec<u8>, Option<String>, Option<String>) = query_opt(
        conn,
        "SELECT name, mime, bytes, text, provenance FROM staged_artifacts WHERE id = ?1",
        [staging_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?
    .ok_or("That generated file is no longer staged — nothing was saved.")?;
    let (name, mime, bytes, text, provenance) = staged;

    in_transaction(conn, || {
        // Which earlier artifact IS this one. The match is on the name the
        // generator ASKED for, not on the name its output ended up under: when a
        // person's file already holds "Plan.md", the first generation lands as
        // "Plan (2).md", and matching on the final name would make every later
        // run mint "Plan (3).md", "Plan (4).md" … — the duplicate spawning this
        // whole funnel exists to prevent. Files written before `artifact_key`
        // existed fall back to their name. Case-insensitively, because
        // `available_name` treats two names differing only in case as the same
        // one, so "deck.html" after "Deck.html" must be a version and not a
        // duplicate the library shows twice.
        let existing: Option<String> = query_opt(
            conn,
            "SELECT id FROM files
             WHERE source = 'generated' AND trashed_at IS NULL
               AND (lower(artifact_key) = lower(?1)
                    OR (artifact_key IS NULL AND lower(name) = lower(?1)))
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [&name],
            |r| r.get(0),
        )?;
        let (id, versioned) = match existing {
            Some(id) => {
                // The snapshot carries the OUTGOING content's provenance with
                // it, so History can say what made the version it is offering
                // to restore — not what made the one that replaced it.
                snapshot_file_version(conn, &id, "AI regenerated")?;
                update_file_content(conn, &id, &bytes, text.as_deref())?;
                (id, true)
            }
            None => {
                let free = available_name(conn, &name)?;
                let meta = insert_file(conn, &free, &mime, &bytes, text.as_deref(), "generated")?;
                (meta.id, false)
            }
        };
        execute_one(
            conn,
            "UPDATE files SET provenance = ?2, artifact_key = ?3 WHERE id = ?1",
            params![id, provenance, name],
        )?;
        execute_one(conn, "DELETE FROM staged_artifacts WHERE id = ?1", [staging_id])?;
        get_file_meta(conn, &id).map(|meta| (meta, versioned))
    })
}

/// Drop every staged artifact left over from a previous session and say how many
/// there were. Called on room open: a staging row that outlived its run belongs
/// to a generation that never finished, and the whole point of staging is that
/// such a write is not in the library — so nothing the user can see changes when
/// these rows go.
///
/// The count is returned for the tests, which is the only thing that reads it
/// today: `migrate()` discards it. Nothing is lost by that — an uncommitted
/// artifact was never in the library to begin with, so there is no vanishing act
/// to explain — but if a "N unfinished generations were discarded" line is ever
/// wanted on room open, this is where the number comes from.
pub fn sweep_staged_artifacts(conn: &Connection) -> Result<usize, String> {
    let n = conn
        .execute("DELETE FROM staged_artifacts", [])
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// The provenance recorded for a file's CURRENT content, if any. A trashed file
/// has none to give: `get_file_provenance` is a command the History strip calls
/// with whatever id the open tab is holding, and answering it would tell the
/// user which run wrote a file that is not in the room.
pub fn file_provenance(conn: &Connection, file_id: &str) -> Result<Option<Provenance>, String> {
    let raw: Option<Option<String>> = query_opt(
        conn,
        "SELECT provenance FROM files WHERE id = ?1 AND trashed_at IS NULL",
        [file_id],
        |r| r.get(0),
    )?;
    Ok(raw.flatten().and_then(|j| serde_json::from_str(&j).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prov() -> Provenance {
        Provenance {
            run_id: Some("run-1".into()),
            agent: Some("Documents agent".into()),
            tool: Some("create_file".into()),
            source_file_ids: vec!["src-1".into()],
        }
    }

    #[test]
    fn a_staged_write_that_never_commits_leaves_the_room_untouched() {
        // The crash/cancel case: bytes are staged, then the run dies. The
        // library must not have gained or changed anything.
        let conn = mem();
        let before = list_files(&conn).unwrap().len();
        let staged = stage_artifact(
            &conn,
            "Report.html",
            "text/html",
            b"<p>half a document</p>",
            Some("half a document"),
            &prov(),
        )
        .unwrap();
        assert_eq!(list_files(&conn).unwrap().len(), before, "staging adds no file");

        // A crash: nothing calls commit or discard. The next room open sweeps.
        assert_eq!(sweep_staged_artifacts(&conn).unwrap(), 1);
        assert_eq!(list_files(&conn).unwrap().len(), before);
        // And the staging id is gone, so a late commit cannot resurrect it.
        assert!(commit_staged(&conn, &staged.id).is_err());
    }

    #[test]
    fn a_cancelled_write_leaves_the_previous_artifact_whole() {
        let conn = mem();
        let first = stage_artifact(&conn, "Notes.md", "text/markdown", b"v1 body", Some("v1 body"), &prov())
            .unwrap();
        let (v1, versioned) = commit_staged(&conn, &first.id).unwrap();
        assert!(!versioned, "the first commit is a new file, not a version");

        // A second run stages a regeneration, then is cancelled before commit.
        let second =
            stage_artifact(&conn, "Notes.md", "text/markdown", b"v2 body", Some("v2 body"), &prov())
                .unwrap();
        discard_staged(&conn, &second.id).unwrap();

        let (_n, _m, bytes, text) = get_file_full(&conn, &v1.id).unwrap();
        assert_eq!(bytes.unwrap(), b"v1 body", "the original bytes survive a cancelled rerun");
        assert_eq!(text.unwrap(), "v1 body");
        assert!(list_file_versions(&conn, &v1.id).unwrap().is_empty(), "and no version was cut");
        assert_eq!(list_files(&conn).unwrap().len(), 1, "no 'Notes (2).md' either");
    }

    #[test]
    fn regeneration_makes_v2_instead_of_overwriting_or_duplicating() {
        let conn = mem();
        let a = stage_artifact(&conn, "Deck.html", "text/html", b"deck one", Some("deck one"), &prov())
            .unwrap();
        let (file, _) = commit_staged(&conn, &a.id).unwrap();

        let b = stage_artifact(&conn, "Deck.html", "text/html", b"deck two", Some("deck two"), &prov())
            .unwrap();
        let (again, versioned) = commit_staged(&conn, &b.id).unwrap();

        assert!(versioned);
        assert_eq!(again.id, file.id, "same file — not a second row");
        assert_eq!(again.name, "Deck.html", "and not 'Deck (2).html'");
        assert_eq!(list_files(&conn).unwrap().len(), 1);

        // The earlier deck is still reachable, and the current one is the new.
        let versions = list_file_versions(&conn, &file.id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].cause, "AI regenerated");
        let (_, old_bytes, old_text, _) = get_version(&conn, &versions[0].id).unwrap();
        assert_eq!(old_bytes, b"deck one");
        assert_eq!(old_text.unwrap(), "deck one");
        assert_eq!(get_file_extracted_text(&conn, &file.id).unwrap(), "deck two");
    }

    #[test]
    fn a_users_own_file_is_never_versioned_over() {
        // Only files the app GENERATED are regenerated in place. A name held by
        // something a person imported gets the duplicate-numbering treatment, so
        // an unattended AI write cannot rewrite the user's own document.
        let conn = mem();
        let mine = insert_file(&conn, "Plan.md", "text/markdown", b"my plan", Some("my plan"), "upload")
            .unwrap();
        let s = stage_artifact(&conn, "Plan.md", "text/markdown", b"ai plan", Some("ai plan"), &prov())
            .unwrap();
        let (made, versioned) = commit_staged(&conn, &s.id).unwrap();

        assert!(!versioned);
        assert_ne!(made.id, mine.id);
        assert_eq!(made.name, "Plan (2).md");
        assert_eq!(get_file_extracted_text(&conn, &mine.id).unwrap(), "my plan");
        assert!(list_file_versions(&conn, &mine.id).unwrap().is_empty());
    }

    #[test]
    fn regenerating_beside_a_users_file_versions_the_copy_it_already_made() {
        // The case the "(2)" answer above only half-solves. Once the artifact has
        // stepped aside to "Plan (2).md", every LATER run has to find that file
        // again — matching on the requested name and nothing else would mint
        // "Plan (3).md", "Plan (4).md" … one per run, which is exactly the
        // duplicate spawning the funnel exists to prevent.
        let conn = mem();
        insert_file(&conn, "Plan.md", "text/markdown", b"my plan", Some("my plan"), "upload").unwrap();
        let mut ids = Vec::new();
        for pass in 0..3 {
            let body = format!("ai plan {pass}");
            let s =
                stage_artifact(&conn, "Plan.md", "text/markdown", body.as_bytes(), Some(&body), &prov())
                    .unwrap();
            let (meta, versioned) = commit_staged(&conn, &s.id).unwrap();
            assert_eq!(meta.name, "Plan (2).md", "pass {pass} stepped aside AGAIN");
            assert_eq!(versioned, pass > 0, "pass {pass} versioned = {versioned}");
            ids.push(meta.id);
        }
        assert_eq!(ids[0], ids[2], "three runs, one artifact");
        assert_eq!(list_files(&conn).unwrap().len(), 2, "the user's file and the artifact — no more");
        assert_eq!(get_file_extracted_text(&conn, &ids[0]).unwrap(), "ai plan 2");
        // And every earlier generation is still reachable.
        assert_eq!(list_file_versions(&conn, &ids[0]).unwrap().len(), 2);
    }

    #[test]
    fn a_name_that_comes_back_in_a_different_case_is_the_same_artifact() {
        // Models do not capitalise deterministically. `available_name` already
        // treats "deck.html" and "Deck.html" as the same name (the library lists
        // both and nobody can tell them apart), so the version match has to agree
        // — otherwise a stray capital is enough to spawn "deck (2).html".
        let conn = mem();
        let a = stage_artifact(&conn, "Deck.html", "text/html", b"one", Some("one"), &prov()).unwrap();
        let (first, _) = commit_staged(&conn, &a.id).unwrap();
        let b = stage_artifact(&conn, "deck.html", "text/html", b"two", Some("two"), &prov()).unwrap();
        let (again, versioned) = commit_staged(&conn, &b.id).unwrap();

        assert!(versioned);
        assert_eq!(again.id, first.id);
        assert_eq!(list_files(&conn).unwrap().len(), 1, "no 'deck (2).html'");
    }

    #[test]
    fn renaming_an_artifact_takes_it_out_of_the_generators_reach() {
        // Giving a generated file your own name is how you adopt it. The next run
        // must mint its own file rather than version over the copy you kept —
        // History is a net, but it is not consent to keep rewriting a document
        // the user has claimed.
        let conn = mem();
        let a = stage_artifact(&conn, "Minutes.md", "text/markdown", b"first", Some("first"), &prov())
            .unwrap();
        let (mine, _) = commit_staged(&conn, &a.id).unwrap();
        rename_file(&conn, &mine.id, "Board minutes — August.md").unwrap();

        let b = stage_artifact(&conn, "Minutes.md", "text/markdown", b"second", Some("second"), &prov())
            .unwrap();
        let (fresh, versioned) = commit_staged(&conn, &b.id).unwrap();

        assert!(!versioned);
        assert_ne!(fresh.id, mine.id);
        assert_eq!(fresh.name, "Minutes.md");
        assert_eq!(
            get_file_extracted_text(&conn, &mine.id).unwrap(),
            "first",
            "the file the user renamed was left alone"
        );
        assert!(list_file_versions(&conn, &mine.id).unwrap().is_empty());
    }

    #[test]
    fn provenance_is_recorded_for_the_head_and_carried_onto_the_version() {
        let conn = mem();
        let one = Provenance {
            run_id: Some("run-1".into()),
            agent: Some("Documents agent".into()),
            tool: None,
            source_file_ids: vec!["src-a".into()],
        };
        let two = Provenance {
            run_id: Some("run-2".into()),
            agent: Some("Research agent".into()),
            tool: None,
            source_file_ids: vec!["src-b".into(), "src-c".into()],
        };
        let a = stage_artifact(&conn, "Brief.md", "text/markdown", b"one", Some("one"), &one).unwrap();
        let (file, _) = commit_staged(&conn, &a.id).unwrap();
        assert_eq!(file_provenance(&conn, &file.id).unwrap().unwrap(), one);

        let b = stage_artifact(&conn, "Brief.md", "text/markdown", b"two", Some("two"), &two).unwrap();
        commit_staged(&conn, &b.id).unwrap();
        assert_eq!(file_provenance(&conn, &file.id).unwrap().unwrap(), two, "head moves to run-2");

        // The snapshot kept run-1 with the bytes run-1 made.
        let versions = list_file_versions(&conn, &file.id).unwrap();
        let raw: Option<String> = conn
            .query_row("SELECT provenance FROM file_versions WHERE id = ?1", [&versions[0].id], |r| r.get(0))
            .unwrap();
        let on_version: Provenance = serde_json::from_str(&raw.unwrap()).unwrap();
        assert_eq!(on_version, one);
    }

    #[test]
    fn empty_and_nameless_artifacts_are_refused_at_the_door() {
        let conn = mem();
        let err = stage_artifact(&conn, "Empty.md", "text/markdown", b"", None, &prov()).unwrap_err();
        assert!(err.contains("Nothing was generated"), "got: {err}");
        assert!(stage_artifact(&conn, "   ", "text/plain", b"x", None, &prov()).is_err());
        assert!(list_files(&conn).unwrap().is_empty(), "a refused write creates nothing");
        assert_eq!(sweep_staged_artifacts(&conn).unwrap(), 0, "and stages nothing");
    }

    #[test]
    fn provenance_with_nothing_in_it_records_nothing() {
        // An empty attribution must read as "not recorded", not as an
        // attribution to nobody — the History strip keys off NULL to stay quiet.
        let conn = mem();
        let s = stage_artifact(&conn, "Bare.md", "text/markdown", b"x", Some("x"), &Provenance::default())
            .unwrap();
        let (file, _) = commit_staged(&conn, &s.id).unwrap();
        assert!(file_provenance(&conn, &file.id).unwrap().is_none());
    }

}
