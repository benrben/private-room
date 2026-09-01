/**
 * D3: the room graph — files and memories as nodes, six kinds of typed edges
 * between them (five the room can PROVE from what it stored, one INFERRED).
 * Ported from `src-tauri/src/commands/moonshot/graph.rs` (1163 lines, the
 * largest submodule of `moonshot.rs` — read in full, including its
 * `#[cfg(test)] mod tests`; all 14 are reproduced in `moonshotGraph.test.ts`,
 * plus a few extra covering the `roomGraph`/IPC wrapper layer the Rust
 * `#[cfg(test)]` module never touches because it tests `build_room_graph`
 * directly, not the `#[tauri::command]` around it).
 *
 * ============================================================================
 * OVERLAP CHECK — this is NOT the same "graph" as `workflowModel.ts`/
 * `workflowEngine.ts`
 * ============================================================================
 * Both READ this batch's instructions as touching a "graph". They are
 * genuinely unrelated features that happen to share a common noun:
 *  - `workflowModel.ts`/`workflowEngine.ts` port `src-tauri/src/commands/
 *    jobs/workflow.rs` — an LLM-orchestrated multi-step job's DAG (nodes are
 *    generate/transform/branch/… STEPS, edges are execution order with
 *    conditions). Its own header calls this "the LLM graph workflow engine".
 *  - This file ports `src-tauri/src/commands/moonshot/graph.rs` — the ROOM's
 *    own similarity/relation map (nodes are FILES and MEMORIES the user
 *    already has, edges are six kinds of "how are these two related").
 * Confirmed no shared code either direction: `grep -n "RoomGraph\|GraphNode\|
 * GraphEdge\|EDGE_KINDS\|link_strength" workflowModel.ts workflowEngine.ts`
 * returns nothing, and the two Rust source files (`jobs/workflow.rs` vs
 * `moonshot/graph.rs`) never reference each other's types either. One design
 * ("workflow") did not supersede the other ("room graph") — both ship in the
 * current Rust tree and both are registered in `lib.rs`.
 *
 * ============================================================================
 * NOT MODEL-INVOCABLE
 * ============================================================================
 * `room_graph` takes no arguments and is registered ONLY in `lib.rs`'s
 * `tauri::generate_handler!` list, directly between `ensure_embed_model` and
 * `front_page` under the "Moonshot (Section D)" banner (lib.rs:364-368) — a
 * person's RoomMap viewer opening, not a tool a model calls. Grepped
 * `agent.rs`'s `exec_tool` match arms and this migration's own
 * `toolSpecs.ts`/`toolSchema.ts`/`execTool.ts`: `"room_graph"`/`"graph"`
 * appears in none of them (the one `toolSpecs.ts` hit is an unrelated
 * `create_workflow` tool description that uses the word "graph" to describe
 * ITS OWN node+edge shape — see the overlap check above). Nothing was added
 * to `execTool.ts`.
 *
 * ============================================================================
 * moonshotCmds.ts's OWN FINDINGS, AND ONE THING TO WATCH
 * ============================================================================
 * `moonshot.rs` (the top-level dispatcher, 129 lines) was read directly
 * rather than through a pre-existing `moonshotCmds.ts`, because at the start
 * of this task no port of it existed yet in this tree — `moonshotCmds.ts`,
 * `moonshotDiscovery.ts` and `moonshotRoles.ts` all landed (concurrently, a
 * few minutes apart, per their mtimes) from other batches WHILE this task was
 * in progress. `moonshotCmds.ts` is now the real port of `moonshot.rs` and
 * confirms what its own header says: it ports only `resolve_structured_model`/
 * `recommended_models`/`ensure_embed_model` — none of `graph.rs`'s surface.
 * `graph.rs` never calls `resolve_structured_model` (it does no model call at
 * all — pure DB reads), so this file needs nothing from `moonshotCmds.ts`.
 *
 * (An earlier revision of this comment claimed `resolveStructuredModel` had
 * been ported TWICE, in `moonshotCmds.ts` and again in
 * `moonshotFrontPage.ts`. That was already out of date when it was written:
 * `moonshotFrontPage.ts` IMPORTS `moonshotCmds.ts`'s copy, as do
 * `moonshotAiActions.ts` and this file's other siblings. There is exactly one
 * port of it, in `moonshotCmds.ts`. Do not "consolidate" a duplicate that
 * does not exist.)
 *
 * ============================================================================
 * WHY `GraphNode`/`GraphEdge`/`RoomGraph` ARE RE-DECLARED HERE, NOT IMPORTED
 * FROM `../shared/apiTypes.ts`
 * ============================================================================
 * `shared/apiTypes.ts` already declares all three (carried over verbatim from
 * the pre-migration frontend's `src/apiTypes.ts`), and this port's own house
 * style prefers reusing an already-correct shared type (`moonshotFrontPage.ts`
 * does exactly that for `FrontPage`). But `apiTypes.ts`'s `GraphNode` has
 * DRIFTED from the current Rust struct:
 *  - it carries an optional `summary?: string` field that current `graph.rs`
 *    does not have at all — `git log -p -- src-tauri/src/commands/moonshot/
 *    graph.rs` shows a `summary: Option<String>` field that existed in an
 *    earlier revision and was removed; the frontend type was never updated
 *    to match.
 *  - it types `folder` as bare-optional (`folder?: string`), which cannot
 *    represent what the Rust struct (`pub folder: Option<String>`, no
 *    `skip_serializing_if`) actually puts on the wire for a top-level file:
 *    an explicit `"folder": null`, not an omitted key.
 * Rather than reuse a type that would either reject a faithful `null` or
 * silently accept a `summary` this builder never produces, this file declares
 * its own field-for-field mirror of the CURRENT struct — the same "local
 * mirror" convention `Memory`/`Folder`/`FileMeta`/etc. all follow in
 * `db-host/`, used here because for once `apiTypes.ts`'s copy is not the
 * genuinely-current one. `kind` is narrowed to the literal union the builder
 * actually emits (`apiTypes.ts` already does this too); `GraphEdge.kind`
 * stays a bare `string`, matching both Rust's own `pub kind: String` and
 * `apiTypes.ts`, since it is compared against {@link EDGE_KINDS} rather than
 * switched over.
 *
 * ============================================================================
 * DEPENDENCIES — ALL ALREADY REAL, INCLUDING ONE BUILT FOR THIS EXACT PORT
 * ============================================================================
 * Every `db::*` call `graph.rs` makes already has a real Electron port:
 * `listFolders`/`listFiles`/`derivedLinks`/`stripHebrewMarks` (`files.ts`,
 * `folders.ts`), `listMemories` (`memories.ts`), `blobToEmbedding`/
 * `cosineSimilarity`/`ftsFileMatches` (`embeddings.ts` — whose own doc comment
 * on `ftsFileMatches` is literally headed "Room map:", written in
 * anticipation of this port), `recentMessageSources` (`messages.ts`),
 * `ftsMatchExpr` (`retrieval.ts`), `clampWords` (`textClamp.ts`). The one raw
 * query `graph.rs` issues directly (`SELECT file_id, embedding, text FROM
 * chunks WHERE file_id IN (...)`, no `db::` wrapper of its own in Rust either)
 * is issued the same way here, via `db-host/util.ts`'s `queryRows`, following
 * `storyTools.ts`'s precedent for a commands-layer file that needs one custom
 * query alongside its `db-host` calls.
 *
 * `STOPWORDS`/`NOT_ALPHANUMERIC` (`db-host/retrieval.ts`) were WIDENED from
 * module-private to exported by this batch — a two-line, purely-additive
 * change (re-run `retrieval.test.ts` after: unaffected) — because
 * `index_terms` (this file) and `question_terms` (`retrieval.ts`) are, in
 * Rust, the exact same shared `pub(crate) const STOPWORDS` via `use
 * super::*`; duplicating a ~50-entry list here would be exactly the
 * driftable copy this migration's other modules (`messages.ts`'s
 * `searchTerms`/`likeAllClause`, reused rather than re-spelled by
 * `memories.ts`) avoid on principle.
 *
 * `isSummaryFile`/`SUMMARY_FILE_NAME` are duplicated a SECOND time (after
 * `moonshotFrontPage.ts`'s own copy) rather than imported, for the identical
 * reason that file's header states: `summarize.rs` has no Electron port yet,
 * the predicate is two string comparisons and an `&&`, and importing from a
 * sibling "moonshot" file for a helper neither file owns would just move the
 * duplication sideways. When `summarize.rs` lands for real, BOTH copies
 * should be deleted in favor of importing it.
 *
 * ============================================================================
 * `RoomSource` — the MOONSHOT FAMILY'S shape, from `moonshotCmds.ts`
 * ============================================================================
 * Two shapes for "read the currently open room" exist in this codebase:
 * `recIpc.ts`/`turnEngine.ts`/`moonshotCmds.ts` declare
 * `{ currentRoom(): OpenRoom | null }`, while `jobs.ts` declares
 * `{ current(): RoomHandle | null }` (reused by `feedbackTools.ts` and the
 * job runners). This file originally took `jobs.ts`'s, on the stated grounds
 * that `moonshotFrontPage.ts` — `room_graph`'s literal neighbour in `lib.rs`'s
 * handler list — had done the same. That was simply not true:
 * `moonshotFrontPage.ts` takes `moonshotCmds.ts`'s `currentRoom()`, and so do
 * `moonshotAiActions.ts` and `moonshotServer.ts`. The result was that a
 * bootstrap building ONE room object for the moonshot family could drive five
 * of the six files and hit `TypeError: rooms.current is not a function` on
 * this one. All six now take the same shape; the room object a host builds for
 * `front_page` drives `room_graph` unchanged.
 *
 * (`buildRoomGraph(db)` is the real work and takes a plain connection, so
 * anything holding a `Database.Database` — a `jobs.ts` runner included — can
 * still call it directly without a `RoomSource` at all.)
 *
 * ============================================================================
 * DEVIATIONS
 * ============================================================================
 *  - Rust's `Result<RoomGraph, String>` becomes a plain return value that
 *    throws, matching `db-host`'s established "errors, not `Result`"
 *    convention (`util.ts`'s own note): every `?` in `build_room_graph` only
 *    ever fails on a broken DB connection, which throws here exactly as
 *    `queryRows`/`queryOne` already throw for every other reader.
 *  - Every `HashMap`/`HashSet` keyed by ROOM- OR FILE-CONTROLLED text (TF-IDF
 *    terms out of a file's own words, URLs, hosts, file names) is a `Map`/
 *    `Set` here, never a plain `{}` object literal — this codebase has found
 *    the `"__proto__"`-as-a-key bug five times already (rule 2), and
 *    `index_terms` over an attacker-authored file's text is exactly the kind
 *    of room-controlled key that bug keeps recurring on. `index_of`,
 *    unambiguously UUID-keyed and therefore lower risk, is still a `Map` for
 *    the same reason `db-host/retrieval.ts`'s `pool` is: consistency costs
 *    nothing here and removes any doubt.
 *  - Pair keys (`pair_key` in Rust, returning a `(String, String)` tuple used
 *    as a `HashMap`/`HashSet` key) become a single joined string
 *    (`${lo}\u0000${hi}`) for use as a `Map`/`Set` key — `\u0000` cannot
 *    appear in a UUID or in FTS-searched text, so this cannot collide.
 *  - `median`/`adaptive_floor`'s `HashMap<(usize, usize), (f32, bool)>` score
 *    cache becomes a `Map<string, [number, boolean]>` keyed by `"i,j"`
 *    (i < j) — same reasoning, indices are small non-negative integers so no
 *    ambiguity is possible.
 *
 * Per rule 4/`recIpc.ts`'s precedent, {@link registerRoomGraphIpc} is written
 * and tested directly but NOT wired into any bootstrap file. The channel name
 * (`"room_graph"`) is the Rust `#[tauri::command]` name `src/api.ts:1470`
 * already invokes, so a future renderer needs no rename.
 */

export { type GraphNode, type GraphEdge, type RoomGraph, EDGE_DERIVED, EDGE_SAME_PAGE, EDGE_SAME_SITE, EDGE_MENTIONS, EDGE_CITED, EDGE_SIMILAR, EDGE_KINDS, GRAPH_MAX_FILES, GRAPH_SIM_TOP_K, GRAPH_SIM_MAX_PER_NODE, GRAPH_VEC_FLOOR, GRAPH_KW_FLOOR, GRAPH_WEIGHT_MIN, GRAPH_MENTION_TOP, GRAPH_MENTION_DF_RATIO, GRAPH_MENTION_MIN_STEM, GRAPH_SITE_GROUP_MAX, GRAPH_CITED_MAX_SOURCES, GRAPH_CITED_TOP, GRAPH_TFIDF_TERMS, linkStrength, nameStem, type OpenRoom, type RoomSource } from "./moonshotGraphModel.js";
export { buildRoomGraph, roomGraph, registerRoomGraphIpc } from "./moonshotGraphSurface.js";
