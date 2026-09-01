"""Fake-only coverage for the video audio-track extraction boundary."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import pytest

from arcelle_sidecar.media import decode


def test_extract_audio_track_runs_the_fixed_avconvert_command_and_privates_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[list[str], dict[str, object]]] = []
    made_private: list[Path] = []

    def fake_run(command: list[str], **kwargs: object) -> SimpleNamespace:
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stderr=b"")

    monkeypatch.setattr(decode.subprocess, "run", fake_run)
    monkeypatch.setattr(decode, "_make_private", made_private.append)
    source = Path("/fabricated/source.mov")
    output = Path("/fabricated/temp/audio.m4a")

    assert decode._extract_audio_track(source, output) == output
    assert calls == [
        (
            [
                "/usr/bin/avconvert",
                "-p",
                "PresetAppleM4A",
                "-s",
                "/fabricated/source.mov",
                "-o",
                "/fabricated/temp/audio.m4a",
            ],
            {"capture_output": True},
        )
    ]
    assert made_private == [output]


def test_extract_audio_track_reports_a_capped_fake_converter_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    made_private: list[Path] = []
    stderr = b"unreadable audio: \xff" + b"x" * (decode._STDERR_CAP + 20)
    monkeypatch.setattr(
        decode.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=17, stderr=stderr),
    )
    monkeypatch.setattr(decode, "_make_private", made_private.append)

    with pytest.raises(RuntimeError, match="no readable audio track: unreadable audio: .") as error:
        decode._extract_audio_track(Path("/fabricated/source.mov"), Path("/fabricated/audio.m4a"))

    message = str(error.value)
    assert len(message.removeprefix("no readable audio track: ")) == decode._STDERR_CAP
    assert made_private == []


def test_extract_audio_track_wraps_a_fake_start_failure_without_privating_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    made_private: list[Path] = []

    def fake_run(*_args: object, **_kwargs: object) -> SimpleNamespace:
        raise OSError("fabricated avconvert missing")

    monkeypatch.setattr(decode.subprocess, "run", fake_run)
    monkeypatch.setattr(decode, "_make_private", made_private.append)

    with pytest.raises(RuntimeError, match="avconvert failed to start: fabricated avconvert missing"):
        decode._extract_audio_track(Path("/fabricated/source.mov"), Path("/fabricated/audio.m4a"))

    assert made_private == []


def test_video_decode_removes_fake_intermediates_immediately_after_track_decode_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tmp_dir = Path("/fabricated/tmp")
    stamp = UUID("11111111-2222-3333-4444-555555555555")
    m4a_path = tmp_dir / f"pr-stt-{stamp}.m4a"
    wav_path = tmp_dir / f"pr-stt-{stamp}.wav"
    removed: list[Path] = []

    monkeypatch.setattr(decode.tempfile, "gettempdir", lambda: str(tmp_dir))
    monkeypatch.setattr(decode.uuid, "uuid4", lambda: stamp)
    monkeypatch.setattr(
        decode,
        "_extract_audio_track",
        lambda source, intermediate: intermediate,
    )
    monkeypatch.setattr(
        decode,
        "_run_afconvert",
        lambda _source, _output: (_ for _ in ()).throw(RuntimeError("fabricated WAV failure")),
    )
    monkeypatch.setattr(decode, "_remove", removed.append)

    with pytest.raises(RuntimeError, match="fabricated WAV failure"):
        decode.decode_to_pcm("/fabricated/source.mov", decode.MediaKind.VIDEO)

    assert removed == [m4a_path, m4a_path, wav_path]
