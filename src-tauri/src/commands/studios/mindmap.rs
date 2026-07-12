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
    use tauri::Emitter;
    // ADD-31: cancellable with visible stages (see studio_flashcards).
    let cancel = register_studio_cancel(&state, &op_id);
    let _cancel_guard = op_id.as_ref().map(|id| CancelGuard {
        state: state.inner(),
        ask_id: id.clone(),
    });
    let instr = studio_instruction(instructions, STUDIO_MINDMAP_PROMPT);
    let _ = window.emit("studio-step", "Reading the material…");
    let (label, text) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        match refs.as_ref().filter(|r| !r.is_empty()) {
            Some(ids) => gather_files_text(&room.conn, ids)?,
            None => gather_scope_text(&room.conn, scope.as_deref(), &room.name)?,
        }
    };
    let model = resolve_structured_model(&state)
        .await
        .ok_or("The local AI (Ollama) isn't running — start it and try again.")?;
    let _ = window.emit(
        "studio-step",
        if is_cloud_model(&model) {
            "Drawing your mind map — the cloud model is writing…"
        } else {
            "Drawing your mind map — a local model can take a few minutes…"
        },
    );
    let page_role = "You are a front-end developer building an interactive mind-map page. Draw one \
        central topic with a tree of branches; let the reader expand and collapse nodes by clicking, \
        and gently pan the canvas if you can. Keep labels short. Base it only on the provided material.";
    let content = match generate_studio_html(&model, page_role, &instr, &label, &text, cancel.clone())
        .await?
    {
        Some(html) if !cancel.load(Ordering::SeqCst) => html,
        _ if cancel.load(Ordering::SeqCst) => return Err("Stopped.".into()),
        _ => {
            let _ = window.emit("studio-step", "Extracting the topic tree…");
            // Fallback: extract the structured tree and render the built-in template.
            let schema = serde_json::json!({
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
            });
            let messages = vec![
                ollama::ChatMessage::new(
                    "system",
                    "You organize material into a mind map: one central root topic and a tree of nodes, \
                     each naming its parent (the root, or another node's exact label). Keep labels short. \
                     Base it only on the provided text.",
                ),
                ollama::ChatMessage::new(
                    "user",
                    format!("{instr}\n\nBase it only on this material about \"{label}\":\n\n{text}"),
                ),
            ];
            let raw = ollama::chat_structured_cancel(
                &model,
                messages,
                Some(0.3),
                KEEP_ALIVE_WARM,
                &schema,
                cancel.clone(),
            )
            .await?;
            if cancel.load(Ordering::SeqCst) {
                return Err("Stopped.".into());
            }
            let parsed = serde_json::from_str::<serde_json::Value>(raw.trim()).ok();
            let root = parsed
                .as_ref()
                .and_then(|v| v.get("root").and_then(|s| s.as_str()))
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&label)
                .trim()
                .to_string();
            let nodes: Vec<MindNode> = parsed
                .as_ref()
                .and_then(|v| v.get("nodes").and_then(|n| n.as_array()).cloned())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|n| {
                            let l = n.get("label").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                            let p = n.get("parent").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                            (!l.is_empty()).then_some(MindNode { label: l, parent: p })
                        })
                        .collect()
                })
                .unwrap_or_default();
            if nodes.is_empty() {
                return Err(
                    "The model didn't return a usable mind map — try a different file.".into(),
                );
            }
            render_mindmap_html(&label, &root, &nodes)
        }
    };
    let name = format!("Mind map - {}.html", safe_scope_name(&label));
    let meta = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        db::insert_file(&room.conn, &name, "text/html", content.as_bytes(), Some(&content), "generated")?
    };
    let _ = window.emit("room-files-changed", ());
    let _ = window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(meta)
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
    MINDMAP_TEMPLATE
        .replace("__TITLE__", &html_escape(title))
        .replace("__TREE__", &tree)
}

pub(crate) const MINDMAP_TEMPLATE: &str = r####"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — Mind map</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--surface:#fff;--surface-2:#eef0f4;--fg:#191b1f;--muted:#63697a;--accent:#6d5cf0;--accent-2:#8b7cf6;--border:#e6e7ee}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--surface:#161a22;--surface-2:#1c212c;--fg:#e8eaf0;--muted:#8b93a7;--accent:#8b7cf6;--accent-2:#a99df8;--border:#232a37}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:50rem;margin:0 auto;padding:2.5rem 1.25rem}
.eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent)}
h1{font-size:1.9rem;margin:.25rem 0 1.5rem;letter-spacing:-.02em}
ul{list-style:none;margin:0;padding-left:1.4rem;border-left:2px solid var(--border)}
ul.tree{border-left:none;padding-left:0}
li{margin:.4rem 0}
details{display:block}
summary,.leaf{display:inline-flex;align-items:center;gap:.5rem;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:.4rem .7rem;box-shadow:0 4px 14px rgba(24,24,60,.05);list-style:none;margin:.1rem 0}
summary{cursor:pointer}
summary::-webkit-details-marker{display:none}
summary::before{content:'\25B8';color:var(--muted);font-size:.85rem;transition:transform .15s}
details[open]>summary::before{transform:rotate(90deg)}
ul.tree>li>details>summary,ul.tree>li>.leaf{background:var(--accent);color:#fff;border-color:transparent;font-weight:650}
ul.tree>li>details>summary::before{color:rgba(255,255,255,.85)}
</style>
</head>
<body>
<main class="wrap">
  <div class="eyebrow">Mind map</div>
  <h1>__TITLE__</h1>
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
