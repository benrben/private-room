"""Fake-only `Lane.push` batching and fallback regressions."""

from __future__ import annotations

from arcelle_sidecar.rec import lanes
from arcelle_sidecar.rec.meta import FRAME


def _fake_lane(monkeypatch):
    """Construct a lane without allowing the optional VAD model to load."""
    monkeypatch.setattr(lanes.NeuralVad, "new", staticmethod(lambda: None))
    return lanes.Lane(0)


def test_push_batches_complete_frames_in_order_and_keeps_the_tail(monkeypatch) -> None:
    lane = _fake_lane(monkeypatch)
    prob_calls: list[list[float]] = []
    processed: list[tuple[list[float], float | None]] = []

    class FakeVad:
        def probs(self, samples: list[float]) -> list[float]:
            prob_calls.append(list(samples))
            return [0.25, 0.75]

    def fake_frame(frame: list[float], speech_prob: float | None):
        processed.append((frame, speech_prob))
        return (len(processed), [speech_prob])

    lane.vad = FakeVad()  # type: ignore[assignment]
    lane.frame = fake_frame  # type: ignore[method-assign]
    lane.push([0.0] * (FRAME - 3))

    closed = lane.push([1.0] * (FRAME + 6))

    assert [len(samples) for samples in prob_calls] == [FRAME * 2]
    assert [probability for _, probability in processed] == [0.25, 0.75]
    assert processed[0][0] == [0.0] * (FRAME - 3) + [1.0] * 3
    assert processed[1][0] == [1.0] * FRAME
    assert closed == [(1, [0.25]), (2, [0.75])]
    assert lane.carry == [1.0, 1.0, 1.0]


def test_push_disables_a_failed_fake_vad_and_uses_energy_frames(monkeypatch) -> None:
    lane = _fake_lane(monkeypatch)
    processed: list[float | None] = []

    class FailingVad:
        def probs(self, samples: list[float]) -> None:
            return None

    def fake_frame(frame: list[float], speech_prob: float | None):
        processed.append(speech_prob)
        return None

    lane.vad = FailingVad()  # type: ignore[assignment]
    lane.frame = fake_frame  # type: ignore[method-assign]

    assert lane.push([1.0] * (FRAME * 2)) == []
    assert lane.vad is None
    assert processed == [None, None]
