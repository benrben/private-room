"""Tests for `arcelle_sidecar.rec.lanes` -- the Python port of
`src-tauri/src/recording.rs` lines 680-1169 (`SysLane`, `mic_failure_message`,
`Source`, `Lane`, `LaneLang`).

This is the merged FINAL test suite -- the union (deduplicated) of two
independent candidate test suites (`test_rec_lanes_candidate_a.py`/
`test_rec_lanes_candidate_b.py`, now deleted), which were themselves
cross-checked against each other by fuzzing both candidate implementations in
lockstep before this file was written (see `rec/lanes.py`'s own module
docstring "JUDGE NOTE" section for the fuzz methodology and its result: zero
behavioral divergence between the two candidates).

Most `Lane` tests run the ENERGY-FALLBACK path exclusively (`lane.vad = None`,
`speech_prob=None` throughout push()/frame()) -- exactly like the Rust
source's own `vad_finds_a_burst_between_silences` test -- so they exercise the
open/close STATE MACHINE without needing a real VAD model. Most use
constant-amplitude ("DC") blocks (a DC block's RMS == its own amplitude,
exactly, so the expected outcome of every threshold comparison is exactly
computable); one lifecycle test uses a real oscillating tone instead, mirror-
ing the Rust source's own test most literally.

A bonus test (`test_e2e_say_speech_opens_and_closes_real_phrases_via_the_real_vad`)
exercises the REAL Silero VAD ONNX model (`arcelle_sidecar.rec.vad.NeuralVad`)
against real `say`-synthesized speech, proving `Lane`'s VAD wiring end-to-end.
Skips cleanly if the cached model / `say` / `afconvert` are unavailable.

`LaneLang`'s suite below is a from-scratch Python re-derivation of the Rust
source's own test suite for the same struct (lines ~2852-3074 of
`recording.rs`) -- every branch it names, plus a few white-box checks
(`lock_votes`/`dissent` directly) to pin behavior the Rust suite only checks
indirectly through `hint()`.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import pytest

from arcelle_sidecar.media.decode import MediaKind, decode_to_pcm
from arcelle_sidecar.rec import vad as vad_module
from arcelle_sidecar.rec.lanes import (
    Active,
    Lane,
    LaneLang,
    Source,
    SysLane,
    mic_failure_message,
)
from arcelle_sidecar.rec.meta import (
    DIP_LOOKBACK,
    END_FRAMES,
    FRAME,
    LANE_RESYNC_GAP,
    MAX_SEGMENT,
    PARTIAL_EVERY,
    PREROLL,
    SAMPLE_RATE,
    START_FRAMES,
    VAD_OPEN,
    VAD_SUSTAIN,
)

# ------------------------------------------------------------------ helpers


def _dc(n: int, level: float) -> list[float]:
    """`n` samples of constant amplitude `level` -- a DC block's RMS is
    exactly `abs(level)`, so every threshold comparison below is exactly
    computable rather than merely bounded."""
    return [level] * n


def frame_of(amplitude: float, n: int = FRAME) -> list[float]:
    """A FRAME-sized (by default) constant-amplitude window."""
    return [amplitude] * n


def _sine_burst(n_samples: int, freq: float = 440.0, amp: float = 0.3) -> list[float]:
    """A real oscillating tone, for the one lifecycle test that mirrors the
    Rust source's own `vad_finds_a_burst_between_silences` most closely."""
    t = np.arange(n_samples) / SAMPLE_RATE
    return (np.sin(2 * np.pi * freq * t) * amp).tolist()


def bare_lane(base: int = 0) -> Lane:
    """A `Lane` with its VAD forced off, so `.frame(...)`/`.push(...)`
    exercise ONLY the energy-fallback path deterministically, regardless of
    whether some real Silero model happens to be reachable via the default
    fallback path on this machine."""
    lane = Lane(base)
    lane.vad = None
    return lane


def strong(lane: LaneLang, lang: str) -> None:
    """A well-evidenced final: long enough on both axes, confident detector --
    same helper (and name) as the Rust test suite's own `strong`."""
    lane.observe((lang, 0.9), 8, 400)


# ----------------------------------------------------------- Source / SysLane


def test_source_discriminants_and_as_str() -> None:
    assert Source.MIC.value == 0
    assert Source.SYS.value == 1
    assert Source.MIC.as_str() == "mic"
    assert Source.SYS.as_str() == "sys"


def test_syslane_values() -> None:
    assert SysLane.RECORDING.value == "recording"
    assert SysLane.STARTING.value == "starting"
    assert SysLane.OFF.value == "off"


# ----------------------------------------------------------- mic_failure_message


def test_mic_banner_only_promises_the_meeting_lane_when_it_is_really_running() -> None:
    """Port of the Rust source's own
    `the_mic_banner_only_promises_the_meeting_lane_when_it_is_really_running`."""
    live = mic_failure_message(SysLane.RECORDING, True)
    assert "the Mac's audio keeps recording" in live
    assert "nothing at all" not in live

    # Off, or refused by macOS: nothing is being captured, and the way out is
    # Stop.
    for ever_pushed in (True, False):
        dead = mic_failure_message(SysLane.OFF, ever_pushed)
        assert "nothing at all is being captured" in dead
        assert "keeps recording" not in dead
        assert "press Stop" in dead

    # Coming up is neither: claiming it is recording would be a promise,
    # claiming nothing is captured would scare the user off a session that is
    # about to be fine.
    starting = mic_failure_message(SysLane.STARTING, True)
    assert "still starting up" in starting
    assert "nothing at all" not in starting

    # The advice each lane state carries is still the advice the mic's own
    # history earns.
    assert "Pause and resume" in mic_failure_message(SysLane.OFF, True)
    assert "System Settings" in mic_failure_message(SysLane.OFF, False)
    assert "reconnect" not in mic_failure_message(SysLane.OFF, False)


def test_mic_failure_message_exact_strings() -> None:
    """Every literal, character for character (em dashes included) -- real
    user-facing copy, all six (`SysLane` x `ever_pushed`) combinations."""
    assert mic_failure_message(SysLane.RECORDING, True) == (
        "The microphone stopped sending audio — the Mac's audio keeps recording. "
        "Pause and resume to reconnect the microphone."
    )
    assert mic_failure_message(SysLane.STARTING, True) == (
        "The microphone stopped sending audio — the Mac's audio is still starting up. "
        "Pause and resume to reconnect the microphone."
    )
    assert mic_failure_message(SysLane.OFF, True) == (
        "The microphone stopped sending audio, and the Mac's audio is not being recorded "
        "— nothing at all is being captured. Pause and resume to reconnect the microphone. "
        "If that cannot be fixed, press Stop."
    )
    assert mic_failure_message(SysLane.RECORDING, False) == (
        "No microphone audio has arrived — the Mac's audio keeps recording. "
        "Check that a microphone is connected and that Arcelle is allowed to use it "
        "in System Settings → Privacy & Security → Microphone."
    )
    assert mic_failure_message(SysLane.STARTING, False) == (
        "No microphone audio has arrived — the Mac's audio is still starting up. "
        "Check that a microphone is connected and that Arcelle is allowed to use it "
        "in System Settings → Privacy & Security → Microphone."
    )
    assert mic_failure_message(SysLane.OFF, False) == (
        "No microphone audio has arrived, and the Mac's audio is not being recorded "
        "— nothing at all is being captured. Check that a microphone is connected and "
        "that Arcelle is allowed to use it in System Settings → Privacy & Security → "
        "Microphone. If that cannot be fixed, press Stop."
    )


# --------------------------------------------------------------- Lane: setup


def test_lane_new_has_the_expected_defaults() -> None:
    lane = Lane(1234)
    assert lane.ingested == 1234
    assert lane.pos == 1234
    assert lane.carry == []
    assert len(lane.ring) == 0
    assert lane.state is None
    assert lane.voiced_run == 0
    assert lane.floor == pytest.approx(2e-3)
    assert lane.level == 0.0
    assert lane.resync is True
    # `vad` must never raise during construction, whatever NeuralVad.new()
    # does internally -- either a real instance or None, never an exception.
    assert lane.vad is None or hasattr(lane.vad, "probs")


def test_vad_construction_failure_never_breaks_lane_construction(monkeypatch: pytest.MonkeyPatch) -> None:
    """A VAD problem must never prevent a `Lane` from existing -- forcibly
    make the VAD constructor raise and confirm `Lane(...)` still succeeds
    with `vad is None`."""
    import arcelle_sidecar.rec.lanes as lanes_mod

    def boom(*_a, **_k):
        raise RuntimeError("simulated VAD load failure")

    monkeypatch.setattr(lanes_mod.NeuralVad, "new", staticmethod(boom))
    lane = Lane(0)
    assert lane.vad is None


# ---------------------------------------------------------- Lane: write_floor


def test_write_floor_gate_and_saturation() -> None:
    lane = Lane(1000)
    assert lane.write_floor(1000) == 1000
    assert lane.write_floor(1000 + LANE_RESYNC_GAP - 1) == 1000
    assert lane.write_floor(1000 + LANE_RESYNC_GAP) == 1000 + LANE_RESYNC_GAP

    # head behind ingested: the gap saturates at 0, never negative.
    behind = Lane(5000)
    assert behind.write_floor(100) == 5000

    # resync=False always answers with `ingested`, whatever the gap.
    lane.resync = False
    assert lane.write_floor(1000 + LANE_RESYNC_GAP + 999) == 1000


def test_write_floor_a_lane_that_never_started_owes_nothing_below_the_head() -> None:
    """Port of the Rust unit test `a_lane_that_never_started_owes_nothing_
    below_the_head` -- `write_floor`/`resync_to`'s own documented contract."""
    head = SAMPLE_RATE * 61

    idle = bare_lane(0)
    assert idle.resync, "a fresh lane must start out waiting to re-anchor"
    assert idle.write_floor(head) == head

    live = bare_lane(0)
    live.resync = False
    live.ingested = head - SAMPLE_RATE // 5
    assert live.write_floor(head) == head - SAMPLE_RATE // 5

    fresh = bare_lane(0)
    assert fresh.write_floor(LANE_RESYNC_GAP - 1) == 0
    assert fresh.write_floor(LANE_RESYNC_GAP) == LANE_RESYNC_GAP

    resumed = bare_lane(SAMPLE_RATE * 5)
    assert resumed.write_floor(SAMPLE_RATE * 5) == SAMPLE_RATE * 5
    assert resumed.write_floor(head) == head


def test_resync_to_resets_position_and_buffers_but_not_the_resync_flag() -> None:
    lane = Lane(500)
    lane.carry = [1.0, 2.0]
    lane.ring.extend([1.0, 2.0, 3.0])
    lane.voiced_run = 7
    lane.resync = False  # deliberately non-default, to prove it survives untouched

    lane.resync_to(9000)

    assert lane.ingested == 9000
    assert lane.pos == 9000
    assert lane.carry == []
    assert len(lane.ring) == 0
    assert lane.voiced_run == 0
    assert lane.resync is False  # untouched by resync_to, per the Rust source


# --------------------------------------------------- Lane: open/close lifecycle


def test_open_close_phrase_lifecycle_energy_fallback_real_tone() -> None:
    """Port of the Rust source's own `vad_finds_a_burst_between_silences`:
    1 s silence, 1 s tone, 1.5 s silence -> exactly one phrase, starting near
    the 1 s mark and running roughly 1 s (+ pre-roll + up-to-hangover tail)."""
    lane = bare_lane(0)

    audio: list[float] = [0.0] * SAMPLE_RATE
    audio += _sine_burst(SAMPLE_RATE)
    audio += [0.0] * (SAMPLE_RATE * 3 // 2)

    closed: list[tuple[int, list[float]]] = []
    for i in range(0, len(audio), 1600):
        closed.extend(lane.push(audio[i : i + 1600]))

    assert len(closed) == 1, "exactly one phrase"
    start, samples = closed[0]
    assert SAMPLE_RATE - PREROLL <= start <= SAMPLE_RATE + FRAME * START_FRAMES
    assert SAMPLE_RATE // 2 <= len(samples) <= SAMPLE_RATE * 2, len(samples)


def test_open_close_lifecycle_energy_fallback_dc_blocks() -> None:
    """The full open -> grow -> close cycle via the energy-fallback path
    only (`speech_prob=None` throughout), with exact-RMS DC blocks so every
    length/content assertion below is exact, not merely bounded."""
    lane = bare_lane(1000)

    # Two voiced frames: not yet enough to open (START_FRAMES == 3).
    assert lane.frame(frame_of(0.5), None) is None
    assert lane.state is None
    assert lane.frame(frame_of(0.5), None) is None
    assert lane.state is None

    # Third consecutive voiced frame opens the phrase.
    assert lane.frame(frame_of(0.5), None) is None
    assert isinstance(lane.state, Active)
    assert lane.state.start == 1000
    assert len(lane.state.buf) == 3 * FRAME

    # More voiced audio just grows the open phrase.
    for _ in range(5):
        assert lane.frame(frame_of(0.5), None) is None
    assert len(lane.state.buf) == 8 * FRAME

    # END_FRAMES - 1 consecutive silent frames: still open.
    for _ in range(END_FRAMES - 1):
        assert lane.frame(frame_of(0.0), None) is None
    assert isinstance(lane.state, Active)

    # The END_FRAMES-th consecutive silent frame closes it.
    result = lane.frame(frame_of(0.0), None)
    assert result is not None
    start, audio = result
    assert start == 1000
    total_buf = 8 * FRAME + END_FRAMES * FRAME
    tail_keep = SAMPLE_RATE // 5
    expected_len = total_buf - (END_FRAMES * FRAME - tail_keep)
    assert len(audio) == expected_len
    # The trailing tail_keep samples are the kept slice of true silence.
    assert audio[-tail_keep:] == [0.0] * tail_keep
    # The leading samples are still the original voiced onset.
    assert audio[:FRAME] == [0.5] * FRAME
    assert lane.state is None
    assert lane.voiced_run == 0


def test_start_frames_hysteresis_a_single_dip_resets_the_run() -> None:
    lane = bare_lane(0)
    assert lane.frame(frame_of(0.5), None) is None
    assert lane.voiced_run == 1
    assert lane.frame(frame_of(0.5), None) is None
    assert lane.voiced_run == 2
    assert lane.state is None

    # One unvoiced dip resets the run entirely -- NOT a one-less-than-before
    # decrement.
    assert lane.frame(frame_of(0.0), None) is None
    assert lane.voiced_run == 0
    assert lane.state is None

    # Two more voiced frames: still short of a fresh run of START_FRAMES.
    assert lane.frame(frame_of(0.5), None) is None
    assert lane.frame(frame_of(0.5), None) is None
    assert lane.state is None

    # The third consecutive voiced frame (of this fresh run) finally opens it.
    assert lane.frame(frame_of(0.5), None) is None
    assert isinstance(lane.state, Active)


def test_start_frames_hysteresis_never_opens_on_a_brief_voiced_dip() -> None:
    """A repeated pattern that never reaches START_FRAMES consecutive voiced
    frames must never open a phrase, however many times it repeats."""
    lane = bare_lane(0)
    pattern = _dc(FRAME * (START_FRAMES - 1), 0.5) + _dc(FRAME, 0.0)
    for _ in range(5):
        closed = lane.push(pattern)
        assert closed == []
        assert lane.state is None, "voiced_run must never reach START_FRAMES"


def test_vad_probabilities_use_the_open_then_sustain_thresholds() -> None:
    """The trained-VAD path uses the stricter threshold while idle, then the
    sustain threshold after opening; the energy in these silent frames must
    not influence either decision."""
    lane = bare_lane(0)

    assert lane.frame(frame_of(0.0), VAD_OPEN - 0.01) is None
    assert lane.state is None
    for _ in range(START_FRAMES):
        assert lane.frame(frame_of(0.0), VAD_OPEN) is None
    assert isinstance(lane.state, Active)

    assert lane.frame(frame_of(0.0), VAD_SUSTAIN) is None
    assert lane.state.silent_frames == 0
    assert lane.frame(frame_of(0.0), VAD_SUSTAIN - 0.01) is None
    assert lane.state.silent_frames == 1


def test_end_frames_hysteresis_a_brief_dip_does_not_close_the_phrase() -> None:
    lane = bare_lane(0)
    for _ in range(START_FRAMES):
        lane.frame(frame_of(0.5), None)
    assert isinstance(lane.state, Active)

    # A brief silence (well under END_FRAMES) -- a mid-sentence breath.
    for _ in range(5):
        result = lane.frame(frame_of(0.0), None)
        assert result is None
    assert lane.state.silent_frames == 5

    # Speech resumes: the silent-frame count resets, the phrase stays open.
    result = lane.frame(frame_of(0.5), None)
    assert result is None
    assert lane.state.silent_frames == 0
    assert isinstance(lane.state, Active)

    # Only a FULL, uninterrupted run of END_FRAMES actually closes it.
    for _ in range(END_FRAMES - 1):
        assert lane.frame(frame_of(0.0), None) is None
    result = lane.frame(frame_of(0.0), None)
    assert result is not None
    assert lane.state is None


def test_end_frames_hysteresis_never_closes_on_repeated_brief_silent_dips() -> None:
    lane = bare_lane(0)
    opened = lane.push(_dc(FRAME * START_FRAMES, 0.5))
    assert opened == []
    assert lane.state is not None

    pattern = _dc(FRAME * (END_FRAMES - 1), 0.0) + _dc(FRAME, 0.5)
    for _ in range(5):
        closed = lane.push(pattern)
        assert closed == [], "a single voiced frame must reset silent_frames before END_FRAMES"
        assert lane.state is not None

    # Now really close it.
    closed = lane.push(_dc(FRAME * END_FRAMES, 0.0))
    assert len(closed) == 1
    assert lane.state is None


def test_preroll_survives_into_the_opened_phrase_unsaturated() -> None:
    """Audio just before the detected onset (the pre-roll ring) must be
    present at the front of the closed phrase's buffer, when the ring never
    even reached PREROLL capacity."""
    lane = bare_lane(0)
    marker = 0.0007  # a distinguishable, sub-threshold (unvoiced) amplitude
    n_marker_frames = 5

    for _ in range(n_marker_frames):
        assert lane.frame(frame_of(marker), None) is None
    assert lane.state is None  # still Idle -- these were unvoiced

    for _ in range(START_FRAMES):
        lane.frame(frame_of(0.5), None)
    assert isinstance(lane.state, Active)

    preroll_len = n_marker_frames * FRAME
    onset_len = START_FRAMES * FRAME
    assert len(lane.state.buf) == preroll_len + onset_len
    assert lane.state.buf[:preroll_len] == [marker] * preroll_len
    assert lane.state.buf[preroll_len:] == [0.5] * onset_len
    # The absolute start walks back by the whole drained pre-roll buffer.
    assert lane.state.start == 0


def test_preroll_survives_before_the_detected_onset_saturated() -> None:
    """Enough leading silence to fully saturate the pre-roll ring (`PREROLL`)
    before the burst starts; the closed phrase's buffer must still start
    well before the acoustic onset, with the leading silence intact."""
    lane = bare_lane(0)

    pre_silence_frames = 20  # 20*FRAME=10240 > PREROLL=8000: the ring saturates
    burst_frames = 5  # >= START_FRAMES, so the phrase opens partway through

    audio = _dc(FRAME * pre_silence_frames, 0.0) + _dc(FRAME * burst_frames, 0.5)
    lane.push(audio)
    assert lane.state is not None, "the burst must have opened a phrase"

    start, buf = lane.flush_active()

    silence_in_ring = PREROLL - FRAME * START_FRAMES
    expected_len = PREROLL + FRAME * (burst_frames - START_FRAMES)
    expected_start = pre_silence_frames * FRAME + START_FRAMES * FRAME - PREROLL

    assert start == expected_start
    assert len(buf) == expected_len
    assert buf == _dc(silence_in_ring, 0.0) + _dc(expected_len - silence_in_ring, 0.5)


def test_preroll_ring_caps_at_preroll_and_drops_the_oldest_first() -> None:
    lane = bare_lane(0)
    # Push far more unvoiced audio than PREROLL can hold, in two batches
    # with distinct, identifiable amplitudes.
    old_amp, new_amp = 0.0001, 0.0002
    n_old_frames = (PREROLL // FRAME) + 5  # already overflows the ring alone
    n_new_frames = 3
    for _ in range(n_old_frames):
        assert lane.frame(frame_of(old_amp), None) is None
    for _ in range(n_new_frames):
        assert lane.frame(frame_of(new_amp), None) is None

    for _ in range(START_FRAMES):
        lane.frame(frame_of(0.5), None)
    assert isinstance(lane.state, Active)

    buf = lane.state.buf
    # The ring can never hold more than PREROLL samples, no matter how much
    # unvoiced audio came before the phrase opened.
    assert len(buf) == PREROLL
    old_survivors = PREROLL - n_new_frames * FRAME - START_FRAMES * FRAME
    assert 0 < old_survivors < n_old_frames * FRAME, "test setup should partially, not fully, evict the old marker"
    assert buf.count(new_amp) == n_new_frames * FRAME
    assert buf.count(old_amp) == old_survivors
    # Order: oldest-surviving material first, then the newer marker, then
    # the voiced onset last.
    assert buf[:old_survivors] == [old_amp] * old_survivors
    assert buf[old_survivors : old_survivors + n_new_frames * FRAME] == [new_amp] * (n_new_frames * FRAME)
    assert buf[-(START_FRAMES * FRAME) :] == [0.5] * (START_FRAMES * FRAME)


def test_max_segment_forces_a_cut_at_the_quietest_window() -> None:
    """A single continuous voiced buffer, long enough to hit MAX_SEGMENT,
    with ONE deliberately quiet window planted well inside the DIP_LOOKBACK
    scan range. The forced cut must land at exactly that window's midpoint --
    not an arbitrary position -- and the remainder must survive as the still-
    open phrase."""
    assert MAX_SEGMENT % FRAME == 0, "test assumes a whole number of frames"
    total = MAX_SEGMENT

    scan_start = max(0, MAX_SEGMENT - DIP_LOOKBACK)
    # Frame-aligned to the scan's own grid (scan_start + k*FRAME), well
    # inside the scanned range and away from both its edges.
    quiet_begin = scan_start + FRAME * 20
    quiet_len = FRAME * 4
    quiet_end = quiet_begin + quiet_len
    assert quiet_end < total - FRAME, "leave loud audio after the dip too"

    audio = _dc(total, 0.5)
    audio[quiet_begin:quiet_end] = _dc(quiet_len, 0.0)

    lane = bare_lane(0)
    closed = lane.push(audio)

    assert len(closed) == 1, "the window limit must force exactly one cut"
    start, cut_audio = closed[0]
    assert start == 0
    cut = len(cut_audio)

    expected_cut = quiet_begin + FRAME // 2
    assert cut == expected_cut, "the cut must land at the quietest window's midpoint"

    assert lane.state is not None, "the remainder must survive as a still-open phrase"
    assert lane.state.start == cut
    assert len(lane.state.buf) == total - cut
    assert lane.state.partial_at == len(lane.state.buf)
    assert lane.state.silent_frames == 0
    # No samples lost or duplicated across the cut.
    assert cut_audio == audio[:cut]
    assert lane.state.buf == audio[cut:]


def test_max_segment_forced_cut_finds_the_quietest_window_at_the_exact_edge_of_dip_lookback() -> None:
    """Adversarial stress test: the earlier `test_max_segment_forces_a_cut_
    at_the_quietest_window` plants its dip a comfortable 20 frames inside the
    scanned range. Here the dip sits EXACTLY at `scan_start` -- the very
    first window the scan loop visits (`i == from_`, before any other
    window has had a chance to become `best`) -- and, in a second case,
    exactly the LAST full window the loop visits before the tail goes
    unscanned (`DIP_LOOKBACK` is not a whole multiple of `FRAME`, so a few
    trailing samples of the buffer are never scanned at all; this pins that
    boundary too). Both are real off-by-one traps: an implementation that
    started scanning at `from_ + FRAME` (skipping the first window) or
    stopped one window early would still pass the "comfortably in the
    middle" test above but fail here.
    """
    assert MAX_SEGMENT % FRAME == 0
    total = MAX_SEGMENT
    scan_start = max(0, MAX_SEGMENT - DIP_LOOKBACK)

    # -- Case 1: the dip IS the first window the scan visits.
    quiet_begin = scan_start
    quiet_end = quiet_begin + FRAME
    audio = _dc(total, 0.5)
    audio[quiet_begin:quiet_end] = _dc(FRAME, 0.0)

    lane = bare_lane(0)
    closed = lane.push(audio)
    assert len(closed) == 1
    _start, cut_audio = closed[0]
    assert len(cut_audio) == quiet_begin + FRAME // 2, "must find the dip even as the very first scanned window"

    # -- Case 2: the dip IS the last FULL window the scan visits (found by
    # walking the same grid the implementation itself walks, landing on
    # whichever full window abuts the unscanned tail).
    i = scan_start
    last_window_start = i
    while i + FRAME <= total:
        last_window_start = i
        i += FRAME
    assert last_window_start + FRAME < total, "test setup needs a real unscanned tail past the last window"

    audio2 = _dc(total, 0.5)
    audio2[last_window_start : last_window_start + FRAME] = _dc(FRAME, 0.0)
    lane2 = bare_lane(0)
    closed2 = lane2.push(audio2)
    assert len(closed2) == 1
    _start2, cut_audio2 = closed2[0]
    assert len(cut_audio2) == last_window_start + FRAME // 2, "must find the dip at the last fully-scanned window too"


def test_max_segment_cut_is_not_a_trivial_boundary_position() -> None:
    """A second geometry for the same forced-cut behavior, confirming the
    cut is neither the buffer's start nor its end (an off-by-one that always
    picked the FIRST or LAST scanned window would still pass a single-shape
    test)."""
    lane = bare_lane(0)
    loud, quiet = 0.5, 0.01
    total_frames = MAX_SEGMENT // FRAME
    assert total_frames * FRAME == MAX_SEGMENT

    lookback_frames = DIP_LOOKBACK // FRAME
    quiet_start_frame = total_frames - lookback_frames + 20
    quiet_len_frames = 20
    quiet_end_frame = quiet_start_frame + quiet_len_frames

    results: list[tuple[int, list[float]]] = []
    for k in range(total_frames):
        amp = quiet if quiet_start_frame <= k < quiet_end_frame else loud
        r = lane.frame(frame_of(amp), None)
        if r is not None:
            results.append(r)

    assert len(results) == 1, "expected exactly one forced cut, no early END_FRAMES close"
    start, audio = results[0]
    assert start == 0

    cut = len(audio)
    quiet_start_sample = quiet_start_frame * FRAME
    quiet_end_sample = quiet_end_frame * FRAME
    assert quiet_start_sample <= cut <= quiet_end_sample
    assert cut not in (0, MAX_SEGMENT)

    assert isinstance(lane.state, Active)
    assert lane.state.start == cut
    assert len(lane.state.buf) == MAX_SEGMENT - cut


# -------------------------------------------------------------- Lane: partial_due


def test_partial_due_is_none_when_idle_or_before_the_threshold() -> None:
    lane = bare_lane(0)
    assert lane.partial_due() is None  # idle

    lane.push(_dc(FRAME * START_FRAMES, 0.5))
    assert lane.state is not None
    assert lane.partial_due() is None, "far under PARTIAL_EVERY so far"


def test_partial_due_fires_at_partial_every_and_resets_the_cadence() -> None:
    lane = bare_lane(0)
    frames_needed = -(-PARTIAL_EVERY // FRAME)  # ceil division
    assert frames_needed * FRAME >= PARTIAL_EVERY
    lane.push(_dc(FRAME * frames_needed, 0.5))

    first = lane.partial_due()
    assert first is not None
    first_start, first_buf = first
    assert first_start == 0
    assert len(first_buf) == frames_needed * FRAME

    # Not due again immediately: the cadence was just reset.
    assert lane.partial_due() is None


def test_partial_due_snapshot_is_a_copy_not_a_view() -> None:
    """Mutating the lane (or the returned snapshot itself) after a partial
    must not retroactively change what was already returned."""
    lane = bare_lane(0)
    frames_needed = -(-PARTIAL_EVERY // FRAME)
    lane.push(_dc(FRAME * frames_needed, 0.5))

    _start, snapshot = lane.partial_due()
    snapshot_len = len(snapshot)

    lane.push(_dc(FRAME * 5, 0.5))
    assert len(snapshot) == snapshot_len, "later growth must not retroactively grow an old snapshot"

    snapshot.append(999.0)
    assert lane.state.buf[-1] != 999.0, "mutating our copy must not touch the lane's own buffer"


def test_partial_due_is_none_after_the_phrase_closes() -> None:
    lane = bare_lane(0)
    for _ in range(START_FRAMES):
        lane.frame(frame_of(0.5), None)
    for _ in range(END_FRAMES):
        lane.frame(frame_of(0.0), None)
    assert lane.state is None
    assert lane.partial_due() is None


# -------------------------------------------------------------- Lane: flush_active


def test_flush_active_on_an_idle_lane_returns_none() -> None:
    lane = bare_lane(0)
    assert lane.flush_active() is None
    assert lane.state is None


def test_flush_active_discards_a_too_short_open_phrase() -> None:
    lane = bare_lane(0)
    lane.push(_dc(FRAME * START_FRAMES, 0.5))  # opens with well under 0.2s
    assert lane.state is not None
    assert len(lane.state.buf) < SAMPLE_RATE // 5

    assert lane.flush_active() is None
    assert lane.state is None, "reset to idle either way"


def test_flush_active_keeps_a_phrase_at_the_0_2s_minimum() -> None:
    lane = bare_lane(0)
    min_samples = SAMPLE_RATE // 5
    frames_needed = max(-(-min_samples // FRAME), START_FRAMES)
    lane.push(_dc(FRAME * frames_needed, 0.5))
    assert len(lane.state.buf) >= min_samples

    start, buf = lane.flush_active()
    assert start == 0
    assert len(buf) == frames_needed * FRAME
    assert lane.state is None


# -------------------------------------------------------------------- Lane: push


def test_push_returns_empty_until_a_whole_frame_has_accumulated() -> None:
    lane = bare_lane(0)
    assert lane.push([0.5] * (FRAME - 1)) == []
    assert len(lane.carry) == FRAME - 1
    # One more sample completes the frame and it gets processed (but is only
    # 1 of 3 needed to open a phrase, so still nothing closes).
    assert lane.push([0.5]) == []
    assert lane.carry == []
    assert lane.voiced_run == 1


def test_push_permanently_drops_a_failing_vad() -> None:
    class _AlwaysFailsVad:
        def __init__(self) -> None:
            self.calls = 0

        def probs(self, fresh):
            self.calls += 1
            return None

    lane = Lane(0)
    fake = _AlwaysFailsVad()
    lane.vad = fake  # type: ignore[assignment]

    lane.push([0.5] * FRAME)
    assert lane.vad is None, "a probs() failure must drop the VAD for the rest of the lane's life"
    assert fake.calls == 1

    # Pushing more must NOT retry the now-dropped (failing) VAD.
    lane.push([0.5] * FRAME)
    assert fake.calls == 1


def test_push_carry_buffering_is_chunk_size_independent() -> None:
    """The SAME total audio, fed through `push()` in one big call vs. many
    ragged (non-FRAME-aligned) small calls, must produce identical closed
    phrases -- proving the sub-frame carry is buffered correctly across
    calls, not just within one."""
    amplitudes = [0.5] * START_FRAMES + [0.5] * 5 + [0.0] * END_FRAMES
    samples: list[float] = []
    for a in amplitudes:
        samples.extend([a] * FRAME)

    lane_a = bare_lane(500)
    closed_a = lane_a.push(samples)

    lane_b = bare_lane(500)
    closed_b: list[tuple[int, list[float]]] = []
    step = 137  # deliberately not a multiple of FRAME
    for i in range(0, len(samples), step):
        closed_b.extend(lane_b.push(samples[i : i + step]))

    assert len(closed_a) == 1
    assert closed_a == closed_b


# ------------------------------------------------------------------ LaneLang


def test_lanelang_fresh_lane_auto_detects() -> None:
    assert LaneLang().hint() is None


def test_lanelang_locks_on_first_evidenced_final() -> None:
    lane = LaneLang()
    assert lane.hint() is None, "a fresh lane auto-detects"
    strong(lane, "he")
    assert lane.hint() == "he"
    assert lane.lock_votes == 1

    # Word count alone is enough…
    by_words = LaneLang()
    by_words.observe(("he", 0.9), LaneLang.MIN_WORDS, 50)
    assert by_words.hint() == "he"
    # …and so is duration alone (one long word).
    by_dur = LaneLang()
    by_dur.observe(("he", 0.9), 1, LaneLang.MIN_DUR_CS)
    assert by_dur.hint() == "he"


def test_lanelang_weak_final_does_not_lock() -> None:
    lane = LaneLang()
    lane.observe(("en", 0.9), 2, 80)  # short and quick: not evidenced
    assert lane.hint() is None, "a two-word blip must not set the lock"
    strong(lane, "he")
    assert lane.hint() == "he"


def test_lanelang_unconfident_first_final_never_locks() -> None:
    lane = LaneLang()
    lane.observe(("en", LaneLang.MIN_LOCK_PROB - 0.01), words=10, dur_cs=500)
    assert lane.hint() is None
    assert lane.lock_votes == 0
    # The lane keeps auto-detecting until a confident final arrives…
    lane.observe(("he", LaneLang.MIN_LOCK_PROB), 8, 400)
    assert lane.hint() == "he", "…which locks it"


def test_lanelang_first_lock_needs_evidence_too_not_just_confidence() -> None:
    lane = LaneLang()
    # High confidence but NOT evidenced (short + brief).
    lane.observe(("en", 0.99), words=1, dur_cs=10)
    assert lane.hint() is None


def test_lanelang_same_language_repeat_bumps_lock_votes() -> None:
    lane = LaneLang()
    strong(lane, "he")
    assert lane.lock_votes == 1
    strong(lane, "he")
    assert lane.lock_votes == 2
    strong(lane, "he")
    assert lane.lock_votes == 3
    assert lane.hint() == "he"

    # A non-evidenced repeat of the SAME language: dissent clears (was
    # already None) but votes do not bump.
    lane.observe(("he", 0.9), words=1, dur_cs=10)
    assert lane.lock_votes == 3
    assert lane.hint() == "he"


def test_lanelang_single_unconfident_disagreement_does_not_perturb_anything() -> None:
    lane = LaneLang()
    strong(lane, "en")
    lane.observe(("he", LaneLang.MIN_SWITCH_PROB - 0.01), 10, 500)  # evidenced but too weak
    assert lane.hint() == "en"
    assert lane.dissent is None
    assert lane.lock_votes == 1
    assert lane.empty_streak == 0  # prob < MIN_SWITCH_PROB: not even an empty-final signal


def test_lanelang_single_confident_misdetection_is_absorbed() -> None:
    lane = LaneLang()
    strong(lane, "he")
    strong(lane, "en")  # one confident, well-evidenced final: still not believed
    assert lane.hint() == "he"
    strong(lane, "he")
    strong(lane, "en")
    assert lane.hint() == "he"


def test_lanelang_consecutive_confident_disagreements_accumulate_then_switch_at_exactly_switch_votes() -> None:
    lane = LaneLang()
    strong(lane, "he")
    strong(lane, "en")
    assert lane.hint() == "he", "one dissent vote must not switch yet"
    assert lane.dissent == ("en", 1)
    strong(lane, "en")
    assert lane.hint() == "en", "a genuine change re-locks at exactly SWITCH_VOTES"
    assert lane.dissent is None
    assert lane.lock_votes == 1


def test_lanelang_agreement_breaks_a_dissent_run() -> None:
    lane = LaneLang()
    strong(lane, "he")
    strong(lane, "en")
    strong(lane, "he")  # back to the locked language: dissent clears
    strong(lane, "en")
    assert lane.hint() == "he", "non-consecutive votes must not add up"


def test_lanelang_weak_disagreement_breaks_a_partial_dissent_streak() -> None:
    # Confident but short (not evidenced): no vote, and it breaks the run.
    lane = LaneLang()
    strong(lane, "he")
    strong(lane, "en")
    lane.observe(("en", 0.9), 2, 80)
    strong(lane, "en")
    assert lane.hint() == "he"

    # Long but unconfident: same.
    lane2 = LaneLang()
    strong(lane2, "he")
    strong(lane2, "en")
    lane2.observe(("en", 0.2), 8, 400)
    strong(lane2, "en")
    assert lane2.hint() == "he"

    # White-box: the next confident dissent starts a FRESH streak at 1.
    lane3 = LaneLang()
    strong(lane3, "he")
    strong(lane3, "en")
    assert lane3.dissent == ("en", 1)
    lane3.observe(("en", LaneLang.MIN_SWITCH_PROB - 0.01), 10, 500)
    assert lane3.dissent is None
    lane3.observe(("en", LaneLang.MIN_SWITCH_PROB), 10, 500)
    assert lane3.dissent == ("en", 1), "the broken streak must not have carried over"
    assert lane3.hint() == "he"


def test_lanelang_weak_disagreement_between_two_strong_ones_resets_not_ignores_the_streak() -> None:
    """Adversarial stress test named exactly per spec: a WEAK disagreement
    sandwiched between two STRONG (evidenced + confident) disagreement votes
    for the same challenger language. If the weak one were merely ignored
    (skipped over, count untouched) the two strong votes either side of it
    would total SWITCH_VOTES and flip the lock; the Rust source's own
    control flow says a weak/unconfident disagreement unconditionally clears
    `dissent`, so the run must restart at 1, not continue at 2 -- the lock
    must NOT switch.
    """
    lane = LaneLang()
    strong(lane, "he")
    assert lane.hint() == "he"

    strong(lane, "en")  # strong disagreement #1
    assert lane.dissent == ("en", 1)
    assert lane.hint() == "he", "a single strong dissent must never switch alone"

    # The weak one in the middle: evidenced but under MIN_SWITCH_PROB, for
    # the SAME challenger language "en" -- if this were ignored rather than
    # resetting, the next strong "en" below would complete a 2-vote streak.
    lane.observe(("en", LaneLang.MIN_SWITCH_PROB - 0.01), words=10, dur_cs=500)
    assert lane.dissent is None, "the weak vote must reset the streak, not merely be skipped"
    assert lane.hint() == "he"

    strong(lane, "en")  # strong disagreement #2 -- but the FIRST of a fresh streak
    assert lane.dissent == ("en", 1), "must restart at 1, not continue as if the weak vote never happened"
    assert lane.hint() == "he", "the switch must NOT have happened: the two strong votes were not consecutive"

    # Contrast: with no weak vote in between, the identical two strong votes
    # DO switch at exactly SWITCH_VOTES -- proving the weak vote above was
    # genuinely load-bearing, not incidental to some other reason the switch
    # didn't fire.
    control = LaneLang()
    strong(control, "he")
    strong(control, "en")
    strong(control, "en")
    assert control.hint() == "en", "two truly consecutive strong dissents must switch"


def test_lanelang_dissent_votes_must_agree_with_each_other() -> None:
    lane = LaneLang()
    strong(lane, "he")
    strong(lane, "en")
    strong(lane, "fr")  # a different stranger restarts the count
    assert lane.hint() == "he"
    strong(lane, "fr")
    assert lane.hint() == "fr"


def test_lanelang_confident_but_too_short_disagreement_counts_as_an_empty_final() -> None:
    """The Rust source's own described deadlock escape: a short-but-confident
    disagreement is treated as `note_empty_final`, not as a switch vote and
    not as a no-op."""
    lane = LaneLang()
    strong(lane, "en")
    assert lane.hint() == "en"

    for i in range(LaneLang.EMPTY_FINALS_TO_UNLOCK - 1):
        lane.observe(("he", LaneLang.MIN_SWITCH_PROB), words=1, dur_cs=10)  # NOT evidenced
        assert lane.hint() == "en", f"must still be locked after {i + 1} short confident dissents"
        assert lane.dissent is None, "this path is not a dissent vote"
        assert lane.empty_streak == i + 1

    # The final one reaches EMPTY_FINALS_TO_UNLOCK and unlocks fully.
    lane.observe(("he", LaneLang.MIN_SWITCH_PROB), words=1, dur_cs=10)
    assert lane.hint() is None
    assert lane.lock_votes == 0
    assert lane.empty_streak == 0


def test_lanelang_short_confident_dissents_unlock_a_dead_lock_and_agreeing_scraps_are_neutral() -> None:
    """The reviewer's residual deadlock: a wrong lock fed nothing but short
    phrases. Scraps can't vote, but confident other-language scraps now
    count toward the dead-final streak -- and agreeing scraps no longer
    reset it, so a dead lock can't be kept alive by fragments."""
    lane = LaneLang()
    strong(lane, "en")  # wrong lock: the meeting is (say) Hebrew
    for _ in range(LaneLang.EMPTY_FINALS_TO_UNLOCK):
        # 2 translated words, 1.2 s -- too short to vote, clearly the other language.
        lane.observe(("he", 0.8), 2, 120)
    assert lane.hint() is None, "all-short speech must still escape a wrong lock"

    # Agreeing scraps are neutral: they neither defend nor kill a lock.
    lane2 = LaneLang()
    strong(lane2, "he")
    lane2.note_empty_final()
    lane2.note_empty_final()
    lane2.observe(("he", 0.9), 2, 120)  # a scrap, agreeing
    lane2.note_empty_final()
    assert lane2.hint() is None, "a scrap must not reset the dead-final streak"


def test_lanelang_three_empty_finals_unlock_a_locked_lane() -> None:
    lane = LaneLang()
    strong(lane, "en")  # e.g. one English opener in a Hebrew meeting
    for _ in range(LaneLang.EMPTY_FINALS_TO_UNLOCK - 1):
        lane.note_empty_final()
        assert lane.hint() == "en", "the lock survives a short dead run"
    lane.note_empty_final()
    assert lane.hint() is None, "a locked lane eating every final must re-detect"
    assert lane.lock_votes == 0
    assert lane.dissent is None
    strong(lane, "he")
    assert lane.hint() == "he"


def test_lanelang_note_empty_final_is_a_noop_when_unlocked() -> None:
    lane = LaneLang()
    lane.note_empty_final()
    assert lane.hint() is None
    assert lane.empty_streak == 0


def test_lanelang_accepted_final_resets_the_empty_streak() -> None:
    lane = LaneLang()
    strong(lane, "he")
    lane.note_empty_final()
    lane.note_empty_final()
    strong(lane, "he")  # the lock is producing words again
    lane.note_empty_final()
    lane.note_empty_final()
    assert lane.hint() == "he", "non-consecutive dead finals must not add up"
    # Even a final with no usable detection proves the lock decodes words.
    lane.observe(None, 8, 400)
    lane.note_empty_final()
    lane.note_empty_final()
    assert lane.hint() == "he"
    lane.note_empty_final()
    assert lane.hint() is None


def test_lanelang_echo_retraction_undoes_a_lone_lock() -> None:
    lane = LaneLang()
    strong(lane, "en")  # the echo's vote -- nothing else supports it
    lane.retract("en")
    assert lane.hint() is None, "a lock resting on the echo alone must fall"
    assert lane.lock_votes == 0
    assert lane.empty_streak == 0

    lane2 = LaneLang()
    strong(lane2, "he")
    strong(lane2, "he")  # the room's own speech confirmed it
    lane2.retract("he")
    assert lane2.hint() == "he", "a confirmed lock survives one retraction"

    # Retracting a language that isn't the lock never touches it.
    lane3 = LaneLang()
    strong(lane3, "he")
    lane3.retract("en")
    assert lane3.hint() == "he"

    # Retracting with no language at all is also a no-op past clearing dissent.
    lane4 = LaneLang()
    strong(lane4, "he")
    strong(lane4, "en")
    lane4.retract(None)
    assert lane4.hint() == "he"
    assert lane4.dissent is None


def test_lanelang_retract_on_a_well_established_lock_only_clears_dissent() -> None:
    lane = LaneLang()
    strong(lane, "he")
    strong(lane, "he")
    assert lane.lock_votes == 2
    lane.observe(("en", LaneLang.MIN_SWITCH_PROB), 10, 500)
    assert lane.dissent == ("en", 1)

    lane.retract("he")

    assert lane.hint() == "he", "a lock backed by more than one vote survives retraction"
    assert lane.dissent is None
    assert lane.lock_votes == 2, "retract must not touch lock_votes on a survived lock"


def test_lanelang_empty_finals_on_an_unlocked_lane_mean_nothing() -> None:
    lane = LaneLang()
    for _ in range(10):
        lane.note_empty_final()  # silence and noise before anyone speaks
    assert lane.hint() is None
    strong(lane, "he")
    assert lane.hint() == "he", "the dead run must not poison the first lock"
    lane.note_empty_final()
    assert lane.hint() == "he", "pre-lock dead finals must not count post-lock"


def test_lanelang_observe_with_zero_words_is_a_full_noop_even_with_strong_detection() -> None:
    lane = LaneLang()
    strong(lane, "he")
    assert lane.lock_votes == 1
    lane.observe(("he", 0.99), words=0, dur_cs=500)
    assert lane.hint() == "he"
    assert lane.lock_votes == 1
    assert lane.dissent is None

    # And on a fresh (unlocked) lane, zero-words detections must not lock
    # anything either.
    fresh = LaneLang()
    fresh.observe(None, 8, 400)
    fresh.observe(("he", 0.9), 0, 400)
    assert fresh.hint() is None


def test_lanelang_empty_or_undetected_finals_change_nothing() -> None:
    lane = LaneLang()
    strong(lane, "he")
    strong(lane, "en")
    # No detection / no words: no information -- the run survives it (the
    # engine never even calls observe for junk finals).
    lane.observe(None, 8, 400)
    lane.observe(("en", 0.9), 0, 400)
    assert lane.hint() == "he"
    strong(lane, "en")
    assert lane.hint() == "en"


def test_lanelang_lanes_are_independent() -> None:
    mic = LaneLang()
    sys = LaneLang()
    strong(mic, "he")
    assert mic.hint() == "he"
    assert sys.hint() is None, "the other lane is untouched"
    strong(sys, "en")
    assert mic.hint() == "he"
    assert sys.hint() == "en"


# ------------------------------------------------------- real-VAD e2e (bonus)

VAD_ONNX_PATH = str(Path.home() / "Library" / "Caches" / "arcelle-sidecar" / "models" / "silero_vad.onnx")
_HAS_VAD_MODEL = Path(VAD_ONNX_PATH).exists()
_HAS_SAY = Path("/usr/bin/say").exists()
_HAS_AFCONVERT = Path("/usr/bin/afconvert").exists()
_HAS_MODEL_AND_TOOLS = _HAS_VAD_MODEL and _HAS_SAY and _HAS_AFCONVERT

requires_real_vad = pytest.mark.skipif(
    not _HAS_MODEL_AND_TOOLS,
    reason=f"requires the cached Silero VAD ONNX model at {VAD_ONNX_PATH} + macOS `say`/`afconvert`",
)


@pytest.fixture(autouse=True)
def _clean_vad_path_override():
    """`set_vad_model_path` mutates process-global state in the sibling `vad`
    module -- every test starts and ends with no override set."""
    vad_module._vad_model_path_override = None
    yield
    vad_module._vad_model_path_override = None


@requires_real_vad
def test_e2e_say_speech_opens_and_closes_real_phrases_via_the_real_vad(tmp_path: Path) -> None:
    """Full integration against the REAL Silero VAD (not the energy
    fallback) and REAL `say`-synthesized speech, wired through `Lane` exactly
    as production does (`NeuralVad.new()` at construction time, no
    monkeypatch): feed the utterance through `Lane.push()` in realistic small
    chunks and confirm at least one real phrase is detected and closed.
    """
    tmp_aiff = tmp_path / "say.aiff"
    proc = subprocess.run(
        ["/usr/bin/say", "-o", str(tmp_aiff), "the quick brown fox jumps over the lazy dog"],
        capture_output=True,
    )
    if proc.returncode != 0 or not tmp_aiff.exists():
        pytest.skip(f"`say` failed: {proc.stderr!r}")
    pcm = decode_to_pcm(tmp_aiff, MediaKind.AUDIO)
    assert pcm.shape[0] > SAMPLE_RATE, "decoded under a second of audio"

    vad_module.set_vad_model_path(VAD_ONNX_PATH)
    lane = Lane(0)
    assert lane.vad is not None, "the real cached VAD model should have loaded"

    audio: list[float] = [0.0] * SAMPLE_RATE  # 1s lead-in silence
    audio += np.asarray(pcm, dtype=np.float32).tolist()
    audio += [0.0] * SAMPLE_RATE  # 1s trailing silence, to close the phrase

    closed: list[tuple[int, list[float]]] = []
    chunk = SAMPLE_RATE // 10  # ~100 ms per push, like a real capture callback
    for i in range(0, len(audio), chunk):
        closed.extend(lane.push(audio[i : i + chunk]))
    tail = lane.flush_active()
    if tail is not None:
        closed.append(tail)

    assert closed, "the real Silero VAD never detected/closed a single phrase in real 'say' speech"
    for start, samples in closed:
        assert start >= 0
        assert len(samples) >= SAMPLE_RATE // 5
        assert max(abs(x) for x in samples) > 0.0, "a closed phrase must contain real signal"
