"""Voiceprint value types and embedding-space comparison rules."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

EMB_DIM: int = 192
MIN_NEW_VOICE_FRAMES: int = 62


@dataclass
class VoicePrint:
    """One phrase's normalized voiceprint and its voiced-frame evidence."""

    vec: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    voiced_frames: int = 0

    def is_silent(self) -> bool:
        return self.voiced_frames == 0 or bool(np.all(self.vec == 0.0))

    def defines_voice(self, min_frames: int) -> bool:
        """Whether the print has enough non-silent evidence to define a voice."""
        return self.voiced_frames >= min_frames and not self.is_silent()

    def is_strong(self) -> bool:
        """Whether the print meets the phrase-scale evidence threshold."""
        return self.defines_voice(MIN_NEW_VOICE_FRAMES)


@dataclass(frozen=True)
class Gates:
    """Clustering constants calibrated for one embedding space."""

    split: float
    center: bool
    raw_same: float
    online_same: float
    online_new: float


DSP_GATES = Gates(
    split=0.65,
    center=False,
    raw_same=0.85,
    online_same=0.35,
    online_new=0.10,
)

NEURAL_GATES = Gates(
    split=0.36,
    center=True,
    raw_same=0.69,
    online_same=0.40,
    online_new=0.20,
)


def is_neural(v: np.ndarray | list[float]) -> bool:
    """Whether a print belongs to the 192-dimensional neural space."""
    return len(v) == EMB_DIM


def gates_for(v: np.ndarray | list[float]) -> Gates:
    return NEURAL_GATES if is_neural(v) else DSP_GATES


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    """Compare same-generation prints, preserving legacy DSP compatibility."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if is_neural(a) != is_neural(b):
        return 0.0
    if a.shape[0] == b.shape[0]:
        return float(np.dot(a, b))
    n = min(a.shape[0], b.shape[0])
    ap, bp = a[:n], b[:n]
    dot = float(np.dot(ap, bp))
    na = float(np.sqrt(np.sum(ap * ap)))
    nb = float(np.sqrt(np.sum(bp * bp)))
    return dot / max(na * nb, 1e-6)
