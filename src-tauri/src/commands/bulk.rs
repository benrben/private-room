//! Batch file operations — one call, many files, one honest receipt.
//!
//! Two callers share this module, and that sharing is the point:
//!
//!   * the Library's multi-selection (move / trash / restore / destroy a set of
//!     rows the user picked), and
//!   * the File agent's organize tools (`organize_files`, `trash_files`).
//!
//! Written once so the two can never drift. A room where "the AI moved it"
//! behaves differently from "I moved it" is a room with two file systems in it,
//! and the difference would only ever surface as a bug report weeks later.
//!
//! WHY BATCHING IS A BACKEND CONCERN AT ALL. Looping the single-file commands
//! from the frontend "works", and it is what the UI did before this module: N
//! room-lock acquisitions, N `room-files-changed` emits — so N full re-renders
//! of a list the user is watching — and, on a partial failure, N toasts and a
//! half-done room nobody described. One command gives one lock, one emit, and
//! one sentence that is true.
//!
//! WHY THESE ARE BEST-EFFORT AND `edit_files` IS ATOMIC. `edit_files` refuses
//! the whole change when one edit cannot match, because a cross-file edit that
//! half-lands leaves the room's CONTENT inconsistent — a rename applied but its
//! references not. Moving or trashing files has no such coupling: each file is
//! independent, so aborting 40 good moves because the 41st file was deleted in
//! another window would be the destructive choice, not the safe one. Each file
//! keeps its own transaction (`db::trash_file` and friends open one), which is
//! the right atomicity granularity here, and the failures are REPORTED rather
//! than swallowed or fatal.

use super::*;

/// Ceiling on one batch.
///
/// Not a performance number — a blast radius. The agent reaches these same
/// functions, and "tidy up the room" against a model that miscounted must not
/// be able to sweep an unbounded number of files in one round. The caller is
/// TOLD when the cap bites (see [`BulkReport::capped`]); a silently truncated
/// batch would report success over work it never did, which is the one failure
/// mode this whole module exists to prevent.
pub(crate) const MAX_BULK_FILES: usize = 200;

/// One file a batch could not act on, and why.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BulkFailure {
    /// The file's name when we could still read it, else the id — never blank.
    /// A failure row the user cannot tie to a file is not a failure report.
    pub name: String,
    pub error: String,
}

/// What a batch actually did. Every field is a fact read back from the
/// database, never an assumption from the input list.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BulkReport {
    /// Names of the files that really changed, in the order they were given.
    pub ok: Vec<String>,
    /// The ones that did not, each with its own reason.
    pub failed: Vec<BulkFailure>,
    /// Ids beyond [`MAX_BULK_FILES`] that were never attempted. Zero normally.
    pub capped: usize,
}

impl BulkReport {
    fn note_ok(&mut self, name: String) {
        self.ok.push(name);
    }

    fn note_failed(&mut self, name: String, error: String) {
        self.failed.push(BulkFailure { name, error });
    }

    /// Did anything at all change? The callers use this to decide whether to
    /// emit `room-files-changed` — an all-failed batch must not tell the UI to
    /// re-read a room nothing happened to.
    pub(crate) fn changed_anything(&self) -> bool {
        !self.ok.is_empty()
    }

    /// A one-line receipt: what happened, in the words the user gets.
    /// `verb_past` completes "<n> files <verb_past>" (e.g. "moved to the trash").
    pub(crate) fn sentence(&self, verb_past: &str) -> String {
        let mut out = match self.ok.len() {
            0 => format!("Nothing was {verb_past}."),
            1 => format!("\"{}\" {verb_past}.", self.ok[0]),
            n => format!("{n} files {verb_past}."),
        };
        if !self.failed.is_empty() {
            // Name them. "3 files could not be moved" with no names leaves the
            // user to diff two lists by eye to find out which.
            let detail: Vec<String> = self
                .failed
                .iter()
                .take(10)
                .map(|f| format!("\"{}\" ({})", f.name, f.error))
                .collect();
            out.push_str(&format!(
                " {} could not be: {}",
                self.failed.len(),
                detail.join("; ")
            ));
            if self.failed.len() > 10 {
                out.push_str(&format!(" …and {} more", self.failed.len() - 10));
            }
            out.push('.');
        }
        if self.capped > 0 {
            out.push_str(&format!(
                " {} more were not attempted — one batch handles at most {MAX_BULK_FILES} files.",
                self.capped
            ));
        }
        out
    }
}

/// Split the caller's id list at [`MAX_BULK_FILES`], de-duplicating as it goes.
///
/// Duplicates matter: the same id twice would be reported twice, and for trash
/// the second pass fails ("already in the trash") — turning a harmless
/// double-click, or a model repeating itself, into a receipt that claims a
/// failure that did not happen.
fn take_capped(ids: &[String]) -> (Vec<String>, usize) {
    let mut seen = HashSet::new();
    let unique: Vec<String> = ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
        .cloned()
        .collect();
    let capped = unique.len().saturating_sub(MAX_BULK_FILES);
    let mut kept = unique;
    kept.truncate(MAX_BULK_FILES);
    (kept, capped)
}

/// Run `op` over each id, naming each file before it is touched.
///
/// The name is read FIRST on purpose: after a successful trash or destroy the
/// row is gone or hidden, and a receipt assembled afterwards could only print
/// ids. `db::any_file_name` is used rather than `get_file_name` because restore
/// and destroy operate on rows that are, by definition, already trashed.
fn each_file(
    conn: &Connection,
    ids: &[String],
    mut op: impl FnMut(&Connection, &str) -> Result<(), String>,
) -> BulkReport {
    let (ids, capped) = take_capped(ids);
    let mut report = BulkReport {
        capped,
        ..Default::default()
    };
    for id in &ids {
        let name = db::any_file_name(conn, id).unwrap_or_else(|| id.clone());
        match op(conn, id) {
            Ok(()) => report.note_ok(name),
            Err(e) => report.note_failed(name, e),
        }
    }
    report
}

// ---------------------------------------------------------------- the four verbs

/// Move a set of files to the trash, attributed to `actor`.
///
/// `actor` is not defaulted: the trash view's whole job is answering "who
/// deleted this", and the UI path and the agent path pass genuinely different
/// answers ([`db::TrashActor::User`] vs [`db::TrashActor::Agent`]). A default
/// here would let a new caller be silently mis-attributed to the person.
pub(crate) fn trash_files_in(
    conn: &Connection,
    ids: &[String],
    actor: db::TrashActor<'_>,
) -> BulkReport {
    each_file(conn, ids, |c, id| db::trash_file(c, id, actor))
}

/// Move a set of files into `folder_id` (None = the top level).
pub(crate) fn move_files_in(
    conn: &Connection,
    ids: &[String],
    folder_id: Option<&str>,
) -> BulkReport {
    each_file(conn, ids, |c, id| db::move_file_to_folder(c, id, folder_id))
}

/// Put a set of trashed files back in the library.
pub(crate) fn restore_files_in(conn: &Connection, ids: &[String]) -> BulkReport {
    each_file(conn, ids, db::restore_file)
}

/// Destroy a set of trashed files for good.
///
/// Keeps [`super::delete_file_permanently`]'s invariant per file: only
/// something ALREADY in the trash can be destroyed, so no batch — however it
/// was assembled, and whoever assembled it — can take a file from the library
/// to gone in one step. The check is here rather than in the caller precisely
/// because there is now more than one caller.
pub(crate) fn destroy_files_in(conn: &Connection, ids: &[String]) -> BulkReport {
    each_file(conn, ids, |c, id| {
        let trashed: bool = c
            .query_row(
                "SELECT count(*) FROM files WHERE id = ?1 AND trashed_at IS NOT NULL",
                [id],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?
            > 0;
        if !trashed {
            return Err("Only a file already in the trash can be deleted permanently.".into());
        }
        db::delete_file(c, id)
    })
}

// ---------------------------------------------------------------- the commands

/// Move several files to the trash in one step. The multi-selection's Remove.
///
/// Recording safety is per file and comes first: `stop_recording_into` for each
/// id, exactly as the single-file [`super::trash_file`] does. Trashing the file
/// a live recording is still writing into would otherwise leave an engine
/// appending to a row that has left the library.
#[tauri::command]
pub fn trash_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    rec: State<'_, super::RecState>,
    ids: Vec<String>,
) -> Result<BulkReport, String> {
    for id in &ids {
        super::files::stop_recording_into(&rec, id);
    }
    // A Tauri command invoked from the window IS the person — same reasoning as
    // the single-file path, where ADD-25 blocks the agent driver from clicking a
    // destructive confirm. The agent's own batch goes through
    // `trash_files_in(.., TrashActor::Agent(..))` and is labelled as such.
    let report =
        state.with_room(|room| Ok(trash_files_in(&room.conn, &ids, db::TrashActor::User)))?;
    emit_if_changed(&app, &report);
    Ok(report)
}

/// Move several files into one folder (or to the top level).
#[tauri::command]
pub fn move_files_to_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    file_ids: Vec<String>,
    folder_id: Option<String>,
) -> Result<BulkReport, String> {
    let report = state
        .with_room(|room| Ok(move_files_in(&room.conn, &file_ids, folder_id.as_deref())))?;
    emit_if_changed(&app, &report);
    Ok(report)
}

/// Put several trashed files back.
#[tauri::command]
pub fn restore_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<BulkReport, String> {
    let report = state.with_room(|room| Ok(restore_files_in(&room.conn, &ids)))?;
    emit_if_changed(&app, &report);
    Ok(report)
}

/// Destroy several trashed files for good.
#[tauri::command]
pub fn delete_files_permanently(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    rec: State<'_, super::RecState>,
    ids: Vec<String>,
) -> Result<BulkReport, String> {
    for id in &ids {
        super::files::stop_recording_into(&rec, id);
    }
    let report = state.with_room(|room| Ok(destroy_files_in(&room.conn, &ids)))?;
    emit_if_changed(&app, &report);
    Ok(report)
}

/// Tell the room to re-read itself — but only when something actually changed.
/// An all-failed batch that emitted anyway would make the library flash and
/// re-render to show the identical list, which reads as "something happened".
fn emit_if_changed(app: &tauri::AppHandle, report: &BulkReport) {
    if report.changed_anything() {
        use tauri::Emitter;
        let _ = app.emit("room-files-changed", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room() -> Connection {
        db::open_in_memory_schema()
    }

    fn add(conn: &Connection, name: &str) -> String {
        db::insert_file(conn, name, "text/plain", b"body", Some("body"), "test")
            .unwrap()
            .id
    }

    #[test]
    fn a_partial_failure_reports_both_halves() {
        // The whole contract: good files move, the bad one is NAMED, and the
        // batch does not abort. This is the behaviour that differs from
        // `edit_files`, so it is the one worth pinning.
        let conn = room();
        let a = add(&conn, "a.txt");
        let b = add(&conn, "b.txt");
        let report = trash_files_in(&conn, &[a, b.clone()], db::TrashActor::User);
        assert_eq!(report.ok.len(), 2);
        // Trashing b a second time fails — it is already there.
        let again = trash_files_in(&conn, &[b], db::TrashActor::User);
        assert!(again.ok.is_empty());
        assert_eq!(again.failed.len(), 1);
        assert_eq!(again.failed[0].name, "b.txt", "a failure names its file");
        assert!(!again.changed_anything(), "nothing changed → no room event");
    }

    #[test]
    fn duplicate_ids_are_collapsed_not_double_reported() {
        // A double-click, or a model repeating itself, must not produce a
        // receipt that invents a failure ("already in the trash") for work the
        // user only asked for once.
        let conn = room();
        let a = add(&conn, "a.txt");
        let report = trash_files_in(&conn, &[a.clone(), a], db::TrashActor::User);
        assert_eq!(report.ok, vec!["a.txt"]);
        assert!(report.failed.is_empty());
    }

    #[test]
    fn the_cap_is_reported_never_silent() {
        let conn = room();
        let ids: Vec<String> = (0..MAX_BULK_FILES + 5)
            .map(|i| add(&conn, &format!("f{i}.txt")))
            .collect();
        let report = trash_files_in(&conn, &ids, db::TrashActor::User);
        assert_eq!(report.ok.len(), MAX_BULK_FILES);
        assert_eq!(report.capped, 5);
        assert!(
            report.sentence("moved to the trash").contains("not attempted"),
            "a truncated batch must say so in the receipt"
        );
    }

    #[test]
    fn destroy_refuses_a_file_that_is_not_in_the_trash() {
        // Library → gone in one step must be impossible from the batch path
        // too, not only from the single-file command.
        let conn = room();
        let a = add(&conn, "a.txt");
        let report = destroy_files_in(&conn, std::slice::from_ref(&a));
        assert!(report.ok.is_empty());
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].error.contains("already in the trash"));
        // Trash it first and the same call succeeds.
        trash_files_in(&conn, std::slice::from_ref(&a), db::TrashActor::User);
        assert_eq!(destroy_files_in(&conn, &[a]).ok.len(), 1);
    }

    #[test]
    fn restore_and_destroy_can_still_name_a_trashed_file() {
        // `get_file_name` hides trashed rows, so a receipt built on it would
        // print ids here. `any_file_name` is why these rows have names.
        let conn = room();
        let a = add(&conn, "invoice.pdf");
        trash_files_in(&conn, std::slice::from_ref(&a), db::TrashActor::User);
        assert_eq!(restore_files_in(&conn, &[a]).ok, vec!["invoice.pdf"]);
    }

    #[test]
    fn the_agent_is_recorded_as_the_deleter() {
        // The trash's attribution column exists to answer "what did the AI
        // delete". It only works if the agent path passes its own actor.
        let conn = room();
        let a = add(&conn, "notes.md");
        trash_files_in(&conn, &[a], db::TrashActor::Agent("trash_files"));
        let trashed = db::list_trashed_files(&conn).unwrap();
        assert_eq!(trashed[0].trashed_by, "agent");
        assert_eq!(trashed[0].trashed_by_id.as_deref(), Some("trash_files"));
    }

    #[test]
    fn moving_reports_real_names_and_lands_the_files() {
        let conn = room();
        let folder = db::create_folder(&conn, "Invoices").unwrap();
        let a = add(&conn, "a.txt");
        let b = add(&conn, "b.txt");
        let report = move_files_in(&conn, &[a.clone(), b], Some(&folder.id));
        assert_eq!(report.ok.len(), 2);
        assert_eq!(
            db::get_file_meta(&conn, &a).unwrap().folder_id.as_deref(),
            Some(folder.id.as_str())
        );
        // …and back to the top level.
        move_files_in(&conn, std::slice::from_ref(&a), None);
        assert!(db::get_file_meta(&conn, &a).unwrap().folder_id.is_none());
    }

    #[test]
    fn moving_refuses_a_file_that_is_not_in_the_room() {
        // A batch used to report every id it was HANDED as moved, so an id
        // trashed in another window a moment earlier came back as `ok` — named
        // by raw uuid — and told the UI to re-read a room nothing happened to.
        let conn = room();
        let gone = add(&conn, "lease.txt");
        trash_files_in(&conn, std::slice::from_ref(&gone), db::TrashActor::User);

        let report = move_files_in(&conn, &[gone, "does-not-exist".into()], None);
        assert!(report.ok.is_empty(), "nothing moved: {:?}", report.ok);
        assert_eq!(report.failed.len(), 2);
        assert!(!report.changed_anything(), "no room-files-changed emit");
    }

    #[test]
    fn a_receipt_never_claims_more_than_it_did() {
        let mut report = BulkReport::default();
        assert_eq!(report.sentence("moved"), "Nothing was moved.");
        report.note_ok("a.txt".into());
        assert_eq!(report.sentence("moved"), "\"a.txt\" moved.");
        report.note_failed("b.txt".into(), "gone".into());
        let s = report.sentence("moved");
        assert!(s.contains("\"a.txt\" moved."));
        assert!(s.contains("\"b.txt\" (gone)"), "the failure is named: {s}");
    }
}
