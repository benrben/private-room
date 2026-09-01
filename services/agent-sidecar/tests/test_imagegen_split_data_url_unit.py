"""Pure data-URL decoding coverage; no image generation is invoked."""

from __future__ import annotations

import pytest

from arcelle_sidecar import imagegen


@pytest.mark.parametrize(
    ("url", "mime", "artwork"),
    [
        ("data:image/png;base64,aGVsbG8=", "image/png", b"hello"),
        (
            "data: Image/PNG ;charset=utf-8;BASE64,AAH/",
            "image/png",
            b"\x00\x01\xff",
        ),
        ("data:application/octet-stream;base64,WA==", "application/octet-stream", b"X"),
        ("data:;base64,WA==", "", b"X"),
    ],
)
def test_split_data_url_decodes_inline_bytes_and_normalizes_its_media_type(
    url: str, mime: str, artwork: bytes
) -> None:
    assert imagegen._split_data_url(url) == (mime, artwork)


@pytest.mark.parametrize(
    ("url", "message"),
    [
        ("https://images.example/picture.png", "link rather than the picture"),
        ("DATA:image/png;base64,WA==", "link rather than the picture"),
        ("data:image/png;base64", "malformed image"),
        ("data:image/png,WA==", "form this room cannot read"),
        ("data:image/png;base64,", "empty image"),
        ("data:image/png;base64,not base64", "could not be decoded"),
    ],
)
def test_split_data_url_refuses_malformed_or_noninline_inputs(url: str, message: str) -> None:
    with pytest.raises(imagegen.ImageGenError, match=message):
        imagegen._split_data_url(url)


@pytest.mark.parametrize("url", [None, b"data:image/png;base64,WA=="])
def test_split_data_url_requires_a_text_url(url: object) -> None:
    with pytest.raises((AttributeError, TypeError)):
        imagegen._split_data_url(url)  # type: ignore[arg-type]
