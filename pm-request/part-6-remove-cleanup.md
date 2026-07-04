# Part 6 — Things to remove or clean up

Leftover pieces that no longer serve a purpose. Small work, keeps the
codebase honest.

---

## RM-1 — Delete the unused `chat_stream` function

**Goal**
No dead code — a light switch wired to nothing confuses the next reader.

**Task**
Remove `chat_stream` from `src-tauri/src/ollama.rs` (~line 52). It is a
thin wrapper that nothing calls (verified by search: only its definition
exists).

**How to do it**
1. Delete the function.
2. Build: `cd src-tauri && cargo build`. If anything fails, it was a
   caller we missed — reconsider.

**How to check it**
1. `grep -rn "chat_stream(" src-tauri/src` returns nothing but
   `chat_stream_tools`.
2. `cargo build` and `cargo test` pass. App runs, chat still streams.

**Acceptance criteria**
- [ ] Function removed; no references remain.
- [ ] Build and tests green; chat unchanged.

---

## RM-2 — Stop writing ghost data: make the web-page cache real (or remove it)

**Goal**
The room should not silently collect data that nothing ever reads.

**Task**
Today every `fetch_page` call INSERTs a row into `web_pages`
(`src-tauri/src/commands.rs`, fetch_page handler), but no code ever reads
that table, and the `raw_html` column is never written at all.
Pick one path — recommended: **make the cache real** (it also feeds the
future link-import feature, ADD-12).

**How to do it (recommended path A — real cache)**
1. Before fetching, SELECT from `web_pages` by exact URL where `saved_at`
   is newer than 24 hours. If found, return the stored title/text and skip
   the network entirely.
2. Change the INSERT to an upsert keyed by URL, so repeat fetches do not
   pile up duplicate rows.
3. Leave `raw_html` alone for now; add a code comment pointing to ADD-12
   (link import) as its future user.

**Path B (if you prefer pure removal)**
1. Delete the INSERT in `fetch_page`.
2. Keep the table definition (dropping columns needs a migration and old
   rooms may hold rows) with a comment explaining it is reserved.

**How to check it (path A)**
1. Turn web on, ask the AI to fetch the same URL twice.
2. Second fetch returns instantly and the "leaves this Mac" notice is not
   needed (log or breakpoint shows no network call).
3. The `web_pages` table has one row for that URL, not two.

**Acceptance criteria**
- [ ] No table grows forever without a reader.
- [ ] (Path A) repeat fetch within 24 h uses the cache; rows are deduped by URL.
- [ ] The chosen decision is recorded in a code comment.

---

## RM-3 — Remove the "sign me" trigger word

**Goal**
The image-locating shortcut should not fire on unrelated sentences.

**Task**
The keyword list in `is_locate_intent` (`src-tauri/src/commands.rs`,
~line 1348) contains `"sign me"` — almost certainly a typo (the list
already has "show me"). It makes the app run a slow image-analysis pass
at the wrong moments.

**How to do it**
1. Delete `"sign me"` from the array.
2. While there, read the remaining keywords out loud once and confirm each
   one really means "the user wants something located in an image".
3. Add a tiny unit test for `is_locate_intent`: "show me the cat" → true,
   "please sign me up" → false.

**How to check it**
1. Attach an image and ask "can you sign me up for the newsletter?" —
   the app must answer normally with NO extra multi-second grounding pass
   (no "📍 Marked on the image" attempt).
2. "Show me where the signature is" still triggers marking.

**Acceptance criteria**
- [ ] "sign me" removed; unit test in place.
- [ ] Locating still triggers on real locate questions.

---

## RM-4 — Fix the stale model comment

**Goal**
Comments must not lie — future-you will trust them.

**Task**
The comment above `best_default` in `src-tauri/src/commands.rs` (~line 984)
still says the chat default is "gemma3". The code returns `qwen3.5:4b`
(`DEFAULT_MODEL`). Update the comment to describe today's behavior.

**How to do it**
1. Rewrite the comment: default is `DEFAULT_MODEL` (qwen3.5:4b), falling
   back to the first installed model.
2. `grep -rn "gemma3" src src-tauri/src` and fix any other stale mentions
   (keep the README's design/history sections if they are accurate).

**How to check it**
1. Grep shows no misleading gemma3 references in code comments.

**Acceptance criteria**
- [ ] Comment matches the code.
- [ ] No other stale model references in comments.

---

## RM-5 — Drop the pre-filled DuckDuckGo plug-in example

**Goal**
One clear internet switch (see CHG-2). The shipped MCP example is a second,
confusing path to web search.

**Task**
Change `DEFAULT_MCP_CONFIG` in `src-tauri/src/commands.rs` (~line 24) from
the DuckDuckGo example to an empty scaffold, and update the Settings help
text that currently points at it.

**How to do it**
1. Set the default to `{ "mcpServers": {} }` (pretty-printed so it is easy
   to edit).
2. In `src/Settings.tsx`, rewrite the "Connections (MCP)" hint: this is an
   advanced section for connecting external tools; remove the sentence
   about the DuckDuckGo example and `"disabled": true`.
3. Do not touch configs already saved inside existing rooms.

**How to check it**
1. Create a new room → Settings → MCP box shows the empty scaffold.
2. An old room that saved the DuckDuckGo config still shows its own config
   untouched.
3. Web search via Settings → Online features still works as the one
   built-in path.

**Acceptance criteria**
- [ ] New rooms ship with an empty MCP config.
- [ ] Help text no longer references the removed example.
- [ ] Existing rooms' saved configs are unchanged.
