"""Live probe: does picture generation work, and does it honour a REFERENCE?

Spends money. Run by hand, never from the suite:

    OPENROUTER_API_KEY=... uv run python live_image_probe.py

Two things are under test and only one of them is about pixels.

  1. Does the chat transport `imagegen` uses still work for image models?
     OpenRouter now publishes a dedicated `POST /images`, and the chat path
     with `modalities: ["image"]` is soft-deprecated. If chat has stopped
     answering with pictures, the Create page cannot work at all and the fix
     is a different endpoint, not a different prompt.

  2. Is an attached picture actually USED? This is the one that decides
     whether a cast of characters is possible. Consistency across shots comes
     from handing the model the same picture every time, not from describing
     the character again in words — so if references are accepted and ignored,
     the whole feature is theatre.

The reference is deliberately unmistakable: a bright magenta circle on a
green field. No model invents that by accident, so "did it look at the
picture" is answerable by looking rather than by arguing.
"""

from __future__ import annotations

import asyncio
import base64
import os
import struct
import sys
import zlib
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from arcelle_sidecar import imagegen  # noqa: E402

MODEL = "openrouter::black-forest-labs/flux.2-klein-4b"


@dataclass
class Provider:
    base_url: str
    api_key: str
    model: str


def reference_png(width: int = 512, height: int = 512) -> bytes:
    """A magenta circle on green — a shape no model produces unprompted."""
    rows = bytearray()
    cx, cy, r2 = width // 2, height // 2, (width // 4) ** 2
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows += b"\xe8\x1c\xa8" if (x - cx) ** 2 + (y - cy) ** 2 < r2 else b"\x1c\x6e\x3a"

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )


async def main() -> int:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        print("no OPENROUTER_API_KEY in the environment")
        return 2
    provider = Provider("https://openrouter.ai/api/v1", key, "black-forest-labs/flux.2-klein-4b")
    here = os.path.dirname(os.path.abspath(__file__))

    print("1/2  plain prompt, no reference…")
    try:
        plain = await imagegen.generate(
            prompt="a small stone lighthouse on a cliff at dusk, oil painting",
            model=MODEL,
            provider=provider,
            privacy=None,
        )
    except imagegen.ImageGenError as exc:
        print(f"  FAILED: {exc}")
        return 1
    out = os.path.join(here, f"probe-plain.{plain['ext']}")
    with open(out, "wb") as handle:
        handle.write(base64.b64decode(plain["artwork_b64"]))
    print(f"  OK — {plain['mime']} -> {out}")

    print("2/2  same model, WITH an attached reference…")
    try:
        guided = await imagegen.generate(
            prompt="put this exact shape on a flag flying over a stone tower",
            model=MODEL,
            provider=provider,
            privacy=None,
            reference_b64=[base64.b64encode(reference_png()).decode("ascii")],
            reference_mime=["image/png"],
            references_ack=True,
        )
    except imagegen.ImageGenError as exc:
        print(f"  FAILED: {exc}")
        return 1
    out = os.path.join(here, f"probe-guided.{guided['ext']}")
    with open(out, "wb") as handle:
        handle.write(base64.b64decode(guided["artwork_b64"]))
    print(f"  OK — {guided['mime']} -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
