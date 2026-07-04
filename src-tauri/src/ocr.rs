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
    /// Bound work on huge documents; OCR runs in the background but a 500-page
    /// scan shouldn't spin forever. The rest of the file is left un-OCR'd.
    const MAX_PDF_PAGES: usize = 50;

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
        let pages = CGPDFDocument::number_of_pages(Some(&doc)).min(MAX_PDF_PAGES);
        if pages == 0 {
            return None;
        }
        let mut out = String::new();
        for page_number in 1..=pages {
            let Some(png) = render_pdf_page_png(&doc, page_number) else {
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
            None
        } else {
            Some(out)
        }
    }

    /// Draw one PDF page onto a white RGBA bitmap and hand back PNG bytes.
    fn render_pdf_page_png(doc: &CGPDFDocument, page_number: usize) -> Option<Vec<u8>> {
        let page: CFRetained<CGPDFPage> = CGPDFDocument::page(Some(doc), page_number)?;
        let media: CGRect = CGPDFPage::box_rect(Some(&page), CGPDFBox::MediaBox);
        let width = (media.size.width * PDF_RENDER_SCALE).ceil() as usize;
        let height = (media.size.height * PDF_RENDER_SCALE).ceil() as usize;
        if width == 0 || height == 0 || width > 20_000 || height > 20_000 {
            return None;
        }

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
        CGContext::scale_ctm(Some(ctx_ref), PDF_RENDER_SCALE, PDF_RENDER_SCALE);
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

    /// Configure a text-recognition request (English + Hebrew, accurate level),
    /// run it against `handler`, and collect the best candidate per text block.
    fn run_recognition(handler: &VNImageRequestHandler) -> Option<String> {
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        let langs = NSArray::from_retained_slice(&[NSString::from_str("en"), NSString::from_str("he")]);
        request.setRecognitionLanguages(&langs);

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
}
