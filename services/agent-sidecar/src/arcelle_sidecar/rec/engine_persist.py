"""Persistence, echo detection, and event emission for Engine."""

from __future__ import annotations

import json
import time
from dataclasses import replace
from typing import TYPE_CHECKING, Any

import numpy as np

from arcelle_sidecar.media.wav import encode_wav
from arcelle_sidecar.rec.lanes import Source
from arcelle_sidecar.rec.meta import ECHO_OVERLAP, ECHO_SAME_TEXT, RecSegment, cs_of_samples, text_overlap, transcript_text

if TYPE_CHECKING:
    from arcelle_sidecar.rec.engine import PersistFailed, Save


def _facade_module() -> Any:
    from arcelle_sidecar.rec import engine

    return engine


class EnginePersistMixin:
    def _flush_metadata(self, save: Save) -> tuple[str, str, int]:
        if save is _facade_module().Save.CHECKPOINT:
            self.relabel_speakers()
        else:
            self.split_speakers()

        self.meta.duration_cs = cs_of_samples(self._mixed_len)
        head = self._mixed_len
        mark = _facade_module().checkpoint_mark(
            min(self.mic.write_floor(head), self.sys.write_floor(head)), head, self.flushed_samples
        )
        return transcript_text(self.meta), json.dumps(self.meta.to_dict()), mark

    def _flush_audio(self, save: Save, mark: int) -> tuple[bytes | None, np.ndarray | None]:
        if save is _facade_module().Save.FULL:
            return encode_wav(self.mixed), None
        if save is _facade_module().Save.CHECKPOINT and mark > self.flushed_samples:
            # A COPY, never a view: `persist` is awaited, and the range below
            # `mark` is exactly the range a lane that fell behind the resync bar
            # writes into next -- one candidate handed over a numpy view whose
            # bytes then changed under the port after the flush had returned.
            return None, np.array(self.mixed[self.flushed_samples : mark], copy=True)
        return None, None

    def _automatic_checkpoint_save(self, save: Save) -> bool:
        return save is _facade_module().Save.CHECKPOINT and not self.stopping

    def _should_report_flush_failure(self, save: Save) -> bool:
        if not self._automatic_checkpoint_save(save):
            return True
        if self.flush_failed_at is None:
            return True
        return (
            time.monotonic() - self.flush_failed_at
        ) >= _facade_module().FLUSH_RETRY_BACKOFF

    def _flush_failure_message(self, exc: Any) -> str:
        if self.stopping:
            return (
                f"Saving the recording failed ({exc.message}). "
                f"{_facade_module().SAVE_FAILED}"
            )
        return (
            f"Saving the recording failed ({exc.message}) — retrying; "
            "do not close the room."
        )

    def _record_flush_failure(self, save: Save, exc: PersistFailed) -> None:
        should_report = self._should_report_flush_failure(save)
        self.flush_failed_at = time.monotonic()
        if should_report:
            self.emit_error(self._flush_failure_message(exc))

    def _record_room_closed(self) -> None:
        # The room closed/switched under a live recording: stop quietly,
        # nothing may be written into a locked room.
        self.emit_error("The room closed — recording stopped.")
        if not self.stopping:
            self.stopping = True

    def _record_flush_success(self, save: Save, mark: int) -> None:
        self.flush_failed_at = None
        self.segments_since_flush = 0
        if save is _facade_module().Save.FULL:
            self.flushed_samples = self._mixed_len
        elif save is _facade_module().Save.CHECKPOINT:
            self.flushed_samples = mark
        # _facade_module().Save.TRANSCRIPT: nothing was written to the audio, so nothing became
        # durable.
        if save is _facade_module().Save.FULL:
            self.ports.emit("room-files-changed", {})

    async def flush(self, save: Save) -> bool:
        """Persist into the room. ``_facade_module().Save.FULL`` (pause/stop) assembles and
        writes the real WAV and clears the audio checkpoints;
        ``_facade_module().Save.CHECKPOINT`` APPENDS only the samples since the last save --
        rewriting an hour-long recording's whole WAV every minute meant ~115 MB
        re-encrypted per flush. A crash between full writes is recovered from
        the checkpoints when the room next opens.

        The transcript about to be written must carry the best labels the
        recording can support, not the provisional live ones. Stop/pause
        additionally run the split pass: the full mixed timeline is in hand, so
        phrases holding two voices become two labeled turns (ADD-28) -- a
        periodic save sticks to the cheap phrase relabel.
        """
        text, meta_json, mark = self._flush_metadata(save)
        wav, checkpoint_pcm = self._flush_audio(save, mark)

        try:
            await self.ports.persist(
                save, wav=wav, checkpoint_pcm=checkpoint_pcm, meta_json=meta_json, text=text
            )
        except _facade_module().PersistFailed as exc:
            # Disk full, deleted row, encryption trouble -- the audio is NOT
            # durable. Say so loudly, keep the un-flushed range marked dirty
            # (`flushed_samples` stays put) so the next flush retries the whole
            # tail, and keep recording in memory. There is no next flush during
            # the FINAL write, so that case must not promise a retry that will
            # never happen.
            #
            # ONCE PER OUTAGE, NOT ONCE PER BATCH -- but only for the automatic
            # save. Past the first minute of dirty audio the ingest trigger is
            # true for every 250 ms batch that arrives, so a failure that
            # persists (a full disk) emitted four of these a second and the UI
            # turned each one into its own toast. A save someone ASKED for --
            # pause, stop -- always answers, whatever the checkpoints have been
            # doing.
            self._record_flush_failure(save, exc)
            return False
        except _facade_module().RoomClosed:
            self._record_room_closed()
            return False

        self._record_flush_success(save, mark)
        return True

    # ------------------------------------------------------------------ echoes

    def echo_of(self, source: Source, t0: int, t1: int, text: str) -> int | None:
        """Index of the phrase the OTHER lane already captured for this same
        sound, if any. Newest-first, since an echo lands beside its original.
        The time-overlap guard is what rules out a sentence merely repeated
        later, so the scan needs no window of its own."""
        other = "sys" if source is Source.MIC else "mic"
        for i in range(len(self.meta.segments) - 1, -1, -1):
            s = self.meta.segments[i]
            if (
                s.source == other
                and _facade_module().time_overlap((s.t0, s.t1), (t0, t1))
                >= ECHO_OVERLAP
                and text_overlap(s.text, text) >= ECHO_SAME_TEXT
            ):
                return i
        return None

    def overlaps_sys_speech(self, t0: int, t1: int) -> bool:
        """Was the system lane carrying speech anywhere inside [t0, t1)? Checks
        finished sys segments (newest first, at most 50 SCANNED -- Rust's
        ``.rev().take(50).filter(..)``, so the cap is on segments looked at,
        not on sys segments found) AND the sys lane's still-open phrase --
        during a long monologue the overlapping sys phrase hasn't closed yet,
        which is exactly when the mic's mangled echo arrives."""
        if self._active_sys_overlaps(t0, t1):
            return True
        return self._recent_sys_overlaps(t0, t1)

    def _active_sys_overlaps(self, t0: int, t1: int) -> bool:
        """Check the open system phrase before closed-history rows."""
        active = self.sys.state
        if active is None:
            return False
        s0 = cs_of_samples(active.start)
        s1 = cs_of_samples(active.start + len(active.buf))
        return _facade_module().time_overlap((t0, t1), (s0, s1)) > 0.0

    def _recent_sys_overlaps(self, t0: int, t1: int) -> bool:
        """Inspect no more than the fifty newest history rows."""
        for checked, segment in enumerate(reversed(self.meta.segments)):
            if checked >= 50:
                return False
            if self._is_overlapping_sys_segment(segment, t0, t1):
                return True
        return False

    @staticmethod
    def _is_overlapping_sys_segment(segment: RecSegment, t0: int, t1: int) -> bool:
        return (
            segment.source == Source.SYS.as_str()
            and _facade_module().time_overlap((t0, t1), (segment.t0, segment.t1))
            >= 0.3
        )

    # ----------------------------------------------------------------- emit_*

    def emit_drop(self, seg_id: str) -> None:
        self.ports.emit("rec-segment-drop", {"fileId": self.cfg.file_id, "id": seg_id})

    def emit_partial(self, source: Source, t0: int, text: str) -> None:
        """The lane's live "still speaking…" line. An empty ``text`` clears
        it."""
        self.ports.emit(
            "rec-partial",
            {"fileId": self.cfg.file_id, "source": source.as_str(), "t0": t0, "text": text},
        )

    def emit_segment(self, seg: RecSegment) -> None:
        # WITHOUT THE VOICEPRINT. It is 192 floats -- around 3.8 KB of JSON per
        # phrase -- kept so the meeting can be re-clustered as it grows, and
        # nothing outside this process has any use for it: the frontend's own
        # `RecSegment` declares no `voice` field, so every byte of it was
        # decoded by the webview and dropped. The authoritative copy in
        # `self.meta.segments` keeps its print.
        self.ports.emit(
            "rec-segment",
            {"fileId": self.cfg.file_id, "segment": replace(seg, voice=None).to_dict()},
        )

    def emit_state(self) -> None:
        self.ports.emit(
            "rec-state",
            {
                "fileId": self.cfg.file_id,
                "status": self.status,
                "durationCs": cs_of_samples(self._mixed_len),
            },
        )

    def emit_save_progress(self, stage: str) -> None:
        """Progress of the stop -> saved drain, so the UI can name the phase
        instead of sitting on one static "Saving…" line. ``remaining`` counts
        the phrase decodes still queued; the audio itself is already durable
        (:meth:`begin_stop` checkpoints it before the first emit)."""
        remaining = len(self.final_queue) + int(self.decode_busy)
        self.ports.emit(
            "rec-save-progress",
            {"fileId": self.cfg.file_id, "stage": stage, "remaining": remaining},
        )

    def emit_source(self, source: str, status: str, message: str) -> None:
        # Durable first, event second: a viewer that mounts later reads the
        # health from `self.sources` instead of having missed the event.
        self.sources[0 if source == "mic" else 1] = (status, message)
        self.ports.emit(
            "rec-source",
            {"fileId": self.cfg.file_id, "source": source, "status": status, "message": message},
        )

    def emit_error(self, message: str) -> None:
        self.ports.emit("rec-error", {"fileId": self.cfg.file_id, "message": message})
