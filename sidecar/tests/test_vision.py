"""Image grounding — /vision_locate (MIGRATION Phase 2, vision.rs).

No network, no Ollama, no weights: a fake ``ollama.AsyncClient`` is injected (the
same pattern as test_llm) and we assert prepare/prompt/parse and the endpoint
contract the Rust rewiring calls. Real images are made with Pillow (a dependency)
so prepare_image runs its true decode+resize path.
"""

from __future__ import annotations

import base64
import io
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from ollama import ResponseError
from PIL import Image

from privateroom_sidecar import llm, vision
from privateroom_sidecar.server import create_app


# --- fakes (mirrors test_llm.FakeAsyncClient) -------------------------------


class FakeAsyncClient:
    """A scripted ollama AsyncClient recording how chat() was called."""

    script: dict[str, Any] = {}
    calls: dict[str, Any] = {}

    def __init__(self, host: str = "") -> None:
        type(self).calls["host"] = host

    async def chat(self, **kwargs: Any) -> Any:
        type(self).calls["chat"] = kwargs
        val = type(self).script.get("chat")
        if isinstance(val, Exception):
            raise val
        return val


@pytest.fixture(autouse=True)
def fake_client(monkeypatch: pytest.MonkeyPatch) -> type[FakeAsyncClient]:
    FakeAsyncClient.script = {}
    FakeAsyncClient.calls = {}
    # chat.generate does `from ollama import AsyncClient` at call time.
    import ollama

    monkeypatch.setattr(ollama, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(llm, "AsyncClient", FakeAsyncClient)
    return FakeAsyncClient


def _chat_reply(text: str) -> SimpleNamespace:
    return SimpleNamespace(message=SimpleNamespace(content=text))


def _png_b64(w: int, h: int) -> str:
    buf = io.BytesIO()
    Image.new("RGB", (w, h)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def client_for(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://sidecar")


# --- prepare_image ----------------------------------------------------------


def test_prepare_image_fits_square() -> None:
    # vision.rs prepare_image_fits_square_so_boxes_dont_drift_down: a wide image is
    # stretched onto the 1000×1000 grounding canvas.
    buf = io.BytesIO()
    Image.new("RGB", (800, 300)).save(buf, format="PNG")
    prepared, w, h = vision.prepare_image(buf.getvalue())
    assert (w, h) == (1000.0, 1000.0)
    # the returned bytes are a real 1000×1000 PNG Ollama can decode
    out = Image.open(io.BytesIO(prepared))
    assert out.size == (1000, 1000)
    assert out.format == "PNG"


def test_prepare_image_undecodable_passes_through() -> None:
    # Not an image: Rust falls back to the square dims (imagesize unwrap_or).
    prepared, w, h = vision.prepare_image(b"not an image at all")
    assert prepared == b"not an image at all"
    assert (w, h) == (1000.0, 1000.0)


def test_prepare_image_transcodes_jpeg_to_png() -> None:
    # Ollama only decodes PNG/JPEG; whatever comes in leaves as a 1000² PNG.
    buf = io.BytesIO()
    Image.new("RGB", (640, 480), (10, 20, 30)).save(buf, format="JPEG")
    prepared, w, h = vision.prepare_image(buf.getvalue())
    assert (w, h) == (1000.0, 1000.0)
    assert Image.open(io.BytesIO(prepared)).format == "PNG"


# --- grounding_prompt / schema ----------------------------------------------


def test_grounding_prompt_matches_rust_text() -> None:
    p = vision.grounding_prompt("the cat", 1000.0, 1000.0)
    assert p == (
        "Outline the position of each instance of the following in this "
        "1000x1000 pixel image: the cat\n"
        "Output ONLY a JSON array, no other text, in the format "
        '[{"bbox_2d": [x1, y1, x2, y2], "label": "<short name>"}]. '
        "One element per match, each with a distinct descriptive label. "
        "If it is not in the image, output []."
    )


def test_boxes_schema_shape() -> None:
    s = vision.boxes_schema()
    assert s["type"] == "array"
    item = s["items"]
    assert item["required"] == ["bbox_2d", "label"]
    assert item["properties"]["bbox_2d"]["minItems"] == 4
    assert item["properties"]["bbox_2d"]["maxItems"] == 4


# --- parse_boxes (ports vision.rs unit tests) -------------------------------


def test_parse_boxes_survives_prose_and_think_spans() -> None:
    w = h = 100.0
    raw = 'Coordinates are [x1,y1,x2,y2]. Here: [{"label":"cat","bbox":[10,10,50,50]}]'
    assert len(vision.parse_boxes(raw, w, h)) == 1
    raw2 = '<think>let me look</think>[{"label":"dog","bbox":[0,0,40,40]}]'
    assert len(vision.parse_boxes(raw2, w, h)) == 1
    assert len(vision.parse_boxes("[]", w, h)) == 0


def test_boxes_from_items_centered_box_stays_centered() -> None:
    # On the 1000² canvas a vertically-centered 0-1000 box lands centered.
    items = [{"bbox_2d": [100, 450, 900, 550], "label": "mid"}]
    boxes = vision.boxes_from_items(items, 1000.0, 1000.0)
    assert len(boxes) == 1
    b = boxes[0]
    assert abs(b["y1"] - 0.45) < 0.01 and abs(b["y2"] - 0.55) < 0.01
    assert abs(b["x1"] - 0.10) < 0.01
    assert b["label"] == "mid"


def test_boxes_from_items_pixel_overshoot_uses_1000_space() -> None:
    # Values overshoot the image dims -> the model answered in its own 0-1000
    # space, so scale by 1000 not the (small) image size.
    items = [{"bbox_2d": [0, 0, 500, 500], "label": "x"}]
    boxes = vision.boxes_from_items(items, 100.0, 100.0)
    assert len(boxes) == 1
    assert abs(boxes[0]["x2"] - 0.5) < 1e-9


def test_boxes_from_items_google_box_2d_is_y_first_0_1000() -> None:
    # box_2d is [ymin, xmin, ymax, xmax] in 0-1000.
    items = [{"box_2d": [100, 200, 300, 400], "label": "g"}]
    boxes = vision.boxes_from_items(items, 1000.0, 1000.0)
    assert len(boxes) == 1
    b = boxes[0]
    assert abs(b["x1"] - 0.2) < 1e-9 and abs(b["y1"] - 0.1) < 1e-9
    assert abs(b["x2"] - 0.4) < 1e-9 and abs(b["y2"] - 0.3) < 1e-9


def test_boxes_from_items_normalized_values_left_alone() -> None:
    # Already 0..1 (max <= 1.0): no scaling.
    items = [{"bbox_2d": [0.1, 0.2, 0.3, 0.4], "label": "n"}]
    boxes = vision.boxes_from_items(items, 800.0, 600.0)
    assert boxes[0]["x1"] == 0.1 and boxes[0]["y2"] == 0.4


def test_boxes_from_items_label_falls_back_to_name_then_match() -> None:
    items = [
        {"bbox_2d": [1, 1, 50, 50], "name": "via_name"},
        {"bbox_2d": [1, 1, 50, 50]},
    ]
    boxes = vision.boxes_from_items(items, 100.0, 100.0)
    assert [b["label"] for b in boxes] == ["via_name", "match"]


def test_boxes_from_items_drops_degenerate_and_malformed() -> None:
    items = [
        {"bbox_2d": [10, 10, 10, 90], "label": "zero-width"},  # c-a < 0.001 -> drop
        {"bbox_2d": [1, 2, 3], "label": "short"},  # not 4 coords -> drop
        {"label": "no-coords"},  # no box key -> drop
        "not-a-dict",  # non-object -> drop
    ]
    assert vision.boxes_from_items(items, 100.0, 100.0) == []


# --- recover_json / strip_think_spans ---------------------------------------


def test_recover_json_unwraps_fence_and_think() -> None:
    assert vision.recover_json('```json\n[{"a":1}]\n```') == '[{"a":1}]'
    assert vision.recover_json("<think>hmm</think>  [1,2]  ") == "[1,2]"


def test_strip_think_spans_truncates_unterminated() -> None:
    assert vision.strip_think_spans("keep<think>drop the rest") == "keep"
    assert vision.strip_think_spans("a<think>x</think>b") == "ab"


# --- /vision_locate endpoint ------------------------------------------------


async def test_vision_locate_round_trip(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply('[{"bbox_2d":[100,450,900,550],"label":"mid"}]')
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/vision_locate",
            json={
                "model": "qwen2.5vl",
                "image_b64": _png_b64(800, 300),
                "query": "the thing",
                "base_url": "http://h:1",
                "keep_alive": "3m",
            },
        )
    assert resp.status_code == 200
    boxes = resp.json()["boxes"]
    assert len(boxes) == 1
    b = boxes[0]
    assert set(b) == {"label", "x1", "y1", "x2", "y2"}
    assert b["label"] == "mid"
    assert abs(b["y1"] - 0.45) < 0.01 and abs(b["y2"] - 0.55) < 0.01

    call = fake_client.calls["chat"]
    # temperature pinned to 0.0, keep_alive + base_url flow through, schema is the
    # format grammar, and the prepared image rides on the user turn.
    assert fake_client.calls["host"] == "http://h:1"
    assert call["options"]["temperature"] == 0.0
    assert call["keep_alive"] == "3m"
    assert call["format"] == vision.boxes_schema()
    assert call["stream"] is False
    user = call["messages"][-1]
    assert user["role"] == "user"
    assert len(user["images"]) == 1
    # the prompt was schema-primed (chat_structured behaviour) and states 1000px
    assert "1000x1000 pixel image: the thing" in user["content"]
    assert "Reply with ONLY JSON matching this schema" in user["content"]


async def test_vision_locate_empty_when_not_found(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = _chat_reply("[]")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/vision_locate",
            json={"model": "m", "image_b64": _png_b64(64, 64), "query": "nope", "base_url": "http://h:1"},
        )
    assert resp.json() == {"boxes": []}


async def test_vision_locate_model_missing_maps_to_code(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = ResponseError("model 'x' not found", 404)
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/vision_locate",
            json={"model": "x", "image_b64": _png_b64(64, 64), "query": "q", "base_url": "http://h:1"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "MODEL_MISSING"


async def test_vision_locate_engine_down_maps_to_ollama_down(fake_client: type[FakeAsyncClient]) -> None:
    fake_client.script["chat"] = httpx.ConnectError("refused")
    app = create_app()
    async with client_for(app) as c:
        resp = await c.post(
            "/vision_locate",
            json={"model": "m", "image_b64": _png_b64(64, 64), "query": "q", "base_url": "http://h:1"},
        )
    assert resp.status_code == 502
    assert resp.json()["code"] == "OLLAMA_DOWN"
