/**
 * Vitest port of `src-tauri/src/commands/moonshot/graph.rs`'s `#[cfg(test)]
 * mod tests` — all 14 reproduced against REAL fixture rooms via `createRoom`
 * (better-sqlite3-multiple-ciphers), matching this migration's established
 * convention (`db-host/retrieval.test.ts`'s own header states the same
 * reasoning): `insertFile`/`insertFileFromUrl`/`addMemory`/`createChat`/
 * `insertMessage` build every fixture, so the rows `buildRoomGraph` reads are
 * the rows the app really writes.
 *
 * PLUS a few extra tests (not in the Rust `#[cfg(test)]` module, which tests
 * `build_room_graph` directly) covering the `roomGraph`/`registerRoomGraphIpc`
 * wrapper layer this port adds around it.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

import { createRoom } from "./db-host/open.js";
import { chunksMissingEmbedding, embeddingToBlob, setChunkEmbedding } from "./db-host/embeddings.js";
import { insertFile, insertFileFromUrl, setDerivedFrom } from "./db-host/files.js";
import { addMemory } from "./db-host/memories.js";
import { createChat } from "./db-host/chats.js";
import { insertMessage } from "./db-host/messages.js";
import type { RoomSource } from "./moonshotCmds.js";
import type { OpenRoom } from "./turnEngine.js";
import {
  EDGE_CITED,
  EDGE_DERIVED,
  EDGE_MENTIONS,
  EDGE_SAME_PAGE,
  EDGE_SAME_SITE,
  EDGE_SIMILAR,
  GRAPH_CITED_TOP,
  GRAPH_KW_FLOOR,
  GRAPH_SIM_MAX_PER_NODE,
  GRAPH_VEC_FLOOR,
  GRAPH_WEIGHT_MIN,
  buildRoomGraph,
  linkStrength,
  nameStem,
  registerRoomGraphIpc,
  roomGraph,
  type GraphEdge,
  type RoomGraph,
} from "./moonshotGraph.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "moonshotGraph-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function add(db: Database.Database, name: string, text: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(text, "utf8"), text, "upload").id;
}

/** Mirrors `commands.rs`'s `#[cfg(test)]` `embed_chunks_by_keyword`: a toy
 * deterministic 2-D embedding — chunks containing `keyword` point one way,
 * everything else points the orthogonal way. */
function embedChunksByKeyword(db: Database.Database, keyword: string): void {
  for (const [id, , text] of chunksMissingEmbedding(db, 1000)) {
    const v = text.toLowerCase().includes(keyword) ? [1.0, 0.0] : [0.0, 1.0];
    setChunkEmbedding(db, id, embeddingToBlob(v));
  }
}

function kinds(g: RoomGraph, kind: string): Array<[string, string]> {
  return g.edges.filter((e) => e.kind === kind).map((e): [string, string] => [e.a, e.b]);
}

function pairKey(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

describe("linkStrength / nameStem — the two directly-tested pure helpers", () => {
  it("keyword_and_vector_links_share_one_strength_scale", () => {
    // A link that only just clears its own bar reads the same either way…
    expect(Math.abs(linkStrength(GRAPH_KW_FLOOR, GRAPH_KW_FLOOR) - GRAPH_WEIGHT_MIN)).toBeLessThan(1e-6);
    expect(Math.abs(linkStrength(GRAPH_VEC_FLOOR, GRAPH_VEC_FLOOR) - GRAPH_WEIGHT_MIN)).toBeLessThan(1e-6);
    // …and a perfect match is 1.0 on both.
    expect(Math.abs(linkStrength(1.0, GRAPH_KW_FLOOR) - 1.0)).toBeLessThan(1e-6);
    expect(Math.abs(linkStrength(1.0, GRAPH_VEC_FLOOR) - 1.0)).toBeLessThan(1e-6);
    // A strong term overlap outranks a barely-there cosine, instead of being
    // drawn as a hairline and dropped first at the edge cap.
    expect(linkStrength(0.5, GRAPH_KW_FLOOR)).toBeGreaterThan(linkStrength(0.46, GRAPH_VEC_FLOOR));
    // Nothing below its own floor ever reaches the drawable band.
    expect(Math.abs(linkStrength(0.0, GRAPH_VEC_FLOOR) - GRAPH_WEIGHT_MIN)).toBeLessThan(1e-6);
  });

  it("name_stem_drops_the_extension_and_the_rerun_suffix", () => {
    expect(nameStem("Flashcards - clean-code.html")).toBe("Flashcards - clean-code");
    // `availableName` bumps a re-run to "X (2)" — the map must still see the
    // same name in the text that talks about the first run.
    expect(nameStem("Flashcards - clean-code (2).html")).toBe("Flashcards - clean-code");
    expect(nameStem("noext")).toBe("noext");
    expect(nameStem("budget (draft).md")).toBe("budget (draft)");
  });
});

describe("buildRoomGraph", () => {
  it("tfidf_prefers_distinctive_words_over_the_first_ones", () => {
    // The old keyword signal was Jaccard over the first 24 words, so the "why
    // linked" reason was the opening line of the file. TF-IDF ranks by how
    // rare a word is in THIS room.
    const db = freshRoom();
    const filler =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima " +
      "mike november oscar papa quebec romeo sierra tango uniform victor whiskey " +
      "xray yankee zulu";
    const a = add(db, "a.txt", `${filler} kryptonite`);
    const b = add(db, "b.txt", `${filler} kryptonite`);
    add(db, "c.txt", `${filler} paperwork`);
    const g = buildRoomGraph(db);
    const ab = g.edges.find((e) => {
      const [x, y] = pairKey(e.a, e.b);
      const [px, py] = pairKey(a, b);
      return x === px && y === py;
    });
    expect(ab, "the two kryptonite files link").toBeDefined();
    expect(ab?.kind).toBe(EDGE_SIMILAR);
    expect(ab?.shared[0], "the reason names the rare word, not the one every file shares").toBe(
      "kryptonite"
    );
  });

  it("an_absolute_similarity_threshold_no_longer_cliques_the_map", () => {
    // THE regression this change exists to prevent. 20 files that all clear
    // the old 0.55 cosine used to produce C(20,2) = 190 edges — a complete
    // graph, which tells the reader nothing.
    const db = freshRoom();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(add(db, `f${i}.txt`, "vacation summer holiday plans"));
    }
    embedChunksByKeyword(db, "vacation");
    const g = buildRoomGraph(db);
    expect(g.nodes.filter((n) => n.kind === "file").length).toBe(20);
    const sim = kinds(g, EDGE_SIMILAR).length;
    expect(sim, `${sim} similar edges is a hairball`).toBeLessThanOrEqual(20 * GRAPH_SIM_MAX_PER_NODE);
    expect(sim, `an all-alike room must still read as connected, got ${sim}`).toBeGreaterThanOrEqual(10);
    expect(g.edges.length, "the complete graph must be gone").toBeLessThan(190 / 2);
    expect(ids.length).toBe(20);
  });

  it("a_two_file_room_can_still_link_and_an_unrelated_file_cannot", () => {
    // The rank rule must degrade correctly at the smallest room there is —
    // and the absolute floor is what keeps "connected" from meaning
    // "everything is connected".
    const db = freshRoom();
    const a = add(db, "trip.txt", "Our vacation plans for the summer holiday.");
    const b = add(db, "pto.txt", "The vacation schedule and paid time away.");
    embedChunksByKeyword(db, "vacation");
    const g = buildRoomGraph(db);
    expect(kinds(g, EDGE_SIMILAR).length, "two matching files link").toBe(1);
    const e = g.edges[0] as GraphEdge;
    expect([e.a, e.b]).toContain(a);
    expect([e.a, e.b]).toContain(b);

    // A third file whose vector is orthogonal earns nothing, not even from
    // the isolate rescue — an unrelated file stays a lone star.
    const c = add(db, "budget.txt", "Quarterly office budget spreadsheet totals.");
    embedChunksByKeyword(db, "vacation");
    const g2 = buildRoomGraph(db);
    expect(
      g2.edges.some((e2) => e2.a === c || e2.b === c),
      "an orthogonal file must not be given a link to look connected"
    ).toBe(false);
  });

  it("a_full_pass_output_links_back_to_the_file_it_was_made_from", () => {
    const db = freshRoom();
    const src = add(db, "lease.txt", "The lease agreement covers pets and the deposit.");
    const out = add(db, "Full pass — lease.txt.md", "Summary of the agreement.");
    setDerivedFrom(db, out, src);
    const g = buildRoomGraph(db);
    const derived = kinds(g, EDGE_DERIVED);
    expect(derived).toEqual([[src, out]]);
    expect(g.edges.find((e) => e.kind === EDGE_DERIVED)?.directed).toBe(true);

    // A file cannot be made from itself, and a dangling id draws nothing.
    setDerivedFrom(db, out, out);
    expect(kinds(buildRoomGraph(db), EDGE_DERIVED).length).toBe(1);
  });

  it("two_saves_of_one_page_link_and_two_pages_of_one_host_link_weaker", () => {
    const db = freshRoom();
    const md = insertFileFromUrl(
      db,
      "Council minutes.md",
      "text/markdown",
      Buffer.from("x"),
      "minutes text",
      "web",
      "https://example.com/minutes"
    ).id;
    const html = insertFileFromUrl(
      db,
      "Council minutes.html",
      "text/html",
      Buffer.from("x"),
      "minutes text",
      "web",
      "https://example.com/minutes"
    ).id;
    const other = insertFileFromUrl(
      db,
      "Budget page.md",
      "text/markdown",
      Buffer.from("x"),
      "budget text",
      "web",
      "https://www.example.com/budget"
    ).id;
    const g = buildRoomGraph(db);
    const samePage = kinds(g, EDGE_SAME_PAGE);
    expect(samePage.length, "the md/html twin is exactly one link").toBe(1);
    expect([samePage[0]?.[0], samePage[0]?.[1]]).toContain(md);
    expect([samePage[0]?.[0], samePage[0]?.[1]]).toContain(html);
    // `www.` is not a different site.
    const sameSite = kinds(g, EDGE_SAME_SITE);
    expect(
      sameSite.some(([a, b]) => [a, b].includes(other)),
      "the third page links to the host's newest file"
    ).toBe(true);
    expect(
      g.edges.some((e) => e.kind === EDGE_SAME_SITE && e.shared.length === 1 && e.shared[0] === "example.com"),
      "the tooltip names the host it is claiming"
    ).toBe(true);
  });

  it("one_document_naming_another_is_a_link_and_a_generic_name_is_not", () => {
    const db = freshRoom();
    // A distinctive name that really appears in another file's text.
    const target = add(db, "Peregrine audit 2024.md", "the audit body");
    const citer = add(db, "board pack.md", "See Peregrine audit 2024 for the numbers.");
    // A generic name that appears all over the room earns nothing.
    const generic = add(db, "Notes.md", "loose notes");
    for (let i = 0; i < 8; i++) {
      add(db, `filler${i}.md`, "these are notes about notes and more notes");
    }
    const g = buildRoomGraph(db);
    const mentions = kinds(g, EDGE_MENTIONS);
    expect(
      mentions.some(([a, b]) => a === citer && b === target),
      `the naming file points at the named one, got ${JSON.stringify(mentions)}`
    ).toBe(true);
    expect(
      mentions.some(([, b]) => b === generic),
      "a name every file's words contain is not evidence of anything"
    ).toBe(false);
    // Short stems are never searched for at all.
    const short = add(db, "q1.md", "x");
    const g2 = buildRoomGraph(db);
    expect(kinds(g2, EDGE_MENTIONS).some(([, b]) => b === short)).toBe(false);
  });

  it("two_files_answering_one_question_are_linked_and_a_research_dump_is_not", () => {
    const db = freshRoom();
    const a = add(db, "lease.txt", "pets clause");
    const b = add(db, "addendum.txt", "deposit clause");
    const c = add(db, "email.txt", "landlord note");
    const d = add(db, "receipt.txt", "payment");
    const e = add(db, "photos.txt", "images");
    const chat = createChat(db);
    insertMessage(db, chat.id, "assistant", "Both say the same thing.", ["lease.txt", "addendum.txt"], null);
    // Five sources is research, not a relationship between any two of them.
    insertMessage(
      db,
      chat.id,
      "assistant",
      "Here is everything.",
      ["lease.txt", "addendum.txt", "email.txt", "receipt.txt", "photos.txt"],
      null
    );
    const g = buildRoomGraph(db);
    const cited = kinds(g, EDGE_CITED);
    expect(cited.length, `only the two-source answer draws, got ${JSON.stringify(cited)}`).toBe(1);
    expect([cited[0]?.[0], cited[0]?.[1]]).toContain(a);
    expect([cited[0]?.[0], cited[0]?.[1]]).toContain(b);
    for (const id of [c, d, e]) {
      expect(cited.some(([x, y]) => x === id || y === id)).toBe(false);
    }
    // A name that no longer resolves is dropped, never guessed at.
    insertMessage(db, chat.id, "assistant", "Gone.", ["lease.txt", "deleted file.txt"], null);
    expect(kinds(buildRoomGraph(db), EDGE_CITED).length).toBe(1);
  });

  it("a_chatty_room_does_not_cite_every_file_alongside_every_other", () => {
    // `cited` is a fact, and the viewer exempts facts from its edge cap — so
    // an unbounded one is a hairball nothing downstream can thin.
    const db = freshRoom();
    for (let i = 0; i < 20; i++) {
      add(db, `f${i}.txt`, "unrelated body text");
    }
    const chat = createChat(db);
    for (let i = 0; i < 20; i++) {
      for (let j = i + 1; j < 20; j++) {
        insertMessage(db, chat.id, "assistant", "x", [`f${i}.txt`, `f${j}.txt`], null);
      }
    }
    const g = buildRoomGraph(db);
    const cited = kinds(g, EDGE_CITED).length;
    expect(cited, `${cited} cited edges is a hairball`).toBeLessThanOrEqual(20 * GRAPH_CITED_TOP);
    expect(cited, "…but a room that really does cite files together still reads").toBeGreaterThanOrEqual(10);

    // The bound is by RANK, so the pair the room keeps reaching for together
    // survives while the one-off pairs around it are dropped.
    const db2 = freshRoom();
    const a = add(db2, "lease.txt", "pets");
    const b = add(db2, "addendum.txt", "deposit");
    for (let i = 0; i < 8; i++) {
      add(db2, `other${i}.txt`, "misc");
    }
    const chat2 = createChat(db2);
    for (let i = 0; i < 5; i++) {
      insertMessage(db2, chat2.id, "assistant", "x", ["lease.txt", "addendum.txt"], null);
    }
    for (let i = 0; i < 8; i++) {
      insertMessage(db2, chat2.id, "assistant", "x", ["lease.txt", `other${i}.txt`], null);
    }
    const g2 = buildRoomGraph(db2);
    const [px, py] = pairKey(a, b);
    expect(
      kinds(g2, EDGE_CITED).some(([x, y]) => x === px && y === py),
      "the most-cited pair is the one that must survive the bound"
    ).toBe(true);
  });

  it("a_memory_links_to_the_files_its_distinctive_words_appear_in", () => {
    // Memories used to be decorative — nodes that could never have an edge.
    const db = freshRoom();
    const f = add(db, "policy.md", "The Zermatt retreat is booked for the whole team.");
    add(db, "unrelated.md", "Invoices and quarterly totals.");
    addMemory(db, "We always go to Zermatt in February.", null);
    const g = buildRoomGraph(db);
    const mem = g.edges.filter((e) => e.a.startsWith("mem:"));
    expect(mem.length, `one memory edge, got ${mem.length}`).toBe(1);
    expect(mem[0]?.b).toBe(f);
    expect(mem[0]?.shared, "it says which word matched").toContain("zermatt");

    // A memory made only of words the room never uses stays unlinked.
    addMemory(db, "Remember the aardvark provisions.", null);
    const g2 = buildRoomGraph(db);
    expect(g2.edges.filter((e) => e.a.startsWith("mem:")).length).toBe(1);
    expect(g2.nodes.filter((n) => n.kind === "memory").length).toBe(2);
  });

  it("a_file_the_room_knows_nothing_about_stays_isolated", () => {
    // The honest failure mode: a sparse map beats a pretty untrue one.
    const db = freshRoom();
    add(db, "trip.txt", "Our vacation plans for the summer holiday.");
    add(db, "pto.txt", "The vacation schedule and paid time away.");
    const lone = add(db, "zzz.bin", "qwrtypsdfghjklzxcvbnm");
    embedChunksByKeyword(db, "vacation");
    const g = buildRoomGraph(db);
    expect(
      g.edges.some((e) => e.a === lone || e.b === lone),
      "nothing relates this file, so nothing may be drawn from it"
    ).toBe(false);
    expect(g.nodes.some((n) => n.id === lone), "…but it is still on the map").toBe(true);
  });

  it("a_fact_wins_the_pair_over_a_guess", () => {
    // One line per pair, and it is the one that tells the reader the most.
    const db = freshRoom();
    const src = add(db, "trip.txt", "Our vacation plans for the summer holiday.");
    const out = add(db, "pto.txt", "The vacation schedule and paid time away.");
    embedChunksByKeyword(db, "vacation");
    expect((buildRoomGraph(db).edges[0] as GraphEdge).kind).toBe(EDGE_SIMILAR);
    setDerivedFrom(db, out, src);
    const g = buildRoomGraph(db);
    expect(g.edges.length, "not two lines on top of each other").toBe(1);
    expect(g.edges[0]?.kind).toBe(EDGE_DERIVED);
  });

  it("the_same_room_always_produces_the_same_payload", () => {
    // The viewer only re-lays-out when the edge list changes, so a builder
    // that returned the same links in a different order each time would
    // scramble the reader's map on every unrelated file write.
    const db = freshRoom();
    for (let i = 0; i < 12; i++) {
      add(db, `f${i}.txt`, `shared topic words number ${i} and more`);
    }
    const a = buildRoomGraph(db);
    const b = buildRoomGraph(db);
    const key = (g: RoomGraph) => g.edges.map((e) => [e.a, e.b, e.kind]);
    expect(key(a)).toEqual(key(b));
    expect(a.edges.length, "the fixture must actually produce edges").toBeGreaterThan(0);
  });
});

describe("roomGraph — the command wrapper", () => {
  function roomSource(db: Database.Database | null, path = "/tmp/x.roomai"): RoomSource {
    return { currentRoom: (): OpenRoom | null => (db === null ? null : { db, path }) };
  }

  it("answers an empty graph, not an error, when no room is open", () => {
    expect(roomGraph(roomSource(null))).toEqual({ nodes: [], edges: [] });
  });

  it("answers buildRoomGraph's own result when a room is open", () => {
    const db = freshRoom();
    add(db, "a.txt", "hello world");
    expect(roomGraph(roomSource(db))).toEqual(buildRoomGraph(db));
  });
});

describe("registerRoomGraphIpc", () => {
  it("registers exactly one channel, room_graph, forwarding to roomGraph", () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const fakeIpcMain: Pick<import("electron").IpcMain, "handle"> = {
      handle: (channel, listener) => {
        handlers.set(channel, listener as (event: unknown) => unknown);
      },
    };
    const db = freshRoom();
    add(db, "a.txt", "hello world");
    const rooms: RoomSource = { currentRoom: (): OpenRoom | null => ({ db, path: "/tmp/x.roomai" }) };
    registerRoomGraphIpc(fakeIpcMain, rooms);

    expect([...handlers.keys()]).toEqual(["room_graph"]);
    const result = handlers.get("room_graph")?.({});
    expect(result).toEqual(buildRoomGraph(db));
  });
});

// ============================================================================
// ADVERSARIAL
// ============================================================================

describe("buildRoomGraph — adversarial", () => {
  it("a doubled www. is the SAME site (`trim_start_matches`, not one strip)", () => {
    // Rust's `host.trim_start_matches("www.")` removes the prefix REPEATEDLY.
    // Stripping it once filed `www.www.example.com` and `example.com` in
    // different `by_site` groups, so the two pages of one host drew no
    // `same_site` link at all — a relation the room can PROVE, silently
    // missing, with nothing in the payload to say it had been dropped.
    const db = freshRoom();
    insertFileFromUrl(
      db, "a.md", "text/markdown", Buffer.from("x"), "alpha body", "web",
      "https://www.www.example.com/a"
    );
    insertFileFromUrl(
      db, "b.md", "text/markdown", Buffer.from("x"), "beta body", "web",
      "https://example.com/b"
    );
    const g = buildRoomGraph(db);
    const site = g.edges.filter((e) => e.kind === EDGE_SAME_SITE);
    expect(site).toHaveLength(1);
    expect(site[0]!.shared).toEqual(["example.com"]);
  });
});

describe("roomGraph — adversarial (interop with the rest of the moonshot family)", () => {
  it("takes the SAME room source moonshotCmds/FrontPage/AiActions/Server all take", () => {
    // This file originally took `jobs.ts`'s `{ current() }` while its five
    // siblings take `moonshotCmds.ts`'s `{ currentRoom() }`, so the single
    // room object a bootstrap builds for the moonshot cluster drove five of
    // the six files and died with `TypeError: rooms.current is not a
    // function` on this one. Typed against the shared `RoomSource` so a
    // regression is a compile error, and asserted at runtime so a widened
    // type cannot hide it.
    const db = freshRoom();
    add(db, "a.txt", "hello world");
    const familyRooms: RoomSource = { currentRoom: (): OpenRoom | null => ({ db, path: "/tmp/x.roomai" }) };
    expect(roomGraph(familyRooms)).toEqual(buildRoomGraph(db));
    expect(roomGraph({ currentRoom: () => null })).toEqual({ nodes: [], edges: [] });
  });
});
