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

#: The square canvas every image is fitted to before grounding. Exactly 1000 so
#: pixel coordinates and 0..1000-normalized coordinates COINCIDE (both divide to
#: the same 0..1 value) — which is what makes box placement robust regardless of
#: which convention the vision model answers in (vision.rs VISION_SQUARE).
VISION_SQUARE: int = 1000

#: chat_structured (ollama.rs:414) appends the schema to the last user turn so a
#: small model fills the forced JSON with real content instead of empty strings —
#: ``format`` constrains the grammar but the model never SEES the schema.
_SCHEMA_PRIMING = "\n\nReply with ONLY JSON matching this schema, filling every field with real content:\n"


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
    return prompt + _SCHEMA_PRIMING + compact_json(schema)


def strip_think_spans(raw: str) -> str:
    """Remove ``<think>…</think>`` reasoning spans a model leaks into its visible
    answer (ollama.rs ``strip_think_spans``). An UNTERMINATED ``<think>`` truncates
    the rest: everything after it is unclosed reasoning, not answer."""
    out = raw
    while True:
        start = out.find("<think>")
        if start == -1:
            break
        rel = out[start:].find("</think>")
        if rel == -1:
            out = out[:start]
            break
        end = start + rel + len("</think>")
        out = out[:start] + out[end:]
    return out


def recover_json(text: str) -> str:
    """Recover the JSON payload from a structured-output response (ollama.rs
    ``recover_json``). A no-op for models that honour ``format``; for models that
    wrap it in a ```json fence or a ``<think>`` preamble, drop the think span then
    slice from the first opening bracket to the last closing one."""
    s = strip_think_spans(text.strip()).strip()
    a = next((i for i, c in enumerate(s) if c in "{["), None)
    b = next((i for i in range(len(s) - 1, -1, -1) if s[i] in "}]"), None)
    if a is not None and b is not None and b >= a:
        return s[a : b + 1]
    return s


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
        if not isinstance(item, dict):
            continue
        # as_str() semantics: use label only if it IS a string (even ""), then
        # name, then the "match" fallback.
        label = item.get("label")
        if not isinstance(label, str):
            label = item.get("name")
            if not isinstance(label, str):
                label = "match"

        # Requested "bbox_2d" is absolute pixels. "box_2d" is Google-style
        # [ymin, xmin, ymax, xmax] 0-1000.
        if isinstance(item.get("bbox_2d"), list):
            coords, y_first, pixels = item["bbox_2d"], False, True
        elif isinstance(item.get("bbox"), list):
            coords, y_first, pixels = item["bbox"], False, True
        elif isinstance(item.get("box_2d"), list):
            coords, y_first, pixels = item["box_2d"], True, False
        elif isinstance(item.get("box"), list):
            coords, y_first, pixels = item["box"], False, False
        else:
            continue

        if len(coords) != 4:
            continue
        vals = [n for n in (_num(c) for c in coords) if n is not None]
        if len(vals) != 4:
            continue

        if y_first:
            a, b, c, d = vals[1], vals[0], vals[3], vals[2]
        else:
            a, b, c, d = vals[0], vals[1], vals[2], vals[3]

        # Scale to 0..1. Pixel keys use the image dims — unless the values
        # overshoot them, which means the model answered in its own
        # 0-1000-normalized space (qwen2.5vl does this on small images).
        max_val = max([0.0, *vals])
        out_of_range = max(a, c) > img_w * 1.05 or max(b, d) > img_h * 1.05
        if max_val <= 1.0:
            sx, sy = 1.0, 1.0
        elif pixels and not out_of_range:
            sx, sy = max(img_w, 1.0), max(img_h, 1.0)
        else:
            sx, sy = 1000.0, 1000.0
        a /= sx
        c /= sx
        b /= sy
        d /= sy
        if a > c:
            a, c = c, a
        if b > d:
            b, d = d, b

        def clamp(v: float) -> float:
            return min(max(v, 0.0), 1.0)

        a, b, c, d = clamp(a), clamp(b), clamp(c), clamp(d)
        if c - a < 0.001 or d - b < 0.001:
            continue
        boxes.append({"label": label, "x1": a, "y1": b, "x2": c, "y2": d})
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
    from . import llm

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
    "strip_think_spans",
    "recover_json",
    "boxes_from_items",
    "parse_boxes",
    "vision_locate",
]
