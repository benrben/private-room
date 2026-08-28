"""Tests for `arcelle_sidecar.docs.rtf` (port of `extract_rtf` /
`skip_rtf_fallback`, `src-tauri/src/extraction.rs` lines 576-730).

There is no `#[cfg(test)]` block on the Rust side for `extract_rtf` to port
verbatim -- it predates the test-driven modules elsewhere in this codebase
-- so this is a from-scratch suite, built by hand-tracing each input
through the state machine (brace depth, skip-group membership, codepage,
`uc` fallback count) against the Rust source, rather than by running the
port and copying its output.
"""

from __future__ import annotations

from arcelle_sidecar.docs import rtf


def test_plain_ascii_prose_with_par_breaks() -> None:
    doc = r"{\rtf1\ansi\ansicpg1252\deff0 Hello world\par Second paragraph}"
    assert rtf.extract_rtf(doc) == "Hello world\nSecond paragraph"


def test_fonttbl_group_skipped_does_not_eat_surrounding_prose() -> None:
    # The module's own worked example: a `\fonttbl` group must be skipped
    # WHOLE without splitting the real prose around it -- "Le siège
    # social" must not become "Le si ge social". `\'e8` is CP1252 0xE8
    # (e-grave), an ASCII-range byte that decodes directly.
    doc = (
        r"{\rtf1\ansi\ansicpg1252{\fonttbl{\f0\froman Times New Roman;}}"
        r"Le si\'e8ge social\par}"
    )
    assert rtf.extract_rtf(doc) == "Le siège social\n"


def test_colortbl_group_skipped_whole() -> None:
    doc = r"{\rtf1\ansi\ansicpg1252{\colortbl;\red0\green0\blue0;}Text\par}"
    assert rtf.extract_rtf(doc) == "Text\n"


def test_hex_escape_ascii_range() -> None:
    doc = r"{\rtf1 A\'e8B}"
    assert rtf.extract_rtf(doc) == "AèB"


def test_hex_escape_high_range_cp1252_curly_quotes() -> None:
    # 0x93/0x94 are CP1252's curly double quotes -- in the 0x80-0x9F high
    # range that needs the module's own lookup table, not a direct byte
    # equivalence.
    doc = r"{\rtf1\ansi\ansicpg1252 \'93Hello\'94\par}"
    assert rtf.extract_rtf(doc) == "“Hello”\n"


def test_u_escape_with_uc1_fallback_not_double_counted() -> None:
    # \u232 is 'è' (0xE8); \uc1 means exactly one ANSI fallback character
    # follows each \u escape ('?' here) and it must be consumed, not
    # emitted alongside the real decoded character.
    doc = r"{\rtf1\ansi\ansicpg1252\uc1\u232?\par}"
    assert rtf.extract_rtf(doc) == "è\n"


def test_u_escape_with_explicit_uc_and_literal_fallback_chars() -> None:
    # \uc2: two ANSI fallback characters follow chr(1488) (Hebrew Alef),
    # written here as two bare literal fallback letters ("XY") rather than
    # escapes -- each bare character counts as exactly one fallback unit
    # too, and both must be swallowed.
    doc = "{\\rtf1\\uc2\\u1488XY more}"
    assert rtf.extract_rtf(doc) == chr(1488) + " more"


def test_negative_u_escape_twos_complement() -> None:
    # A negative \u parameter is the code unit written as a signed 16-bit
    # integer: -3629 + 65536 = 61907 (U+F1D3).
    doc = r"{\rtf1\ansi\ansicpg1252\uc0\u-3629\par}"
    assert rtf.extract_rtf(doc) == chr(61907) + "\n"


def test_u_fallback_run_ends_early_at_group_boundary() -> None:
    # \uc5 asks for 5 fallback characters, but the group closes right
    # after \u65 with none actually present -- the fallback consumer must
    # stop at the brace rather than consuming (or choking on) it, leaving
    # the brace for the main walk to close the group with normally.
    doc = r"{\rtf1\uc5\u65}"
    assert rtf.extract_rtf(doc) == "A"


def test_non_1252_codepage_leaves_hex_escape_as_space() -> None:
    # \ansicpg1250 (Central European) means a non-ASCII \'xx byte cannot be
    # decoded via the CP1252 table -- it becomes a plain space rather than
    # a guess.
    doc = r"{\rtf1\ansi\ansicpg1250 X\'e8Y\par}"
    assert rtf.extract_rtf(doc) == "X Y\n"


def test_nested_skip_groups_still_fully_skip() -> None:
    # \stylesheet is itself a skip-group control word, encountered here
    # while already inside a skipped \fonttbl -- it must not reset or
    # re-mark anything, and everything inside (at any nesting depth) must
    # still be dropped.
    doc = (
        r"{\rtf1\ansi\ansicpg1252{\fonttbl{\stylesheet Ignored text}"
        r"Also ignored}Visible text\par}"
    )
    assert rtf.extract_rtf(doc) == "Visible text\n"


def test_tab_is_space_and_break_words_are_newlines() -> None:
    doc = r"{\rtf1\ansi\ansicpg1252 A\tab B\line C\par D\pard E\sect F\page G}"
    assert rtf.extract_rtf(doc) == "A B\nC\nD\nE\nF\nG"


def test_whitespace_only_document_returns_none() -> None:
    assert rtf.extract_rtf(r"{\rtf1\ansi\ansicpg1252\par\par}") is None
    assert rtf.extract_rtf(r"{\rtf1\tab}") is None
    assert rtf.extract_rtf("") is None
    assert rtf.extract_rtf(r"{\rtf1}") is None


def test_escaped_literal_backslash_brace_chars() -> None:
    # \\ \{ \} are the only non-alphabetic escapes that emit a literal
    # character; every other one (e.g. \~) consumes silently.
    doc = "{\\rtf1\\ansi\\ansicpg1252 A\\\\B\\{C\\}D\\par}"
    assert rtf.extract_rtf(doc) == "A\\B{C}D\n"


def test_other_nonalpha_escape_produces_no_output() -> None:
    doc = r"{\rtf1\ansi\ansicpg1252 A\~B\par}"
    assert rtf.extract_rtf(doc) == "AB\n"


def test_unrecognized_control_word_produces_no_output() -> None:
    # \b / \b0 (bold on/off) are not in SKIP_GROUPS and not one of the
    # paragraph-break/tab words -- ignored silently, including their own
    # delimiter space, so no extra space appears in the output either.
    doc = r"{\rtf1\b Bold\b0 unbold}"
    assert rtf.extract_rtf(doc) == "Boldunbold"


def test_invalid_hex_escape_still_consumes_two_chars_but_emits_nothing() -> None:
    # The two characters after \' are always consumed (whether or not they
    # are valid hex digits) -- but if they don't parse as a hex byte at
    # all, nothing is emitted, not even a fallback space.
    doc = r"{\rtf1\ansi\ansicpg1252 A\'zzB\par}"
    assert rtf.extract_rtf(doc) == "AB\n"


def test_hex_escape_leading_minus_is_invalid_not_a_negative_byte() -> None:
    # `u8::from_str_radix("-8", 16)` errors in Rust (unsigned types never
    # accept a leading '-') -- verified against rustc. A naive Python
    # `int(s, 16)` would instead happily return -8 and later crash the
    # caller's `chr()`.
    doc = r"{\rtf1 A\'-8B}"
    assert rtf.extract_rtf(doc) == "AB"


def test_hex_escape_leading_plus_is_valid() -> None:
    # `u8::from_str_radix("+8", 16)` is `Ok(8)` in Rust -- unsigned integer
    # parsing strips a single leading '+' unconditionally. Verified
    # against rustc.
    doc = r"{\rtf1 A\'+8B}"
    assert rtf.extract_rtf(doc) == "A\x08B"


def test_hex_escape_embedded_space_is_invalid() -> None:
    # `u8::from_str_radix(" 8", 16)` errors in Rust (no whitespace
    # stripping) -- verified against rustc. Python's `int(" 8", 16)` would
    # otherwise silently strip the space and decode it as 8.
    doc = "{\\rtf1 A\\' 8B}"
    assert rtf.extract_rtf(doc) == "AB"


def test_uc_count_is_clamped_to_16() -> None:
    # \uc20 must be clamped to 16: if it were not, the 4 extra fallback
    # "characters" would swallow the start of the real text ("REAL")
    # instead of stopping after the 16 placeholder 'x' characters.
    doc = "{\\rtf1\\ansi\\ansicpg1252\\uc20\\u65" + ("x" * 16) + "REAL\\par}"
    assert rtf.extract_rtf(doc) == "AREAL\n"
