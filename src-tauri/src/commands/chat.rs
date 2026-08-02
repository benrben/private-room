use super::*;

#[tauri::command]
pub fn list_chats(state: State<'_, AppState>) -> Result<Vec<Chat>, String> {
    state.with_room(|room| db::list_chats(&room.conn))
}

#[tauri::command]
pub fn create_chat(state: State<'_, AppState>) -> Result<Chat, String> {
    state.with_room(|room| db::create_chat(&room.conn))
}

#[tauri::command]
pub fn delete_chat(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.with_room(|room| db::delete_chat(&room.conn, &id))
}

#[tauri::command]
pub fn get_messages(state: State<'_, AppState>, chat_id: String) -> Result<Vec<Message>, String> {
    state.with_room(|room| db::list_messages(&room.conn, &chat_id))
}

/// ADD-9: give a chat an explicit title (persists in the room file).
#[tauri::command]
pub fn rename_chat(state: State<'_, AppState>, id: String, title: String) -> Result<(), String> {
    state.with_room(|room| db::rename_chat(&room.conn, &id, &title))
}

/// ADD-9: delete one message — regenerate drops the last assistant reply, then
/// re-runs `ask` with the previous user question.
#[tauri::command]
pub fn delete_message(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.with_room(|room| db::delete_message(&room.conn, &id))
}

/// D15: a pasted image or voice note is held in memory whole and stored as one
/// SQLite blob, exactly like a file added by link — so it gets the same ceiling
/// instead of no ceiling at all. Measured on the BASE64 (4 chars per 3 bytes) so
/// an oversized paste is refused before it is decoded into a second copy.
fn check_paste_size(b64_len: usize, display_name: &str) -> Result<(), String> {
    let size = (b64_len / 4 * 3) as u64;
    if size > crate::web::MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "{display_name} is {} MB — larger than the {} MB limit for a room file.",
            size / (1024 * 1024),
            crate::web::MAX_DOWNLOAD_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// ADD-8: import a pasted screenshot. Base64-decode, then go through the same
/// insert/index path any uploaded file uses (source "upload").
#[tauri::command]
pub fn import_image_bytes(
    state: State<'_, AppState>,
    name: String,
    b64: String,
) -> Result<FileMeta, String> {
    check_paste_size(b64.len(), &name)?;
    state.with_room(|room| {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("Could not read the pasted image: {e}"))?;
        let mime = mime_guess::from_path(&name)
            .first_or(mime_guess::mime::IMAGE_PNG)
            .essence_str()
            .to_string();
        // Images carry no extractable text; they still index by name like any file.
        db::insert_file(&room.conn, &name, &mime, &bytes, None, "upload")
    })
}

/// ADD-18: store a voice note recorded inside the room, then transcribe it in
/// the background exactly like an imported recording — the room ends up with
/// BOTH the audio file and its searchable timestamped transcript.
#[tauri::command]
pub fn import_audio_bytes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
    b64: String,
) -> Result<FileMeta, String> {
    check_paste_size(b64.len(), &name)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("Could not read the recording: {e}"))?;
    let ext = extraction::extension_of(&name);
    // Store a mime WKWebView will play back: guessers label .m4a "audio/m4a",
    // which <audio> silently refuses — AAC-in-MP4 is audio/mp4.
    let mime = match ext.as_str() {
        "m4a" | "mp4" => "audio/mp4".to_string(),
        "webm" => "audio/webm".to_string(),
        _ => mime_guess::from_path(&name)
            .first_raw()
            .unwrap_or("audio/mp4")
            .to_string(),
    };
    let (meta, room_path) = state.with_room(|room| {
        Ok((
            db::insert_file(&room.conn, &name, &mime, &bytes, None, "upload")?,
            room.path.clone(),
        ))
    })?;
    // Wave 3 (Idea 9): epoch-stamp the queued transcription so a rollback drops
    // it rather than writing the transcript into the swapped room.
    let epoch = state.room_epoch();
    enqueue_stt(
        &app,
        JobMeta { id: meta.id.clone(), name, mime, ext, room_path, epoch },
    );
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasted_media_gets_the_same_ceiling_a_linked_file_does() {
        // An ordinary paste is untouched.
        assert!(check_paste_size(1024, "shot.png").is_ok());
        // Exactly at the limit still passes; one base64 quantum over does not.
        let at_limit = crate::web::MAX_DOWNLOAD_BYTES as usize / 3 * 4;
        assert!(check_paste_size(at_limit, "shot.png").is_ok());
        let err = check_paste_size(at_limit + 4, "voice note.m4a").unwrap_err();
        assert!(err.contains("voice note.m4a"), "names the file: {err}");
        assert!(err.contains("limit for a room file"), "states the limit: {err}");
    }
}

