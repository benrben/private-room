"""Image grounding — the /vision_locate endpoint (MIGRATION Phase 2).

Ported from ``commands/vision.rs`` ``locate_in_image``. Rust keeps ONLY the DB +
model-selection work (decrypt the image bytes, pick the local vision model) and
hands us ``{image_b64, query, model}``; every bit of the grounding COMPUTE lives
here now:

  prepare_image  -> stretch the image onto a 1000×1000 canvas, transcode to PNG
  grounding_prompt -> the Qwen-VL trained prompt, in pixel terms
  boxes_schema   -> the structured-output grammar handed to Ollama ``format``
  (schema priming + recover_json) -> exactly what ``ollama.rs`` chat_structured did
  parse_boxes    -> the coordinate-convention salvage (pixel vs 0-1000, xy vs yx)

The boxes come back NORMALIZED 0..1 relative to the image, top-left origin — the
same ``ImageBox`` shape ``vision.rs`` serialised, so the Rust rewiring deserialises
the sidecar's reply straight into ``Vec<ImageBox>`` and returns it unchanged.

Privacy (SPEC §6): the image never leaves the box — it goes only to the loopback
Ollama the ``base_url`` names, through :mod:`.llm`, which strips all tracing.
"""

from __future__ import annotations

import base64
import io
import json
from typing import Any

from PIL import Image

from .messages import compact_json
from .model_text import SCHEMA_PRIMER, recover_json, strip_think_spans

#: The square canvas every image is fitted to before grounding. Exactly 1000 so
#: pixel coordinates and 0..1000-normalized coordinates COINCIDE (both divide to
#: the same 0..1 value) — which is what makes box placement robust regardless of
#: which convention the vision model answers in (vision.rs VISION_SQUARE).
VISION_SQUARE: int = 1000


def prepare_image(data: bytes) -> tuple[bytes, float, float]:
    """Normalize an image for the model (vision.rs ``prepare_image``).

    Transcode to PNG (Ollama only decodes PNG/JPEG — WebP/HEIC/mislabeled files
    fail with "unknown format") and STRETCH it onto a fixed VISION_SQUARE² canvas.
    Returns ``(bytes, width, height)``.

    Marking fix: the image is stretched to a square rather than kept at its own
    aspect ratio. This removes the two things that push highlight boxes off —
    almost always downward: (1) the pixel-vs-0..1000 scale ambiguity disappears,
    because on a 1000×1000 image both conventions normalize identically; and (2)
    it pre-empts the vision model's OWN internal square-padding, which otherwise
    drags the boxes down. Boxes are drawn back over the ORIGINAL image using
    NORMALIZED coordinates, so the per-axis stretch cancels out exactly — only the
    model's working view is distorted, never the placement.

    Mirrors the Rust branch structure: a clean decode+encode yields the square PNG
    at (1000, 1000); a decode failure passes the bytes through with fallback dims;
    an encode failure passes the ORIGINAL bytes through at the source dimensions.
    """
    square = float(VISION_SQUARE)
    try:
        img = Image.open(io.BytesIO(data))
        # .size is available from the header without a full decode; keep the
        # source dims for the encode-failure fallback (Rust returns (ow, oh)).
        ow, oh = float(img.width), float(img.height)
    except Exception:  # noqa: BLE001 - undecodable: pass through like imagesize's fallback
        # Rust asks imagesize for the dims here; if PIL can't even open it we have
        # no dims, so we fall to the square (Rust's ``unwrap_or((square, square))``).
        return data, square, square
    try:
        # resize_exact with a Triangle filter == PIL bilinear onto the square.
        fitted = img.resize((VISION_SQUARE, VISION_SQUARE), Image.Resampling.BILINEAR)
        out = io.BytesIO()
        fitted.save(out, format="PNG")
        return out.getvalue(), square, square
    except Exception:  # noqa: BLE001 - encode failed: original bytes, original dims
        return data, ow, oh


def grounding_prompt(query: str, w: float, h: float) -> str:
    """The grounding prompt Qwen-VL models were trained on (vision.rs)."""
    return (
        f"Outline the position of each instance of the following in this "
        f"{w:.0f}x{h:.0f} pixel image: {query}\n"
        f"Output ONLY a JSON array, no other text, in the format "
        f'[{{"bbox_2d": [x1, y1, x2, y2], "label": "<short name>"}}]. '
        f"One element per match, each with a distinct descriptive label. "
        f"If it is not in the image, output []."
    )


def boxes_schema() -> dict[str, Any]:
    """The JSON schema handed to Ollama ``format`` for the grounding pass, so a
    small vision model can only ever emit a well-formed box array (vision.rs
    ADD-22). ``parse_boxes`` still handles the coordinate-scale ambiguity (pixel
    vs 0-1000) a schema can't express, but no longer has to salvage malformed
    JSON."""
    return {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "bbox_2d": {
                    "type": "array",
                    "items": {"type": "number"},
                    "minItems": 4,
                    "maxItems": 4,
                },
                "label": {"type": "string"},
            },
            "required": ["bbox_2d", "label"],
        },
    }


def prime_with_schema(prompt: str, schema: dict[str, Any]) -> str:
    """Append the schema to the prompt, as chat_structured did to the user turn."""
    return prompt + SCHEMA_PRIMER + compact_json(schema)


# One decoder instance: raw_decode parses ONE balanced JSON value from the start
# and ignores trailing prose — the exact behaviour of the Rust stream-deserializer.
_DECODER = json.JSONDecoder()


def _first_json_value(s: str) -> Any:
    """Parse the first balanced JSON value at the start of ``s``, or None."""
    try:
        value, _end = _DECODER.raw_decode(s)
        return value
    except (json.JSONDecodeError, ValueError):
        return None


def _num(v: Any) -> float | None:
    """``serde_json::Value::as_f64``: numbers only — JSON booleans are NOT numbers
    (bool is an int subclass in Python, so exclude it explicitly)."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def _box_label(item: dict[Any, Any]) -> str:
    """Return the model label with the Rust-compatible fallback order."""
    label = item.get("label")
    if isinstance(label, str):
        return label
    name = item.get("name")
    if isinstance(name, str):
        return name
    return "match"


def _box_coordinates(item: dict[Any, Any]) -> tuple[list[Any], bool, bool] | None:
    """Return coordinates and their convention, in precedence order."""
    if isinstance(item.get("bbox_2d"), list):
        return item["bbox_2d"], False, True
    if isinstance(item.get("bbox"), list):
        return item["bbox"], False, True
    if isinstance(item.get("box_2d"), list):
        return item["box_2d"], True, False
    if isinstance(item.get("box"), list):
        return item["box"], False, False
    return None


def _numeric_coordinates(coords: list[Any]) -> list[float] | None:
    """Accept exactly four JSON numbers, excluding Python boolean values."""
    if len(coords) != 4:
        return None
    values = [number for value in coords if (number := _num(value)) is not None]
    if len(values) != 4:
        return None
    return values


def _xy_coordinates(values: list[float], y_first: bool) -> tuple[float, float, float, float]:
    """Put a supported coordinate convention into x1, y1, x2, y2 order."""
    if y_first:
        return values[1], values[0], values[3], values[2]
    return values[0], values[1], values[2], values[3]


def _image_scales(
    values: list[float],
    bounds: tuple[float, float, float, float],
    pixels: bool,
    img_w: float,
    img_h: float,
) -> tuple[float, float]:
    """Choose the scale matching the model's apparent coordinate convention."""
    a, b, c, d = bounds
    out_of_range = max(a, c) > img_w * 1.05 or max(b, d) > img_h * 1.05
    if max([0.0, *values]) <= 1.0:
        return 1.0, 1.0
    if pixels and not out_of_range:
        return max(img_w, 1.0), max(img_h, 1.0)
    return 1000.0, 1000.0


def _scaled_bounds(
    bounds: tuple[float, float, float, float], scales: tuple[float, float]
) -> tuple[float, float, float, float]:
    """Apply independent horizontal and vertical normalization scales."""
    a, b, c, d = bounds
    sx, sy = scales
    return a / sx, b / sy, c / sx, d / sy


def _ordered_bounds(bounds: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """Return bounds with their start coordinate no greater than their end."""
    a, b, c, d = bounds
    if a > c:
        a, c = c, a
    if b > d:
        b, d = d, b
    return a, b, c, d


def _clamp_unit(value: float) -> float:
    """Keep a coordinate within the normalized image plane."""
    return min(max(value, 0.0), 1.0)


def _clamped_bounds(bounds: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """Clamp every normalized coordinate to the image plane."""
    a, b, c, d = bounds
    return _clamp_unit(a), _clamp_unit(b), _clamp_unit(c), _clamp_unit(d)


def _has_area(bounds: tuple[float, float, float, float]) -> bool:
    """Require the same minimum normalized extent as the Rust implementation."""
    a, b, c, d = bounds
    return c - a >= 0.001 and d - b >= 0.001


def _box_from_item(item: Any, img_w: float, img_h: float) -> dict[str, Any] | None:
    """Normalize one model item or return no box for malformed input."""
    if not isinstance(item, dict):
        return None
    label = _box_label(item)
    coordinate_details = _box_coordinates(item)
    if coordinate_details is None:
        return None
    coords, y_first, pixels = coordinate_details
    values = _numeric_coordinates(coords)
    if values is None:
        return None
    bounds = _xy_coordinates(values, y_first)
    scales = _image_scales(values, bounds, pixels, img_w, img_h)
    normalized_bounds = _clamped_bounds(_ordered_bounds(_scaled_bounds(bounds, scales)))
    if not _has_area(normalized_bounds):
        return None
    a, b, c, d = normalized_bounds
    return {"label": label, "x1": a, "y1": b, "x2": c, "y2": d}


def boxes_from_items(items: list[Any], img_w: float, img_h: float) -> list[dict[str, Any]]:
    """One ``ImageBox`` dict per valid item (vision.rs ``boxes_from_items``).

    Reproduces the coordinate-convention salvage a JSON schema can't express:
    ``bbox_2d``/``bbox`` are absolute pixels (Qwen-VL native), ``box_2d`` is
    Google-style ``[ymin, xmin, ymax, xmax]`` in 0-1000, and pixel values that
    overshoot the image dims mean the model actually answered in its own
    0-1000-normalized space. Output keys match the camelCase ``ImageBox``
    (label, x1, y1, x2, y2), all normalized 0..1, top-left origin."""
    boxes: list[dict[str, Any]] = []
    for item in items:
        box = _box_from_item(item, img_w, img_h)
        if box is not None:
            boxes.append(box)
    return boxes


def parse_boxes(raw: str, img_w: float, img_h: float) -> list[dict[str, Any]]:
    """Boxes from the model's raw text (vision.rs ``parse_boxes``).

    Drop any ``<think>`` span, then scan each '[' as a candidate JSON array
    (raw_decode parses one balanced value and ignores trailing prose), returning
    the first array that yields at least one box. Robust to leading/trailing prose
    containing brackets, unlike a single first-'['-to-last-']' slice."""
    cleaned = strip_think_spans(raw)
    bracket_positions = [i for i, ch in enumerate(cleaned) if ch == "["][:8]
    for start in bracket_positions:
        value = _first_json_value(cleaned[start:])
        if not isinstance(value, list):
            continue
        boxes = boxes_from_items(value, img_w, img_h)
        if boxes:
            return boxes
    return []


async def vision_locate(
    model: str,
    image_b64: str,
    query: str,
    base_url: str,
    *,
    temperature: float | None = 0.0,
    num_ctx: int | None = None,
    keep_alive: str | None = None,
    privacy: dict[str, Any] | None = None,
    provider: Any | None = None,
) -> list[dict[str, Any]]:
    """Ground ``query`` in the image and return normalized boxes.

    Reproduces vision.rs ``locate_in_image`` MINUS the DB read and model pick
    (Rust keeps those): prepare the image, build + schema-prime the grounding
    prompt, run one structured (``format``) vision generation via the Phase-1
    gateway, recover the JSON, and parse the boxes. Errors surface as
    :class:`llm.LlmError` (OLLAMA_DOWN / MODEL_MISSING), same as /generate."""
    from . import llm, privacy as privacy_mod

    # The privacy door strips images bound for a non-local model and only COUNTS
    # them (``guard_outbound`` -> ``block_images``); the call itself proceeds. On
    # every other path that is right — the text still gets an answer. Here it is
    # not: grounding with no image returns no boxes, and no boxes is rendered to
    # the user as "could not locate that in this image", i.e. a claim about their
    # picture rather than about their settings. Rust's `grounding_pick` avoids
    # choosing such a model at all; this is the backstop for any caller that
    # doesn't, so the failure can never come back as a lie about the image.
    policy = privacy_mod.policy_from_payload(privacy)
    if policy is not None and policy.active and privacy_mod.is_nonlocal_model(model):
        raise llm.LlmError(
            "ENGINE_ERROR",
            "This room's privacy door does not let images leave the Mac, so "
            f"{model} cannot be shown the picture. Mark images with a model that "
            "runs on this Mac, or turn the door off for this room.",
        )

    data = base64.b64decode(image_b64)
    prepared, w, h = prepare_image(data)
    prepared_b64 = base64.b64encode(prepared).decode("ascii")

    schema = boxes_schema()
    prompt = prime_with_schema(grounding_prompt(query, w, h), schema)
    messages = [{"role": "user", "content": prompt}]

    text = await llm.generate(
        model,
        messages,
        base_url,
        temperature=temperature,
        num_ctx=num_ctx,
        keep_alive=keep_alive,
        format=schema,
        images=[prepared_b64],
        privacy=privacy,
        provider=provider,
    )
    return parse_boxes(recover_json(text), w, h)


__all__ = [
    "VISION_SQUARE",
    "prepare_image",
    "grounding_prompt",
    "boxes_schema",
    "prime_with_schema",
    "boxes_from_items",
    "parse_boxes",
    "vision_locate",
]
