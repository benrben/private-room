"""Fake-only coverage for the afconvert boundary in ``mp3_to_wav``."""

from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from arcelle_sidecar import tts


class FakePath:
    """In-memory Path-shaped value sufficient for the decoder boundary."""

    files: dict[str, bytes] = {}

    def __init__(self, value: str) -> None:
        self.value = value

    def __truediv__(self, child: str) -> FakePath:
        return FakePath(f"{self.value}/{child}")

    def __str__(self) -> str:
        return self.value

    def exists(self) -> bool:
        return self.value in self.files

    def read_bytes(self) -> bytes:
        return self.files[self.value]

    def write_bytes(self, value: bytes) -> int:
        self.files[self.value] = value
        return len(value)


class FakeTemporaryDirectory:
    """A context manager that supplies a name without creating a directory."""

    def __init__(self, *, prefix: str) -> None:
        self.prefix = prefix

    def __enter__(self) -> str:
        return "/fake/tts-temp"

    def __exit__(self, *_args: object) -> None:
        return None


@pytest.fixture
def fake_conversion(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    """Replace the process, temp path, and output bytes with deterministic fakes."""
    FakePath.files = {}
    calls: list[tuple[list[str], bool, int]] = []
    outcome = {"returncode": 0, "stderr": b"", "wav": b"fake-wav"}

    def run(command: list[str], *, capture_output: bool, timeout: int) -> SimpleNamespace:
        calls.append((command, capture_output, timeout))
        if outcome["returncode"] == 0 and outcome["wav"] is not None:
            FakePath.files[command[-1]] = outcome["wav"]  # type: ignore[index]
        return SimpleNamespace(
            returncode=outcome["returncode"],
            stderr=outcome["stderr"],
        )

    monkeypatch.setattr(tts, "Path", FakePath)
    monkeypatch.setattr(
        tts.tempfile,
        "TemporaryDirectory",
        lambda *, prefix: FakeTemporaryDirectory(prefix=prefix),
    )
    monkeypatch.setitem(sys.modules, "subprocess", SimpleNamespace(run=run))
    return {"calls": calls, "outcome": outcome}


def test_mp3_to_wav_uses_the_forced_rate_and_returns_fake_decoder_bytes(
    fake_conversion: dict[str, object],
) -> None:
    wav = tts.mp3_to_wav(b"fake-mp3", sample_rate=24_000)

    calls = fake_conversion["calls"]
    assert isinstance(calls, list)
    assert wav == b"fake-wav"
    assert FakePath.files["/fake/tts-temp/in.mp3"] == b"fake-mp3"
    assert calls == [
        (
            [
                tts.AFCONVERT,
                "-f",
                "WAVE",
                "-d",
                "LEI16",
                "-c",
                "1",
                "-r",
                "24000",
                "/fake/tts-temp/in.mp3",
                "/fake/tts-temp/out.wav",
            ],
            True,
            60,
        )
    ]


def test_mp3_to_wav_keeps_the_source_rate_when_one_is_not_requested(
    fake_conversion: dict[str, object],
) -> None:
    assert tts.mp3_to_wav(b"fake-mp3") == b"fake-wav"

    calls = fake_conversion["calls"]
    assert isinstance(calls, list)
    command = calls[0][0]
    assert "-r" not in command
    assert command[-2:] == ["/fake/tts-temp/in.mp3", "/fake/tts-temp/out.wav"]


@pytest.mark.parametrize(
    ("returncode", "wav", "stderr"),
    [
        (9, b"ignored-output", b"fake decoder rejected the input"),
        (0, None, b"fake decoder produced no file"),
    ],
)
def test_mp3_to_wav_surfaces_fake_decoder_failures(
    fake_conversion: dict[str, object],
    returncode: int,
    wav: bytes | None,
    stderr: bytes,
) -> None:
    outcome = fake_conversion["outcome"]
    assert isinstance(outcome, dict)
    outcome.update(returncode=returncode, wav=wav, stderr=stderr)

    with pytest.raises(tts.TtsError, match=stderr.decode()):
        tts.mp3_to_wav(b"fake-mp3")
