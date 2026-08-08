"""Live probe: does the real video API work, and does it take an INLINE picture?

Not a unit test — it spends money. Run by hand, never from the suite:

    OPENROUTER_API_KEY=... uv run python live_video_probe.py

It exercises `videogen` itself rather than a hand-rolled request, so a pass
means the shipped code path works, not merely that the endpoint exists.

The whole point is the frame image. Every OpenRouter example passes a picture
as an HTTP URL; the spec leaves the field an unconstrained string and says
nothing about inline data. Arcelle's pictures live inside an encrypted room
file and putting them on a public URL is the one thing this app exists not to
do — so if inline base64 is refused, "make a video from this picture" cannot
be built the way it is designed. One cheap clip answers it for certain.

Cheapest model that accepts a first frame, at its shortest legal length and
smallest size: x-ai/grok-imagine-video, 1 second, 480p — about five cents.
"""

from __future__ import annotations

import asyncio
import os
import struct
import sys
import time
import zlib
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from arcelle_sidecar import videogen  # noqa: E402

MODEL = "openrouter::x-ai/grok-imagine-video"
SECONDS = 1
RESOLUTION = "480p"
POLL_EVERY = 5.0
GIVE_UP_AFTER = 600.0


@dataclass
class Provider:
    """Stands in for the ProviderConfig Rust mints from Keychain."""

    base_url: str
    api_key: str
    model: str


def test_png(width: int = 512, height: int = 512) -> bytes:
    """A real PNG, built without pillow: a horizon with a sun.

    Deliberately something a model can obviously animate, so a returned clip
    that ignored the frame is recognizable at a glance rather than arguable.
    """
    rows = bytearray()
    cx, cy, r2 = width // 2, height // 3, (width // 8) ** 2
    for y in range(height):
        rows.append(0)  # PNG per-scanline filter: none
        for x in range(width):
            if (x - cx) ** 2 + (y - cy) ** 2 < r2:
                rows += b"\xff\xd2\x40"  # sun
            elif y < height * 0.55:
                shade = int(120 + 100 * (y / height))
                rows += bytes((shade // 2, shade, 220))  # sky
            else:
                rows += b"\x1c\x3a\x2e"  # dark ground

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
    provider = Provider("https://openrouter.ai/api/v1", key, "x-ai/grok-imagine-video")

    import base64

    picture = base64.b64encode(test_png()).decode("ascii")
    print(f"frame picture: {len(picture)} chars of base64")

    print(f"submitting {MODEL} — {SECONDS}s at {RESOLUTION}, with an INLINE first frame…")
    try:
        started = await videogen.submit(
            prompt="the sun sinks slowly toward the horizon, clouds drifting",
            model=MODEL,
            provider=provider,
            privacy=None,
            seconds=SECONDS,
            resolution=RESOLUTION,
            frames=[{"b64": picture, "mime": "image/png", "frame_type": "first_frame"}],
            references_ack=True,
        )
    except videogen.VideoGenError as exc:
        # THE answer, either way. A complaint about decoding the picture means
        # the inline form is accepted; "must be a URL" means it is not.
        print(f"REFUSED: {exc}")
        return 1

    video_id = started["video_id"]
    print(f"accepted, job id {video_id}")

    deadline = time.monotonic() + GIVE_UP_AFTER
    while time.monotonic() < deadline:
        await asyncio.sleep(POLL_EVERY)
        state = await videogen.status(model=MODEL, video_id=video_id, provider=provider)
        print(f"  {state['status']}  progress={state['progress']}")
        if state["failed"]:
            print(f"FAILED: {state['error']}")
            return 1
        if state["done"]:
            break
    else:
        print("gave up waiting")
        return 1

    clip = await videogen.fetch(model=MODEL, video_id=video_id, provider=provider)
    raw = base64.b64decode(clip["artwork_b64"])
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe-clip.mp4")
    with open(out, "wb") as handle:
        handle.write(raw)
    print(f"OK — {len(raw)} bytes of {clip['mime']} saved to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
