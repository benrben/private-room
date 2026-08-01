use super::*;

// ---- ADD-22: document templates (model fills structured slots, Rust renders) ----

/// The structured shape the model fills for meeting minutes. Constrained via
/// `format` so a small model returns a valid object, not hand-authored HTML.
pub(crate) fn minutes_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "date": {"type": "string"},
            "attendees": {"type": "array", "items": {"type": "string"}},
            "timeline": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "time": {"type": "string"},
                        "topic": {"type": "string"},
                        "summary": {"type": "string"}
                    },
                    "required": ["topic", "summary"]
                }
            },
            "decisions": {"type": "array", "items": {"type": "string"}},
            "actions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"owner": {"type": "string"}, "task": {"type": "string"}},
                    "required": ["task"]
                }
            }
        },
        "required": ["title", "timeline"]
    })
}

/// Merge per-window minutes into one document's worth of structured fields.
/// Deterministic — Rust does the merging, so a long meeting can't lose its second
/// half to a model that only had room for the first. Timeline items keep window
/// order (the meeting's own order); the window overlap and any repeated decision
/// or attendee are deduped case-insensitively.
pub(crate) fn merge_minutes(parts: &[serde_json::Value]) -> serde_json::Value {
    use serde_json::{json, Value};
    let first_str = |key: &str| -> String {
        parts
            .iter()
            .filter_map(|p| p.get(key).and_then(|v| v.as_str()))
            .map(str::trim)
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_string()
    };
    let mut seen_str: HashSet<String> = HashSet::new();
    let mut attendees: Vec<Value> = Vec::new();
    let mut decisions_seen: HashSet<String> = HashSet::new();
    let mut decisions: Vec<Value> = Vec::new();
    let mut timeline_seen: HashSet<String> = HashSet::new();
    let mut timeline: Vec<Value> = Vec::new();
    let mut actions_seen: HashSet<String> = HashSet::new();
    let mut actions: Vec<Value> = Vec::new();
    let key_of = |s: &str| s.trim().to_lowercase();
    let field = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string();

    for p in parts {
        for a in p.get("attendees").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
            if let Some(s) = a.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                if seen_str.insert(key_of(s)) {
                    attendees.push(json!(s));
                }
            }
        }
        for d in p.get("decisions").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
            if let Some(s) = d.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                if decisions_seen.insert(key_of(s)) {
                    decisions.push(json!(s));
                }
            }
        }
        for it in p.get("timeline").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
            let (topic, summary) = (field(it, "topic"), field(it, "summary"));
            if topic.is_empty() && summary.is_empty() {
                continue;
            }
            if timeline_seen.insert(format!("{}|{}", key_of(&topic), key_of(&summary))) {
                timeline.push(it.clone());
            }
        }
        for a in p.get("actions").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
            let (owner, task) = (field(a, "owner"), field(a, "task"));
            if task.is_empty() {
                continue;
            }
            if actions_seen.insert(format!("{}|{}", key_of(&owner), key_of(&task))) {
                actions.push(a.clone());
            }
        }
    }
    json!({
        "title": first_str("title"),
        "date": first_str("date"),
        "attendees": attendees,
        "timeline": timeline,
        "decisions": decisions,
        "actions": actions,
    })
}

/// Render structured minutes into a timeline-styled HTML body using the shared
/// `DOC_STYLE` components (hero, chips, timeline, checklist, table). Every section
/// is omitted when empty, and all text is escaped. Pure and testable.
pub(crate) fn render_minutes_html(p: &serde_json::Value, title: &str) -> String {
    let arr_strings = |k: &str| -> Vec<String> {
        p.get(k)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };
    let field = |v: &serde_json::Value, k: &str| {
        v.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
    };

    let date = p.get("date").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let attendees = arr_strings("attendees");
    let mut meta = Vec::new();
    if !date.is_empty() {
        meta.push(html_escape(&date));
    }
    if !attendees.is_empty() {
        meta.push(format!(
            "{} attendee{}",
            attendees.len(),
            if attendees.len() == 1 { "" } else { "s" }
        ));
    }
    let mut body = doc_hero("Meeting minutes", title, &meta.join(" · "));
    if !attendees.is_empty() {
        body.push_str("<div class=\"chips\">");
        for a in &attendees {
            body.push_str(&format!("<span class=\"chip\">{}</span>", html_escape(a)));
        }
        body.push_str("</div>\n");
    }

    if let Some(items) = p.get("timeline").and_then(|v| v.as_array()) {
        let items: Vec<&serde_json::Value> = items
            .iter()
            .filter(|it| !field(it, "topic").is_empty() || !field(it, "summary").is_empty())
            .collect();
        if !items.is_empty() {
            body.push_str("<h2>Timeline</h2>\n<ul class=\"tl\">\n");
            for it in items {
                body.push_str("<li>");
                let time = field(it, "time");
                if !time.is_empty() {
                    body.push_str(&format!("<div class=\"time\">{}</div>", html_escape(&time)));
                }
                let topic = field(it, "topic");
                if !topic.is_empty() {
                    body.push_str(&format!("<div class=\"topic\">{}</div>", html_escape(&topic)));
                }
                let summary = field(it, "summary");
                if !summary.is_empty() {
                    body.push_str(&format!("<p class=\"summary\">{}</p>", html_escape(&summary)));
                }
                body.push_str("</li>\n");
            }
            body.push_str("</ul>\n");
        }
    }

    let decisions = arr_strings("decisions");
    if !decisions.is_empty() {
        body.push_str("<h2>Decisions</h2>\n<ul class=\"checks\">\n");
        for d in &decisions {
            body.push_str(&format!("<li>{}</li>\n", html_escape(d)));
        }
        body.push_str("</ul>\n");
    }

    if let Some(actions) = p.get("actions").and_then(|v| v.as_array()) {
        let rows: Vec<(String, String)> = actions
            .iter()
            .filter_map(|a| {
                let task = field(a, "task");
                if task.is_empty() {
                    return None;
                }
                Some((field(a, "owner"), task))
            })
            .collect();
        if !rows.is_empty() {
            body.push_str("<h2>Action items</h2>\n<table class=\"actions\">\n<tr><th>Owner</th><th>Task</th></tr>\n");
            for (owner, task) in rows {
                let owner = if owner.is_empty() { "—".to_string() } else { html_escape(&owner) };
                body.push_str(&format!("<tr><td>{}</td><td>{}</td></tr>\n", owner, html_escape(&task)));
            }
            body.push_str("</table>\n");
        }
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_minutes_stitches_every_pass_into_one_timeline() {
        // Two windows of one long meeting. The second half must survive — with a
        // single clamped pass it never reached the model at all.
        let first = serde_json::json!({
            "title": "Quarterly review",
            "date": "2026-07-05",
            "attendees": ["Ana", "Ben"],
            "timeline": [{"time": "09:00", "topic": "Kickoff", "summary": "Reviewed goals."}],
            "decisions": ["Ship on Friday"],
            "actions": [{"owner": "Ana", "task": "Send recap"}]
        });
        let second = serde_json::json!({
            "title": "",
            "date": "",
            // The window overlap re-shows Kickoff, and Ben attends throughout.
            "attendees": ["ben", "Cai"],
            "timeline": [
                {"time": "09:00", "topic": "Kickoff", "summary": "Reviewed goals."},
                {"time": "10:30", "topic": "Budget", "summary": "Agreed Q3 numbers."}
            ],
            "decisions": ["ship on friday", "Hire a designer"],
            "actions": [{"owner": "Ana", "task": "Send recap"}, {"task": "Book room"}]
        });
        let m = merge_minutes(&[first, second]);
        assert_eq!(m["title"], "Quarterly review", "title comes from the first pass that has one");
        assert_eq!(m["date"], "2026-07-05");
        // Overlap deduped case-insensitively; order of first appearance kept.
        assert_eq!(m["attendees"], serde_json::json!(["Ana", "Ben", "Cai"]));
        assert_eq!(m["decisions"], serde_json::json!(["Ship on Friday", "Hire a designer"]));
        let timeline = m["timeline"].as_array().unwrap();
        assert_eq!(timeline.len(), 2, "the repeated item is merged, not doubled");
        assert_eq!(timeline[0]["topic"], "Kickoff");
        assert_eq!(timeline[1]["topic"], "Budget", "the late part of the meeting is in the minutes");
        assert_eq!(m["actions"].as_array().unwrap().len(), 2);
        // A merge of nothing stays empty (the caller turns that into the
        // "couldn't find a meeting" error rather than an empty document).
        assert!(merge_minutes(&[]).get("timeline").unwrap().as_array().unwrap().is_empty());
    }

    #[test]
    fn render_minutes_html_builds_timeline() {
        let data = serde_json::json!({
            "title": "Weekly sync",
            "date": "2026-07-05",
            "attendees": ["Ana", "Ben"],
            "timeline": [
                {"time": "09:00", "topic": "Kickoff", "summary": "Reviewed goals."},
                {"topic": "Budget", "summary": "Agreed on Q3 numbers."}
            ],
            "decisions": ["Ship on Friday"],
            "actions": [{"owner": "Ana", "task": "Send recap"}, {"task": "Book room"}]
        });
        let body = render_minutes_html(&data, "Weekly sync");
        assert!(body.contains("<h1>Weekly sync</h1>"));
        // Editorial hero: an accent eyebrow labels the document type.
        assert!(body.contains("class=\"eyebrow\"") && body.contains("Meeting minutes"));
        assert!(body.contains("class=\"tl\""));
        assert!(body.contains("class=\"chip\""), "attendees render as chips");
        assert!(body.contains("Kickoff") && body.contains("Budget"));
        assert!(body.contains("Ship on Friday"));
        assert!(body.contains("Send recap"));
        assert!(body.contains("<td>—</td>"), "ownerless action falls back to —");
        // Wraps into a full themed document (centered column + footer).
        let doc = html_document("Weekly sync", &body);
        assert!(doc.starts_with("<!doctype html>"));
        assert!(doc.contains("--accent"));
        assert!(doc.contains("class=\"doc\"") && doc.contains("doc-foot"));
    }
}
