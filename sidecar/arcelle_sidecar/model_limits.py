"""Context-window sizing: native-length lookup + the payload-fitted request.

Two distinct numbers live here and they must not be confused:

- ``native_context_length`` — what the MODEL advertises (e.g. ~256k for
  qwen3.5). This is a capability ceiling, not what a request actually gets.
- ``pick_num_ctx`` — what a local request must ASK for. The Ollama daemon
  loads local models with its own default window (measured live 2026-07-23:
  ``llama-server -c 4096 --context-shift``), and when a prompt exceeds it the
  server silently context-shifts the FRONT of the prompt away — system
  prompt, tool doctrine and the question itself vanish, and the model returns
  degraded or empty text (the "Done." live regression; a ~6.8k-token turn was
  cut to ``prompt_eval_count`` 2050). So every local call sends an explicit
  ``num_ctx`` sized to its actual payload.

Ollama's own `/api/tags` reports the native length, per model, as `details.
context_length` — confirmed live for BOTH local and `:cloud` models (a
`:cloud` model reports its own real remote window, e.g. 524288 for one,
262144 for another), so this one live source covers both cases; no hardcoded
per-model table needed.
"""

from __future__ import annotations

import os

import httpx

#: Window sizes a local request may ask for. Bucketing (rather than an exact
#: fit) keeps ``num_ctx`` byte-stable across the rounds of a turn and across
#: turns of a conversation, so Ollama's prompt KV-cache stays warm; the model
#: only reloads when a conversation genuinely outgrows its bucket.
#:
#: The top two buckets are the old background-JOB tier (ollama.rs
#: ``num_ctx_for(_, Job)``: 65536 / 131072). They are here because the job
#: paths — a whole-file pass section, a deep summary's gathered read windows —
#: legitimately compose 100 KB+ and a 32k ceiling put them straight back into
#: the silent context-shift this module exists to prevent. Which of them is
#: reachable is decided by RAM (:func:`max_num_ctx`), not by the caller.
NUM_CTX_BUCKETS: tuple[int, ...] = (8_192, 16_384, 32_768, 65_536, 131_072)

#: ollama.rs — the RAM threshold above which the largest window is safe.
#: Measured 2026-07 on qwen3.5:9b (Q4_K_M, GQA cache ≈34 KB/token, 16 GB
#: M-series): 12k ctx → 5.9 GB · 32k → 6.6 GB · 64k → 7.7 GB · 128k → 9.9 GB.
#: 128k on a 16 GB Mac leaves too little for everything else, so it is gated.
_HIGH_RAM_BYTES: int = 32 * 1024 * 1024 * 1024

#: Room left for the model's own output (and thinking) on top of the prompt.
GENERATION_HEADROOM_TOKENS = 2_048

#: Conservative bytes-per-token for the mixed payloads this app sends
#: (English + Hebrew UTF-8 + JSON tool schemas). English prose runs ~4,
#: Hebrew ~2.5, compact JSON ~3 — undercounting tokens is the failure mode
#: that reintroduces silent truncation, so estimate low.
BYTES_PER_TOKEN = 3

_max_ctx_cache: int | None = None


def _total_ram_bytes() -> int:
    """Total physical RAM in bytes, or 0 if it can't be determined.

    ``os.sysconf`` works on macOS and Linux (verified on macOS: SC_PHYS_PAGES *
    SC_PAGE_SIZE). No subprocess, no third-party dependency.
    """
    try:
        return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError, AttributeError):  # pragma: no cover - exotic OS
        return 0


def max_num_ctx() -> int:
    """The largest window this Mac may ask a LOCAL model for.

    RAM-adaptive, restoring what ollama.rs's deleted ``num_ctx_for`` did: the
    full 131072 on a 32 GB+ machine, 65536 below it. Cached — RAM does not
    change under us. Unknown RAM (0) takes the safe smaller ceiling.
    """
    global _max_ctx_cache
    if _max_ctx_cache is None:
        _max_ctx_cache = 131_072 if _total_ram_bytes() >= _HIGH_RAM_BYTES else 65_536
    return _max_ctx_cache


def pick_num_ctx(payload_bytes: int, native_ctx: int | None) -> int:
    """The ``num_ctx`` a local call must request for a payload of this size.

    Smallest bucket that fits the estimated prompt tokens plus generation
    headroom, then two clamps:

    * **RAM** (:func:`max_num_ctx`) — a window this Mac can actually hold.
    * **The model's own native window** — asking beyond it would force RoPE
      extrapolation and degrade every token.

    A payload larger than the resulting window is NOT silently accepted: the
    caller must shrink it first (``budget.trim_messages_to_window``), because
    handing an oversized prompt to Ollama is exactly the context-shift this
    module's docstring describes.
    """
    want = payload_bytes // BYTES_PER_TOKEN + GENERATION_HEADROOM_TOKENS
    ceiling = max_num_ctx()
    chosen = next((b for b in NUM_CTX_BUCKETS if b >= want), NUM_CTX_BUCKETS[-1])
    chosen = min(chosen, ceiling)
    if native_ctx is not None and 0 < native_ctx < chosen:
        return native_ctx
    return chosen

#: (base_url, model) -> native context length, cached for the process
#: lifetime (an installed model's own catalog entry doesn't change
#: mid-session). Only successful lookups are cached — a transient failure
#: retries next time rather than locking in "unknown" forever.
_CACHE: dict[tuple[str, str], int] = {}


async def native_context_length(model: str, base_url: str) -> int | None:
    """The model's real context length, straight from Ollama's own catalog.

    `None` when the model isn't listed, reports nothing, or the daemon can't
    be reached — callers use their explicit override, if any, then a display
    fallback.
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


__all__ = [
    "BYTES_PER_TOKEN",
    "GENERATION_HEADROOM_TOKENS",
    "NUM_CTX_BUCKETS",
    "max_num_ctx",
    "native_context_length",
    "pick_num_ctx",
]
