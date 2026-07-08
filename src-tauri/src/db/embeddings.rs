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
    let mut stmt = conn
        .prepare(
            "SELECT c.id, f.name, c.text
             FROM chunks c JOIN files f ON f.id = c.file_id
             WHERE c.embedding IS NULL LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// ADD-13: store an embedding BLOB on one chunk (by chunk id).
pub fn set_chunk_embedding(conn: &Connection, id: &str, blob: &[u8]) -> Result<(), String> {
    conn.execute(
        "UPDATE chunks SET embedding = ?2 WHERE id = ?1",
        params![id, blob],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// CHG-15: every chunk's (rowid, embedding blob) — NO text. The brute-force
/// cosine pass scores over just these, so only the ~24 winners' text is ever
/// copied (via `chunks_by_rowids`). Previously this JOINed `c.text` for every
/// embedded chunk on every question — tens of MB of discarded String allocation
/// under the room mutex on a large room. The rowid keys the keyword/vector blend.
pub fn chunk_embedding_vectors(conn: &Connection) -> Result<Vec<(i64, Vec<u8>)>, String> {
    let mut stmt = conn
        .prepare("SELECT rowid, embedding FROM chunks WHERE embedding IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
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
         WHERE c.rowid IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params: Vec<&dyn rusqlite::ToSql> =
        rowids.iter().map(|r| r as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(params.as_slice(), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// ADD-13: like `search_chunks_fts` but also returns each hit's chunk rowid so
/// keyword and vector scores can be blended per chunk. (rowid, file name, chunk
/// text, bm25 — smaller is a better match).
pub fn search_chunks_fts_ranked(
    conn: &Connection,
    match_expr: &str,
    limit: usize,
) -> Result<Vec<(i64, String, String, f64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT chunks_fts.rowid, f.name, c.text, bm25(chunks_fts)
             FROM chunks_fts
             JOIN chunks c ON c.rowid = chunks_fts.rowid
             JOIN files f ON f.id = c.file_id
             WHERE chunks_fts MATCH ?1
             ORDER BY bm25(chunks_fts)
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![match_expr, limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// (file name, chunk text) for the most recently added chunks — the fallback
/// context when a question matches nothing in the FTS index (CHG-10).
pub fn recent_chunks(conn: &Connection, limit: usize) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.name, c.text FROM chunks c JOIN files f ON f.id = c.file_id
             ORDER BY f.created_at DESC, c.seq ASC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
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

    #[test]
    fn embedding_backfill_columns_work() {
        // ADD-13: chunks start with NULL embedding; storing a blob makes them
        // visible to the vector pass and clears them from the missing list.
        let conn = mem();
        add_file(&conn, "a.txt", "The office holiday party is on Friday.");
        let missing = chunks_missing_embedding(&conn, 10).unwrap();
        assert_eq!(missing.len(), 1);
        assert!(chunk_embedding_vectors(&conn).unwrap().is_empty());
        let blob = embedding_to_blob(&[0.1, 0.2, 0.3]);
        set_chunk_embedding(&conn, &missing[0].0, &blob).unwrap();
        assert!(chunks_missing_embedding(&conn, 10).unwrap().is_empty());
        assert_eq!(chunk_embedding_vectors(&conn).unwrap().len(), 1);
        // CHG-15: hydrating the winning rowids returns the chunk text.
        let vecs = chunk_embedding_vectors(&conn).unwrap();
        let rowids: Vec<i64> = vecs.iter().map(|(r, _)| *r).collect();
        let hydrated = chunks_by_rowids(&conn, &rowids).unwrap();
        assert_eq!(hydrated.len(), 1);
        assert!(hydrated[0].2.contains("holiday party"));
    }
}
