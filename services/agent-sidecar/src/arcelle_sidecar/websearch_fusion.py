"""Pure ranking plus dependency-injected fanout orchestration."""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Callable, Iterable
from operator import itemgetter
from typing import Any

from .websearch_parse import Hit, _dedupe_key

Engine = Callable[..., list[Hit]]
_RRF_WEIGHT = 0.70
_LEXICAL_WEIGHT = 0.30
_WORD = re.compile(r"[a-z0-9]+")


def _lexical(query: str, title: str | None) -> float:
    words = set(_WORD.findall(query.lower()))
    if not words:
        return 0.0
    return len(words & set(_WORD.findall((title or "").lower()))) / len(words)


def _score(query: str, result: Hit, rrf_share: float) -> float:
    return round(
        _RRF_WEIGHT * rrf_share
        + _LEXICAL_WEIGHT * _lexical(query, result["title"]),
        3,
    )


def _merge_page(merged: dict[str, Hit], key: str, result: Hit) -> None:
    page = merged.setdefault(key, dict(result, engines=[]))
    if result["source"] not in page["engines"]:
        page["engines"].append(result["source"])
    if page.get("snippet") is None and result.get("snippet"):
        page["snippet"] = result["snippet"]


def _merge_engine_hits(
    merged: dict[str, Hit],
    rrf: defaultdict[str, float],
    hits: list[Hit],
    rrf_k: int,
) -> None:
    counted: set[str] = set()
    for rank, result in enumerate(hits, start=1):
        key = _dedupe_key(result["url"])
        if not key or key in counted:
            continue
        counted.add(key)
        _merge_page(merged, key, result)
        rrf[key] += 1.0 / (rrf_k + rank)


def _fused_pages(
    results: list[list[Hit]], rrf_k: int
) -> tuple[dict[str, Hit], defaultdict[str, float], int]:
    merged: dict[str, Hit] = {}
    rrf: defaultdict[str, float] = defaultdict(float)
    collected = 0
    for hits in results:
        collected += len(hits)
        _merge_engine_hits(merged, rrf, hits, rrf_k)
    return merged, rrf, collected


def _fuse_results(
    engines: Iterable[Engine],
    *,
    query: str,
    delay: float,
    rrf_k: int,
    budget: float,
    run_politely: Callable[[list[Engine], str, float, list[list[Hit]], list[bool]], None],
    run_parallel: Callable[[list[Engine], str, float, list[list[Hit]], list[bool]], None],
) -> tuple[dict[str, Hit], dict[str, float], int, list[str]]:
    engine_list = list(engines)
    results: list[list[Hit]] = [[] for _ in engine_list]
    broke = [False] * len(engine_list)
    if delay:
        run_politely(engine_list, query, delay, results, broke)
    else:
        run_parallel(engine_list, query, budget, results, broke)
    merged, rrf, collected = _fused_pages(results, rrf_k)
    failed = [
        engine.__name__
        for engine, missed in zip(engine_list, broke, strict=True)
        if missed
    ]
    return merged, rrf, collected, failed


def _rank_results(
    query: str,
    limit: int,
    *,
    engines: Iterable[Engine],
    delay: float,
    rrf_k: int,
    budget: float,
    fuse_runner: Callable[..., tuple[dict[str, Hit], dict[str, float], int, list[str]]],
) -> tuple[list[Hit], int, list[str]]:
    merged, rrf, collected, failed = fuse_runner(
        query, engines, delay=delay, rrf_k=rrf_k, budget=budget
    )
    if not merged:
        return [], collected, failed
    top_rrf = max(rrf.values()) or 1.0
    scored = [
        dict(result, score=_score(query, result, rrf[key] / top_rrf))
        for key, result in merged.items()
    ]
    scored.sort(key=itemgetter("score"), reverse=True)
    return scored[:limit], collected, failed


def _timed_result(
    query: str,
    limit: int,
    engines: Iterable[Engine] | None,
    ranked_runner: Callable[..., tuple[list[Hit], int, list[str]]],
    monotonic: Callable[[], float],
) -> dict[str, Any]:
    started = monotonic()
    hits, collected, failed = ranked_runner(query, limit, engines=engines)
    return {
        "hits": hits,
        "merged": collected,
        "tookMs": int((monotonic() - started) * 1000),
        "failed": failed,
    }
