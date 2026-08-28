"""Tests for `arcelle_sidecar.docs.mail` (port of the mail section of
`src-tauri/src/extraction/data.rs`: `extract_eml` and its helpers).

Mirrors the Rust `#[cfg(test)]` mail cases verbatim:
`a_plain_message_keeps_its_headers_and_body`,
`a_folded_subject_and_an_encoded_word_are_read_as_one_value`,
`multipart_prefers_the_plain_alternative_and_decodes_it`,
`an_html_only_message_is_stripped_not_indexed_as_markup`,
`a_base64_body_is_decoded`.
"""

from __future__ import annotations

from arcelle_sidecar.docs.mail import extract_eml


def test_a_plain_message_keeps_its_headers_and_body() -> None:
    eml = "From: a@example.com\r\nTo: b@example.com\r\nSubject: Rent\r\n\r\nThe fee is 5%.\r\n"
    text = extract_eml(eml)
    assert text is not None, "no text"
    assert "Subject: Rent" in text
    assert "The fee is 5%." in text


def test_a_folded_subject_and_an_encoded_word_are_read_as_one_value() -> None:
    eml = (
        "Subject: =?utf-8?B?15fXqdeR15XXn8Kg15HXmdeq?=\r\n "
        "=?utf-8?Q?_more?=\r\nFrom: a@example.com\r\n\r\nbody\r\n"
    )
    text = extract_eml(eml)
    assert text is not None, "no text"
    assert "חשבון" in text, f"encoded word not decoded: {text!r}"
    assert "more" in text, f"the folded continuation was dropped: {text!r}"


def test_multipart_prefers_the_plain_alternative_and_decodes_it() -> None:
    # quoted-printable body with a soft break and an escaped e-acute.
    eml = (
        'Subject: Hi\r\nContent-Type: multipart/alternative; boundary="xyz"\r\n\r\n'
        "--xyz\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n"
        "Le si=C3=A8ge so=\r\ncial\r\n"
        "--xyz\r\nContent-Type: text/html\r\n\r\n<p>ignored</p>\r\n--xyz--\r\n"
    )
    text = extract_eml(eml)
    assert text is not None, "no text"
    assert "Le siège social" in text, f"qp decode or soft break failed: {text!r}"
    assert "ignored" not in text, "the HTML alternative won over text/plain"


def test_an_html_only_message_is_stripped_not_indexed_as_markup() -> None:
    eml = "Subject: Hi\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>there</b></p>\r\n"
    text = extract_eml(eml)
    assert text is not None
    assert "Hello" in text, text
    assert "<b>" not in text, f"markup reached the index: {text!r}"


def test_a_base64_body_is_decoded() -> None:
    eml = "Subject: Hi\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8gd29ybGQ=\r\n"
    text = extract_eml(eml)
    assert text is not None
    assert "Hello world" in text, text


def test_a_soft_break_split_across_a_multibyte_characters_own_escapes() -> None:
    """Adversarial case distinct from the ported `...decodes_it` test (which
    only splits a soft break across plain ASCII prose, "so=\\r\\ncial").

    Here the soft break falls INSIDE the pair of `=XX` escapes that together
    encode one multi-byte UTF-8 character: "e" (U+00E9) is bytes C3 A9, and
    line 1 ends right after the "=C3" escape (plus the soft-break "="), so
    "=A9" only appears at the very start of line 2. Byte 0xC3 alone is an
    incomplete UTF-8 sequence and 0xA9 alone is a lone continuation byte --
    either one decoded independently (per-line) is invalid and would lossy-
    decode to a replacement character. Only decoding the whole byte buffer
    at the end (after concatenating across the soft break with no inserted
    newline) reassembles them into a valid "e".
    """
    eml = (
        "Subject: Hi\r\nContent-Type: text/plain\r\n"
        "Content-Transfer-Encoding: quoted-printable\r\n\r\n"
        "Caf=C3=\r\n=A9 today\r\n"
    )
    text = extract_eml(eml)
    assert text is not None
    assert "Café today" in text, f"multi-byte char split by soft break: {text!r}"
    assert "�" not in text, f"a byte half decoded on its own: {text!r}"


def test_nested_multipart_html_fallback_wins_over_a_later_plain_sibling() -> None:
    """The trickiest multipart invariant: when a multipart part is itself
    multipart (nested), `_eml_body_text` recurses and returns that nested
    result IMMEDIATELY if it is non-empty -- even if the nested result is
    itself only an HTML fallback, and even if a LATER sibling of the outer
    multipart is a real text/plain part. This mirrors the Rust source's
    `if !nested.trim().is_empty() { return nested; }` exactly: the outer
    loop never gets a chance to prefer its own later text/plain sibling once
    an earlier nested part has already produced ANY non-empty text.
    """
    eml = (
        'Subject: Mixed\r\nContent-Type: multipart/mixed; boundary="outer"\r\n\r\n'
        "--outer\r\n"
        'Content-Type: multipart/alternative; boundary="inner"\r\n\r\n'
        "--inner\r\n"
        "Content-Type: text/html\r\n\r\n"
        "<p>HTML ONLY nested alt</p>\r\n"
        "--inner--\r\n"
        "--outer\r\n"
        "Content-Type: text/plain\r\n\r\n"
        "REAL PLAIN TEXT SIBLING\r\n"
        "--outer--\r\n"
    )
    text = extract_eml(eml)
    assert text is not None
    assert "HTML ONLY nested alt" in text, text
    assert "REAL PLAIN TEXT SIBLING" not in text, (
        f"the later plain sibling was reached, diverging from the Rust "
        f"source's immediate-return-on-nested-result behavior: {text!r}"
    )
