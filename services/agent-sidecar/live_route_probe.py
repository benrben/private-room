"""Live probe: the three video ROUTES, called exactly as the Rust host calls them.

Spends money. Run by hand:

    OPENROUTER_API_KEY=... uv run python live_route_probe.py

`live_video_probe.py` proves the engine works. This proves the *seam* works —
the FastAPI routes, the pydantic request models, and the field names Rust
actually puts on the wire. That is a different failure surface and a quieter
one: a key spelled `aspectRatio` here and `aspect_ratio` there does not raise,
it is dropped by `extra="ignore"` and the clip comes back the wrong shape with
nothing anywhere saying why.

So the bodies below are copied from what `jobs/create.rs` builds, and the app
is driven in-process over ASGI rather than through a socket, so no server has
to be started to check it.
"""

from __future__ import annotations

import asyncio
import base64
import os
import struct
import sys
import time
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import httpx  # noqa: E402

from arcelle_sidecar.server import create_app  # noqa: E402

MODEL = "openrouter::x-ai/grok-imagine-video"
POLL_EVERY = 5.0
GIVE_UP_AFTER = 600.0


def provider(key: str) -> dict:
    """The ProviderConfig Rust mints from Keychain, as JSON."""
    return {
        "id": "openrouter",
        "api_key": key,
        "base_url": "https://openrouter.ai/api/v1",
        "model": "x-ai/grok-imagine-video",
    }


def test_png(width: int = 512, height: int = 512) -> bytes:
    """A checkerboard — unmistakable if it survives into the clip."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows += b"\xf2\x6b\x1c" if ((x // 64) + (y // 64)) % 2 else b"\x14\x22\x38"

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

    app = create_app(token="")
    picture = base64.b64encode(test_png()).decode("ascii")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://sidecar",
        timeout=700.0,
    ) as client:
        # ---- 1. /video_start, with the body `run_one_video` builds ----
        print("POST /video_start …")
        started = await client.post(
            "/video_start",
            json={
                "model": MODEL,
                "prompt": "the checkerboard tilts and slides out of frame",
                "seconds": 1,
                "resolution": "480p",
                "aspect_ratio": "",
                "frames": [
                    {"b64": picture, "mime": "image/png", "frame_type": "first_frame"}
                ],
                "references": [],
                "references_ack": True,
                "provider": provider(key),
            },
        )
        if started.status_code != 200:
            print(f"  FAILED {started.status_code}: {started.text[:400]}")
            return 1
        video_id = started.json().get("video_id")
        print(f"  accepted, job id {video_id}")
        if not video_id:
            print("  FAILED: no video_id in the reply")
            return 1

        job_body = {"model": MODEL, "video_id": video_id, "provider": provider(key)}

        # ---- 2. /video_status, polled ----
        deadline = time.monotonic() + GIVE_UP_AFTER
        while time.monotonic() < deadline:
            await asyncio.sleep(POLL_EVERY)
            state = (await client.post("/video_status", json=job_body)).json()
            print(f"  status={state.get('status')} done={state.get('done')}")
            if state.get("failed"):
                print(f"  FAILED: {state.get('error')}")
                return 1
            if state.get("done"):
                break
        else:
            print("  gave up waiting")
            return 1

        # ---- 3. /video_fetch ----
        print("POST /video_fetch …")
        fetched = await client.post("/video_fetch", json=job_body)
        if fetched.status_code != 200:
            print(f"  FAILED {fetched.status_code}: {fetched.text[:400]}")
            return 1
        body = fetched.json()
        raw = base64.b64decode(body["artwork_b64"])
        out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe-route.mp4")
        with open(out, "wb") as handle:
            handle.write(raw)
        print(f"  OK — {len(raw)} bytes of {body['mime']} (.{body['ext']}) -> {out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
