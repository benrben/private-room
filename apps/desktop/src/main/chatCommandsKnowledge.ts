/**
 * The knowledge/retrieval-flavored `#commands`: `#remember`, `#find`,
 * `#add-file` (single + the `for each …` fan-out), `#highlight`, `#extract`.
 * Ported from `src-tauri/src/commands/chat_commands/knowledge.rs` (642
 * lines, read in full, including its `#[cfg(test)] mod tests`).
 *
 * NOT MODEL-INVOCABLE. Verified against the real Rust source, not assumed:
 * `#commands` are dispatched by `chat_commands.rs`'s `run_command` — a plain
 * `#[tauri::command]` the FRONTEND calls when a human types `#name …` and
 * presses send (`lib.rs`'s `tauri::generate_handler!` registers it next to
 * `list_chat_commands`, both invoked only from `src/api.ts`). `exec_tool`'s
 * whole match-arm list (`agent.rs`, read for this batch) has no
 * `"remember"`/`"find"`/`"add_file"`/`"highlight"`/`"extract"` arm, and
 * `toolSpecs.ts`'s `BUILTIN_TOOL_NAMES` has no such names either — the model
 * never calls any of these. So this file adds nothing to `execTool.ts`.
 *
 * WHAT THIS FILE PORTS, and what it deliberately does NOT:
 *
 *   - The five `cmd_*` functions themselves — `cmdRemember`/`cmdFind`/
 *     `cmdAddFile`/`cmdHighlight`/`cmdExtract` — plus their own private
 *     helpers (`capFanOut`, `findBody`, `tabularFieldRows`,
 *     `stripTrailingPreposition`), all ported verbatim.
 *   - The slice of `chat_commands.rs`'s shared `CmdCtx` scaffolding these five
 *     commands actually call: {@link CmdCtx} itself, {@link cmdWindows},
 *     {@link quietStepText}, {@link askQuiet}, and the private `mapWindows`/
 *     `foldNotes`/{@link digest}. `chat_commands.rs` (the `run_command`
 *     dispatcher, `ask_streaming`, `ask_structured`, `format_history`, the
 *     watchdog) is NOT ported — nothing in `knowledge.rs` calls any of it.
 *     `ask_quiet`/`digest`/`map_windows`/`fold_notes`/`cmd_windows` live here,
 *     ported alongside the first command file that needs them, because no
 *     `chatCommands.ts` base module exists yet in this migration. A future
 *     port of `chat_commands/generate.rs` (`#summarize`/`#compare`/
 *     `#transcribe`/`#minutes`/`#sketch`/`#to-sheet`/`#translate`/
 *     `#research`, all of which also use this scaffolding) should IMPORT
 *     these exports rather than re-declaring them; a future port of
 *     `chat_commands.rs`'s own `run_command` should do the same for
 *     {@link CmdCtx} and read {@link CmdCtx.unread} the way Rust's dispatcher
 *     reads `ctx.unread` — see that field's own doc.
 *
 * DEPENDENCIES ALREADY REAL, verified by reading each target file, not
 * assumed from its name:
 *   - `retrieve_context_limited`/`make_snippet` -> `db-host/retrieval.ts`
 *     (`retrieveContextLimited`/`makeSnippet`).
 *   - `embed_question` -> `retrievalBackfill.ts` (`embedQuestion`), which
 *     that file's own doc built specifically as the "producer" of
 *     `retrieveContext*`'s question-embedding input.
 *   - `duplicate_memory` -> `libraryTools.ts` (`duplicateMemory`); `db::
 *     add_memory` -> `db-host/memories.ts` (`addMemory`). `cmd_remember`
 *     calls the DB layer directly, bypassing `commands::library::add_memory`'s
 *     cap check — a deliberate Rust choice this port preserves (see
 *     `cmdRemember`'s own doc).
 *   - `db::get_file_full` -> `db-host/files.ts` (`getFileFull`);
 *     `build_annotation` -> `fileTools.ts` (`buildAnnotation`), EXPORTED by
 *     this batch (it was `agent.rs`-private in the Rust source's own module
 *     but is called from BOTH `agent.rs::annotate_file` and
 *     `chat_commands/knowledge.rs::cmd_highlight` there — one Rust function,
 *     two callers — so exporting the existing TS port is the one-function
 *     answer, not a second copy).
 *   - `parse_delim`/`serialize_delim` -> `editMatchCells.ts` (verbatim ports
 *     of the same `spreadsheet.rs` functions). `value_str` -> `jsonTools.ts`
 *     (`valueStr`).
 *   - `Artifact::new`/`note`/`by`/`during_run`/`from_files`/`cancel_with`/
 *     `commit` -> `artifactBuilder.ts`. `note_mime`/`html_note_name`/
 *     `title_from_name`/`html_titled_doc`/`refs_files`/`refs_context` ->
 *     `docsHtml.ts`, EXTENDED by this batch (see that file's own module doc)
 *     — `docs_html.rs`'s own prior port had scoped these five out by name as
 *     "other commands' territory"; this is that command.
 *   - `sidecar::sidecar_json_cancellable`/`SidecarError::sentinel` ->
 *     `sidecarJsonCancellable.ts`. `ollama::generate` -> `ollamaGenerate.ts`
 *     (`generate`) — that file's own module doc names
 *     `commands/chat_commands.rs:310,356` (i.e. `ask_quiet`/`ask_structured`)
 *     as a real, currently-unwired caller; {@link askQuiet} is that wiring.
 *   - `extraction::partition_windows`/`extraction::extension_of` ->
 *     `extractionWindow.ts` (`partitionWindows`/`byteLength`/`sliceUtf8`) /
 *     `editMatchExtraction.ts` (`extensionOf`).
 *
 * ONE ACCEPTED SIMPLIFICATION, not a fidelity gap: `knowledge.rs` calls the
 * NON-cancellable `sidecar::sidecar_json` at two sites (`#add-file`'s list
 * enumeration, `#extract`'s per-window field pass) and the cancellable
 * `sidecar_json_cancellable` at two others (`#add-file`'s per-item and
 * single-file document generation). `sidecarJsonCancellable.ts`'s own module
 * doc already made the call, for the whole migration, that the plain variant
 * is not worth a second HTTP client: "both Rust functions are collapsed into
 * this one, since nothing else in this port needs the non-cancellable
 * variant." Followed here exactly as `storyTools.ts` already follows it for
 * its own non-cancellable Rust call site — a FRESH, NEVER-SET `CancelFlag` at
 * the two non-cancellable sites (so a real Stop cannot abort that particular
 * network call, matching Rust's own behavior there), `ctx.cancel` itself at
 * the two cancellable sites.
 *
 * TWO NAMES THAT ARE BYTE COUNTS DESPITE THEIR NAME: `CMD_WINDOW_CHARS`/
 * `CMD_WINDOW_OVERLAP` are `chat_commands.rs`'s own constant names, but
 * `extraction::partition_windows` slices on `str::len()` — UTF-8 BYTES — so
 * {@link cmdWindows} is built on {@link byteLength}/`partitionWindows`/
 * `sliceUtf8`, never `.length`/`.slice()` (see `extractionWindow.ts`'s own
 * module doc on why: a JS string index is a UTF-16 code unit, not a byte, and
 * would produce different windows for any file with so much as one accented
 * or Hebrew character).
 *
 * `save_and_open` (`docs_html.rs`) is ported HERE, not added to `docsHtml.ts`
 * alongside its other four siblings: `artifactBuilder.ts` already imports
 * `docsHtml.ts` for `noteMime` (added by the concurrent
 * `chat_commands/generate.rs` batch), so `docsHtml.ts` importing
 * `Artifact`/`Written` the other way would make the two files a cycle. This
 * file may safely depend on both, so it is the natural home instead.
 */

export { type EmitFn, type UnreadCounter, type CmdCtx, quietStepText, COMMAND_STEP_TIMEOUT_MS, askQuiet, CMD_WINDOW_CHARS, CMD_WINDOW_OVERLAP, cmdWindows, digest, type ScoredChunk } from "./chatKnowledgeContext.js";
export { type CommandResult, cmdRemember, MAX_FIND_MATCHES, findBody, cmdFind } from "./chatKnowledgeRemember.js";
export { MAX_FAN_OUT_FILES, capFanOut, cmdAddFile } from "./chatKnowledgeFiles.js";
export { cmdHighlight } from "./chatKnowledgeHighlight.js";
export { tabularFieldRows, stripTrailingPreposition, extractFieldNames, cmdExtract } from "./chatKnowledgeExtract.js";
