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
    /// RRF damping constant; standard value.
    const RRF_K: f32 = 60.0;
    struct Cand {
        file_name: String,
        text: String,
        kw_rank: Option<usize>,
        vec_rank: Option<usize>,
    }
    let mut pool: HashMap<i64, Cand> = HashMap::new();

    // Keyword signal: chunks ranked best-first by bm25 → RRF rank.
    if let Some(expr) = fts_match_expr(question_terms(question).iter().map(String::as_str)) {
        let hits = db::search_chunks_fts_ranked(conn, &expr, RETRIEVE_CANDIDATES)?;
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
    if let Some(q) = question_embedding {
        let mut scored: Vec<(i64, f32)> = db::chunk_embedding_vectors(conn)?
            .into_iter()
            .filter_map(|(rowid, blob)| {
                db::blob_to_embedding(&blob).and_then(|emb| {
                    let cos = db::cosine_similarity(q, &emb);
                    (cos > 0.0).then_some((rowid, cos))
                })
            })
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(RETRIEVE_CANDIDATES);
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
        scored.truncate(MAX_CONTEXT_CHUNKS);
        // Every RRF-pooled chunk scores > 0; empty only when exclusion removed
        // all of them — the caller distinguishes that from a true no-match.
        return Ok((scored, false));
    }

    // Generic questions ("summarize this") match nothing; fall back to the
    // most recently added content so the model still sees the room.
    let scored = db::recent_chunks(conn, MAX_CONTEXT_CHUNKS)?
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
    let normalized: String = haystack.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = normalized.to_lowercase();
    let find = |n: &str| {
        let n = n.trim().to_lowercase();
        if n.is_empty() {
            None
        } else {
            lower.find(&n)
        }
    };
    let chars: Vec<char> = normalized.chars().collect();
    // No match to center on: return a clipped preview from the start.
    let Some(byte) = find(needle).or_else(|| needle.split_whitespace().find_map(find)) else {
        let mut out: String = chars.iter().take(radius * 2).collect();
        if chars.len() > radius * 2 {
            out.push('…');
        }
        return out;
    };
    let char_pos = lower[..byte].chars().count();
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
/// last paragraph boundary before the limit with an explicit omitted-marker,
/// so the model never sees a silently unterminated prior turn. Char-safe.
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
        let end = content[..cut].rfind("\n\n").unwrap_or(cut);
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
        let cost = m.len() + 3; // "- " + "\n"
        if used + cost > budget {
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

}
