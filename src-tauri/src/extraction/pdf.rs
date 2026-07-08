pub(crate) fn extract_pdf(bytes: &[u8]) -> Option<String> {
    // pdf-extract can panic on malformed files; contain it.
    let bytes = bytes.to_vec();
    std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem(&bytes).ok())
        .ok()
        .flatten()
}
