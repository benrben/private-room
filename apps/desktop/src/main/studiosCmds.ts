/**
 * The Studios feature's TOP-LEVEL DISPATCHER and shared plumbing — flashcards,
 * mind map, podcast script. Ported from `src-tauri/src/commands/studios.rs`
 * (844 lines, read in full, including its `#[cfg(test)] mod tests`): every
 * function and constant declared directly in that file. `run_studio`/
 * `run_studio_core` are the ONE pipeline all three artifact generators share
 * (gather scope text, resolve a model, author a whole HTML page, fall back to
 * a structured extraction rendered by a built-in template, save and open);
 * `spec: StudioSpec` is the only thing that varies between them.
 *
 * NOT PORTED HERE, and why: `studios.rs`'s own `mod` declarations pull in four
 * sibling files — `studios/flashcards.rs` (309 lines), `studios/mindmap.rs`
 * (240 lines), `studios/podcast.rs` (355 lines) and `studios/podcast_audio.rs`
 * (561 lines, "a different act... split from podcast" per its own module
 * header) — each its own `flashcards_spec()`/`mindmap_spec()`/`podcast_spec()`
 * factory plus that artifact's own `#[tauri::command]` entry point and (for
 * podcast_audio) TTS rendering. None of those four files are part of THIS
 * batch's 844-line scope.
 *
 * DISCOVERED MID-BATCH, not assumed at the start: FOUR other, concurrent
 * batches ported `flashcards.rs`/`mindmap.rs`/`podcast.rs`/`podcast_audio.rs`
 * in parallel with this one (`studiosFlashcards.ts`, `studiosMindmap.ts`,
 * `studiosPodcast.ts`, `studiosPodcastAudio.ts` — the last one genuinely
 * real end-to-end against the sidecar's `/tts`/`/tts/podcast` routes, per its
 * own module doc). Three of the four (everything but `podcast_audio.rs`,
 * which never called into `studios.rs`'s shared pipeline — it works from an
 * already-saved podcast row, not a fresh `run_studio` call) independently hit
 * the exact gap this file fills and built the same injectable-seam prediction
 * for it — their own module docs call it "this port's best-effort prediction of that
 * future shared type's shape, so a `studios.rs` port can adopt [a spec's]
 * return value with no changes to this file." {@link StudioSpec}/
 * {@link RunStudioFn}/{@link fillTemplate}/the three `STUDIO_*_PROMPT`
 * constants now live HERE, canonically, exactly matching what those three
 * predictions already converged on (down to the curried `(spec, scope,
 * instructions, refs, opId, parentRun) => Promise<FileMeta>` calling
 * convention — see {@link makeRunStudio}); the three sibling files were
 * updated ADDITIVELY (per this migration's stated rule for concurrent-batch
 * overlap) to import and re-export these rather than keep their own local
 * copies, removing the one real type-drift risk that had already opened up
 * between `studiosMindmap.ts`'s `afterSave` (typed `db: unknown`, since
 * mindmap never sets it) and `studiosPodcast.ts`'s (typed `db:
 * Database.Database`, since podcast's `storePodcast` genuinely does) — this
 * file keeps the latter, more precise type. {@link runStudio}/
 * {@link runStudioCore} are fully real and tested here; {@link studioSpecFor}
 * (Rust's own reconstruction of a spec from a durable job's `kind` string)
 * can now be handed the three REAL factories (`flashcardsSpec`/`mindmapSpec`/
 * `podcastSpec`) — see its own doc.
 *
 * `exec_tool`'s STUDIO ARM LIVES HERE, once — {@link resolveStudioRefs} and
 * {@link execStudio}. `agent.rs` ~4299 dispatches `"studio_flashcards" |
 * "studio_mindmap" | "generate_podcast_script"` through ONE match arm whose
 * only per-artifact difference is which `spec` it builds, and it does MORE
 * than call `run_studio` verbatim: it resolves the schema's file-NAME `refs`
 * to ids itself and passes `parent_run: turn.map(TurnId::run_id)` (Owner
 * replacement #3) rather than the three `#[tauri::command]` wrappers' own
 * hard-coded `None`.
 *
 * AN AUDIT OF THIS BATCH (2026-08-23) FOUND THAT ARM FORKED: a
 * flashcards-only copy lived in `studiosFlashcards.ts`, `execTool.ts`'s
 * `studio_flashcards` case ran it when `ExecToolDeps.runStudioDeps` was
 * supplied, and the `studio_mindmap`/`generate_podcast_script` cases refused
 * UNCONDITIONALLY — so a fully-bootstrapped app could build a deck and could
 * not build a mind map or a podcast script, from one Rust arm. One function
 * taking `spec` now, mirroring the one Rust arm; `studiosFlashcards.ts`
 * re-exports `resolveStudioRefs` under its original
 * `resolveFlashcardsRefs` name and `execStudioFlashcards` is
 * `execStudio(deps, flashcardsSpec(), ...)`.
 *
 * What stays genuinely missing, and is NOT invented here: {@link
 * RunStudioDeps} needs a live `RoomSource`/`CancelState`, which no host
 * bootstrap constructs yet — the same gap `ExecToolDeps.downloadJob`/
 * `.workflowRun` already document for their own job-queue-backed arms. All
 * three `execTool.ts` cases therefore still refuse with their own gap
 * sentence when `deps.runStudioDeps === undefined`, and run for real the
 * moment it is supplied.
 *
 * REUSED, not re-declared — verified against each file's own exports:
 *  - {@link Artifact}/{@link Written} (`artifactBuilder.ts`) — the ART-1 write
 *    funnel `run_studio_core` commits through.
 *  - `chatStructured`/`StructuredOpts` (`ollamaGenerate.ts`) — that file's own
 *    module doc names `commands/studios.rs:387,565` as one of the real call
 *    sites that justified porting it; this is that call site.
 *  - {@link CancelFlag}/`childOfRun`/`remember`/`forget`/`guardCommit`/
 *    `type CancelState`/`type Node` (`cancel.ts`) — the run-id cancel tree.
 *  - `jsonStrField` (`jsonTools.ts`) — that file's own doc names
 *    `jsonStrField(reply, "html")` as written for exactly this call site.
 *  - `titleFromName` (`docsHtml.ts`), `clampBytes` (`textClamp.ts`),
 *    `byteLength` (`extractionWindow.ts`), `getFileName`/
 *    `getFileExtractedText`/`listFiles`/`type FileMeta` (`db-host/files.ts`).
 *  - `modelSetting` (`gatherContext.ts`), `isExternalEngine`/`ROLLBACK_BUSY`
 *    (`turnContext.ts`), `listModels` (`engineRouting.ts`), `bestLocalDefault`/
 *    `KEEP_ALIVE_WARM` (`ollamaModels.ts`) — {@link resolveStructuredModel}'s
 *    real, composed pieces; see that function's own doc.
 *  - `obs.warn`/`obs.id`/`obs.errKind`, via the `{warn: typeof obs.warn}` log
 *    seam `recRead.ts`'s own `RecReadLog`/`REAL_LOG` already establishes —
 *    same shape, duplicated per that file's own convention rather than
 *    exported from one place no other file has claimed yet.
 *
 * DUPLICATED HERE, deliberately and in a few lines, following this rewrite's
 * established "too small to justify a shared port" precedent
 * (`chatCommandsGenerate.ts`'s own doc lists `mediaKind`/`safeFileStem` as
 * exactly this):
 *  - `saveAndOpen`/`requireRoom`/`emitSafely` — `docs_html.rs::save_and_open`
 *    is ALREADY ported, privately, inside `chatCommandsKnowledge.ts`, whose own
 *    doc explains why it lives there rather than in `docsHtml.ts` (an import
 *    cycle) and is not exported. `chatCommandsGenerate.ts` already duplicates
 *    `requireRoom` for the identical reason ("unexported there, and every one
 *    of this file's eight commands needs it"); this file is a second such
 *    caller.
 *  - {@link resolveStructuredModel} — `commands/moonshot.rs::resolve_structured_model`.
 *    DISCOVERED MID-BATCH (same as the studio siblings above): a CONCURRENT
 *    batch also ported `moonshot.rs` (`moonshotCmds.ts`), including this
 *    exact function — checked, not assumed. NOT imported from there, for one
 *    real reason: `moonshotCmds.ts`'s own `RoomSource.currentRoom(): OpenRoom
 *    | null` (`turnEngine.ts`'s `OpenRoom`, `{db, path}`) has no `name` field,
 *    which {@link gatherScopeText}'s whole-room scope genuinely needs — this
 *    file's {@link RoomSource}/{@link RoomHandle} were built specifically to
 *    carry it (see this module's own "room access" section). Adapting one
 *    shape to the other at every room-touching call site in this file would
 *    be a larger, riskier change than the four-line function this note is
 *    attached to. Composed ENTIRELY from already-real pieces (see the REUSED
 *    list above) either way — genuinely working, not a stub — and exported
 *    so a future integration pass can reconcile the two `RoomSource` shapes
 *    (or thread a `name` through `moonshotCmds.ts`'s) and drop whichever copy
 *    instead of re-deriving a third one (`ollamaModels.ts`'s own
 *    `bestLocalDefault` already exists alongside an OLDER, independently
 *    duplicated copy in `feedbackTools.ts` — the exact drift this note is
 *    trying to prevent a third instance of).
 *
 * ONE DELIBERATE STRUCTURAL ADDITION beyond the Rust source, required by
 * `cancel.ts`'s own documented port deviation: Rust's cancel tree self-prunes
 * (`Weak<Node>` decays when the owning `Arc` drops); this port's tree uses
 * STRONG references and needs an explicit {@link CancelNode.dispose} call when
 * a child's work finishes, in a `finally` — `cancel.ts`'s module doc names
 * "studio builds" BY NAME as a future caller that must remember this.
 * {@link runStudio} is that caller: {@link registerStudioCancel} always
 * creates a node (a child of the parent run when one exists, else a root), and
 * without disposing it a Studio started by the agent's `studio_flashcards`
 * tool (`op_id: None`, a real `parent_run`) would leave a finished node linked
 * into its parent's `kids` list forever — the "phantom still-live child"
 * `cancel.ts`'s own doc warns a leak like this fabricates.
 *
 * `stage_preview_html`/`open_html_in_browser` port only their `_core`/testable
 * bodies, per this rewrite's "no ipcMain wiring in this batch" convention
 * (`recIpc.ts`, `previewTools.ts`): both are `#[tauri::command]`s whose Tauri
 * `State<'_, HtmlPreviews>` extraction has no Electron IPC equivalent to wire
 * without an explicit owner go-ahead (rule 4). {@link HtmlPreviews} is a plain,
 * directly-testable store — no `Mutex`/`AtomicU64` needed, Node is
 * single-threaded, the same reasoning `cancel.ts`'s own registries give.
 */

export { type RoomHandle, type RoomSource, type EmitFn, gatherScopeText, gatherFilesText, safeScopeName, fillTemplate } from "./studiosScope.js";
export { previewDir, openHtmlInBrowser, cleanupBrowserPreviews, sweepPreviewsOlderThan, cleanupBrowserPreviewsOlderThan, PREVIEW_MAX, type HtmlPreviews, createHtmlPreviews, stagePreviewHtmlCore } from "./studiosPreview.js";
export { STUDIO_FLASHCARDS_PROMPT, STUDIO_MINDMAP_PROMPT, STUDIO_PODCAST_PROMPT, studioInstruction, type StudioPrompts, studioPrompts, SELF_CONTAINED_HTML_RULES, registerStudioCancel, resolveStructuredModel, generateStudioHtml, cleanStudioHtml } from "./studiosModels.js";
export { type StudioSpec, type StudioLog, type RunStudioDeps, runStudio, type RunStudioFn, makeRunStudio, runStudioCore } from "./studiosRun.js";
export { resolveStudioRefs, execStudio } from "./studiosRefs.js";
export { type StudioKind, type StudioSpecFactories, studioSpecFor, studioTitle } from "./studiosSpecs.js";
