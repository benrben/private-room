"""Pure unit coverage for Hebrew search-text normalization."""

from __future__ import annotations

from arcelle_sidecar.docs.pdf import strip_hebrew_marks


def test_strip_hebrew_marks_preserves_an_unpointed_input_exactly() -> None:
    plain = "קהלת — search notes 2026"

    assert strip_hebrew_marks(plain) is plain


def test_strip_hebrew_marks_drops_points_but_keeps_punctuation_and_other_scripts() -> None:
    pointed = "קֹהֶלֶת־א׃ e\u0301"

    assert strip_hebrew_marks(pointed) == "קהלת־א׃ e\u0301"
