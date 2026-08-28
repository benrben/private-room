"""The video seam: submit, poll, download — and a picture sent INLINE.

Video is the one generation that cannot be a single request. The provider
accepts a job and hands back an id; the clip arrives minutes later from a
different endpoint. Everything here exists because the original implementation
asked ``/chat/completions`` for a video and could never have worked.

The inline-picture assertions are the ones with real stakes. OpenRouter's own
examples always pass a frame as an HTTP URL, and Arcelle's pictures live inside
an encrypted room file — publishing them to a URL is the one thing this app
exists not to do. Verified live against ``x-ai/grok-imagine-video`` on
2026-08-08: a base64 data URL is accepted, and the returned clip's first frame
was the picture sent, pixel for pixel.
"""

from __future__ import annotations

import base64
from types import SimpleNamespace

import httpx
import pytest

from arcelle_sidecar import videogen

#: The wire shape Rust actually sends (`privacy.policy_from_payload`).
DOOR_ON = {
    "active": True,
    "rules": [{"real": "Dana", "placeholder": "[Person A]"}],
}

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
PNG_B64 = base64.b64encode(PNG).decode("ascii")


def config(**over):
    base = dict(
        id="openrouter",
        api_key="test-secret",
        base_url="https://openrouter.test/api/v1",
        model="vendor/filmer",
        context_window=None,
        supports_tools=True,
    )
    base.update(over)
    return SimpleNamespace(**base)


def mock_client(monkeypatch, handler):
    real = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        videogen.httpx,
        "AsyncClient",
        lambda **kwargs: real(transport=transport, **kwargs),
    )


@pytest.mark.asyncio
async def test_a_submission_goes_to_the_videos_endpoint_and_returns_an_id(monkeypatch) -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["method"] = request.method
        seen["body"] = httpx.Response(200, content=request.content).json()
        return httpx.Response(202, json={"id": "vid_123", "status": "pending"})

    mock_client(monkeypatch, handler)
    out = await videogen.submit(
        prompt="the boat leaves the harbour",
        model="openrouter::vendor/filmer",
        provider=config(),
        seconds=6,
        resolution="720p",
    )

    # NOT /chat/completions. A chat request cannot hold open for a clip.
    assert seen["url"] == "https://openrouter.test/api/v1/videos"
    assert seen["method"] == "POST"
    assert seen["body"]["model"] == "vendor/filmer"
    assert seen["body"]["duration"] == 6
    assert seen["body"]["resolution"] == "720p"
    # 202 Accepted is the success case here, not an oddity to be tolerated.
    assert out["video_id"] == "vid_123"


@pytest.mark.asyncio
async def test_a_room_picture_rides_inline_as_the_first_frame(monkeypatch) -> None:
    """The assertion the whole feature rests on.

    An HTTP URL would mean publishing a private picture to reach a model.
    """
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = httpx.Response(200, content=request.content).json()
        return httpx.Response(202, json={"id": "vid_123"})

    mock_client(monkeypatch, handler)
    await videogen.submit(
        prompt="she turns to the sea",
        model="openrouter::vendor/filmer",
        provider=config(),
        frames=[{"b64": PNG_B64, "mime": "image/png", "frame_type": "first_frame"}],
        references=[{"b64": PNG_B64, "mime": "image/jpeg"}],
        references_ack=True,
    )

    frame = seen["body"]["frame_images"][0]
    assert frame["type"] == "image_url"
    assert frame["frame_type"] == "first_frame"
    assert frame["image_url"]["url"] == f"data:image/png;base64,{PNG_B64}"
    assert "http" not in frame["image_url"]["url"][:10]

    # A reference is a different slot: it guides the look, it is not a frame.
    reference = seen["body"]["input_references"][0]
    assert "frame_type" not in reference
    assert reference["image_url"]["url"].startswith("data:image/jpeg;base64,")


@pytest.mark.asyncio
async def test_an_unknown_frame_slot_is_refused_before_it_is_billed() -> None:
    with pytest.raises(videogen.VideoGenError) as caught:
        await videogen.submit(
            prompt="a pan",
            model="openrouter::vendor/filmer",
            provider=config(),
            frames=[{"b64": PNG_B64, "mime": "image/png", "frame_type": "middle_frame"}],
            references_ack=True,
        )
    assert "middle_frame" in str(caught.value)


@pytest.mark.asyncio
async def test_a_non_picture_cannot_be_a_frame() -> None:
    """A PDF handed over as a frame is ignored by the model, not refused.

    So it has to be refused here, or the user pays for a clip of something
    else and reads it as the model disobeying them.
    """
    with pytest.raises(videogen.VideoGenError) as caught:
        await videogen.submit(
            prompt="a pan",
            model="openrouter::vendor/filmer",
            provider=config(),
            frames=[{"b64": PNG_B64, "mime": "application/pdf", "frame_type": "first_frame"}],
            references_ack=True,
        )
    assert "not a picture" in str(caught.value)


@pytest.mark.asyncio
async def test_a_clip_may_be_made_from_a_picture_with_no_words(monkeypatch) -> None:
    """The API marks `prompt` optional for models that animate a still alone."""
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = httpx.Response(200, content=request.content).json()
        return httpx.Response(202, json={"id": "vid_123"})

    mock_client(monkeypatch, handler)
    await videogen.submit(
        prompt="",
        model="openrouter::vendor/filmer",
        provider=config(),
        frames=[{"b64": PNG_B64, "mime": "image/png", "frame_type": "first_frame"}],
        references_ack=True,
    )
    assert "prompt" not in seen["body"], "an empty prompt is omitted, not sent blank"
    assert seen["body"]["frame_images"]


@pytest.mark.asyncio
async def test_neither_words_nor_a_picture_never_spends_a_call() -> None:
    with pytest.raises(videogen.VideoGenError) as caught:
        await videogen.submit(
            prompt="   ",
            model="openrouter::vendor/filmer",
            provider=config(),
        )
    assert "nothing to film" in str(caught.value)


@pytest.mark.asyncio
async def test_the_door_refuses_a_picture_until_it_is_acknowledged() -> None:
    with pytest.raises(videogen.VideoGenError) as caught:
        await videogen.submit(
            prompt="she turns to the sea",
            model="openrouter::vendor/filmer",
            provider=config(),
            privacy=DOOR_ON,
            frames=[{"b64": PNG_B64, "mime": "image/png", "frame_type": "first_frame"}],
        )
    message = str(caught.value)
    assert "privacy door" in message
    # It says HOW MANY pictures, because consent that does not name what is
    # being sent is not consent.
    assert "the 1 you attached" in message


@pytest.mark.asyncio
async def test_an_acknowledged_picture_goes_but_the_prompt_is_still_redacted(monkeypatch) -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = httpx.Response(200, content=request.content).json()
        return httpx.Response(202, json={"id": "vid_123"})

    mock_client(monkeypatch, handler)
    out = await videogen.submit(
        prompt="Dana turns to the sea",
        model="openrouter::vendor/filmer",
        provider=config(),
        privacy=DOOR_ON,
        frames=[{"b64": PNG_B64, "mime": "image/png", "frame_type": "first_frame"}],
        references_ack=True,
    )
    assert seen["body"]["frame_images"]
    assert "Dana" not in seen["body"]["prompt"]
    assert out["privacy"]["replacements"] >= 1


@pytest.mark.asyncio
async def test_status_separates_still_working_from_over(monkeypatch) -> None:
    # Patched ONCE and the answer varied per call: re-patching inside the loop
    # would wrap the already-patched factory and pass `transport` twice.
    current = {"status": "pending"}
    mock_client(monkeypatch, lambda request: httpx.Response(200, json=dict(current)))

    for raw, expect_done, expect_failed in [
        ("pending", False, False),
        ("in_progress", False, False),
        ("completed", True, False),
        ("failed", False, True),
        ("expired", False, True),
        ("cancelled", False, True),
    ]:
        current["status"] = raw
        state = await videogen.status(
            model="openrouter::vendor/filmer", video_id="vid_123", provider=config()
        )
        assert state["done"] is expect_done, raw
        assert state["failed"] is expect_failed, raw


@pytest.mark.asyncio
async def test_an_unrecognized_status_keeps_waiting_rather_than_guessing(monkeypatch) -> None:
    """Calling it done loses a paid clip; calling it failed abandons a live one."""
    mock_client(monkeypatch, lambda request: httpx.Response(200, json={"status": "warming_up"}))
    state = await videogen.status(
        model="openrouter::vendor/filmer", video_id="vid_123", provider=config()
    )
    assert state["pending"] is True
    assert state["done"] is False
    assert state["failed"] is False


@pytest.mark.asyncio
async def test_a_failure_carries_the_providers_own_words(monkeypatch) -> None:
    mock_client(
        monkeypatch,
        lambda request: httpx.Response(
            200,
            json={"status": "failed", "error": {"message": "Content policy refused this."}},
        ),
    )
    state = await videogen.status(
        model="openrouter::vendor/filmer", video_id="vid_123", provider=config()
    )
    assert state["failed"] is True
    assert state["error"] == "Content policy refused this."


@pytest.mark.asyncio
async def test_the_finished_clip_downloads_as_bytes(monkeypatch) -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, content=b"\x00\x00\x00 ftypmp42", headers={"content-type": "video/mp4"})

    mock_client(monkeypatch, handler)
    out = await videogen.fetch(
        model="openrouter::vendor/filmer", video_id="vid_123", provider=config()
    )
    assert seen["url"] == "https://openrouter.test/api/v1/videos/vid_123/content?index=0"
    assert base64.b64decode(out["artwork_b64"]).startswith(b"\x00\x00\x00 ftyp")
    assert out["mime"] == "video/mp4"
    assert out["ext"] == "mp4"


@pytest.mark.asyncio
async def test_a_mislabelled_transfer_is_saved_rather_than_thrown_away(monkeypatch) -> None:
    """The clip is already paid for. A wrong Content-Type must not cost it."""
    mock_client(
        monkeypatch,
        lambda request: httpx.Response(
            200, content=b"mp4 bytes", headers={"content-type": "application/octet-stream"}
        ),
    )
    out = await videogen.fetch(
        model="openrouter::vendor/filmer", video_id="vid_123", provider=config()
    )
    assert out["ext"] == "mp4"


@pytest.mark.asyncio
async def test_an_empty_download_is_an_error_not_an_empty_file(monkeypatch) -> None:
    mock_client(monkeypatch, lambda request: httpx.Response(200, content=b""))
    with pytest.raises(videogen.VideoGenError) as caught:
        await videogen.fetch(
            model="openrouter::vendor/filmer", video_id="vid_123", provider=config()
        )
    assert "empty" in str(caught.value)


@pytest.mark.asyncio
async def test_a_submission_that_names_no_id_is_refused(monkeypatch) -> None:
    """Without an id there is nothing to poll — silence here would hang."""
    mock_client(monkeypatch, lambda request: httpx.Response(202, json={"status": "pending"}))
    with pytest.raises(videogen.VideoGenError) as caught:
        await videogen.submit(
            prompt="a pan",
            model="openrouter::vendor/filmer",
            provider=config(),
        )
    assert "named no id" in str(caught.value)


@pytest.mark.asyncio
async def test_the_provider_error_is_repeated_in_its_own_words(monkeypatch) -> None:
    mock_client(
        monkeypatch,
        lambda request: httpx.Response(402, json={"error": {"message": "Insufficient credits."}}),
    )
    with pytest.raises(videogen.VideoGenError) as caught:
        await videogen.submit(
            prompt="a pan",
            model="openrouter::vendor/filmer",
            provider=config(),
        )
    assert str(caught.value) == "Insufficient credits."


def test_a_local_model_is_left_entirely_alone() -> None:
    sent, report = videogen.guard(
        "Dana turns to the sea",
        "qwen3.5:4b",
        DOOR_ON,
        picture_count=1,
        acknowledged=False,
    )
    assert sent == "Dana turns to the sea"
    assert report is None
