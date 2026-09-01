/**
 * Vitest port of `src-tauri/src/commands/retrieval.rs`'s `mod tests`.
 *
 * REAL FIXTURE ROOMS via `createRoom` (better-sqlite3-multiple-ciphers),
 * matching this directory's established convention — `files.ts`'s own
 * `insertFile`/`insertChunks` build every fixture, so the chunks these
 * queries rank are the chunks the app really writes.
 *
 * NOT PORTED:
 *  - `real_pdf_search_probe` — `#[ignore]`d in the Rust suite itself: a
 *    manual probe against a real PDF on the developer's disk (`PR_PDF` /
 *    `PR_FIND` env vars), not a test by that suite's own definition.
 *  - `the_hand_off_is_the_whole_conversation_not_a_window_slice` and
 *    `the_hand_off_is_fitted_to_the_engine_that_has_to_read_it` — both assert
 *    facts about `history_budget_bytes`/`handoff_budget_bytes` THEMSELVES
 *    (`commands.rs`, out of scope), not about `compactHistory`.
 *
 * ADAPTED: `a_long_conversation_survives_the_hand_off_intact` and
 * `the_backstop_still_bounds_a_years_old_room` ARE ported — they are
 * genuinely testing `compactHistory`'s own budget behaviour — with
 * `history_budget_bytes(…)` replaced by the literal `HISTORY_HANDOFF_MAX`
 * (200,000) that every call to it resolves to today, copied from
 * `commands.rs` rather than invented.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import { chunksMissingEmbedding, embeddingToBlob, setChunkEmbedding } from "./embeddings.js";
import { insertChunks, insertFile } from "./files.js";
import {
  MAX_CONTEXT_CHUNKS,
  MAX_VECTOR_CANDIDATES,
  MIN_CHUNK_SIMILARITY,
  compactHistory,
  ftsMatchExpr,
  makeSnippet,
  questionTerms,
  retrieveContext,
  retrieveContextExcluding,
  retrieveContextForFiles,
  retrieveContextLimited,
  selectMemories,
  stripMarkupBlocks,
} from "./retrieval.js";

/** `commands.rs`'s `HISTORY_HANDOFF_MAX`, which is what every
 * `history_budget_bytes(model)` call returns today. */
const HISTORY_HANDOFF_MAX = 200_000;

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-retrieval-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function addFile(db: Database.Database, name: string, text: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(text, "utf8"), text, "upload").id;
}

/** Give every chunk in the room the vector at the same index, in order —
 * mirrors the Rust test module's own `embed_chunks_in_order`. */
function embedChunksInOrder(db: Database.Database, vectors: number[][]): void {
  const missing = chunksMissingEmbedding(db, 1000);
  expect(missing.length, "fixture: one vector per chunk").toBe(vectors.length);
  missing.forEach(([id], i) => {
    setChunkEmbedding(db, id, embeddingToBlob(vectors[i] as number[]));
  });
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

// ============================================================ markup / terms

describe("stripMarkupBlocks / ftsMatchExpr / questionTerms", () => {
  it("strips_markup_blocks", () => {
    const content = 'Answer.\n\n```boxes\n{"a":1}\n```\n\n```annotation\n{"b":2}\n```';
    expect(stripMarkupBlocks(content)).toBe("Answer.");
    expect(stripMarkupBlocks("plain")).toBe("plain");
  });

  it("fts_match_expr_quotes_and_or_joins", () => {
    expect(ftsMatchExpr(["lease", "rent"])).toBe('"lease" OR "rent"');
    // Empty input yields no query (caller falls back).
    expect(ftsMatchExpr([])).toBeNull();
    // A quote inside a term would break out of the FTS string literal, and a
    // term that is nothing BUT quotes leaves an empty `""` that is dropped.
    expect(ftsMatchExpr(['re"nt', '"'])).toBe('"rent"');
  });

  it("lowercases, splits on non-alphanumeric runs, dedupes, drops stopwords, caps at 24", () => {
    // Not a standalone Rust test (question_terms is exercised through
    // retrieve_context and make_snippet), but every one of these properties
    // is load-bearing for both.
    expect(questionTerms("The Deposit, and the LEASE!")).toEqual(["deposit", "lease"]);
    // CHG-14: 2-letter high-signal terms survive; 2-letter stopwords do not.
    expect(questionTerms("AI EU Q2 IP")).toEqual(["ai", "eu", "q2", "ip"]);
    expect(questionTerms("is AI renewal")).toEqual(["ai", "renewal"]);
    // Repeats collapse to one.
    expect(questionTerms("the AI is the AI")).toEqual(["ai"]);
    expect(questionTerms("lease lease deposit")).toEqual(["lease", "deposit"]);
    const many = Array.from({ length: 30 }, (_, i) => `term${i}`).join(" ");
    expect(questionTerms(many).length).toBe(24);
  });

  it("strips Hebrew nikud first, so a pointed question matches the consonantal index", () => {
    expect(questionTerms("קֹהֶלֶת")).toEqual(["קהלת"]);
  });

  it("the >=2 filter counts UTF-8 BYTES, as Rust's word.len() does", () => {
    // A single Hebrew letter is 1 UTF-16 code unit but 2 UTF-8 bytes, and a
    // CJK character is 3 — so the Rust build keeps both as terms. Counting
    // `.length` would call them 1 and drop them, quietly making a
    // single-character query unanswerable in exactly the scripts this app
    // treats as first-class.
    expect(questionTerms("ו")).toEqual(["ו"]);
    expect(questionTerms("書")).toEqual(["書"]);
    // A single ASCII letter really is 1 byte, and really is dropped.
    expect(questionTerms("a b")).toEqual([]);
  });

  it("keeps a word whole across combining marks, as char::is_alphanumeric does", () => {
    // Rust splits on `!is_alphanumeric()`, which is ALPHABETIC ∪ numeric —
    // and Other_Alphabetic combining marks (Devanagari matras, Thai vowels)
    // are alphabetic. Splitting on `\p{L}` instead — the tempting near-miss —
    // shreds "किताब" into three single-consonant fragments the index cannot
    // contain.
    expect(questionTerms("किताब")).toEqual(["किताब"]);
  });
});

// =================================================================== snippet

describe("makeSnippet", () => {
  it("snippet_centers_on_the_match", () => {
    const text = "The quarterly report shows revenue of five million dollars this year.";
    const snip = makeSnippet(text, "revenue", 20);
    expect(snip.toLowerCase()).toContain("revenue");
    // Clipped on both sides → ellipses front and back.
    expect(snip.startsWith("…") && snip.endsWith("…")).toBe(true);
    // Multi-line text collapses to one line in the snippet.
    expect(makeSnippet("alpha\n\n  beta   gamma", "beta", 40)).toContain("alpha beta gamma");
    // No match → a preview from the start, never a throw.
    expect(makeSnippet("just some words here", "zzzzz", 5).startsWith("just")).toBe(true);
  });

  it("snippet_centres_on_the_selective_word_not_the_first_one", () => {
    // The two words of the query are ~900 characters apart, so there is no
    // phrase match to centre on. The preview must show the word that made the
    // file match, not the article the query happened to open with.
    const lease = `The tenant shall keep the premises in good repair. ${"Filler about quiet enjoyment. ".repeat(
      30
    )} Any deposit is held in trust.`;
    const snip = makeSnippet(lease, "the deposit", 40);
    expect(snip, `got ${snip}`).toContain("deposit");
    expect(snip, `still centred on the stopword: ${snip}`).not.toContain("tenant shall");
    // Longest-first among the selective terms.
    expect(makeSnippet(lease, "repair deposit", 40)).toContain("deposit");
    // A query with nothing selective in it keeps the old behaviour: the first
    // of its words that occurs at all.
    expect(makeSnippet(lease, "the it", 20)).toContain("tenant");
    // And a single word is still centred on itself.
    expect(makeSnippet(lease, "deposit", 20)).toContain("deposit");
  });

  it("snippet_survives_a_lowercase_that_changes_length", () => {
    // Turkish 'İ' (U+0130) lowercases to TWO chars, so a byte offset into the
    // lowered text drifts one char per 'İ'. With more of them before the
    // match than `radius`, the old char-count arithmetic produced start > end
    // and the Rust slice panicked — a room holding a page of Turkish headings
    // took the whole window down on any search.
    const heading = "İSTANBUL BÜYÜKŞEHİR BELEDİYESİ ";
    const snip = makeSnippet(`${heading.repeat(18)}kira sözleşmesi`, "sözleşmesi", 60);
    expect(snip, `match must be in the snippet: ${snip}`).toContain("sözleşmesi");
    // Centered on the match at the very end, so it is clipped only in front.
    expect(snip.startsWith("…") && !snip.endsWith("…")).toBe(true);
    // And a match BEFORE the length-changing chars still centers correctly.
    const early = makeSnippet(`kira sözleşmesi ${heading.repeat(18)}`, "sözleşmesi", 20);
    expect(early, `got ${early}`).toContain("sözleşmesi");
  });
});

// ================================================================= retrieval

describe("retrieveContext", () => {
  it("uses each named file's first chunk when the question has no FTS match", () => {
    const db = freshRoom();
    addFile(db, "notes.md", "A project update with no magic search term.");

    const [chunks, fallback] = retrieveContextForFiles(db, "unfindable keyword", ["notes.md", "NOTES.md"]);

    expect(fallback).toBe(false);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.fileName).toBe("notes.md");
    db.close();
  });

  it("fills the remaining named-file budget from later chunks", () => {
    const db = freshRoom();
    const fileId = addFile(db, "notes.md", "placeholder");
    db.prepare("DELETE FROM chunks WHERE file_id = ?").run(fileId);
    insertChunks(db, fileId, "A deliberately unfindable note. ".repeat(600));

    const [chunks] = retrieveContextForFiles(db, "missing keyword", ["notes.md"], 2);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.fileName === "notes.md")).toBe(true);
    db.close();
  });

  it("pointed_hebrew_is_searchable_by_plain_query", () => {
    // The Bible bug: nikud'd text indexed under unicode61 shreds into
    // single-letter fragments, so "קהלת" never matched "קֹהֶלֶת". The chunk
    // layer now indexes consonantally.
    const db = freshRoom();
    insertFile(
      db,
      "bible.pdf",
      "application/pdf",
      Buffer.from("x"),
      "דִּבְרֵי קֹהֶלֶת בֶּן־דָּוִד מֶלֶךְ בִּירוּשָׁלִָם׃",
      "upload"
    );
    // A plain (unpointed) query finds the chunk…
    let [chunks, fallback] = retrieveContext(db, "קהלת", null);
    expect(fallback, "plain Hebrew query must be a real match").toBe(false);
    expect(chunks[0]?.fileName).toBe("bible.pdf");
    expect(chunks[0]?.text, "chunk stores consonantal text").toContain("קהלת");

    // …and so does a POINTED query (marks stripped from the question too).
    [chunks, fallback] = retrieveContext(db, "קֹהֶלֶת", null);
    expect(fallback).toBe(false);
    expect(chunks[0]?.fileName).toBe("bible.pdf");
    db.close();
  });

  it("blend_retrieves_synonym_by_vector", () => {
    // ADD-13: keyword search cannot connect "time off" to "vacation
    // schedule", but a vector pointing at the vacation chunk can.
    const db = freshRoom();
    addFile(db, "handbook.txt", "The office holiday party is on Friday.");
    addFile(db, "hr.txt", "Our vacation schedule lists everyone's paid time away.");
    embedChunksByKeyword(db, "vacation");

    // The question shares no keyword with either file; its vector points at
    // the vacation chunk ([1,0]).
    const [chunks, fallback] = retrieveContext(db, "how much unpaid absence", [1.0, 0.0]);
    expect(fallback, "vector match must count as a real match").toBe(false);
    expect(chunks[0]?.fileName).toBe("hr.txt");

    // Pure keyword path (no embedding) still works for a literal term.
    const [kwChunks, kwFallback] = retrieveContext(db, "holiday", null);
    expect(kwFallback).toBe(false);
    expect(kwChunks[0]?.fileName).toBe("handbook.txt");

    // No keyword hit and no embedding → clean fallback to recent content.
    const [, genericFallback] = retrieveContext(db, "xyzzy nothing", null);
    expect(genericFallback).toBe(true);
    db.close();
  });

  it("a_question_the_room_cannot_answer_is_still_a_no_match_once_it_is_embedded", () => {
    // Every positive cosine used to pool a chunk, and every chunk in a room
    // has a positive cosine with almost every question — so once the backfill
    // finished, `fallback` was unreachable and a nonsense question came back
    // with the six least-unrelated chunks presented as the room's answer.
    const db = freshRoom();
    addFile(db, "hr.txt", "Our vacation schedule lists everyone's paid time away.");
    addFile(db, "lease.pdf", "The tenant shall not keep pets on the premises.");
    embedChunksInOrder(db, [
      [1.0, 0.0, 0.0],
      [0.0, 1.0, 0.0],
    ]);

    // Cosine 0.4 with both chunks — the band nomic-embed-text puts an
    // unanswerable question in (measured 0.32-0.49). No keyword overlap
    // either, so nothing at all in this room matches.
    let [chunks, fallback] = retrieveContext(db, "asdf qwerty", [0.4, 0.4, 0.8246211]);
    expect(
      fallback,
      `an unanswerable question must not be dressed up as a match: got ${chunks.length} chunks`
    ).toBe(true);

    // …and the floor must not be so high that a real match falls under it:
    // cosine 0.66 with hr.txt is what a genuine paraphrase scores.
    [chunks, fallback] = retrieveContext(db, "how much unpaid absence", [0.66, 0.4, 0.6359245]);
    expect(fallback, "a genuine vector match is still a match").toBe(false);
    expect(chunks[0]?.fileName).toBe("hr.txt");
    db.close();
  });

  it("MIN_CHUNK_SIMILARITY is the documented floor (0.55), not zero", () => {
    // A floor is a floor, not "any positive value" — pinned as a literal so a
    // future edit has to change this test on purpose.
    expect(MIN_CHUNK_SIMILARITY).toBe(0.55);
  });

  it("MAX_CONTEXT_CHUNKS caps a normal question's context", () => {
    const db = freshRoom();
    for (let i = 0; i < 10; i++) {
      addFile(db, `f${i}.txt`, `paragraph about topic ${i}`);
    }
    const [chunks] = retrieveContext(db, "topic", null);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CONTEXT_CHUNKS);
    db.close();
  });

  it("an_unlimited_search_of_a_huge_embedded_room_answers_instead_of_erroring", () => {
    // #find asks for every match (`limit: null`). The vector pass hydrates
    // its candidates with one SQL variable per rowid, and SQLite binds at
    // most 32,766 — so past that many embedded chunks the command did not
    // return a long list, it returned "too many SQL variables".
    const db = freshRoom();
    insertFile(db, "big.txt", "text/plain", Buffer.from("x"), "seed chunk", "upload");
    const fileId = db.prepare("SELECT id FROM files LIMIT 1").pluck().get() as string;
    const blob = embeddingToBlob([1.0, 0.0, 0.0]);
    const ROWS = 32_800; // one more than SQLite's variable limit
    const insert = db.prepare(
      "INSERT INTO chunks (id, file_id, seq, text, embedding) VALUES (?, ?, ?, ?, ?)"
    );
    const insertMany = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) {
        insert.run(`c${i}`, fileId, i, `paragraph ${i}`, blob);
      }
    });
    insertMany(ROWS);

    // No keyword hit (so every candidate has to be hydrated by the vector
    // pass), and a vector every chunk answers.
    const [chunks, fallback] = retrieveContextLimited(
      db,
      "asdf qwerty",
      [1.0, 0.0, 0.0],
      new Set(),
      null
    );
    expect(fallback).toBe(false);
    expect(chunks.length).toBeGreaterThan(0);
    expect(
      chunks.length,
      `an unlimited search still has to fit one query: ${chunks.length} chunks`
    ).toBeLessThanOrEqual(MAX_VECTOR_CANDIDATES);
    db.close();
  }, 30_000);

  it("retrieveContextExcluding drops chunks already injected into the prompt", () => {
    // Not a direct Rust unit-test target (`retrieve_context_excluding` is
    // only exercised through the commands that wrap it), but it is the one
    // behaviour `retrieveContext` never reaches — its `exclude` set is always
    // empty — and it is easy to get backwards (excluding BEFORE vs. AFTER
    // deciding `fallback`).
    const db = freshRoom();
    addFile(db, "a.txt", "the lease mentions a deposit");
    addFile(db, "b.txt", "another lease also mentions a deposit");
    const [firstPass] = retrieveContext(db, "lease deposit", null);
    expect(firstPass.length).toBe(2);
    const exclude = new Set([firstPass[0]?.rowid as number]);
    const [secondPass, fallback] = retrieveContextExcluding(db, "lease deposit", null, exclude);
    expect(fallback, "excluding one real hit must not manufacture a fallback").toBe(false);
    expect(secondPass.map((c) => c.rowid)).not.toContain(firstPass[0]?.rowid);
    expect(secondPass.length).toBe(1);
    db.close();
  });

  it("exclusion is applied AFTER the fallback gate — an emptied pool is not a no-match", () => {
    // The case that actually separates the two orders, and the reason the test
    // above is not enough on its own: excluding SOME of the hits leaves the
    // pool non-empty whichever side of the gate the exclusion happens on, so
    // that test stays green with the exclusion moved in FRONT of the gate
    // (verified by mutation) — the one-matching-row shape, in the other
    // direction.
    //
    // Excluding ALL of them is what tells them apart. `retrieveContextLimited`
    // gates `fallback` on the pool BEFORE exclusion, so a real match that
    // exclusion emptied comes back as `[[], false]`: the caller can tell "you
    // have already been shown everything this room has" from "the room does
    // not answer this", and CHG-10 keeps refusing to credit recent-content
    // filler as a source. Gating after exclusion would pad the answer with
    // unrelated recent chunks and call them context.
    const db = freshRoom();
    addFile(db, "a.txt", "the lease mentions a deposit");
    addFile(db, "b.txt", "another lease also mentions a deposit");
    const [firstPass] = retrieveContext(db, "lease deposit", null);
    expect(firstPass.length).toBe(2);
    const everything = new Set(firstPass.map((c) => c.rowid));
    const [chunks, fallback] = retrieveContextExcluding(db, "lease deposit", null, everything);
    expect(chunks).toEqual([]);
    expect(fallback, "an emptied pool is not a question the room cannot answer").toBe(false);
    db.close();
  });

  it("hand-verified RRF: a keyword-only hit, a vector-only hit, and one that wins both", () => {
    // The blend's arithmetic, made hand-computable. Three files:
    //   both.txt    — keyword rank 0 AND vector rank 0 → 1/60 + 1/60
    //   kwonly.txt  — keyword rank 1, no embedding     → 1/61
    //   veconly.txt — no keyword overlap, vector rank 1 → 1/61
    const db = freshRoom();
    addFile(db, "both.txt", "the quarterly lease renewal report");
    addFile(db, "kwonly.txt", "a lease renewal without the quarterly word twice over for ranking");
    addFile(db, "veconly.txt", "content sharing no keyword with the question at all");

    // `setChunkEmbedding` takes a CHUNK id, so map file name → chunk id
    // first. "both.txt" sits AT the question vector; "veconly.txt" a little
    // off it but still above the 0.55 floor; "kwonly.txt" is left unembedded.
    const idByName = new Map(
      (
        db
          .prepare("SELECT c.id as id, f.name as name FROM chunks c JOIN files f ON f.id = c.file_id")
          .all() as Array<{ id: string; name: string }>
      ).map((r) => [r.name, r.id])
    );
    setChunkEmbedding(db, idByName.get("both.txt") as string, embeddingToBlob([1.0, 0.0]));
    setChunkEmbedding(
      db,
      idByName.get("veconly.txt") as string,
      embeddingToBlob([0.9, Math.sqrt(1 - 0.81)])
    );

    const [chunks] = retrieveContextLimited(db, "quarterly lease renewal", [1.0, 0.0], new Set(), 3);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.fileName, "both signals must outrank either alone").toBe("both.txt");
    const bothScore = chunks[0]?.score as number;
    expect(bothScore).toBeCloseTo(1 / 60 + 1 / 60, 6);
    // The other two tie at 1/61, so assert the SET rather than an order the
    // arithmetic does not decide.
    expect(new Set(chunks.slice(1).map((c) => c.fileName))).toEqual(
      new Set(["kwonly.txt", "veconly.txt"])
    );
    for (const c of chunks.slice(1)) {
      expect(c.score).toBeCloseTo(1 / 61, 6);
      expect(c.score, "either signal alone must rank below both together").toBeLessThan(bothScore);
    }
    db.close();
  });
});

// =========================================================== history / memory

describe("compactHistory", () => {
  it("drops turns containing only viewer markup", () => {
    expect(compactHistory([["assistant", "```boxes\nhidden\n```"]], 2_000)).toEqual([]);
  });

  it("does not return a fragment too small to be useful", () => {
    const longTurn = "detail ".repeat(100);
    expect(compactHistory([["assistant", longTurn]], 399)).toEqual([]);
  });

  it("one_early_blank_line_does_not_shrink_a_long_turn_to_nothing", () => {
    // "Here's the summary:" over a list written with single newlines: the
    // only "\n\n" in 70 KB sits at character 19. Cutting there kept 19
    // characters of a 20,000-character allowance and spent the rest on
    // nothing.
    let long = "Here's the summary:\n\n";
    for (let i = 0; i < 2_000; i++) {
      long += `- item ${i} explained at some length\n`;
    }
    const budget = 20_000;
    const kept = compactHistory([["assistant", long]], budget);
    expect(kept.length).toBe(1);
    const piece = kept[0]?.[1] as string;
    expect(piece.length, `kept ${piece.length} characters of a ${budget} budget`).toBeGreaterThan(
      (budget * 3) / 4
    );
    expect(piece.endsWith("… [rest of this message omitted]")).toBe(true);

    // A paragraph boundary NEAR the cut is still preferred over it.
    const para = `${"a".repeat(19_000)}\n\n${"b".repeat(19_000)}`;
    const kept2 = compactHistory([["assistant", para]], budget);
    expect(kept2[0]?.[1], "cut past the nearby paragraph break").not.toContain("b");
    expect(kept2[0]?.[1]?.startsWith("aaa")).toBe(true);
  });

  it("a_long_conversation_survives_the_hand_off_intact", () => {
    // ~104 KB, the size the Rust source's own measurement used. At the old
    // 49,152-byte budget this lost more than half the turns; at
    // HISTORY_HANDOFF_MAX it loses none.
    const history: Array<[string, string]> = [];
    for (let i = 0; i < 40; i++) {
      history.push(["user", `Q${i} ${"x".repeat(1_300)}`]);
      history.push(["assistant", `A${i} ${"y".repeat(1_300)}`]);
    }
    const raw = history.reduce((sum, [, c]) => sum + Buffer.byteLength(c, "utf8"), 0);
    expect(raw, `fixture too small: ${raw}`).toBeGreaterThan(100_000);

    const kept = compactHistory(history, HISTORY_HANDOFF_MAX);
    expect(kept.length, "turns were dropped").toBe(history.length);
    // The OLDEST turn is the one truncation takes first, and the one a
    // revision-tracking question most often needs.
    expect(kept[0]?.[1]?.startsWith("Q0 ")).toBe(true);

    const starved = compactHistory(history, 49_152);
    expect(
      starved.length,
      "the old budget kept everything too — the fixture proves nothing"
    ).toBeLessThan(kept.length);
  });

  it("the_backstop_still_bounds_a_years_old_room", () => {
    const history: Array<[string, string]> = [];
    for (let i = 0; i < 400; i++) {
      history.push(["user", `T${i} ${"z".repeat(2_000)}`]);
    }
    const kept = compactHistory(history, HISTORY_HANDOFF_MAX);
    const bytes = kept.reduce((sum, [, c]) => sum + Buffer.byteLength(c, "utf8"), 0);
    expect(bytes).toBeLessThanOrEqual(HISTORY_HANDOFF_MAX);
    expect(kept.length).toBeGreaterThan(0);
  });

  it("the history budget is BYTES, not UTF-16 length — a Hebrew turn costs what Rust charges it", () => {
    // Not in the Rust suite (its own fixtures are all ASCII, so the
    // distinction is invisible there) — but `compact_history`'s budget IS
    // genuinely `String::len()`, unlike `select_memories`' (CHG-8 fixed the
    // byte/char confusion THERE and not here). A Hebrew character is 2 UTF-8
    // bytes but 1 UTF-16 code unit, so a budget confused for characters would
    // keep roughly DOUBLE what the Rust build keeps.
    const latinTurn = "a".repeat(1000); // 1000 chars, 1000 bytes
    const hebrewTurn = "א".repeat(1000); // 1000 chars, 2000 bytes
    const budget = 1500;
    // The Latin turn fits whole…
    expect(compactHistory([["user", latinTurn]], budget)).toEqual([["user", latinTurn]]);
    // …the Hebrew one does not, and what is kept still fits the byte budget.
    const hebrewKept = compactHistory([["user", hebrewTurn]], budget);
    expect(hebrewKept.length, "an over-budget turn is cut, not kept whole").toBe(1);
    expect(hebrewKept[0]?.[1]).not.toBe(hebrewTurn);
    const keptBytes = Buffer.byteLength(hebrewKept[0]?.[1] as string, "utf8");
    // The marker is appended after the cut, so allow for its length.
    expect(keptBytes, `kept ${keptBytes} bytes of a ${budget}-byte budget`).toBeLessThanOrEqual(
      budget + "\n… [rest of this message omitted]".length
    );
    // And it never cuts mid-character: re-encoding is lossless.
    const text = hebrewKept[0]?.[1] as string;
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
  });

  it("backs a compacted fragment up to a UTF-8 character boundary", () => {
    const value = `prefix ${"🙂".repeat(500)}`;
    // The raw cut is byte 964: one byte into the emoji that starts at 963.
    // The result must back up to that start byte rather than decode a partial
    // character as U+FFFD.
    const [[, piece]] = compactHistory([["assistant", value]], 1_004);
    expect(piece).not.toContain("�");
    expect(piece).toBe(`prefix ${"🙂".repeat(239)}\n… [rest of this message omitted]`);
    expect(Buffer.from(piece, "utf8").toString("utf8")).toBe(piece);
  });
});

describe("selectMemories", () => {
  it("the_memory_budget_is_the_same_size_in_every_script", () => {
    // The budget is named in characters, so it has to hold the same number of
    // notes whatever script they are written in. Counting bytes instead gave
    // a Hebrew-speaking user half the memory an English-speaking one got, in
    // a room where Hebrew is a first-class language.
    const latin = Array.from({ length: 6 }, (_, i) => `note ${i} ${"a".repeat(40)}`);
    const hebrew = Array.from({ length: 6 }, (_, i) => `note ${i} ${"א".repeat(40)}`);
    const budget = 200;
    const nLatin = selectMemories(latin, "note", budget).length;
    const nHebrew = selectMemories(hebrew, "note", budget).length;
    expect(nLatin, "the fixture should fit at least one note").toBeGreaterThan(0);
    expect(
      nLatin,
      `same notes, same length, different script — ${nLatin} fit in Latin but ${nHebrew} in Hebrew`
    ).toBe(nHebrew);
  });

  it("a_note_too_big_to_fit_does_not_end_the_selection", () => {
    // The oversized note has to sort FIRST for this to pin anything: both
    // notes match "short", and the tie breaks on recency (later index wins),
    // so the huge one is considered before the small one. With `break` the
    // selection ends there and returns nothing; with `continue` the budget
    // goes to the note that fits.
    const memories = ["short one", `short ${"x".repeat(120)}`];
    expect(
      selectMemories(memories, "short", 60),
      "a note too big for the remaining budget is skipped, not a stopping point"
    ).toEqual(["short one"]);
  });
});
