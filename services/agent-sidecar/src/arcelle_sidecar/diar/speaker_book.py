"""Live, provisional speaker assignment between full reclusters."""

from __future__ import annotations

import re

import numpy as np

from .cluster_constants import AUTO_MAX_SPEAKERS, MIN_OPEN_FRAMES, MIN_UPDATE_FRAMES
from .embed import Gates, VoicePrint, cosine, gates_for

class SpeakerBook:
    """The **provisional** live label for a phrase, produced the instant it
    is transcribed: nearest known voice, or a new one when nothing is close
    and the phrase is long enough to be sure. Deliberately simple and a
    little conservative -- :func:`cluster` revisits the whole recording on
    every flush and corrects these labels with the benefit of everything
    heard since.

    **The number of participants is discovered, not declared.**
    """

    def __init__(self, max_speakers: int = AUTO_MAX_SPEAKERS) -> None:
        self.max_speakers: int = max(1, min(max_speakers, AUTO_MAX_SPEAKERS))
        # Speakers already named in a resumed file. New voices are numbered
        # after them (their centroids are not persisted, so they cannot be
        # re-matched).
        self.base: int = 0
        # (running centroid, phrase count) per opened voice.
        self.centroids: list[list] = []

    @classmethod
    def auto(cls) -> "SpeakerBook":
        """Discover however many people are in the meeting (the normal
        case)."""
        return cls(AUTO_MAX_SPEAKERS)

    @classmethod
    def with_cap(cls, max_speakers: int) -> "SpeakerBook":
        """Pin the participant count -- used when a caller genuinely knows
        it (e.g. a one-on-one), which collapses stray voices onto the
        nearest."""
        return cls(max_speakers)

    def seed_labels(self, existing_speaker_labels: list[str]) -> None:
        """On resume, keep numbering after the speakers already in the
        file. Those voices can't be re-identified (no persisted centroids),
        so a returning speaker may get a fresh number.

        Ported without depending on a ``RecSegment`` type (that model
        doesn't exist yet in this migration): takes plain "Speaker N"-shaped
        label strings instead of Rust's slice of ``RecSegment``, extracting
        the same max-N-plus-one base logic. Rust's
        ``s.speaker.strip_prefix("Speaker ")?.parse::<usize>().ok()``
        requires the ENTIRE remainder after the prefix to be a bare
        non-negative integer (no sign, no whitespace) -- mirrored here with
        a strict ``^[0-9]+$`` match rather than Python's more permissive
        ``str.isdigit()`` (which also accepts non-ASCII digit characters
        Rust's parser would reject).
        """
        best = 0
        for label in existing_speaker_labels:
            if not label.startswith("Speaker "):
                continue
            rest = label[len("Speaker ") :]
            if re.fullmatch(r"[0-9]+", rest):
                n = int(rest)
                if n > best:
                    best = n
        self.base = min(best, self.max_speakers - 1)

    def room_left(self) -> int:
        """How many distinct voices this session may still open."""
        return max(self.max_speakers - self.base, 1)

    def _nearest_centroid(self, emb: np.ndarray) -> tuple[int, float] | None:
        """Return the most similar existing centroid, preferring the last tie."""
        best: tuple[int, float] | None = None
        for i, (centroid, _count) in enumerate(self.centroids):
            similarity = cosine(emb, centroid)
            if best is None or similarity >= best[1]:
                best = (i, similarity)
        return best

    def _may_open_voice(self, print: VoicePrint) -> bool:
        """Whether this phrase has enough evidence to create a live voice."""
        return len(self.centroids) < self.room_left() and print.voiced_frames >= MIN_OPEN_FRAMES

    def _open_voice(self, emb: np.ndarray) -> int:
        """Record an unobserved voice and return its new centroid index."""
        self.centroids.append([np.array(emb, copy=True), 0])
        return len(self.centroids) - 1

    def _speaker_index(self, nearest: tuple[int, float] | None, g: Gates, print: VoicePrint, emb: np.ndarray) -> int:
        """Choose the existing nearest speaker or deliberately open a new one."""
        if nearest is None:
            return self._open_voice(emb)

        idx, similarity = nearest
        if similarity >= g.online_same:
            return idx
        if similarity < g.online_new and self._may_open_voice(print):
            return self._open_voice(emb)
        return idx

    @staticmethod
    def _can_update_centroid(centroid: np.ndarray, count: int, emb: np.ndarray, print: VoicePrint) -> bool:
        """Keep early, sufficiently long, dimension-compatible evidence only."""
        return count > 0 and print.voiced_frames >= MIN_UPDATE_FRAMES and len(centroid) == len(emb)

    @staticmethod
    def _updated_centroid(centroid: np.ndarray, count: int, emb: np.ndarray) -> np.ndarray:
        """Apply the capped running mean used by online diarization."""
        weight = float(min(count, 20))
        updated = (centroid * weight + emb) / (weight + 1.0)
        norm = max(float(np.sqrt(np.sum(updated * updated))), 1e-6)
        return updated / norm

    def _record_assignment(self, idx: int, emb: np.ndarray, print: VoicePrint) -> None:
        """Count the phrase and update its centroid when its evidence warrants it."""
        centroid, count = self.centroids[idx]
        if self._can_update_centroid(centroid, count, emb, print):
            centroid = self._updated_centroid(centroid, count, emb)
        self.centroids[idx] = [centroid, count + 1]

    def assign(self, print: VoicePrint | None) -> str:  # noqa: A002 - matches Rust field name
        if print is None or print.is_silent():
            return f"Speaker {self.base + 1}"

        emb = np.asarray(print.vec, dtype=np.float64)
        g = gates_for(emb)

        idx = self._speaker_index(self._nearest_centroid(emb), g, print, emb)
        self._record_assignment(idx, emb, print)

        return f"Speaker {self.base + idx + 1}"
