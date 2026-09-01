"""Audio ingest, decode integration, and speaker updates for Engine."""

from __future__ import annotations

import time
import uuid
from typing import TYPE_CHECKING, Any

import numpy as np

from arcelle_sidecar.diar.embed import VoicePrint
from arcelle_sidecar.diar.label import Naming
from arcelle_sidecar.media.wav import resample_to_16k
from arcelle_sidecar.rec.lanes import Lane, Source, SysLane
from arcelle_sidecar.rec.meta import (
    FLUSH_EVERY_SEGMENTS,
    LANE_RESYNC_GAP,
    MAX_SESSION_SAMPLES,
    SAMPLE_RATE,
    RecSegment,
    RecWord,
    cs_of_samples,
)

if TYPE_CHECKING:
    from arcelle_sidecar.rec.engine import DecodeJob, DecodeOut


def _facade_module() -> Any:
    from arcelle_sidecar.rec import engine

    return engine


class EngineIngestMixin:
    def _note_mic_ingest(self, source: Source) -> None:
        """Record an arriving microphone batch and clear its watchdog state."""
        if source is not Source.MIC:
            return
        self.last_mic_push = time.monotonic()
        self.mic_ever_pushed = True
        if self.mic_flagged:
            self.mic_flagged = False
            self.emit_source("mic", "on", "")

    def _resync_lane_for_ingest(self, lane: Lane, head: int) -> None:
        """Anchor a newly reopened lane when it has fallen behind the mix."""
        if not lane.resync:
            return
        lane.resync = False
        if head - lane.ingested >= LANE_RESYNC_GAP:
            lane.resync_to(head)

    async def _mix_ingested_pcm(self, at: int, pcm: np.ndarray) -> bool:
        """Mix a batch, or initiate the ceiling stop before it reaches memory."""
        need = at + int(pcm.size)
        if need > MAX_SESSION_SAMPLES:
            # Stop RIGHT HERE, not via a queued message: every batch already
            # sitting in the queue would otherwise trip the ceiling again and
            # pop its own copy of this error, and a user Stop racing them would
            # find the session already finished.
            self.emit_error("Recording reached the 3-hour session limit — stopping.")
            await self.begin_stop(None)
            return False
        self._grow_mixed(need)
        self._mixed_buf[at:need] += pcm
        return True

    def _dispatch_closed_phrases(
        self, source: Source, closed: list[tuple[int, list[float]]]
    ) -> None:
        """Queue closed VAD phrases when live STT is on, then start decode work."""
        if self.live_stt:
            for start, audio in closed:
                self.queue_final(source, start, audio)
        self.dispatch_next()

    def _checkpoint_is_backing_off(self) -> bool:
        """Whether a recent checkpoint failure still suppresses automatic retry."""
        return (
            self.flush_failed_at is not None
            and (time.monotonic() - self.flush_failed_at)
            < _facade_module().FLUSH_RETRY_BACKOFF
        )

    async def _checkpoint_audio_if_due(self) -> None:
        """Persist a minute-long dirty audio tail unless the retry clock is live.

        Crash safety cannot depend on segments existing: with live STT off (or a
        silent room) no segment ever lands, and the segment-count flush would
        leave hours of audio only in memory. Once the dirty tail is past a
        minute this is true for every batch, so a full disk must not trigger a
        full save attempt four times a second.
        """
        if self._checkpoint_is_backing_off():
            return
        if self._mixed_len - self.flushed_samples >= SAMPLE_RATE * 60:
            await self.flush(_facade_module().Save.CHECKPOINT)

    async def ingest(self, source: Source, rate: int, samples: np.ndarray) -> None:
        self._note_mic_ingest(source)
        pcm = resample_to_16k(samples, rate)

        # Mix into the shared timeline at the lane's own position. The lanes do
        # NOT start together -- the ScreenCaptureKit tap takes seconds to come
        # up, at the start of the session and again after every resume -- so a
        # lane opening after a real gap is re-anchored to the timeline's head
        # first. Without that, everything the meeting lane hears is filed
        # however many seconds late it was, growing with each resume.
        head = self._mixed_len
        lane = self._lane(source)
        self._resync_lane_for_ingest(lane, head)
        at = lane.ingested
        lane.ingested += int(pcm.size)

        if not await self._mix_ingested_pcm(at, pcm):
            return

        closed = lane.push(pcm)
        self._dispatch_closed_phrases(source, closed)
        self.duration_cs = cs_of_samples(self._mixed_len)
        await self._checkpoint_audio_if_due()

    def sys_lane(self) -> SysLane:
        """Is the Mac's audio actually being captured right now? Read from the
        tap state itself rather than from the setting, because "asked for" and
        "running" come apart for the seconds a tap needs to start and for good
        after one macOS refuses."""
        if not self.cfg.system_audio:
            return SysLane.OFF
        if self.sys_tap_up:
            return SysLane.RECORDING
        if self.sys_tap_starting:
            return SysLane.STARTING
        return SysLane.OFF

    # ---------------------------------------------------------------- decoding

    def queue_final(self, source: Source, start: int, audio: list[float] | np.ndarray) -> None:
        """Queue a closed phrase for its final decode, and retire the lane's
        live partial: the phrase it belonged to is over, so decoding that
        snapshot now would re-emit a "still speaking…" ghost line AFTER the
        real transcript row for the same words. Finals also outrank partials in
        :meth:`dispatch_next`, which is exactly how a pending partial could
        outlive its phrase."""
        self.drop_partial(source)
        self.last_final_start[source.value] = start
        self.final_queue.append(
            _facade_module().DecodeJob.final_job(source, start, np.asarray(audio, dtype=np.float32))
        )

    def drop_partial(self, source: Source) -> None:
        if self.partial_pending is not None and self.partial_pending.source is source:
            self.partial_pending = None

    def dispatch_next(self) -> None:
        if self.decode_busy:
            return
        job: DecodeJob | None
        if self.final_queue:
            job = self.final_queue.popleft()
        elif self.partial_pending is not None:
            job = self.partial_pending
            self.partial_pending = None
        else:
            return
        # Stamp the sticky language at DISPATCH, not enqueue: a queued final
        # must feel the lock the previous final just established.
        job.lang = self.lane_lang[job.source.value].hint()
        self.decode_busy = True
        self._job_queue.put_nowait(job)

    def close_open_phrases(self) -> None:
        for source in (Source.MIC, Source.SYS):
            flushed = self._lane(source).flush_active()
            if flushed is not None and self.live_stt:
                start, audio = flushed
                self.queue_final(source, start, audio)
            else:
                # Nothing left to say on this lane (or live transcription is
                # off) -- clear any live ghost.
                self.drop_partial(source)
                self.emit_partial(source, 0, "")
        self.dispatch_next()

    async def integrate(self, out: DecodeOut) -> None:
        self._report_decode_error(out)
        if out.kind is _facade_module().JobKind.PARTIAL:
            self._integrate_partial(out)
            return
        await self._integrate_final(out)

    def _report_decode_error(self, out: DecodeOut) -> None:
        # A phrase the speech engine choked on is not silence. Say so once -- a
        # model that cannot decode fails on every phrase, so one honest error
        # is the signal and a hundred is noise -- and never let the recording
        # quietly come out as "nobody spoke".
        if out.err is None or self.decode_error_reported:
            return
        self.decode_error_reported = True
        self.emit_error(
            f"The speech engine could not transcribe part of this recording ({out.err}). "
            "The audio is still being saved; you can rebuild the transcript later."
        )

    def _integrate_partial(self, out: DecodeOut) -> None:
        # A partial that was already in the decoder when live STT was switched
        # off would repaint the ghost line that switch just cleared -- and
        # nothing else would ever clear it again.
        if not self.live_stt:
            return
        # A partial that was already in the decoder when its phrase closed
        # describes words the transcript now shows for real.
        if self._partial_is_stale(out):
            return
        text = " ".join(s.text.strip() for s in out.segs if s.text.strip())
        self.emit_partial(out.source, cs_of_samples(out.start), text)

    def _partial_is_stale(self, out: DecodeOut) -> bool:
        last = self.last_final_start[out.source.value]
        return last is not None and out.start <= last

    async def _integrate_final(self, out: DecodeOut) -> None:
        text, words, lang, mean_p = _facade_module().merge_phrase(out.segs)
        # Clear this lane's ghost line even when the phrase decoded to nothing
        # (breath, keyboard clatter). A locked lane whose finals keep dying
        # here may be locked WRONG -- real speech forced through the wrong
        # language gets gated -- so the policy counts these and eventually
        # unlocks itself.
        if not text.strip():
            self._record_empty_final(out)
            return

        t0 = cs_of_samples(out.start)
        t1 = cs_of_samples(out.start + out.n_samples)
        # The microphone hears the Mac's speakers. When a mic phrase coincides
        # with meeting speech and decodes THIS badly, it is the meeting's echo
        # mangled by the room -- the degraded-echo case `echo_of` can't catch,
        # because garbled echo shares no words with what the system lane heard
        # cleanly ("Thank you." over and over is Whisper guessing at mush).
        # Real mic speech during crosstalk decodes far more confidently and
        # stays.
        if self._is_degraded_mic_echo(out, mean_p, t0, t1):
            self._clear_partial(out.source, t0)
            return
        # The microphone also hears the meeting through the speakers. Same
        # words, same moment, other lane: one utterance, not two. The system
        # lane wins -- it cannot hear the room, so whatever reaches it is what
        # the computer actually played.
        if self._drop_mic_echo(out, t0, t1, text):
            return

        # Only a final that actually enters the transcript votes on the lane's
        # sticky language -- junk and echoes never do.
        self.lane_lang[out.source.value].observe(out.detected, len(words), t1 - t0)

        seg = self._new_segment(out, t0, t1, text, words, lang)
        self._insert_segment(seg, out.wins)
        self._queue_live_translation(seg)
        await self._record_integrated_segment()

    def _record_empty_final(self, out: DecodeOut) -> None:
        self.emit_partial(out.source, cs_of_samples(out.start), "")
        self.lane_lang[out.source.value].note_empty_final()

    def _is_degraded_mic_echo(self, out: DecodeOut, mean_p: float, t0: int, t1: int) -> bool:
        return out.source is Source.MIC and mean_p < 0.35 and self.overlaps_sys_speech(t0, t1)

    def _clear_partial(self, source: Source, t0: int) -> None:
        self.emit_partial(source, t0, "")

    def _drop_mic_echo(self, out: DecodeOut, t0: int, t1: int, text: str) -> bool:
        twin = self.echo_of(out.source, t0, t1, text)
        if twin is None:
            return False
        if out.source is Source.MIC:
            self._clear_partial(out.source, t0)
            return True
        self._remove_echoed_mic(twin)
        return False

    def _remove_echoed_mic(self, twin: int) -> None:
        echoed = self.meta.segments.pop(twin)
        self.win_cache.pop(echoed.id, None)
        self.emit_drop(echoed.id)
        # The dropped row was meeting audio, not the room: any language vote it
        # cast on the mic lane was pollution.
        self.lane_lang[Source.MIC.value].retract(echoed.lang)

    def _new_segment(
        self,
        out: DecodeOut,
        t0: int,
        t1: int,
        text: str,
        words: list[RecWord],
        lang: str | None,
    ) -> RecSegment:
        # Provisional only: `relabel` re-derives every label, including this
        # one, from all the voices heard so far.
        speaker = "You" if out.source is Source.MIC else self.book.assign(out.emb)
        return RecSegment(
            id=str(uuid.uuid4()),
            source=out.source.as_str(),
            speaker=speaker,
            t0=t0,
            t1=t1,
            text=text,
            words=words,
            lang=lang,
            voice=out.emb,
        )

    def _insert_segment(
        self, seg: RecSegment, wins: list[tuple[int, int, VoicePrint]]
    ) -> None:
        # Keep the transcript ordered by time even when a slow mic phrase lands
        # after a quick system one.
        at = 0
        for i in range(len(self.meta.segments) - 1, -1, -1):
            if self.meta.segments[i].t0 <= seg.t0:
                at = i + 1
                break
        if wins:
            self.win_cache[seg.id] = wins
        self.meta.segments.insert(at, seg)
        self.emit_segment(seg)

    def _queue_live_translation(self, seg: RecSegment) -> None:
        if self.live_translate is not None:
            # Never blocking: the engine also carries the audio, so a slow
            # translator must fall behind on its own and drop lines, not stall
            # the recording. What it drops is the OLDEST waiting line.
            self.translate_tx.push(seg, self.live_translate)

    async def _record_integrated_segment(self) -> None:
        self.segments_since_flush += 1
        # Re-cluster from time to time so the speakers sort themselves out
        # DURING the conversation, not only at the end -- but on a schedule
        # that backs off as the pass gets expensive, since this is also what
        # mixes the incoming audio.
        self._relabel_when_due()
        if self.segments_since_flush >= FLUSH_EVERY_SEGMENTS:
            await self.flush(_facade_module().Save.CHECKPOINT)

    def _relabel_when_due(self) -> None:
        self.relabel_countdown = max(0, self.relabel_countdown - 1)
        if self.relabel_countdown == 0:
            self.relabel_speakers()

    # --------------------------------------------------------------- speakers

    def split_speakers(self) -> None:
        """The stop/pause voice pass: split phrases at their voice changes
        using the sub-window prints collected while decoding (segments without
        a cache entry -- resumed history, pieces from an earlier pause -- are
        re-embedded from the mixed timeline on the spot). No UI event here:
        every caller persists the meta right after and the UI reloads it
        whole."""
        model_diar = self.cfg.diarize_model_path or ""

        def wins_for(seg: RecSegment) -> list[tuple[int, int, VoicePrint]]:
            cached = self.win_cache.get(seg.id)
            if cached is not None:
                return cached
            i0 = max(seg.t0, 0) * (SAMPLE_RATE // 100)
            i1 = min(max(seg.t1, 0) * (SAMPLE_RATE // 100), self._mixed_len)
            if i1 <= i0:
                return []
            return _facade_module().window_prints(self.mixed[i0:i1], seg.t0, model_diar)

        naming = Naming(
            names=self.meta.speaker_names, recognized=self.meta.recognized, known=self.known
        )
        _facade_module().split_by_voice(
            self.meta.segments, self.meta.max_speakers, naming, wins_for
        )

    def relabel_speakers(self) -> None:
        """Re-derive every meeting speaker from the whole recording's voices
        and, when a label moved -- or a saved voice was recognised -- tell the
        UI so the transcript on screen corrects itself mid-conversation. Times
        itself and schedules the next pass accordingly."""
        began = time.monotonic()
        naming = Naming(
            names=self.meta.speaker_names, recognized=self.meta.recognized, known=self.known
        )
        moved = _facade_module().relabel(
            self.meta.segments, self.meta.max_speakers, naming
        )
        self.relabel_countdown = _facade_module().relabel_interval(
            int((time.monotonic() - began) * 1000)
        )
        if not moved:
            return
        labels = [{"id": s.id, "speaker": s.speaker} for s in self.meta.segments]
        names = self.meta.speaker_names
        # The overlay rides along: a pass can change what a voice is CALLED
        # without moving a single label (a saved voice recognised mid-meeting),
        # and a payload of labels alone would leave that on screen only after
        # the next full reload. Sorted, like the `BTreeMap`/`BTreeSet` Rust
        # serializes here.
        self.ports.emit(
            "rec-relabel",
            {
                "fileId": self.cfg.file_id,
                "labels": labels,
                "speakerNames": {k: names[k] for k in sorted(names)},
                "recognized": sorted(self.meta.recognized),
            },
        )

    # ------------------------------------------------------------------ saving
