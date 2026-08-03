use super::*;

// ---- D3: room graph ---------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub name: String,
    pub folder: Option<String>,
    /// "file" | "memory"
    pub kind: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub a: String,
    pub b: String,
    /// Link strength on one shared 0..1 scale (see `link_strength`), NOT the raw
    /// similarity — the signals below are measured differently.
    pub weight: f32,
    /// WHICH relationship this is — one of [`EDGE_KINDS`]. The first five are
    /// facts the room can prove from what it stored; only `similar` is inferred.
    pub kind: String,
    /// True when the relation has a direction: `a` → `b` (a was made from… no,
    /// `a` is the SOURCE and `b` the thing it produced or that names it).
    pub directed: bool,
    /// Up to 3 short strings of evidence for the link (shared terms, the host,
    /// how many answers cited the pair). Empty when the kind alone says it all.
    pub shared: Vec<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoomGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// `b` was generated FROM `a` — the room watched it happen (`files.derived_from`).
pub(crate) const EDGE_DERIVED: &str = "derived";
/// Both files were saved from the SAME URL (the browser's md+html twin, a re-save).
pub(crate) const EDGE_SAME_PAGE: &str = "same_page";
/// Both files came off the same host.
pub(crate) const EDGE_SAME_SITE: &str = "same_site";
/// `a`'s text contains `b`'s name — one document naming another.
pub(crate) const EDGE_MENTIONS: &str = "mentions";
/// One answer used both files as its sources.
pub(crate) const EDGE_CITED: &str = "cited";
/// The only INFERRED relation: the two read alike. Everything above is a fact.
pub(crate) const EDGE_SIMILAR: &str = "similar";

/// Every edge kind the builder can emit, most-trusted first. The order IS the
/// trust order: when two relations hold for one pair only the first is drawn,
/// because "made from" tells the reader strictly more than "reads alike".
pub(crate) const EDGE_KINDS: &[&str] = &[
    EDGE_DERIVED,
    EDGE_SAME_PAGE,
    EDGE_MENTIONS,
    EDGE_CITED,
    EDGE_SAME_SITE,
    EDGE_SIMILAR,
];

fn edge_rank(kind: &str) -> usize {
    EDGE_KINDS.iter().position(|k| *k == kind).unwrap_or(EDGE_KINDS.len())
}

/// Cap the file set so the O(n²) pairing stays cheap on a very large room.
pub(crate) const GRAPH_MAX_FILES: usize = 60;
/// How many neighbours each file may PROPOSE for the inferred `similar`
/// relation. Rank-based, not a similarity cutoff: the old code kept every pair
/// over an absolute cosine of 0.55, and because mean-pooled document vectors in
/// one room all sit well above that, 19 files produced 163 of the 171 possible
/// links — a picture that says nothing. A per-file top-K is invariant to that
/// compression. Union (an edge lives if EITHER end ranks it) rather than mutual,
/// which would strand every file whose nearest neighbour is a hub.
pub(crate) const GRAPH_SIM_TOP_K: usize = 3;
/// Whole-map budget for `similar`, per FILE node (memories propose none). Facts
/// are not counted against it.
pub(crate) const GRAPH_SIM_MAX_PER_NODE: usize = 3;
/// Sanity floor on the raw cosine of two mean chunk embeddings. Rank alone would
/// link the three files of a three-file room no matter how unrelated they are;
/// this is what keeps an unrelated file unconnected.
pub(crate) const GRAPH_VEC_FLOOR: f32 = 0.45;
/// The same floor for the TF-IDF cosine used while a file has no embeddings.
/// Much lower because the two are different measurements — `link_strength` is
/// what puts them on one scale.
pub(crate) const GRAPH_KW_FLOOR: f32 = 0.08;
/// Weight a link that only just clears its own floor is drawn at, so the
/// weakest surviving edge is still visible instead of a 0-width hairline.
pub(crate) const GRAPH_WEIGHT_MIN: f32 = 0.3;
/// How many files may be linked as naming one given file. `mentions` is a fact,
/// but an UNBOUNDED fact is still a hairball, so it gets a budget like `similar`.
pub(crate) const GRAPH_MENTION_TOP: usize = 2;
/// A name is only searched for if its rarest word appears in at most this share
/// of the room's files. This is what stops "Notes.md" or "Report.md" linking to
/// everything — mechanically, from the room's own word statistics, instead of
/// from a hand-written list of nouns that would always be missing one.
pub(crate) const GRAPH_MENTION_DF_RATIO: f32 = 0.15;
/// Shortest file-name stem worth searching for at all.
pub(crate) const GRAPH_MENTION_MIN_STEM: usize = 6;
/// Biggest same-host group that still earns `same_site` links. Past this a
/// domain is a scrape, not a relationship.
pub(crate) const GRAPH_SITE_GROUP_MAX: usize = 8;
/// An answer citing more than this many files is doing research, not relating
/// two documents — linking all its pairs would clique the map.
pub(crate) const GRAPH_CITED_MAX_SOURCES: usize = 4;
/// How many `cited` partners one file may keep, most-cited first. `cited` is a
/// fact, but — like `mentions` — an UNBOUNDED fact is still a hairball: pairs
/// accumulate over every answer the room has ever given, so a well-used room
/// eventually cites every file alongside every other and the map goes back to
/// being a complete graph. Measured: 20 files and one two-source answer per
/// pair produced all 190 links, and because facts are exempt from the viewer's
/// edge cap nothing downstream would have thinned them.
pub(crate) const GRAPH_CITED_TOP: usize = 3;
/// Distinct terms kept per file for the TF-IDF signal.
pub(crate) const GRAPH_TFIDF_TERMS: usize = 40;

pub(crate) struct GraphFile {
    id: String,
    name: String,
    folder: Option<String>,
    origin_url: Option<String>,
    mean: Option<Vec<f32>>,
    /// L2-normalised TF-IDF weights over the file's most distinctive terms.
    tfidf: HashMap<String, f32>,
}

/// Put a raw similarity on the ONE 0..1 scale the map draws, ranks and caps by:
/// each signal's own floor maps to `GRAPH_WEIGHT_MIN`, a perfect match to 1.0.
/// Cosine and TF-IDF cosine are different measurements — a 0.1 term overlap is
/// about as strong a keyword link as a room ever produces, while a 0.1 cosine
/// is noise — so sending both raw drew every keyword edge as a near-invisible
/// hairline, labelled it "10% similar", and made it the first edge dropped when
/// the viewer's edge cap bit.
pub(crate) fn link_strength(raw: f32, floor: f32) -> f32 {
    if floor >= 1.0 {
        return raw.clamp(0.0, 1.0);
    }
    let above = ((raw - floor) / (1.0 - floor)).clamp(0.0, 1.0);
    GRAPH_WEIGHT_MIN + above * (1.0 - GRAPH_WEIGHT_MIN)
}

/// The distinctive words of a piece of text, for the TF-IDF keyword signal.
/// Deliberately NOT `question_terms`: that stops at 24 terms, so over a file it
/// returns the first two dozen words of the first chunk — positional, not
/// distinctive, which is why the "why are these linked" tooltip used to read
/// like the opening line of the document.
pub(crate) fn index_terms(text: &str) -> Vec<String> {
    let text = extraction::strip_hebrew_marks(text);
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3 && !STOPWORDS.contains(w))
        .map(|w| w.to_string())
        .collect()
}

/// Cosine of two L2-normalised sparse TF-IDF vectors.
pub(crate) fn tfidf_cosine(a: &HashMap<String, f32>, b: &HashMap<String, f32>) -> f32 {
    let (small, big) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    small.iter().filter_map(|(t, w)| big.get(t).map(|w2| w * w2)).sum::<f32>().clamp(0.0, 1.0)
}

/// The terms carrying the most of two files' shared TF-IDF mass — the honest
/// "why are these two linked" line.
pub(crate) fn top_shared_terms(
    a: &HashMap<String, f32>,
    b: &HashMap<String, f32>,
    max: usize,
) -> Vec<String> {
    let mut hits: Vec<(&String, f32)> = a
        .iter()
        .filter_map(|(t, w)| b.get(t).map(|w2| (t, w * w2)))
        .collect();
    // Ties broken by term so the same room always produces the same reasons.
    hits.sort_by(|x, y| y.1.total_cmp(&x.1).then_with(|| x.0.cmp(y.0)));
    hits.into_iter().take(max).map(|(t, _)| t.clone()).collect()
}

/// A file name's searchable stem: extension dropped, and the " (2)" suffix
/// `db::available_name` adds to a re-run stripped, so the second run of a
/// studio still matches the text that names the first.
pub(crate) fn name_stem(name: &str) -> String {
    let stem = match name.rsplit_once('.') {
        Some((s, _)) if !s.is_empty() => s,
        _ => name,
    };
    let trimmed = stem.trim_end();
    if let Some(open) = trimmed.strip_suffix(')').and_then(|s| s.rfind(" (")) {
        let inner = &trimmed[open + 2..trimmed.len() - 1];
        if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
            return trimmed[..open].trim().to_string();
        }
    }
    trimmed.to_string()
}

/// Median, and median absolute deviation, of a score list. The `similar`
/// relation's per-file bar is built from these rather than from a constant:
/// a room's own similarity scale is the only thing a cutoff can honestly be
/// measured against.
fn median(sorted_desc: &[f32]) -> f32 {
    let n = sorted_desc.len();
    if n == 0 {
        return 0.0;
    }
    if n % 2 == 1 {
        sorted_desc[n / 2]
    } else {
        (sorted_desc[n / 2 - 1] + sorted_desc[n / 2]) / 2.0
    }
}

/// The bar a file's own candidates must clear, from that file's own score
/// spread. Returns `-inf` (i.e. no bar, leaving top-K and the absolute floor to
/// do the work) when there are too few candidates for a spread to mean
/// anything — at n=2 a median-based cutoff would reject the only pair a
/// two-file room can have, every time.
fn adaptive_floor(sorted_desc: &[f32]) -> f32 {
    if sorted_desc.len() < 4 {
        return f32::NEG_INFINITY;
    }
    let med = median(sorted_desc);
    let mut devs: Vec<f32> = sorted_desc.iter().map(|s| (s - med).abs()).collect();
    devs.sort_by(|a, b| b.total_cmp(a));
    med + median(&devs)
}

/// Unordered key for a pair of node ids, so the same relation found twice is
/// one edge.
fn pair_key(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

/// Collects at most one edge per pair, keeping the most-trusted kind (then the
/// strongest). Two files that are BOTH a full pass of each other and word-alike
/// should read as "made from", not as two lines on top of each other.
#[derive(Default)]
struct EdgeSet {
    by_pair: HashMap<(String, String), GraphEdge>,
}

impl EdgeSet {
    fn offer(&mut self, e: GraphEdge) {
        if e.a == e.b {
            return;
        }
        let key = pair_key(&e.a, &e.b);
        match self.by_pair.get(&key) {
            Some(cur)
                if (edge_rank(&cur.kind), -cur.weight) <= (edge_rank(&e.kind), -e.weight) => {}
            _ => {
                self.by_pair.insert(key, e);
            }
        }
    }

    fn contains(&self, a: &str, b: &str) -> bool {
        self.by_pair.contains_key(&pair_key(a, b))
    }

    /// Most-trusted first, then strongest — a stable order so an unchanged room
    /// produces a byte-identical payload and the viewer never re-lays-out for
    /// nothing.
    fn into_sorted(self) -> Vec<GraphEdge> {
        let mut out: Vec<GraphEdge> = self.by_pair.into_values().collect();
        out.sort_by(|x, y| {
            edge_rank(&x.kind)
                .cmp(&edge_rank(&y.kind))
                .then_with(|| y.weight.total_cmp(&x.weight))
                .then_with(|| x.a.cmp(&y.a))
                .then_with(|| x.b.cmp(&y.b))
        });
        out
    }
}

/// The host of a URL with a leading `www.` dropped, or None when it doesn't
/// parse. `reqwest::Url` is the in-repo URL parser (browser.rs) — no new crate.
fn site_of(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_lowercase();
    Some(host.trim_start_matches("www.").to_string())
}

/// Link every member of a same-origin group to its newest member (`group` is
/// newest-first). A star, not a clique: eight pages off one host is 7 honest
/// links, where all-pairs would be 28 and would swamp everything else on the map.
fn star_links(group: &[usize], files: &[GraphFile], kind: &str, weight: f32, why: Vec<String>) -> Vec<GraphEdge> {
    let Some((&hub, rest)) = group.split_first() else {
        return Vec::new();
    };
    rest.iter()
        .map(|&i| GraphEdge {
            a: files[hub].id.clone(),
            b: files[i].id.clone(),
            weight,
            kind: kind.to_string(),
            directed: false,
            shared: why.clone(),
        })
        .collect()
}

/// D3: build the room's typed link graph from stored data ONLY — no model call.
///
/// Six relations, five of which the room can PROVE (provenance, a shared source
/// URL, one document naming another, two documents cited by one answer) and one
/// inferred (`similar`). The inferred one is the only one that is thresholded,
/// and it is bounded by rank rather than by an absolute similarity, because a
/// single global cutoff over mean-pooled document vectors admits every pair in
/// the room. Nothing here invents a relation to make the picture look connected:
/// a file the room knows nothing about stays a lone star.
///
/// Pure over the connection → unit-testable with an in-memory room.
pub(crate) fn build_room_graph(conn: &Connection) -> Result<RoomGraph, String> {
    // Folder id → name, so nodes carry a human folder label.
    let folders: HashMap<String, String> =
        db::list_folders(conn)?.into_iter().map(|f| (f.id, f.name)).collect();

    // Newest files first; cap for the pairwise pass. Skip the app's own summary.
    let metas: Vec<FileMeta> = db::list_files(conn)?
        .into_iter()
        .filter(|f| !is_summary_file(&f.name, &f.source))
        .take(GRAPH_MAX_FILES)
        .collect();

    // One pass over chunks: a summed embedding + a term-frequency map per file.
    struct Acc {
        sum: Vec<f32>,
        n: usize,
        tf: HashMap<String, u32>,
    }
    let mut acc: HashMap<String, Acc> = HashMap::new();
    if !metas.is_empty() {
        // ONLY the files the map will draw. Reading every chunk in the room and
        // discarding all but these afterwards made the map's open time scale
        // with the whole room instead of with the 60 nodes on it.
        let placeholders = vec!["?"; metas.len()].join(",");
        let mut stmt = conn
            .prepare(&format!(
                "SELECT file_id, embedding, text FROM chunks WHERE file_id IN ({placeholders})"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(metas.iter().map(|m| m.id.as_str())), |r| {
                let file_id: String = r.get(0)?;
                let emb: Option<Vec<u8>> = r.get(1)?;
                let text: String = r.get(2)?;
                Ok((file_id, emb, text))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (file_id, emb, text) = row.map_err(|e| e.to_string())?;
            let entry = acc.entry(file_id).or_insert_with(|| Acc {
                sum: Vec::new(),
                n: 0,
                tf: HashMap::new(),
            });
            if let Some(vec) = emb.as_deref().and_then(db::blob_to_embedding) {
                if entry.sum.is_empty() {
                    entry.sum = vec;
                    entry.n += 1;
                } else if entry.sum.len() == vec.len() {
                    for (s, v) in entry.sum.iter_mut().zip(vec.iter()) {
                        *s += *v;
                    }
                    entry.n += 1;
                }
            }
            for term in index_terms(&text) {
                // A book's vocabulary is bounded in practice; the cap is only
                // here so a pathological file can't grow this map without end.
                if entry.tf.len() < 20_000 || entry.tf.contains_key(&term) {
                    *entry.tf.entry(term).or_insert(0) += 1;
                }
            }
        }
    }

    // Document frequency over the mapped files — the room's own word statistics.
    // Used twice: to weight the TF-IDF vectors, and to decide whether a file's
    // NAME is distinctive enough to be worth searching the room's text for.
    let n_docs = metas.len().max(1) as f32;
    let mut df: HashMap<&str, u32> = HashMap::new();
    for a in acc.values() {
        for term in a.tf.keys() {
            *df.entry(term.as_str()).or_insert(0) += 1;
        }
    }

    // Per-file records: mean embedding (if any) + a normalised TF-IDF vector.
    let files: Vec<GraphFile> = metas
        .iter()
        .map(|m| {
            let a = acc.get(&m.id);
            let mean = a.and_then(|a| {
                (a.n > 0 && !a.sum.is_empty())
                    .then(|| a.sum.iter().map(|x| *x / a.n as f32).collect::<Vec<f32>>())
            });
            let mut weighted: Vec<(String, f32)> = a
                .map(|a| {
                    a.tf.iter()
                        .map(|(t, &tf)| {
                            let idf = (n_docs / *df.get(t.as_str()).unwrap_or(&1) as f32).ln() + 1.0;
                            (t.clone(), (1.0 + (tf as f32).ln()) * idf)
                        })
                        .collect()
                })
                .unwrap_or_default();
            weighted.sort_by(|x, y| y.1.total_cmp(&x.1).then_with(|| x.0.cmp(&y.0)));
            weighted.truncate(GRAPH_TFIDF_TERMS);
            let norm = weighted.iter().map(|(_, w)| w * w).sum::<f32>().sqrt();
            let tfidf: HashMap<String, f32> = if norm > 0.0 {
                weighted.into_iter().map(|(t, w)| (t, w / norm)).collect()
            } else {
                HashMap::new()
            };
            GraphFile {
                id: m.id.clone(),
                name: m.name.clone(),
                folder: m.folder_id.as_ref().and_then(|fid| folders.get(fid).cloned()),
                origin_url: m.origin_url.clone(),
                mean,
                tfidf,
            }
        })
        .collect();

    let index_of: HashMap<&str, usize> =
        files.iter().enumerate().map(|(i, f)| (f.id.as_str(), i)).collect();

    // Nodes: files (with folder) then memories.
    let memories = db::list_memories(conn)?;
    let mut nodes: Vec<GraphNode> = files
        .iter()
        .map(|f| GraphNode {
            id: f.id.clone(),
            name: f.name.clone(),
            folder: f.folder.clone(),
            kind: "file".into(),
        })
        .collect();
    for m in memories.iter().take(GRAPH_MAX_FILES) {
        nodes.push(GraphNode {
            id: format!("mem:{}", m.id),
            name: clamp_words(&m.content, 60),
            folder: None,
            kind: "memory".into(),
        });
    }

    let mut edges = EdgeSet::default();

    // ---- 1. `derived`: the room watched this file being made from that one ----
    for (src, out) in db::derived_links(conn)? {
        if index_of.contains_key(src.as_str()) && index_of.contains_key(out.as_str()) {
            edges.offer(GraphEdge {
                a: src,
                b: out,
                weight: 1.0,
                kind: EDGE_DERIVED.into(),
                directed: true,
                shared: Vec::new(),
            });
        }
    }

    // ---- 2. `same_page` / `same_site`: a shared web origin ----
    // Exact-URL groups first (the browser saves a page as an .md and an .html
    // sharing one origin_url — the twin every reader expects to see joined).
    let mut by_url: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut by_site: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, f) in files.iter().enumerate() {
        let Some(url) = f.origin_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) else {
            continue;
        };
        by_url.entry(url).or_default().push(i);
        if let Some(site) = site_of(url) {
            by_site.entry(site).or_default().push(i);
        }
    }
    let mut url_keys: Vec<&&str> = by_url.keys().collect();
    url_keys.sort();
    for url in url_keys {
        let group = &by_url[*url];
        if group.len() < 2 {
            continue;
        }
        for e in star_links(group, &files, EDGE_SAME_PAGE, 1.0, vec![(*url).to_string()]) {
            edges.offer(e);
        }
    }
    let mut site_keys: Vec<&String> = by_site.keys().collect();
    site_keys.sort();
    for site in site_keys {
        let group = &by_site[site];
        // Past the cap a host is a scrape, and linking it says nothing about
        // any two of its pages. Nothing is drawn rather than something false.
        if group.len() < 2 || group.len() > GRAPH_SITE_GROUP_MAX {
            continue;
        }
        for e in star_links(group, &files, EDGE_SAME_SITE, 0.45, vec![site.clone()]) {
            edges.offer(e);
        }
    }

    // ---- 3. `mentions`: one document names another ----
    // Bounded three ways — a name must be long enough, its rarest word must be
    // rare in THIS room, and only the best few matches per name are kept. An
    // unbounded "fact" is still a hairball: "Notes.md" matched as a bare word
    // would link to every file that happens to say "noted".
    let df_cap = ((n_docs * GRAPH_MENTION_DF_RATIO).round() as u32).max(1);
    let is_distinctive = |tokens: &[String]| -> bool {
        !tokens.is_empty()
            && tokens.iter().map(|t| *df.get(t.as_str()).unwrap_or(&0)).min().unwrap_or(0) <= df_cap
    };
    for f in &files {
        let stem = name_stem(&f.name);
        if stem.chars().count() < GRAPH_MENTION_MIN_STEM {
            continue;
        }
        let tokens = index_terms(&stem);
        if !is_distinctive(&tokens) {
            continue;
        }
        // ONE quoted item, which FTS5 reads as a phrase. Passing the stem's
        // words separately would OR them and match anything.
        let Some(expr) = fts_match_expr([stem.to_lowercase().as_str()]) else {
            continue;
        };
        for hit in db::fts_file_matches(conn, &expr, &f.id, GRAPH_MENTION_TOP)? {
            if index_of.contains_key(hit.as_str()) {
                edges.offer(GraphEdge {
                    a: hit,
                    b: f.id.clone(),
                    weight: 0.8,
                    kind: EDGE_MENTIONS.into(),
                    directed: true,
                    shared: vec![stem.clone()],
                });
            }
        }
    }
    // Memories were decorative before this: nodes with no edge, ever. A memory
    // whose distinctive words appear in a file is a real, checkable relation —
    // and one with no distinctive word stays unlinked rather than being attached
    // to whatever it loosely resembles.
    for m in memories.iter().take(GRAPH_MAX_FILES) {
        let mut terms: Vec<String> = index_terms(&m.content);
        terms.sort();
        terms.dedup();
        terms.retain(|t| matches!(df.get(t.as_str()), Some(&d) if d >= 1 && d <= df_cap));
        terms.sort_by_key(|t| (*df.get(t.as_str()).unwrap_or(&0), t.clone()));
        terms.truncate(2);
        if terms.is_empty() {
            continue;
        }
        // AND, not OR: the memory has to share ALL of its rare words with the
        // file, or a one-line memory links to half the room.
        let expr = terms
            .iter()
            .map(|t| format!("\"{}\"", t.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" AND ");
        for hit in db::fts_file_matches(conn, &expr, "", GRAPH_MENTION_TOP)? {
            if index_of.contains_key(hit.as_str()) {
                edges.offer(GraphEdge {
                    a: format!("mem:{}", m.id),
                    b: hit,
                    weight: 0.6,
                    kind: EDGE_MENTIONS.into(),
                    directed: true,
                    shared: terms.clone(),
                });
            }
        }
    }

    // ---- 4. `cited`: one answer used both files ----
    // `messages.sources` holds file NAMES, so an unresolved name is dropped, not
    // guessed at: a rename, or a second run `available_name` bumped to "X (2)",
    // silently ends the link. That lossiness is the argument for storing ids.
    let by_name: HashMap<&str, &str> = {
        let mut m: HashMap<&str, &str> = HashMap::new();
        for f in &files {
            m.entry(f.name.as_str()).or_insert(f.id.as_str());
        }
        m
    };
    let mut cite_counts: HashMap<(String, String), u32> = HashMap::new();
    for sources in db::recent_message_sources(conn, 500)? {
        let mut ids: Vec<&str> =
            sources.iter().filter_map(|n| by_name.get(n.as_str()).copied()).collect();
        ids.sort();
        ids.dedup();
        if ids.len() < 2 || ids.len() > GRAPH_CITED_MAX_SOURCES {
            continue;
        }
        for i in 0..ids.len() {
            for j in (i + 1)..ids.len() {
                *cite_counts.entry(pair_key(ids[i], ids[j])).or_insert(0) += 1;
            }
        }
    }
    // Union top-K per file, by how often the pair was cited: the same rank-based
    // bound `similar` and `mentions` get, for the same reason. A pair one answer
    // happened to touch is the weakest thing this relation can mean; a pair five
    // answers kept reaching for together is the thing worth drawing.
    let mut partners: HashMap<&str, Vec<(&str, u32)>> = HashMap::new();
    for ((a, b), count) in &cite_counts {
        partners.entry(a.as_str()).or_default().push((b.as_str(), *count));
        partners.entry(b.as_str()).or_default().push((a.as_str(), *count));
    }
    let mut kept: HashSet<(String, String)> = HashSet::new();
    let mut owners: Vec<&&str> = partners.keys().collect();
    owners.sort();
    for owner in owners {
        let mut list = partners[*owner].clone();
        // Ties by partner id, never by hash order — the payload has to be
        // byte-identical for an unchanged room or the viewer re-lays-out.
        list.sort_by(|x, y| y.1.cmp(&x.1).then_with(|| x.0.cmp(y.0)));
        for (other, _) in list.into_iter().take(GRAPH_CITED_TOP) {
            kept.insert(pair_key(owner, other));
        }
    }
    for ((a, b), count) in cite_counts {
        if !kept.contains(&pair_key(&a, &b)) {
            continue;
        }
        edges.offer(GraphEdge {
            a,
            b,
            weight: (0.5 + 0.15 * (count as f32).ln_1p()).min(0.9),
            kind: EDGE_CITED.into(),
            directed: false,
            shared: vec![format!(
                "cited together in {count} answer{}",
                if count == 1 { "" } else { "s" }
            )],
        });
    }

    // ---- 5. `similar`: the one inferred relation, rank-bounded ----
    // Score every pair once. A pair where both ends have embeddings is scored by
    // cosine; otherwise by TF-IDF overlap, so a freshly-imported room still
    // shows links instead of isolated dots while the backfill runs.
    let n = files.len();
    let mut scores: HashMap<(usize, usize), (f32, bool)> = HashMap::new();
    for i in 0..n {
        for j in (i + 1)..n {
            let entry = match (&files[i].mean, &files[j].mean) {
                (Some(a), Some(b)) => (db::cosine_similarity(a, b), true),
                _ => (tfidf_cosine(&files[i].tfidf, &files[j].tfidf), false),
            };
            scores.insert((i, j), entry);
        }
    }
    let score_of = |i: usize, j: usize| -> (f32, bool) {
        let key = if i < j { (i, j) } else { (j, i) };
        *scores.get(&key).unwrap_or(&(0.0, false))
    };
    let floor_for = |vector: bool| if vector { GRAPH_VEC_FLOOR } else { GRAPH_KW_FLOOR };

    // Each file proposes its own top-K, per signal (a room mid-backfill has
    // both). An edge survives if EITHER end proposed it.
    let mut proposed: HashSet<(usize, usize)> = HashSet::new();
    for i in 0..n {
        for vector in [true, false] {
            let mut cands: Vec<(usize, f32)> = (0..n)
                .filter(|&j| j != i)
                .map(|j| (j, score_of(i, j)))
                .filter(|(_, (raw, is_vec))| *is_vec == vector && *raw >= floor_for(vector))
                .map(|(j, (raw, _))| (j, raw))
                .collect();
            if cands.is_empty() {
                continue;
            }
            // Deterministic: ties resolved by index, never by hash order.
            cands.sort_by(|x, y| y.1.total_cmp(&x.1).then_with(|| x.0.cmp(&y.0)));
            let sorted: Vec<f32> = cands.iter().map(|c| c.1).collect();
            let bar = adaptive_floor(&sorted);
            for (j, raw) in cands.into_iter().take(GRAPH_SIM_TOP_K) {
                if raw >= bar {
                    proposed.insert(if i < j { (i, j) } else { (j, i) });
                }
            }
        }
    }
    let mut sim: Vec<(usize, usize, f32, bool)> = proposed
        .into_iter()
        .map(|(i, j)| {
            let (raw, is_vec) = score_of(i, j);
            (i, j, raw, is_vec)
        })
        .collect();
    sim.sort_by(|x, y| y.2.total_cmp(&x.2).then_with(|| (x.0, x.1).cmp(&(y.0, y.1))));
    sim.truncate(n * GRAPH_SIM_MAX_PER_NODE);
    for (i, j, raw, is_vec) in sim {
        edges.offer(GraphEdge {
            a: files[i].id.clone(),
            b: files[j].id.clone(),
            weight: link_strength(raw, floor_for(is_vec)),
            kind: EDGE_SIMILAR.into(),
            directed: false,
            shared: top_shared_terms(&files[i].tfidf, &files[j].tfidf, 3),
        });
    }

    // ---- 6. rescue the isolates ----
    // Sparsifying by rank can leave a file with no edge at all even though it
    // has a decent partner — the classic over-correction from hairball to field
    // of dots. Give each isolate its single best partner, and ONLY if that
    // partner clears the same absolute floor every other link had to: a file the
    // room has nothing to say about stays a lone star, which is the truth.
    let isolated: Vec<usize> =
        (0..n).filter(|&i| !(0..n).any(|j| j != i && edges.contains(&files[i].id, &files[j].id))).collect();
    for i in isolated {
        let best = (0..n)
            .filter(|&j| j != i)
            .map(|j| (j, score_of(i, j)))
            .filter(|(_, (raw, is_vec))| *raw >= floor_for(*is_vec))
            .max_by(|x, y| x.1 .0.total_cmp(&y.1 .0).then_with(|| y.0.cmp(&x.0)));
        if let Some((j, (raw, is_vec))) = best {
            edges.offer(GraphEdge {
                a: files[i].id.clone(),
                b: files[j].id.clone(),
                weight: link_strength(raw, floor_for(is_vec)),
                kind: EDGE_SIMILAR.into(),
                directed: false,
                shared: top_shared_terms(&files[i].tfidf, &files[j].tfidf, 3),
            });
        }
    }

    Ok(RoomGraph { nodes, edges: edges.into_sorted() })
}

/// D3: the room's link graph for the RoomMap viewer. Empty when no room is
/// open (never an error the UI has to special-case).
#[tauri::command]
pub fn room_graph(state: State<'_, AppState>) -> Result<RoomGraph, String> {
    let guard = state.room.lock().unwrap();
    let Some(room) = guard.as_ref() else {
        return Ok(RoomGraph::default());
    };
    build_room_graph(&room.conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add(conn: &Connection, name: &str, text: &str) -> String {
        db::insert_file(conn, name, "text/plain", b"x", Some(text), "upload").unwrap().id
    }

    fn kinds(g: &RoomGraph, kind: &str) -> Vec<(String, String)> {
        g.edges
            .iter()
            .filter(|e| e.kind == kind)
            .map(|e| (e.a.clone(), e.b.clone()))
            .collect()
    }

    #[test]
    fn keyword_and_vector_links_share_one_strength_scale() {
        // A link that only just clears its own bar reads the same either way…
        assert!((link_strength(GRAPH_KW_FLOOR, GRAPH_KW_FLOOR) - GRAPH_WEIGHT_MIN).abs() < 1e-6);
        assert!((link_strength(GRAPH_VEC_FLOOR, GRAPH_VEC_FLOOR) - GRAPH_WEIGHT_MIN).abs() < 1e-6);
        // …and a perfect match is 1.0 on both.
        assert!((link_strength(1.0, GRAPH_KW_FLOOR) - 1.0).abs() < 1e-6);
        assert!((link_strength(1.0, GRAPH_VEC_FLOOR) - 1.0).abs() < 1e-6);
        // A strong term overlap outranks a barely-there cosine, instead of being
        // drawn as a hairline and dropped first at the edge cap.
        assert!(link_strength(0.5, GRAPH_KW_FLOOR) > link_strength(0.46, GRAPH_VEC_FLOOR));
        // Nothing below its own floor ever reaches the drawable band.
        assert!((link_strength(0.0, GRAPH_VEC_FLOOR) - GRAPH_WEIGHT_MIN).abs() < 1e-6);
    }

    #[test]
    fn tfidf_prefers_distinctive_words_over_the_first_ones() {
        // The old keyword signal was Jaccard over `question_terms`, which stops
        // at the first 24 words — so the "why linked" reason was the opening
        // line of the file. TF-IDF ranks by how rare a word is in THIS room.
        let conn = db::open_in_memory_schema();
        // 26 words every file shares, then the one word that actually
        // distinguishes two of them — placed LAST, past the 24-term ceiling the
        // old `question_terms` signal stopped at, so it could never be a reason.
        let filler = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima \
                      mike november oscar papa quebec romeo sierra tango uniform victor whiskey \
                      xray yankee zulu";
        let a = add(&conn, "a.txt", &format!("{filler} kryptonite"));
        let b = add(&conn, "b.txt", &format!("{filler} kryptonite"));
        add(&conn, "c.txt", &format!("{filler} paperwork"));
        let g = build_room_graph(&conn).unwrap();
        let ab = g
            .edges
            .iter()
            .find(|e| pair_key(&e.a, &e.b) == pair_key(&a, &b))
            .expect("the two kryptonite files link");
        assert_eq!(ab.kind, EDGE_SIMILAR);
        assert_eq!(
            ab.shared.first().map(String::as_str),
            Some("kryptonite"),
            "the reason names the rare word, not the one every file shares"
        );
    }

    #[test]
    fn name_stem_drops_the_extension_and_the_rerun_suffix() {
        assert_eq!(name_stem("Flashcards - clean-code.html"), "Flashcards - clean-code");
        // db::available_name bumps a re-run to "X (2)" — the map must still see
        // the same name in the text that talks about the first run.
        assert_eq!(name_stem("Flashcards - clean-code (2).html"), "Flashcards - clean-code");
        assert_eq!(name_stem("noext"), "noext");
        assert_eq!(name_stem("budget (draft).md"), "budget (draft)", "only digits are a re-run");
    }

    #[test]
    fn an_absolute_similarity_threshold_no_longer_cliques_the_map() {
        // THE regression this change exists to prevent. 20 files that all clear
        // the old 0.55 cosine used to produce C(20,2) = 190 edges — a complete
        // graph, which tells the reader nothing. Rank-based selection bounds it
        // to a readable average degree whatever the room's similarity scale is.
        let conn = db::open_in_memory_schema();
        let mut ids = Vec::new();
        for i in 0..20 {
            ids.push(add(&conn, &format!("f{i}.txt"), "vacation summer holiday plans"));
        }
        // Every chunk gets the SAME vector, so every pair scores cosine 1.0.
        embed_chunks_by_keyword(&conn, "vacation");
        let g = build_room_graph(&conn).unwrap();
        assert_eq!(g.nodes.iter().filter(|n| n.kind == "file").count(), 20);
        let sim = kinds(&g, EDGE_SIMILAR).len();
        assert!(sim <= 20 * GRAPH_SIM_MAX_PER_NODE, "{sim} similar edges is a hairball");
        assert!(sim >= 10, "an all-alike room must still read as connected, got {sim}");
        assert!(g.edges.len() < 190 / 2, "the complete graph must be gone");
        assert_eq!(ids.len(), 20);
    }

    #[test]
    fn a_two_file_room_can_still_link_and_an_unrelated_file_cannot() {
        // The rank rule must degrade correctly at the smallest room there is —
        // and the absolute floor is what keeps "connected" from meaning
        // "everything is connected".
        let conn = db::open_in_memory_schema();
        let a = add(&conn, "trip.txt", "Our vacation plans for the summer holiday.");
        let b = add(&conn, "pto.txt", "The vacation schedule and paid time away.");
        embed_chunks_by_keyword(&conn, "vacation");
        let g = build_room_graph(&conn).unwrap();
        assert_eq!(kinds(&g, EDGE_SIMILAR).len(), 1, "two matching files link");
        let e = &g.edges[0];
        assert!([e.a.as_str(), e.b.as_str()].contains(&a.as_str()));
        assert!([e.a.as_str(), e.b.as_str()].contains(&b.as_str()));

        // A third file whose vector is orthogonal earns nothing, not even from
        // the isolate rescue — an unrelated file stays a lone star.
        let c = add(&conn, "budget.txt", "Quarterly office budget spreadsheet totals.");
        embed_chunks_by_keyword(&conn, "vacation");
        let g2 = build_room_graph(&conn).unwrap();
        assert!(
            !g2.edges.iter().any(|e| e.a == c || e.b == c),
            "an orthogonal file must not be given a link to look connected"
        );
    }

    #[test]
    fn a_full_pass_output_links_back_to_the_file_it_was_made_from() {
        let conn = db::open_in_memory_schema();
        let src = add(&conn, "lease.txt", "The lease agreement covers pets and the deposit.");
        let out = add(&conn, "Full pass — lease.txt.md", "Summary of the agreement.");
        db::set_derived_from(&conn, &out, &src).unwrap();
        let g = build_room_graph(&conn).unwrap();
        let derived = kinds(&g, EDGE_DERIVED);
        assert_eq!(derived, vec![(src.clone(), out.clone())], "source → output, in that order");
        assert!(g.edges.iter().find(|e| e.kind == EDGE_DERIVED).unwrap().directed);

        // A file cannot be made from itself, and a dangling id draws nothing.
        db::set_derived_from(&conn, &out, &out).unwrap();
        assert_eq!(kinds(&build_room_graph(&conn).unwrap(), EDGE_DERIVED).len(), 1);
    }

    #[test]
    fn two_saves_of_one_page_link_and_two_pages_of_one_host_link_weaker() {
        let conn = db::open_in_memory_schema();
        let md = db::insert_file_from_url(
            &conn,
            "Council minutes.md",
            "text/markdown",
            b"x",
            Some("minutes text"),
            "web",
            Some("https://example.com/minutes"),
        )
        .unwrap()
        .id;
        let html = db::insert_file_from_url(
            &conn,
            "Council minutes.html",
            "text/html",
            b"x",
            Some("minutes text"),
            "web",
            Some("https://example.com/minutes"),
        )
        .unwrap()
        .id;
        let other = db::insert_file_from_url(
            &conn,
            "Budget page.md",
            "text/markdown",
            b"x",
            Some("budget text"),
            "web",
            Some("https://www.example.com/budget"),
        )
        .unwrap()
        .id;
        let g = build_room_graph(&conn).unwrap();
        let same_page = kinds(&g, EDGE_SAME_PAGE);
        assert_eq!(same_page.len(), 1, "the md/html twin is exactly one link");
        assert!([&same_page[0].0, &same_page[0].1].contains(&&md));
        assert!([&same_page[0].0, &same_page[0].1].contains(&&html));
        // `www.` is not a different site.
        let same_site = kinds(&g, EDGE_SAME_SITE);
        assert!(
            same_site.iter().any(|(a, b)| [a, b].contains(&&other)),
            "the third page links to the host's newest file"
        );
        assert!(
            g.edges.iter().any(|e| e.kind == EDGE_SAME_SITE && e.shared == vec!["example.com"]),
            "the tooltip names the host it is claiming"
        );
    }

    #[test]
    fn one_document_naming_another_is_a_link_and_a_generic_name_is_not() {
        let conn = db::open_in_memory_schema();
        // A distinctive name that really appears in another file's text.
        let target = add(&conn, "Peregrine audit 2024.md", "the audit body");
        let citer = add(&conn, "board pack.md", "See Peregrine audit 2024 for the numbers.");
        // A generic name that appears all over the room earns nothing.
        let generic = add(&conn, "Notes.md", "loose notes");
        for i in 0..8 {
            add(&conn, &format!("filler{i}.md"), "these are notes about notes and more notes");
        }
        let g = build_room_graph(&conn).unwrap();
        let mentions = kinds(&g, EDGE_MENTIONS);
        assert!(
            mentions.contains(&(citer.clone(), target.clone())),
            "the naming file points at the named one, got {mentions:?}"
        );
        assert!(
            !mentions.iter().any(|(_, b)| *b == generic),
            "a name every file's words contain is not evidence of anything"
        );
        // Short stems are never searched for at all.
        let short = add(&conn, "q1.md", "x");
        let g2 = build_room_graph(&conn).unwrap();
        assert!(!kinds(&g2, EDGE_MENTIONS).iter().any(|(_, b)| *b == short));
    }

    #[test]
    fn two_files_answering_one_question_are_linked_and_a_research_dump_is_not() {
        let conn = db::open_in_memory_schema();
        let a = add(&conn, "lease.txt", "pets clause");
        let b = add(&conn, "addendum.txt", "deposit clause");
        let c = add(&conn, "email.txt", "landlord note");
        let d = add(&conn, "receipt.txt", "payment");
        let e = add(&conn, "photos.txt", "images");
        let chat = db::create_chat(&conn).unwrap();
        db::insert_message(
            &conn,
            &chat.id,
            "assistant",
            "Both say the same thing.",
            &["lease.txt".into(), "addendum.txt".into()],
            None,
        )
        .unwrap();
        // Five sources is research, not a relationship between any two of them.
        db::insert_message(
            &conn,
            &chat.id,
            "assistant",
            "Here is everything.",
            &[
                "lease.txt".into(),
                "addendum.txt".into(),
                "email.txt".into(),
                "receipt.txt".into(),
                "photos.txt".into(),
            ],
            None,
        )
        .unwrap();
        let g = build_room_graph(&conn).unwrap();
        let cited = kinds(&g, EDGE_CITED);
        assert_eq!(cited.len(), 1, "only the two-source answer draws, got {cited:?}");
        assert!([&cited[0].0, &cited[0].1].contains(&&a));
        assert!([&cited[0].0, &cited[0].1].contains(&&b));
        for id in [&c, &d, &e] {
            assert!(!cited.iter().any(|(x, y)| x == id || y == id));
        }
        // A name that no longer resolves is dropped, never guessed at.
        db::insert_message(
            &conn,
            &chat.id,
            "assistant",
            "Gone.",
            &["lease.txt".into(), "deleted file.txt".into()],
            None,
        )
        .unwrap();
        assert_eq!(kinds(&build_room_graph(&conn).unwrap(), EDGE_CITED).len(), 1);
    }

    #[test]
    fn a_chatty_room_does_not_cite_every_file_alongside_every_other() {
        // `cited` is a fact, and the viewer exempts facts from its edge cap —
        // so an unbounded one is a hairball nothing downstream can thin. Pairs
        // accumulate over every answer the room ever gave: 20 files with one
        // two-source answer per pair used to emit all 190 links, i.e. the exact
        // complete graph this whole change exists to remove, just in a
        // different colour.
        let conn = db::open_in_memory_schema();
        for i in 0..20 {
            add(&conn, &format!("f{i}.txt"), "unrelated body text");
        }
        let chat = db::create_chat(&conn).unwrap();
        for i in 0..20 {
            for j in (i + 1)..20 {
                db::insert_message(
                    &conn,
                    &chat.id,
                    "assistant",
                    "x",
                    &[format!("f{i}.txt"), format!("f{j}.txt")],
                    None,
                )
                .unwrap();
            }
        }
        let g = build_room_graph(&conn).unwrap();
        let cited = kinds(&g, EDGE_CITED).len();
        assert!(cited <= 20 * GRAPH_CITED_TOP, "{cited} cited edges is a hairball");
        assert!(cited >= 10, "…but a room that really does cite files together still reads");

        // The bound is by RANK, so the pair the room keeps reaching for
        // together survives while the one-off pairs around it are dropped.
        let conn2 = db::open_in_memory_schema();
        let a = add(&conn2, "lease.txt", "pets");
        let b = add(&conn2, "addendum.txt", "deposit");
        for i in 0..8 {
            add(&conn2, &format!("other{i}.txt"), "misc");
        }
        let chat2 = db::create_chat(&conn2).unwrap();
        for _ in 0..5 {
            db::insert_message(
                &conn2,
                &chat2.id,
                "assistant",
                "x",
                &["lease.txt".into(), "addendum.txt".into()],
                None,
            )
            .unwrap();
        }
        for i in 0..8 {
            db::insert_message(
                &conn2,
                &chat2.id,
                "assistant",
                "x",
                &["lease.txt".into(), format!("other{i}.txt")],
                None,
            )
            .unwrap();
        }
        let g2 = build_room_graph(&conn2).unwrap();
        assert!(
            kinds(&g2, EDGE_CITED).contains(&pair_key(&a, &b)),
            "the most-cited pair is the one that must survive the bound"
        );
    }

    #[test]
    fn a_memory_links_to_the_files_its_distinctive_words_appear_in() {
        // Memories used to be decorative — nodes that could never have an edge.
        let conn = db::open_in_memory_schema();
        let f = add(&conn, "policy.md", "The Zermatt retreat is booked for the whole team.");
        add(&conn, "unrelated.md", "Invoices and quarterly totals.");
        db::add_memory(&conn, "We always go to Zermatt in February.", None).unwrap();
        let g = build_room_graph(&conn).unwrap();
        let mem: Vec<&GraphEdge> = g.edges.iter().filter(|e| e.a.starts_with("mem:")).collect();
        assert_eq!(mem.len(), 1, "one memory edge, got {:?}", mem.len());
        assert_eq!(mem[0].b, f);
        assert!(mem[0].shared.contains(&"zermatt".to_string()), "it says which word matched");

        // A memory made only of words the room never uses stays unlinked.
        db::add_memory(&conn, "Remember the aardvark provisions.", None).unwrap();
        let g2 = build_room_graph(&conn).unwrap();
        assert_eq!(g2.edges.iter().filter(|e| e.a.starts_with("mem:")).count(), 1);
        assert!(g2.nodes.iter().filter(|n| n.kind == "memory").count() == 2);
    }

    #[test]
    fn a_file_the_room_knows_nothing_about_stays_isolated() {
        // The honest failure mode: a sparse map beats a pretty untrue one.
        let conn = db::open_in_memory_schema();
        add(&conn, "trip.txt", "Our vacation plans for the summer holiday.");
        add(&conn, "pto.txt", "The vacation schedule and paid time away.");
        let lone = add(&conn, "zzz.bin", "qwrtypsdfghjklzxcvbnm");
        embed_chunks_by_keyword(&conn, "vacation");
        let g = build_room_graph(&conn).unwrap();
        assert!(
            !g.edges.iter().any(|e| e.a == lone || e.b == lone),
            "nothing relates this file, so nothing may be drawn from it"
        );
        assert!(g.nodes.iter().any(|n| n.id == lone), "…but it is still on the map");
    }

    #[test]
    fn a_fact_wins_the_pair_over_a_guess() {
        // One line per pair, and it is the one that tells the reader the most.
        let conn = db::open_in_memory_schema();
        let src = add(&conn, "trip.txt", "Our vacation plans for the summer holiday.");
        let out = add(&conn, "pto.txt", "The vacation schedule and paid time away.");
        embed_chunks_by_keyword(&conn, "vacation");
        assert_eq!(build_room_graph(&conn).unwrap().edges[0].kind, EDGE_SIMILAR);
        db::set_derived_from(&conn, &out, &src).unwrap();
        let g = build_room_graph(&conn).unwrap();
        assert_eq!(g.edges.len(), 1, "not two lines on top of each other");
        assert_eq!(g.edges[0].kind, EDGE_DERIVED);
    }

    #[test]
    fn the_same_room_always_produces_the_same_payload() {
        // The viewer only re-lays-out when the edge list changes, so a builder
        // that returned the same links in a different order each time would
        // scramble the reader's map on every unrelated file write.
        let conn = db::open_in_memory_schema();
        for i in 0..12 {
            add(&conn, &format!("f{i}.txt"), &format!("shared topic words number {i} and more"));
        }
        let a = build_room_graph(&conn).unwrap();
        let b = build_room_graph(&conn).unwrap();
        let key = |g: &RoomGraph| {
            g.edges.iter().map(|e| (e.a.clone(), e.b.clone(), e.kind.clone())).collect::<Vec<_>>()
        };
        assert_eq!(key(&a), key(&b));
        assert!(!a.edges.is_empty(), "the fixture must actually produce edges");
    }
}


