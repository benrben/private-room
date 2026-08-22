"""Tests for `arcelle_sidecar.docs.text_decode` (port of
`src-tauri/src/extraction.rs` lines 112-282: the BOM -> UTF-8 -> detect
decode cascade, `decode_text_as`, and `encoding_choices()`).

Every encoding claim here is verified empirically against this machine's
real Python codecs and the real `charset-normalizer` package -- not assumed
from the module's own docstring. In particular:

  - the DETECTED-path tests use realistic sample lengths, because a
    short/synthetic single-byte sample was measured (during this port) to
    detect unreliably with `charset-normalizer` -- a real, accepted
    difference from the Rust source's `chardetng` detector, not a bug (see
    the module docstring's detector-swap section);
  - `test_real_world_cjk_supersets_detect_via_the_alias_table` locks in a
    real bug found while merging two independent ports of this module: one
    candidate had no alias mapping from `charset-normalizer`'s very common
    `cp932`/`cp949` guesses back to this table's `shift_jis`/`euc-kr`
    entries, so real Shift_JIS/EUC-KR text silently fell back to the
    windows-1252 default and came back as confident mojibake with
    `lossy=False` -- exactly the "nothing on screen admits it is wrong"
    failure the Rust source's own doc comment warns about. Verified by
    running `charset_normalizer.from_bytes` directly on these fixtures
    before writing the assertions, not assumed;
  - `test_every_offered_encoding_name_round_trips_through_decode_text_as`
    round-trips REAL non-ASCII content through every one of the 23 table
    entries (not just ASCII, which would trivially round-trip through any
    single-byte codec and prove nothing about the mapping).
"""

from __future__ import annotations

import codecs

import pytest

from arcelle_sidecar.docs import text_decode as td

# ------------------------------------------------------------------ BOM


def test_utf8_bom_is_stripped_and_never_reappears_as_u_feff():
    payload = "Hello, café — 日本語".encode("utf-8")
    data = b"\xef\xbb\xbf" + payload
    result = td.decode_text_detail(data)
    assert result.source == td.EncodingSource.BOM
    assert result.encoding == "UTF-8"
    assert result.lossy is False
    assert result.text == "Hello, café — 日本語"
    assert "﻿" not in result.text


def test_utf16le_bom_is_detected_and_stripped():
    payload = "Hello, café — 日本語".encode("utf-16-le")
    data = b"\xff\xfe" + payload
    result = td.decode_text_detail(data)
    assert result.source == td.EncodingSource.BOM
    assert result.encoding == "UTF-16LE"
    assert result.lossy is False
    assert result.text == "Hello, café — 日本語"
    assert "﻿" not in result.text


def test_utf16be_bom_is_detected_and_stripped():
    payload = "Hello, café — 日本語".encode("utf-16-be")
    data = b"\xfe\xff" + payload
    result = td.decode_text_detail(data)
    assert result.source == td.EncodingSource.BOM
    assert result.encoding == "UTF-16BE"
    assert result.lossy is False
    assert result.text == "Hello, café — 日本語"
    assert "﻿" not in result.text


def test_bom_only_with_empty_payload_decodes_to_empty_string():
    result = td.decode_text_detail(b"\xff\xfe")
    assert result.source == td.EncodingSource.BOM
    assert result.encoding == "UTF-16LE"
    assert result.lossy is False
    assert result.text == ""


def test_bom_path_still_reports_lossy_on_malformed_trailing_byte():
    # A BOM'd UTF-16LE stream with one odd trailing byte -- not a full code
    # unit -- must still decode (lossily) rather than raise, and the lossy
    # flag must be True.
    data = b"\xff\xfe" + "hi".encode("utf-16-le") + b"\x41"
    result = td.decode_text_detail(data)
    assert result.source == td.EncodingSource.BOM
    assert result.lossy is True
    assert "�" in result.text


# --------------------------------------------------------------- UTF-8


def test_valid_utf8_with_no_bom_is_read_with_no_guessing():
    text = "Plain UTF-8 with no byte-order mark: héllo wörld 你好"
    data = text.encode("utf-8")
    result = td.decode_text_detail(data)
    assert result.source == td.EncodingSource.UTF8
    assert result.encoding == "UTF-8"
    assert result.lossy is False
    assert result.text == text
    assert td.decode_text_bytes(data) == text


def test_empty_input_decodes_as_utf8_empty_string():
    result = td.decode_text_detail(b"")
    assert result.source == td.EncodingSource.UTF8
    assert result.encoding == "UTF-8"
    assert result.lossy is False
    assert result.text == ""


# -------------------------------------------------------------- detect


def test_ambiguous_single_byte_legacy_text_is_detected_and_readable():
    # A realistic paragraph, not a short/synthetic sample -- empirically
    # confirmed (during this port) that charset-normalizer needs
    # paragraph-length signal to guess a single-byte encoding reliably.
    # This exact fixture's real guess was run through charset-normalizer
    # directly and confirmed to be cp1252 before writing this assertion.
    french = (
        "La France est un pays d'Europe occidentale. Sa capitale est Paris, "
        "une ville connue pour son histoire, sa culture et sa cuisine. "
        "Les Français apprécient beaucoup le café le matin, un bon repas "
        "à midi et une promenade le soir. On y trouve aussi de belles "
        "églises, des châteaux et des musées célèbres à travers tout le "
        "pays."
    )
    data = french.encode("cp1252")
    # Sanity: genuinely not valid UTF-8, so this really exercises step 3.
    with pytest.raises(UnicodeDecodeError):
        data.decode("utf-8", errors="strict")

    result = td.decode_text_detail(data)
    assert result.source == td.EncodingSource.DETECTED
    assert result.encoding == "windows-1252"
    assert result.lossy is False
    assert result.text == french


def test_detect_sample_is_bounded_to_64kib_prefix_but_full_input_is_decoded():
    assert td._SAMPLE_BYTES == 64 * 1024
    french_sentence = "café à la française, château, éléphant. "
    data = (french_sentence * 5000).encode("cp1252")  # well over 64 KiB
    assert len(data) > 64 * 1024
    result = td.decode_text_detail(data)
    assert result.source == td.EncodingSource.DETECTED
    assert result.lossy is False
    assert len(result.text) == len(french_sentence) * 5000


def test_real_world_cjk_supersets_detect_via_the_alias_table():
    # Real Shift_JIS and EUC-KR content very commonly guesses as Microsoft's
    # supersets (cp932 / cp949) rather than the base codec name -- verified
    # by running charset_normalizer.from_bytes on these exact fixtures. A
    # port that doesn't map those guesses back to this table's shift_jis /
    # euc-kr entries silently falls back to the windows-1252 default and
    # produces confident mojibake with lossy=False (the "nothing admits it
    # is wrong" failure mode the Rust source's doc comment warns about).
    japanese = (
        "こんにちは世界。これはテスト文章です。"
        "日本語のエンコーディングを確認します。"
    )
    data_ja = japanese.encode("cp932", errors="ignore")
    guess_ja = codecs.lookup(td._cn_from_bytes(data_ja).best().encoding).name
    assert guess_ja == "cp932", "fixture assumption changed; re-check the alias table"
    result_ja = td.decode_text_detail(data_ja)
    assert result_ja.source == td.EncodingSource.DETECTED
    assert result_ja.encoding == "Shift_JIS"
    assert result_ja.lossy is False
    assert result_ja.text == japanese

    korean = (
        "안녕하세요 세계, 이것은 인코딩 감지를 확인하기 위한 테스트 문장입니다. "
        "이 문장은 조금 더 길게 작성하여 감지가 더 정확하게 이루어지도록 합니다."
    )
    data_ko = korean.encode("euc-kr")
    guess_ko = codecs.lookup(td._cn_from_bytes(data_ko).best().encoding).name
    assert guess_ko == "cp949", "fixture assumption changed; re-check the alias table"
    result_ko = td.decode_text_detail(data_ko)
    assert result_ko.source == td.EncodingSource.DETECTED
    assert result_ko.encoding == "EUC-KR"
    assert result_ko.lossy is False
    assert result_ko.text == korean


# --------------------------------------------------------------- lossy


def test_lossy_flag_true_when_a_byte_has_no_meaning_in_the_encoding():
    # 0x81 is undefined in windows-1252 (a real decode error, not a guess).
    data = b"before \x81 after"
    result = td.decode_text_as(data, "windows-1252")
    assert result is not None
    assert result.lossy is True
    assert "�" in result.text


def test_lossy_flag_false_for_a_clean_file():
    text = "This is a perfectly clean windows-1252 file with no bad bytes."
    data = text.encode("cp1252")
    result = td.decode_text_as(data, "windows-1252")
    assert result is not None
    assert result.lossy is False
    assert result.text == text


def test_lossy_flag_is_not_fooled_by_a_genuine_replacement_character():
    # A validly-encoded file that happens to legitimately CONTAIN U+FFFD
    # must not be reported as lossy -- the flag means "a byte had no
    # meaning here", not "U+FFFD appears in the output".
    text = "This text genuinely contains a real replacement char: � (on purpose)."
    data = text.encode("utf-8")
    result = td.decode_text_detail(data)
    assert result.source == td.EncodingSource.UTF8
    assert result.lossy is False
    assert result.text == text
    assert "�" in result.text


# ---------------------------------------------------------- decode_text_as


@pytest.mark.parametrize(
    ("label", "python_codec", "sample_text"),
    [
        ("windows-1252", "cp1252", "café latte"),
        ("WINDOWS-1252", "cp1252", "café latte"),
        ("koi8-r", "koi8-r", "Привет"),
        ("Koi8-R", "koi8-r", "Привет"),
        ("big5", "big5", "你好"),
        ("Big5", "big5", "你好"),
        ("shift_jis", "shift-jis", "こんにちは"),
        ("SHIFT_JIS", "shift-jis", "こんにちは"),
        ("euc-kr", "euc-kr", "안녕하세요"),
    ],
)
def test_decode_text_as_recognized_labels_case_insensitive(label, python_codec, sample_text):
    data = sample_text.encode(python_codec)
    result = td.decode_text_as(data, label)
    assert result is not None
    assert result.source == td.EncodingSource.CHOSEN
    assert result.text == sample_text
    assert result.lossy is False


def test_decode_text_as_also_matches_by_canonical_name():
    # "UTF-16LE" is the WHATWG canonical name, not the short label
    # ("utf-16le") -- both must resolve to the same choice.
    data = "hello".encode("utf-16-le")
    result = td.decode_text_as(data, "UTF-16LE")
    assert result is not None
    assert result.encoding == "UTF-16LE"
    assert result.text == "hello"


def test_decode_text_as_does_not_strip_a_bom_even_if_present():
    # The override means "read literally as this encoding", including bytes
    # that happen to look like a BOM for some OTHER encoding.
    payload = "hello".encode("utf-8")
    data = b"\xef\xbb\xbf" + payload  # a real UTF-8 BOM, on purpose
    result = td.decode_text_as(data, "windows-1252")
    assert result is not None
    assert result.source == td.EncodingSource.CHOSEN
    assert result.encoding == "windows-1252"
    expected = data.decode("cp1252")
    assert result.text == expected
    assert len(result.text) == len(data) == 8
    assert result.text != "hello"
    assert "﻿" not in result.text


def test_decode_text_as_unrecognized_label_returns_none():
    assert td.decode_text_as(b"whatever", "not-a-real-encoding") is None
    assert td.decode_text_as(b"whatever", "") is None
    # Real WHATWG aliases the Rust source's `for_label` would accept, but
    # deliberately out of scope for this module's 23 curated choices (see
    # the module docstring's "decode_text_as scope" section).
    assert td.decode_text_as(b"whatever", "iso-8859-9") is None  # merged into windows-1254
    assert td.decode_text_as(b"whatever", "latin1") is None


# ---------------------------------------------------------- encoding_choices()


def test_encoding_choices_has_exactly_23_distinct_entries():
    choices = td.encoding_choices()
    assert len(choices) == 23
    names = [name for name, _title in choices]
    assert len(set(names)) == 23, f"duplicate names: {names}"
    titles = [title for _name, title in choices]
    assert len(set(titles)) == 23, f"duplicate titles: {titles}"


def test_encoding_choices_matches_the_rust_source_order_and_titles():
    # Copied verbatim from the Rust ENCODING_CHOICES array's comments.
    expected = [
        ("UTF-8", "Unicode (UTF-8)"),
        ("UTF-16LE", "Unicode (UTF-16, little-endian)"),
        ("UTF-16BE", "Unicode (UTF-16, big-endian)"),
        ("windows-1252", "Western European (Windows 1252)"),
        ("ISO-8859-15", "Western European (ISO-8859-15)"),
        ("macintosh", "Western European (Mac Roman)"),
        ("windows-1250", "Central European (Windows 1250)"),
        ("ISO-8859-2", "Central European (ISO-8859-2)"),
        ("windows-1254", "Turkish (Windows 1254 / ISO-8859-9)"),
        ("windows-1251", "Cyrillic (Windows 1251)"),
        ("KOI8-R", "Cyrillic (KOI8-R)"),
        ("ISO-8859-5", "Cyrillic (ISO-8859-5)"),
        ("windows-1253", "Greek (Windows 1253)"),
        ("windows-1255", "Hebrew (Windows 1255)"),
        ("windows-1256", "Arabic (Windows 1256)"),
        ("windows-1257", "Baltic (Windows 1257)"),
        ("windows-1258", "Vietnamese (Windows 1258)"),
        ("Shift_JIS", "Japanese (Shift_JIS)"),
        ("EUC-JP", "Japanese (EUC-JP)"),
        ("GBK", "Simplified Chinese (GBK)"),
        ("gb18030", "Simplified Chinese (GB18030)"),
        ("Big5", "Traditional Chinese (Big5)"),
        ("EUC-KR", "Korean (EUC-KR)"),
    ]
    assert td.encoding_choices() == expected


def test_every_offered_encoding_name_round_trips_through_decode_text_as():
    # The exact regression the Rust source's own comment says a test
    # enforces: "so the picker can never offer an encoding this decoder
    # cannot actually read." Uses REAL non-ASCII content per encoding, not
    # ASCII (which would trivially round-trip through any single-byte
    # codec and prove nothing about the mapping actually being correct).
    samples: dict[str, tuple[str, str]] = {
        "UTF-8": ("utf-8", "hello café 日本語"),
        "UTF-16LE": ("utf-16-le", "hello café 日本語"),
        "UTF-16BE": ("utf-16-be", "hello café 日本語"),
        "windows-1252": ("cp1252", "café latte"),
        "ISO-8859-15": ("iso8859-15", "café €"),
        "macintosh": ("mac-roman", "café"),
        "windows-1250": ("cp1250", "Příliš žluťoučký kůň"),
        "ISO-8859-2": ("iso8859-2", "Příliš žluťoučký kůň"),
        "windows-1254": ("cp1254", "Türkçe İstanbul"),
        "windows-1251": ("cp1251", "Привет мир"),
        "KOI8-R": ("koi8-r", "Привет мир"),
        "ISO-8859-5": ("iso8859-5", "Привет мир"),
        "windows-1253": ("cp1253", "Ξεσκεπάζω"),
        "windows-1255": ("cp1255", "שלום עולם"),
        "windows-1256": ("cp1256", "مرحبا بالعالم"),
        "windows-1257": ("cp1257", "Šiaurės vėjas"),
        "windows-1258": ("cp1258", "ăâđêôơư Nam"),
        "Shift_JIS": ("shift-jis", "こんにちは"),
        "EUC-JP": ("euc-jp", "こんにちは"),
        "GBK": ("gbk", "你好世界"),
        "gb18030": ("gb18030", "你好世界"),
        "Big5": ("big5", "你好世界"),
        "EUC-KR": ("euc-kr", "안녕하세요"),
    }
    names = [name for name, _title in td.encoding_choices()]
    assert set(names) == set(samples), "sample table drifted from encoding_choices()"
    for name in names:
        codec, text = samples[name]
        data = text.encode(codec)
        result = td.decode_text_as(data, name)
        assert result is not None, f"{name!r} was offered but decode_text_as rejected it"
        assert result.encoding == name
        assert result.source == td.EncodingSource.CHOSEN
        assert result.lossy is False
        assert result.text == text


# ---------------------------------------------------- codec fidelity sweep


@pytest.mark.parametrize("choice", td.ENCODING_CHOICES, ids=lambda c: c.label)
def test_every_table_codec_round_trips_a_sample_string(choice):
    # Empirical proof (not assumption) that every python_codec in the table
    # actually encodes and decodes a representative string for that script
    # without error, on THIS machine's Python build.
    samples = {
        "utf-8": "hello",
        "utf-16le": "hello",
        "utf-16be": "hello",
        "windows-1252": "café",
        "iso-8859-15": "café €",
        "macintosh": "café",
        "windows-1250": "Příliš žluťoučký kůň",
        "iso-8859-2": "Příliš žluťoučký kůň",
        "windows-1254": "Türkçe İstanbul",
        "windows-1251": "Съешь же ещё этих мягких французских булок",
        "koi8-r": "Съешь же ещё этих мягких французских булок",
        "iso-8859-5": "Съешь же ещё этих мягких французских булок",
        "windows-1253": "Ξεσκεπάζω την ψυχοφθόρα βδελυγμία",
        "windows-1255": "שלום עולם",
        "windows-1256": "مرحبا بالعالم",
        "windows-1257": "Šiaurės vėjas",
        # Not "Việt Nam" -- Python's cp1258 is a static charmap covering
        # only the precomposed single-diacritic Vietnamese letters (see the
        # module docstring's codec-fidelity note).
        "windows-1258": "ăâđêôơư Nam",
        "shift_jis": "こんにちは世界",
        "euc-jp": "こんにちは世界",
        "gbk": "你好世界",
        "gb18030": "你好世界",
        "big5": "你好世界",
        "euc-kr": "안녕하세요 세계",
    }
    sample = samples[choice.label]
    encoded = sample.encode(choice.python_codec)
    decoded = encoded.decode(choice.python_codec)
    assert decoded == sample
    assert codecs.lookup(choice.python_codec) is not None
