
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- ADD-16: one flat level of folders. A file's folder_id is NULL at top level.
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'upload',
  original_bytes BLOB,
  extracted_text TEXT,
  folder_id TEXT,
  -- ADD-17: cached one-line "what is this file" summary, cleared whenever the
  -- file's content changes so re-summarizing only touches new/changed files.
  ai_summary TEXT,
  -- BROWSE-2 (D19): where a downloaded file came from. NULL for everything
  -- that did not arrive over the network (uploads, generated files).
  origin_url TEXT,
  -- What a video ACTUALLY is (media_probe::MediaMeta as JSON): duration,
  -- display size, codec, frame rate, audio track. NULL means "not probed
  -- yet" — a probe that read nothing stores nothing, so NULL never has to
  -- stand in for "we looked and there was no answer".
  media_meta TEXT,
  -- What a SAVED WEB PAGE declares about itself (extraction::PageMeta as
  -- JSON): title, site, author, publication date, language, plus the room's
  -- own source URL and capture time. A field the page never declared is absent
  -- from the JSON — the room stores what the page said, and an author or a
  -- date it did not say has no value that could stand in for one. NULL means
  -- "this file did not come from a web page".
  web_meta TEXT,
  -- Room map: the file this one was MADE from, when a generator knows it (a
  -- full pass's source, a translated transcript's recording). NULL means "no
  -- provenance recorded" — never "made from nothing" — so the map draws a
  -- `derived` link only where the app actually witnessed the derivation
  -- instead of guessing from the output's name.
  derived_from TEXT,
  -- ART-1: what produced this file's CURRENT content (`Provenance` as JSON) —
  -- run id, agent/tool name, source file ids. Ids only, never content. This is
  -- the head of the same chain `file_versions.provenance` records for older
  -- states, so every version of a generated artifact can say what made it.
  -- Distinct from `derived_from`, which is a single file→file link for the room
  -- map and survives independently. NULL means nobody recorded it.
  provenance TEXT,
  -- ART-1: the name the generator ASKED for, which is what identifies an
  -- artifact across re-runs. Usually the same as `name`, but not always: when a
  -- file a PERSON put in the room already holds the requested name, the artifact
  -- lands under `available_name`'s next free one ("Plan (2).md") while its key
  -- stays "Plan.md". Matching the next generation on the KEY rather than on the
  -- final name is what stops a re-run minting "Plan (3).md", "Plan (4).md" …
  -- forever instead of versioning its own previous output. NULL for everything
  -- that did not come through the funnel, and CLEARED on rename — a file the
  -- user renamed is one they have adopted, and the next run must leave it alone
  -- and mint its own.
  artifact_key TEXT,
  -- Trash: when this file was deleted. NULL is the ONLY value that means
  -- "present in the room" — every listing, count, search and retrieval query
  -- filters on `trashed_at IS NULL`, so a trashed file is absent everywhere the
  -- user or the model can see, while its row and its bytes survive.
  trashed_at TEXT,
  -- Who deleted it: 'user' (a person clicked delete), 'agent' (the AI deleted
  -- it on its own), or 'app' (the app's own housekeeping). "What did the agent
  -- delete" is the question the trash exists to answer, so the actor is
  -- recorded at the moment of deletion rather than inferred later.
  trashed_by TEXT,
  -- WHICH actor, as an id: the agent/tool name for an 'agent' delete, the
  -- command for an 'app' one. NULL when the kind alone is the whole answer.
  trashed_by_id TEXT,
  -- Which destination MADE this file: 'library' (imported, generated, saved
  -- from the browser — anything that belongs to the room at large), 'sketch',
  -- 'create', 'recordings'. Ownership, and deliberately not the same question
  -- as `library_visibility` below: a sketch stays a sketch whether or not Home
  -- is also showing it, so promotion never has to rewrite where a thing lives.
  origin_destination TEXT NOT NULL DEFAULT 'library',
  -- Whether Home's Library shows this file: 'linked' or 'sectionOnly'. A
  -- section-only file is a full room file — encrypted, versioned, searchable,
  -- attachable — that simply does not appear in Home; it appears in the
  -- destination that made it. 'linked' is the default so that everything the
  -- room already holds keeps being visible exactly where it was, and only the
  -- tool-native creation paths opt their own new objects out.
  library_visibility TEXT NOT NULL DEFAULT 'linked',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
-- Trash: where a trashed file's search chunks WAIT. Trashing moves the rows out
-- of `chunks` and into here; restoring moves them back verbatim, embedding blob
-- and all.
--
-- Why move them instead of adding `AND f.trashed_at IS NULL` to the retrieval
-- joins: two of the hot retrieval queries (`for_each_chunk_embedding`,
-- `fts_file_matches`) never touch the `files` table at all, so there is no `f`
-- to filter on, and any future query over `chunks` would silently inherit the
-- bug. Emptying the table is the invariant — a trashed file cannot be retrieved
-- because its text is not in the index, not because every reader remembered to
-- ask. It also makes restore exact: re-chunking from `extracted_text` would
-- come back with NULL embeddings and stay invisible to vector search until a
-- background pass happened to re-embed it.
CREATE TABLE IF NOT EXISTS trashed_chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_trashed_chunks_file ON trashed_chunks(file_id);
-- HLT-3: full-text index over chunk text, kept in sync by the triggers below.
-- External-content table: rows live in `chunks`, the index only stores terms.
-- CHG-14: porter stemming so plural/inflected query words match singular
-- document words ('invoices' → 'invoice', 'renewing' → 'renewal').
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
  USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  sources TEXT,
  effects TEXT,
  kind TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  -- Wave 1b (idea 5): preference | fact | project | instruction; NULL =
  -- uncategorized (every legacy row). Organizational only in v1.
  category TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- S9 (2026-08-04): soft delete, same shape as files' trash — NULL means
  -- never trashed. `delete_memory` was the app's one truly irreversible AI
  -- action; every other write has snapshot/Undo or the files Trash tab.
  trashed_at TEXT,
  trashed_by TEXT,
  trashed_by_id TEXT
);
CREATE TABLE IF NOT EXISTS web_pages (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  raw_html BLOB,
  readable_text TEXT,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- RM-2: one cache row per URL so repeat fetches upsert instead of piling up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_web_pages_url ON web_pages(url);
-- BROWSE-3b: preview-image bytes for search results, keyed by the image's own
-- URL. Every byte arrived through the Rust guard, so the results page can render
-- from data URLs and never make a request of its own.
CREATE TABLE IF NOT EXISTS web_images (
  url TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- CHG-33: short-lived web_search results cache, keyed by normalized query. This
-- lived ONLY in `migrate` for a while, which meant a brand-new room (which runs
-- SCHEMA and never migrate) had no table at all: every attempt to remember a
-- search failed silently until the room was closed and reopened. Both places
-- must mint every table — `migrate` for rooms written before it existed, here
-- for the ones created from now on.
CREATE TABLE IF NOT EXISTS web_searches (
  query_key TEXT PRIMARY KEY,
  results_text TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- PRIV-1: the room's protected-entity map — one row per real string that must
-- never reach a non-local model. `placeholder` is stable for the room's life so
-- cloud conversations stay coherent across turns ("[Person A]" is always the
-- same person) and answers can be re-personalized locally. `source` is 'user'
-- (the block list — iron-clad, added by hand) or 'scan' (found by the local
-- import-time scanner — reviewable in the reader's blackout view).
CREATE TABLE IF NOT EXISTS privacy_entities (
  id TEXT PRIMARY KEY,
  real_text TEXT NOT NULL UNIQUE,
  placeholder TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'concept',
  source TEXT NOT NULL DEFAULT 'scan',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- PRIV-2: per-file scan bookkeeping — which text + which rules the last scan
-- reflects, so imports/rule-edits re-scan only what actually changed.
CREATE TABLE IF NOT EXISTS privacy_scans (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  text_sha256 TEXT NOT NULL,
  rules_sha256 TEXT NOT NULL,
  scanned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- ADD-2: previous bytes of a file, captured before each overwrite so any
-- change can be undone. Dropped automatically when the file is deleted.
CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  bytes BLOB NOT NULL,
  -- Compound snapshot: for Recordings the bytes are the unchanged WAV and the
  -- overwrite replaces the TRANSCRIPT — so text + recording meta ride along,
  -- or restore could never bring the old words/speakers/cuts back.
  text TEXT,
  rec_meta TEXT,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  cause TEXT NOT NULL,
  -- ART-1: what produced the content this row snapshots (`Provenance` as
  -- JSON) — run id, agent/tool name, source file ids. Ids only, never
  -- content. NULL means "nobody recorded it", never "a person typed it".
  provenance TEXT,
  -- A version the user asked to KEEP. The prune in `snapshot_file_version`
  -- counts and deletes only unpinned rows, so a pinned version survives any
  -- number of later saves — the one way to stop the rolling window from
  -- silently eating the state you actually wanted back.
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id);
-- ART-1: the staging area for AI-generated artifacts. A generator writes its
-- bytes HERE, they are validated here, and only then does one transaction move
-- them into `files`. A crash, a Stop, or a failed validation therefore leaves
-- the room's real files exactly as they were — there is no window in which a
-- half-written artifact is what the library shows. Staging lives INSIDE the
-- encrypted room like everything else: a scratch file in /tmp would put room
-- content outside the room, which is the one thing this app does not do.
--
-- Rows are transient. A commit deletes its own row; anything an interrupted run
-- left behind is swept on the next room open (`sweep_staged_artifacts`), which
-- is why nothing else in the app ever reads this table.
CREATE TABLE IF NOT EXISTS staged_artifacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  text TEXT,
  provenance TEXT,
  staged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- ADD-27: live-recording metadata (word timings, speakers, cuts) as one JSON
-- blob per file. Row existence marks the file as a Recording in the viewer.
CREATE TABLE IF NOT EXISTS recordings (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  meta TEXT NOT NULL
);
-- A generated podcast SCRIPT, as data: its hosts, its turns, and the voice
-- assigned to each host. Keyed by the script page's file id.
--
-- WHY A TABLE AND NOT A ROOM FILE. The turns have to be re-readable to render
-- audio, and re-readable AFTER the user re-casts a host, without asking the
-- model to write the episode again. A companion "<name>.podcast.json" would do
-- that too, at the cost of a file in the library that nobody wants to open and
-- that every count, search and AI-source list would have to carry.
--
-- `audio_file_id` is the rendered episode, when one exists — a plain room file
-- like any other, so it plays, seeks and exports with no special case. NULL
-- means the script has never been recorded, which is the state every podcast
-- starts in.
CREATE TABLE IF NOT EXISTS podcasts (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  -- [{"speaker": "...", "line": "..."}], the model's own output, in order.
  turns TEXT NOT NULL,
  -- [{"name": "...", "voice": "...", "rate": "...", "pitch": "..."}] — the
  -- CAST. Written once from the script, then owned by the user's edits.
  --
  -- NOT named `cast`: SQLite parses a bare `cast` in a SELECT LIST as the start
  -- of a CAST(x AS y) expression, so `SELECT file_id, cast FROM podcasts` is a
  -- syntax error while `INSERT INTO podcasts(file_id, cast)` is perfectly legal
  -- — the write half works and only the read half breaks.
  cast_json TEXT NOT NULL,
  audio_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- Live-recording audio checkpoints (raw 16-bit PCM since the last full WAV
-- write). Normally empty: pause/stop assemble the WAV and clear them; rows
-- surviving here mean a crashed session, recovered on the next room open.
CREATE TABLE IF NOT EXISTS rec_chunks (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  pcm BLOB NOT NULL,
  PRIMARY KEY (file_id, seq)
);
-- ADD-30/ADD-32: durable background jobs + their per-step artifacts. These
-- MUST live in SCHEMA as well as migrate(): create_room runs only SCHEMA, so
-- a table that exists only in migrate() is missing from a brand-new room
-- until it is closed and reopened (a job started in a fresh room would fail
-- with "no such table: jobs").
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  cursor INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  -- Wave 4a: set on a child job a workflow drives INLINE (a file_pass node). The
  -- queue pump, resume_job and quiesce all skip these — the parent workflow job
  -- holds the lane slot and re-drives the child on its own resume, so a child
  -- must never start (or be Resumed) independently.
  parent_job_id TEXT,
  -- Why this job stopped when NOBODY chose to stop it: the room was locked, or
  -- the app closed, while it was still running. 'paused' alone cannot say that
  -- — it is also what pressing Stop writes — so a job the app dropped read as a
  -- job the user parked. NULL means the pause was the user's own.
  parked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS job_artifacts (
  job_id TEXT NOT NULL,
  step_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (job_id, step_id)
);
-- Wave 4a (Idea 2): LLM graph workflows. `definition` is the immutable
-- WorkflowDef JSON (nodes + edges); a RUN snapshots it into the jobs plan, so a
-- later edit never corrupts a paused run. `binding` (shortcuts extension) scopes
-- where a workflow surfaces (general vs file-kind); `pinned` shows it in the top
-- bar. MUST live in SCHEMA and migrate() (the schema.rs:115-119 rule).
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL DEFAULT 'user',
  binding TEXT NOT NULL DEFAULT '{"scope":"general"}',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  job_id TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  input_file_id TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON workflow_runs(workflow_id);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  param TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  catch_up INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  last_job_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedules_wf ON schedules(workflow_id);
-- Agent Skills are a separate library, not room files.  The two-table shape is
-- an encrypted representation of the portable folder contract: one metadata +
-- instruction row (SKILL.md) and any number of relative resource paths below it.
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT 'user',
  agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS skill_resources (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'reference',
  content BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(skill_id, path)
);
CREATE INDEX IF NOT EXISTS idx_skill_resources_skill ON skill_resources(skill_id);
CREATE TABLE IF NOT EXISTS browse_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  -- Which browsing SITTING this line belongs to: minted when the first page
  -- opens and cleared when the last one closes, so the Journal can separate
  -- what is happening now from everything that came before. Empty for lines
  -- written outside a sitting, and for every line written before this column
  -- existed.
  session TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- The voices this room can recognise: one row per person the user has NAMED in
-- a recording, so the next recording puts the name back on them instead of
-- starting again at "Speaker 2" (see db/voices.rs for why they live in the
-- room and nowhere else). `emb` is the L2-normalized neural centroid as raw
-- little-endian f32; `frames` is the 16 ms voiced frames behind it and `takes`
-- how many namings have been folded in, which together are the evidence the
-- Settings list shows and the weight a further naming is merged at. The NAME
-- is the key: one person, one voice.
CREATE TABLE IF NOT EXISTS voice_ids (
  name TEXT PRIMARY KEY,
  emb BLOB NOT NULL,
  frames INTEGER NOT NULL DEFAULT 0,
  takes INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- Voices the user has said are NOT that person — one row per corrected guess.
-- Without them a wrong match is wrong again in every future recording, because
-- correcting it only ever taught the OTHER name.
CREATE TABLE IF NOT EXISTS voice_rejects (
  name TEXT NOT NULL,
  emb BLOB NOT NULL,
  PRIMARY KEY (name, emb)
);
-- The room's CAST: the people a story is about.
--
-- Room-level, not per-story, because a cast is reused — the same hero appears
-- in every scene, and re-describing them per shot is exactly what makes a
-- character look different in every picture.
--
-- `face_file_id` is the load-bearing column, and it is a FILE not a prompt.
-- Character consistency does not come from words: "a woman with red hair"
-- is re-imagined from scratch on every call. It comes from handing the model
-- the SAME picture each time, which is what `input_references` is for. The
-- description and backstory are for the prompt and for the user's own memory;
-- the picture is what actually holds a face together across shots.
--
-- ON DELETE SET NULL, not CASCADE: trashing a hero's portrait must not delete
-- the hero. Their description and story are the user's writing.
CREATE TABLE IF NOT EXISTS story_cast (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  story TEXT NOT NULL DEFAULT '',
  face_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- One script. NOT called a "script" anywhere the user can see it: this app
-- already has Scripts, meaning runnable Python (`run_script`, the Scripts
-- page, the `script_run` workflow node). Two meanings for one word in one
-- product is a bug in the product. On screen it is a SHOT LIST.
-- `aspect_ratio` is ONE value for the whole list, not one per shot, and that
-- is a claim about the domain rather than a shortcut: an episode whose shots
-- change shape halfway through is a mistake, never an intention. It is also
-- load-bearing — a shot's still becomes its clip's literal first frame, so a
-- 1:1 picture handed to a 16:9 clip is pinned to a frame the wrong shape.
--
-- Size is per medium because the two endpoints publish different vocabularies
-- for it: `/images/models` says "1K"/"2K", `/videos/models` says
-- "720p"/"1080p"/"4K". One column would have to mean both.
CREATE TABLE IF NOT EXISTS story_lists (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  logline TEXT NOT NULL DEFAULT '',
  aspect_ratio TEXT NOT NULL DEFAULT '',
  still_resolution TEXT NOT NULL DEFAULT '',
  clip_resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- One shot: what happens, who is in it, how long, and what came back.
--
-- `still_file_id` and `clip_file_id` are the chain. A shot is made in two
-- steps — draw the frame, then animate it — and keeping both means the still
-- can be re-animated (a different length, a different model) without paying
-- to draw it again. `cast_ids` is JSON because SQLite has no array type and a
-- join table for a handful of ids per shot buys nothing here.
CREATE TABLE IF NOT EXISTS story_shots (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES story_lists(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT '',
  cast_ids TEXT NOT NULL DEFAULT '[]',
  seconds INTEGER,
  image_model TEXT NOT NULL DEFAULT '',
  video_model TEXT NOT NULL DEFAULT '',
  still_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  clip_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_story_shots_list ON story_shots(list_id, ord);
