"""Lifecycle, message dispatch, and stop handling for the recording engine."""

from __future__ import annotations

import asyncio
import contextlib
import copy
import time
from typing import TYPE_CHECKING, Any

import numpy as np

from arcelle_sidecar.rec.lanes import Lane, Source, mic_failure_message
from arcelle_sidecar.rec.meta import RecMeta, cs_of_samples

if TYPE_CHECKING:
    from arcelle_sidecar.rec.engine import EngineMsg, EngineOutcome, MsgAudio, MsgDecodeDone, MsgEditMeta, MsgPause, MsgResume, MsgSetLiveStt, MsgSetLiveTranslate, MsgStop, MsgSysTapResult


def _facade_module() -> Any:
    from arcelle_sidecar.rec import engine

    return engine


class EngineLifecycleMixin:
    @property
    def mixed(self) -> np.ndarray:
        """The mixed timeline so far -- Rust's ``Vec<f32>``, as a ``float32``
        view onto a growth buffer.

        Neither candidate's representation survived the 3-hour ceiling this
        module's own constant enforces. Appending with ``np.concatenate``
        copies the whole timeline on every 250 ms batch (measured: 1.7 ms/batch
        at the start of a session, 16.9 ms/batch 30 simulated minutes in, and
        the engine thread also mixes the incoming audio). Holding the samples
        in a Python ``list[float]`` is flat in time but costs ~5.5 GB at the
        ceiling -- eight times the "~230 MB/h of f32" the Rust source's own
        comment budgets for, because every sample becomes a boxed ``PyFloat``.

        So: a ``float32`` buffer with GEOMETRIC growth, which is what
        ``Vec::resize`` does natively -- amortized O(1) per batch, 691 MB at
        the ceiling, and every consumer (``encode_wav``, ``window_prints``,
        slicing for a checkpoint) gets a real array with no conversion. The
        view is writable, so ``self.mixed[at:at + n] += batch`` mixes in place.
        """
        return self._mixed_buf[: self._mixed_len]

    @mixed.setter
    def mixed(self, samples: np.ndarray) -> None:
        """Replace the whole timeline (resume, or a test standing one up)."""
        arr = np.asarray(samples, dtype=np.float32).reshape(-1)
        self._mixed_buf = np.array(arr, dtype=np.float32, copy=True)
        self._mixed_len = int(arr.size)

    def _grow_mixed(self, need: int) -> None:
        """Extend the timeline to ``need`` samples of silence -- Rust's
        ``self.mixed.resize(need, 0.0)``, with ``Vec``'s own doubling."""
        if need <= self._mixed_len:
            return
        if need > self._mixed_buf.size:
            new_cap = max(need, int(self._mixed_buf.size) * 2, _facade_module()._MIXED_MIN_CAPACITY)
            grown = np.zeros(new_cap, dtype=np.float32)
            grown[: self._mixed_len] = self._mixed_buf[: self._mixed_len]
            self._mixed_buf = grown
        # Newly exposed capacity starts at silence, whether it was just
        # allocated or was already held in reserve.
        self._mixed_buf[self._mixed_len : need] = 0.0
        self._mixed_len = need

    # ------------------------------------------------------------------ plumbing

    def send(self, msg: EngineMsg) -> None:
        """Push an inbound message -- what a real audio callback / IPC handler
        calls; :meth:`run` drains this queue.

        Once :meth:`run` has returned nobody drains it any more, so a message
        carrying a reply future is ANSWERED here rather than parked in a queue
        that will never be read (:meth:`_answer_orphan`)."""
        if self._ended:
            self._answer_orphan(msg)
            return
        self.inbox.put_nowait(msg)

    def _answer_orphan(self, msg: EngineMsg) -> None:
        """Answer a reply future the run loop will never reach -- a message
        still queued when :meth:`run` returned, or handed to :meth:`send`
        afterwards.

        RUST GETS THIS FOR FREE AND THIS PORT DOES NOT. ``Engine::run`` ends by
        letting its thread end, which drops the ``mpsc::Receiver`` and with it
        the ``Sender`` inside every message still sitting in the channel. So
        ``rec_stop``'s ``done_rx.recv()`` -- which has *deliberately no
        deadline* ("the wait ends when the engine answers or when the engine is
        gone", recording_cmds.rs) -- returns ``Err`` at once and falls back to
        ``stop_verdict(&shared)``, i.e. to the verdict :meth:`finish` left in
        ``RecShared.outcome``. An ``asyncio.Future`` has no such hang-up
        signal: left unanswered it stays pending FOR EVER, and the caller
        waiting on it hangs on a recording that saved perfectly.

        That is not a rare race. The run loop handles exactly ONE message
        before it re-checks whether it is stopped and drained, so a Stop
        enqueued behind the batch that trips the 3-hour ceiling (or behind the
        checkpoint that discovers the room closed) is ALWAYS left over --
        exactly the "Stop that arrives after the engine already stopped itself"
        the Rust source keeps ``outcome`` around for.

        A Stop is therefore answered from :attr:`outcome`, which is precisely
        what ``stop_verdict`` reads; anything else carrying a reply future is
        told the engine is gone."""
        done = getattr(msg, "done", None)
        if done is None:
            return
        if isinstance(msg, _facade_module().MsgStop):
            self._settle(done, self._orphan_stop_result())
            return
        self._settle(done, RuntimeError(_facade_module().ENGINE_GONE))

    def _orphan_stop_result(self) -> "RecMeta | Exception":
        """Match the final Stop reply to the recorded engine outcome."""
        outcome = self.outcome
        if outcome is not None and outcome.ok and outcome.meta is not None:
            return copy.deepcopy(outcome.meta)
        error = outcome.error if outcome is not None else None
        return RuntimeError(error or _facade_module().ENGINE_GONE)

    def _drain_orphans(self) -> None:
        """Answer every reply future still queued. Called once, by :meth:`run`,
        the moment its loop ends -- the port's stand-in for Rust's engine
        thread ending and taking the channel with it."""
        while True:
            try:
                msg = self.inbox.get_nowait()
            except asyncio.QueueEmpty:
                return
            self._answer_orphan(msg)

    async def aclose(self) -> None:
        """Tear down the background ``asyncio.Task``s this engine owns (the
        decode worker, the live-translate worker). Python's tasks, unlike
        Rust's threads, do not exit on their own when their queue is dropped --
        this is the explicit replacement for that. Safe to call more than once;
        :meth:`run` calls it itself after :meth:`finish`."""
        tasks, self._background_tasks = self._background_tasks, []
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task

    def _lane(self, source: Source) -> Lane:
        return self.mic if source is Source.MIC else self.sys

    async def _decode_worker(self) -> None:
        """The decoder lane: one task, one Whisper call at a time, results fed
        back through :attr:`inbox` (as a :class:`MsgDecodeDone`) so ``Engine``
        stays the single owner of ordering and state."""
        while True:
            job = await self._job_queue.get()
            out = await asyncio.to_thread(
                _facade_module()._run_decode_job, self.cfg.model_path, self.cfg.diarize_model_path, job
            )
            self.inbox.put_nowait(_facade_module().MsgDecodeDone(out))

    # ---------------------------------------------------------------- run loop

    async def run(self) -> EngineOutcome | None:
        """Drain :attr:`inbox` with a ~100 ms timeout, ``handle()`` per message
        and ``tick()`` on timeout, until stopped and drained -- Rust's
        ``Engine::run``, which then lets its thread end; here the background
        tasks are closed instead (:meth:`aclose`).

        Returns the session's verdict for convenience -- the same object
        :attr:`outcome` holds. A FAILED final save is reported there and on the
        Stop reply future, never by raising out of a task nobody may be
        awaiting. ``None`` would mean the loop ended without finishing, which
        is unreachable while :meth:`handle` always returns ``False`` (as Rust's
        does).
        """
        await self._start_run()
        while not await self._run_once():
            pass
        await self._close_run()
        return self.outcome

    async def _start_run(self) -> None:
        """Start optional system capture, then publish the initial recording state."""
        if self.cfg.system_audio:
            await self.start_sys_tap()
        self.emit_state()

    async def _run_once(self) -> bool:
        """Handle one inbound message or timer tick; ``True`` ends the loop."""
        msg = await self._next_run_message()
        if msg is not None and await self.handle(msg):
            return True
        self.tick()
        if await self._finish_if_drained():
            return True
        await self._flush_paused_tail_if_ready()
        return False

    async def _next_run_message(self) -> EngineMsg | None:
        """Wait one UI cadence for work, using ``None`` for an idle tick."""
        try:
            return await asyncio.wait_for(self.inbox.get(), timeout=0.1)
        except asyncio.TimeoutError:
            return None

    async def _finish_if_drained(self) -> bool:
        """Finish once a stopping engine has no final decode left to integrate."""
        if not self._stopped_and_drained():
            return False
        await self.finish()
        return True

    def _stopped_and_drained(self) -> bool:
        """Whether stopping may safely perform the final persistence step."""
        return (
            self.stopping
            and not self.decode_busy
            and not self.final_queue
            and self.partial_pending is None
        )

    async def _flush_paused_tail_if_ready(self) -> None:
        """Persist a pause's final decoded words after its original WAV save."""
        if not self._paused_tail_is_ready():
            return
        self.pause_pending = False
        await self.flush(_facade_module().Save.TRANSCRIPT)

    def _paused_tail_is_ready(self) -> bool:
        """Whether the pause follow-up has no outstanding decode work."""
        return (
            self.pause_pending
            and self.paused
            and not self.decode_busy
            and not self.final_queue
        )

    async def _close_run(self) -> None:
        """Settle messages no loop can read, then close owned background tasks."""
        self._ended = True
        self._drain_orphans()
        await self.aclose()

    async def handle(self, msg: EngineMsg) -> bool:
        """The single entry point every state mutation goes through. The return
        value means exactly what Rust's does (``True`` = stop the run loop) --
        Rust's own ``handle`` always returns ``False`` (every branch falls
        through to a hardcoded ``false``), which this port keeps literally
        rather than inventing a stop condition Rust never wired up."""
        handler = self._message_handlers.get(type(msg))
        if handler is not None:
            await handler(msg)
        return False

    async def _handle_audio(self, msg: MsgAudio) -> None:
        if not self.paused and not self.stopping:
            await self.ingest(msg.source, msg.rate, msg.samples)

    async def _handle_sys_tap_result(self, msg: MsgSysTapResult) -> None:
        self.sys_tap_starting = False
        if not msg.ok:
            self.emit_source("sys", "error", _facade_module()._sys_tap_error(msg.error))
            return
        # Never keep two taps: a second one would record and transcribe the
        # meeting twice, and the one we dropped would go on capturing for the
        # rest of the session.
        if self.stopping or self.paused or self.sys_tap_up:
            await self.ports.stop_sys_tap()
            return
        self.sys_tap_up = True
        self.emit_source("sys", "on", "")

    async def _handle_live_translate(self, msg: MsgSetLiveTranslate) -> None:
        self.live_translate = msg.lang

    async def _handle_live_stt(self, msg: MsgSetLiveStt) -> None:
        self.live_stt = msg.on
        if msg.on:
            return
        # The open phrases are abandoned (their audio already sits on the
        # mixed timeline), so turning back on decodes NEW phrases only -- and
        # the ghost lines leave the screen now.
        self.partial_pending = None
        self.mic.flush_active()
        self.sys.flush_active()
        for source in (Source.MIC, Source.SYS):
            self.emit_partial(source, 0, "")

    async def _handle_pause(self, _msg: MsgPause) -> None:
        self.paused = True
        self.close_open_phrases()
        # Force-closing can truncate a phrase into an empty final;
        # "consecutive dead finals" must not span a pause.
        for lane_lang in self.lane_lang:
            lane_lang.empty_streak = 0
        await self.stop_sys_tap()
        # The sentence Pause just closed is still decoding; the run loop saves
        # again when it lands (see `pause_pending`).
        self.pause_pending = self.decode_busy or bool(self.final_queue)
        await self.flush(_facade_module().Save.FULL)
        self.status = "paused"
        self.emit_state()

    async def _handle_resume(self, _msg: MsgResume) -> None:
        self.paused = False
        self.pause_pending = False
        self.last_mic_push = time.monotonic()
        # Neither lane is producing sound yet, and the meeting tap takes
        # seconds to come back: both re-anchor to the timeline head on their
        # first batch instead of resuming where they stopped.
        self.mic.resync = True
        self.sys.resync = True
        if self.cfg.system_audio:
            await self.start_sys_tap()
        self.status = "recording"
        self.emit_state()

    async def _handle_stop(self, msg: MsgStop) -> None:
        await self.begin_stop(msg.done)

    async def _handle_edit_meta(self, msg: MsgEditMeta) -> None:
        # Edit the authoritative copy, then persist it NOW rather than at the
        # next scheduled flush: a rename the user can see on screen but that a
        # crash in the next few seconds would lose is not saved, and this is
        # the one write path that can promise it is.
        try:
            error = msg.apply(self.meta)
        except Exception as exc:  # noqa: BLE001 -- apply's contract is Result-shaped
            # Rust's `apply` returns `Result`, so it cannot unwind; a Python
            # callable can, and letting it out of `handle` would kill the run
            # loop and with it the whole recording.
            error = str(exc)
        if error is not None:
            self._settle(msg.done, RuntimeError(error))
            return
        # The flush's own success/failure is deliberately discarded (Rust's
        # `let _ = self.flush(...)`) -- the reply reports only whether `apply`
        # itself succeeded.
        await self.flush(_facade_module().Save.CHECKPOINT)
        if msg.done is not None:
            # The meta that was actually STORED, so the calling command answers
            # with it rather than with what it hoped for.
            self._settle(msg.done, copy.deepcopy(self.meta))

    async def _handle_decode_done(self, msg: MsgDecodeDone) -> None:
        self.decode_busy = False
        await self.integrate(msg.out)
        self.dispatch_next()
        if self.stopping:
            self.emit_save_progress("transcribing")

    @staticmethod
    def _settle(fut: "asyncio.Future[RecMeta] | None", result: "RecMeta | Exception") -> None:
        """Answer a reply future, if there is one and it is still waiting. Rust
        sends into an ``mpsc::Sender`` and ignores the result (``let _ =
        done.send(..)``) -- a receiver that hung up is not this engine's
        problem. A Python future that was already cancelled or resolved raises
        ``InvalidStateError`` on ``set_result``, which would otherwise escape
        ``handle``/``finish`` and kill the run loop."""
        if fut is None or fut.done():
            return
        if isinstance(result, Exception):
            fut.set_exception(result)
        else:
            fut.set_result(result)

    def tick(self) -> None:
        """The ~100 ms partial-check/level-emit logic Rust's ``run()`` calls on
        every loop timeout. Purely synchronous -- ``ports.emit`` is
        fire-and-forget, so nothing here needs to await."""
        if self.paused or self.stopping:
            return
        self._flag_dead_microphone()
        if self.live_stt:
            self._queue_live_partials()
        self.dispatch_next()
        self._emit_level_if_due()

    def _flag_dead_microphone(self) -> None:
        """Report one true no-input microphone outage without flagging silence."""
        # Mic frames arrive ~4x/s while the tap lives (even muted or silent --
        # disabled tracks still deliver zeros). Six seconds of nothing means
        # the tap is dead, not quiet.
        if not self.mic_flagged and (time.monotonic() - self.last_mic_push) >= 6:
            self.mic_flagged = True
            message = mic_failure_message(self.sys_lane(), self.mic_ever_pushed)
            self.emit_source("mic", "error", message)

    def _queue_live_partials(self) -> None:
        """Keep only the newest due partial across the two capture lanes."""
        for source in (Source.MIC, Source.SYS):
            due = self._lane(source).partial_due()
            if due is not None:
                start, part_samples = due
                # Only the newest partial matters; a stale one is dropped
                # rather than queued behind finals.
                self.partial_pending = _facade_module().DecodeJob(
                    kind=_facade_module().JobKind.PARTIAL,
                    source=source,
                    start=start,
                    samples=np.asarray(part_samples, dtype=np.float32),
                )

    def _emit_level_if_due(self) -> None:
        """Emit and decay the two peak meters at their UI cadence."""
        if (time.monotonic() - self.last_level_emit) >= 0.2:
            self.last_level_emit = time.monotonic()
            self.ports.emit(
                "rec-level",
                {
                    "fileId": self.cfg.file_id,
                    "mic": self.mic.level,
                    "sys": self.sys.level,
                    "durationCs": cs_of_samples(self._mixed_len),
                },
            )
            self.mic.level *= 0.5
            self.sys.level *= 0.5

    # -------------------------------------------------------------- lifecycle

    async def begin_stop(self, done: "asyncio.Future[RecMeta] | None") -> None:
        """Begin the stop -> saved drain. ``done`` is the Stop command's reply
        future when a user pressed Stop, ``None`` when the engine stopped
        itself (the 3-hour ceiling, the room closing under it). Idempotent: a
        second call only adopts a reply future, so a Stop that races a
        self-stop is still answered instead of finding a finished engine."""
        if self.stopping:
            if done is not None:
                self.stop_reply = done
            return
        self.close_open_phrases()
        await self.stop_sys_tap()
        self.partial_pending = None
        self.pause_pending = False
        self.stopping = True
        self.stop_reply = done
        self.status = "saving"
        self.emit_state()
        # Make the audio bytes durable NOW, before the transcript tail finishes
        # decoding: a checkpoint append is cheap, and it lets the UI truthfully
        # say "your audio is saved" the moment Stop is pressed instead of after
        # a possibly-long decode drain.
        await self.flush(_facade_module().Save.CHECKPOINT)
        self.emit_save_progress("transcribing")

    async def finish(self) -> None:
        """The final write, then the terminal state. The order matters: saying
        "saved" before knowing whether the write worked put a green badge next
        to a red error. A failed final write ends the session as "failed" --
        still terminal (the session entry clears, the chip goes away), just not
        a lie."""
        self.emit_save_progress("writing")
        saved = await self.flush(_facade_module().Save.FULL)
        # The result is kept here too: an engine that stopped itself (the
        # 3-hour ceiling) has nobody to answer, and a Stop arriving afterwards
        # would otherwise see a dead engine and report a timeout for a
        # recording that saved perfectly.
        self.outcome = _facade_module().EngineOutcome(
            ok=saved,
            meta=copy.deepcopy(self.meta) if saved else None,
            error=None if saved else _facade_module().SAVE_FAILED,
        )
        self.status = "saved" if saved else "failed"
        self.emit_state()
        reply, self.stop_reply = self.stop_reply, None
        if reply is not None:
            # A failed final write must fail the STOP, not smile through it.
            self._settle(reply, copy.deepcopy(self.meta) if saved else RuntimeError(_facade_module().SAVE_FAILED))

    async def start_sys_tap(self) -> None:
        """Request the renderer-owned meeting-audio tap. Bringing one up takes
        seconds (permission + capture start); pausing and resuming inside that
        window must not request a second one -- the meeting would be recorded
        and transcribed twice."""
        if self.sys_tap_up or self.sys_tap_starting:
            return
        self.sys_tap_starting = True
        await self.ports.request_sys_tap()

    async def stop_sys_tap(self) -> None:
        """Release the tap -- and ONLY when one is actually up. Rust's whole
        body is ``if let Some(tap) = self.sys_tap.take() { tap.stop(); }``: with
        no tap there is nothing to stop, and signalling the renderer anyway
        (which one candidate did) sends a release for a capture that was never
        started -- on every pause and stop of a microphone-only recording. A
        tap still COMING UP is not this case either: it is torn down when it
        arrives, by the ``MsgSysTapResult`` arm."""
        if self.sys_tap_up:
            await self.ports.stop_sys_tap()
            self.sys_tap_up = False

    # ---------------------------------------------------------------- capture
