"""Picture and video generation (the Create page's engine).

The one seam in the app where a model hands back PIXELS rather than words.
Everything else that talks to a provider is a conversation; this is a single
terminal act that produces a file, so it does not ride the chat path at all —
:mod:`.provider_api`'s ``generate`` is typed ``-> str`` and its list-content
branch keeps only ``type == "text"`` blocks, which would drop a generated
image on the floor.

Transport is the dedicated ``POST {base_url}/images``, which answers with raw
base64 on ``data[].b64_json``.

IT USED TO BE ``/chat/completions`` WITH ``modalities: ["image", "text"]``,
and that was a real bug, not a style preference: **31 of the 42 image models
in the live catalogue declare ``output_modalities: ["image"]`` and nothing
else**, so asking them for text alongside the picture was refused outright —
*"No endpoints found that support the requested output modalities: image,
text"*. Three quarters of the shelf could never produce anything, and the
failure named modalities rather than the model, so it read as the room being
broken. Verified live 2026-08-08 against ``flux.2-klein-4b``.

The dedicated endpoint has no modality negotiation to get wrong, and it is
also the only one that documents reference pictures — ``input_references``,
*"as base64 data URLs or HTTP(S) URLs"*. That sentence is what makes a room's
own pictures usable at all: the alternative is publishing them to a URL, which
is the one thing this app exists not to do.

PRIVACY. Two distinct rules, and they differ on purpose:

  * The PROMPT is room content leaving the Mac, so it goes through the same
    mechanical redactor every other outbound seam uses. A prompt naming a
    person by name should not carry that name to a provider.

  * A REFERENCE image is refused, never stripped. ``guard_outbound`` counts
    images and lets the call proceed, which is right when text still gets an
    answer — here it is not. Generation from a stripped reference returns a
    picture of something else entirely, and the user reads that as the model
    ignoring their photo rather than as their own privacy setting. This is
    the same failure shape :func:`vision.locate` refuses for the same reason;
    see the comment there.

Nothing is retried. A generation is billed per call, so a silent second
attempt spends the user's money twice.
"""

from __future__ import annotations

import base64
import binascii
from typing import Any

import httpx

#: What one reference picture may weigh, imported rather than restated: the two
#: Create tabs send the same room pictures to the same providers, and a second
#: copy of this number is a second answer to one question.
from .videogen import MAX_REFERENCE_BYTES

#: How long one generation may take. Video models are minutes, not seconds,
#: and the Rust side already runs this inside a cancellable background job —
#: so the ceiling here only has to stop a wedged socket, not pace the user.
GENERATE_TIMEOUT_SECS = 600.0

# THERE IS DELIBERATELY NO PROMPT LENGTH LIMIT HERE.
#
# There used to be a 4,000-character cap, meant to pre-empt an opaque
# provider 400. It refused real work instead: a story shot's opening frame
# carries the scene, the cast with their looks, the action and the light,
# and runs long as a matter of course. The provider publishes its own
# limits and enforces them in its own words; a refusal from the model that
# made the rule is a better error than a refusal from a constant in this
# file. (videogen.py reached the same conclusion first.)

#: What a generated file may weigh, decoded. A provider that streams back
#: something enormous is a bug (or a bill), not a picture worth keeping.
MAX_ARTWORK_BYTES = 64 * 1024 * 1024

#: Data-URL prefixes we know how to turn into a room file, mapped to the
#: extension the file should carry. A format outside this set is refused by
#: name rather than saved as bytes nothing can open.
KNOWN_MIMES: dict[str, str] = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
}


class ImageGenError(RuntimeError):
    """Generation failed — refused, unreachable, or nothing usable came back."""


def _endpoint(base_url: str) -> str:
    return f"{base_url.rstrip('/')}/images"


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "Arcelle",
    }


def _model_slug(model: str, configured: str) -> str:
    """``"openrouter::vendor/slug"`` -> ``"vendor/slug"``.

    Mirrors :func:`provider_api._model_slug`: the composite string is Arcelle's
    own addressing, and the provider only knows the bare half.
    """
    _, separator, selected = model.partition(":" * 2)
    return selected.strip() if separator and selected.strip() else configured


def _decode_artwork(payload: str) -> bytes:
    """Base64 from a provider -> bytes, with this room's own limits applied."""
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImageGenError("the model returned an image that could not be decoded") from exc
    if not raw:
        raise ImageGenError("the model returned an empty image")
    if len(raw) > MAX_ARTWORK_BYTES:
        raise ImageGenError(
            f"the model returned {len(raw) // (1024 * 1024)} MB, over this room's "
            f"{MAX_ARTWORK_BYTES // (1024 * 1024)} MB limit for one generated file"
        )
    return raw


def _split_data_url(url: str) -> tuple[str, bytes]:
    """``data:image/png;base64,AAA`` -> ``("image/png", b"\\x00\\x00")``."""
    if not url.startswith("data:"):
        raise ImageGenError(
            "the model answered with a link rather than the picture itself, "
            "which this room does not follow"
        )
    header, separator, payload = url[len("data:") :].partition(",")
    if not separator:
        raise ImageGenError("the model returned a malformed image")
    mime = header.split(";", 1)[0].strip().lower()
    if not header.lower().endswith("base64") and ";base64" not in header.lower():
        raise ImageGenError(f"the model returned {mime or 'data'} in a form this room cannot read")
    return mime, _decode_artwork(payload)


def _first_artwork(data: dict[str, Any], model: str) -> tuple[str, bytes]:
    """The first picture off an ``/images`` reply, whichever way it is carried.

    ``b64_json`` is the documented shape and is RAW base64 — not a data URL,
    which is the easy mistake: decoding it as one strips the first bytes of a
    real PNG and saves a file nothing can open. ``url`` is read too, but only
    when it is inline; a link to somewhere else is not followed, because
    fetching one would be an outbound request the privacy door never saw.
    """
    entries = data.get("data")
    if not isinstance(entries, list) or not entries:
        raise ImageGenError(
            f"{model} returned no picture. Pick a model the catalog lists as "
            "making images."
        )
    entry = entries[0] if isinstance(entries[0], dict) else {}

    b64 = entry.get("b64_json")
    if isinstance(b64, str) and b64.strip():
        mime = str(entry.get("media_type") or "image/png").split(";", 1)[0].strip().lower()
        return mime or "image/png", _decode_artwork(b64.strip())

    url = entry.get("url")
    if isinstance(url, str) and url.strip():
        return _split_data_url(url.strip())

    raise ImageGenError(f"{model} answered, but with nothing this room could save")


def _reference_url(b64: str, mime: str) -> str:
    """One attached picture as the inline data URL a provider accepts.

    The type is carried rather than assumed. Every reference used to be
    announced as ``image/png`` whatever it actually was, which is a lie a
    provider is entitled to act on — a JPEG labelled PNG can be refused, or
    worse, decoded as garbage and quietly turned into a picture of nothing.

    The weight is measured here for the same reason :func:`videogen._data_url`
    measures it: the same room picture that the Video tab refuses instantly,
    naming the limit, was uploaded whole from this tab and came back as
    whatever opaque error the provider chose, after the wait.
    """
    payload = (b64 or "").strip()
    if not payload:
        raise ImageGenError("a reference picture was empty")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImageGenError("a reference picture could not be read") from exc
    if len(raw) > MAX_REFERENCE_BYTES:
        raise ImageGenError(
            f"a reference picture is {len(raw) // (1024 * 1024)} MB, over this "
            f"room's {MAX_REFERENCE_BYTES // (1024 * 1024)} MB limit for one "
            "picture sent to a model"
        )
    kind = (mime or "").strip().lower() or "image/png"
    if not kind.startswith("image/"):
        raise ImageGenError(f"{kind} is not a picture, so it cannot guide a drawing")
    return f"data:{kind};base64,{payload}"


def guard_prompt(
    prompt: str,
    model: str,
    privacy: dict[str, Any] | None,
    *,
    has_reference: bool,
    acknowledged: bool = False,
) -> tuple[str, dict[str, int] | None]:
    """Apply the door to one generation, or refuse it.

    Returns ``(prompt_to_send, report)`` — the redacted prompt and what the
    door did, or the original prompt and ``None`` when the door stays shut
    (local model, or policy off/absent).

    Raises :class:`ImageGenError` when a reference image cannot reach the
    model. That is the refuse-don't-strip rule the module docstring explains,
    and it still never strips.

    ``acknowledged`` is the one thing that opens it, and it is not a setting.
    An unconditional refusal made "draw my hero again, the same way" impossible
    in any room with the door on — which is every room by default — so the
    feature could not exist. The host passes this only after showing the user
    the actual pictures and taking a press on a button that said they would be
    sent. Consent naming specific files is a different act from a global
    switch; nothing else may set it. Mirrors :func:`videogen.guard`.
    """
    from . import privacy as privacy_mod

    policy = privacy_mod.policy_from_payload(privacy)
    engaged = (
        policy is not None and policy.active and privacy_mod.is_nonlocal_model(model)
    )
    if not engaged or policy is None:
        return prompt, None

    if has_reference and not acknowledged:
        raise ImageGenError(
            "This room's privacy door does not let pictures leave the Mac, so "
            f"{model} cannot be shown the one you attached. Send it for this "
            "one generation, or draw from words alone."
        )

    return policy.redact_text(prompt), policy.report.as_payload()


async def generate(
    *,
    prompt: str,
    model: str,
    provider: Any,
    privacy: dict[str, Any] | None = None,
    reference_b64: list[str] | None = None,
    reference_mime: list[str] | None = None,
    references_ack: bool = False,
    aspect_ratio: str = "",
    resolution: str = "",
    kind: str = "image",
) -> dict[str, Any]:
    """Ask one model for one picture and hand back the bytes.

    ``provider`` is the per-call :class:`config.ProviderConfig` Rust minted
    from Keychain. The return is ready for the host to write into the room:
    ``{"artwork_b64", "mime", "ext", "text", "privacy"}``.

    ``kind`` is accepted and checked rather than honoured: video does not come
    from here at all (see :mod:`.videogen`), and a caller that asks this seam
    for a clip has made a routing mistake worth naming.
    """
    if kind == "video":
        raise ImageGenError(
            "A clip is not made here. Video is a submit-and-wait API — this is "
            "an internal routing mistake, not something you did."
        )
    text = prompt.strip()
    if not text:
        raise ImageGenError("nothing to draw — the prompt is empty")

    references = [image for image in (reference_b64 or []) if image and image.strip()]
    # Positional, and padded rather than zipped: a caller that sent five
    # pictures and three types meant five pictures, and PNG is what every
    # picture this room generates already is. `zip` would silently drop two.
    mimes = list(reference_mime or [])
    outbound, report = guard_prompt(
        text,
        model,
        privacy,
        has_reference=bool(references),
        acknowledged=references_ack,
    )

    payload: dict[str, Any] = {
        "model": _model_slug(model, provider.model),
        "prompt": outbound,
        "n": 1,
    }
    if references:
        payload["input_references"] = [
            {
                "type": "image_url",
                "image_url": {"url": _reference_url(image, mimes[i] if i < len(mimes) else "")},
            }
            for i, image in enumerate(references)
        ]
    # Sent only when asked for. An omitted parameter is honoured by every
    # provider; a guessed one can be refused, and a refusal here costs the
    # user a round trip to learn something the catalogue already knew.
    if aspect_ratio.strip():
        payload["aspect_ratio"] = aspect_ratio.strip()
    if resolution.strip():
        payload["resolution"] = resolution.strip()

    try:
        async with httpx.AsyncClient(timeout=GENERATE_TIMEOUT_SECS) as client:
            response = await client.post(
                _endpoint(provider.base_url),
                headers=_headers(provider.api_key),
                json=payload,
            )
    except httpx.HTTPError as exc:
        raise ImageGenError(f"could not reach the provider: {exc}") from exc

    if not response.is_success:
        raise ImageGenError(_error_message(response))

    try:
        data = response.json()
    except ValueError as exc:
        raise ImageGenError("the provider returned a reply that was not JSON") from exc

    mime, raw = _first_artwork(data, model)
    ext = KNOWN_MIMES.get(mime)
    if ext is None:
        raise ImageGenError(f"the model returned {mime}, which this room cannot open")

    return {
        "artwork_b64": base64.b64encode(raw).decode("ascii"),
        "mime": mime,
        "ext": ext,
        # The dedicated endpoint returns pixels and nothing else — no model
        # narrates what it drew here. Kept in the shape so the host's file
        # writer stays one code path across both media.
        "text": "",
        "privacy": report,
    }


def _error_message(response: httpx.Response) -> str:
    """The provider's own words when it refuses, not just a status code."""
    try:
        body = response.json()
    except ValueError:
        return f"the provider refused the request ({response.status_code})"
    error = body.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
    elif isinstance(error, str) and error.strip():
        return error.strip()
    return f"the provider refused the request ({response.status_code})"


__all__ = [
    "GENERATE_TIMEOUT_SECS",
    "KNOWN_MIMES",
    "MAX_ARTWORK_BYTES",
    "ImageGenError",
    "generate",
    "guard_prompt",
]
