export interface RoomInfo {
  name: string;
  path: string;
  fileCount: number;
  messageCount: number;
  /** True when the room file lives in a cloud-sync folder (HLT-6). */
  synced: boolean;
  /** Set when the room has enabled MCP servers whose config fingerprint is
   * not yet approved on this Mac — the UI must ask before anything runs
   * (SEC-1). null when there's nothing to approve. */
  pendingMcp: McpApproval | null;
}

/** An MCP config awaiting the user's approval before its servers start (SEC-1). */
export interface McpApproval {
  fingerprint: string;
  servers: { name: string; command: string }[];
}

/** ART-1: what produced one state of a generated artifact — ids and names only,
 * never content. Every field is optional because the room records what it
 * actually witnessed: a missing `agent` means nobody recorded one, not "unknown
 * agent". */
export interface Provenance {
  runId?: string;
  agent?: string;
  tool?: string;
  sourceFileIds?: string[];
}

/** A prior saved state of a file (ADD-2). `provenance` is present only where the
 * app witnessed the write (ART-1) — absent on a person's own saves and on every
 * version from before provenance was recorded. */
export interface FileVersion {
  id: string;
  savedAt: string;
  cause: string;
  provenance?: Provenance;
  /** Kept on purpose: outside the rolling window the room prunes on each save. */
  pinned: boolean;
  /** Bytes this snapshot occupies — every version is a whole copy of the file. */
  bytes: number;
}

/** Idea 11: a saved version's extracted text next to the file's current text,
 * for the read-only side-by-side compare view. Either side is null when that
 * file kind has no comparable text (image/binary). */
export interface VersionContent {
  fileName: string;
  versionText: string | null;
  currentText: string | null;
}

/** Idea 9: one whole-room checkpoint — a full encrypted copy of the room file
 * beside it, with plaintext metadata only (name/date/size). `auto` marks the
 * pre-rollback safety copies (capped, pruned) apart from user checkpoints. */
export interface CheckpointMeta {
  id: string;
  name: string;
  createdAt: string;
  sizeBytes: number;
  auto: boolean;
}

/** A recently opened room, listed on the start screen (ADD-5). */
export interface RecentRoom {
  name: string;
  path: string;
  /** Unix epoch millis of the last open; absent for entries saved earlier. */
  openedAt?: number | null;
  /** True when nothing is at `path` any more — moved, deleted, or on a drive
   * that isn't plugged in. Recomputed by `list_recent` on every read, so it is
   * an answer about right now, not a cached one. */
  missing?: boolean;
}

export interface FileMeta {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  source: string;
  hasText: boolean;
  createdAt: string;
  /** Folder this file sits in, or null for the top level (ADD-16). */
  folderId: string | null;
  /** True when only the first N chunks were indexed (HLT-4). */
  partiallyIndexed: boolean;
  /** The cached one-liner describing this file ("Describe new files
   * automatically" in Settings, or a manual Summarize-room run) — null until
   * that has run for this file, or for a file with nothing to describe. */
  aiSummary: string | null;
}

/** Who deleted a file. Recorded at the moment of deletion — `"unknown"` is a
 * row written before the actor was tracked, and says so rather than being
 * blamed on the person. */
export type TrashActorKind = "user" | "agent" | "app" | "unknown";

/** Trash: a deleted file, as the trash view shows it. NOT a `FileMeta` — a
 * trashed file is not in the room, and giving it the same shape invites it into
 * a list that means "what's here". */
export interface TrashedFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** When it was deleted (ISO-8601, the room's own clock). */
  trashedAt: string;
  trashedBy: TrashActorKind;
  /** Which agent/tool or which command, when the kind alone isn't the answer. */
  trashedById: string | null;
  /** The folder it goes back to on restore, or null for the top level. */
  folderId: string | null;
}

/** A one-level folder inside the room (ADD-16). */
export interface Folder {
  id: string;
  name: string;
}

/** One speaker in a podcast script, and the voice that reads them. */
export interface PodcastHost {
  /** The JOIN KEY between a line and a voice — the speaker name exactly as it
   * appears in every turn. Renaming a host rewrites its turns to match. */
  name: string;
  /** A neural voice id from the live catalog. "" = the product default. */
  voice: string;
  /** Edge prosody, e.g. "+22%" / "-2Hz". "" = the service default. */
  rate: string;
  pitch: string;
}

/** One line of an episode. */
export interface PodcastTurn {
  speaker: string;
  line: string;
}

/** A generated podcast script as DATA, so its hosts can be cast and the
 * episode rendered without asking the model to write it again. */
export interface Podcast {
  /** The script page's file id — the row's identity. */
  fileId: string;
  title: string;
  turns: PodcastTurn[];
  cast: PodcastHost[];
  /** The rendered episode, when one exists — an ordinary room file. */
  audioFileId: string | null;
  createdAt: string;
}

/** One file a batch operation could not act on, and why. */
export interface BulkFailure {
  /** The file's name, or its id when even that could no longer be read. */
  name: string;
  error: string;
}

/** What a batch file operation actually did (`commands::bulk`).
 *
 * Every field is read back from the room, never assumed from the input list —
 * which is the whole reason these commands return a value instead of `void`.
 * A multi-file move is best-effort by design (unlike `edit_files`, which is
 * atomic): independent files must not lose 39 good moves to a 40th bad id, so
 * the ones that failed come back NAMED rather than silently dropped. */
export interface BulkReport {
  /** Names of the files that really changed, in the order given. */
  ok: string[];
  failed: BulkFailure[];
  /** Ids past the backend's per-batch ceiling that were never attempted. */
  capped: number;
}

/** A prebuilt "#name" chat workflow, for autocomplete/help. */
export interface ChatCommand {
  name: string;
  summary: string;
  usage: string;
}

/** One specialist agent this room can dispatch a turn to, for the composer's
 *  "*name" menu. Derived per room by the sidecar registry (`list_specialists`),
 *  never a list this frontend keeps: a room with the internet switched off has
 *  no Web specialist to offer, and the menu has to agree with the turn. */
export interface Specialist {
  /** The short key the user types after "*" ("browse"). */
  key: string;
  /** The `ask_*_agent` tool this specialist's domain hangs under. */
  tool: string;
  /** The worker this tag runs ("chat.browse"). One row per AGENT, not per
   *  domain — the Browser agent is its own menu entry beside the Web agent. */
  agent: string;
  /** Its own label, the same words the agent diagram uses ("Browser agent"). */
  label: string;
  /** One plain-words noun phrase: the area it covers. */
  area: string;
  /** The full sentence: what it can actually be asked for. */
  description: string;
}

/** Grouped results of a room-wide search (ADD-6). */
export interface SearchResults {
  files: { id: string; name: string; snippet: string }[];
  messages: { chatId: string; messageId: string; snippet: string }[];
  memories: { id: string; snippet: string }[];
}

export interface ImportReport {
  imported: FileMeta[];
  errors: string[];
}

/** A single AI action definition surfaced in the file/room "AI actions" menu.
 *  `scope` decides where it appears (file context menu vs whole-room area);
 *  `needsQuestion` is true only for "research", which shows an extra field. */
export interface AiActionDef {
  id: string;
  title: string;
  description: string;
  scope: "file" | "room";
  needsQuestion: boolean;
  /** ADD-27: true only for "translate" — the modal shows a language picker. */
  needsLanguage: boolean;
  defaultPrompt: string;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: string;
}

export interface Message {
  id: string;
  role: string;
  content: string;
  sources: string[];
  createdAt: string;
  /** ADD-23: structured viewer effects (boxes/annotation) for this turn.
   * Rendered from data — the message content itself stays plain prose.
   * Null for plain answers and for user messages. */
  effects: MessageEffects | null;
  /** Marks a non-ordinary row without repurposing `role` — today only
   * `"handoff"` (a context-compaction summary marker). Null/absent for every
   * ordinary user/assistant message. */
  kind?: string | null;
}

/** PRIV-1: one protected entity in the room's map. */
export interface PrivacyEntity {
  id: string;
  realText: string;
  placeholder: string;
  category: string;
  /** "user" (block list) | "scan" (found by the local scanner). */
  source: string;
}

/** PRIV-1: the Settings section's full picture. */
export interface PrivacyStatus {
  globalDefaultOn: boolean;
  /** The room's explicit override: "on" | "off" | null (= follow global). */
  roomSetting: string | null;
  effectiveOn: boolean;
  entities: PrivacyEntity[];
  concepts: string[];
  pendingFiles: number;
  scanning: boolean;
  /** Whether remote-connector arguments are masked right now. NOT implied by
   * `effectiveOn` — that seam is deliberately switch-blind, so the panel is
   * told rather than left to infer it. */
  connectorArgsMasked: boolean;
}

/** PRIV-1: the reader's cloud view — the file exactly as a non-local model
 * would receive it. */
export interface PrivacyPreview {
  text: string;
  entitiesHidden: number;
  replacements: number;
  present: string[];
}

/** PRIV-1: the ask-privacy event — what the door did on one turn. */
export interface AskPrivacy {
  entities_hidden?: number;
  replacements?: number;
  images_blocked?: number;
  bypassed?: boolean;
}

/** The token-budget bar's 5 fixed breakdown categories, in legend/stacking
 * order (tokens.css --tok-* vars). Never reordered. */
export type TokenCategory = "system" | "history" | "tools" | "skills" | "files";

/** The ask-token-usage event — one live per-turn snapshot, pushed once per
 * completed assistant turn. Snake_case throughout, matching `AskPrivacy`:
 * this is a raw pass-through of the sidecar/Rust-constructed JSON value, not
 * a camelCase-derived struct. `breakdown` is always a char-length estimate
 * (proportional split, scaled to `total_tokens` when a real engine aggregate
 * is known); `estimated` flags when `total_tokens` itself is also estimated
 * (no exact usage obtainable from this engine at all). The same shape is
 * reused for the persisted `MessageEffects.usage` blob. */
export interface AskTokenUsage {
  round?: number;
  total_tokens: number;
  max_context: number;
  estimated: boolean;
  breakdown: Record<TokenCategory, { tokens: number; estimated: boolean }>;
}

/** Dispatch-first agent visibility: one roster entry per plan step — which
 * domain agent will handle it. The whole array arrives once per ask via
 * `ask-plan`, before any work starts (single-step turns get a 1-item roster).
 * Snake-free pass-through of the sidecar's plan event body. */
export interface AskPlanStep {
  /** Registry id, e.g. "jobs.run". */
  agent: string;
  /** Human-readable agent name, e.g. "Jobs & long passes". */
  label: string;
  /** The clause of the user's ask this step will execute. */
  instruction: string;
  /** This entry's own state. Every `ask-plan` is a COMPLETE snapshot, so the
   * latest one is the whole truth — no diffing, no dependence on event order
   * (children emit concurrently, so their order guarantees nothing).
   * Optional: an older sidecar omits it, and the graph falls back to deriving
   * state from the single `step` marker. */
  status?: AgentNodeStatus;
  /** Which dispatch round sent this specialist. Entries sharing a batch were
   * launched TOGETHER and run in parallel — the one fact that makes the
   * fan-out legible, and the one thing roster growth alone cannot express.
   * `null` on the Main agent, which is the hub rather than a dispatched child. */
  batch?: number | null;
  /** Uniquely addresses this node ("main", or "<agent id>#<slot>"). The
   * registry id will NOT do: one round can dispatch two `files.read` children,
   * and each needs its own tool-step bucket. */
  key?: string;
  /** Why a node that never RAN is marked failed — a delegation to a domain
   * this room cannot serve. It rides on the roster rather than arriving as an
   * `ask-report` because the sidecar refuses these from a synchronous path
   * that cannot emit. A node that ran reports through `ask-report` instead. */
  report?: string;
}

/** The `ask-report` event: what one specialist handed back to the Main agent.
 *
 * The same words stream as `ask-delta` while that child holds the live-text
 * lease, and the next `ask-round` wipes them — correctly, since that area shows
 * the current round. This is the durable copy, so the diagram can show what a
 * child actually said instead of only that it said something. */
export interface AskReport {
  /** The `AskPlanStep.key` of the agent that reported. */
  node: string | null;
  text: string;
  /** False when the delegation failed — then `text` is the reason. */
  ok: boolean;
}

/** A node's state in the turn's agent graph. Rendered so it never depends on
 * colour alone — each state also carries its own glyph and outline. */
export type AgentNodeStatus = "pending" | "running" | "done" | "failed";

/** The `ask-agent` event — which roster entry is active right now. */
export interface AskActiveAgent {
  id: string;
  label: string;
  /** 1-based position in the roster. With a parallel batch in flight this
   * points at the FIRST running child; read `active_steps` for the real set. */
  step: number;
  total: number;
  /** Every 1-based slot running right now. A batch lights several at once,
   * which `step` alone cannot say. Optional — older sidecars omit it. */
  active_steps?: number[];
}

/** The `ask-step` event. Payload is a bare string from the many non-sidecar
 * emitters (chat commands, ai_actions, the native agent paths) and an object
 * from the sidecar, which stamps the emitting agent's graph slot. `api.ts`
 * normalises both to this shape. */
export interface AskStep {
  label: string;
  /** The `AskPlanStep.key` of the agent that ran this tool, when known. */
  node?: string | null;
}

/** Who an `ask-*` event belongs to (owner replacement #4, 2026-08-03).
 *
 * Every turn event is broadcast to the whole window, so before this the only
 * way a listener could tell whose event it was reading was "whatever chat is
 * mounted right now" — which is why an answer streamed into the wrong
 * conversation and a brand-new chat showed the previous one's token bar.
 *
 * `runId` is the ask id the composer minted and handed to `ask`/`run_command`,
 * so the chat has the run registered before the first event can arrive and
 * rejects anything naming a different one — including a late event from a turn
 * it already finished. Both are null for the handful of emitters that belong to
 * no conversation at all (the AI-actions menu); see `ownerOf` in effects.ts. */
export interface AskTurn {
  runId: string | null;
  chatId: string | null;
}

/** PRIV-2: privacy-scan progress events. */
export interface PrivacyScanProgress {
  running: boolean;
  done: number;
  total: number;
  label?: string;
  /** Terminal events only: why the scan stopped without finishing. */
  error?: string | null;
}

/** ADD-31: a named stage while a Studio artefact is being written.
 *
 * `local` is the whole reason this is a struct and not a string. When it is
 * false the step says room content is leaving the Mac, which is a privacy
 * consequence rather than a progress aside, and the AI pane draws the two
 * differently. Recovering that by matching "leaves this Mac" against `step`
 * would break on the first reworded sentence — silently, and in the direction
 * that under-warns. It comes from the model's DECLARED capabilities in
 * studios.rs, not from its name. */
export interface StudioStep {
  step: string;
  local: boolean;
}

/** ADD-23: the `effects` column payload — what a turn's tools drew. */
export interface MessageEffects {
  boxes?: {
    fileId: string;
    name?: string;
    boxes: { label: string; x1: number; y1: number; x2: number; y2: number }[];
  };
  annotation?: AnnotationPayload;
  /** Wave 2 (Idea 4): content-free per-edit outcome records for the turn
   * (`{tool, outcome, n}`). Telemetry only — the UI renders nothing from it. */
  edits?: { tool: string; outcome: string; n?: number; files?: number }[];
  /** This turn's token-usage snapshot for the budget bar (see AskTokenUsage). */
  usage?: AskTokenUsage;
  /** Dispatch-first agent visibility: the roster of domain agents that handled
   * this turn (the sidecar's plan event body). Rendered as a compact line on
   * the finished message — the live strip only exists while streaming. */
  agents?: AskPlanStep[];
}

/** ADD-25: one backend→webview request on the agent↔UI bridge. The driver
 * answers via api.resolveAgentUi(id, payload). */
export interface AgentUiRequest {
  id: string;
  kind:
    | "ui_snapshot"
    | "ui_act"
    | "view_screenshot"
    | "media_frame"
    // BROWSE-1: the OUTBOUND privacy door. Unlike the others this is not
    // performed by the DOM driver — it needs a human answer, so effects.ts
    // intercepts it and queues a consent card.
    | "browse_consent";
  args: Record<string, unknown>;
}

/** The agent is about to type ROOM content into a web page.
 *
 * Every other privacy door in the app points OUTBOUND TO A MODEL. This one
 * points outbound to the open web, where no model is involved and
 * `privacy.py` never sees it. Following the connector-argument lesson, the
 * answer is consent shown with the REAL values — masking silently would just
 * make the form submission fail in a way nobody could diagnose.
 */
export interface BrowseConsentRequest {
  id: string;
  url: string;
  field: string;
  text: string;
  entities: string[];
}

export interface Memory {
  id: string;
  content: string;
  /** Wave 1b (idea 5): preference | fact | project | instruction, or null =
   * uncategorized (every pre-category row). */
  category: string | null;
  createdAt: string;
}

/** A recording's waveform envelope: per-bucket peak amplitude (0–1), plus the
 * true duration taken from the decoded sample count — which is also how the
 * viewer learns the length of a streamed container whose own header reports
 * `Infinity` to the media element. */
export interface AudioPeaks {
  peaks: number[];
  duration: number;
  /** The envelope never rose above the host's noise floor — the file decoded
   * and has a length, but there is nothing audible in it. Decided by the host
   * (`commands::peaks::is_silent`) so the flat lane and the label under it
   * can't disagree about what silence is. */
  silent: boolean;
}

/** One slide of a deck, drawn by macOS Quick Look. */
export interface SlideImage {
  /** PNG, base64. */
  pngB64: string;
  /** How many slides the deck has — the backend counts them while rendering. */
  slides: number;
}

/** A macOS-drawn page image for a file the app can't render itself. */
export interface QuickLookPreview {
  /** PNG, base64. */
  pngB64: string;
}

/** Every viewer kind the Rust format registry (`src-tauri/src/formats.rs`) can
 * produce. `src/viewers/registry.tsx` must have an entry for each one — its
 * own test asserts that, so a kind added on the Rust side fails the UI build
 * instead of silently landing on the "no preview available" card.
 *
 * NOT to be confused with api.ts's `FileKind`, which is the Library's ICON
 * category ("web", "generated", "file") — a different question about a
 * different object (a FileMeta row, not an opened file's content). */
export type ViewerKind =
  | "image"
  | "pdf"
  | "docx"
  | "worddoc"
  | "sheet"
  | "csv"
  | "slides"
  | "book"
  | "archive"
  | "markdown"
  | "html"
  | "svg"
  | "sketch"
  | "notebook"
  | "json"
  | "subtitle"
  | "email"
  | "prose"
  | "log"
  | "code"
  | "text"
  | "audio"
  | "video"
  | "recording"
  | "binary";

export interface FileContent {
  kind: ViewerKind;
  name: string;
  mime: string;
  editable: boolean;
  text: string | null;
  /** Legacy base64 payload. Nothing populates this today — every viewer that
   * needs raw bytes reads them from `mediaToken` instead. Kept so byte
   * delivery can be switched back in one place if it ever has to be. */
  dataB64: string | null;
  /** Token for the roommedia:// streaming protocol (Range-capable, any size).
   * Set for EVERY file whose viewer parses the real bytes — audio and video,
   * and since the base64 payload was retired, also images, PDFs, Word files,
   * workbooks, decks, books and archives. The viewer reads
   * `roommedia://localhost/<token>` instead of receiving a data URL. */
  mediaToken: string | null;
  /** Video only: what the container itself says. `null` = never probed (the
   * viewer asks for one); every field inside is independently `null` for
   * "the file doesn't say", which the viewer must render as unknown rather
   * than as a plausible default. */
  mediaMeta: MediaMeta | null;
  /** Saved web pages only: what the page declared about itself, plus where and
   * when the room saved it. `null` = this file did not come from a web page,
   * and every field inside is optional for the stronger reason — a page that
   * named no author has no author, so the strip shows none rather than
   * "unknown" (which would read as "we looked it up and it is unknown"). */
  webMeta: PageMeta | null;
}

/** What a saved page declared about itself. Mirrors `extraction::PageMeta`
 * field for field. Absent means the page never said it: nothing here is ever
 * filled in from somewhere else. */
export interface PageMeta {
  title?: string;
  byline?: string;
  siteName?: string;
  published?: string;
  modified?: string;
  excerpt?: string;
  lang?: string;
  /** The room's own facts, not the page's. */
  sourceUrl?: string;
  capturedAt?: string;
}

/** The technical facts about a video, read from its container by
 * `media_probe.rs`. Mirrors that struct field for field — and every field is
 * nullable there for the same reason it is here: a container that never stated
 * its frame rate has no frame rate to show. */
export interface MediaMeta {
  durationSecs: number | null;
  /** DISPLAY size, with the track's rotation already applied. */
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  frameRate: number | null;
  bitrateKbps: number | null;
  /** `false` is a finding ("this video is silent"), `null` is ignorance. */
  hasAudio: boolean | null;
  audioCodec: string | null;
}

/** One charset the viewer's encoding picker offers. `name` is the WHATWG name
 * the backend reports back for it, so the menu's selection and the strip's
 * "read as …" are always the same string. */
export interface EncodingChoice {
  name: string;
  title: string;
}

/** A plain-text file re-read from its ORIGINAL BYTES (`decode_file_text`).
 *
 * Detection is a guess — the same legacy bytes genuinely are Turkish AND are
 * Cyrillic — so the viewer shows which encoding is in effect and lets a human
 * overrule it. Overruling re-reads the bytes in Rust; re-interpreting the
 * already-decoded string could only launder one wrong reading into another. */
export interface DecodedFileText {
  text: string;
  /** WHATWG name of the encoding in effect (`UTF-8`, `windows-1254`, …). */
  encoding: string;
  /** How that encoding was arrived at: a fact about the bytes (`bom`, `utf8`),
   * a guess (`detected`), or the user's own pick (`chosen`). */
  source: "bom" | "utf8" | "detected" | "chosen";
  /** Bytes with no meaning in this encoding became U+FFFD — the text on screen
   * is NOT the file, so it must never be saved back over it. */
  lossy: boolean;
  /** Whether this reading may be edited in place (format allows it AND the
   * decode was clean). */
  editable: boolean;
  options: EncodingChoice[];
}

// ---- ADD-27: the live Recording file ----

/** One transcribed word on the recording's timeline (centiseconds). `del`
 * marks words removed in the transcript editor — playback skips their span. */
export interface RecWord {
  w: string;
  t0: number;
  t1: number;
  del?: boolean;
}

export interface RecSegment {
  id: string;
  /** Which capture lane heard it: your mic, or the Mac's (meeting) audio. */
  source: "mic" | "sys";
  /** "You" for the mic; "Speaker N" for clustered meeting voices. */
  speaker: string;
  t0: number;
  t1: number;
  text: string;
  words: RecWord[];
  lang?: string | null;
}

/** A span deleted from the transcript; playback skips it, export removes it. */
export interface RecCut {
  t0: number;
  t1: number;
}

export interface RecMeta {
  /* No `version`: the Rust struct dropped it (there is no version dispatch),
     and a field declared here that the backend never sends is worse than no
     field — `meta.version < 2` type-checks and is silently false at runtime.
     `recording.rs`'s round-trip test asserts the key is absent from the wire. */
  durationCs: number;
  segments: RecSegment[];
  cuts: RecCut[];
  /** 0 = speakers are discovered from their voices (always, from the UI).
   * A non-zero value pins the participant count for an older room. */
  maxSpeakers: number;
  /** GH #5: machine label → the name the user gave them ("Speaker 2" → "Dana").
   * An overlay on top of `segments`, so re-clustering and re-transcribe (which
   * both rewrite the labels) can't destroy it. Absent until someone renames. */
  speakerNames?: Record<string, string>;
  /** Which of `speakerNames` the app GUESSED, from a voice this room has been
   * told the name of before — as opposed to a name the user typed.
   *
   * NAMES, not labels: re-clustering moves labels constantly, so a guess keyed
   * to one would be about a different person by the next pass. The screen has
   * to keep the two apart — a name the app inferred and a name the user
   * asserted are not the same claim, and only the first may be withdrawn. */
  recognized?: string[];
  /** What the room found when it read this recording, plus anything you wrote
   * yourself. All three are kept in time order and anchored on the ORIGINAL
   * timeline (the same one `cuts` are stated on), so a re-transcribe — which
   * remakes every segment — leaves them exactly where they were. */
  chapters?: RecChapter[];
  highlights?: RecHighlight[];
  notes?: RecNote[];
  /** The transcript the last reading was made from. Absent = never read, which
   * is what the background sweep looks for. When it no longer matches the
   * transcript, the tabs say the reading is out of date rather than presenting
   * old findings as current. */
  readOf?: { turns: number; chars: number };
}

/** Who put an item on the recording. `room` is the reading pass; `you` is the
 * person. Editing one of the room's items makes it yours, and the room never
 * touches it again — which is also the "Read again" rule.
 *
 * The distinction is the safety property of the whole feature: the room reads
 * every recording by itself and is sometimes wrong, and a made-up action item
 * with a colleague's name on it must never look like something you wrote. */
export type By = "room" | "you";

export type NoteKind = "decision" | "action" | "question" | "point";

export interface RecChapter {
  id: string;
  t0: number;
  title: string;
  by?: By;
}

export interface RecHighlight {
  id: string;
  t0: number;
  t1: number;
  by?: By;
}

export interface RecNote {
  id: string;
  t0: number;
  kind: NoteKind;
  text: string;
  /** Who an action is on — only ever somebody who actually speaks in this
   * recording; the backend drops a name it cannot find. */
  who?: string;
  by?: By;
}

/** A voice this room can recognise: someone named in a recording, whose
 * voiceprint is saved so later recordings put their name back automatically.
 * Stored in the encrypted room, never sent anywhere; the print itself never
 * crosses this boundary. */
export interface SavedVoice {
  name: string;
  /** Seconds of speech behind the saved voice — the evidence, in a unit a
   * person can weigh. */
  seconds: number;
  /** How many separate namings have been folded into it. */
  takes: number;
  /** How many times the user has said "that isn't them". */
  corrections: number;
  updatedAt: string;
}

export interface RecStart {
  fileId: string;
  name: string;
  meta: RecMeta;
}

export interface RecLive {
  fileId: string;
  status: string;
  durationCs: number;
  /** Durable per-source health [status, message] — lets a viewer that
   *  mounted after a fast failure still show the banner. */
  mic: [string, string];
  sys: [string, string];
}

export interface RecFile {
  name: string;
  meta: RecMeta;
}

// ---- ADD-28: feedback → GitHub issue ----

export interface FeedbackDraft {
  title: string;
  body: string;
}

export interface AppDiag {
  version: string;
  os: string;
  arch: string;
  /** "owner/repo" the issue opens against. */
  repo: string;
}

export interface AiStatus {
  running: boolean;
  /** True when Ollama is installed on this Mac even if not currently running
   * — lets onboarding tell "not installed" from "not started" (ADD-10). */
  installed: boolean;
  models: string[];
  defaultModel: string;
  /** Cloud CLIs detected on this Mac ("claude-cli", "codex-cli"). */
  external: string[];
  /** True when this room's Ollama is ANOTHER computer (Settings → the Closet).
   * The model name cannot carry that fact, so every "does content leave this
   * Mac?" surface must OR this in — see `workspace/markup.isCloudRoute`. */
  remoteRelay: boolean;
}

export const ENGINE_LABELS: Record<string, string> = {
  "claude-cli": "Claude Code",
  "codex-cli": "Codex",
  openrouter: "OpenRouter",
};

/** A specific model offered by a cloud engine (the Cloud picker's second
 * level) — `slug` is what gets sent to the CLI via `--model`, `label` is the
 * friendly display name, `efforts` are its supported reasoning levels (empty
 * if the engine has no effort knob), `defaultEffort` the engine-reported
 * default if any. */
export interface ExternalModelInfo {
  slug: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
  contextWindow: number | null;
  description: string | null;
  /** OpenRouter prices in USD per token, exactly as returned by its live API. */
  inputPrice: string | null;
  outputPrice: string | null;
  inputModalities: string[];
  /** What the model PRODUCES, from the catalog's `architecture
   * .output_modalities`. The mirror of `inputModalities`. */
  outputModalities: string[];
  tools: boolean;
  vision: boolean;
  /** Derived from `outputModalities`, never from the slug — `vision` means it
   * can READ a picture, these mean it can MAKE one, and every vision model in
   * the app is the former and none is the latter. */
  imageOutput: boolean;
  videoOutput: boolean;
  reasoning: boolean;
  structuredOutputs: boolean;
}

/** One model the Create page may offer, as `list_create_models` returns it. */
export interface CreateModel {
  /** The full selection string a generation is started with, engine prefix
   * included ("openrouter::vendor/slug"). */
  model: string;
  slug: string;
  label: string;
  engine: string;
  engineLabel: string;
  local: boolean;
  description: string | null;
  /** Both may be true — a model that makes stills and clips shows on both tabs. */
  image: boolean;
  video: boolean;
  /** The provider's own per-token price, verbatim. Not converted to a
   * per-picture figure, which the room would have to invent. */
  outputPrice: string | null;
  /** What this model will actually accept, read from the provider's own media
   * endpoints. Null when it published nothing. Veo takes 4/6/8 seconds and
   * nothing else; Kling takes 3–15 — so a single invented list of lengths
   * would be refused by most of the shelf. */
  limits: MediaLimits | null;
}

/** The legal shapes for one media model. An EMPTY list means the provider
 * declined to say, which is not the same as "anything goes": the caller sends
 * nothing and the model's own default stands. */
export interface MediaLimits {
  durations: number[];
  resolutions: string[];
  aspectRatios: string[];
  /** "first_frame" / "last_frame". Empty = this model animates from words
   * alone, so offering a starting picture would be offering nothing. */
  frameImages: string[];
  /** How many guiding pictures it will look at. Null = unpublished. */
  maxReferences: number | null;
  generateAudio: boolean;
}

/** Someone a story is about.
 *
 * `faceFileId` is the load-bearing field. Character consistency does not come
 * from words — "a woman with red hair" is re-imagined on every call — it comes
 * from handing the model the same picture each time. */
export interface CastMember {
  id: string;
  name: string;
  description: string;
  story: string;
  faceFileId: string | null;
  ord: number;
}

/** One shot list. Called a SHOT LIST on screen, never a "script": this app
 * already uses that word for runnable Python. */
export interface StoryList {
  id: string;
  title: string;
  logline: string;
  /** The frame shape for every shot in the list, e.g. "16:9". One value for
   * the whole thing on purpose: a shot's still becomes its clip's literal
   * first frame, so a 1:1 picture pinned to a 16:9 clip is the wrong shape.
   * Empty = let each model's own default stand. */
  aspectRatio: string;
  /** Output size, per medium — the two catalogues publish different words for
   * it ("1K"/"2K" for pictures, "720p"/"1080p"/"4K" for clips). */
  stillResolution: string;
  clipResolution: string;
  shotCount: number;
  updatedAt: string;
}

/** A room file with readable text in it — something a script or a cast can be
 * read out of, rather than typed in again. */
export interface RoomDocument {
  fileId: string;
  name: string;
  /** Roughly how long, so a note and a 40-page script are told apart before
   * either is opened. */
  words: number;
  snippet: string;
}

/** Someone found in a document, before anyone has agreed to keep them. */
export interface ParsedMember {
  name: string;
  description: string;
  story: string;
}

/** What a character sheet turned out to contain. */
export interface CastFromFile {
  name: string;
  found: ParsedMember[];
  /** WHICH reader produced these — the room's model, or the pattern reader.
   * Shown, because the two are not equally trustworthy on a messy file and
   * "why did it split this wrong" is unanswerable without it. */
  readBy: string;
  /** Set when the model was meant to read it and could not. The fallback rows
   * must never pass for the model's work. */
  fellBack: string | null;
}

/** One shot exactly as it will be sent — or why it will not be.
 *
 * Built by the same Rust that runs the job, never assembled separately: a
 * preview that drifts from what it previews is worse than none, because it
 * puts one claim on screen above a button that pays for another. */
export interface ShotPreview {
  shotId: string;
  /** 1-based place in the list, as the row is labelled. */
  n: number;
  action: string;
  /** The words that will be sent, verbatim. */
  prompt: string;
  /** The length after the model's own published list has had its say. */
  seconds: number | null;
  model: string;
  /** The picture the clip opens on, and the one it closes on — the second is
   * the next shot's opening picture, which is what joins them. */
  startFileId: string | null;
  endFileId: string | null;
  /** The portraits that ride along as guidance. "Mira is in this shot" is a
   * claim; the picture that will be sent is the evidence for it. */
  referenceFileIds: string[];
  cast: string[];
  /** Cast in this shot with NO picture — the ones who will be re-imagined from
   * words on every call rather than looking like themselves. */
  faceless: string[];
  /** The model that would not take an ending picture here, so the join was
   * dropped. Per shot, because a list can mix models. */
  joinDropped: string | null;
  /** True when this clip OPENS on the frame the previous clip really ends on —
   * captured from the finished video, not aimed at. The join, stated as a
   * promise the run can actually keep. */
  startsOnPrevious: boolean;
  /** Why this shot is not being sent. Null means it is. */
  skip: string | null;
}

/** What pressing "Draw them" / "Film them" would actually do. */
export interface FilmPlan {
  kind: "image" | "video";
  /** Every shot, sent or not — a row missing from the review is a row nobody
   * can ask about. */
  shots: ShotPreview[];
  sending: number;
  skipped: number;
  totalSeconds: number;
  /** How many clips OPEN on the captured end of the one before. Aiming with a
   * last frame is not counted — it is aim, not contact. */
  joined: number;
  overCap: boolean;
  /** The model that will not take an ending picture. THE reason "clip one ends
   * on a frame clip two does not start with" — the clips get made either way,
   * so without this the failure is only findable by watching twenty videos. */
  joinBlockedBy: string | null;
  /** Everyone in the run with no portrait, deduplicated. */
  faceless: string[];
}

/** The outcome of one press of "Draw them" / "Film them". */
export interface ShotRunStarted {
  jobIds: string[];
  /** How many were meant to start, so a short run reads as a shortfall rather
   * than as a smaller number with nothing to compare it against. */
  asked: number;
  shortfall: string | null;
}

/** One shot: what happens, who is in it, and what has been made of it. */
export interface StoryShot {
  id: string;
  listId: string;
  ord: number;
  action: string;
  castIds: string[];
  /** Null = the model's own default. Legal lengths differ per model, so a
   * number chosen before the model may be illegal after it. */
  seconds: number | null;
  imageModel: string;
  videoModel: string;
  stillFileId: string | null;
  clipFileId: string | null;
}

/** One room picture, small enough to draw a hundred of. The thumbnail is a
 * downscaled JPEG — a grid of full-size pictures would cost hundreds of
 * megabytes to show a few kilobytes of information. */
export interface RoomPicture {
  fileId: string;
  name: string;
  thumbB64: string;
}

/** One shot a split would produce. */
export interface PlannedShot {
  action: string;
  /** This shot's OWN length — per shot, not one number for all of them. A
   * real script has a ten-second beat in it, and flattening that to fifteen
   * would change the author's pacing without saying so. */
  seconds: number;
}

/** What breaking a script into shots would produce, before it is written. */
export interface ShotPlan {
  parts: number;
  totalSeconds: number;
  /** Every shot, so the split can be seen before it is committed. */
  shots: PlannedShot[];
  /** True when the SCRIPT declared its own chunks (`**00:00–00:15** — …`) and
   * they were used verbatim, rather than the room cutting it by length. The
   * two produce very different results, so the page says which happened. */
  fromScript: boolean;
}

/** Everything the Story tab draws itself from, in one round trip. */
export interface StoryBoard {
  cast: CastMember[];
  lists: StoryList[];
  shots: StoryShot[];
  selected: string | null;
}

/** Why a set of models is NOT on the Create shelf. Returned rather than
 * dropped: "where is Claude" is the question this page has to answer. */
export interface CreateExclusion {
  engineLabel: string;
  reason: string;
  count: number;
  examples: string[];
}

/** Everything the Create page needs to draw itself. */
export interface CreateCatalog {
  models: CreateModel[];
  /** The denominator in "11 of 34 can make a picture". */
  scanned: number;
  excluded: CreateExclusion[];
  /** False means "connect a provider", which is a different sentence from
   * "nothing here can draw". */
  anyProvider: boolean;
  /** A provider is connected but its catalog would not load. */
  error: string | null;
}

export interface AiProviderStatus {
  id: string;
  label: string;
  connected: boolean;
}

/** A cloud engine selection, most-specific-last:
 *   "claude-cli"                    bare engine (CLI default model+effort)
 *   "codex-cli::gpt-5.6-sol"        a specific model
 *   "codex-cli::gpt-5.6-sol::high"  a specific model AND reasoning effort
 * Mirrors the Rust-side `split_external_model`. Returns
 * [engine, model|null, effort|null]. */
export function splitExternalModel(
  model: string,
): [string, string | null, string | null] {
  const parts = model.split("::");
  const engine = parts[0];
  if (engine !== "claude-cli" && engine !== "codex-cli" && engine !== "openrouter") {
    return [model, null, null];
  }
  return [engine, parts[1] ?? null, parts[2] ?? null];
}

/** Friendly label for any model id — local, bare cloud engine, or a composite
 * cloud-engine + model (+ effort) selection. `engineModels` is an optional
 * cache of the fetched model list per engine, used to turn a slug into its
 * display label; the effort (if any) is appended as "· <effort>". */
export function engineModelLabel(
  model: string,
  engineModels?: Record<string, ExternalModelInfo[]>,
): string {
  const [engine, submodel, effort] = splitExternalModel(model);
  const engineLabel = ENGINE_LABELS[engine];
  if (!engineLabel) return modelLabel(model) ?? model;
  if (!submodel) return engineLabel;
  const known = engineModels?.[engine]?.find((m) => m.slug === submodel)?.label;
  const base = `${engineLabel} — ${known ?? submodel}`;
  return effort ? `${base} · ${effort}` : base;
}

/** ADD-22: a local model's declared abilities (from Ollama /api/show), so the
 * picker can badge each model and warn when the chosen one can't drive the app. */
export interface ModelCaps {
  name: string;
  tools: boolean;
  vision: boolean;
}

/** One capability answer. `"unknown"` is a real answer, not a missing one: an
 * engine we could not reach must never be rendered as capable OR incapable —
 * the same rule the host's `Support` enum states. */
export type Support = "yes" | "no" | "unknown";

/** The capability questions the host will answer. Closed on purpose — mirrors
 *  the host's `Capability` enum, so a caller cannot ask for one nothing
 *  declares an answer for. */
export type Capability =
  | "streaming"
  | "tool_calling"
  | "vision"
  | "structured_output"
  | "chat";

/** The engine's DECLARED capability record (src-tauri/src/commands/
 *  capabilities.rs). One record per provider, refined per-model where the live
 *  catalog knows more. Nothing in the UI re-derives these from a model name. */
export interface EngineCapabilities {
  engine: string;
  label: string;
  model: string;
  local: boolean;
  streaming: Support;
  toolCalling: Support;
  vision: Support;
  structuredOutput: Support;
  chat: Support;
  contextWindow: number | null;
  tier: string;
  /** Would pixels actually ARRIVE? The privacy door strips images out of every
   *  non-local request, so "can see" and "will receive the picture" are two
   *  different facts and the UI must not merge them. */
  imageReaches: boolean;
}

/** Why a preflight blocked, as a value rather than a sentence — two blocks that
 *  read alike need different offers, and matching on the prose would re-derive
 *  a distinction the host's record already made.
 *   • "capability"  — the engine itself cannot. A different (or newly
 *     downloaded) model is the fix, so an offer to install one is honest.
 *   • "privacy-door" — it can, but this room's door removes what it needs. The
 *     fix is a switch the user owns; offering a download here is noise. */
export type BlockCode = "capability" | "privacy-door";

/** What a PREFLIGHT check concluded for the room's engine, before a run. */
export type EnginePreflight =
  | { status: "ready" }
  | { status: "unknown"; reason: string }
  | { status: "blocked"; code: BlockCode; reason: string };

export interface AgentRow {
  id: string;
  label: string;
}

export interface ProviderRow extends EngineCapabilities {
  /** Installed / connected on THIS Mac right now. */
  available: boolean;
  /** Agent ids this provider's tier can reach — derived by the sidecar from its
   *  own registry, never a list written down here. */
  agents: string[];
}

/** The published provider × agent support matrix (owner decision #3). */
export interface SupportMatrix {
  agents: AgentRow[];
  providers: ProviderRow[];
  /** False when the sidecar could not be reached. The capability columns are
   *  still true (they are declared in the host); the agent columns are simply
   *  not known, and the UI says so rather than drawing an empty grid that would
   *  read as "no agent works anywhere". */
  agentsKnown: boolean;
  agentsError: string | null;
}

/** ADD-18: state of the built-in dictation/transcription engine. The engine
 * (Whisper) is compiled into the app; only the model file downloads on demand. */
export interface SttStatus {
  installed: boolean;
  downloading: boolean;
  sizeMb: number;
}

/** Idea 3: one voice from the Edge service's LIVE catalog (the app bundles
 * no roster — the picker is fed from `list_neural_voices` at open). */
export interface NeuralVoiceInfo {
  id: string;
  gender: string;
  locale: string;
}

/** Friendly display names for models we ship guidance for. The stored setting
 * always keeps the raw id — this is display only (CHG-4). Unknown models the
 * user pulled themselves fall through to their raw id. */
const MODEL_LABELS: { match: (id: string) => boolean; label: string }[] = [
  { match: (m) => m.startsWith("qwen3.5"), label: "Standard local AI (recommended)" },
  { match: (m) => m.includes("qwen2.5vl") || m.includes("qwen2.5-vl"), label: "Vision helper (marks images)" },
];

/** Friendly name for a model id, or `null` if we ship no label for it. */
export function modelLabel(id: string): string | null {
  return MODEL_LABELS.find((m) => m.match(id))?.label ?? null;
}

export interface ImageBox {
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Where a viewer should navigate/highlight when a file opens. */
export interface FileTarget {
  page?: number;
  cell?: string;
  find?: string;
  sheet?: string;
  range?: string;
  quote?: string;
}

/** Payload of an ```annotation block / agent-annotate event. */
export interface AnnotationPayload {
  fileId: string;
  name?: string;
  quote?: string;
  page?: number;
  sheet?: string;
  range?: string;
  note?: string;
  /** ADD-22: true when the exact quote wasn't found and the closest passage was
   * highlighted instead — the UI marks it "≈ closest match". */
  approx?: boolean;
}

export interface McpServerStatus {
  name: string;
  status: "connecting" | "connected" | "failed" | "disabled";
  error: string | null;
  tools: string[];
  /** True when reached over the network (a remote HTTP server) — the UI badges
   * it "reaches the internet" vs a local "runs on your Mac" connector. */
  remote: boolean;
}

/** One connector's answers to the two connector powers (mirrors Rust's
 * `ConnectorOverride`). A power that is ABSENT means "follow the Mac-wide
 * switch" — that is a third state, not a `false`, and collapsing it would make
 * the switch above unable to change anything. */
export interface ConnectorOverride {
  auto_approve?: boolean;
  outbound_unmask?: boolean;
}

/** Per-connector overrides keyed by connector name. Empty when every connector
 * follows the two switches. */
export type ConnectorPowers = Record<string, ConnectorOverride>;

/** What "Install" would write into the room's mcpServers config, from the
 * marketplace. Tagged union on `kind` (mirrors Rust's InstallSpec). */
export type InstallSpec =
  | { kind: "stdio"; command: string; args: string[]; envKeys: string[] }
  | { kind: "http"; url: string; headerKeys: string[] };

/** One normalized marketplace listing from the MCP registry (mcp_registry.rs
 * CatalogEntry). */
export interface CatalogEntry {
  id: string;
  name: string;
  /** The registry's human title when present; the UI shows this, falling back
   * to `name`. */
  title: string | null;
  /** The server's icon as an inlined `data:` URI (backend-proxied — the CSP
   * blocks remote images), or null → show a monogram. */
  icon: string | null;
  description: string;
  publisher: string;
  /** The publisher demonstrably owns the namespace (registry trust signal). */
  verified: boolean;
  /** Installs a remote endpoint — data leaves the Mac when the tool is called. */
  remote: boolean;
  transport: "stdio" | "http" | "sse" | string;
  repository: string | null;
  install: InstallSpec;
  /** The other transport when the record offers both a local package and a
   * remote endpoint — `install` is the (privacy-first) local default, this is
   * the cloud alternative the drawer can switch to. null when only one exists. */
  altInstall: InstallSpec | null;
}

/** SEC-1b: a pending per-call MCP approval prompt from the backend. */
export interface McpApproveRequest {
  id: string;
  server: string;
  tool: string;
  args: string;
  /** Audit #505: set when this card is an agent-initiated DELETION, not a tool
   * call — the sentence naming what goes with it. `server` is then the thing's
   * name and `tool` is what kind of thing it is. Present means the destructive
   * card: no "always allow", because standing consent to run connector tools
   * was never consent to destroy the room's own configuration. */
  confirm?: string;
}

/** Wave 2 (Idea 6): one file's before/after in a diff-preview approval card. */
export interface EditPreviewFile {
  name: string;
  before: string;
  after: string;
  /** True when the preview text was clipped to the size ceiling. */
  clipped: boolean;
}

/** Wave 2 (Idea 6): a pending diff-preview approval prompt from the backend.
 * `allowTurn` is true only when the cadence is "Once per answer" AND the request
 * came from the run-scoped local engine — so the "rest of this answer" button is
 * never offered to a sink-less cloud/external client. */
export interface EditApproveRequest {
  id: string;
  tool: string;
  allowTurn: boolean;
  files: EditPreviewFile[];
}

/** Payload of the agent-open-file event: a bare file id, or an id with a
 * navigation hint (page/cell/find). */
export type AgentOpenFilePayload =
  | string
  | { id: string; page?: number; cell?: string; find?: string };

/* ============================================================
 * Moonshot feature types (Wave-3 API surface). Every new backend command
 * struct derives serde rename_all="camelCase", so fields are camelCase here.
 * ============================================================ */

/** D1: the two SPECIAL models Settings offers to pull. There was a `chat`
 * list here too, which no screen ever rendered — the first-run chooser has its
 * own richer roster in `workspace/constants.ts`. */
export interface RecommendedModels {
  embed: string;
  vision: string;
}

/** D3: one node in the room's similarity graph (a file or a memory). */
export interface GraphNode {
  id: string;
  name: string;
  folder?: string;
  summary?: string;
  kind: "file" | "memory";
}

/** D3: a TYPED link between two nodes. `kind` says which relationship it is —
 *  "derived" | "same_page" | "mentions" | "cited" | "same_site" are relations
 *  the room can prove from what it stored, "similar" is the only inferred one.
 *  `directed` marks the a → b relations (a produced b, or a names b), and
 *  `shared` holds up to 3 short pieces of evidence for the link. */
export interface GraphEdge {
  a: string;
  b: string;
  weight: number;
  kind: string;
  directed: boolean;
  shared: string[];
}

/** D3: the whole room graph, from roomGraph(). */
export interface RoomGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** D4: instant, model-free snapshot for the Front Page on unlock. */
export interface FrontPage {
  recentFiles: FileMeta[];
  recentChats: Chat[];
  memories: Memory[];
  suggestions: string[];
  fileCount: number;
  chatCount: number;
}

/** D6: whether the last exchange is worth remembering, plus the distilled fact. */
export interface MemorySuggestion {
  worth: boolean;
  fact: string;
}

/** D7: a suggested tidy-up for a freshly imported file (Smart import). */
export interface FileMetaSuggestion {
  title: string;
  folder: string;
  tags: string[];
}

/** D9: state of the persistent Room MCP server (the Leash). Wave 1a: `scope`
 * is the running trust tier; `stable` means the fixed port was bound (the
 * pasted config survives restarts); `allowCloud` echoes the effective cloud
 * sub-option so Settings shows the truth after reopening. */
export interface RoomServerStatus {
  running: boolean;
  url: string;
  config: string;
  scope: "files" | "full";
  stable: boolean;
  allowCloud: boolean;
}

/** Whether a local connector's command can run right now, and if not, whether
 * one download fixes it (`mcp_runtime_for_command`). A connector needing
 * `uvx`/`npx` on a Mac without them used to fail with the launcher's raw error
 * and no way to fix it from inside the app. */
export interface RuntimeStatus {
  /** The command can run as-is — a downloaded or system runtime satisfies it. */
  available: boolean;
  /** The runtime a download would provide ("uv" | "node"), when there is one. */
  kind: string | null;
  /** A one-time download would make it available. */
  provisionable: boolean;
  /** One plain-words line for the prompt. */
  note: string;
}

/** D11: a selectable room persona (tutor, critic, opposing-counsel, …). */
export interface RoomRole {
  id: string;
  name: string;
  blurb: string;
  instructions: string;
  prompts: string[];
  commands: string[];
}

/** The default, editable prompts each Studio action runs with. */
export interface StudioPrompts {
  flashcards: string;
  mindmap: string;
  podcast: string;
}

/** ADD-30: a durable background job (deep summary) as the jobs panel sees it.
 * `status` is queued | running | paused | error | done. */
export interface Job {
  id: string;
  kind: string;
  title: string;
  plan: unknown;
  state: unknown;
  cursor: number;
  total: number;
  status: string;
  error: string | null;
  /** Wave 4a: set on a workflow's inline child job (hidden from the sidebar). */
  parentJobId?: string | null;
  /** Why this job stopped when nobody chose to stop it — the room was locked,
   * or the app closed, while it was still running. Null/absent means the pause
   * was the user's own Stop, which the card says differently. */
  parkedReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** ADD-30: one `job-progress` event — live counts plus terminal flags. */
export interface JobProgress {
  jobId: string;
  label: string;
  done: number;
  total: number;
  finished?: boolean;
  paused?: boolean;
  failed?: boolean;
  fileId?: string | null;
}

// ------------------------------------------------------------ Wave 4a: workflows

/** Where a workflow surfaces. `general` = library/top bar; `file` = a file's
 * Actions menu, run on that file. */
export type WorkflowBinding =
  | { scope: "general" }
  | { scope: "file"; kinds?: string[]; exts?: string[]; file_id?: string | null };

/** A saved LLM graph workflow. `definition`/`binding` are opaque JSON here. */
export interface Workflow {
  id: string;
  name: string;
  description: string;
  emoji: string;
  definition: WorkflowDef;
  status: "draft" | "active";
  createdBy: "user" | "agent" | "script";
  binding: WorkflowBinding;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The node graph. Nodes carry a `kind` discriminant plus its params. */
export interface WorkflowDef {
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowNode {
  id: string;
  label?: string;
  kind:
    | "generate"
    | "summarize_file"
    | "file_pass"
    | "for_each_file"
    | "agent_run"
    | "extract"
    | "route"
    | "vote"
    | "refine"
    | "plan_and_map"
    | "transform"
    | "merge"
    | "http_fetch"
    | "script_run"
    | "save_file"
    | "condition";
  // Kind-specific params (flattened): prompt/model/select/instruction/mode/
  // name_template/format/question/op/value/fields/labels/samples/rubric/
  // objective/url/file/find/separator. Kept loose so the param sheet edits
  // them generically.
  [key: string]: unknown;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** "then"/"else" off a condition, or one of a route node's labels; absent
   * otherwise. */
  branch?: string | null;
}

export interface Schedule {
  id: string;
  workflowId: string;
  kind: "interval" | "daily" | "weekly";
  param: string;
  enabled: boolean;
  catchUp: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastJobId: string | null;
}

export interface ScheduleArg {
  kind: string; // interval|daily|weekly, or "" to clear
  param?: string;
  enabled?: boolean;
  catchUp?: boolean;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  jobId: string | null;
  trigger: string;
  status: string;
  error: string | null;
  inputFileId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowTemplate {
  name: string;
  description: string;
  emoji: string;
  binding: WorkflowBinding;
  schedule?: ScheduleArg;
  definition: WorkflowDef;
}

/** One `workflow-node` event — a node's live status during a run. */
export interface WorkflowNodeEvent {
  jobId: string;
  workflowId: string;
  nodeId: string;
  status: "running" | "done" | "skipped" | "error";
  peek?: string | null;
}

// ------------------------------------------------------------ Wave 5: scripts

/** A `.py`/`.js` room file as a first-class runnable/schedulable script. Its run
 * history/schedule come from the same `workflow_runs`/`schedules` rows as
 * everything else, via a hidden per-script auto-workflow. */
export interface ScriptInfo {
  fileId: string;
  name: string;
  lang: "py" | "js";
  deps: string[];
  inputs: string[];
  outputs: string[];
  /** Where it surfaces as a one-click shortcut. */
  shortcut: "global" | "file" | "none";
  /** True when this exact content is approved to run on this Mac. */
  approved: boolean;
  /** Ran/scheduled before, but the current content isn't approved (edited). */
  changedSinceApproval: boolean;
  workflowId: string | null;
  schedule: Schedule | null;
  lastRun: WorkflowRun | null;
  /** How many of the most-recent runs failed with the SAME error (newest-first;
   * 0 = latest run didn't fail). Drives the single "incident" card. */
  consecutiveFailures: number;
  /** The shared error text of that failure streak, or null when not failing. */
  lastError: string | null;
}

/** The parsed PEP-723 + room-* manifest for one script. */
export interface ScriptManifest {
  interpreter: "py" | "js";
  deps: string[];
  inputs: string[];
  outputs: string[];
  timeoutSecs: number;
  shortcut: "global" | "file" | "none";
}

/** A pending script-run consent prompt from the backend (SEC-1 doctrine). */
export interface ScriptApproveRequest {
  id: string;
  name: string;
  /** The exact command line that would run, e.g. "uv run --no-project x.py". */
  interpreterLine: string;
  deps: string[];
  inputs: string[];
  outputs: string[];
  timeout: number;
}

// ------------------------------------------------------------ Agent Skills

/** Level-1 progressive-disclosure metadata. This is the only part of every
 * enabled skill placed in an ordinary model turn. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  createdBy: "user" | "agent" | "import";
  /** Which domain agent owns this skill (`agent:` in SKILL.md frontmatter).
   * "" = general: offered to every agent, which is what an ordinary
   * hand-written skill stays. */
  agent: string;
  resourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Skill extends Omit<SkillSummary, "resourceCount"> {
  instructions: string;
}

export interface SkillResourceMeta {
  path: string;
  kind: "script" | "reference" | "asset" | "agent" | "resource";
  sizeBytes: number;
  text: boolean;
  updatedAt: string;
}

export interface SkillBundle {
  skill: Skill;
  resources: SkillResourceMeta[];
}

export interface SkillResourceContent {
  path: string;
  kind: string;
  text: string | null;
  dataB64: string | null;
}

// --------------------------------------------------------------- BROWSE-1

/** Live state of the private browser's child webview. */
export interface BrowserInfo {
  open: boolean;
  /** A new tab that has not navigated yet. The native view is parked while
   *  this is true, so the start screen underneath is actually visible. */
  blank?: boolean;
  url?: string | null;
  title?: string | null;
  ready?: string | null;
  takeover?: boolean;
  /** Item #18: the page latched a double Escape — the user is asking for the
   *  keyboard back. True on exactly one poll; the page clears it as it reports
   *  it, so acting on it twice is impossible. */
  leaveRequested?: boolean;
  error?: string;
}

/** One slice of the current page as text (`browser_page_text`).
 *
 * The raw page-script answer, not a formatted string: the reading view follows
 * `truncated`/`nextOffset` itself so it can say how much of the page it is
 * actually showing rather than presenting a slice as the whole thing. */
export interface BrowserPageText {
  url?: string;
  title?: string;
  mode?: "main" | "full";
  offset?: number;
  /** Where the NEXT read must start, in the page script's own UTF-16 units. */
  nextOffset?: number;
  total?: number;
  truncated?: boolean;
  text?: string;
}

/** One open private-browser page (`browser_tabs`).
 *
 * These are never persisted: a restored list of visited URLs is a browsing
 * history, which is the one thing this browser promises not to keep. */
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

/** One fused web result (BROWSE-3).
 *
 * The engines that agreed on a URL are kept as a LIST, not collapsed to one
 * name: cross-engine agreement is a ranking signal we can show and a single
 * search engine cannot. */
export interface WebHit {
  title: string;
  url: string;
  /** Every engine that returned this URL, in the fusion's priority order. */
  engines: string[];
  date?: string | null;
  /** The engine's own blurb, upgraded to the page's `meta description` once
   *  the enrich pass has read it. */
  snippet?: string | null;
  score: number;
}

/** What the browser's results page renders for one search (BROWSE-3). */
export interface BrowserSearchResult {
  hits: WebHit[];
  /** Raw hits collected across all engines before dedup — the honest
   *  denominator behind "31 merged into 12". */
  merged: number;
  tookMs: number;
  /** Served from this Mac's 15-minute cache, no network touched. */
  cached: boolean;
  /** Engines that could not answer — blocked, rate limited or too slow. A
   *  thin result set with two engines down is not the same page as a thin
   *  result set from a whole working fan-out, and only this says which. */
  failed?: string[];
  query: string;
  /** False when the room turned result previews off: every card keeps its
   *  monogram tile and no result origin is contacted. */
  previewsEnabled: boolean;
  /** False when the room has no engine configured — the view must not offer a
   *  summary button that can only fail. */
  summaryAvailable: boolean;
}

/** One result's preview, from the enrich pass (BROWSE-3b).
 *
 * Images arrive as data URLs because the results page must never fetch
 * anything itself — every byte comes through the Rust guard. */
export interface ResultPreview {
  url: string;
  image?: string | null;
  icon?: string | null;
  description?: string | null;
  title?: string | null;
  /** The page was read; if `image` is still null it simply has no preview
   *  image, and the card should stop waiting and keep its monogram tile. */
  done: boolean;
}

/** One row of the browser's audit trail.
 *
 * The inversion that makes the private browser trustworthy: the WEB persists
 * nothing (non-persistent data store — no history, cookies or cache), while
 * everything the AGENT did persists here, inside the encrypted room.
 */
export interface BrowseJournalRow {
  id: number;
  at: string;
  /** open | read | act | look | consent | blocked | download | takeover | blocker */
  kind: string;
  url: string;
  detail: string;
}

/** What one Stop actually stopped (`cancel_ask`).
 *
 * Owner replacement #3: cancellation is a TREE rooted at the run, so a Stop can
 * reach a Studio build or a file pass the answer had started. `stopped` names
 * them, root first, and lists ONLY what this Stop moved from running to
 * stopped — work that had already finished is not in it, because claiming a
 * Stop reached it would be untrue. `known: false` means the host no longer had
 * the run at all (it had just finished), which is not an error but is also not
 * a Stop that stopped anything.
 */
export interface StopReport {
  stopped: string[];
  known: boolean;
}

/** The payload of the `sketch-drawn` event (see `api.onSketchDrawn`). */
export interface SketchDrawn {
  fileId: string;
  name: string;
  added: string[];
  changed: string[];
  removed: string[];
  /** One line per statement the script ran, in order. */
  steps: string[];
  /** The whole document after the write, as JSON. */
  doc: string;
}
