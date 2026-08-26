# Workspace and Harness Implementation Tasks

This file is the delivery checklist for `HLD_WORKSPACE_HARNESS.md`.

Legend:

- `[x]` implemented in the current branch
- `[ ]` still required before general availability

## Phase A: specification and parity baseline

- [x] Write the HLD.
- [x] Write this task document.
- [x] Add the shared 16-agent manifest.
- [x] Record all eight existing graph shapes.
- [x] Add workspace and harness feature flags.
- [ ] Inventory every remaining direct read of `files.original_bytes`.
- [ ] Inventory every remaining direct write of `files.original_bytes`.
- [ ] Build a provider-by-feature parity matrix.
- [ ] Add legacy, large-file, recording, workflow, privacy and checkpoint fixtures.
- [ ] Generate provider definitions from the shared manifest instead of keeping parallel definitions.

## Phase B: content abstraction

- [x] Define `RoomDescriptor` for sealed files and workspace folders.
- [x] Define the `ContentStore` interface.
- [x] Implement `BlobContentStore`.
- [x] Implement `WorkspaceContentStore`.
- [x] Route import, generated text, text edit and basic viewer reads through workspace storage.
- [x] Add optimistic SHA-256 conflict errors.
- [ ] Route every media stream through `ContentStore` without full buffering.
- [ ] Route downloads and URL imports through `ContentStore`.
- [ ] Route recordings and recording recovery through `ContentStore`.
- [ ] Route workflow and Studio outputs through `ContentStore`.
- [ ] Route every Room MCP file tool through `ContentStore`.
- [ ] Remove all higher-layer assumptions that current bytes live in SQLCipher.

## Phase C: workspace database and services

- [x] Add workspace file columns and additive migrations.
- [x] Make current bytes nullable for workspace rows.
- [x] Add encrypted content-object tables.
- [x] Implement streaming object encryption and decryption.
- [x] Add object references and reachability garbage collection.
- [x] Add filesystem operation journal tables.
- [x] Add agent-run and baseline tables.
- [x] Implement room marker and same-host writer lease.
- [x] Implement safe relative-path normalization.
- [x] Block `.arcelle`, absolute paths, traversal and symlink segments.
- [x] Implement atomic create, write, import, move, trash and restore.
- [x] Preserve original POSIX mode when replacing an existing file.
- [ ] Implement the ten-unpinned-version retention job for object-backed versions.
- [ ] Add storage reporting for normal files, database and private history.
- [ ] Add safe read-only opening when another writer owns the lease.
- [ ] Add remote-device lease expiry/recovery policy.

## Phase D: watcher and indexing

- [x] Add Chokidar with stable-write and atomic-write handling.
- [x] Ignore `.arcelle` and Arcelle temporary files.
- [x] Add full manifest reconciliation.
- [x] Preserve file ID for a proven external rename.
- [x] Add the six index states.
- [x] Run reconciliation after workspace unlock.
- [ ] Add a user setting for polling on network and synced folders.
- [x] Add trusted-stat scan optimization before hashing unchanged large files.
- [x] Add unique hash-only rename matching when filesystem identity changes.
- [ ] Connect stale rows to extraction, chunks, FTS and embeddings.
- [ ] Discard extraction results when the source hash changed.
- [ ] Add watcher health and “Rescan room” UI.
- [ ] Reconcile after every native harness run and watcher error in the live orchestrator.

## Phase E: room lifecycle and UI

- [x] Create workspace folders through a temporary sibling.
- [x] Detect legacy files and workspace folders on open.
- [x] Acquire and release the workspace lease.
- [x] Open the private SQLCipher database.
- [x] Start watcher and reconciliation services.
- [x] Store recovery wrappers beside private `room.db`.
- [x] Make new UI rooms workspace folders by default.
- [x] Allow the macOS room picker to select a folder or legacy file.
- [x] Update the start-screen storage explanation.
- [x] Rename the outer workspace folder from the room rename command.
- [ ] Add a full lock test that proves keys and decrypted caches are gone.
- [ ] Add read-only UI when the lease belongs to another process.
- [ ] Detect raw Finder copies with duplicate room IDs.
- [ ] Register a duplicated workspace with a fresh room ID.
- [ ] Update Touch ID credentials after an outer-folder rename.
- [ ] Move room deletion to recoverable operating-system Trash.
- [ ] Update every UI sentence that still says all files are encrypted in one file.

## Phase F: migration, sealed export and checkpoints

- [x] Implement resumable legacy-to-workspace conversion.
- [x] Export each current blob as a normal file.
- [x] Preserve stable IDs, provenance, chat, memory, workflows and versions.
- [x] Resolve invalid names and case collisions deterministically.
- [x] Validate count, size and SHA-256 before publishing.
- [x] Keep the legacy source file unchanged.
- [x] Produce a conversion report.
- [x] Implement consistent sealed `.arcelle` creation.
- [x] Verify schema, password, file count, size and hashes before publish.
- [x] Import a sealed package into a new workspace.
- [ ] Rebuild `.roomck` checkpoints with the same packager.
- [ ] Restore through a verified sibling workspace and recoverable backup.

## Phase G: unified harness foundation

- [x] Define normalized harness context, events, approvals and usage.
- [x] Add async normalized event queue.
- [x] Add Harness Orchestrator and provider registry.
- [x] Add child-safe write lease behavior in the orchestrator.
- [x] Add run baseline records and end-of-run comparison.
- [x] Add conflict-safe automatic rollback rules.
- [x] Add the shared agent manifest.
- [ ] Register the orchestrator in the live Electron bootstrap.
- [ ] Route the current agent UI through normalized events.
- [ ] Generate all provider-specific specialists from the manifest.
- [ ] Add `arcelle_delegate` child runs and normalized child events.
- [ ] Serialize write specialists while allowing parallel read specialists.
- [ ] Add per-provider capability results to Settings diagnostics.

## Phase H: Claude and Codex native harnesses

- [x] Install the Claude Agent SDK.
- [x] Add the Claude SDK runtime.
- [x] Add `canUseTool`, pre-tool and post-tool policies.
- [x] Enable Claude strict filesystem and network sandboxing.
- [x] Add process-tree cancellation through the SDK spawn signal.
- [x] Add the Codex app-server JSONL client.
- [x] Add initialize, thread and turn startup.
- [x] Map Codex structured text, plan, tool, diff, usage and completion events.
- [x] Map command and file-change approval requests.
- [x] Add macOS `.arcelle` Seatbelt protection and self-test.
- [ ] Load or generate the schema for the installed Codex version.
- [ ] Add capability-version compatibility tests for several Codex releases.
- [ ] Add the restricted `codex exec` fallback under the common contract.
- [ ] Add the restricted Claude CLI fallback under the common contract.
- [ ] Prove outside-workspace read isolation for native direct mode.
- [ ] Add mass-change pause at more than 20 paths.
- [ ] Test cancellation and descendant-process cleanup with real CLIs.
- [ ] Disable native mode automatically when any isolation test fails.

## Phase I: Deep Harness

- [x] Add Deep Agents behind a request option and feature flag.
- [x] Add `ArcelleHarnessModelAdapter`.
- [x] Add `ArcelleWorkspaceBackend` with MCP-only file access.
- [x] Add `ArcelleStateBackend`.
- [x] Add `ArcelleToolBackend`.
- [x] Add `ArcelleCompiledSubAgentAdapter`.
- [x] Wrap existing compiled specialist graphs.
- [x] Keep the deterministic classic graph as the default fallback.
- [x] Prohibit `LocalShellBackend` in Arcelle integration.
- [x] Add read-only workspace MCP tools for Deep Harness.
- [ ] Create a write-enabled per-run MCP bridge only after baseline preflight.
- [ ] Add Ollama capability probes for reliable tool calling.
- [ ] Select Deep Harness for capable Ollama models.
- [ ] Select deterministic graphs for weak/small models.
- [ ] Add OpenRouter model adapter integration tests.
- [ ] Verify local Ollama works with all networking disabled.
- [ ] Verify cancellation, compaction, duplicate prevention and final synthesis in Deep mode.

## Phase J: write protection and rollback

- [x] Create encrypted baseline objects before native write runs.
- [x] Refuse write mode when baseline creation fails.
- [x] Record baseline paths and hashes.
- [x] Compare final manifest with the baseline.
- [x] Restore modified, deleted and moved files from encrypted objects.
- [x] Move run-created files to Arcelle Trash on rollback.
- [x] Refuse rollback overwrite after a later user edit.
- [x] Add “restore baseline as a copy” for conflicts.
- [ ] Show created, changed, moved and deleted files in the UI.
- [ ] Add one-click rollback UI.
- [ ] Reindex every changed file before marking the run complete.
- [ ] Add audit retention and cleanup policy.
- [ ] Add secret-safe structured logging tests.

## Phase K: cloud redacted mirror

- [ ] Create a `0700` per-run mirror outside the room.
- [ ] Preserve safe relative paths for text files.
- [ ] Add redacted companions for PDFs, documents, sheets, audio and video.
- [ ] Add image and unsupported-binary stubs.
- [ ] Keep reverse placeholder maps only in trusted state.
- [ ] Reject unknown or damaged placeholders.
- [ ] Review duplicated protected placeholders.
- [ ] Restore protected values locally.
- [ ] Apply safe text writes atomically.
- [ ] Route structured changes through Arcelle MCP tools.
- [ ] Record cloud provenance.
- [ ] Delete mirrors after success, failure, cancellation and startup crash cleanup.
- [ ] Add clear privacy-enabled and privacy-disabled UI text.

## Phase L: hardening and release

- [ ] Run the complete Electron test suite.
- [ ] Run the complete Python sidecar test suite.
- [x] Test legacy rooms without conversion.
- [x] Test interrupted conversion and resume.
- [ ] Test power loss at every journal phase.
- [ ] Test database corruption while normal files remain safe.
- [ ] Test password change and recovery.
- [ ] Test large video, recording and generated artifacts.
- [ ] Test Unicode, case collisions, long paths and symlinks.
- [ ] Test iCloud, Dropbox, network drives and offline placeholders.
- [ ] Test two-process and duplicate-room conflicts.
- [ ] Complete traversal, shell escape, `.arcelle` and privacy security review.
- [ ] Write upgrade, rollback, support and recovery documentation.
- [ ] Enable general availability only after parity and security gates pass.

## Current release gate

The current branch is an implementation foundation, not general availability. Workspace room creation, the main text-file paths, explicit resumable legacy conversion, verified sealed export and import, and conflict-safe baseline copies work. Legacy compatibility remains. Native and Deep harness drivers exist behind flags. Workspace checkpoint restore, cloud mirrors, complete byte-path migration, live orchestrator UI wiring and final security tests are still required.
