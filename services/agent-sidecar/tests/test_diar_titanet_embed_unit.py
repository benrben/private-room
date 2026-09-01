"""Fully fabricated TitaNet embedding adapter coverage."""

from __future__ import annotations

import numpy as np
import pytest

from arcelle_sidecar.diar import embed


class _FakeFbank:
    def __init__(self, frames: int) -> None:
        self.frames = frames
        self.received: np.ndarray | None = None

    def compute(self, samples: np.ndarray) -> tuple[int, np.ndarray]:
        self.received = samples
        features = np.arange(self.frames * embed.NBINS, dtype=np.float64)
        return self.frames, features


class _FakeSession:
    def __init__(self, output: np.ndarray | Exception) -> None:
        self.output = output
        self.calls: list[tuple[list[str], dict[str, np.ndarray]]] = []

    def run(self, names: list[str], inputs: dict[str, np.ndarray]) -> tuple[np.ndarray]:
        self.calls.append((names, inputs))
        if isinstance(self.output, Exception):
            raise self.output
        return (self.output,)


def _install(
    monkeypatch: pytest.MonkeyPatch, session: _FakeSession | None, fbank: _FakeFbank
) -> None:
    monkeypatch.setattr(embed, "_model_for", lambda _path: session)
    monkeypatch.setattr(embed, "_get_fbank", lambda: fbank)


def test_titanet_embed_returns_none_without_a_loaded_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fbank = _FakeFbank(3)
    _install(monkeypatch, None, fbank)

    assert embed.titanet_embed("fabricated.onnx", np.array([1.0])) is None
    assert fbank.received is None


def test_titanet_embed_refuses_too_few_feature_frames(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fbank = _FakeFbank(1)
    session = _FakeSession(np.ones(embed.EMB_DIM, dtype=np.float32))
    _install(monkeypatch, session, fbank)

    assert embed.titanet_embed("fabricated.onnx", np.array([1.0])) is None
    assert session.calls == []


def test_titanet_embed_normalizes_and_pads_fabricated_model_features(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fbank = _FakeFbank(3)
    session = _FakeSession(np.arange(1, embed.EMB_DIM + 1, dtype=np.float64))
    _install(monkeypatch, session, fbank)

    result = embed.titanet_embed("fabricated.onnx", np.array([1.25, -2.5]))

    assert result is not None
    assert result.shape == (embed.EMB_DIM,)
    assert result.dtype == np.float32
    assert float(np.linalg.norm(result)) == pytest.approx(1.0, abs=1e-6)
    assert fbank.received is not None and fbank.received.dtype == np.float32
    assert len(session.calls) == 1
    names, inputs = session.calls[0]
    assert names == ["embs"]
    assert inputs["length"].tolist() == [3]
    assert inputs["audio_signal"].shape == (1, embed.NBINS, 16)
    assert inputs["audio_signal"].dtype == np.float32
    assert np.all(inputs["audio_signal"][0, :, 3:] == 0.0)


def test_titanet_embed_does_not_pad_an_exact_sixteen_frame_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fbank = _FakeFbank(16)
    session = _FakeSession(np.ones((1, embed.EMB_DIM), dtype=np.float32))
    _install(monkeypatch, session, fbank)

    assert embed.titanet_embed("fabricated.onnx", np.array([0.0])) is not None
    _names, inputs = session.calls[0]
    assert inputs["audio_signal"].shape == (1, embed.NBINS, 16)
    assert np.any(inputs["audio_signal"][0, :, 15] != 0.0)


def test_titanet_embed_collapses_model_inference_and_shape_failures_to_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fbank = _FakeFbank(2)
    failed_session = _FakeSession(RuntimeError("fabricated inference failure"))
    _install(monkeypatch, failed_session, fbank)
    assert embed.titanet_embed("fabricated.onnx", np.array([0.0])) is None

    wrong_shape_session = _FakeSession(np.zeros(embed.EMB_DIM - 1, dtype=np.float32))
    _install(monkeypatch, wrong_shape_session, _FakeFbank(2))
    assert embed.titanet_embed("fabricated.onnx", np.array([0.0])) is None
