use super::*;

/// A QuickLook page image for a file this app can't render itself.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QuickLookPreview {
    /// PNG, base64. Small enough to cross IPC (one page at ~1400pt).
    pub png_b64: String,
}

/// Ask macOS to draw a preview of a room file.
///
/// This is the last resort in the viewer chain, and the only one that covers
/// the long tail: `.key`, `.pages`, `.numbers`, legacy `.doc`/`.ppt`, RAW
/// photos, PSD, 3D models — anything with a Quick Look extension on this Mac.
/// Before it, all of those showed the same sentence: "No preview available for
/// this file type yet."
///
/// Returns `Ok(None)` rather than an error when the OS has nothing to draw:
/// "this Mac can't preview it either" is a normal answer, not a failure, and
/// the viewer says so plainly instead of showing an error banner.
#[tauri::command]
pub async fn quicklook_preview(
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<QuickLookPreview>, String> {
    use tauri::Manager;
    // Read the bytes out, then DROP the room lock — QuickLook calls out to a
    // system service that can take seconds, and holding the mutex across that
    // would freeze every other room operation behind a preview.
    let (name, bytes) = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let (name, _mime, bytes, _text) = db::get_file_full(&room.conn, &id)?;
        (name, bytes.unwrap_or_default())
    };
    if bytes.is_empty() {
        return Ok(None);
    }
    let png = tauri::async_runtime::spawn_blocking(move || crate::quicklook::preview_png(&name, &bytes))
        .await
        .map_err(|e| format!("The preview could not be drawn: {e}"))?;
    Ok(png.map(|png| QuickLookPreview {
        png_b64: base64::engine::general_purpose::STANDARD.encode(png),
    }))
}
