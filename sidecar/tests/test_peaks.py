"""Tests for arcelle_sidecar.media.peaks, ported 1:1 from the Rust test
module in src-tauri/src/commands/peaks.rs (`#[cfg(test)] mod tests`).

Float exact-equality assertions in Rust become explicit epsilon checks here,
matching the epsilon the Rust tests themselves used (1e-6 for the burst
normalization, 0.01 for "did not become loud").
"""

from __future__ import annotations

import numpy as np

from arcelle_sidecar.media.peaks import (
    DEFAULT_BUCKETS,
    MAX_BUCKETS,
    NOISE_FLOOR,
    cache_key,
    describe_decode_error,
    envelope,
    is_silent,
)


def test_module_constants_match_the_rust_source() -> None:
    assert DEFAULT_BUCKETS == 2000
    assert MAX_BUCKETS == 8000
    assert NOISE_FLOOR == 0.01


def test_an_envelope_follows_the_loud_parts() -> None:
    # Silence, then a loud burst, then silence again.
    samples = np.zeros(300, dtype=np.float32)
    samples[100:200] = 0.5
    env = envelope(samples, 3)
    assert len(env) == 3
    assert env[0] < 0.01, f"the quiet opening became loud: {env!r}"
    assert abs(env[1] - 1.0) < 1e-6, f"the burst should normalize to 1: {env!r}"
    assert env[2] < 0.01, f"the quiet tail became loud: {env!r}"


def test_a_mean_would_have_flattened_this_but_a_max_does_not() -> None:
    # One loud sample in a bucket of 100 IS an audible transient.
    samples = np.zeros(100, dtype=np.float32)
    samples[50] = 1.0
    result = envelope(samples, 1)
    assert list(result) == [1.0]


def test_silence_is_not_amplified_into_noise() -> None:
    # Normalizing by the loudest moment would turn dither into a full
    # waveform and make an empty recording look like speech.
    env = envelope(np.full(1000, 0.0005, dtype=np.float32), 4)
    assert all(v < 0.01 for v in env), f"silence was amplified: {env!r}"


def test_buckets_cover_every_sample_and_never_run_past_the_end() -> None:
    # A length that divides badly used to be the classic off-by-one here.
    for length in (1, 7, 999, 1001):
        for buckets in (1, 3, 64, 2000):
            env = envelope(np.full(length, 0.25, dtype=np.float32), buckets)
            assert len(env) == buckets, f"len={length} buckets={buckets}"


def test_a_silent_track_is_reported_as_silent_and_a_quiet_one_is_not() -> None:
    # The waveform lane draws flat for both a silent file and a file whose
    # peaks never arrived; only this flag lets the viewer tell the user
    # which one it is looking at.
    assert is_silent(envelope(np.zeros(1000, dtype=np.float32), 8)), "digital silence"
    assert is_silent(
        envelope(np.full(1000, 0.0005, dtype=np.float32), 8)
    ), "dither is not signal"
    # A QUIETLY recorded meeting is signal: envelope normalizes it to 1.0,
    # and calling that "silent" would be a worse lie than saying nothing.
    assert not is_silent(
        envelope(np.full(1000, 0.03, dtype=np.float32), 8)
    ), "a quiet meeting is audible"
    # Nothing decoded at all is the viewer's "no readable audio" case, not
    # a claim about the content.
    assert not is_silent(np.array([], dtype=np.float32))


def test_a_missing_audio_track_reads_as_a_sentence_not_as_converter_stderr() -> None:
    assert (
        describe_decode_error("no readable audio track: avconvert: error: nope")
        == "This video has no audio track this Mac can read."
    )
    # Anything else keeps its own words — the detail is the only clue.
    assert (
        describe_decode_error("audio decode failed: bad file")
        == "audio decode failed: bad file"
    )


def test_a_recording_that_grew_cannot_hit_its_old_envelope() -> None:
    """The waveform after "Continue recording" was the pre-continuation one:
    the key could not tell the grown file from the file it used to be, and
    every mark drawn against the cached `duration` sat at the wrong moment.
    """
    before = cache_key("rec-1", 2000, 4_000_044)
    assert before == cache_key("rec-1", 2000, 4_000_044), "same audio, same key"
    assert before != cache_key("rec-1", 2000, 9_100_044), "a continued recording"
    # The two things the key always separated still separate.
    assert before != cache_key("rec-1", 4000, 4_000_044)
    assert before != cache_key("rec-2", 2000, 4_000_044)


def test_nothing_in_nothing_out() -> None:
    assert envelope(np.array([], dtype=np.float32), 10).size == 0
    assert envelope(np.array([0.5, 0.5], dtype=np.float32), 0).size == 0
