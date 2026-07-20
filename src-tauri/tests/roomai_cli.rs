//! End-to-end test for the `roomai` CLI binary: create a real encrypted room
//! with the lib, then drive the built binary the way a user would. Cargo hands
//! us the binary path via CARGO_BIN_EXE_roomai.

use arcelle_lib::db;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_roomai");

fn make_room(path: &str, password: &str) {
    let conn = db::create_room(path, password, "clitest").unwrap();
    conn.execute(
        "INSERT INTO files(id, name, mime_type, size_bytes, original_bytes, extracted_text)
         VALUES ('f1', 'notes.txt', 'text/plain', 5, x'68656c6c6f', 'hello')",
        [],
    )
    .unwrap();
}

#[test]
fn cli_verify_info_recover_export() {
    let dir = std::env::temp_dir().join(format!("roomai-cli-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("cli.roomai");
    let path_str = path.to_string_lossy().to_string();
    make_room(&path_str, "hunter22");
    // Set up a recovery code for the `recover` path.
    let code = db::write_recovery(&path_str, "hunter22").unwrap();

    // verify with the right password → exit 0, prints OK.
    let out = Command::new(BIN)
        .args(["verify", &path_str])
        .env("ROOMAI_PASSWORD", "hunter22")
        .output()
        .unwrap();
    assert!(out.status.success(), "verify failed: {:?}", out);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("OK"), "verify stdout: {stdout}");

    // info dumps meta keys.
    let out = Command::new(BIN)
        .args(["info", &path_str])
        .env("ROOMAI_PASSWORD", "hunter22")
        .output()
        .unwrap();
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("roomai"), "info stdout: {stdout}");

    // wrong password → non-zero exit, nothing leaked on stdout.
    let out = Command::new(BIN)
        .args(["verify", &path_str])
        .env("ROOMAI_PASSWORD", "nope")
        .output()
        .unwrap();
    assert!(!out.status.success(), "wrong password should fail");

    // recover with the code → exit 0.
    let out = Command::new(BIN)
        .args(["recover", &path_str])
        .env("ROOMAI_RECOVERY", &code)
        .output()
        .unwrap();
    assert!(out.status.success(), "recover failed: {:?}", out);

    // export writes the stored file back out.
    let outdir = dir.join("out");
    let out = Command::new(BIN)
        .args(["export", &path_str, &outdir.to_string_lossy()])
        .env("ROOMAI_PASSWORD", "hunter22")
        .output()
        .unwrap();
    assert!(out.status.success(), "export failed: {:?}", out);
    let written = std::fs::read(outdir.join("notes.txt")).unwrap();
    assert_eq!(written, b"hello", "exported bytes should match the stored file");

    std::fs::remove_dir_all(&dir).unwrap();
}
