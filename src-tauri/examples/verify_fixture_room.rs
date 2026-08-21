// Phase 0 spike S1, reverse direction: can the SHIPPED Rust app still open a
// room that the Node/better-sqlite3-multiple-ciphers side wrote or rekeyed?
// D2 promises "old roomai/Rust builds can still read new files" — this is
// what proves it, using the exact production `open_room_readonly` path.
//
// Usage: cargo run --manifest-path src-tauri/Cargo.toml --example \
//   verify_fixture_room -- <path> <password>
use arcelle_lib::db;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: verify_fixture_room <path> <password>");
    let password = args.next().expect("usage: verify_fixture_room <path> <password>");

    match db::open_room_readonly(&path, &password) {
        Ok(conn) => {
            let count: i64 = conn
                .query_row("SELECT count(*) FROM memories", [], |r| r.get(0))
                .expect("count memories");
            println!("OK: opened, {count} memories readable");
        }
        Err(e) => {
            println!("FAIL: {e}");
            std::process::exit(1);
        }
    }
}
