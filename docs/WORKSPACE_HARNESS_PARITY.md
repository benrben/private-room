# Workspace and Harness Parity Report

This report shows what works now and what is still missing.

It is an implementation report. It is not a design promise.

Machine-readable sources:

- `config/workspace-harness-parity.json`
- `config/original-bytes-inventory.json`
- `config/agent-manifest.json`

Automated tests fail when a provider, specialist, graph shape, evidence file, or direct `original_bytes` source is missing from these inventories.

## Status words

| Status | Meaning |
|---|---|
| Implemented | The code path exists and has automated coverage. |
| Partial | A useful part works, but the same behavior is not complete end to end. |
| Missing | The required path is not implemented. |
| N/A | The feature does not apply to this provider. |

## Provider parity matrix

| Feature | Codex | Claude | Ollama local | Ollama cloud | OpenRouter |
|---|---|---|---|---|---|
| Normalized harness events | Implemented | Implemented | Partial | Partial | Partial |
| Streaming output | Implemented | Implemented | Implemented | Implemented | Implemented |
| Cancellation | Implemented | Implemented | Partial | Partial | Partial |
| Interactive approvals | Implemented | Implemented | Partial | Partial | Partial |
| Write baseline and rollback | Implemented | Implemented | Partial | Partial | Partial |
| Workspace isolation | Implemented | Implemented | Implemented | Implemented | Implemented |
| Cloud redacted mirror | Implemented | Implemented | N/A | Partial | Partial |
| Shared 16 specialists | Implemented | Implemented | Implemented | Implemented | Implemented |
| Capability probe and safe fallback | Implemented | Implemented | Implemented | Implemented | Implemented |

Important details:

- Codex uses app-server structured events.
- Claude uses Agent SDK structured events and hooks.
- Both native providers use the Electron orchestrator, baseline, final scan, rollback, and macOS sandbox.
- Deep Harness builds its subagents from the existing Python registry. It uses the authenticated workspace bridge. It does not receive database keys or normal system paths.
- Deep Harness still uses the older sidecar event stream. It is not yet fully connected to the normalized Electron run UI.
- Codex and Claude generate specialist definitions from the same shared manifest. Claude receives SDK subagent definitions. Codex receives the generated collaboration catalog.
- Native capability probes and restricted CLI fallbacks use the common harness contract.
- Ollama cloud and OpenRouter are not yet guaranteed to receive the redacted mirror for every Deep run.

## Specialist parity

The shared manifest contains exactly sixteen agents and eight graph shapes.

| Graph shape | Specialists |
|---|---|
| `supervisor` | Main agent |
| `react_verify` | File, Connector, Drawing |
| `recall_act_check` | Scripts, Workflow, Skills, Skill-builder |
| `chain_stage` | Web |
| `perceive_act` | Browser, App |
| `route_act` | Jobs, Studio |
| `react` | Connector setup, Video |
| `probe_gate_act` | Transcription |

Current provider behavior:

| Provider family | Shared specialist status |
|---|---|
| Deep Harness: Ollama local, Ollama cloud, OpenRouter | The main agent and fifteen subagents are built from the Python registry. The registry has parity tests against the shared manifest. |
| Codex native | Runs the Codex coordinator with a generated specialist catalog and normalized collaboration events. |
| Claude native | Runs the Claude coordinator with generated SDK subagents and normalized subagent events. |

## `original_bytes` inventory

The `original_bytes` column remains only for old database rooms and compatibility boundaries.

No listed path is allowed to store current workspace file bytes in this column.

| Source | Access | Reason it still exists |
|---|---|---|
| `cli/roomai.ts` | Read | Extract an old sealed database room. |
| `db-host/files.ts` | Read and write | Legacy blob primitives behind `BlobContentStore`. |
| `db-host/schema.sql` | Schema | Keep the nullable compatibility column for old rooms. |
| `db-host/versions.ts` | Read | Create versions for legacy blob rooms. Workspace versions use encrypted objects. |
| `workspace/conversion.ts` | Read, then clear | Stream old blobs into normal files and clear the column in the new copy. |
| `workspace/sealedPackage.ts` | Clear | Import sealed current files as normal workspace files. |
| `workspace/storageUsage.ts` | Read | Report legacy blob storage usage. |
| `workspace/workspaceService.ts` | Write `NULL` | Create workspace projection rows. |
| `workspace/roomContent.ts` | Documentation reference | State and enforce the compatibility rule. |
| `db-host/recordings.ts` | Documentation reference | State and enforce that hybrid recording recovery does not refill the blob column. |
| `recBridge.ts` | Documentation reference | State and enforce that hybrid transcript edits do not copy audio into the blob column. |

Direct access is not the only risk. A higher-level module can call an old blob helper without naming the SQL column. The machine inventory therefore also records known indirect callers. These remain release blockers until their workspace paths are complete.

The live agent edit and organize paths are no longer on this list. Workspace `edit_file`, `edit_files`, `write_file`, `set_cells`, `save_link`, create, rename, move, merge and trash now use normal files, optimistic hashes, encrypted snapshots and atomic writes. Their synchronous blob functions remain only for legacy sealed-database rooms.

Browser captures and imports, `#transcribe` and `#research`, drawings and drawing exports, room summaries, and creative image/video jobs also use the workspace source of truth now. Their legacy functions remain available only for sealed-database rooms.

## Acceptance fixture map

The tests use real SQLCipher databases and real filesystem paths. They do not use a fake in-memory file service.

| Fixture | Automated coverage |
|---|---|
| Legacy room | `workspace/conversion.test.ts` and `workspace/acceptanceFixtures.test.ts` keep real blob bytes and prove the source room is unchanged. |
| Large file | `workspace/acceptanceFixtures.test.ts` writes a 12 MiB chunked file, reads it as a stream, checks its SHA-256, and proves the database blob is `NULL`. |
| Recording | `workspace/acceptanceFixtures.test.ts` stores a normal WAV plus encrypted recording metadata and transcript state. |
| Workflow | `workspace/acceptanceFixtures.test.ts` stores a private workflow definition plus a normal output file. |
| Privacy | `harness/cloudMirror.test.ts` and `workspace/acceptanceFixtures.test.ts` prove redaction, binary blocking, placeholder validation, local restoration, and cleanup. |
| Checkpoint | `roomCheckpoints.test.ts` and `workspace/acceptanceFixtures.test.ts` create and verify real encrypted `.roomck` packages. |

## Remaining release blockers

The parity matrix is complete. Product parity is not complete.

Main blockers:

1. Route the remaining chat attachment, knowledge-command artifact, streamed-answer save, and story/cast image paths through workspace storage. The exact source files are recorded in `config/original-bytes-inventory.json`.
2. Connect Deep Harness runs to the same normalized Electron event and approval lifecycle.
3. Guarantee redacted mirrors for every cloud Deep Harness run.
4. Finish the full Electron suite, synced-folder and security release tests.

General availability must stay disabled until these blockers and the unchecked tasks in `WORKSPACE_HARNESS_TASKS.md` are complete.
