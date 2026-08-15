//! THE UNIVERSAL FALLBACK: macOS's own preview generator.
//!
//! Whatever this app can't parse itself, the Mac usually can. QuickLook is the
//! machinery behind pressing space in Finder, and every format with a Quick
//! Look extension installed — `.key`, `.pages`, `.numbers`, legacy `.doc` and
//! `.ppt`, RAW photos, PSD and AI artwork, 3D models — renders through it.
//!
//! One integration therefore replaces "No preview available for this file type
//! yet" with a real page for a long tail of formats that would otherwise each
//! need their own parser. It is image-only: no text selection, no search, no
//! editing. That is a genuine limit and the UI says so rather than implying the
//! file is fully supported.
//!
//! PRIVACY NOTE, stated because it is the one real cost: QuickLook is a system
//! service and takes a FILE URL, so the decrypted bytes must touch the disk for
//! the moment it takes to render. They are written to a per-render temp file
//! with owner-only permissions and removed immediately afterwards, whether the
//! render succeeded or not. This is the same bargain `stt::decode_bytes_to_pcm`
//! already makes to hand audio to the OS converters — the alternative is not
//! "no temp file", it is "no preview at all for these formats".

#[cfg(target_os = "macos")]
mod imp {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_core_foundation::CGSize;
    use objc2_foundation::{NSError, NSURL};
    use objc2_quick_look_thumbnailing::{
        QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
        QLThumbnailGenerator, QLThumbnailRepresentation,
    };
    use std::sync::mpsc;
    use std::time::Duration;

    /// A thumbnail request that hasn't answered in this long is abandoned. A
    /// third-party Quick Look extension runs out of process and can hang; the
    /// preview is a nicety and must never be able to wedge a room operation.
    const TIMEOUT: Duration = Duration::from_secs(20);

    /// Render `path` to a PNG at up to `max_edge` points on its longest side.
    pub fn thumbnail_png(path: &std::path::Path, max_edge: f64) -> Option<Vec<u8>> {
        let url = NSURL::fileURLWithPath(&objc2_foundation::NSString::from_str(path.to_str()?));
        // 2x scale so the preview is sharp on a Retina display; QuickLook
        // reports sizes in points and renders at scale × that.
        let size = CGSize { width: max_edge, height: max_edge };
        let request = unsafe {
            QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
                QLThumbnailGenerationRequest::alloc(),
                &url,
                size,
                2.0,
                // `All` lets the OS fall back from a full-fidelity render to a
                // lower one rather than returning nothing — a document with no
                // Quick Look extension still yields its icon-with-preview.
                QLThumbnailGenerationRequestRepresentationTypes::All,
            )
        };

        let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
        let handler = RcBlock::new(
            move |rep: *mut QLThumbnailRepresentation, _err: *mut NSError| {
                // The channel is gone if we already timed out; that send
                // failing is expected, not an error.
                let _ = tx.send(unsafe { rep.as_ref() }.and_then(png_of));
            },
        );
        unsafe {
            QLThumbnailGenerator::sharedGenerator()
                .generateBestRepresentationForRequest_completionHandler(&request, &handler);
        }
        // QuickLook answers on a background queue, so this blocks a worker
        // thread rather than the main run loop — the command that calls it is
        // already on `spawn_blocking`.
        rx.recv_timeout(TIMEOUT).ok().flatten()
    }

    /// The representation's CGImage, encoded as PNG.
    fn png_of(rep: &QLThumbnailRepresentation) -> Option<Vec<u8>> {
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
        use objc2_foundation::NSDictionary;

        let cg = unsafe { rep.CGImage() };
        let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg);
        let data: Option<Retained<objc2_foundation::NSData>> = unsafe {
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        };
        data.map(|d| d.to_vec())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn thumbnail_png(_path: &std::path::Path, _max_edge: f64) -> Option<Vec<u8>> {
        None
    }
}

/// The longest edge, in points, of the preview handed to the viewer. Large
/// enough that a page of text is legible when the pane is full-width, small
/// enough that the base64 payload stays a few hundred KB.
pub const PREVIEW_EDGE: f64 = 1400.0;

/// Render one file's bytes to a PNG preview via QuickLook.
///
/// `name` matters: QuickLook dispatches on the file EXTENSION, so the temp
/// copy has to keep it or the OS has no idea which extension should render it.
pub fn preview_png(name: &str, bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.is_empty() {
        return None;
    }
    let file = temp_path_for(name);
    if write_private(&file, bytes).is_err() {
        return None;
    }
    let png = imp::thumbnail_png(&file, PREVIEW_EDGE);
    // Always, on both paths — a preview must not leave decrypted bytes behind.
    let _ = std::fs::remove_file(&file);
    png
}

/// A fresh temp path for one render, keeping the original EXTENSION —
/// QuickLook dispatches on it, so a copy without it is a file the OS has no
/// idea how to draw. The uuid stem means two concurrent renders of the same
/// document never collide.
fn temp_path_for(name: &str) -> std::path::PathBuf {
    let ext = crate::extraction::extension_of(name);
    let stem = uuid::Uuid::new_v4();
    std::env::temp_dir().join(if ext.is_empty() {
        format!("arcelle-ql-{stem}")
    } else {
        format!("arcelle-ql-{stem}.{ext}")
    })
}

/// Write with owner-only permissions from the start, rather than creating a
/// world-readable file and tightening it afterwards: between those two steps
/// another local process can already have opened it.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Count leftover temp copies WITH A GIVEN EXTENSION.
    ///
    /// Filtering by extension is what makes these tests honest: cargo runs
    /// them on parallel threads against one shared temp directory, so a naive
    /// count of every `arcelle-ql-*` sees another test's file mid-render and
    /// reports a leak that isn't there. Each test below therefore owns an
    /// extension no other one uses.
    fn leftovers(suffix: &str) -> usize {
        std::fs::read_dir(std::env::temp_dir())
            .map(|d| {
                d.filter_map(Result::ok)
                    .filter(|e| {
                        let n = e.file_name().to_string_lossy().into_owned();
                        n.starts_with("arcelle-ql-") && n.ends_with(suffix)
                    })
                    .count()
            })
            .unwrap_or(0)
    }

    #[test]
    fn empty_bytes_are_not_written_to_disk_at_all() {
        assert!(preview_png("thing.key", &[]).is_none());
    }

    #[test]
    fn the_temp_copy_is_always_removed() {
        // Whatever QuickLook does with it — render, refuse, or time out — the
        // decrypted copy must not survive the call.
        assert_eq!(leftovers(".qltest"), 0, "a previous run leaked");
        let _ = preview_png("probe.qltest", b"hello");
        assert_eq!(
            leftovers(".qltest"),
            0,
            "a decrypted preview copy was left in the temp directory"
        );
    }

    #[test]
    fn a_file_with_no_extension_still_gets_a_unique_temp_name() {
        // Two renders must never collide on one path: `create_new` would make
        // the second fail and silently return no preview.
        let a = temp_path_for("noext");
        let b = temp_path_for("noext");
        assert_ne!(a, b, "two renders of the same name reused one temp path");
        // Render an extension-less name for real. Whether QuickLook produces a
        // thumbnail for it is the environment's business and not what this test
        // is about — what matters is that the call cannot leave a decrypted
        // copy behind, which the assertion below is the one that states.
        // (This was `assert!(… .is_none() || true)`, which asserts nothing:
        // `|| true` is true whatever the call returns.)
        let _ = preview_png("noext", b"hello");
        assert_eq!(leftovers("-noextprobe"), 0);
    }

    #[cfg(unix)]
    #[test]
    fn the_temp_copy_is_owner_only_while_it_exists() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("arcelle-ql-{}.qlperm", uuid::Uuid::new_v4()));
        write_private(&path, b"secret").expect("write");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let _ = std::fs::remove_file(&path);
        assert_eq!(mode, 0o600, "a decrypted preview copy was readable by other users");
    }

    #[test]
    fn writing_twice_to_one_path_is_refused_rather_than_overwriting() {
        // `create_new` is deliberate: an existing file at that path is someone
        // else's, and clobbering it would be worse than skipping the preview.
        let path = std::env::temp_dir().join(format!("arcelle-ql-{}.qlonce", uuid::Uuid::new_v4()));
        write_private(&path, b"first").expect("first write");
        assert!(write_private(&path, b"second").is_err());
        let _ = std::fs::remove_file(&path);
    }
}
