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
import { EDGE_CITED, EDGE_DERIVED, EDGE_MENTIONS, EDGE_SAME_PAGE, EDGE_SAME_SITE, EdgeSet, GRAPH_CITED_MAX_SOURCES, GRAPH_CITED_TOP, GRAPH_MAX_FILES, GRAPH_MENTION_MIN_STEM, GRAPH_MENTION_TOP, GRAPH_SITE_GROUP_MAX, GraphEdge, indexTerms, nameStem, pairKeyStr, siteOf, starLinks } from "./moonshotGraphModel.js";
export function addDerivedEdges(
  db: Database.Database,
  indexOfId: ReadonlyMap<string, number>,
  edges: EdgeSet,
): void {
  for (const [source, output] of derivedLinks(db)) {
    if (indexOfId.has(source) && indexOfId.has(output)) {
      edges.offer({ a: source, b: output, weight: 1.0, kind: EDGE_DERIVED, directed: true, shared: [] });
    }
  }
}

export function groupIndex(groups: Map<string, number[]>, key: string, index: number): void {
  let group = groups.get(key);
  if (group === undefined) {
    group = [];
    groups.set(key, group);
  }
  group.push(index);
}

export function originGroups(files: readonly GraphFile[]): [Map<string, number[]>, Map<string, number[]>] {
  const byUrl = new Map<string, number[]>();
  const bySite = new Map<string, number[]>();
  for (let index = 0; index < files.length; index++) {
    const url = (files[index] as GraphFile).originUrl?.trim();
    if (url === undefined || url === "") continue;
    groupIndex(byUrl, url, index);
    const site = siteOf(url);
    if (site !== null) groupIndex(bySite, site, index);
  }
  return [byUrl, bySite];
}

export function offerAll(edges: EdgeSet, additions: readonly GraphEdge[]): void {
  for (const edge of additions) edges.offer(edge);
}

export function addSamePageEdges(
  groups: ReadonlyMap<string, number[]>,
  files: readonly GraphFile[],
  edges: EdgeSet,
): void {
  for (const url of [...groups.keys()].sort()) {
    const group = groups.get(url) as number[];
    if (group.length >= 2) offerAll(edges, starLinks(group, files, EDGE_SAME_PAGE, 1.0, [url]));
  }
}

export function addSameSiteEdges(
  groups: ReadonlyMap<string, number[]>,
  files: readonly GraphFile[],
  edges: EdgeSet,
): void {
  for (const site of [...groups.keys()].sort()) {
    const group = groups.get(site) as number[];
    if (group.length >= 2 && group.length <= GRAPH_SITE_GROUP_MAX) {
      offerAll(edges, starLinks(group, files, EDGE_SAME_SITE, 0.45, [site]));
    }
  }
}

export function addOriginEdges(files: readonly GraphFile[], edges: EdgeSet): void {
  const [byUrl, bySite] = originGroups(files);
  addSamePageEdges(byUrl, files, edges);
  addSameSiteEdges(bySite, files, edges);
}

export function isDistinctive(
  tokens: readonly string[],
  df: ReadonlyMap<string, number>,
  dfCap: number,
): boolean {
  if (tokens.length === 0) return false;
  let min = Number.POSITIVE_INFINITY;
  for (const term of tokens) {
    const frequency = df.get(term) ?? 0;
    if (frequency < min) min = frequency;
  }
  return min <= dfCap;
}

export function fileMentionQuery(
  file: GraphFile,
  df: ReadonlyMap<string, number>,
  dfCap: number,
): [string, string] | null {
  const stem = nameStem(file.name);
  if (Array.from(stem).length < GRAPH_MENTION_MIN_STEM) return null;
  if (!isDistinctive(indexTerms(stem), df, dfCap)) return null;
  const expression = ftsMatchExpr([stem.toLowerCase()]);
  return expression === null ? null : [stem, expression];
}

export function addFileMentionMatches(
  db: Database.Database,
  file: GraphFile,
  stem: string,
  expression: string,
  indexOfId: ReadonlyMap<string, number>,
  edges: EdgeSet,
): void {
  for (const hit of ftsFileMatches(db, expression, file.id, GRAPH_MENTION_TOP)) {
    if (indexOfId.has(hit)) {
      edges.offer({ a: hit, b: file.id, weight: 0.8, kind: EDGE_MENTIONS, directed: true, shared: [stem] });
    }
  }
}

export function addFileMentionEdges(
  db: Database.Database,
  files: readonly GraphFile[],
  indexOfId: ReadonlyMap<string, number>,
  df: ReadonlyMap<string, number>,
  dfCap: number,
  edges: EdgeSet,
): void {
  for (const file of files) {
    const query = fileMentionQuery(file, df, dfCap);
    if (query !== null) addFileMentionMatches(db, file, query[0], query[1], indexOfId, edges);
  }
}

export function compareTermsByFrequency(
  df: ReadonlyMap<string, number>,
  x: string,
  y: string,
): number {
  const xFrequency = termFrequency(df, x);
  const yFrequency = termFrequency(df, y);
  if (xFrequency !== yFrequency) return xFrequency - yFrequency;
  if (x < y) return -1;
  return 1;
}

export function termFrequency(df: ReadonlyMap<string, number>, term: string): number {
  const frequency = df.get(term);
  return frequency === undefined ? 0 : frequency;
}

export function memoryMentionTerms(
  content: string,
  df: ReadonlyMap<string, number>,
  dfCap: number,
): string[] {
  const terms = [...new Set(indexTerms(content))].filter((term) => {
    const frequency = df.get(term);
    return frequency !== undefined && frequency >= 1 && frequency <= dfCap;
  });
  terms.sort((x, y) => compareTermsByFrequency(df, x, y));
  return terms.slice(0, 2);
}

export function addMemoryMentionMatches(
  db: Database.Database,
  memoryId: string,
  terms: readonly string[],
  indexOfId: ReadonlyMap<string, number>,
  edges: EdgeSet,
): void {
  const expression = terms.map((term) => `"${term.replaceAll('"', "")}"`).join(" AND ");
  for (const hit of ftsFileMatches(db, expression, "", GRAPH_MENTION_TOP)) {
    if (indexOfId.has(hit)) {
      edges.offer({ a: `mem:${memoryId}`, b: hit, weight: 0.6, kind: EDGE_MENTIONS, directed: true, shared: [...terms] });
    }
  }
}

export function addMemoryMentionEdges(
  db: Database.Database,
  memories: ReturnType<typeof listMemories>,
  indexOfId: ReadonlyMap<string, number>,
  df: ReadonlyMap<string, number>,
  dfCap: number,
  edges: EdgeSet,
): void {
  for (const memory of memories.slice(0, GRAPH_MAX_FILES)) {
    const terms = memoryMentionTerms(memory.content, df, dfCap);
    if (terms.length > 0) addMemoryMentionMatches(db, memory.id, terms, indexOfId, edges);
  }
}

export interface CiteEntry {
  a: string;
  b: string;
  count: number;
}

export function fileIdsByName(files: readonly GraphFile[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const file of files) {
    if (!byName.has(file.name)) byName.set(file.name, file.id);
  }
  return byName;
}

export function resolvedSourceIds(sources: readonly string[], byName: ReadonlyMap<string, string>): string[] {
  const resolved: string[] = [];
  for (const source of sources) {
    const id = byName.get(source);
    if (id !== undefined) resolved.push(id);
  }
  return [...new Set(resolved)].sort();
}

export function incrementCiteCount(ids: readonly string[], counts: Map<string, CiteEntry>): void {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i] as string;
      const b = ids[j] as string;
      const key = pairKeyStr(a, b);
      const entry = counts.get(key);
      if (entry === undefined) counts.set(key, { a, b, count: 1 });
      else entry.count += 1;
    }
  }
}

export function citationCounts(db: Database.Database, byName: ReadonlyMap<string, string>): Map<string, CiteEntry> {
  const counts = new Map<string, CiteEntry>();
  for (const sources of recentMessageSources(db, 500)) {
    const ids = resolvedSourceIds(sources, byName);
    if (ids.length >= 2 && ids.length <= GRAPH_CITED_MAX_SOURCES) incrementCiteCount(ids, counts);
  }
  return counts;
}

export function addCitationPartner(
  partners: Map<string, Array<[string, number]>>,
  owner: string,
  other: string,
  count: number,
): void {
  let list = partners.get(owner);
  if (list === undefined) {
    list = [];
    partners.set(owner, list);
  }
  list.push([other, count]);
}

export function citationPartners(counts: ReadonlyMap<string, CiteEntry>): Map<string, Array<[string, number]>> {
  const partners = new Map<string, Array<[string, number]>>();
  for (const { a, b, count } of counts.values()) {
    addCitationPartner(partners, a, b, count);
    addCitationPartner(partners, b, a, count);
  }
  return partners;
}

export function comparePartners(x: [string, number], y: [string, number]): number {
  if (y[1] !== x[1]) return y[1] - x[1];
  return x[0] < y[0] ? -1 : 1;
}

export function keptCitationPairs(partners: ReadonlyMap<string, Array<[string, number]>>): Set<string> {
  const kept = new Set<string>();
  for (const owner of [...partners.keys()].sort()) {
    const list = [...(partners.get(owner) as Array<[string, number]>)];
    list.sort(comparePartners);
    for (const [other] of list.slice(0, GRAPH_CITED_TOP)) kept.add(pairKeyStr(owner, other));
  }
  return kept;
}

export function addCitedEdges(db: Database.Database, files: readonly GraphFile[], edges: EdgeSet): void {
  const counts = citationCounts(db, fileIdsByName(files));
  const kept = keptCitationPairs(citationPartners(counts));
  for (const { a, b, count } of counts.values()) {
    if (kept.has(pairKeyStr(a, b))) {
      edges.offer({
        a,
        b,
        weight: Math.min(0.5 + 0.15 * Math.log1p(count), 0.9),
        kind: EDGE_CITED,
        directed: false,
        shared: [`cited together in ${count} answer${count === 1 ? "" : "s"}`],
      });
    }
  }
}
