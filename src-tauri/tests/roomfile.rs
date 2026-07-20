use arcelle_lib::db;
use arcelle_lib::extraction;

#[test]
fn roomai_lifecycle_and_encryption() {
    let dir = std::env::temp_dir().join(format!("roomai-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("test.roomai");
    let path_str = path.to_string_lossy().to_string();

    // Create a room and store something in it.
    {
        let conn = db::create_room(&path_str, "hunter22", "test").unwrap();
        conn.execute(
            "INSERT INTO files(id, name, mime_type, size_bytes, original_bytes, extracted_text)
             VALUES ('f1', 'secret.txt', 'text/plain', 24, x'00', 'the launch code is 4242')",
            [],
        )
        .unwrap();
    }

    // The file on disk must not look like a plaintext SQLite database.
    let header = std::fs::read(&path).unwrap();
    assert!(header.len() > 16);
    assert_ne!(
        &header[..16],
        b"SQLite format 3\0",
        "room file is NOT encrypted!"
    );
    assert!(
        !header
            .windows(b"launch code".len())
            .any(|w| w == b"launch code"),
        "plaintext content leaked into the room file!"
    );

    // Wrong password must be rejected.
    let err = db::open_room(&path_str, "wrong-password").unwrap_err();
    assert_eq!(err, "WRONG_PASSWORD");

    // Correct password opens and reads the stored data back.
    let conn = db::open_room(&path_str, "hunter22").unwrap();
    let text: String = conn
        .query_row("SELECT extracted_text FROM files WHERE id = 'f1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(text, "the launch code is 4242");

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn migrates_old_rooms_into_sessions() {
    let dir = std::env::temp_dir().join(format!("roomai-migrate-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("old.roomai");
    let path_str = path.to_string_lossy().to_string();

    // Simulate a room written by the pre-sessions app version:
    // messages table without chat_id, no chats table.
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "key", "pw").unwrap();
        conn.execute_batch(
            "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE messages(
               id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL,
               sources TEXT,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
             INSERT INTO meta VALUES('format','roomai'),('name','old');
             INSERT INTO messages(id, role, content) VALUES('m1','user','hello');",
        )
        .unwrap();
    }

    let conn = db::open_room(&path_str, "pw").unwrap();
    let title: String = conn
        .query_row("SELECT title FROM chats", [], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "Earlier conversation");
    let chat_id: Option<String> = conn
        .query_row("SELECT chat_id FROM messages WHERE id = 'm1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(chat_id.is_some(), "old message was not adopted into a chat");

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn chunking_and_extraction() {
    let text = "para one\n\npara two\n\n".repeat(200);
    let chunks = extraction::chunk_text(&text, 1200);
    assert!(!chunks.is_empty());
    assert!(chunks.iter().all(|c| c.len() <= 3000));

    let extracted = extraction::extract_text("notes.md", "hello **world**".as_bytes()).unwrap();
    assert!(extracted.contains("hello"));

    let html = "<html><body><p>alpha</p><script>var x=1;</script><p>beta</p></body></html>";
    let extracted = extraction::extract_text("page.html", html.as_bytes()).unwrap();
    assert!(extracted.contains("alpha"));
    assert!(extracted.contains("beta"));
    assert!(!extracted.contains("var x"));
}
