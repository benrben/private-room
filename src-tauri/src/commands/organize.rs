//! The File agent's organize verbs: tidy the room, delete into the trash,
//! merge documents.
//!
//! WHAT THIS MODULE IS FOR. Before it, the agent's entire vocabulary for
//! "organize this room" was `rename_file` and `move_file` — one file per call,
//! no way to delete anything at all, and no way to combine two notes. Asked to
//! file forty documents it had to spend forty rounds, each one a fresh chance
//! for a small model to lose the plan; asked to throw one away it could only
//! say it had, which is worse than refusing.
//!
//! THREE VERBS, AND WHY THEY ARE THREE.
//!
//!   * `organize_files` — moves, renames and folder maintenance in ONE call.
//!     The argument for batching is the same one `edit_files` already makes for
//!     edits: a change that spans files, issued as N single calls, is N chances
//!     to drift and N rounds of budget. One call is also one plan a person can
//!     read in one card, and it can be previewed (`dry_run`) before it lands.
//!
//!   * `trash_files` — deletion is DELIBERATELY not a key inside the verb
//!     above. The trash view's whole job is answering "what did the AI delete"
//!     (the owner left "ask before AI edits" off; the trash plus its attribution
//!     column is the compensating control). A separate tool name is what lets
//!     the lane label, the tier gate and the host log treat destruction
//!     differently from filing — and what makes it legible in a transcript.
//!
//!   * `merge_files` — DETERMINISTIC concatenation, no model call. The agent
//!     could fake this with `open_file` + `create_file`, but that pushes both
//!     documents through the context window to get their own bytes back out:
//!     it fails on a 4B, and it fails on anything book-sized regardless of
//!     model. Combining files is a mechanical act and belongs in Rust. An
//!     AI-written *synthesis* is a different product (the whole-file pass), and
//!     the tool description says so, so the model can tell them apart.
//!
//! WHAT THE AGENT STILL CANNOT DO. It has trash, never `delete_file` and never
//! `empty_trash`. Everything here is recoverable from Library → Trash, by hand,
//! with the agent named as the actor. That asymmetry is the point: the model
//! may tidy, and only a person may destroy.

use super::bulk::{BulkFailure, BulkReport, MAX_BULK_FILES};
use super::*;

/// A file the agent named, resolved to a real room row — or the reason it
/// could not be. Resolution is reported per NAME rather than failing the batch,
/// for the same reason the bulk verbs are best-effort: one hallucinated
/// filename in a plan of thirty must not discard the twenty-nine real ones.
struct Resolved {
    /// (index in `names`, id, real name) — the pairing is carried out of the
    /// resolve rather than recovered later, because the loop that consumes it
    /// RENAMES and MOVES files: a second lookup of the same name runs against a
    /// database the caller has already changed, and matches something else or
    /// nothing at all.
    hits: Vec<(usize, String, String)>,
    misses: Vec<BulkFailure>,
    /// Names that resolved to a file an earlier name already claimed.
    dupes: Vec<BulkFailure>,
}

/// Resolve the names in a plan, in order, dropping duplicates.
///
/// Uses [`db::find_file_like_qualified`], so the folder-prefixed names the
/// agent was shown by `list_room_files` ("Invoices/q3.pdf") resolve — the round
/// trip that silently failed before.
///
/// De-duplication is by resolved ID, not by the string the model wrote: a plan
/// that names the same file twice, once as `q3.pdf` and once as
/// `Invoices/q3.pdf`, is one file. Left in, the second entry would either
/// double-apply a move or report a bogus failure. The duplicate is REPORTED
/// (`dupes`) rather than dropped in silence — for the verbs where a second
/// entry carried instructions of its own, saying nothing about it is a receipt
/// that claims a plan was carried out whole when part of it never ran.
fn resolve(conn: &Connection, names: &[String]) -> Resolved {
    let mut hits: Vec<(usize, String, String)> = Vec::new();
    let mut misses: Vec<BulkFailure> = Vec::new();
    let mut dupes: Vec<BulkFailure> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (at, raw) in names.iter().enumerate() {
        let name = raw.trim();
        if name.is_empty() {
            continue;
        }
        match db::find_file_like_qualified(conn, name) {
            Ok((id, real)) => {
                if seen.insert(id.clone()) {
                    hits.push((at, id, real));
                } else {
                    dupes.push(BulkFailure {
                        name: name.to_string(),
                        error: "names the same file as an earlier entry".into(),
                    });
                }
            }
            Err(e) => misses.push(BulkFailure {
                name: name.to_string(),
                error: e,
            }),
        }
    }
    Resolved { hits, misses, dupes }
}

/// Does this name mean "the top level" rather than a folder?
///
/// The same vocabulary `move_file` already accepts, kept in one place so the
/// two tools cannot disagree about what "no folder" is called.
fn means_top_level(name: &str) -> bool {
    let name = name.trim();
    name.is_empty()
        || ["none", "top", "top level", "root", "/"]
            .iter()
            .any(|w| name.eq_ignore_ascii_case(w))
}

/// The id of an existing folder with this name, if there is one.
fn existing_folder(conn: &Connection, name: &str) -> Option<Folder> {
    db::list_folders(conn)
        .unwrap_or_default()
        .into_iter()
        .find(|f| f.name.eq_ignore_ascii_case(name.trim()))
}

/// Find a folder by name, or make one.
///
/// ONLY the real run may call this. A DRY RUN used to resolve every destination
/// through here, and resolving meant creating — so previewing "file these under
/// Invoices, Receipts and Tax" silently left three real folders in the room. A
/// preview that mutates is worse than no preview, because it is the one the
/// user trusted; the dry-run branches report the destination by NAME and never
/// reach this function.
///
/// Get-or-create is deliberate and unchanged: the agent's `move_file` has
/// always made a folder on the way into it, and "file these under Invoices"
/// before an Invoices folder exists is what the request means.
fn folder_id_for(conn: &Connection, name: &str) -> Result<Option<String>, String> {
    if means_top_level(name) {
        return Ok(None);
    }
    let name = name.trim();
    match existing_folder(conn, name) {
        Some(f) => Ok(Some(f.id)),
        None => Ok(Some(db::create_folder(conn, name)?.id)),
    }
}

// ---------------------------------------------------------------- organize_files

/// One entry in an organize plan, as the model writes it.
#[derive(Deserialize, Default)]
pub(crate) struct OrganizeEntry {
    /// The file this entry is about (name, fragment, or `Folder/name`).
    #[serde(default)]
    pub name: String,
    /// Destination folder. `Some("")` means the top level — which is why this
    /// is an Option and not a String: "move it out of its folder" and "don't
    /// move it" are different instructions and an empty string cannot say both.
    #[serde(default)]
    pub folder: Option<String>,
    /// New name, extension optional (kept from the original when omitted).
    #[serde(default)]
    pub new_name: Option<String>,
}

/// What an organize run did, per file — the receipt the model reports from.
#[derive(Default)]
pub(crate) struct OrganizeReport {
    pub moved: Vec<String>,
    pub renamed: Vec<String>,
    pub folders_made: Vec<String>,
    pub folders_removed: Vec<String>,
    pub failed: Vec<BulkFailure>,
    pub capped: usize,
}

impl OrganizeReport {
    /// The sentence the tool returns.
    ///
    /// Every clause is counted from work that actually happened. `react_verify`
    /// ground-truths what this agent claims it changed, so a vague or inflated
    /// receipt is not merely bad manners — it is what the verifier catches, and
    /// a run that over-claims gets retried instead of finishing.
    pub fn sentence(&self, dry_run: bool) -> String {
        let mut parts: Vec<String> = Vec::new();
        let verb = |n: usize, past: &str, future: &str| {
            if dry_run {
                format!("would {future} {n}")
            } else {
                format!("{past} {n}")
            }
        };
        if !self.moved.is_empty() {
            parts.push(format!(
                "{} ({})",
                verb(self.moved.len(), "moved", "move"),
                self.moved.join(", ")
            ));
        }
        if !self.renamed.is_empty() {
            parts.push(format!(
                "{} ({})",
                verb(self.renamed.len(), "renamed", "rename"),
                self.renamed.join(", ")
            ));
        }
        if !self.folders_made.is_empty() {
            parts.push(format!("created folder(s) {}", self.folders_made.join(", ")));
        }
        if !self.folders_removed.is_empty() {
            parts.push(format!(
                "removed folder(s) {} — their files went to the top level",
                self.folders_removed.join(", ")
            ));
        }
        let mut out = if parts.is_empty() {
            "Nothing was changed.".to_string()
        } else if dry_run {
            format!("PREVIEW ONLY, nothing was changed — {}.", parts.join("; "))
        } else {
            format!("{}.", parts.join("; "))
        };
        if !self.failed.is_empty() {
            let detail: Vec<String> = self
                .failed
                .iter()
                .take(10)
                .map(|f| format!("\"{}\" ({})", f.name, f.error))
                .collect();
            out.push_str(&format!(
                " {} could not be done: {}.",
                self.failed.len(),
                detail.join("; ")
            ));
        }
        if self.capped > 0 {
            out.push_str(&format!(
                " {} entries were not attempted — one call handles at most {MAX_BULK_FILES}.",
                self.capped
            ));
        }
        out
    }
}

/// Apply an organize plan.
///
/// `dry_run` resolves every name and computes every outcome, then writes
/// nothing. It exists for the same reason `edit_file`'s does: the model can put
/// a whole reorganization in front of the user before it lands, and a plan
/// built on a misread filename shows up as a miss in the preview instead of as
/// forty files in the wrong place.
pub(crate) fn organize(
    conn: &Connection,
    entries: &[OrganizeEntry],
    make_folders: &[String],
    remove_folders: &[String],
    dry_run: bool,
) -> Result<OrganizeReport, String> {
    // Every list in one call carries the same ceiling. Folder maintenance used
    // to have none, so one call could create — or delete — thousands of
    // folders, and the receipt said nothing had been held back because nothing
    // had been.
    let mut report = OrganizeReport {
        capped: entries.len().saturating_sub(MAX_BULK_FILES)
            + make_folders.len().saturating_sub(MAX_BULK_FILES)
            + remove_folders.len().saturating_sub(MAX_BULK_FILES),
        ..Default::default()
    };

    // Folders are created FIRST so an empty folder can be made in the same call
    // that files are moved into it, and so `folder:` on an entry below finds a
    // folder this very plan asked for rather than making a second one.
    for name in make_folders.iter().take(MAX_BULK_FILES) {
        let name = name.trim();
        if name.is_empty() || means_top_level(name) {
            continue;
        }
        // An existing folder is not news. Reporting it as "created" would be a
        // claim about work that did not happen — and this receipt is exactly
        // what `react_verify` checks the agent's story against.
        if existing_folder(conn, name).is_some() {
            continue;
        }
        if dry_run {
            report.folders_made.push(format!("\"{name}\""));
            continue;
        }
        match db::create_folder(conn, name) {
            Ok(f) => report.folders_made.push(format!("\"{}\"", f.name)),
            Err(e) => report.failed.push(BulkFailure {
                name: name.to_string(),
                error: e,
            }),
        }
    }

    let plan: Vec<&OrganizeEntry> = entries.iter().take(MAX_BULK_FILES).collect();
    let names: Vec<String> = plan.iter().map(|e| e.name.clone()).collect();
    let resolved = resolve(conn, &names);
    report.failed.extend(resolved.misses);
    report.failed.extend(resolved.dupes);
    // Each hit carries the index of the entry it came from. Looking the name up
    // a SECOND time here would search a room this very loop is renaming: an
    // entry that moves "final.md" after an earlier entry renamed something else
    // to "final.md" would find the wrong file, or none — and a hit with no
    // entry was silently skipped, done nowhere and reported nowhere.
    for (at, id, real_name) in &resolved.hits {
        let entry = plan[*at];
        if let Some(folder) = &entry.folder {
            let where_to = if means_top_level(folder) {
                "the top level".to_string()
            } else {
                format!("\"{}\"", folder.trim())
            };
            if dry_run {
                // Nothing is resolved and nothing is created — a preview that
                // left folders behind is the bug this branch exists for.
                report.moved.push(format!("\"{real_name}\" → {where_to}"));
            } else {
                match folder_id_for(conn, folder)
                    .and_then(|fid| db::move_file_to_folder(conn, id, fid.as_deref()))
                {
                    Ok(()) => report.moved.push(format!("\"{real_name}\" → {where_to}")),
                    Err(e) => report.failed.push(BulkFailure {
                        name: real_name.clone(),
                        error: e,
                    }),
                }
            }
        }
        if let Some(new_name) = entry.new_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            // Keep the extension when the model drops it — the same courtesy
            // `rename_file` extends, and for the same reason: a model renaming
            // "q3.pdf" to "Q3 report" means the title, not the file type.
            let final_name = if extraction::extension_of(new_name).is_empty() {
                let ext = extraction::extension_of(real_name);
                if ext.is_empty() {
                    new_name.to_string()
                } else {
                    format!("{new_name}.{ext}")
                }
            } else {
                new_name.to_string()
            };
            if dry_run {
                report
                    .renamed
                    .push(format!("\"{real_name}\" → \"{final_name}\""));
            } else {
                match db::rename_file(conn, id, &final_name) {
                    Ok(()) => report
                        .renamed
                        .push(format!("\"{real_name}\" → \"{final_name}\"")),
                    Err(e) => report.failed.push(BulkFailure {
                        name: real_name.clone(),
                        error: e,
                    }),
                }
            }
        }
    }

    // Folders are removed LAST, so a plan that empties a folder and then drops
    // it does both in the right order. `db::delete_folder` never deletes files
    // — they return to the top level (ADD-16) — which is what makes this safe
    // to give a model at all.
    for name in remove_folders.iter().take(MAX_BULK_FILES) {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        match existing_folder(conn, name) {
            Some(f) => {
                if dry_run {
                    report.folders_removed.push(format!("\"{}\"", f.name));
                } else {
                    match db::delete_folder(conn, &f.id) {
                        Ok(()) => report.folders_removed.push(format!("\"{}\"", f.name)),
                        Err(e) => report.failed.push(BulkFailure {
                            name: f.name,
                            error: e,
                        }),
                    }
                }
            }
            None => report.failed.push(BulkFailure {
                name: name.to_string(),
                error: "no folder by that name".into(),
            }),
        }
    }

    Ok(report)
}

// ---------------------------------------------------------------- trash_files

/// Move the named files to the trash, attributed to the agent.
///
/// Rides `bulk::trash_files_in` — the SAME function the Library's own
/// multi-selection calls — so an AI deletion and a human one are the same
/// operation with a different actor recorded, rather than two implementations
/// that will eventually disagree about what deleting means.
pub(crate) fn trash_named(conn: &Connection, names: &[String]) -> (BulkReport, Vec<BulkFailure>) {
    let resolved = resolve(conn, names);
    let ids: Vec<String> = resolved.hits.into_iter().map(|(_, id, _)| id).collect();
    let report = super::bulk::trash_files_in(conn, &ids, db::TrashActor::Agent("trash_files"));
    (report, resolved.misses)
}

// ---------------------------------------------------------------- merge_files

/// Join several text files into one new room file.
///
/// NO MODEL CALL. That is the whole design: the bytes never enter a context
/// window, so this works identically on a 4B and on a cloud engine, and it
/// works on inputs far past any window. The result is a plain concatenation —
/// if the user wanted the documents *synthesized* rather than joined, that is
/// the whole-file pass, and `merge_files`' description points there.
///
/// Sources are NOT deleted unless asked, and when they are, they go to the
/// trash like everything else the agent removes.
pub(crate) fn merge(
    conn: &Connection,
    names: &[String],
    into: &str,
    headings: bool,
    trash_sources: bool,
) -> Result<(String, String, Vec<BulkFailure>), String> {
    let resolved = resolve(conn, names);
    let mut failures = resolved.misses;
    if resolved.hits.len() < 2 {
        return Err(format!(
            "merge_files needs at least two files it can find; matched {}.{}",
            resolved.hits.len(),
            if failures.is_empty() {
                String::new()
            } else {
                format!(
                    " Not found: {}.",
                    failures
                        .iter()
                        .map(|f| format!("\"{}\"", f.name))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
        ));
    }

    let mut body = String::new();
    let mut merged: Vec<String> = Vec::new();
    for (_, id, name) in &resolved.hits {
        // A file whose text the room never extracted (a PDF that failed OCR, a
        // recording with no transcript, an image) has nothing to contribute.
        // Skipping it SILENTLY would produce a merge that looks complete and
        // is not, so it is reported as a per-file failure like any other.
        let text = match db::get_file_extracted_text(conn, id) {
            Some(t) if !t.trim().is_empty() => t,
            _ => {
                failures.push(BulkFailure {
                    name: name.clone(),
                    error: "no readable text in this file".into(),
                });
                continue;
            }
        };
        if headings {
            // The heading names the SOURCE, so the merged document can still
            // be traced back — a merge that loses provenance is a merge nobody
            // can check.
            body.push_str(&format!("\n\n## {name}\n\n"));
        } else if !body.is_empty() {
            body.push_str("\n\n");
        }
        body.push_str(text.trim());
        merged.push(name.clone());
    }
    if merged.len() < 2 {
        return Err(
            "merge_files needs at least two files with readable text; the rest had none.".into(),
        );
    }

    let into = into.trim();
    let name = if into.is_empty() {
        "Merged notes.md".to_string()
    } else if extraction::extension_of(into).is_empty() {
        format!("{into}.md")
    } else {
        into.to_string()
    };
    // `into` names a NEW file (so says the tool's own schema), and the default
    // is the app's own — so neither may land on a name already in use. Merging
    // twice with no `into` produced a second "Merged notes.md" beside the
    // first, same name and different content, and every name-based verb after
    // that reached only the newest one. The receipt reports `meta.name`, so it
    // keeps telling the truth about which file was written.
    let name = db::available_name(conn, &name)?;
    let mime = mime_guess::from_path(&name)
        .first_or(mime_guess::mime::TEXT_PLAIN)
        .essence_str()
        .to_string();
    let content = body.trim_start().to_string();
    let meta = db::insert_file(conn, &name, &mime, content.as_bytes(), Some(&content), "generated")?;

    // Only now, and only if asked. Trashing before the write would risk losing
    // the sources to a failed insert.
    if trash_sources {
        let ids: Vec<String> = resolved
            .hits
            .iter()
            .filter(|(_, _, n)| merged.contains(n))
            .map(|(_, id, _)| id.clone())
            .collect();
        let trashed =
            super::bulk::trash_files_in(conn, &ids, db::TrashActor::Agent("merge_files"));
        failures.extend(trashed.failed);
    }

    let receipt = format!(
        "Merged {} files into \"{}\" ({} characters){}.{}",
        merged.len(),
        meta.name,
        content.chars().count(),
        if trash_sources {
            " and moved the originals to the trash"
        } else {
            " — the originals are untouched"
        },
        if failures.is_empty() {
            String::new()
        } else {
            format!(
                " Skipped: {}.",
                failures
                    .iter()
                    .map(|f| format!("\"{}\" ({})", f.name, f.error))
                    .collect::<Vec<_>>()
                    .join("; ")
            )
        }
    );
    Ok((meta.name, receipt, failures))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room() -> Connection {
        db::open_in_memory_schema()
    }

    fn add(conn: &Connection, name: &str, text: &str) -> String {
        db::insert_file(conn, name, "text/plain", text.as_bytes(), Some(text), "test")
            .unwrap()
            .id
    }

    #[test]
    fn a_folder_qualified_name_resolves() {
        // THE ROUND TRIP. `list_room_files` prints "Invoices/q3.pdf"; the tools
        // must accept exactly what was printed.
        let conn = room();
        let folder = db::create_folder(&conn, "Invoices").unwrap();
        let id = add(&conn, "q3.pdf", "body");
        db::move_file_to_folder(&conn, &id, Some(&folder.id)).unwrap();
        let (hit, name) = db::find_file_like_qualified(&conn, "Invoices/q3.pdf").unwrap();
        assert_eq!(hit, id);
        assert_eq!(name, "q3.pdf");
        // The bare name still works, and a folder path with no file does not
        // silently match the newest file in the room.
        assert!(db::find_file_like_qualified(&conn, "q3").is_ok());
        assert!(db::find_file_like_qualified(&conn, "Invoices/").is_err());
    }

    #[test]
    fn organize_moves_renames_and_reports_the_misses() {
        let conn = room();
        add(&conn, "a.txt", "alpha");
        add(&conn, "b.txt", "beta");
        let entries = vec![
            OrganizeEntry {
                name: "a.txt".into(),
                folder: Some("Archive".into()),
                new_name: Some("Alpha report".into()),
            },
            OrganizeEntry {
                name: "nope.txt".into(),
                folder: Some("Archive".into()),
                ..Default::default()
            },
        ];
        let r = organize(&conn, &entries, &[], &[], false).unwrap();
        assert_eq!(r.moved.len(), 1);
        assert_eq!(r.renamed.len(), 1);
        assert_eq!(r.failed.len(), 1, "the hallucinated file is reported");
        // The extension survived a rename that dropped it.
        let (_, name) = db::find_file_like(&conn, "Alpha report").unwrap();
        assert_eq!(name, "Alpha report.txt");
        // …and the folder was created on the way.
        assert!(db::list_folders(&conn)
            .unwrap()
            .iter()
            .any(|f| f.name == "Archive"));
    }

    #[test]
    fn an_entry_is_not_lost_when_an_earlier_rename_takes_its_name() {
        // The plan renames draft.md to final.md and then files the ORIGINAL
        // final.md away. Re-resolving "final.md" after the rename finds the
        // wrong row (or two candidates), so the second entry used to be done
        // nowhere and reported nowhere.
        let conn = room();
        let final_id = add(&conn, "final.md", "the real one");
        add(&conn, "draft.md", "a draft");
        let entries = vec![
            OrganizeEntry {
                name: "draft.md".into(),
                new_name: Some("final.md".into()),
                ..Default::default()
            },
            OrganizeEntry {
                name: "final.md".into(),
                folder: Some("Archive".into()),
                ..Default::default()
            },
        ];
        let r = organize(&conn, &entries, &[], &[], false).unwrap();
        assert_eq!(r.renamed.len(), 1);
        assert_eq!(r.moved.len(), 1, "the second entry was attempted: {:?}", r.sentence(false));
        assert!(r.failed.is_empty(), "{:?}", r.sentence(false));
        // …and it moved the file the plan named, not the renamed draft.
        let archive = existing_folder(&conn, "Archive").expect("Archive exists");
        let meta = db::get_file_meta(&conn, &final_id).unwrap();
        assert_eq!(meta.folder_id.as_deref(), Some(archive.id.as_str()));
    }

    #[test]
    fn naming_one_file_twice_is_reported_rather_than_dropped() {
        let conn = room();
        let id = add(&conn, "q3.pdf", "body");
        let entries = vec![
            OrganizeEntry {
                name: "q3.pdf".into(),
                folder: Some("Invoices".into()),
                ..Default::default()
            },
            OrganizeEntry {
                name: "q3".into(),
                new_name: Some("Q3 report".into()),
                ..Default::default()
            },
        ];
        let r = organize(&conn, &entries, &[], &[], false).unwrap();
        assert_eq!(r.moved.len(), 1);
        assert!(r.renamed.is_empty(), "the second entry names the same file");
        assert_eq!(r.failed.len(), 1);
        assert!(r.failed[0].error.contains("earlier entry"), "{}", r.failed[0].error);
        // The rename it asked for did not happen, and the receipt says so.
        assert_eq!(db::get_file_meta(&conn, &id).unwrap().name, "q3.pdf");
        assert!(r.sentence(false).contains("could not be done"));
    }

    #[test]
    fn folder_maintenance_is_capped_like_everything_else() {
        // One call used to be able to create — or delete — an unbounded number
        // of folders, with the receipt reporting nothing held back.
        let conn = room();
        let many: Vec<String> = (0..MAX_BULK_FILES + 3).map(|i| format!("F{i}")).collect();
        let r = organize(&conn, &[], &many, &[], false).unwrap();
        assert_eq!(r.folders_made.len(), MAX_BULK_FILES);
        assert_eq!(r.capped, 3);
        assert!(r.sentence(false).contains("were not attempted"));
        assert_eq!(db::list_folders(&conn).unwrap().len(), MAX_BULK_FILES);
        // Removal is bounded by the same ceiling.
        let r = organize(&conn, &[], &[], &many, false).unwrap();
        assert_eq!(r.folders_removed.len(), MAX_BULK_FILES);
        assert_eq!(r.capped, 3);
    }

    #[test]
    fn a_dry_run_changes_nothing_and_says_so() {
        // A PREVIEW THAT MUTATES IS WORSE THAN NO PREVIEW, because it is the
        // one the user trusted. This caught a real defect: resolving a
        // destination used to mean get-or-CREATE, so previewing "file these
        // under Archive" left a real Archive folder behind — from the branch
        // whose entire promise is that nothing happened.
        let conn = room();
        add(&conn, "a.txt", "alpha");
        let entries = vec![OrganizeEntry {
            name: "a.txt".into(),
            folder: Some("Archive".into()),
            new_name: Some("Alpha".into()),
        }];
        let r = organize(&conn, &entries, &["Extra".into()], &[], true).unwrap();
        assert_eq!(r.moved.len(), 1);
        assert_eq!(r.renamed.len(), 1);
        assert_eq!(r.folders_made.len(), 1);
        let s = r.sentence(true);
        assert!(s.contains("PREVIEW ONLY"), "{s}");
        assert!(s.contains("would move") && s.contains("would rename"), "{s}");
        // NOTHING landed: no destination folder, no explicitly-requested
        // folder, no move, no rename.
        assert!(
            db::list_folders(&conn).unwrap().is_empty(),
            "a preview must not create folders — neither the destination nor the requested one",
        );
        let (id, name) = db::find_file_like(&conn, "a.txt").unwrap();
        assert_eq!(name, "a.txt", "the rename was only previewed");
        assert!(db::get_file_meta(&conn, &id).unwrap().folder_id.is_none());
    }

    #[test]
    fn deleting_a_folder_never_deletes_its_files() {
        // The invariant that makes folder removal safe to hand a model at all.
        let conn = room();
        let folder = db::create_folder(&conn, "Old").unwrap();
        let id = add(&conn, "keep.txt", "body");
        db::move_file_to_folder(&conn, &id, Some(&folder.id)).unwrap();
        let r = organize(&conn, &[], &[], &["Old".into()], false).unwrap();
        assert_eq!(r.folders_removed.len(), 1);
        let meta = db::get_file_meta(&conn, &id).unwrap();
        assert!(meta.folder_id.is_none(), "the file survived, at the top level");
    }

    #[test]
    fn the_agents_deletions_are_attributed_to_the_agent() {
        let conn = room();
        add(&conn, "junk.txt", "x");
        let (report, misses) = trash_named(&conn, &["junk.txt".into(), "ghost.txt".into()]);
        assert_eq!(report.ok, vec!["junk.txt"]);
        assert_eq!(misses.len(), 1, "an unmatched name is reported, not ignored");
        let trashed = db::list_trashed_files(&conn).unwrap();
        assert_eq!(trashed[0].trashed_by, "agent");
        assert_eq!(trashed[0].trashed_by_id.as_deref(), Some("trash_files"));
    }

    #[test]
    fn merge_joins_text_and_leaves_the_sources_alone_by_default() {
        let conn = room();
        add(&conn, "one.md", "First half.");
        add(&conn, "two.md", "Second half.");
        let (name, receipt, _) = merge(
            &conn,
            &["one.md".into(), "two.md".into()],
            "Combined",
            true,
            false,
        )
        .unwrap();
        assert_eq!(name, "Combined.md", "an extension is supplied when omitted");
        let (id, _) = db::find_file_like(&conn, "Combined").unwrap();
        let text = db::get_file_extracted_text(&conn, &id).unwrap();
        assert!(text.contains("First half.") && text.contains("Second half."));
        assert!(text.contains("## one.md"), "headings name their source file");
        assert!(receipt.contains("originals are untouched"));
        // Both sources are still in the library.
        assert!(db::find_file_like(&conn, "one.md").is_ok());
    }

    #[test]
    fn merge_refuses_rather_than_producing_half_a_document() {
        let conn = room();
        add(&conn, "only.md", "text");
        // One resolvable file is not a merge.
        assert!(merge(&conn, &["only.md".into(), "ghost.md".into()], "x", true, false).is_err());
        // Two files, one with no readable text, is also not a merge — and the
        // error says so rather than silently writing a copy of the first.
        db::insert_file(&conn, "scan.pdf", "application/pdf", b"%PDF", None, "test").unwrap();
        let err = merge(&conn, &["only.md".into(), "scan.pdf".into()], "x", true, false)
            .unwrap_err();
        assert!(err.contains("readable text"), "{err}");
    }

    #[test]
    fn a_second_merge_does_not_reuse_the_first_ones_name() {
        // Two files called "Merged notes.md" with different content is a room
        // where the first merge can never be opened by name again.
        let conn = room();
        add(&conn, "a.md", "First.");
        add(&conn, "b.md", "Second.");
        add(&conn, "c.md", "Third.");
        add(&conn, "d.md", "Fourth.");
        let (first, _, _) = merge(&conn, &["a.md".into(), "b.md".into()], "", false, false).unwrap();
        let (second, receipt, _) =
            merge(&conn, &["c.md".into(), "d.md".into()], "", false, false).unwrap();
        assert_eq!(first, "Merged notes.md");
        assert_ne!(second, first, "the second merge took a free name");
        // The receipt names the file that was actually written.
        assert!(receipt.contains(&second), "{receipt}");
        // …and the first merge is still reachable by its own name.
        let (id, _) = db::find_file_like(&conn, &first).unwrap();
        let text = db::get_file_extracted_text(&conn, &id).unwrap();
        assert!(text.contains("First."), "got: {text}");
    }

    #[test]
    fn merge_can_trash_its_sources_when_asked() {
        let conn = room();
        add(&conn, "one.md", "First.");
        add(&conn, "two.md", "Second.");
        let (_, receipt, _) =
            merge(&conn, &["one.md".into(), "two.md".into()], "Both.md", false, true).unwrap();
        assert!(receipt.contains("moved the originals to the trash"));
        assert!(db::find_file_like(&conn, "one.md").is_err());
        // Recoverable, and attributed — never destroyed.
        let trashed = db::list_trashed_files(&conn).unwrap();
        assert_eq!(trashed.len(), 2);
        assert_eq!(trashed[0].trashed_by, "agent");
    }
}
