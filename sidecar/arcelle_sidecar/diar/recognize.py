"""Cross-recording speaker recognition -- naming a saved voice across
DIFFERENT recordings, days, microphones, and rooms.

Ported from the "Cross-recording recognition" section of
``src-tauri/src/recording/diarize.rs`` (lines 258-423): ``KNOWN_SAME``,
``KNOWN_MARGIN``, ``MIN_IDENTITY_FRAMES``, :class:`KnownVoice`,
:func:`identity_print`, :func:`raw_similarity`, :func:`vetoed`, and
:func:`recognize_groups`. The sibling per-print machinery
(:class:`~arcelle_sidecar.diar.embed.VoicePrint`, :func:`is_neural`,
:func:`cosine`) and the online evidence gate (``MIN_OPEN_FRAMES``) already
exist in the sibling modules and are imported from there rather than
redefined.

## Why the bar here is set ABOVE the within-session same-voice bar

Within a recording, a wrong same-voice merge self-corrects: the next
re-cluster (:func:`~arcelle_sidecar.diar.cluster.cluster`) re-derives every
group from scratch, from everything heard since. Across recordings, nothing
re-derives a name from last week -- a wrong cross-recording match is a real
person's name on somebody else's words, forever, with nothing downstream to
catch it. The cost of the two mistakes (missing a real match vs. naming the
wrong person) is not symmetric, so the bar is not the same one: ``KNOWN_SAME``
(0.72) is anchored on the neural space's measured "one person through ANY
channel" invariant (``NEURAL_GATES.raw_same`` == 0.69, the exact question
being asked across recordings) and then raised.

There is no labeled cross-recording voice-identity corpus on this machine (the
Rust source's own doc comments say the same: the sweep that would measure a
real false-accept rate at this bar is ``#[ignore]``d and unrun). So this bar
is DERIVED from ``raw_same``, not independently measured -- ported honestly
as such, not validated any harder than the Rust source itself claims to be.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .cluster import MIN_OPEN_FRAMES
from .embed import VoicePrint, cosine, is_neural

__all__ = [
    "KNOWN_SAME",
    "KNOWN_MARGIN",
    "MIN_IDENTITY_FRAMES",
    "KnownVoice",
    "identity_print",
    "raw_similarity",
    "vetoed",
    "recognize_groups",
]

# =============================================================================
# ---- Cross-recording recognition -------------------------------------------
#
# Deliberately NOT a field of Gates. A saved voice only ever exists in the
# neural space (see identity_print), so there is no second calibration to
# carry -- and one threshold that cannot be reached from the DSP path states
# that wall better than a DSP number nobody measured.
# =============================================================================

#: A saved voice is put on a group only when their RAW centroids agree at
#: least this strongly.
#:
#: Anchored on ``NEURAL_GATES.raw_same`` (0.69) -- the measured "one person
#: through ANY channel" invariant, which is exactly the question being asked
#: across recordings -- and then raised. Within a session, ``raw_same``
#: guards a merge that the next re-cluster re-derives from scratch; nothing
#: re-derives a name from last week. The cost of the two mistakes is not
#: symmetric, so neither is the bar.
#:
#: DERIVED from ``raw_same``, not measured: the false-accept rate at it -- the
#: rate at which a real person's name lands on somebody else's words -- is
#: unknown. No labeled cross-recording corpus exists on this machine to
#: measure it (see module docstring).
KNOWN_SAME: float = 0.72

#: How far the best saved voice must beat the runner-up. Two saved voices
#: this close to one group are not two candidates, they are one unanswered
#: question -- and "Speaker 2" is the honest answer to it. Also how far a
#: candidate must beat the counter-example the user corrected it with (see
#: :func:`vetoed`).
KNOWN_MARGIN: float = 0.04

#: Total voiced evidence (16 ms frames, ~= 2.5 s) a voice needs before it can
#: be saved or recognised across recordings -- the same bar the online
#: speaker book demands to open a new voice live (``MIN_OPEN_FRAMES``,
#: imported from :mod:`arcelle_sidecar.diar.cluster` rather than
#: redefined), which is the highest evidence bar in this module. Inside a
#: recording a thin voice is corrected by the next pass; across recordings
#: nothing corrects it.
MIN_IDENTITY_FRAMES: int = MIN_OPEN_FRAMES


@dataclass
class KnownVoice:
    """A voice the room has already been told the name of.

    Held in memory for the length of a recording (the room's table is read
    once, at start), so recognition costs one dot product per group per pass.
    """

    #: What the user calls this person.
    name: str = ""
    #: Their saved centroid -- L2-normalized, neural, and comparable raw.
    vec: list[float] | np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    #: Voices the user has said are NOT this person: each is the centroid of
    #: a group this name was guessed onto and then corrected. Without them a
    #: wrong match is wrong again in every future recording, because the
    #: correction only ever taught the OTHER name.
    rejects: list[np.ndarray] = field(default_factory=list)


def identity_print(prints: list[VoicePrint]) -> VoicePrint | None:
    """The one print that stands for a voice across recordings: the
    renormalized mean of every strong print in `prints`.

    Neural prints ONLY, and deliberately so -- this is the single print that
    outlives its recording, and the DSP fallback space shares no geometry
    with the neural one, so a saved DSP centroid could only ever be compared
    against something it may not be compared against. A room recorded
    without the model saves nobody, rather than saving something meaningless.

    ``None`` when the voice has not been heard for :data:`MIN_IDENTITY_FRAMES`
    of real speech across those prints: a name typed on half a sentence is a
    fine label for that recording and far too little to recognise anyone by
    later. Also ``None`` when the strong prints cancel out to a near-zero
    mean (the exact 1e-6 norm floor the Rust source uses): a vector that
    defines nothing is not a saved voice.
    """
    strong = [p for p in prints if is_neural(p.vec) and p.is_strong()]
    if not strong:
        return None
    dim = int(np.asarray(strong[0].vec).shape[0])
    frames = sum(p.voiced_frames for p in strong)
    if frames < MIN_IDENTITY_FRAMES:
        return None

    mean = np.zeros(dim, dtype=np.float64)
    for p in strong:
        mean += np.asarray(p.vec, dtype=np.float64)
    norm = float(np.sqrt(np.sum(mean * mean)))
    if norm < 1e-6:
        return None  # prints that cancel out define nothing
    mean = mean / norm
    return VoicePrint(vec=mean.astype(np.float32), voiced_frames=frames)


def raw_similarity(a: VoicePrint, b: VoicePrint) -> float | None:
    """What cross-recording recognition actually compares: the raw
    similarity of two saved voices, on the same terms :func:`recognize_groups`
    judges them. ``None`` when the prints are not comparable at all (either
    is not neural, or their lengths differ).

    Public for the acceptance bench, which has to measure the very quantity
    the threshold is set against -- a bench that re-implemented the
    comparison would be certifying its own copy of it.
    """
    if not (is_neural(a.vec) and is_neural(b.vec) and len(a.vec) == len(b.vec)):
        return None
    return cosine(np.asarray(a.vec), np.asarray(b.vec))


def vetoed(c: VoicePrint, k: KnownVoice, sim: float) -> bool:
    """Has the user already looked at this voice under this name and said no?

    The test is DISCRIMINATIVE -- closer to the counter-example than to the
    person -- rather than "close to the counter-example at all". The two
    voices a user had to tell apart are, by the nature of the mistake,
    similar to each other: a flat "anywhere near the thing you rejected" veto
    would take Dana's own voice down with the impostor's and she would never
    be recognised again. Correcting one guess must cost exactly that guess.

    Only rejects whose vector length matches `c` are consulted at all.
    """
    c_vec = np.asarray(c.vec)
    for r in k.rejects:
        r_vec = np.asarray(r)
        if r_vec.shape[0] != c_vec.shape[0]:
            continue
        if cosine(c_vec, r_vec) + KNOWN_MARGIN >= sim:
            return True
    return False


def recognize_groups(
    centroids: list[VoicePrint | None],
    known: list[KnownVoice],
    blocked: list[str],
) -> list[str | None]:
    """Put saved voices onto this recording's groups -- one name per group,
    one group per name.

    ``centroids[i]`` is group i's :func:`identity_print` (``None`` when the
    group has too little neural evidence to be recognised at all). `blocked`
    names are already spoken for by the USER on some other group, and a name
    the user typed is not a candidate -- it is already the answer.

    Greedy best-first over every admissible (group, name) pair, so the
    strongest agreement in the room is settled first: two people who each
    sound a little like one saved voice cannot claim it by accident of
    iteration order. A group whose top two candidates sit within
    :data:`KNOWN_MARGIN` of each other is named by nobody -- an ambiguous
    identity is not an identity.
    """
    out: list[str | None] = [None] * len(centroids)
    pairs: list[tuple[float, int, int]] = []

    for g, centroid in enumerate(centroids):
        if centroid is None or not is_neural(centroid.vec):
            continue
        c = centroid
        c_vec = np.asarray(c.vec)

        scored: list[tuple[float, int]] = []
        for i, k in enumerate(known):
            if len(k.vec) != len(c_vec) or not is_neural(k.vec):
                continue
            if k.name in blocked:
                continue
            sim = cosine(c_vec, np.asarray(k.vec))
            if sim < KNOWN_SAME:
                continue
            if vetoed(c, k, sim):
                continue
            scored.append((sim, i))
        scored.sort(key=lambda t: -t[0])

        if not scored:
            continue
        sim, best = scored[0]
        if len(scored) > 1 and (sim - scored[1][0]) < KNOWN_MARGIN:
            continue  # two people it could be -- so it is neither
        pairs.append((sim, g, best))

    pairs.sort(key=lambda t: -t[0])
    used: set[int] = set()
    for _sim, g, k in pairs:
        if out[g] is None:
            if k not in used:
                used.add(k)
                out[g] = known[k].name
    return out
