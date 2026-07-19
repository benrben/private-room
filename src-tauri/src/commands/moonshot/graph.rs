use super::*;

// ---- D3: room graph ---------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub name: String,
    pub folder: Option<String>,
    pub summary: Option<String>,
    /// "file" | "memory"
    pub kind: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub a: String,
    pub b: String,
    pub weight: f32,
    /// Up to 3 short reason strings (shared terms) explaining the link.
    pub shared: Vec<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoomGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// Cosine threshold above which two files' mean embeddings earn an edge.
pub(crate) const GRAPH_VEC_THRESHOLD: f32 = 0.55;
/// Jaccard (keyword-overlap) threshold used when a file has no embeddings yet,
/// so a freshly-imported room still shows links instead of isolated dots.
pub(crate) const GRAPH_KW_THRESHOLD: f32 = 0.12;
/// Cap the file set so the O(n²) pairing stays cheap on a very large room.
pub(crate) const GRAPH_MAX_FILES: usize = 60;

pub(crate) struct GraphFile {
    id: String,
    name: String,
    folder: Option<String>,
    summary: Option<String>,
    mean: Option<Vec<f32>>,
    terms: Vec<String>,
}

/// Jaccard similarity of two term lists treated as sets. 0 when either is empty.
pub(crate) fn jaccard(a: &[String], b: &[String]) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let sa: HashSet<&String> = a.iter().collect();
    let sb: HashSet<&String> = b.iter().collect();
    let inter = sa.intersection(&sb).count();
    let union = sa.union(&sb).count();
    if union == 0 {
        0.0
    } else {
        inter as f32 / union as f32
    }
}

/// The first `max` terms shared by both lists — short human reasons for an edge.
pub(crate) fn shared_terms(a: &[String], b: &[String], max: usize) -> Vec<String> {
    let sb: HashSet<&String> = b.iter().collect();
    a.iter().filter(|t| sb.contains(t)).take(max).cloned().collect()
}

/// D3: build the room's file/memory similarity graph from stored data ONLY — no
/// model call. Each file's vector is the mean of its chunk embeddings; an edge is
/// cosine ≥ threshold, falling back to keyword (Jaccard) overlap when a file has
/// no embeddings yet. Memories are added as nodes (no edges in v1). Pure over the
/// connection → unit-testable with an in-memory room.
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
    let keep: HashSet<String> = metas.iter().map(|f| f.id.clone()).collect();

    // One pass over chunks: accumulate a summed embedding + a text blob per file.
    struct Acc {
        sum: Vec<f32>,
        n: usize,
        text: String,
    }
    let mut acc: HashMap<String, Acc> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT file_id, embedding, text FROM chunks")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let file_id: String = r.get(0)?;
                let emb: Option<Vec<u8>> = r.get(1)?;
                let text: String = r.get(2)?;
                Ok((file_id, emb, text))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (file_id, emb, text) = row.map_err(|e| e.to_string())?;
            if !keep.contains(&file_id) {
                continue;
            }
            let entry = acc.entry(file_id).or_insert_with(|| Acc {
                sum: Vec::new(),
                n: 0,
                text: String::new(),
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
            if entry.text.len() < 4000 {
                entry.text.push_str(&text);
                entry.text.push(' ');
            }
        }
    }

    // Per-file records: mean embedding (if any) + top keyword terms.
    let files: Vec<GraphFile> = metas
        .iter()
        .map(|m| {
            let a = acc.get(&m.id);
            let mean = a.and_then(|a| {
                (a.n > 0 && !a.sum.is_empty())
                    .then(|| a.sum.iter().map(|x| *x / a.n as f32).collect::<Vec<f32>>())
            });
            let terms = a.map(|a| question_terms(&a.text)).unwrap_or_default();
            GraphFile {
                id: m.id.clone(),
                name: m.name.clone(),
                folder: m.folder_id.as_ref().and_then(|fid| folders.get(fid).cloned()),
                summary: None,
                mean,
                terms,
            }
        })
        .collect();

    // Nodes: files (with folder) then memories (kind "memory", no edges in v1).
    let mut nodes: Vec<GraphNode> = files
        .iter()
        .map(|f| GraphNode {
            id: f.id.clone(),
            name: f.name.clone(),
            folder: f.folder.clone(),
            summary: f.summary.clone(),
            kind: "file".into(),
        })
        .collect();
    for m in db::list_memories(conn)?.into_iter().take(GRAPH_MAX_FILES) {
        nodes.push(GraphNode {
            id: format!("mem:{}", m.id),
            name: clamp_words(&m.content, 60),
            folder: None,
            summary: None,
            kind: "memory".into(),
        });
    }

    // Edges: pairwise over files. Prefer the vector signal; fall back to keyword
    // Jaccard when either file has no embeddings yet.
    let mut edges: Vec<GraphEdge> = Vec::new();
    for i in 0..files.len() {
        for j in (i + 1)..files.len() {
            let (weight, threshold) = match (&files[i].mean, &files[j].mean) {
                (Some(a), Some(b)) => (db::cosine_similarity(a, b), GRAPH_VEC_THRESHOLD),
                _ => (jaccard(&files[i].terms, &files[j].terms), GRAPH_KW_THRESHOLD),
            };
            if weight >= threshold {
                edges.push(GraphEdge {
                    a: files[i].id.clone(),
                    b: files[j].id.clone(),
                    weight,
                    shared: shared_terms(&files[i].terms, &files[j].terms, 3),
                });
            }
        }
    }

    Ok(RoomGraph { nodes, edges })
}

/// D3: the room's similarity graph for the RoomMap viewer. Empty when no room is
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

    #[test]
    fn jaccard_and_shared_terms_over_sets() {
        // The keyword fallback the graph uses when a file has no embeddings.
        let a: Vec<String> = vec!["lease".into(), "rent".into(), "pets".into()];
        let b: Vec<String> = vec!["rent".into(), "pets".into(), "deposit".into()];
        assert!((jaccard(&a, &b) - 0.5).abs() < 1e-6, "2 shared of 4 total → 0.5");
        assert_eq!(shared_terms(&a, &b, 3), vec!["rent", "pets"]);
        assert_eq!(jaccard(&[], &a), 0.0, "empty input is no signal");
    }

    #[test]
    fn room_graph_links_files_by_embedding() {
        // D3: two files whose mean vectors match earn an edge; an orthogonal one
        // does not. Reuses the toy 2-D embeddings the retrieval test uses.
        let conn = db::open_in_memory_schema();
        let a = db::insert_file(
            &conn,
            "trip.txt",
            "text/plain",
            b"x",
            Some("Our vacation plans for the summer holiday."),
            "upload",
        )
        .unwrap()
        .id;
        let b = db::insert_file(
            &conn,
            "pto.txt",
            "text/plain",
            b"x",
            Some("The vacation schedule and paid time away."),
            "upload",
        )
        .unwrap()
        .id;
        let c = db::insert_file(
            &conn,
            "budget.txt",
            "text/plain",
            b"x",
            Some("Quarterly office budget spreadsheet totals."),
            "upload",
        )
        .unwrap()
        .id;
        embed_chunks_by_keyword(&conn, "vacation");

        let g = build_room_graph(&conn).unwrap();
        assert_eq!(g.nodes.iter().filter(|n| n.kind == "file").count(), 3);
        // Exactly one edge — the two vacation files (cosine 1.0 ≥ 0.55). The
        // budget file's [0,1] vector is orthogonal to their [1,0], so no edge.
        assert_eq!(g.edges.len(), 1);
        let e = &g.edges[0];
        assert!(e.weight >= GRAPH_VEC_THRESHOLD);
        let ends = [e.a.clone(), e.b.clone()];
        assert!(ends.contains(&a) && ends.contains(&b));
        assert!(!ends.contains(&c), "orthogonal file is not linked");

        // A saved memory becomes a node (no edges in v1) without adding file edges.
        db::add_memory(&conn, "The office is closed on Fridays.", None).unwrap();
        let g2 = build_room_graph(&conn).unwrap();
        assert!(g2.nodes.iter().any(|n| n.kind == "memory"));
        assert_eq!(g2.edges.len(), 1);
    }

}
