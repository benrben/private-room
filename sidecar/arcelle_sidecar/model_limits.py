"""Native context-length lookup for the token-budget bar.

Confirmed live 2026-07-21 (user report): the RAM-adaptive `num_ctx` handed to
Ollama (config.py's `num_ctx_for_chat`, e.g. 12288/24576) is the WORKING
window for this session — throttled down for speed/memory — not what the
model can actually do. Users expect the bar's denominator to be the model's
real advertised capability (e.g. ~256k for qwen3.5), even though Ollama's own
working window is smaller by design.

Ollama's own `/api/tags` already reports this, per model, as `details.
context_length` — confirmed live for BOTH local and `:cloud` models (a
`:cloud` model reports its own real remote window, e.g. 524288 for one,
262144 for another), so this one live source covers both cases; no hardcoded
per-model table needed.
"""

from __future__ import annotations

import httpx

#: (base_url, model) -> native context length, cached for the process
#: lifetime (an installed model's own catalog entry doesn't change
#: mid-session). Only successful lookups are cached — a transient failure
#: retries next time rather than locking in "unknown" forever.
_CACHE: dict[tuple[str, str], int] = {}


async def native_context_length(model: str, base_url: str) -> int | None:
    """The model's real context length, straight from Ollama's own catalog.

    `None` when the model isn't listed, reports nothing, or the daemon can't
    be reached — callers fall back to the RAM-adaptive `num_ctx` they already
    have (a legitimate answer, just not the one users expect to see first).
    """
    key = (base_url, model)
    if key in _CACHE:
        return _CACHE[key]
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{base_url}/api/tags")
            resp.raise_for_status()
            data = resp.json()
    except Exception:  # noqa: BLE001 - best-effort; caller has a fallback
        return None
    for m in data.get("models", []):
        if m.get("model") == model or m.get("name") == model:
            length = (m.get("details") or {}).get("context_length")
            if isinstance(length, int) and length > 0:
                _CACHE[key] = length
                return length
    return None


__all__ = ["native_context_length"]
