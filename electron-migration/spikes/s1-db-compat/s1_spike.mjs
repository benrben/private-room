// Phase 0 spike S1 — does better-sqlite3-multiple-ciphers open a REAL
// SQLCipher-4 `.room` file written by the shipped Rust app, in place, with no
// converter? This is the one spike that changes the whole plan if it fails
// (plan §8 Phase 0; fallback = resurrect the pysqlcipher3 converter).
//
// Fixtures come from `cargo run --example gen_fixture_room` (the actual
// production create_room/add_memory/rekey code path), not a hand-rolled
// approximation — see src-tauri/examples/gen_fixture_room.rs.
import Database from "better-sqlite3-multiple-ciphers";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    console.log(`FAIL  ${label}`);
    failures++;
  }
}

// schema.rs apply_key: conn.pragma_update(None, "key", password) then
// `PRAGMA cipher_compatibility = 4;` under rusqlite/libsqlite3-sys' bundled
// SQLCipher. SQLite3MultipleCiphers (what better-sqlite3-multiple-ciphers
// links) exposes the SAME on-disk format via its "sqlcipher" cipher scheme:
// `PRAGMA cipher='sqlcipher'; PRAGMA legacy=4;` before the key. Order here
// matters: legacy must be set before `key` is applied so the KDF/HMAC layout
// matches on first read.
function openRoom(file, password, { readonly = false } = {}) {
  const db = new Database(file, { readonly });
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  // Pragma has no parameter binding (schema.rs:600 note) — the Rust side
  // doubles single quotes; mirror it exactly rather than relying on the
  // driver's `key()` helper doing it differently.
  const escaped = password.replace(/'/g, "''");
  db.pragma(`key='${escaped}'`);
  return db;
}

function firstReadOk(db) {
  try {
    db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    return true;
  } catch {
    return false;
  }
}

// --- 1. plain.roomai: open, read schema-created rows, read the two memories ---
{
  const file = path.join(fixtures, "plain.roomai");
  const db = openRoom(file, "correct horse battery staple");
  check("plain.roomai: first read succeeds", firstReadOk(db));
  const meta = db
    .prepare("SELECT value FROM meta WHERE key='format'")
    .get();
  check("plain.roomai: meta.format = 'roomai'", meta?.value === "roomai");
  const uv = db.pragma("user_version", { simple: true });
  check("plain.roomai: user_version = 3 (CURRENT_USER_VERSION)", uv === 3);
  const memories = db.prepare("SELECT content FROM memories ORDER BY created_at").all();
  check("plain.roomai: 2 memories present", memories.length === 2);
  check(
    "plain.roomai: Hebrew round-trips as UTF-8 (שלום עולם)",
    memories.some((m) => m.content.includes("שלום עולם"))
  );
  db.close();
}

// --- 2. wrong password classification: must fail cleanly, not crash ---
{
  const file = path.join(fixtures, "plain.roomai");
  const db = openRoom(file, "definitely the wrong password");
  const ok = firstReadOk(db);
  check("plain.roomai + wrong password: first read fails (not silently ok)", !ok);
  db.close();
}

// --- 3. quote-password.roomai: single-quote-containing password ---
{
  const file = path.join(fixtures, "quote-password.roomai");
  const password = "it's a trap' -- ";
  const db = openRoom(file, password);
  check("quote-password.roomai: opens with quote-containing password", firstReadOk(db));
  const memories = db.prepare("SELECT content FROM memories").all();
  check(
    "quote-password.roomai: memory row readable",
    memories.length === 1 && memories[0].content.includes("quote-containing password")
  );
  db.close();
}

// --- 4. rekeyed.roomai: opens with the POST-rekey password only ---
{
  const file = path.join(fixtures, "rekeyed.roomai");
  const dbOld = openRoom(file, "original password 1");
  check("rekeyed.roomai: old password fails after Rust-side rekey", !firstReadOk(dbOld));
  dbOld.close();

  const db = openRoom(file, "new password 2!!");
  check("rekeyed.roomai: new password opens", firstReadOk(db));
  const memories = db.prepare("SELECT content FROM memories ORDER BY created_at").all();
  check("rekeyed.roomai: both pre- and post-rekey rows present", memories.length === 2);
  db.close();
}

// --- 5. Node-side rekey of a Rust-created room (bidirectional compat) ---
{
  const src = path.join(fixtures, "plain.roomai");
  const dst = path.join(fixtures, "node-rekeyed-copy.roomai");
  const fs = await import("node:fs");
  fs.copyFileSync(src, dst);
  const db = openRoom(dst, "correct horse battery staple");
  db.pragma("rekey='node applied this password'");
  db.close();

  const reopened = openRoom(dst, "node applied this password");
  check("Node-side PRAGMA rekey then reopen with new password", firstReadOk(reopened));
  reopened.close();

  const withOld = openRoom(dst, "correct horse battery staple");
  check("Node-rekeyed room: old password now fails", !firstReadOk(withOld));
  withOld.close();
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
