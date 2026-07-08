//! ADD-25: whole-window capture of the app's own WKWebView for the agent's
//! `view_screenshot` tool. Uses WKWebView's `takeSnapshot(with:)` — Apple's
//! public API for rendering the webview's own content in-process — which is
//! NOT screen capture and needs no Screen Recording (TCC) permission.
//!
//! Hardware-composited layers (`<video>`, WebGL) render blank in these
//! snapshots (WebKit limitation); video frames go through the driver's
//! canvas `media_frame` path instead.

/// Capture the window's webview as PNG bytes. Must be callable from any
/// thread EXCEPT the main thread: the WKWebView call itself is dispatched to
/// the main thread (Tauri's `with_webview` guarantees its closure runs there
/// — see the tauri 2.x docs for `Webview::with_webview`) and the result is
/// ferried back over a channel. Blocking the main thread on that channel
/// would deadlock — the snapshot's completion handler needs the main run
/// loop to fire — so main-thread callers get an error instead of a hang.
/// The agent loop calls this from a tokio worker thread, which is fine.
#[cfg(target_os = "macos")]
pub fn capture_webview_png(window: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    // Deadlock guard: MainThreadMarker::new() succeeds only on the main
    // thread, and blocking it below would starve the very run loop that
    // delivers the snapshot. Fail fast rather than eat the 5s timeout.
    if MainThreadMarker::new().is_some() {
        return Err(
            "capture_webview_png must not be called from the main thread (it would deadlock \
             waiting for the snapshot completion handler)"
                .into(),
        );
    }

    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();

    window
        .with_webview(move |platform_webview| {
            // This closure runs on the main thread (Tauri guarantee), so we
            // can talk to the MainThreadOnly WebKit classes directly.
            let outcome = (|| -> Result<(), String> {
                let mtm = MainThreadMarker::new()
                    .ok_or("with_webview closure did not run on the main thread")?;

                // SAFETY: on macOS, PlatformWebview::inner() is the WKWebView
                // instance (Tauri's own with_webview example casts it exactly
                // this way). It is non-null for a live webview and stays
                // alive for the duration of this main-thread closure because
                // the window that owns it is retained by Tauri.
                let wk_ptr: *mut WKWebView = platform_webview.inner().cast();
                if wk_ptr.is_null() {
                    return Err("platform webview pointer was null".into());
                }
                let wk: &WKWebView = unsafe { &*wk_ptr };

                // A default configuration snapshots the full visible
                // viewport at the view's current size — exactly what the
                // agent's view_screenshot tool wants.
                // SAFETY: mtm proves we are on the main thread, which is the
                // only requirement of this MainThreadOnly initializer.
                let cfg = unsafe { WKSnapshotConfiguration::new(mtm) };

                // The completion handler also runs on the main thread; it
                // converts NSImage → PNG there and ships plain bytes across
                // the channel so nothing ObjC ever crosses a thread boundary.
                let block_tx = tx.clone();
                let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let result = (|| -> Result<Vec<u8>, String> {
                        // SAFETY: WebKit hands us either a valid NSImage or
                        // nil plus an NSError; both pointers are valid for
                        // the duration of this block invocation.
                        let image: &NSImage = match unsafe { image.as_ref() } {
                            Some(img) => img,
                            None => {
                                let msg = unsafe { error.as_ref() }
                                    .map(|e| e.localizedDescription().to_string())
                                    .unwrap_or_else(|| {
                                        "snapshot returned no image and no error".into()
                                    });
                                return Err(format!("webview snapshot failed: {msg}"));
                            }
                        };

                        // NSImage → PNG goes through TIFF because NSImage has
                        // no direct PNG accessor: TIFFRepresentation flattens
                        // the image, NSBitmapImageRep re-encodes it as PNG.
                        let tiff = image
                            .TIFFRepresentation()
                            .ok_or("snapshot image has no TIFF representation")?;
                        let rep = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
                            .ok_or("could not build a bitmap rep from the snapshot")?;
                        // SAFETY: the empty properties dictionary matches the
                        // declared generic (no PNG encoder options needed).
                        let png = unsafe {
                            rep.representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            )
                        }
                        .ok_or("PNG encoding of the snapshot failed")?;
                        Ok(png.to_vec())
                    })();
                    // The caller may have timed out and dropped the receiver;
                    // a dead channel is not an error worth surfacing here.
                    let _ = block_tx.send(result);
                });

                // SAFETY: wk is a valid WKWebView on the main thread; the
                // block is retained by WebKit until it is invoked once.
                unsafe { wk.takeSnapshotWithConfiguration_completionHandler(Some(&cfg), &handler) };
                Ok(())
            })();
            if let Err(e) = outcome {
                let _ = tx.send(Err(e));
            }
        })
        .map_err(|e| format!("could not reach the platform webview: {e}"))?;

    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result,
        Err(_) => Err("timed out waiting for the webview snapshot (5s)".into()),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn capture_webview_png(_window: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    Err("Screenshots are only supported on macOS.".into())
}
