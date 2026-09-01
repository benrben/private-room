/**
 * The generative `#commands`. Ported from
 * `src-tauri/src/commands/chat_commands/generate.rs` (989 lines, read in
 * full, including its `#[cfg(test)] mod chunked_pass_tests`): `#summarize`,
 * `#compare`, `#transcribe`, `#minutes`, `#sketch`, `#to-sheet`,
 * `#translate`, `#research`.
 *
 * NOT AN `exec_tool` ARM. Verified against the real dispatcher, not assumed:
 * `chat_commands.rs`'s `run_command` is its OWN `#[tauri::command]`, invoked
 * by the frontend when the user TYPES a `#command` — a completely separate
 * entry point from the model's tool-calling loop (`execTool.ts`/
 * `toolRouting.ts`). Nothing in `toolSpecs.ts` advertises any of these names
 * to a model, and nothing here should be wired into `execTool.ts`.
 * `run_command` itself (the catalog, the cancel-registration boilerplate,
 * `#checkpoint`'s short-circuit, the local-model fallback, the dispatch
 * `match`, and the trailing "N part(s) couldn't be read" / "*(stopped)*"
 * bookkeeping) is `chat_commands.rs`'s OWN top-level dispatcher — a sibling
 * file, out of this batch's scope — and is not re-hosted here.
 *
 * `chatCommandsKnowledge.ts` LANDED CONCURRENTLY with this batch (its own
 * module doc: "A future port of `chat_commands/generate.rs`... should IMPORT
 * these exports rather than re-declaring them") and already rebuilt the slice
 * of `chat_commands.rs`'s shared `CmdCtx` scaffolding its five commands use:
 * {@link CmdCtx} (imported and EXTENDED here, not re-declared — see below),
 * `cmdWindows`/`CMD_WINDOW_CHARS`/`CMD_WINDOW_OVERLAP`, `quietStepText`,
 * `askQuiet`, `digest` (which owns the private `mapWindows`/`foldNotes` this
 * file therefore does not need its own copy of), and `CommandResult`. All are
 * imported and reused verbatim. Also reused: `docsHtml.ts`'s `refsFiles`/
 * `refsContext`/`nameFromTopic`/`htmlNoteName` (extended by that same
 * concurrent batch, per its own module doc — "this is that other command"
 * language it left for whoever needed them next), `editMatchCells.ts`'s
 * `serializeDelim`, and `editMatchExtraction.ts`'s `extensionOf`.
 *
 * WHAT THIS FILE ADDS on top of the reused `CmdCtx` shape — the two things
 * `knowledge.rs`'s five commands never needed: {@link askStreaming} (`ask_
 * streaming`, needs `ctx.temperature` — the ONE field `chatCommandsKnowledge
 * .ts`'s own module doc predicted a `generate.rs` port would have to add)
 * and {@link askStructured} (`ask_structured`, ADD-22's schema-constrained
 * call). Neither is a new client: `askStructured` is a thin wrapper over the
 * already-real `chatStructured` (`ollamaGenerate.ts`); `askStreaming` needs
 * `sidecar::generate_stream`'s `/generate_stream` NDJSON reader, which
 * nothing in this tree has ported (`sidecarJsonCancellable.ts`'s own doc
 * draws its line at the non-streaming `sidecar_json*` family), so it is
 * composed from already-committed pieces rather than a fresh low-level
 * client: `sidecar.ts`'s own `splitCompleteLines`/`waitForNextChunkOrCancel`/
 * `authedHeaders`/`busy`/`ensureUp` (the exact NDJSON-reading idiom
 * `streamRun` already uses for `/run`), plus `privacy.ts`'s `injectPolicy`
 * and `providers.ts`'s `ensureProviderCatalog`/`injectProviderRuntime` (the
 * same policy/provider wiring `ollamaGenerate.ts`'s `postGenerateCancellable`
 * already does for `/generate`). `chat_commands.rs::watch_stream` — the outer
 * per-command watchdog that races the whole stream against Stop-grace and an
 * idle ceiling — is ported alongside it as {@link watchStream}, with its own
 * two Rust unit tests carried over verbatim.
 *
 * ONE DELIBERATE STRUCTURAL DEVIATION in {@link generateStream}: Rust's
 * `next_stream_chunk` also enforces its OWN loose 1200s idle backstop
 * (`sidecar::STREAM_IDLE_TIMEOUT`) independent of `watch_stream`'s tighter
 * one (300s / 960s). `waitForNextChunkOrCancel` — the reused, unmodified
 * primitive — has no idle timeout of its own, and re-implementing a second,
 * always-looser one on top of it would be pure duplication: the outer
 * {@link watchStream} ceiling always fires first. Skipped, not silently
 * dropped — this note is that documentation. A genuine stall is still caught
 * and still aborts the request (`watchStream` calls back into `abort()`).
 *
 * GENUINELY UNPORTED DEPENDENCIES, refused honestly rather than faked (see
 * each seam's own doc below): on-device Whisper transcription
 * (`stt::decode_bytes_to_pcm`/`stt::transcribe`, plus the bundled/downloaded-
 * model lookup `stt_effective_model` folds into the same seam) for
 * `#transcribe`'s ON-DEMAND branch — a file that already has a cached
 * transcript still works in full; and the `.sketch` layout/geometry engine
 * (`commands::sketchdoc::layout_graph`, 2811 lines) for `#sketch`'s final
 * render — everything upstream of it (windowed structured calls, merging,
 * the schema, the title-safing) is real and tested, only drawing the result
 * throws. Both seams are injectable on {@link CmdCtx} (via {@link CmdCtx.
 * transcribeAudio}/{@link CmdCtx.layoutGraph}), defaulting to a clearly-
 * labeled `NOT_IMPLEMENTED:` rejection — the same "stub, don't fake"
 * convention `recRead.ts`'s `resolveReadEngineNotImplemented` and
 * `workflowCompose.ts`'s `generateOllama` default already establish, and the
 * same shape `chatCommandsKnowledge.ts`'s own `CmdCtx.generate` test seam
 * uses for `askQuiet`'s underlying call.
 *
 * SMALL PURE HELPERS PORTED LOCALLY, because nothing else in this port has
 * them yet — `docHero`/`minutesSchema`/`mergeMinutes`/`renderMinutesHtml`
 * (`docs_html/minutes.rs`, entirely `#minutes`' own territory), `extractMd
 * Table` (`docs_html.rs` — not among the four functions the knowledge.rs
 * batch already claimed), and `mediaKind` (a slice of `stt.rs`). Duplicating
 * a small, already-tested pure function locally rather than reaching into a
 * sibling file mid-edit is this port's established convention
 * (`sidecarJsonCancellable.ts`'s local `isConnectionRefused`, `ollamaGenerate
 * .ts`'s local `recoverJson`).
 *
 * `artifactBuilder.ts` IS extended (not duplicated) — its own module doc
 * explicitly invited exactly this: `Artifact.note` (the extension-defaulting
 * Markdown constructor) and `Artifact.indexedAs` (index a drawing's derived
 * text instead of its raw JSON) are genuinely part of the ONE write funnel,
 * reused by four of these eight commands (and now by `knowledge.rs`'s
 * `cmd_add_file`/`cmd_highlight` too, via its own `saveAndOpen`).
 *
 * `GENERATE_STREAM_DISPATCHER`: `/generate_stream` is exactly the kind of
 * long-lived streaming POST `sidecar.ts`'s own `RUN_STREAM_DISPATCHER`
 * exists for (undici's default 300s body/headers timeout would otherwise
 * tear down a legitimately slow local model's answer out from under
 * `watchStream`'s own, more informative ceiling). A separate local instance
 * rather than importing the un-exported one — `sidecar.ts` draws its own
 * scope at the `/run` client and this batch does not touch it.
 */

export { type MediaKind, type TranscribeAudioFn, TRANSCRIBE_AUDIO_NOT_IMPLEMENTED, transcribeAudioNotImplemented, type GraphNode, type GraphEdge, type SketchDoc, type LayoutGraphFn, LAYOUT_GRAPH_NOT_IMPLEMENTED, layoutGraphNotImplemented, type CmdCtx, generateStream, type CommandResult } from "./chatGenerateContext.js";
export { COMMAND_STREAM_IDLE_SECS, COMMAND_STREAM_IDLE_CLI_SECS, COMMAND_STOP_GRACE_MS, streamIdleSecs, watchStream, askStreaming, askStructured, mediaKind, extractMdTable, minutesSchema, type MinutesDoc, mergeMinutes, renderMinutesHtml } from "./chatGenerateDocuments.js";
export { sketchSchema, safeFileStem, mergeSketch, cmdSummarize, cmdCompare } from "./chatGenerateData.js";
export { cmdTranscribe, cmdMinutes, cmdSketch, cmdToSheet } from "./chatGenerateSketch.js";
export { CHUNK_GIVE_UP_AFTER, ChunkFailures, translationLocale, translationSystemPrompt, translationValidationIssues, cmdTranslate } from "./chatGenerateResearch.js";
export { cmdResearch } from "./chatGenerateDispatch.js";
