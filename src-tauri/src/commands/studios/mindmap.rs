use super::*;

#[derive(Serialize, Deserialize, Clone)]
pub struct MindNode {
    pub label: String,
    #[serde(default)]
    pub parent: String,
}

/// D5 (optional): generate a self-contained, collapsible mind-map HTML tree from
/// the scope's material and save it into the room. Same graceful-degradation
/// contract as flashcards. CONTRACT-NOTE: rendered as a pure CSS/JS tree (no
/// force-layout lib bundled) — the RoomMap viewer already covers the physics
/// constellation; a mind map reads better as a clean hierarchy.
#[tauri::command]
pub async fn studio_mindmap(
    window: tauri::Window,
    state: State<'_, AppState>,
    scope: Option<String>,
    instructions: Option<String>,
    refs: Option<Vec<String>>,
    op_id: Option<String>,
) -> Result<FileMeta, String> {
    // A Studio button in the UI: its own root, nobody's child.
    run_studio(&window, &state, mindmap_spec(), scope, instructions, refs, op_id, None).await
}

/// The mind-map artifact spec for the shared `run_studio` pipeline.
pub(crate) fn mindmap_spec() -> StudioSpec {
    StudioSpec {
        default_prompt: STUDIO_MINDMAP_PROMPT,
        page_role: "You are a front-end developer building an interactive mind-map page. Draw one \
            central topic with a tree of branches; let the reader expand and collapse nodes by clicking, \
            and gently pan the canvas if you can. Keep labels short. Base it only on the provided material.",
        working_label: "Drawing your mind map",
        fallback_step: Some("Extracting the topic tree…"),
        fallback_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "root": {"type": "string"},
                "nodes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string"},
                            "parent": {"type": "string"}
                        },
                        "required": ["label", "parent"]
                    }
                }
            },
            "required": ["root", "nodes"]
        }),
        fallback_system: "You organize material into a mind map: one central root topic and a tree of nodes, \
             each naming its parent (the root, or another node's exact label). Keep labels short. \
             Base it only on the provided text.",
        fallback_intro: "Base it only on this material about",
        fallback_temp: 0.3,
        render: fallback_mindmap,
        filename_prefix: "Mind map",
        // HTML-authoring stays primary here: this artifact is a PAGE, and
        // nothing downstream needs to read its parts back as data.
        structured_first: false,
        after_save: None,
    }
}

/// Fallback: parse the extracted topic tree and render the built-in mind-map
/// template. The root defaults to the scope label when the model omits it.
fn fallback_mindmap(raw: &str, label: &str) -> Result<String, String> {
    let root = json_str_field(raw, "root")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| label.trim().to_string());
    let nodes: Vec<MindNode> = json_array(raw, "nodes")
        .iter()
        .filter_map(|n| {
            let l = value_str(n, "label");
            (!l.is_empty()).then_some(MindNode {
                label: l,
                parent: value_str(n, "parent"),
            })
        })
        .collect();
    if nodes.is_empty() {
        return Err("The model didn't return a usable mind map — try a different file.".into());
    }
    Ok(render_mindmap_html(label, &root, &nodes))
}

/// D5: render a collapsible mind-map tree as a self-contained HTML page. Built
/// as STATIC nested <details> in Rust (native disclosure, no JavaScript) for
/// the same sandbox reason as the flashcards above.
pub(crate) fn render_mindmap_html(title: &str, root: &str, nodes: &[MindNode]) -> String {
    use std::collections::HashMap;
    let mut kids: HashMap<String, Vec<String>> = HashMap::new();
    for n in nodes {
        let parent = if n.parent.trim().is_empty() {
            root.to_string()
        } else {
            n.parent.clone()
        };
        if n.label != parent {
            kids.entry(parent).or_default().push(n.label.clone());
        }
    }
    fn node_html(
        label: &str,
        kids: &HashMap<String, Vec<String>>,
        depth: usize,
        seen: &mut std::collections::HashSet<String>,
    ) -> String {
        let esc = html_escape(label);
        // Guard against runaway depth and parent/child cycles from a bad tree.
        if depth > 8 || !seen.insert(label.to_string()) {
            return format!("<span class=\"leaf\">{esc}</span>");
        }
        let children = kids.get(label).cloned().unwrap_or_default();
        let out = if children.is_empty() {
            format!("<span class=\"leaf\">{esc}</span>")
        } else {
            let open = if depth < 2 { " open" } else { "" };
            let mut inner = String::new();
            for c in &children {
                inner.push_str("<li>");
                inner.push_str(&node_html(c, kids, depth + 1, seen));
                inner.push_str("</li>");
            }
            format!("<details{open}><summary>{esc}</summary><ul>{inner}</ul></details>")
        };
        seen.remove(label);
        out
    }
    let mut seen = std::collections::HashSet::new();
    let tree = format!(
        "<ul class=\"tree\"><li>{}</li></ul>",
        node_html(root, &kids, 0, &mut seen)
    );
    fill_template(
        MINDMAP_TEMPLATE,
        &[
            // One inlined copy of the notebook for every generated page — see
            // NOTEBOOK_CSS in docs_html.rs.
            ("__NOTEBOOK__", NOTEBOOK_CSS),
            ("__TITLE__", &html_escape(title)),
            ("__TREE__", &tree),
        ],
    )
}

pub(crate) const MINDMAP_TEMPLATE: &str = r####"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — Mind map</title>
<style>
__NOTEBOOK__
/* ---- the map: inked nodes, pencil connectors ------------------------------
   Everything above comes from NOTEBOOK_CSS (docs_html.rs), the one inlined
   copy of src/styles/tokens.css. Nothing below restates a colour. */
.wrap{max-width:50rem;margin:0 auto;padding:2.5rem 1.25rem 3rem}
.eyebrow{display:inline-block;font-size:var(--fs-micro);font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin-bottom:.4rem}
h1{font-family:var(--sans);font-weight:700;font-size:var(--fs-page);line-height:1.15;letter-spacing:-.022em;color:var(--ink-strong);margin:.05rem 0 0}
.rule{height:3px;width:66px;border-radius:3px 2px 4px 2px / 2px 4px 2px 3px;background:linear-gradient(90deg,var(--accent-fill),color-mix(in srgb,var(--mk-berry) 30%,transparent));margin:1rem 0 2rem}
/* Connectors are PENCIL — a guide line drawn before the ink, not a frame. The
   spine runs down each branch and an elbow reaches out to every node. */
ul{list-style:none;margin:0;padding-left:1.5rem;border-left:var(--stroke-w) solid var(--rule)}
ul.tree{border-left:none;padding-left:0}
li{position:relative;margin:.4rem 0}
ul:not(.tree)>li::before{content:'';position:absolute;left:-1.5rem;top:1.2rem;width:1.1rem;border-top:var(--stroke-w) solid var(--rule);pointer-events:none}
details{display:block}
/* Nodes are FRAMES DRAWN ON THE SHEET: transparent, so the dotted grid runs
   under the whole map, with the pen as their outline. min-height keeps the
   smallest node a 24px target. */
summary,.leaf{display:inline-flex;align-items:center;gap:.5rem;min-height:24px;background:transparent;border:var(--stroke-w) solid var(--sketch);border-radius:var(--radius);padding:.4rem .7rem;list-style:none;margin:.1rem 0}
summary{cursor:pointer;transition:background var(--dur-fast) var(--ease-pen)}
summary:hover{background:color-mix(in srgb,var(--ink) 6%,transparent)}
summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
summary::-webkit-details-marker{display:none}
summary::before{content:'\25B8';color:var(--ink-2);font-size:.85rem;transition:transform var(--dur-fast) var(--ease-pen)}
details[open]>summary::before{transform:rotate(90deg)}
/* The central topic is FILLED INK, the notebook's primary treatment. Reversing
   white out of the pink pen is the obvious move and it fails the contrast
   gate: white on the dark theme's pink is 3.1:1. Ink on paper is 14:1 in both
   themes, and the pen still marks the map through the rule and the branches. */
ul.tree>li>details>summary,ul.tree>li>.leaf{background:var(--btn-ink);color:var(--btn-ink-text);border-color:var(--btn-ink);font-weight:650;font-size:var(--fs-lead)}
ul.tree>li>details>summary:hover{background:var(--btn-ink)}
ul.tree>li>details>summary::before{color:var(--btn-ink-text)}
/* The first ring off the centre carries the pen as a marker edge, so the main
   branches read at a glance without inventing a second colour scheme. The <ul>
   is a child of the root's <details>, not of its <li> — render_mindmap_html
   emits <li><details><summary>…</summary><ul>…</ul></details></li>, so a
   `ul.tree>li>ul` selector matches nothing at all. */
ul.tree>li>details>ul>li>details>summary,
ul.tree>li>details>ul>li>.leaf{border-left:3px solid var(--accent-fill)}
@media print{
  /* A collapsed branch prints collapsed — CSS cannot open a <details> the
     reader left shut, and faking it would print something the page is not
     showing. Expand what you want before you print. */
  li,summary,.leaf{break-inside:avoid;page-break-inside:avoid}
}
</style>
</head>
<body>
<main class="wrap">
  <div class="eyebrow">Mind map</div>
  <h1>__TITLE__</h1>
  <div class="rule"></div>
  __TREE__
</main>
</body>
</html>
"####;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mindmap_html_is_static_nested_details() {
        // D5: the tree is static <details>/<summary> (native disclosure, no JS)
        // and tolerates a cycle without recursing forever.
        let nodes = vec![
            MindNode { label: "Child A".into(), parent: "Root".into() },
            MindNode { label: "Grandchild".into(), parent: "Child A".into() },
            MindNode { label: "Child B".into(), parent: String::new() }, // empty parent -> root
            // a self-referential cycle must not hang
            MindNode { label: "Loop".into(), parent: "Loop".into() },
        ];
        let html = render_mindmap_html("My Map", "Root", &nodes);
        assert!(html.starts_with("<!doctype html>"));
        assert!(!html.contains("<script"));
        assert!(html.contains("<details"));
        assert!(html.contains("<summary>Root</summary>"));
        assert!(html.contains("Child A"));
        assert!(html.contains("Grandchild"));
        assert!(html.contains("Child B"));
    }
}
