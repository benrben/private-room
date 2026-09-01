"""Video generation — the asynchronous seam.

Video does NOT ride ``/chat/completions``. That was the original mistake and it
could never have worked: a clip takes minutes, so the provider will not hold a
chat request open for one. The real shape is three calls:

  1. ``POST {base}/videos``            -> ``{"id": ...}``, accepted, not done
  2. ``GET  {base}/videos/{id}``       -> a status, polled until terminal
  3. ``GET  {base}/videos/{id}/content`` -> the bytes

Each is a separate endpoint here rather than one blocking ``generate()``, and
the reason is money. The host runs generation inside a cancellable job; if the
polling loop lived in this process the user's Stop would have nothing to stop,
the progress bar would sit at zero for four minutes, and a wedged job would
still be billed. Driving the loop from the host means Stop is real, the bar
moves, and the job survives a sidecar restart because the provider's job id is
the only state that matters.

Nothing here retries. A submitted generation is billed whether or not we like
the answer, so a second attempt spends the user's money twice.

REFERENCE PICTURES. Two slots, and they are not interchangeable:

  * ``frame_images`` — the picture IS the first (or last) frame. The model
    animates out of it. This is what "make a video from this picture" means.
  * ``input_references`` — guidance, not a frame: a character, a place, a look.
    This is what keeps the same hero recognizable across shots.

Both carry the picture inline as a base64 data URL. OpenRouter's own spec says
so for images ("as base64 data URLs or HTTP(S) URLs") and leaves the video
field an unconstrained string, while the one field in the same request that
genuinely needs a web address — ``callback_url`` — is explicitly marked
HTTPS-only. That matters enormously for this app: the alternative is putting a
room's pictures on a public URL, which is the one thing Arcelle exists not to
do.
"""

from __future__ import annotations

import base64
import binascii
from typing import Any

import httpx

#: One HTTP call's ceiling. Not the generation's — that is the host's polling
#: loop, which can run for as long as the provider takes.
CALL_TIMEOUT_SECS = 120.0

#: Downloading the finished clip is the one long transfer here.
FETCH_TIMEOUT_SECS = 600.0

#: What a finished clip may weigh. A provider streaming back something enormous
#: is a bug (or a bill), not a video worth keeping.
MAX_CLIP_BYTES = 512 * 1024 * 1024

# THERE IS DELIBERATELY NO PROMPT LENGTH LIMIT HERE.
#
# The image seam caps a prompt at 4,000 characters, and copying that across
# would be the obvious thing to do and the wrong one. A shot is described, not
# named: a scene carrying a logline, several characters with their looks, the
# action, the camera move and the lighting runs long as a matter of course, and
# a cap set by us would truncate the description of a clip the user is paying
# for. The provider publishes its own limits and enforces them in its own
# words; a refusal from the model that made the rule is a better error than a
# refusal from a constant in this file.

#: What ONE reference picture may weigh, decoded, before it is sent. Providers
#: reject oversized inputs with an opaque 400 after the upload has already
#: cost the user time; saying so first costs nothing.
MAX_REFERENCE_BYTES = 20 * 1024 * 1024

#: Statuses the provider can report. Split by what the host should do next
#: rather than kept as one list, because "still working" and "over" are the
#: only two answers the polling loop actually needs.
PENDING_STATUSES = frozenset({"pending", "queued", "in_progress", "processing", "running"})
DONE_STATUSES = frozenset({"completed", "succeeded", "success"})
DEAD_STATUSES = frozenset({"failed", "cancelled", "canceled", "expired", "rejected"})

#: Container types a clip may come back as, mapped to the extension the room
#: file should carry.
CLIP_MIMES: dict[str, str] = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
}

#: Which frame slots exist. A model that supports neither is refused before it
#: is billed, by the host's capability check.
FRAME_TYPES = frozenset({"first_frame", "last_frame"})


class VideoGenError(RuntimeError):
    """A video generation failed — refused, unreachable, or came back empty."""


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "Arcelle",
    }


def _model_slug(model: str, configured: str) -> str:
    """``"openrouter::vendor/slug"`` -> ``"vendor/slug"``.

    Mirrors :func:`imagegen._model_slug`; the composite string is Arcelle's own
    addressing and the provider only knows the bare half.
    """
    _, separator, selected = model.partition(":" * 2)
    return selected.strip() if separator and selected.strip() else configured


def _data_url(b64: str, mime: str) -> str:
    """One reference picture as the inline URL the provider accepts.

    Validated here rather than trusted: a malformed payload should be named as
    ours before it becomes an opaque 400 from three services away.
    """
    payload = _reference_payload(b64)
    raw = _decoded_reference_payload(payload)
    _validate_reference_size(raw)
    kind = _picture_mime(mime)
    return f"data:{kind};base64,{payload}"


def _reference_payload(b64: str) -> str:
    payload = (b64 or "").strip()
    if not payload:
        raise VideoGenError("a reference picture was empty")
    return payload


def _decoded_reference_payload(payload: str) -> bytes:
    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise VideoGenError("a reference picture could not be read") from exc


def _validate_reference_size(raw: bytes) -> None:
    if len(raw) > MAX_REFERENCE_BYTES:
        raise VideoGenError(
            f"a reference picture is {len(raw) // (1024 * 1024)} MB, over this "
            f"room's {MAX_REFERENCE_BYTES // (1024 * 1024)} MB limit for one "
            "picture sent to a model"
        )


def _picture_mime(mime: str) -> str:
    kind = (mime or "image/png").strip().lower()
    if not kind.startswith("image/"):
        raise VideoGenError(f"{kind} is not a picture, so it cannot be a frame")
    return kind


def frame_parts(frames: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Build the ``frame_images`` array: which picture is which end of the clip."""
    parts: list[dict[str, Any]] = []
    for frame in frames or []:
        parts.append(_frame_part(frame))
    return parts


def _frame_part(frame: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "image_url",
        "frame_type": _frame_slot(frame),
        "image_url": {"url": _data_url(str(frame.get("b64") or ""), str(frame.get("mime") or ""))},
    }


def _frame_slot(frame: dict[str, Any]) -> str:
    slot = str(frame.get("frame_type") or "first_frame").strip().lower()
    if slot not in FRAME_TYPES:
        raise VideoGenError(f"{slot} is not a frame this room knows how to send")
    return slot


def reference_parts(references: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Build ``input_references``: who and what the clip should look like."""
    return [
        {
            "type": "image_url",
            "image_url": {"url": _data_url(str(ref.get("b64") or ""), str(ref.get("mime") or ""))},
        }
        for ref in references or []
    ]


def guard(
    prompt: str,
    model: str,
    privacy: dict[str, Any] | None,
    *,
    picture_count: int,
    acknowledged: bool,
) -> tuple[str, dict[str, int] | None]:
    """Apply the privacy door to one submission, or refuse it.

    Same two rules :mod:`.imagegen` documents — the prompt is redacted, a
    picture is refused rather than stripped — with one addition that makes the
    feature possible at all: an EXPLICIT acknowledgement.

    A stripped reference is the failure worth designing around: the clip comes
    back showing someone else, and the user reads that as the model ignoring
    them rather than as their own setting. So the door still never strips. But
    refusing unconditionally means "make a video of my hero" can never work in
    a room with the door on, and the door is on by default — so the host may
    pass ``acknowledged`` when, and only when, the user was shown the actual
    pictures and pressed a button that said they would be sent. Consent that
    names the specific files is a different thing from a global setting, and
    it is the only thing allowed to open this.
    """
    from . import privacy as privacy_mod

    policy = privacy_mod.policy_from_payload(privacy)
    if not _privacy_policy_is_engaged(policy, model, privacy_mod):
        return prompt, None

    if _has_unacknowledged_pictures(picture_count, acknowledged):
        raise VideoGenError(
            "This room's privacy door does not let pictures leave the Mac, so "
            f"{model} cannot be shown the {picture_count} you attached. Send "
            "them for this one generation, or make the clip from words alone."
        )

    return policy.redact_text(prompt), policy.report.as_payload()


def _privacy_policy_is_engaged(policy: Any, model: str, privacy_mod: Any) -> bool:
    return policy is not None and policy.active and privacy_mod.is_nonlocal_model(model)


def _has_unacknowledged_pictures(picture_count: int, acknowledged: bool) -> bool:
    return bool(picture_count and not acknowledged)


async def submit(
    *,
    prompt: str,
    model: str,
    provider: Any,
    privacy: dict[str, Any] | None = None,
    seconds: int | None = None,
    resolution: str = "",
    aspect_ratio: str = "",
    frames: list[dict[str, Any]] | None = None,
    references: list[dict[str, Any]] | None = None,
    references_ack: bool = False,
    generate_audio: bool | None = None,
) -> dict[str, Any]:
    """Hand the provider one job and get back its id. Does not wait.

    A prompt is optional here, unlike an image: several models generate a clip
    from a starting picture alone, and the spec says so. But something must be
    asked for — a submission with neither words nor a picture is refused before
    it is billed.
    """
    text, frame_list, reference_list = _submission_parts(prompt, frames, references)
    outbound, report = guard(
        text,
        model,
        privacy,
        picture_count=len(frame_list) + len(reference_list),
        acknowledged=bool(references_ack),
    )
    payload = _submission_payload(
        model,
        provider.model,
        outbound,
        seconds,
        resolution,
        aspect_ratio,
        frame_list,
        reference_list,
        generate_audio,
    )
    data = await _call(provider, "POST", "/videos", json=payload)
    return _submission_result(data, report)


def _submission_parts(
    prompt: str,
    frames: list[dict[str, Any]] | None,
    references: list[dict[str, Any]] | None,
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    text = (prompt or "").strip()
    frame_list = frame_parts(frames)
    reference_list = reference_parts(references)
    if not text and not frame_list and not reference_list:
        raise VideoGenError("nothing to film — say what happens, or attach a picture")
    return text, frame_list, reference_list


def _submission_payload(
    model: str,
    configured_model: str,
    prompt: str,
    seconds: int | None,
    resolution: str,
    aspect_ratio: str,
    frames: list[dict[str, Any]],
    references: list[dict[str, Any]],
    generate_audio: bool | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"model": _model_slug(model, configured_model)}
    _add_submission_text(payload, prompt, resolution, aspect_ratio)
    _add_submission_options(payload, seconds, generate_audio)
    _add_submission_pictures(payload, frames, references)
    return payload


def _add_submission_text(
    payload: dict[str, Any], prompt: str, resolution: str, aspect_ratio: str
) -> None:
    if prompt:
        payload["prompt"] = prompt
    _add_stripped_payload_value(payload, "resolution", resolution)
    _add_stripped_payload_value(payload, "aspect_ratio", aspect_ratio)


def _add_stripped_payload_value(payload: dict[str, Any], key: str, value: str) -> None:
    stripped = value.strip()
    if stripped:
        payload[key] = stripped


def _add_submission_options(
    payload: dict[str, Any], seconds: int | None, generate_audio: bool | None
) -> None:
    if seconds:
        payload["duration"] = int(seconds)
    if generate_audio is not None:
        payload["generate_audio"] = bool(generate_audio)


def _add_submission_pictures(
    payload: dict[str, Any], frames: list[dict[str, Any]], references: list[dict[str, Any]]
) -> None:
    if frames:
        payload["frame_images"] = frames
    if references:
        payload["input_references"] = references


def _submission_id(data: dict[str, Any]) -> str:
    video_id = data.get("id") or data.get("job_id")
    if not isinstance(video_id, str) or not video_id.strip():
        raise VideoGenError("the provider accepted the job but named no id for it")
    return video_id.strip()


def _submission_result(
    data: dict[str, Any], report: dict[str, int] | None
) -> dict[str, Any]:
    return {"video_id": _submission_id(data), "privacy": report}


async def status(*, model: str, video_id: str, provider: Any) -> dict[str, Any]:
    """Where one submitted job has got to.

    An unrecognized status is reported as still-working rather than guessed
    either way: calling it done loses a clip the user paid for, and calling it
    failed abandons one that is still coming. The host's own ceiling ends a job
    that never resolves.
    """
    _ = model  # present so the host's provider/privacy injection has a model to key on
    data = await _call(provider, "GET", f"/videos/{video_id}")
    return _status_result(data)


def _status_result(data: dict[str, Any]) -> dict[str, Any]:
    raw = _status_value(data)
    return {
        "status": raw or "pending",
        "done": raw in DONE_STATUSES,
        "failed": raw in DEAD_STATUSES,
        "pending": raw not in DONE_STATUSES and raw not in DEAD_STATUSES,
        "error": _optional_error_message(data.get("error")),
        "progress": _optional_progress(data.get("progress")),
    }


def _status_value(data: dict[str, Any]) -> str:
    return str(data.get("status") or "").strip().lower()


def _optional_error_message(error: Any) -> str | None:
    if isinstance(error, dict):
        error = error.get("message")
    return _optional_text(error)


def _optional_progress(progress: Any) -> int | None:
    return int(progress) if isinstance(progress, (int, float)) else None


def _optional_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


async def fetch(*, model: str, video_id: str, provider: Any, index: int = 0) -> dict[str, Any]:
    """Download a finished clip as bytes the host can file."""
    _ = model
    response = await _download_clip_response(provider, video_id, index)
    _require_successful_clip_response(response)
    raw = _clip_bytes(response)
    mime, ext = _clip_format(response)
    return {"artwork_b64": base64.b64encode(raw).decode("ascii"), "mime": mime, "ext": ext}


async def _download_clip_response(provider: Any, video_id: str, index: int) -> httpx.Response:
    url = f"{provider.base_url.rstrip('/')}/videos/{video_id}/content?index={int(index)}"
    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SECS, follow_redirects=True) as client:
            return await client.get(url, headers=_headers(provider.api_key))
    except httpx.HTTPError as exc:
        raise VideoGenError(f"could not download the clip: {exc}") from exc


def _require_successful_clip_response(response: httpx.Response) -> None:
    if not response.is_success:
        raise VideoGenError(_error_message(response))



def _clip_bytes(response: httpx.Response) -> bytes:
    raw = response.content
    if not raw:
        raise VideoGenError("the provider returned an empty clip")
    _require_clip_size(raw)
    return raw


def _require_clip_size(raw: bytes) -> None:
    if len(raw) > MAX_CLIP_BYTES:
        raise VideoGenError(
            f"the clip is {len(raw) // (1024 * 1024)} MB, over this room's "
            f"{MAX_CLIP_BYTES // (1024 * 1024)} MB limit for one generated file"
        )


def _clip_format(response: httpx.Response) -> tuple[str, str]:
    mime = (response.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    ext = CLIP_MIMES.get(mime)
    if ext is None:
        # A provider that mislabels the transfer should not cost the user a
        # clip they have already paid for. mp4 is what every model in the live
        # catalogue returns, so save it rather than refuse it.
        mime, ext = "video/mp4", "mp4"
    return mime, ext


async def _call(provider: Any, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
    """One JSON call to the video API, with the provider's own words on failure."""
    url = f"{provider.base_url.rstrip('/')}{path}"
    try:
        async with httpx.AsyncClient(timeout=CALL_TIMEOUT_SECS) as client:
            response = await client.request(
                method, url, headers=_headers(provider.api_key), **kwargs
            )
    except httpx.HTTPError as exc:
        raise VideoGenError(f"could not reach the provider: {exc}") from exc
    if not response.is_success:
        raise VideoGenError(_error_message(response))
    try:
        data = response.json()
    except ValueError as exc:
        raise VideoGenError("the provider returned a reply that was not JSON") from exc
    if not isinstance(data, dict):
        raise VideoGenError("the provider returned a reply in an unexpected shape")
    return data


def _error_message(response: httpx.Response) -> str:
    """The provider's own words when it refuses, not just a status code."""
    message = _provider_error_message(_json_body(response))
    return message or _refusal_message(response)


def _json_body(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def _provider_error_message(body: Any) -> str | None:
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        error = error.get("message")
    return _optional_text(error)


def _refusal_message(response: httpx.Response) -> str:
    return f"the provider refused the request ({response.status_code})"


__all__ = [
    "CLIP_MIMES",
    "DEAD_STATUSES",
    "DONE_STATUSES",
    "MAX_CLIP_BYTES",
    "MAX_REFERENCE_BYTES",
    "PENDING_STATUSES",
    "VideoGenError",
    "fetch",
    "frame_parts",
    "guard",
    "reference_parts",
    "status",
    "submit",
]
