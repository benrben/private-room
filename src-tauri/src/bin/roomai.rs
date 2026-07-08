// roomai — a tiny, honest, offline CLI for a Private Room file.
//
// It reuses the desktop app's library crate (`private_room_lib`) so it opens
// rooms with the exact same SQLCipher scheme the app uses — no second code
// path to drift out of sync. Nothing here touches the network or a model; it
// only decrypts a local file and reads or copies out what is already inside.
//
// Contract section E. Subcommands: verify / info / recover / export.
// Secrets come from the environment (ROOMAI_PASSWORD / ROOMAI_RECOVERY) so they
// never have to sit in shell history; a --password / --code flag is the escape
// hatch. Exit codes: 0 ok, 1 runtime error, 2 usage.

use std::collections::HashSet;
use std::path::Path;

use private_room_lib::db;
use rusqlite::Connection;

const USAGE: &str = "\
roomai — offline tools for a Private Room file

Usage:
  roomai verify  <path>           Check the file decrypts and is a valid room.
  roomai info    <path>           Verify, then dump the room's meta keys.
  roomai recover <path>           Open using a recovery code instead of a password.
  roomai export  <path> <outdir>  Write every stored file back out to a folder.

Secrets (kept off the command line unless you opt in):
  ROOMAI_PASSWORD   password for verify / info / export   (or --password <p>)
  ROOMAI_RECOVERY   recovery code for recover             (or --code <c>)

Exit codes: 0 ok, 1 error, 2 usage.
";

/// A parsed command line. Splitting parse from run keeps argument handling
/// pure and unit-testable (no room, no filesystem).
#[derive(Debug, PartialEq, Eq)]
enum Command {
    Verify {
        path: String,
        password: Option<String>,
    },
    Info {
        path: String,
        password: Option<String>,
    },
    Recover {
        path: String,
        code: Option<String>,
    },
    Export {
        path: String,
        outdir: String,
        password: Option<String>,
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
        Command::Verify { path, password } => do_verify(&path, password.as_deref()),
        Command::Info { path, password } => do_info(&path, password.as_deref()),
        Command::Recover { path, code } => do_recover(&path, code.as_deref()),
        Command::Export {
            path,
            outdir,
            password,
        } => do_export(&path, &outdir, password.as_deref()),
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
            let password = take_flag(&mut args, "--password")?;
            let path = one_positional(args, &cmd, "<path>")?;
            Ok(if cmd == "verify" {
                Command::Verify { path, password }
            } else {
                Command::Info { path, password }
            })
        }
        "recover" => {
            let code = take_flag(&mut args, "--code")?;
            let path = one_positional(args, &cmd, "<path>")?;
            Ok(Command::Recover { path, code })
        }
        "export" => {
            let password = take_flag(&mut args, "--password")?;
            let (path, outdir) = two_positionals(args, &cmd)?;
            Ok(Command::Export {
                path,
                outdir,
                password,
            })
        }
        other => Err(format!("Unknown command: {other}")),
    }
}

/// Pull `--flag <value>` out of the argument list, if present. Removes both the
/// flag and its value so what remains is purely positional.
fn take_flag(args: &mut Vec<String>, flag: &str) -> Result<Option<String>, String> {
    match args.iter().position(|a| a == flag) {
        Some(pos) => {
            if pos + 1 >= args.len() {
                return Err(format!("`{flag}` needs a value."));
            }
            let value = args.remove(pos + 1);
            args.remove(pos);
            Ok(Some(value))
        }
        None => Ok(None),
    }
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

fn resolve_password(flag: Option<&str>) -> Result<String, String> {
    if let Some(p) = flag {
        return Ok(p.to_string());
    }
    match std::env::var("ROOMAI_PASSWORD") {
        Ok(v) if !v.is_empty() => Ok(v),
        _ => Err("No password. Set ROOMAI_PASSWORD or pass --password <p>.".into()),
    }
}

fn resolve_code(flag: Option<&str>) -> Result<String, String> {
    if let Some(c) = flag {
        return Ok(c.to_string());
    }
    match std::env::var("ROOMAI_RECOVERY") {
        Ok(v) if !v.is_empty() => Ok(v),
        _ => Err("No recovery code. Set ROOMAI_RECOVERY or pass --code <c>.".into()),
    }
}

// --------------------------------------------------------------- commands

fn do_verify(path: &str, pw_flag: Option<&str>) -> Result<(), String> {
    let password = resolve_password(pw_flag)?;
    let conn = db::open_room(path, &password)?;
    print_ok(&conn);
    Ok(())
}

fn do_info(path: &str, pw_flag: Option<&str>) -> Result<(), String> {
    let password = resolve_password(pw_flag)?;
    let conn = db::open_room(path, &password)?;
    print_ok(&conn);
    print_meta_dump(&conn);
    Ok(())
}

fn do_recover(path: &str, code_flag: Option<&str>) -> Result<(), String> {
    let code = resolve_code(code_flag)?;
    let conn = db::open_with_recovery(path, &code)?;
    print_ok(&conn);
    Ok(())
}

fn do_export(path: &str, outdir: &str, pw_flag: Option<&str>) -> Result<(), String> {
    let password = resolve_password(pw_flag)?;
    let conn = db::open_room(path, &password)?;

    std::fs::create_dir_all(outdir)
        .map_err(|e| format!("Could not create {outdir}: {e}"))?;

    let mut stmt = conn
        .prepare("SELECT name, original_bytes FROM files ORDER BY created_at, rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let name: String = r.get(0)?;
            let bytes: Option<Vec<u8>> = r.get(1)?;
            Ok((name, bytes))
        })
        .map_err(|e| e.to_string())?;

    let mut used: HashSet<String> = HashSet::new();
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
    println!("OK: decrypts and is a valid Private Room file.");
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

/// Make `base` unique within this export run so two files that share a name
/// don't silently clobber each other. Appends ` (2)`, ` (3)`, … before the
/// extension.
fn unique_name(used: &mut HashSet<String>, base: &str) -> String {
    if used.insert(base.to_string()) {
        return base.to_string();
    }
    let (stem, ext) = match base.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (base.to_string(), String::new()),
    };
    let mut n = 2;
    loop {
        let candidate = format!("{stem} ({n}){ext}");
        if used.insert(candidate.clone()) {
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

    #[test]
    fn verify_reads_password_flag_in_any_position() {
        let want = Command::Verify {
            path: "room.room".into(),
            password: Some("hunter2".into()),
        };
        assert_eq!(
            parse(argv(&["verify", "room.room", "--password", "hunter2"])).unwrap(),
            want
        );
        assert_eq!(
            parse(argv(&["verify", "--password", "hunter2", "room.room"])).unwrap(),
            want
        );
    }

    #[test]
    fn verify_without_flag_leaves_password_none() {
        assert_eq!(
            parse(argv(&["verify", "room.room"])).unwrap(),
            Command::Verify {
                path: "room.room".into(),
                password: None,
            }
        );
    }

    #[test]
    fn info_parses() {
        assert_eq!(
            parse(argv(&["info", "room.room"])).unwrap(),
            Command::Info {
                path: "room.room".into(),
                password: None,
            }
        );
    }

    #[test]
    fn recover_reads_code_flag() {
        assert_eq!(
            parse(argv(&["recover", "room.room", "--code", "AAAA-BBBB"])).unwrap(),
            Command::Recover {
                path: "room.room".into(),
                code: Some("AAAA-BBBB".into()),
            }
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
                password: None,
            }
        );
    }

    #[test]
    fn unknown_flag_is_rejected() {
        assert!(parse(argv(&["verify", "room.room", "--nope"])).is_err());
        assert!(parse(argv(&["verify", "--passwrod", "x", "room.room"])).is_err());
    }

    #[test]
    fn dangling_flag_value_errors() {
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
}
