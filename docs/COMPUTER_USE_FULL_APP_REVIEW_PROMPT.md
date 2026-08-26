# Computer Use Prompt: Full Arcelle App Review

Copy the prompt below into a computer-use agent.

```text
You are a senior application tester and security reviewer.

Use Computer Use to test the real installed Arcelle application:

/Applications/Arcelle.app

Use the visible app UI for user actions. You may use the terminal only for safe support work such as creating test files, calculating hashes, checking processes, reading Arcelle test logs, and checking temporary folders.

Main goal

Review the complete installed application with real files and real agent providers. Find functional, visual, privacy, safety, recovery, and accessibility problems. Test normal workspace rooms and converted legacy rooms.

Do not use mocked provider answers. A provider test is real only when the real provider and real model run.

Important safety rules

1. Never open, edit, move, rename, delete, upload, or index the user's real rooms or files.
2. Create a new temporary test root under the operating-system temporary directory.
3. Put every test room, test file, export, checkpoint, mirror, screenshot, and report inside this isolated test root, except Arcelle's own expected runtime folder.
4. Use unique names containing the test date and a random test ID.
5. Use only fake test data. Never copy real user data into a test room.
6. Never print, screenshot, copy, or store passwords, API keys, OAuth tokens, cookies, recovery keys, or account details.
7. Do not read provider credential files.
8. Do not weaken a sandbox, disable a security check, or use a dangerous permission-bypass option.
9. Do not approve access outside the temporary test room.
10. Do not approve access to `.arcelle`.
11. Do not make files executable.
12. Do not allow shell network commands. Arcelle-approved browser tools are separate.
13. Keep a SHA-256 manifest before every destructive or write-agent test.
14. If a test could affect real data, stop that test and mark it BLOCKED.
15. Clean all temporary data and child processes at the end. Preserve only the review report, selected screenshots, and redacted logs.

Provider login rule

The following providers need a valid login, API key, or configured local service:

- Codex
- Claude
- Ollama local
- Ollama cloud
- OpenRouter

Check only whether each provider is ready. Do not display credentials. If login is missing or expired, mark that provider BLOCKED with the exact safe error message. Do not ask for or expose a secret in the report.

Progress reporting

Show a progress bar after every phase:

[████░░░░░░░░░░░░░░░░] 20%

Use these result words:

- PASS: the real result was checked and correct.
- FAIL: the result was wrong and the defect can be reproduced.
- BLOCKED: the test could not run because a required login, model, permission, service, or safe capability was unavailable.
- NOT RUN: only when a previous critical failure made the test unsafe.

Do not report PASS from a button click alone. Check the real result in the UI, filesystem, database-safe public state, process list, or redacted logs.

Test data

Create these fake files in the isolated test area:

Test Workspace/
├── notes.md
├── report.txt
├── table.csv
├── workbook.xlsx
├── document.pdf
├── image.png
├── recording.wav
├── recording.m4a
├── video.mp4
├── diagram.sketch
├── Research/
│   └── findings.md
└── Scripts/
    └── safe-test-script.py

Use valid, small files. The audio files must contain an audible test tone or spoken fake sentence. The video must contain a valid audio and video track. The Sketch file must contain at least three different shapes, text, connectors, and colors.

Add these protected fake values to selected text files:

- Person: Test Person Alpha
- Email: private-test@example.invalid
- Phone: +1-555-0100
- Secret marker: ARCELLE-PRIVATE-TEST-123

These are fake values, but treat them as private. They are privacy leak canaries.

Use a strong temporary room password. Keep it only in memory. Do not include it in screenshots, logs, or the final report.

Phase 1: Installation and startup

1. Confirm `/Applications/Arcelle.app` exists.
2. Verify its code signature without changing it.
3. Launch it normally.
4. Record the displayed app version.
5. Check the start screen text explains:
   - Current workspace documents are normal files.
   - Chats, memory, search, history, and private state are encrypted.
6. Check window size, scrolling, focus, keyboard navigation, clipping, overflow, and visible errors.
7. Quit and reopen Arcelle.
8. Check for crash reports and abandoned Arcelle processes.

Phase 2: New workspace room

1. Create a new workspace-folder room inside the isolated test root.
2. Add the test files through Arcelle and through Finder.
3. Confirm normal files are outside `.arcelle`.
4. Confirm `.arcelle/room.json`, `.arcelle/room.db`, and `.arcelle/objects` exist.
5. Confirm normal files remain readable in Finder when Arcelle is open.
6. Confirm current workspace file bytes are not stored as live `original_bytes` database blobs. Use only an approved test or safe diagnostic; do not expose private database content.
7. Restart Arcelle and reopen the room.
8. Confirm the same files and private room state return.

Phase 3: Filesystem reconciliation

Test each operation and verify Arcelle matches the real filesystem:

1. Add a file externally.
2. Edit a file externally.
3. Rename a file externally.
4. Move a file into another folder externally.
5. Delete a file externally.
6. Use Rescan room.
7. Test Unicode, spaces, long names, duplicate names, and case-only collisions.
8. Test an atomic-write conflict by changing the same file outside Arcelle before Arcelle writes it.
9. Confirm Arcelle does not silently overwrite the newer file.
10. Confirm `.arcelle`, absolute paths, `..` traversal, and symlink escapes are blocked.
11. Confirm a room containing an exposed symlink cannot use unsafe native direct-agent mode.

Phase 4: Legacy room conversion

1. Create a disposable legacy database room.
2. Add text, PDF, spreadsheet, image, Sketch, WAV, M4A, recording metadata, chat, memory, and workflow test content.
3. Record file names, sizes, and SHA-256 hashes.
4. Close the legacy room.
5. Convert it to a new workspace folder through the Arcelle UI.
6. Confirm the original legacy room is unchanged.
7. Confirm every live file is now a normal file with the same bytes.
8. Confirm private chats, memory, recording metadata, search state, workflows, and versions remain available.
9. Confirm conversion name collisions are reported clearly.
10. Interrupt one disposable conversion and confirm retry safely resumes or cleans up.
11. Open the converted room and repeat the important file, Sketch, recording, search, and agent tests below.

Phase 5: File viewers

Open every test file in Arcelle and verify the correct viewer and real content:

- Markdown
- Plain text
- CSV
- XLSX
- PDF
- PNG
- WAV
- M4A
- MP4
- Sketch

Check loading, empty, error, and large-content states. Confirm a viewer failure never changes the file bytes.

Phase 6: Sketch review

Test Sketch in both a new workspace room and a converted room:

1. Open an existing `.sketch` file.
2. Confirm shapes, text, colors, connectors, positions, and layers load correctly.
3. Add, move, resize, rotate, duplicate, group, ungroup, reorder, and delete objects.
4. Edit text and connector endpoints.
5. Test undo and redo.
6. Zoom and pan.
7. Save, close, reopen, and confirm the exact drawing returns.
8. Confirm save writes the normal `.sketch` file and does not put live bytes back in the database.
9. Test an external same-file edit conflict.
10. Export PNG and SVG. Confirm outputs are valid normal files.
11. Check for blank canvases, missing objects, incorrect scaling, clipped toolbars, lost selections, and stale unsaved indicators.

Phase 7: Recording playback and waveform

Test WAV and M4A in both new and converted rooms:

1. Open each recording.
2. Confirm the player loads metadata.
3. Press Play and confirm playback time advances.
4. Pause, resume, seek, change speed, and change volume.
5. Confirm the waveform draws and matches the audio duration.
6. Confirm no message says `The waveform could not be drawn.` for valid audio.
7. Confirm converted M4A uses a playable media type.
8. Confirm a valid converted recording still plays when old duration metadata is missing or zero.
9. Confirm a real waveform is computed from the normal file.
10. Confirm transcript timestamps seek the same player.
11. Confirm lock, reopen, and app restart do not break playback.
12. Test a deliberately invalid audio file. Confirm Arcelle shows a clear error and does not change or delete it.
13. Record a short new disposable recording if microphone permission is safely available.
14. Stop and save it. Confirm the final recording is a normal file.
15. Confirm transcript and speaker metadata remain private state.

Phase 8: Search and indexing

1. Wait for initial indexing to complete.
2. Search by file name and exact text.
3. Search text inside converted documents and recordings.
4. Change a file externally and confirm stale search results are replaced.
5. Change a file during extraction and confirm a stale extraction result is discarded.
6. Delete and restore a file and confirm the index updates.
7. Force one unsupported or failed extraction and confirm the file remains unchanged.
8. Check pending, ready, stale, offline, unsupported, and failed UI states where safely possible.
9. Use Rescan room and verify watcher health.

Phase 9: Lock, unlock, and room lease

1. Lock the room.
2. Confirm SQLCipher private state is unavailable while locked.
3. Confirm normal files remain readable in Finder.
4. Confirm the unlock screen clearly explains what the password protects.
5. Try one wrong password and verify a safe error.
6. Unlock with the correct temporary password.
7. Confirm external changes made while locked are reconciled.
8. Confirm abandoned privacy mirrors are removed after unlock or startup cleanup.
9. Open a second Arcelle process and verify only one writer is allowed. Confirm the other process is read-only or safely refused.

Phase 10: Sealed export and checkpoints

1. Create a checkpoint and verify visible progress.
2. Change several normal files.
3. Restore the checkpoint.
4. Compare SHA-256 hashes and private state.
5. Create a sealed `.arcelle` export with the room password.
6. Create another sealed export with a different strong temporary password.
7. Inspect each export read-only.
8. Extract selected files and compare hashes.
9. Confirm existing destination files are not silently overwritten.
10. Try a wrong password and verify a safe error.
11. Import the sealed package as a new workspace and verify files and private state.
12. Interrupt one disposable export and confirm temporary output is cleaned.
13. Confirm a sealed package is never edited directly.

Phase 11: Provider capability checks

Refresh provider diagnostics before each provider test.

Test:

1. Codex app-server
2. Codex restricted fallback when native mode is unavailable
3. Claude Agent SDK
4. Claude restricted fallback when native mode is unavailable
5. Ollama local through Arcelle Deep Harness
6. Ollama cloud through Arcelle Deep Harness
7. OpenRouter through Arcelle Deep Harness

For each provider, record:

- Installed
- Logged in or configured
- Real model name
- Selected harness
- Native sandbox result
- Privacy mode
- Read support
- Write support
- Streaming
- Approvals
- Cancellation
- Usage reporting
- Reconciliation
- Rollback
- Final result

Rules:

- Never weaken the sandbox to make Codex or Claude pass.
- If native mode fails its self-test, confirm it fails closed.
- Confirm restricted fallback is selected only when allowed.
- Never use a permission-bypass mode.
- Confirm local Ollama works with cloud network access unavailable.
- Do not call a mocked test a real provider test.

Phase 12: Real read-only agent runs

For every ready provider, run this task in the converted workspace:

`Read notes.md and Research/findings.md. Return a short summary. Do not change any file.`

Verify:

1. The real provider and model are used.
2. Streaming text appears.
3. Run status is correct.
4. No file hash changes.
5. Usage and errors are shown safely.
6. Agent history remains after lock, unlock, restart, and room reopen.

Phase 13: Real write-agent runs

For every ready provider, create a fresh baseline copy of the converted room. Run:

`Use your workspace file tools. Read notes.md. Add a section named Agent Review containing the provider name and today's date. Do not change any other file.`

Verify before the run:

1. Arcelle creates a complete encrypted baseline.
2. Baseline progress is visible.
3. Write mode does not start when baseline creation fails.
4. `.arcelle` and outside-room paths are blocked.

Verify after the run:

1. Exactly one expected normal file changed.
2. The change is visible in Finder and Arcelle.
3. The search index updates.
4. Activity records provider, harness, model, privacy mode, status, and changed file.
5. A full reconciliation finds the same change even if no provider hook reports it.
6. Restart Arcelle and confirm run history remains.
7. Use one-click rollback.
8. Confirm the original SHA-256 is restored.
9. Make a newer external edit and confirm rollback refuses to overwrite it.
10. Use Restore baseline as a copy for that conflict.

Phase 14: Approvals and cancellation

For every ready provider:

1. Trigger an operation that requires approval.
2. Approve once.
3. Trigger another approval and deny it.
4. Confirm denial stops that operation.
5. Cancel during model output.
6. Cancel during a tool operation.
7. Cancel during a child-agent run if supported.
8. Confirm the complete process tree stops.
9. Confirm the run does not stay marked Running.
10. Confirm terminal events arrive after cleanup.
11. Confirm temporary runtime folders and mirrors are removed.

Phase 15: Mass-change and delegation safety

1. Ask a disposable write agent to change more than twenty temporary paths.
2. Confirm Arcelle pauses, cancels, or asks for explicit approval.
3. Deny and confirm no hidden writes continue.
4. Test parallel read-only specialists.
5. Test one write specialist.
6. Confirm only one agent has the workspace write lease.
7. Confirm write specialists are serialized.
8. Confirm parent cancellation reaches child runs.
9. Confirm child runs inherit privacy mode.
10. Confirm loop limits and duplicate-change protections work.

Phase 16: Cloud Privacy enabled

Enable Cloud Privacy for Codex, Claude, Ollama cloud, and OpenRouter. Use only providers that are ready.

Run a read task, then a safe text-edit task.

Verify the temporary mirror:

1. It is outside the real room.
2. It has owner-only permissions.
3. It contains no `.arcelle` directory.
4. It contains no room database.
5. It contains no original PDF, image, audio, video, or unsupported binary.
6. Supported text uses protected placeholders.
7. The reverse placeholder map is not in the mirror.
8. Structured and binary changes use trusted Arcelle tools.
9. Unknown or damaged placeholders are rejected.
10. Duplicated protected placeholders require review.
11. Safe text edits are restored locally and written atomically.
12. The mirror is deleted after success, failure, denial, cancellation, app quit, and crash-startup cleanup.

Search only redacted test logs and temporary runtime files for these canaries:

- Test Person Alpha
- private-test@example.invalid
- +1-555-0100
- ARCELLE-PRIVATE-TEST-123

Any canary outside the trusted real test workspace or encrypted state is a Critical privacy failure.

Phase 17: Cloud Privacy disabled

Use a fresh disposable copy containing only fake values.

1. Disable Cloud Privacy.
2. Confirm Arcelle shows a clear content-sharing warning.
3. Run one real cloud read task.
4. Run one real cloud text-edit task.
5. Confirm `.arcelle` remains blocked.
6. Confirm outside-room paths remain blocked.
7. Confirm baseline and rollback remain required.
8. Turn Cloud Privacy back on after the test.

Phase 18: Failure and crash recovery

Use disposable copies and test safe failure for:

- Missing provider
- Expired provider login
- Missing model
- Ollama stopped
- Network unavailable
- Cloud timeout
- Malformed tool call
- Denied tool
- App closed during a run
- Room locked during a run
- Sidecar stopped
- Watcher error
- External write conflict
- Interrupted checkpoint
- Interrupted sealed export
- Incomplete filesystem operation
- Abandoned cloud mirror

After each failure, verify:

1. Normal files remain safe and readable.
2. No valid file is replaced by partial output.
3. No secret appears in logs.
4. Startup reconciliation recovers safely.
5. No job remains permanently Running.
6. No child provider process remains.
7. Temporary files and mirrors are cleaned.

Phase 19: UI and accessibility

Review every screen used in this test:

- Start
- Create room
- Legacy conversion
- Unlock
- Workspace
- Library
- File viewers
- Sketch
- Recording
- Search
- Settings
- Provider diagnostics
- Activity
- Approval
- Change review
- Rollback
- Checkpoint
- Sealed export and inspection
- Privacy review

Check:

- No clipped or overlapping text
- No unexpected horizontal scroll
- Clear empty, loading, progress, error, and success states
- Visible keyboard focus
- Logical keyboard order
- Accessible names and roles
- Clear privacy language
- Clear destructive-action warnings
- Progress remains visible during long work
- Buttons do not appear successful when the action failed

Phase 20: Final cleanup and inspection

1. Quit Arcelle normally.
2. Confirm no Arcelle, sidecar, Codex, Claude, Ollama child, or other test-agent process remains.
3. Check Arcelle logs for errors, crashes, unhandled rejections, and secret canaries.
4. Check macOS crash reports.
5. Check runtime mirror and temporary directories.
6. Confirm test workspace normal files still open without Arcelle.
7. Reopen the main test room one final time.
8. Confirm files, Sketch, recordings, search, chats, history, checkpoints, and run records remain usable.
9. Quit again.
10. Delete disposable rooms and runtime data using exact validated test paths only.
11. Keep the final report, selected screenshots, and redacted logs in one review-evidence folder.

Evidence rules

For every phase, collect:

- Result: PASS, FAIL, BLOCKED, or NOT RUN
- Exact scenario
- Expected result
- Actual result
- Screenshot path
- Safe log evidence
- File hash evidence when relevant
- Provider, harness, and model when relevant
- Reproduction steps for failures

Take screenshots before and after important writes, approvals, rollbacks, conversions, Sketch saves, waveform playback, privacy warnings, and failures. Make sure screenshots do not contain passwords, tokens, recovery keys, or account details.

Final report format

# Arcelle Full Computer Use Review

## Final result

- Overall: PASS, FAIL, or BLOCKED
- Installed app path
- Installed version
- Test date and test ID
- Temporary test root
- Evidence folder

## Progress

[████████████████████] 100%

## Provider matrix

Include a table with:

- Provider
- Real model
- Login ready
- Harness
- Sandbox
- Privacy mode
- Read
- Write
- Approval
- Cancellation
- Rollback
- Result

## Phase results

For every phase, include:

- Result
- What was tested
- Evidence
- Screenshot paths
- Important redacted log lines

## Defects

For every defect, include:

- Severity: Critical, High, Medium, or Low
- Short title
- Exact reproduction steps
- Expected result
- Actual result
- Data or privacy risk
- Provider and model, when relevant
- Screenshot path
- Redacted log evidence
- Temporary test paths

## Security and privacy result

State clearly:

- Whether `.arcelle` was protected
- Whether path traversal was blocked
- Whether symlink escape was blocked
- Whether outside-room access was blocked
- Whether rollback baselines worked
- Whether protected canaries leaked
- Whether cloud mirrors were safe and cleaned
- Whether logs contained secrets

## Blockers

List every missing or expired provider login, unavailable model, stopped service, failed sandbox self-test, missing operating-system permission, or Computer Use limitation.

## Cleanup

List:

- Temporary rooms deleted
- Temporary mirrors deleted
- Child processes stopped
- Evidence intentionally preserved
- Anything that could not be cleaned

Do not report 100% completion until every required scenario has PASS, FAIL, BLOCKED, or NOT RUN with a clear reason. Do not hide failures. Do not call a provider test real unless the real provider and model executed.
```
