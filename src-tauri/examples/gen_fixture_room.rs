// Electron/Python migration spike S1: produce real `.room` files with the
// SHIPPED Rust app's own `create_room`/`add_memory`/`rekey` code path, so the
// Node-side `better-sqlite3-multiple-ciphers` compatibility spike opens
// exactly what the production app writes — not a hand-rolled approximation.
//
// Usage: cargo run --manifest-path src-tauri/Cargo.toml --example gen_fixture_room -- <out-dir>
//
// Writes (all named for what the Node spike must prove):
//   plain.roomai            password "correct horse battery staple"
//   quote-password.roomai   password containing a single quote (pragma-escaping test)
//   rekeyed.roomai          created then rekeyed to a second password
use arcelle_lib::db;

fn main() {
    let out_dir = std::env::args()
        .nth(1)
        .expect("usage: gen_fixture_room <out-dir>");
    let out_dir = std::path::PathBuf::from(out_dir);
    std::fs::create_dir_all(&out_dir).expect("create out dir");

    // 1. Plain room with ordinary password.
    {
        let path = out_dir.join("plain.roomai");
        let path_str = path.to_string_lossy().to_string();
        if path.exists() {
            std::fs::remove_file(&path).unwrap();
        }
        let conn = db::create_room(&path_str, "correct horse battery staple", "Fixture Room")
            .expect("create_room");
        db::add_memory(&conn, "The migration spike ran on 2026-08-22.", Some("fact"))
            .expect("add_memory");
        db::add_memory(&conn, "Hebrew check: שלום עולם", None).expect("add_memory hebrew");
        drop(conn);
        println!("wrote {path_str}");
    }

    // 2. Password containing a single quote — the pragma-escaping trap
    // (schema.rs applies the key via string-interpolated PRAGMA, doubling
    // single quotes; the Node port must double them the same way).
    {
        let path = out_dir.join("quote-password.roomai");
        let path_str = path.to_string_lossy().to_string();
        if path.exists() {
            std::fs::remove_file(&path).unwrap();
        }
        let password = "it's a trap' -- ";
        let conn = db::create_room(&path_str, password, "Quote Password Room")
            .expect("create_room with quote password");
        db::add_memory(&conn, "opened with a quote-containing password", None)
            .expect("add_memory");
        drop(conn);
        println!("wrote {path_str} (password recorded in fixtures/README, not here)");
    }

    // 3. Room created then rekeyed — proves `PRAGMA rekey` compatibility.
    {
        let path = out_dir.join("rekeyed.roomai");
        let path_str = path.to_string_lossy().to_string();
        if path.exists() {
            std::fs::remove_file(&path).unwrap();
        }
        let conn =
            db::create_room(&path_str, "original password 1", "Rekeyed Room").expect("create_room");
        db::add_memory(&conn, "written before rekey", None).expect("add_memory");
        db::rekey(&conn, "new password 2!!").expect("rekey");
        db::add_memory(&conn, "written after rekey", None).expect("add_memory post-rekey");
        drop(conn);
        println!("wrote {path_str}");
    }

    println!("done");
}
