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
import { GRAPH_MAX_FILES, GRAPH_TFIDF_TERMS, GraphNode, indexTerms, isSummaryFile } from "./moonshotGraphModel.js";
// ============================================================================
// The builder.
// ============================================================================

export interface GraphFile {
  id: string;
  name: string;
  folder: string | null;
  originUrl: string | null;
  mean: number[] | null;
  /** L2-normalised TF-IDF weights over the file's most distinctive terms. */
  tfidf: Map<string, number>;
}

export interface Acc {
  sum: number[];
  n: number;
  tf: Map<string, number>;
}

/**
 * D3: build the room's typed link graph from stored data ONLY — no model
 * call. Ported from `build_room_graph`.
 *
 * Six relations, five of which the room can PROVE (provenance, a shared
 * source URL, one document naming another, two documents cited by one
 * answer) and one inferred (`similar`). The inferred one is the only one
 * that is thresholded, and it is bounded by rank rather than by an absolute
 * similarity, because a single global cutoff over mean-pooled document
 * vectors admits every pair in the room. Nothing here invents a relation to
 * make the picture look connected: a file the room knows nothing about
 * stays a lone star.
 *
 * Pure over the connection → unit-testable with a real fixture room.
 */
export function graphFolders(db: Database.Database): Map<string, string> {
  const folders = new Map<string, string>();
  for (const folder of listFolders(db)) folders.set(folder.id, folder.name);
  return folders;
}

export function graphMetas(db: Database.Database): FileMeta[] {
  const metas: FileMeta[] = [];
  for (const meta of listFiles(db)) {
    if (!isSummaryFile(meta.name, meta.source)) metas.push(meta);
    if (metas.length === GRAPH_MAX_FILES) break;
  }
  return metas;
}

export function graphChunkRows(
  db: Database.Database,
  metas: readonly FileMeta[],
): Array<[string, Buffer | null, string]> {
  if (metas.length === 0) return [];
  const placeholders = metas.map(() => "?").join(",");
  return queryRows(
    db,
    `SELECT file_id, embedding, text FROM chunks WHERE file_id IN (${placeholders})`,
    metas.map((meta) => meta.id),
    (row): [string, Buffer | null, string] => [
      row[0] as string,
      row[1] as Buffer | null,
      row[2] as string,
    ],
  );
}

export function accumulationFor(acc: Map<string, Acc>, fileId: string): Acc {
  let entry = acc.get(fileId);
  if (entry === undefined) {
    entry = { sum: [], n: 0, tf: new Map() };
    acc.set(fileId, entry);
  }
  return entry;
}

export function addEmbedding(entry: Acc, embedding: Buffer | null): void {
  if (embedding === null) return;
  const vector = blobToEmbedding(embedding);
  if (vector === null) return;
  if (entry.sum.length === 0) {
    entry.sum = vector;
    entry.n += 1;
    return;
  }
  addMatchingEmbedding(entry, vector);
}

export function addMatchingEmbedding(entry: Acc, vector: readonly number[]): void {
  if (entry.sum.length !== vector.length) return;
  for (let index = 0; index < entry.sum.length; index++) {
    entry.sum[index] = (entry.sum[index] as number) + (vector[index] as number);
  }
  entry.n += 1;
}

export function addTerms(entry: Acc, text: string): void {
  for (const term of indexTerms(text)) {
    if (entry.tf.size < 20_000 || entry.tf.has(term)) {
      entry.tf.set(term, (entry.tf.get(term) ?? 0) + 1);
    }
  }
}

export function graphAccumulations(db: Database.Database, metas: readonly FileMeta[]): Map<string, Acc> {
  const acc = new Map<string, Acc>();
  for (const [fileId, embedding, text] of graphChunkRows(db, metas)) {
    const entry = accumulationFor(acc, fileId);
    addEmbedding(entry, embedding);
    addTerms(entry, text);
  }
  return acc;
}

export function documentFrequency(acc: ReadonlyMap<string, Acc>): Map<string, number> {
  const df = new Map<string, number>();
  for (const entry of acc.values()) {
    for (const term of entry.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return df;
}

export function meanEmbedding(entry: Acc | undefined): number[] | null {
  if (entry === undefined || entry.n === 0 || entry.sum.length === 0) return null;
  return entry.sum.map((value) => value / entry.n);
}

export function compareTermWeights(x: [string, number], y: [string, number]): number {
  if (y[1] !== x[1]) return y[1] - x[1];
  return x[0] < y[0] ? -1 : 1;
}

export function weightedTerms(
  entry: Acc | undefined,
  df: ReadonlyMap<string, number>,
  nDocs: number,
): Array<[string, number]> {
  if (entry === undefined) return [];
  const weighted: Array<[string, number]> = [];
  for (const [term, tf] of entry.tf) {
    const idf = Math.log(nDocs / (df.get(term) ?? 1)) + 1;
    weighted.push([term, (1 + Math.log(tf)) * idf]);
  }
  weighted.sort(compareTermWeights);
  return weighted.slice(0, GRAPH_TFIDF_TERMS);
}

export function normalisedTerms(weighted: readonly [string, number][]): Map<string, number> {
  const norm = Math.sqrt(weighted.reduce((sum, [, weight]) => sum + weight * weight, 0));
  const tfidf = new Map<string, number>();
  if (norm === 0) return tfidf;
  for (const [term, weight] of weighted) tfidf.set(term, weight / norm);
  return tfidf;
}

export function graphFile(
  meta: FileMeta,
  folders: ReadonlyMap<string, string>,
  acc: ReadonlyMap<string, Acc>,
  df: ReadonlyMap<string, number>,
  nDocs: number,
): GraphFile {
  const entry = acc.get(meta.id);
  return {
    id: meta.id,
    name: meta.name,
    folder: meta.folderId !== null ? (folders.get(meta.folderId) ?? null) : null,
    originUrl: meta.originUrl,
    mean: meanEmbedding(entry),
    tfidf: normalisedTerms(weightedTerms(entry, df, nDocs)),
  };
}

export function graphFiles(
  metas: readonly FileMeta[],
  folders: ReadonlyMap<string, string>,
  acc: ReadonlyMap<string, Acc>,
  df: ReadonlyMap<string, number>,
): GraphFile[] {
  const nDocs = Math.max(metas.length, 1);
  return metas.map((meta) => graphFile(meta, folders, acc, df, nDocs));
}

export function graphIndex(files: readonly GraphFile[]): Map<string, number> {
  const indexOfId = new Map<string, number>();
  for (let index = 0; index < files.length; index++) {
    indexOfId.set((files[index] as GraphFile).id, index);
  }
  return indexOfId;
}

export function graphNodes(files: readonly GraphFile[], memories: ReturnType<typeof listMemories>): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const file of files) {
    nodes.push({ id: file.id, name: file.name, folder: file.folder, kind: "file" });
  }
  for (const memory of memories.slice(0, GRAPH_MAX_FILES)) {
    nodes.push({ id: `mem:${memory.id}`, name: clampWords(memory.content, 60), folder: null, kind: "memory" });
  }
  return nodes;
}
