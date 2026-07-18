use super::*;

/// ADD-13: embed the question so retrieval can blend meaning with keywords.
/// Returns None on ANY failure (model missing, Ollama down, empty result) so the
/// caller silently falls back to the pure keyword path — the chat never blocks.
/// Keeps the small embed model briefly warm so back-to-back questions are fast.
/// CHG-12: nomic-embed-text expects the `search_query:` task prefix on queries.
pub(crate) async fn embed_question(question: &str) -> Option<Vec<f32>> {
    let prefixed = format!("search_query: {question}");
    match ollama::embed(ollama::EMBED_MODEL, std::slice::from_ref(&prefixed), "5m").await {
        Ok(mut v) if !v.is_empty() && !v[0].is_empty() => Some(v.remove(0)),
        _ => None,
    }
}

/// ADD-13: kick off the lazy background embed pass for the currently open room.
/// Bumps the embed generation (so any older pass exits) and spawns exactly one
/// loop carrying the new stamp. Cheap to call on every unlock; no-op work once
/// every chunk already has a vector.
/// One-shot re-extraction pass for files that were imported before an
/// extractor improvement and so carry no text (e.g. all-numeric .xlsx files
/// stored when the extractor only read shared strings). Runs the current
/// extractor over their stored bytes and re-indexes any that now yield text.
/// OCR/STT candidates are left to their own workers; only the open room is
/// touched, and the room lock is never held across nothing but quick DB work.
pub(crate) fn spawn_reextract_backfill(app: &tauri::AppHandle) {
    use tauri::{Emitter as _, Manager as _};
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (path, epoch, candidates) = {
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { return };
            let list = db::files_missing_text(&room.conn).unwrap_or_default();
            // Wave 3 (Idea 9): capture the room epoch — this pass writes bytes
            // captured NOW, so a rollback mid-pass must drop the write.
            (room.path.clone(), state.room_epoch(), list)
        };
        let mut fixed = 0usize;
        for (id, name, mime, bytes) in candidates {
            // Skip scans/photos/media — their text arrives via OCR/STT workers.
            let ext = extraction::extension_of(&name);
            if extraction::is_image(&mime)
                || ocr::is_ocr_candidate(&mime, &ext)
                || stt::media_kind(&mime, &ext).is_some()
            {
                continue;
            }
            let Some(text) = extraction::extract_text(&name, &bytes) else {
                continue;
            };
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { return };
            // Wave 3 (Idea 9): epoch pin — a rollback swapped the DB, so these
            // pre-rollback bytes must not be written into the restored room.
            if room.path != path || state.room_epoch() != epoch {
                return;
            }
            if db::update_file_content(&room.conn, &id, &bytes, Some(&text)).is_ok() {
                fixed += 1;
            }
        }
        if fixed > 0 {
            let _ = app.emit("room-files-changed", ());
        }
    });
}

pub(crate) fn spawn_embedding_backfill(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri::Manager as _;
    let generation = {
        let state = app.state::<AppState>();
        state.embed_generation.fetch_add(1, Ordering::SeqCst) + 1
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        backfill_embeddings(app, generation).await;
    });
}

/// ADD-13: background pass that fills `chunks.embedding` for the open room. It
/// drains NULL-embedding chunks in batches, then idles — picking up chunks that
/// later imports/edits add — until the room closes or a newer room opens (the
/// generation stamp moves). Never holds the room lock across the Ollama call.
/// Any embed error (model missing / server down) just backs off and retries; the
/// keyword path keeps working meanwhile. The short `keep_alive` lets Ollama
/// release the small embed model on its own once indexing goes idle (HLT-5).
pub(crate) async fn backfill_embeddings(app: tauri::AppHandle, generation: u64) {
    use std::sync::atomic::Ordering;
    use tauri::Manager as _;
    const BATCH: usize = 32;
    loop {
        // Collect a batch under the lock; bail if this pass is stale or closed.
        let (path, batch) = {
            let state = app.state::<AppState>();
            if state.embed_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let guard = state.room.lock().unwrap();
            let Some(room) = guard.as_ref() else { return };
            let batch = db::chunks_missing_embedding(&room.conn, BATCH).unwrap_or_default();
            (room.path.clone(), batch)
        };

        if batch.is_empty() {
            // Fully indexed for now; poll for chunks future imports/edits add.
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            continue;
        }

        // CHG-12: embed documents with the `search_document:` task prefix and
        // prepend the file name for context, matching the `search_query:` side.
        // The augmented string is transient — only the vector is stored, on the
        // unmodified chunk.
        let texts: Vec<String> = batch
            .iter()
            .map(|(_, name, text)| format!("search_document: {name}\n{text}"))
            .collect();
        let vectors = match ollama::embed(ollama::EMBED_MODEL, &texts, "30s").await {
            Ok(v) if v.len() == texts.len() => v,
            _ => {
                // Model missing or Ollama down — back off, then retry. Keyword
                // retrieval stays fully functional in the meantime.
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                continue;
            }
        };

        // Write the vectors back, only if this is still the same open room.
        let state = app.state::<AppState>();
        if state.embed_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let guard = state.room.lock().unwrap();
        let Some(room) = guard.as_ref() else { return };
        if room.path != path {
            return;
        }
        for ((id, _, _), vec) in batch.iter().zip(vectors.iter()) {
            if vec.is_empty() {
                continue;
            }
            let blob = db::embedding_to_blob(vec);
            let _ = db::set_chunk_embedding(&room.conn, id, &blob);
        }
    }
}
