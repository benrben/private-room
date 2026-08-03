//! Is a PDF's extracted text good enough to index?
//!
//! THE PROBLEM: `pdf-extract` is a pure-Rust reader with no layout model. It
//! walks glyphs in content-stream order, which is right for a single column of
//! prose and wrong for everything else. On a two-column paper it interleaves
//! the columns line by line; on a table it runs the cells together; on a page
//! whose font has no usable ToUnicode map it emits the glyph indices as
//! letters. In every one of those cases it returns text and reports success —
//! so the room indexed the mess, RAG retrieved the mess, and the model answered
//! from the mess with nothing anywhere saying the page had not been read.
//!
//! OCR already existed as a fallback but only for the empty case, which catches
//! only the image-only scan. Everything above returns *something*.
//!
//! THE FIX HERE is the missing question — "is this text, or is it noise?" —
//! asked of the output before it is trusted. A page that fails goes to Apple's
//! Vision recognizer instead, which reads the RENDERED page and is therefore
//! layout-aware and font-independent by construction. That engine is already
//! bundled, already signed and already used for scans, so this costs no new
//! dependency at all: it just stops being reserved for the one failure mode
//! that happened to be easy to detect.

/// A page of prose has a space roughly every 5–6 characters. Below this the
/// extractor has run words together — the ToUnicode/width failure — and the
/// result tokenizes into nothing a search can match.
const MIN_SPACE_RATIO: f64 = 0.06;

/// Above this share of replacement characters, the encoding was not understood.
const MAX_REPLACEMENT_RATIO: f64 = 0.02;

/// Below this share of characters being letters/digits/space/punctuation, the
/// output is symbol soup rather than language.
const MIN_READABLE_RATIO: f64 = 0.80;

/// Text shorter than this is judged only on "is it empty" — a title page or a
/// cover legitimately carries a dozen words, and ratios over 40 characters are
/// noise themselves.
const MIN_SAMPLE: usize = 200;

/// Why a PDF's extracted text was rejected. Carried so the decision can be
/// logged and tested by name rather than as a bare bool.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum PdfTextFault {
    /// Nothing at all — the classic image-only scan.
    Empty,
    /// Words run together: almost no spaces.
    NoWordBreaks,
    /// The font's character map wasn't understood.
    Undecodable,
    /// Mostly symbols rather than language.
    NotLanguage,
}

/// Judge extracted PDF text. `None` means "good enough to index".
pub fn fault_in(text: &str) -> Option<PdfTextFault> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(PdfTextFault::Empty);
    }
    // Sample the head rather than walk a 900-page book: the failure modes are
    // properties of the document's fonts and layout, not of one page.
    let sample: Vec<char> = trimmed.chars().take(20_000).collect();
    if sample.len() < MIN_SAMPLE {
        return None;
    }
    let total = sample.len() as f64;

    let replacement = sample.iter().filter(|c| **c == '\u{fffd}').count() as f64;
    if replacement / total > MAX_REPLACEMENT_RATIO {
        return Some(PdfTextFault::Undecodable);
    }

    let readable = sample
        .iter()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || c.is_ascii_punctuation())
        .count() as f64;
    if readable / total < MIN_READABLE_RATIO {
        return Some(PdfTextFault::NotLanguage);
    }

    // Word breaks: any whitespace counts, since a reader that emits one glyph
    // per line still separates its words.
    let spaces = sample.iter().filter(|c| c.is_whitespace()).count() as f64;
    if spaces / total < MIN_SPACE_RATIO {
        return Some(PdfTextFault::NoWordBreaks);
    }
    None
}

/// True when this text should be replaced by an OCR pass over the rendered
/// pages. Named for the decision it drives.
pub fn should_reread_with_ocr(text: &str) -> bool {
    fault_in(text).is_some()
}

/// Which of two readings of the same document to keep.
///
/// OCR is not automatically better: on a clean, well-encoded PDF the embedded
/// text is exact while Vision can misread a ligature or a digit. So the
/// extracted text is kept unless it is FAULTY, and the OCR is kept only if it
/// is not faulty itself — a scan of a blank page must not replace real text
/// with nothing.
pub fn choose<'a>(extracted: Option<&'a str>, ocr: Option<&'a str>) -> Option<&'a str> {
    match (extracted, ocr) {
        (Some(e), Some(o)) => {
            if fault_in(e).is_none() {
                Some(e)
            } else if fault_in(o).is_none() {
                Some(o)
            } else {
                // Both are poor: keep whichever has more readable content, so
                // a partial reading still beats nothing.
                if o.trim().len() > e.trim().len() {
                    Some(o)
                } else {
                    Some(e)
                }
            }
        }
        (Some(e), None) => Some(e),
        (None, Some(o)) => Some(o),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "The lease commences on the first of March and continues for a term of \
        twenty-four months. Rent is payable monthly in advance. The tenant shall keep the \
        premises in good repair and shall not sublet without written consent from the landlord.";

    #[test]
    fn ordinary_prose_passes() {
        assert_eq!(fault_in(GOOD), None);
        assert!(!should_reread_with_ocr(GOOD));
    }

    #[test]
    fn an_empty_reading_is_the_scan_case() {
        assert_eq!(fault_in(""), Some(PdfTextFault::Empty));
        assert_eq!(fault_in("   \n\n  "), Some(PdfTextFault::Empty));
        assert!(should_reread_with_ocr(""));
    }

    #[test]
    fn words_run_together_are_caught() {
        // The ToUnicode/width failure: every glyph arrives, no spaces do. The
        // old code indexed this happily and search could never match a word.
        let jammed = GOOD.repeat(2).replace(' ', "");
        assert_eq!(fault_in(&jammed), Some(PdfTextFault::NoWordBreaks));
    }

    #[test]
    fn a_reading_under_the_sample_floor_is_only_judged_on_emptiness() {
        // The floor is load-bearing in both directions, so it is pinned here
        // rather than left as an implementation detail: a short cover page
        // must pass, and a short jammed one is NOT enough evidence to re-OCR
        // a whole document over.
        let short_jammed = "Thisisashortline".repeat(2);
        assert!(short_jammed.len() < MIN_SAMPLE);
        assert_eq!(fault_in(&short_jammed), None);
    }

    #[test]
    fn an_unmapped_font_is_caught() {
        let broken = "\u{fffd}".repeat(120) + GOOD;
        assert_eq!(fault_in(&broken), Some(PdfTextFault::Undecodable));
    }

    #[test]
    fn symbol_soup_is_caught() {
        // A font with no usable character map often emits private-use glyphs.
        let soup: String = std::iter::repeat_n('\u{e000}', 400).collect();
        assert_eq!(fault_in(&soup), Some(PdfTextFault::NotLanguage));
    }

    #[test]
    fn a_short_cover_page_is_not_judged_on_ratios() {
        // "Annual Report 2026" is a legitimate whole-page reading; measuring
        // space ratios over 18 characters would reject real documents.
        assert_eq!(fault_in("Annual Report 2026"), None);
        assert_eq!(fault_in("Title"), None);
    }

    #[test]
    fn hebrew_and_accented_prose_are_language() {
        // `is_ascii_punctuation` alone would fail these; the readable test has
        // to be Unicode-aware or every non-English PDF gets re-OCR'd.
        let hebrew = "חוזה השכירות מתחיל בראשון למרץ וממשיך לתקופה של עשרים וארבעה חודשים. \
            דמי השכירות משולמים מדי חודש מראש והשוכר ישמור על הנכס במצב תקין."
            .repeat(2);
        assert_eq!(fault_in(&hebrew), None, "Hebrew prose was judged unreadable");
        let french = "Le siège social de la société est établi à Paris. \
            Les présentes conditions générales régissent l'utilisation du service."
            .repeat(3);
        assert_eq!(fault_in(&french), None, "accented prose was judged unreadable");
    }

    #[test]
    fn clean_extracted_text_is_never_replaced_by_ocr() {
        // Vision can misread a ligature or a digit; the embedded text of a
        // well-encoded PDF is exact. Faultless extraction always wins.
        let ocr = "The leaso commences on the flrst of Marcb and continues for a term of \
            twenty-four montbs. Rent is payable montbly in advance. The tenant shall keep \
            the premises in good repair and shall not sublet without consent.";
        assert_eq!(choose(Some(GOOD), Some(ocr)), Some(GOOD));
    }

    #[test]
    fn faulty_extraction_yields_to_a_clean_ocr() {
        let jammed = GOOD.repeat(2).replace(' ', "");
        assert_eq!(choose(Some(&jammed), Some(GOOD)), Some(GOOD));
    }

    #[test]
    fn a_blank_ocr_never_erases_real_text() {
        // The regression this guards: "OCR ran, so use OCR" would replace a
        // faulty-but-present reading with nothing at all.
        let jammed = GOOD.repeat(2).replace(' ', "");
        assert_eq!(choose(Some(&jammed), Some("   ")), Some(jammed.as_str()));
        assert_eq!(choose(Some(GOOD), None), Some(GOOD));
        assert_eq!(choose(None, None), None);
    }
}
