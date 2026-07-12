use super::*;

// ADD-27: per-file recording metadata (segments with word timings, speakers,
// cut list) as one JSON blob keyed by file id. The row's EXISTENCE is also
// the marker that turns a plain audio file into a "recording" in the viewer.
// The transcript itself is NOT here — it stays in files.extracted_text where
// search, RAG and every AI action already find it.

pub fn set_rec_meta(conn: &Connection, file_id: &str, meta_json: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO recordings(file_id, meta) VALUES (?1, ?2)
         ON CONFLICT(file_id) DO UPDATE SET meta = excluded.meta",
        params![file_id, meta_json],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn get_rec_meta(conn: &Connection, file_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT meta FROM recordings WHERE file_id = ?1",
        [file_id],
        |r| r.get(0),
    )
    .ok()
}

// ---- live-recording audio checkpoints -----------------------------------
//
// A live session's periodic saves used to rewrite the file's ENTIRE growing
// WAV (an hour in ≈ 115 MB, re-encrypted every minute). Instead, the audio
// recorded since the last full write is APPENDED here as raw 16-bit PCM
// chunks; pause/stop assemble the real WAV once and clear the chunks. After
// a crash the chunks still hold everything since the last pause —
// reassembled the next time the room opens.

/// Append one checkpoint of mono 16 kHz samples for a live recording.
pub fn append_rec_chunk(conn: &Connection, file_id: &str, samples: &[f32]) -> Result<(), String> {
    let mut pcm = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        pcm.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    conn.execute(
        "INSERT INTO rec_chunks(file_id, seq, pcm)
         VALUES (?1, 1 + COALESCE((SELECT MAX(seq) FROM rec_chunks WHERE file_id = ?1), 0), ?2)",
        params![file_id, pcm],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Drop a file's checkpoints — the full WAV was just written.
pub fn clear_rec_chunks(conn: &Connection, file_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM rec_chunks WHERE file_id = ?1", [file_id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Recover any recording whose live session died before its final write:
/// splice the checkpointed tail onto the stored WAV and clear the chunks.
/// Idempotent, and free when there is nothing to recover (the normal case).
pub fn recover_rec_chunks(conn: &Connection) -> Result<usize, String> {
    let ids: Vec<String> = {
        let mut stmt =
            conn.prepare("SELECT DISTINCT file_id FROM rec_chunks").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for id in &ids {
        let mut samples = get_file_bytes(conn, id)?
            .map(|b| crate::recording::decode_wav(&b))
            .transpose()?
            .unwrap_or_default();
        let chunks: Vec<Vec<u8>> = {
            let mut stmt = conn
                .prepare("SELECT pcm FROM rec_chunks WHERE file_id = ?1 ORDER BY seq")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([id.as_str()], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        for pcm in chunks {
            samples.extend(
                pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0),
            );
        }
        let wav = crate::recording::encode_wav(&samples);
        // The transcript was checkpointed by every flush and is CURRENT —
        // it must ride through, or this rescue would erase it.
        let text = get_file_extracted_text(conn, id);
        update_file_content(conn, id, &wav, text.as_deref())?;
        clear_rec_chunks(conn, id)?;
    }
    Ok(ids.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rec_meta_roundtrip_upsert_and_cascade() {
        let conn = mem();
        let id = add_file(&conn, "call.wav", "(live recording)");
        assert!(get_rec_meta(&conn, &id).is_none());
        set_rec_meta(&conn, &id, r#"{"version":1}"#).unwrap();
        assert_eq!(get_rec_meta(&conn, &id).as_deref(), Some(r#"{"version":1}"#));
        set_rec_meta(&conn, &id, r#"{"version":2}"#).unwrap();
        assert_eq!(get_rec_meta(&conn, &id).as_deref(), Some(r#"{"version":2}"#));
        // Deleting the file takes the meta row with it (ON DELETE CASCADE).
        delete_file(&conn, &id).unwrap();
        assert!(get_rec_meta(&conn, &id).is_none());
    }
}
