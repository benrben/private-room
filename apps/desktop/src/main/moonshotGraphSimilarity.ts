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
import { GraphFile } from "./moonshotGraphFiles.js";
import { EDGE_SIMILAR, EdgeSet, GRAPH_KW_FLOOR, GRAPH_SIM_MAX_PER_NODE, GRAPH_SIM_TOP_K, GRAPH_VEC_FLOOR, adaptiveFloor, linkStrength, tfidfCosine, topSharedTerms } from "./moonshotGraphModel.js";
export type SimilarityScore = [number, boolean];
export type Similarity = [number, number, number, boolean];

export function scoreKey(i: number, j: number): string {
  return i < j ? `${i},${j}` : `${j},${i}`;
}

export function scoreOf(scores: ReadonlyMap<string, SimilarityScore>, i: number, j: number): SimilarityScore {
  return scores.get(scoreKey(i, j)) ?? [0, false];
}

export function floorFor(vector: boolean): number {
  return vector ? GRAPH_VEC_FLOOR : GRAPH_KW_FLOOR;
}

export function pairScores(files: readonly GraphFile[]): Map<string, SimilarityScore> {
  const scores = new Map<string, SimilarityScore>();
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const first = files[i] as GraphFile;
      const second = files[j] as GraphFile;
      const score: SimilarityScore = first.mean !== null && second.mean !== null
        ? [cosineSimilarity(first.mean, second.mean), true]
        : [tfidfCosine(first.tfidf, second.tfidf), false];
      scores.set(scoreKey(i, j), score);
    }
  }
  return scores;
}

export function similarityCandidates(
  index: number,
  vector: boolean,
  fileCount: number,
  scores: ReadonlyMap<string, SimilarityScore>,
): Array<[number, number]> {
  const candidates: Array<[number, number]> = [];
  for (let other = 0; other < fileCount; other++) {
    if (other === index) continue;
    const [raw, isVector] = scoreOf(scores, index, other);
    if (isVector === vector && raw >= floorFor(vector)) candidates.push([other, raw]);
  }
  return candidates;
}

export function compareCandidateScores(x: [number, number], y: [number, number]): number {
  if (y[1] !== x[1]) return y[1] - x[1];
  return x[0] - y[0];
}

export function proposeSimilarForFile(
  index: number,
  fileCount: number,
  scores: ReadonlyMap<string, SimilarityScore>,
  proposed: Set<string>,
): void {
  for (const vector of [true, false]) {
    const candidates = similarityCandidates(index, vector, fileCount, scores);
    if (candidates.length === 0) continue;
    candidates.sort(compareCandidateScores);
    const bar = adaptiveFloor(candidates.map((candidate) => candidate[1]));
    for (const [other, raw] of candidates.slice(0, GRAPH_SIM_TOP_K)) {
      if (raw >= bar) proposed.add(scoreKey(index, other));
    }
  }
}

export function proposedSimilarityPairs(
  fileCount: number,
  scores: ReadonlyMap<string, SimilarityScore>,
): Set<string> {
  const proposed = new Set<string>();
  for (let index = 0; index < fileCount; index++) {
    proposeSimilarForFile(index, fileCount, scores, proposed);
  }
  return proposed;
}

export function similaritiesFrom(
  proposed: ReadonlySet<string>,
  scores: ReadonlyMap<string, SimilarityScore>,
): Similarity[] {
  const similarities: Similarity[] = [];
  for (const key of proposed) {
    const [first, second] = key.split(",").map(Number);
    const [raw, isVector] = scoreOf(scores, first as number, second as number);
    similarities.push([first as number, second as number, raw, isVector]);
  }
  return similarities;
}

export function compareSimilarities(x: Similarity, y: Similarity): number {
  if (y[2] !== x[2]) return y[2] - x[2];
  if (x[0] !== y[0]) return x[0] - y[0];
  return x[1] - y[1];
}

export function offerSimilarEdge(
  files: readonly GraphFile[],
  first: number,
  second: number,
  raw: number,
  isVector: boolean,
  edges: EdgeSet,
): void {
  const firstFile = files[first] as GraphFile;
  const secondFile = files[second] as GraphFile;
  edges.offer({
    a: firstFile.id,
    b: secondFile.id,
    weight: linkStrength(raw, floorFor(isVector)),
    kind: EDGE_SIMILAR,
    directed: false,
    shared: topSharedTerms(firstFile.tfidf, secondFile.tfidf, 3),
  });
}

export function addSimilarEdges(
  files: readonly GraphFile[],
  scores: ReadonlyMap<string, SimilarityScore>,
  edges: EdgeSet,
): void {
  const similarities = similaritiesFrom(proposedSimilarityPairs(files.length, scores), scores);
  similarities.sort(compareSimilarities);
  for (const [first, second, raw, isVector] of similarities.slice(0, files.length * GRAPH_SIM_MAX_PER_NODE)) {
    offerSimilarEdge(files, first, second, raw, isVector, edges);
  }
}

export function isIsolated(index: number, files: readonly GraphFile[], edges: EdgeSet): boolean {
  const file = files[index] as GraphFile;
  for (let other = 0; other < files.length; other++) {
    if (other === index) continue;
    if (edges.contains(file.id, (files[other] as GraphFile).id)) return false;
  }
  return true;
}

export function isolatedFileIndexes(files: readonly GraphFile[], edges: EdgeSet): number[] {
  const isolated: number[] = [];
  for (let index = 0; index < files.length; index++) {
    if (isIsolated(index, files, edges)) isolated.push(index);
  }
  return isolated;
}

export function isBetterPartner(
  candidate: [number, number, boolean],
  best: [number, number, boolean] | null,
): boolean {
  return best === null || candidate[1] > best[1] || (candidate[1] === best[1] && candidate[0] < best[0]);
}

export function bestSimilarPartner(
  index: number,
  fileCount: number,
  scores: ReadonlyMap<string, SimilarityScore>,
): [number, number, boolean] | null {
  let best: [number, number, boolean] | null = null;
  for (let other = 0; other < fileCount; other++) {
    if (other === index) continue;
    const [raw, isVector] = scoreOf(scores, index, other);
    const candidate: [number, number, boolean] = [other, raw, isVector];
    const better = isBetterPartner(candidate, best);
    if (raw >= floorFor(isVector) && better) best = candidate;
  }
  return best;
}

export function addIsolateRescues(
  files: readonly GraphFile[],
  scores: ReadonlyMap<string, SimilarityScore>,
  edges: EdgeSet,
): void {
  for (const index of isolatedFileIndexes(files, edges)) {
    const best = bestSimilarPartner(index, files.length, scores);
    if (best !== null) offerSimilarEdge(files, index, best[0], best[1], best[2], edges);
  }
}
