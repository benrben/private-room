# Arcelle — full end-to-end review

_2026-08-17 · v0.24.0 · working tree clean at `d0d6b40`_


## How this was produced

78 subagents across three workflows, ~14.8M tokens. Every domain was read by one
agent and then **adversarially re-checked by a second** whose instructions were to
refute the first — defaulting to REFUTED when unconvinced. UX claims went through a
grounding pass whose job was to delete any described control that is not in the
source (a previous audit of this app invented a "12 blocked" counter, so this pass
exists specifically to stop that).

Baseline before the review: `tsc -b` clean, every Rust suite green, 1586 sidecar
tests green. **Everything below survives a fully green gate.**

| | |
|---|---|
| Findings raised | 774 |
| Refuted by the verification pass | 6 |
| Deduplicated defects | 418 (289 confirmed, 129 plausible) |
| UX / simplification items | 332 (110 high-impact) |
| P0 | 4 |
| P1 | 31 |

Severity: **P0** = data loss, privacy leak, or a core operation broken for everyone.
**P1** = a feature is wrong or broken in a common case. **P2** = edge case or
misleading. **P3** = minor.

`CONFIRMED` = the verifier reproduced the logic path. `PLAUSIBLE` = the code reads
wrong but a guard could not be fully ruled out. Items marked **[author-verified]**
I opened and confirmed myself.


---

## P0 — fix before anything else


### P0.1 MarkdownEditor's Preview layout unmounts the buffer — unsaved edits vanish and the unsaved-edits guard is disarmed

`src/viewers/MarkdownEditor.tsx:136` · data-loss · CONFIRMED


**Symptom.** Pressing "Preview" in the note editor destroys the live buffer. The preview pane keeps painting the edited text (React state `live` survives), but the only editable/saveable copy is gone; returning to "Source" shows the last saved text, so the two panes of one document disagree. Because the unmount also clears the dirty mirror and the external save hook, the unsaved-edits dialog is disarmed for whatever happens next, and ⌘S from the workspace has nothing to save.


**Repro.** Open any .md → Edit (opens in Split) → type a sentence → click "Preview" → click "Source": the sentence is gone from the buffer while the preview pane still shows it. Variant: Edit → type → "Preview" → close the tab or switch files — no "you have unsaved edits" prompt, because onDirtyChange(false) already ran on unmount.


**Fix.** Keep CodeEditor mounted in every layout and hide `.mde-source` with CSS (`display:none`), the way HtmlView.tsx:145-157 and OfficeDocView.tsx:93-96 deliberately keep their frames mounted and use `hidden`. If unmounting is kept, `live` must be fed back as the editor's value on remount and the dirty/save mirrors must not be cleared while the file is still open in edit mode. Secondary at the same site: in Preview the formatting toolbar stays rendered but `formatRef.current` was nulled by `registerFormat(null)`, so B/I/H1 become silent no-ops.


### P0.2 The sidecar privacy door never engages for Ollama's `<size>-cloud` tags

`sidecar/arcelle_sidecar/privacy.py:37` · privacy · CONFIRMED


**Symptom.** In a room whose model is an Ollama hosted tag written the `<size>-cloud` way (`gpt-oss:120b-cloud`, `qwen3-coder:480b-cloud`, `qwen3-vl:235b-cloud`), the cloud-privacy door does nothing at all: no entity is replaced, no image is stripped, no live guard runs — while Settings says "On for this room — protected details never reach a cloud model" and the trust chip says "Protected cloud". Rust attaches the policy correctly; the sidecar discards it.


**Repro.** Pull `gpt-oss:120b-cloud` in Ollama, select it as the room model, leave Cloud privacy ON, add "Ben Reich" to the block list, ask a question containing that name with a photo attached. `guard_outbound` returns the untouched messages (policy.report stays all-zero, no `privacy` event is emitted), and the real name plus the image bytes go to ollama.com.


**Fix.** Make `is_cloud_model` accept both spellings, mirroring `capabilities::engine_id_of`: `tag = model.rsplit(':',1)[-1]; return ':' in model and (tag == 'cloud' or tag.endswith('-cloud'))`. Add the `<size>-cloud` names to test_privacy_gate.py, and better, stop deciding locality from the name twice — have Rust put its own answer (`runs_on_this_mac`) in the policy payload and have `guard_outbound` honour it, so the two languages cannot drift again.


### P0.3 The rec_read job runner never frees the queue slot — after the first recording is read, every background job in the room stalls for the session

`src-tauri/src/commands/jobs/rec_read.rs:717` · correctness · PLAUSIBLE


**Symptom.** After any recording is read (which happens automatically on Stop and from the auto sweep), the single heavy-work slot stays claimed forever. Every subsequent background job — deep summary, file pass, studio, download, workflow, another read — is created with status 'queued' and never starts, and its card sits in the sidebar saying nothing. The only cure is closing the room or restarting the app.


**Repro.** Open a room. Record anything with speech and press "Stop & save" — recording_cmds.rs:537 auto-starts a read, which reserves the slot. Wait for the read to finish (tabs fill in, job row says 'done'). Now start a deep summary or a file pass: the row is created and stays 'queued' forever, its progress card never advances, and no error is shown. Restarting the app clears it (pump_on_open).


**Fix.** Give the rec_read body the same epilogue every other runner has: after `set_job_status`, emit the terminal `job-progress` (`finished`/`paused`/`failed` with the label) and then `queue::finish_and_pump(&app, &window, &job_id).await;`. That one addition also restores the global failure toast in workspace/effects.ts and the `refreshJobs` that retires the card — the other half of the "Reading this recording… forever" finding. Add a test asserting `running_job` is None after each job kind's runner completes, so the next runner cannot repeat the omission.


### P0.4 The Closet defeats the cloud-privacy door entirely: the sidecar's guard_outbound engages on the model NAME, so a relayed room sends real names and images unredacted

`sidecar/arcelle_sidecar/privacy.py:282` · privacy · PLAUSIBLE


**Symptom.** With Settings → Connections → Remote AI pointed at another machine and the cloud-privacy door ON, nothing is redacted: the room's block-list items go to that machine as themselves and attached images are not stripped — while Cloud privacy says the door is on and the Remote AI field itself promises "Cloud privacy applies here too: with the door on, protected details are replaced before anything is sent." The Rust half of the Closet fix landed and is tested; the Python half re-derives locality from the model name and throws the policy away.


**Repro.** Settings → Connections → Remote AI → http://192.168.1.20:11434 → Save. Settings → Cloud privacy: door ON, add "Ben Reich" to "Never share these" (it shows as "guaranteed"). Ask a question containing "Ben Reich", or open an image and ask about it. On the receiving box, Ollama's request log shows the prompt containing "Ben Reich" verbatim (not "[Person A]") and the base64 image still attached.


**Fix.** The host has already made the locality decision — inject_policy only attaches a policy for a destination it considers non-local — so the sidecar must stop re-deriving it from the name: treat "an active policy is present" as authoritative in guard_outbound and in server.py's `engaged`, or add the transport half explicitly (`is_nonlocal_model(model) or not _base_is_loopback(base_url)`). Whichever is chosen, add a sidecar test that a local model NAME with a non-loopback base_url still redacts, and a Rust-side end-to-end assertion, so the two halves cannot drift again.


---

## P1 — a feature is wrong in a common case


### P1.1 Pressing Stop before the first token reports the app's "the reply was lost… Please try again" failure notice

`src-tauri/src/commands/agent.rs:1316` · honesty · CONFIRMED


**Symptom.** A deliberate Stop that lands before the first token is persisted as Arcelle's own lost-reply notice — the app tells the user its reply was lost in transit and instructs them to try again, and draws a red recovery strip under it, when in fact the user cancelled the turn.


**Repro.** Ask anything on any engine; press Stop while the bubble still reads "Thinking locally…"/"Asking your cloud AI…" (before any ask-delta). The saved assistant row is LOST_REPLY_CLEAN + " *(stopped)*" and ChatPane shows "Nothing was written, so asking again is safe." + Try again. Same for a Stop during the first tool call, when no text has streamed.


**Fix.** Consult the cancel flag inside the empty-answer arm: if cancel.load(SeqCst) is true, return Ok(String::new()) — ask() already appends the "(stopped)" marker and the "(Also stopped: …)" line, so a stopped turn with no partial reads as an empty stopped turn rather than a failure. Keep the LOST_REPLY_* choice for the genuinely non-cancelled empty case.


### P1.2 save_link / download_url / download_media skip the outbound-URL privacy guard that fetch_page and browse_open both apply

`src-tauri/src/commands/agent.rs:3598` · privacy · CONFIRMED


**Symptom.** With Cloud privacy on, a URL carrying a room-protected name is refused by fetch_page and by browse_open, but fetched verbatim by save_link, download_url and download_media — the placeholder the model saw is restored to the real value at the bridge before the request leaves the Mac.


**Repro.** Cloud CLI or :cloud engine, web access on, Cloud privacy on, "Dana Cohen" in the block list. The model (which only ever saw "[Person A]") calls save_link({url:"https://example.com/?q=[Person A]"}). room_mcp.rs:1481 restores the real name, files.rs::import_link_and_index fetches https://example.com/?q=Dana%20Cohen. The identical URL through fetch_page returns "Not fetched: this URL carries 1 protected name(s)…".


**Fix.** Hoist the check into one helper and call it at the top of all four URL-taking arms: `if let Some(hidden) = privacy::outbound_url_hides(&url) { return Ok(refusal(hidden)); }`. Refuse rather than mask, exactly as fetch_page does — a masked query string only 404s.


### P1.3 `perceive_image` tells the model the image is attached when the privacy door is about to strip it

`src-tauri/src/commands/agent.rs:518` · honesty · CONFIRMED


**Symptom.** With a vision-capable non-local chat model and Cloud privacy ON, `view_screenshot` / `browse_look` / the sketch capture return "Captured X. The image is attached to your context — look at it before answering." The door then strips the pixels and only counts them, so the model answers about a picture it never received and narrates a page or a drawing from surrounding context alone.


**Repro.** Room model `openrouter::<a vision model>`, Cloud privacy ON. In the private browser ask "what's on the page?". `browse_look` pushes the PNG and returns the "attached" sentence, the sidecar door drops the image (`images_blocked: 1`), and the model describes a page it never saw while the chat chip reads "1 image held back".


**Fix.** Gate on both facts at agent.rs:518 — `image_reaches_model(&model) && chat_model_sees_images(&model).await` — so a door-blocked model falls through to perceive_image's local-describe path. If pixels are ever queued for a model the door will strip, the tool result must say so explicitly, the way external_llm.py:255 already does ("they were NOT sent. You have not seen them").


### P1.4 #find with an embedding returns the entire room as "matches", and errors outright on a large room

`src-tauri/src/commands/chat_commands/knowledge.rs:58` · correctness · CONFIRMED


**Symptom.** In an embedded room `#find <anything>` prints "Matches for **x** (N):" with one line per chunk in the whole room, plus a source chip per file, and never prints "No matches found". Above ~32,766 embedded chunks the command fails with a SQLite "too many SQL variables" error instead.


**Repro.** Import two long books, let the backfill finish, type `#find deposit`. Under 32,766 chunks you get a multi-MB chat message built by copying every chunk's text under the room mutex — the exact allocation CHG-15 removed from this function. Over it, `chunks_by_rowids` errors and the command fails.


**Fix.** Give the unlimited path a real ceiling for the VECTOR pass (rank-truncate to a few hundred before hydrating; the keyword pass is already bounded by the FTS match), batch `chunks_by_rowids` into groups of <=900 ids, and cap what #find prints with an explicit "…and N more" line.


### P1.5 Quitting the app during a live recording never stops or flushes the engine — the un-checkpointed tail is lost

`src-tauri/src/lib.rs:566` · data-loss · CONFIRMED


**Symptom.** ⌘Q or closing the window while a recording runs silently discards everything since the last checkpoint — up to a minute of audio and its transcript — with no warning and no hold.


**Repro.** Start a recording, speak 90 s (one checkpoint at 60 s), press ⌘Q. Reopen the room: `recover_rec_chunks` restores the first 60 s; seconds 60-90 and their segments are gone.


**Fix.** In `RunEvent::Exit` (and, better, hold the quit in `ExitRequested` the way the unsaved-edits door does), take the RecState session, send `EngineMsg::Stop` and wait bounded on the done channel before returning — `flush(true)`/`finish()` is what makes the tail durable. Cheaper partial mitigation: send Stop and wait only for the checkpoint `flush(false)` that `begin_stop` already does at recording.rs:1786.


### P1.6 Unlocking a room with the files-tier Leash on writes its bearer token into plaintext ~/.arcelle/leash.json, which the files tier promises never to do

`src-tauri/src/commands/rooms.rs:300` · security · CONFIRMED


**Symptom.** A room server left on at the files tier republishes its bearer token, port and room name to ~/.arcelle/leash.json on every unlock. Any process running as the user can read it and drive the room's file tools over loopback without the user ever pasting anything.


**Repro.** Settings → turn the room server on at the files tier (not full). Lock the room, unlock it. `cat ~/.arcelle/leash.json` now shows `{"scope":"files","token":"…","room":"…"}` — the exact record `set_room_server` deletes rather than writes for that tier.


**Fix.** Mirror server.rs in `spawn_room_server_if_enabled`: `if matches!(bscope, ToolScope::ExternalAgent) { write_discovery(...) } else { remove_discovery(&app); }`. Add a test that the files tier leaves no discovery file after a restart-on-unlock.


### P1.7 target="_blank" links and window.open() are silently dead, and the navigation hook records the URL anyway

`src-tauri/src/browser.rs:604` · correctness · CONFIRMED


**Symptom.** Any link with `target="_blank"` and any `window.open()` does nothing at all — no page, no error, no journal line. Meanwhile the tab's recorded URL is overwritten with the destination that never loaded and its title is cleared, so the strip/address bar briefly name a page that does not exist (self-healed ~1.2 s later by the `browser_info` poll, and only for the active tab).


**Repro.** Open any page containing `<a target="_blank" href="https://example.com/">` and click it. Nothing loads. Via the agent: `browse_do {"actions":[{"click":"e5"}]}` on such a link returns `1. clicked e5 — link "…"` with the batch marked ok and no `The page navigated.` line — a success report for something that did not happen.


**Fix.** Add `.on_new_window(...)` to the builder in `create()`: run `navigation_allowed` on the requested URL, then either `browser::new_tab(app, url)` or navigate the current page, and return `NewWindowResponse::Deny` so WebKit does not also try to make a window. Until that exists, at minimum stop `record_url`ing a navigation the page may never commit.


### P1.8 reconcilePages discards every title/URL update when no page was opened or closed

`src/workspace/browserPages.ts:131` · correctness · CONFIRMED


**Symptom.** A private page's sidebar row never updates its title or host once the set of open pages stops changing. A tab keeps the label it had at creation; following links inside it leaves the row naming the site it started on, for the life of the tab.


**Repro.** node: reconcilePages([{id:'a',title:'',url:'https://example.com/'}], [{id:'a',title:'Example Domain',url:'https://example.com/',active:true}]) returns the prev array by identity. In the app: open exactly one page and let it load; the sidebar row keeps showing the host (pageLabel falls back to pageHost) even though browser_info has already written 'Example Domain' into Rust's tab record.


**Fix.** Compare element identity, not length: `const changed = added.length > 0 || kept.length !== prev.length || kept.some((p, i) => p !== prev[i]); return changed ? [...kept, ...added] : prev;`. Add a test whose live list has the SAME id set as prev and only a changed title — the existing suite structurally cannot cover it.


### P1.9 One failed media catalogue erases the OTHER catalogue's models from the Create page, with a fabricated reason, for an hour

`src-tauri/src/commands/media_limits.rs:102` · correctness · CONFIRMED


**Symptom.** When one of the two OpenRouter media catalogues answers and the other does not, the Create page drops every model of the failed modality and publishes an exclusion card stating, as fact, that the provider's picture/video endpoints do not serve them. The stamp was already written, so the missing half is not re-fetched for an hour.


**Repro.** Fresh app launch, OpenRouter connected. Block or fail `GET https://openrouter.ai/api/v1/images/models` while `/videos/models` returns its 21 entries. Open Create: `found` is non-empty so `fetched_at` stays stamped and `media_table_loaded()` is true; `limits_for` is None for all 42 image models, so `drop_unserved` removes them and the exclusion row claims the endpoints refuse them. Repeats on every Create open for REFRESH_AFTER (1 h).


**Fix.** Track loadedness per modality — e.g. two AtomicBools set inside `parse_video_models` / `parse_image_models`, or have `ensure_media_limits` return which paths succeeded — and give `drop_unserved` a per-model flag so a video model is judged only against a loaded video table and an image model only against a loaded image table. Reset `fetched_at` to None when EITHER fetch failed so the missing half is retried.


### P1.10 MCP OAuth follows connector-supplied endpoints with only a literal-IP check — no DNS resolution, no redirect re-check (SSRF)

`src-tauri/src/commands/mcp_oauth.rs:339` · security · CONFIRMED


**Symptom.** A hostile or compromised MCP connector can make the app fetch and POST to arbitrary addresses inside this Mac and the local network. The `WWW-Authenticate` challenge names a metadata URL, that document names an authorization server, that server's metadata names authorize/token/registration endpoints — all attacker-chosen. A hostname that resolves to 127.0.0.1 (rebinding), or a public host that 302s to `http://127.0.0.1:11434` or `http://192.168.1.1/admin`, is followed and POSTed to.


**Repro.** Connect a hostile remote MCP connector. Its PRM document names `token_endpoint: https://a.attacker.test/t`; `a.attacker.test` either has a short-TTL A record pointing at 127.0.0.1 or simply answers 302 -> `http://127.0.0.1:11434/api/generate`. `checked_endpoint` passes on the literal hostname and reqwest follows the redirect to loopback.


**Fix.** Make `checked_endpoint` async and do what fetch.rs does: `check_public_http_url` -> `resolve_public_addr(host, port)` -> pin the connection to the returned address (`resolve_to_addrs`), and either set `redirect::Policy::none()` on the client or follow the chain by hand, re-running the whole check on every `Location`, as `guarded_get` already does.


### P1.11 `ai_status` spawns interactive login shells on every call and throws away one of the two results

`src-tauri/src/commands/models.rs:203` · perf · CONFIRMED


**Symptom.** Every `ai_status` call forks at least one, usually two, interactive login zsh shells that source the whole `.zshrc`; the second one's answer is discarded whenever Ollama is reachable. Latency on every image open and every recording start/stop, and on a fresh Mac each sourced `.zshrc` re-triggers macOS's App-Data consent prompt.


**Repro.** Have Ollama running and installed via Homebrew (no `/Applications/Ollama.app`). Open an image in the viewer (ImageView calls `aiStatus`) or start/stop a recording. `detect_external_blocking` forks `zsh -ilc`; `ollama_installed_blocking` forks a second; the `Ok` arm then returns `installed: true`, discarding the second result. Repeat for every call — nothing is cached.


**Fix.** Move the `ollama_installed_blocking` call inside the `Err(_)` arm, where its value is the only one used. Give `state.external_cache` a timestamp and let `ai_status` reuse it within a short TTL (and expose an explicit re-scan for Settings), so an ordinary status poll does not source the user's shell profile.


### P1.12 Grid edits to a non-comma CSV land in the wrong cell and corrupt the row

`src-tauri/src/commands/spreadsheet.rs:223` · data-loss · CONFIRMED


**Symptom.** Editing one cell of a semicolon- or pipe-delimited .csv (or of any file starting with Excel's `sep=` line) rewrites a different position than the cell that was clicked, silently corrupting that row of the user's file.


**Repro.** Import `data.csv` = "name;total\nalpha;5\n". guessSep counts only ';' so SheetJS parses two columns; the grid shows A1=name B1=total A2=alpha B2=5. Turn on Edit, change B2 to 7. set_cell_in_bytes splits on ',': row 1 is the single field `alpha;5`, is resized to 2, and index 1 is set — the file becomes "name;total\nalpha;5,7\n". With a leading `sep=,` line the whole grid is one file line lower, so editing A1 overwrites the sep directive itself.


**Fix.** Make one side authoritative. Either send the separator SheetView parsed with as a parameter of set_cell and use it in the csv branch, or port guessSep + the `sep=` prefix rule into set_cell_in_bytes; in both cases refuse the write (a plain error toast) when the delimiter the caller believes in and the one the file parses with disagree, rather than writing blind.


### P1.13 TrashPanel calls hooks after an early return — the trash going empty (or non-empty) throws during render and kills the contextual sidebar

`src/workspace/TrashPanel.tsx:99` · crash · CONFIRMED


**Symptom.** While the Trash tab is showing, the first transition between an empty and a non-empty trash throws during render; the whole second column (Browse / AI sources / Trash) is replaced by the error card until the user presses Try again.


**Repro.** Library → Trash tab, one deleted file → its row's ✓ Restore (or Empty the trash → Delete for good). `reloadTrash()` → `setTrashed([])` → TrashPanel re-renders down the 0-hook path → throw. Equally: sit on an EMPTY Trash tab and let the assistant trash a file (`room-files-changed` → `listTrashedFiles`) → 0→2 hooks → throw.


**Fix.** Move `selectAllRef` and its `useEffect` above the `s.trashed.length === 0` early return (or render the empty state as a branch of the single return). Since there is no ESLint config, adding eslint-plugin-react-hooks — or at least a rendering test for this panel — is what stops the next one.


### P1.14 Opening a different file (library click, ⌘K hit, agent open, job toast, recording chip) discards unsaved edits without asking

`src/workspace/fileActions.ts:667` · data-loss · CONFIRMED


**Symptom.** With an editor open and dirty, opening any other file — the app's most-used navigation — replaces the buffer with no question. The guard covers only tab switch/close, the viewer's Close, ⌘T and rail area changes.


**Repro.** Home → open Note A → Edit → type "draft" → click Note B in the Library. B opens, A's "draft" is gone, no dialog, nothing in History. Same via ⌘K → a file hit, via the assistant opening a citation, and via a background job finishing while you are not mid-turn.


**Fix.** Guard the mutation, not the callers: make `viewFile` (or a thin `openFileGuarded` that every caller uses) run its body inside `guardLeave("Opening another file", …)` when `editModeRef && editorDirtyRef`. Do the same for the two ⌘K jumps that null the open file outside the guard (miscActions.ts:342 revealMemory, 384 revealBrowser, Overlays' `leaveAreas`) and for workflowActions/scriptActions/skillActions' `setOpenFile(null)`.


### P1.15 Settings → Remote AI (the Closet) turns the "local-only" privacy scanner into a bulk export of every file's raw text

`src-tauri/src/commands/privacy.rs:1067` · privacy · CONFIRMED


**Symptom.** With a LAN address saved in Settings → Connections → Remote AI, the background privacy scanner posts the complete extracted text of every unscanned file, in chunks, to that machine's Ollama — while Settings → Cloud privacy says "A local model reads each imported file once and marks private details." The sidecar route documented to refuse a non-local scan never fires, because it tests the model NAME and the Closet leaves the name local.


**Repro.** Room with several imported documents, cloud-privacy door on. Settings → Connections → Remote AI → http://192.168.1.20:11434 → Save. Settings → Privacy & recovery → Cloud privacy → Scan now. On the receiving box, `ollama` logs (or tcpdump on :11434) show /api/generate calls carrying the documents' full text. Nothing in Settings says the reading happened off this Mac.


**Fix.** Give the sidecar guard the transport half it never got: in scan_text, refuse when the base_url is not loopback as well as when the model name is non-local (`if is_nonlocal_model(model) or not _base_is_loopback(base_url): raise ValueError(...)`). On the Rust side, either skip scheduling a scan when `!ollama_runs_here()` or say plainly in the Cloud-privacy panel that the scan runs on the remote machine — the copy at CloudPrivacySection.tsx:302 must stop saying "a local model" when it is not one.


### P1.16 "Mark this moment" (and any note) is refused mid-recording: at_time checks against a stale duration

`src-tauri/src/commands/recording_cmds.rs:785` · correctness · CONFIRMED


**Symptom.** While recording, "Mark this moment" — and any note or chapter placed at a live moment — is refused with "That moment is outside this recording." for a moment that is plainly inside it. It works only in the window where the engine's copy of duration_cs is still 0 (a brand-new recording before its first checkpoint) or within 6 s of a checkpoint.


**Repro.** Start a recording with live transcription on. Wait for a checkpoint (60 s of audio, or 8 decoded phrases). Speak for another ~20 s and press "Mark this moment": t0 = live-6 s is beyond the checkpointed duration_cs and the highlight is refused. Same for rec_note_add on the phrase just spoken.


**Fix.** In the `EngineMsg::EditMeta` arm (recording.rs:1744) set `self.meta.duration_cs = cs_of_samples(self.mixed.len());` immediately before `apply(&mut self.meta)`, so the guard measures against the live timeline the UI is showing. Add a test that drives EditMeta on a running engine past one checkpoint.


### P1.17 Once any chunk is embedded, the "no real match" fallback flag can never be true

`src-tauri/src/commands/retrieval.rs:207` · honesty · CONFIRMED


**Symptom.** With the embed model installed and the backfill finished, no question can ever be a no-match. "asdf qwerty" returns the six highest-cosine chunks under the header "Context from files stored in this room:", and their file names are shown to the user as source chips. The CHG-10 rule that filler must not be credited as a source, and search_room's no-match answer, are both unreachable.


**Repro.** Room with nomic-embed-text pulled and chunks embedded. Ask a question sharing nothing with the room ("asdf qwerty"). Chips name files that had nothing to do with the question; ask the model to search_room for the same nonsense and it gets four excerpts instead of "No matching content found."


**Fix.** Compute `fallback` from a stricter set than the RRF pool: require a keyword hit, or a cosine above an absolute floor plus a margin over the room's own median cosine, before a vector-only chunk counts as a match. Keep `cos > 0.0` as the RANKING input so blending is unchanged, and add a test that drives the embedded path with an orthogonal/anti-correlated question vector.


### P1.18 Settings → Model promises "images stay local" while grounding_pick deliberately prefers the room's own cloud model

`src/settings/ModelSection.tsx:175` · honesty · CONFIRMED


**Symptom.** With any cloud engine connected, Settings → Model prints "Images stay local (vision and image marking always use the local model)". With an OpenRouter vision model selected and the cloud-privacy door off, image marking uploads the user's photograph to OpenRouter — the sentence asserts something the code contradicts by design.


**Repro.** Connect OpenRouter, pick a vision-capable model, Settings → Cloud privacy → turn the door off for this room. Ask the AI to mark something in an image: grounding_pick returns the OpenRouter model (image_reaches_model is true because active_policy() is None) and the pixels go out. Settings → Model still claims images always use the local model.


**Fix.** Replace the parenthetical with the conditional truth that image_reaches_model already encodes — images stay on this Mac only while the cloud-privacy door is on — or name the model that will receive them, the way HelpersSection does with `groundingModel`.


### P1.19 ⌘Q after cancelling the unsaved-edits dialog quits silently and discards the buffer

`src-tauri/src/commands/shell_exit.rs:47` · data-loss · CONFIRMED


**Symptom.** ⌘Q with an unsaved Monaco buffer raises the "Unsaved edits" dialog; pressing Cancel keeps the app open but permanently disarms the guard. The next ⌘Q — even minutes later, with more unsaved typing — terminates the process with no dialog and the buffer is gone.


**Repro.** Open a .md file, Edit, type without saving. ⌘Q → dialog → Cancel (or Esc). Type another character. ⌘Q again → app exits immediately, edits lost. (Saving in between hides the bug: it clears UNSAVED_EDITS and re-arms the latch.)


**Fix.** Distinguish an UNANSWERED hold from an answered one. Cheapest correct fix: in the `!go` branch of Workspace.tsx's onQuitRequested, call `await api.setUnsavedEdits(false)` then `await api.setUnsavedEdits(true)` (which clears QUIT_HELD and re-asserts the dirty flag); better, add a `quit_answered()` command that clears QUIT_HELD on ANY reply to `quit-requested`, keeping the hold-once rule only for the case where the window never replies. Add a test that a decline re-arms the door.


### P1.20 Escape closes the open file without the unsaved-edits guard

`src/workspace/effects.ts:882` · data-loss · CONFIRMED


**Symptom.** Escape while a dirty editor is open — with focus anywhere outside Monaco's hidden textarea — throws the buffer away silently: no dialog, no undo, nothing written to History.


**Repro.** Open a note → Edit → type → click the sidebar's "+ Add page or source" (or any viewer toolbar button, or the breadcrumb) → press Escape. The menu stays up; `openFile` becomes null, Monaco unmounts, the typing is gone.


**Fix.** Route it through the same door the other six exits use: `a.guardLeave("Closing this file", () => s.setOpenFile(null))` — `a` is already in scope in that effect. While there, treat `isContentEditable` as typing, and give the sidebar's add-menu its own capture-phase Escape (the TopBar pattern) so Escape never falls through to the file.


### P1.21 Cancelling the ⌘Q "unsaved edits" dialog disarms it — the next ⌘Q quits and discards the buffer with no prompt

`src-tauri/src/commands/shell_exit.rs:59` · data-loss · CONFIRMED


**Symptom.** Once the user answers Cancel to the ⌘Q unsaved-edits dialog, the door is disarmed for the rest of the session (until a save or a room change clears the flag). The next ⌘Q quits immediately, with no dialog, and the unsaved Monaco buffer goes out with the process.


**Repro.** Open a text file in a room, type without saving, press ⌘Q, click Cancel. Keep typing. Press ⌘Q again → the app quits at once with no dialog and the edits are gone.


**Fix.** Release the latch when the quit is declined: add a `release_quit_hold` command (or make `set_unsaved_edits(true)` also clear QUIT_HELD) and call it from the `!go` branch in Workspace.tsx. The fail-open latch should only survive a window that never ANSWERED, not one that answered no. A unit test on `hold_quit_for_unsaved` asserting ask → decline → ask again would fail on today's code.


### P1.22 Compaction orphans tool results: the assistant `tool_calls` turn is digested away while its `role: "tool"` reply survives

`sidecar/arcelle_sidecar/compaction.py:268` · correctness · CONFIRMED


**Symptom.** On a conversation long enough to trip compaction, the payload can go out with a `role: "tool"` message that no preceding assistant turn declares. An OpenAI-compatible provider rejects the whole request with a 400 and the turn dies after the tool work is already done; Ollama is documented (budget.py:244-246) to reject the same shape.


**Repro.** `cd sidecar && uv run python -c` on the four-message transcript above with `budget_bytes=50_000` — output is `[system, user(digest), tool]`. Production shape: an agent round whose newest tool result alone exceeds `budget_bytes * RECENT_SHARE` (e.g. a 40KB `browse_read` on a payload-fitted 32k local window, or ~170KB on a 128k provider window), or any tail that fills to within the assistant turn's size of that boundary.


**Fix.** After `_split`, repair the boundary: while `recent` starts with a `role: "tool"` message, move it back into `older` (or pull the trailing assistant `tool_calls` turn out of `older` into `recent`). Add a regression test asserting every `tool` message in `compact_to_budget`'s output is preceded by an assistant turn declaring its id, and correct the docstring at compaction.py:303-305.


### P1.23 An id collision between the agent and the editor silently destroys the shape the user just drew

`src/viewers/sketch/model.ts:1020` · data-loss · CONFIRMED


**Symptom.** A shape drawn during an assistant `draw` call is silently replaced by one of the agent's shapes: same id, different geometry. The editor and the file then disagree about what `e5` is.


**Repro.** Open a sketch whose file holds 4 elements (seq=4 on disk). Start drawing boxes continuously (each stroke re-arms the 1.4 s timer, so nothing is flushed and disk seq stays 4). The user's first new box is `e5`. Ask the assistant to add a box; `tool_draw` loads seq=4 and also mints `e5`. On `sketch-drawn`, `theirIds` contains `e5`, so the user's `e5` is dropped from `unsaved` and the agent's takes its place on screen. If the agent minted every id the user did (e5..e7 both sides), `unsavedKept` is empty, no save is scheduled, and the armed timer writes the user's pre-agent document back — losing the agent's work from the file too.


**Fix.** Stop treating the id string as identity across the seam. Either (a) carry the base seq the agent started from in the `sketch-drawn` payload and treat any local id above it as local-only — renumbering it and remapping `from`/`to` the way `duplicate()` already does — or (b) give the two sides disjoint id spaces (e.g. the editor mints `u<n>`), and bump `seq` past both. Add a merge test where both sides mint the same id.


### P1.24 #sketch diagrams five columns deep get broken connectors: route() clamps endpoints to 1600×1000 while the page it built is bigger

`src-tauri/src/commands/sketchdoc.rs:1230` · correctness · CONFIRMED


**Symptom.** Any `#sketch` of a 5-step (or 5-branch) flow draws no connector into the last column — just a stray arrowhead inside the second-to-last box — and the layout report says nothing is wrong.


**Repro.** `#sketch` a five-step process. layers=5 → doc.width=2180; the link from column 4 to column 5 routes to start=(1680,cy) end=(1790,cy), both clamped to x=1600, producing a degenerate arrow. Add a 5-layer case to `a_described_flow_lays_out_left_to_right_with_nothing_overlapping` and it fails.


**Fix.** Thread the document's own `width`/`height` into `route`/`edge_point` (and `clamp_box`/`translate`) instead of reading the module constants, and clamp against those. Add a layout test at 5 and 6 layers asserting each link's two endpoints differ and each lands within 20 units of its box's edge.


### P1.25 The editor clamps every coordinate to 1600×1000, so a shape on a wider #sketch page teleports on the first drag

`src/viewers/sketch/model.ts:242` · correctness · CONFIRMED


**Symptom.** On any drawing wider than 1600 (every `#sketch` with 4+ layers), the right-hand part of the page is unreachable with the pointer, and a shape there selected from the object strip jumps hundreds of units left on the first nudge or drag — and the jump is autosaved.


**Repro.** Run `#sketch` on a five-step process (doc.width 2180) and open the .sketch. Click the last box: nothing selects. Select its chip in the object strip and press the right arrow: `clamp(1801, 0, 1600-300)` = 1300, so it moves 500 units left.


**Fix.** Thread `doc.width`/`doc.height` (not `CANVAS_W`/`CANVAS_H`) through `translate`, `fitToBox`, `strokeFromTrail` and `toCanvas`. Keep the constants only as the default page size in `emptySketch`.


### P1.26 Saving, adding or removing a resource file silently throws away unsaved SKILL.md edits

`src/workspace/skills/SkillsView.tsx:507` · data-loss · CONFIRMED


**Symptom.** Typed-but-unsaved Name / Description / Offered-to / SKILL.md instruction edits are silently replaced by the stored values (and the Save SKILL.md button greys out) the moment the user saves, adds, or removes a file in the Folder-contents pane. No prompt, no toast, no undo.


**Repro.** Open a skill. Type into the SKILL.md instructions textarea (Save SKILL.md lights up). Without saving, click references/policy.md in Folder contents, type one character, press Save on the file. The file saves and the instructions textarea snaps back to the stored text with Save SKILL.md disabled. Same with typing a path into 'New file path' and pressing Enter, and with Remove on an open file.


**Fix.** Make `load()` refuse to clobber a dirty editor: keep `draft` when `dirty` is true (still refresh `bundle.resources`), or give the resource paths a `reloadResourcesOnly()` that re-fetches the bundle without calling `setDraft`/`setDirty(false)`. Routing them through `confirmDiscard("editor")` also works but is worse UX — the user did not ask to discard anything.


### P1.27 Selecting another skill while editing discards unsaved work without asking

`src/workspace/skills/SkillsView.tsx:225` · data-loss · CONFIRMED


**Symptom.** With the editor open and unsaved SKILL.md or resource-file edits pending, clicking any other skill in the left sidebar loads that skill and destroys the edits with no dialog — while the sibling action (the '← All skills' button) does ask.


**Repro.** Open skill A from the sidebar, edit its instructions (or open one of its files and edit the text). Do not save. Click skill B in the sidebar. B loads immediately; A's edits are gone and nothing was asked.


**Fix.** Give the selection change the same gate as leaving: in SkillsView, intercept the id change (e.g. keep a `pendingSelect` and only `load()` after `await confirmDiscard("editor")`, reverting `s.setSelectedSkillId` to the previous id on cancel), or move the guard into a SkillsView-provided wrapper that Sidebar's rows call instead of the raw `a.openSkill`.


### P1.28 read_of.chars is a BYTE count in Rust and a UTF-16 count in the UI — every non-ASCII transcript is permanently "stale"

`src/viewers/RecordingView.tsx:354` · honesty · CONFIRMED


**Symptom.** Immediately after a successful read, the Notes/Highlights/Chapters tabs show the "transcript changed since this was read" badge for any transcript that is not pure ASCII — a warning about an edit that never happened, sitting over findings that are in fact current, and one the user cannot clear.


**Repro.** Read a recording transcribed in Hebrew (one segment "שלום" = 4 UTF-16 units, 8 UTF-8 bytes). When the job finishes, open Notes: readOf.chars = 8 vs the UI's 4, so `stale` is true and the rec-read-stale badge renders. Press "Read again" — it comes back with 8 again.


**Fix.** Stop deriving the same fact twice on two sides of the seam. Best: have Rust compute staleness (`ReadStamp::of(&meta.segments) != read_of`) and ship it as a boolean on the meta, so there is one implementation. If the derivation must stay in the UI, make both sides count Unicode scalar values (`s.text.chars().count()` in Rust, `[...s.text].length` in TS).


### P1.29 A pending autosave fires after the agent's document is folded in and erases the agent's work from disk

`src/viewers/SketchView.tsx:348` · data-loss · CONFIRMED


**Symptom.** The assistant reports a finished diagram, the shapes appear on the canvas, and about a second later they are written out of the file. Nothing on screen changes, so the loss is only discovered on reopen — and the agent's version is not in version history either.


**Repro.** Open a sketch with an existing box. Drag it (a move creates no element, so `scheduleSave(docA)` is armed for 1.4 s). Within that window the assistant's `draw` lands adding e7/e8. Every id in `mine` is also in `theirs`, `unsavedKept` is empty, no new save is scheduled, and ~900 ms later the armed timer flushes `docA` — which has no e7/e8. Reopen the file: the agent's shapes are gone.


**Fix.** Call `scheduleSave(merged)` unconditionally in `applyAgent` (or at minimum clear `saveTimer.current` there). A redundant write of an identical document costs one IPC; the current code's cheapest failure is losing a whole generated diagram.


### P1.30 A vision-capable OpenRouter model is handed the user's SCREEN — the one thing the cloud tier's design says structurally never crosses

`src-tauri/src/room_mcp.rs:104` · privacy · PLAUSIBLE


**Symptom.** In a room whose model is an OpenRouter model that declares image input, `view_screenshot` / `ui_snapshot` capture the app window and the raw PNG is sent to OpenRouter. With the privacy door OFF nothing strips it (the door-off warning promises only that "questions, documents and tool results" leave, not the screen); with the door ON it is stripped and the model is told it was attached anyway (the separate honesty defect). The screen shows whatever room content is on display — an open PDF page, a transcript, a photo.


**Repro.** Set the room model to an OpenRouter vision model, turn Cloud privacy OFF (or leave it on and watch `images_blocked` count 1 while the model still claims to see). Ask "what am I looking at?". The tool returns "Captured a screenshot of the app window. The image is attached..." and the PNG of the app window is POSTed to openrouter.ai.


**Fix.** Decide the rule where the guarantee is written: either gate `effects.vision_chat` on `runs_on_this_mac(&model)` for the SCREEN tools specifically (falling through to perceive_image's local vision-model description, which is what the doc already promises), or drop the guarantee from room_mcp.rs:100-110 and make the door-off warning say the screen can leave. Do not leave the doc and the code disagreeing.


### P1.31 The shape the user just finished is dropped by the agent merge, because endGesture merges against a docRef that commit() has not updated

`src/viewers/SketchView.tsx:849` · data-loss · PLAUSIBLE


**Symptom.** Draw a shape while the assistant is drawing: on pointer-up the shape flashes onto the canvas and is immediately gone. This is the exact failure the whole hold-until-pointer-up mechanism and `mergeAgentDoc` exist to prevent, and it is deterministic — not a race.


**Repro.** Open a sketch, ask the assistant to add something, and start drawing a box before its `draw` lands. The `sketch-drawn` listener sees `drawingRef.current === true` and parks the document in `pendingAgent` (line 423-425). Release the pointer: `commit` adds the box (setDoc queued), then `applyAgent` merges from the stale `docRef.current`, the box is absent from `unsaved`, and `setDoc(merged)` — queued after and not a functional update — wins. The box is gone from the screen; whichever of the two `scheduleSave` calls fires last decides whether the file loses the box or loses the agent's shapes.


**Fix.** Use `advance(next)` inside `commit` (or call `advance` for the `made` document in `endGesture` before applying the held agent doc) so `docRef.current` is always the live document at the seam. A regression test can drive `endGesture` with a pending agent document and assert the just-made id survives the merge.


---

## P2 / P3 — full list, by area


### Other (77)


- **[P2·correctness]** The waveform after "Continue recording" is the pre-continuation envelope — the peak cache is never invalidated
  `src-tauri/src/commands/peaks.rs:123` — After continuing an existing recording and stopping, the waveform draws only the original stretch: the axis stops at the old length, every speaker lane / highlight band / chapter rule is positioned against the wrong duration, and clicking near the right-hand end seeks to the old end.
  _Fix:_ Invalidate on write rather than on room close: drop the `<id>:*` entries whenever a file's bytes are rewritten (`finalize_rec_audio`, `store_file_bytes`, version rollback), or key the cache on a content/version token instead of the bare file id.

- **[P2·privacy]** Double-clicking Resume orphans a microphone tap that never stops
  `src/workspace/liveRec.ts:215` — Two overlapping `attachMicTap` calls both pass the guard; the loser's MediaStream and AudioContext are dropped on the floor with no teardown. Its tracks are never stopped (macOS keeps the mic indicator lit for the life of the process) and its worklet keeps calling `rec_push_audio` 4x/second — into the current session while it lasts (so the mic lane is mixed in twice) and into any later session that starts.
  _Fix:_ Claim the singleton synchronously: set a module-level `attaching = true` (or park a placeholder in `teardown`) before the first await, and have any loser stop the stream it was handed and return. Independently, disable the Resume button while `resumeLiveRecording` is in flight — it is enabled for the whole round trip today.

- **[P2·correctness]** Podcast host names with surrounding whitespace silently record in the default voice
  `src/workspace/PodcastPanel.tsx:136` — A cast entry saved with a leading or trailing space previews in the chosen voice but records the whole episode in the default voice, with nothing on screen warning about it — after a multi-minute cloud TTS job.
  _Fix:_ Trim once, on the way in: store `h.name.trim()` in `set_podcast_cast` so the persisted cast can never disagree with the turns it just rewrote (belt and braces: trim in `editHost`/`saveCast` too).

- **[P2·honesty]** The address bar reverts from the search query to the parked page's URL one poll after a search
  `src/workspace/BrowserView.tsx:400` — With a page already open, running a search leaves the address box showing the query for about a second and then silently replaces it with the URL of the page parked at 1x1 behind the results. The box now names a page that is not on screen, beside the magnifier that says it is a search box, and Enter navigates there instead of re-running the search.
  _Fix:_ Gate the assignment on what is actually in front of the page: `if (!editing && !searchOpen && next.url) setAddress(next.url);`, reading searchOpen through a ref so `refresh` is not rebuilt on every results toggle. Cover it beside e2e/page-script/browserTrust.test.mjs:273.

- **[P2·honesty]** go() sets the settled URL and then immediately overwrites it with the old page's URL
  `src/workspace/BrowserView.tsx:544` — For as long as the outgoing document is still live — up to the whole load time of a slow site, not one poll — the address bar shows the URL of the page being navigated away from, with a padlock/'Not secure' chip derived from that stale scheme, and Rust's own tab record is rewritten to the old URL as well.
  _Fix:_ Make `info` refuse to answer for a superseded document the way the readiness probe already does — return `{ok:false}` (or a `superseded:true` flag) from page.js when `window.__arcelleSuperseded` is set, and let browser_info fall back to `active_url`. That fixes the address bar, the padlock and the record corruption in one place, rather than adding a per-caller 'expected URL' latch in React.

- **[P2·ux-defect]** A failed navigation from the reading view parks the page behind a results list that does not exist
  `src/workspace/BrowserView.tsx:597` — The browser pane goes completely blank — no page (parked at 1x1), no results list, no start screen — and Save, Read-as-text and the chat page scope all go dead, with no control on screen able to undo it.
  _Fix:_ `if (search) setSearchOpen(true);` in the catch — or better, give BrowserReader its own onNavigate that reports the error without touching results state, since 'go back to the results I came from' is meaningless for a link clicked in the transcript.

- **[P2·ux-defect]** Erasing the journal fails silently — the rejection is never caught and nothing is shown
  `src/workspace/BrowserView.tsx:1148` — Erase closes the confirmation, leaves the entries on screen unchanged, shows no banner, and throws an unhandled promise rejection. The user cannot tell whether nothing was deleted, everything was, or — in the partial-failure case — the record was destroyed while the cached queries and page text survived.
  _Fix:_ `api.browserClearJournal().then(loadJournal).catch((e) => { setError(String(e)); setConfirmClear(true); void loadJournal(); })` — reload either way so the panel shows what actually survived — and wrap the two deletes in one sqlite transaction in browser_clear_journal so a partial erase cannot be reported as either outcome.

- **[P2·ux-defect]** The results page steals DOM focus whenever the AGENT searches, turning typing into single-key actions
  `src/workspace/BrowserSearch.tsx:214` — An assistant-driven search mounts the results page, which grabs DOM focus out from under whatever the user is typing in. The remaining keystrokes are consumed as single-key shortcuts — including 'a', which imports the selected result page into the room as a file and pins it to the composer.
  _Fix:_ Only take focus for searches this component's user started: pass a `userInitiated` flag from BrowserView (true from runSearch, false from onBrowserSearched) and skip the focus call otherwise; additionally skip it whenever document.activeElement is an input, textarea or contenteditable.

- **[P2·security]** Downloaded runtimes are executed with no integrity verification, and uv is fetched from an unpinned `latest` URL
  `src-tauri/src/commands/runtimes.rs:343` — The app downloads ~22–45 MB of executable content over HTTPS, unpacks it into its data dir, and prepends it to the PATH of every stdio MCP connector without verifying a checksum or signature — and for uv without pinning a version at all.
  _Fix:_ Pin uv to an explicit release tag as Node already is; ship expected SHA-256 constants per (kind, arch, version) and verify the downloaded bytes with sha2 BEFORE extraction, deleting the download and failing loudly on mismatch. As a cheaper interim, fetch and check nodejs.org's SHASUMS256.txt for the Node tarball and pin uv's tag so a checksum can be added at all.

- **[P2·ux-defect]** The token bar and its "Hand off" button vanish on a reopened chat — the per-message usage that would restore them is persisted and never read
  `src/workspace/TokenBudgetBar.tsx:67` — Reopen the app, select a long conversation: no token meter and no "Hand off" button, even though the last turn's usage snapshot is stored on the assistant row. The context-compaction affordance is missing precisely when the window is nearly full, until the user sends one more (possibly overflowing) turn.
  _Fix:_ Seed usageByChat[chatId] from the newest assistant message's effects.usage when a chat's messages load, and move the Hand off button outside the `if (!usage) return null` guard so a chat with no snapshot yet still offers it.

- **[P2·ux-defect]** The Library's ⌘A steals Select-All from the whole window while Home is the destination, including when the sidebar is hidden
  `src/workspace/Sidebar.tsx:543` — In Home/Browse, ⌘A over a PDF, transcript or prose document selects every visible library row instead of the document's text — and with the sidebar collapsed it arms that multi-file selection invisibly.
  _Fix:_ Scope it the way the PDF viewer scopes ⌘F: require the event target to be inside the library pane (`e.target.closest('.pane-library')`) or at minimum require `layout.visible.includes("library")` before calling preventDefault; otherwise let the surface with focus keep its native select-all.

- **[P2·data-loss]** The per-answer Undo chip restores the newest version, so it can roll back the user's own later save
  `src/workspace/fileActions.ts:171` — Clicking an older answer's Undo edit chip restores whatever version is newest at click time, not the one that turn created, so it discards the user's own later save and puts the AI's wording back while the toast says Change undone.
  _Fix:_ Record the version id each AI write created and store {fileId, versionId} in undoByMsg, restoring that id; refuse or warn when the head has moved since, the way apply_with_staleness (edit_gate.rs:163-205) already does.

- **[P2·correctness]** Undo reverts only the last of several AI writes to the same file in one answer
  `src/workspace/fileActions.ts:170` — When one turn edits a file twice, the Undo chip reverts one write, removes itself and reports Change undone, leaving the earlier write applied with no chip left to remove it.
  _Fix:_ Collect an ordered list of version ids per file for the run and restore them newest-first in one loop, keeping the chip until all are reverted; equivalently, restore the snapshot taken at the turn's FIRST write to that file.

- **[P2·ux-defect]** A file whose name and content both match is hidden by the "In the file name" filter
  `src/workspace/SearchExpanded.tsx:401` — Setting the Match filter to "In the file name" drops precisely the files whose name AND content matched — the strongest hits vanish, often leaving zero results.
  _Fix:_ Return explicit `matchedName` / `matchedText` booleans from `search_all` (a file may carry both) and filter on them, instead of overloading an empty snippet; the FTS pass can cheaply also test the name against the same terms.

- **[P2·honesty]** ai_status reports running:false when the PYTHON SIDECAR is down, so the chat blames Ollama and offers a button that cannot help
  `src-tauri/src/commands/models.rs:216` — With Ollama installed and reachable but the sidecar unable to start, the chat pane blames Ollama and offers an Open Ollama button that cannot fix anything — while every ask in the same session correctly says the AI helper could not start.
  _Fix:_ Match on the error string in the Err arm: when it starts with `SIDECAR_UNAVAILABLE`, carry a distinct field on AiStatus (e.g. `helperDown: true` plus the reason) and render the sidecar's own message instead of the Ollama onboarding banner.

- **[P2·correctness]** `split_self_closing` drops closing tags, producing malformed presentation.xml for decks that write `<p:sldId …></p:sldId>`
  `src-tauri/src/commands/office.rs:107` — A .pptx whose slide list uses the long `<p:sldId …></p:sldId>` spelling is rewritten without its closing tags, so `ppt/presentation.xml` is unbalanced and Quick Look refuses the staged file; every slide except the first renders as 'This Mac could not draw this slide.'
  _Fix:_ In `split_self_closing`, after locating the first `>`, check whether the captured slice ends in `/>`; if not, extend the end past the matching `</tag>` so the whole element (including any child `<p:extLst>`) is carried through. Add a test asserting `id_order` round-trips and the output stays balanced for the long spelling.

- **[P2·honesty]** OCR silently drops PDF pages it cannot rasterise while claiming it reports whatever it cut
  `src-tauri/src/ocr.rs:157` — Pages that fail to rasterise are dropped from the OCR text with no mention, so a scan whose pages mostly failed to render is stored and indexed as if the pages that worked were the whole document.
  _Fix:_ Count the skipped pages inside the loop and, when non-zero, append a second note on the same footing as the cap note, e.g. `[N of M pages of this scan could not be rendered and were not read]`.

- **[P2·honesty]** `vision_door_block` asserts "can look at images" for a model whose vision support is Unknown
  `src-tauri/src/commands/capabilities.rs:537` — With the privacy door on and the provider catalog unreadable, Settings' vision preflight and `locate_in_image` both assert that the engine can see images — a capability the module's own doctrine forbids claiming for an engine we could not reach.
  _Fix:_ Gate the door sentence on a confirmed yes — `if caps.image_reaches || caps.vision != Support::Yes { return None; }` — and let `preflight` fall through to the existing `Support::Unknown` arm, which already produces 'Could not confirm that … (the AI engine may be unreachable)'. Add a test pinning Unknown + door-on to the Unknown verdict.

- **[P2·honesty]** `feedback_draft`'s doc comment promises feedback never leaves the Mac; the code sends it to the room's cloud engine
  `src-tauri/src/commands/feedback.rs:40` — A comment states as a privacy guarantee something the code deliberately does not do: with a cloud engine selected, raw feedback text is sent off the Mac by `sidecar_json("/feedback_draft")`.
  _Fix:_ Pick one: either match the comment by calling `best_local_default(&models)` unconditionally here (as dictation shaping does), or delete the false claim and replace it with a note that the room's chosen engine is used, with the privacy door as the actual seam.

- **[P2·data-loss]** CSV writer never quotes a value containing a bare CR, and the parser deletes bare CRs — a cell edit loses characters
  `src-tauri/src/commands/spreadsheet.rs:172` — A cell value containing a bare CR is written unquoted, and re-parsing that file drops the CR — the two halves of the value fuse, permanently, on the next edit or grid view.
  _Fix:_ Add `|| value.contains('\r')` to `must_quote`, and add a round-trip test asserting a lone-CR value survives write → read unchanged.

- **[P2·dead-code]** Memory soft-delete has no recovery surface and no purge: "Forget this" hides the row forever
  `src-tauri/src/commands/library.rs:73` — Deleting a memory only flags it. No view lists trashed memories, no wrapper reaches `restore_memory`, and no code path ever issues a DELETE on the memories table — so "Forget this" is neither undoable nor a real forget, and the actor attribution recorded on every agent deletion is unreadable.
  _Fix:_ Pick one half and finish it. Either add `list_trashed_memories` + an api.ts `restoreMemory` wrapper + a memories trash section (which is what db/memories.rs:66-69 says the soft delete was for, and which would finally surface `trashed_by`), or extend the purge so `empty_trash` also deletes trashed memory rows. Shipping neither half leaves the feature strictly worse than the hard delete it replaced.

- **[P2·dead-code]** `rec_note_set` / `rec_chapter_set` are unreachable: a room-written note cannot be corrected in place
  `src/api.ts:1301` — The Notes/Chapters panel marks room-written items with "?" and the backend's stated remedy is to retype them, but no UI control calls `recNoteSet`/`recChapterSet` — so a wrong room-written action item can only be deleted, and it returns on the next reading pass.
  _Fix:_ Put an inline edit on the found-row — the same pattern as the transcript correction box at RecordingView.tsx:1098-1105 — calling `api.recNoteSet` / `api.recChapterSet` and folding the returned RecMeta into state the way deleteItem already does at :1195.

- **[P2·dead-code]** Shot lists cannot be deleted and shots cannot be reordered — both commands exist with no caller
  `src/api.ts:529` — The Story tab can create, rename and re-shape a shot list and add/remove individual shots, but there is no control to delete a list or move a shot, though both commands are registered and wrapped.
  _Fix:_ Add a confirm-guarded delete on the list header calling `api.storyDeleteList(id)`, and up/down (or drag) handles on shot rows calling `api.storyReorderShots(listId, ids)` — both commands already exist at commands/story.rs:279 and :775.

- **[P2·correctness]** Enter on any button inside the results page navigates to the selected result instead of pressing the button
  `src/workspace/BrowserSearch.tsx:193` — A keyboard user tabs to any control on the results page — 'Ask the assistant about this', 'Summarize these results', a card's Open-in-new-tab / Peek / Add button, a citation chip — and presses Enter. The button does not fire. The browser navigates to whichever result is currently selected instead.
  _Fix:_ Bail out of the container handler for any interactive target, not just inputs: `if ((e.target as HTMLElement).closest('button, a, input, textarea, [contenteditable]')) return;` at the top of onKeyDown. The card articles are tabIndex=0 divs, not buttons, so Enter-to-open on a focused card keeps working.

- **[P2·honesty]** A journal read that failed is rendered as "Nothing yet." and disables the only Clear button
  `src/workspace/BrowserView.tsx:454` — If browser_journal rejects, the Journal panel presents an empty record — 'Nothing yet.' — for a room whose record was never read. The panel is the browser's audit surface, so a failed read is presented as a clean history, and the Clear button goes disabled with the tooltip 'Nothing recorded yet', so the user cannot act on the record they cannot see.
  _Fix:_ Keep the failure: add `journalError` state set in a .catch, render 'The record could not be read — <reason>' with a Retry instead of 'Nothing yet.', and leave the previous rows on screen rather than replacing them with [].

- **[P2·correctness]** The room's web cache can only be erased through a button that is disabled whenever the journal is empty
  `src/workspace/BrowserView.tsx:1160` — The Journal's Clear button is the only control in the entire app that empties the web cache — the user's search terms, the full readable text of result pages and every preview thumbnail. It is disabled on `journal.length === 0`, and the assistant's chat-side web_search fills that cache without writing a journal row. So a room can hold the queries and page text of every search the assistant ran while the erase control is greyed out and labelled 'Nothing recorded yet'.
  _Fix:_ Gate the button on the whole scope rather than the journal alone: fetch browser_clear_scope when the panel opens and enable Clear whenever `journal + searches + pages + images > 0` (clearWarning in browserJournal.ts:155-165 already renders the journal-empty case correctly as 'Erase N cached items'). Longer term, journal the assistant's web_search too, or give the cache its own erase control in Settings.

- **[P2·correctness]** Every successful cell edit remounts the grid: the change marks and ⌘Z history are destroyed and the whole workbook is re-fetched and re-parsed
  `src/workspace/ViewerRouter.tsx:180` — In grid edit mode, committing a cell in an .xlsx or .csv writes the file, and the backend's `file-updated` event makes the workspace re-fetch the content and bump viewerRev — which changes the grid's remount key. SheetView is destroyed and rebuilt, so `edits` resets to empty: the "N cells changed" receipt and its "Undo <ref> ⌘Z" button — which SheetView's own comment calls "the receipt — and the way back out", the only undo the grid has — disappear immediately after each edit, and the pink change marks with them. The bytes are also re-staged, re-downloaded over roommedia:// and re-parsed by SheetJS on every single cell commit, so editing a large workbook stalls per keystroke-commit.
  _Fix:_ Do not remount the grid for a write the grid itself just made: either drop `viewerRev` from the grid's key while edit mode is on, or have `editCell` mark the file id as self-originated (like `s.editedRef`) so the `file-updated` handler skips the reload for that revision. If a reload really is needed, lift the `edits`/undo history out of SheetView so it survives it.

- **[P2·correctness]** viewFile has no staleness guard, so two quick opens can paint the loser over the winner
  `src/workspace/fileActions.ts:639` — Opening file B while file A's `get_file_content` is still in flight can leave A on screen: whichever call resolves LAST wins `setOpenFile`, and the tab watcher then mints/activates a tab for it, so the click the user made most recently is the one that loses. The 'Opening…' indicator is cleared by the first resolver, so the still-pending open shows no progress at all.
  _Fix:_ Track the intended open in a ref (`openIntentRef.current = id` before the await) and drop the result when it no longer matches, exactly as the getPodcast effect does; clear `openingFileId` only when it still equals this call's id.

- **[P2·data-loss]** Editing or adding a memory silently truncates it to 500 characters, with no cap in the UI and no undo
  `src-tauri/src/commands/library.rs:59` — A memory longer than 500 characters loses everything past character 500 the moment it is saved or edited from the Memory page — no warning, no marker, no toast, and memories have no version history to recover from.
  _Fix:_ Either lift the clamp on update_memory (the injection budget is already enforced independently by select_memories) or make it refuse rather than truncate: return "That memory is longer than 500 characters" and add a maxLength plus a live counter to both MemoryView inputs so the limit is visible before the text is destroyed.

- **[P2·data-loss]** A CSV with lone-CR line endings collapses into a single row on any cell edit
  `src-tauri/src/commands/spreadsheet.rs:110` — `parse_delim_quoted` deletes every `\r` in the unquoted branch instead of treating a lone CR as a row separator, so a classic Mac-style CSV (CR-only, still emitted by 'CSV (Macintosh)' exports and some legacy tools) parses as ONE row with the last field of each line fused to the first field of the next. Any write through `set_cell_in_bytes` then serialises that fused single row back over the file, destroying its row structure permanently.
  _Fix:_ In `parse_delim_quoted`'s unquoted branch, treat `\r` as a row terminator (consuming a following `\n` when present) rather than discarding it, and teach `delim_style` a third case for CR-only files so the convention is preserved on write. Add a round-trip test for a CR-only two-row CSV asserting the row count and the values survive an edit.

- **[P3·perf]** Podcast preview blob URLs are never revoked and preview state is keyed by a duplicable name
  `src/workspace/PodcastPanel.tsx:146` — Each voice preview leaks one object URL (a few hundred KB of WAV) for the session; and with two identically-named hosts the Stop/Play state and the click handler address the wrong row.
  _Fix:_ Keep the URL beside the element and `URL.revokeObjectURL` it in `stopPreview` and in `onended`; key `previewing` on the cast index, not the name.

- **[P3·ux-defect]** Toggling a search-result peek twice in quick succession re-opens it when the fetch lands
  `src/workspace/BrowserSearch.tsx:158` — Press 'p' (or the eye button) twice on a result while the first peek is still loading: the preview block closes as expected, then re-opens by itself when the read returns, showing text for a peek the user cancelled.
  _Fix:_ Guard the write inside the setter — `setPeeks((m) => (hit.url in m ? { ...m, [hit.url]: text } : m))` — for both the resolve and the reject arm, or track a per-URL generation counter and drop stale answers.

- **[P3·ux-defect]** Notice timers clobber each other, so a later confirmation can vanish after under a second
  `src/workspace/BrowserView.tsx:623` — A save confirmation (or any later notice) can be wiped almost immediately by an earlier, unrelated notice's timer still running against the same state.
  _Fix:_ Hold the timeout id in a ref and clearTimeout it before every setNotice, plus clear it in an unmount effect — the shape toastStack already uses.

- **[P3·ux-defect]** The Clear confirmation survives closing and reopening the journal panel
  `src/workspace/BrowserView.tsx:1137` — Reopening the Journal can land the user directly on an armed 'Erase / Keep' prompt they did not arm in this visit, next to counts fetched during the earlier round trip.
  _Fix:_ Reset both in the journalOpen effect: `if (!journalOpen) { setConfirmClear(false); setClearScope(null); }` alongside the existing load.

- **[P3·ux-defect]** Engines that failed are named to the user with the sidecar's internal function names
  `src/workspace/BrowserSearch.tsx:428` — The results header can read 'duckduckgo_ia, google_news unavailable' while the footer and consensus dial on the same screen call those same engines 'ddg-ia' and 'news' — two names for one engine on one page. The empty-state copy (line 272) repeats the raw names.
  _Fix:_ Give each engine callable an explicit `source` attribute and build `failed` from that in websearch.py, so the failure list and the hits' `engines` list are drawn from one vocabulary. Add a sidecar test asserting every name in the failure list is a member of the source set the hits use.

- **[P3·ux-defect]** A failed privacy check latches the shield on "Checking" for that page for the rest of its life
  `src/workspace/BrowserView.tsx:406` — One transient failure of browser_verify_private leaves the shield chip reading 'Checking' with neutral ink for as long as that URL stays loaded — never resolving, never retried — even though the storage check would answer correctly on the next poll.
  _Fix:_ Release the claim when the answer did not come back: `const answer = await api.browserVerifyPrivate().catch(() => null); if (answer === null) verifiedForRef.current = null; setEphemeral(answer);`

- **[P3·honesty]** The skill autocomplete header states a count that is capped at 10
  `src/workspace/ComposerPane.tsx:302` — With more than 10 matching enabled skills the popover header says '10 enabled skills', which reads as the room's total rather than the list's length.
  _Fix:_ Compute the unsliced match count and render '10 of 25 enabled skills' (or drop the number when the list is truncated). Do the same for the files/folders menu, whose two slices make its count doubly unrepresentative.

- **[P3·ux-defect]** The file-header Run button promises to run an unapproved script, while the Scripts page relabels the same action "Review script"
  `src/workspace/ViewerPane.tsx:726` — Opening an unapproved .py/.js file shows a header button labelled "Run" whose tooltip promises execution; pressing it can only raise the consent card — the exact confusion the ScriptRow fix was written for.
  _Fix:_ Reuse the ScriptRow rule: label and title off `sc?.approved`, defaulting to "Review script" (and the review tooltip) when the script is unapproved or not yet in s.scripts.

- **[P3·correctness]** The frame-quote document cache never invalidates on content change, so quoting a saved page silently stops working after the file is edited
  `src/workspace/ViewerPane.tsx:438` — After a saved page is rewritten while it stays open (built-in editor, agent write, version restore), selecting a newly added sentence in the Page tab produces no Quote-in-chat button and no explanation, because the passage is checked against the pre-edit text. Conversely a sentence that was deleted from the file can still be quoted.
  _Fix:_ Key the cache on `{ id, text }` (or on viewerRev) and rebuild when either changes, exactly as useTextEncoding keys on `{ id, payload }`.

- **[P3·correctness]** The quote rule checks both ends of a selection for containment but only one end for exclusion
  `src/workspace/ViewerPane.tsx:355` — A drag that STARTS in the document and ENDS in the reader's own chrome is offered as a quote, so chapter titles from a book's contents list or the words "Page Text" from a reader's mode buttons land in the composer attributed to the document. Dragging the other way is correctly refused, so the rule's answer depends on drag direction.
  _Fix:_ Test both ends: `inExcludedSurface(sel.anchorNode) || inExcludedSurface(sel.focusNode)`, and add a unit test for the both-ends rule rather than only asserting the selector's contents.

- **[P3·correctness]** Trash footer's "Restore selected" counts ids the panel has already dropped, so it stays enabled and then fails
  `src/workspace/Sidebar.tsx:339` — After restoring or destroying a checked file from its own row, the footer still claims a selection ("Put 1 file back in the library", enabled) while the panel above shows none; pressing it produces an error toast naming a file that is no longer in the trash. With the trash emptied, the footer stays enabled over "Nothing deleted".
  _Fix:_ Prune `selectedTrashIds` against `s.trashed` whenever the trash list changes — the same effect shape BrowsePanel already uses for `selectedFileIds` — or derive the footer's count and ids from the same filtered `picked` list TrashPanel renders. (Note the pruning effect must live above TrashPanel's early return, or it re-creates the hook-order crash.)

- **[P3·ux-defect]** The unsaved-edits dialog claims aria-modal but does not trap focus
  `src/workspace/UnsavedEditsDialog.tsx:86` — Tab walks out of Save/Discard/Cancel into the live workspace behind the veil while the page is announced as modal; a keyboard or screen-reader user can act on covered chrome, and can even change which file the dialog claims to be about.
  _Fix:_ Extract the dialog body into a child component that is MOUNTED only while `pendingLeave !== null` and call `useFocusTrap(() => s.setPendingLeave(null))` there — a drop-in call in the current component would run its mount effect once at Workspace mount (the component is always rendered and returns null), so the ApproveCard line cannot simply be copied.

- **[P3·honesty]** The shortcuts sheet, which the app presents as the complete list, omits ⌘T
  `src/workspace/Overlays.tsx:303` — The one key that creates the current destination's item (new page / sketch / creation) is absent from the sheet the app calls complete, while its ⇧⌘T counterpart is listed — so a reader of the sheet concludes ⌘T does nothing, worst of all in the Browser where it is the primary verb.
  _Fix:_ Thread `area` into ShortcutsSheet and render a ⌘T row from `newItemLabel(area)` (that helper's doc already promises this consumer), or add a static row "New page / sketch / creation, depending on where you are".

- **[P3·honesty]** Home's front page lists and counts section-only objects the Library deliberately hides
  `src-tauri/src/commands/moonshot/front_page.rs:42` — A sketch or a generated creation that is section-only is absent from Home's Library list and badge but present in Home's front-page timeline, and is included in the front page's "N files" stamp — the stamp reads higher than the badge beside it.
  _Fix:_ Decide which question the front page answers and say it once. Simplest: add a db::list_library_files / db::library_file_count pair carrying `AND library_visibility <> 'sectionOnly'` and use them in front_page_of, so Home's two surfaces share one predicate; update the stale test at front_page.rs:150-186 that still asserts list_files' length is "the Library badge".

- **[P3·correctness]** The .doc HYPERLINK field resolver can delete prose between the keyword and the next quoted string
  `src-tauri/src/textutil.rs:112` — A legacy Word document that contains the literal uppercase word HYPERLINK in prose, followed later by any quoted string with only letters/whitespace in between, loses every word in between — in the extracted search text and in the rendered preview.
  _Fix:_ Bound the gap to what a real field instruction looks like: at most a few characters, and only whitespace plus backslash switches (\\l, \\o), e.g. `gap.len() <= 8 && gap.chars().all(|c| c.is_whitespace() || c == '\\' || c.is_ascii_alphabetic())`. Add the sentence above as a regression test alongside the existing comma case.

- **[P3·concurrency]** Podcast host preview can play two clips at once and leave the wrong Stop button lit
  `src/workspace/PodcastPanel.tsx:138` — Clicking Preview on host A and then host B before A's synthesis returns plays both clips simultaneously; Stop silences only the one `audioRef` happens to hold, and the surviving clip's `onended` clears the Stop state for the wrong host.
  _Fix:_ Take a monotonic token in a ref before the await and bail (`if (token !== tokenRef.current) return;`) before assigning `audioRef.current`, calling `play()` or setting `previewing` — the same epoch discipline voice.ts already uses. Disabling the other Preview buttons while one is in flight would also do.

- **[P3·perf]** Podcast preview leaks a blob object URL on every click
  `src/workspace/PodcastPanel.tsx:148` — Every Preview click retains a WAV blob that is never released, so auditioning voices accumulates buffers for as long as the window lives.
  _Fix:_ Keep the URL beside the element and revoke it in `el.onended`, in the catch, and in `stopPreview()` before nulling the ref.

- **[P3·honesty]** Memories are truncated at 60 with no disclosure, while files get a careful one
  `src-tauri/src/commands/moonshot/graph.rs:450` — A room with more than 60 memories draws exactly 60 memory stars with no disclosure, and no room discloses memories in the header at all, even though memory→file links are included in the link total the header prints beside the file count.
  _Fix:_ Return the true memory total (or a `memoriesTruncated` flag) from build_room_graph, count memory nodes in the header beside the file count, and extend the atFileLimit caveat wording to cover them.

- **[P3·correctness]** Rendered slides are cached forever per file id and never invalidated when the file's bytes change
  `src-tauri/src/commands/office.rs:186` — After a .pptx's bytes are replaced in-session, the viewer keeps showing the previous deck's rendered slides, and the page count (recomputed from the new bytes) can disagree with the images on screen.
  _Fix:_ Include a content hash (or the row's updated_at) in the cache key, or drop every `"{id}:*"` entry inside `store_file_bytes` / on the `file-updated` path. Clear `images` in SlidesView when `bytes` changes so the frontend copy cannot outlive it either.

- **[P3·perf]** `model_capabilities` and `grounding_pick` make one uncached sidecar round trip per installed model, sequentially
  `src-tauri/src/commands/models.rs:252` — Opening an image or the Settings model list makes one uncached sidecar round trip per installed Ollama model, in series, every time.
  _Fix:_ Add a process-lifetime map keyed by `(resolved_base_url, model)` inside `ollama::capabilities`, evicted by `pull_model` and `delete_model` (capabilities change only on pull/delete). Once cached, the `grounding_pick` loop can also be flattened with `join_all`.

- **[P3·correctness]** A room summary whose file is trashed mid-run is written into the trashed row and then reported as an error
  `src-tauri/src/commands/summarize.rs:244` — If 'Room summary.html' is trashed while the summarize reduce is running, the finished summary is written into the trashed row and the command then fails on the trash-filtered metadata read — the user sees an error while an invisible file was updated.
  _Fix:_ Re-validate `existing_id` after the await with a trash-aware read (`db::get_file_name`, as `restore_version_into` does); on a miss, fall through to the `insert_file` branch so a fresh summary is created instead of resurrecting a trashed one.

- **[P3·dead-code]** `engine_capabilities` is registered and wrapped in api.ts but has no consumer
  `src-tauri/src/commands/capabilities.rs:611` — A command, its Tauri registration, an api.ts wrapper and a QA fixture are all maintained for an endpoint nothing calls; every real preflight goes through `enginePreflight` or `engineSupportMatrix`.
  _Fix:_ Delete `engine_capabilities`, its lib.rs:278 registration, the api.ts wrapper and the qa-mock fixture — or wire it into the surface it was written for. Separately decide `imageReaches`: `from_decl` computes it as `decl.local && ollama_runs_here()` (capabilities.rs:369), which is meaningless for a provider row, so if nothing reads it on `ProviderRow` it should not be serialised there.

- **[P3·honesty]** `agents_known` reports "the sidecar did not answer" when the sidecar answered with an empty or undecodable agent list
  `src-tauri/src/commands/capabilities.rs:704` — When `/agent_support` answers 200 with an `agents` field that fails to deserialise (or is legitimately empty), the matrix says the agent half could not be reached and offers no reason — a host/sidecar shape bug is presented as a network problem.
  _Fix:_ Set `agents_known` from the `Ok(_)` arm of the match, and decode with `serde_json::from_value(...).map_err(...)` so a decode failure becomes an `agents_error` string ('the AI engine answered in a shape this version does not understand') instead of an empty vec.

- **[P3·honesty]** `api.engineCapabilities` — the declared single source of truth for engine locality — has no caller
  `src/api.ts:879` — The wrapper the file names as the one place to ask about engine locality is called by nothing; the trust chip answers the engine half of that question from a hardcoded id list in another language, and api.ts/apiTypes.ts assert a contract nothing honours.
  _Fix:_ Either have `trustState`'s caller fetch `api.engineCapabilities().local` once per room open and feed the chip from it, or delete the wrapper and correct the comments at api.ts:877 and apiTypes.ts:1176 so they stop claiming a contract nothing uses.

- **[P3·dead-code]** `FileMeta.originUrl` is serialized on every file list but is absent from the TS interface and read by nothing
  `src-tauri/src/commands.rs:613` — Every `list_files` response carries the page a file came from, but the TS FileMeta does not declare it, so no component can read it without a cast and none does — the provenance the field exists to surface stays buried in the Markdown body.
  _Fix:_ Add `originUrl: string | null` to apiTypes.ts's FileMeta and render it on the Library row / file header. If provenance is not wanted in the UI, remove it from the FileMeta serialization only — keep the column and the `db::file_origin_url` reads, which graph.rs and safety.rs depend on.

- **[P3·correctness]** `EngineCapabilities` omits the two generation capabilities the host sends, and the `Capability` union omits two values the host accepts
  `src/apiTypes.ts:1178` — The TS EngineCapabilities and the `Capability` union stop at the five older questions, so no component can type-safely read `caps.imageGeneration` or preflight "can this room draw?", though both ride the wire and both have real answers.
  _Fix:_ Add `imageGeneration: Support; videoGeneration: Support;` to apiTypes.ts:1178's interface and `"image_generation" | "video_generation"` to the union at :1168. Both mirror closed Rust enums, so an enum-diff assertion in the page-script suite would keep them in step mechanically.

- **[P3·correctness]** The waveform cache is never invalidated when a file's audio changes, so a resumed recording draws its old shape and old duration
  `src-tauri/src/commands/peaks.rs:124` — `PeakCache` is keyed by `{file id}:{buckets}` and is only ever emptied when the room closes. Any path that rewrites a file's bytes in place — resuming a recording (the engine's `finalize_rec_audio` → `update_file_content`) or restoring a saved version — leaves the stale envelope in the cache. The viewer then draws the pre-change waveform AND uses its stale `duration` as the denominator for every overlay: highlight bands, chapter ticks and the seek mapping are all positioned as a percentage of a length the audio no longer has, so marks point at the wrong moments.
  _Fix:_ Evict the cache entry whenever a file's bytes change: give `PeakCache` a `forget(file_id)` that drops every `{id}:*` key and call it from `finalize_rec_audio`'s caller (the engine's full flush), from `restore_version_into`, and from `update_file_content`'s command wrapper — or key the cache on a content fingerprint (e.g. the file's updated_at/byte length) so a stale entry can never be served.

- **[P3·correctness]** Overlapping podcast previews play on top of each other, and the first becomes unstoppable
  `src/workspace/PodcastPanel.tsx:139` — `preview()` awaits `api.previewPodcastVoice` (a cloud TTS round trip, easily a second or more) and then unconditionally assigns `audioRef.current = el` and plays. A second Preview click during that window calls `stopPreview()` — which can only pause an element that does not exist yet — and starts its own request. Both responses then create and play their own `Audio`, so two voices speak at once, and whichever assigns `audioRef.current` first is orphaned: `stopPreview` can never pause it, and its `onended` clears `previewing` for the host that is still speaking. The panel's unmount cleanup has the same hole: `alive` is captured in the effect (line 81-84) but `preview` never consults it, so a preview that resolves after the Studio tab swaps starts playing into a panel that is gone.
  _Fix:_ Take a monotonic token (or reuse the effect's `alive`) at the top of `preview`, and after the await drop the result unless the token is still current — stopping/revoking the blob in the stale branch.

- **[P3·correctness]** Audio batches are pushed without chaining, so the mic timeline can be re-ordered at the TS↔Rust seam
  `src/workspace/liveRec.ts:130` — `makeSink.send()` assigns `inflight = push(rate, b64).catch(() => {})` but never waits on the previous one before firing the next, and `rec_push_audio` is an `async` Tauri command (recording_cmds.rs:279) — each invocation is spawned as its own task on the async runtime. The engine appends each batch at `lane.ingested` in ARRIVAL order (recording.rs:1806-1821), so if a batch's task is delayed past the next one, 250 ms of the recording is written in the wrong place: the mixed WAV and the phrase boundaries fed to the decoder are both scrambled at that point, with nothing to detect or report it. Latent rather than routinely hit — reordering needs a task to be starved for a full quarter second — but the fix is one line and the failure is silent and permanent.
  _Fix:_ Serialize the lane: `inflight = inflight.then(() => push(rate, b64)).catch(() => {});` so batch N+1 is only invoked after N's invoke has resolved. It costs nothing at 4 pushes/second and makes ordering a property of the sink instead of the scheduler.

- **[P3·correctness]** Pausing silently forgets that the microphone was muted, contradicting liveRec's own contract
  `src/workspace/liveRec.ts:351` — `stopMicTap()` ends with `muted = false`, and `pauseLiveRecording` calls `stopMicTap()` (recordingActions.ts:419). So a mute the user set to keep a private aside out of the recording is cleared by any pause, and `attachMicTap`'s `t.enabled = !muted` (line 222-224) re-opens the microphone on resume. This directly contradicts the module's documented contract at liveRec.ts:47-51 ('the choice must survive the view unmounting, and a mic re-acquired on resume inherits it'). RecordingView re-reads `micMuted()` on every status change (RecordingView.tsx:786-790), so the button does not lie — but the behaviour the doc promises is not implemented, and 'pause' is not a reason a user would expect their mute to be dropped.
  _Fix:_ Decide which contract is true and make one of them so. Either scope `muted` to the SESSION (reset it in `startLiveRecording`, not in `stopMicTap`) so a pause preserves it as the doc says, or drop the doc's claim and have the pause banner say the mute was cleared.

- **[P3·honesty]** The reading view asserts "Encrypted connection" for anything that is not literally http://
  `src/workspace/BrowserReader.tsx:166` — The reader header prints a green 'Encrypted connection' tape for any URL that does not start with the exact string 'http://', including an empty or unparseable one — a two-valued rendering of a three-valued fact, inconsistent with the chrome six inches above it.
  _Fix:_ Reuse the chrome's classification rather than re-deriving it — export schemeOf from BrowserView (or a shared module) and render no tape at all when the protocol is neither https: nor http:, exactly as line 825 does.

- **[P3·correctness]** A page navigation mid-read makes "Read the next part" splice the previous page's text onto the new page
  `src/workspace/BrowserReader.tsx:129` — The reading view can present two different documents concatenated as one continuous page, with no visible seam and no warning — the exact tiling the module's own comment (lines 116-122) says it refuses to do.
  _Fix:_ Stamp each extraction with the URL it was started against and drop answers that no longer match — capture `const forUrl = info.url` at the top of both `load` and `more`, and in the setter return `p` unchanged when `p.url !== forUrl`. A monotonic request id in a ref works equally well and also fixes two racing `load`s resolving out of order.

- **[P3·honesty]** A failed result-open offers to search the web for text the user typed into a different, earlier failure
  `src/workspace/BrowserView.tsx:596` — The error banner can show a new error above a recovery button naming an unrelated string the user typed minutes ago — 'Search the web for “intranet.corp” instead' beside 'Blocked https://example.org/…'. Pressing it broadcasts that earlier internal hostname to seven engines, which is precisely the leak the failedInput mechanism exists to make deliberate.
  _Fix:_ Clear the pair together everywhere it is set: add `setFailedInput(null)` beside the existing `setError(null)` in openResult (590) and openResultInNewTab (617). Better still, hold them as one piece of state (`{message, retryQuery}`) so it is impossible to update one without the other.

- **[P3·correctness]** Frame-quote verification compares the frame's re-decoded text against the ORIGINAL decode, so an encoding override silently kills the quote button
  `src/workspace/ViewerPane.tsx:441` — HtmlView renders the text the encoding picker produced, but the passage a frame reports is verified against the payload get_file_content decoded automatically. Once the user overrules the detected encoding on a saved page, every selection containing a non-ASCII character fails containment and the Quote-in-chat button silently never appears — the same silent-drop failure mode as the stale-cache finding, from a different cause, and it does not heal.
  _Fix:_ Build the searchable document from the same text the viewer is showing — pass ViewerRouter's `c.text` (or `enc.text ?? content.text`) into the cache, and key the cache on that string so a re-decode rebuilds it.

- **[P3·correctness]** ViewerChunkBoundary latches too, so one failed lazy import poisons every later viewer
  `src/workspace/ViewerRouter.tsx:26` — After a single rejected viewer chunk (the documented case: the updater replaced the bundle while the old process is running), every subsequent file the reader opens — including kinds whose chunk is fine and already cached — renders "This viewer couldn't load" instead of the document, until the inline Retry is pressed.
  _Fix:_ Reset on a changing key — take `openFile.id`/`content.kind` as a prop and clear `failed` in `componentDidUpdate` when it changes (or put `key={openFile.id}` on the boundary), so the retry is automatic for the next document.

- **[P3·concurrency]** Only the first queued approval card is rendered, so a second card can expire unseen and be reported as a decline
  `src/workspace/Overlays.tsx:433` — With two pending edit approvals (a chat turn plus a job, or parallel tool calls) the second is invisible while the first is unanswered; its 180 s timer keeps running and it is auto-declined without ever being shown.
  _Fix:_ Render the queue as a stack (or show a count plus a next affordance) and start the backend timer only once a card is actually displayed; at minimum have the Activity row say 'waiting behind another card'.

- **[P3·honesty]** move_files_to_folder's BulkReport claims "ok" for ids that changed nothing, breaking the module's own stated invariant
  `src-tauri/src/commands/bulk.rs:185` — A batch move reports every id it was given as moved — including ids of files that no longer exist — and names them by raw uuid in the receipt ("\"3f2a…\" moved."). It also fires room-files-changed for a batch in which nothing changed, which emit_if_changed exists specifically to prevent.
  _Fix:_ Make db::move_file_to_folder use execute_existing with `AND trashed_at IS NULL` and the message "That file is no longer in this room." (this is the same fix finding 6 needs, and it repairs both the single-file and the batch paths at one site). Add a bulk test in the shape of destroy_refuses_a_file_that_is_not_in_the_trash asserting that moving an unknown id lands in `failed`, not `ok`.

- **[P3·ux-defect]** A memory hit in ⌘K opens the Memory page but never points at the memory
  `src/workspace/miscActions.ts:283` — Clicking a memory result from the search overlay drops the user on an unfiltered, unscrolled Memory page and leaves them to find the row by eye — while file hits jump to the passage and message hits scroll and mark the message.
  _Fix:_ Give revealMemory the id (and optionally the query): seed MemoryView's filter with the query and scroll/flash the row, mirroring revealMessage's poll-until-rendered pattern.

- **[P3·honesty]** The search overlay presents per-query caps as if they were result totals
  `src/workspace/SearchExpanded.tsx:707` — Each group in ⌘K prints a bare count next to its heading, but every count is a hard query limit, not the number of matches in the room — so "Files 12" can mean "12 of 300" and there is no way to reach the rest.
  _Fix:_ Have search_all return a per-group `total` (or a `truncated` flag) alongside the rows and render "30 of 118" / "first 30" in the group head, the same way the partially-indexed note is rendered.

- **[P3·ux-defect]** Quitting from full screen saves the full-screen rectangle, so the next launch opens a whole-display window
  `src-tauri/src/commands/window_geometry.rs:86` — Enter full screen, quit, relaunch: the window opens at the display's full size in the corner instead of the size it had before full screen. The pre-fullscreen geometry is overwritten and lost.
  _Fix:_ Skip `note_geometry` while `window.is_fullscreen()` (or `is_maximized()`) is true, so the last NORMAL-state rectangle is the one written on the way out.

- **[P3·security]** Downloaded `uv`/`node` runtimes are extracted and put first on the connector PATH with no checksum or signature check
  `src-tauri/src/commands/runtimes.rs:313` — `mcp_provision_runtime` fetches a tarball over HTTPS, unpacks it into the app data dir and publishes its bin dir as the FIRST entry on the PATH every stdio MCP connector child inherits. Nothing verifies what was downloaded. Anyone who can terminate that TLS session (a corporate MITM root, a poisoned mirror/CDN entry, a compromised release asset) gets arbitrary code execution as the user the next time a connector launches, in an app whose entire premise is that nothing untrusted runs against the room.
  _Fix:_ Download the matching `.sha256`/SHASUMS256.txt for the pinned asset, compute SHA-256 over the streamed bytes, and refuse to extract on mismatch (delete the temp file and report it). For Node, pin the version's digest in the source next to `NODE_VERSION` so the check does not depend on a second fetch.

- **[P3·perf]** The slide cache clears all 60 entries at the ceiling instead of evicting the oldest, contradicting its own doc
  `src-tauri/src/commands/office.rs:188` — On reaching MAX_CACHED_SLIDES the whole map is emptied, so a reader paging through a deck longer than 60 slides pays a fresh several-hundred-millisecond Quick Look render for EVERY slide from then on, including ones they just looked at, and the prefetch of the next slide (SlidesView.tsx:113) re-renders too. The comment above the constant promises the opposite.
  _Fix:_ Either store an insertion counter alongside each PNG (or use an ordered structure) and evict the single oldest entry, or correct the comment to state that the cache is dropped wholesale at the ceiling. Prefer the eviction: the constant's whole justification is that paging back and forth must not pay the render twice.

- **[P3·honesty]** `feedback_draft` turns a shape drift from the sidecar into a silently empty draft
  `src-tauri/src/commands/feedback.rs:68` — A 200 response whose `title`/`body` are missing, renamed or non-string yields empty strings rather than an error. The modal writes them straight into its two fields, so the user presses 'Draft it for me', the button finishes with no error, and the title and body boxes are simply blank — with the Open-issue button disabled and nothing saying why. A host/sidecar contract break reads as 'the AI had nothing to say'.
  _Fix:_ Require the fields: return an error when either is absent or not a string (`v["title"].as_str().ok_or("The draft came back in a shape this version does not understand.")?`), so the modal's existing catch surfaces a real message and the user's typed text in the raw box is visibly still the thing to fall back on.

- **[P3·honesty]** Both cast readers truncate at 40 people without telling anyone, and the review sheet reports the truncated number as the file's contents
  `src-tauri/src/commands/castparse.rs:197` — When a character sheet describes more than 40 people, the pattern reader returns early at the 40th and the model reader's merge drops everything past the 40th — in both cases with no marker on the result. The review sheet then says '40 found in <file>', which the reader will take as the file's full cast; the missing people are invisible and unnamed. This is the honesty rule the OCR page-cap note and the summarize 'only the first N files were summarized' note both already follow, applied nowhere here.
  _Fix:_ Have both readers report the truncation: add a `capped: Option<usize>` (or reuse the existing `fell_back` note) to `CastFromFile`, set it when `parse_cast` hits MAX_FOUND and when the sidecar's `merge_cast` drops anyone, and render it in the review sheet as 'this file describes more people than one import can hold — the first 40 are shown'.

- **[P3·test-gap]** No test anywhere checks that api.ts command names, argument names and payload shapes match the Rust handlers
  `src/api.ts:157` — Argument names and payload shapes at the invoke seam have no automated check; a renamed Rust parameter type-checks, builds and passes every suite, failing only as a runtime argument-deserialization error in the user's hands. (Command names themselves are already gated.)
  _Fix:_ Add the arg-level assertion beside the two existing gates: parse api.ts for `invoke("name", { keys })`, parse each command's signature (skipping `State`/`Window`/`AppHandle` params), and assert camelCase key-for-parameter agreement. ~60 lines; it currently reports zero offenders, so it lands green and stays a drift alarm. Six wrappers pass an opaque object (`opts`/`w`) straight through — start_create_job, story_set_shape, story_update_shot, story_apply_split, save_workflow, update_workflow — so have it check those against the declared TS option type instead.

- **[P3·error-handling]** The memory delete is the one memory mutation that drops the host's error on the floor
  `src/workspace/MemoryView.tsx:443` — `onConfirm` calls `api.deleteMemory(m.id)` inline with no try/catch. `db::delete_memory` deliberately returns `Err("That memory is not in this room.")` rather than a silent no-op (db/memories.rs:66-72 states the reason: a caller offering delete on a stale list must be told), and this caller discards it — the rejection is unhandled, no toast appears, `setMemories(await api.listMemories())` never runs, and the row simply stays put with no explanation.
  _Fix:_ Route it through the same helper as the others — move the delete into a `forgetMemory(id)` verb in miscActions.ts wrapped in `tryToast`, and have MemoryView call `() => void a.forgetMemory(m.id)`. Separately, type DeleteControl's prop as `() => void | Promise<void>` and `void onConfirm()` at the call site, so a rejecting handler is at least visible to the linter.

- **[P3·test-gap]** Nothing reports a registered command with no caller — the direction that has six live instances
  `qa/check-mock-coverage.mjs:131` — The seam has two drift gates and neither can see a command that is registered and invoked by nobody. commandregistry.test.mjs compares DEFINED against REGISTERED; check-mock-coverage.mjs fails only on frontend-invokes-what-Rust-lacks and mock-fakes-what-Rust-lacks. The reverse — registered, wrapped or not, called by nothing — is computed nowhere, which is why the six orphans in this audit (the five in finding 8 plus `restore_memory`) accumulated silently, and why a wrapper whose UI was never built reads exactly like a wrapper whose UI was deleted.
  _Fix:_ Add the third set to check-mock-coverage.mjs beside the two it already computes: registered names that are neither invoked from src/ nor named in agent.rs / room_mcp.rs, reported against a written allow-list carrying a reason per entry (the shape commandregistry.test.mjs already uses with KNOWN_UNREGISTERED). Seed the allow-list with the four agent-only commands so it lands green, and the six orphans show up as the report they should have been.


### Viewers (62)


- **[P2·ux-defect]** A read that fails or is parked leaves the tabs claiming "Reading this recording…" forever
  `src/viewers/RecordingView.tsx:592` — When a read ends in error or paused (Ollama down, MODEL_MISSING, Stop, the transcript-changed refusal), the Notes/Highlights/Chapters tabs keep showing "Reading this recording… / this can take a minute" and the read button stays disabled until the file is closed and reopened — and nothing anywhere tells the user the read failed.
  _Fix:_ Give the read a terminal event on every outcome: emit the standard `job-progress` with `finished`/`paused`/`failed` from the runner epilogue (which also restores the global failure toast), plus `rec-read-done` with `{fileId, ok, error}`; clear `reading` on it and toast the error. Separately, seed `reading` on mount from `list_jobs` (a rec_read row for this file in 'queued'/'running') so an auto-started or already-running read is reflected instead of being invisible.

- **[P2·data-loss]** Clearing a subtitle line deletes the cue and its timing on save
  `src/viewers/subtitles.ts:76` — Emptying a cue's textarea and pressing Save writes a file in which that cue no longer exists: its timecode is gone from disk, the on-screen list drops to N-1 cues, and every later cue is renumbered by `toSrt`'s `i + 1`.
  _Fix:_ Make the round trip total: have `parseCues` keep a timed block with no body (`text: ""`) instead of `continue`, or refuse to save a blank cue with a message naming it. Add the empty-cue round trip to e2e/page-script/viewerparse.test.mjs — the existing 'editing a cue's text and re-serializing changes nothing else' case only exercises non-empty text.

- **[P2·ux-defect]** Transcribe button in the audio viewer is a silent no-op when no speech model is installed
  `src/viewers/AudioView.tsx:126` — With no Whisper model installed, pressing Transcribe disables the button for exactly 6 s and then reverts to 'No transcript yet', with no mention of the missing model — even though the backend named the reason and the app is holding it in `sttStage`.
  _Fix:_ Branch on `sttStage` next to `sttWhy`: `model-missing` → say the speech model is missing and offer Settings (reuse the copy at recordingActions.ts:408-411 / ATTENTION_COPY['model-missing']); `none` → say the file was read all the way through and held no speech, matching ATTENTION_COPY['no-speech'].

- **[P2·data-loss]** Quitting the app within the 1.4 s autosave window loses the last strokes, and nothing asks
  `src/viewers/SketchView.tsx:337` — Draw a stroke, then ⌘Q or click the window's close button. No prompt appears, the window goes away, and the last stroke is missing when the room is reopened — while the footer was still saying “Saving…”.
  _Fix:_ Have SketchView publish its own pending state — either drive `api.setUnsavedEdits(true)` while `dirty.current` is set, or register a sketch-specific flush the close/quit handlers await before `win.destroy()`/`exit(0)`. Note `api.saveSketch` is async IPC, so the door must await it, not fire it.

- **[P2·correctness]** The eraser deletes locked elements, and a locked element selected from the object strip can still be nudged and resized
  `src/viewers/SketchView.tsx:527` — “Lock in place” does not hold anything against the eraser or the keyboard: one eraser swipe removes a locked background shape, and a locked shape selected from the object strip can be nudged, recoloured, and resized by a grip that is not drawn.
  _Fix:_ Give `hitTest` an `includeLocked = false` parameter (the arrow-attachment and connector paths that legitimately want locked shapes pass true), skip locked ids in `eraseAt`, in `nudge`, in the ink recolour, and in the `els` captured for a resize, and make the strip's chip refuse to select a locked element the way the canvas does.

- **[P2·ux-defect]** The note text field is positioned as a percentage of the document, so it lands away from the click whenever the canvas is zoomed, panned or letterboxed
  `src/viewers/SketchView.tsx:1766` — With the Note tool, the text field appears somewhere other than where you clicked — badly wrong once the page is zoomed or panned, and slightly wrong even at 100% — while the note itself is created at the click point.
  _Fix:_ Map the canvas point back to client space with `svgRef.current.getScreenCTM()` and position the input in pixels relative to the stage's `getBoundingClientRect()`, rather than by percentage of `doc.width`/`doc.height`.

- **[P2·correctness]** Every keystroke in the Label field pushes a whole-document undo snapshot
  `src/viewers/SketchView.tsx:1013` — Renaming a shape costs one undo entry per character: the toolbar's Undo removes a single letter at a time, and a long label pushes real drawing edits out of the 80-deep history.
  _Fix:_ Commit label edits with `{ undoable: false }` while typing and push a single history entry on blur/Enter — or coalesce in `pushHistory` when the previous entry differs from the current document only in the same element's label/text.

- **[P2·correctness]** A line's label is drawn at the canvas origin, omitted from the SVG export and dropped when the agent reads the drawing
  `src/viewers/SketchView.tsx:1983` — A labelled line puts its text in the top-left corner of the page, the label disappears from Export as SVG/PNG, and `read_drawing` shows the model a line with no label — so the model relabels or deletes it.
  _Fix:_ Render a line's label at its midpoint in both renderers (reuse the arrow arm's midpoint in `Drawn` and call `write_label` from `to_svg`'s Line arm), and emit `{label}` in `to_script`'s Line arm. A `to_script` → `apply_script` round-trip property test over a labelled line would have caught all three.

- **[P2·efficiency]** ArchiveView decompresses the entire zip into memory just to list its names
  `src/viewers/ArchiveView.tsx:112` — Opening a .zip inflates every entry into renderer memory before a row is drawn; peak allocation equals the archive's total unpacked size, so a multi-GB backup or a nested-deflate bomb hangs or kills the webview while the pane still reads "Reading archive…".
  _Fix:_ Pass `{ filter: (f) => { entries.push({ path: f.name, size: f.originalSize }); return false; } }` (or collect in the filter and ignore the callback's `files`), so names and sizes come off UnzipFileInfo and no entry is ever inflated.

- **[P2·correctness]** EPUB hrefs are never percent-decoded, so chapters with spaces or non-ASCII names drop out of the spine
  `src/viewers/epub.ts:123` — A book whose OPF percent-encodes its hrefs (required for any filename containing a space or non-ASCII character) loses its reading order and its chapter titles, and its inline images render with no src — all silently. The Rust extractor loses the spine for the same book, so search order degrades too.
  _Fix:_ Decode percent-escapes once at the boundary — in withoutFragment or findEntry, try decodeURIComponent and fall back to the raw string on a malformed escape — and mirror it in epub_spine_order on the Rust side and in readRels for OOXML picture targets.

- **[P2·honesty]** A password-protected PDF is reported as "incomplete or damaged"
  `src/viewers/PdfView.tsx:862` — An encrypted PDF — which the app cannot open and never asks a password for — is presented to the reader as a corrupt file, with three remedies that cannot work.
  _Fix:_ Keep the rejection value and branch on `e?.name === 'PasswordException'` (pdf.js also exposes PasswordResponses): either wire `task.onPassword` to a prompt, or state plainly that the file is password-protected and this app cannot open it. Do not assert damage the code has no evidence for.

- **[P2·ux-defect]** Zooming a PDF permanently erases the citation highlight and its "Verified" receipt
  `src/viewers/PdfView.tsx:491` — After the assistant lands the reader on a quoted passage, one press of zoom in/out (or ⌘+/⌘-) wipes the yellow highlight and the green receipt badge for good; an active ⌘F hit's boxes vanish the same way while the find bar keeps counting them.
  _Fix:_ Do not null highlightRef/findHlRef in buildPages — they describe the target, not the DOM. After the restoring scrollIntoView, re-run applyTarget (or at minimum re-paint the remembered target and find hit on the restored page) instead of returning early.

- **[P2·honesty]** A legacy .ppt shows "This presentation could not be read" while (and if) macOS is drawing it
  `src/viewers/SlidesView.tsx:148` — Every .ppt states the presentation is unreadable for the whole duration of the Quick Look render, and states it permanently on any Mac where that render fails or times out — hiding the accurate message written for exactly that case.
  _Fix:_ A zip-parse failure is a verdict on the OUTLINE, not on the file — the picture comes from macOS and does not depend on it. Drop parseError from the render gate (keep it as a note beside the outline/notes controls) and let the renderError / "Reading slides…" branches own the empty state.

- **[P2·correctness]** Speaker notes are attached to the wrong slide in extracted .pptx text
  `src-tauri/src/extraction/pptx.rs:35` — In a deck where only some slides carry notes, the extracted text that search and the model read labels one slide's narration as another slide's, and the real owner's notes are missing entirely.
  _Fix:_ Resolve the notes part through `ppt/slides/_rels/slideN.xml.rels` (the relationship whose target contains notesSlide), as the TypeScript parser does, and fall back to the numeric guess only when the rels part is unreadable. Label with the same slide number the part was resolved from.

- **[P2·correctness]** smart_filter silently deletes repeated table/ledger rows before the model reads a file
  `src-tauri/src/extraction/window.rs:29` — Any two consecutive identical lines are collapsed to one in the text handed to summarization and the full-file pass, so a spreadsheet, ledger or log with repeated rows is read as having fewer rows than it has, with nothing recording that anything was removed.
  _Fix:_ Bound the rule to what its own comment says it is for: drop a duplicate only when it repeats across a page/section boundary, or only after more than two consecutive repeats, and append a note when lines were removed so nothing downstream reads a shortened table as the whole table.

- **[P2·ux-defect]** Citations into a legacy .doc/.rtf never anchor — the quote is dropped on the success path
  `src/viewers/OfficeDocView.tsx:137` — When the assistant cites a passage in a .doc or .rtf and macOS imports it successfully, neither the page frame nor the Text tab highlights or scrolls to the quote; the reader is left on page 1 of an opaque frame to find it by eye.
  _Fix:_ Run applyQuoteHighlight over the Text pane's <pre> (as DocxView does) when a quote is supplied, and default `mode` to "text" when `quote` is non-empty, since the sandboxed frame cannot be annotated at all.

- **[P2·correctness]** .ods spreadsheets get a live editable grid whose every write the backend refuses
  `src/viewers/registry.tsx:186` — An OpenDocument spreadsheet is offered Edit. Changing a cell paints the new value, raises "1 cell changed" with an Undo button, and the panel claims the cell is "already saved into the file" — while a red toast simultaneously says cell editing only works on .xlsx and .csv. Reopening the file shows the original value.
  _Fix:_ Widen the read-only guard to every format `set_cell_in_bytes` cannot write — `/\.(xls|ods)$/i` — and give .ods its own `readOnlyReason` sentence the way .xls has one (registry.tsx:192-196). Independently, make SheetView await `onEditCell` and roll the cell back (and skip `recordEdit`) when the write rejects, so the counter can never assert an unwritten save.

- **[P2·correctness]** A legacy-encoded CSV is offered the editable grid, but the CSV writer refuses anything that is not strict UTF-8
  `src/viewers/registry.tsx:202` — A CSV stored in windows-1255/1252 opens correctly decoded (the encoding row even names the charset), Edit opens the grid, and every cell commit fails with '"x.csv" is not saved as UTF-8 text… Re-save it as UTF-8 first' — advice the app cannot act on, since a csv gets no text editor and no re-save-as-UTF-8. The grid keeps showing the change that was refused. Same for a lossy decode, where the encoding alert has just promised that editing is off.
  _Fix:_ Gate the csv grid on the decode really being UTF-8 rather than merely non-lossy — drive it from `enc.decoded.source` (`utf8`/`bom`) and at minimum honour `c.editable` like every other raw-text row — and pass SheetView a `readOnlyReason` naming the encoding, the shape .xls already uses.

- **[P2·security]** The frame-quote verifier accepts text that is in the file's markup but not on the page, so a saved page can put words of its choosing into the composer under its own name
  `src/viewers/htmlText.ts:13` — A hostile or merely careless .html file in the room can make "Quote in chat" appear unprompted, at coordinates it chooses, carrying up to 1200 characters of text that exists only in hidden markup. Clicking it appends those words to the composer stamped with the file's name, as though the reader had selected them.
  _Fix:_ Verify against what is VISIBLE: while walking the inert DOMParser document, drop subtrees carrying `hidden`, `display:none`, `visibility:hidden` or zero geometry. And require a gesture — have the reporter stamp a monotonically increasing selectionchange sequence the host has not already consumed (and/or ignore reports whose rect the host cannot corroborate), so a page cannot raise the button with no selection at all.

- **[P2·ux-defect]** Mermaid diagrams follow the Mac's appearance instead of the app's theme, and never re-theme
  `src/viewers/Mermaid.tsx:20` — Diagrams are drawn in whichever palette the Mac was in when the first ```mermaid fence of the session rendered, and never re-drawn. Toggle the app between light and dark and the diagrams keep the old palette; pin the app opposite to macOS and they are wrong from the start — dark node fills and pale label text on ivory paper.
  _Fix:_ Read `frameIsDark()` from frameTheme.ts instead of the media query, re-initialize + re-render when `data-theme` changes (a MutationObserver as in `useFrameTheme`/`watchMonacoTheme`), and add the resolved theme to the render effect's dependency array.

- **[P2·honesty]** Editing a Word document whose text exceeds 1 MB fails with a message that blames the user for a line they did not touch
  `src/viewers/registry.tsx:162` — Opening a long .docx, changing one word and pressing "Save into the Word file" is refused with "…the document has N and the edited text has M. Undo the added or deleted line…" — the user added and deleted nothing; the editor was handed a 1 MB-clipped copy ending in "… (truncated preview)".
  _Fix:_ Have get_file_content report whether the payload was clipped, and either refuse `"docx"` edit mode for a clipped document (falling back to `"copy"` with a banner saying why) or have update_docx_text detect the "… (truncated preview)" tail and answer "this document is too long to edit in place here" instead of a paragraph-count accusation.

- **[P2·correctness]** A file with no extension imports as an unreadable binary with no searchable text
  `src-tauri/src/extraction.rs:355` — Importing a plain UTF-8 file whose name carries no extension (README, LICENSE, Makefile, Dockerfile, .env, .gitignore) stores extracted_text NULL: no chunks are written, so it is absent from keyword search and from RAG, invisible to the assistant, and the viewer draws the "binary" card instead of its text.
  _Fix:_ Give extract_text a bytes-based last resort when the extension is empty or unknown: run extraction::decode_text_detail (the same decoder the encoding strip uses) and, if the decode is non-lossy and the bytes carry no NUL, return Some(text). Mirror it in classify_file so the same file reaches CODE/prose instead of PLAIN, and add a regression test importing a file literally named "README".

- **[P2·ux-defect]** Dragging on any edge or star silently fails to pan — the backdrop never receives the pointerdown
  `src/viewers/roomMap/usePanZoom.ts:78` — A click-drag that begins within ~3.5px of a link line or ~11px of a star does not pan the map; the press is swallowed by the invisible hit target and the pan handlers on the backdrop rect never fire, even though the SVG's :active rule swaps the cursor to `grabbing`.
  _Fix:_ Move onPointerDown/Move/Up from the backdrop rect onto the <svg> itself so the gesture works wherever it starts, and keep an `e.target === backdrop` test only for the deselect decision in onBgUp. (Alternatively put pointer-events="none" on the hit shapes, but that kills the 'why linked' tooltip and the click target.)

- **[P2·ux-defect]** Zoom and Reset controls sit behind ~120 tab stops, and focusing a node never brings it into view
  `src/viewers/roomMap/NodeStar.tsx:83` — Keyboard focus walks every node group before it can reach Zoom in / Zoom out / Reset, and focusing a node neither scrolls it into view nor labels it, so a keyboard user who zooms in tabs through invisible stars with no on-screen indicator.
  _Fix:_ Give the node layer a single roving-tabindex stop with arrow-key movement; adjust `view` in onFocus so the focused node is brought on-canvas; and put .rm-controls before the <svg> in DOM order (they are absolutely positioned, so nothing moves visually). Separately, verify the SVG tabindex actually focuses in WKWebView or the aria-labels are inert.

- **[P2·ux-defect]** Tooltip is clipped by the stage's overflow:hidden near the right and bottom edges
  `src/viewers/RoomMap.tsx:128` — A tooltip opened within roughly 275px of the stage's right edge, or ~60px of its bottom edge, is cut off by the stage's overflow:hidden — the `shared` evidence terms and the folder line are truncated mid-word or lost entirely.
  _Fix:_ Clamp in showTip the way labels are clamped: measure or estimate the tip box and flip to `clientX - width - 14` when `left + width > size.w`, and to `clientY - height - 14` when it would pass the bottom — the same onCanvas discipline already used at RoomMap.tsx:204-209.

- **[P2·data-loss]** Saving a .vtt destroys its STYLE, NOTE and REGION blocks, cue ids and per-cue positioning
  `src/viewers/subtitles.ts:96` — `parseCues` deliberately drops everything that is not a timed cue — the WEBVTT header's metadata lines, `NOTE`/`STYLE`/`REGION` blocks (line 64), WebVTT cue identifiers (line 66-67) and the settings that follow the end stamp (line 71-73, e.g. `line:90% align:start`). `toVtt` then re-serializes from cues alone, emitting a bare `WEBVTT\n\n` header and bare timing lines. Correcting one typo in a styled/positioned .vtt therefore silently rewrites the file without any of it: captions lose their placement and styling in every player that honoured them. The parse side is even unit-tested for cue settings ('WebVTT headers, notes and cue settings are handled', e2e/page-script/viewerparse.test.mjs:120) — nothing tests what the SAVE does to them, so the suite is green.
  _Fix:_ Carry the unparsed parts through: keep a per-cue `settings` string and `id`, plus the file's prologue blocks, on the `Cue`/parse result, and re-emit them in `toVtt`. Failing that, refuse to save a .vtt whose parse dropped anything (compare a re-serialize of the untouched parse against the original) and say why.

- **[P2·data-loss]** One ⌘Z after the assistant draws deletes its entire diagram and autosaves the deletion
  `src/viewers/SketchView.tsx:346` — The assistant draws a diagram; the user presses ⌘Z intending to undo their own last stroke, and the whole generated diagram vanishes and is written out of the file.
  _Fix:_ Push a history entry in `applyAgent` before `setDoc(merged)` (the pre-merge document is exactly the right `before`), so one undo steps over the agent's edit rather than through it.

- **[P2·honesty]** A refused set_cell still marks the cell changed and shows the new value as "already saved into the file"
  `src/viewers/SheetView.tsx:464` — When the backend refuses a cell write, the grid nevertheless records the edit, paints the pink changed-cell edge, displays the value that was never written, counts it in "N cells changed", and the notes panel states those cells were "changed in this session and already saved into the file". The only contrary signal is a transient error toast.
  _Fix:_ Await the write before recording: make onEditCell return a promise/boolean, and only call recordEdit and clear the notice on success; on failure restore the cell and put the reason in the sheet-notice strip rather than in a toast that disappears.

- **[P2·crash]** Zip-backed viewers inflate on the main thread, and the off-thread path needs a blob: Worker this app's CSP forbids
  `src/viewers/BookView.tsx:58` — The claim that fflate's async unzip "runs off the main thread, so a large archive doesn't freeze the window" holds only for entries at least 512 KB that also compress well. Everything else inflates synchronously inside the unzip() call, so a book/deck/archive with many parts freezes the window. Worse, when an entry DOES take the worker path, the Worker is constructed from a blob: URL, which this app's CSP does not allow — the constructor throws synchronously out of unzip(), past the (err, files) callback, and escapes the useEffect into the pane-level ErrorBoundary instead of the viewer's own error message.
  _Fix:_ Confirm the worker path in the running app first (open a zip with one >512 KB text entry). Regardless of the outcome, wrap each unzip() call in try/catch so a synchronous throw becomes the viewer's own error state, and move the listing/parse work off the render thread properly — for ArchiveView by using the filter-only pass (no inflation at all), and for BookView/SlidesView by inflating only the parts actually needed.

- **[P2·honesty]** The Strength bar hides proven relations before it hides guesses
  `src/viewers/roomMap/edges.ts:171` — The slider is titled 'Hide the weakest links' and filterEdges compares one `weight` number across all six kinds — but the backend assigns per-kind constant weights, so raising it strips FACTS first while high-scoring inferred links survive. The control the map offers as the honest way back from a hairball removes the map's most trustworthy content first.
  _Fix:_ Either exempt facts from the strength filter the way rankEdges exempts them from the render cap (`e.weight >= minWeight || styleFor(e.kind).fact`), or apply the bar only to the inferred kind and rename it accordingly — 'Hide the weakest guesses'.

- **[P2·honesty]** A memory→file link is drawn and described as 'this one names the other by name', which it is not
  `src/viewers/roomMap/edges.ts:77` — The map tells the reader a memory NAMES a file when all the backend found is that the memory's two rarest words appear somewhere in that file's text. The tooltip lead and the legend word are borrowed from the file→file relation, which really is name-matching.
  _Fix:_ Give the memory relation its own kind (e.g. `mentioned_in`) in graph.rs and in EDGE_STYLE, with a lead that says what was actually measured — 'This memory's distinctive words appear in this file' — or, if a new kind is too costly, make edgeLines() special-case an edge whose `a` starts with `mem:` and swap the lead.

- **[P2·ux-defect]** A small drag on a star opens the file — there is no movement threshold on a node click
  `src/viewers/roomMap/NodeStar.tsx:109` — Because nodes swallow the pan gesture (see the confirmed backdrop finding) and their click handler has no drag threshold, a natural 'grab and move the map' attempt that starts on a star instead opens that file and tears the map down — losing pan, zoom, filters and selection.
  _Fix:_ Move the pan handlers to the <svg> so a drag from a node pans, and gate `activate()` on the same movedRef threshold the backdrop uses — a press that moved more than 3px is a pan, not a click.

- **[P3·ux-defect]** The live meeting-lane ghost is drawn under a speaker name that is not a label, in Speaker 1's colour
  `src/viewers/RecordingView.tsx:1528` — While a meeting is captured, the sys-lane "still speaking…" ghost is headed "Meeting" and painted in Speaker 1's blue; a moment later the finalised phrase appears as "Speaker N" in that speaker's own colour, and renaming that voice never affects the ghost.
  _Fix:_ Present the ghost as provisional rather than as a speaker: drop the coloured chip for the sys lane and label it neutrally ("the Mac's audio"), or attach it to the label the sys lane's most recent final phrase carries so the chip and colour match what the row becomes. Also fix the comment at lines 1522-1525, which asserts something the code does not do.

- **[P3·correctness]** Repeated Transcribe clicks enqueue duplicate STT jobs on the same file
  `src/viewers/AudioView.tsx:137` — When the STT lane is backed up, the button flips back to 'Transcribe' after 6 s even though nothing has started, and each further click queues another full decode of the same file. There is no 'queued' state at all.
  _Fix:_ Hold `kicked` until a `stt-progress` event naming this file arrives (and give the strip a 'Queued' word), or add a backend guard refusing `retranscribe_file` for a file already queued/in flight, the way `rec_retranscribe` guards with `rec.retranscribing`.

- **[P3·dead-code]** A failed subtitle save is invisible in the viewer and the error surface is unreachable
  `src/viewers/SubtitleView.tsx:43` — The prop's documented contract ('Resolves false when the write failed') is never checked, so the component's own error line can never render; a failed write is reported only by the global toast, and the `!openFile` path reports nothing anywhere.
  _Fix:_ `const ok = await onSave(...); if (!ok) setError("Could not save this subtitle file — your edits are still here.");`

- **[P3·correctness]** Subtitle length label reads the last cue rather than the latest end time
  `src/viewers/SubtitleView.tsx:65` — For a file whose cues are not in ascending order (legal in SRT, common in machine-merged or bilingual files) the 'N cues · X long' header understates the length, potentially by minutes.
  _Fix:_ `shortStamp(Math.max(...cues.map((c) => c.endMs)))`.

- **[P3·honesty]** Book "Text" mode claims a chapter has no text when the zip key merely differs in case
  `src/viewers/BookView.tsx:111` — For a book whose manifest hrefs differ from the zip entry names only in case or a leading slash, Page mode renders the chapter but Text mode asserts it is a full-page image — a false claim about the book, and it removes the only way to quote from it.
  _Fix:_ Use `findEntry(files, chapter.path)` in the `plain` memo — the same tolerant lookup every other reader of that path already uses.

- **[P3·ux-defect]** A notebook code cell containing a fence breaks out of its code block and renders as prose
  `src/viewers/NotebookView.tsx:135` — Any code cell whose source contains a line of three backticks (a docstring holding markdown, a cell that writes README text, a prompt string) ends the fence early: the rest of the cell renders as Markdown — headings, tables, emphasis, KaTeX — instead of as Python.
  _Fix:_ Open the fence with a run of backticks one longer than the longest run appearing in the source, or bypass the Markdown round trip entirely and hand the source to the highlighter directly.

- **[P3·honesty]** A password-protected or otherwise unreadable workbook reports only "Could not parse this spreadsheet"
  `src/viewers/SheetView.tsx:170` — An encrypted .xlsx is presented as an unparseable file, so the reader has no way to learn that a password is the reason and no way to supply one.
  _Fix:_ Bind the error and distinguish the password case in the message (the same way the legacy .xls read-only strip already explains itself via readOnlyReason), keeping the generic sentence for everything else.

- **[P3·correctness]** Grid undo performs the file write inside a setState updater
  `src/viewers/SheetView.tsx:415` — ⌘Z in the spreadsheet grid issues the Tauri write and a toast from inside a React state updater, so any replay of that updater performs the undo twice — two file writes and two "You edited" version entries for one keystroke (deterministically in dev under StrictMode).
  _Fix:_ Read the last edit from the current state (or a ref), perform the write and setNotice outside the updater, and leave `setEdits` as a pure `prev => prev.slice(0, -1)`.

- **[P3·perf]** Quote highlighting allocates one JS object per character of the whole document, up to eight times
  `src/viewers/highlight.ts:214` — Opening a very large note or .txt from a search hit or an agent citation stalls the window for seconds and spikes memory into the hundreds of MB; when the quote cannot be found in the rendered DOM the identical work is repeated on seven successive animation frames before it gives up.
  _Fix:_ Index text nodes as (node, startOffset, length) tuples and binary-search a match offset back to its node instead of materialising one object per character, and cache the built source/normalisation across the retry frames instead of rebuilding both on every frame.

- **[P3·test-gap]** The QuickLook temp-file leak test for extension-less files asserts nothing
  `src-tauri/src/quicklook.rs:210` — `a_file_with_no_extension_still_gets_a_unique_temp_name` claims to prove that rendering an extension-less file leaves no decrypted copy behind, but its final assertion counts files matching a suffix that code path can never produce; it would pass unchanged if that branch leaked.
  _Fix:_ Extend `leftovers` (or add a sibling) that counts extension-less copies — `n.starts_with("arcelle-ql-") && !n.contains('.')` — and assert on that, or give the extension-less render a predictable stem the test can filter on.

- **[P3·correctness]** A CRLF document is chunked as one paragraph and its line structure is destroyed
  `src-tauri/src/extraction/chunking.rs:5` — A Windows-authored document (Excel CSV, CRLF .txt, .eml body) is indexed as chunks of space-joined words cut at arbitrary ~1200-char points, with no row, line or paragraph boundaries left in the text the model reads.
  _Fix:_ Normalize "\r\n" → "\n" at the top of chunk_text, and make split_by_len split on LINES first and only fall back to words for a line that is itself too long, so single-newline structure survives. Add a CRLF fixture to the chunking tests.

- **[P3·correctness]** userAdjustedRef is never cleared on a new graph despite its own comment
  `src/viewers/RoomMap.tsx:95` — Two contradictory comments describe one flag, and any room-file change silently reshuffles every node position while the reader's pan/zoom is preserved — so a zoomed reader is left framing a region that now holds different nodes, with nothing on screen saying the map was rebuilt.
  _Fix:_ Delete the stale 'Cleared on … new graph' half of the RoomMap.tsx:93-94 comment. Then either keep positions stable across rebuilds (seed the angle from `seedFrom(node.id)` rather than from the array index) or, when a re-seed happens while userAdjustedRef is true, surface a one-line 'the map was rebuilt — reset view' affordance beside the existing .rm-controls.

- **[P3·correctness]** The map never refreshes when memories change, though it draws memory nodes
  `src/viewers/roomMap/useRoomGraph.ts:123` — Adding, editing or deleting a memory leaves the drawn memory stars and their links unchanged until an unrelated file write or a reopen of the map; and because the UI memory commands emit no event at all, no amount of frontend subscribing fixes the human-edit case.
  _Fix:_ Two halves. Backend: emit `memories-changed` from library.rs add_memory / update_memory / delete_memory / restore_memory, matching what agent.rs already does. Frontend: subscribe to `api.onMemoriesChanged` alongside `onRoomFilesChanged` in the same effect, sharing the 400ms debounce, the `alive` flag and the cleanup.

- **[P3·ux-defect]** "Deselect" is unreachable — focusId falls back to topNode, so the circled ring never goes away
  `src/viewers/RoomMap.tsx:123` — The map has no state in which nothing is circled: clicking empty canvas and pressing Reset both null `focus`, which immediately falls back to the hub node, so 'deselect' returns the ring to a node the reader never chose rather than removing it. usePanZoom.ts:102's comment 'A click on empty canvas (no drag) deselects' is therefore only half true.
  _Fix:_ Separate the default emphasis from the selection: keep `focusId = focus ?? topNode` for labelling, but pass a `userSelected = focus != null` flag and draw .rm-node-circled / .rm-label-bg.is-focus only when it is true — or give the hub a distinctly weaker default treatment so 'circled' keeps meaning 'you chose this'.

- **[P3·ux-defect]** Clicking a star unmounts the map, discarding pan, zoom, filters and selection with no way back
  `src/viewers/RoomMap.tsx:549` — Opening a file from a star tears the map down; returning re-fetches, re-seeds every node onto a fresh circle and replays the settle animation with the default fit, all link kinds shown and the Strength bar back at 0.
  _Fix:_ Lift the map's view + filter state into the workspace store (alongside showMap) so a re-open restores it; or make a single click select only and open on double-click / Enter, which the aria-label already advertises.

- **[P3·honesty]** The List view — the documented keyboard/screen-reader equivalent — omits every memory node
  `src/viewers/RoomMap.tsx:267` — The list is a list of files, not of the graph: a memory with no link is drawn on the canvas and appears nowhere in the list, and a linked memory appears only as an unlabelled name inside some file's 'Names' group, so a keyboard or screen-reader user cannot tell memories from files or enumerate them.
  _Fix:_ Emit memory rows in listRows too (no open button — `openable` is false for them) and mark memory names inside the kind groups, or narrow the RoomMap.tsx:246-251 comment to say the list covers files and their links only.

- **[P3·dead-code]** Node tooltips promise a summary line the backend never sends
  `src/viewers/roomMap/NodeStar.tsx:58` — The second tooltip line on a star can never render, and graphSignature hashes a field that is always undefined — a field the frontend type declares but no producer ever populates.
  _Fix:_ Pick a side: either add `summary` to the Rust GraphNode (populated from the file's stored summary) so the tooltip line means something, or delete it from types.ts:8, NodeStar.tsx:58 and useRoomGraph.ts:51.

- **[P3·dead-code]** MAX_NODES = 800 truncation branch is unreachable — the backend caps the graph at 120 nodes
  `src/viewers/roomMap/useRoomGraph.ts:179` — Dead branch plus a misleading comment ('Cap to the highest-degree nodes if a room is enormous'), and a latent inconsistency: the truncation it would perform is not mirrored in visibleEdges, so the header, degree, adjacency and list would all still count dropped nodes' links.
  _Fix:_ Delete the branch and MAX_NODES; if a node budget is genuinely wanted, apply it to `visibleEdges` too so no downstream count can outlive the nodes it refers to.

- **[P3·dead-code]** Dead reduced-motion escape hatch for a transition that no longer exists
  `src/viewers/roomMap.css:559` — A CSS rule and three separate comments describe a `.room-map-node` colour transition in misc-moonshot.css that was deleted; the rule matches an element that has no transition, and the comments send the next reader looking for a stylesheet rule that is not there.
  _Fix:_ Delete the @media block at roomMap.css:556-562, and rewrite the roomMap.css:125-128 and NodeStar.tsx:33-37 comments to say `stroke: none` / the per-shape paints are deliberately defensive against a rule that was removed, rather than describing it as live.

- **[P3·ux-defect]** Labels print on-canvas for stars that are off-canvas
  `src/viewers/RoomMap.tsx:204` — A label card can be drawn pinned to the edge of the stage describing a star that is not on screen, because the offscreen cull uses a fixed 60/30px margin while the card itself is then clamped fully into view.
  _Fix:_ Cull against the label's own geometry rather than a fixed margin — skip a candidate whose preferred box would need more than a few pixels of clamping — and drop the prio>=2 forced fallback for candidates that are already outside the viewport.

- **[P3·data-loss]** A save that lands while a newer edit is pending clears the dirty flag, so the unmount flush skips the newer edit
  `src/viewers/SketchView.tsx:277` — An edit made in the moment an autosave is in flight is silently dropped when the viewer is closed shortly after: the footer says “Saved”, and the edit is not in the file.
  _Fix:_ Version the document — keep a monotonically increasing counter bumped by `scheduleSave` and captured by `flush`, and only clear `dirty.current` when the counter has not moved since the write started.

- **[P3·reliability]** A failed autosave is never retried; the drawing sits unsaved until the user happens to edit again
  `src/viewers/SketchView.tsx:279` — If a save fails (a locked room, a storage error), the footer changes to “Not saved” and nothing further happens — no retry, no dialog, and the ordinary “Saved”/“Saving…” wording returns as soon as the next edit is scheduled even though the failed document was never written.
  _Fix:_ Retry on a backoff from the failure path, and keep the failed state sticky until a write actually succeeds — a canvas with no Save button has no other way for the user to force one.

- **[P3·correctness]** SlidesView indexes the parsed deck by array position, ignoring the slide number it stores
  `src/viewers/SlidesView.tsx:144` — When any slide part is unparseable or its relationship target is missing, the frontend parse silently drops it, and every later slide's title, speaker notes and citation landing point shift by one relative to the picture macOS draws — the notes shown beside slide 7 belong to slide 8.
  _Fix:_ Key the lookups by the stored slide number rather than by array position — build a `Map<number, Slide>` and use `slides.get(at + 1)`, and for the citation use `setAt(slides[idx].number - 1)` — so a dropped part leaves a gap instead of shifting everything after it.

- **[P3·ux-defect]** The html, json, log, svg and notebook registry rows drop the viewer target, so a search hit or an agent citation into those files points at nothing
  `src/viewers/registry.tsx:248` — ⌘K opens every file hit with `{find: snippet}` and agents open files with a quote/find, but these rows never read `target`: the file opens at the top and nothing is located, highlighted or scrolled to, with no message saying the passage could not be pointed at. Saved web pages and logs — two formats people search precisely because they are long — are the worst affected, and for html the app already HAS a surface that could do it (the Text mode is the app's own DOM, unlike the sandboxed Page frame).
  _Fix:_ For log/json/svg/notebook, pass the target through and use the existing anchoring (LogView already has a filter box the term could seed). For html, switch to Text mode when a quote/find target arrives and run applyQuoteHighlight over the rendered `<pre>` — or, if that is not wanted, say plainly that the passage cannot be pointed at inside the sandboxed page instead of dropping the request.

- **[P3·incomplete-coverage]** TEXT_EXTENSIONS entries "gitignore", "env" and "dockerfile" can never match the files they were added for
  `src-tauri/src/extraction.rs:34` — `Dockerfile`, `.gitignore` and `.env` under their canonical names are not recognised as text and take the same no-text/binary path as any other extension-less file; the dotted variants (web.dockerfile, prod.env) do work.
  _Fix:_ Fix it with finding 1's bytes-sniff rather than a name table — that covers README/LICENSE/Makefile too. If a name table is preferred anyway, add TEXT_FILENAMES checked case-insensitively on the whole file name BEFORE the extension lookup, and keep the existing extension entries (they are live for dotted spellings).

- **[P3·ux-defect]** Wheel zoom cannot preventDefault — a trackpad pinch zooms the whole app, not the map
  `src/viewers/roomMap/usePanZoom.ts:48` — `preventDefault()` in the room map's wheel handler never runs — it is called inside React's passive root listener. Today that costs a console warning per wheel tick and leaves the map unable to suppress any future default wheel behaviour; unlike SketchView, a pinch (ctrl/meta+wheel) and a plain two-finger scroll are also treated identically, both zooming.
  _Fix:_ Mirror SketchView.tsx:456-477: drop the `onWheel` prop from RoomMap.tsx:478, attach the handler in a useEffect on `svgRef.current` with `{ passive: false }`, and branch on `ev.ctrlKey || ev.metaKey` (pinch → zoom at cursor) versus a plain wheel (pan on deltaX/deltaY).

- **[P3·perf]** Every pointer move re-renders the whole SVG tree and forces a layout read
  `src/viewers/RoomMap.tsx:127` — Each mousemove over a link or a star performs one forced layout read (getBoundingClientRect) and reconciles the entire SVG tree — up to 120 node groups and up to MAX_EDGES = 400 edges, two <line> elements each — because the tooltip position lives in RoomMap state and no child is memoised.
  _Fix:_ Cache the stage rect in the existing ResizeObserver (useRoomGraph.ts:135-150) instead of reading it per event; wrap Edge and NodeStar in React.memo and stabilise showTip/setHovered/setFocus with useCallback; optionally drive the tooltip's left/top through a ref + direct style write so a move does not re-render the tree at all.

- **[P3·ux-defect]** A room with one file and many linked memories is told to "add a few files", and still burns a settle loop behind the empty text
  `src/viewers/RoomMap.tsx:138` — With one file and several linked memories the map hides the whole canvas behind 'Add a few files and I'll map how they connect', suppressing the legend, list toggle and controls, while the simulation still runs its full settle loop and its per-tick setView/rerender against a canvas that is never mounted.
  _Fix:_ Bail out of the layout effect when the canvas will not be drawn (early-return on the same condition showEmpty uses), and decide deliberately whether a one-file room with memory links should draw — if it should, base showEmpty on `graph.nodes.length < 2 || cappedEdges.length === 0` and reword EMPTY_TEXT accordingly.

- **[P3·honesty]** The MAX_EDGES render cap drops links with no disclosure, while the file cap gets a careful one
  `src/viewers/roomMap/edges.ts:153` — rankEdges can silently discard links before the map ever sees them, and nothing downstream knows. The header prints 'M links' and '(N hidden)' where N counts only what the reader's own filter removed, so a room over the budget under-reports its links while presenting the number as the room's total — the exact failure the atFileLimit caveat exists to avoid for files.
  _Fix:_ Have rankEdges return the pre-cap total (or a `truncated` flag), thread it through RoomGraphApi beside atFileLimit, and extend the header title the way the file caveat is worded — 'the map draws the 400 strongest links; weaker ones aren't on it'.

- **[P3·correctness]** The tooltip is never cleared when the link it describes stops being drawn or moves away
  `src/viewers/roomMap/Edge.tsx:76` — The tip is state holding a snapshot of a title and its evidence lines; it is cleared only by mouseleave/blur/drag-start. If the element under the cursor disappears or the geometry moves without a pointer event, the map keeps narrating a link it is no longer showing.
  _Fix:_ Clear the tip whenever what it points at can no longer be trusted: call setTip(null) from the visibleEdges repaint effect and when a new graph is installed, and key Edge components by their edge identity (`${e.a}|${e.b}|${e.kind}`) rather than by array index so a reload remounts them.


### Recording (29)


- **[P2·correctness]** A live recording's `caffeinate -i` child is orphaned on quit — the Mac never idle-sleeps again
  `src-tauri/src/commands/recording_cmds.rs:240` — Quit while recording and a stray `caffeinate -i` survives the app, so the Mac stops idle-sleeping until the user finds and kills it. One orphan per quit-during-recording.
  _Fix:_ Spawn it as `caffeinate -i -w $(pid)` so the OS reaps it on any exit path, and/or kill the child from the `RunEvent::Exit` handler alongside `stt::unload_ctx()`.

- **[P2·honesty]** Mic-failure banner asserts "the Mac's audio keeps recording" even when system audio is off or its tap failed
  `src-tauri/src/recording.rs:1871` — With "Include the Mac's audio" unticked (or with the tap failed on the permission error), a dead microphone means nothing at all is being captured — but the banner and toast tell the user the Mac's audio keeps recording, so they let an empty recording run.
  _Fix:_ Branch the message on `self.cfg.system_audio && self.sys_tap.is_some()`; when the meeting lane is off or failed, say that nothing is being captured and point at Stop — the same wording recordingActions.ts:388 already uses.

- **[P2·concurrency]** One global Whisper mutex is held across an entire decode, so a background import freezes live meeting transcription
  `src-tauri/src/stt.rs:440` — Importing an audio/video file while a meeting records stops the live transcript for the length of that import (minutes for a long video): no partials, no new lines, finals accumulate in memory. Dictation blocks the same way in both directions.
  _Fix:_ Stop holding the mutex across the decode: keep the `WhisperContext` in an `Arc` behind the mutex, clone the Arc under the lock, release it, and run `create_state()` + `full()` outside (whisper.cpp supports multiple states per context). Failing that, make whole-file and dictation jobs yield while a live session exists rather than preempting it.

- **[P2·data-loss]** Resuming a recording that still has audio checkpoints deletes or desynchronises them
  `src-tauri/src/commands/recording_cmds.rs:182` — After a save failure (disk full, DB error) the session's audio survives in rec_chunks. Pressing Record on that file again loads only the stored WAV, and the next successful save deletes those chunks — that stretch of the meeting is gone. If the new session crashes instead, recovery splices the old tail in and every timestamp in the new transcript is offset by its length.
  _Fix:_ Call `db::recover_rec_chunks` (or a per-file variant) at the top of rec_start's resume branch, before `get_file_full`, so `base` always includes the checkpointed tail — and refuse the resume if that rescue fails rather than recording over it.

- **[P2·data-loss]** A long dictation whose final decode exceeds 120 s loses the entire transcript, including the partial already on screen
  `src-tauri/src/commands/stt_cmds.rs:573` — Stopping a several-minute dictation can fail with 'Transcribing the dictation timed out.' The finished decode is thrown away, and the frontend then wipes the live partial it had already painted, so the composer resets to whatever was typed before the mic opened.
  _Fix:_ Scale the wait with the captured audio (or drop it and rely on `dict_cancel` plus a UI-side 'still transcribing' state), and — independently — on any dictStop failure keep the last `dict-partial` text in the composer instead of calling `onPartial("")`. A rough transcript beats nothing, and that half fixes every dictStop error path, not just the timeout.

- **[P2·honesty]** The stale-reading warning cannot see the two edits the page is built around (delete words / fix the words)
  `src-tauri/src/recording.rs:315` — After "Delete from recording" or "Fix the words", the stale badge never appears, so chapters/notes/highlights derived from the old wording keep presenting themselves as current — including a note that quotes words the user has since deleted.
  _Fix:_ Fingerprint what the reader actually reads: `chars: segments.iter().map(|s| segment_visible_text(s).chars().count()).sum()` (and keep the UI mirror in the same unit, or better, move the comparison into Rust — see the byte/UTF-16 finding). `segment_visible_text` allocates, so on a very long transcript sum the kept words' lengths directly instead.

- **[P2·correctness]** rec_read's transcript-changed guard is blind to a delete that empties a turn, so findings land on the wrong moments
  `src-tauri/src/commands/jobs/rec_read.rs:483` — If a whole phrase is deleted from the transcript while a read is running, the publish guard does not fire, and every finding whose turn number falls after the deleted phrase is written onto the preceding speaker's sentence.
  _Fix:_ Two independent fixes, both worth doing: (1) fingerprint the visible text (see the ReadStamp finding) so the guard actually fires; (2) make resolution positionally immune — capture each turn's segment id in the plan and resolve findings by id, dropping any finding whose segment is gone.

- **[P2·honesty]** Deleting a selected phrase also deletes the other lane's overlapping words, and the toast counts only the selected ones
  `src-tauri/src/commands/recording_cmds.rs:1099` — Deleting a selected phrase that overlaps another lane in time also removes the other lane's words from the transcript, and the confirmation names only the number of words the user highlighted, so nothing on screen says other people's words went with it.
  _Fix:_ Do not narrow the marking (that would desynchronise the transcript from the audio cut). Return the number of words the command actually marked, split by lane, and let the toast say it — e.g. "Removed 12 words (5 of them on the meeting lane) — playback now skips that stretch." Consider naming the time span in the confirm step, since the act is time-based rather than selection-based.

- **[P2·honesty]** "Recording saved — transcript included." is asserted without reading the result
  `src/workspace/recordingActions.ts:463` — A session recorded with live transcription switched off, or one in which nothing was said, still reports 'transcript included' on Stop. The user opens the file and finds none.
  _Fix:_ `const meta = await api.recStop();` and pick the sentence from `meta.segments.length` — 'Recording saved — transcript included.' vs 'Recording saved. No transcript was written — use Re-transcribe to build one.'

- **[P2·perf]** Every RecSegment ships a 192-float voiceprint across the IPC seam that the TS type does not declare
  `src-tauri/src/recording.rs:140` — Meeting-lane recordings carry a 192-dim voiceprint per phrase on the `rec-segment` event and inside every RecMeta a command returns; the frontend RecSegment type has no `voice` field, so the webview decodes megabytes of floats and throws them away on every note, chapter, highlight, rename and range edit.
  _Fix:_ Strip `voice` on the IPC boundary only. A blanket `#[serde(skip_serializing)]` would be wrong — recording_cmds.rs:207 serializes the same struct into `set_rec_meta` and diarize/`learn_voice` (recording_cmds.rs:734-740) needs the prints — so introduce a wire view of RecSegment/RecMeta for the command returns and the `rec-segment` payload, or clear `voice` on a clone in the return path.

- **[P2·data-integrity]** A checkpoint that half-fails is retried non-idempotently: the same audio is appended again, and the retry runs 4x/second forever
  `src-tauri/src/recording.rs:2214` — If a periodic checkpoint fails PART WAY — `append_rec_chunk` succeeds but `set_file_extracted_text` or `set_rec_meta` fails — `flushed_samples` is deliberately left alone "so the next flush retries the whole tail", but the append is not idempotent: the retry inserts a NEW chunk row covering the same samples again. Crash recovery concatenates all rows in seq order, so the recovered recording physically repeats that stretch of audio and is longer than its transcript. Worse, once the dirty range is past 60 s the retry condition is true on EVERY ingested batch, so the engine re-attempts the whole growing tail about four times a second, each attempt appending another overlapping copy and emitting another `rec-error` — which effects.ts turns into one toast per event.
  _Fix:_ Wrap the checkpoint branch in `in_transaction` exactly as `finalize_rec_audio` does, so append+text+meta land or roll back together and the retry cannot double-append. Separately, rate-limit the retry (remember the last failed attempt's instant and back off to, say, once every few seconds) and emit the error at most once per outage instead of once per batch.

- **[P2·correctness]** A mid-recording edit that times out has ALREADY been applied — the user's retry writes it twice
  `src-tauri/src/commands/recording_cmds.rs:609` — `edit_rec_meta` sends the edit closure to the engine and then waits 20 s. If the engine is busy (the pause/stop speaker-split pass is explicitly the thing that can be in front of it, and that pass is documented to run for MINUTES on a long meeting), the wait times out and the caller is told "The recording is busy — try again in a moment." — but the closure is still queued and will be applied when the engine gets to it. The user obeys the message and presses the button again, and the note / highlight / chapter is written twice (fresh uuids, no dedup). A speaker rename is applied twice too, which additionally teaches the voice table twice.
  _Fix:_ Make the edit cancellable on timeout: have the caller pass an `Arc<AtomicBool>` (or a `Weak` reply channel) that the engine checks before applying — `if done.send(...).is_err() { skip }` is not enough because the engine applies before it replies, so move the apply after a liveness check on `done`. Simplest correct shape: engine checks `if done_is_dropped() { return; }` first, and `edit_rec_meta` drops its receiver before returning the timeout error.

- **[P2·honesty]** A read where every window was skipped is stored as a completed read that "found none", and the sweep never retries it
  `src-tauri/src/commands/jobs/rec_read.rs:495` — When the model fails non-fatally on some or all windows (a timeout, two malformed replies, a provider hiccup), the publish step still runs, writes whatever it has — possibly nothing — and stamps the recording as read. The tabs then say "the room read it and found none", which is a claim about the meeting rather than about the read, and the automatic sweep will never look at that recording again.
  _Fix:_ Carry the skipped count into the meta (e.g. `read_of: { turns, chars, partsRead, parts }`) and let the panel say "read 1 of 3 parts — read again" instead of "found none"; and do not stamp `read_of` at all when every window was skipped, so the sweep retries. At minimum, include `{skipped, parts}` in the `rec-read-done` payload and toast it.

- **[P2·data-loss]** Pause drops the mic tail too — and here the engine discards it deterministically
  `src/workspace/recordingActions.ts:419` — `pauseLiveRecording` tears the tap down and does not await its flush, exactly like the Stop path, but the ordering is far more likely to lose: `rec_pause` is a SYNCHRONOUS Tauri command (`pub fn rec_pause`, recording_cmds.rs:304) that runs inline on the IPC thread, while `rec_push_audio` is `pub async fn` (recording_cmds.rs:279) and is spawned onto the async runtime. The Pause message therefore usually reaches the engine channel before the spawned push does, and `handle(EngineMsg::Audio)` drops any audio that arrives once paused: `if !self.paused && self.stopping.is_none() { self.ingest(...) }` (recording.rs:1668-1671). Up to 250 ms of speech is cut out of the MIDDLE of a meeting on every pause, not just at the end.
  _Fix:_ Same fix as the Stop path: have the teardown return the flush promise and `await` it before `api.recPause()` / `api.recStop()`. One `stopMicTapAndFlush()` used by both call sites closes both holes.

- **[P3·honesty]** The system-audio tap's "read back the negotiated sample rate" guard is inert — it re-reads the value it just set
  `src-tauri/src/recording/sck.rs:176` — The engine believes it resamples whatever rate ScreenCaptureKit negotiated. It cannot: the value handed to `on_samples` is always the 16 kHz we requested. If any macOS release ignores the request, the whole meeting lane would be mixed and transcribed at the wrong speed with no guard firing.
  _Fix:_ Take the real rate per batch from the delivered buffer in `extract_f32` (`CMSampleBufferGetFormatDescription` → `CMAudioFormatDescriptionGetStreamBasicDescription().mSampleRate`) and pass that to `on_samples`; or delete `TapIvars.rate` and the three comments so the code stops claiming a check it does not perform.

- **[P3·correctness]** Stopping a recording before the ScreenCaptureKit tap finishes coming up leaks the tap — it is never stopCapture'd
  `src-tauri/src/recording.rs:2319` — Press Stop during the seconds the tap is coming up (very likely on a first run, with the Screen Recording sheet open) and the stream is started and then never explicitly stopped. The macOS system-audio/screen recording indicator can stay lit and the capture callback keeps firing into a dead channel.
  _Fix:_ Give `SysAudioTap` a `Drop` that calls `stopCaptureWithCompletionHandler(None)` and make `stop(self)` a thin wrapper (or just delete `stop` and rely on drop), so every path that discards the value — including the failed channel send — tears the stream down.

- **[P3·privacy]** Decrypted room audio is written to the temp dir with default permissions, unlike every sibling temp path
  `src-tauri/src/stt.rs:113` — Transcribing an import, computing a waveform or dictating writes the room's decrypted audio/video to a temp file at 0644 for the length of the decode, and a failed (partial) write leaves that decrypted file behind permanently.
  _Fix:_ Reuse the `write_private` shape (`OpenOptions::create_new(true).mode(0o600)`) for the source copy, remove the file on the write-error path as `probe_bytes` does, and chmod the afconvert/avconvert outputs to 0600 as soon as they return.

- **[P3·data-loss]** A lagging capture lane's audio is written behind the checkpoint mark and never persisted
  `src-tauri/src/recording.rs:2217` — In a crash-recovered recording only, up to ~0.25-0.5 s of the trailing lane (usually the meeting/system lane) is missing at each one-minute checkpoint boundary; the other lane is intact, so a remote voice briefly drops out.
  _Fix:_ Checkpoint to a durable watermark instead of `mixed.len()`: `let mark = self.mic.ingested.min(self.sys.ingested).max(self.flushed_samples);` append `mixed[flushed_samples..mark]` and set `flushed_samples = mark` (the full/final flush can keep using the whole timeline).

- **[P3·perf]** Every pause writes the whole recording's WAV twice
  `src-tauri/src/recording.rs:1663` — Pausing a long meeting re-encodes and re-encrypts the whole recording twice within a second or two, with the room mutex held both times; on a multi-hour session that is hundreds of MB of write amplification per pause and a visible freeze of everything else the room does.
  _Fix:_ Make the pause_pending follow-up cheap: run the split/relabel pass and persist meta + extracted text (and, if any samples arrived, a checkpoint append) instead of a second `flush(true)` — the audio was already made durable by the first write and cannot have grown while paused.

- **[P3·correctness]** Waveform's "colour repeats but the texture doesn't" guarantee is void whenever the caller supplies `tone`
  `src/viewers/Waveform.tsx:365` — On the single ribbon (7+ voices) two different speakers can be drawn with the identical hue AND the identical texture, so their turns are indistinguishable — the exact failure the toneBand ladder was written to prevent; their legend swatches are identical too.
  _Fix:_ Derive the band from the same key as the hue: compute it from the tone class's index in SPEAKER_TONES combined with how many voices already claimed that class (the Nth voice wearing a hue gets band N), and apply the band to the legend swatch as well as the spans.

- **[P3·honesty]** Start toast claims "the Mac's audio keeps recording" before any capture lane exists
  `src/workspace/recordingActions.ts:387` — With the mic blocked and 'Include the Mac's audio' ticked, the error toast asserts in the present tense that the Mac's audio keeps recording — a claim about a lane that has not been asked to start, and that will not start at all if Screen Recording is denied or rec_start fails.
  _Fix:_ State only what is known before rec_start ('the Mac's audio will be recorded if screen recording is allowed'), or move the sentence after `api.recStart` succeeds and read the session's sys lane the way `resumeLiveRecording` does.

- **[P3·correctness]** A failure after rec_start succeeds is reported as a start failure while the engine keeps recording
  `src/workspace/recordingActions.ts:404` — If `listFiles` rejects or `new AudioContext()` throws after the engine started, the user gets a plain error toast that reads as 'start failed', the mic stream is torn down, and the session runs to completion with a system-audio lane only.
  _Fix:_ Split the try at the `recStart` boundary. Anything failing after a successful start must be reported as 'the recording started, but …' and must not tear the mic down — or must stop the session outright via `api.recStop()` so the state matches the message.

- **[P3·data-loss]** Dictation silently stops capturing after 10 minutes with no signal to the user
  `src-tauri/src/commands/stt_cmds.rs:609` — Past DICT_MAX_SECS the worker drops every further sample. The composer's live partial freezes, the final decode ends at the 10-minute mark, and everything said after it is lost with no toast and no state change.
  _Fix:_ When the cap is hit, emit a distinguishable event (or set a flag the final result carries) and have the frontend stop the dictation and say the microphone was closed at the limit — rather than continuing to show a live mic over a dead buffer.

- **[P3·honesty]** Resume reports "the Mac's audio is not being recorded" during the seconds the tap is coming up
  `src-tauri/src/recording.rs:1430` — The durable sys-lane health is wrong in two directions: "off" for the seconds a tap is starting (so a mic failure on Resume in that window is reported as "nothing at all is being captured"), and "on" for the whole of a pause, when the tap has actually been torn down.
  _Fix:_ Model the lane honestly: set a "starting" state in `start_sys_tap`, resolve it in the SysTap arm, and set "off" in `stop_sys_tap`; then have recordingActions treat "starting" as "coming up" rather than folding it into "not recording".

- **[P3·correctness]** After rec_stop takes the session, a webview reload during the (minutes-long) save drain makes the app claim nothing is recording
  `src-tauri/src/commands/recording_cmds.rs:511` — `rec_stop` removes the LiveSession from RecState before the engine has drained and written anything, so for the whole save — which is deliberately unbounded and can run for minutes on a long meeting — `rec_live_status` answers None. The frontend's live state is otherwise held only in React memory, so a webview reload (or a crash of the renderer) inside that window leaves the UI with no REC chip, no save card and no "saving" status, while the engine is still finalising. Worse, the guard that stops a second session is the frontend's `if (s.recLive)` check, which is now false: pressing Record on the SAME file starts a second engine whose base is the not-yet-written WAV, and the two engines then race on `finalize_rec_audio` / `clear_rec_chunks` for one file id.
  _Fix:_ Keep the session entry until the engine reaches a terminal status instead of removing it at Stop — mark it `stopping` and let `clear_finished` retire it on "saved"/"failed" (which it already does) — so `rec_live_status` can report the drain to a reloaded window and `rec_start` keeps refusing a second engine for that file.

- **[P3·robustness]** resample_to_16k divides by the caller-supplied rate with no validation, so a zero rate from the IPC seam panics the recording engine
  `src-tauri/src/recording.rs:607` — `rec_push_audio` and `dict_push_audio` accept `rate: u32` straight off the IPC boundary and hand it to `resample_to_16k`, which computes `input.len() as u64 * SAMPLE_RATE as u64 / from as u64`. A rate of 0 is an integer division by zero, which panics the recording engine thread (or the dictation worker). The engine's channel receiver is then dropped, every subsequent `rec_push_audio` silently no-ops (`let _ = tx.send(...)`), no `rec-state` is emitted so the UI keeps showing REC, and the eventual Stop finds a dead channel with no `shared.outcome` and reports "The recording engine stopped before it could save." — losing everything since the last checkpoint.
  _Fix:_ Validate at the boundary and defend in depth: reject a rate outside a sane band (say 4 kHz-384 kHz) in `rec_push_audio`/`dict_push_audio` with a plain Err, and make `resample_to_16k` return `input.to_vec()` for `from == 0` instead of dividing. Consider making the engine thread's panic observable (catch_unwind → set status "failed" + emit rec-state) so a dead engine can never look like a live one.

- **[P3·data-loss]** The last ~250 ms of microphone audio is dropped at Stop
  `src/workspace/recordingActions.ts:455` — The final partial batch of mic samples races `rec_stop`. When it loses, up to 250 ms of the tail is silently dropped from both the mixed WAV and the transcript; nothing reports it, because the sink swallows push failures by design.
  _Fix:_ Return the flush promise from the recording teardown (`stopMicTapAndFlush(): Promise<void>`) and await it in `stopLiveRecording` before `api.recStop()`, mirroring the dictation path at recordingActions.ts:249.

- **[P3·correctness]** The post-Stop refresh is outside the try, so a failure there escapes as an unhandled rejection
  `src/workspace/recordingActions.ts:471` — `stopLiveRecording`'s try/catch ends at line 469; the two awaits that follow — `s.setFiles(await api.listFiles())` (471) and `await viewFile(fileId)` (473) — are unguarded. Every caller invokes it as `void a.stopLiveRecording()` (ViewerPane.tsx:1221, RecordingView.tsx:1549), so a rejection from `listFiles` becomes an unhandled promise rejection: the success toast has already claimed the recording was saved, but the sidebar never gains the new row and the player keeps showing the pre-stop bytes, with nothing said.
  _Fix:_ Wrap the refresh in the existing `tryToast` helper (used for the same pattern in fileActions.ts:823) or extend the try so a failed refresh says 'the recording was saved — the list could not be refreshed'.

- **[P3·honesty]** A failed translate pass is swallowed: dictation comes back untranslated with nothing saying so
  `src-tauri/src/commands/stt_cmds.rs:771` — With Settings → dictation Translate ON, if the local model call for the translate pass fails (Ollama busy, model evicted, a generation error), `shape_text` silently keeps the original-language text and returns Ok. The user gets Hebrew (or whatever they spoke) inserted as if it had been translated, with no toast and no marker — while the very same function reports a failed CLEANUP pass loudly.
  _Fix:_ Treat a failed translate pass like the shape pass: either propagate the error so the existing 'Kept the exact transcript — …' toast fires, or return the original text together with a flag the frontend surfaces as 'couldn't translate — kept what you said'. Silently returning the untranslated text is the one option that misrepresents what happened.


### Jobs / Workflows (23)


- **[P2·correctness]** A script step that parks for approval is recorded as "error", so the agent is told to fix a script that isn't broken
  `src-tauri/src/commands/jobs/workflow.rs:2611` — An unapproved `script_run` step lands as job status `error`, so the model is told the workflow failed and instructed to edit the step — while the human-written "needs the user's approval" copy never fires. Conversely, a run the user Stopped is reported as "PAUSED — a script step needs the user's approval", which is false.
  _Fix:_ Give the approval-park its own signal: return a sentinel from run_script_process (e.g. `NEEDS_APPROVAL: <msg>`, mirroring the existing `STOPPED`) and map it in spawn_workflow_job to Paused (or a new NeedsApproval outcome) so the already-written paused copy is what the user and the model see. Then reword the Stop-caused paused strings (workflow.rs:3990/4015, scripts.rs:506-510) so they no longer assert approval is pending.

- **[P2·data-loss]** Starting a run deletes the workflow's parked job before checking the queue cap
  `src-tauri/src/commands/jobs/workflow.rs:2771` — A paused or errored run of this workflow (its checkpoint, its done-set and its per-step artifacts) is deleted, and then the replacement run is refused. The Activity card the user could have pressed Resume on vanishes and nothing takes its place.
  _Fix:_ Delete the early call entirely and let db::create_job's own retire_superseded_parked do the work (it already matches workflow rows by workflow id), or, if the explicit sweep is wanted, move it inside the `state.with_room` block at 2812 that mints the row, before db::create_job.

- **[P2·ux-defect]** The live pipeline diagram never animates for a run started from the workflow detail pane
  `src/workspace/workflows/WorkflowDetail.tsx:175` — Press "Run now" in the Workflows detail pane and the pipeline canvas stays completely static for the entire run — no running/done/skipped badges, no peeks — even though the backend emits a `workflow-node` event per step and the store records them under the job id.
  _Fix:_ Return the new job id from api.runWorkflow through runWorkflowNow/runWorkflowOn and hand it to the canvas as the live job, or re-fetch getWorkflowRuns after api.runWorkflow resolves. Emitting `workflows-changed` from start_workflow_run once the run row is created would fix both this pane and the library card's badge.

- **[P2·honesty]** A finished download / picture / podcast job reports "Finished — 0 of 100 steps" in Activity history
  `src-tauri/src/commands/jobs/download.rs:51` — In Activity → History a successfully completed download reads "Finished — 0 of 100 steps"; a finished Create job reads the same; a recorded podcast episode reads "Finished — 0 of 1 steps". A completed job stating it completed none of its steps — the exact defect the studio fix was written for.
  _Fix:_ Create these three with total = 0 (the studio remedy — the history line already drops the clause when total is 0 and jobMeter already renders an indeterminate bar), or checkpoint the cursor to total on success. Widen the pinning test to assert that every create_job site whose runner never calls checkpoint_job passes 0.

- **[P2·perf]** Resuming a workflow re-drives its file_pass node from scratch and mints a brand-new child job row every time
  `src-tauri/src/commands/jobs/file_pass.rs:574` — Every pause/resume cycle of a workflow whose file_pass node had not finished throws away the child's checkpoint and starts a fresh child job, re-reading the whole file through the model from window 0, and leaves the previous child row plus its artifacts behind as an invisible orphan.
  _Fix:_ Record the child's job id in the node's WfArtifact (or look up the parent's existing child for this step id) and, on re-entry, re-drive that child from its stored cursor and existing artifacts instead of minting a new row — the same thing start_file_pass_row does for a top-level pass.

- **[P2·correctness]** A script_run node is not idempotent across a wave replay — a resumed workflow re-executes the script
  `src-tauri/src/commands/jobs/workflow.rs:1807` — When any step in the same dispatch wave as a script_run node fails (or the app dies mid-wave), the wave is not checkpointed, and on Resume the script executes a second time — importing a duplicate copy of every file it produced and repeating whatever else it does.
  _Fix:_ Give the ScriptRun arm the same `existing` short-circuit SaveFile and FilePass have — if a prior non-skipped artifact for this step id exists, return it instead of re-running the process — or checkpoint completed siblings of a failed wave (a bigger change that the run_plan_discards_a_failed_waves_completed_siblings test deliberately pins against).

- **[P2·honesty]** A part-failed multi-variation generation reports success and throws away the reason
  `src-tauri/src/commands/jobs/create.rs:744` — When variation 3 of 4 fails, the job finishes green as "2 pictures ready in this room" and the provider's own words for the failure are dropped on the floor — no error field, no red card, nothing in the job row.
  _Fix:_ Return `(Vec<FileMeta>, Option<String>)` from run_create (or a small struct) and, when the error is Some, put it in the terminal job-progress label and on the job row — e.g. status "done" with a recorded warning, or a distinct partial label quoting the provider.

- **[P2·correctness]** An unread recording starves the auto-index summary sweep, permanently when the read cannot start
  `src-tauri/src/commands/jobs/auto_index.rs:168` — In a room holding a recording the AI has not read, dropping in documents produces no ai_summary coverage: the tick spends itself on the recording arm and returns before the missing-summary decision runs, and nothing re-arms the waiter afterwards.
  _Fix:_ Only take the early exit when a read was actually STARTED: match on the Ok, and on Err (or after a successful start, if the sweep should still run) fall through to auto_index_decision instead of returning. Additionally call schedule_auto_index when a rec_read job finishes so the displaced sweep is re-armed.

- **[P2·honesty]** A workflow_runs row is only ever closed by the runner's epilogue, so Remove-from-queue and a poisoned start leave a run reading "running" forever
  `src-tauri/src/commands/jobs.rs:257` — A workflow run that never got to run keeps a permanent live status: the library card wears the green "Running" badge and Run history prints the raw status "running" for that row indefinitely, with finished_at NULL, and WorkflowDetail picks its job id as the live job.
  _Fix:_ Close the run row wherever the job reaches a terminal state outside the runner: call db::set_workflow_run_status_by_job(conn, id, "paused") in cancel_job's queued branch, and db::finish_workflow_run_by_job(conn, job_id, "error", Some(&e)) in queue.rs's poisoned-start arm (park_crashed_job at jobs.rs:378-382 already does exactly this and is the pattern to copy). For the delete path, close or delete the run row with the job.

- **[P2·concurrency]** The "already running or queued" guard is a TOCTOU across two awaits — double-clicking Run now queues the workflow twice
  `src-tauri/src/commands/jobs/workflow.rs:2754` — One workflow runs twice back to back from a single user action, producing two of every output file (and paying twice for every model call) — the precise pile-up the in-flight guard was written to prevent.
  _Fix:_ Make the guard and the insert atomic: do the has_inflight/at_capacity check inside the same `state.with_room` block that calls db::create_job + create_workflow_run at 2812 (list_models and compile can stay above it — only the decision must move down). A per-workflow in-flight set in AppState, or disabling the button while the promise is pending, would each shrink but not close the window.

- **[P2·correctness]** A chain-parked clip is never woken when the shot before it fails or is stopped, and its card still promises it will start by itself
  `src-tauri/src/commands/jobs/create.rs:737` — A job that parked itself with ChainGate::Wait is resumed only from the predecessor's SUCCESS path. If the predecessor's clip errors, is stopped by the user, or is abandoned by abandon_doomed_queue, nothing ever flips the waiter back to 'queued' — it sits 'paused' indefinitely, and its parked reason tells the user "It starts by itself when that clip is ready", which is by then untrue.
  _Fix:_ On the failure/stop epilogue in spawn_create, look up the successor shot the same way wake_chain_waiter does and either re-queue its parked job (its own gate will now answer Proceed, since the predecessor has no clip and no live job) or rewrite its parked_reason to say the shot before it will not be filmed, so the card stops promising an automatic start.

- **[P2·correctness]** A model's published reference limit is enforced only in the bench — the shot-list path sends up to four portraits regardless
  `src-tauri/src/commands/jobs/create.rs:1378` — `max_references` (input_references.max, read straight off /images/models) is consulted in exactly one place in the whole codebase — the bench's attach button. plan_shot_list attaches every cast face on the shot, capped only by the hard-coded MAX_SHOT_CAST = 4, and check_media_shape never looks at max_references, so a shot with more faces than the chosen picture model publishes is sent anyway and comes back as a provider refusal — after the review sheet has shown those portraits as "looks like" evidence.
  _Fix:_ In check_media_shape, truncate plan.reference_file_ids to `limits.max_references` when it is published (dropping rather than refusing, as resolution/aspect_ratio already are) and surface the drop on the review row — and let MAX_SHOT_CAST be the UI's convenience cap rather than the thing the wire relies on.

- **[P3·correctness]** Re-activating a workflow fires a missed run immediately, ignoring the "Catch up at unlock" setting
  `src-tauri/src/commands/jobs/scheduler.rs:127` — A workflow that sat in draft across its scheduled time runs a full pass within 30 s of being activated, even with "Catch up at unlock" switched off — the tick path applies no catch_up rule at all.
  _Fix:_ Recompute next_run_at from now when a workflow transitions draft→active (in set_workflow_status, when a schedule row exists), which is the same thing the catch_up=false skip branch already does; or apply the catch_up rule in tick for a next_run_at older than one tick interval.

- **[P3·correctness]** Deleting a job or a workflow orphans its child job rows and their artifacts forever
  `src-tauri/src/commands/jobs/workflow.rs:3243` — A workflow's file_pass child rows survive the deletion of their parent job or workflow. They keep a parent_job_id pointing at a row that no longer exists, so list_jobs and unfinished_jobs both hide them and nothing lists, resumes, or ever cleans them or their job_artifacts.
  _Fix:_ Make delete_job_tree pub and use it at all four sites — its own doc comment already states the rule the other callers break.

- **[P3·perf]** jobs, job_artifacts and workflow_runs are never pruned, and list_jobs returns every row with its full plan blob
  `src-tauri/src/db/jobs.rs:411` — Nothing ever removes finished job rows, their artifacts, or workflow_runs rows, so an interval-scheduled workflow grows the encrypted room file monotonically, and every Activity refresh deserializes every row's plan — which for a workflow job embeds the entire definition plus the compiled step list.
  _Fix:_ Add a rolling retention sweep at room open, mirroring prune_web_cache: keep the most recent N 'done' jobs per work identity and N workflow_runs per workflow, deleting through delete_job_tree so children and artifacts go with them. At minimum give list_jobs a LIMIT.

- **[P3·correctness]** Save-and-Activate activates the workflow even when the save failed
  `src/workspace/workflows/WorkflowDetail.tsx:250` — If the save half of Activate fails, the user gets an error toast AND the workflow flips to active — running the previously stored definition while the editor on screen shows the edits they believe they just activated.
  _Fix:_ Give saveWorkflowEdits a variant that propagates failure (or have tryToast return a success boolean) and gate the status flip on it.

- **[P3·correctness]** The queue's FIFO order is undefined among jobs created in the same second
  `src-tauri/src/db/jobs.rs:431` — Two jobs enqueued within the same second (a scheduled run colliding with a manual one, or a burst of triggers) have no defined relative order in the queue — the documented "FIFO by created_at" is not actually deterministic.
  _Fix:_ Add `, rowid ASC` to unfinished_jobs's ORDER BY, matching parked_identities.

- **[P3·dead-code]** generate_audio is plumbed through the sidecar but no caller ever sets it
  `src-tauri/src/commands/jobs/create.rs:806` — A parameter is parsed, typed, forwarded through two layers and badged in the UI, but no request body ever carries it, so nothing in the room can influence whether a clip has sound.
  _Fix:_ Either add a bench control and send `generate_audio` from the plan, or delete the parameter from videogen.submit and the request model — a plumbed argument with no producer is a control surface with no wire behind it.

- **[P3·dead-code]** PlannedRow::prev_clip_file_id is computed and never read outside tests
  `src-tauri/src/commands/jobs/create.rs:1257` — A struct field documented as carrying the resume path's continuity is populated on every planned row and read only by tests; the real capture is chain_gate's, at run start.
  _Fix:_ Delete the field and rewrite those assertions against preview.starts_on_previous and decide_chain's outcome, which is what actually governs the resume path.

- **[P3·correctness]** transform-mode steps feed a silently head-truncated 32 KB tail downstream
  `src-tauri/src/commands/jobs/workflow.rs:2194` — A `script_run` node in transform mode is a pipe stage: its artifact becomes the downstream `{{input}}`. That artifact is the ring-buffer tail, so a script printing more than 32 KB hands the next node its LAST 32 KB with no marker of any kind — not even the "(output truncated)" the agent path adds.
  _Fix:_ Carry the dropped-byte count out of the ring (same change the agent-path fix needs) and prefix the transform artifact with `[earlier output omitted — N bytes]`, or fail the step when the output overflowed the ring, so a pipe stage never silently corrupts its payload.

- **[P3·correctness]** Route node: the validator matches edges against trimmed labels while the runtime sends the raw list
  `src-tauri/src/commands/jobs/workflow.rs:1879` — A route node whose stored `labels` carry surrounding whitespace routes to a branch string no edge matches, so every downstream node writes {skipped:true} and the branch silently does nothing. An empty-string label additionally wins the substring fallback whenever the model's reply isn't parseable as the structured label object.
  _Fix:_ Normalise once at compile time: trim and drop empties in compile_workflow and store the cleaned list in the step params, so validation, the sidecar payload and the edge match all read the same strings. Rejecting empty/padded labels at save time (validate_definition) closes the authoring hole as well.

- **[P3·ux-defect]** Run history fetches a run's steps using the CURRENT — even unsaved — node count, so trimming a workflow hides the old runs' later steps
  `src/workspace/workflows/RunHistory.tsx:173` — Expanding an old run in Run history shows only as many steps as the workflow has nodes RIGHT NOW in the editor. Delete two steps (without even saving) and every past run of the 6-step version silently displays 4 steps; add a step and the panel starts requesting artifact indices that never existed.
  _Fix:_ Fetch by the run's own size, not the editor's: pass the run's job `total` (or the length of the plan's steps) into RunHistory, or have the backend return all artifacts for a job in one call and render whatever comes back.

- **[P3·privacy]** Resume on a podcast recording re-sends the entire script to Microsoft from turn 0
  `src-tauri/src/commands/jobs.rs:1199` — A podcast_audio job that was stopped or errored offers Resume, but there is no checkpoint: `render_podcast_audio` always starts at the first turn, so every line of the script is redacted, packed and sent to Microsoft's Edge TTS service a second time. The button says 'Resume', the card says nothing about a full re-send, and the panel's cloud-seam warning ('nothing is sent until you press Record') is only shown next to Record.
  _Fix:_ Either say so on the control — label it 'Record again' for this kind and have the confirmation repeat the cloud-seam sentence — or drop podcast_audio from the resumable set. If per-turn checkpointing is ever added (which the streaming-progress fix would enable), Resume can then mean what it says.


### Agent / Chat (20)


- **[P2·correctness]** read_skill truncates a large skill at 20 KB with no marker and drops its bundled-resource list entirely
  `src-tauri/src/commands/agent.rs:4335` — For a skill whose SKILL.md body exceeds ~20 KB, the read_skill tool result is cut mid-sentence with nothing saying so, and the 'Bundled resources:' section never appears — so the model has no idea references/ or scripts/ exist and never calls read_skill_resource or run_skill_script.
  _Fix:_ Clamp the instructions body alone, append an explicit '… (instructions truncated — the full SKILL.md is longer than this tool can return)' marker, and always emit the 'Bundled resources:' tree after the clamp — exactly what agent.rs:1023 already does. Add the same marker to the /slash clamp and to list_skills.

- **[P2·correctness]** organize_files / trash_files ASSIGN effects.wrote, erasing an earlier tool's real write and triggering a false "no file was changed" correction
  `src-tauri/src/commands/agent.rs:3977` — A turn that wrote a file and then made a no-op organize/trash call reports itself as having changed nothing: a truthful answer gets "*(Correction: no file was actually changed this turn…)*" appended, and if the reply is then lost the user is told "nothing was written" while an Undo-edit button sits on screen.
  _Fix:_ `effects.wrote = effects.wrote || …` at both sites (or `|=`), so the flag stays monotonic within a run like every other write site. Add a test that runs create_file then a no-op trash_files against one ToolEffects and asserts wrote is still true.

- **[P2·correctness]** Attachments are silently dropped: the 5th+ image, and any non-image with no extracted text
  `src-tauri/src/commands/agent.rs:795` — The composer says "Attached 6" and the turn carries 4 images; a file with no extracted text yet (a scanned PDF pre-OCR, a recording pre-transcription) is dropped entirely. The model is never told, and the dropped file gets no source chip, so an answer that ignored pinned evidence is indistinguishable from one that weighed it.
  _Fix:_ Push a note for every skipped attachment — "(Attached image: X — not sent; this turn carries at most 4 images)" / "(Attached file: X has no readable text yet)" — so the model can say so, and mirror the fact in the composer chip. Base the viewing-hint suppression on what was actually attached, not on the raw list.

- **[P2·ux-defect]** Regenerate leaves the original question behind, duplicating the user message in the transcript and in the model's history
  `src/workspace/chatActions.ts:804` — Regenerate and the lost-reply "Try again" both append another copy of the question to the conversation every time they are used.
  _Fix:_ Delete the preceding user row as well and let ask/run_command re-insert it (the editAndResend shape), or give ask a `resend` flag that skips the user-row insert. Whichever way, cover it with a test that regenerating twice leaves one user row.

- **[P2·concurrency]** Two turns can start in one chat when the composer's page-scope read is in flight, and the first to finish tears down the second's live overlay
  `src/workspace/chatActions.ts:471` — Under the browser page/selection scope, a fast double-Enter starts two turns in one chat. The second registration hides the first turn's stream, and the first turn's completion deletes the chat's run slot — so the second answer keeps streaming with no overlay, no Stop button and no way to cancel it.
  _Fix:_ Take a synchronous latch before the await — either call s.beginRun(chatId, askId) (moving askId minting up) before the page read, or set a module-level `sending` ref that the :401 guard also checks and that is cleared in runTurn's finally.

- **[P2·honesty]** A dead Ollama during a cast import is reported to the user as "this file isn't a character sheet", and loses the OLLAMA_DOWN sentinel
  `sidecar/arcelle_sidecar/chat_docs.py:499` — With Ollama down or the model unpulled, `/knowledge_extract mode="cast"` answers 502 `ENGINE_ERROR` with a message blaming the user's document, and the Rust gateway cannot rebuild `OLLAMA_DOWN` / `MODEL_MISSING:<model>` so the UI shows no "start Ollama" recovery.
  _Fix:_ In the per-window `except`, re-raise unchanged when `exc.code == "OLLAMA_DOWN" or exc.code.startswith("MODEL_MISSING")` — the same test `file_pass._is_fatal` already implements. Keep the "not usable" message only for windows that returned unparseable JSON.

- **[P2·concurrency]** A finished turn declines every queued diff-approval card in the app, including other chats' and jobs'
  `src/workspace/chatActions.ts:254` — An approval card the user is still reading vanishes and its edit is refused because an unrelated conversation's answer happened to finish.
  _Fix:_ Tag each request with the owning run/chat (the id is minted at edit_gate.rs:101 - emit the ask/run id beside it) and decline only ids from the run that is ending; leave other chats' and job/bridge cards queued.

- **[P2·honesty]** Edit & resend ignores the live chat scope entirely — a rewritten question under "This page" is answered from the room while the strip still promises the page
  `src/workspace/chatActions.ts:921` — send() is the only path that makes the scope strip's promise true: it either prepends the live page text / selection (scopedQuestion) or the sketch preamble (withPreamble), and REFUSES the turn outright when the page cannot be read rather than silently answering from the room. editAndResend re-asks the user's rewritten text raw. So editing a question while the strip reads "Answering from This page" sends a bare question with no page text at all, and the model answers from room retrieval — the exact substitution send() calls a different question answered from different evidence.
  _Fix:_ Factor the scope application out of send() into one helper (`applyScope(outgoing, parsed) -> {ok, text, fileIds}`) and call it from send, editAndResend and regenerate alike — including the refusal path, so a rewritten question under a page scope whose text cannot be read is refused with the question put back in the box rather than quietly downgraded.

- **[P2·honesty]** "Undo edit" is attributed by a global file-updated bucket, so it can offer to revert the user's OWN spreadsheet edit as a change the answer made
  `src/workspace/chatActions.ts:226` — editedRef is a single global Set filled by the `file-updated` event, which carries no run or chat identity and is emitted by user-initiated writes as well as agent writes. Whatever is in it when a turn ends is stamped onto that turn's last assistant message as undoByMsg, and ChatPane renders "Undo the file change this answer made". Pressing it calls restoreFileVersion on the newest version of each file — rolling back an edit the AI never made, under a label that says it did. The same bucket also cross-attributes between two chats running at once (the app explicitly supports concurrent runs: finishRun "no other conversation's in-flight turn is touched").
  _Fix:_ Give the attribution the same identity discipline the ask-* events already have: emit file-updated through TurnId::emit (or add the run/chat ids to its payload) and have the listener file the id under that run's chat, dropping ids from writes that belong to no run. At minimum, key editedRef by chatId and only record ids while that chat has a live run and the write came from a tool, not from the viewer.

- **[P2·data-loss]** A turn that only RENAMES a file gets an Undo edit chip that rolls the file's content back to an unrelated older version
  `src-tauri/src/commands/agent.rs:3886` — After an answer that merely renamed a file, the chat shows Undo edit. Pressing it does not undo the rename - it restores the file's newest CONTENT version, which belongs to some earlier turn or save, silently reverting text this answer never touched, while the toast says Change undone.
  _Fix:_ Send the created version id with file-updated (null for a rename/move) and have chatActions collect {fileId, versionId} pairs, dropping ids with no version; undoEdits then restores those exact ids and a rename-only turn correctly offers no chip (or an undo that renames back).

- **[P2·data-loss]** write_file with a missing or empty content blanks the file - the guard the scratch-pad path applies by hand
  `src-tauri/src/commands/agent.rs:3239` — A malformed model call (write_file{name:'notes.md'} with no content, or content:'') truncates the named file to zero bytes and is reported as a successful rewrite.
  _Fix:_ Refuse an empty/whitespace-only content in plan_write_file with an EditError worded like the pad's ('nothing was generated ... it was left as it was'), and require an explicit flag or a forced preview card for a deliberate blanking.

- **[P2·privacy]** An answer in flight is written into the NEXT room when a second .roomai is opened over the first
  `src-tauri/src/commands/agent.rs:1386` — A straggler turn's assistant row (text, sources, effects) can be inserted into a DIFFERENT room's encrypted database as an orphan row keyed by the previous room's chat id — content crossing the room boundary onto disk.
  _Fix:_ Capture `state.room_epoch()` and the room path at the top of `ask` and re-check both inside `persist_assistant_reply` before inserting; on a mismatch drop the write and return the in-memory Message, exactly as the existing `None` branch does. Same pin the OCR/STT/video lanes already use.

- **[P3·perf]** The per-turn skills preamble is unbounded — every enabled general skill's full description goes into every question
  `src-tauri/src/commands/agent.rs:1005` — Every enabled general skill's full description is prepended to every single question with no cap on count or total size, so a room with many verbose skills spends a large fixed share of each turn advertising them — and on a local model the retrieved file context is what the fit-to-window trim drops.
  _Fix:_ Clamp each advertised description (e.g. `clamp_chars(desc, 200)`) and the assembled preamble as a whole (a few KB via `clamp_bytes`), and if the list is cut say so in the preamble and in the Skills UI ('only the first N enabled skills are advertised each turn').

- **[P3·dead-code]** search_room's already-injected-chunk exclusion is dead: injected_rowids is computed, threaded, then discarded
  `src-tauri/src/commands/agent.rs:1223` — CHG-16's exclusion never happens on any live path: search_room re-returns the same chunks already sitting in the prompt, and its "the best matches are already in the excerpts above" branch can never fire.
  _Fix:_ Pick one and do it fully: either carry the run's rowids on the bridge (store them in StartOpts/EffectsSink and pass them at room_mcp.rs:1639/1684), or delete injected_rowids, the `_injected_rowids` parameter, retrieve_context_excluding's exclusion argument and the unreachable branch, and stop telling the model in the tool description that the excerpts are excluded.

- **[P3·dead-code]** set_cells' documented legacy single-cell fallback is unreachable — the central required-arg guard rejects the call first
  `src-tauri/src/commands/agent.rs:3289` — The commented "legacy single top-level cell/value for older prompts" fallback in set_cells cannot serve the shape it documents; a model emitting {name, cell, value} gets a required-arg error.
  _Fix:_ Delete the fallback block and its comment (the required-arg error already tells the model exactly what to send), or, if the legacy shape must keep working, exempt set_cells from the central guard and let the arm decide when updates is genuinely absent.

- **[P3·honesty]** edit_file always tells the model The user sees the updated file.
  `src-tauri/src/commands/agent.rs:3173` — The success string asserts something the backend cannot know - the file is usually not open, and when it is open with a dirty buffer the viewer deliberately does not reload - so the answer tells the user to look at a change they cannot see.
  _Fix:_ Say what is knowable - 'Saved to the room; it is in the file's History and can be undone' - and claim visibility only if the arm is given the currently-open file id (the ask already carries viewing).

- **[P3·concurrency]** The per-turn edited-files set is global, so concurrent chats lose or misattribute the Undo chip
  `src/workspace/chatActions.ts:144` — Starting a turn in a second chat wipes the first chat's record of what was edited (its Undo chip never appears), and a background job's writes land on whichever chat finishes next.
  _Fix:_ Key the set by chat/run id (Record<string, Set<string>>, cleared only for the starting chat) and stamp file-updated with the run that caused the write.

- **[P3·correctness]** The room-lock poison guard is bypassed by ~180 production call sites, so one panic still bricks most room commands
  `src-tauri/src/commands/agent.rs:1490` — After any panic taken while the room mutex is held, every command that locks the room directly panics for the rest of the session: window up, nothing works, nothing explained — the failure the poison guard and its test claim to have removed.
  _Fix:_ Make `AppState.room` private, route every access through `room_guard()`/`with_room()`, and add a source-scanning test (the pattern sidecar_lifecycle.rs:527-544 and menu.rs already use) that fails on any new `.room.lock().unwrap()` outside commands.rs.

- **[P3·concurrency]** The composer is not blocked during a context handoff, so a turn can start against a conversation that is mid-compaction
  `src/workspace/chatActions.ts:401` — handoffContext refuses to start while a turn is running (`if (!s.activeChatId || s.asking || s.handoffStarting) return;`), but send() checks only s.asking — a handoff registers no run, so the composer stays live and Enter starts a full turn while "Summarizing…" is on screen. The two then race over the same chat: the turn's history read (db::recent_messages) and the handoff's marker insert are separate room-lock acquisitions, so the question can be saved before the marker and its answer after it, leaving a question stranded above the compaction cut with its answer below — and the recap that becomes the model's whole memory of the chat never saw that question.
  _Fix:_ Add s.handoffStarting to send()'s guard (and to regenerate/editAndResend, which have the same asymmetry), so the composer is refused for the duration of a compaction the same way Hand off is refused for the duration of a turn.

- **[P3·privacy]** The live guard's request-scoped rules are restored into tool arguments but are invisible to the Rust web seam
  `sidecar/arcelle_sidecar/chat.py:732` — With concept rules configured ("my health", "my kids") and a cloud model, the sidecar's live guard mints request-scoped `[Hidden N]` rules for what it finds in the typed question, and restores them to their real values in the model's tool-call arguments before dispatch. If the model then calls `web_search` or `fetch_page` with that argument, the Rust web seam — which is supposed to stop exactly this — does not mask it, because it only knows the room's DURABLE entity map.
  _Fix:_ Either do not restore ephemeral (concept-guard) rules into arguments of tools that leave the machine, or return the request-scoped rules to the host with the tool call so `mask_outbound_web` / `outbound_url_hides` can see them. The cheap version: mark ephemeral placeholders and have the sidecar refuse to restore them in `web_search` / `fetch_page` / `browse_open` arguments.


### Create / Studio (16)


- **[P2·correctness]** A partial media-catalogue load empties one whole Create tab and blames the models for it
  `src-tauri/src/commands/media_limits.rs:135` — When exactly one of /videos/models and /images/models answers, the other medium's models are all dropped from the Create shelf and listed under an exclusion row that asserts the provider's media endpoints do not serve them — a fact the room never established. Cached for an hour.
  _Fix:_ Track loadedness per table (`images_loaded` / `videos_loaded` set inside ensure_media_limits, held next to the cache) and pass the flag for the model's own medium into the drop_unserved predicate, so an image model is only judged against a table that actually arrived. Reset `fetched_at` to None when EITHER fetch failed, so the next open retries rather than sitting on half a table.

- **[P2·privacy]** Story picture thumbnails survive a room lock in process memory
  `src-tauri/src/commands/story.rs:107` — Locking a room leaves downscaled JPEGs of its pictures in a process-global map for the rest of the session, contrary to the teardown block's own stated invariant, and the map grows across every room opened without a cap.
  _Fix:_ Add `pub(crate) fn clear_thumbs()` in story.rs and call it from the same teardown block in rooms.rs alongside clear_media/clear_peaks/clear_slides. Cap the map's size and drop an entry when its file is trashed.

- **[P2·perf]** The cast strip issues one whole-room thumbnail build per cast member
  `src/workspace/create/StoryTab.tsx:526` — Opening Story with N cast members fires N+1 concurrent whole-room thumbnail builds; on a cold cache each decodes and re-encodes up to 150 images and takes the room lock once per file, so the first paint of the cast strip is delayed by redundant work that scales with the cast.
  _Fix:_ Fetch the thumbnails once in StoryTab (or a shared context) and pass a `Record<fileId, thumbB64>` down to HeroFace, exactly as Canvas and FilmReview already do.

- **[P2·correctness]** A fifth cast member on a shot is silently truncated but stays ticked in the UI
  `src-tauri/src/commands/story.rs:305` — Pressing a fifth cast chip on a shot leaves the fifth person highlighted in the row while the room stored only four; the review sheet lists four, and the fifth person's portrait and name are never sent.
  _Fix:_ Either refuse past MAX_SHOT_CAST with a message the row can show, or return the stored shot from story_update_shot and reconcile ShotRow's local state on prop change (`useEffect(() => setCastIds(shot.castIds), [shot.castIds])`).

- **[P2·ux-defect]** A first frame stays attached and billed after switching to a model that takes none
  `src/workspace/create/CreatePage.tsx:804` — Switching the video model to one with no first_frame slot hides the attached picture and its only Remove control while keeping it in state: the privacy notice miscounts what will be sent, and Make it fails telling the user to clear a picture the UI no longer shows.
  _Fix:_ Clear `frame` in the same effect that clears resolution/aspectRatio whenever `takesFirstFrame(selected)` is false — or keep the Attached tile rendered with its Remove button under a "this model will ignore it" note, so `sending` and the button stay truthful.

- **[P2·ux-defect]** The Story tab is unreachable whenever no provider catalogue loads
  `src/workspace/create/CreatePage.tsx:214` — With no provider connected, offline, or after a catalogue fetch failure, purely local work already stored in the room (cast, shot lists, shape) becomes unreachable — the page shows only the empty-shelf notice.
  _Fix:_ Render the tab row and the Story branch outside the `models.length === 0` guard (EmptyShelf can stay as the Images/Video worktable's content), and let the per-shot model dropdowns be the thing that reports the empty shelf.

- **[P2·privacy]** Stop on a podcast recording stops nothing — every remaining line still goes to Microsoft
  `src-tauri/src/commands/studios/podcast_audio.rs:105` — Stop on the 'Podcast episode' job card is inert for the whole synthesis: the card keeps showing the running state, and the sidecar keeps sending every remaining script line to Microsoft's Edge TTS service after the user asked it to stop. It only flips to 'Paused' once the finished WAV comes back.
  _Fix:_ Two halves, and only both together make Stop honest: (1) host — `sidecar_json_cancellable("/tts/podcast", &body, &cancel)` and treat `Ok(None)` as the cancelled path, so the card flips promptly; (2) sidecar — wrap the call in `until_hangup(request, tts_mod.synthesize_podcast(...))` like /generate_doc and the file-pass windows, so the hangup actually ends the per-turn Edge calls. Then fix the server.py:815-818 docstring, which today asserts the behaviour neither side implements.

- **[P2·data-loss]** Renaming podcast hosts rewrites turns sequentially, so a name swap collapses every line onto one speaker
  `src-tauri/src/commands/studios/podcast_audio.rs:326` — Swapping two hosts' names in the podcast panel and pressing 'Save cast' rewrites every turn's speaker to a single name. The stored transcript then attributes every line to one person and the next recording uses that host's voice for the entire episode.
  _Fix:_ Build the old→new mapping from `current.cast`/`cast` first, then apply it once per turn against the ORIGINAL speaker string (single pass, first match wins). While you are in that guard at 318, also reject a cast whose names collide case-insensitively — duplicate names are accepted today and collapse the cast at render time (see the separate missed finding).

- **[P2·correctness]** Every keystroke in the shot-list title or logline is a round-trip that rewrites the whole board — characters get dropped
  `src/workspace/create/StoryTab.tsx:1065` — The list title and logline are controlled inputs bound to server state and written on every keystroke through an async command plus a full board reload, so fast typing races the reload: React re-renders the input with the stale `current.title` that came back from the DB and the characters typed since are lost. Each keystroke also flips the tab-wide `busy` flag, disabling every button and select in the Story tab for the duration.
  _Fix:_ Keep the field in local state and commit on blur or after a debounce (the shot's action input already uses `onBlur={() => action !== shot.action && save({action})}` — do the same here), and do not route a title edit through the tab-wide `busy`/full-board reload.

- **[P2·correctness]** A model listed by BOTH media catalogues loses its durations and frame slots — the image parse overwrites the video entry
  `src-tauri/src/commands/media_limits.rs:207` — `parse_video_models` runs first and `parse_image_models` runs second into the SAME map, and the image parser inserts a fully-formed `MediaLimits` with `durations: Vec::new()` and `frame_images: Vec::new()` (media_limits.rs:209-218). Any slug that appears on both `/videos/models` and `/images/models` therefore ends up with its video facts erased: no legal lengths (so the Create page offers no seconds picker) and — worse — an EMPTY frame list, which the generate path reads as a published 'this model takes no starting picture'.
  _Fix:_ Merge instead of overwrite: in `parse_image_models`, look up the existing entry and fill only the image-side fields (`resolutions`/`aspect_ratios` when the video entry published none, plus `max_references`), leaving `durations`, `frame_images` and `generate_audio` intact. Add a test with one slug present in both fixtures asserting durations and frame slots survive.

- **[P3·ux-defect]** A cast portrait older than the 150 newest room images renders as a permanent blank face
  `src/workspace/create/StoryTab.tsx:531` — In a room with more than 150 images, a cast member whose face is an older picture shows an empty square in the cast strip forever, indistinguishable from "still loading".
  _Fix:_ Add a by-ids thumbnail command (`story_thumbs(file_ids)`) and use it for the cast strip instead of searching the newest-150 list; at minimum distinguish "loading" from "not in the picker's window" so the strip can say which.

- **[P3·honesty]** A one-shot list claims the chosen clip model takes no starting picture
  `src/workspace/create/StoryTab.tsx:1209` — A shot list with exactly one shot displays a hint stating a capability fact about "the clip model chosen here" that the code never evaluated, and which contradicts the catalogue for most models.
  _Fix:_ Split the conditions: when `board.shots.length < 2` render nothing (or "nothing to join yet"); emit the capability sentence only when a receiver model was actually inspected and found to lack first_frame, and name it.

- **[P3·ux-defect]** Applying a script split with no models chosen writes shots that nothing can make
  `src/workspace/create/StoryTab.tsx:896` — "Add N shots" is enabled with both model dropdowns still on "— pick —", writing up to 80 shots with empty models that both Draw them and Film them refuse wholesale.
  _Fix:_ Disable Add until both models are chosen and say which is missing, or default them to the first entry of imageModels/videoModels as the bench does via selectedModel.

- **[P3·honesty]** Stale doc promises a per-turn progress callback the podcast job does not have; the card sits at 0/1 for minutes
  `src-tauri/src/commands/studios/podcast_audio.rs:39` — The podcast job card reads 'Reading the script…' 0/1 for the entire multi-minute build, while the function's own documentation claims a per-turn progress callback exists.
  _Fix:_ Delete the `progress` sentence (it documents a parameter that does not exist). Then either stream per-turn progress from the sidecar, or make the label state what is truthfully known — 'Recording N turns — this takes a few minutes'.

- **[P3·concurrency]** `ensure_media_limits` is not single-flighted: a concurrent caller proceeds with an empty limits table
  `src-tauri/src/commands/media_limits.rs:112` — A second Create-page open inside the (up to 60 s) fetch window returns instantly with the limits table still empty, so that page renders `limits: null` on every model — no legal durations, no resolutions, no frame-slot knowledge — until it is reloaded.
  _Fix:_ Use the same pattern as `ensure_provider_catalog`: take a `tokio::sync::Mutex` first, re-check freshness inside it, and let concurrent callers await the in-flight fetch instead of returning early.

- **[P3·correctness]** Duplicate host names are accepted and collapse the whole episode into one voice
  `src-tauri/src/commands/studios/podcast_audio.rs:318` — Two hosts can be saved with the same name (the panel lets you type it; the only guard rejects empty names). The panel then shows two rows with two different voices, but the recording resolves every line through a first-match lookup, so both hosts read in the first row's voice and the episode is a one-voice reading of a two-voice script — exactly the failure the voice-distinctness code elsewhere exists to prevent.
  _Fix:_ Reject a cast with case-insensitively colliding names in the same guard at line 318 ('Two hosts can't share a name — the lines are matched by name'), and key the panel's preview state on the host index rather than the name. Best done together with the rename-ordering fix, since a collision is the other way that bug is reached.


### Files / DB (16)


- **[P2·ux-defect]** import_files never emits room-files-changed, so every other room surface goes stale after an import
  `src-tauri/src/commands/files.rs:158` — After adding files the sidebar updates, but Home's front-page "N files" stamp and its timeline, the Scripts index and the unscanned-file privacy count keep showing the pre-import room until some unrelated write fires the event.
  _Fix:_ Emit `app.emit("room-files-changed", ())` at the end of import_files_blocking, after `drop(guard)` and after the terminal import-progress emit, exactly as import_download does at files.rs:327.

- **[P3·correctness]** organize_files silently drops an entry when its name no longer re-resolves to the same file
  `src-tauri/src/commands/organize.rs:289` — An organize plan whose earlier entry renames a file into a name a later entry uses — or that names one file twice — silently skips the later entry's move/rename: it is not done and not listed in `failed`.
  _Fix:_ Resolve once and carry the pairing: have resolve() return Vec<(entry_index, id, real_name)> and iterate that, so no name is re-resolved against a database the loop is mutating. An entry whose id was already claimed by an earlier entry belongs in `failed` with "names the same file as an earlier entry", never dropped. As a bonus this removes the O(n²) DB queries the current `find` does.

- **[P3·honesty]** move_file_to_folder accepts any folder id and any file id, and reports success either way
  `src-tauri/src/db/folders.rs:93` — Moving a file into a folder id that no longer exists reports success and leaves the file listed under no folder and not at the top level; moving a trashed or non-existent file id also reports success.
  _Fix:_ Validate the destination first (`SELECT 1 FROM folders WHERE id = ?` → "That folder no longer exists.") and run the UPDATE through execute_existing with `AND trashed_at IS NULL` → "That file is no longer in this room.". Adding `folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL` to SCHEMA makes it structural for new rooms.

- **[P3·honesty]** rename_folder reports success when the folder no longer exists
  `src-tauri/src/db/folders.rs:68` — Renaming a folder that has been removed since the sidebar was drawn changes nothing, answers Ok, toasts "renamed", and is followed by a folder list that does not contain it.
  _Fix:_ Run the UPDATE through execute_existing with "That folder no longer exists." — the name-clash path is already guarded ahead of it, so the only remaining zero-row cause is a missing folder.

- **[P3·correctness]** delete_folder reports success for a folder id that does not exist, and its two writes are not one transaction
  `src-tauri/src/db/folders.rs:78` — Deleting an already-deleted folder answers Ok, so the UI reports a removal that did not happen; and a failure between the two statements leaves the folder in place with its files emptied to the top level.
  _Fix:_ Wrap both statements in db::in_transaction and make the DELETE execute_existing with "That folder no longer exists."; the UPDATE's zero-row case stays legitimate (an empty folder).

- **[P3·correctness]** organize_files' blast-radius cap covers only file entries — make_folders and remove_folders are unbounded
  `src-tauri/src/commands/organize.rs:247` — One organize_files call can create or delete an unbounded number of folders, and the receipt does not say anything was capped because nothing was.
  _Fix:_ Truncate both folder lists to MAX_BULK_FILES the way `plan` is truncated and add the dropped counts into report.capped, so the receipt keeps saying so.

- **[P3·dead-code]** folder_id_for's create=false branch is unreachable dead code
  `src-tauri/src/commands/organize.rs:130` — A parameter and a match arm no caller can reach, carrying an empty-string folder-id sentinel that would be a dangling id if anything ever did reach it.
  _Fix:_ Drop the `create` parameter and the `None =>` arm; the function becomes plain get-or-create and the dry-run path already returns before calling it. Keep the doc comment's explanation of why previews must not create folders — that history is worth more than the branch.

- **[P3·data-loss]** store_file_bytes is not atomic: a failed save still cuts a version and can evict the oldest one
  `src-tauri/src/commands/files.rs:826` — When the content write fails, the file is unchanged but its history has gained a duplicate snapshot of the current bytes and, at the 10-unpinned-version window, silently lost the oldest one — while the command reports that nothing was saved.
  _Fix:_ Wrap the pair: `db::in_transaction(conn, || { db::snapshot_file_version(conn, id, cause)?; db::update_file_content(conn, id, bytes, text) })`.

- **[P3·honesty]** room_file_count's doc claims the Library badge shares its definition; the badge uses a different one
  `src-tauri/src/db/files.rs:144` — A documented invariant that section-only files made false, so a reader auditing "do all the count surfaces agree?" is told by the source that they do.
  _Fix:_ Pick one: either add the library_visibility predicate to the surfaces that claim to show "the Library" (see finding 3's fix), or correct the comment and the front_page.rs test label to say room_file_count answers "what is in this room" and name the single surface that answers "what the Library lists".

- **[P3·ux-defect]** A skipped duplicate import is reported through the error channel and toasted red as a failure
  `src-tauri/src/commands/files.rs:90` — Re-dropping files the room already holds produces red error toasts, and with more than three of them a single toast reading "N files could not be added" — for a duplicate check that did exactly its job.
  _Fix:_ Add `skipped: Vec<String>` to ImportReport (and to the TS interface at apiTypes.ts:218) for files already present, and report it as an info toast ("4 files were already in this room"), leaving `errors` for real failures.

- **[P3·correctness]** Import stores the file name verbatim, so two same-named files are indistinguishable
  `src-tauri/src/commands/files.rs:130` — Two different files imported under the same name produce two identical-looking Library rows, and every name-taking agent verb resolves only to the newer one, so the older file cannot be acted on by name.
  _Fix:_ Treat it as a resolution problem, not a naming one: when a fuzzy resolve matches more than one live row, return the ambiguity to the caller ("2 files match \"report.pdf\" — say which, e.g. by folder or date") instead of silently taking the newest. If the owner would rather disambiguate at write time, route the import name through db::available_name(&room.conn, &file_name) before insert_file — but note that alone does not fix the resolver.

- **[P3·ux-defect]** Dropping a FOLDER onto the window fails with a raw errno per folder and imports nothing
  `src-tauri/src/commands/files.rs:82` — Dragging a folder of documents onto the room — the obvious way to add a set of files — imports nothing and produces a red toast reading e.g. "Invoices: Is a directory (os error 21)". Drag a folder plus three files and the whole drop is reported through the same channel with the OS's words.
  _Fix:_ In import_files_blocking, branch on std::fs::metadata(..).is_dir(): either walk it one level (or recursively, skipping dotfiles) and import the files inside, counting them into `total` for the progress strip, or — if folder import is deliberately out of scope — replace the errno with a sentence the user can act on ("Folders can't be added yet — drop the files inside it."), and route it through the `skipped` channel proposed for duplicate imports rather than `errors`.

- **[P3·correctness]** merge_files writes its output under a fixed name with no available_name, so repeated merges pile up identically-named files
  `src-tauri/src/commands/organize.rs:481` — Running merge_files twice without naming the output (or twice with the same `into`) leaves two — then three — Library rows all called "Merged notes.md", with different content and no way to tell them apart; every later name-based verb reaches only the newest, so the earlier merge is unreachable by name.
  _Fix:_ Route the computed name through db::available_name(conn, &name) before db::insert_file in merge (organize.rs:481), and report meta.name in the receipt (it already does — `meta.name`, so the sentence stays true automatically). Do the same in save_generated_impl. Unlike the import case, these names are chosen by the app, which is exactly the population available_name's doc scopes itself to.

- **[P3·correctness]** No embedding-model or dimension check on room open: a width change silently kills vector recall
  `src-tauri/src/db/embeddings.rs:126` — If the vectors behind the `nomic-embed-text` tag ever change width, every previously embedded chunk scores 0.0 forever and is never re-embedded, with nothing shown to the user and no failure anywhere in the logs.
  _Fix:_ Stamp `embed_model` and the OBSERVED `embed_dim` on the first successful embed (not a hardcoded 768), compare both on room open, and set `chunks.embedding = NULL` for the room when either changed so the existing backfill re-drains them.

- **[P3·data-loss]** Editing a memory that no longer exists reports success and silently discards the text
  `src-tauri/src/db/memories.rs:117` — Saving an edit to a memory that was trashed while the card was open reports success and the typed text disappears from the page — and silently reappears if the memory is ever restored.
  _Fix:_ Scope the UPDATE with `AND trashed_at IS NULL` and use execute_existing with a message like "That memory is not in this room." — the guard is what catches this case; the row-count check is what makes the guard speak.

- **[P3·correctness]** `db::update_memory` has no trash filter, and the by-id trash guard test only scans the files table
  `src-tauri/src/db/memories.rs:109` — `UPDATE memories SET content = ?2, category = ?3 WHERE id = ?1` will happily overwrite a soft-deleted memory. Latent today because both callers resolve ids through filtered queries, but it is exactly the invariant the codebase enforces for files, and it becomes live the moment the missing restore/trash surface (finding 1) starts handing out trashed ids.
  _Fix:_ Add `AND trashed_at IS NULL` to the UPDATE at db/memories.rs:117 (the `execute_one` helper already turns 0 rows into an error, so the caller gets the same honest refusal `delete_memory` gives). Then widen the guard test at db/files.rs:1995 to cover `from memories`/`update memories` by-id statements, or it will keep passing over this file.


### Browser (15)


- **[P2·security]** A trailing dot on a hostname defeats both the local-name guard and every private-range content rule
  `src-tauri/src/web/guard.rs:46` — `check_public_http_url` accepts `http://localhost.:11434/...` and no content-rule filter matches it. Everywhere the literal check is the ONLY layer — `download_allowed` — a page can start a download from a service on this Mac; everywhere else a DNS recheck catches it (after the request has left, for top-level navigation).
  _Fix:_ Normalise before comparing in `check_public_http_url`: `let host = host.trim_end_matches('.')` (do it once, before the localhost/.local/IpAddr tests). Add the dotted spellings to PRIVATE_URL_FILTERS (`^https?://localhost\.[:/]`, `^https?://localhost\.$`, `^https?://[^/]*\.local\.[:/]`, `^https?://[^/]*\.local\.$`) and bump RULE_LIST_ID to v4 — every filter there must stay inside WebKit's accepted subset or the whole list fails silently. Extend `private_filters_match_exactly_the_hosts_the_guard_rejects` with the dotted spellings; it passes today only because it tests canonical ones. Separately, give `download_allowed` the same `resolve_public_addr` backstop the other three callers have.

- **[P2·privacy]** A revealed password field is not fenced, and its value is put into the snapshot the model reads
  `src-tauri/src/browser/page.js:191` — After the site's own "show password" toggle sets `type="text"` on a field whose only credential signal is `name`/`id`, the field gets a ref, its plaintext value appears in `browse_snapshot`'s output as `(has "…")`, and `browse_do {"type":…}` on it is accepted — while the tool spec (commands/browse.rs:90) promises "Password fields are never listed: they are fenced".
  _Fix:_ Two independent changes, because they close different halves. (1) In `isSecret`, substring-match the hint rather than tokenise it: `/passwo?rd|passwd|one-time-code|\botp\b/`. (2) In `stateFor`, never emit the literal value for a credential- or PII-shaped control — check name/id/autocomplete against password/cc-*/ssn/national-id and push `filled`/`empty` instead. (2) is the one that holds even when (1)'s heuristic misses.

- **[P2·security]** ensure() navigates a page whose content rule list has not been attached yet
  `src-tauri/src/browser.rs:541` — A page navigated while its predecessor's rule list is still compiling loads its opening burst of requests — trackers and private-range sub-resources alike — with no content blocker attached, and nothing says so; the shield only reports `Unknown`, which the chrome renders as "not yet", not as "this load was unprotected".
  _Fix:_ In `ensure`, when the active page still has a live `deferred_since` (or `protection == Unknown`), route through the attach path instead of navigating: `attach_rules(app, id, ThenGo::Navigate(url))`, which replaces the deferred destination and still fires the navigation from inside the completion handler. Add a unit test on the `deferred → ensure` transition next to the existing `should_go_after_rules` cases.

- **[P2·correctness]** click_at takes CSS pixels but browse_look hands the model an image rescaled with no scale note
  `src-tauri/src/commands/browse.rs:809` — Coordinates read off the `browse_look` image land on the wrong element (or off the page, returning "Nothing is at (x, y)") — defeating the one interaction (canvas, map, custom widget) the picture exists to enable.
  _Fix:_ Carry the mapping instead of leaving the model to guess it: record the capture's `image_px / css_px` factor in `BrowserState` when `look_png` runs, and divide `click_at`'s x/y by it in Rust before the action reaches the page script (silently correct, no prompt budget). If that is too stateful, state it in `browse_look`'s result text — "the picture is N px wide, the page is M CSS px wide; multiply picture coordinates by M/N" — and say the same in the `click_at` spec.

- **[P2·privacy]** A numeric `text` in a type action bypasses the outbound consent door entirely
  `src-tauri/src/commands/browse.rs:357` — The agent can type an account number, phone number, ID number or any other numeric room content into a web form with NO consent card and NO journal line, simply by emitting the value as a JSON number instead of a JSON string.
  _Fix:_ Coerce in `typed_texts` the same way the page script does, instead of demanding a string: accept `Value::String`, `Value::Number` and `Value::Bool` (`serde_json::Value::as_str().map(str::to_string).or_else(|| matches!(t, Number|Bool).then(|| t.to_string()))`), and reject any other shape with an explicit error rather than silently skipping it. Add a unit test alongside `typed_texts_finds_every_type_action_in_a_batch` covering a numeric and a boolean `text`.

- **[P2·correctness]** A tab switch during an agent action is reported to the model as "the page navigated", with another page's URL and snapshot
  `src-tauri/src/browser.rs:1440` — If the user selects a different tab while `browse_do` is running, the model is told "The first action loaded a new page, so any later actions in that batch did NOT run. You are now on <the other tab's URL>" and is handed the other tab's snapshot — a fabricated account of what happened, on a page the action never touched.
  _Fix:_ Bind an in-flight async op to the page it was started on: capture the active page id before `begin` and have `call_async` (and its `call("take")`/`doc_id`/`wait_ready` hops) use `webview_of(app, &id)` rather than `webview(app)`. If the page is gone, that is a real error; if the ACTIVE page merely changed, the op is still valid and the report stays about A. As a smaller stopgap, compare the active id before and after and report a tab switch as itself rather than as a navigation.

- **[P3·correctness]** A sub-frame navigation permanently retitles a BACKGROUND tab; only the active page ever self-heals
  `src-tauri/src/browser.rs:455` — A background tab's row in the strip shows a late-loading iframe's host (a consent wall, a YouTube/Disqus embed) with its real `<title>` cleared, and stays wrong until the user selects that tab and waits one poll.
  _Fix:_ Cheapest correct fix: only accept a recorded URL for a background page when it is same-origin with the destination that page was actually sent to (compare against the existing `page.url`'s origin), which lets same-site redirects through and rejects third-party frames. Better but larger: a `on_new_window`/custom-delegate route that exposes `navigationAction.targetFrame.isMainFrame`, or extend the info poll to every open page on a slower beat.

- **[P3·security]** The private-range content rules only anchor on http/https, so ws:// sub-resources to local services are unblocked
  `src-tauri/src/browser/rules.rs:151` — A page can run `new WebSocket("ws://127.0.0.1:PORT/")` against every port on this Mac and time the failures to enumerate local services; nothing in the guard or the rule list is consulted.
  _Fix:_ Add `wss?://` variants of the private-range filters and bump RULE_LIST_ID to v4 — but verify the compile, do not assume it: per the WebKit rule-list lesson in this repo, one pattern outside `URLFilterParser`'s subset kills the WHOLE list silently with `WKErrorDomain error 6`, and `wss?` is a quantifier on a single character (accepted) whereas anything fancier is not. Extend `private_filters_match_exactly_the_hosts_the_guard_rejects` with ws/wss spellings so the two layers stay one policy, and check the compiled list actually attaches (Protection::Active) before shipping.

- **[P3·ux-defect]** Every tab gets its own ephemeral cookie jar, so "Open in a new tab" always lands logged out
  `src-tauri/src/browser.rs:600` — Signing in on one page and then opening a link in a new tab lands anonymous, with no explanation anywhere in the UI; going back to the first page shows the session is still live there.
  _Fix:_ Say it where it is met rather than engineering around it: a one-line note on the new-tab control and in the start-screen copy that each page is its own private session. If sharing is wanted, it needs a wry/tauri change to inject one `WKWebsiteDataStore` across the child webviews — and `verify_ephemeral` must keep asserting non-persistence against the shared store, or the privacy invariant quietly weakens.

- **[P3·dead-code]** canGoBack is computed by the page script, dropped by Rust, and Back/Forward are enabled unconditionally
  `src-tauri/src/browser/page.js:1376` — Back and Forward are always clickable while any page is open, including a page with no history entry, where pressing them does nothing and says nothing. The fact needed to disable them is measured on every 1.2 s poll and discarded.
  _Fix:_ Pick one: forward canGoBack/canGoForward through browser_info into BrowserInfo and add them to ChromeAbilities, or delete the field from page.js and its test so the poll stops paying to compute an answer nobody reads.

- **[P3·correctness]** browse_find silently re-snapshots and invalidates every ref once the marked controls have scrolled out of the visibility band
  `src-tauri/src/browser/page.js:871` — When `browse_find` falls back to a full re-snapshot it silently renumbers the page while returning only the matches, so the model's earlier ref list now points at different elements — a subsequent `browse_do` acts on the wrong control and reports it as a success (the label in `did` is the only clue).
  _Fix:_ Gate the fallback on the registry, not on the filtered result: `if (registry.size === 0) { …snapshot… }`, otherwise answer with `matches: []` and let the Rust side's existing "take a fresh browse_snapshot" wording (commands/browse.rs:596-601) do its job. Independently, make `resolve` refuse a ref issued under an older `generation` so any silent renumbering fails loudly instead of acting on the wrong element.

- **[P3·correctness]** create()'s window-size viewport fallback is dead code — reposition parks the brand-new page at 1×1 in the same call
  `src-tauri/src/browser.rs:576` — The documented promise that an agent-opened page "never lays out at a fictional width" is not kept: when the browser area has never mounted, the page is created at window size and then immediately resized to 1×1, so it loads and lays out at a one-pixel viewport — the exact degenerate width the fallback was written to avoid.
  _Fix:_ Make the two agree. Either have `reposition` fall back to the same measured window rect `create` computes (extract it into one `default_bounds(app)` helper used by both), or delete the fallback in `create` and correct its comment to say a page opened with no measured area is parked until the area mounts. Whichever is chosen, `browse_open` should emit its reveal event before `wait_ready` so the area mounts and reports a real rect while the page is still loading, rather than after it.

- **[P3·correctness]** A same-document navigation mid-batch is reported to the model as a failed action, and pays for a screenshot
  `src-tauri/src/browser/page.js:1254` — When an action succeeds and the page changes URL within the same document (hash change, SPA pushState), the model is told "An action failed, so a picture of the page … is attached" and an image is billed into the turn — when in fact every action that ran succeeded and the batch was cut short on purpose.
  _Fix:_ Distinguish "cut short" from "failed" in the return: add `skippedFrom` (or set the existing `navigated: true`) when the batch stops because the URL changed, and in commands/browse.rs attach the failure picture only when some result actually has `ok:false` — i.e. test the results array rather than the batch-level `ok`.

- **[P3·correctness]** wait_for {gone: …} reports success instantly for any ref it does not know, and words it as the opposite
  `src-tauri/src/browser/page.js:1200` — `{"wait_for": {"gone": "e9"}}` returns immediately and claims success whenever the ref is not in the registry — including a typo, a stale number, or a ref invalidated by an earlier action — so "wait until the spinner disappears" succeeds without waiting for anything. The `did` string then says the opposite of what was asked: "waited until it appeared".
  _Fix:_ Require the ref to have been live when the wait started: capture `resolve_(spec.gone)` once before the interval and return `{found:false, error:"e99 was not on the page to begin with"}` if it was already absent, so "gone" means "went away". Word the result per spec shape ("waited until it disappeared" / "…but it was still there"), and either document `gone` in the `browse_do` spec or drop it.

- **[P3·correctness]** `browse_look` and the failed-action snapshot attach pixels regardless of whether the chat model can see
  `src-tauri/src/commands/browse.rs:708` — The browser's two picture paths push the PNG unconditionally and tell the model it is looking at the page, even when the chat model is text-only. A text-only room therefore gets no picture and no substitute — the graceful degradation every other perception tool has (a LOCAL vision model describes the image and the description becomes the tool result) never happens here, and the model is told it is "looking at" a page it received nothing about.
  _Fix:_ Route both browse pixel paths through `perceive_image` (or gate them on `effects.vision_chat` and fall back to the local vision-model description), so every tier degrades the same way and no tool result claims sight the model does not have.


### MCP / Connectors (15)


- **[P2·security]** Per-connector permission grants (and the session "always allow") are keyed by name and survive removal, re-applying to a different connector
  `src-tauri/src/commands/mcp_cmds.rs:1563` — Removing a connector leaves its 'run without asking' / 'send real values' overrides behind, keyed only by name. A later connector that lands on the same config key silently inherits both grants and the Connectors row states them as deliberately set ('set here, so the setting above doesn't apply').
  _Fix:_ On `mcp_remove_server`, `agent_delete_mcp`, and the retarget branch of `agent_save_mcp`, drop the server's entry from `mcp_connector_powers` (and persist) and from `state.mcp_session_ok`. Better: key the overrides on `mcp::config_key(cfg)` (or name+config_key) so a grant cannot follow a name onto a new destination.

- **[P2·ux-defect]** An access token that expires on a live connection is never refreshed, and the 401 tells the user to press a button the drawer disables
  `src-tauri/src/commands/mcp_cmds.rs:598` — About an hour into a session, every call to a remote OAuth connector fails with 'this connector needs you to sign in … click "Connect account"', while the Connectors row still says connected and the drawer shows 'Signed in' with Connect-account greyed out. The stored refresh token is valid throughout.
  _Fix:_ Run `refresh_if_expiring` before each remote `call_tool` (or on a per-connection renewal timer), and on a 401 from a connector whose stored set `can_refresh`, refresh + retry once before surfacing an error. Separately, `auth_error_message` should not name a button that `mcp_oauth_status` will have disabled — mention Sign out, or make the button live whenever the last call 401'd.

- **[P2·security]** Marketplace icon fetch is an unguarded SSRF: registry-supplied URLs are fetched with no private-address check
  `src-tauri/src/commands/mcp_registry.rs:347` — Browsing the connector marketplace makes the app issue GETs to whatever address a registry record names, including loopback and RFC1918 hosts, and follow redirects to them.
  _Fix:_ Call `crate::web::check_public_http_url(url)` at the top of `fetch_icon` and refuse what it rejects; build the icon client with `redirect::Policy::none()` (or re-check every hop the way web/fetch.rs:139 does).

- **[P2·privacy]** OAuth sign-in requests every scope the authorization server advertises
  `src-tauri/src/commands/mcp_oauth.rs:622` — The provider's consent screen asks the user to grant Arcelle the union of everything the authorization server supports — write and admin scopes included — for a connector that may only need to read, and the stored token then carries all of them.
  _Fix:_ Parse `scopes_supported` from the Protected Resource Metadata document and thread it into `authorize`; when the PRM has none, omit the `scope` parameter entirely (the AS then applies its own default) rather than requesting the AS-wide superset.

- **[P2·correctness]** RFC 8414 discovery URL is built by appending, so any issuer with a path component fails sign-in
  `src-tauri/src/commands/mcp_oauth.rs:368` — 'Connect account' dies with '…/.well-known/oauth-authorization-server returned HTTP 404' for any connector whose issuer has a path (multi-tenant Auth0/Descope/Stytch/WorkOS-style deployments) and for OIDC-only authorization servers.
  _Fix:_ Try candidates in order, taking the first that parses: path-inserted `{origin}/.well-known/oauth-authorization-server{path}`, then the suffixed form, then `{origin}/.well-known/openid-configuration{path}` and its suffixed form — each still through `checked_endpoint`. Do the same path-aware construction in `well_known_prm`.

- **[P2·honesty]** The install drawer states flatly that Arcelle redacts and asks — a claim the two connector powers can make false
  `src/settings/McpMarketplace.tsx:687` — At the moment the user decides whether to install an internet-reaching connector, the drawer promises redaction and a consent prompt that will not happen if either power is on — or, for redaction, if the room has no protected entities at all.
  _Fix:_ Pass the live `autoApprove`/`outboundUnmask` (and the per-connector override when known) into `McpMarketplace` and word the note off them the way `conn-lead` does; state the entity-map caveat rather than promising redaction unconditionally.

- **[P2·data-loss]** `mcp_oauth_authorize` writes a config snapshot taken before the browser round-trip, into whatever room is open when it returns
  `src-tauri/src/commands/mcp_cmds.rs:820` — The interactive sign-in reads the room's connector config, waits up to five minutes for the browser, then writes `merge_bearer(<that stale snapshot>)` back with an unpinned `state.with_room`. Any connector change made during the wait is reverted — and if the user switched or locked/reopened a room in that window, room A's whole connector config and room A's OAuth token are written into room B.
  _Fix:_ Pin `(room.path, state.room_epoch())` before `authorize` and re-check them inside the write closure, returning an error if they moved (copy `refreshed_oauth_config`'s guard). Re-read `MCP_CONFIG_KEY` inside that same closure instead of merging into the pre-await snapshot.

- **[P2·security]** A stored OAuth token follows a connector NAME onto a new destination — only the agent path clears it on retarget
  `src-tauri/src/commands/mcp_cmds.rs:12` — Tokens are stored under `oauth:<server name>` with no tie to the endpoint. `mcp_apply_config` — the path behind marketplace install and the Advanced editor — never clears them when the entry under that name starts pointing somewhere else, so the connect-time renewal merges a refreshed access token for provider A into a config entry that now reaches provider B, and the drawer reports 'Signed in' for a connector the user never authorized.
  _Fix:_ Clear `oauth:<name>` in `mcp_apply_config` for every server whose destination changed relative to the stored config (reuse `same_destination`), or key the token store by `mcp::config_key` so a token can never be re-attached to a different endpoint; have `mcp_oauth_status` verify the stored set belongs to the current destination before answering true.

- **[P3·crash]** The OAuth loopback callback parser panics on a `%` followed by a non-ASCII byte, killing the sign-in with no error
  `src-tauri/src/commands/mcp_oauth.rs:586` — A malformed loopback callback panics the `mcp_oauth_authorize` task; the invoke never resolves, so the drawer sits on 'Waiting for your browser…' until the user cancels, with no message and nothing written anywhere.
  _Fix:_ Decode from the byte slice rather than re-slicing the `&str`: match `bytes[i+1]`/`bytes[i+2]` against `b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F'` and combine them. Add the malformed cases to `parses_callback_query`.

- **[P3·correctness]** `run_mcp_tool` forwards `arguments` unvalidated, and a non-object silently becomes `{}` after the consent card has shown otherwise
  `src-tauri/src/room_mcp.rs:1607` — When a model emits `arguments` as a JSON string or array, the consent card shows that value but the connector is called with an empty object — the tool runs with all defaults or fails for a reason nobody can see.
  _Fix:_ Apply the same `.filter(|v| v.is_object())` to the nested `arguments` and return an `isError` tool result naming the problem instead of substituting `{}`, so the model can correct itself.

- **[P3·correctness]** A connector's `resource` content blocks are discarded as "[resource content omitted]" although their text is in the block
  `src-tauri/src/mcp.rs:338` — A connector that answers with an embedded resource hands the model the literal string '[resource content omitted]' instead of the resource's text, and the model reports the connector returned nothing useful.
  _Fix:_ Add a `Some("resource")` arm that pushes `block["resource"]["text"]` when it is a string, and names the `uri`/`mimeType` when the payload is a `blob`; treat `resource_link` as its uri. Extend `flattens_tool_result_variants` to cover both.

- **[P3·honesty]** Writing a per-connector permission grant reports success even when the persist fails
  `src-tauri/src/commands/mcp_cmds.rs:301` — If the overrides file cannot be written, the Connectors page shows the grant as stored and 'in force'; it silently disappears at the next launch, and the in-memory state disagrees with disk in the meantime.
  _Fix:_ Return `Err` from `set_mcp_connector_power` when the path or the write fails, so the existing catch re-reads the true map and surfaces it in `mcpError`; give `set_mcp_auto_approve` / `set_mcp_outbound_unmask` a `Result` return and do the same.

- **[P3·reliability]** The OAuth loopback listener accepts exactly one connection and reads it once with no timeout
  `src-tauri/src/commands/mcp_oauth.rs:528` — A browser pre-connect (an accepted socket that sends nothing) hangs the sign-in indefinitely, because only `accept` is under a timeout and the `read` that follows has none; a socket that opens and closes consumes the single accept and reports 'the sign-in did not complete (state mismatch or denied)' while the real callback then hits a closed port; and a request line over 4 KB truncates the authorization code.
  _Fix:_ Loop on `accept` until AUTH_TIMEOUT expires overall, wrapping each connection's read in its own short timeout and ignoring requests whose target has no `code`; read until the header terminator (or a bounded cap well above 4 KB) instead of a single 4 KB read.

- **[P3·correctness]** Discovery tries only the first authorization server and drops the resource path from the well-known PRM URL
  `src-tauri/src/commands/mcp_oauth.rs:363` — A Protected Resource Metadata document listing several authorization servers is reduced to its first entry with no fallback, so one unreachable or misconfigured AS blocks sign-in even when the resource offers a working alternative. Separately, the fallback PRM URL is built from the origin alone, so a server that publishes PRM under its resource path is not found when it sends no `WWW-Authenticate`.
  _Fix:_ Iterate `authorization_servers` and take the first that yields usable metadata, reporting the last error only if all fail; build the PRM candidate list path-first (`{origin}/.well-known/oauth-protected-resource{path}`, then origin-only), each through `checked_endpoint`.

- **[P3·honesty]** The tool-call consent card tells the user a LOCAL connector's arguments leave the room, contradicting the Connectors page
  `src-tauri/src/commands/mcp_cmds.rs:694` — The approval card that gates every connector call describes each one as 'a separate program that can reach the internet — what the AI sends it leaves this room', whether the connector is local or remote, because the emitted payload carries no remote flag. The Connectors page says the opposite for the same connector ('it runs on your Mac, so nothing it is told leaves here'), so the app's two consent surfaces disagree about the single fact that decides whether a call is a privacy event.
  _Fix:_ Include `remote` in the `mcp-approve-request` payload and branch the card's sentence on it — remote keeps the internet wording and names the host, local says the call stays on this Mac. While there, state whether the arguments shown are the room's real values or placeholders, which the card already has in hand (it renders the exact copy that will be sent).


### Skills (15)


- **[P2·honesty]** Enabling a skill after a failed save reports success and silently drops the edits
  `src/workspace/skills/SkillsView.tsx:411` — When the implicit pre-save fails, the user gets an error toast immediately followed by a green 'Skill enabled — its description is now available to the assistant.', the checkbox flips, and the edited instructions are replaced by the stored text — so the version now advertised to the model is not the one on screen a second ago.
  _Fix:_ Have `saveMetadata` return `Promise<boolean>` (or rethrow) and make `toggleEnabled` bail before `setSkillEnabled` when the save did not land, leaving the checkbox and the draft untouched: `if (dirty && !(await saveMetadata())) return;`.

- **[P2·honesty]** delete_skill_resource reports success for a path that was never there
  `src-tauri/src/db/skills.rs:288` — The assistant's delete_skill_resource tool answers 'Deleted references/policy.md from skill "review".' for a path the skill never had, so the model believes and reports a cleanup that did not happen.
  _Fix:_ Switch the resource DELETE to `execute_existing` with a message like 'That skill has no file at {path}.' The skill-level `delete_skill` can stay loose (its intent is already satisfied by absence).

- **[P2·ux-defect]** A missing skill resource surfaces raw SQLite text ("Query returned no rows") to both the user and the model
  `src-tauri/src/db/skills.rs:253` — A skill whose SKILL.md names a file that is not bundled makes read_skill_resource return the bare string 'Query returned no rows' to the model, and the same jargon appears as a red toast in the editor when a stale folder row is clicked.
  _Fix:_ Give `get_skill_resource` an `Option` twin (or wrap both call sites) and phrase the miss: '"{skill}" has no file at {path}.' — ideally listing the paths it does have, which read_skill_resource already has in hand via `list_skill_resources`.

- **[P2·correctness]** Folder import walks hidden directories, so importing a cloned skill repo pulls in .git / .DS_Store or fails with a misleading size error
  `src-tauri/src/commands/skills.rs:918` — Importing the normal distribution shape of an Agent Skill — a git checkout — either silently stores hundreds of .git objects and .DS_Store as encrypted skill resources (listed under 'Other files' and re-emitted on every export) or refuses the import with 'That skill folder is too large (250 files / 128 MB maximum)', which names the wrong cause.
  _Fix:_ Skip entries whose file name starts with '.' before recursing (and before counting them toward the caps) in `collect_folder_files`; if `.gitignore`-style dotfiles are wanted, allow-list them explicitly rather than walking every dot-directory.

- **[P2·data-loss]** The open editor never reloads on skills-changed, so an assistant write to the same skill is silently overwritten by the next Save
  `src/workspace/skills/SkillsView.tsx:235` — While a skill is open, an assistant save_skill / write_skill_resource on it is invisible in the editor: the Enabled toggle keeps claiming a state the backend has already flipped to disabled, the folder pane misses the new file, and pressing Save SKILL.md writes the pre-existing text back over the assistant's version with no conflict warning.
  _Fix:_ Subscribe SkillsView to skills-changed: when neither `dirty` nor `resourceDirty`, re-`load()` the open skill; when either is dirty, show a 'this skill changed elsewhere' banner with Reload / Keep-mine instead of silently winning. Server side, have `update_skill` take the `updated_at` the editor loaded and refuse a stale write with a distinct message.

- **[P2·cancellation]** A running skill script cannot be stopped — agent_run_skill_script fabricates a cancel flag that is never set
  `src-tauri/src/commands/skills.rs:703` — Pressing Stop during a turn ends the turn but does not kill a bundled skill script: it keeps running to its manifest timeout, holding a process group, a workspace of decrypted skill files, and (for uv) possibly a network install. Every other consumer of the same executor honours Stop.
  _Fix:_ Thread `exec_tool`'s `cancel: Option<Arc<AtomicBool>>` into `agent_run_skill_script` and pass it to `execute_script_in_workspace`, falling back to a fresh flag only when the caller has none (the room bridge) — the same shape `consult_advisor` already uses.

- **[P2·correctness]** A resource path that is also a directory prefix (references + references/policy.md) breaks Export folder and every script run for that skill
  `src-tauri/src/commands/skills.rs:1098` — A skill that holds both a file named `references` and any file under `references/` can never be exported and none of its scripts can run: both seams materialize resources onto the filesystem in path order, write the file first, then fail to create the directory of the same name. The export aborts with a raw OS error and deletes the destination it just made.
  _Fix:_ Reject a new resource path that is a strict prefix (at a '/' boundary) of an existing path, or vice versa, in `save_skill_resource` / `agent_write_skill_resource` / `import_into`; and make the export/materialize loops sort deepest-last and report the collision in the app's own words instead of leaking the OS error.

- **[P2·data-loss]** The assistant deleting the open skill unmounts the editor mid-edit with no prompt and no toast
  `src/workspace/skills/SkillsView.tsx:226` — While the user is typing in a skill's instructions or in one of its files, a delete of that skill from anywhere else (the assistant's delete_skill, another window) makes the whole editor vanish back to the skills list, taking the unsaved text with it and saying nothing about what just happened.
  _Fix:_ When `refreshSkills` clears a `selectedSkillId` that is currently open, push an explicit toast ('"review" was deleted — your unsaved changes were not saved') and, when `dirty || resourceDirty`, keep the text on screen in a read-only 'this skill was deleted elsewhere — copy what you need' state instead of unmounting.

- **[P3·correctness]** normalize_skill_path accepts a trailing slash, creating a nameless resource that permanently breaks Export folder
  `src-tauri/src/commands/skills.rs:299` — A resource path ending in '/' is stored verbatim, shows as a row with an empty name in the folder pane, and then makes Export folder — and running any bundled script — fail with a raw 'No such file or directory (os error 2)' that names nothing the user can act on.
  _Fix:_ In `normalize_skill_path`, rebuild the path from its `Component::Normal` parts joined with '/' instead of returning `raw`, and reject a path whose trimmed form ends in '/'. Add the trailing-slash case to the `paths_cannot_escape_or_replace_skill_md` test.

- **[P3·ux-defect]** A folder whose SKILL.md is lowercase imports on macOS but is then refused with a path-escape message
  `src-tauri/src/commands/skills.rs:937` — Importing a folder whose SKILL.md is spelled in any other case fails with 'Resource paths must stay inside the skill folder; SKILL.md is edited through the skill fields.' — a message about path escape, for the skill's own file, after the file was already read successfully.
  _Fix:_ Make the skip case-insensitive: `if rel.eq_ignore_ascii_case("SKILL.md") { continue; }`, matching the rule `normalize_skill_path` already enforces.

- **[P3·dead-code]** SkillResourceMeta.text is computed on every get_skill and never read
  `src-tauri/src/commands/skills.rs:746` — Every skill open decrypts and loads every bundled resource's full bytes and UTF-8-validates them to fill a field no consumer reads; a skill with large assets pays that cost again after each file save.
  _Fix:_ Drop the field and `is_text_path` (or make the editor use it, so the extension allow-list is the single rule), and have `list_skill_resources` grow a metadata-only variant selecting `length(content)` so `get_skill` never pulls resource bytes at all.

- **[P3·ux-defect]** Enabling a skill that was deleted elsewhere leaks "Query returned no rows" instead of the SKILL_GONE sentence the disable path uses
  `src-tauri/src/commands/skills.rs:823` — The two halves of the same command answer the same situation in two different languages: disabling a deleted skill says 'That skill no longer exists — it was deleted.', enabling one says 'Query returned no rows'.
  _Fix:_ Start the enable branch with `let s = require_skill(&room.conn, &id)?;` — it already returns the full `db::Skill` that `validate_skill_fields` needs.

- **[P3·correctness]** The Skills editor cannot save a skill whose owner is not in the roster, because the picker offers the very value the save refuses
  `src/workspace/skills/SkillsView.tsx:848` — For a skill flagged 'Unknown owner' — the state the UI explicitly draws — every Save SKILL.md is refused with 'agent must be one of: … Got "x"; nothing was saved.', including edits that have nothing to do with the owner, unless the user first notices the dropdown and changes it.
  _Fix:_ When `draft.agent` is not in `agentIds`, send `undefined` (which api.ts maps to null = 'leave the binding alone') so unrelated edits can be saved, and turn the stale option into a visible correction prompt — or make the save send the owner only when the user actually changed it.

- **[P3·ux-defect]** compose_skill discards a fully generated skill when its name clashes with an existing one
  `src-tauri/src/commands/skills.rs:1238` — 'Build with AI' runs the whole generation (a minute or more on a local model), then throws the result away with 'A skill named "x" already exists.' — the retry loop that exists to salvage bad output does not cover the one failure the model is most likely to repeat, and nothing offers to replace or rename.
  _Fix:_ Treat the clash like the other rejections — feed it back as `last_err` ('that name is taken, choose another') so the second attempt can rename — and only clear `composeText` in SkillsView after `composeSkill` resolves.

- **[P3·privacy]** Decrypted skill resources survive a crash in the app cache, under a random name nothing ever sweeps
  `src-tauri/src/commands/skills.rs:643` — Running a skill script writes every bundled resource — reference documents, source-file snapshots taken from encrypted room files — in the clear to ~/Library/Caches/<app>/skill-runs/<uuid>/. That directory is removed only by a Drop impl, so a crash, a force-quit or a SIGKILL leaves the decrypted copies on disk permanently.
  _Fix:_ Sweep `skill-runs/` at startup (and on room close) the way the browser staging dir is swept at browser.rs:734, and chmod the parent 0o700 as well as the run root.


### Scripts (13)


- **[P2·honesty]** A script that writes a filename it never mentions overwrites the room file of that name, and the report calls it "Created"
  `src-tauri/src/commands/jobs/script_run.rs:853` — An existing room file is replaced (as a new version) by script output even though its name is in no `room-outputs:` header, on no line of the consent card, and nowhere in the script text — and the run report hands the assistant "Created: <name>", so the user is told a file was made when one was replaced.
  _Fix:_ Have write_output return whether it overwrote, and split the report into `created` / `replaced` so printed_output stops calling an overwrite a creation; in step 2 also push a skip-note for a collision ("the script wrote notes.md, which already exists — it was saved as a new version; declare it in room-outputs to make that explicit"), matching what step 3 already does at line 886.

- **[P2·honesty]** The consent card's "Reads" list is also a write list — a file shown only under Reads is saved back over its room copy
  `src-tauri/src/commands/jobs/script_run.rs:884` — The run-consent card presents two distinct sets — "Reads" and "Writes back" — but any file in the Reads set that the script modifies in place is written back into the room as a new version. A script with no `room-outputs:` shows no "Writes back" line at all and still replaces room files.
  _Fix:_ Make the card's labels match the runner: either list the materialized set under a combined key ("Reads — and may save its changes back to these"), or send a third field (e.g. `mayWriteBack`) carrying `readable_room_files` minus the declared outputs and render it beside "Writes back". The wording belongs in scriptTrust.ts so the page and the card cannot drift.

- **[P2·ux-defect]** The consent card stays on screen after the backend's 180 s timeout, and answering it then does nothing
  `src-tauri/src/commands/scripts.rs:116` — An expired script-run consent card is never retracted. It keeps the Activity badge lit, and answering it silently does nothing at all.
  _Fix:_ Emit a `script-approve-cancelled` {id} from both the timeout arm (scripts.rs:118-121) and the room-teardown clear (rooms.rs:581), and have effects.ts drop that id from scriptApprovals. Make resolve_script_run return Err("that request expired") for an unknown id and let scriptActions surface it instead of `.catch(() => {})`.

- **[P2·correctness]** A uv runtime the app itself downloaded is invisible to the script runner, which then tells the user to `brew install uv`
  `src-tauri/src/commands/jobs/script_run.rs:358` — After the app has downloaded uv for an MCP connector, running a Python script with dependencies still fails with "This script needs <pkg>. Install uv (`brew install uv`) to run scripts with dependencies." Installing uv by hand mid-session also does not help until the app restarts.
  _Fix:_ Prepend the entries of runtimes::cached_path_prefix() (and/or app_data_dir()/runtimes/{uv,node}/…) to the candidate lists in uv_bin()/node_bin(), and replace the OnceLock with a cache that refresh_path_prefix() invalidates (or a short TTL), so a runtime installed mid-session is picked up. Also reword the error to name the in-app download when the runtime is provisionable.

- **[P2·honesty]** The card prints a declared input token, but the run decrypts whatever file that token matches as a substring
  `src-tauri/src/commands/jobs/script_run.rs:505` — The consent card exists to name every room file a run would decrypt (scripts.rs:57-61), but for DECLARED inputs it prints the manifest token verbatim, while materialization resolves that token with a fuzzy, newest-wins substring match — so the file actually copied out of the encrypted room can be a different document that appears nowhere on the card.
  _Fix:_ Resolve declared inputs in readable_room_files with the same db::find_file_like call the runner uses and show the RESOLVED room names on the card (falling back to `token → (no match)` when nothing resolves), so the card and materialize_inputs cannot name different files.

- **[P3·honesty]** The Scripts page "Reads" field lists only declared inputs, hiding the room files the run actually decrypts
  `src-tauri/src/commands/scripts.rs:396` — A script with no `# room-inputs:` header shows no "Reads" row at all on the Scripts page, while running it decrypts up to 20 room files (MAX_AUTO_MATERIALIZE) — every room file whose exact name appears in the script text — into a plaintext workspace.
  _Fix:_ Compute `inputs` in list_scripts with readable_room_files(&room.conn, &manifest.inputs, &text) — the same call run_script_inner makes — so the row and the card describe one run. (Note it needs the file text, which list_scripts already has at scripts.rs:359.)

- **[P3·correctness]** An auto-heal retry can run for twice the script's declared `room-timeout`
  `src-tauri/src/commands/jobs/script_run.rs:1103` — A script that declares `# room-timeout: 300` and fails fast (missing import) gets a healed retry allowed to run ~595 s, and the timeout message then reports a limit that appears in no manifest.
  _Fix:_ Pass `left.min(manifest.timeout_secs)` as the per-attempt timeout at line 1103 so the declared timeout bounds every attempt and TOTAL_TIMEOUT_MULTIPLE bounds only the sum.

- **[P3·honesty]** Output over 32 KB loses its BEGINNING but is labelled "(output truncated)" at the end
  `src-tauri/src/commands/jobs/script_run.rs:751` — For a chatty script the assistant receives a middle slice of the output with no indication that the beginning was dropped, under a preamble telling it to quote the values exactly as the answer.
  _Fix:_ Track a dropped-byte counter in the ring reader and have tail_string prefix the result with `[earlier output omitted — N bytes]`; make clamp_script_output name which end it cut. Trimming the leading partial UTF-8 sequence before the lossy conversion also removes the stray U+FFFD.

- **[P3·dead-code]** `timeout` is emitted on every consent request and never rendered
  `src-tauri/src/commands/scripts.rs:113` — The consent card carries the script's timeout across the IPC seam and shows nothing about it, so the card that is meant to describe exactly what would run never says how long the program may hold the machine (up to 2× that, per the retry finding).
  _Fix:_ Either render it ("Runs for up to N minutes before it is stopped" — and say 2N if the heal budget stays as-is), or delete the field from the emit and from ScriptApproveRequest.

- **[P3·honesty]** Auto-heal installs PyPI packages the consent card never named
  `src-tauri/src/commands/jobs/script_run.rs:1080` — The consent card's "Installs" row is the script's DECLARED dependency list (and is omitted entirely when the script declares none), but the uv runner will, after consent, install up to MAX_HEAL_ROUNDS = 8 additional packages inferred from the script's own ModuleNotFoundError output and re-execute the script with them.
  _Fix:_ Either derive the card's "Installs" line honestly ("declared: none — the runner may install packages this script imports"), or restrict auto-heal to packages the user has seen: heal only when deps were declared, or surface the healed set in the run report's notes the way step 3 does for in-place writes.

- **[P3·honesty]** A declared output that was materialized as an input is re-imported even when the script never wrote it
  `src-tauri/src/commands/jobs/script_run.rs:810` — For the input==output pattern the empty state itself teaches (`# room-inputs: portfolio.csv` + `# room-outputs: portfolio.csv`), step 1 of import_outputs always finds the file on disk — because the runner put it there — so it writes a fresh, byte-identical version into the room on every run and reports "Created: portfolio.csv", even when the script wrote nothing at all. The honest note "the script did not write this declared output" can never fire for that shape.
  _Fix:_ In step 1, hash the file on disk against the Materialized sha for the same name (is_modified_used_file already has the comparison) and treat an unchanged materialized copy as "the script did not write this declared output" instead of importing it.

- **[P3·ux-defect]** A timed-out or stopped script discards everything it printed
  `src-tauri/src/commands/jobs/script_run.rs:691` — When a run hits its timeout (or Stop), the collected stdout/stderr tails are thrown away: the error is a single sentence with no output, so a script that printed progress and then hung leaves the user and the assistant nothing to diagnose with — while a plain non-zero exit does surface the stderr tail.
  _Fix:_ Read tail_string(&out_buf)/tail_string(&err_buf) before returning on the timeout and cancel paths and append the last lines to the error ("…output before it was stopped: …"), the way the non-zero-exit path already does.

- **[P3·ux-defect]** The Scripts incident card shows the advice sentence as the failure's "cause"
  `src/workspace/scripts/ScriptRow.tsx:22` — For the two most common script failures, the incident block on the Scripts page displays the LAST line of the stored error, which the runner appends as guidance — so under the title "This script failed 3 times in a row — same error" the cause line reads "Or ask the assistant to declare the script's dependencies." instead of the actual exception.
  _Fix:_ Separate the two in the payload rather than parsing prose in TS: store the stderr tail and the guidance as distinct fields on the run row (or split on the "\n\n" the runner inserts) and render the cause from the stderr part, with the guidance as the recovery line under it.


### AI file editing (13)


- **[P2·honesty]** Approving a diff-preview card that has already timed out silently does nothing, and the model is told the user declined
  `src-tauri/src/commands/edit_gate.rs:86` — Two halves of one failure: (a) a 180s read of a large diff is reported to the model as "the user declined the proposed change after seeing the preview", which is false; (b) pressing Apply after that returns Ok, the card disappears, nothing is written, and the user has every reason to think the edit landed.
  _Fix:_ Mirror agent_ui.rs: return Err(NO_LONGER_WAITING) from resolve_edit_approval when the id is not pending (and when tx.send fails), and let miscActions surface it the way resolveBrowseConsent does. Separately, distinguish the timeout from a real decline in the sentence handed to the model ("nobody answered the preview in time" is a refusal to respect, not a decision the user made).

- **[P2·data-loss]** Every edit/rewrite tool resolves the file by substring-LIKE, newest wins, with no ambiguity error
  `src-tauri/src/commands/edit_match.rs:368` — edit_file / write_file / set_cells / edit_files act on the newest file whose name merely CONTAINS the given name, so a room holding both notes.md and old notes.md can have the wrong document rewritten end to end with no ambiguity error.
  _Fix:_ Rank resolution in find_newest_named: exact lower(name)=?1, then folder-qualified, then substring; and count substring candidates so >1 non-exact match returns an EditError with outcome 'ambiguous' listing the names - the refusal shape resolve_with_refinements and sketch.rs::resolve already use.

- **[P2·correctness]** section on Markdown silently turns off the tolerant matcher and reports it with parameters the caller never passed
  `src-tauri/src/commands/edit_match.rs:595` — A quote that matches fine without section fails once the model scopes it to a heading, and the failure blames prefix_context/suffix_context/occurrence - none of which were supplied - telling the model to drop them, which changes nothing.
  _Fix:_ When section is the only refinement, run fuzzy_find over the section's byte range and offset the returned span, as the HTML branch already does; compose the not-found message from the refinements actually present.

- **[P2·ux-defect]** A clipped diff card shows the first 200 KB of the file, so a change past that offset is approved unseen
  `src-tauri/src/commands/edit_match.rs:326` — On a large file the approval card renders two identical panes with no visible diff and asks the user to approve; the only hint is a note saying the full change is still applied.
  _Fix:_ Clip a window around the changed byte range (the plan knows the replaced span; write_file can diff for the first divergence) and label it 'showing the changed region of a large file'; if no change falls in the window, say so rather than drawing two identical panes.

- **[P2·perf]** `plan_set_cells` re-parses and re-serialises the whole workbook once per cell, with no bound on the batch
  `src-tauri/src/commands/edit_match.rs:414` — A `set_cells` batch of N updates performs N full parses and N full serialisations of the entire spreadsheet, all while the room mutex is held, so a column-fill on a modest .xlsx stalls the whole app with no progress signal.
  _Fix:_ Add batch primitives that open the file once — `xlsx_set_cells(bytes, sheet, &[(cell, value)])` applying every update between one `read_reader` and one `write_writer`, and a CSV twin that parses and serialises once — and cap the accepted batch (or make `is_large_scale_edit` count cells for `set_cells`) so an unbounded model batch is refused up front.

- **[P2·honesty]** Answering an approval card whose backend wait is already over silently does nothing
  `src-tauri/src/commands/edit_gate.rs:80` — The user presses Apply on a diff card that has already timed out (or whose tool task is gone); the card disappears as if accepted, nothing is written, and nobody is told - while the model has already been told the user declined.
  _Fix:_ Return Err('... no longer waiting ...') from resolve_edit_approval when the id is absent or the send fails, and surface that error in resolveEditApproval for approving decisions, exactly as resolveBrowseConsent does.

- **[P3·honesty]** A timed-out or auto-declined approval is reported to the model as the user having declined after seeing the preview
  `src-tauri/src/commands/edit_gate.rs:253` — When nobody answers the card (180s timeout, or the frontend auto-declines at turn teardown), the model is told the user looked at the change and said no, and relays that to the user as fact.
  _Fix:_ Return a three-way outcome from edit_call_approved (approved / declined / unanswered-or-cancelled) and word the last honestly: the approval card was not answered, nothing was changed, ask again if the change is still wanted.

- **[P3·correctness]** section + all: true on a Markdown file: all is ignored and the error tells the model to pass all: true
  `src-tauri/src/commands/edit_match.rs:817` — A section-scoped replace-all on .md can never succeed: the flag is dropped whenever any refinement is present, and the ambiguity error recommends the one option that path cannot honour.
  _Fix:_ Pass all into resolve_with_refinements and replace every filtered candidate right-to-left (matching the HTML branch), or build the message with all_offered=false whenever a refinement is in play.

- **[P3·data-loss]** A match that starts or ends inside an fi/fl ligature silently deletes the other half of the character
  `src-tauri/src/commands/edit_match.rs:78` — edit_file replaces one character MORE than the quoted text and reports Replaced 1 occurrence(s) - a letter the model never asked to touch is gone from the document.
  _Fix:_ Give the second half of a Pair a zero-width span anchored at the char end (first i..end, second end..end), or reject a match whose first/last hay index is the non-boundary half of a Pair. Apply in edit_match.rs, extraction/docx.rs and extraction/html_edit.rs.

- **[P3·correctness]** A batch that renames a file's type derives the searchable text with the NEW name
  `src-tauri/src/commands/edit_match.rs:338` — Editing a .docx and renaming it to .md in one edit_files call stores the zip's bytes decoded as if they were text, filling the search index and the model's retrieved context with binary mojibake.
  _Fix:_ Derive the text with the name whose format the BYTES are in (entry.real_name), as the preview does, or refuse a batch rename that changes the extension away from the bytes' actual format.

- **[P3·ux-defect]** The approval card's before pane renders a legacy-encoded text file as mojibake
  `src-tauri/src/commands/edit_match.rs:318` — For a windows-1252/1255 text file the card shows the current content with a replacement box wherever an accented or Hebrew character is, and write_file's model-facing line counts are computed off that same corrupted string.
  _Fix:_ Use extraction::decode_text_bytes for the non-office arm of render_for_preview so the card and the model-facing summary describe the file as the viewer and the index already do.

- **[P3·ux-defect]** A no-op .docx save is reported as a failed save and blocks the unsaved-edits dialog
  `src-tauri/src/commands/docx_edit.rs:111` — After a whitespace-only change to a Word file, Save shows a red Could not save toast, the unsaved-edits dialog refuses to close the file, and Discard is the only way out.
  _Fix:_ Return Ok with the untouched bytes for the no-op case (skipping the write and the snapshot) so the dirty flag clears and the navigation proceeds.

- **[P3·correctness]** Stop does not gate the edit tools' commit, unlike every other write funnel
  `src-tauri/src/commands/edit_gate.rs:212` — An edit_file / edit_files / write_file / set_cells call already in flight when the user presses Stop still commits its write; only create_file and the scratch-pad rewrite honour the Stop flag before writing.
  _Fix:_ Thread the run's cancel flag into gated_write and read it immediately before commit_plans in both phases, returning Artifact::commit's wording ('Stopped before ... was saved - nothing was written to the room.').


### Sidecar (12)


- **[P2·correctness]** One-shot generation on a provider or CLI engine has no window fit at all, while the local twin does
  `sidecar/arcelle_sidecar/provider_api.py:584` — Every non-agent gateway call — `/handoff_summary`, `/generate`, `/file_pass_section`, `/ai_action`, `/knowledge_extract` — is cut to the window on a local room and sent completely unbounded on an OpenRouter room. Oversized payloads come back as a bare provider 400 the UI can only repeat.
  _Fix:_ In `OpenAICompatibleChatModel.generate` (and `generate_stream`), run `budget.fit_oversized_results(messages, fit_budget_bytes(self.provider.context_window or DEFAULT_PROVIDER_CONTEXT, json_chars(format) if format else 0, CLOUD_SPEND_FRACTION), reserved)` before `_payload`. For the CLI path, either give `generate_external` an explicit `window` argument its callers can supply, or accept it as unbounded and document it.

- **[P2·correctness]** Cloud compaction budgets are scaled by a bytes-per-token ratio measured from a local model, contradicting the constant's own contract
  `sidecar/arcelle_sidecar/model_limits.py:91` — The point at which a cloud conversation starts compacting moves by up to 2x depending on what a LOCAL model in the same process last generated — either compacting far earlier than needed (lost verbatim turns, paid digest calls) or far later (an oversized request the provider rejects).
  _Fix:_ Key the calibration by local/non-local (or by model) and make `window_budget_bytes` take the ratio as an argument, so the cloud paths pass the `BYTES_PER_TOKEN` floor explicitly. At minimum, correct the comment at model_limits.py:88-91 — it is why nobody looked.

- **[P2·honesty]** A dead network on an OpenRouter room is reported as OLLAMA_DOWN, so the UI says "The local AI isn't running" and offers to open Ollama
  `sidecar/arcelle_sidecar/llm.py:82` — On a room whose engine is an OpenRouter/API provider — a room that never touches Ollama — a connect failure or read timeout to the provider is classified as `OLLAMA_DOWN`. The Rust gateway passes that sentinel straight through (`sidecar.rs:75`), `composer.isOllamaDown` matches it (`src/workspace/composer.ts:504-508`) and the UI renders "The local AI isn't running." plus an "Open Ollama" recovery button (`src/workspace/AiPane.tsx:951`). The user is told to start a daemon their room does not use, and the real cause (offline, DNS, provider stall) is never stated.
  _Fix:_ Classify by SEAM, not by exception type alone: give `_classify` a flag (or a separate `_classify_provider`) used by the provider branches of `llm.generate` / `llm.generate_stream` / `summarize.OllamaModelClient._chat` that maps transport failures to `ENGINE_ERROR` with the provider's host in the message. Keep `OLLAMA_DOWN` for calls that actually targeted `ollama_base_url`.

- **[P2·cancellation]** Stop is not sampled during compaction, and on a cloud-CLI room each digest pass is an uncancellable 15-minute subprocess
  `sidecar/arcelle_sidecar/external_llm.py:1026` — Pressing Stop on the long conversation that triggers compaction does nothing until every digest pass has finished. On a `claude-cli` / `codex-cli` room each pass is a whole spawned process bounded only by `EXTERNAL_IDLE_SECS = 900`, and it is spawned with no cancel token at all — so a stopped turn keeps spawning and paying for CLI sessions the user has already abandoned.
  _Fix:_ Thread the round's cancel token into compaction: give `compact_to_budget` an optional `cancel` and return `(messages, False)` as soon as it is tripped, and pass it down to each `_digest` (external: `drain_with_idle(..., cancel)`; local: sample it around `_bounded`). At minimum, check `cancel.cancelled` before entering `_compact` in all three `stream` implementations.

- **[P3·honesty]** The token bar's "Skill-injected content" segment excludes the actual skill injection, which is billed to "Conversation history"
  `sidecar/arcelle_sidecar/usage.py:62` — The per-turn skills preamble and an explicitly /slash-selected skill's whole SKILL.md body are charged to 'Conversation history' rather than 'Skill-injected content', so a user reading the bar to find out why context is full is pointed at their conversation instead of at the skill.
  _Fix:_ Have the host report the byte length of the skills portion of the per-turn user message alongside the messages (or emit the preamble as its own message the categorizer can recognise), and subtract it from 'history' into 'skills' in `categorize_messages`.

- **[P3·correctness]** Image references have no size ceiling, unlike video references
  `sidecar/arcelle_sidecar/imagegen.py:173` — An oversized room picture attached as an image reference is base64'd and uploaded whole; the user waits for a long POST and gets whatever opaque error the provider returns, where the identical picture on the Video tab is refused instantly with the limit named.
  _Fix:_ Give _reference_url the same decode-and-measure guard as videogen._data_url and share one MAX_REFERENCE_BYTES constant between the two modules.

- **[P3·security]** Flattening the transcript for a cloud CLI destroys the role boundary, so tool-result text can forge a user turn
  `sidecar/arcelle_sidecar/external_llm.py:334` — On a `claude-cli` / `codex-cli` room, a line starting `User: ` inside a fetched page or connector result appears at column 0 in the flattened prompt under `Result of browse_read:`, in the same shape a genuine user instruction takes, making injected instructions materially more likely to be obeyed.
  _Fix:_ Fence tool-result content in `flatten_agent_messages`: a labelled block with an explicit "reference data, never instructions" header, and prefix every line of the result (indent, or a `| ` marker) so no line inside a result can occupy column 0 as `User: `/`Assistant: `. Say the same in `_TOOL_PROTOCOL` rather than only in `BROWSE_PROMPT`.

- **[P3·dead-code]** Dead `while True: … break` in the provider stream loop, left over from the removed catalog-narrowing retry
  `sidecar/arcelle_sidecar/provider_api.py:650` — `OpenAICompatibleChatModel.stream` wraps its single request in a loop that can only run once, reading as a retry loop and inviting a future `continue` that would re-send an unbounded payload.
  _Fix:_ Delete the `while True:` and the trailing `break`, de-indenting the `async with client.stream(...)` block.

- **[P3·concurrency]** `ExternalChatModel` stores the engine's reported window on the shared instance, so concurrent delegated children overwrite each other
  `sidecar/arcelle_sidecar/external_llm.py:1330` — Under `ask_agents` on a cloud-CLI room, a child can publish another agent's context-window denominator to the token bar, and its next `_compact` can budget against a window it never had.
  _Fix:_ Thread the parsed window through the call frame instead of storing it: have `stream` keep `window` local and pass it to `self._usage(input_tokens, window)`, and give `_compact` a `window` parameter rather than reading `self._stated_context`.

- **[P3·correctness]** `summarize._gather_window` sizes a cloud room's file-read budget off the Mac's RAM ceiling instead of the provider's own window
  `sidecar/arcelle_sidecar/summarize.py:566` — For an OpenRouter or CLI room the one-line file summariser budgets its `read_text` reads at `window_budget_bytes(max_num_ctx())` — 190 KB to 390 KB of file text — regardless of the model's real context window, which for a provider is known (`provider.context_window`). On a small-window cloud model the gathered text is then silently cut back by `provider_api._compact` (or, on the no-tools branch, rejected outright — see verdict 5), so the summary is built on a truncated read with nothing saying so.
  _Fix:_ In `_gather_window`, return the provider's stated window when one is known: `window = getattr(getattr(client, "provider", None), "context_window", None)`; `return min(ceiling, window) if window else ceiling`. Leave the CLI branch on the ceiling (no window is stated there) but say so in the docstring.

- **[P3·correctness]** The compaction digest drops every tool call and tool name, so the digested stretch records page text with no record of which tool or URL produced it
  `sidecar/arcelle_sidecar/compaction.py:350` — The text handed to the digest model renders an assistant turn that only requested a tool as the bare line `assistant: ` (its `tool_calls` — the tool name and arguments — are dropped) and its result as `tool: <content>` with the `tool_name` dropped. After compaction the model's memory of the older half contains the fetched text but no record of what was run, with what arguments, or against which URL — while `DIGEST_PROMPT` explicitly asks for "every stated value, name, decision, file and outcome, with what it refers to".
  _Fix:_ Render the machinery in the digest text: for an assistant turn append `called <name>(<compact args>)` when `tool_calls` is present, and prefix a tool line with its `tool_name` (`tool <name>: …`). Include both in `_key` so the cache cannot collide across chunks that differ only in their calls.

- **[P3·correctness]** A podcast turn with no ASCII spaces is sent to the voice service as one over-limit request
  `sidecar/arcelle_sidecar/tts.py:226` — `split_for_tts` can return a piece longer than MAX_TTS_CHARS for a turn with no ASCII spaces (Chinese/Japanese, or one very long token), and the podcast path sends it to Edge with no length check anywhere.
  _Fix:_ Add the CJK terminators to the sentence split and give the last-resort splitter the same break set the frontend chunker uses (`SOFT_BREAKS = ",;: 、，；：`, voice.ts:455), with a hard character cut when the window holds no break character at all. A test on the returned piece lengths is the cheap regression guard.


### Settings (11)


- **[P2·data-loss]** A stale frontend copy of the config silently wipes the OAuth bearer the backend just wrote
  `src/settings/useMcpConfig.ts:74` — After signing in to a remote connector, any UI write of the connector config in the same page visit (marketplace install, or Advanced → Save & Connect) re-posts a snapshot taken before the sign-in, dropping that connector's `headers.Authorization`. The connector reconnects unauthenticated and every call 401s while the drawer still reads 'Signed in'.
  _Fix:_ Stop writing whole-config snapshots from React. Either have `mcp_apply_config` take a per-server fragment and merge server-side, or re-read `await api.mcpGetConfig()` inside `installServer`/`applyMcp` immediately before merging, and refresh `mcpConfig` after `mcpOauthAuthorize`/`mcpOauthSignOut` exactly as `setServerEnabled` already does.

- **[P2·correctness]** Disconnecting OpenRouter can point the room at an embedding model, an Ollama cloud relay, or the very model just disconnected
  `src/Settings.tsx:568` — Pressing Disconnect on the OpenRouter card writes an unusable model into the room's `model` setting: nomic-embed-text (every turn then fails with "does not support chat"), or a `<size>-cloud` relay tag presented as the local fallback, or — when Ollama is not reachable — the OpenRouter model that was just disconnected, so the dialog's promise ("Any room using an OpenRouter model switches back to the local one") is not kept.
  _Fix:_ Use the helper written for this: `bestLocalModel(ai?.models ?? [], RECOMMENDED_MODELS) ?? DEFAULT_MODEL`. Never `ai.defaultModel` — it is the model being replaced — and never `.endsWith(":cloud")`, which isRelayedModel replaced.

- **[P2·ux-defect]** AI advisors offered (and labelled "OpenRouter") when no advisor CLI exists
  `src/settings/AdvisorsSection.tsx:42` — Connecting an OpenRouter key on a Mac with no `claude`/`codex` replaces the accurate "No cloud AI CLIs were detected" message with a live toggle reading "Enable AI advisors (OpenRouter)". Turning it on writes advisors_enabled=on and offers a capability that can never run — consult_advisor is never added to the catalog.
  _Fix:_ Gate and label on the CLI list only: expose `detected_advisors` as its own AiStatus field (e.g. `advisors: string[]`), or filter here with `ai.external.filter((e) => e !== "openrouter")` — and keep apiTypes' "Cloud CLIs detected on this Mac" comment true of whatever the section reads.

- **[P2·ux-defect]** Focus trap is escapable after a backdrop click when work is unsaved
  `src/settings/useFocusTrap.ts:42` — Clicking the dimmed backdrop with unsaved work leaves the modal open showing the "closing now would discard them" strip, but focus is on document.body. From there the modal's key handler never fires, so Tab walks into the live workspace behind the modal — including the Lock button the trap was written to guard — and Escape does nothing at all.
  _Fix:_ Keep the keydown inside the trapped subtree: give the backdrop `tabIndex={-1}` so the click focuses it (it is inside the modal's React subtree), or move focus into the modal when `confirmClose` becomes true (focus the "Keep editing" button). Marking the workspace `inert` while the modal is open would close it for good.

- **[P2·correctness]** A revoked recovery key is silently overwritten by the stranded-checkpoints message after a password change
  `src/settings/usePrivacy.ts:100` — When a password change fails twice over — the recovery key could not be re-issued AND some checkpoints could not be re-locked — only the checkpoint warning survives. The sentence about the recovery key having been revoked is written and then immediately replaced, so the one credential that is now permanently gone is never mentioned.
  _Fix:_ Accumulate post-change warnings into a `pwWarnings: string[]` and render all of them, rather than having two independent facts share one string slot.

- **[P2·correctness]** Turning the room MCP server off and on again silently downgrades a saved "Full agent" scope to "Files only"
  `src/settings/useRoomServer.ts:33` — The persisted room_server_scope is only read back while the bridge is running. Open Settings with the Leash stopped and it always shows "Files only" regardless of what is stored; turning the switch on then restarts at the files tier and overwrites the stored "full" — the pasted external-agent config (fixed port 17872, stable token) stops working, with nothing said.
  _Fix:_ Have room_server_status_snapshot's None arm read `room_server_scope` and the allow-cloud sub-option from the open room's settings instead of returning hardcoded defaults, and seed the hook unconditionally rather than only when `st.running`.

- **[P2·honesty]** Settings → Model labels every installed model "Local" and says models "run locally through Ollama" while the Closet relays them off the Mac
  `src/settings/ModelSection.tsx:75` — With a remote Ollama saved, Settings → Model still reads "The AI that lives in this room. Models run locally through Ollama — except :cloud models…", and the picker lists every installed tag under the "On this Mac" tab with a green "Local" tier label. The one Settings surface where the model is chosen never mentions that the whole list runs on another computer, even though the backend reports it.
  _Fix:_ Thread `ai.remoteRelay` into ModelSection and EngineModelPicker: when it is true, replace the "run locally" hint with a note naming the relay, and label the Ollama rows with the relay tier instead of "Local" (reuse `isCloudRoute`, so there is one rule).

- **[P3·data-loss]** A failed Private-topics save leaves the typing unprotected from the next background reload
  `src/settings/CloudPrivacySection.tsx:105` — If set_privacy_concepts rejects, the error line appears but the dirty flag has already been cleared, so the next background scan's terminal event repopulates the textarea from the stored list and the user's typed topics are wiped without them touching anything.
  _Fix:_ Clear `conceptsDirty.current` only after the await resolves, and set it back to true in the catch.

- **[P3·ux-defect]** Model delete confirm disarms itself after 3 seconds — the pattern the app fixed everywhere else
  `src/settings/useModelManagement.ts:207` — The "Delete? ✓ ✕" question in Settings → Model reverts to the bin icon after three seconds, so anyone who pauses to read it clicks where ✓ was and hits the bin, which just re-asks.
  _Fix:_ Drop the timeout; let only ✕, another armed confirm, or cancelRemoveModel take it down — matching miscActions.askConfirm.

- **[P3·error-handling]** Behavior → Save (custom instructions + creativity) has no error path: a failed write is an unhandled rejection with no message
  `src/settings/useBehaviorSettings.ts:78` — If either setSetting rejects, the Save button produces no error, no "Saved" tick and no toast — exactly the "indistinguishable from a click that did nothing" failure the neighbouring sections were fixed for. A partial failure is also possible: temperature is written, custom_instructions is not, and nothing says so.
  _Fix:_ Wrap the two writes in try/catch, surface the message in the section (a `tuningError` beside `saved`), and only advance storedInstructions/storedTemperature after both writes land — the shape useOnlineSearch already uses.

- **[P3·ux-defect]** Closing Settings mid-preview leaves the voice talking with no way to stop it
  `src/settings/useVoiceSettings.ts:130` — Press Preview in Settings → Spoken voice and close the modal while the sample is speaking: the audio keeps playing to the end, and the only control that could stop it (the 'Stop preview' button) has just been unmounted. It also keeps speaking through the UNSAVED voice/slider values the user was auditioning.
  _Fix:_ Add a cleanup to the hook — `useEffect(() => () => { if (previewingRef.current) voice.cancelAll(); }, [])` — or call `voice.cancelAll()` from Settings' onClose. Cancelling only when this hook owns the pipeline matters: an unconditional cancelAll on close would also silence an answer that is legitimately being read aloud behind the modal.


### Privacy / Security (9)


- **[P2·honesty]** Cloud-privacy panel's connector-masking note ignores per-connector overrides and can state the exact opposite of what happens
  `src-tauri/src/commands/privacy.rs:638` — Global "Send remote connectors real values" OFF plus a per-connector override ON makes Cloud privacy print "a remote connector is still sent placeholders instead of the items below" while that connector receives the real names. The mirror case (global ON, one connector overridden OFF) prints the leak warning for a seam that is masked.
  _Fix:_ Make the reported fact per-connector: have privacy_status walk the configured servers through `outbound_unmask_for` and return counts (or the two sets), and let the panel render "some masked, some not". Minimum viable: report masked only when EVERY configured remote connector resolves to masked, and delete the stale comment at privacy.rs:632-637.

- **[P2·data-loss]** Private topics beyond the 20th are silently discarded and erased from the textarea
  `src-tauri/src/commands/privacy.rs:777` — Typing/pasting more than 20 private-topic lines and blurring silently keeps the first 20 — the backend truncates, the panel's reload rewrites the textarea from the stored list, and the extra lines vanish with no error and no mention of a cap anywhere in the copy.
  _Fix:_ Enforce and state the cap where the user is (disable saving past 20, or show "20 topics maximum"), or have set_privacy_concepts return an Err when the list is over the cap instead of silently truncating — the same doctrine add_privacy_block already follows for its 2-character floor.

- **[P2·ux-defect]** `change_password`, `duplicate_room` and `compact_room` are synchronous commands — a multi-GB room freezes the whole app
  `src-tauri/src/commands/safety.rs:310` — Changing the password on a large room beachballs the app: the live-room rekey plus one full rekey per checkpoint run on the main thread, with no redraw, no input and no progress; macOS shows "application not responding". `duplicate_room` (VACUUM INTO the whole room), `compact_room` (VACUUM) and `export_all` have the same shape.
  _Fix:_ Make all four `pub async fn` and wrap the blocking body in `tokio::task::block_in_place`, exactly as `create_room_checkpoint` does; do the same for `list_stranded_checkpoints`, which is called straight afterwards.

- **[P2·privacy]** A transient DB read failure silently opens the privacy door while the panel still says it is on
  `src-tauri/src/commands/privacy.rs:525` — If `list_privacy_entities` returns an Err at any refresh, `compute_policy` returns None, `refresh_policy` stores None in the policy cell, and from then until the next successful refresh the door is fully open: `inject_policy` attaches no policy (so the sidecar redacts nothing and strips no images), `remote_seam_redactor` is None (so remote-connector arguments go out with real values), `mask_outbound_web` is None (so real names go to the search engines), and `door_is_active` is false (so the scanner silently declines to run). Nothing tells the user: `privacy_status` computes `effective_on` by re-reading the switch from the DB (privacy.rs:643-648), so Settings and the trust chip keep saying "On for this room".
  _Fix:_ Fail CLOSED: on a read error keep the previously cached policy rather than clearing it, or synthesize an active policy with no rules (which still blocks images and carries the concepts) and surface the error. At minimum, distinguish "no room" from "could not read the entity map" and make `privacy_status` report the latter instead of claiming the door is on.

- **[P2·privacy]** The background privacy scan writes room A's findings into whatever room is open when the chunk returns
  `src-tauri/src/commands/privacy.rs:1081` — Lock room A while its library scan is running and open room B: the scan loop keeps going and, when the in-flight `/privacy_scan` call returns, it re-acquires `state.room` and writes room A's discovered entities — real names, addresses, phone numbers extracted from A's documents — into ROOM B's `privacy_entities` table, where they show up in B's Cloud-privacy panel as protected items. The stale scan row is written into B too, and because `scan_flag` is still set, `schedule_privacy_scan` for B returns early, so B is not scanned.
  _Fix:_ Capture `(room_path, epoch)` when `run_privacy_scan` starts and require `room.path == room_path && state.room_epoch() == epoch` before every write (and before taking the next work snapshot); otherwise abandon the run. Also clear/abort the scan on `clear_policy`, so a scan cannot outlive the room whose policy it was started for.

- **[P3·dead-code]** Dead redundant disjunct in set_privacy_room
  `src-tauri/src/commands/privacy.rs:688` — The second operand of the condition in set_privacy_room can never change the outcome — it recomputes what active_policy() already answers — so a reader is led to believe there are two distinct cases.
  _Fix:_ `if active_policy().is_some() { schedule_privacy_scan(app); }`.

- **[P3·correctness]** The protected-item length floor counts BYTES in the DB layer while its message and every caller say characters
  `src-tauri/src/db/privacy.rs:50` — db::add_privacy_entity accepts a single 2-byte non-ASCII character as a protected item while its own error text promises a 2-CHARACTER floor. Both current callers pre-filter with the char rule, so nothing leaks now; the next caller that does not would store an item the panel lists as protected and the redactor drops.
  _Fix:_ Use the shared predicate in the db layer too (`if !is_protectable(real) { return Err(...) }`), so the floor has one definition and the message matches it.

- **[P3·correctness]** Case-insensitive de-duplication of protected entities is ASCII-only, so one non-Latin name becomes two entities
  `src-tauri/src/db/privacy.rs:61` — Add "José Muñoz" to the block list, then "JOSÉ MUÑOZ" (or let the scanner find the upper-cased spelling). The duplicate check misses, a second row with a second placeholder is created, and the panel lists the same person twice — one "guaranteed", one "found by scan" — while only one of the two placeholders is ever emitted.
  _Fix:_ Do the comparison in Rust with full-Unicode `str::to_lowercase()` before inserting (read candidate rows and compare there), or register a Unicode-aware `lower` via `create_scalar_function` and use it in the query. Extend the test at db/privacy.rs:272 past ASCII.

- **[P3·correctness]** `set_privacy_room("default")` reports success even when clearing the room override fails
  `src-tauri/src/commands/privacy.rs:680` — "Follow the app default instead" can silently do nothing: the DELETE error is thrown away and `Ok(())` returned, so the panel reloads unchanged and the user is given no reason.
  _Fix:_ `"default" => room.conn.execute("DELETE FROM settings WHERE key = ?1", [KEY_SWITCH]).map(|_| ()).map_err(|e| e.to_string())`.


### App lifecycle (9)


- **[P2·ux-defect]** A rollback that fails after teardown leaves the workspace mounted over a room that is closed
  `src-tauri/src/commands/room_checkpoints.rs:622` — When the post-rollback reopen fails, the host has already set `state.room = None` but the frontend is never told. The workspace stays fully rendered while every room command returns "No room is open." — files, chat and editor all fail with no explanation on screen except a line of text inside Settings.
  _Fix:_ Emit a `room-closed` event from `teardown_open_room` (or from the two rollback error branches) and route App.tsx back to the start screen on it; also stop discarding the recovery `open_room_impl` result at line 607 and fold its failure into the message.

- **[P2·correctness]** The parked "recording could not be restored" message is consumed by its own 2-second fallback emit, so a slow mount loses it entirely
  `src-tauri/src/commands/rooms.rs:186` — On a cold start, the crash-recovery failure notice can be silently dropped: the fallback timer removes the parked message and emits it before any listener exists, and the workspace's own collect then returns null. The user is told nothing — the exact silence this code was added to end.
  _Fix:_ Emit a CLONE and leave the park intact; let `take_rec_recovery_error` be the only consumer, and have the frontend ignore a `rec-error` with an empty fileId whose text it has already shown.

- **[P3·ux-defect]** ⌘W does nothing at the start screen and password gate — the only Close row is disabled with no room open
  `src-tauri/src/menu.rs:520` — With no room open (launch, start screen, unlock gate) File → Close is grey and there is no Close Window row anywhere, so ⌘W — the standard macOS 'close this window' key — does nothing at all.
  _Fix:_ Exclude `file.close-item` from the room gate — it always has a meaning (close the window, which is what useNativeMenu's own comment promises) — or add back a predefined Close Window row that is enabled while no room is open.

- **[P3·correctness]** A force-quit or crash orphans the `ollama serve` the app started, and it is never adopted or stopped again
  `src-tauri/src/ollama_lifecycle.rs:332` — An `ollama serve` Arcelle spawned survives an abnormal exit and becomes permanently unmanageable — the next launch finds it reachable, records no PID, and by its own safety rule never sleeps or stops it.
  _Fix:_ Persist the spawned PID next to window.json and adopt it at startup when the running daemon matches (pid alive + reachable), so `stop_if_ours` and the idle watcher can still own it after a crash. Optionally give the child its own process group to match the comment.

- **[P3·dead-code]** Five commands are registered on the IPC surface with no caller in TS, in Rust, or in the agent tool catalog
  `src-tauri/src/lib.rs:466` — `browser_close`, `get_workflow`, `get_script_manifest`, `import_youtube_video` and `transcribe_audio` are exposed on the IPC surface with no invoker anywhere — dead surface that the existing drift gates cannot see, because both of them only check that registration and definition agree.
  _Fix:_ Drop the `#[tauri::command]` attribute and the `generate_handler!` line for each, keeping the plain function where an internal caller exists (`db::get_workflow`) and deleting outright where none does. Also add them to a KNOWN_UNREGISTERED-style allow-list if any is being kept on purpose, so the choice is written down.

- **[P3·ux-defect]** Rolling back to a checkpoint discards an unsaved editor buffer with no warning
  `src-tauri/src/commands/room_checkpoints.rs:601` — A rollback tears the room down and remounts the workspace, throwing away whatever is unsaved in the open editor — the same buffer the app guards on ⌘Q and on window close — with no separate prompt and no mention in the confirmation text.
  _Fix:_ Cheapest honest fix: extend the confirm text to say unsaved changes in the open document will be lost. Stronger: expose UNSAVED_EDITS to `rollback_room_checkpoint` and return an actionable error asking the user to save or discard first.

- **[P3·resource-leak]** A failed rollback copy strands a full-size `.swap-<uuid>` file beside the room forever
  `src-tauri/src/commands/room_checkpoints.rs:448` — If `std::fs::copy` fails part-way through staging the checkpoint (I/O error, a volume that filled after the pre-check, an ejected disk), `perform_swap` returns the error without deleting the partially written `<room>.roomai.swap-<uuid>`. Nothing in the app ever sweeps that name, so a room-sized (potentially multi-GB) turd sits next to the user's room file permanently, and the next failed attempt adds another.
  _Fix:_ Mirror the rename branch: `std::fs::copy(...).map_err(|e| { let _ = std::fs::remove_file(&swap_tmp); format!(...) })?`, and add a startup sweep of `<room>.swap-*` beside the existing `.recovery` handling.

- **[P3·correctness]** The parked recording-recovery message is never cleared on lock, so it can surface as a toast inside a DIFFERENT room
  `src-tauri/src/commands/rooms.rs:164` — `rec_recovery_error` is parked at unlock and consumed only by a read. `teardown_open_room` clears every other piece of per-room state but not this one, and the 2 s fallback timer deliberately returns WITHOUT taking the park when the room is no longer open. A message about room A can therefore still be sitting there when room B's workspace mounts, and room B's user is shown an error toast claiming audio in 'the room' could not be restored and that the rescue will run again next unlock — about a room they are not in.
  _Fix:_ Clear `rec_recovery_error` in `teardown_open_room` alongside the other per-room caches (or park it as `(room_path, message)` and have `take_rec_recovery_error` return it only when the path matches the open room).

- **[P3·correctness]** The Ollama idle watcher can SIGTERM the daemon microseconds after a new call has taken its Busy guard
  `src-tauri/src/ollama_lifecycle.rs:291` — The watcher samples pid/idle/inflight and then kills, with no lock shared with `ensure_up`. A caller that took its `Busy` guard and found the daemon reachable just before that sample can have the daemon killed under it, so the user's request fails with a transport error rather than an answer — after five minutes of idle, i.e. exactly on the first thing they do when they come back.
  _Fix:_ Bump `last_used` when a `Busy` is CREATED as well as dropped, and re-check `inflight == 0` immediately before the kill (ideally holding the `our_pid` lock across the check-and-kill so `ensure_up` cannot slip in).


### Sketch (8)


- **[P2·correctness]** The draw tool tells the model to call `see_drawing`, a tool that was deleted
  `src-tauri/src/commands/sketch.rs:536` — Whenever a draw produces layout notes, the tool result instructs the model to call a tool that is not in its catalog; the model either burns a turn on an invalid call or drops the look-then-fix loop. The tool description bills the same wrong name in every context window on every turn.
  _Fix:_ Replace both strings with `read_drawing` and regenerate sidecar/devtools/dataset/tool_catalog.json. Extend `the_tool_descriptions_teach_the_one_command_that_prevents_bad_arrows` (line 876) to assert that every tool name mentioned inside any description text is in `DRAW_TOOL_NAMES` — the current test only checks that the two names appear somewhere in the JSON.

- **[P2·correctness]** `draw` swallows resolve()'s ambiguity refusal and quietly starts a third drawing instead
  `src-tauri/src/commands/sketch.rs:469` — An ambiguous drawing name makes the assistant create a new file (or rename an unrelated blank sketch) instead of reporting the ambiguity, so the diagram the user meant is untouched and the work lands under a name they did not choose.
  _Fix:_ Return a typed error from `resolve` (or match on the message) so only the not-found case falls through to claim/create; hand the ambiguity string back to the model verbatim. Add a test that calls the write path with two matching names and asserts no file was created or renamed.

- **[P2·correctness]** `canvas W H` makes a page nothing can be placed on, and a script that only resizes the page is never saved
  `src-tauri/src/commands/sketchdoc.rs:1015` — After `canvas 2400 1200` every shape placed in the new area is silently piled against x=1600/y=1000, `read_drawing` then shows the model coordinates it did not write, and a script that only resizes the page changes the open canvas on screen while leaving the file at 1600×1000.
  _Fix:_ Apply `Stmt::Canvas` in a pre-pass (or hoist the page size before parsing) so `clamp_box`/`translate` can clamp against the document's own width/height, and count a canvas change in `ScriptOutcome` so the save decision sees it.

- **[P2·data-loss]** mergeAgentDoc reverts the user's unsaved edits to any element the agent did not touch, and then saves the revert
  `src/viewers/sketch/model.ts:1025` — A drag, resize, relabel, recolour or lock made in the seconds before the assistant answers is silently undone — the shape snaps back to where it was on disk — and the reverted document is written to the file.
  _Fix:_ Pass `changed` through to `applyAgent` and let `mine`'s version win for any id that is in neither `added` nor `changed` (the agent demonstrably did not touch it), keeping `theirs` authoritative for added/changed/removed. Add a merge test for an element modified locally and untouched by the agent.

- **[P3·crash]** An arrow or line with fewer than two points panics three Rust paths
  `src-tauri/src/commands/sketchdoc.rs:1357` — Exporting, reading or drawing on a hand-edited or imported .sketch whose arrow/line carries one point panics the command instead of reporting a bad file; the UI waits on a promise that never resolves.
  _Fix:_ Repair in `Sketch::from_json` the way the TS `isElement` does — drop (or extend) arrow/line/pen elements with fewer than two points — and belt-and-braces the three call sites with `points.first()`/`points.last()`. Add a `from_json` test for a one-point arrow.

- **[P3·test-gap]** The two "the editor routes exactly like Rust" tests only grep for a function name, and the two routers genuinely differ
  `src-tauri/src/commands/sketchdoc.rs:2390` — A connector's endpoints shift by ~2 units (more on diagonals) depending on which side last touched the file, so every alternation between the agent and the editor rewrites it; and two shapes sharing a centre make Rust route a connector to the page origin while the editor routes it to the centre.
  _Fix:_ Pick one formula and one gap constant, and replace both string-matching tests with a shared fixture table (a handful of box pairs, including a diagonal pair and a concentric pair, with expected endpoints) asserted by the Rust test and by sketch.test.mjs. Add the `!t.is_finite()` guard to `edge_point` to match the TS port.

- **[P3·correctness]** The element ceiling counts a script's additions without its deletions, so `clear` plus a full redraw is refused with a false number
  `src-tauri/src/commands/sketchdoc.rs:723` — Redrawing a busy page from scratch in one call is refused with a count the script would never reach, and the model is told to “draw fewer” when its script would in fact shrink the page.
  _Fix:_ Use the `live` vector pass 1 already computes — compare `live.len()` against MAX_ELEMENTS instead of recomputing a sum that only counts creations.

- **[P3·correctness]** `move` on a connector is reported as done and then silently undone by reflow
  `src-tauri/src/commands/sketchdoc.rs:1079` — The model moves an arrow, is told “moved e3 by 40,0”, then reads the drawing back and finds e3 exactly where it was — so it moves it again, and again.
  _Fix:_ In the `Move` arm, detect an attached connector and report it honestly — e.g. “e3 is a connector; it follows e1 and e2, so move those instead” — rather than claiming a change reflow will discard.


### Shell / Nav (8)


- **[P2·data-loss]** Declining the ⌘Q unsaved-edits dialog consumes the Rust quit latch, so the next ⌘Q quits silently
  `src/Workspace.tsx:188` — After answering "no" once to the quit guard, the guard is disarmed for the rest of that editing session: the next ⌘Q terminates immediately and the unsaved Monaco buffer is gone with no dialog.
  _Fix:_ Re-arm on a real "no": from the decline branch call a dedicated `rearm_quit_guard` command (or `setUnsavedEdits(false)` immediately followed by `setUnsavedEdits(true)`) and reset the poll's `sent` sentinel so the push is not swallowed. Keep the fail-open latch for the case where the window never answers — e.g. arm a timeout, not a permanent flag.

- **[P2·correctness]** Trashing the room's last file leaves a ghost tab that persists across relaunch and also suppresses the saved-area restore
  `src/Workspace.tsx:642` — A room whose file list becomes empty keeps a tab pointing at the deleted file. It is persisted, re-activated on the next unlock, produces a "Could not open that file" toast over an empty workspace, and blocks the saved-destination restore until the user closes it by hand.
  _Fix:_ Guard on "the list has loaded", not "the list is non-empty": set a `filesLoadedRef` on the first successful `listFiles()` and let the effect run with an empty array. Belt and braces: have `removeFile`/`removeFiles`/`destroyFile`/`destroyFiles` close the matching tab id directly, and make the apply effect drop a tab whose `viewFile` failed.

- **[P2·correctness]** Renaming the room re-runs the tab/area restore and closes the open section-only document
  `src/Workspace.tsx:493` — Renaming the room from the top bar closes whatever section-only object is open (a sketch, a creation) and re-enters the destination from `workspace_area`, as though the room had been reopened.
  _Fix:_ Identify the ROOM by something a rename cannot change: `useTabs(info.path)` and `areaRestoredFor.current === info.path` (the path is already the layout key, and tabs.ts's comment "tabs belong to a room, not to the window" is about identity, not display name).

- **[P2·privacy]** The mic tap is never stopped when the workspace unmounts
  `src/workspace/effects.ts:733` — Nothing in the effect's teardown stops the microphone tap, so the tap's lifetime depends entirely on a `rec-state` event arriving before the listener is removed. If it loses that race, the MediaStream and AudioContext survive the lock: the macOS mic indicator stays lit over a sealed room and the worklet keeps calling `rec_push_audio` four times a second (into swallowed 'No live recording.' errors).
  _Fix:_ Call `stopMicTap()` in the effect's cleanup — it is idempotent and costs nothing when the terminal event already ran — so the tap's lifetime is bounded by the workspace's, not by an event race.

- **[P2·ux-defect]** Every successful grid cell edit remounts the spreadsheet, wiping the undo history it just recorded
  `src/workspace/effects.ts:563` — Committing a cell in Edit mode reloads and REMOUNTS SheetView, so the "N cells changed" receipt, the pink changed-cell marks, ⌘Z / the Undo button, the scroll position in a 90,000-row sheet and the keyboard focus Enter just moved are all destroyed after every single edit. The undo feature the viewer was built around is therefore inert.
  _Fix:_ Treat the grid like the editor in this listener: skip the reload+viewerRev bump when the update was caused by this pane's own write (mark the id in a ref before calling api.setCell and ignore the matching file-updated), or drop viewerRev from the grid's key so the content prop refreshes without remounting.

- **[P2·correctness]** ErrorBoundary never resets, so one pane crash outlives the destination that caused it
  `src/shell/ErrorBoundary.tsx:30` — Once any boundary catches, its pane shows "<scope> couldn't be drawn" forever — navigating to a different destination does not clear it, because the error lives in class state that nothing resets. After the TrashPanel hook crash, the reader goes to Sketch, Memory or the Browser and the entire second column is still the crash card; the only way back is to spot the small "Try again" button.
  _Fix:_ Give the boundary a `resetKey` prop (pass `area` at the sidebar/centre sites) and clear the error in `componentDidUpdate` when it changes — or hoist the `key={area}` onto the ErrorBoundary itself so a destination change mints a fresh boundary.

- **[P3·ux-defect]** Tab shortcuts still switch Home documents from destinations that draw no tab strip
  `src/Workspace.tsx:670` — ⌘⇧] / ⌘⇧[ / ⌥⌘1-9 pressed in Sketch, Skills, Memory, Create or Connectors opens a Home document that is not on screen and yanks the rail back to Home — the failure the redesign fixed for ⌘T.
  _Fix:_ Gate the three tab-key branches on `showsDocumentTabs(area)` — the same predicate the strip uses; `area` is already in the effect's dependency array.

- **[P3·correctness]** Legacy area tabs elect the last file tab when pruned, so a pre-redesign room opens on a stale document instead of its recorded place
  `src/Workspace.tsx:625` — A room whose saved `workspace_tabs` still contains `area:*` rows (every room written before places stopped being tabs) opens by applying the recorded area for one tick and is then navigated to whichever file tab happens to be last in the strip — a document the reader may not have touched in weeks.
  _Fix:_ Prune legacy area tabs with `unlist` (heirOfNothing) rather than `prune`, or make `selectionAfterDrop` refuse to elect an heir when the dropped current tab was an `area` tab — dropping housekeeping rows must never navigate.


### Retrieval / Memory (7)


- **[P2·correctness]** `duckduckgo` is the one engine not wrapped in `_fails_soft`, so one parse error kills the entire web search
  `sidecar/arcelle_sidecar/websearch.py:346` — Any non-`RequestException` raised inside the DuckDuckGo scrape — the rotted-selector `AttributeError` case `_fails_soft`'s docstring names — escapes `_fuse`, discards the other six engines' results, and answers the user 502 "Web search failed" when six engines answered fine.
  _Fix:_ Add `@_fails_soft` to `duckduckgo` (its inner `except requests.RequestException` stays — it is the do-not-retry short-circuit). Also wrap `future.result()` in `_fuse` so any future that raises sets `broke[index] = True` instead of aborting the fan-out.

- **[P2·ux-defect]** Clicking a search result never highlights the passage: the snippet still carries the ellipses the snippet builder added
  `src-tauri/src/commands/retrieval.rs:298` — Opening a content hit from the ⌘K overlay opens the file but never highlights or scrolls to the matching passage, for every clipped snippet.
  _Fix:_ Strip leading/trailing '…' from the snippet before handing it to the viewer (in activateResult, miscActions.ts:277), or add `case "…": return "";` to foldChar so it is ignored on both sides. The second is safer — it also fixes any other caller that forwards a snippet.

- **[P2·correctness]** One large file can crowd other files out of the search results
  `src-tauri/src/commands/search.rs:27` — Searching a term that appears many times in one document silently drops other matching files from the Files group, and the group's count reads as a total.
  _Fix:_ Over-fetch the chunk hits the way fts_file_matches does (or GROUP BY file_id with MIN(bm25)) before taking the first N distinct files, and label the count when the cap was hit.

- **[P2·correctness]** Standing "Instructions" memories stop being injected as the memory list grows
  `src-tauri/src/commands/retrieval.rs:359` — A standing instruction memory is silently omitted from the prompt once a few newer or more question-relevant memories fill the 1,500-char budget, while the Memory page keeps showing it under "Instructions".
  _Fix:_ Reserve budget for `category = 'instruction'` memories and inject them first (oldest-first, so the ones the user has lived with longest survive), then spend the remainder on keyword relevance. Pass the whole Memory struct into select_memories rather than flattening to strings at agent.rs:731.

- **[P2·correctness]** search_all applies two different matching rules to one query: OR for file content, AND for names, messages and memories
  `src-tauri/src/commands/search.rs:24` — One query means two things in one result list: Files lists documents containing only ONE of the typed words, while Messages, Memories and name matches are restricted to rows containing ALL of them — so relevant messages are silently missing while marginal files are listed.
  _Fix:_ Pick one semantic for the overlay and apply it to all four queries — either build the FTS expression with AND, or run the LIKE side over the same stopword-stripped term set. Whichever is chosen, align MAX_SEARCH_TERMS with question_terms' cap.

- **[P3·ux-defect]** Search snippets centre on the first word of the query, which is usually a stopword
  `src-tauri/src/commands/retrieval.rs:284` — Searching a phrase whose words are not adjacent in the text previews the region around the first (usually function) word of the query rather than the region that made the file match.
  _Fix:_ Try `question_terms(needle)` (stopwords already removed) — longest term first — before falling back to raw word order, so the snippet centres on the most selective term present.

- **[P3·correctness]** A long turn with one early blank line is cut to almost nothing in the conversation hand-off
  `src-tauri/src/commands/retrieval.rs:333` — The oldest turn kept by the hand-off can shrink to its first sentence (or to nothing but the omitted-marker) while tens of KB of budget go unspent.
  _Fix:_ Accept the paragraph boundary only when it is within a bounded distance of `cut` (say the last 20% of the fragment); otherwise cut at `cut` itself. Add a fixture with one early blank line and assert the kept piece is close to the budget.


### Voice (5)


- **[P2·ux-defect]** Pressing Play on a second answer leaves no message marked as speaking — the Stop button never appears
  `src/workspace/voiceActions.ts:19` — With answer A still being read aloud, pressing Play on answer B starts B but leaves no message marked as speaking: B's button still reads 'Play', and pressing it restarts B from the top instead of stopping it.
  _Fix:_ Set the id after the pipeline has been claimed — call `voice.speakText(...)` first and `s.setSpeakingMsgId(m.id)` after — or have `speakText` swap `onManualState` without invoking the outgoing one when a replacement is supplied in the same call.

- **[P2·ux-defect]** The sentence splitter cuts inside URLs, so raw URLs are read aloud instead of the link label
  `src/workspace/voice.ts:416` — Any answer containing a markdown link with a dotted URL is cut mid-URL and the URL text is read aloud, brackets and all, instead of just the link label — with the chunk boundaries landing mid-token.
  _Fix:_ Run the link/inline-code replacements of `stripForSpeech` over `work` before the sentence regex in `extractSentences` (keeping the fence hold as-is), or extend the mid-token guard so a '.' with a non-space, non-capital immediately after it is not treated as a sentence end.

- **[P3·correctness]** Manual Play or Settings Preview during an answer silently kills hands-free for good
  `src/workspace/voice.ts:238` — With hands-free on, pressing Play on an older message (or Preview in Settings) while an answer is streaming means the mic is not re-armed when that answer finishes. The user has to click the mic or type once; the next turn re-arms normally.
  _Fix:_ Track 'a streamed turn is still open' separately from 'who owns the audio pipeline' (a flag only `beginTurn`/`cancelAll` clear), and let `endOfTurn` fire the turn-done signal for the ask that closed even when a manual play has taken the pipeline.

- **[P3·ux-defect]** A synthesis failure that lands after Stop still toasts 'Couldn't read that aloud'
  `src/workspace/voice.ts:522` — After Stop (or a room autolock), an already-in-flight /tts call that then fails pops a red 'Couldn't read that aloud…' toast about a turn the user deliberately stopped.
  _Fix:_ Check the epoch first inside the catch (`if (epoch !== myEpoch) return;` before `reportVoiceProblem`). Resetting `problemReported` in `cancelAll` is worth doing for symmetry with beginTurn/speakText but is not what fixes this.

- **[P3·test-gap]** The whole spoken-voice pipeline has no automated test anywhere in the repo
  `src/workspace/voice.ts:400` — `extractSentences`, `emit`, `queueChunk`, `breakPoint`, `stripForSpeech` and the beginTurn/roundBoundary/endOfTurn/cancelAll lifecycle are pure, easily testable logic with no exercising test, so the URL-splitting and hands-free-re-arm defects sit in a fully green suite.
  _Fix:_ Export the pure chunker helpers and add a node:test suite: Western and CJK splitting, the decimal guard, a markdown link (the confirmed bug), fence hold/drop, force-flush sizing, and a lifecycle test asserting a manual `speakText` mid-ask does not swallow the streamed turn's audio-done signal.
