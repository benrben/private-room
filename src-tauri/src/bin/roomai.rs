// roomai — a tiny, honest, offline CLI for a Arcelle file.
//
// It reuses the desktop app's library crate (`arcelle_lib`) so it opens
// rooms with the exact same SQLCipher scheme the app uses — no second code
// path to drift out of sync. Nothing here touches the network or a model; it
// only decrypts a local file and reads or copies out what is already inside.
//
// Contract section E. Subcommands: verify / info / recover / export.
// Secrets come from the environment ONLY (ROOMAI_PASSWORD / ROOMAI_RECOVERY).
// There is deliberately no --password / --code flag: on macOS every process
// running as you can read another's argv (`ps -ww`, /proc equivalents, any
// monitoring agent), so a room password typed on the command line is readable
// by anything on the machine — and lands in shell history besides. The flags
// used to exist as an "escape hatch"; the environment is the escape hatch.
// Exit codes: 0 ok, 1 runtime error, 2 usage.

use std::collections::HashSet;
use std::path::Path;

use arcelle_lib::db;
use rusqlite::Connection;

const USAGE: &str = "\
roomai — offline tools for a Arcelle file

Usage:
  roomai verify  <path>           Check the file decrypts and is a valid room.
  roomai info    <path>           Verify, then dump the room's meta keys.
  roomai recover <path>           Open using a recovery code instead of a password.
  roomai export  <path> <outdir>  Write every stored file back out to a folder.

Secrets (environment only — never on the command line, where any other
program running as you can read them):
  ROOMAI_PASSWORD   password for verify / info / export
  ROOMAI_RECOVERY   recovery code for recover

Exit codes: 0 ok, 1 error, 2 usage.
";

/// A parsed command line. Splitting parse from run keeps argument handling
/// pure and unit-testable (no room, no filesystem).
#[derive(Debug, PartialEq, Eq)]
enum Command {
    Verify {
        path: String,
    },
    Info {
        path: String,
    },
    Recover {
        path: String,
    },
    Export {
        path: String,
        outdir: String,
    },
    /// No args, `help`, or `-h/--help`. Renders usage and exits 2.
    Help,
}

fn main() {
    // argv[0] is the program name; the parser works on everything after it.
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(run(args));
}

/// Top-level dispatch. Returns the process exit code and never panics on bad
/// input — every failure path maps to a clean stderr line and a non-zero code.
fn run(args: Vec<String>) -> i32 {
    let cmd = match parse(args) {
        Ok(c) => c,
        Err(msg) => {
            eprintln!("{msg}\n");
            eprint!("{USAGE}");
            return 2;
        }
    };

    let result = match cmd {
        Command::Help => {
            eprint!("{USAGE}");
            return 2;
        }
        Command::Verify { path } => do_verify(&path),
        Command::Info { path } => do_info(&path),
        Command::Recover { path } => do_recover(&path),
        Command::Export { path, outdir } => do_export(&path, &outdir),
    };

    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("Error: {e}");
            1
        }
    }
}

// ----------------------------------------------------------------- parsing

fn parse(mut args: Vec<String>) -> Result<Command, String> {
    if args.is_empty() {
        return Ok(Command::Help);
    }
    let cmd = args.remove(0);
    match cmd.as_str() {
        "help" | "-h" | "--help" => Ok(Command::Help),
        "verify" | "info" => {
            reject_secret_flags(&args)?;
            let path = one_positional(args, &cmd, "<path>")?;
            Ok(if cmd == "verify" {
                Command::Verify { path }
            } else {
                Command::Info { path }
            })
        }
        "recover" => {
            reject_secret_flags(&args)?;
            let path = one_positional(args, &cmd, "<path>")?;
            Ok(Command::Recover { path })
        }
        "export" => {
            reject_secret_flags(&args)?;
            let (path, outdir) = two_positionals(args, &cmd)?;
            Ok(Command::Export { path, outdir })
        }
        other => Err(format!("Unknown command: {other}")),
    }
}

/// The two flags that used to carry a secret on the command line. Named
/// explicitly rather than falling through to "Unknown flag" so anyone with an
/// old script is told WHY it stopped working and what to do instead.
fn reject_secret_flags(args: &[String]) -> Result<(), String> {
    for a in args {
        if a == "--password" || a == "--code" {
            return Err(format!(
                "`{a}` is no longer accepted: any program running as you can read \
                 another process's arguments, so a secret there is not private. \
                 Set ROOMAI_PASSWORD / ROOMAI_RECOVERY in the environment instead."
            ));
        }
    }
    Ok(())
}

/// Reject any leftover token that looks like a flag — catches typos such as
/// `--passwrod` before they get silently treated as a path.
fn reject_unknown_flags(args: &[String]) -> Result<(), String> {
    for a in args {
        if a.starts_with('-') && a != "-" {
            return Err(format!("Unknown flag: {a}"));
        }
    }
    Ok(())
}

fn one_positional(args: Vec<String>, cmd: &str, what: &str) -> Result<String, String> {
    reject_unknown_flags(&args)?;
    match args.len() {
        0 => Err(format!("`{cmd}` needs a {what}.")),
        1 => Ok(args.into_iter().next().expect("len checked")),
        _ => Err(format!("`{cmd}` takes exactly one {what}.")),
    }
}

fn two_positionals(args: Vec<String>, cmd: &str) -> Result<(String, String), String> {
    reject_unknown_flags(&args)?;
    if args.len() != 2 {
        return Err(format!("`{cmd}` needs <path> and <outdir>."));
    }
    let mut it = args.into_iter();
    Ok((it.next().unwrap(), it.next().unwrap()))
}

// --------------------------------------------------------------- secrets

fn resolve_password() -> Result<String, String> {
    match std::env::var("ROOMAI_PASSWORD") {
        Ok(v) if !v.is_empty() => Ok(v),
        _ => Err("No password. Set ROOMAI_PASSWORD (never pass it as an argument — \
                  other programs on this Mac can read a process's arguments)."
            .into()),
    }
}

fn resolve_code() -> Result<String, String> {
    match std::env::var("ROOMAI_RECOVERY") {
        Ok(v) if !v.is_empty() => Ok(v),
        _ => Err("No recovery code. Set ROOMAI_RECOVERY (never pass it as an argument — \
                  other programs on this Mac can read a process's arguments)."
            .into()),
    }
}

// --------------------------------------------------------------- commands

/// CHECK, don't touch. `db::open_room` always runs the schema migration and at
/// least one write, so "verify" used to fail outright on a copy sitting on a
/// read-only volume — and on a room not opened since the last schema change it
/// rebuilt the search index while claiming only to be looking.
fn do_verify(path: &str) -> Result<(), String> {
    let password = resolve_password()?;
    let conn = db::open_room_readonly(path, &password)?;
    print_ok(&conn);
    Ok(())
}

fn do_info(path: &str) -> Result<(), String> {
    let password = resolve_password()?;
    let conn = db::open_room_readonly(path, &password)?;
    print_ok(&conn);
    print_meta_dump(&conn);
    Ok(())
}

fn do_recover(path: &str) -> Result<(), String> {
    let code = resolve_code()?;
    let conn = db::open_with_recovery(path, &code)?;
    print_ok(&conn);
    Ok(())
}

fn do_export(path: &str, outdir: &str) -> Result<(), String> {
    let password = resolve_password()?;
    let conn = db::open_room(path, &password)?;

    std::fs::create_dir_all(outdir)
        .map_err(|e| format!("Could not create {outdir}: {e}"))?;

    let mut stmt = conn
        // Trash: an export is "everything in this room", and a deleted file is
        // not in the room. Exporting it would also be the one way trashed bytes
        // could reach the plain filesystem — the whole point of keeping them
        // inside the room is that they never do.
        .prepare(
            "SELECT name, original_bytes FROM files WHERE trashed_at IS NULL \
             ORDER BY created_at, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let name: String = r.get(0)?;
            let bytes: Option<Vec<u8>> = r.get(1)?;
            Ok((name, bytes))
        })
        .map_err(|e| e.to_string())?;

    let mut used: HashSet<String> = HashSet::new();
    // Never clobber what's already in the output folder: seed the dedupe
    // set with the names that exist there so unique_name() steps past them.
    // Keys are lowercased because APFS is case-insensitive by default, so
    // "Report.pdf" would overwrite an existing "report.pdf".
    let entries = std::fs::read_dir(outdir).map_err(|e| format!("Could not read {outdir}: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        used.insert(entry.file_name().to_string_lossy().to_lowercase());
    }
    let mut written = 0usize;
    let mut skipped = 0usize;

    for row in rows {
        let (name, bytes) = row.map_err(|e| e.to_string())?;
        // Rows can carry no original bytes (e.g. app-generated notes). Nothing
        // to write out — count it and move on rather than emit an empty file.
        let Some(bytes) = bytes else {
            skipped += 1;
            continue;
        };
        let filename = unique_name(&mut used, &sanitize(&name));
        let dest = Path::new(outdir).join(&filename);
        std::fs::write(&dest, &bytes)
            .map_err(|e| format!("Could not write {}: {e}", dest.display()))?;
        written += 1;
    }

    println!("Wrote {written} file(s) to {outdir}.");
    if skipped > 0 {
        println!("Skipped {skipped} row(s) with no stored bytes.");
    }
    Ok(())
}

// ---------------------------------------------------------------- helpers

/// Success banner shared by verify / info / recover.
fn print_ok(conn: &Connection) {
    println!("OK: decrypts and is a valid Arcelle file.");
    println!("  format:         {}", meta_or(conn, "format"));
    println!("  format_version: {}", meta_or(conn, "format_version"));
    println!("  files:          {}", count(conn, "files"));
    println!("  chats:          {}", count(conn, "chats"));
}

/// The extra `info` section: the interesting meta keys, shown even when unset
/// so it's clear which ones a room does and doesn't carry.
fn print_meta_dump(conn: &Connection) {
    println!("\nMeta:");
    for key in ["format", "format_version", "name", "embed_model", "embed_dim"] {
        match db::get_meta(conn, key) {
            Some(v) => println!("  {key}: {v}"),
            None => println!("  {key}: (not set)"),
        }
    }
}

fn meta_or(conn: &Connection, key: &str) -> String {
    db::get_meta(conn, key).unwrap_or_else(|| "(unset)".into())
}

/// Count rows in a table. The table name is always a hard-coded literal from
/// this file, never user input, so the format! is not an injection surface.
fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap_or(0)
}

/// Minimal filename hardening for export: keep only the final path component
/// and neutralise separators / NUL, so a stored name like `../../etc/passwd`
/// can never write outside the chosen output directory.
fn sanitize(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .map(|c| match c {
            '/' | '\\' | '\0' => '_',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "unnamed".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Make `base` unique against `used` — seeded with the destination's
/// pre-existing filenames and every name handed out earlier in this export
/// run — so nothing gets silently clobbered. Appends ` (2)`, ` (3)`, … before
/// the extension. `used` holds lowercased keys (and candidates are tested
/// lowercased) because APFS is case-insensitive by default; the returned
/// name keeps the original case.
fn unique_name(used: &mut HashSet<String>, base: &str) -> String {
    if used.insert(base.to_lowercase()) {
        return base.to_string();
    }
    let (stem, ext) = match base.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (base.to_string(), String::new()),
    };
    let mut n = 2;
    loop {
        let candidate = format!("{stem} ({n}){ext}");
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
        n += 1;
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_args_is_help() {
        assert_eq!(parse(argv(&[])).unwrap(), Command::Help);
    }

    #[test]
    fn help_word_and_flags_are_help() {
        assert_eq!(parse(argv(&["help"])).unwrap(), Command::Help);
        assert_eq!(parse(argv(&["-h"])).unwrap(), Command::Help);
        assert_eq!(parse(argv(&["--help"])).unwrap(), Command::Help);
    }

    #[test]
    fn unknown_command_is_rejected() {
        assert!(parse(argv(&["frobnicate", "room.room"])).is_err());
    }

    #[test]
    fn verify_requires_a_path() {
        assert!(parse(argv(&["verify"])).is_err());
    }

    /// A room password on the command line is readable by every other process
    /// running as you (`ps -ww`), and lands in shell history. The flag that
    /// accepted one is refused BY NAME in every position, with a message that
    /// says where to put the secret instead — an old script must not fail with
    /// a bare "Unknown flag" and must certainly not silently keep working.
    #[test]
    fn a_secret_on_the_command_line_is_refused_by_name() {
        for argv_ in [
            argv(&["verify", "room.room", "--password", "hunter2"]),
            argv(&["verify", "--password", "hunter2", "room.room"]),
            argv(&["info", "room.room", "--password", "hunter2"]),
            argv(&["export", "room.room", "out", "--password", "hunter2"]),
            argv(&["recover", "room.room", "--code", "AAAA-BBBB"]),
        ] {
            let err = parse(argv_).expect_err("a secret argument must be refused");
            assert!(err.contains("ROOMAI_PASSWORD") || err.contains("ROOMAI_RECOVERY"), "{err}");
        }
    }

    #[test]
    fn verify_takes_only_a_path() {
        assert_eq!(
            parse(argv(&["verify", "room.room"])).unwrap(),
            Command::Verify { path: "room.room".into() }
        );
    }

    #[test]
    fn info_parses() {
        assert_eq!(
            parse(argv(&["info", "room.room"])).unwrap(),
            Command::Info { path: "room.room".into() }
        );
    }

    #[test]
    fn recover_takes_only_a_path() {
        assert_eq!(
            parse(argv(&["recover", "room.room"])).unwrap(),
            Command::Recover { path: "room.room".into() }
        );
    }

    #[test]
    fn export_needs_two_positionals() {
        assert!(parse(argv(&["export", "room.room"])).is_err());
        assert!(parse(argv(&["export", "room.room", "out", "extra"])).is_err());
        assert_eq!(
            parse(argv(&["export", "room.room", "out"])).unwrap(),
            Command::Export {
                path: "room.room".into(),
                outdir: "out".into(),
            }
        );
    }

    #[test]
    fn unknown_flag_is_rejected() {
        assert!(parse(argv(&["verify", "room.room", "--nope"])).is_err());
        assert!(parse(argv(&["verify", "--passwrod", "x", "room.room"])).is_err());
    }

    #[test]
    fn a_bare_secret_flag_errors_too() {
        // No value to take, so this must not fall through to "<path>".
        assert!(parse(argv(&["verify", "room.room", "--password"])).is_err());
    }

    #[test]
    fn sanitize_strips_path_traversal() {
        assert_eq!(sanitize("../../etc/passwd"), "passwd");
        assert_eq!(sanitize("a/b/c.txt"), "c.txt");
        assert_eq!(sanitize("plain.pdf"), "plain.pdf");
        assert_eq!(sanitize(""), "unnamed");
        assert_eq!(sanitize("   "), "unnamed");
        assert_eq!(sanitize(".."), "unnamed");
    }

    #[test]
    fn unique_name_disambiguates_collisions() {
        let mut used = HashSet::new();
        assert_eq!(unique_name(&mut used, "a.txt"), "a.txt");
        assert_eq!(unique_name(&mut used, "a.txt"), "a (2).txt");
        assert_eq!(unique_name(&mut used, "a.txt"), "a (3).txt");
        assert_eq!(unique_name(&mut used, "noext"), "noext");
        assert_eq!(unique_name(&mut used, "noext"), "noext (2)");
    }

    #[test]
    fn unique_name_steps_past_preexisting_names() {
        // Names seeded from the destination directory must not be reused.
        let mut used = HashSet::new();
        used.insert("report.pdf".to_string());
        assert_eq!(unique_name(&mut used, "report.pdf"), "report (2).pdf");
    }

    #[test]
    fn unique_name_is_case_insensitive() {
        // APFS is case-insensitive by default: "Report.pdf" would clobber a
        // pre-existing "report.pdf". Keys are compared lowercased, but the
        // returned name keeps the caller's case.
        let mut used = HashSet::new();
        used.insert("report.pdf".to_string()); // seeded (already lowercased)
        assert_eq!(unique_name(&mut used, "Report.pdf"), "Report (2).pdf");
        assert_eq!(unique_name(&mut used, "REPORT.PDF"), "REPORT (3).PDF");
        assert_eq!(unique_name(&mut used, "Fresh.pdf"), "Fresh.pdf");
        assert_eq!(unique_name(&mut used, "fresh.pdf"), "fresh (2).pdf");
    }
}
