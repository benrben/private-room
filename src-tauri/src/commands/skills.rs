//! Agent Skills: validation, encrypted CRUD, folder import/export, and
//! engine-agnostic AI composition. Skills deliberately never enter `files`.

use super::*;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

const MAX_NAME: usize = 64;
const MAX_DESCRIPTION: usize = 2_000;
const MAX_INSTRUCTIONS: usize = 200_000;
const MAX_RESOURCE_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMPORT_BYTES: usize = 128 * 1024 * 1024;
const MAX_RESOURCES: usize = 250;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillResourceMeta {
    pub path: String,
    pub kind: String,
    pub size_bytes: usize,
    pub text: bool,
    pub updated_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillBundle {
    pub skill: db::Skill,
    pub resources: Vec<SkillResourceMeta>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillResourceContent {
    pub path: String,
    pub kind: String,
    pub text: Option<String>,
    pub data_b64: Option<String>,
}

pub(crate) fn validate_skill_name(name: &str) -> Result<String, String> {
    let name = name.trim().to_lowercase().replace([' ', '_'], "-");
    if name.is_empty() {
        return Err("Give the skill a name.".into());
    }
    if name.len() > MAX_NAME
        || name.starts_with('-')
        || name.ends_with('-')
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("Skill names must be 1–64 lowercase letters, numbers, or hyphens, without a leading or trailing hyphen.".into());
    }
    Ok(name)
}

fn validate_skill_fields(
    name: &str,
    description: &str,
    instructions: &str,
) -> Result<String, String> {
    let name = validate_skill_name(name)?;
    let description = description.trim();
    if description.is_empty() {
        return Err("Describe what the skill does and when the assistant should use it.".into());
    }
    if description.chars().count() > MAX_DESCRIPTION {
        return Err(format!(
            "Keep the skill description under {MAX_DESCRIPTION} characters."
        ));
    }
    if instructions.chars().count() > MAX_INSTRUCTIONS {
        return Err("SKILL.md is too large. Move detailed material into references/.".into());
    }
    Ok(name)
}

pub(crate) fn normalize_skill_path(raw: &str) -> Result<String, String> {
    let raw = raw.trim().replace('\\', "/");
    if raw.is_empty() || raw.len() > 240 {
        return Err("Use a short relative resource path.".into());
    }
    let path = Path::new(&raw);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || raw.eq_ignore_ascii_case("SKILL.md")
    {
        return Err("Resource paths must stay inside the skill folder; SKILL.md is edited through the skill fields.".into());
    }
    Ok(raw)
}

pub(crate) fn skill_resource_kind(path: &str) -> &'static str {
    let first = path.split('/').next().unwrap_or_default();
    match first {
        "scripts" => "script",
        "references" => "reference",
        "assets" => "asset",
        "agents" => "agent",
        _ => "resource",
    }
}

fn is_text_path(path: &str, bytes: &[u8]) -> bool {
    if std::str::from_utf8(bytes).is_err() {
        return false;
    }
    matches!(
        Path::new(path)
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "md" | "txt"
            | "py"
            | "js"
            | "ts"
            | "tsx"
            | "jsx"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "csv"
            | "html"
            | "css"
            | "sh"
            | "sql"
            | "xml"
            | "svg"
    )
}

pub(crate) fn render_skill_md(skill: &db::Skill) -> String {
    let description = skill.description.replace('\n', " ").replace('\r', " ");
    let description = description.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "---\nname: {}\ndescription: \"{}\"\n---\n\n{}\n",
        skill.name,
        description,
        skill.instructions.trim_end()
    )
}

fn unquote_yaml(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')))
    {
        let body = &s[1..s.len() - 1];
        if s.starts_with('"') {
            body.replace("\\\"", "\"").replace("\\\\", "\\")
        } else {
            body.replace("''", "'")
        }
    } else {
        s.to_string()
    }
}

fn parse_skill_md(text: &str) -> Result<(String, String, String), String> {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err("SKILL.md must begin with YAML frontmatter between --- lines.".into());
    }
    let mut name = String::new();
    let mut description = String::new();
    let mut in_description_block = false;
    let mut body_start = None;
    let all: Vec<&str> = text.lines().collect();
    for (i, raw) in all.iter().enumerate().skip(1) {
        if raw.trim() == "---" {
            body_start = Some(i + 1);
            break;
        }
        if in_description_block && (raw.starts_with(' ') || raw.starts_with('\t')) {
            if !description.is_empty() {
                description.push(' ');
            }
            description.push_str(raw.trim());
            continue;
        }
        in_description_block = false;
        if let Some(v) = raw.strip_prefix("name:") {
            name = unquote_yaml(v);
        } else if let Some(v) = raw.strip_prefix("description:") {
            let v = v.trim();
            if v == ">" || v == "|" || v == ">-" || v == "|-" {
                in_description_block = true;
            } else {
                description = unquote_yaml(v);
            }
        }
    }
    let at = body_start.ok_or("SKILL.md frontmatter has no closing --- line.")?;
    let instructions = all[at..].join("\n").trim().to_string();
    let name = validate_skill_fields(&name, &description, &instructions)?;
    Ok((name, description.trim().to_string(), instructions))
}

fn emit_skills_changed(window: &tauri::Window) {
    use tauri::Emitter;
    let _ = window.emit("skills-changed", ());
}

/// Agent authoring seam. Every generated/edited skill returns to disabled so a
/// person reviews the exact instructions before they can influence later turns.
pub(crate) fn agent_save_skill(
    window: &tauri::Window,
    state: &AppState,
    args: &serde_json::Value,
) -> Result<String, String> {
    let raw_name = args["name"].as_str().unwrap_or_default();
    let description = args["description"].as_str().unwrap_or_default();
    let instructions = args["instructions"].as_str().unwrap_or_default();
    let name = validate_skill_fields(raw_name, description, instructions)?;
    let (id, updated) = state.with_room(|room| {
        if let Some(existing) = db::find_skill(&room.conn, &name)? {
            db::update_skill(
                &room.conn,
                &existing.id,
                &name,
                description.trim(),
                instructions.trim(),
            )?;
            db::set_skill_enabled(&room.conn, &existing.id, false)?;
            Ok((existing.id, true))
        } else {
            db::create_skill(
                &room.conn,
                &name,
                description.trim(),
                instructions.trim(),
                false,
                "agent",
            )
            .map(|id| (id, false))
        }
    })?;
    emit_skills_changed(window);
    Ok(format!(
        "{} skill \"{}\" as a disabled draft (id: {}). The user can review and enable it in Skills.",
        if updated { "Updated" } else { "Created" },
        name,
        id
    ))
}

pub(crate) fn agent_write_skill_resource(
    window: &tauri::Window,
    state: &AppState,
    args: &serde_json::Value,
) -> Result<String, String> {
    let key = args["skill"].as_str().unwrap_or_default();
    let path = normalize_skill_path(args["path"].as_str().unwrap_or_default())?;
    let content = args["content"].as_str().unwrap_or_default();
    if content.len() > MAX_RESOURCE_BYTES {
        return Err("That resource is too large (32 MB maximum).".into());
    }
    let skill = state.with_room(|room| {
        db::find_skill(&room.conn, key)?.ok_or_else(|| format!("No skill named \"{key}\" exists."))
    })?;
    state.with_room(|room| {
        db::upsert_skill_resource(
            &room.conn,
            &skill.id,
            &path,
            skill_resource_kind(&path),
            content.as_bytes(),
        )?;
        db::set_skill_enabled(&room.conn, &skill.id, false)
    })?;
    emit_skills_changed(window);
    Ok(format!(
        "Saved {path} in \"{}\" and left the skill disabled for review.",
        skill.name
    ))
}

struct SkillRunWorkspace(PathBuf);
impl Drop for SkillRunWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Execute a bundled Python/JavaScript helper after the same per-content human
/// consent used by room scripts. Only the skill tree is materialized; the
/// encrypted room, room files, and database key are never exposed.
pub(crate) async fn agent_run_skill_script(
    window: &tauri::Window,
    state: &AppState,
    args: &serde_json::Value,
) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    use tauri::Manager as _;

    let key = args["skill"].as_str().unwrap_or_default();
    let path = normalize_skill_path(args["path"].as_str().unwrap_or_default())?;
    if !path.starts_with("scripts/") {
        return Err("Only resources inside scripts/ can be executed.".into());
    }
    let (skill, resources, script_bytes) = state.with_room(|room| {
        let skill = db::find_skill(&room.conn, key)?
            .ok_or_else(|| format!("No skill named \"{key}\" exists."))?;
        if !skill.enabled {
            return Err("Enable and review this skill before running its scripts.".into());
        }
        let resources = db::list_skill_resources(&room.conn, &skill.id)?;
        let script_bytes = resources
            .iter()
            .find(|resource| resource.path == path)
            .map(|resource| resource.content.clone())
            .ok_or_else(|| format!("The skill has no resource at {path}."))?;
        Ok((skill, resources, script_bytes))
    })?;
    let display_name = format!("{}/{}", skill.name, path);
    let (runner, manifest) =
        approve_script_bytes(window, state, &display_name, &script_bytes).await?;

    let cache = window
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let root = cache.join("skill-runs").join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(root.join("tmp")).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let workspace = SkillRunWorkspace(root);
    for resource in resources {
        let rel = normalize_skill_path(&resource.path)?;
        let target = workspace.0.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(target, resource.content).map_err(|e| e.to_string())?;
    }

    let input = args["input"].as_str().map(str::as_bytes);
    let cancel = Arc::new(AtomicBool::new(false));
    let out = execute_script_in_workspace(
        &workspace.0,
        &runner,
        &path,
        manifest.timeout_secs,
        &cancel,
        input,
    )
    .await?;
    if out.exit_code != 0 {
        let detail = if out.stderr_tail.trim().is_empty() {
            out.stdout_tail
        } else {
            out.stderr_tail
        };
        return Err(format!(
            "The skill script failed (exit {}):\n{}",
            out.exit_code,
            clamp_bytes(detail, 12_000)
        ));
    }
    let text = if out.stdout_tail.trim().is_empty() {
        format!("{display_name} finished successfully (no stdout).")
    } else {
        out.stdout_tail
    };
    Ok(clamp_bytes(text, 20_000))
}

#[tauri::command]
pub fn list_skills(state: State<'_, AppState>) -> Result<Vec<db::SkillSummary>, String> {
    state.with_room(|room| db::list_skills(&room.conn, false))
}

#[tauri::command]
pub fn get_skill(state: State<'_, AppState>, id: String) -> Result<SkillBundle, String> {
    state.with_room(|room| {
        let skill = db::get_skill(&room.conn, &id)?;
        let resources = db::list_skill_resources(&room.conn, &id)?
            .into_iter()
            .map(|r| SkillResourceMeta {
                text: is_text_path(&r.path, &r.content),
                size_bytes: r.content.len(),
                path: r.path,
                kind: r.kind,
                updated_at: r.updated_at,
            })
            .collect();
        Ok(SkillBundle { skill, resources })
    })
}

#[tauri::command]
pub fn create_skill(
    window: tauri::Window,
    state: State<'_, AppState>,
    name: String,
    description: String,
    instructions: String,
) -> Result<String, String> {
    let name = validate_skill_fields(&name, &description, &instructions)?;
    let id = state.with_room(|room| {
        db::create_skill(
            &room.conn,
            &name,
            description.trim(),
            instructions.trim(),
            false,
            "user",
        )
    })?;
    emit_skills_changed(&window);
    Ok(id)
}

#[tauri::command]
pub fn update_skill(
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: String,
    instructions: String,
) -> Result<(), String> {
    let name = validate_skill_fields(&name, &description, &instructions)?;
    state.with_room(|room| {
        db::update_skill(
            &room.conn,
            &id,
            &name,
            description.trim(),
            instructions.trim(),
        )
    })?;
    emit_skills_changed(&window);
    Ok(())
}

#[tauri::command]
pub fn set_skill_enabled(
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        state.with_room(|room| {
            let s = db::get_skill(&room.conn, &id)?;
            validate_skill_fields(&s.name, &s.description, &s.instructions)?;
            db::set_skill_enabled(&room.conn, &id, true)
        })?;
    } else {
        state.with_room(|room| db::set_skill_enabled(&room.conn, &id, false))?;
    }
    emit_skills_changed(&window);
    Ok(())
}

#[tauri::command]
pub fn delete_skill(
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.with_room(|room| db::delete_skill(&room.conn, &id))?;
    emit_skills_changed(&window);
    Ok(())
}

#[tauri::command]
pub fn get_skill_resource(
    state: State<'_, AppState>,
    skill_id: String,
    path: String,
) -> Result<SkillResourceContent, String> {
    let path = normalize_skill_path(&path)?;
    state.with_room(|room| {
        let r = db::get_skill_resource(&room.conn, &skill_id, &path)?;
        let text = std::str::from_utf8(&r.content).ok().map(str::to_string);
        let data_b64 = text
            .is_none()
            .then(|| base64::engine::general_purpose::STANDARD.encode(&r.content));
        Ok(SkillResourceContent {
            path: r.path,
            kind: r.kind,
            text,
            data_b64,
        })
    })
}

#[tauri::command]
pub fn save_skill_resource(
    window: tauri::Window,
    state: State<'_, AppState>,
    skill_id: String,
    path: String,
    text: Option<String>,
    data_b64: Option<String>,
) -> Result<(), String> {
    let path = normalize_skill_path(&path)?;
    let bytes = match (text, data_b64) {
        (Some(t), _) => t.into_bytes(),
        (None, Some(b)) => base64::engine::general_purpose::STANDARD
            .decode(b)
            .map_err(|_| "That resource is not valid base64.".to_string())?,
        _ => return Err("Provide text or binary resource content.".into()),
    };
    if bytes.len() > MAX_RESOURCE_BYTES {
        return Err("That resource is too large (32 MB maximum).".into());
    }
    let kind = skill_resource_kind(&path);
    state
        .with_room(|room| db::upsert_skill_resource(&room.conn, &skill_id, &path, kind, &bytes))?;
    emit_skills_changed(&window);
    Ok(())
}

#[tauri::command]
pub fn delete_skill_resource(
    window: tauri::Window,
    state: State<'_, AppState>,
    skill_id: String,
    path: String,
) -> Result<(), String> {
    let path = normalize_skill_path(&path)?;
    state.with_room(|room| db::delete_skill_resource(&room.conn, &skill_id, &path))?;
    emit_skills_changed(&window);
    Ok(())
}

fn collect_folder_files(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(String, Vec<u8>)>,
    total: &mut usize,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_symlink() {
            return Err("Skill folders may not contain symbolic links.".into());
        }
        if ty.is_dir() {
            collect_folder_files(root, &entry.path(), out, total)?;
            continue;
        }
        if !ty.is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if rel == "SKILL.md" {
            continue;
        }
        let rel = normalize_skill_path(&rel)?;
        let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_RESOURCE_BYTES {
            return Err(format!("{rel} is larger than 32 MB."));
        }
        *total += bytes.len();
        if *total > MAX_IMPORT_BYTES || out.len() >= MAX_RESOURCES {
            return Err("That skill folder is too large (250 files / 128 MB maximum).".into());
        }
        out.push((rel, bytes));
    }
    Ok(())
}

#[tauri::command]
pub fn import_skill_folder(
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err("Choose a skill folder containing SKILL.md.".into());
    }
    let skill_md = std::fs::read_to_string(root.join("SKILL.md"))
        .map_err(|_| "That folder has no readable SKILL.md.".to_string())?;
    let (name, description, instructions) = parse_skill_md(&skill_md)?;
    let mut files = Vec::new();
    let mut total = 0usize;
    collect_folder_files(&root, &root, &mut files, &mut total)?;
    let id = state.with_room(|room| {
        let id = db::create_skill(
            &room.conn,
            &name,
            &description,
            &instructions,
            false,
            "import",
        )?;
        for (path, bytes) in &files {
            if let Err(e) =
                db::upsert_skill_resource(&room.conn, &id, path, skill_resource_kind(path), bytes)
            {
                let _ = db::delete_skill(&room.conn, &id);
                return Err(e);
            }
        }
        Ok(id)
    })?;
    emit_skills_changed(&window);
    Ok(id)
}

#[tauri::command]
pub fn export_skill_folder(
    state: State<'_, AppState>,
    id: String,
    destination: String,
) -> Result<String, String> {
    let (skill, resources) = state.with_room(|room| {
        Ok((
            db::get_skill(&room.conn, &id)?,
            db::list_skill_resources(&room.conn, &id)?,
        ))
    })?;
    let base = PathBuf::from(destination);
    if !base.is_dir() {
        return Err("Choose an existing destination folder.".into());
    }
    let root = base.join(&skill.name);
    if root.exists() {
        return Err(format!(
            "A folder named \"{}\" already exists there.",
            skill.name
        ));
    }
    std::fs::create_dir(&root).map_err(|e| e.to_string())?;
    let write_result = (|| -> Result<(), String> {
        std::fs::write(root.join("SKILL.md"), render_skill_md(&skill))
            .map_err(|e| e.to_string())?;
        for r in resources {
            let rel = normalize_skill_path(&r.path)?;
            let target = root.join(&rel);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(target, r.content).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_dir_all(&root);
        return Err(e);
    }
    Ok(root.to_string_lossy().into_owned())
}

fn skill_compose_prompt(request: &str) -> String {
    format!(
        "Create one portable Agent Skill as JSON only. The skill follows the open Agent Skills folder format: a required SKILL.md plus optional scripts/, references/, assets/, and agents/.\n\n\
         Return this object: {{\"name\":\"lowercase-hyphen-name\",\"description\":\"what it does AND when to use it\",\"instructions\":\"concise imperative Markdown body\",\"resources\":[{{\"path\":\"references/example.md\",\"content\":\"text\"}}]}}.\n\
         Rules: name is at most 64 characters; description is the complete trigger; keep instructions focused and under 500 lines; put detailed knowledge in references; use scripts only for deterministic repeated work; use assets only for output materials; reference every resource from the instructions with a relative path; include no README or installation guide; return text resources only.\n\n\
         The user wants: {request}"
    )
}

#[tauri::command]
pub async fn compose_skill(
    window: tauri::Window,
    state: State<'_, AppState>,
    description: String,
) -> Result<String, String> {
    let request = description.trim();
    if request.is_empty() {
        return Err("Describe the skill you want.".into());
    }
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    let room_model = state.with_room(|room| Ok(model_setting(&room.conn)))?;
    let models = ollama::list_models().await.unwrap_or_default();
    let model = room_model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| default_resolved_model(&None, &models));
    let base = skill_compose_prompt(request);
    let mut last_err = String::new();
    for attempt in 0..2 {
        let prompt = if attempt == 0 {
            base.clone()
        } else {
            format!("{base}\n\nYour previous result was rejected: {last_err}\nReturn corrected JSON only.")
        };
        let raw = generate_text_any_engine(&model, &prompt).await?;
        let value: serde_json::Value = match serde_json::from_str(&ollama::recover_json(&raw)) {
            Ok(v) => v,
            Err(e) => {
                last_err = format!("invalid JSON: {e}");
                continue;
            }
        };
        let name = value["name"].as_str().unwrap_or_default();
        let desc = value["description"].as_str().unwrap_or_default();
        let instructions = value["instructions"].as_str().unwrap_or_default();
        let name = match validate_skill_fields(name, desc, instructions) {
            Ok(n) => n,
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        let mut resources: Vec<(String, Vec<u8>)> = Vec::new();
        let mut bad = None;
        for r in value["resources"]
            .as_array()
            .into_iter()
            .flatten()
            .take(MAX_RESOURCES)
        {
            let path = match r["path"].as_str().map(normalize_skill_path) {
                Some(Ok(p)) => p,
                _ => {
                    bad = Some("a resource had an invalid path".to_string());
                    break;
                }
            };
            let content = r["content"]
                .as_str()
                .unwrap_or_default()
                .as_bytes()
                .to_vec();
            if content.len() > MAX_RESOURCE_BYTES {
                bad = Some(format!("{path} was too large"));
                break;
            }
            resources.push((path, content));
        }
        if let Some(e) = bad {
            last_err = e;
            continue;
        }
        let id = state.with_room(|room| {
            let id = db::create_skill(
                &room.conn,
                &name,
                desc.trim(),
                instructions.trim(),
                false,
                "agent",
            )?;
            for (path, content) in &resources {
                if let Err(e) = db::upsert_skill_resource(
                    &room.conn,
                    &id,
                    path,
                    skill_resource_kind(path),
                    content,
                ) {
                    let _ = db::delete_skill(&room.conn, &id);
                    return Err(e);
                }
            }
            Ok(id)
        })?;
        emit_skills_changed(&window);
        return Ok(id);
    }
    Err(format!(
        "Couldn't compose a valid skill ({last_err}). Try describing it more specifically."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_md_round_trip_keeps_portable_contract() {
        let skill = db::Skill {
            id: "x".into(),
            name: "review-contract".into(),
            description: "Review contracts when asked about legal terms".into(),
            instructions: "# Review\n\nRead `references/policy.md`.".into(),
            enabled: true,
            created_by: "user".into(),
            created_at: "".into(),
            updated_at: "".into(),
        };
        let text = render_skill_md(&skill);
        let (name, desc, body) = parse_skill_md(&text).unwrap();
        assert_eq!(name, skill.name);
        assert_eq!(desc, skill.description);
        assert_eq!(body, skill.instructions);
    }

    #[test]
    fn paths_cannot_escape_or_replace_skill_md() {
        assert!(normalize_skill_path("references/policy.md").is_ok());
        for bad in ["../secret", "/tmp/x", "scripts/../../x", "SKILL.md"] {
            assert!(normalize_skill_path(bad).is_err(), "{bad}");
        }
    }
}
