"""The Create page's picture seam.

Three facts worth pinning:

  1. A generated picture survives the round trip as filable bytes.
  2. The request goes to the DEDICATED ``/images`` endpoint. It used to go to
     ``/chat/completions`` with ``modalities: ["image", "text"]``, and 31 of
     the 42 image models in the live catalogue declare ``["image"]`` and
     nothing else — so three quarters of the shelf was refused outright with
     a message about modalities that read as the room being broken.
  3. The privacy door REFUSES a reference picture rather than quietly
     dropping it, and only an explicit per-generation acknowledgement opens
     it. A stripped reference returns a picture of someone else, which reads
     as the model ignoring you rather than as your own setting.
"""

from __future__ import annotations

import base64
from types import SimpleNamespace

import httpx
import pytest

from arcelle_sidecar import imagegen

#: The wire shape Rust actually sends (`privacy.policy_from_payload`) — rules
#: as {real, placeholder} pairs, not a bare entity list.
DOOR_ON = {
    "active": True,
    "rules": [{"real": "Dana", "placeholder": "[Person A]"}],
}

# A one-pixel PNG — real bytes, so the decode path is genuinely exercised.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
PNG_B64 = base64.b64encode(PNG).decode("ascii")


def config(**over):
    base = dict(
        id="openrouter",
        api_key="test-secret",
        base_url="https://openrouter.test/api/v1",
        model="vendor/painter",
        context_window=None,
        supports_tools=True,
    )
    base.update(over)
    return SimpleNamespace(**base)


def mock_client(monkeypatch, handler):
    real = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        imagegen.httpx,
        "AsyncClient",
        lambda **kwargs: real(transport=transport, **kwargs),
    )


def reply(b64=PNG_B64, *, media_type="image/png", status=200):
    """The `/images` shape: raw base64 on `data[].b64_json`, NOT a data URL."""
    entry = {"b64_json": b64}
    if media_type:
        entry["media_type"] = media_type
    return httpx.Response(status, json={"created": 1, "data": [entry]})


@pytest.mark.asyncio
async def test_a_generated_picture_comes_back_as_filable_bytes(monkeypatch) -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = httpx.Response(200, content=request.content).json()
        return reply()

    mock_client(monkeypatch, handler)
    out = await imagegen.generate(
        prompt="A lighthouse at dusk",
        model="openrouter::vendor/painter",
        provider=config(),
    )

    # THE endpoint assertion. Chat with `modalities` is refused outright by
    # the 31 catalogue models that declare image output and nothing else.
    assert seen["url"] == "https://openrouter.test/api/v1/images"
    assert seen["auth"] == "Bearer test-secret"
    # The composite "openrouter::" prefix is Arcelle's addressing, not the
    # provider's — it must not ride out.
    assert seen["body"]["model"] == "vendor/painter"
    assert seen["body"]["prompt"] == "A lighthouse at dusk"
    assert "modalities" not in seen["body"], "the parameter that broke the shelf"

    assert base64.b64decode(out["artwork_b64"]) == PNG
    assert out["mime"] == "image/png"
    assert out["ext"] == "png"
    assert out["privacy"] is None


@pytest.mark.asyncio
async def test_a_clip_is_never_asked_of_this_seam() -> None:
    """Video is a submit-and-wait API and does not come from here at all.

    Named as a routing mistake rather than a user error, because it is one:
    nothing the user can type reaches this branch.
    """
    with pytest.raises(imagegen.ImageGenError) as caught:
        await imagegen.generate(
            prompt="A harbour pan",
            model="openrouter::runway/aleph-2",
            provider=config(model="runway/aleph-2"),
            kind="video",
        )
    assert "not something you did" in str(caught.value)


@pytest.mark.asyncio
async def test_raw_base64_is_not_mistaken_for_a_data_url(monkeypatch) -> None:
    """`b64_json` is RAW base64. Parsing it as a data URL corrupts the file.

    The failure would be silent and near-invisible: a picture lands in the
    room with the right size and the wrong first bytes, and nothing opens it.
    """
    mock_client(monkeypatch, lambda request: reply())
    out = await imagegen.generate(
        prompt="A lighthouse",
        model="openrouter::vendor/painter",
        provider=config(),
    )
    saved = base64.b64decode(out["artwork_b64"])
    assert saved == PNG
    assert saved[:8] == b"\x89PNG\r\n\x1a\n", "a real PNG header, byte for byte"


@pytest.mark.asyncio
async def test_an_unlabelled_picture_is_saved_as_png(monkeypatch) -> None:
    """`media_type` is optional in the spec — an absent one is not a failure."""
    mock_client(monkeypatch, lambda request: reply(media_type=None))
    out = await imagegen.generate(
        prompt="A lighthouse",
        model="openrouter::vendor/painter",
        provider=config(),
    )
    assert out["mime"] == "image/png"
    assert out["ext"] == "png"


@pytest.mark.asyncio
async def test_a_reference_carries_its_own_type_not_a_guess(monkeypatch) -> None:
    """A JPEG announced as PNG can be refused, or decoded into nothing."""
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = httpx.Response(200, content=request.content).json()
        return reply()

    mock_client(monkeypatch, handler)
    await imagegen.generate(
        prompt="the same hero, on a cliff",
        model="openrouter::vendor/painter",
        provider=config(),
        reference_b64=[PNG_B64, PNG_B64],
        reference_mime=["image/jpeg"],
        references_ack=True,
    )
    urls = [r["image_url"]["url"] for r in seen["body"]["input_references"]]
    assert urls[0].startswith("data:image/jpeg;base64,")
    # Padded, never zipped: two pictures and one type is still two pictures.
    assert len(urls) == 2
    assert urls[1].startswith("data:image/png;base64,")


@pytest.mark.asyncio
async def test_a_text_model_says_so_rather_than_returning_nothing(monkeypatch) -> None:
    mock_client(
        monkeypatch,
        lambda request: httpx.Response(200, json={"created": 1, "data": []}),
    )
    with pytest.raises(imagegen.ImageGenError) as caught:
        await imagegen.generate(
            prompt="A lighthouse",
            model="openrouter::vendor/talker",
            provider=config(model="vendor/talker"),
        )
    # Naming the real cause: the wrong model was picked, not "no image".
    assert "no picture" in str(caught.value)
    assert "catalog" in str(caught.value)


@pytest.mark.asyncio
async def test_the_door_refuses_a_reference_instead_of_stripping_it() -> None:
    """The whole point. `guard_outbound` would count-and-proceed here."""
    with pytest.raises(imagegen.ImageGenError) as caught:
        await imagegen.generate(
            prompt="Make her smile",
            model="openrouter::vendor/painter",
            provider=config(),
            privacy=DOOR_ON,
            reference_b64=[PNG_B64],
        )
    message = str(caught.value)
    assert "privacy door" in message
    assert "one generation" in message


@pytest.mark.asyncio
async def test_only_an_explicit_acknowledgement_opens_the_door(monkeypatch) -> None:
    """Not a setting — a press, on a button that showed the actual pictures.

    Without this the door can never open for a reference, and "draw my hero
    again, the same way" is impossible in every room by default. With it as a
    mere flag on the request it would be no door at all; the rule is that only
    the consent step may set it.
    """
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = httpx.Response(200, content=request.content).json()
        return reply()

    mock_client(monkeypatch, handler)
    out = await imagegen.generate(
        prompt="A portrait of Dana at the harbour",
        model="openrouter::vendor/painter",
        provider=config(),
        privacy=DOOR_ON,
        reference_b64=[PNG_B64],
        references_ack=True,
    )
    # The picture goes. The PROMPT is still redacted — acknowledging a face
    # is not consent to send a name.
    assert len(seen["body"]["input_references"]) == 1
    assert "Dana" not in seen["body"]["prompt"]
    assert "[Person A]" in seen["body"]["prompt"]
    assert out["privacy"]["replacements"] >= 1


def test_the_prompt_itself_is_redacted_on_the_way_out() -> None:
    """A prompt is room content leaving the Mac, so it goes through the door."""
    sent, report = imagegen.guard_prompt(
        "A portrait of Dana at the harbour",
        "openrouter::vendor/painter",
        DOOR_ON,
        has_reference=False,
    )
    assert "Dana" not in sent
    assert "[Person A]" in sent
    assert report is not None and report["replacements"] >= 1


def test_a_local_model_is_left_entirely_alone() -> None:
    sent, report = imagegen.guard_prompt(
        "A portrait of Dana",
        "qwen3.5:4b",
        DOOR_ON,
        has_reference=True,
    )
    assert sent == "A portrait of Dana"
    assert report is None


@pytest.mark.asyncio
async def test_a_link_is_refused_rather_than_fetched(monkeypatch) -> None:
    """Following a returned URL would be a second, unguarded trip off the Mac."""
    mock_client(
        monkeypatch,
        lambda request: httpx.Response(
            200, json={"created": 1, "data": [{"url": "https://cdn.example/art.png"}]}
        ),
    )
    with pytest.raises(imagegen.ImageGenError) as caught:
        await imagegen.generate(
            prompt="A lighthouse",
            model="openrouter::vendor/painter",
            provider=config(),
        )
    assert "link" in str(caught.value)


@pytest.mark.asyncio
async def test_the_provider_error_is_repeated_in_its_own_words(monkeypatch) -> None:
    mock_client(
        monkeypatch,
        lambda request: httpx.Response(
            402, json={"error": {"message": "Insufficient credits."}}
        ),
    )
    with pytest.raises(imagegen.ImageGenError) as caught:
        await imagegen.generate(
            prompt="A lighthouse",
            model="openrouter::vendor/painter",
            provider=config(),
        )
    assert str(caught.value) == "Insufficient credits."


@pytest.mark.asyncio
async def test_an_oversized_result_is_refused_not_filed(monkeypatch) -> None:
    huge = base64.b64encode(b"\x00" * (imagegen.MAX_ARTWORK_BYTES + 1)).decode("ascii")
    mock_client(monkeypatch, lambda request: reply(huge))
    with pytest.raises(imagegen.ImageGenError) as caught:
        await imagegen.generate(
            prompt="A lighthouse",
            model="openrouter::vendor/painter",
            provider=config(),
        )
    assert "limit" in str(caught.value)


@pytest.mark.asyncio
async def test_an_empty_prompt_never_spends_a_call() -> None:
    with pytest.raises(imagegen.ImageGenError) as caught:
        await imagegen.generate(
            prompt="   ",
            model="openrouter::vendor/painter",
            provider=config(),
        )
    assert "empty" in str(caught.value)


@pytest.mark.asyncio
async def test_the_asked_for_shape_and_size_actually_reach_the_provider(monkeypatch) -> None:
    """A control that is silently dropped is worse than one that is absent.

    ``ImageGenerateRequest`` is ``extra="ignore"``, and ``aspect_ratio`` was
    never declared on it — so the host sent the field, Pydantic threw it away,
    and every picture came back in the model's default shape however it had
    been asked for. Nothing anywhere reported a failure, which is exactly what
    makes this class of bug expensive: it is indistinguishable from a model
    that ignores you.
    """
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = httpx.Response(200, content=request.content).json()
        return reply()

    mock_client(monkeypatch, handler)
    await imagegen.generate(
        prompt="a lighthouse at dusk",
        model="openrouter::vendor/painter",
        provider=config(),
        aspect_ratio="16:9",
        resolution="2K",
    )
    assert seen["body"]["aspect_ratio"] == "16:9"
    assert seen["body"]["resolution"] == "2K"


@pytest.mark.asyncio
async def test_a_shape_nobody_asked_for_is_not_invented(monkeypatch) -> None:
    """An omitted parameter is honoured everywhere; a guessed one can be refused."""
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = httpx.Response(200, content=request.content).json()
        return reply()

    mock_client(monkeypatch, handler)
    await imagegen.generate(
        prompt="a lighthouse at dusk",
        model="openrouter::vendor/painter",
        provider=config(),
    )
    assert "aspect_ratio" not in seen["body"]
    assert "resolution" not in seen["body"]


def test_the_request_model_itself_keeps_the_shape_fields() -> None:
    """The bug was one level up from ``generate``: the field did not exist.

    ``extra="ignore"`` means an undeclared field is dropped without a word, so
    the round trip has to be asserted on the MODEL, not only on the function
    that would have used it.
    """
    from arcelle_sidecar.config import ImageGenerateRequest

    req = ImageGenerateRequest.model_validate(
        {
            "model": "openrouter::vendor/painter",
            "prompt": "a lighthouse",
            "aspect_ratio": "16:9",
            "resolution": "2K",
        }
    )
    assert req.aspect_ratio == "16:9"
    assert req.resolution == "2K"


@pytest.mark.asyncio
async def test_a_long_prompt_is_sent_whole_not_refused(monkeypatch) -> None:
    """There is deliberately no prompt length cap on this seam.

    A 4,000-character cap used to live here and refused real work: a story
    shot's opening frame carries the scene, the cast with their looks, the
    action and the light, and 4,440 characters is an ordinary size for it
    (the actual refusal a user hit). The provider enforces its own limits in
    its own words; this seam sends the prompt whole — neither refused nor
    truncated.
    """
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = httpx.Response(200, content=request.content).json()
        return reply()

    mock_client(monkeypatch, handler)
    prompt = ("A shot described, not named. " * 160)[:4440]
    assert len(prompt) == 4440
    await imagegen.generate(
        prompt=prompt,
        model="openrouter::vendor/painter",
        provider=config(),
    )
    assert seen["body"]["prompt"] == prompt


@pytest.mark.asyncio
async def test_an_oversized_reference_is_refused_before_the_upload(monkeypatch) -> None:
    """The same picture the Video tab refuses instantly, naming the limit.

    From this tab it used to be base64'd whole, POSTed, and answered only by
    whatever the provider chose to say about it — after the wait.
    """
    posted: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posted.append(str(request.url))
        return reply()

    mock_client(monkeypatch, handler)
    huge = base64.b64encode(b"\0" * (imagegen.MAX_REFERENCE_BYTES + 1)).decode("ascii")
    with pytest.raises(imagegen.ImageGenError) as caught:
        await imagegen.generate(
            prompt="the same hero, on a cliff",
            model="openrouter::vendor/painter",
            provider=config(),
            reference_b64=[huge],
            references_ack=True,
        )
    limit_mb = imagegen.MAX_REFERENCE_BYTES // (1024 * 1024)
    assert f"{limit_mb} MB limit" in str(caught.value)
    assert not posted, "the oversized picture was uploaded anyway"


def test_a_reference_right_on_the_limit_still_goes() -> None:
    """The ceiling is a ceiling, not a wall one byte lower."""
    at_limit = base64.b64encode(b"\0" * imagegen.MAX_REFERENCE_BYTES).decode("ascii")
    url = imagegen._reference_url(at_limit, "image/png")
    assert url.startswith("data:image/png;base64,")


def test_a_reference_that_is_not_base64_is_named_as_ours() -> None:
    """Better than an opaque 400 from three services away."""
    with pytest.raises(imagegen.ImageGenError) as caught:
        imagegen._reference_url("not base64 at all!!", "image/png")
    assert "could not be read" in str(caught.value)
