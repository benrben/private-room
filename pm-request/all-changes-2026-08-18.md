# Everything that changed — in plain English

_2026-08-18 · Arcelle v0.24.0 · 537 changes across 237 files · all uncommitted_

Each line is one change. **[bug]** = something was broken and now works.
**[ux]** = something worked but was confusing, dishonest, or cluttered.


## Privacy & security (15)

- [bug] Cloud-privacy panel's connector-masking note ignores per-connector overrides and can state the exact opposite of what happens
- [bug] Private topics beyond the 20th are silently discarded and erased from the textarea
- [bug] A transient DB read failure silently opens the privacy door while the panel still says it is on
- [bug] The background privacy scan writes room A's findings into whatever room is open when the chunk returns
- [bug] `set_privacy_room("default")` reports success even when clearing the room override fails
- [bug] Dead redundant disjunct in set_privacy_room
- [bug] A revoked recovery key is silently overwritten by the stranded-checkpoints message after a password change
- [bug] The protected-item length floor counted BYTES while its message said characters
- [bug] Case-insensitive de-duplication of protected entities was ASCII-only
- [bug] A failed Private-topics save leaves the typing unprotected from the next background reload
- [bug] `change_password`, `duplicate_room` and `compact_room` are synchronous commands — a multi-GB room freezes the whole app
- [ux] 'Compact room now' is drawn as destructive and armed like a delete, but the copy explains nothing
- [ux] Touch ID has no test anywhere, including the sentence a locked-out user reads
- [ux] Private topics saves on blur with no confirmation and no way to tell it saved
- [ux] Password change and recovery-key write have no test on either side of the seam

## Recording & transcripts (39)

- [bug] Podcast host names with surrounding whitespace silently record in the default voice
- [bug] Podcast preview blob URLs are never revoked and preview state is keyed by a duplicable name
- [bug] Podcast host preview can play two clips at once and leave the wrong Stop button lit
- [bug] Podcast preview leaks a blob object URL on every click
- [bug] Overlapping podcast previews play on top of each other, and the first becomes unstoppable
- [bug] A live recording's `caffeinate -i` child is orphaned on quit — the Mac never idle-sleeps again
- [bug] Resuming a recording that still has audio checkpoints deletes or desynchronises them
- [bug] A mid-recording edit that times out has ALREADY been applied — the user's retry writes it twice
- [bug] After rec_stop takes the session, a webview reload during the save drain makes the app claim nothing is recording
- [bug] "Recording saved — transcript included." is asserted without reading the result
- [bug] Start toast claims "the Mac's audio keeps recording" before any capture lane exists
- [bug] A failure after rec_start succeeds is reported as a start failure while the engine keeps recording
- [bug] The post-Stop refresh is outside the try, so a failure there escapes as an unhandled rejection
- [bug] Mic-failure banner asserts "the Mac's audio keeps recording" even when system audio is off or its tap failed
- [bug] Every RecSegment ships a 192-float voiceprint across the IPC seam that the TS type does not declare
- [bug] A checkpoint that half-fails is retried non-idempotently: the same audio is appended again, and the retry runs 4x/second forever
- [bug] Stopping a recording before the ScreenCaptureKit tap finishes coming up leaks the tap — it is never stopCapture'd
- [bug] A lagging capture lane's audio is written behind the checkpoint mark and never persisted
- [bug] Every pause writes the whole recording's WAV twice
- [bug] resample_to_16k divides by the caller-supplied rate with no validation, so a zero rate from the IPC seam panics the recording engine
- [bug] A long dictation whose final decode exceeds 120 s loses the entire transcript
- [bug] A failed translate pass is swallowed: dictation comes back untranslated with nothing saying so
- [bug] One global Whisper mutex is held across an entire decode, so a background import freezes live transcription
- [bug] Decrypted room audio is written to the temp dir with default permissions
- [bug] A read that fails or is parked leaves the tabs claiming "Reading this recording…" forever
- [bug] rec_read's transcript-changed guard is blind to a delete that empties a turn
- [bug] A read where every window was skipped is stored as a completed read that "found none"
- [bug] Clearing a subtitle line deletes the cue and its timing on save
- [bug] Saving a .vtt destroys its STYLE, NOTE and REGION blocks, cue ids and per-cue positioning
- [bug] Transcribe button in the audio viewer is a silent no-op when no speech model is installed
- [bug] Repeated Transcribe clicks enqueue duplicate STT jobs on the same file
- [bug] A failed subtitle save was invisible in the viewer and the error line unreachable
- [bug] Subtitle length label read the last cue rather than the latest end time
- [bug] The system-audio tap's "read back the negotiated sample rate" guard is inert — it re-reads the value it just set
- [bug] Waveform's "colour repeats but the texture doesn't" guarantee is void whenever the caller supplies `tone`
- [ux] The podcast panel's privacy sentence is false the moment you press Preview
- [ux] A failed script read is presented as "this podcast is an old format — generate it again"
- [ux] The subtitle editor says "Saved" about a file nobody has saved, and its save failure is silent to a screen reader
- [ux] The speaker-recognition threshold is a committed constant with no committed measurement (diarize.rs half)

## Private browser (48)

- [bug] A revealed password field is not fenced, and its value is put into the snapshot the model reads
- [bug] canGoBack is computed by the page script, dropped by Rust, and Back/Forward are enabled unconditionally
- [bug] browse_find silently re-snapshots and invalidates every ref once the marked controls have scrolled out of the visibility band
- [bug] A same-document navigation mid-batch is reported to the model as a failed action, and pays for a screenshot
- [bug] wait_for {gone: …} reports success instantly for any ref it does not know, and words it as the opposite
- [bug] ensure() navigates a page whose content rule list has not been attached yet
- [bug] A tab switch during an agent action is reported to the model as "the page navigated", with another page's URL and snapshot
- [bug] A sub-frame navigation permanently retitles a BACKGROUND tab; only the active page ever self-heals
- [bug] create()'s window-size viewport fallback is dead code — reposition parks the brand-new page at 1×1 in the same call
- [bug] The address bar reverts from the search query to the parked page's URL one poll after a search
- [bug] A failed navigation from the reading view parks the page behind a results list that does not exist
- [bug] Erasing the journal fails silently — the rejection is never caught and nothing is shown
- [bug] A journal read that failed is rendered as "Nothing yet." and disables the only Clear button
- [bug] The room's web cache can only be erased through a button that is disabled whenever the journal is empty
- [bug] Notice timers clobber each other, so a later confirmation can vanish after under a second
- [bug] The Clear confirmation survives closing and reopening the journal panel
- [bug] A failed privacy check latches the shield on "Checking" for that page for the rest of its life
- [bug] A failed result-open offers to search the web for text the user typed into a different, earlier failure
- [bug] The results page steals DOM focus whenever the AGENT searches, turning typing into single-key actions
- [bug] Enter on any button inside the results page navigates to the selected result instead of pressing the button
- [bug] Toggling a search-result peek twice in quick succession re-opens it when the fetch lands
- [bug] Engines that failed are named to the user with the sidecar's internal function names
- [bug] click_at takes CSS pixels but browse_look hands the model an image rescaled with no scale note
- [bug] A numeric `text` in a type action bypasses the outbound consent door entirely
- [bug] `browse_look` and the failed-action snapshot attach pixels regardless of whether the chat model can see
- [bug] The reading view asserts "Encrypted connection" for anything that is not literally http://
- [bug] A page navigation mid-read makes "Read the next part" splice the previous page's text onto the new page
- [bug] A trailing dot on a hostname defeats both the local-name guard and every private-range content rule
- [bug] The private-range content rules only anchor on http/https, so ws:// sub-resources to local services are unblocked
- [ux] The chrome shows no loading state, and Stop is unreachable for the commonest navigation
- [ux] The search skeleton is drawn underneath the still-live page, so a search from an open page shows nothing
- [ux] Re-running a search from the results page leaves the previous results on screen with no sign anything is happening
- [ux] Once you search there is no control that takes you back to the page you were on
- [ux] "◂ Results" brings the list back but leaves the address bar naming the hidden page
- [ux] Two controls in one toolbar open the same journal
- [ux] Six banner rows can stack between the toolbar and the page (removal half)
- [ux] Save selection is offered when nothing is selected, though the app already knows
- [ux] The claim this browser most needs to make disappears the moment you start browsing
- [ux] The journal and the reading view fight for the same pane
- [ux] Clicking away from a half-typed address silently reverts it to the current page
- [ux] "Read as text" is described as an accessibility workaround, not as the reading mode it is
- [ux] The results page says only the query left the Mac while it fetches eight result origins
- [ux] The results page grabs the keyboard into a container with no accessible name
- [ux] `hostOf` is implemented twice, and the two disagree about what an unparseable URL is
- [ux] "Nothing is written to disk" is contradicted by the room's own web cache
- [ux] Toggles that change their label AND set aria-pressed
- [ux] Nothing ties RULE_LIST_ID to the rules it caches, so an edited blocker ships stale
- [ux] No test pins the results page's privacy line (partial — the searchPrivacyLine half only)

## AI chat & agent (38)

- [bug] Regenerate leaves the original question behind, duplicating the user message in the transcript and in the model's history
- [bug] Two turns can start in one chat when the composer's page-scope read is in flight, and the first to finish tears down the second's live overlay
- [bug] Edit & resend ignores the live chat scope entirely — a rewritten question under "This page" is answered from the room while the strip still promises the page
- [bug] The composer is not blocked during a context handoff, so a turn can start against a conversation that is mid-compaction
- [bug] read_skill truncates a large skill at 20 KB with no marker and drops its bundled-resource list entirely
- [bug] organize_files / trash_files ASSIGN effects.wrote, erasing an earlier tool's real write
- [bug] Attachments are silently dropped: the 5th+ image, and any non-image with no extracted text
- [bug] An answer in flight is written into the NEXT room when a second .roomai is opened over the first
- [bug] The per-turn skills preamble is unbounded
- [bug] search_room's already-injected-chunk exclusion is dead (agent.rs half)
- [bug] set_cells' documented legacy single-cell fallback is unreachable
- [bug] edit_file always tells the model 'The user sees the updated file.'
- [bug] #find with an embedding returns the entire room as "matches", and errors outright on a large room
- [bug] The skill autocomplete header states a count that is capped at 10
- [bug] The token bar and its "Hand off" button vanish on a reopened chat
- [bug] A dead Ollama during a cast import is reported as "this file isn't a character sheet", losing the OLLAMA_DOWN sentinel
- [bug] The memory delete is the one memory mutation that drops the host's error on the floor
- [ux] "Summarize the room" reports itself as Working when any unrelated job is running
- [ux] Activity History pays for a model call to restate an exact fact
- [ux] "Everything in here is actionable" — five of the six row types in that section have no control
- [ux] The scope control is two different things wearing one appearance
- [ux] The AI pane's tabs announce a tablist that has no panels (keyboard half)
- [ux] A failed specialist reads as a clean one once the turn is reloaded
- [ux] An answer that rewrote files leaves no durable record of it
- [ux] Edit & resend destroys the rest of the conversation with the count only in a tooltip
- [ux] "Thinking locally…" is the same model-only privacy claim as the trust chip
- [ux] The assistant's answer is never announced
- [ux] Live tool-step chips are unbounded, duplicate the graph, and vanish when the turn ends
- [ux] The token-budget breakdown calls itself a dialog and behaves like nothing
- [ux] The token meter draws one ratio three ways
- [ux] The token meter says "this turn" about the turn before
- [ux] The Memory page never says memories are sent to the model
- [ux] A generated sentence displaces the Memory page's privacy promise
- [ux] Copy all text no longer pastes a model instruction into the clipboard
- [ux] Regenerate asks with the same evidence as the turn it repeats
- [ux] Regenerate stops being a silent one-way door
- [ux] Clipboard failures name the act, not the DOMException class
- [ux] The conversation's name is the only thing in the chat header that shrinks

## Viewers (documents & media) (74)

- [bug] Tooltip is clipped by the stage's overflow:hidden near the right and bottom edges
- [bug] userAdjustedRef is never cleared on a new graph despite its own comment
- [bug] "Deselect" is unreachable — focusId falls back to topNode, so the circled ring never goes away
- [bug] The List view — the documented keyboard/screen-reader equivalent — omits every memory node
- [bug] Labels print on-canvas for stars that are off-canvas
- [bug] A room with one file and many linked memories is told to "add a few files"
- [bug] .ods spreadsheets get a live editable grid whose every write the backend refuses
- [bug] A legacy-encoded CSV is offered the editable grid, but the CSV writer refuses anything that is not strict UTF-8
- [bug] Editing a Word document whose text exceeds 1 MB fails with a message that blames the user for a line they did not touch
- [bug] Grid edits to a non-comma CSV land in the wrong cell and corrupt the row
- [bug] CSV writer never quotes a value containing a bare CR, and the parser deletes bare CRs
- [bug] A CSV with lone-CR line endings collapses into a single row on any cell edit
- [bug] `split_self_closing` drops closing tags, producing malformed presentation.xml
- [bug] Rendered slides cached forever per file id, never invalidated when the bytes change
- [bug] The slide cache clears all 60 entries at the ceiling instead of evicting the oldest
- [bug] A password-protected or otherwise unreadable workbook reports only "Could not parse this spreadsheet"
- [bug] Grid undo performs the file write inside a setState updater
- [bug] The Strength bar hides proven relations before it hides guesses
- [bug] A memory→file link is drawn and described as 'this one names the other by name', which it is not
- [bug] A small drag on a star opens the file — there is no movement threshold on a node click
- [bug] Node tooltips promise a summary line the backend never sends
- [bug] The live meeting-lane ghost is drawn under a speaker name that is not a label, in Speaker 1's colour
- [bug] A file with no extension imports as an unreadable binary with no searchable text
- [bug] TEXT_EXTENSIONS entries "gitignore", "env" and "dockerfile" can never match the files they were added for
- [bug] A password-protected PDF is reported as "incomplete or damaged"
- [bug] Zooming a PDF permanently erases the citation highlight and its "Verified" receipt
- [bug] A legacy .ppt shows "This presentation could not be read" while (and if) macOS is drawing it
- [bug] SlidesView indexes the parsed deck by array position, ignoring the slide number it stores
- [bug] Zip-backed BookView crashes the pane when fflate takes the blob: Worker path the CSP forbids
- [bug] Book "Text" mode claimed a chapter had no text when the zip key differed only in case
- [bug] ArchiveView decompresses the entire zip into memory just to list its names
- [bug] EPUB hrefs are never percent-decoded, so chapters with spaces or non-ASCII names drop out of the spine
- [bug] Speaker notes are attached to the wrong slide in extracted .pptx text
- [bug] smart_filter silently deletes repeated table/ledger rows before the model reads a file
- [bug] Citations into a legacy .doc/.rtf never anchor — the quote is dropped on the success path
- [bug] The frame-quote verifier accepts text that is in the file's markup but not on the page
- [bug] Mermaid diagrams follow the Mac's appearance instead of the app's theme, and never re-theme
- [bug] The map never refreshes when memories change, though it draws memory nodes
- [bug] MAX_NODES = 800 truncation branch is unreachable — the backend caps the graph at 120 nodes
- [bug] A notebook code cell containing a fence breaks out of its code block and renders as prose
- [bug] Quote highlighting allocates one JS object per character of the whole document, up to eight times
- [bug] The QuickLook temp-file leak test for extension-less files asserts nothing
- [bug] A CRLF document is chunked as one paragraph and its line structure is destroyed
- [bug] Dead reduced-motion escape hatch for a transition that no longer exists
- [bug] The tooltip is never cleared when the link it describes stops being drawn
- [ux] The transcript never follows playback
- [ux] A recording with audio and no transcript dead-ends
- [ux] Nothing says which model reads the recording, and it reads it automatically on Stop
- [ux] Renaming a speaker is invisible unless you hover the chip
- [ux] "Read this recording" is offered on recordings the engine will refuse to read
- [ux] Delete the Clips aside — it is the transcript again, in a narrower column
- [ux] Timestamp buttons promise "Play from here" while recording, and do nothing
- [ux] Naming a voice teaches the whole room, and only the receipt says so
- [ux] "Show deleted" is offered on every recording, including the ones with nothing deleted
- [ux] Clicking a word starts playback
- [ux] Playback speed and volume reset to 1× on every recording you open
- [ux] Subtitles are exported timed to a file that may not exist
- [ux] The transcript's accessible name promises edits that a live recording refuses
- [ux] "Listening… speak, or bring the meeting on" is shown while paused and while saving
- [ux] Deleted transcript words are read aloud as if they were still in the recording
- [ux] The translate drawer shows "Translating 0/1…" before it knows how many parts there are
- [ux] The tabs' doc comment describes a design that was removed
- [ux] Where the mouse happens to be decides what ⌘F does
- [ux] Four verbs for one phase: Opening / Reading / Loading / Preparing
- [ux] A slide that is not being drawn says "Drawing slide…" forever
- [ux] Three viewers end in a "Reading…" state that nothing ever clears
- [ux] A deck's slide rail promises thumbnails and draws a numbered list
- [ux] An RTF shows its selectable text with a caption underneath saying the text cannot be selected
- [ux] Waiting, failing and empty are all the same dim grey line (DocxView only)
- [ux] A Hebrew note reads correctly in chat and backwards as a file (partial — the MarkdownView half)
- [ux] Four different controls that all mean "show me the raw form"
- [ux] An SVG document is marked decorative and never named
- [ux] Two buttons labelled Find, in the same family, doing unrelated things
- [ux] role="status" is missing from the readout that actually changes

## Sketch & drawing (25)

- [bug] A pending autosave fires after the agent's document is folded in and erases the agent's work from disk
- [bug] The shape the user just finished is dropped by the agent merge (endGesture merges against a stale docRef)
- [bug] The eraser deletes locked elements, and a locked element selected from the object strip can still be nudged and resized
- [bug] The note text field is positioned as a percentage of the document
- [bug] Every keystroke in the Label field pushes a whole-document undo snapshot
- [bug] A line's label is drawn at the canvas origin (canvas renderer half)
- [bug] One ⌘Z after the assistant draws deletes its entire diagram and autosaves the deletion
- [bug] A save that lands while a newer edit is pending clears the dirty flag, so the unmount flush skips the newer edit
- [bug] A failed autosave is never retried
- [bug] `canvas W H` makes a page nothing can be placed on, and a resize-only script is never saved
- [bug] An arrow or line with fewer than two points panics three Rust paths
- [bug] The two "the editor routes exactly like Rust" tests only grep for a function name, and the two routers genuinely differ
- [bug] The element ceiling counts a script's additions without its deletions
- [bug] `move` on a connector is reported as done and then silently undone by reflow
- [bug] The draw tool tells the model to call `see_drawing`, a tool that was deleted
- [bug] `draw` swallows resolve()'s ambiguity refusal and quietly starts a third drawing instead
- [ux] Sketch's window keydown deletes objects from anywhere in the app
- [ux] Arrow keys inside the sketch object list silently move the shape
- [ux] The object strip puts one tab stop per shape between the canvas and the footer
- [ux] A pen stroke's label is accepted and never drawn
- [ux] The sketch empty state's third card promises a diagram and prints a sentence
- [ux] The tool that stays on has no way to be discovered
- [ux] The sketch canvas is declared an application but can never be focused
- [ux] The Sketch landing's "New sketch" button cannot be clicked
- [ux] Seven stale blue --accent fallbacks in the sketch viewer

## Create & Studio (30)

- [bug] The cast strip issues one whole-room thumbnail build per cast member
- [bug] Every keystroke in the shot-list title or logline is a round-trip that rewrites the whole board
- [bug] A cast portrait older than the 150 newest room images renders as a permanent blank face
- [bug] A one-shot list claims the chosen clip model takes no starting picture
- [bug] Applying a script split with no models chosen writes shots that nothing can make
- [bug] One failed media catalogue erases the OTHER catalogue's models from the Create page, with a fabricated reason, for an hour (P1)
- [bug] A partial media-catalogue load empties one whole Create tab and blames the models for it (P2, same defect as the P1 above)
- [bug] A model listed by BOTH media catalogues loses its durations and frame slots
- [bug] ensure_media_limits is not single-flighted: a concurrent caller proceeds with an empty limits table
- [bug] Stop on a podcast recording stops nothing (host half)
- [bug] Renaming podcast hosts collapses every turn onto one speaker
- [bug] Stale doc promises a per-turn progress callback that does not exist
- [bug] Duplicate host names are accepted and collapse the episode into one voice
- [bug] A fifth cast member on a shot is silently truncated but stays ticked in the UI
- [bug] A first frame stays attached and billed after switching to a model that takes none
- [bug] The Story tab is unreachable whenever no provider catalogue loads
- [bug] OCR silently drops PDF pages it cannot rasterise while claiming it reports whatever it cut
- [ux] The Create page shows a progress bar pinned at 0% for the whole run
- [ux] The Create page's "made in this room" grid lists every sketch and the room summary
- [ux] Two identical model filters, on screen at once, bound to one state
- [ux] The Make button never says how many it is about to make
- [ux] var(--radius-md) is not defined - four Create-page surfaces render with square corners
- [ux] Three more tokens are referenced and never defined (create.css share)
- [ux] Six destination titles, three sizes, four weights - two of them a weight the font does not have (create.css share)
- [ux] Three text fields drop the app's focus ring for a colour-only signal (create.css share)
- [ux] "Take it to Story" no longer dead-ends on the empty shot list
- [ux] Deleted the dead privacy statement `StorySeam`
- [ux] Studio rows never admit that a run is already going
- [ux] Escape is a dead key in the Create-page sheets (PicturePicker's share)
- [ux] "See the card in the sidebar" points at a pane that has no such card

## Files, folders & search (24)

- [bug] import_files never emits room-files-changed, so every other room surface goes stale after an import
- [bug] store_file_bytes is not atomic: a failed save still cuts a version and can evict the oldest one
- [bug] Import stores the file name verbatim, so two same-named files are indistinguishable
- [bug] Dropping a FOLDER onto the window fails with a raw errno per folder
- [bug] Search snippets centre on the first word of the query, which is usually a stopword
- [bug] A long turn with one early blank line is cut to almost nothing in the conversation hand-off
- [bug] organize_files silently drops an entry when its name no longer re-resolves to the same file
- [bug] organize_files' blast-radius cap covers only file entries — make_folders and remove_folders are unbounded
- [bug] folder_id_for's create=false branch is unreachable dead code
- [bug] merge_files writes its output under a fixed name with no available_name
- [bug] move_file_to_folder accepts any folder id and any file id, and reports success either way
- [bug] rename_folder reports success when the folder no longer exists
- [bug] delete_folder reports success for a folder id that does not exist, and its two writes are not one transaction
- [bug] One large file can crowd other files out of the search results
- [bug] search_all applies two different matching rules to one query (OR for file content, AND for everything else)
- [bug] Editing or adding a memory silently truncates it to 500 characters
- [bug] Editing a memory that no longer exists reports success and silently discards the text
- [bug] `db::update_memory` has no trash filter, and the by-id trash guard test only scans the files table
- [bug] `duckduckgo` is the one engine not wrapped in `_fails_soft`, so one parse error kills the entire web search
- [bug] room_file_count's doc claims the Library badge shares its definition; the badge uses a different one
- [ux] The empty-state rule contradicts the comment directly above it
- [ux] A doc comment describing the embed pass is orphaned onto the re-extraction pass
- [ux] The embedding backfill decides what the model can find, and has no test
- [ux] A file row's selected state is invisible to a screen reader

## Jobs & workflows (24)

- [bug] A script step that parks for approval is recorded as "error", so the agent is told to fix a script that isn't broken
- [bug] Starting a run deletes the workflow's parked job before checking the queue cap
- [bug] A script_run node is not idempotent across a wave replay — a resumed workflow re-executes the script
- [bug] The "already running or queued" guard is a TOCTOU across two awaits — double-clicking Run now queues the workflow twice
- [bug] Route node: the validator matches edges against trimmed labels while the runtime sends the raw list
- [bug] A part-failed multi-variation generation reports success and throws away the reason
- [bug] A chain-parked clip is never woken when the shot before it fails
- [bug] A model's published reference limit is enforced only in the bench
- [bug] PlannedRow::prev_clip_file_id is computed and never read outside tests
- [bug] The live pipeline diagram never animates for a run started from the workflow detail pane
- [bug] Save-and-Activate activates the workflow even when the save failed
- [bug] A workflow_runs row was only ever closed by the runner's epilogue
- [bug] Resume on a podcast recording re-sent the entire script to Microsoft from turn 0
- [bug] jobs, job_artifacts and workflow_runs were never pruned
- [bug] The queue's FIFO order was undefined among jobs created in the same second
- [bug] An unread recording starves the auto-index summary sweep, permanently when the read cannot start
- [bug] A finished download job reports "Finished — 0 of 100 steps" in Activity history
- [bug] Resuming a workflow re-drives its file_pass node from scratch and mints a brand-new child job row every time
- [bug] Re-activating a workflow fires a missed run immediately, ignoring the "Catch up at unlock" setting
- [bug] Run history fetches a run's steps using the CURRENT — even unsaved — node count
- [ux] You cannot test-run a workflow before activating it + Run now is enabled on a file-scoped workflow and is guaranteed to fail
- [ux] Selecting a step in the pipeline scrolls nothing, so the click reads as a no-op
- [ux] A draft workflow's card promises a run the scheduler will never make
- [ux] Clippy is in package.json and in CI, and has never been able to fail anything

## Skills (18)

- [bug] Folder import walks hidden directories (.git / .DS_Store)
- [bug] A folder whose SKILL.md is lowercase imports and is then refused with a path-escape message
- [bug] normalize_skill_path accepts a trailing slash, creating a nameless resource that breaks Export folder
- [bug] A resource path that is also a directory prefix breaks Export folder and every script run
- [bug] Enabling a deleted skill leaks "Query returned no rows" instead of SKILL_GONE
- [bug] compose_skill discards a fully generated skill when its name clashes
- [bug] Decrypted skill resources survive a crash in the app cache under a random name nothing sweeps
- [bug] Saving, adding or removing a resource file silently throws away unsaved SKILL.md edits
- [bug] Selecting another skill while editing discards unsaved work without asking
- [bug] Enabling a skill after a failed save reports success and silently drops the edits
- [bug] The open editor never reloads on skills-changed, so an assistant write is silently overwritten by the next Save
- [bug] The assistant deleting the open skill unmounts the editor mid-edit with no prompt and no toast
- [bug] The Skills editor cannot save a skill whose owner is not in the roster
- [bug] delete_skill_resource reports success for a path that was never there
- [bug] A missing skill resource surfaces raw SQLite text ("Query returned no rows") to both the user and the model
- [ux] Saving a new skill fails through a toast; workflows validate inline
- [ux] "New skill" then "← All skills" always asks to discard work that does not exist
- [ux] The skills source picker binds Escape to one input, not the sheet

## Scripts (15)

- [bug] A uv the app downloaded is invisible to the script runner, which then says `brew install uv`
- [bug] An auto-heal retry can run for twice the script's declared room-timeout
- [bug] Output over 32 KB loses its BEGINNING but is labelled "(output truncated)" at the end
- [bug] A timed-out script discards everything it printed
- [bug] Auto-heal installs PyPI packages the consent card never named
- [bug] A declared output that was materialized as an input is re-imported even when the script never wrote it
- [bug] A script that writes a filename it never mentions overwrites the room file and the report calls it "Created"
- [bug] The Scripts page "Reads" field lists only declared inputs, hiding the room files the run actually decrypts
- [bug] Downloaded runtimes are executed with no integrity verification, and uv is fetched from an unpinned `latest` URL
- [bug] Downloaded `uv`/`node` runtimes are extracted and put first on the connector PATH with no checksum or signature check
- [bug] The Scripts incident card shows the advice sentence as the failure's "cause"
- [ux] The Scripts empty state teaches the manifest but not what a run is allowed to do
- [ux] The Scripts empty state offers the same New script button twice
- [ux] Nothing fails the build when a new format falls out of the fill, reader or quotable set
- [ux] No test holds the Create page to the app's own progress-honesty rule

## Connectors (MCP) (19)

- [bug] Per-connector permission grants (and the session "always allow") are keyed by name and survive removal
- [bug] `mcp_oauth_authorize` writes a config snapshot taken before the browser round-trip, into whatever room is open when it returns
- [bug] A stored OAuth token follows a connector NAME onto a new destination — only the agent path cleared it on retarget
- [bug] Writing a per-connector permission grant reports success even when the persist fails
- [bug] MCP OAuth follows connector-supplied endpoints with only a literal-IP check (SSRF)
- [bug] OAuth sign-in requests every scope the authorization server advertises
- [bug] RFC 8414 discovery URL is built by appending, so any issuer with a path fails sign-in
- [bug] The OAuth loopback callback parser panics on a % followed by a non-ASCII byte
- [bug] The OAuth loopback listener accepts exactly one connection and reads it once with no timeout
- [bug] Discovery tries only the first authorization server and drops the resource path from the well-known PRM URL
- [bug] `run_mcp_tool` forwards `arguments` unvalidated, and a non-object silently becomes `{}`
- [bug] Marketplace icon fetch is an unguarded SSRF: registry-supplied URLs are fetched with no private-address check
- [bug] The install drawer states flatly that Arcelle redacts and asks — a claim the two connector powers can make false
- [bug] A stale frontend copy of the config silently wipes the OAuth bearer the backend just wrote
- [bug] A connector's `resource` content blocks are discarded as "[resource content omitted]"
- [ux] A connector's API key is masked as you type it and shown in clear text below
- [ux] A failed connector states the error and no way to retry it
- [ux] The install drawer says "Installed ✓" without knowing whether the connector started
- [ux] Dead code: the guided connector form nothing renders

## Settings (25)

- [bug] Settings → Model promises "images stay local" while grounding_pick deliberately prefers the room's own cloud model
- [bug] Settings → Model says models "run locally through Ollama" while the Closet relays them off the Mac
- [bug] Disconnecting OpenRouter can point the room at an embedding model, an Ollama cloud relay, or the very model just disconnected
- [bug] AI advisors offered (and labelled "OpenRouter") when no advisor CLI exists
- [bug] Focus trap is escapable after a backdrop click when work is unsaved
- [bug] Turning the room MCP server off and on again silently downgrades a saved "Full agent" scope to "Files only"
- [bug] Model delete confirm disarms itself after 3 seconds
- [bug] Closing Settings mid-preview leaves the voice talking with no way to stop it
- [ux] A failed model download reports itself at the bottom of whatever page you are on (PARTIAL)
- [ux] With unsaved work, Escape can never close Settings and focus never reaches the question
- [ux] The page index is six unconditional tab stops with no arrow-key model
- [ux] Two behavior checkboxes state no consequence
- [ux] Behavior's Save button sits mid-section, above three checkboxes that never needed saving
- [ux] Nothing says which settings belong to this room and which to this Mac (Behavior only)
- [ux] Downloading a helper paints two progress bars at once, one of them unlabelled under the wrong control
- [ux] Settings' model delete re-implements DeleteControl and strands focus (+ the icon-only button with no accessible name)
- [ux] 'Reset to Arcelle defaults' does not reset the open room's panes, and says it does
- [ux] The Density hint names the wrong pages as the rough ones
- [ux] AI helpers hides the true vision answer behind 'Ollama is not running'
- [ux] Choosing 'Full agent' silently drops the cloud-client gate the user just declined
- [ux] Settings retires a working recovery code without saying it did
- [ux] 'Test connection' saves the remote-AI address even when the test fails — and Settings then says it is unsaved
- [ux] Spoken voice does nothing while the internet switch is off, and neither section says so
- [ux] AI advisors points at 'Connected tools (MCP) below' — nothing is below
- [ux] A button labelled 'Test' writes the room's internet settings before testing

## App shell & navigation (70)

- [bug] Trashing the room's last file leaves a ghost tab that persists across relaunch
- [bug] Renaming the room re-runs the tab/area restore and closes the open section-only document
- [bug] Tab shortcuts still switch Home documents from destinations that draw no tab strip
- [bug] Legacy area tabs elect the last file tab when pruned
- [bug] The file-header Run button promises to run an unapproved script
- [bug] The frame-quote document cache never invalidates on content change
- [bug] The quote rule checks both ends for containment but only one for exclusion
- [bug] Frame-quote verification ignores an encoding override
- [bug] The parked "recording could not be restored" message is consumed by its own 2-second fallback emit
- [bug] The parked recording-recovery message is never cleared on lock, so it can surface inside a DIFFERENT room
- [bug] The mic tap is never stopped when the workspace unmounts
- [bug] The Library's ⌘A steals Select-All from the whole window while Home is the destination
- [bug] Trash footer's "Restore selected" counts ids the panel has already dropped
- [bug] The shortcuts sheet, presented as the complete list, omitted ⌘T
- [bug] Only the first queued approval card was rendered, so a second could expire unseen
- [bug] ⌘W does nothing at the start screen and password gate — the only Close row is disabled with no room open
- [bug] Escape closes the open file without the unsaved-edits guard
- [ux] The empty viewer promises privacy from a hardcoded string that reads no state
- [ux] The first screen after unlock invites a question the room cannot answer yet
- [ux] 'Summarize room' is disabled with its reason sealed inside a tooltip that cannot open
- [ux] "Ask the assistant about this" can land in a pane nobody can see, and destroys the composer draft
- [ux] Two popovers let Escape close the file behind them
- [ux] Three per-kind sets live outside the registry (partial: the stale set only)
- [ux] A .txt and a PDF each draw two reading-progress strokes (partial)
- [ux] The cloud-payload view is full-height or not depending on which file you opened it from
- [ux] The Creations sidebar prints "Filming… 43% 0/100"
- [ux] SIMPLIFY: the Recordings sidebar offers the same two verbs twice, plus five that don't belong
- [ux] SIMPLIFY: "Focus this pane" can give a file list the whole window, with no way out
- [ux] Delete the sidebar's import strip — the assistant pane already shows the same import, with more
- [ux] The Skills sidebar hides the two states that mean a skill can never fire
- [ux] Four containers claim role="toolbar" and none implements it (the two containers in my files)
- [ux] The folder collapse control announces a triangle
- [ux] shell.css carries 215 lines of Studio/Activity CSS that is shadowed in every instance (items #2 + #4)
- [ux] 86 font sizes sit below the floor the type scale declares (item #1, folding in #3 and #7)
- [ux] Every selected row puts --faint on a ground it was never solved against (item #0, shell.css half)
- [ux] ⌘W is documented as "close the current tab" and can close the window (item #12)
- [ux] The shortcuts sheet under-reports what the keyboard actually does (item #14)
- [ux] ⌘K is the complete route to destinations only — not to what lives inside them (item #10)
- [ux] A failed auto-lock is completely silent
- [ux] The token meter and Hand off disappear on restart, though the numbers were saved
- [ux] The recovery sheet said 'Copied' whether or not the clipboard write succeeded
- [ux] The recovery key is a second file on disk, and the app never said so (PART 1)
- [ux] Printing the recovery code does not count as saving it, contrary to the file's own comment
- [ux] The Touch ID tip is shown to Macs that have no Touch ID
- [ux] The recovery-unlock screen states one origin for a code that has three (merged with 'Nothing follows a recovery unlock')
- [ux] A recovery unlock blames the code for every failure, including a damaged room or a missing drive
- [ux] When the recovery code cannot be written, the room opens anyway and nobody is told it has no recovery key
- [ux] A recent room whose file is gone still sends you to a password form for a file that is not there
- [ux] 'Try a demo room' is the full five-step room-creation ceremony
- [ux] The gate's lead sentence promises "never leaves this computer" for every room
- [ux] The gate promises 'Offline by default' while the app contacts GitHub on every launch
- [ux] Two groups of destinations, four names for them
- [ux] Two destinations pin the rail's disclosure open by proxy, and one row can be current twice
- [ux] The trust chip says "nothing leaves the device" while the chip next to it says "Internet tools on" (+ What is reaching the internet is only readable with a mouse)
- [ux] "N jobs running" counts jobs that are not running
- [ux] Delete the status bar's layout readout — it reports what the screen is already showing
- [ux] Reset Layout dropped from the ⋯ room menu (one name, four surfaces)
- [ux] The recording chip stops calling a finished capture "a live recording"
- [ux] "Sidebar" stops naming two different columns inside one View menu
- [ux] Zoom into a picture and the zoom controls scroll away
- [ux] The words OCR read off a picture are rendered as source code
- [ux] Double-clicking a 5px divider resets the entire window layout
- [ux] The crash card asserts that nothing was written, which a render boundary cannot know
- [ux] Drop "Try again" from the full-window crash card
- [ux] paper.css ships primitives with no consumers, five of them decorative draw-in animations
- [ux] --fs-lead and --fs-card are one rung wearing two names
- [ux] Eight legacy aliases are kept warm for rules that no longer exist
- [ux] The status bar counts the room summary twice while it starts
- [ux] The toast stack's wrapper aria-live downgrades the error toasts
- [ux] The tab model still carries a kind nothing can create (comment half only)

## Voice & speech (5)

- [bug] The sentence splitter cuts inside URLs, so raw URLs are read aloud
- [bug] Manual Play or Settings Preview during an answer silently kills hands-free
- [bug] A synthesis failure that lands after Stop still toasts "Couldn't read that aloud"
- [bug] The spoken-voice pipeline has no automated test
- [bug] Pressing Play on a second answer leaves no message marked as speaking — the Stop button never appears

## AI engine (sidecar) (11)

- [bug] Stop is not sampled during compaction, and each digest pass is an uncancellable 15-minute subprocess
- [bug] Flattening the transcript for a cloud CLI destroys the role boundary, so tool-result text can forge a user turn
- [bug] `ExternalChatModel` stores the engine's reported window on the shared instance, so concurrent delegated children overwrite each other
- [bug] One-shot generation on a provider engine has no window fit at all, while the local twin does
- [bug] Dead `while True: … break` in the provider stream loop
- [bug] A dead network on an OpenRouter room is reported as OLLAMA_DOWN, so the UI says "The local AI isn't running" and offers to open Ollama
- [bug] The compaction digest drops every tool call and tool name
- [bug] A podcast turn with no ASCII spaces is sent to the voice service as one over-limit request
- [bug] Image references have no size ceiling, unlike video references
- [bug] `summarize._gather_window` sizes a cloud room's file-read budget off the Mac's RAM ceiling instead of the provider's own window
- [bug] Compaction orphans tool results: the assistant tool_calls turn is digested away while its role:tool replies remain

## Tests & checks (3)

- [bug] Nothing reports a registered command with no caller
- [ux] The mock-coverage report treats a missing READ the same as a missing mutation
- [ux] e2e/README.md's map of the UI-regression suite is three specs out of date

## Other (54)

- [bug] section on Markdown silently turns off the tolerant matcher and blames parameters the caller never passed
- [bug] A clipped diff card shows the first 200 KB of the file, so a change past that offset is approved unseen
- [bug] section + all: true on a Markdown file: all is ignored and the error tells the model to pass all: true
- [bug] A match that starts or ends inside an fi/fl ligature silently deletes the other half of the character
- [bug] A batch that renames a file's type derives the searchable text with the NEW name
- [bug] The approval card's before pane renders a legacy-encoded text file as mojibake
- [bug] No test checks api.ts argument names against the Rust handlers
- [bug] Double-clicking Resume orphans a microphone tap that never stops
- [bug] Audio batches are pushed without chaining, so the mic timeline can be re-ordered at the TS<->Rust seam
- [bug] `vision_door_block` asserts "can look at images" for a model whose vision support is Unknown
- [bug] `agents_known` reports "the sidecar did not answer" when the sidecar answered with an empty or undecodable agent list
- [bug] The per-answer Undo chip restores the newest version, so it can roll back the user's own later save
- [bug] Undo reverts only the last of several AI writes to the same file in one answer
- [bug] viewFile has no staleness guard, so two quick opens can paint the loser over the winner
- [bug] A failed rollback copy strands a full-size `.swap-<uuid>` file beside the room forever
- [bug] The waveform after "Continue recording" is the pre-continuation envelope — the peak cache is never invalidated
- [bug] The waveform cache is never invalidated when a file's audio changes (duplicate report of the peaks defect)
- [bug] `feedback_draft`'s doc comment promises feedback never leaves the Mac; the code sent it to the room's cloud engine
- [bug] `feedback_draft` turns a shape drift from the sidecar into a silently empty draft
- [bug] Every cell commit remounted the grid, destroying the change marks and ⌘Z history
- [bug] ViewerChunkBoundary latched, so one failed lazy import poisoned every later viewer
- [bug] A force-quit or crash orphans the `ollama serve` the app started, and it is never adopted or stopped again
- [bug] The Ollama idle watcher can SIGTERM the daemon microseconds after a new call has taken its Busy guard
- [bug] Quitting from full screen saves the full-screen rectangle, so the next launch opens a whole-display window
- [bug] The unsaved-edits dialog claims aria-modal but does not trap focus
- [bug] A no-op .docx save is reported as a failed save and blocks the unsaved-edits dialog
- [bug] The .doc HYPERLINK field resolver can delete prose between the keyword and the next quoted string
- [bug] A room summary whose file is trashed mid-run is written into the trashed row and then reported as an error
- [bug] `EngineCapabilities` omits the two generation capabilities the host sends, and the `Capability` union omits two values the host accepts
- [bug] Opening a different file (library click, Cmd-K hit, agent open, job toast, recording chip) discards unsaved edits
- [ux] Icon-only quick actions take a sentence-long hint as their accessible name
- [ux] Quick-action pills are disabled with the real attribute
- [ux] Closing the quick-actions menu drops keyboard focus onto nothing
- [ux] The Recordings shelf sends the newest recording's name to the room's model to write a subtitle
- [ux] Three words for one thing: transcribe, write up, read (partial)
- [ux] Home's generated subtitle sends a room item's title to whatever engine the room is set to — including a cloud one — to rewrite the line promising nothing leaves this Mac
- [ux] Delete the AI-written subtitle on Room Home
- [ux] 'Work in this room' is a second copy of the rail + Home lists the destinations a third time, and the list is wrong
- [ux] Delete the permanent 'start here' marginalia
- [ux] The AI-action dialog can send the whole room to a cloud model without saying so
- [ux] The translate action focuses the prompt, not the language field it requires
- [ux] Escape does nothing in the feedback modal
- [ux] The bug-report sheet offers "the errors shown this session" — the log is fed only by toasts
- [ux] Starting a launch-time update download cannot be stopped
- [ux] The updater draws a progress track that stays at 0% for the whole download
- [ux] "New page" is two different things on the same shortcut
- [ux] Draw the agent graph only in the overlay; leave a roster line in the transcript
- [ux] The expanded agent graph is unreachable by keyboard
- [ux] Ten modals say aria-modal="true" and let Tab walk out behind them (CompareModal's share)
- [ux] Moving a file to the trash offers no Undo, though the toast machinery and the restore call both exist
- [ux] Every message in the transcript is stamped with a time and no day
- [ux] Four names for the one actor the user talks to
- [ux] "New script" produces two indistinguishable "New script.py" rows
- [ux] seal.css re-declares the motion system on :root