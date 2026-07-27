"""Live-model e2e for ``POST /wf_node`` — the migrated workflow chain nodes.

    ARCELLE_E2E=1 uv run pytest tests/e2e_live/test_live_wf_node.py -q

``tests/test_wf_nodes.py`` compares the port's PROMPT TRANSCRIPT against a
transcription of the Rust arms under a scripted model, which proves the chains
are byte-identical in what they ask. It cannot prove the HTTP surface Rust
actually calls is wired: the request model, the `{"result": …}` envelope Rust
reads, the Stop contract, and the lane semaphore.

This drives the real route on the real app against the real local model, the
same way ``workflow.rs::wf_node`` does.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from .harness import E2E_MODEL, OLLAMA, skip_unless_live

skip_unless_live()


async def _post(body: dict[str, Any], *, timeout: float = 600.0) -> dict[str, Any]:
    from arcelle_sidecar.server import create_app

    app = create_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://sidecar",
        timeout=timeout,
    ) as c:
        r = await c.post("/wf_node", json=body)
        return {"status": r.status_code, "json": r.json()}


def _base(kind: str, **extra: Any) -> dict[str, Any]:
    return {
        "kind": kind,
        # TOP-LEVEL model: `sidecar_json` keys inject_policy and
        # inject_provider_runtime off body["model"], so this is contractual.
        "model": E2E_MODEL,
        "base_url": OLLAMA,
        "run_id": "e2e-wf",
        "parallel": 1,
        **extra,
    }


async def test_refine_returns_the_result_envelope_rust_reads() -> None:
    """`wf_node` does `v["result"].as_str()`. Anything else is a silent empty
    step artifact, which downstream nodes then interpolate as ''."""
    out = await _post(
        _base(
            "refine",
            prompt="Write ONE short sentence about tide pools.",
            rubric="vivid and factually accurate",
            max_rounds=2,
        )
    )
    assert out["status"] == 200, out
    assert "result" in out["json"], f"missing the envelope Rust reads: {out['json']}"
    assert out["json"]["result"].strip(), "refine produced an empty artifact"


async def test_plan_and_map_fans_out_and_synthesizes() -> None:
    out = await _post(
        _base(
            "plan_and_map",
            prompt="Summarise what makes a good weekly team update.",
            context="The team ships a desktop app and works asynchronously.",
            max_workers=3,
        ),
        timeout=900.0,
    )
    assert out["status"] == 200, out
    assert out["json"].get("result", "").strip(), "plan_and_map produced nothing"


async def test_a_local_lane_never_overlaps_its_workers() -> None:
    """`Lane::LocalLlm => 1` exists because "Local model and Whisper are serial
    (RAM and a single resident model)". Rust enforces that ACROSS steps; a
    fan-out INSIDE one step would bypass it, and nothing in the tree sets
    OLLAMA_NUM_PARALLEL, so Ollama's dynamic default would admit several
    concurrent generations against a local 4B and multiply resident context.

    Measured against the real daemon: with parallel=1 the wall-clock cannot be
    shorter than the serial sum, so overlap would show up as a much faster run
    than the number of workers implies.
    """
    in_flight = 0
    peak = 0
    lock = asyncio.Lock()

    from arcelle_sidecar import llm as llm_mod

    real = llm_mod.generate

    async def counting(*a: Any, **kw: Any) -> str:
        nonlocal in_flight, peak
        async with lock:
            in_flight += 1
            peak = max(peak, in_flight)
        try:
            return await real(*a, **kw)
        finally:
            async with lock:
                in_flight -= 1

    llm_mod.generate = counting  # type: ignore[assignment]
    try:
        out = await _post(
            _base(
                "plan_and_map",
                prompt="List three short checks for a code review.",
                context="Small desktop app, one maintainer.",
                max_workers=3,
                parallel=1,
            ),
            timeout=900.0,
        )
    finally:
        llm_mod.generate = real  # type: ignore[assignment]

    assert out["status"] == 200, out
    assert peak == 1, f"a LocalLlm fan-out ran {peak} generations at once"


async def test_stop_reaches_a_running_chain_through_the_cancel_route() -> None:
    """Stop is DELIVERED, not implied.

    Dropping the client connection does NOT cancel a non-streaming handler
    under the pinned uvicorn/starlette, so `/wf_node` registers in the same
    RunRegistry `/run` uses and Rust POSTs `/cancel` before dropping. Without
    this a stopped 7-call refine keeps burning the GPU on Lane::LocalLlm's
    single slot while the next job queues behind it.
    """
    from arcelle_sidecar.server import create_app

    app = create_app()
    run_id = "e2e-wf-stop"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://sidecar",
        timeout=600.0,
    ) as c:

        async def fire() -> Any:
            return await c.post(
                "/wf_node",
                json=_base(
                    "refine",
                    prompt="Write a detailed paragraph about coastal erosion.",
                    rubric="thorough",
                    max_rounds=4,
                    run_id=run_id,
                ),
            )

        task = asyncio.create_task(fire())
        # Let the first generation start, then Stop exactly as Rust does.
        await asyncio.sleep(4.0)
        cancelled = await c.post("/cancel", json={"run_id": run_id})
        assert cancelled.status_code == 200
        assert cancelled.json()["known"] is True, (
            "/wf_node did not register in the RunRegistry, so Stop cannot reach it"
        )
        resp = await task

    assert resp.status_code == 200
    body = json.loads(resp.text)
    assert body.get("stopped") is True, (
        f"a cancelled chain must answer the Stop contract Rust reads, got {body}"
    )
