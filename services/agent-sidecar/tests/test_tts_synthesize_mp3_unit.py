"""Fake-only unit coverage for Edge TTS MP3 streaming."""

from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from arcelle_sidecar import tts


@pytest.mark.asyncio
async def test_synthesize_mp3_joins_only_audio_messages_from_a_fake_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, str] = {}

    class FakeCommunicate:
        def __init__(self, text: str, voice: str, *, rate: str, pitch: str) -> None:
            seen.update(text=text, voice=voice, rate=rate, pitch=pitch)

        async def stream(self):
            yield {"type": "WordBoundary", "offset": 0}
            yield {"type": "audio", "data": b"fake-mp3-first"}
            yield {"type": "SentenceBoundary", "offset": 12}
            yield {"type": "audio", "data": b"fake-mp3-last"}

    monkeypatch.setitem(sys.modules, "edge_tts", SimpleNamespace(Communicate=FakeCommunicate))

    audio = await tts.synthesize_mp3(
        "fake text", "fake voice", "+9%", "-3Hz"
    )

    assert audio == b"fake-mp3-firstfake-mp3-last"
    assert seen == {
        "text": "fake text",
        "voice": "fake voice",
        "rate": "+9%",
        "pitch": "-3Hz",
    }


@pytest.mark.asyncio
async def test_synthesize_mp3_names_empty_and_failed_fake_service_streams(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class EmptyCommunicate:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def stream(self):
            yield {"type": "metadata", "value": "fake only"}

    monkeypatch.setitem(sys.modules, "edge_tts", SimpleNamespace(Communicate=EmptyCommunicate))
    with pytest.raises(tts.TtsError, match="neural voice returned no audio"):
        await tts.synthesize_mp3("fake text", "fake voice", "+0%", "+0Hz")

    class FailingCommunicate:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def stream(self):
            if False:  # keeps this a fake async generator without yielding audio
                yield {"type": "audio", "data": b"unreachable"}
            raise RuntimeError("fake TTS service unavailable")

    monkeypatch.setitem(sys.modules, "edge_tts", SimpleNamespace(Communicate=FailingCommunicate))
    with pytest.raises(tts.TtsError, match="neural voice unavailable: fake TTS service unavailable") as caught:
        await tts.synthesize_mp3("fake text", "fake voice", "+0%", "+0Hz")
    assert isinstance(caught.value.__cause__, RuntimeError)
