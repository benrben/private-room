use super::*;

mod backfill;
pub(crate) use backfill::*;

/// Remove fenced UI-markup payloads (```boxes, ```annotation) from message
/// content — they are viewer data, not conversation text.
pub(crate) fn strip_markup_blocks(content: &str) -> String {
    let mut out = content.to_string();
    for tag in ["```boxes", "```annotation"] {
        while let Some(start) = out.find(tag) {
            let after = &out[start + tag.len()..];
            out = match after.find("```") {
                Some(end) => format!("{}{}", &out[..start], &after[end + 3..]),
                None => out[..start].to_string(),
            }
            .trim()
            .to_string();
        }
    }
    out
}

pub(crate) const STOPWORDS: &[&str] = &[
    // CHG-14: include common 2-letter function words so the >=2 length filter
    // can admit high-signal short terms (AI, EU, Q2, IP) without letting these
    // through.
    "is", "to", "of", "in", "on", "at", "it", "be", "as", "by", "an", "or", "if", "we", "do",
    "so", "up", "my", "me", "no", "us", "am", "he",
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our",
    "out", "get", "has", "him", "his", "how", "new", "now", "see", "two", "way", "who", "did",
    "its", "let", "say", "she", "too", "use", "that", "with", "have", "this", "will", "your",
    "from", "they", "know", "want", "been", "good", "much", "some", "time", "what", "when",
    "which", "about", "would", "there", "their", "were", "them", "then", "than", "into", "also",
    "just", "like", "over", "such", "only", "most", "make", "after", "where", "does", "please",
    "could", "should", "tell",
];

pub(crate) fn question_terms(question: &str) -> Vec<String> {
    let mut terms = Vec::new();
    // A pasted pointed-Hebrew query must match the consonantal index: marks
    // are alphanumeric-adjacent separators that would shred the word here.
    let question = extraction::strip_hebrew_marks(question);
    for word in question
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
    {
        // CHG-14: >=2 so short high-signal terms (AI, EU, Q2, IP) survive; the
        // 2-letter function words are filtered by STOPWORDS above.
        if word.len() >= 2 && !STOPWORDS.contains(&word) && !terms.contains(&word.to_string()) {
            terms.push(word.to_string());
        }
        if terms.len() >= 24 {
            break;
        }
    }
    terms
}

/// How close a chunk's vector has to be to the question's before it counts as
/// a match at all.
///
/// Measured on the embed model this app actually runs (nomic-embed-text with
/// the `search_query:` / `search_document:` prefixes, 2026-08-16): a question
/// nothing in the room answers ("asdf qwerty", "kzzzt vorplex") scores
/// 0.32–0.49 against EVERY chunk, while a real paraphrase of a chunk scores
/// 0.64–0.83. Any positive cosine used to pool a chunk, so once the backfill
/// had run no question could ever be reported as unanswered: the six chunks
/// with the highest cosine came back under a header calling them context from
/// the room, when all that distinguished them was being least-unrelated.
pub(crate) const MIN_CHUNK_SIMILARITY: f32 = 0.55;

/// How many vector candidates one question may carry into hydration.
///
/// `chunks_by_rowids` binds one SQL variable per rowid and SQLite binds at most
/// 32,766 of them, so an unlimited request (`limit: None`) over a room with
/// more embedded chunks than that failed the whole query rather than answering
/// it. Far above anything a caller displays, and far below the bind limit.
const MAX_VECTOR_CANDIDATES: usize = 2_000;

pub(crate) struct ScoredChunk {
    pub(crate) rowid: i64,
    pub(crate) file_name: String,
    pub(crate) text: String,
    pub(crate) score: f32,
}

/// Build an FTS5 MATCH expression from search terms: each term is double-quoted
/// (so punctuation or an FTS keyword like "or"/"near" is treated as a literal)
/// and the terms are OR-joined. Returns None when there are no usable terms.
pub(crate) fn fts_match_expr<'a>(terms: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let quoted: Vec<String> = terms
        .into_iter()
        // A quote inside a term would break out of the FTS string literal.
        .map(|t| format!("\"{}\"", t.replace('"', "")))
        .filter(|t| t.len() > 2) // drop the empty `""` a stripped term leaves
        .collect();
    if quoted.is_empty() {
        None
    } else {
        Some(quoted.join(" OR "))
    }
}

/// HLT-3 + ADD-13: retrieve context by blending the FTS5 keyword score with
/// vector (cosine) similarity over stored chunk embeddings, then taking the top
/// MAX_CONTEXT_CHUNKS. `question_embedding` is the question's vector (from
/// `embed_question`); pass None to run the pure keyword path unchanged — when
/// the embed model is absent or no chunks are embedded yet, retrieval degrades
/// cleanly to keywords.
///
/// Returns the chunks plus a `fallback` flag: true when nothing matched and we
/// padded with recent content instead (CHG-10 — such filler must not be credited
/// as a "source"). The `(chunks, fallback)` tuple shape is preserved for callers.
pub(crate) fn retrieve_context(
    conn: &Connection,
    question: &str,
    question_embedding: Option<&[f32]>,
) -> Result<(Vec<ScoredChunk>, bool), String> {
    retrieve_context_excluding(conn, question, question_embedding, &std::collections::HashSet::new())
}

/// CHG-13 + CHG-15 + CHG-16: as `retrieve_context`, but excludes chunk rowids in
/// `exclude` (used by search_room to skip chunks already injected into the
/// prompt). Blends keyword and vector signals with Reciprocal Rank Fusion —
/// scale-free, no min-max degeneracy, no "vec=0 for a good keyword hit". The
/// vector pass scores over (rowid, blob) only (no text copied) and hydrates just
/// the top candidates' text, so a large room no longer allocates every chunk's
/// text per question under the room mutex.
pub(crate) fn retrieve_context_excluding(
    conn: &Connection,
    question: &str,
    question_embedding: Option<&[f32]>,
    exclude: &std::collections::HashSet<i64>,
) -> Result<(Vec<ScoredChunk>, bool), String> {
    retrieve_context_limited(conn, question, question_embedding, exclude, Some(MAX_CONTEXT_CHUNKS))
}

/// As `retrieve_context_excluding`, but with the result count as a parameter.
/// `None` means every match, for callers that are SHOWING results rather than
/// spending a context window on them (#find): capping a search result list at the
/// six chunks a prompt can afford hides matches the user came to see.
pub(crate) fn retrieve_context_limited(
    conn: &Connection,
    question: &str,
    question_embedding: Option<&[f32]>,
    exclude: &std::collections::HashSet<i64>,
    limit: Option<usize>,
) -> Result<(Vec<ScoredChunk>, bool), String> {
    /// RRF damping constant; standard value.
    const RRF_K: f32 = 60.0;
    // Rank enough candidates per signal to fill the requested result count; an
    // unlimited request pools everything the index can return (SQLite treats a
    // negative LIMIT as no limit, which `i64::MAX` matches in practice).
    let candidates = match limit {
        Some(n) => n.saturating_mul(4).max(RETRIEVE_CANDIDATES),
        // Not `i64::MAX`: hydration binds one SQL variable per rowid and SQLite
        // binds at most 32,766, so "no limit" over a big room failed the whole
        // query instead of answering it.
        None => MAX_VECTOR_CANDIDATES,
    };
    struct Cand {
        file_name: String,
        text: String,
        kw_rank: Option<usize>,
        vec_rank: Option<usize>,
    }
    let mut pool: HashMap<i64, Cand> = HashMap::new();

    // Keyword signal: chunks ranked best-first by bm25 → RRF rank.
    if let Some(expr) = fts_match_expr(question_terms(question).iter().map(String::as_str)) {
        let hits = db::search_chunks_fts_ranked(conn, &expr, candidates)?;
        for (rank, (rowid, name, text, _bm25)) in hits.into_iter().enumerate() {
            let e = pool.entry(rowid).or_insert_with(|| Cand {
                file_name: name,
                text,
                kw_rank: None,
                vec_rank: None,
            });
            e.kw_rank = Some(rank);
        }
    }

    // Vector signal: brute-force cosine over (rowid, blob) — no text shuttled.
    // Pool only positive-cosine chunks, ranked by cosine → RRF rank; hydrate
    // text for the winners not already present from the keyword pass.
    // Scored while STREAMING the blobs (`for_each_chunk_embedding` +
    // `cosine_similarity_blob`): collecting every embedding into a Vec first,
    // and decoding each one into a Vec<f32>, meant tens of MB allocated and
    // thrown away per question on a book-sized room, all under the room lock.
    // Only the (rowid, cosine) pairs — 12 bytes a chunk — are kept.
    if let Some(q) = question_embedding {
        let mut scored: Vec<(i64, f32)> = Vec::new();
        db::for_each_chunk_embedding(conn, |rowid, blob| {
            let cos = db::cosine_similarity_blob(q, blob);
            // A floor, not "any positive cosine": every chunk scores somewhat
            // above zero against any question, so pooling on `> 0.0` meant a
            // question the room cannot answer still came back with its six
            // least-unrelated chunks, presented as context from the room.
            if cos >= MIN_CHUNK_SIMILARITY {
                scored.push((rowid, cos));
            }
        })?;
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(candidates);
        let need_text: Vec<i64> = scored
            .iter()
            .map(|(rowid, _)| *rowid)
            .filter(|rowid| !pool.contains_key(rowid))
            .collect();
        let hydrated: HashMap<i64, (String, String)> = db::chunks_by_rowids(conn, &need_text)?
            .into_iter()
            .map(|(rowid, name, text)| (rowid, (name, text)))
            .collect();
        for (rank, (rowid, _cos)) in scored.into_iter().enumerate() {
            if let Some(e) = pool.get_mut(&rowid) {
                e.vec_rank = Some(rank);
            } else if let Some((name, text)) = hydrated.get(&rowid) {
                pool.insert(
                    rowid,
                    Cand {
                        file_name: name.clone(),
                        text: text.clone(),
                        kw_rank: None,
                        vec_rank: Some(rank),
                    },
                );
            }
        }
    }

    // A real match means the pool was populated by keyword or positive-cosine
    // hits — gate the fallback on that (before any exclusion) so no-match
    // questions still fall back and CHG-10 keeps refusing to credit filler.
    if !pool.is_empty() {
        let mut scored: Vec<ScoredChunk> = pool
            .into_iter()
            .filter(|(rowid, _)| !exclude.contains(rowid))
            .map(|(rowid, c)| {
                let rrf = c.kw_rank.map_or(0.0, |r| 1.0 / (RRF_K + r as f32))
                    + c.vec_rank.map_or(0.0, |r| 1.0 / (RRF_K + r as f32));
                ScoredChunk {
                    rowid,
                    file_name: c.file_name,
                    text: c.text,
                    score: rrf,
                }
            })
            .collect();
        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(n) = limit {
            scored.truncate(n);
        }
        // Every RRF-pooled chunk scores > 0; empty only when exclusion removed
        // all of them — the caller distinguishes that from a true no-match.
        return Ok((scored, false));
    }

    // Generic questions ("summarize this") match nothing; fall back to the
    // most recently added content so the model still sees the room.
    let scored = db::recent_chunks(conn, limit.unwrap_or(MAX_CONTEXT_CHUNKS))?
        .into_iter()
        .map(|(file_name, text)| ScoredChunk {
            rowid: -1,
            file_name,
            text,
            score: 0.0,
        })
        .collect();
    Ok((scored, true))
}

/// ADD-6: extract a short snippet of `haystack` around the first occurrence of
/// `needle` (case-insensitive), with ellipses when clipped. Falls back to the
/// first matching word of `needle`, then to the start of the text. Whitespace
/// is collapsed so multi-line file text reads as one line. Pure and testable.
pub(crate) fn make_snippet(haystack: &str, needle: &str, radius: usize) -> String {
    /// Greek final sigma: `str::to_lowercase` picks ς at a word end while
    /// `char::to_lowercase` always gives σ. Folding both sides to σ keeps the
    /// per-char lowering below interchangeable with the needle's.
    fn fold(c: char) -> char {
        if c == 'ς' {
            'σ'
        } else {
            c
        }
    }
    let normalized: String = haystack.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = normalized.chars().collect();
    // Lowercasing is length-preserving in neither bytes NOR chars — Turkish 'İ'
    // (U+0130) lowercases to TWO chars — so an offset into the lowered text says
    // nothing about the original. Lower char by char, remembering where each
    // original char landed, and map a hit back through that. Counting the chars
    // of `lower[..hit]` against `normalized` (what this did) drifts one char per
    // 'İ' and, once the drift passes `radius`, slices `chars[start..end]` with
    // start > end — a panic on any room holding a page of Turkish headings.
    let mut lower = String::with_capacity(normalized.len());
    let mut starts: Vec<usize> = Vec::with_capacity(chars.len());
    for c in &chars {
        starts.push(lower.len());
        lower.extend(c.to_lowercase().map(fold));
    }
    let find = |n: &str| {
        let n: String = n.trim().to_lowercase().chars().map(fold).collect();
        if n.is_empty() {
            None
        } else {
            lower.find(&n)
        }
    };
    // No match to center on: return a clipped preview from the start.
    //
    // The whole phrase first; failing that, the most SELECTIVE word in it. Word
    // order used to decide, so "the deposit" previewed the region around "the" —
    // in a lease that opens "The tenant shall…", the reader saw the first
    // sentence with "the" marked and never saw the word that made the file
    // match. `question_terms` is the same stopword filter the search itself
    // ranks with; longest term first is the cheap stand-in for selectivity.
    // Raw word order still backstops it, so a query that is ALL stopwords
    // ("the it") centres exactly where it used to.
    let mut selective = question_terms(needle);
    selective.sort_by_key(|t| std::cmp::Reverse(t.chars().count()));
    let Some(byte) = find(needle)
        .or_else(|| selective.iter().find_map(|t| find(t)))
        .or_else(|| needle.split_whitespace().find_map(find))
    else {
        let mut out: String = chars.iter().take(radius * 2).collect();
        if chars.len() > radius * 2 {
            out.push('…');
        }
        return out;
    };
    // `starts` is strictly increasing (every char lowers to at least one byte),
    // so the last entry at or before the hit is the char the hit begins in.
    let char_pos = starts.partition_point(|&s| s <= byte).saturating_sub(1);
    let start = char_pos.saturating_sub(radius);
    let end = (char_pos + radius).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// CHG-8: compact chat history under a single char budget. `history` is
/// oldest-first. We walk newest-first, keeping whole turns until the budget is
/// spent (recency-weighted), and drop older turns entirely instead of cutting
/// each to a fixed head. A turn that alone exceeds the budget is cut at the
/// last paragraph boundary NEAR the limit — or at the limit itself when the
/// nearest one is far behind it — with an explicit omitted-marker, so the model
/// never sees a silently unterminated prior turn. Char-safe.
pub(crate) fn compact_history(history: Vec<(String, String)>, budget: usize) -> Vec<(String, String)> {
    let mut kept: Vec<(String, String)> = Vec::new();
    let mut remaining = budget;
    for (role, content) in history.into_iter().rev() {
        // Viewer-markup payloads are UI data, not conversation.
        let content = strip_markup_blocks(&content);
        if content.is_empty() {
            continue;
        }
        if content.len() <= remaining {
            remaining -= content.len();
            kept.push((role, content));
            continue;
        }
        // Doesn't fully fit. If we have room for a useful fragment of the
        // newest such turn, cut it at a paragraph boundary; otherwise stop.
        if remaining < 400 {
            break;
        }
        let cut = floor_boundary(&content, remaining.saturating_sub(40));
        // A paragraph boundary is worth having only if it is NEAR the cut. One
        // blank line early in a long turn — "Here's the summary:\n\n" above a
        // list written with single newlines — is the last "\n\n" before a cut
        // 40 KB later, so this kept 19 characters and threw the other 40 KB of
        // allowance away. Past that distance, cut where the budget says.
        let floor = cut - cut / 5;
        let end = match content[..cut].rfind("\n\n") {
            Some(at) if at >= floor => at,
            _ => cut,
        };
        let mut piece = content[..end].to_string();
        piece.push_str("\n… [rest of this message omitted]");
        kept.push((role, piece));
        break;
    }
    kept.reverse();
    kept
}

/// CHG-7: choose which persistent memories to inject under a char budget,
/// preferring ones whose text overlaps the question's keywords, then recency.
/// `memories` is oldest-first (list_memories order); returns the selected
/// memory strings in the order they should be shown.
pub(crate) fn select_memories(memories: &[String], question: &str, budget: usize) -> Vec<String> {
    let terms = question_terms(question);
    // Score = overlapping keyword count; recency breaks ties (tail = newest).
    let mut scored: Vec<(usize, usize, &String)> = memories
        .iter()
        .enumerate()
        .map(|(idx, m)| {
            let lower = m.to_lowercase();
            let hits = terms.iter().filter(|t| lower.contains(t.as_str())).count();
            (hits, idx, m)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut out = Vec::new();
    let mut used = 0usize;
    for (_, _, m) in scored {
        // CHARACTERS, matching the budget's name (`MAX_MEMORY_INJECT_CHARS`).
        // This charged `m.len()` — bytes — so a note in Hebrew, Arabic, Greek
        // or Cyrillic cost twice what the same note costs in English, and a
        // room written in one of them got half the memory injected. Nothing
        // about the budget's purpose is script-dependent; the counting was.
        let cost = m.chars().count() + 3; // "- " + "\n"
        if used + cost > budget {
            // BREAK WOULD BE WRONG HERE, and the test above is red on it: the
            // list is relevance-ordered, so skipping one note that will not fit
            // to take a later one that does spends budget that would otherwise
            // sit empty. Stopping would drop context for nothing.
            continue;
        }
        used += cost;
        out.push(m.clone());
    }
    out
}

// ================================================================= chat commands
// Prebuilt "#name …" workflows. Typing "#" is deterministic routing done by the
// most reliable router available — a human — so the small local model is invoked
// only at the fuzzy nodes (write this text, pick this quote, list these items)
// with a tiny task prompt instead of the full agent loop's tool-selection
// gamble. "@name" pins a file/folder as guaranteed context (handled frontend-
// side by resolving to attachment ids). Every command is a fixed pipeline in
// code; the model never sees the "#"/"@" syntax.


#[cfg(test)]
mod tests {
    use super::*;

    /// The budget is named in characters, so it has to hold the same number of
    /// notes whatever script they are written in. Counting bytes instead gave a
    /// Hebrew-speaking user half the memory an English-speaking one got, in a
    /// room where Hebrew is a first-class language.
    #[test]
    fn the_memory_budget_is_the_same_size_in_every_script() {
        let latin: Vec<String> = (0..6)
            .map(|i| format!("note {i} {}", "a".repeat(40)))
            .collect();
        let hebrew: Vec<String> = (0..6)
            .map(|i| format!("note {i} {}", "א".repeat(40)))
            .collect();
        let budget = 200;
        let n_latin = select_memories(&latin, "note", budget).len();
        let n_hebrew = select_memories(&hebrew, "note", budget).len();
        assert!(n_latin > 0, "the fixture should fit at least one note");
        assert_eq!(
            n_latin, n_hebrew,
            "same notes, same length, different script — {n_latin} fit in Latin but \
             {n_hebrew} in Hebrew"
        );
    }

    /// Relevance-ordered, then greedy: a note that does not fit is SKIPPED, not
    /// a stopping point, so the remaining budget goes to the next one that
    /// does. Pinned because the obvious "tidier" rewrite — `break` — silently
    /// throws away context that had room.
    #[test]
    fn a_note_too_big_to_fit_does_not_end_the_selection() {
        // The oversized note has to sort FIRST for this to pin anything: both
        // notes match "short", and the tie breaks on recency (later index
        // wins), so the huge one is considered before the small one. With
        // `break` the selection ends there and returns nothing; with `continue`
        // the budget goes to the note that fits.
        let memories = vec![
            "short one".to_string(),
            format!("short {}", "x".repeat(120)),
        ];
        let chosen = select_memories(&memories, "short", 60);
        assert_eq!(
            chosen,
            vec!["short one".to_string()],
            "a note too big for the remaining budget is skipped, not a stopping point"
        );
    }

    #[test]
    fn snippet_centers_on_the_match() {
        let text = "The quarterly report shows revenue of five million dollars this year.";
        let snip = make_snippet(text, "revenue", 20);
        assert!(snip.to_lowercase().contains("revenue"));
        // Clipped on both sides → ellipses front and back.
        assert!(snip.starts_with('…') && snip.ends_with('…'));
        // Multi-line text collapses to one line in the snippet.
        let multi = make_snippet("alpha\n\n  beta   gamma", "beta", 40);
        assert!(multi.contains("alpha beta gamma"));
        // No match → a preview from the start, never a panic.
        let none = make_snippet("just some words here", "zzzzz", 5);
        assert!(none.starts_with("just"));
    }

    #[test]
    fn snippet_centres_on_the_selective_word_not_the_first_one() {
        // The two words of the query are 900 characters apart, so there is no
        // phrase match to centre on. The preview must show the word that made
        // the file match, not the article the query happened to open with.
        let lease = format!(
            "The tenant shall keep the premises in good repair. {} Any deposit is held in trust.",
            "Filler about quiet enjoyment. ".repeat(30)
        );
        let snip = make_snippet(&lease, "the deposit", 40);
        assert!(snip.contains("deposit"), "got {snip:?}");
        assert!(!snip.contains("tenant shall"), "still centred on the stopword: {snip:?}");
        // Longest-first among the selective terms.
        let both = make_snippet(&lease, "repair deposit", 40);
        assert!(both.contains("deposit"), "got {both:?}");
        // A query with nothing selective in it keeps the old behaviour: the
        // first of its words that occurs at all.
        let all_stop = make_snippet(&lease, "the it", 20);
        assert!(all_stop.contains("tenant"), "got {all_stop:?}");
        // And a single word is still centred on itself.
        let one = make_snippet(&lease, "deposit", 20);
        assert!(one.contains("deposit"), "got {one:?}");
    }

    #[test]
    fn one_early_blank_line_does_not_shrink_a_long_turn_to_nothing() {
        // "Here's the summary:" over a list written with single newlines: the
        // only "\n\n" in 70 KB sits at character 19. Cutting there kept 19
        // characters of a 20,000-character allowance and spent the rest on
        // nothing.
        let mut long = String::from("Here's the summary:\n\n");
        for i in 0..2_000 {
            long.push_str(&format!("- item {i} explained at some length\n"));
        }
        let budget = 20_000;
        let kept = compact_history(vec![("assistant".into(), long)], budget);
        assert_eq!(kept.len(), 1);
        let piece = &kept[0].1;
        assert!(
            piece.len() > budget * 3 / 4,
            "kept {} characters of a {budget} budget",
            piece.len()
        );
        assert!(piece.ends_with("… [rest of this message omitted]"));

        // A paragraph boundary NEAR the cut is still preferred over it.
        let para = format!("{}\n\n{}", "a".repeat(19_000), "b".repeat(19_000));
        let kept = compact_history(vec![("assistant".into(), para)], budget);
        assert!(!kept[0].1.contains('b'), "cut past the nearby paragraph break");
        assert!(kept[0].1.starts_with("aaa"));
    }

    #[test]
    fn snippet_survives_a_lowercase_that_changes_length() {
        // Turkish 'İ' (U+0130) lowercases to TWO chars, so a byte offset into
        // the lowered text drifts one char per 'İ'. With more of them before the
        // match than `radius`, the old char-count arithmetic produced
        // start > end and `chars[start..end]` panicked — a room holding a page
        // of Turkish headings took the whole window down on any search.
        let heading = "İSTANBUL BÜYÜKŞEHİR BELEDİYESİ ";
        let text = format!("{}kira sözleşmesi", heading.repeat(18));
        let snip = make_snippet(&text, "sözleşmesi", 60);
        assert!(snip.contains("sözleşmesi"), "match must be in the snippet: {snip:?}");
        // Centered on the match at the very end, so it is clipped only in front.
        assert!(snip.starts_with('…') && !snip.ends_with('…'));
        // And a match BEFORE the length-changing chars still centers correctly.
        let early = format!("kira sözleşmesi {}", heading.repeat(18));
        let snip = make_snippet(&early, "sözleşmesi", 20);
        assert!(snip.contains("sözleşmesi"), "got {snip:?}");
    }

    #[test]
    fn fts_match_expr_quotes_and_or_joins() {
        let expr = fts_match_expr(["lease", "rent"]).unwrap();
        assert_eq!(expr, "\"lease\" OR \"rent\"");
        // Empty input yields no query (caller falls back).
        assert!(fts_match_expr(std::iter::empty::<&str>()).is_none());
    }

    #[test]
    fn strips_markup_blocks() {
        let content = "Answer.\n\n```boxes\n{\"a\":1}\n```\n\n```annotation\n{\"b\":2}\n```";
        assert_eq!(strip_markup_blocks(content), "Answer.");
        assert_eq!(strip_markup_blocks("plain"), "plain");
    }

    #[test]
    fn pointed_hebrew_is_searchable_by_plain_query() {
        // The Bible bug: nikud'd text indexed under unicode61 shreds into
        // single-letter fragments, so "קהלת" never matched "קֹהֶלֶת". The
        // chunk layer now indexes consonantally.
        let conn = db::open_in_memory_schema();
        db::insert_file(
            &conn,
            "bible.pdf",
            "application/pdf",
            b"x",
            Some("דִּבְרֵי קֹהֶלֶת בֶּן־דָּוִד מֶלֶךְ בִּירוּשָׁלִָם׃"),
            "upload",
        )
        .unwrap();
        // A plain (unpointed) query finds the chunk…
        let (chunks, fallback) = retrieve_context(&conn, "קהלת", None).unwrap();
        assert!(!fallback, "plain Hebrew query must be a real match");
        assert_eq!(chunks[0].file_name, "bible.pdf");
        assert!(chunks[0].text.contains("קהלת"), "chunk stores consonantal text");
        // …and so does a POINTED query (marks stripped from the question too).
        let (chunks, fallback) = retrieve_context(&conn, "קֹהֶלֶת", None).unwrap();
        assert!(!fallback);
        assert_eq!(chunks[0].file_name, "bible.pdf");
    }

    /// REAL end-to-end search over a real PDF: exact app pipeline — extract →
    /// import → index → retrieve. Usage:
    ///   PR_PDF=~/Downloads/hebrew_bible.pdf PR_FIND=קהלת \
    ///   cargo test --lib real_pdf_search -- --ignored --nocapture
    #[test]
    #[ignore = "manual probe on a real PDF; set PR_PDF and PR_FIND"]
    fn real_pdf_search_probe() {
        let (Ok(path), Ok(term)) = (std::env::var("PR_PDF"), std::env::var("PR_FIND")) else {
            eprintln!("SKIP: set PR_PDF and PR_FIND");
            return;
        };
        let bytes = std::fs::read(&path).expect("readable file");
        let name = std::path::Path::new(&path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let text = crate::extraction::extract_text(&name, &bytes).expect("extraction");
        eprintln!("extracted {} chars", text.len());
        let conn = db::open_in_memory_schema();
        db::insert_file(&conn, &name, "application/pdf", b"x", Some(&text), "upload").unwrap();
        let n_chunks: i64 = conn
            .query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))
            .unwrap();
        eprintln!("indexed {n_chunks} chunks (cap {})", db::CHUNK_CAP);
        let (chunks, fallback) = retrieve_context(&conn, &term, None).unwrap();
        eprintln!("search \"{term}\": fallback={fallback}, {} chunks", chunks.len());
        for c in chunks.iter().take(3) {
            eprintln!("  [{}] {}", c.file_name, excerpt(&c.text, &term, 160));
        }
        assert!(!fallback, "\"{term}\" must be a real keyword match");
        assert!(
            chunks.iter().any(|c| c.text.contains(&term)),
            "a returned chunk must contain \"{term}\""
        );
    }

    #[test]
    fn blend_retrieves_synonym_by_vector() {
        // ADD-13: keyword search cannot connect "time off" to "vacation
        // schedule", but a vector pointing at the vacation chunk can.
        let conn = db::open_in_memory_schema();
        db::insert_file(
            &conn,
            "handbook.txt",
            "text/plain",
            b"x",
            Some("The office holiday party is on Friday."),
            "upload",
        )
        .unwrap();
        db::insert_file(
            &conn,
            "hr.txt",
            "text/plain",
            b"x",
            Some("Our vacation schedule lists everyone's paid time away."),
            "upload",
        )
        .unwrap();
        embed_chunks_by_keyword(&conn, "vacation");

        // Question shares no keyword with either file; its vector points at the
        // vacation chunk ([1,0]).
        let q = [1.0f32, 0.0];
        let (chunks, fallback) =
            retrieve_context(&conn, "how much unpaid absence", Some(&q)).unwrap();
        assert!(!fallback, "vector match must count as a real match");
        assert_eq!(chunks[0].file_name, "hr.txt");

        // Pure keyword path (no embedding) still works for a literal term.
        let (kw_chunks, kw_fallback) = retrieve_context(&conn, "holiday", None).unwrap();
        assert!(!kw_fallback);
        assert_eq!(kw_chunks[0].file_name, "handbook.txt");

        // No keyword hit and no embedding → clean fallback to recent content.
        let (_, generic_fallback) = retrieve_context(&conn, "xyzzy nothing", None).unwrap();
        assert!(generic_fallback);
    }

    /// Give every chunk in the room the vector at the same index, in order.
    fn embed_chunks_in_order(conn: &Connection, vectors: &[[f32; 3]]) {
        let missing = db::chunks_missing_embedding(conn, 1000).unwrap();
        assert_eq!(missing.len(), vectors.len(), "fixture: one vector per chunk");
        for ((id, _, _), v) in missing.iter().zip(vectors) {
            db::set_chunk_embedding(conn, id, &db::embedding_to_blob(v)).unwrap();
        }
    }

    /// An embedded room must still be able to say "nothing here matches that".
    ///
    /// Every positive cosine used to pool a chunk, and every chunk in a room
    /// has a positive cosine with almost every question — so once the backfill
    /// finished, `fallback` was unreachable and a nonsense question came back
    /// with the six least-unrelated chunks presented as the room's answer.
    #[test]
    fn a_question_the_room_cannot_answer_is_still_a_no_match_once_it_is_embedded() {
        let conn = db::open_in_memory_schema();
        db::insert_file(
            &conn,
            "hr.txt",
            "text/plain",
            b"x",
            Some("Our vacation schedule lists everyone's paid time away."),
            "upload",
        )
        .unwrap();
        db::insert_file(
            &conn,
            "lease.pdf",
            "application/pdf",
            b"x",
            Some("The tenant shall not keep pets on the premises."),
            "upload",
        )
        .unwrap();
        embed_chunks_in_order(&conn, &[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]);

        // Cosine 0.4 with both chunks — the band nomic-embed-text puts an
        // unanswerable question in (measured 0.32–0.49). No keyword overlap
        // either, so nothing at all in this room matches.
        let nothing = [0.4f32, 0.4, 0.824_621_1];
        let (chunks, fallback) =
            retrieve_context(&conn, "asdf qwerty", Some(&nothing)).unwrap();
        assert!(
            fallback,
            "an unanswerable question must not be dressed up as a match: got {} chunks",
            chunks.len()
        );

        // …and the floor must not be so high that a real match falls under it:
        // cosine 0.66 with hr.txt is what a genuine paraphrase scores.
        let real = [0.66f32, 0.4, 0.635_924_5];
        let (chunks, fallback) =
            retrieve_context(&conn, "how much unpaid absence", Some(&real)).unwrap();
        assert!(!fallback, "a genuine vector match is still a match");
        assert_eq!(chunks[0].file_name, "hr.txt");
    }

    /// #find asks for every match (`limit: None`). The vector pass hydrates its
    /// candidates with one SQL variable per rowid, and SQLite binds at most
    /// 32,766 — so past that many embedded chunks the command did not return a
    /// long list, it returned "too many SQL variables".
    #[test]
    fn an_unlimited_search_of_a_huge_embedded_room_answers_instead_of_erroring() {
        let conn = db::open_in_memory_schema();
        db::insert_file(&conn, "big.txt", "text/plain", b"x", Some("seed chunk"), "upload")
            .unwrap();
        let file_id: String = conn
            .query_row("SELECT id FROM files LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let blob = db::embedding_to_blob(&[1.0f32, 0.0, 0.0]);
        // One more than SQLite's variable limit, which is where it broke.
        const ROWS: usize = 32_800;
        conn.execute("BEGIN", []).unwrap();
        {
            let mut stmt = conn
                .prepare("INSERT INTO chunks (id, file_id, seq, text, embedding) VALUES (?1, ?2, ?3, ?4, ?5)")
                .unwrap();
            for i in 0..ROWS {
                stmt.execute(rusqlite::params![
                    format!("c{i}"),
                    &file_id,
                    i as i64,
                    format!("paragraph {i}"),
                    &blob
                ])
                .unwrap();
            }
        }
        conn.execute("COMMIT", []).unwrap();

        // No keyword hit (so every candidate has to be hydrated by the vector
        // pass), and a vector every chunk answers.
        let q = [1.0f32, 0.0, 0.0];
        let (chunks, fallback) =
            retrieve_context_limited(&conn, "asdf qwerty", Some(&q), &HashSet::new(), None)
                .unwrap();
        assert!(!fallback);
        assert!(!chunks.is_empty());
        assert!(
            chunks.len() <= MAX_VECTOR_CANDIDATES,
            "an unlimited search still has to fit one query: {} chunks",
            chunks.len()
        );
    }

    // ------------------------------------------------- the history hand-off
    //
    // What the model is given to work with. Measured 2026-07-28 on a
    // revision-tracking task (four values, each revised 1-3 times across a
    // ~104 KB conversation; score = fraction of the four CURRENT values still
    // present in the payload the model finally saw, n=4 paired):
    //
    //     hand-off 49,152 B ....... 0.56
    //     hand-off whole convo .... 1.00      +0.44, 4 wins / 0 losses
    //
    // The facts were amputated HERE, before the sidecar's compaction could
    // compress them. Nothing downstream can restore what this dropped.

    #[test]
    fn the_hand_off_is_the_whole_conversation_not_a_window_slice() {
        // It used to be derived from the engine's window (~49 KB local, ~6% of
        // a cloud CLI's). Every engine now gets the same thing, because the
        // sidecar compacts on every path rather than truncating again.
        let local = crate::commands::history_budget_bytes("qwen3.5:4b");
        let cloud = crate::commands::history_budget_bytes("claude-cli");
        let provider = crate::commands::history_budget_bytes("openrouter::x/y");
        assert_eq!(local, crate::commands::HISTORY_HANDOFF_MAX);
        assert_eq!(local, cloud);
        assert_eq!(local, provider);
        // And it is far above the pre-fix 12,000 that cost the model every fact.
        assert!(local > 12_000 * 10);
    }

    #[test]
    fn a_long_conversation_survives_the_hand_off_intact() {
        // ~104 KB, the size the experiment used. At the old 49,152 B budget
        // this lost more than half the turns; at the new one it loses none.
        let history: Vec<(String, String)> = (0..40)
            .flat_map(|i| {
                [
                    ("user".to_string(), format!("Q{i} {}", "x".repeat(1_300))),
                    ("assistant".to_string(), format!("A{i} {}", "y".repeat(1_300))),
                ]
            })
            .collect();
        let raw: usize = history.iter().map(|(_, c)| c.len()).sum();
        assert!(raw > 100_000, "fixture too small: {raw}");

        let kept = compact_history(history.clone(), crate::commands::history_budget_bytes("qwen3.5:4b"));
        assert_eq!(kept.len(), history.len(), "turns were dropped");
        // The OLDEST turn is the one truncation takes first, and the one a
        // revision-tracking question most often needs.
        assert!(kept[0].1.starts_with("Q0 "));

        let old_budget = 49_152;
        let starved = compact_history(history, old_budget);
        assert!(
            starved.len() < kept.len(),
            "the old budget kept everything too — the fixture proves nothing"
        );
    }

    #[test]
    fn the_hand_off_is_fitted_to_the_engine_that_has_to_read_it() {
        // The AGENT path can be engine-blind (the sidecar compacts what it
        // receives, on every engine). The HAND-OFF cannot: it flattens the rows
        // into one prompt for a one-shot gateway that nothing trims on a
        // `:cloud` model, an OpenRouter provider or a cloud CLI. Handing an
        // 8k-window engine 200 KB came back as an engine error or an empty
        // summary — from the button whose whole job is to make the
        // conversation smaller.
        let small = crate::commands::handoff_budget_bytes(8_192);
        assert!(small < 20_000, "an 8k window was handed {small} bytes");
        // A big window is still bounded by the years-old-room backstop.
        assert_eq!(
            crate::commands::handoff_budget_bytes(1_000_000),
            crate::commands::HISTORY_HANDOFF_MAX
        );
        // And it really does cut a long technical chat down to that size.
        let history: Vec<(String, String)> = (0..200)
            .map(|i| ("user".to_string(), format!("T{i} {}", "z".repeat(2_000))))
            .collect();
        let kept = compact_history(history, small);
        let bytes: usize = kept.iter().map(|(_, c)| c.len()).sum();
        assert!(bytes <= small, "{bytes} > {small}");
        assert!(kept.len() < 200, "nothing was dropped, so the fixture proves nothing");
    }

    #[test]
    fn the_backstop_still_bounds_a_years_old_room() {
        let history: Vec<(String, String)> = (0..400)
            .map(|i| ("user".to_string(), format!("T{i} {}", "z".repeat(2_000))))
            .collect();
        let kept = compact_history(history, crate::commands::history_budget_bytes(""));
        let bytes: usize = kept.iter().map(|(_, c)| c.len()).sum();
        assert!(bytes <= crate::commands::HISTORY_HANDOFF_MAX);
        assert!(!kept.is_empty());
    }
}



