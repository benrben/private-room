/** Cohesive extraction from moonshotGraph.ts; the public API remains on that module. */
import type Database from "better-sqlite3-multiple-ciphers";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { blobToEmbedding, cosineSimilarity, ftsFileMatches } from "./db-host/embeddings.js";
import { derivedLinks, listFiles, stripHebrewMarks, type FileMeta } from "./db-host/files.js";
import { listFolders } from "./db-host/folders.js";
import type { RoomSource } from "./moonshotCmds.js";
import type { OpenRoom } from "./turnEngine.js";
import { listMemories } from "./db-host/memories.js";
import { recentMessageSources } from "./db-host/messages.js";
import { ftsMatchExpr, NOT_ALPHANUMERIC, STOPWORDS } from "./db-host/retrieval.js";
import { queryRows } from "./db-host/util.js";
import { clampWords } from "./textClamp.js";
import { documentFrequency, graphAccumulations, graphFiles, graphFolders, graphIndex, graphMetas, graphNodes } from "./moonshotGraphFiles.js";
import { EdgeSet, GRAPH_MENTION_DF_RATIO, RoomGraph } from "./moonshotGraphModel.js";
import { addCitedEdges, addDerivedEdges, addFileMentionEdges, addMemoryMentionEdges, addOriginEdges } from "./moonshotGraphRelations.js";
import { addIsolateRescues, addSimilarEdges, pairScores } from "./moonshotGraphSimilarity.js";
export function buildRoomGraph(db: Database.Database): RoomGraph {
  const metas = graphMetas(db);
  const folders = graphFolders(db);
  const acc = graphAccumulations(db, metas);
  const df = documentFrequency(acc);
  const files = graphFiles(metas, folders, acc, df);
  const indexOfId = graphIndex(files);
  const memories = listMemories(db);
  const nodes = graphNodes(files, memories);
  const edges = new EdgeSet();
  const dfCap = Math.max(Math.round(Math.max(metas.length, 1) * GRAPH_MENTION_DF_RATIO), 1);

  addDerivedEdges(db, indexOfId, edges);
  addOriginEdges(files, edges);
  addFileMentionEdges(db, files, indexOfId, df, dfCap, edges);
  addMemoryMentionEdges(db, memories, indexOfId, df, dfCap, edges);
  addCitedEdges(db, files, edges);

  const scores = pairScores(files);
  addSimilarEdges(files, scores, edges);
  addIsolateRescues(files, scores, edges);
  return { nodes, edges: edges.intoSorted() };
}

// ============================================================================
// D3: the `#[tauri::command]` wrapper.
// ============================================================================

/** D3: the room's link graph for the RoomMap viewer. Ported from
 * `room_graph`. Empty when no room is open (never an error the UI has to
 * special-case) — same posture as `moonshotFrontPage.ts`'s `frontPage` for
 * its sibling command. */
export function roomGraph(rooms: RoomSource): RoomGraph {
  const room = rooms.currentRoom();
  if (room === null) {
    return { nodes: [], edges: [] };
  }
  return buildRoomGraph(room.db);
}

// ============================================================================
// IPC — written, NOT wired into any bootstrap file (rule 4).
// ============================================================================

/** Register the `room_graph` channel on `ipcMain`. NOT wired into any
 * bootstrap file — ready for a future preload/renderer batch, same
 * convention as `registerFrontPageIpc`/`registerRecIpc`. */
export function registerRoomGraphIpc(ipcMain: Pick<IpcMain, "handle">, rooms: RoomSource): void {
  ipcMain.handle("room_graph", (_event: IpcMainInvokeEvent) => roomGraph(rooms));
}
