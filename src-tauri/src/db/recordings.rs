use super::*;

// ADD-27: per-file recording metadata (segments with word timings, speakers,
// cut list) as one JSON blob keyed by file id. The row's EXISTENCE is also
// the marker that turns a plain audio file into a "recording" in the viewer.
// The transcript itself is NOT here — it stays in files.extracted_text where
// search, RAG and every AI action already find it.

pub fn set_rec_meta(conn: &Connection, file_id: &str, meta_json: &str) -> Result<(), String> {
    execute_one(
        conn,
        "INSERT INTO recordings(file_id, meta) VALUES (?1, ?2)
         ON CONFLICT(file_id) DO UPDATE SET meta = excluded.meta",
        params![file_id, meta_json],
    )
}

/// A recording's meta, or None when this file is not a recording.
///
/// Joined to `files` for the trash clause: the meta IS the transcript —
/// segments, every word, the speakers the user named — so a by-id read of a
/// deleted recording hands back its content in full. The `recordings` row has
/// no `trashed_at` of its own (it is keyed only by file id), and the join is
/// what keeps the invariant `get_file_meta` documents true here too. The
/// transcript-editing commands (`rec_set_speaker_name`, `rec_delete_range`)
/// reach this before they touch any filtered read, so this is their only gate.
pub fn get_rec_meta(conn: &Connection, file_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT r.meta FROM recordings r JOIN files f ON f.id = r.file_id
         WHERE r.file_id = ?1 AND f.trashed_at IS NULL",
        [file_id],
        |r| r.get(0),
    )
    .ok()
}

/// Recordings the room has never read (see `jobs::rec_read`) — the set the
/// background sweep works through so recordings made before this feature
/// existed fill in by themselves.
///
/// "Never read" is `readOf` being absent, which is exactly what
/// `RecMeta.read_of` serializes to when unset — read through `json_extract`
/// rather than a LIKE on the blob, so a note whose text happens to contain the
/// word cannot make a recording look read. A recording with no transcript yet
/// is skipped: there is nothing to read, and asking a model about silence
/// wastes the machine.
///
/// Trashed files are excluded by the same join `get_rec_meta` uses.
pub fn recordings_missing_read(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<String>, String> {
    query_rows(
        conn,
        "SELECT r.file_id FROM recordings r JOIN files f ON f.id = r.file_id
         WHERE f.trashed_at IS NULL
           AND json_extract(r.meta, '$.readOf') IS NULL
           AND json_array_length(r.meta, '$.segments') > 0
         ORDER BY f.created_at DESC
         LIMIT ?1",
        [limit as i64],
        |r| r.get(0),
    )
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
    execute_one(
        conn,
        "INSERT INTO rec_chunks(file_id, seq, pcm)
         VALUES (?1, 1 + COALESCE((SELECT MAX(seq) FROM rec_chunks WHERE file_id = ?1), 0), ?2)",
        params![file_id, pcm],
    )
}

/// Drop a file's checkpoints — the full WAV was just written.
pub fn clear_rec_chunks(conn: &Connection, file_id: &str) -> Result<(), String> {
    execute_one(conn, "DELETE FROM rec_chunks WHERE file_id = ?1", [file_id])
}

/// Write the assembled WAV (plus its transcript) and drop the now-redundant
/// checkpoints as ONE transaction.
///
/// These used to be two independent statements, and nothing tied them
/// together: a failure — or a crash — between them left a complete recording
/// with its checkpoints still on disk, and the next `recover_rec_chunks`
/// dutifully spliced that tail onto the end of audio that already contained
/// it, so part of the recording played twice. Either both land or neither
/// does; the flush that failed simply retries.
pub fn finalize_rec_audio(
    conn: &Connection,
    file_id: &str,
    wav: &[u8],
    text: Option<&str>,
) -> Result<(), String> {
    in_transaction(conn, || {
        update_file_content(conn, file_id, wav, text)?;
        clear_rec_chunks(conn, file_id)
    })
}

/// Recover any recording whose live session died before its final write:
/// splice the checkpointed tail onto the stored WAV and clear the chunks.
/// Idempotent, and free when there is nothing to recover (the normal case).
pub fn recover_rec_chunks(conn: &Connection) -> Result<usize, String> {
    let ids: Vec<String> = query_rows(
        conn,
        "SELECT DISTINCT file_id FROM rec_chunks",
        [],
        |r| r.get(0),
    )?;
    let mut recovered = 0usize;
    // One recording that cannot be rescued must not take the others down with
    // it. A damaged WAV, a failing write — anything — used to abort the loop on
    // the spot, so a single bad file meant every OTHER interrupted recording in
    // the room stayed unrescued, on every unlock, forever. Failures are counted
    // here and reported at the end; their checkpoints stay put, so the next
    // unlock tries again.
    let mut failed = 0usize;
    for id in &ids {
        // A file trashed while its live session was still checkpointing has no
        // row this read can find. SKIPPED, not failed: `?` here aborted the
        // whole loop, so one deleted recording would take the rescue of every
        // OTHER interrupted recording in the room down with it — and the user
        // would be told the recovery failed. The checkpoints stay put, so a
        // restore still finds its tail waiting on the next open.
        let Ok(stored) = get_file_bytes(conn, id) else { continue };
        match recover_one(conn, id, stored) {
            Ok(()) => recovered += 1,
            Err(_) => failed += 1,
        }
    }
    if failed > 0 {
        // Counts only — a recording's name is room content. `recovered` is
        // reported alongside so the message can never read as a total loss.
        return Err(format!(
            "{failed} of {} interrupted recording(s) could not be restored \
             ({recovered} were). Their audio is still stored in the room and the \
             rescue runs again the next time you unlock it.",
            ids.len(),
        ));
    }
    Ok(recovered)
}

/// Splice one recording's checkpointed tail onto its stored WAV.
fn recover_one(conn: &Connection, id: &str, stored: Option<Vec<u8>>) -> Result<(), String> {
    let mut samples = stored
        .map(|b| crate::recording::decode_wav(&b))
        .transpose()?
        .unwrap_or_default();
    let chunks: Vec<Vec<u8>> = query_rows(
        conn,
        "SELECT pcm FROM rec_chunks WHERE file_id = ?1 ORDER BY seq",
        [id],
        |r| r.get(0),
    )?;
    for pcm in chunks {
        samples.extend(
            pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0),
        );
    }
    let wav = crate::recording::encode_wav(&samples);
    // The transcript was checkpointed by every flush and is CURRENT —
    // it must ride through, or this rescue would erase it.
    let text = get_file_extracted_text(conn, id);
    // The write and the checkpoint drop are one step, for the same reason
    // `finalize_rec_audio` is: a WAV that already contains its tail, with the
    // checkpoints still on disk, gets that tail spliced on AGAIN next time.
    in_transaction(conn, || {
        update_file_content(conn, id, &wav, text.as_deref())?;
        clear_rec_chunks(conn, id)
    })
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

    /// The final write and the checkpoint cleanup are one step. A complete
    /// WAV whose checkpoints survived would be spliced onto itself by the
    /// next crash recovery, and part of the recording would play twice.
    #[test]
    fn finalizing_writes_the_wav_and_clears_the_checkpoints_together() {
        let conn = mem();
        let id = add_file(&conn, "call.wav", "(live recording)");
        let tail = vec![0.5f32; 800];
        append_rec_chunk(&conn, &id, &tail).unwrap();
        append_rec_chunk(&conn, &id, &tail).unwrap();

        let whole = crate::recording::encode_wav(&vec![0.5f32; 1600]);
        finalize_rec_audio(&conn, &id, &whole, Some("(live recording)\n")).unwrap();
        assert_eq!(get_file_bytes(&conn, &id).unwrap().as_deref(), Some(whole.as_slice()));
        let left: i64 = conn
            .query_row("SELECT count(*) FROM rec_chunks WHERE file_id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "checkpoints survived a completed write");

        // Recovery over a finalized recording is a no-op, so nothing is
        // appended to audio that already contains it.
        assert_eq!(recover_rec_chunks(&conn).unwrap(), 0);
        assert_eq!(get_file_bytes(&conn, &id).unwrap().as_deref(), Some(whole.as_slice()));

        // A write that fails leaves the checkpoints alone, so the next flush
        // can still retry the whole tail. (The transaction is what makes the
        // two halves inseparable in either direction.)
        append_rec_chunk(&conn, &id, &tail).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(finalize_rec_audio(&conn, &id, &whole, None).is_ok());
        conn.execute_batch("ROLLBACK").unwrap();
        let still: i64 = conn
            .query_row("SELECT count(*) FROM rec_chunks WHERE file_id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(still, 1, "a rolled-back write must keep its checkpoints");
    }

    /// A deleted recording must not take the crash rescue of the OTHERS down
    /// with it.
    ///
    /// The rescue reads each checkpointed file's stored bytes BY ID, and that
    /// read honours the trash — so `?` on it aborted the whole loop the moment
    /// one interrupted recording had since been deleted. Every other room-mate
    /// of that file lost its tail, and the user was told the recovery failed.
    #[test]
    fn a_trashed_recording_does_not_take_the_crash_rescue_down_with_it() {
        let conn = mem();
        let deleted = add_file(&conn, "old call.wav", "(live recording)");
        let live = add_file(&conn, "board meeting.wav", "(live recording)");
        // Both died mid-session with a checkpointed tail on disk.
        update_file_content(&conn, &live, &crate::recording::encode_wav(&[0.25f32; 400]), None)
            .unwrap();
        append_rec_chunk(&conn, &deleted, &[0.1f32; 200]).unwrap();
        append_rec_chunk(&conn, &live, &[0.3f32; 200]).unwrap();
        trash_file(&conn, &deleted, TrashActor::User).unwrap();

        assert_eq!(recover_rec_chunks(&conn).unwrap(), 1, "the surviving one was rescued");
        let left: i64 = conn
            .query_row("SELECT count(*) FROM rec_chunks WHERE file_id = ?1", [&live], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "its checkpoints were consumed");
        // The trashed one's tail is kept rather than thrown away: trash is
        // reversible, so a restore must still find something to recover.
        let kept: i64 = conn
            .query_row("SELECT count(*) FROM rec_chunks WHERE file_id = ?1", [&deleted], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kept, 1);
    }

    /// One recording that genuinely CANNOT be rescued — damaged stored audio —
    /// must not cancel the rescue of the others, and must be reported.
    ///
    /// The failure used to abort the loop with `?`, so a single unreadable WAV
    /// meant every other interrupted recording in the room stayed unrescued on
    /// every unlock, forever, while the caller (which then swallowed the error)
    /// said nothing at all.
    #[test]
    fn a_recording_that_cannot_be_rescued_does_not_cancel_the_others() {
        let conn = mem();
        let damaged = add_file(&conn, "garbled.wav", "(live recording)");
        let good = add_file(&conn, "board meeting.wav", "(live recording)");
        // Not a WAV at all — decoding it fails.
        update_file_content(&conn, &damaged, b"this is not a wav file", None).unwrap();
        update_file_content(&conn, &good, &crate::recording::encode_wav(&[0.25f32; 400]), None)
            .unwrap();
        append_rec_chunk(&conn, &damaged, &[0.1f32; 200]).unwrap();
        append_rec_chunk(&conn, &good, &[0.3f32; 200]).unwrap();

        let err = recover_rec_chunks(&conn).expect_err("a failed rescue must be reported");
        assert!(err.contains("1 of 2"), "{err}");
        assert!(err.contains("still stored"), "the message must say nothing was lost: {err}");
        // The healthy one was rescued anyway…
        let left: i64 = conn
            .query_row("SELECT count(*) FROM rec_chunks WHERE file_id = ?1", [&good], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "a healthy recording was skipped because of a damaged one");
        // …and the damaged one keeps its tail for the next attempt.
        let kept: i64 = conn
            .query_row("SELECT count(*) FROM rec_chunks WHERE file_id = ?1", [&damaged], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kept, 1);
    }
}
