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
import time

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

#: Cold-start bytes-per-token, and the FLOOR the live calibration below may
#: never go under. Undercounting tokens is the failure mode that reintroduces
#: silent truncation, so a guess must be low.
#:
#: It is also, measured, far too low to use as the only number. Real ratios
#: from qwen3.5:2b-mlx's own tokenizer (`prompt_eval_count`, 2026-07-28):
#:
#:     English prose      5.89 B/token      a 3-B budget fills  51% of the window
#:     Hebrew prose       3.62 B/token                          83%
#:     Hebrew + numbers   2.91 B/token                         103%
#:     English + numbers  2.48 B/token                         121%
#:     Code / markup      3.08 B/token                          98%
#:
#: So a constant is wrong in BOTH directions depending on what the user writes:
#: ordinary English chat gets barely half the context it could have, while a
#: number-dense turn overflows. That spread is content, not language — Hebrew
#: costs ~1.23x the BYTES of the same content, a 19% penalty, not the halving
#: it was assumed to be.
BYTES_PER_TOKEN = 3

#: Upper clamp on the calibrated ratio. Above this the estimate would be
#: claiming a payload is ~2x lighter than the floor assumes, which is the
#: overflow (silent context-shift) direction.
_CAL_CEILING: float = 6.0

#: Applied to every observation. Sub-1.0 makes the ratio SMALLER than measured,
#: which sizes windows UP and content budgets DOWN — the safe direction for
#: both users of this number.
_CAL_SAFETY: float = 0.85

#: EWMA weight for a new observation. High enough to follow a conversation that
#: switches language or starts pasting code within a few rounds.
_CAL_ALPHA: float = 0.3

#: The live ratio, or None before anything has been observed. Process-global
#: rather than per-model on purpose: measured spread across CONTENT (2.48 to
#: 5.89) dwarfs the spread across tokenizers, a room chats with one model at a
#: time, and the clamp plus `_CAL_SAFETY` absorb a model switch inside a few
#: rounds. Only local calls consult it — a non-local model owns its own window
#: and is never budgeted here.
_calibration: float | None = None

_max_ctx_cache: int | None = None


def observe_token_ratio(payload_bytes: int, prompt_tokens: int) -> None:
    """Feed one REAL (bytes, tokens) observation into the calibration.

    The engine already tells us both numbers every round (Ollama's
    ``prompt_eval_count``), so the app can measure the thing it was guessing
    instead of shipping a constant that is wrong for most content.
    """
    global _calibration
    if payload_bytes <= 0 or prompt_tokens <= 0:
        return
    ratio = payload_bytes / prompt_tokens
    # A ratio outside this is not a tokenizer, it is a bug (a mis-paired
    # payload/usage, or a report about a different call). Ignore rather than
    # let one bad sample move the window sizing.
    if not 1.0 <= ratio <= 20.0:
        return
    _calibration = (
        ratio
        if _calibration is None
        else (1.0 - _CAL_ALPHA) * _calibration + _CAL_ALPHA * ratio
    )


def bytes_per_token() -> float:
    """Bytes per token to assume right now — calibrated if we have measured it.

    Never returns less than :data:`BYTES_PER_TOKEN`, so this can only ever
    grant MORE context than the constant did, never less. Both callers move in
    the safe direction together: :func:`pick_num_ctx` divides by it (a smaller
    value asks for a bigger window) and :func:`.budget.window_budget_bytes`
    multiplies by it (a smaller value allows fewer bytes).
    """
    if _calibration is None:
        return float(BYTES_PER_TOKEN)
    return min(max(_calibration * _CAL_SAFETY, float(BYTES_PER_TOKEN)), _CAL_CEILING)


def reset_token_ratio() -> None:
    """Drop the calibration (tests, and a model change in a long-lived process)."""
    global _calibration
    _calibration = None


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
    want = int(payload_bytes / bytes_per_token()) + GENERATION_HEADROOM_TOKENS
    ceiling = max_num_ctx()
    chosen = next((b for b in NUM_CTX_BUCKETS if b >= want), NUM_CTX_BUCKETS[-1])
    chosen = min(chosen, ceiling)
    if native_ctx is not None and 0 < native_ctx < chosen:
        return native_ctx
    return chosen

#: (base_url, model) -> (when it was read, native context length). Cached
#: because the lookup is an HTTP round trip on the hot path of every local
#: call, and EXPIRING because a model does change under its own name: re-pull
#: `qwen3.5:4b`, or swap it for a different quantisation, and the catalog says
#: something new while the process keeps sizing every request — and the token
#: bar's ceiling — off the length it read at startup. Only successful lookups
#: are cached; a transient failure retries next time rather than locking in
#: "unknown" forever.
_CACHE: dict[tuple[str, str], tuple[float, int]] = {}

#: How long a cached native length stays fresh. Short enough that a swapped
#: model is picked up within a few turns, long enough that a burst of rounds
#: costs one `/api/tags` call between them.
_CACHE_TTL_SECONDS: float = 300.0


async def native_context_length(model: str, base_url: str) -> int | None:
    """The model's real context length, straight from Ollama's own catalog.

    `None` when the model isn't listed, reports nothing, or the daemon can't
    be reached — callers use their explicit override, if any, then a display
    fallback. A stale cached length is preferred to `None` when the refresh
    itself fails: it was true five minutes ago, and `None` sends the caller to
    a made-up display default.
    """
    key = (base_url, model)
    cached = _CACHE.get(key)
    now = time.monotonic()
    if cached is not None and now - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]
    stale = cached[1] if cached is not None else None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{base_url}/api/tags")
            resp.raise_for_status()
            data = resp.json()
    except Exception:  # noqa: BLE001 - best-effort; caller has a fallback
        return stale
    for m in data.get("models", []):
        if m.get("model") == model or m.get("name") == model:
            length = (m.get("details") or {}).get("context_length")
            if isinstance(length, int) and length > 0:
                _CACHE[key] = (now, length)
                return length
    return stale


__all__ = [
    "BYTES_PER_TOKEN",
    "GENERATION_HEADROOM_TOKENS",
    "NUM_CTX_BUCKETS",
    "bytes_per_token",
    "max_num_ctx",
    "native_context_length",
    "observe_token_ratio",
    "pick_num_ctx",
    "reset_token_ratio",
]
