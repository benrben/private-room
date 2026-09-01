"""Fake-only coverage for private staged-image cleanup helpers."""

from __future__ import annotations

from arcelle_sidecar import external_llm


def test_close_staging_fd_closes_a_valid_fabricated_descriptor(monkeypatch) -> None:
    closed: list[int] = []
    monkeypatch.setattr(external_llm.os, "close", closed.append)

    external_llm._close_staging_fd(41)  # noqa: SLF001 - private cleanup seam

    assert closed == [41]


def test_close_staging_fd_ignores_the_missing_descriptor_sentinel(monkeypatch) -> None:
    closed: list[int] = []
    monkeypatch.setattr(external_llm.os, "close", closed.append)

    external_llm._close_staging_fd(-1)  # noqa: SLF001 - private cleanup seam

    assert closed == []


def test_close_staging_fd_swallows_a_fabricated_close_error(monkeypatch) -> None:
    def refuse_close(_fd: int) -> None:
        raise OSError("fabricated close failure")

    monkeypatch.setattr(external_llm.os, "close", refuse_close)

    external_llm._close_staging_fd(41)  # noqa: SLF001 - private cleanup seam


def test_unlink_staging_path_unlinks_a_valid_fabricated_path(monkeypatch) -> None:
    unlinked: list[str] = []
    monkeypatch.setattr(external_llm.os, "unlink", unlinked.append)

    external_llm._unlink_staging_path("/fabricated/arcelle-img.png")  # noqa: SLF001 - private cleanup seam

    assert unlinked == ["/fabricated/arcelle-img.png"]


def test_unlink_staging_path_ignores_a_missing_path(monkeypatch) -> None:
    unlinked: list[str] = []
    monkeypatch.setattr(external_llm.os, "unlink", unlinked.append)

    external_llm._unlink_staging_path(None)  # noqa: SLF001 - private cleanup seam

    assert unlinked == []


def test_unlink_staging_path_swallows_a_fabricated_unlink_error(monkeypatch) -> None:
    def refuse_unlink(_path: str) -> None:
        raise OSError("fabricated unlink failure")

    monkeypatch.setattr(external_llm.os, "unlink", refuse_unlink)

    external_llm._unlink_staging_path("/fabricated/arcelle-img.png")  # noqa: SLF001 - private cleanup seam
