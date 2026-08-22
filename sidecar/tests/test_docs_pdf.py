"""Tests for `arcelle_sidecar.docs.pdf` (port of
`src-tauri/src/extraction/pdf.rs` + `src-tauri/src/extraction/pdf_quality.rs`).

Sections (1)-(2) port the `#[cfg(test)]` modules of `pdf.rs` and
`pdf_quality.rs` verbatim -- same input strings, same expected outcomes.
Section (3) is a genuine integration test of `extract_pdf` itself: a real
PDF built in-process with `pymupdf`, plus a garbage-bytes-is-not-a-PDF case
confirming `None` rather than a raised exception -- the Python-side
equivalent of the Rust `catch_unwind` guard (not something the Rust test
suite exercised, since it only ever fed synthetic strings straight to
`fix_visual_hebrew`; this is new coverage the port adds).
"""

from __future__ import annotations

import string

import pymupdf

from arcelle_sidecar.docs import pdf


def consonants(s: str) -> str:
    """Mirrors the Rust test helper of the same name: strip combining marks
    so assertions can check letter order without nikud noise.
    """
    return "".join(c for c in s if not pdf.is_heb_mark(c))


# ------------------------------------------------------- (1) pdf.rs (RTL repair)


def test_visual_hebrew_is_mirrored_back_to_logical() -> None:
    # A REAL line from pdf-extract on a visual-order Hebrew Bible PDF
    # (מִפְּנֵי רֹעַ מַעַלְלֵיכֶם׃ -- mirrored, cluster-spaced), repeated so
    # the document-level detector has enough signal.
    line = "׃םֽ ֶכיֵלְל ַע ַמ  ַע ֹ֥ ר יֵ֖נ ְפּ ִמ"
    doc = (line + "\n") * 60
    fixed = pdf.fix_visual_hebrew(doc)
    first = fixed.split("\n")[0]
    # Letter order restored: the verse now STARTS with mem and ENDS with
    # sof pasuq, and the long word reads forward.
    cons = consonants(first)
    assert cons.startswith("מ"), f"got: {cons}"
    assert cons.endswith("׃"), f"got: {cons}"
    assert "מעלליכם" in cons, f"got: {cons}"
    # No combining mark is left dangling after a space.
    chars = list(first)
    for a, b in zip(chars, chars[1:]):
        assert not (a == " " and pdf.is_heb_mark(b)), f"orphan mark after space in: {first}"


def test_logical_hebrew_and_english_pass_through_untouched() -> None:
    # Properly-extracted (logical) Hebrew has no space+mark clusters, so
    # the detector must not fire -- even for a large document.
    logical = "בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ׃\n" * 200
    assert pdf.fix_visual_hebrew(logical) == logical
    english = "The quick brown fox jumps over the lazy dog.\n" * 200
    assert pdf.fix_visual_hebrew(english) == english


def test_digit_runs_survive_the_mirror() -> None:
    # Verse/page numbers inside a reversed Hebrew line must not come out
    # as mirrored numbers ("13" -> "31").
    line = "׃םֽ ֶכיֵלְל ַע ַמ  ַע ֹ֥ ר יֵ֖נ ְפּ ִמ 13"
    doc = (line + "\n") * 60
    fixed = pdf.fix_visual_hebrew(doc)
    first = fixed.split("\n")[0]
    assert "13" in first, f"digits mirrored: {first}"
    assert "31" not in first, f"digits mirrored: {first}"


def test_line_with_one_hebrew_letter_is_left_untouched() -> None:
    # The Rust boundary is "fewer than TWO Hebrew letters" -- a single
    # Hebrew letter surrounded by digits/Latin must not be reversed at all.
    # Needs to sit inside an otherwise-visual-order document to exercise
    # the per-line "heb < 2" guard rather than the document-level detector.
    trigger = "׃םֽ ֶכיֵלְל ַע ַמ  ַע ֹ֥ ר יֵ֖נ ְפּ ִמ\n" * 60
    single = "abc א 123"
    doc = trigger + single + "\n"
    fixed = pdf.fix_visual_hebrew(doc)
    assert single in fixed.split("\n"), f"single-letter line was mutated: {fixed!r}"


def test_visual_hebrew_with_digits_maqaf_and_sof_pasuq_round_trips() -> None:
    # Adversarial line built (and independently hand/oracle-verified) to mix
    # a digit run, a Hebrew word, and TWO of the excluded Hebrew punctuation
    # marks (maqaf 05BE, sof pasuq 05C3) -- the sof pasuq sits directly
    # against a combining mark (qamats) with no letter or space between them,
    # and the maqaf sits directly against letters on both sides (its real
    # typesetting: a hyphen joining two words with no surrounding spaces).
    # Intended LOGICAL reading: "12 " + bet+segol+final-nun + maqaf +
    # alef+qamats + sof-pasuq.
    logical = "12 " + "ב" + "ֶ" + "ן" + "־" + "א" + "ָ" + "׃"
    # Its visual-order pre-image: a full-string mirror flips everything
    # (letters, marks, punctuation) into the right relative shape for passes
    # 1+3 to restore, EXCEPT the digit run -- pass 2 unconditionally
    # re-flips whatever ascii-alnum run it finds, so a valid raw input must
    # carry that one run in its natural (already-correct) reading order, not
    # mirrored like everything else.
    raw = "׃ָא־ןֶב 12"

    trigger = "׃םֽ ֶכיֵלְל ַע ַמ  ַע ֹ֥ ר יֵ֖נ ְפּ ִמ\n" * 60
    doc = trigger + raw + "\n"
    fixed = pdf.fix_visual_hebrew(doc)
    lines = fixed.split("\n")
    assert lines[-1] == logical, f"got: {lines[-1]!r}"


def test_crlf_line_endings_are_handled_like_rust_lines() -> None:
    # Rust's str::lines() strips a trailing \r from each piece; _rust_lines
    # must match exactly, including no trailing empty entry.
    line = "׃םֽ ֶכיֵלְל ַע ַמ  ַע ֹ֥ ר יֵ֖נ ְפּ ִמ"
    doc = (line + "\r\n") * 60
    fixed = pdf.fix_visual_hebrew(doc)
    assert "\r" not in fixed
    assert not fixed.endswith("\n\n")


# --------------------------------------------------- (2) pdf_quality.rs (fault)

GOOD = (
    "The lease commences on the first of March and continues for a term of "
    "twenty-four months. Rent is payable monthly in advance. The tenant shall keep the "
    "premises in good repair and shall not sublet without written consent from the landlord."
)


def test_ordinary_prose_passes() -> None:
    assert pdf.fault_in(GOOD) is None
    assert not pdf.should_reread_with_ocr(GOOD)


def test_an_empty_reading_is_the_scan_case() -> None:
    assert pdf.fault_in("") is pdf.PdfTextFault.EMPTY
    assert pdf.fault_in("   \n\n  ") is pdf.PdfTextFault.EMPTY
    assert pdf.should_reread_with_ocr("")


def test_words_run_together_are_caught() -> None:
    # The ToUnicode/width failure: every glyph arrives, no spaces do. The
    # old code indexed this happily and search could never match a word.
    jammed = (GOOD * 2).replace(" ", "")
    assert pdf.fault_in(jammed) is pdf.PdfTextFault.NO_WORD_BREAKS


def test_a_reading_under_the_sample_floor_is_only_judged_on_emptiness() -> None:
    # The floor is load-bearing in both directions, so it is pinned here
    # rather than left as an implementation detail: a short cover page must
    # pass, and a short jammed one is NOT enough evidence to re-OCR a whole
    # document over.
    short_jammed = "Thisisashortline" * 2
    assert len(short_jammed) < pdf.MIN_SAMPLE
    assert pdf.fault_in(short_jammed) is None


def test_an_unmapped_font_is_caught() -> None:
    broken = "�" * 120 + GOOD
    assert pdf.fault_in(broken) is pdf.PdfTextFault.UNDECODABLE


def test_symbol_soup_is_caught() -> None:
    # A font with no usable character map often emits private-use glyphs.
    soup = "" * 400
    assert pdf.fault_in(soup) is pdf.PdfTextFault.NOT_LANGUAGE


def test_fault_priority_undecodable_before_not_language() -> None:
    # Rust's fault_in is a strict if/else-if chain: replacement ratio is
    # checked BEFORE the readable ratio. Build a string that independently
    # trips both thresholds (lots of U+FFFD drags the readable ratio down
    # too, since U+FFFD isn't alnum/space/punctuation) and confirm
    # UNDECODABLE -- not NOT_LANGUAGE -- is what's reported.
    broken = "\ufffd" * 90 + GOOD
    sample = broken.strip()[:20_000]
    total = len(sample)
    repl_ratio = sum(1 for c in sample if c == "\ufffd") / total
    readable_ratio = sum(
        1 for c in sample if c.isalnum() or c.isspace() or c in frozenset(string.punctuation)
    ) / total
    assert repl_ratio > pdf.MAX_REPLACEMENT_RATIO, "test string doesn't trip Undecodable"
    assert readable_ratio < pdf.MIN_READABLE_RATIO, "test string doesn't also trip NotLanguage"
    assert pdf.fault_in(broken) is pdf.PdfTextFault.UNDECODABLE


def test_fault_priority_not_language_before_no_word_breaks() -> None:
    # Same chain, next link: readable ratio is checked BEFORE the space
    # ratio. Private-use glyphs have zero spaces (trips NoWordBreaks) AND
    # zero readable chars (trips NotLanguage) at once -- confirm NOT_LANGUAGE
    # wins, matching Rust's if/else-if order.
    soup = "\ue000" * 300
    sample = soup.strip()[:20_000]
    total = len(sample)
    readable_ratio = sum(
        1 for c in sample if c.isalnum() or c.isspace() or c in frozenset(string.punctuation)
    ) / total
    space_ratio = sum(1 for c in sample if c.isspace()) / total
    assert readable_ratio < pdf.MIN_READABLE_RATIO, "test string doesn't trip NotLanguage"
    assert space_ratio < pdf.MIN_SPACE_RATIO, "test string doesn't also trip NoWordBreaks"
    assert pdf.fault_in(soup) is pdf.PdfTextFault.NOT_LANGUAGE


def test_a_short_cover_page_is_not_judged_on_ratios() -> None:
    # "Annual Report 2026" is a legitimate whole-page reading; measuring
    # space ratios over 18 characters would reject real documents.
    assert pdf.fault_in("Annual Report 2026") is None
    assert pdf.fault_in("Title") is None


def test_hebrew_and_accented_prose_are_language() -> None:
    # An ASCII-only punctuation/alnum test alone would fail these; the
    # readable test has to be Unicode-aware or every non-English PDF gets
    # re-OCR'd.
    hebrew = (
        "חוזה השכירות מתחיל בראשון למרץ וממשיך לתקופה של עשרים וארבעה חודשים. "
        "דמי השכירות משולמים מדי חודש מראש והשוכר ישמור על הנכס במצב תקין."
    ) * 2
    assert pdf.fault_in(hebrew) is None, "Hebrew prose was judged unreadable"
    french = (
        "Le siège social de la société est établi à Paris. "
        "Les présentes conditions générales régissent l'utilisation du service."
    ) * 3
    assert pdf.fault_in(french) is None, "accented prose was judged unreadable"


def test_fully_pointed_hebrew_niqqud_is_language() -> None:
    # Genesis 1:1, WITH niqqud (vowel points) -- unlike the consonantal-only
    # Hebrew above, roughly half of a fully-pointed verse's characters are
    # combining marks (sheva, patah, qamats, hiriq, tsere, segol, holam,
    # qubuts, dagesh...). Rust's `char::is_alphanumeric()` follows Unicode's
    # full `Alphabetic` derived property, under which these vowel points ARE
    # alphabetic (`Other_Alphabetic`, confirmed against a real `rustc`
    # build); Python's category-based `str.isalnum()` is not, so a readable
    # check built on bare `isalnum()` undercounts a pointed verse and misreads
    # it as symbol soup -- exactly the primary Hebrew-Bible-PDF case this
    # whole module exists for.
    pointed = (
        "בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ׃ " * 5
    )
    assert pdf.fault_in(pointed) is None, "fully-pointed Hebrew was judged unreadable"


def test_clean_extracted_text_is_never_replaced_by_ocr() -> None:
    # Vision can misread a ligature or a digit; the embedded text of a
    # well-encoded PDF is exact. Faultless extraction always wins.
    ocr = (
        "The leaso commences on the flrst of Marcb and continues for a term of "
        "twenty-four montbs. Rent is payable montbly in advance. The tenant shall keep "
        "the premises in good repair and shall not sublet without consent."
    )
    assert pdf.choose(GOOD, ocr) == GOOD


def test_faulty_extraction_yields_to_a_clean_ocr() -> None:
    jammed = (GOOD * 2).replace(" ", "")
    assert pdf.choose(jammed, GOOD) == GOOD


def test_a_blank_ocr_never_erases_real_text() -> None:
    # The regression this guards: "OCR ran, so use OCR" would replace a
    # faulty-but-present reading with nothing at all.
    jammed = (GOOD * 2).replace(" ", "")
    assert pdf.choose(jammed, "   ") == jammed
    assert pdf.choose(GOOD, None) == GOOD
    assert pdf.choose(None, None) is None


# --------------------------------------------------- (3) extract_pdf integration


def test_extract_pdf_reads_real_text_from_a_real_pdf() -> None:
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=400, height=200)
        page.insert_text((20, 100), "Hello from a real PDF page.", fontsize=24)
        data = doc.tobytes()
    finally:
        doc.close()

    result = pdf.extract_pdf(data)
    assert result is not None
    assert "Hello from a real PDF page." in result


def test_extract_pdf_joins_multiple_pages_with_a_blank_line() -> None:
    doc = pymupdf.open()
    try:
        p1 = doc.new_page(width=400, height=200)
        p1.insert_text((20, 100), "First page text.", fontsize=24)
        p2 = doc.new_page(width=400, height=200)
        p2.insert_text((20, 100), "Second page text.", fontsize=24)
        data = doc.tobytes()
    finally:
        doc.close()

    result = pdf.extract_pdf(data)
    assert result is not None
    assert "First page text." in result
    assert "Second page text." in result
    first_idx = result.index("First page text.")
    second_idx = result.index("Second page text.")
    assert first_idx < second_idx


def test_extract_pdf_on_garbage_bytes_returns_none_not_an_exception() -> None:
    assert pdf.extract_pdf(b"this is not a pdf at all, just garbage bytes") is None
