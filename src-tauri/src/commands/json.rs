//! Plucking fields out of a model's JSON reply.
//!
//! Every structured-output call hands back a JSON string, and the caller wants
//! one or two fields out of it. A bad reply is never fatal here: the field is
//! simply absent and the caller falls back (a built-in template, the raw text,
//! "(not found)"). These helpers keep that lenient contract in one place instead
//! of re-deriving it at every generation site.

/// The string at `key` of a JSON object, trimmed. `None` when the reply isn't
/// JSON, isn't an object, or has no string there. Callers that treat a blank
/// value as missing add their own `.filter(|s| !s.is_empty())` — some (a file
/// summary) would rather keep the empty string than fall back.
pub(crate) fn json_str_field(raw: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(raw.trim())
        .ok()?
        .get(key)?
        .as_str()
        .map(|s| s.trim().to_string())
}

// MIGRATION Phase 3: `json_bool_field` (memory_suggestion) and `json_str_array`
// (suggest_file_meta) moved with their features into the sidecar, which parses the
// bool/tag-array itself and returns typed JSON. They're gone from Rust; the object
// and item pluckers below stay (studios/file-meta still shape their replies here).

/// The array at `key` as owned values; empty when absent. For arrays of objects
/// (cards, mind-map nodes, podcast turns) the caller shapes each item, usually
/// with `value_str`.
pub(crate) fn json_array(raw: &str, key: &str) -> Vec<serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(raw.trim())
        .ok()
        .and_then(|v| v.get(key).and_then(|a| a.as_array()).cloned())
        .unwrap_or_default()
}

/// The trimmed string at `key` of an already-parsed object; `""` when absent —
/// the item-level counterpart of `json_str_field`.
pub(crate) fn value_str(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plucks_fields_and_tolerates_junk() {
        let raw = r#" {"html": " <div/> ", "worth": true, "tags": ["a", " ", " B "], "cards": [{"q": "x"}]} "#;
        assert_eq!(json_str_field(raw, "html").as_deref(), Some("<div/>"));
        assert_eq!(json_str_field(raw, "missing"), None);
        assert_eq!(value_str(&json_array(raw, "cards")[0], "q"), "x");
        assert_eq!(value_str(&json_array(raw, "cards")[0], "a"), "");

        // A non-JSON reply is missing data, not an error.
        assert_eq!(json_str_field("sorry, I can't", "html"), None);
        assert!(json_array("sorry, I can't", "cards").is_empty());
    }
}
