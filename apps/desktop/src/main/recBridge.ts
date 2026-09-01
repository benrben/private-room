/**
 * ADD-27 recording feature: Electron main's "session broker" — the DB writes
 * plus the WS client for the sidecar's persistence channel.
 *
 * The live recording ENGINE (VAD, the decoder thread, ScreenCaptureKit,
 * diarization) already shipped, unchanged, as
 * `services/agent-sidecar/src/arcelle_sidecar/rec/session_ws.py` + `rec/engine.py` — nothing here
 * reimplements it. This file ports the business logic ABOVE it:
 * `src-tauri/src/commands/recording_cmds.rs` (its `#[cfg(test)]` tail, lines
 * 1663-2330, is fixtures rather than portable logic and is not ported; several
 * of its cases are reproduced in this module's own test file instead).
 *
 * ============================================================================
 * WHAT ELECTRON MAIN DOES, AND WHAT IT DELIBERATELY DOES NOT
 * ============================================================================
 *
 * 1. CONTROL-POST ISSUER. The 7 routes `session_ws.py::register_rec_routes`
 *    mounts (`/rec/start|pause|resume|set_live_stt|set_live_translate|
 *    edit_meta|stop`), through the single injected {@link RecBridgeDeps.
 *    sidecarPost} seam. A non-2xx becomes a {@link RecControlError} carrying
 *    the sidecar's own `code` (`REC_ALREADY_LIVE`, `REC_SPOOL_EXISTS`,
 *    `REC_NOT_LIVE`, `REC_EDIT_META_TIMEOUT`, `REC_SAVE_FAILED`, …), so a
 *    caller can branch on it without parsing English.
 *
 * 2. WS /rec/host CLIENT. The sidecar pushes `{reqId, kind, fromSample,
 *    toSample, spoolRange, metaJson, text}` down this socket as it flushes;
 *    this module decrypts the referenced spool range, executes the matching DB
 *    write, and acks `{reqId, ok:true}` or `{reqId, ok:false, reason,
 *    message}` — see {@link handlePersistRequest}.
 *
 *    THE DISPATCH TABLE is read off `recording.rs::Engine::flush`'s own
 *    `match save { … }` (lines 2355-2410), NOT reverse-engineered from
 *    `recordings.rs`, which supplies the primitives without saying which fires
 *    for which `Save` kind or in what transactional grouping:
 *      - `full`        -> `finalizeRecAudio` (itself one transaction: write the
 *                         WAV, drop the checkpoints) and THEN `setRecMeta` as a
 *                         SEPARATE statement — matching Rust's
 *                         `finalize_rec_audio(..).and_then(|()| set_rec_meta(..))`
 *                         chain exactly: two commits, so a WAV that lands and a
 *                         meta write that then fails leaves the audio durable.
 *      - `checkpoint`  -> ONE transaction: append the spool-decrypted PCM (only
 *                         when `spoolRange` is present — "a checkpoint with
 *                         nothing new to append"), then ALWAYS
 *                         `setFileExtractedText` + `setRecMeta`.
 *                         `appendRecChunk` is not idempotent, and the retry this
 *                         failure path promises re-appends the whole dirty tail:
 *                         a partial commit means crash recovery concatenates the
 *                         same samples twice.
 *      - `transcript`  -> the same two meta writes, one transaction, no spool
 *                         touch at all: the engine is paused, so the audio is
 *                         already durable and cannot have grown.
 *
 *    THE `"closed"` VS `"failed"` DISTINCTION is load-bearing and not
 *    interchangeable (`session_ws.py` §3: `RoomClosed` makes `Engine.flush` end
 *    the session QUIETLY and abandon the un-flushed tail; `PersistFailed` is
 *    retried). Rust's own answer is the `match guard.as_ref()` around the write:
 *    `Some(room) if room.path == self.cfg.room_path => {write}` / `_ =>
 *    Err(None)`. So `"closed"` is exactly "no room is open, or a DIFFERENT room
 *    is open than the one this session belongs to" — a fact this module reads
 *    FRESH from {@link RecBridgeDeps.currentRoom} before touching the database
 *    at all, exactly like Rust re-reads the room lock on every flush. A thrown
 *    exception from the write itself is ALWAYS `"failed"` and never `"closed"`:
 *    answering a full disk with `"closed"` throws the recording away.
 *
 * 3. LIVE-EDIT ROUTING ({@link routeEdit}). Rust's `edit_rec_meta` branches on
 *    its own in-process `RecState.session` mutex to decide "hand this to the
 *    engine thread, or write the room directly". That mutex has MOVED to the
 *    sidecar's `RecSessionManager`, so this port needs only its own much
 *    smaller fact — "is `fileId` the recording I started and have not stopped"
 *    ({@link RecBridgeState.liveFileId}). When it matches, the edit is POSTed to
 *    `/rec/edit_meta`, whose `_build_apply` is itself a faithful port of the
 *    same Rust ops (same refusal strings, same `at_time` horizon); otherwise it
 *    is applied and written here, exactly like Rust's non-live branch.
 *
 *    Rust's take-exactly-once race between "the engine applies the edit" and
 *    "the 20 s wait gives up on it" (`take_edit_claim`/`REC_EDIT_BUSY`/
 *    `REC_EDIT_LANDED`) has NO analogue here and is not reproduced: both sides
 *    of that race lived in one process, over one `mpsc` reply channel. Here it
 *    is `session_ws.py`'s problem alone (its `EDIT_META_TIMEOUT` plus the
 *    engine's future); Electron sees exactly one HTTP response.
 *
 * 4. SAVED-VOICE LEARNING ({@link learnVoice}). `session_ws.py` says this in as
 *    many words: the enrolment `rec_set_speaker_name` also performs is a real
 *    DB write and therefore Electron's job. Offline that is exact and
 *    race-free. LIVE, the rename POST returns the ALREADY-mutated meta, which
 *    can no longer say what a label used to be called — and there is no "read
 *    the live meta" endpoint — so the last meta this process saw for the
 *    session ({@link RecBridgeState.lastMeta}, refreshed by every routed edit)
 *    is the "before" snapshot. Best-effort, matching `learn_voice`'s own Rust
 *    doc: a stale snapshot costs a missed correction, never a wrong rename.
 *
 * 5. `recPushAudio` IS DEAD CODE HERE, deliberately, not by omission. Its only
 *    caller, `src/workspace/liveRec.ts:255,304`, fed WebView-captured mic PCM
 *    through Tauri IPC into the SAME in-process engine `rec_start` had just
 *    created — precisely the hop the plan (line 349) replaces with a direct
 *    renderer -> `WS /rec/session` connection. Routing audio through an IPC hop
 *    into Electron and back out to the sidecar would be strictly worse than
 *    that socket, not a faithful port of anything. It is kept as an exported,
 *    IPC-wired stub matching `src/api.ts:1264`'s call shape that THROWS with
 *    the explanation, so a stale renderer bundle fails with an instruction
 *    rather than with "no handler registered".
 *
 * 6. THE `retranscribing` GUARD SET ({@link beginRetranscribe} /
 *    {@link endRetranscribe} / {@link isRetranscribing}) — the port of
 *    `RecState.retranscribing` (`recording_cmds.rs:12-15`). It used to be
 *    missing, and this doc used to explain that away with "`session_ws.py`
 *    mounts no `/rec/retranscribe` route, so nothing can populate it". That
 *    route EXISTS now, and `mediaTranscribeJob.ts` drives it, so the set is
 *    real again and the three commands Rust gates on it —
 *    {@link recStart} (resume only), {@link recDeleteRange},
 *    {@link recCorrectRange} — refuse against it exactly as Rust does.
 *
 *    IT IS MODULE STATE, not a {@link RecBridgeState} field, and that is a
 *    decision rather than an oversight. Rust's own set lives on `RecState`, a
 *    Tauri MANAGED SINGLETON — one per app process, which is what a
 *    module-level `Set` is here too. More decisively: the rebuild does not run
 *    through a `RecBridgeCtx` at all. `recIpc.ts` hands `rec_retranscribe` a
 *    ctx, but the live wiring overrides that channel with a handler that
 *    ignores it and calls `transcribeMediaWithSpeakers`, whose dependencies
 *    are a `RoomManagerState` — so a set hanging off `RecBridgeState` would be
 *    a guard nothing could ever populate, which is precisely the inert shape
 *    the previous version of this comment was apologising for.
 *
 * 7. NOT PORTED, disclosed rather than guessed at:
 *    - `rec_read_start` (and `rec_stop`'s best-effort kickoff of the same job)
 *      needs the room's background JOB system — a separate, unported subsystem.
 *    - `rec_retranscribe`'s COMMAND BODY. The pipeline half now has a route
 *      (`POST /rec/retranscribe`) and the whole job — staging, the NDJSON
 *      stream, the GH #5 name fold, the paired `recordings.meta` +
 *      `files.extracted_text` write — lives in `mediaTranscribeJob.ts`, which
 *      every route into transcription shares. {@link recRetranscribe} stays
 *      here only as the default behind `recIpc.ts`'s `live.retranscribe ?? …`
 *      seam, and says where the real one is.
 *    - `caffeinate -i` for a live session's lifetime, and the
 *      `rolling_back`/`ROLLBACK_BUSY` room-checkpoint guard: room-lifecycle
 *      concerns with no Electron equivalent yet.
 *    - STT model resolution (`stt_effective_model`) is a Settings/STT concern,
 *      taken as {@link RecBridgeDeps.resolveSttModel} rather than guessed at;
 *      its `null` reproduces Rust's `STT_MODEL_MISSING` refusal honestly.
 */

export { type RecStart, type RecFile, type RecLiveControl, type RecLiveStatus, RecBridgeState, beginRetranscribe, endRetranscribe, isRetranscribing, type HostWsLike, type RecBridgeDeps, type RecBridgeCtx, createRecBridgeCtx, sidecarPostAt, recHostWsUrl, type FileMeta, type KnownVoice, type SavedVoice } from "./recBridgeState.js";
export { decryptSpoolFrame, readSpoolFrame, type PersistRequest, type PersistAck, handlePersistRequest, attachHostWs, noteLiveSessionEnded } from "./recBridgeMeta.js";
export { RecControlError, parseRecMeta, coerceRecMeta } from "./recBridgeControl.js";
export { recordingStamp, recStart, recPushAudio, recPause, recResume, recSetLiveTranslate, recSetLiveStt, recStop, recLiveStatus } from "./recBridgePersistence.js";
export { recGet, voicesList, voiceForget, type RecEditOp, recNoteAdd, recNoteSet, recChapterAdd, recChapterSet, recHighlightAdd, recItemDelete, recSetSpeakerName } from "./recBridgeSession.js";
export { recDeleteRange, recDeleteRangeHybrid, correctWords, recCorrectRange, recCorrectRangeHybrid, reflowAfterCuts, recExportClean, recExportCleanHybrid } from "./recBridgeEdits.js";
export { TRANSLATE_BATCH_SIZE, translatableLines, buildTranslatePrompt, type ReconciledBatch, reconcileTranslatedBatch, buildTranslatedDocument, recTranslate, recRetranscribe, recReadStart } from "./recBridgeSavedVoice.js";
