use super::*;

// ---------------------------------------------------------------- embeddings (ADD-13)

/// ADD-13: encode an embedding as a compact little-endian f32 BLOB for storage
/// in `chunks.embedding`. Round-trips with `blob_to_embedding`.
pub fn embedding_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// ADD-13: decode a little-endian f32 BLOB back into a vector. A blob whose
/// length is not a whole number of f32s (corrupt / foreign) reads as None so the
/// caller silently skips it rather than mis-scoring it.
pub fn blob_to_embedding(b: &[u8]) -> Option<Vec<f32>> {
    if b.is_empty() || b.len() % 4 != 0 {
        return None;
    }
    Some(
        b.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// ADD-13: cosine similarity of two vectors. Returns 0.0 when the lengths
/// differ, either is empty, or either has zero magnitude — a safe "no signal"
/// value for the blend.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0f32;
    let mut na = 0f32;
    let mut nb = 0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// ADD-13: a batch of chunks that still lack an embedding — (chunk id, file
/// name, text). CHG-12: the file name is prepended when embedding as a
/// `search_document:` so a paragraph that never names its own file ("...pets
/// allowed...") can still match a question that does ("what does the lease say
/// about pets"). The background pass drains these in batches until none remain.
pub fn chunks_missing_embedding(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<(String, String, String)>, String> {
    query_rows(
        conn,
        // `f.trashed_at IS NULL` is redundant with trashing MOVING the chunks
        // out of this table — and stays anyway. Two of the retrieval queries
        // below cannot express the filter at all (they never touch `files`), so
        // the move is the real guarantee; where a query does have `f` in scope,
        // saying it as well costs nothing and means a future change to how the
        // trash stores chunks cannot quietly leak deleted text into an answer.
        "SELECT c.id, f.name, c.text
         FROM chunks c JOIN files f ON f.id = c.file_id
         WHERE c.embedding IS NULL AND f.trashed_at IS NULL LIMIT ?1",
        [limit as i64],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
}

/// ADD-13: store an embedding BLOB on one chunk (by chunk id).
pub fn set_chunk_embedding(conn: &Connection, id: &str, blob: &[u8]) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE chunks SET embedding = ?2 WHERE id = ?1",
        params![id, blob],
    )
}

/// CHG-15: hand every chunk's (rowid, embedding blob) to `visit` one row at a
/// time, straight out of SQLite's own row buffer — NO text. The brute-force
/// cosine pass scores over just these, so only the ~24 winners' text is ever
/// copied (via `chunks_by_rowids`). The rowid keys the keyword/vector blend.
///
/// It used to JOIN `c.text` for every embedded chunk on every question — tens of
/// MB of discarded String allocation under the room mutex — and then, once that
/// was fixed, still copied EVERY blob into a `Vec<(i64, Vec<u8>)>` before
/// scoring a single one, with `blob_to_embedding` allocating a second
/// `Vec<f32>` per chunk on top. On a room holding a couple of long books that
/// is tens of megabytes allocated, walked once and dropped, on every question,
/// with the room locked the whole time. Streaming (with `cosine_similarity_blob`
/// scoring off the borrowed bytes) allocates nothing per chunk and keeps peak
/// memory flat however large the room grows. The scan is still linear in chunk
/// count — only an approximate-nearest-neighbour index would change that.
///
/// Rows whose `embedding` is not a blob are skipped, matching
/// `blob_to_embedding`'s "silently skip rather than mis-score" contract.
pub fn for_each_chunk_embedding(
    conn: &Connection,
    mut visit: impl FnMut(i64, &[u8]),
) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT rowid, embedding FROM chunks WHERE embedding IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let rowid: i64 = row.get(0).map_err(|e| e.to_string())?;
        if let Ok(rusqlite::types::ValueRef::Blob(blob)) = row.get_ref(1) {
            visit(rowid, blob);
        }
    }
    Ok(())
}

/// Cosine similarity between a query vector and an embedding STILL IN its
/// little-endian BLOB form — the same maths, and the same accumulation order,
/// as `cosine_similarity`, without decoding the blob into a `Vec<f32>` first.
/// A blob that is not a whole number of f32s, or that is a different width from
/// the query, scores 0.0 — exactly what `blob_to_embedding` + `cosine_similarity`
/// did for those rows.
pub fn cosine_similarity_blob(query: &[f32], blob: &[u8]) -> f32 {
    if query.is_empty() || blob.len() % 4 != 0 || blob.len() / 4 != query.len() {
        return 0.0;
    }
    let mut dot = 0f32;
    let mut na = 0f32;
    let mut nb = 0f32;
    for (x, c) in query.iter().zip(blob.chunks_exact(4)) {
        let y = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// CHG-15: fetch (rowid, file name, chunk text) for a specific set of chunk
/// rowids — used to hydrate only the top vector candidates after scoring.
pub fn chunks_by_rowids(
    conn: &Connection,
    rowids: &[i64],
) -> Result<Vec<(i64, String, String)>, String> {
    if rowids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = rowids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT c.rowid, f.name, c.text
         FROM chunks c JOIN files f ON f.id = c.file_id
         WHERE c.rowid IN ({placeholders}) AND f.trashed_at IS NULL"
    );
    let params: Vec<&dyn rusqlite::ToSql> =
        rowids.iter().map(|r| r as &dyn rusqlite::ToSql).collect();
    query_rows(conn, &sql, params.as_slice(), |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })
}

/// ADD-13: like `search_chunks_fts` but also returns each hit's chunk rowid so
/// keyword and vector scores can be blended per chunk. (rowid, file name, chunk
/// text, bm25 — smaller is a better match).
pub fn search_chunks_fts_ranked(
    conn: &Connection,
    match_expr: &str,
    limit: usize,
) -> Result<Vec<(i64, String, String, f64)>, String> {
    query_rows(
        conn,
        "SELECT chunks_fts.rowid, f.name, c.text, bm25(chunks_fts)
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         JOIN files f ON f.id = c.file_id
         WHERE chunks_fts MATCH ?1 AND f.trashed_at IS NULL
         ORDER BY bm25(chunks_fts)
         LIMIT ?2",
        params![match_expr, limit as i64],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
}

/// Room map: the file IDS whose chunks match `match_expr`, best match first and
/// each file listed once. `exclude` is dropped from the results — a generated
/// file usually writes its own name into its first line, and a file "mentioning
/// itself" is not a relation.
///
/// Ordered by bm25 rather than left to scan order: the map's frontend only
/// re-lays-out when the edge list actually changes, so a query that returned
/// the same links in a different order every rebuild would scramble the layout
/// for no reason.
pub fn fts_file_matches(
    conn: &Connection,
    match_expr: &str,
    exclude: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    // Over-fetch chunk hits, then keep the first `limit` DISTINCT files: several
    // chunks of one file can all match, and `SELECT DISTINCT` cannot be combined
    // with an `ORDER BY bm25()` the projection doesn't carry.
    let rows: Vec<String> = query_rows(
        conn,
        "SELECT c.file_id
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         WHERE chunks_fts MATCH ?1 AND c.file_id <> ?2
         ORDER BY bm25(chunks_fts)
         LIMIT ?3",
        params![match_expr, exclude, (limit * 20).max(20) as i64],
        |r| r.get(0),
    )?;
    let mut out: Vec<String> = Vec::new();
    for id in rows {
        if !out.contains(&id) {
            out.push(id);
        }
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// (file name, chunk text) for the most recently added chunks — the fallback
/// context when a question matches nothing in the FTS index (CHG-10).
pub fn recent_chunks(conn: &Connection, limit: usize) -> Result<Vec<(String, String)>, String> {
    query_rows(
        conn,
        "SELECT f.name, c.text FROM chunks c JOIN files f ON f.id = c.file_id
         WHERE f.trashed_at IS NULL
         ORDER BY f.created_at DESC, c.seq ASC LIMIT ?1",
        [limit as i64],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedding_blob_round_trips() {
        // ADD-13: f32 vector <-> little-endian BLOB is lossless.
        let v = vec![0.0f32, 1.5, -2.25, 3.125, 1e-6];
        let blob = embedding_to_blob(&v);
        assert_eq!(blob.len(), v.len() * 4);
        assert_eq!(blob_to_embedding(&blob), Some(v));
        // Empty and misaligned blobs decode to None (skipped, not mis-scored).
        assert_eq!(blob_to_embedding(&[]), None);
        assert_eq!(blob_to_embedding(&[1, 2, 3]), None);
    }

    #[test]
    fn cosine_similarity_basics() {
        // Identical direction → 1.0; orthogonal → 0.0; opposite → -1.0.
        assert!((cosine_similarity(&[1.0, 0.0], &[2.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
        assert!((cosine_similarity(&[1.0, 0.0], &[-1.0, 0.0]) + 1.0).abs() < 1e-6);
        // Mismatched length or zero vector → safe 0.0.
        assert_eq!(cosine_similarity(&[1.0, 0.0], &[1.0]), 0.0);
        assert_eq!(cosine_similarity(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
    }

    /// The whole embedded set, collected off the streaming scan — what
    /// `chunk_embedding_vectors` used to return before the retrieval pass
    /// stopped materializing it.
    fn collect_vectors(conn: &Connection) -> Vec<(i64, Vec<u8>)> {
        let mut out = Vec::new();
        for_each_chunk_embedding(conn, |rowid, blob| out.push((rowid, blob.to_vec()))).unwrap();
        out
    }

    #[test]
    fn embedding_backfill_columns_work() {
        // ADD-13: chunks start with NULL embedding; storing a blob makes them
        // visible to the vector pass and clears them from the missing list.
        let conn = mem();
        add_file(&conn, "a.txt", "The office holiday party is on Friday.");
        let missing = chunks_missing_embedding(&conn, 10).unwrap();
        assert_eq!(missing.len(), 1);
        assert!(collect_vectors(&conn).is_empty());
        let blob = embedding_to_blob(&[0.1, 0.2, 0.3]);
        set_chunk_embedding(&conn, &missing[0].0, &blob).unwrap();
        assert!(chunks_missing_embedding(&conn, 10).unwrap().is_empty());
        assert_eq!(collect_vectors(&conn).len(), 1);
        // CHG-15: hydrating the winning rowids returns the chunk text.
        let vecs = collect_vectors(&conn);
        let rowids: Vec<i64> = vecs.iter().map(|(r, _)| *r).collect();
        let hydrated = chunks_by_rowids(&conn, &rowids).unwrap();
        assert_eq!(hydrated.len(), 1);
        assert!(hydrated[0].2.contains("holiday party"));
    }

    #[test]
    fn streaming_scan_scores_exactly_like_the_materializing_one() {
        // The vector pass used to copy every blob out of SQLite and decode each
        // into a Vec<f32> before scoring one of them — tens of MB per question
        // on a big room. Streaming must score identically, row for row.
        let conn = mem();
        let vectors = [
            vec![1.0f32, 0.0, 0.0],
            vec![0.5, 0.5, 0.0],
            vec![0.0, 0.0, 1.0],
        ];
        for (i, v) in vectors.iter().enumerate() {
            add_file(&conn, &format!("f{i}.txt"), &format!("chunk number {i}"));
            let missing = chunks_missing_embedding(&conn, 10).unwrap();
            set_chunk_embedding(&conn, &missing[0].0, &embedding_to_blob(v)).unwrap();
        }
        let q = [1.0f32, 0.0, 0.0];
        let mut streamed: Vec<(i64, f32)> = Vec::new();
        for_each_chunk_embedding(&conn, |rowid, blob| {
            streamed.push((rowid, cosine_similarity_blob(&q, blob)))
        })
        .unwrap();
        let materialized: Vec<(i64, f32)> = collect_vectors(&conn)
            .into_iter()
            .map(|(rowid, blob)| {
                let emb = blob_to_embedding(&blob).unwrap();
                (rowid, cosine_similarity(&q, &emb))
            })
            .collect();
        assert_eq!(streamed.len(), 3);
        assert_eq!(streamed, materialized);
    }

    #[test]
    fn blob_cosine_matches_decoded_cosine_including_the_skip_cases() {
        // Same maths, same accumulation order, same "safe 0.0" for anything
        // that blob_to_embedding would have refused to decode.
        let q = vec![0.3f32, -0.7, 1.25, 0.0];
        let v = vec![-0.1f32, 0.4, 2.0, 3.5];
        let decoded = cosine_similarity(&q, &v);
        assert_eq!(cosine_similarity_blob(&q, &embedding_to_blob(&v)), decoded);
        // Truncated / foreign blobs and width mismatches score 0.0 rather than
        // being mis-scored against a shorter vector.
        assert_eq!(cosine_similarity_blob(&q, &[1, 2, 3]), 0.0);
        assert_eq!(cosine_similarity_blob(&q, &[]), 0.0);
        assert_eq!(cosine_similarity_blob(&q, &embedding_to_blob(&[1.0, 2.0])), 0.0);
        assert_eq!(cosine_similarity_blob(&[], &embedding_to_blob(&v)), 0.0);
        // A zero-magnitude stored vector is "no signal", not a NaN.
        assert_eq!(cosine_similarity_blob(&q, &embedding_to_blob(&[0.0; 4])), 0.0);
    }
}
