//! ADD-14: on-device OCR for scans and photos.
//!
//! When a PDF or image yields no extractable text, we recognize the text with
//! Apple's Vision framework (`VNRecognizeTextRequest`) — entirely on the Mac,
//! no bundled engine and nothing over the network. Best-effort by design: any
//! failure returns `None` so import silently falls back to "no text", exactly
//! like before this feature existed.
//!
//! English + Hebrew are requested with the accurate recognition level. Hebrew
//! quality still needs verification on real hardware with real scans.

/// True for the file kinds worth OCR-ing when text extraction came back empty:
/// raster images and PDFs (which may be image-only scans).
pub fn is_ocr_candidate(mime: &str, ext: &str) -> bool {
    mime.starts_with("image/") || ext == "pdf"
}

#[cfg(test)]
mod tests {
    use super::is_ocr_candidate;

    #[test]
    fn ocr_candidates_are_images_and_pdfs() {
        assert!(is_ocr_candidate("image/jpeg", "jpg"));
        assert!(is_ocr_candidate("image/png", "png"));
        assert!(is_ocr_candidate("application/pdf", "pdf"));
        // Not scans: text/office formats we already extract natively.
        assert!(!is_ocr_candidate("text/plain", "txt"));
        assert!(!is_ocr_candidate(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "docx"
        ));
    }
}

/// Recognize text in a PDF or image's bytes, on-device. Returns the recognized
/// text (WITHOUT the caller's "(text recognized from scan)" prefix), or `None`
/// when nothing was read or OCR isn't available. Blocking — run off the UI
/// thread. Returns `None` on every platform but macOS.
pub fn recognize(_mime: &str, _ext: &str, _bytes: &[u8]) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let text = if _ext == "pdf" {
            mac::ocr_pdf(_bytes)
        } else {
            mac::ocr_image_bytes(_bytes)
        };
        text.filter(|t| !t.trim().is_empty())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use core::ffi::c_void;
    use core::ptr::NonNull;

    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2::AllocAnyThread;
    use objc2_core_foundation::{CFData, CFRetained, CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGBitmapContextGetBytesPerRow, CGBitmapContextGetData, CGColorSpace, CGContext,
        CGDataProvider, CGImageAlphaInfo, CGPDFBox, CGPDFDocument, CGPDFPage,
    };
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{
        VNImageOption, VNImageRequestHandler, VNRecognizedTextObservation, VNRecognizeTextRequest,
        VNRequest, VNRequestTextRecognitionLevel,
    };

    /// Render PDFs at 2x the point size so small scanned type is legible to the
    /// recognizer.
    const PDF_RENDER_SCALE: f64 = 2.0;
    /// Bound work on huge documents; OCR runs in the background, but it should
    /// not read a library. Whatever this cuts is REPORTED in the text — the old
    /// 50-page limit meant a 200-page scan looked like it had worked while
    /// three quarters of it was missing from search and from every answer.
    const MAX_PDF_PAGES: usize = 500;
    /// Ceiling on one rasterized page. 40 MP is ~160 MB for the RGBA bitmap,
    /// and the tight repack plus the PNG encode each cost about as much again.
    /// The old guard was per-dimension (20 000 × 20 000), which allowed a
    /// 1.6 GB allocation and then two more copies of it. A poster- or map-sized
    /// page is rendered at a reduced scale rather than skipped outright.
    const MAX_PAGE_PIXELS: f64 = 40_000_000.0;
    /// Ceiling on EITHER edge of a rasterized page. Area alone bounds neither
    /// side: a page whose media box declares 250 000 000 × 0.001 pt has a
    /// trivial area, so the area cap leaves the scale at 2.0 and CoreGraphics is
    /// asked for a 500 000 000 × 1 bitmap — 2 GB it then fills with white,
    /// followed by another 2 GB for the tight repack. The bytes are
    /// attacker-supplied: OCR runs on any text-less PDF that arrives by import
    /// or by download.
    const MAX_PAGE_EDGE: f64 = 20_000.0;

    /// Bitmap size (and the scale that produced it) for one page's media box,
    /// or `None` when there is nothing drawable. Pure, so both caps are
    /// testable without a PDF.
    fn page_raster_size(page_w: f64, page_h: f64) -> Option<(usize, usize, f64)> {
        let mut scale = PDF_RENDER_SCALE;
        let pixels = page_w * page_h * scale * scale;
        if pixels > MAX_PAGE_PIXELS {
            scale *= (MAX_PAGE_PIXELS / pixels).sqrt();
        }
        // Then clamp each edge on its own, so a degenerate media box can't slip
        // an enormous single dimension past the area cap.
        for edge in [page_w, page_h] {
            if edge * scale > MAX_PAGE_EDGE {
                scale = MAX_PAGE_EDGE / edge;
            }
        }
        if !scale.is_finite() || scale <= 0.0 {
            return None;
        }
        let edge_px = MAX_PAGE_EDGE as usize;
        // `.min` rather than a bare check: rounding up can leave the product a
        // hair over the clamp, and clipping a sub-pixel is better than refusing
        // a legitimately poster-sized page.
        let width = ((page_w * scale).ceil() as usize).min(edge_px);
        let height = ((page_h * scale).ceil() as usize).min(edge_px);
        if width == 0 || height == 0 {
            return None;
        }
        Some((width, height, scale))
    }

    /// OCR an image's encoded bytes (PNG/JPEG/HEIC/TIFF/… — anything CoreImage
    /// can decode) via a data-backed Vision request handler.
    pub fn ocr_image_bytes(bytes: &[u8]) -> Option<String> {
        autoreleasepool(|_| {
            let data = NSData::with_bytes(bytes);
            let options: Retained<NSDictionary<VNImageOption, AnyObject>> = NSDictionary::new();
            let handler = VNImageRequestHandler::initWithData_options(
                VNImageRequestHandler::alloc(),
                &data,
                &options,
            );
            run_recognition(&handler)
        })
    }

    /// Rasterize each PDF page to an RGBA bitmap, then OCR it. Image-only scans
    /// have no text layer, so this is the only way to read them.
    pub fn ocr_pdf(bytes: &[u8]) -> Option<String> {
        let cf_data = CFData::from_bytes(bytes);
        let provider = CGDataProvider::with_cf_data(Some(&cf_data))?;
        let doc = CGPDFDocument::with_provider(Some(&provider))?;
        let total_pages = CGPDFDocument::number_of_pages(Some(&doc));
        let pages = total_pages.min(MAX_PDF_PAGES);
        if pages == 0 {
            return None;
        }
        let mut out = String::new();
        let mut unrendered = 0usize;
        for page_number in 1..=pages {
            let Some(png) = render_pdf_page_png(&doc, page_number) else {
                // A damaged page object or a context allocation this Mac
                // refused. Counted, not swallowed: the pages that DID render
                // must not be handed on as the whole document.
                unrendered += 1;
                continue;
            };
            if let Some(text) = ocr_image_bytes(&png) {
                if !text.trim().is_empty() {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(&text);
                }
            }
        }
        if out.trim().is_empty() {
            return None;
        }
        out.push_str(&unread_notes(total_pages, pages, unrendered));
        Some(out)
    }

    /// What this scan's text does NOT contain, appended so neither the reader
    /// nor the model treats a partial read as the whole file. Empty when every
    /// page was both reached and rendered.
    ///
    /// `pages` is how many were attempted (the cap), `unrendered` how many of
    /// those the rasterizer could not draw at all.
    fn unread_notes(total_pages: usize, pages: usize, unrendered: usize) -> String {
        let mut notes = String::new();
        if total_pages > pages {
            notes.push_str(&format!(
                "\n\n[only the first {pages} of {total_pages} pages of this scan were read]"
            ));
        }
        if unrendered > 0 {
            notes.push_str(&format!(
                "\n\n[{unrendered} of {pages} pages of this scan could not be rendered and were not read]"
            ));
        }
        notes
    }

    /// Draw one PDF page onto a white RGBA bitmap and hand back PNG bytes.
    fn render_pdf_page_png(doc: &CGPDFDocument, page_number: usize) -> Option<Vec<u8>> {
        let page: CFRetained<CGPDFPage> = CGPDFDocument::page(Some(doc), page_number)?;
        let media: CGRect = CGPDFPage::box_rect(Some(&page), CGPDFBox::MediaBox);
        let page_w = media.size.width.max(0.0);
        let page_h = media.size.height.max(0.0);
        // Scale DOWN an unusually large page rather than refusing it: the point
        // of the 2x render is legibility, and half the legibility of a poster
        // still reads far better than nothing at all.
        let (width, height, scale) = page_raster_size(page_w, page_h)?;

        let color_space = CGColorSpace::new_device_rgb()?;
        let bits_per_component = 8usize;
        let bytes_per_row = width * 4;
        // CoreGraphics only exposes the "adaptive" bitmap-context constructor in
        // this crate; the classic entry point is a stable C symbol, so declare
        // it directly. Passing a null data pointer lets CG own the backing store
        // (freed with the context).
        extern "C-unwind" {
            fn CGBitmapContextCreate(
                data: *mut c_void,
                width: usize,
                height: usize,
                bits_per_component: usize,
                bytes_per_row: usize,
                space: Option<&CGColorSpace>,
                bitmap_info: u32,
            ) -> Option<NonNull<CGContext>>;
        }
        let raw_ctx = unsafe {
            CGBitmapContextCreate(
                core::ptr::null_mut(),
                width,
                height,
                bits_per_component,
                bytes_per_row,
                Some(&color_space),
                CGImageAlphaInfo::PremultipliedLast.0,
            )
        }?;
        let ctx: CFRetained<CGContext> = unsafe { CFRetained::from_raw(raw_ctx) };
        let ctx_ref: &CGContext = &ctx;

        // Paint white behind the page so transparent (vector-text) pages don't
        // recognize as light text on black.
        CGContext::set_rgb_fill_color(Some(ctx_ref), 1.0, 1.0, 1.0, 1.0);
        CGContext::fill_rect(
            Some(ctx_ref),
            CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(width as f64, height as f64)),
        );
        // Map PDF user space (origin at the media box, unscaled) into the bitmap.
        CGContext::scale_ctm(Some(ctx_ref), scale, scale);
        CGContext::translate_ctm(Some(ctx_ref), -media.origin.x, -media.origin.y);
        CGContext::draw_pdf_page(Some(ctx_ref), Some(&page));

        let data_ptr = CGBitmapContextGetData(Some(ctx_ref)) as *const u8;
        if data_ptr.is_null() {
            return None;
        }
        let actual_row = CGBitmapContextGetBytesPerRow(Some(ctx_ref));
        // Repack into a tightly-packed RGBA buffer (the context row may be padded).
        let mut rgba = vec![0u8; width * height * 4];
        for y in 0..height {
            let src = unsafe { data_ptr.add(y * actual_row) };
            let dst = &mut rgba[y * width * 4..y * width * 4 + width * 4];
            unsafe { core::ptr::copy_nonoverlapping(src, dst.as_mut_ptr(), width * 4) };
        }

        // Encode PNG so the recognizer's data path can decode it uniformly.
        use image::ImageEncoder;
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&rgba, width as u32, height as u32, image::ExtendedColorType::Rgba8)
            .ok()?;
        Some(png)
    }

    /// Scripts worth offering the recognizer, in priority order. Only English
    /// and Hebrew used to be requested, so a scan in Russian, Chinese, Japanese
    /// or Arabic came back completely empty, and a French or German page was
    /// read AS English — which mangles its accented words.
    ///
    /// These are language PREFIXES, matched against whatever this Mac reports
    /// as supported; the device's own identifiers are what gets passed back.
    /// Handing Vision a code it doesn't know makes it refuse the entire
    /// request, which is exactly how "OCR found nothing" happens silently.
    const WANTED_LANGUAGE_PREFIXES: &[&str] = &[
        "en", "he", "fr", "de", "es", "it", "pt", "nl", "ru", "uk", "ar", "ars", "zh", "yue",
        "ja", "ko", "th", "vi", "pl", "tr",
    ];

    /// The subset of [`WANTED_LANGUAGE_PREFIXES`] this Mac actually supports,
    /// as its own identifiers, in our priority order.
    fn available_languages(request: &VNRecognizeTextRequest) -> Vec<Retained<NSString>> {
        let Ok(supported) = (unsafe { request.supportedRecognitionLanguagesAndReturnError() })
        else {
            return Vec::new();
        };
        let ids: Vec<String> = supported.iter().map(|s| s.to_string()).collect();
        let mut chosen: Vec<String> = Vec::new();
        for want in WANTED_LANGUAGE_PREFIXES {
            for id in &ids {
                let base = id.split('-').next().unwrap_or(id);
                if base == *want && !chosen.contains(id) {
                    chosen.push(id.clone());
                }
            }
        }
        chosen.iter().map(|id| NSString::from_str(id)).collect()
    }

    /// Configure a text-recognition request (accurate level, every script this
    /// Mac can read), run it against `handler`, and collect the best candidate
    /// per text block.
    fn run_recognition(handler: &VNImageRequestHandler) -> Option<String> {
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        // Let Vision work out which script it is looking at rather than being
        // told it is always English; the list below is the priority hint.
        request.setAutomaticallyDetectsLanguage(true);
        let langs = available_languages(&request);
        if !langs.is_empty() {
            request.setRecognitionLanguages(&NSArray::from_retained_slice(&langs));
        }

        let request_ref: &VNRequest = &request;
        let requests = NSArray::from_slice(&[request_ref]);
        if handler.performRequests_error(&requests).is_err() {
            return None;
        }

        let observations: Retained<NSArray<VNRecognizedTextObservation>> = request.results()?;
        let mut lines: Vec<String> = Vec::new();
        for observation in observations.iter() {
            let candidates = observation.topCandidates(1);
            if let Some(best) = candidates.firstObject() {
                let line = best.string().to_string();
                if !line.trim().is_empty() {
                    lines.push(line);
                }
            }
        }
        if lines.is_empty() {
            None
        } else {
            Some(lines.join("\n"))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{
            page_raster_size, unread_notes, MAX_PAGE_EDGE, MAX_PAGE_PIXELS, PDF_RENDER_SCALE,
        };

        #[test]
        fn a_degenerate_media_box_cannot_ask_for_a_gigabyte_bitmap() {
            // Regression: the per-dimension guard was replaced by an area cap
            // alone, and area bounds NEITHER side. /MediaBox [0 0 250000000
            // 0.001] has an area of 250 000 pt², so the cap left the scale at
            // 2.0 and the render asked CoreGraphics for 500 000 000 × 1 — a
            // 2 GB context, plus another 2 GB for `vec![0u8; w*h*4]`.
            for (w, h) in [(250_000_000.0, 0.001), (0.001, 250_000_000.0)] {
                let (width, height, _) = page_raster_size(w, h).expect("still renderable");
                assert!(width as f64 <= MAX_PAGE_EDGE, "width {width} unbounded");
                assert!(height as f64 <= MAX_PAGE_EDGE, "height {height} unbounded");
                assert!(
                    (width * height) as f64 <= MAX_PAGE_PIXELS,
                    "{width}×{height} past the area cap"
                );
            }
        }

        #[test]
        fn ordinary_and_poster_pages_still_render() {
            // A4 at 72dpi: rendered at the full 2x, untouched by either cap.
            let (w, h, scale) = page_raster_size(595.0, 842.0).expect("A4 renders");
            assert_eq!(scale, PDF_RENDER_SCALE);
            assert_eq!((w, h), (1190, 1684));
            // A wall-sized plan: scaled DOWN by the area cap, not refused.
            let (w, h, scale) = page_raster_size(5000.0, 7000.0).expect("poster renders");
            assert!(scale < PDF_RENDER_SCALE && scale > 0.0, "scale {scale}");
            // Rounding each edge UP can put the product a pixel-row over.
            assert!((w * h) as f64 <= MAX_PAGE_PIXELS + (w + h) as f64, "{w}×{h}");
            // Nothing drawable at all.
            assert!(page_raster_size(0.0, 0.0).is_none());
            assert!(page_raster_size(f64::MAX, f64::MAX).is_none());
        }

        #[test]
        fn pages_that_could_not_be_rendered_are_declared() {
            // Regression: a scan whose pages mostly failed to rasterize was
            // stored and answered from as if the few that worked were the
            // whole document — the loop `continue`d and, with no cap in play,
            // nothing was appended at all.
            let note = unread_notes(12, 12, 9);
            assert!(note.contains("9 of 12"), "{note}");
            assert!(note.contains(concat!("could not be ", "rendered")), "{note}");
            assert!(!note.contains("only the first"), "{note}");

            // A whole document that rendered cleanly says nothing extra.
            assert_eq!(unread_notes(12, 12, 0), "");
            // One page short of clean still speaks up.
            assert!(unread_notes(12, 12, 1).contains("1 of 12"));

            // Capped AND partly unrenderable: both facts, cap first.
            let both = unread_notes(900, 500, 3);
            let cap = both.find("only the first 500 of 900").expect("cap note");
            let skip = both.find("3 of 500").expect("skip note");
            assert!(cap < skip, "{both}");

            // Capped but every attempted page drew: only the cap note.
            let capped = unread_notes(900, 500, 0);
            assert!(capped.contains("only the first 500 of 900"), "{capped}");
            assert!(!capped.contains(concat!("could not be ", "rendered")), "{capped}");
        }
    }
}
