//! Wave 4a (Idea 2): the LLM graph workflow engine. A `WorkflowDef` is a small
//! DAG of nodes from a curated palette (generate / summarize_file / file_pass /
//! agent_run / save_file / condition). `compile_workflow` topo-sorts it into the
//! ADD-30 `Step` plan (dense, dependency-ordered ids), and `execute_workflow_step`
//! dispatches each node to the sidecar's stateless endpoints and the jobs runner.
//! All orchestration is deterministic Rust on the persisted/checkpointed/resumable
//! job runner — no dynamic LangGraph composition.
//!
//! Conditional edges (v1): `run_plan` is untouched. A step whose incoming edges
//! are all DEAD (a skipped/missing parent, or a condition-branch mismatch) writes
//! a `{skipped:true}` artifact and returns Ok — so skip propagates transitively,
//! `done` stays a valid prefix, and resume keeps working.

use super::*;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;

// ---------------------------------------------------------------- definition

fn default_version() -> u32 {
    1
}

/// The immutable workflow definition: a node palette + edges.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDef {
    #[serde(default = "default_version")]
    pub version: u32,
    pub nodes: Vec<WorkflowNode>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowNode {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(flatten)]
    pub kind: NodeKind,
}

/// A file-choosing selector shared by summarize_file / file_pass nodes. `type` is
/// newest | all | name_like | missing_summary | since_last_run | run_input.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FileSelector {
    #[serde(rename = "type", default = "sel_newest")]
    pub kind: String,
    #[serde(default)]
    pub pattern: Option<String>,
}
fn sel_newest() -> String {
    "newest".into()
}

fn default_mode() -> String {
    "merge".into()
}
fn default_format() -> String {
    "html".into()
}
fn default_save_mode() -> String {
    "create".into()
}
fn default_script_mode() -> String {
    "import".into()
}
fn default_merge_mode() -> String {
    "concat".into()
}
fn default_vote_mode() -> String {
    "concat".into()
}
fn default_samples() -> u32 {
    3
}
fn default_refine_rounds() -> u32 {
    2
}
fn default_max_workers() -> u32 {
    4
}

/// The node palette. `kind` is the discriminant; each variant carries its params.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NodeKind {
    /// One model call. `model` = "" / "auto" (per-run resolve) | "local" | "cloud"
    /// | an explicit name. Prompt supports `{{input}}` (live parent artifacts),
    /// `{{files}}` (one-liner inventory), `{{date}}`.
    Generate {
        prompt: String,
        #[serde(default)]
        model: String,
    },
    /// Cache a one-liner for the selected file(s) (missing_summary summarizes ALL
    /// still-missing files — subsumes idea 8's auto-index trigger).
    SummarizeFile {
        #[serde(default)]
        select: FileSelector,
    },
    /// A real, durable child file_pass over one selected file.
    FilePass {
        #[serde(default)]
        select: FileSelector,
        #[serde(default)]
        instruction: String,
        #[serde(default = "default_mode")]
        mode: String,
    },
    /// One headless agent turn (tools available; never streamed into the chat).
    AgentRun { question: String },
    /// Write the pipeline's output into the room as a new file.
    SaveFile {
        name_template: String,
        #[serde(default = "default_format")]
        format: String,
        #[serde(default = "default_save_mode")]
        mode: String,
    },
    /// A deterministic branch over the JOINED live input. `op` = contains |
    /// not_contains | is_empty | not_empty | new_files_since_last_run. Its
    /// artifact records branch then|else.
    ///
    /// There is deliberately no `input` field: the subject is always the live
    /// upstream text, so the empty `input: ""` the step editor used to write was
    /// shown by no screen, read by no code, and saved into every workflow file.
    /// Unknown keys are ignored on load, so old definitions still parse.
    Condition {
        op: String,
        #[serde(default)]
        value: Option<String>,
    },
    /// Wave 5 (Idea 13): run a `.py`/`.js` room script in a throwaway workspace,
    /// importing its declared + new outputs back into the room. `file` is the
    /// script's file id (or a name). The consent hash lives in the plan snapshot.
    ///
    /// `mode` = "import" (default, the Wave-5 behavior: the artifact is the run
    /// report JSON) | "transform" (a first-class PIPE STAGE: the upstream
    /// `{{input}}` is fed to the script's STDIN and its STDOUT becomes the step
    /// artifact, so a script drops into the dataflow between LLM nodes — the
    /// "deterministic step" a workflow reaches for). Imported files land either
    /// way.
    ScriptRun {
        file: String,
        #[serde(default = "default_script_mode")]
        mode: String,
    },
    // ---- richer palette (the pattern nodes) ----
    /// A deterministic text transform on the joined input — no model call. `op` =
    /// append | prepend | replace | upper | lower | trim | truncate | strip_html.
    /// `find`/`value` carry the op's operands. The "more deterministic steps" a
    /// workflow should prefer over an LLM call for mechanical work.
    Transform {
        op: String,
        #[serde(default)]
        find: Option<String>,
        #[serde(default)]
        value: Option<String>,
    },
    /// A fan-in reducer: combine EVERY live incoming branch deterministically.
    /// `mode` = concat (join by `separator`, default a blank line) | dedupe_lines
    /// | numbered. The explicit merge point for parallel branches.
    Merge {
        #[serde(default = "default_merge_mode")]
        mode: String,
        #[serde(default)]
        separator: Option<String>,
    },
    /// Deterministic HTTP GET of `url` (SSRF-guarded, readable-text extracted),
    /// its text the step artifact. `url` supports `{{input}}`/`{{date}}`.
    HttpFetch { url: String },
    /// Structured output: pull named `fields` out of the input as a JSON object
    /// (schema-constrained `/generate`). The augmented-LLM foundation that lets a
    /// downstream condition/code gate branch on machine-readable values.
    Extract {
        fields: Vec<String>,
        #[serde(default)]
        model: String,
    },
    /// Routing (fuzzy classifier): the model picks ONE of `labels` for the input;
    /// the chosen label is the taken branch (edges carry `branch: <label>`), so a
    /// route fans to N specialized handlers the way `condition` fans to then/else.
    Route {
        #[serde(default)]
        prompt: String,
        labels: Vec<String>,
        #[serde(default)]
        model: String,
    },
    /// Parallelization–voting: run the same `prompt` `samples` times and aggregate.
    /// `mode` = concat (label each sample) | majority (most common trimmed answer).
    Vote {
        prompt: String,
        #[serde(default)]
        model: String,
        #[serde(default = "default_samples")]
        samples: u32,
        #[serde(default = "default_vote_mode")]
        mode: String,
    },
    /// Parallelization–sectioning over a file set: run `instruction` against EACH
    /// selected file and join the results (fixes file_pass/`all` taking only the
    /// first file).
    ForEachFile {
        #[serde(default)]
        select: FileSelector,
        instruction: String,
        #[serde(default)]
        model: String,
    },
    /// Evaluator-optimizer: generate → evaluate against `rubric` → revise, looping
    /// up to `max_rounds` or until the evaluator passes. The one pattern that needs
    /// a bounded loop, kept a single acyclic step so resume/checkpoint are unchanged.
    Refine {
        prompt: String,
        #[serde(default)]
        rubric: String,
        #[serde(default)]
        model: String,
        #[serde(default = "default_refine_rounds")]
        max_rounds: u32,
    },
    /// Orchestrator-workers: the model decomposes `objective` into a structured
    /// subtask list (unknown until runtime), runs a worker per subtask, then
    /// synthesizes — a dynamic fan-out kept inside one step.
    PlanAndMap {
        objective: String,
        #[serde(default)]
        model: String,
        #[serde(default = "default_max_workers")]
        max_workers: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowEdge {
    pub from: String,
    pub to: String,
    /// Only legal off a condition node: "then" | "else".
    #[serde(default)]
    pub branch: Option<String>,
}

/// Shortcuts extension: where a workflow surfaces. `general` = top bar / library
/// only; `file` = the open-file header, run on that file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum WorkflowBinding {
    General {},
    File {
        #[serde(default)]
        kinds: Vec<String>,
        #[serde(default)]
        exts: Vec<String>,
        #[serde(default)]
        file_id: Option<String>,
    },
}

/// The immutable plan snapshot stored on the jobs row — a later edit of the
/// workflow never corrupts a paused run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowPlan {
    pub workflow_id: String,
    pub workflow_name: String,
    /// manual | schedule | catchup | agent — gates the terminal auto-open (a
    /// scheduled run must never yank the viewer, per the [MINOR] amendment).
    pub trigger: String,
    pub def: WorkflowDef,
    pub resolved_model: String,
    #[serde(default)]
    pub input_file_id: Option<String>,
    /// The previous run's start time — feeds `since_last_run` /
    /// `new_files_since_last_run`.
    #[serde(default)]
    pub prev_run_at: Option<String>,
    /// Wave 5 (Idea 13): per-script-node consent snapshot (script file id →
    /// approved SHA-256 of the script bytes), stamped at ENQUEUE from the just-
    /// granted hash (manual) or the approvals file (scheduled). The executor re-
    /// hashes the script and PARKS on mismatch, so a mid-run edit never runs.
    #[serde(default)]
    pub script_consents: std::collections::HashMap<String, String>,
    pub steps: Vec<Step>,
}

/// One workflow step's artifact.
#[derive(Debug, Default, Serialize, Deserialize)]
struct WfArtifact {
    #[serde(default)]
    result: String,
    #[serde(default)]
    skipped: bool,
    /// condition nodes: the taken branch.
    #[serde(default)]
    branch: Option<String>,
    /// save_file / file_pass: the written file id (idempotent re-execution).
    #[serde(default)]
    file_id: Option<String>,
    /// The node's human name + kind, stamped at store time so the run-history
    /// view can label each step by its node (not just "Step N") — the compiled
    /// step order isn't the def order, so the frontend can't derive this itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    node_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    node_kind: Option<String>,
}

// ---------------------------------------------------------------- validation

const NODE_KINDS: &[&str] = &[
    "generate",
    "summarize_file",
    "file_pass",
    "agent_run",
    "save_file",
    "condition",
    "script_run",
    "transform",
    "merge",
    "http_fetch",
    "extract",
    "route",
    "vote",
    "for_each_file",
    "refine",
    "plan_and_map",
];
const TRANSFORM_OPS: &[&str] = &[
    "append",
    "prepend",
    "replace",
    "upper",
    "lower",
    "trim",
    "truncate",
    "strip_html",
];
const MERGE_MODES: &[&str] = &["concat", "dedupe_lines", "numbered"];
const SCRIPT_MODES: &[&str] = &["import", "transform"];
const VOTE_MODES: &[&str] = &["concat", "majority"];
const FILE_SELECTORS: &[&str] = &[
    "newest",
    "all",
    "name_like",
    "missing_summary",
    "since_last_run",
    "run_input",
];
const CONDITION_OPS: &[&str] = &[
    "contains",
    "not_contains",
    "is_empty",
    "not_empty",
    "new_files_since_last_run",
];

/// True when a node reads the run's input file (requires a file binding).
fn selector_is_run_input(sel: &FileSelector) -> bool {
    sel.kind == "run_input"
}

fn node_uses_run_input(node: &WorkflowNode) -> bool {
    match &node.kind {
        NodeKind::SummarizeFile { select }
        | NodeKind::FilePass { select, .. }
        | NodeKind::ForEachFile { select, .. } => selector_is_run_input(select),
        _ => false,
    }
}

/// True if any node in the def reads the run's input file.
pub fn def_uses_run_input(def: &WorkflowDef) -> bool {
    def.nodes.iter().any(node_uses_run_input)
}

/// Upper bounds on a definition. The assistant writes workflows itself, so a
/// runaway one would save and queue with no warning at all; these are far above
/// anything a real workflow needs and exist only to make "runaway" visible.
const MAX_NODES: usize = 60;
const MAX_EDGES: usize = 240;
/// Longest a single node's free text (prompt / instruction / objective) may be.
const MAX_NODE_TEXT: usize = 20_000;

/// The free text a node carries, for the length cap. Templates only — never a
/// name, id or op.
fn node_text_fields(kind: &NodeKind) -> Vec<&str> {
    match kind {
        NodeKind::Generate { prompt, .. } => vec![prompt.as_str()],
        NodeKind::AgentRun { question } => vec![question.as_str()],
        NodeKind::Vote { prompt, .. } => vec![prompt.as_str()],
        NodeKind::Route { prompt, .. } => vec![prompt.as_str()],
        NodeKind::Refine { prompt, rubric, .. } => vec![prompt.as_str(), rubric.as_str()],
        NodeKind::PlanAndMap { objective, .. } => vec![objective.as_str()],
        NodeKind::FilePass { instruction, .. } => vec![instruction.as_str()],
        NodeKind::ForEachFile { instruction, .. } => vec![instruction.as_str()],
        _ => Vec::new(),
    }
}

/// How hard to check a definition.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Rigor {
    /// Everything — the gate on save/update and the canvas's live check. A new
    /// or edited definition must satisfy every rule we know.
    Saving,
    /// Only the rules that have ALWAYS been enforced — the gate on starting a
    /// run. Rules learned after a workflow was written are advice for its
    /// author, not grounds to stop it dead: nothing migrates old definitions,
    /// and a SCHEDULED start that fails is invisible (scheduler.rs just
    /// advances `next_run_at` — no run row, no error, no notification), so a
    /// newly-strict rule at run time reads as an automation that quietly
    /// stopped months after the user set it up. Each grandfathered rule below
    /// says what the old behaviour was; all of them still block a SAVE, which
    /// is where the user is looking.
    Running,
}

/// Validate a definition, returning a list of model-fixable sentences (empty =
/// valid). Checks unknown kinds, per-kind params, duplicate/dangling ids, edge
/// refs, branch legality, size limits, and a Kahn topo sort that NAMES a cycle.
/// The SAVE-time gate — see `validate_runnable` for the run-time one.
pub fn validate_definition(def: &WorkflowDef) -> Result<(), Vec<String>> {
    validate_inner(def, Rigor::Saving)
}

/// The RUN-time gate: everything structural (unknown kinds and selectors,
/// dangling edges, illegal branch labels, cycles), minus the rules a definition
/// written by an earlier version could not have known about. See `Rigor`.
pub fn validate_runnable(def: &WorkflowDef) -> Result<(), Vec<String>> {
    validate_inner(def, Rigor::Running)
}

fn validate_inner(def: &WorkflowDef, rigor: Rigor) -> Result<(), Vec<String>> {
    let saving = rigor == Rigor::Saving;
    let mut errs: Vec<String> = Vec::new();
    if def.nodes.is_empty() {
        errs.push("The workflow has no nodes — add at least one step.".into());
        return Err(errs);
    }
    // Size caps: authoring guard-rails ("make runaway visible"), so they bite
    // when a workflow is written. A big one already saved still runs.
    if saving && def.nodes.len() > MAX_NODES {
        errs.push(format!(
            "The workflow has {} steps — the limit is {MAX_NODES}. Split it into smaller workflows.",
            def.nodes.len()
        ));
        return Err(errs);
    }
    if saving && def.edges.len() > MAX_EDGES {
        errs.push(format!(
            "The workflow has {} connections — the limit is {MAX_EDGES}.",
            def.edges.len()
        ));
        return Err(errs);
    }
    // Unique ids.
    let mut ids: HashSet<&str> = HashSet::new();
    for n in &def.nodes {
        if n.id.trim().is_empty() {
            errs.push("A node has an empty id — every node needs a unique id.".into());
        } else if !ids.insert(n.id.as_str()) {
            errs.push(format!(
                "Duplicate node id '{}' — ids must be unique.",
                n.id
            ));
        }
        // Same guard-rail shape as the size caps: a long prompt saved before
        // this limit existed (a pasted spec or rubric) still runs.
        if saving {
            for t in node_text_fields(&n.kind) {
                if t.chars().count() > MAX_NODE_TEXT {
                    errs.push(format!(
                        "Node '{}' has instructions longer than {MAX_NODE_TEXT} characters — shorten them.",
                        n.id
                    ));
                    break;
                }
            }
        }
    }
    // Which nodes have something upstream to read (dangling edges excluded —
    // they're reported separately and connect nothing).
    let has_incoming: HashSet<&str> = def
        .edges
        .iter()
        .filter(|e| ids.contains(e.from.as_str()) && ids.contains(e.to.as_str()))
        .map(|e| e.to.as_str())
        .collect();
    // Per-kind param checks.
    let mut condition_ids: HashSet<&str> = HashSet::new();
    // route nodes are branch sources like condition, but their branch labels are
    // the node's own `labels` (not then/else) — collected here for edge legality.
    let mut route_labels: HashMap<&str, Vec<String>> = HashMap::new();
    for n in &def.nodes {
        match &n.kind {
            NodeKind::Generate { prompt, .. } => {
                if prompt.trim().is_empty() {
                    errs.push(format!("Node '{}' (generate) has an empty prompt.", n.id));
                }
            }
            NodeKind::SummarizeFile { select } | NodeKind::FilePass { select, .. } => {
                if !FILE_SELECTORS.contains(&select.kind.as_str()) {
                    errs.push(format!(
                        "Node '{}' has an unknown file selector '{}' — use one of: {}.",
                        n.id,
                        select.kind,
                        FILE_SELECTORS.join(", ")
                    ));
                }
                if select.kind == "name_like"
                    && select.pattern.as_deref().unwrap_or("").trim().is_empty()
                {
                    errs.push(format!(
                        "Node '{}' selects by name but has no pattern.",
                        n.id
                    ));
                }
                // A full-file pass reads ONE file end to end. Pointed at "all"
                // it silently read only the newest — so someone asking for
                // "read all my files thoroughly" got one file. Say so instead.
                // Grandfathered at run time: the step editor still offers "All
                // files" here, so saved workflows carry it, and they have
                // always read the newest — `run_file_pass_node` now names the
                // file it read and counts the ones it didn't.
                if saving && select.kind == "all" && matches!(n.kind, NodeKind::FilePass { .. }) {
                    errs.push(format!(
                        "Node '{}' (file_pass) reads ONE file, so \"all files\" would read only the newest — use a for_each_file step to cover every file, or select newest/name_like/run_input.",
                        n.id
                    ));
                }
            }
            NodeKind::AgentRun { question } => {
                if question.trim().is_empty() {
                    errs.push(format!(
                        "Node '{}' (agent_run) has an empty question.",
                        n.id
                    ));
                }
            }
            NodeKind::SaveFile {
                name_template,
                format,
                mode,
            } => {
                if name_template.trim().is_empty() {
                    errs.push(format!("Node '{}' (save_file) has an empty name.", n.id));
                }
                if !["html", "md"].contains(&format.as_str()) {
                    errs.push(format!(
                        "Node '{}' has an unknown format '{}' — use html or md.",
                        n.id, format
                    ));
                }
                if !["create", "overwrite", "append"].contains(&mode.as_str()) {
                    errs.push(format!(
                        "Node '{}' has an unknown save mode '{}' — use create, overwrite or append.",
                        n.id, mode
                    ));
                }
            }
            NodeKind::Condition { op, value } => {
                condition_ids.insert(n.id.as_str());
                if !CONDITION_OPS.contains(&op.as_str()) {
                    errs.push(format!(
                        "Node '{}' has an unknown condition '{}' — use one of: {}.",
                        n.id,
                        op,
                        CONDITION_OPS.join(", ")
                    ));
                }
                // An empty "contains" needle matches EVERY text, so the branch
                // is decided before it is asked — always then, always else.
                // Grandfathered at run time: that is a pointless workflow, not
                // a broken one, and it has always taken the same branch.
                if saving
                    && matches!(op.as_str(), "contains" | "not_contains")
                    && value.as_deref().unwrap_or("").trim().is_empty()
                {
                    errs.push(format!(
                        "Node '{}' checks whether the text contains something but no text was given — type what to look for.",
                        n.id
                    ));
                }
                // The subject is the joined upstream result, so a text check
                // with nothing wired into it reads an empty string forever.
                // Grandfathered at run time for the same reason as the empty
                // needle: constant, but it has always been constant.
                if saving
                    && matches!(
                        op.as_str(),
                        "contains" | "not_contains" | "is_empty" | "not_empty"
                    )
                    && !has_incoming.contains(n.id.as_str())
                {
                    errs.push(format!(
                        "Node '{}' checks the text coming into it, but nothing runs before it — connect a step to it, or use new_files_since_last_run.",
                        n.id
                    ));
                }
            }
            NodeKind::ScriptRun { file, mode } => {
                if file.trim().is_empty() {
                    errs.push(format!("Node '{}' (script_run) has no script file.", n.id));
                } else if script_lang_of(file).is_none()
                    && extraction::extension_of(file).is_empty()
                {
                    // A bare id (no extension) is fine — it's resolved at run
                    // time; a name WITH an extension must be .py/.js.
                } else if script_lang_of(file).is_none() {
                    errs.push(format!(
                        "Node '{}' points at '{}' — only .py or .js scripts can run.",
                        n.id, file
                    ));
                }
                if !SCRIPT_MODES.contains(&mode.as_str()) {
                    errs.push(format!(
                        "Node '{}' has an unknown script mode '{}' — use import or transform.",
                        n.id, mode
                    ));
                }
            }
            NodeKind::Transform { op, find, value } => {
                if !TRANSFORM_OPS.contains(&op.as_str()) {
                    errs.push(format!(
                        "Node '{}' has an unknown transform '{}' — use one of: {}.",
                        n.id,
                        op,
                        TRANSFORM_OPS.join(", ")
                    ));
                }
                if op == "replace" && find.as_deref().unwrap_or("").is_empty() {
                    errs.push(format!("Node '{}' (replace) needs a `find` string.", n.id));
                }
                if op == "truncate"
                    && value
                        .as_deref()
                        .unwrap_or("")
                        .trim()
                        .parse::<usize>()
                        .is_err()
                {
                    errs.push(format!(
                        "Node '{}' (truncate) needs `value` to be a character count.",
                        n.id
                    ));
                }
            }
            NodeKind::Merge { mode, .. } => {
                if !MERGE_MODES.contains(&mode.as_str()) {
                    errs.push(format!(
                        "Node '{}' has an unknown merge mode '{}' — use one of: {}.",
                        n.id,
                        mode,
                        MERGE_MODES.join(", ")
                    ));
                }
            }
            NodeKind::HttpFetch { url } => {
                if url.trim().is_empty() {
                    errs.push(format!("Node '{}' (http_fetch) has no URL.", n.id));
                }
            }
            NodeKind::Extract { fields, .. } => {
                if fields.iter().all(|f| f.trim().is_empty()) {
                    errs.push(format!(
                        "Node '{}' (extract) lists no fields to pull out.",
                        n.id
                    ));
                }
            }
            NodeKind::Route { labels, .. } => {
                let clean: Vec<String> = labels
                    .iter()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
                if clean.len() < 2 {
                    errs.push(format!(
                        "Node '{}' (route) needs at least two labels to route between.",
                        n.id
                    ));
                }
                route_labels.insert(n.id.as_str(), clean);
            }
            NodeKind::Vote { prompt, mode, .. } => {
                if prompt.trim().is_empty() {
                    errs.push(format!("Node '{}' (vote) has an empty prompt.", n.id));
                }
                if !VOTE_MODES.contains(&mode.as_str()) {
                    errs.push(format!(
                        "Node '{}' has an unknown vote mode '{}' — use concat or majority.",
                        n.id, mode
                    ));
                }
            }
            NodeKind::ForEachFile {
                select,
                instruction,
                ..
            } => {
                if !FILE_SELECTORS.contains(&select.kind.as_str()) {
                    errs.push(format!(
                        "Node '{}' has an unknown file selector '{}' — use one of: {}.",
                        n.id,
                        select.kind,
                        FILE_SELECTORS.join(", ")
                    ));
                }
                if select.kind == "name_like"
                    && select.pattern.as_deref().unwrap_or("").trim().is_empty()
                {
                    errs.push(format!(
                        "Node '{}' selects by name but has no pattern.",
                        n.id
                    ));
                }
                if instruction.trim().is_empty() {
                    errs.push(format!(
                        "Node '{}' (for_each_file) has an empty instruction.",
                        n.id
                    ));
                }
            }
            NodeKind::Refine { prompt, .. } => {
                if prompt.trim().is_empty() {
                    errs.push(format!("Node '{}' (refine) has an empty prompt.", n.id));
                }
            }
            NodeKind::PlanAndMap { objective, .. } => {
                if objective.trim().is_empty() {
                    errs.push(format!(
                        "Node '{}' (plan_and_map) has an empty objective.",
                        n.id
                    ));
                }
            }
        }
    }
    // The `kind` tag is validated by serde at parse time; a defensive check keeps
    // the message actionable if this is ever called on a hand-built def.
    for n in &def.nodes {
        let tag = node_kind_tag(&n.kind);
        if !NODE_KINDS.contains(&tag) {
            errs.push(format!("Node '{}' has an unknown kind '{}'.", n.id, tag));
        }
    }
    // Edge refs + branch legality. A branch label must be then|else and may only
    // come off a condition node, and every edge OFF a condition/route must carry
    // one. (An unwired branch simply dead-ends — skip propagation handles it —
    // so both branches are NOT required.)
    for e in &def.edges {
        if !ids.contains(e.from.as_str()) {
            errs.push(format!("An edge starts from unknown node '{}'.", e.from));
        }
        if !ids.contains(e.to.as_str()) {
            errs.push(format!("An edge points to unknown node '{}'.", e.to));
        }
        // A branch source's outgoing edges MUST each say which outcome they
        // follow: an unlabelled one is live no matter which way the step went,
        // so a route with unlabelled exits runs every handler at once and pays
        // for all of them. The step editor's "Runs after" checkboxes create
        // exactly these, and nothing flagged it.
        //
        // Grandfathered at run time: this is precisely the edge the old "add a
        // step after this one" path and the still-shipping "Runs after"
        // checkbox produce, so refusing to START on it would stop workflows the
        // app itself wrote — silently, on a schedule. Fanning every branch is
        // what those definitions have always done.
        let from_condition = condition_ids.contains(e.from.as_str());
        let from_route = route_labels.contains_key(e.from.as_str());
        if saving && e.branch.is_none() && (from_condition || from_route) {
            errs.push(if from_condition {
                format!(
                    "Edge {}→{} leaves a condition without saying which outcome it follows — set its branch to 'then' or 'else'.",
                    e.from, e.to
                )
            } else {
                format!(
                    "Edge {}→{} leaves a route without saying which label it follows — set its branch to one of route '{}'s labels, or every branch runs at once.",
                    e.from, e.to, e.from
                )
            });
        }
        if let Some(b) = &e.branch {
            // A branch edge comes off a condition (then|else) OR a route (one of
            // its own labels). Skip-propagation matches the artifact branch string
            // to the edge branch either way, so both fan the graph the same.
            if from_condition {
                if !["then", "else"].contains(&b.as_str()) {
                    errs.push(format!(
                        "Edge {}→{} has branch '{}' — a condition only branches 'then' or 'else'.",
                        e.from, e.to, b
                    ));
                }
            } else if from_route {
                if !route_labels[e.from.as_str()].iter().any(|l| l == b) {
                    errs.push(format!(
                        "Edge {}→{} has branch '{}', but route '{}' has no such label.",
                        e.from, e.to, b, e.from
                    ));
                }
            } else {
                errs.push(format!(
                    "Edge {}→{} has a branch, but '{}' is not a condition or route node.",
                    e.from, e.to, e.from
                ));
            }
        }
    }
    // Shortcuts extension: a run_input node requires a file binding — but the
    // binding lives outside the def, so it is cross-checked at save time
    // (validate_with_binding). Here we only topo-check.
    if let Err(cycle) = topo_order(def) {
        errs.push(format!(
            "The workflow has a cycle through: {} — remove an edge so it can run in order.",
            cycle.join(" → ")
        ));
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs)
    }
}

/// Cross-check the def against its binding (a run_input node needs file scope).
pub fn validate_with_binding(
    def: &WorkflowDef,
    binding: &WorkflowBinding,
) -> Result<(), Vec<String>> {
    validate_definition(def)?;
    if def_uses_run_input(def) && !matches!(binding, WorkflowBinding::File { .. }) {
        for n in &def.nodes {
            if node_uses_run_input(n) {
                return Err(vec![format!(
                    "Node '{}' reads the run's input file — set the workflow's binding to file-scoped.",
                    n.id
                )]);
            }
        }
    }
    Ok(())
}

fn node_kind_tag(kind: &NodeKind) -> &'static str {
    match kind {
        NodeKind::Generate { .. } => "generate",
        NodeKind::SummarizeFile { .. } => "summarize_file",
        NodeKind::FilePass { .. } => "file_pass",
        NodeKind::AgentRun { .. } => "agent_run",
        NodeKind::SaveFile { .. } => "save_file",
        NodeKind::Condition { .. } => "condition",
        NodeKind::ScriptRun { .. } => "script_run",
        NodeKind::Transform { .. } => "transform",
        NodeKind::Merge { .. } => "merge",
        NodeKind::HttpFetch { .. } => "http_fetch",
        NodeKind::Extract { .. } => "extract",
        NodeKind::Route { .. } => "route",
        NodeKind::Vote { .. } => "vote",
        NodeKind::ForEachFile { .. } => "for_each_file",
        NodeKind::Refine { .. } => "refine",
        NodeKind::PlanAndMap { .. } => "plan_and_map",
    }
}

/// Kahn topo sort over node ids; `Err(cycle)` names the nodes still stuck.
fn topo_order(def: &WorkflowDef) -> Result<Vec<String>, Vec<String>> {
    let ids: Vec<&str> = def.nodes.iter().map(|n| n.id.as_str()).collect();
    let idset: HashSet<&str> = ids.iter().copied().collect();
    let mut indeg: HashMap<&str, usize> = ids.iter().map(|&i| (i, 0usize)).collect();
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in &def.edges {
        // Ignore edges referencing unknown nodes (already reported by validation).
        if idset.contains(e.from.as_str()) && idset.contains(e.to.as_str()) {
            adj.entry(e.from.as_str()).or_default().push(e.to.as_str());
            *indeg.get_mut(e.to.as_str()).unwrap() += 1;
        }
    }
    // Deterministic order: process ready nodes in their declared order.
    let mut order: Vec<String> = Vec::new();
    let mut ready: Vec<&str> = ids.iter().copied().filter(|i| indeg[i] == 0).collect();
    while let Some(&n) = ready.first() {
        ready.remove(0);
        order.push(n.to_string());
        if let Some(next) = adj.get(n) {
            for &m in next {
                let d = indeg.get_mut(m).unwrap();
                *d -= 1;
                if *d == 0 {
                    ready.push(m);
                }
            }
        }
    }
    if order.len() == ids.len() {
        Ok(order)
    } else {
        Err(indeg
            .iter()
            .filter(|(_, &d)| d > 0)
            .map(|(&i, _)| i.to_string())
            .collect())
    }
}

// ---------------------------------------------------------------- compiler

/// Resolve a node's model choice to (model_name, lane). Mirrors
/// `resolve_pass_engine`'s doctrine — engine parity: "auto" and a literal
/// honor whatever the user chose, INCLUDING external CLIs (the sidecar's
/// external backend runs them); "local" stays a hard local pick; "cloud"
/// prefers an installed `:cloud` proxy. Lane = remote engines → Cloud.
fn resolve_node_model(
    choice: &str,
    room_model: &Option<String>,
    models: &[String],
) -> (String, Lane) {
    let name = match choice.trim() {
        "" | "auto" => room_model.clone().unwrap_or_else(|| best_default(models)),
        "local" => best_local_default(models),
        "cloud" => models
            .iter()
            .find(|m| is_cloud_model(m))
            .cloned()
            .unwrap_or_else(|| best_default(models)),
        literal => literal.to_string(),
    };
    let lane = if is_cloud_model(&name) || is_external_engine(&name) {
        Lane::Cloud
    } else {
        Lane::LocalLlm
    };
    (name, lane)
}

/// Compile a validated def into a dense, dependency-ordered `Step` plan. Each
/// step's params carry the node, its resolved model, and its incoming edges (so
/// the executor is self-contained per step — the immutable-snapshot doctrine).
pub fn compile_workflow(
    def: &WorkflowDef,
    room_model: &Option<String>,
    models: &[String],
) -> Result<Vec<Step>, Vec<String>> {
    // The RUN-time gate: a definition already on disk must still start. Every
    // save path validates strictly first (`validate_with_binding`), so an
    // authoring mistake is still caught where it can be fixed.
    validate_runnable(def)?;
    let order = topo_order(def).map_err(|c| vec![format!("cycle through {}", c.join(" → "))])?;
    // node id -> step index (dense, topo order).
    let step_of: HashMap<&str, usize> = order
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let node_of: HashMap<&str, &WorkflowNode> =
        def.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut steps: Vec<Step> = Vec::with_capacity(order.len());
    for (idx, nid) in order.iter().enumerate() {
        let node = node_of[nid.as_str()];
        let incoming: Vec<serde_json::Value> = def
            .edges
            .iter()
            .filter(|e| &e.to == nid)
            .filter_map(|e| {
                step_of
                    .get(e.from.as_str())
                    .map(|&p| serde_json::json!({ "parent": p, "branch": e.branch }))
            })
            .collect();
        let depends_on: Vec<usize> = incoming
            .iter()
            .filter_map(|i| i["parent"].as_u64().map(|v| v as usize))
            .collect();
        let (model, lane) = match &node.kind {
            NodeKind::Generate { model, .. }
            | NodeKind::Extract { model, .. }
            | NodeKind::Route { model, .. }
            | NodeKind::Vote { model, .. }
            | NodeKind::ForEachFile { model, .. }
            | NodeKind::Refine { model, .. }
            | NodeKind::PlanAndMap { model, .. } => resolve_node_model(model, room_model, models),
            NodeKind::SummarizeFile { .. }
            | NodeKind::FilePass { .. }
            | NodeKind::AgentRun { .. } => resolve_node_model("auto", room_model, models),
            // Deterministic, no model call — the CPU lane (fans out to 4).
            NodeKind::SaveFile { .. }
            | NodeKind::Condition { .. }
            | NodeKind::ScriptRun { .. }
            | NodeKind::Transform { .. }
            | NodeKind::Merge { .. }
            | NodeKind::HttpFetch { .. } => (String::new(), Lane::Cpu),
        };
        steps.push(Step {
            id: idx,
            lane,
            kind: "workflow_node".into(),
            params: serde_json::json!({
                "node": node,
                "model": if model.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(model) },
                "incoming": incoming,
            }),
            depends_on,
        });
    }
    Ok(steps)
}

/// The resolved default model for a def (for display/snapshot).
pub fn default_resolved_model(room_model: &Option<String>, models: &[String]) -> String {
    resolve_node_model("auto", room_model, models).0
}

// ---------------------------------------------------------------- executor

/// A headless agent-turn runner, injected by the concrete spawner so the
/// generic executor stays mock-drivable (the agent_run arm needs concrete
/// window/state types the mock harness can't produce; the planned e2e avoids it).
pub type AgentRunFn = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> + Send + Sync,
>;

fn load_wf_artifact(conn: &Connection, job_id: &str, step_id: usize) -> Option<WfArtifact> {
    db::get_job_artifact(conn, job_id, step_id).and_then(|s| serde_json::from_str(&s).ok())
}

/// Pure liveness rule for one incoming edge: a parent is live iff its artifact
/// exists and is not skipped, and (the edge has no branch, or the parent is a
/// condition whose taken branch equals the edge's). A MISSING parent artifact is
/// NOT live (same as skipped). Unit-tested.
fn edge_is_live(parent: Option<&WfArtifact>, branch: &Option<String>) -> bool {
    match parent {
        Some(a) if !a.skipped => match branch {
            Some(b) => a.branch.as_deref() == Some(b.as_str()),
            None => true,
        },
        _ => false,
    }
}

/// Pure condition evaluation → true = "then" branch. Unit-tested.
fn eval_condition(op: &str, subject: &str, value: &Option<String>, new_files: i64) -> bool {
    let needle = value.clone().unwrap_or_default().to_lowercase();
    match op {
        "contains" => subject.to_lowercase().contains(&needle),
        "not_contains" => !subject.to_lowercase().contains(&needle),
        "is_empty" => subject.trim().is_empty(),
        "not_empty" => !subject.trim().is_empty(),
        "new_files_since_last_run" => new_files > 0,
        _ => false,
    }
}

fn store_wf_artifact(
    conn: &Connection,
    job_id: &str,
    step_id: usize,
    a: &WfArtifact,
) -> Result<(), String> {
    db::put_job_artifact(
        conn,
        job_id,
        step_id,
        &serde_json::to_string(a).map_err(|e| e.to_string())?,
    )
}

fn emit_workflow_node<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    job_id: &str,
    workflow_id: &str,
    node_id: &str,
    status: &str,
    peek: Option<&str>,
) {
    use tauri::Emitter;
    if let Some(w) = crate::main_window(app) {
        let _ = w.emit(
            "workflow-node",
            serde_json::json!({
                "jobId": job_id,
                "workflowId": workflow_id,
                "nodeId": node_id,
                "status": status,
                "peek": peek.map(|p| p.chars().take(200).collect::<String>()),
            }),
        );
    }
}

/// Interpolate `{{input}}`, `{{files}}`, `{{date}}` in a template. Room-pinned.
///
/// `{{input}}` is substituted LAST, deliberately. It carries model output and
/// file text, so expanding it first meant a document (or an AI reply) that
/// happened to contain the marker `{{files}}` had the room's whole file
/// inventory pasted into the next step's prompt — a template placeholder is a
/// thing the WORKFLOW AUTHOR writes, never something upstream text can conjure.
fn interpolate<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    room_path: &str,
    template: &str,
    inputs: &str,
) -> String {
    use tauri::Manager;
    let mut out = template.to_string();
    if out.contains("{{files}}") {
        let files = {
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            guard
                .as_ref()
                .filter(|r| r.path == room_path)
                .and_then(|r| db::list_files_brief(&r.conn).ok())
                .map(|rows| {
                    rows.iter()
                        .map(|(name, _mime, _size, liner)| match liner {
                            Some(l) if !l.trim().is_empty() => format!("- {name}: {l}"),
                            _ => format!("- {name}"),
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        };
        out = out.replace("{{files}}", &files);
    }
    if out.contains("{{date}}") {
        let date = {
            let state = app.state::<AppState>();
            let guard = state.room.lock().unwrap();
            guard
                .as_ref()
                .filter(|r| r.path == room_path)
                .map(|r| db::current_date(&r.conn))
                .unwrap_or_default()
        };
        out = out.replace("{{date}}", &date);
    }
    out.replace("{{input}}", inputs)
}

/// Resolve a file selector to (id, name, mime) rows (room-pinned).
fn resolve_files<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    room_path: &str,
    sel: &FileSelector,
    input_file_id: &Option<String>,
    prev_run_at: &Option<String>,
) -> Result<Vec<(String, String, String)>, String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let guard = state.room.lock().unwrap();
    let room = guard
        .as_ref()
        .filter(|r| r.path == room_path)
        .ok_or("The room this job belongs to is no longer open.")?;
    let conn = &room.conn;
    let rows: Vec<(String, String, String)> = match sel.kind.as_str() {
        "run_input" => {
            let id = input_file_id
                .as_ref()
                .ok_or("this workflow needs a file to run on")?;
            let (name, mime): (String, String) = conn
                .query_row(
                    "SELECT name, coalesce(mime_type,'') FROM files WHERE id = ?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|_| "the file this run was invoked on is no longer in the room")?;
            vec![(id.clone(), name, mime)]
        }
        // newest / all / name_like INCLUDE generated files: in a room whose useful
        // content is AI-authored (dashboards, sheets, research memos), excluding
        // `source='generated'` here matched nothing, so every file-read node returned
        // "No file matched — nothing to read." Only the INCREMENTAL selectors below
        // (since_last_run / missing_summary) still exclude generated, because those
        // drive scheduled runs where a workflow could otherwise re-ingest its own
        // just-saved output in a feedback loop.
        "newest" => query_files(
            conn,
            "SELECT id, name, coalesce(mime_type,'') FROM files \
             ORDER BY created_at DESC LIMIT 1",
            [],
        )?,
        // Same 50-file cap as the other bulk selectors. A file_pass node reads
        // ONE file, so `all` is rejected on it at validation (use for_each_file
        // to cover every file) — every other reader here uses the whole list.
        "all" => query_files(
            conn,
            "SELECT id, name, coalesce(mime_type,'') FROM files \
             ORDER BY created_at DESC LIMIT 50",
            [],
        )?,
        "name_like" => {
            let pat = format!(
                "%{}%",
                like_escape(&sel.pattern.clone().unwrap_or_default().to_lowercase())
            );
            query_files(
                conn,
                "SELECT id, name, coalesce(mime_type,'') FROM files \
                 WHERE lower(name) LIKE ?1 ESCAPE '\\' \
                 ORDER BY created_at DESC LIMIT 20",
                [pat],
            )?
        }
        // missing_summary INCLUDES generated files: summarizing only caches a
        // one-liner into the file's `ai_summary` metadata (never a new file), so
        // there is no feedback loop — and an AI-authored file needs its one-line
        // description just like any other. Excluding generated here meant a room of
        // generated files reported "nothing to summarize" while none got a summary.
        "missing_summary" => query_files(
            conn,
            "SELECT id, name, coalesce(mime_type,'') FROM files \
             WHERE ai_summary IS NULL \
               AND extracted_text IS NOT NULL AND trim(extracted_text) != '' \
             ORDER BY created_at DESC LIMIT 50",
            [],
        )?,
        "since_last_run" => {
            let since = prev_run_at.clone().unwrap_or_default();
            query_files(
                conn,
                "SELECT id, name, coalesce(mime_type,'') FROM files \
                 WHERE source != 'generated' AND created_at > ?1 \
                 ORDER BY created_at DESC LIMIT 50",
                [since],
            )?
        }
        _ => Vec::new(),
    };
    Ok(rows)
}

/// Escape a user-typed "name contains" fragment for SQL LIKE. `_` and `%` are
/// wildcards down there, so an unescaped `q3_report` also matched `q3-report`
/// and `q3xreport` — a workflow running on files the user never meant.
fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn query_files<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params, |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Count source files created after `since` — the `new_files_since_last_run`
/// condition op.
fn count_new_files<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    room_path: &str,
    prev_run_at: &Option<String>,
) -> i64 {
    use tauri::Manager;
    let since = prev_run_at.clone().unwrap_or_default();
    let state = app.state::<AppState>();
    let guard = state.room.lock().unwrap();
    guard
        .as_ref()
        .filter(|r| r.path == room_path)
        .and_then(|r| {
            r.conn
                .query_row(
                    "SELECT count(*) FROM files WHERE source != 'generated' AND created_at > ?1",
                    [since],
                    |row| row.get::<_, i64>(0),
                )
                .ok()
        })
        .unwrap_or(0)
}

// ----------------------------------------------- richer-node helpers

/// Per-file text budget for a for_each_file map — the local model's Job-tier ctx.
const PER_FILE_CHARS: usize = 12_000;

/// The workflow's single LLM entry point: one cancellable `/generate` call with an
/// optional structured-output `format` schema. Every model node (extract / route /
/// vote / for_each_file / refine / plan_and_map) speaks to the same endpoint as
/// the Generate arm, so engine-parity and Stop behave identically across them.
async fn wf_generate(
    model: &str,
    prompt: &str,
    format: Option<serde_json::Value>,
    cancel: &Arc<AtomicBool>,
) -> Result<String, String> {
    let mut body = serde_json::json!({
        "model": model,
        "base_url": ollama::resolved_base_url(),
        "messages": [{ "role": "user", "content": prompt }],
        "keep_alive": KEEP_ALIVE_WARM,
    });
    if let Some(f) = format {
        body["format"] = f;
    }
    match crate::sidecar::sidecar_json_cancellable("/generate", &body, cancel).await {
        Ok(Some(v)) => Ok(v["text"].as_str().unwrap_or_default().to_string()),
        Ok(None) => Err("STOPPED".into()),
        Err(e) => Err(e.sentinel(Some(model))),
    }
}

/// Run one workflow CHAIN node in the sidecar's LangGraph (MIGRATION slice 1,
/// owner decision 2026-07-25: "Rust drives, Python thinks").
///
/// `refine` and `plan_and_map` are the only two node kinds that are multi-call
/// model chains needing NOTHING from the room while they run: `interpolate`
/// resolves `{{files}}`/`{{date}}` against the encrypted DB once, BEFORE the
/// call, and everything after was just `wf_generate`. So they move whole, and
/// Rust keeps what it already owns — the plan, the lane, the interpolation, the
/// wave scheduler and every checkpoint.
///
/// The step boundary does not move, which is why this needs no checkpointer.
/// In-process, a failure at call 6 of 7 aborted the arm, `run_plan` returned
/// `Error` BEFORE `checkpoint(&done)` ran, and resume replayed the step from
/// scratch — calls 1-5 were already thrown away. Bundling the chain behind one
/// POST therefore costs exactly zero durability: the granularity was never
/// finer than the step. `run_plan_discards_a_failed_waves_completed_siblings`
/// pins that contract and this change cannot reach it.
async fn wf_node_value(
    kind: &str,
    model: &str,
    job_id: &str,
    step_id: usize,
    lane: Lane,
    body: serde_json::Value,
    cancel: &Arc<AtomicBool>,
) -> Result<serde_json::Value, String> {
    let run_id = format!("{job_id}:{step_id}");
    let mut payload = serde_json::json!({
        "kind": kind,
        // TOP-LEVEL, deliberately: `sidecar_json` keys `inject_policy` and
        // `inject_provider_runtime` off `body["model"]`, so nesting it would
        // silently drop the privacy door and the Keychain-backed provider
        // credentials on a cloud engine.
        "model": model,
        "base_url": ollama::resolved_base_url(),
        "keep_alive": KEEP_ALIVE_WARM,
        "run_id": run_id,
        // The lane budget, re-imposed INSIDE the step. `plan_dispatch` enforces
        // Lane::LocalLlm => 1 ACROSS steps because "Local model and Whisper are
        // serial (RAM and a single resident model)"; a fan-out inside ONE step
        // would bypass it entirely and let several generations hit a local 4B
        // at once, multiplying resident context.
        "parallel": lane.slots(),
    });
    // Merge the node's own fields UNDER the reserved keys above, never over
    // them. The comment on "model" says exactly why it must stay top-level —
    // `sidecar_json` keys the privacy door and the Keychain-backed provider
    // credentials off `body["model"]` — and a blind `payload[k] = v` would let
    // a future node body named `model` (or `run_id`, or `parallel`) overwrite
    // it silently, which is the failure that comment exists to prevent.
    const RESERVED: &[&str] = &["kind", "model", "base_url", "keep_alive", "run_id", "parallel"];
    if let Some(map) = body.as_object() {
        for (k, v) in map {
            debug_assert!(
                !RESERVED.contains(&k.as_str()),
                "wf_node body key {k:?} would shadow a reserved payload field"
            );
            if !RESERVED.contains(&k.as_str()) {
                payload[k] = v.clone();
            }
        }
    }
    match crate::sidecar::sidecar_json_cancellable_run(
        "/wf_node",
        &payload,
        cancel,
        &run_id,
        crate::sidecar::SIDECAR_CHAIN_TIMEOUT,
    )
    .await
    {
        // The sidecar's own Stop answer, and the host-side one, map to the same
        // sentinel `wf_generate` produced — `spawn_workflow_job` normalises it
        // to Paused, so Stop still parks the job rather than failing it.
        Ok(Some(v)) if v.get("stopped").and_then(|s| s.as_bool()) == Some(true) => {
            Err("STOPPED".into())
        }
        Ok(Some(v)) => Ok(v),
        Ok(None) => Err("STOPPED".into()),
        Err(e) => Err(e.sentinel(Some(model))),
    }
}

/// The common case: a chain node whose whole artifact is its text.
async fn wf_node(
    kind: &str,
    model: &str,
    job_id: &str,
    step_id: usize,
    lane: Lane,
    body: serde_json::Value,
    cancel: &Arc<AtomicBool>,
) -> Result<String, String> {
    let v = wf_node_value(kind, model, job_id, step_id, lane, body, cancel).await?;
    Ok(v["result"].as_str().unwrap_or_default().to_string())
}

/// Pure deterministic text transform (unit-tested).
fn apply_transform(op: &str, find: &Option<String>, value: &Option<String>, input: &str) -> String {
    let v = value.clone().unwrap_or_default();
    match op {
        "append" => format!("{input}{v}"),
        "prepend" => format!("{v}{input}"),
        "replace" => match find {
            Some(f) if !f.is_empty() => input.replace(f.as_str(), &v),
            _ => input.to_string(),
        },
        "upper" => input.to_uppercase(),
        "lower" => input.to_lowercase(),
        "trim" => input.trim().to_string(),
        "truncate" => input.chars().take(v.trim().parse().unwrap_or(0)).collect(),
        "strip_html" => extraction::strip_html(input),
        _ => input.to_string(),
    }
}

/// Pure fan-in reducer over the live incoming branch results (unit-tested).
fn apply_merge(mode: &str, separator: &Option<String>, inputs: &[String]) -> String {
    let sep = separator.clone().unwrap_or_else(|| "\n\n".into());
    match mode {
        "numbered" => inputs
            .iter()
            .enumerate()
            .map(|(i, s)| format!("{}. {}", i + 1, s))
            .collect::<Vec<_>>()
            .join(&sep),
        "dedupe_lines" => {
            let mut seen: HashSet<String> = HashSet::new();
            let mut out: Vec<String> = Vec::new();
            for block in inputs {
                for line in block.lines() {
                    if seen.insert(line.to_string()) {
                        out.push(line.to_string());
                    }
                }
            }
            out.join("\n")
        }
        _ => inputs.join(&sep), // "concat"
    }
}

/// Pure vote aggregation (unit-tested): majority = most common trimmed sample
/// (ties → the earliest); concat = every sample, labeled.
// `aggregate_votes` lived here and is DELETED (2026-07-25, MIGRATION slice 2).
// The vote arm now runs in the sidecar, so this was a second implementation of
// something Python already owns — exactly the "written twice" case. Its four
// assertions (majority wins, a TIE goes to the earliest sample, concat labels
// samples from 1, empty in -> empty out) moved verbatim into
// `sidecar/tests/test_wf_nodes.py::test_aggregate_votes_matches_the_rust_rules`.
// `build_extract_schema`, `route_schema_of` and `pick_route_label` lived here
// and are DELETED (2026-07-25, MIGRATION slice 3). The extract and route arms
// run in the sidecar now, so these were second implementations of things Python
// owns. Their assertions moved verbatim into
// `sidecar/tests/test_wf_nodes.py::test_route_label_pick_is_robust` and
// `::test_extract_schema_requires_each_field`.
/// How one step ended, for the pipeline diagram.
enum NodeReport {
    /// Every incoming edge was dead — the step wrote its `{skipped:true}`
    /// artifact and did nothing.
    Skipped,
    /// The step ran; the string is its result, for the node's peek.
    Done(String),
}

/// Execute one workflow step and mark the node on the live pipeline diagram.
///
/// The badge is decided HERE and nowhere else. The work itself is full of `?`
/// paths — a room closed mid-run, a Stop inside a per-file loop, a store that
/// failed — and each one used to return straight past the diagram, so the box
/// either lost its badge when the run ended or span forever. One funnel means a
/// step that broke is always the box that turns red.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_workflow_step<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    job_id: &str,
    room_path: &str,
    plan: &WorkflowPlan,
    step: &Step,
    cancel: &Arc<AtomicBool>,
    published: &std::sync::Mutex<Option<FileMeta>>,
    agent_run: &AgentRunFn,
) -> Result<(), String> {
    let node: WorkflowNode = serde_json::from_value(step.params["node"].clone())
        .map_err(|_| "this workflow step is unreadable".to_string())?;
    emit_workflow_node(app, job_id, &plan.workflow_id, &node.id, "running", None);
    match run_workflow_node(
        app, job_id, room_path, plan, step, cancel, published, agent_run, &node,
    )
    .await
    {
        Ok(NodeReport::Skipped) => {
            emit_workflow_node(app, job_id, &plan.workflow_id, &node.id, "skipped", None);
            Ok(())
        }
        Ok(NodeReport::Done(result)) => {
            let peek = if result.is_empty() { None } else { Some(result.as_str()) };
            emit_workflow_node(app, job_id, &plan.workflow_id, &node.id, "done", peek);
            Ok(())
        }
        Err(e) => {
            // Single funnel for EVERY node kind — clean an empty-generation /
            // cloud-quota failure into one actionable line here, so agent_run
            // (which passes its error through raw) reads the same as generate.
            let e = crate::sidecar::humanize_empty_generation(&e).unwrap_or(e);
            emit_workflow_node(app, job_id, &plan.workflow_id, &node.id, "error", Some(&e));
            Err(e)
        }
    }
}

/// The step's actual work. Generic over the runtime so the mock-app harness can
/// drive the deterministic nodes; the agent_run arm is injected via `agent_run`
/// so the executor core stays mock-drivable. Room-pinned throughout. Emits
/// nothing — its caller owns the diagram.
#[allow(clippy::too_many_arguments)]
async fn run_workflow_node<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    job_id: &str,
    room_path: &str,
    plan: &WorkflowPlan,
    step: &Step,
    cancel: &Arc<AtomicBool>,
    published: &std::sync::Mutex<Option<FileMeta>>,
    agent_run: &AgentRunFn,
    node: &WorkflowNode,
) -> Result<NodeReport, String> {
    use tauri::Manager;
    let model = step.params["model"].as_str().map(|s| s.to_string());
    let incoming: Vec<(usize, Option<String>)> = step.params["incoming"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|i| {
                    i["parent"]
                        .as_u64()
                        .map(|p| (p as usize, i["branch"].as_str().map(|s| s.to_string())))
                })
                .collect()
        })
        .unwrap_or_default();

    // Liveness: gather live parents' results (a MISSING/skipped parent, or a
    // branch mismatch, is not live). A non-root node with no live incoming edge
    // is skipped (dead subgraph) — skip propagates transitively.
    let (live_inputs, any_incoming, live_present): (Vec<String>, bool, bool) = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let room = guard
            .as_ref()
            .filter(|r| r.path == room_path)
            .ok_or("The room this job belongs to is no longer open.")?;
        let mut inputs: Vec<String> = Vec::new();
        let mut live_present = false;
        for (parent, branch) in &incoming {
            let a = load_wf_artifact(&room.conn, job_id, *parent);
            if edge_is_live(a.as_ref(), branch) {
                live_present = true;
                if let Some(a) = &a {
                    if !a.result.trim().is_empty() {
                        inputs.push(a.result.clone());
                    }
                }
            }
        }
        (inputs, !incoming.is_empty(), live_present)
    };
    if any_incoming && !live_present {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
            store_wf_artifact(
                &r.conn,
                job_id,
                step.id,
                &WfArtifact {
                    skipped: true,
                    node_label: Some(node.label.clone()),
                    node_kind: Some(node_kind_tag(&node.kind).to_string()),
                    ..Default::default()
                },
            )?;
        }
        return Ok(NodeReport::Skipped);
    }

    let inputs_joined = live_inputs.join("\n\n");

    // Idempotency: a save_file / file_pass node that already published (crash
    // between completion and checkpoint) reuses its recorded file instead of
    // inserting a duplicate.
    let existing = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        guard
            .as_ref()
            .filter(|r| r.path == room_path)
            .and_then(|r| load_wf_artifact(&r.conn, job_id, step.id))
    };

    let result: Result<WfArtifact, String> = match &node.kind {
        NodeKind::Generate { prompt, .. } => {
            let prompt = interpolate(app, room_path, prompt, &inputs_joined);
            let model = model.clone().unwrap_or_else(|| plan.resolved_model.clone());
            let body = serde_json::json!({
                "model": model,
                "base_url": ollama::resolved_base_url(),
                "messages": [{ "role": "user", "content": prompt }],
                "keep_alive": KEEP_ALIVE_WARM,
            });
            match crate::sidecar::sidecar_json_cancellable("/generate", &body, cancel).await {
                Ok(Some(v)) => Ok(WfArtifact {
                    result: v["text"].as_str().unwrap_or_default().to_string(),
                    ..Default::default()
                }),
                Ok(None) => Err("STOPPED".into()),
                Err(e) => Err(e.sentinel(Some(&model))),
            }
        }
        NodeKind::SummarizeFile { select } => {
            let model = model.clone().unwrap_or_else(|| plan.resolved_model.clone());
            let files = resolve_files(
                app,
                room_path,
                select,
                &plan.input_file_id,
                &plan.prev_run_at,
            )?;
            if files.is_empty() {
                Ok(WfArtifact {
                    result: "No files matched — nothing to summarize.".into(),
                    ..Default::default()
                })
            } else {
                let mut lines: Vec<String> = Vec::new();
                for (id, name, mime) in &files {
                    if cancel.load(Ordering::SeqCst) {
                        return Err("STOPPED".into());
                    }
                    let full = {
                        let state = app.state::<AppState>();
                        let guard = state.room.lock().unwrap();
                        guard
                            .as_ref()
                            .filter(|r| r.path == room_path)
                            .and_then(|r| db::get_file_extracted_text(&r.conn, id))
                    };
                    let Some(full) = full.filter(|t| !t.trim().is_empty()) else {
                        continue;
                    };
                    // The SHARED sentinel policy (jobs.rs::summarize_one_liner),
                    // not a second copy of it: a file the model can't describe
                    // is marked with the '' sentinel so it leaves the
                    // missing-summary set instead of costing one pointless
                    // model call every time this workflow ticks, and a file
                    // that simply fails no longer aborts the whole run and
                    // strands every later file without a description.
                    let cache = |liner: &str| {
                        let state = app.state::<AppState>();
                        let guard = state.room.lock().unwrap();
                        if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                            let _ = db::set_file_ai_summary(&r.conn, id, liner);
                        }
                    };
                    match summarize_one_liner(&model, name, mime, &full).await {
                        LinerOutcome::Cached(liner) => {
                            cache(&liner);
                            lines.push(format!("{name}: {liner}"));
                        }
                        LinerOutcome::Stuck => {
                            cache("");
                            lines.push(format!("{name}: (no description could be written)"));
                        }
                        // The CALL failed (timeout / quota / a 502), which says
                        // nothing about the file — cache nothing, so this file
                        // stays in the missing set and the next run retries it.
                        // Caching the sentinel here would have been permanent:
                        // every retry selector matches NULL only.
                        LinerOutcome::Failed(_) => {
                            lines.push(format!("{name}: (not described this run — trying again next time)"));
                        }
                        LinerOutcome::Hard(e) => return Err(e),
                    }
                }
                Ok(WfArtifact {
                    result: lines.join("\n"),
                    ..Default::default()
                })
            }
        }
        NodeKind::FilePass {
            select,
            instruction,
            mode,
        } => {
            // Reuse a prior publish if this node already ran (idempotency).
            if let Some(a) = &existing {
                if a.file_id.is_some() && !a.skipped {
                    Ok(WfArtifact {
                        result: a.result.clone(),
                        file_id: a.file_id.clone(),
                        ..Default::default()
                    })
                } else {
                    run_file_pass_node(
                        app,
                        job_id,
                        room_path,
                        plan,
                        select,
                        instruction,
                        mode,
                        cancel,
                        published,
                    )
                    .await
                }
            } else {
                run_file_pass_node(
                    app,
                    job_id,
                    room_path,
                    plan,
                    select,
                    instruction,
                    mode,
                    cancel,
                    published,
                )
                .await
            }
        }
        NodeKind::AgentRun { question } => {
            let q = interpolate(app, room_path, question, &inputs_joined);
            match agent_run(q).await {
                Ok(text) => Ok(WfArtifact {
                    result: text,
                    ..Default::default()
                }),
                Err(e) => Err(e),
            }
        }
        NodeKind::SaveFile {
            name_template,
            format,
            mode,
        } => save_file_node(
            app,
            room_path,
            name_template,
            format,
            mode,
            &inputs_joined,
            existing.as_ref(),
            published,
            &format!("Workflow saved — {}", plan.workflow_name),
        )
        .map(|(result, file_id)| WfArtifact {
            result,
            file_id: Some(file_id),
            ..Default::default()
        }),
        NodeKind::Condition { op, value, .. } => {
            let new_files = if op == "new_files_since_last_run" {
                count_new_files(app, room_path, &plan.prev_run_at)
            } else {
                0
            };
            let taken = eval_condition(op, &inputs_joined, value, new_files);
            let branch = if taken { "then" } else { "else" };
            Ok(WfArtifact {
                result: format!("branch: {branch}"),
                branch: Some(branch.to_string()),
                ..Default::default()
            })
        }
        NodeKind::ScriptRun { file, mode } => {
            // transform mode makes the script a pipe stage: {{input}} → stdin,
            // stdout → the step artifact (so a downstream node reads the script's
            // output, not the run report). import mode is the Wave-5 behavior.
            let stdin = if mode == "transform" {
                Some(inputs_joined.clone())
            } else {
                None
            };
            run_script_node(
                app, job_id, step.id, room_path, plan, file, mode, stdin, cancel, published,
            )
            .await
        }
        NodeKind::Transform { op, find, value } => Ok(WfArtifact {
            result: apply_transform(op, find, value, &inputs_joined),
            ..Default::default()
        }),
        NodeKind::Merge { mode, separator } => Ok(WfArtifact {
            // Merge reduces the live branches individually, so dedupe/numbered can
            // see each branch (not the pre-joined blob).
            result: apply_merge(mode, separator, &live_inputs),
            ..Default::default()
        }),
        NodeKind::HttpFetch { url } => {
            if cancel.load(Ordering::SeqCst) {
                return Err("STOPPED".into());
            }
            let url = interpolate(app, room_path, url, &inputs_joined);
            match crate::web::fetch_page(&url).await {
                Ok((title, text)) => Ok(WfArtifact {
                    result: format!("{title}\n\n{text}"),
                    ..Default::default()
                }),
                Err(e) => Err(e),
            }
        }
        NodeKind::Extract { fields, .. } => {
            // MIGRATION slice 3: one structured call, run in the sidecar.
            // `build_extract_schema` moved WITH it (and took its Rust
            // assertions along) so the schema is not built in two places.
            let m = model.clone().unwrap_or_else(|| plan.resolved_model.clone());
            let result = wf_node(
                "extract",
                &m,
                job_id,
                step.id,
                step.lane,
                serde_json::json!({ "fields": fields, "context": inputs_joined }),
                cancel,
            )
            .await?;
            Ok(WfArtifact {
                result,
                ..Default::default()
            })
        }

        NodeKind::Route { prompt, labels, .. } => {
            // MIGRATION slice 3. This arm returns a BRANCH as well as text —
            // `compile_workflow` prunes the dead edges from it — so `wf_node`
            // alone is not enough here and the branch is read explicitly.
            let m = model.clone().unwrap_or_else(|| plan.resolved_model.clone());
            let ask = interpolate(app, room_path, prompt, &inputs_joined);
            let v = wf_node_value(
                "route",
                &m,
                job_id,
                step.id,
                step.lane,
                serde_json::json!({
                    "prompt": ask,
                    "labels": labels,
                    "context": inputs_joined,
                }),
                cancel,
            )
            .await?;
            let branch = v["branch"].as_str().map(|s| s.to_string());
            Ok(WfArtifact {
                result: v["result"].as_str().unwrap_or_default().to_string(),
                branch,
                ..Default::default()
            })
        }

        NodeKind::Vote {
            prompt,
            samples,
            mode,
            ..
        } => {
            // MIGRATION slice 2: self-consistency sampling runs as a LangGraph
            // fan-out in the sidecar. Same profile as refine/plan_and_map —
            // `interpolate` once against the encrypted DB HERE, then N model
            // calls that touch nothing. The blocker the analysis named for this
            // arm (majority ties resolve by FIRST-SEEN index, so completion
            // order must not leak in) is closed by the same index-carrying
            // reducer `plan_and_map` uses; `aggregate_votes` is ported verbatim
            // and its Rust unit test stays as the parity anchor.
            let m = model.clone().unwrap_or_else(|| plan.resolved_model.clone());
            let p = interpolate(app, room_path, prompt, &inputs_joined);
            let result = wf_node(
                "vote",
                &m,
                job_id,
                step.id,
                step.lane,
                serde_json::json!({
                    "prompt": p,
                    "mode": mode,
                    "samples": *samples,
                }),
                cancel,
            )
            .await?;
            Ok(WfArtifact {
                result,
                ..Default::default()
            })
        }
        NodeKind::ForEachFile {
            select,
            instruction,
            ..
        } => {
            let m = model.clone().unwrap_or_else(|| plan.resolved_model.clone());
            let files = resolve_files(
                app,
                room_path,
                select,
                &plan.input_file_id,
                &plan.prev_run_at,
            )?;
            if files.is_empty() {
                Ok(WfArtifact {
                    result: "No files matched — nothing to do.".into(),
                    ..Default::default()
                })
            } else {
                let instr = interpolate(app, room_path, instruction, &inputs_joined);
                let mut sections: Vec<String> = Vec::new();
                for (id, name, _mime) in &files {
                    if cancel.load(Ordering::SeqCst) {
                        return Err("STOPPED".into());
                    }
                    let full = {
                        let state = app.state::<AppState>();
                        let guard = state.room.lock().unwrap();
                        guard
                            .as_ref()
                            .filter(|r| r.path == room_path)
                            .and_then(|r| db::get_file_extracted_text(&r.conn, id))
                    };
                    let Some(full) = full.filter(|t| !t.trim().is_empty()) else {
                        continue;
                    };
                    // One file, one model call — so a long file is CLIPPED to
                    // the local model's job-tier window. Say so, in the prompt
                    // and in the section heading: a summary headed with the
                    // file's name otherwise reads as a summary of the whole
                    // thing when it only saw the first few pages.
                    let clipped: String = full.chars().take(PER_FILE_CHARS).collect();
                    let cut = clipped.len() < full.len();
                    let note = if cut {
                        format!(
                            "\n\n(Only the first {PER_FILE_CHARS} characters of this file are \
                             shown — it is longer. Do not describe it as complete.)"
                        )
                    } else {
                        String::new()
                    };
                    let prompt = format!("{instr}\n\nFile: {name}{note}\n\n{clipped}");
                    let r = wf_generate(&m, &prompt, None, cancel).await?;
                    let heading = if cut {
                        format!("## {name}\n\n_Read the first {PER_FILE_CHARS} characters only._")
                    } else {
                        format!("## {name}")
                    };
                    sections.push(format!("{heading}\n\n{}", r.trim()));
                }
                let result = if sections.is_empty() {
                    "No files had readable text.".into()
                } else {
                    sections.join("\n\n")
                };
                Ok(WfArtifact {
                    result,
                    ..Default::default()
                })
            }
        }
        NodeKind::Refine {
            prompt,
            rubric,
            max_rounds,
            ..
        } => {
            // MIGRATION slice 1 (owner decision 2026-07-25, "Rust drives,
            // Python thinks"): the evaluator-optimizer loop now runs as a
            // LangGraph graph in the sidecar. Rust still interpolates against
            // the encrypted DB HERE, before the call — the sidecar never sees a
            // room handle, only finished text.
            let m = model.clone().unwrap_or_else(|| plan.resolved_model.clone());
            let base = interpolate(app, room_path, prompt, &inputs_joined);
            let result = wf_node(
                "refine",
                &m,
                job_id,
                step.id,
                step.lane,
                serde_json::json!({
                    "prompt": base,
                    "rubric": rubric,
                    "max_rounds": *max_rounds,
                }),
                cancel,
            )
            .await?;
            Ok(WfArtifact {
                result,
                ..Default::default()
            })
        }
        NodeKind::PlanAndMap {
            objective,
            max_workers,
            ..
        } => {
            // MIGRATION slice 1: the orchestrator-worker fan-out now runs as a
            // LangGraph graph. A `Lane::Cloud` step gets its workers overlapped
            // 4-wide for free; a local one still serializes exactly as the
            // sequential `for st in &subtasks` loop did, because the lane's slot
            // count rides along in the payload and becomes a semaphore there.
            let m = model.clone().unwrap_or_else(|| plan.resolved_model.clone());
            let obj = interpolate(app, room_path, objective, &inputs_joined);
            let result = wf_node(
                "plan_and_map",
                &m,
                job_id,
                step.id,
                step.lane,
                serde_json::json!({
                    "prompt": obj,
                    "context": inputs_joined,
                    "max_workers": *max_workers,
                }),
                cancel,
            )
            .await?;
            Ok(WfArtifact {
                result,
                ..Default::default()
            })
        }
    };

    let mut artifact = result?;
    artifact.node_label = Some(node.label.clone());
    artifact.node_kind = Some(node_kind_tag(&node.kind).to_string());
    {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let room = guard
            .as_ref()
            .filter(|r| r.path == room_path)
            .ok_or("The room this job belongs to is no longer open.")?;
        store_wf_artifact(&room.conn, job_id, step.id, &artifact)?;
    }
    Ok(NodeReport::Done(artifact.result))
}

#[allow(clippy::too_many_arguments)]
async fn run_file_pass_node<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    job_id: &str,
    room_path: &str,
    plan: &WorkflowPlan,
    select: &FileSelector,
    instruction: &str,
    mode: &str,
    cancel: &Arc<AtomicBool>,
    published: &std::sync::Mutex<Option<FileMeta>>,
) -> Result<WfArtifact, String> {
    let files = resolve_files(
        app,
        room_path,
        select,
        &plan.input_file_id,
        &plan.prev_run_at,
    )?;
    // A full-file pass reads ONE file end to end. `all` is rejected at
    // validation for this node kind, but a narrowing selector can still match
    // several — name the one that was read and how many were left, rather than
    // dropping the rest in silence.
    let matched = files.len();
    let Some((id, name, _mime)) = files.into_iter().next() else {
        return Ok(WfArtifact {
            result: "No file matched — nothing to read.".into(),
            skipped: false,
            ..Default::default()
        });
    };
    let (summary, meta) = drive_file_pass(
        app,
        job_id,
        room_path,
        &id,
        &name,
        instruction,
        mode,
        cancel,
    )
    .await?;
    let file_id = meta.as_ref().map(|m| m.id.clone());
    if let Some(m) = meta {
        *published.lock().unwrap() = Some(m);
    }
    let result = if matched > 1 {
        format!(
            "{summary}\n\nRead \"{name}\" only — {} other matching file(s) were not read. \
             A full-file pass covers one file; use a \"for each file\" step to cover them all.",
            matched - 1
        )
    } else {
        summary
    };
    Ok(WfArtifact {
        result,
        file_id,
        ..Default::default()
    })
}

/// Wave 5 (Idea 13): the `script_run` node arm. Resolves the script file id, reads
/// its consent hash from the IMMUTABLE plan snapshot (a mid-run script edit parks,
/// never silently runs new code), runs it, records the report JSON as the step
/// artifact, and publishes the first imported output (the terminal auto-open is
/// gated to MANUAL runs in `spawn_workflow_job`).
#[allow(clippy::too_many_arguments)]
async fn run_script_node<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    job_id: &str,
    step_id: usize,
    room_path: &str,
    plan: &WorkflowPlan,
    file: &str,
    mode: &str,
    stdin: Option<String>,
    cancel: &Arc<AtomicBool>,
    published: &std::sync::Mutex<Option<FileMeta>>,
) -> Result<WfArtifact, String> {
    use tauri::Manager;
    // Resolve the node's `file` (a stored file id, or a name) through the ONE
    // resolver the consent stamping and the consent card also use.
    let (file_id, bytes) = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let room = guard
            .as_ref()
            .filter(|r| r.path == room_path)
            .ok_or("The room this job belongs to is no longer open.")?;
        let (id, _name, bytes) = resolve_script_file(&room.conn, file)?;
        (id, bytes)
    };
    let consent = plan.script_consents.get(&file_id).cloned().or_else(|| {
        // A NAME resolves to the newest matching file, so a similarly named
        // file arriving between approval and run can move the id out from under
        // the stamped consent. Consent is content-addressed, so a byte-exact
        // match against a hash this very plan stamped as approved IS the same
        // approval — anything else still parks.
        let sha = script_fingerprint(&bytes);
        plan.script_consents.values().find(|s| **s == sha).cloned()
    });
    let consent = consent.unwrap_or_default();
    let report =
        run_script_process(app, job_id, step_id, room_path, &file_id, &consent, stdin, cancel)
            .await?;
    // Publish the first imported output so a MANUAL run can auto-open it.
    if let Some(first) = report.imported.first() {
        *published.lock().unwrap() = Some(first.clone());
    }
    let n = report.imported.len();
    // transform mode is a pipe stage: the artifact is the script's STDOUT, so a
    // downstream {{input}} reads the script's output. import mode records the run
    // report JSON (the Wave-5 behavior the run-history view renders specially).
    let result = if mode == "transform" {
        let out = report.stdout_tail.trim();
        if out.is_empty() {
            format!("(the script produced no output; {n} file(s) imported)")
        } else {
            out.to_string()
        }
    } else {
        serde_json::to_string(&report).unwrap_or_else(|_| {
            format!(
                "Script finished (exit {}), {n} file(s) imported.",
                report.exit_code
            )
        })
    };
    let file_id = report.imported.first().map(|m| m.id.clone());
    Ok(WfArtifact {
        result,
        file_id,
        ..Default::default()
    })
}

/// Longest a saved file's name may be, before the extension. The template runs
/// through `interpolate`, so `{{input}}` can drop a whole model reply into it.
const MAX_SAVE_NAME_CHARS: usize = 120;

/// Flatten and bound a save_file name: one line, no path separators, and short
/// enough to be a file name rather than a pasted paragraph.
fn clean_save_name(raw: &str) -> String {
    let flat: String = raw
        .chars()
        .map(|c| if c.is_control() || c == '/' || c == '\\' { ' ' } else { c })
        .collect();
    let mut name: String = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.chars().count() > MAX_SAVE_NAME_CHARS {
        name = name.chars().take(MAX_SAVE_NAME_CHARS).collect::<String>();
        name = name.trim_end().to_string();
    }
    if name.is_empty() {
        name = "Workflow output".into();
    }
    name
}

/// Append `body` INSIDE an existing HTML document rather than gluing a whole
/// second page onto the end of the first — which left stranded footers mid-page
/// and the formatting restarting after a few runs.
fn append_into_html(old: &str, name: &str, body: &str) -> String {
    let fragment = format!("\n<hr/>\n{}\n", body.trim());
    // The offset must index the ORIGINAL, so the case-folded copy we search has
    // to be byte-for-byte the same length. `to_lowercase()` is NOT: 'İ' (U+0130)
    // grows a byte, 'ẞ' (U+1E9E) shrinks one — a page carrying either spliced
    // the next block a few bytes off, into the middle of the closing tag, and
    // enough of them ran the index past the end (a panic, under the room lock).
    // The markers are pure ASCII, and `to_ascii_lowercase` only rewrites ASCII
    // bytes in place, so every offset it reports is valid in `old`.
    let folded = old.to_ascii_lowercase();
    // Splice before the LAST closing marker the generated document ends with.
    for marker in ["</main>", "</body>"] {
        if let Some(at) = folded.rfind(marker) {
            let mut out = String::with_capacity(old.len() + fragment.len());
            out.push_str(&old[..at]);
            out.push_str(&fragment);
            out.push_str(&old[at..]);
            return out;
        }
    }
    // Not a document we recognise (an empty or hand-written file) — build one.
    html_document(name, &format!("{}\n{fragment}", old.trim()))
}

/// Write the workflow's output as a room file. Idempotent: if this node already
/// created a file (recorded in its artifact), overwrite that file id. Every
/// overwrite is snapshotted first (`store_file_bytes`), so a scheduled run can
/// never destroy a page the user edited — Time Machine restores it.
#[allow(clippy::too_many_arguments)]
fn save_file_node<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    room_path: &str,
    name_template: &str,
    format: &str,
    mode: &str,
    inputs: &str,
    existing: Option<&WfArtifact>,
    published: &std::sync::Mutex<Option<FileMeta>>,
    cause: &str,
) -> Result<(String, String), String> {
    use tauri::{Emitter, Manager};
    let name_raw = clean_save_name(&interpolate(app, room_path, name_template, inputs));
    let ext = if format == "md" { "md" } else { "html" };
    let name = if name_raw.to_lowercase().ends_with(&format!(".{ext}")) {
        name_raw
    } else {
        format!("{name_raw}.{ext}")
    };
    let (mime, content) = if ext == "md" {
        ("text/markdown".to_string(), inputs.to_string())
    } else {
        ("text/html".to_string(), html_document(&name, inputs))
    };
    let state = app.state::<AppState>();
    let meta = {
        let guard = state.room.lock().unwrap();
        let room = guard
            .as_ref()
            .filter(|r| r.path == room_path)
            .ok_or("The room this job belongs to is no longer open.")?;
        // Idempotent re-run: overwrite the recorded file.
        if let Some(prev) = existing.and_then(|a| a.file_id.clone()) {
            if db::get_file_extracted_text(&room.conn, &prev).is_some() {
                store_file_bytes(&room.conn, &prev, content.as_bytes(), Some(&content), cause)?;
                db::get_file_meta(&room.conn, &prev)?
            } else {
                db::insert_file(
                    &room.conn,
                    &name,
                    &mime,
                    content.as_bytes(),
                    Some(&content),
                    "generated",
                )?
            }
        } else if mode == "overwrite" || mode == "append" {
            // Find an existing generated file of this name.
            let existing_id: Option<String> = room
                .conn
                .query_row(
                    "SELECT id FROM files WHERE name = ?1 AND source = 'generated' ORDER BY created_at DESC LIMIT 1",
                    [&name],
                    |r| r.get(0),
                )
                .ok();
            match existing_id {
                Some(fid) if mode == "append" => {
                    let old = db::get_file_extracted_text(&room.conn, &fid).unwrap_or_default();
                    let joined = if ext == "md" {
                        format!("{old}\n\n{inputs}")
                    } else {
                        append_into_html(&old, &name, inputs)
                    };
                    store_file_bytes(&room.conn, &fid, joined.as_bytes(), Some(&joined), cause)?;
                    db::get_file_meta(&room.conn, &fid)?
                }
                Some(fid) => {
                    store_file_bytes(&room.conn, &fid, content.as_bytes(), Some(&content), cause)?;
                    db::get_file_meta(&room.conn, &fid)?
                }
                None => db::insert_file(
                    &room.conn,
                    &name,
                    &mime,
                    content.as_bytes(),
                    Some(&content),
                    "generated",
                )?,
            }
        } else {
            db::insert_file(
                &room.conn,
                &name,
                &mime,
                content.as_bytes(),
                Some(&content),
                "generated",
            )?
        }
    };
    if let Some(w) = crate::main_window(app) {
        let _ = w.emit("room-files-changed", ());
    }
    let id = meta.id.clone();
    let display = meta.name.clone();
    *published.lock().unwrap() = Some(meta);
    Ok((format!("Saved \"{display}\" into the room."), id))
}

// ---------------------------------------------------------------- spawner

/// One headless agent turn on the room's CHOSEN engine — tools available (the
/// sidecar loop locally, the room bridge for an external CLI), but NEVER
/// streamed into the chat (headless mode suppresses the ask-* events). Pinned to
/// `room_path`: refuses if the room swapped underneath the run.
pub(crate) async fn run_agent_headless(
    app: &tauri::AppHandle,
    room_path: &str,
    question: &str,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    use tauri::Manager;
    let window = crate::main_window(app).ok_or("main window is gone")?;
    let state = app.state::<AppState>();
    let (model, web_enabled, lanes, advisors_on, advisor_tools_on) = {
        let guard = state.room.lock().unwrap();
        let room = guard
            .as_ref()
            .filter(|r| r.path == room_path)
            .ok_or("the room this workflow belongs to is no longer open")?;
        let m = model_setting(&room.conn);
        let models_room = m.clone();
        let advisors_on = advisors_enabled(&room.conn);
        (
            models_room,
            web_access_enabled(&room.conn),
            crate::commands::web_lanes(&room.conn),
            advisors_on,
            advisors_on && advisor_tools_enabled(&room.conn),
        )
    };
    let models = ollama::list_models().await.unwrap_or_default();
    let chat_model = model.unwrap_or_else(|| best_default(&models));
    let advisors = if advisors_on {
        detected_advisors(&state).await
    } else {
        Vec::new()
    };
    // Engine parity: an external CLI runs the grounded turn ITSELF — it is an
    // agent, so it gets the same per-run room bridge as a chat ask
    // (CloudAdvisor scope: file + web tools, never UI/job tools, no MCP
    // connectors in a headless run) and the same cancel watcher.
    if is_cli_engine(&chat_model) {
        let (advisor_runtime, consulted_room_bridge) =
            crate::room_mcp::prepare_advisor_runtime(
                app.clone(),
                web_enabled,
                advisors,
                advisor_tools_on,
                cancel.clone(),
                false,
            )
            .await;
        let bridge = crate::room_mcp::start(
            app.clone(),
            web_enabled,
            crate::room_mcp::ToolScope::CloudAdvisor { include_mcp: false },
            None,
            crate::room_mcp::StartOpts {
                advisor: advisor_runtime,
                lanes,
                ..Default::default()
            },
        )
        .await
        .ok();
        let messages = vec![ollama::ChatMessage::new("user", question)];
        let res = run_external(&chat_model, &messages, Some(cancel), bridge.as_ref(), false).await;
        if let Some(b) = &bridge {
            b.stop();
        }
        if let Some(nested) = consulted_room_bridge {
            nested.stop();
        }
        // Usage discarded — workflow-node usage reporting is out of scope for
        // the chat token-budget bar (this text-only path never touches it).
        return res.map(|(text, _usage)| text);
    }
    let mut effects = ToolEffects::default();
    let outcome = crate::sidecar::run_via_sidecar(
        &window,
        &state,
        &chat_model,
        question,
        Vec::new(),
        None,
        &mut effects,
        web_enabled,
        cancel,
        true,  // headless — no ask-* events into the chat UI
        false, // background turns never bypass the privacy door
        advisors,
        advisor_tools_on,
    )
    .await;
    match outcome {
        crate::sidecar::SidecarOutcome::Done(text) => Ok(text),
        crate::sidecar::SidecarOutcome::Unavailable(e) => Err(e),
        crate::sidecar::SidecarOutcome::EngineError(e) => Err(e),
        crate::sidecar::SidecarOutcome::Failed { text, error } => {
            if text.trim().is_empty() {
                Err(error)
            } else {
                Ok(text)
            }
        }
    }
}

/// Spawn the checkpointed runner for a workflow job (fresh or resumed). Mirrors
/// `spawn_file_pass`: status → running, per-wave checkpoint persists the DONE-SET
/// (a workflow's branched multi-lane plan needs the real set, not a cursor), the
/// terminal payload carries the published file only for a MANUAL run (a scheduled
/// run must not yank the viewer).
pub(crate) fn spawn_workflow_job(
    window: tauri::Window,
    job_id: String,
    room_path: String,
    plan: WorkflowPlan,
    start_done: HashSet<usize>,
    cancel: Arc<AtomicBool>,
) {
    use tauri::{Emitter, Manager};
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let _ = db::set_job_status(&r.conn, &job_id, "running", None);
                // A resumed run's row was left 'paused' — put it back live.
                let _ = db::set_workflow_run_status_by_job(&r.conn, &job_id, "running");
            }
        }
        let steps = plan.steps.clone();
        let total = steps.len();
        emit_progress(
            &window,
            &job_id,
            "Starting the workflow…",
            start_done.len(),
            total,
        );

        let published: Arc<std::sync::Mutex<Option<FileMeta>>> =
            Arc::new(std::sync::Mutex::new(None));
        let last_prefix = Arc::new(std::sync::atomic::AtomicUsize::new(dense_prefix(
            &start_done,
        )));

        // The injected headless agent-turn runner (concrete window/state captured
        // here so the executor core stays runtime-generic + mock-drivable).
        let agent_run: AgentRunFn = {
            let app = app.clone();
            let room_path = room_path.clone();
            let cancel = cancel.clone();
            Arc::new(move |question: String| {
                let app = app.clone();
                let room_path = room_path.clone();
                let cancel = cancel.clone();
                Box::pin(
                    async move { run_agent_headless(&app, &room_path, &question, cancel).await },
                )
            })
        };

        let exec_app = app.clone();
        let exec_job = job_id.clone();
        let exec_room = room_path.clone();
        // Shared, not copied: the executor only READS the plan, and a workflow
        // plan carries the whole definition — cloning it once per step made a
        // big workflow pay for its own size on every node.
        let exec_plan = Arc::new(plan.clone());
        let exec_cancel = cancel.clone();
        let exec_pub = published.clone();
        let exec_agent = agent_run.clone();
        let cp_lp = last_prefix.clone();
        let outcome = run_plan(
            &steps,
            start_done,
            cancel.clone(),
            |s| {
                let app = exec_app.clone();
                let job_id = exec_job.clone();
                let room_path = exec_room.clone();
                let plan = exec_plan.clone();
                let cancel = exec_cancel.clone();
                let published = exec_pub.clone();
                let agent_run = exec_agent.clone();
                async move {
                    execute_workflow_step(
                        &app, &job_id, &room_path, &plan, &s, &cancel, &published, &agent_run,
                    )
                    .await
                }
            },
            |done| {
                let cursor = dense_prefix(done);
                cp_lp.store(cursor, Ordering::SeqCst);
                let done_vec: Vec<usize> = {
                    let mut v: Vec<usize> = done.iter().copied().collect();
                    v.sort_unstable();
                    v
                };
                let state = app.state::<AppState>();
                let guard = state.room.lock().unwrap();
                if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                    let _ = db::checkpoint_job(
                        &r.conn,
                        &job_id,
                        cursor as i64,
                        &serde_json::json!({ "done": done_vec }),
                    );
                }
            },
            |done, total| {
                // `done` = steps completed so far; at 0 nothing has run yet, so
                // "step 0 of N" reads wrong — show "Preparing…" then 1-based.
                let label = if done == 0 {
                    "Preparing…".to_string()
                } else if done >= total {
                    "Finishing…".to_string()
                } else {
                    format!("Running step {} of {}…", done + 1, total)
                };
                emit_progress(&window, &job_id, &label, done, total);
            },
        )
        .await;

        // A Stop mid-model-call surfaces as the call's error — normalize to Paused.
        let outcome = match outcome {
            RunOutcome::Error(_) if cancel.load(Ordering::SeqCst) => RunOutcome::Paused,
            o => o,
        };

        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let (status, err) = match &outcome {
                    RunOutcome::Done => ("done", None),
                    RunOutcome::Paused => ("paused", None),
                    RunOutcome::Error(e) => ("error", Some(e.as_str())),
                };
                let _ = db::set_job_status(&r.conn, &job_id, status, err);
                // Close the workflow_runs row for a terminal outcome. A PAUSE
                // is not terminal — the run can still be resumed — but it must
                // stop reading as 'running', or the history line keeps a live
                // green dot forever with nothing to explain it.
                if matches!(outcome, RunOutcome::Paused) {
                    let _ = db::set_workflow_run_status_by_job(&r.conn, &job_id, "paused");
                } else {
                    let run_status = if matches!(outcome, RunOutcome::Done) {
                        "done"
                    } else {
                        "error"
                    };
                    let _ = db::finish_workflow_run_by_job(&r.conn, &job_id, run_status, err);
                }
            }
        }
        state.job_cancels.lock().unwrap().remove(&job_id);

        let done_now = last_prefix.load(Ordering::SeqCst);
        let manual = plan.trigger == "manual";
        let payload = match &outcome {
            RunOutcome::Done => serde_json::json!({
                "jobId": job_id,
                "label": format!("Workflow “{}” finished", plan.workflow_name),
                "done": total, "total": total, "finished": true,
                // Only a MANUAL run may auto-open its output — a scheduled run
                // must never yank the viewer (the [MINOR] terminal-payload fix).
                "fileId": if manual { published.lock().unwrap().take().map(|m| m.id) } else { None },
            }),
            RunOutcome::Paused => serde_json::json!({
                "jobId": job_id, "label": "Paused", "done": done_now, "total": total,
                "paused": true,
            }),
            RunOutcome::Error(e) => serde_json::json!({
                "jobId": job_id, "label": format!("Stopped — {e}"), "done": done_now,
                "total": total, "failed": true,
            }),
        };
        let _ = window.emit("job-progress", payload);
        let _ = window.emit("workflows-changed", ());
        // Free the queue slot and start the next waiting job.
        super::queue::finish_and_pump(&app, &window, &job_id).await;
    });
}

// ---------------------------------------------------------------- run orchestration

/// Wave 5: for every `script_run` node, resolve its script file id and hash the
/// current bytes; if that hash is approved (per-Mac approvals ∪ this run's
/// grants), record `file_id → hash` so the executor runs it. An unapproved or
/// unresolvable script gets no entry, so the executor parks with an empty consent
/// — a scheduled run never silently executes new/changed code.
pub(crate) fn stamp_script_consents(
    conn: &Connection,
    def: &WorkflowDef,
    approved: &std::collections::HashSet<String>,
) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for node in &def.nodes {
        if let NodeKind::ScriptRun { file, .. } = &node.kind {
            // The ONE resolver — the executor and the consent card use it too,
            // so the three can no longer disagree about which file this is.
            if let Ok((id, _name, bytes)) = resolve_script_file(conn, file) {
                let sha = script_fingerprint(&bytes);
                if approved.contains(&sha) {
                    out.insert(id, sha);
                }
            }
        }
    }
    out
}

/// The last SUCCESSFUL run's start time (for since_last_run /
/// new_files_since_last_run). Only a run that finished counts: measuring from a
/// failed or stopped attempt would move the window past files that attempt
/// never processed, so they would be skipped for good with nothing to show it.
fn previous_run_at(conn: &Connection, workflow_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT started_at FROM workflow_runs WHERE workflow_id = ?1 AND status = 'done' \
         ORDER BY started_at DESC LIMIT 1",
        [workflow_id],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

/// Compile a workflow and enqueue a run. Shared by the command, the agent tool,
/// and the scheduler. Returns the new job id. `trigger` = manual|schedule|
/// catchup|agent; `input_file_id` is the header-run's current file (validated by
/// the caller for run_input defs). `extra_consents` are script fingerprints
/// granted for THIS invocation (a manual "run once" grant that isn't in the
/// approvals file) — folded into the plan's `script_consents` alongside the
/// per-Mac approvals file (Wave 5, decision 5).
pub(crate) async fn start_workflow_run(
    window: &tauri::Window,
    state: &AppState,
    workflow_id: &str,
    trigger: &str,
    input_file_id: Option<String>,
    extra_consents: &std::collections::HashSet<String>,
) -> Result<String, String> {
    use tauri::Manager;
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    // Read the workflow + room model under the lock, then probe models off-lock.
    let (wf, room_model, room_path, prev_run_at) = state.with_room(|room| {
        let wf = db::get_workflow(&room.conn, workflow_id)?;
        Ok((
            wf,
            model_setting(&room.conn),
            room.path.clone(),
            previous_run_at(&room.conn, workflow_id),
        ))
    })?;
    let def: WorkflowDef = serde_json::from_value(wf.definition.clone())
        .map_err(|_| "this workflow's definition is unreadable")?;
    // run_input defs need a file to run on.
    if def_uses_run_input(&def) && input_file_id.is_none() {
        return Err(
            "This workflow runs on a chosen file — start it from a file's Actions menu.".into(),
        );
    }
    // Engine-review #1: never pile up runs of the SAME workflow. Without this a
    // scheduled workflow whose runtime exceeds its interval accumulates duplicate
    // queued runs (each re-firing save_file → a growing pile of output files).
    // A scheduled trigger skips silently (the tick still advances next_run_at); a
    // manual trigger tells the user why. Also honor the shared queue cap, which
    // the scheduler path previously bypassed.
    let (has_inflight, full) = state.with_room(|room| {
        Ok((
            has_inflight_run(&room.conn, workflow_id),
            queue::at_capacity(&room.conn),
        ))
    })?;
    if has_inflight {
        return if trigger == "manual" {
            Err("This workflow is already running or queued.".into())
        } else {
            Ok(String::new())
        };
    }
    if full {
        return if trigger == "manual" {
            Err(queue::QUEUE_FULL.into())
        } else {
            Ok(String::new())
        };
    }
    // Wave 5: stamp the consent snapshot for any script_run nodes (approvals
    // file on this Mac ∪ this invocation's grants). Read under the room lock.
    let app = window.app_handle().clone();
    let approved: std::collections::HashSet<String> = {
        let mut set: std::collections::HashSet<String> =
            crate::commands::read_script_approvals(&app)
                .into_iter()
                .collect();
        set.extend(extra_consents.iter().cloned());
        set
    };
    let script_consents =
        state.with_room(|room| Ok(stamp_script_consents(&room.conn, &def, &approved)))?;
    let models = ollama::list_models().await.unwrap_or_default();
    let steps = compile_workflow(&def, &room_model, &models).map_err(|errs| errs.join(" "))?;
    let resolved_model = default_resolved_model(&room_model, &models);
    let plan = WorkflowPlan {
        workflow_id: workflow_id.to_string(),
        workflow_name: wf.name.clone(),
        trigger: trigger.to_string(),
        def,
        resolved_model,
        input_file_id: input_file_id.clone(),
        prev_run_at,
        script_consents,
        steps: steps.clone(),
    };
    let plan_json = serde_json::to_value(&plan).map_err(|e| e.to_string())?;
    let total = steps.len() as i64;
    let title = format!("Workflow — {}", wf.name);
    // Create the job row + open the run row, verifying the room didn't swap.
    let job_id = state.with_room(|room| {
        if room.path != room_path {
            return Err("The room changed while starting this workflow.".into());
        }
        let id = db::create_job(&room.conn, "workflow", &title, &plan_json, total)?;
        db::create_workflow_run(
            &room.conn,
            workflow_id,
            &id,
            trigger,
            input_file_id.as_deref(),
        )?;
        Ok(id)
    })?;
    super::queue::submit(window, state, job_id.clone()).await?;
    Ok(job_id)
}

// ---------------------------------------------------------------- parsing helpers

/// Parse a definition Value into a WorkflowDef, mapping a serde error into a
/// model-fixable sentence (unknown kind / missing field).
fn parse_def(v: &serde_json::Value) -> Result<WorkflowDef, String> {
    serde_json::from_value(v.clone()).map_err(|e| {
        format!(
            "The workflow definition is malformed ({e}). Each node needs a unique id and a valid kind \
             (generate, summarize_file, file_pass, agent_run, save_file, condition) with its params."
        )
    })
}

/// Human label for a step kind — mirrors `KIND_LABELS` in
/// `src/workspace/workflows/kinds.ts`. Kept in sync so the stored name and the
/// UI never diverge.
fn human_kind_label(kind: &str) -> String {
    match kind {
        "generate" => "Generate text",
        "summarize_file" => "Summarize a file",
        "file_pass" => "Full-file pass",
        "for_each_file" => "For each file",
        "agent_run" => "Ask the agent",
        "extract" => "Extract fields",
        "route" => "Route by content",
        "vote" => "Vote / consensus",
        "refine" => "Refine (critique loop)",
        "plan_and_map" => "Plan & map",
        "transform" => "Transform text",
        "merge" => "Merge branches",
        "http_fetch" => "Fetch a URL",
        "script_run" => "Run a script",
        "save_file" => "Save a file",
        "condition" => "Condition",
        other => return other.replace('_', " "),
    }
    .to_string()
}

/// Ensure every node in a definition JSON carries a non-empty human `label`.
/// AI-composed definitions (and the agent's `save_workflow` tool) emit only
/// `id` + `kind`, so their steps would open with a blank "Step name" field even
/// though the canvas shows the kind. Backfilling the raw JSON at persist time —
/// rather than the parsed struct, which isn't what we store — makes the saved
/// name real and consistent across the canvas, the inspector, and validation.
fn backfill_node_labels(def_val: &mut serde_json::Value) {
    let Some(nodes) = def_val.get_mut("nodes").and_then(|n| n.as_array_mut()) else {
        return;
    };
    for node in nodes {
        let Some(obj) = node.as_object_mut() else {
            continue;
        };
        let blank = obj
            .get("label")
            .and_then(|l| l.as_str())
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        if blank {
            let kind = obj
                .get("kind")
                .and_then(|k| k.as_str())
                .unwrap_or("")
                .to_string();
            obj.insert(
                "label".into(),
                serde_json::Value::String(human_kind_label(&kind)),
            );
        }
    }
}

/// Parse a binding Value, defaulting to general on absence/malformed input.
fn parse_binding(v: Option<&serde_json::Value>) -> WorkflowBinding {
    v.and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or(WorkflowBinding::General {})
}

/// Compile-check a def+binding against the palette, returning the numbered error
/// list (empty = valid). Shared by save/update and the validate-only command.
async fn validate_workflow_inner(
    state: &AppState,
    def: &WorkflowDef,
    binding: &WorkflowBinding,
) -> Vec<String> {
    if let Err(errs) = validate_with_binding(def, binding) {
        return errs;
    }
    let room_model = state
        .with_room(|room| Ok(model_setting(&room.conn)))
        .ok()
        .flatten();
    let models = ollama::list_models().await.unwrap_or_default();
    match compile_workflow(def, &room_model, &models) {
        Ok(_) => Vec::new(),
        Err(errs) => errs,
    }
}

// ---------------------------------------------------------------- commands

/// Validate a definition WITHOUT persisting it — the M2 canvas round-trips every
/// edit through this (single source of truth, per the addendum). Returns the
/// numbered, node-naming error list; empty = valid.
#[tauri::command]
pub async fn validate_workflow(
    state: State<'_, AppState>,
    definition: serde_json::Value,
    binding: Option<serde_json::Value>,
) -> Result<Vec<String>, String> {
    let def = match parse_def(&definition) {
        Ok(d) => d,
        Err(e) => return Ok(vec![e]),
    };
    let binding = parse_binding(binding.as_ref());
    Ok(validate_workflow_inner(state.inner(), &def, &binding).await)
}

/// Set (or clear, kind="") a workflow's schedule. Refuses a run_input def.
async fn apply_schedule(
    state: &AppState,
    workflow_id: &str,
    def: &WorkflowDef,
    kind: &str,
    param: &str,
    enabled: bool,
    catch_up: bool,
) -> Result<(), String> {
    if kind.is_empty() {
        return state.with_room(|room| {
            db::upsert_schedule(&room.conn, workflow_id, "", "", true, true, None)
        });
    }
    if def_uses_run_input(def) {
        return Err("This workflow runs on a chosen file — it can't be scheduled.".into());
    }
    if super::next_run_from_now(kind, param).is_none() {
        return Err("That schedule is invalid — check the time or interval.".into());
    }
    let next = if enabled {
        super::next_run_from_now(kind, param)
    } else {
        None
    };
    state.with_room(|room| {
        db::upsert_schedule(
            &room.conn,
            workflow_id,
            kind,
            param,
            enabled,
            catch_up,
            next.as_deref(),
        )
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleArg {
    pub kind: String,
    #[serde(default)]
    pub param: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "yes")]
    pub catch_up: bool,
}
fn yes() -> bool {
    true
}

/// Save a NEW workflow (always a draft). Validation is the contract — an invalid
/// def bounces back with the numbered, node-naming error list.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_workflow(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
    emoji: Option<String>,
    mut definition: serde_json::Value,
    binding: Option<serde_json::Value>,
    created_by: Option<String>,
    schedule: Option<ScheduleArg>,
) -> Result<String, String> {
    backfill_node_labels(&mut definition);
    let def = parse_def(&definition)?;
    let binding = parse_binding(binding.as_ref());
    let errs = validate_workflow_inner(state.inner(), &def, &binding).await;
    if !errs.is_empty() {
        return Err(errs.join(" "));
    }
    let binding_json =
        serde_json::to_value(&binding).unwrap_or(serde_json::json!({"scope": "general"}));
    let id = state.with_room(|room| {
        db::create_workflow(
            &room.conn,
            name.trim(),
            description.as_deref().unwrap_or("").trim(),
            emoji.as_deref().unwrap_or("").trim(),
            &definition,
            match created_by.as_deref() {
                Some("agent") => "agent",
                _ => "user",
            },
            &binding_json,
        )
    })?;
    if let Some(s) = schedule {
        apply_schedule(
            state.inner(),
            &id,
            &def,
            &s.kind,
            &s.param,
            s.enabled,
            s.catch_up,
        )
        .await?;
    }
    Ok(id)
}

/// Update an existing workflow. An update to an ACTIVE workflow drops it back to
/// draft (its schedule pauses) until the user re-activates — the review gate.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_workflow(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    description: Option<String>,
    emoji: Option<String>,
    definition: Option<serde_json::Value>,
    binding: Option<serde_json::Value>,
    schedule: Option<ScheduleArg>,
) -> Result<(), String> {
    let current = state.with_room(|room| db::get_workflow(&room.conn, &id))?;
    let mut def_val = definition
        .clone()
        .unwrap_or_else(|| current.definition.clone());
    backfill_node_labels(&mut def_val);
    let def = parse_def(&def_val)?;
    let binding_val = binding.clone().unwrap_or_else(|| current.binding.clone());
    let binding_obj = parse_binding(Some(&binding_val));
    let errs = validate_workflow_inner(state.inner(), &def, &binding_obj).await;
    if !errs.is_empty() {
        return Err(errs.join(" "));
    }
    state.with_room(|room| {
        db::update_workflow(
            &room.conn,
            &id,
            name.as_deref().unwrap_or(&current.name).trim(),
            description
                .as_deref()
                .unwrap_or(&current.description)
                .trim(),
            emoji.as_deref().unwrap_or(&current.emoji).trim(),
            &def_val,
            &binding_val,
        )?;
        // Review gate: editing an active workflow returns it to draft.
        if current.status == "active" {
            db::set_workflow_status(&room.conn, &id, "draft")?;
        }
        Ok(())
    })?;
    if let Some(s) = schedule {
        apply_schedule(
            state.inner(),
            &id,
            &def,
            &s.kind,
            &s.param,
            s.enabled,
            s.catch_up,
        )
        .await?;
    }
    Ok(())
}

/// Flip a workflow active/draft. Activating is the explicit user consent that
/// also pre-consents any scheduled/headless runs (no 180s prompt at cron time).
#[tauri::command]
pub fn set_workflow_status(
    state: State<'_, AppState>,
    id: String,
    status: String,
) -> Result<(), String> {
    let status = match status.as_str() {
        "active" => "active",
        _ => "draft",
    };
    state.with_room(|room| db::set_workflow_status(&room.conn, &id, status))?;
    Ok(())
}

#[tauri::command]
pub fn set_workflow_pinned(
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    let wf = state.with_room(|room| db::get_workflow(&room.conn, &id))?;
    let binding = parse_binding(Some(&wf.binding));
    if pinned && matches!(binding, WorkflowBinding::File { .. }) {
        return Err(
            "File-scoped workflows appear in the file header, not the top bar — only general-purpose workflows can be pinned."
                .into(),
        );
    }
    state.with_room(|room| db::set_workflow_pinned(&room.conn, &id, pinned))?;
    Ok(())
}

#[tauri::command]
pub async fn set_workflow_schedule(
    state: State<'_, AppState>,
    id: String,
    schedule: ScheduleArg,
) -> Result<(), String> {
    let wf = state.with_room(|room| db::get_workflow(&room.conn, &id))?;
    let def = parse_def(&wf.definition)?;
    apply_schedule(
        state.inner(),
        &id,
        &def,
        &schedule.kind,
        &schedule.param,
        schedule.enabled,
        schedule.catch_up,
    )
    .await?;
    Ok(())
}

/// True if this workflow already has a job in flight (running or queued) — the
/// guard against duplicate/pile-up runs.
///
/// A PAUSED job is deliberately not in flight: it makes no progress on its own,
/// so counting it here parked the workflow forever — every scheduled tick
/// skipped silently and Run answered "already running or queued" for a job that
/// was never going to move. The parked job stays resumable from the Activity
/// panel either way.
fn has_inflight_run(conn: &Connection, workflow_id: &str) -> bool {
    let Ok(runs) = db::list_workflow_runs(conn, workflow_id) else {
        return false;
    };
    runs.iter().any(|r| {
        r.job_id
            .as_ref()
            .and_then(|jid| db::get_job(conn, jid).ok())
            .map(|j| matches!(j.status.as_str(), "running" | "queued"))
            .unwrap_or(false)
    })
}

#[tauri::command]
pub fn delete_workflow(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Cascade addendum: cancel + delete any unfinished job driving this workflow,
    // then delete the row (schedules + runs cascade via FK).
    state.with_room(|room| {
        let runs = db::list_workflow_runs(&room.conn, &id)?;
        for r in runs {
            if let Some(job_id) = r.job_id {
                let job = db::get_job(&room.conn, &job_id);
                let unfinished = job
                    .as_ref()
                    .map(|j| matches!(j.status.as_str(), "running" | "queued" | "paused"))
                    .unwrap_or(false);
                if unfinished {
                    // Signal a running job to stop, then remove the row.
                    if let Some(flag) = state.job_cancels.lock().unwrap().get(&job_id) {
                        flag.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    let _ = db::delete_job(&room.conn, &job_id);
                }
            }
        }
        db::delete_workflow(&room.conn, &id)
    })
}

#[tauri::command]
pub fn list_workflows(state: State<'_, AppState>) -> Result<Vec<db::Workflow>, String> {
    state.with_room(|room| db::list_workflows(&room.conn))
}

#[tauri::command]
pub fn get_workflow(state: State<'_, AppState>, id: String) -> Result<db::Workflow, String> {
    state.with_room(|room| db::get_workflow(&room.conn, &id))
}

#[tauri::command]
pub fn get_workflow_schedule(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<db::Schedule>, String> {
    state.with_room(|room| db::get_schedule(&room.conn, &id))
}

#[tauri::command]
pub fn get_workflow_runs(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<db::WorkflowRun>, String> {
    state.with_room(|room| db::list_workflow_runs(&room.conn, &id))
}

/// Peek/drill-down into one job step's raw artifact (the run-history detail).
#[tauri::command]
pub fn get_job_step_artifact(
    state: State<'_, AppState>,
    job_id: String,
    step_id: usize,
) -> Result<Option<String>, String> {
    state.with_room(|room| Ok(db::get_job_artifact(&room.conn, &job_id, step_id)))
}

/// Manually run a workflow now. `file_id` is the header-run's current file.
#[tauri::command]
pub async fn run_workflow(
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
    file_id: Option<String>,
) -> Result<String, String> {
    // Verify the file (if given) exists in THIS room.
    if let Some(fid) = &file_id {
        state.with_room(|room| {
            db::get_file_extracted_text(&room.conn, fid)
                .map(|_| ())
                .or_else(|| {
                    room.conn
                        .query_row("SELECT 1 FROM files WHERE id = ?1", [fid], |_| Ok(()))
                        .ok()
                })
                .ok_or_else(|| "That file is no longer in this room.".to_string())
        })?;
    }
    // A user-driven run may embed script_run nodes. Surface the consent card for
    // any script not yet approved on this Mac (reusing the Scripts-page machinery)
    // and fold the grants into this run — so an embedded script is runnable without
    // a separate trip to the Scripts page, while still gated by explicit per-Mac
    // consent. Without this the run parked with "Script changed since it was
    // approved" even though the script was never approved.
    let def: WorkflowDef = state.with_room(|room| {
        let wf = db::get_workflow(&room.conn, &id)?;
        serde_json::from_value(wf.definition)
            .map_err(|_| "this workflow's definition is unreadable".to_string())
    })?;
    let extra = crate::commands::approve_workflow_scripts(&window, state.inner(), &def).await?;
    start_workflow_run(&window, state.inner(), &id, "manual", file_id, &extra).await
}

/// The prebuilt template gallery (empty-state) — also the agent's few-shot set.
#[tauri::command]
pub fn workflow_templates() -> Vec<serde_json::Value> {
    builtin_templates()
}

// -------------------------------------------------- agent-tool implementations

fn emit_workflows_changed<R: tauri::Runtime>(window: &tauri::Window<R>) {
    use tauri::Emitter;
    let _ = window.emit("workflows-changed", ());
}

fn schedule_from_args(args: &serde_json::Value) -> Option<ScheduleArg> {
    let s = args.get("schedule")?;
    if s.is_null() {
        return None;
    }
    let kind = s.get("kind").and_then(|v| v.as_str())?.to_string();
    Some(ScheduleArg {
        kind,
        param: s
            .get("param")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        enabled: s.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
        catch_up: s
            .get("catchUp")
            .or_else(|| s.get("catch_up"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
    })
}

/// Agent tool `list_workflows`: no name → id/name/status/schedule summary lines;
/// with a name → that workflow's full definition JSON (needed for update flows).
pub(crate) fn agent_list_workflows(state: &AppState, name: Option<&str>) -> Result<String, String> {
    state.with_room(|room| match name.filter(|n| !n.trim().is_empty()) {
        Some(n) => {
            let wf = db::find_workflow(&room.conn, n)?;
            let sched = db::get_schedule(&room.conn, &wf.id)?;
            let sched_line = sched
                .map(|s| format!(" schedule: {} {}", s.kind, s.param))
                .unwrap_or_default();
            Ok(format!(
                "{} (id {}, {}){}\n\nDefinition:\n{}",
                wf.name,
                wf.id,
                wf.status,
                sched_line,
                serde_json::to_string_pretty(&wf.definition).unwrap_or_default()
            ))
        }
        None => {
            let wfs = db::list_workflows(&room.conn)?;
            // The node grammar rides the INDEX, not the per-workflow fetch:
            // this is the call the Workflow agent's flow fires as a free probe
            // before authoring, so the reference lands exactly once per task
            // instead of on every turn inside save_workflow's description.
            // An empty room is the most likely place a model is about to write
            // its first workflow, so it gets the reference too.
            if wfs.is_empty() {
                return Ok(format!(
                    "No workflows are saved in this room yet.{WORKFLOW_NODE_REFERENCE}"
                ));
            }
            let lines: Vec<String> = wfs
                .iter()
                .map(|w| {
                    format!(
                        "- {} {} (id {}, {}, by {})",
                        if w.emoji.is_empty() { "•" } else { &w.emoji },
                        w.name,
                        w.id,
                        w.status,
                        w.created_by
                    )
                })
                .collect();
            Ok(format!("{}{WORKFLOW_NODE_REFERENCE}", lines.join("\n")))
        }
    })
}

/// Agent tool `save_workflow`: validate + compile, then write a DRAFT.
pub(crate) async fn agent_save_workflow(
    state: &AppState,
    window: &tauri::Window,
    args: &serde_json::Value,
    created_by: &str,
) -> Result<String, String> {
    let name = args["name"].as_str().unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Err("save_workflow needs a `name`.".into());
    }
    let mut definition = args
        .get("definition")
        .cloned()
        .ok_or("save_workflow needs a `definition` object.")?;
    backfill_node_labels(&mut definition);
    let def = parse_def(&definition)?;
    let binding = parse_binding(args.get("binding"));
    let errs = validate_workflow_inner(state, &def, &binding).await;
    if !errs.is_empty() {
        // The corrective-error doctrine: hand the model the numbered list to fix.
        return Err(format!(
            "The workflow is not valid yet — fix these and call save_workflow again:\n- {}",
            errs.join("\n- ")
        ));
    }
    let binding_json =
        serde_json::to_value(&binding).unwrap_or(serde_json::json!({"scope": "general"}));
    let id = state.with_room(|room| {
        db::create_workflow(
            &room.conn,
            &name,
            args["description"].as_str().unwrap_or("").trim(),
            args["emoji"].as_str().unwrap_or("").trim(),
            &definition,
            created_by,
            &binding_json,
        )
    })?;
    if let Some(s) = schedule_from_args(args) {
        apply_schedule(state, &id, &def, &s.kind, &s.param, s.enabled, s.catch_up).await?;
    }
    emit_workflows_changed(window);
    Ok(format!(
        "Saved as a DRAFT named \"{name}\". Tell the user to review and activate it on the Workflows page."
    ))
}

/// The instruction handed to the model to turn a plain-language request into a
/// WorkflowDef JSON. Deliberately reuses the save_workflow tool's schema prose so
/// the two stay in sync.
fn compose_prompt(description: &str) -> String {
    format!(
        "You compose an automation workflow for a note-taking app, as JSON only.\n\n\
         Output ONE JSON object with keys: \"name\" (short), \"emoji\" (one emoji), \
         \"description\" (one sentence), \"definition\", and optionally \"binding\" and \
         \"schedule\". No prose, no code fence — JSON only.\n\n\
         `definition` is a small graph: {{\"version\":1,\"nodes\":[...],\"edges\":[...]}}. \
         Node kinds and their fields:\n\
         - generate {{prompt, model:\"auto\"}}\n\
         - summarize_file {{select}}\n\
         - file_pass {{select, instruction, mode}}\n\
         - for_each_file {{select, instruction, model}} — runs the instruction on EACH \
           selected file and joins the results (use instead of file_pass to cover many files)\n\
         - agent_run {{question}}\n\
         - extract {{fields:[\"name\",...]}} — pulls named fields out of {{{{input}}}} as JSON\n\
         - route {{prompt, labels:[\"a\",\"b\",...]}} — the model tags {{{{input}}}} with ONE label; \
           edges off it use branch:<label> (like condition's then/else, but N-way)\n\
         - vote {{prompt, samples:3, mode:\"concat\"|\"majority\"}} — runs the prompt N times, aggregates\n\
         - refine {{prompt, rubric, max_rounds:2}} — generate→critique→revise until it passes\n\
         - plan_and_map {{objective, max_workers:4}} — splits the objective into subtasks, runs each, synthesizes\n\
         - transform {{op, find?, value?}} — deterministic text op (append|prepend|replace|upper|lower|trim|truncate|strip_html)\n\
         - merge {{mode:\"concat\"|\"dedupe_lines\"|\"numbered\", separator?}} — joins parallel branches\n\
         - http_fetch {{url}} — fetches a web page's text (url may use {{{{input}}}})\n\
         - script_run {{file, mode:\"import\"|\"transform\"}} — runs a .py/.js room script; transform feeds \
           {{{{input}}}} on stdin and returns its stdout as a pipe stage\n\
         - save_file {{name_template, format:\"html\"|\"md\", mode:\"create\"}}\n\
         - condition {{op, value}}\n\
         `select` is {{\"type\":...,\"pattern\"?}}. The ONLY valid types: \"newest\" (latest \
         file), \"all\" (every file), \"name_like\" (needs \"pattern\"), \"missing_summary\" \
         (files with no summary yet), \"since_last_run\" (files added since the previous \
         run), \"run_input\" (the file the workflow is invoked on — file binding only). \
         `op` must be one of: contains, not_contains, is_empty, not_empty, \
         new_files_since_last_run.\n\
         Each node needs a unique \"id\", a \"kind\", and a short \"label\" — 2-4 words \
         in the USER'S language describing what THIS step does for them (e.g. \
         \"Find new tickers\", \"Append to dashboard\"), NOT the kind name. edges are [{{\"from\",\"to\",\"branch\"?}}] \
         (branch \"then\"/\"else\" off a condition, or one of a route's labels off a route; \
         omit branch otherwise). Parallel branches are just several edges out of one node, \
         re-joined by a later node (e.g. a merge). Prompts may use {{{{input}}}} \
         (upstream results), {{{{files}}}} (the room's file list), {{{{date}}}}.\n\
         For a workflow that runs on the file the user is viewing, set \
         \"binding\":{{\"scope\":\"file\",\"kinds\":[\"pdf\"]}} and give input-taking nodes \
         \"select\":{{\"type\":\"run_input\"}}. Otherwise omit binding (general).\n\
         For a schedule use \"schedule\":{{\"kind\":\"daily\",\"param\":\"08:00\"}} \
         (kind interval|daily|weekly).\n\n\
         Example: {{\"name\":\"Morning digest\",\"emoji\":\"🌅\",\"description\":\"Digest new files each morning.\",\
         \"definition\":{{\"version\":1,\"nodes\":[{{\"id\":\"gen\",\"kind\":\"generate\",\"label\":\"Write the digest\",\"model\":\"auto\",\
         \"prompt\":\"Digest the files:\\n{{{{files}}}}\"}},{{\"id\":\"save\",\"kind\":\"save_file\",\"label\":\"Save today's digest\",\
         \"name_template\":\"Digest {{{{date}}}}\",\"format\":\"html\",\"mode\":\"create\"}}],\
         \"edges\":[{{\"from\":\"gen\",\"to\":\"save\"}}]}},\"schedule\":{{\"kind\":\"daily\",\"param\":\"08:00\"}}}}\n\n\
         The workflow the user wants: {description}"
    )
}

/// Generate text from whatever engine the room is set to — a local/cloud Ollama
/// model or an external CLI (Codex/Claude). Used by `compose_workflow` so it works
/// on ANY engine, including a plain-text external CLI that has no room tools.
pub(crate) async fn generate_text_any_engine(model: &str, prompt: &str) -> Result<String, String> {
    let msgs = vec![ollama::ChatMessage::new("user", prompt)];
    if is_cli_engine(model) {
        // Usage discarded — this one-shot text gateway (workflow generate
        // nodes) is out of scope for the chat token-budget bar.
        crate::commands::run_external(model, &msgs, None, None, false)
            .await
            .map(|(text, _usage)| text)
    } else {
        ollama::generate(
            model,
            msgs,
            Some(0.2),
            KEEP_ALIVE_WARM,
            None,
            ollama::CtxTier::Job,
        )
        .await
        .map(|t| ollama::strip_think_spans(&t))
    }
}

/// `compose_workflow` command: turn a plain-language description into a saved DRAFT
/// workflow, engine-agnostically. It asks the model for the definition JSON as TEXT
/// (not a tool call — so it works even with an external CLI that has no room tools),
/// recovers/validates it (one repair retry), and saves it for review. Returns the
/// new workflow's id so the UI can open it.
#[tauri::command]
pub async fn compose_workflow(
    window: tauri::Window,
    state: State<'_, AppState>,
    description: String,
) -> Result<String, String> {
    let description = description.trim();
    if description.is_empty() {
        return Err("Describe the workflow you want.".into());
    }
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    let room_model = state.with_room(|room| Ok(model_setting(&room.conn)))?;
    let models = ollama::list_models().await.unwrap_or_default();
    let model = match room_model {
        Some(m) if !m.trim().is_empty() => m,
        _ => default_resolved_model(&None, &models),
    };

    let base = compose_prompt(description);
    let mut last_err = String::new();
    for attempt in 0..2 {
        let prompt = if attempt == 0 {
            base.clone()
        } else {
            format!("{base}\n\nYour previous attempt was rejected: {last_err}\nReturn corrected JSON only.")
        };
        let raw = generate_text_any_engine(&model, &prompt).await?;
        let json = ollama::recover_json(&raw);
        let val: serde_json::Value = match serde_json::from_str(&json) {
            Ok(v) => v,
            Err(e) => {
                last_err = format!("output was not valid JSON ({e})");
                continue;
            }
        };
        let Some(mut definition) = val.get("definition").cloned() else {
            last_err = "the JSON had no `definition` object".into();
            continue;
        };
        backfill_node_labels(&mut definition);
        let def = match parse_def(&definition) {
            Ok(d) => d,
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        let binding = parse_binding(val.get("binding"));
        let errs = validate_workflow_inner(&state, &def, &binding).await;
        if !errs.is_empty() {
            last_err = errs.join("; ");
            continue;
        }
        let name = val["name"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("New workflow");
        let emoji = val["emoji"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("✨");
        let binding_json =
            serde_json::to_value(&binding).unwrap_or(serde_json::json!({"scope": "general"}));
        let id = state.with_room(|room| {
            db::create_workflow(
                &room.conn,
                name,
                val["description"].as_str().unwrap_or("").trim(),
                emoji,
                &definition,
                "agent",
                &binding_json,
            )
        })?;
        if let Some(s) = schedule_from_args(&val) {
            apply_schedule(&state, &id, &def, &s.kind, &s.param, s.enabled, s.catch_up).await?;
        }
        emit_workflows_changed(&window);
        return Ok(id);
    }
    Err(format!(
        "Couldn't compose a valid workflow ({last_err}). Try describing it more specifically."
    ))
}

/// Agent tool `update_workflow`: same validation; an update to an ACTIVE workflow
/// drops it back to draft (its schedule pauses) — the review gate.
pub(crate) async fn agent_update_workflow(
    state: &AppState,
    window: &tauri::Window,
    args: &serde_json::Value,
) -> Result<String, String> {
    let key = args["name_or_id"]
        .as_str()
        .or_else(|| args["name"].as_str())
        .unwrap_or_default();
    let current = state.with_room(|room| db::find_workflow(&room.conn, key))?;
    let mut def_val = args
        .get("definition")
        .cloned()
        .unwrap_or_else(|| current.definition.clone());
    backfill_node_labels(&mut def_val);
    let def = parse_def(&def_val)?;
    let binding_val = args
        .get("binding")
        .cloned()
        .unwrap_or_else(|| current.binding.clone());
    let binding = parse_binding(Some(&binding_val));
    let errs = validate_workflow_inner(state, &def, &binding).await;
    if !errs.is_empty() {
        return Err(format!(
            "The updated workflow is not valid — fix these and try again:\n- {}",
            errs.join("\n- ")
        ));
    }
    state.with_room(|room| {
        db::update_workflow(
            &room.conn,
            &current.id,
            args["name"].as_str().unwrap_or(&current.name).trim(),
            args["description"]
                .as_str()
                .unwrap_or(&current.description)
                .trim(),
            args["emoji"].as_str().unwrap_or(&current.emoji).trim(),
            &def_val,
            &binding_val,
        )?;
        if current.status == "active" {
            db::set_workflow_status(&room.conn, &current.id, "draft")?;
        }
        Ok(())
    })?;
    if let Some(s) = schedule_from_args(args) {
        apply_schedule(
            state,
            &current.id,
            &def,
            &s.kind,
            &s.param,
            s.enabled,
            s.catch_up,
        )
        .await?;
    }
    emit_workflows_changed(window);
    Ok(format!(
        "Updated \"{}\" and set it back to DRAFT — tell the user to review and re-activate it.",
        current.name
    ))
}

/// Agent-side workflow deletion mirrors the UI command: unfinished runs are
/// cancelled before their workflow row (and cascading schedule/history rows) is
/// removed. It is intentionally a separate tool so delete is never inferred
/// from an update payload.
pub(crate) fn agent_delete_workflow(
    state: &AppState,
    window: &tauri::Window,
    args: &serde_json::Value,
) -> Result<String, String> {
    let key = args["name_or_id"]
        .as_str()
        .or_else(|| args["name"].as_str())
        .unwrap_or_default()
        .trim();
    if key.is_empty() {
        return Err("delete_workflow needs a workflow name or id.".into());
    }
    let workflow = state.with_room(|room| db::find_workflow(&room.conn, key))?;
    state.with_room(|room| {
        let runs = db::list_workflow_runs(&room.conn, &workflow.id)?;
        for run in runs {
            if let Some(job_id) = run.job_id {
                let unfinished = db::get_job(&room.conn, &job_id)
                    .ok()
                    .map(|job| matches!(job.status.as_str(), "running" | "queued" | "paused"))
                    .unwrap_or(false);
                if unfinished {
                    if let Some(flag) = state.job_cancels.lock().unwrap().get(&job_id) {
                        flag.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    let _ = db::delete_job(&room.conn, &job_id);
                }
            }
        }
        db::delete_workflow(&room.conn, &workflow.id)
    })?;
    emit_workflows_changed(window);
    Ok(format!("Deleted workflow \"{}\".", workflow.name))
}

/// Agent tool `run_workflow`: enqueue a manual run (same trust class as
/// start_file_pass — started, don't poll).
pub(crate) async fn agent_run_workflow(
    window: &tauri::Window,
    state: &AppState,
    args: &serde_json::Value,
) -> Result<String, String> {
    let key = args["name_or_id"]
        .as_str()
        .or_else(|| args["name"].as_str())
        .unwrap_or_default();
    let wf = state.with_room(|room| db::find_workflow(&room.conn, key))?;
    if wf.status != "active" {
        return Err(format!(
            "\"{}\" is a draft — the user must activate it on the Workflows page before it can run.",
            wf.name
        ));
    }
    let file = args["file"].as_str().or_else(|| args["file_id"].as_str());
    let file_id = match file {
        Some(f) => Some(
            state.with_room(|room| db::find_source_file_like(&room.conn, f).map(|(id, _)| id))?,
        ),
        None => None,
    };
    start_workflow_run(
        window,
        state,
        &wf.id,
        "manual",
        file_id,
        &std::collections::HashSet::new(),
    )
    .await?;
    Ok(format!(
        "Started \"{}\" in the background — the user can watch it on the Workflows page. Do not wait for it.",
        wf.name
    ))
}

/// Agent tool `test_workflow`: the build→test→fix loop's inspection half. RUN a
/// workflow (draft OR active) to completion right now and report the outcome —
/// overall status plus EACH step's label, kind, skip and a preview of its result —
/// so the agent can see what actually failed and fix it with `update_workflow`.
///
/// Unlike `run_workflow` (fire-and-forget, active-only), this waits for the run and
/// returns its results. It leaves the workflow's status untouched — a tested draft
/// stays a DRAFT, so the user remains the activation gate (never auto-activated).
/// Script steps still need the user's approval (the agent can't self-approve code),
/// so a `script_run` node PARKS during a test — reported honestly in the result.
pub(crate) async fn agent_test_workflow(
    window: &tauri::Window,
    state: &AppState,
    args: &serde_json::Value,
) -> Result<String, String> {
    let key = args["name_or_id"]
        .as_str()
        .or_else(|| args["name"].as_str())
        .unwrap_or_default();
    let wf = state.with_room(|room| db::find_workflow(&room.conn, key))?;
    let def: WorkflowDef = serde_json::from_value(wf.definition.clone())
        .map_err(|_| "this workflow's definition is unreadable".to_string())?;
    let binding = parse_binding(Some(&wf.binding));

    // Validate first — a compile error needs no run and names each fix.
    if let Err(errs) = validate_with_binding(&def, &binding) {
        return Ok(format!(
            "Test of \"{}\": it doesn't validate yet, so it can't run. Fix these with update_workflow, then test again:\n- {}",
            wf.name,
            errs.join("\n- ")
        ));
    }

    // Deadlock-safe: only test when the single job slot is free. A test queued
    // behind a running job that is ITSELF waiting on this call (a parent workflow's
    // agent_run node) would hang — so refuse rather than queue.
    if state.running_job.lock().unwrap().is_some() {
        // Terminal, and it says so. This used to read "ask the user to wait …
        // then test the workflow again", which a model hears as "retry": the
        // self-test (2026-08-01, wave 3) burned seven identical calls against
        // this line in 90 seconds because nothing in it says the answer will
        // not change this turn. The busy slot is held by a background job the
        // agent cannot advance, so retrying is guaranteed waste.
        //
        // Validation has already PASSED to reach here, which is the part the
        // agent was actually asked for — say so, or an honest report reads as
        // total failure.
        // Still an Err: the test genuinely did not run, so the step chip must
        // stay red. What changes is that the text is now terminal.
        return Err(format!(
            "Test of \"{}\" did NOT run: another background job holds the single job slot. \
             Its definition validates, but it has not been test-run. Do not call \
             test_workflow again this turn — the slot cannot free while you wait, so every \
             retry returns this same line. Tell the user it is saved and valid, and that \
             they can test-run it once the running job finishes.",
            wf.name
        ));
    }

    // A file-scoped (run_input) workflow needs a file to run on.
    let file = args["file"].as_str().or_else(|| args["file_id"].as_str());
    let file_id = match file {
        Some(f) => Some(
            state.with_room(|room| db::find_source_file_like(&room.conn, f).map(|(id, _)| id))?,
        ),
        None => None,
    };
    if def_uses_run_input(&def) && file_id.is_none() {
        return Err(format!(
            "\"{}\" runs on a chosen file — pass `file` (a file name) so the test has something to run on.",
            wf.name
        ));
    }

    // Enqueue a real run with the "agent" trigger — NOT "manual", so a successful
    // test doesn't auto-open its output file in the viewer on every iteration (only
    // a manual run yanks the viewer). No script grants — the agent can't self-
    // approve, so any script step parks (surfaced below). The slot was free, so this
    // starts immediately rather than queuing.
    let job_id = start_workflow_run(
        window,
        state,
        &wf.id,
        "agent",
        file_id,
        &std::collections::HashSet::new(),
    )
    .await?;
    if job_id.is_empty() {
        return Err("Couldn't start a test run just now — try again in a moment.".into());
    }

    // Poll the job to a terminal status, bounded. On timeout, cancel the run.
    const TEST_TIMEOUT_SECS: u64 = 240;
    let start = std::time::Instant::now();
    let (status, err): (String, Option<String>) = loop {
        let job = state.with_room(|room| db::get_job(&room.conn, &job_id));
        if let Ok(j) = job {
            match j.status.as_str() {
                "done" => break ("done".into(), None),
                "error" => break ("error".into(), j.error.clone()),
                "paused" => break ("paused".into(), j.error.clone()),
                _ => {}
            }
        }
        if start.elapsed().as_secs() >= TEST_TIMEOUT_SECS {
            if let Some(c) = state.job_cancels.lock().unwrap().get(&job_id) {
                c.store(true, Ordering::SeqCst);
            }
            // Live QA 2026-07-25: the agent reported "the test run timed out so
            // it never got validated" while the workflow card showed a green
            // "Ran OK" — the run finished in the gap between the last poll and
            // the cancel taking effect. Read the truth one final time before
            // reporting a failure that did not happen.
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            let settled = state
                .with_room(|room| db::get_job(&room.conn, &job_id))
                .ok()
                .map(|j| (j.status.clone(), j.error.clone()));
            break match settled {
                Some((s, e)) if s == "done" || s == "error" || s == "paused" => (s, e),
                _ => ("timeout".into(), None),
            };
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    };

    // Read each step's stored artifact for a per-step report.
    let total = def.nodes.len();
    let mut lines: Vec<String> = Vec::new();
    for i in 0..total {
        let raw = state
            .with_room(|room| Ok(db::get_job_artifact(&room.conn, &job_id, i)))
            .ok()
            .flatten();
        let Some(raw) = raw else {
            lines.push(format!("{}. (did not run)", i + 1));
            continue;
        };
        let art: WfArtifact = serde_json::from_str(&raw).unwrap_or_default();
        let label = art
            .node_label
            .clone()
            .unwrap_or_else(|| format!("Step {}", i + 1));
        let kind = art.node_kind.clone().unwrap_or_default();
        let state_str = if art.skipped { "skipped" } else { "done" };
        let preview: String = art.result.trim().chars().take(240).collect();
        let preview = if preview.is_empty() {
            "(no output)".to_string()
        } else {
            preview.replace('\n', " ")
        };
        let kind_tag = if kind.is_empty() {
            String::new()
        } else {
            format!(" [{kind}]")
        };
        lines.push(format!(
            "{}. {label}{kind_tag} — {state_str}: {preview}",
            i + 1
        ));
    }

    let header = match status.as_str() {
        "done" => format!("Test of \"{}\": SUCCESS — every step ran.", wf.name),
        "error" => format!(
            "Test of \"{}\": FAILED — {}",
            wf.name,
            err.as_deref().unwrap_or("a step errored (see steps below)")
        ),
        "paused" => format!(
            "Test of \"{}\": PAUSED — {}. A script step needs the user's approval on the Scripts page (the agent can't approve code).",
            wf.name,
            err.as_deref().unwrap_or("stopped before finishing")
        ),
        _ => format!(
            "Test of \"{}\": still running after {TEST_TIMEOUT_SECS}s — stopped waiting (it may be a heavy model step). The partial results so far:",
            wf.name
        ),
    };
    // A machine-checkable gate so the model can't paraphrase a failing run into
    // "Fixed". Only a real terminal `done` counts as validated; a parked script
    // (needs the user's approval) did NOT validate anything.
    let trailer = test_run_trailer(&status);
    Ok(clamp_test_report(format!(
        "{header}\nSteps:\n{}\n\n{trailer}\n\nThe workflow stays a DRAFT for the user to review and activate.",
        lines.join("\n")
    )))
}

/// The machine-checkable verdict line, so the model cannot paraphrase a failing
/// run into "Fixed" — nor, since 2026-07-25, a still-running one into "broken".
fn test_run_trailer(status: &str) -> &'static str {
    match status {
        "done" => "VALIDATED: yes — every step ran to completion. You may now tell the user this works and the draft is ready to review & activate.",
        "paused" => "VALIDATED: no — a script step parked for the user's approval, so this run did NOT validate the workflow. Do NOT say it's fixed or works. Tell the user to review and run/approve it on the Scripts page; a script can only be confirmed by an approved run.",
        // A timeout is UNKNOWN, not failed: nothing errored, we simply stopped
        // waiting. Telling the model to "fix the failing step" made it report a
        // failure to the user for a run that went on to finish green.
        "timeout" => "VALIDATED: unknown — nothing failed; the run was still going when the wait ended. Do NOT call it broken and do NOT start fixing steps. Tell the user it is still running and they can watch it finish on the Workflows page.",
        _ => "VALIDATED: no — this run did not succeed. Fix the failing step with update_workflow and test again. Do NOT tell the user it's fixed or ready until a test_workflow returns VALIDATED: yes.",
    }
}

/// Bound the test report so a chatty run can't blow the tool-result budget.
fn clamp_test_report(s: String) -> String {
    const MAX: usize = 6000;
    if s.len() <= MAX {
        return s;
    }
    let mut cut = s
        .char_indices()
        .map(|(i, _)| i)
        .take_while(|&i| i <= MAX)
        .last()
        .unwrap_or(0);
    if cut == 0 {
        cut = s.len();
    }
    format!("{}…\n(report truncated)", &s[..cut])
}

/// Wave 4a: the workflow agent tools. Like the job tools, NEVER in `tools_catalog`
/// (so a cloud client can't reach them) — served only over the bridge for the
/// LocalEngine/ExternalAgent scopes and gated by the jobs routing flag.
/// The node grammar `save_workflow` needs — served ONCE per workflow task as an
/// epilogue on the `list_workflows` index, not on every turn the workflow tier
/// is offered (2026-07-28).
///
/// It lived inside `save_workflow`'s own description: 2,668 characters of DSL
/// against 1,203 for `test_workflow`, 860 for `create_file`, 639 for
/// `start_file_pass`. Every turn that served the workflow tools paid for the
/// whole grammar whether or not the model was authoring anything — a real bill
/// against an 8k local window, and the reason those windows kept
/// context-shifting.
///
/// `list_workflows` is the right home because the Workflow agent's flow opens
/// with it as a free `probe` (see `agents.py`), so an authoring task gets the
/// grammar on its first round, in full, exactly when it is about to be used.
pub const WORKFLOW_NODE_REFERENCE: &str = "\n\n## Node reference (for save_workflow / update_workflow)\n\
`definition` is {version, nodes, edges}; edges are [{from, to, branch?}]. Every edge OUT of a condition or a \
route MUST carry `branch` (then|else for a condition, one of the route's own labels); no other edge may.\n\
MODEL nodes: generate {prompt, model} · summarize_file {select} · file_pass {select, instruction, mode} · \
for_each_file {select, instruction} (runs on EACH selected file) · agent_run {question} · \
extract {fields:[...]} (structured JSON out of {{input}}) · route {prompt, labels:[...]} (tags input with one \
label → edges use branch:<label>, an N-way condition) · vote {prompt, samples, mode:concat|majority} · \
refine {prompt, rubric, max_rounds} (generate→critique→revise loop) · \
plan_and_map {objective, max_workers} (decompose→work→synthesize).\n\
DETERMINISTIC nodes (no model): transform {op:append|prepend|replace|upper|lower|trim|truncate|strip_html, find?, value?} · \
merge {mode:concat|dedupe_lines|numbered} (join parallel branches) · http_fetch {url} · \
script_run {file, mode:import|transform} (runs a room .py/.js; transform pipes {{input}}→stdin→stdout) · \
save_file {name_template, format, mode} · condition {op, value}.\n\
`select` types: newest | all | name_like (+pattern) | missing_summary | since_last_run | run_input — except \
file_pass, which reads ONE file and rejects `all` (use for_each_file to cover every file).\n\
Parallelism = several edges out of one node, re-joined by a merge. Prompts support {{input}} (upstream \
results), {{files}} (file list), {{date}}. Give every node a short `label` (2-4 words in the user's \
language, e.g. \"Write the digest\") so the canvas reads as plain steps, not kind names.\n\
Set binding {\"scope\":\"file\",\"kinds\":[\"pdf\"]} for a workflow that runs on the file the user is looking \
at (its nodes use select {\"type\":\"run_input\"}).\n\
Example: {\"name\":\"Morning digest\",\"emoji\":\"🌅\",\"definition\":{\"version\":1,\"nodes\":[\
{\"id\":\"gen\",\"kind\":\"generate\",\"label\":\"Write the digest\",\"model\":\"auto\",\"prompt\":\"Digest the new files:\\n{{files}}\"},\
{\"id\":\"save\",\"kind\":\"save_file\",\"label\":\"Save today's digest\",\"name_template\":\"Digest {{date}}\",\"format\":\"html\",\"mode\":\"create\"}],\
\"edges\":[{\"from\":\"gen\",\"to\":\"save\"}]},\"schedule\":{\"kind\":\"daily\",\"param\":\"08:00\"}}";

pub fn workflow_tools_specs() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"type": "function", "function": {"name": "list_workflows",
            "description": "List the saved workflows in this room (name, id, status, schedule), and the full node reference you need to write one. Call this FIRST when creating or changing a workflow. Pass `name` to get one workflow's definition JSON — needed before update_workflow.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "Optional: a workflow name to fetch its full definition"}}}}}),
        serde_json::json!({"type": "function", "function": {"name": "save_workflow",
            "description": "Create a reusable multi-step workflow as a DRAFT the user reviews and activates on the Workflows page. `definition` is a graph of nodes + edges — call list_workflows first for the full node reference (kinds, `select` types, {{input}}/{{files}}/{{date}}, and a worked example). Validation is strict: an invalid definition comes back as a numbered list to fix. After saving, don't stop there: call test_workflow to actually RUN it, read which step failed, fix it with update_workflow, and test again until test_workflow returns `VALIDATED: yes` — only then tell the user the draft is ready to activate. NEVER tell the user it's fixed or works before a test returns `VALIDATED: yes`; a script_run step can only be confirmed by an approved run on the Scripts page.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string"},
                "description": {"type": "string"},
                "emoji": {"type": "string"},
                "definition": {"type": "object", "description": "The workflow graph {version, nodes, edges}"},
                "binding": {"type": "object", "description": "Optional {scope: general|file, kinds?, exts?, file_id?}"},
                "schedule": {"type": "object", "description": "Optional {kind: interval|daily|weekly, param}"}},
                "required": ["name", "definition"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "update_workflow",
            "description": "Change an existing workflow (fetch it first with list_workflows). Same validation as save_workflow. Updating an ACTIVE workflow returns it to draft until the user re-activates it — the review gate.",
            "parameters": {"type": "object", "properties": {
                "name_or_id": {"type": "string"},
                "name": {"type": "string"},
                "description": {"type": "string"},
                "emoji": {"type": "string"},
                "definition": {"type": "object"},
                "binding": {"type": "object"},
                "schedule": {"type": "object"}},
                "required": ["name_or_id"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "delete_workflow",
            "description": "Delete a workflow and its schedule/run history. Any unfinished run is cancelled first. Use only when the user explicitly asks to delete that workflow.",
            "parameters": {"type": "object", "properties": {
                "name_or_id": {"type": "string", "description": "Workflow name or id"}},
                "required": ["name_or_id"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "run_workflow",
            "description": "Run an ACTIVE workflow now, in the background. Optionally pass `file` (a file name) for a file-scoped workflow. After starting it, tell the user it is underway — do not wait for it or poll.",
            "parameters": {"type": "object", "properties": {
                "name_or_id": {"type": "string"},
                "file": {"type": "string", "description": "Optional file name for a file-scoped workflow"}},
                "required": ["name_or_id"]}}}),
        serde_json::json!({"type": "function", "function": {"name": "test_workflow",
            "description": "TEST a workflow you're building: run it (draft or active) to completion RIGHT NOW and get the result of every step back, so you can see what failed and fix it. This is how you iterate — save_workflow (draft) → test_workflow → read the failing step → update_workflow to fix it → test_workflow again → repeat until the result says `VALIDATED: yes`, then tell the user it's ready to activate. The result ends with `VALIDATED: yes` only when every step actually ran; treat `VALIDATED: no` as not-yet-working and never report success on it. Unlike run_workflow this WAITS and returns the outcome (each step's label, kind, whether it was skipped, and a preview of its output). It never changes the workflow's status — a tested workflow stays a DRAFT for the user to review and activate. A script_run step needs the user's approval (you can't approve code), so it PARKS in a test and comes back `VALIDATED: no` — that does NOT mean the script works; tell the user to approve and run it on the Scripts page, don't claim it's fixed. Only runs when no other job is busy; if it says another job is running, ask the user to wait and try again. Pass `file` (a file name) for a file-scoped workflow.",
            "parameters": {"type": "object", "properties": {
                "name_or_id": {"type": "string"},
                "file": {"type": "string", "description": "Optional file name for a file-scoped workflow"}},
                "required": ["name_or_id"]}}}),
    ]
}

// ---------------------------------------------------------------- templates

/// Four prebuilt workflows for the empty-state gallery. The JSON doubles as the
/// agent's few-shot examples (one is embedded in save_workflow's spec).
pub fn builtin_templates() -> Vec<serde_json::Value> {
    vec![
        // Morning digest — condition on new files → digest → save (daily 08:00).
        serde_json::json!({
            "name": "Morning digest",
            "description": "Each morning, if new files arrived, write a short digest of them.",
            "emoji": "🌅",
            "binding": { "scope": "general" },
            "schedule": { "kind": "daily", "param": "08:00", "enabled": true, "catchUp": true },
            "definition": {
                "version": 1,
                "nodes": [
                    { "id": "check", "label": "Any new files?", "kind": "condition",
                      "op": "new_files_since_last_run" },
                    { "id": "digest", "label": "Write the digest", "kind": "generate",
                      "model": "auto",
                      "prompt": "Write a short, friendly morning digest of what's new in this room. Files:\n{{files}}\nKeep it to a few bullet points." },
                    { "id": "save", "label": "Save the page", "kind": "save_file",
                      "name_template": "Morning digest {{date}}", "format": "html", "mode": "create" }
                ],
                "edges": [
                    { "from": "check", "to": "digest", "branch": "then" },
                    { "from": "digest", "to": "save" }
                ]
            }
        }),
        // New-file summarizer — index every still-missing file (interval 30 min).
        serde_json::json!({
            "name": "New-file summarizer",
            "description": "Keep every file's one-line description up to date.",
            "emoji": "📥",
            "binding": { "scope": "general" },
            "schedule": { "kind": "interval", "param": "30", "enabled": true, "catchUp": false },
            "definition": {
                "version": 1,
                "nodes": [
                    { "id": "index", "label": "Summarize new files", "kind": "summarize_file",
                      "select": { "type": "missing_summary" } }
                ],
                "edges": []
            }
        }),
        // Weekly review — what changed this week (weekly Fri 16:00).
        serde_json::json!({
            "name": "Weekly review",
            "description": "A Friday review of what changed and the open questions.",
            "emoji": "📅",
            "binding": { "scope": "general" },
            "schedule": { "kind": "weekly", "param": "5 16:00", "enabled": true, "catchUp": true },
            "definition": {
                "version": 1,
                "nodes": [
                    { "id": "review", "label": "Write the review", "kind": "generate",
                      "model": "auto",
                      "prompt": "Given these files, write a weekly review: what changed this week and the open questions.\n{{files}}" },
                    { "id": "save", "label": "Save the review", "kind": "save_file",
                      "name_template": "Weekly review {{date}}", "format": "html", "mode": "create" }
                ],
                "edges": [ { "from": "review", "to": "save" } ]
            }
        }),
        // Deep read — a full pass over the newest file (manual; run from Actions).
        serde_json::json!({
            "name": "Deep read",
            "description": "Read a whole file end to end and save a thorough summary.",
            "emoji": "📖",
            "binding": { "scope": "general" },
            "definition": {
                "version": 1,
                "nodes": [
                    { "id": "pass", "label": "Full pass", "kind": "file_pass",
                      "select": { "type": "newest" },
                      "instruction": "Summarize this file thoroughly — every section, name and figure.",
                      "mode": "merge" }
                ],
                "edges": []
            }
        }),
        // Compare perspectives — a DIAMOND: one brief fans out to two parallel
        // reads, which a merge re-joins (fan-out + fan-in, the sectioning pattern).
        serde_json::json!({
            "name": "Compare perspectives",
            "description": "Look at the room from two angles at once, then combine them.",
            "emoji": "⚖️",
            "binding": { "scope": "general" },
            "definition": {
                "version": 1,
                "nodes": [
                    { "id": "brief", "label": "Gather the material", "kind": "generate",
                      "model": "auto", "prompt": "Briefly summarize what's in this room:\n{{files}}" },
                    { "id": "pro", "label": "The optimistic read", "kind": "generate",
                      "model": "auto", "prompt": "Argue the OPTIMISTIC case about this:\n{{input}}" },
                    { "id": "con", "label": "The skeptical read", "kind": "generate",
                      "model": "auto", "prompt": "Argue the SKEPTICAL case about this:\n{{input}}" },
                    { "id": "merge", "label": "Combine both", "kind": "merge", "mode": "numbered" },
                    { "id": "save", "label": "Save the memo", "kind": "save_file",
                      "name_template": "Two views {{date}}", "format": "html", "mode": "create" }
                ],
                "edges": [
                    { "from": "brief", "to": "pro" },
                    { "from": "brief", "to": "con" },
                    { "from": "pro", "to": "merge" },
                    { "from": "con", "to": "merge" },
                    { "from": "merge", "to": "save" }
                ]
            }
        }),
        // Summarize every file — for_each_file sectioning over the whole room.
        serde_json::json!({
            "name": "Summarize every file",
            "description": "Write a short summary of every file, then save one page.",
            "emoji": "🗂️",
            "binding": { "scope": "general" },
            "definition": {
                "version": 1,
                "nodes": [
                    { "id": "each", "label": "Read each file", "kind": "for_each_file",
                      "model": "auto", "select": { "type": "all" },
                      "instruction": "Summarize this file in a short paragraph." },
                    { "id": "save", "label": "Save the digest", "kind": "save_file",
                      "name_template": "File digest {{date}}", "format": "md", "mode": "create" }
                ],
                "edges": [ { "from": "each", "to": "save" } ]
            }
        }),
        // Triage the newest note — a ROUTE fans to three specialized handlers that
        // re-converge on a save (N-way routing pattern).
        serde_json::json!({
            "name": "Triage the newest note",
            "description": "Sort the newest file into a bucket and act on it.",
            "emoji": "🧭",
            "binding": { "scope": "general" },
            "definition": {
                "version": 1,
                "nodes": [
                    { "id": "read", "label": "Read newest", "kind": "summarize_file",
                      "select": { "type": "newest" } },
                    { "id": "route", "label": "Which bucket?", "kind": "route",
                      "prompt": "Which bucket does this belong in?",
                      "labels": ["action", "reference", "idea"] },
                    { "id": "act", "label": "Make a checklist", "kind": "generate",
                      "model": "auto", "prompt": "Turn this into a short action checklist:\n{{input}}" },
                    { "id": "ref", "label": "Note the reference", "kind": "generate",
                      "model": "auto", "prompt": "Write a one-line reference note for this:\n{{input}}" },
                    { "id": "idea", "label": "Expand the idea", "kind": "generate",
                      "model": "auto", "prompt": "Expand this idea into a paragraph:\n{{input}}" },
                    { "id": "save", "label": "Save it", "kind": "save_file",
                      "name_template": "Triage {{date}}", "format": "html", "mode": "create" }
                ],
                "edges": [
                    { "from": "read", "to": "route" },
                    { "from": "route", "to": "act", "branch": "action" },
                    { "from": "route", "to": "ref", "branch": "reference" },
                    { "from": "route", "to": "idea", "branch": "idea" },
                    { "from": "act", "to": "save" },
                    { "from": "ref", "to": "save" },
                    { "from": "idea", "to": "save" }
                ]
            }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: serde_json::Value) -> WorkflowDef {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_timed_out_test_run_is_unknown_not_failed() {
        // Live QA 2026-07-25: the agent told the user "the test run timed out so
        // it never got validated" while the workflow card showed a green
        // "Ran OK". Nothing failed — we stopped waiting — but the trailer said
        // "this run did not succeed. Fix the failing step", so the model
        // reported a failure that never happened.
        let timeout = test_run_trailer("timeout");
        assert!(timeout.starts_with("VALIDATED: unknown"));
        assert!(timeout.contains("nothing failed"));
        assert!(!timeout.contains("did not succeed"));
        assert!(!timeout.contains("Fix the failing step"));
        // The verdicts that DO mean something still say so plainly.
        assert!(test_run_trailer("done").starts_with("VALIDATED: yes"));
        assert!(test_run_trailer("error").starts_with("VALIDATED: no"));
        assert!(test_run_trailer("paused").starts_with("VALIDATED: no"));
    }

    #[test]
    fn resolve_node_model_honors_external_engines_on_the_cloud_lane() {
        let models = vec!["qwen3.5:4b".to_string(), "minimax-m3:cloud".to_string()];
        // Engine parity: "auto" keeps the room's external CLI choice.
        let (m, lane) = resolve_node_model("auto", &Some("claude-cli::opus".into()), &models);
        assert_eq!(m, "claude-cli::opus");
        assert!(matches!(lane, Lane::Cloud));
        // A literal external engine is honored too.
        let (m, lane) = resolve_node_model("codex-cli", &None, &models);
        assert_eq!(m, "codex-cli");
        assert!(matches!(lane, Lane::Cloud));
        // "local" stays a hard local pick whatever the room engine is.
        let (m, lane) = resolve_node_model("local", &Some("codex-cli".into()), &models);
        assert_eq!(m, "qwen3.5:4b");
        assert!(matches!(lane, Lane::LocalLlm));
        // `:cloud` proxies keep riding the cloud lane.
        let (_, lane) = resolve_node_model("cloud", &None, &models);
        assert!(matches!(lane, Lane::Cloud));
    }

    fn linear_def() -> WorkflowDef {
        parse(serde_json::json!({
            "version": 1,
            "nodes": [
                { "id": "a", "kind": "generate", "prompt": "hi {{input}}", "model": "auto" },
                { "id": "b", "kind": "save_file", "name_template": "out", "format": "html", "mode": "create" }
            ],
            "edges": [ { "from": "a", "to": "b" } ]
        }))
    }

    #[test]
    fn validate_accepts_a_linear_def_and_the_templates() {
        assert!(validate_definition(&linear_def()).is_ok());
        for t in builtin_templates() {
            let def: WorkflowDef = serde_json::from_value(t["definition"].clone()).unwrap();
            assert!(
                validate_definition(&def).is_ok(),
                "template {} invalid",
                t["name"]
            );
        }
    }

    #[test]
    fn validate_names_a_cycle() {
        let def = parse(serde_json::json!({
            "nodes": [
                { "id": "a", "kind": "generate", "prompt": "x" },
                { "id": "b", "kind": "generate", "prompt": "y" }
            ],
            "edges": [ { "from": "a", "to": "b" }, { "from": "b", "to": "a" } ]
        }));
        let errs = validate_definition(&def).unwrap_err();
        assert!(
            errs.iter()
                .any(|e| e.contains("cycle") && e.contains("a") && e.contains("b")),
            "cycle must be named: {errs:?}"
        );
    }

    #[test]
    fn validate_flags_dangling_edges_and_bad_branches() {
        let def = parse(serde_json::json!({
            "nodes": [
                { "id": "a", "kind": "generate", "prompt": "x" },
                { "id": "b", "kind": "save_file", "name_template": "o" }
            ],
            // edge to unknown node + a branch off a non-condition
            "edges": [ { "from": "a", "to": "ghost" }, { "from": "a", "to": "b", "branch": "then" } ]
        }));
        let errs = validate_definition(&def).unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("ghost")),
            "dangling edge: {errs:?}"
        );
        assert!(
            errs.iter().any(|e| e.contains("not a condition")),
            "bad branch: {errs:?}"
        );
    }

    #[test]
    fn validate_flags_unknown_selector_and_op() {
        let def = parse(serde_json::json!({
            "nodes": [
                { "id": "s", "kind": "summarize_file", "select": { "type": "bogus" } },
                { "id": "c", "kind": "condition", "op": "sometimes" }
            ],
            "edges": []
        }));
        let errs = validate_definition(&def).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("file selector")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("condition")), "{errs:?}");
    }

    #[test]
    fn all_is_a_valid_selector() {
        let def = parse(serde_json::json!({
            "nodes": [ { "id": "s", "kind": "summarize_file", "select": { "type": "all" } } ],
            "edges": []
        }));
        assert!(validate_definition(&def).is_ok());
    }

    // The composer model can only pick selectors/ops it was told about — the
    // original 'all' bug was the prompt teaching none of them.
    #[test]
    fn compose_prompt_teaches_the_full_palette() {
        let prompt = compose_prompt("x");
        for sel in FILE_SELECTORS {
            assert!(
                prompt.contains(sel),
                "selector '{sel}' missing from compose prompt"
            );
        }
        for op in CONDITION_OPS {
            assert!(
                prompt.contains(op),
                "condition op '{op}' missing from compose prompt"
            );
        }
    }

    #[test]
    fn run_input_requires_a_file_binding() {
        let def = parse(serde_json::json!({
            "nodes": [ { "id": "p", "kind": "file_pass", "select": { "type": "run_input" },
                        "instruction": "read it" } ],
            "edges": []
        }));
        assert!(def_uses_run_input(&def));
        // General binding is rejected…
        let err = validate_with_binding(&def, &WorkflowBinding::General {}).unwrap_err();
        assert!(err[0].contains("file-scoped"), "{err:?}");
        // …file binding is accepted.
        assert!(validate_with_binding(
            &def,
            &WorkflowBinding::File {
                kinds: vec!["pdf".into()],
                exts: vec![],
                file_id: None
            }
        )
        .is_ok());
    }

    #[test]
    fn compile_produces_dense_topo_ids_and_lanes() {
        // condition(cpu) → generate(local) → save_file(cpu), declared out of order.
        let def = parse(serde_json::json!({
            "nodes": [
                { "id": "save", "kind": "save_file", "name_template": "o" },
                { "id": "gen", "kind": "generate", "prompt": "p", "model": "local" },
                // A ROOM-reading condition, so it is legitimately a first step
                // (a text check with nothing upstream is a validation error).
                { "id": "cond", "kind": "condition", "op": "new_files_since_last_run" }
            ],
            "edges": [ { "from": "cond", "to": "gen", "branch": "then" }, { "from": "gen", "to": "save" } ]
        }));
        let models = vec!["qwen3.5:4b".to_string()];
        let steps = compile_workflow(&def, &None, &models).unwrap();
        assert_eq!(steps.len(), 3);
        // Dense ids 0..n, every dep lower than its step (valid resume ordering).
        for (i, s) in steps.iter().enumerate() {
            assert_eq!(s.id, i);
            for d in &s.depends_on {
                assert!(*d < s.id, "step {} depends on later {}", s.id, d);
            }
        }
        // cond is a root (no deps) and on the Cpu lane; the generate is LocalLlm.
        let cond = steps
            .iter()
            .find(|s| s.params["node"]["id"] == "cond")
            .unwrap();
        assert!(cond.depends_on.is_empty());
        assert_eq!(cond.lane, Lane::Cpu);
        let gen = steps
            .iter()
            .find(|s| s.params["node"]["id"] == "gen")
            .unwrap();
        assert_eq!(gen.lane, Lane::LocalLlm);
        // The generate's incoming edge carries the 'then' branch of the condition.
        let inc = gen.params["incoming"].as_array().unwrap();
        assert_eq!(inc.len(), 1);
        assert_eq!(inc[0]["branch"], "then");
    }

    #[test]
    fn compile_bounces_an_invalid_def() {
        let def = parse(serde_json::json!({
            "nodes": [ { "id": "a", "kind": "generate", "prompt": "" } ],
            "edges": []
        }));
        let err = compile_workflow(&def, &None, &[]).unwrap_err();
        assert!(err.iter().any(|e| e.contains("empty prompt")), "{err:?}");
    }

    #[test]
    fn edge_liveness_rule() {
        let done = WfArtifact {
            result: "hi".into(),
            ..Default::default()
        };
        let skipped = WfArtifact {
            skipped: true,
            ..Default::default()
        };
        let then_branch = WfArtifact {
            branch: Some("then".into()),
            ..Default::default()
        };
        // No branch: live iff not skipped, missing = dead.
        assert!(edge_is_live(Some(&done), &None));
        assert!(!edge_is_live(Some(&skipped), &None));
        assert!(!edge_is_live(None, &None));
        // Branch edge: live only on a matching condition branch.
        assert!(edge_is_live(Some(&then_branch), &Some("then".into())));
        assert!(!edge_is_live(Some(&then_branch), &Some("else".into())));
    }

    #[test]
    fn condition_ops_evaluate() {
        assert!(eval_condition(
            "contains",
            "hello world",
            &Some("world".into()),
            0
        ));
        assert!(!eval_condition("contains", "hello", &Some("bye".into()), 0));
        assert!(eval_condition(
            "not_contains",
            "hello",
            &Some("bye".into()),
            0
        ));
        assert!(eval_condition("is_empty", "   ", &None, 0));
        assert!(eval_condition("not_empty", "x", &None, 0));
        assert!(eval_condition("new_files_since_last_run", "", &None, 3));
        assert!(!eval_condition("new_files_since_last_run", "", &None, 0));
    }

    // ---- richer palette: pure helpers + validation ----

    #[test]
    fn transform_ops_are_deterministic() {
        assert_eq!(
            apply_transform("append", &None, &Some(" world".into()), "hi"),
            "hi world"
        );
        assert_eq!(
            apply_transform("prepend", &None, &Some(">> ".into()), "hi"),
            ">> hi"
        );
        assert_eq!(
            apply_transform("replace", &Some("a".into()), &Some("b".into()), "banana"),
            "bbnbnb"
        );
        assert_eq!(apply_transform("upper", &None, &None, "hi"), "HI");
        assert_eq!(apply_transform("lower", &None, &None, "HI"), "hi");
        assert_eq!(apply_transform("trim", &None, &None, "  hi \n"), "hi");
        assert_eq!(
            apply_transform("truncate", &None, &Some("3".into()), "abcdef"),
            "abc"
        );
        assert_eq!(
            apply_transform("strip_html", &None, &None, "<b>hi</b>").trim(),
            "hi"
        );
        // Unknown op is a passthrough (validation catches it earlier).
        assert_eq!(apply_transform("bogus", &None, &None, "hi"), "hi");
    }

    #[test]
    fn merge_modes_combine_branches() {
        let inputs = vec!["a\nb".to_string(), "b\nc".to_string()];
        assert_eq!(
            apply_merge("concat", &Some("|".into()), &inputs),
            "a\nb|b\nc"
        );
        assert_eq!(
            apply_merge("numbered", &Some("\n".into()), &inputs),
            "1. a\nb\n2. b\nc"
        );
        // dedupe_lines keeps first occurrence order, drops the repeat 'b'.
        assert_eq!(apply_merge("dedupe_lines", &None, &inputs), "a\nb\nc");
    }




    #[test]
    fn validate_route_needs_labels_and_legal_branches() {
        // Fewer than two labels is rejected.
        let bad = parse(serde_json::json!({
            "nodes": [ { "id": "r", "kind": "route", "labels": ["only"] } ],
            "edges": []
        }));
        assert!(validate_definition(&bad)
            .unwrap_err()
            .iter()
            .any(|e| e.contains("two labels")));
        // A branch label the route doesn't declare is rejected.
        let bad2 = parse(serde_json::json!({
            "nodes": [
                { "id": "r", "kind": "route", "labels": ["a", "b"] },
                { "id": "g", "kind": "generate", "prompt": "x" }
            ],
            "edges": [ { "from": "r", "to": "g", "branch": "c" } ]
        }));
        assert!(validate_definition(&bad2)
            .unwrap_err()
            .iter()
            .any(|e| e.contains("no such label")));
        // A legal route graph validates.
        let ok = parse(serde_json::json!({
            "nodes": [
                { "id": "r", "kind": "route", "labels": ["a", "b"] },
                { "id": "g", "kind": "generate", "prompt": "x" },
                { "id": "h", "kind": "generate", "prompt": "y" }
            ],
            "edges": [
                { "from": "r", "to": "g", "branch": "a" },
                { "from": "r", "to": "h", "branch": "b" }
            ]
        }));
        assert!(validate_definition(&ok).is_ok());
    }

    #[test]
    fn an_unlabelled_exit_from_a_branch_step_is_rejected() {
        // An edge with no branch is live whichever way the step went, so a
        // route with unlabelled exits runs EVERY handler at once and pays for
        // all of them. The step editor's "Runs after" checkboxes create exactly
        // these, and saving reported no problem.
        let route = parse(serde_json::json!({
            "nodes": [
                { "id": "r", "kind": "route", "labels": ["a", "b"] },
                { "id": "g", "kind": "generate", "prompt": "x" },
                { "id": "h", "kind": "generate", "prompt": "y" }
            ],
            "edges": [
                { "from": "r", "to": "g", "branch": "a" },
                { "from": "r", "to": "h" }
            ]
        }));
        let errs = validate_definition(&route).unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("r→h") && e.contains("which label")),
            "{errs:?}"
        );
        // Same rule off a condition.
        let cond = parse(serde_json::json!({
            "nodes": [
                { "id": "s", "kind": "transform", "op": "trim" },
                { "id": "c", "kind": "condition", "op": "not_empty" },
                { "id": "g", "kind": "generate", "prompt": "x" }
            ],
            "edges": [ { "from": "s", "to": "c" }, { "from": "c", "to": "g" } ]
        }));
        let errs = validate_definition(&cond).unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("c→g") && e.contains("which outcome")),
            "{errs:?}"
        );
        // A plain (non-branching) step's unlabelled edges are still fine.
        assert!(validate_definition(&linear_def()).is_ok());
    }

    #[test]
    fn a_text_condition_needs_both_a_needle_and_something_to_read() {
        // An empty "contains" box matches EVERY text, so the branch is decided
        // before it is asked; and a text check with nothing wired into it reads
        // an empty string forever. Neither was flagged when saving.
        let empty_needle = parse(serde_json::json!({
            "nodes": [
                { "id": "s", "kind": "transform", "op": "trim" },
                { "id": "c", "kind": "condition", "op": "contains", "value": "  " }
            ],
            "edges": [ { "from": "s", "to": "c" } ]
        }));
        let errs = validate_definition(&empty_needle).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("what to look for")), "{errs:?}");

        let nothing_upstream = parse(serde_json::json!({
            "nodes": [ { "id": "c", "kind": "condition", "op": "not_empty" } ],
            "edges": []
        }));
        let errs = validate_definition(&nothing_upstream).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("nothing runs before it")), "{errs:?}");

        // new_files_since_last_run reads the ROOM, not the pipeline — it is
        // legitimately a first step and needs no value.
        let first_step = parse(serde_json::json!({
            "nodes": [ { "id": "c", "kind": "condition", "op": "new_files_since_last_run" } ],
            "edges": []
        }));
        assert!(validate_definition(&first_step).is_ok());
    }

    #[test]
    fn a_full_file_pass_may_not_be_pointed_at_all_files() {
        // The editor let you point a file_pass at "all files"; it then kept the
        // single newest match and dropped the rest in silence, so "read all my
        // files thoroughly" read one file. Name the step that covers them all.
        let def = parse(serde_json::json!({
            "nodes": [ { "id": "p", "kind": "file_pass", "select": { "type": "all" },
                         "instruction": "read it" } ],
            "edges": []
        }));
        let errs = validate_definition(&def).unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("for_each_file") && e.contains("newest")),
            "{errs:?}"
        );
        // for_each_file over "all" is exactly the right shape and stays valid.
        let each = parse(serde_json::json!({
            "nodes": [ { "id": "e", "kind": "for_each_file", "select": { "type": "all" },
                         "instruction": "summarize it" } ],
            "edges": []
        }));
        assert!(validate_definition(&each).is_ok());
    }

    #[test]
    fn a_runaway_definition_is_refused() {
        // The assistant writes workflows itself, so a runaway one used to save
        // and queue with no warning at all.
        let nodes: Vec<serde_json::Value> = (0..MAX_NODES + 1)
            .map(|i| serde_json::json!({ "id": format!("n{i}"), "kind": "transform", "op": "trim" }))
            .collect();
        let huge = parse(serde_json::json!({ "nodes": nodes, "edges": [] }));
        let errs = validate_definition(&huge).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("steps")), "{errs:?}");

        // A single node's instructions are bounded too.
        let long = parse(serde_json::json!({
            "nodes": [ { "id": "g", "kind": "generate", "prompt": "x".repeat(MAX_NODE_TEXT + 1) } ],
            "edges": []
        }));
        let errs = validate_definition(&long).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("longer than")), "{errs:?}");
        // Right at the limit is still fine.
        let ok = parse(serde_json::json!({
            "nodes": [ { "id": "g", "kind": "generate", "prompt": "x".repeat(MAX_NODE_TEXT) } ],
            "edges": []
        }));
        assert!(validate_definition(&ok).is_ok());
    }

    #[test]
    fn a_workflow_saved_before_these_rules_existed_still_runs() {
        // Every rule above is checked on SAVE, and `compile_workflow` runs on
        // every START. So the moment they landed, definitions the app itself
        // wrote stopped being startable — and a SCHEDULED start reports nothing
        // (scheduler.rs advances next_run_at and moves on: no run row, no
        // error), so a months-old automation just stopped firing.
        //
        // The rules stay; they just apply where the author can act on them.
        let grandfathered = [
            // An unlabelled exit from a condition — what the "Runs after"
            // checkbox and the old add-a-step-after path both write.
            serde_json::json!({
                "nodes": [
                    { "id": "s", "kind": "transform", "op": "trim" },
                    { "id": "c", "kind": "condition", "op": "not_empty" },
                    { "id": "g", "kind": "generate", "prompt": "x" }
                ],
                "edges": [ { "from": "s", "to": "c" }, { "from": "c", "to": "g" } ]
            }),
            // …and from a route.
            serde_json::json!({
                "nodes": [
                    { "id": "r", "kind": "route", "labels": ["a", "b"] },
                    { "id": "g", "kind": "generate", "prompt": "x" }
                ],
                "edges": [ { "from": "r", "to": "g" } ]
            }),
            // A file_pass on "All files" — still an option in the dropdown.
            serde_json::json!({
                "nodes": [ { "id": "p", "kind": "file_pass", "select": { "type": "all" },
                             "instruction": "read it" } ],
                "edges": []
            }),
            // A condition with an empty needle, and one with nothing upstream.
            serde_json::json!({
                "nodes": [
                    { "id": "s", "kind": "transform", "op": "trim" },
                    { "id": "c", "kind": "condition", "op": "contains", "value": "" }
                ],
                "edges": [ { "from": "s", "to": "c" } ]
            }),
            serde_json::json!({
                "nodes": [ { "id": "c", "kind": "condition", "op": "not_empty" } ],
                "edges": []
            }),
            // A prompt longer than the (new) per-node text cap.
            serde_json::json!({
                "nodes": [ { "id": "g", "kind": "generate",
                             "prompt": "x".repeat(MAX_NODE_TEXT + 1) } ],
                "edges": []
            }),
        ];
        for (i, raw) in grandfathered.iter().enumerate() {
            let def = parse(raw.clone());
            assert!(
                validate_definition(&def).is_err(),
                "#{i}: saving must still refuse it — that is where it gets fixed"
            );
            assert!(
                validate_runnable(&def).is_ok(),
                "#{i}: an already-saved workflow must still start: {:?}",
                validate_runnable(&def).unwrap_err()
            );
            assert!(
                compile_workflow(&def, &None, &[]).is_ok(),
                "#{i}: starting a run compiles through validate_runnable"
            );
        }
        // A runaway node count is an authoring guard-rail too.
        let nodes: Vec<serde_json::Value> = (0..MAX_NODES + 1)
            .map(|i| serde_json::json!({ "id": format!("n{i}"), "kind": "transform", "op": "trim" }))
            .collect();
        let huge = parse(serde_json::json!({ "nodes": nodes, "edges": [] }));
        assert!(validate_definition(&huge).is_err());
        assert!(validate_runnable(&huge).is_ok());

        // What run-time leniency does NOT cover: a definition that cannot be
        // executed at all is still refused, at both gates.
        let structural = [
            // An unknown selector, an illegal branch label, a dangling edge…
            serde_json::json!({
                "nodes": [ { "id": "s", "kind": "summarize_file", "select": { "type": "sideways" } } ],
                "edges": []
            }),
            serde_json::json!({
                "nodes": [
                    { "id": "c", "kind": "condition", "op": "new_files_since_last_run" },
                    { "id": "g", "kind": "generate", "prompt": "x" }
                ],
                "edges": [ { "from": "c", "to": "g", "branch": "maybe" } ]
            }),
            serde_json::json!({
                "nodes": [ { "id": "g", "kind": "generate", "prompt": "x" } ],
                "edges": [ { "from": "g", "to": "ghost" } ]
            }),
            // …and a cycle.
            serde_json::json!({
                "nodes": [
                    { "id": "a", "kind": "transform", "op": "trim" },
                    { "id": "b", "kind": "transform", "op": "trim" }
                ],
                "edges": [ { "from": "a", "to": "b" }, { "from": "b", "to": "a" } ]
            }),
        ];
        for (i, raw) in structural.iter().enumerate() {
            let def = parse(raw.clone());
            assert!(validate_definition(&def).is_err(), "structural #{i}");
            assert!(
                validate_runnable(&def).is_err(),
                "structural #{i}: a def that cannot run must never start"
            );
        }
    }

    #[test]
    fn the_node_reference_agrees_with_the_validator() {
        // The model authors workflows from this text and is then bounced by
        // `validate_definition`. Two rules were added without touching the
        // spec, so a model that followed it exactly spent one of its two
        // attempts on a rule it was never told about.
        let r = WORKFLOW_NODE_REFERENCE;
        assert!(r.contains("MUST carry `branch`"), "the branch rule is not in the spec");
        assert!(r.contains("rejects `all`"), "the file_pass/`all` rule is not in the spec");
        // And the spec's own worked example must pass the gate it documents.
        let example = r
            .split_once("Example: ")
            .expect("the reference carries a worked example")
            .1;
        let v: serde_json::Value =
            serde_json::from_str(example.trim()).expect("the example must be valid JSON");
        let def = parse(v["definition"].clone());
        assert!(
            validate_definition(&def).is_ok(),
            "the reference's own example does not validate: {:?}",
            validate_definition(&def).unwrap_err()
        );
    }

    #[test]
    fn a_name_contains_filter_is_not_a_wildcard() {
        // `_` and `%` are wildcards to SQL LIKE, so filtering for q3_report also
        // matched q3-report and q3xreport — a workflow running on files the
        // user never meant. The escaped pattern only matches a literal.
        assert_eq!(like_escape("q3_report"), "q3\\_report");
        assert_eq!(like_escape("50%"), "50\\%");
        assert_eq!(like_escape("a\\b"), "a\\\\b");
        assert_eq!(like_escape("plain name.pdf"), "plain name.pdf");
    }

    #[test]
    fn a_saved_file_name_cannot_be_a_pasted_model_reply() {
        // The name template runs through `interpolate`, so {{input}} can drop a
        // whole answer — newlines, slashes and all — into a file name.
        let long = "word ".repeat(200);
        let cleaned = clean_save_name(&long);
        assert!(cleaned.chars().count() <= MAX_SAVE_NAME_CHARS);
        assert_eq!(clean_save_name("Digest\n2026/07\\18"), "Digest 2026 07 18");
        assert_eq!(clean_save_name("   "), "Workflow output");
        // An ordinary name is untouched.
        assert_eq!(clean_save_name("Morning digest 2026-08-01"), "Morning digest 2026-08-01");
    }

    #[test]
    fn appending_to_an_html_page_stays_one_document() {
        // Gluing a whole second document onto the end left stranded footers
        // mid-page and the formatting restarting after a few runs.
        let old = html_document("Digest", "<p>first</p>");
        let joined = append_into_html(&old, "Digest", "<p>second</p>");
        assert_eq!(joined.matches("<!doctype html>").count(), 1);
        assert_eq!(joined.matches("</main>").count(), 1);
        assert!(joined.contains("<p>first</p>") && joined.contains("<p>second</p>"));
        // The new block lands INSIDE the document, before the footer.
        let at_second = joined.find("<p>second</p>").unwrap();
        assert!(at_second < joined.find("</main>").unwrap());
        // A file that isn't a document we recognise becomes one.
        let built = append_into_html("loose text", "Digest", "<p>next</p>");
        assert!(built.starts_with("<!doctype html>"));
        assert!(built.contains("loose text") && built.contains("<p>next</p>"));
    }

    #[test]
    fn appending_survives_text_that_changes_length_when_lowercased() {
        // The splice point is an offset into the case-folded copy, so that copy
        // must be the same LENGTH as the original. `to_lowercase()` isn't:
        // 'İ' (U+0130) grows a byte, 'ẞ' (U+1E9E) shrinks one — so a page whose
        // accumulated content carried either had the next block spliced a few
        // bytes off, into the middle of the closing tag, and enough of them ran
        // the index past the end (a panic, under the room lock).
        for shifty in ["İstanbul İzmir İçel", "STRAẞE ẞ ẞ ẞ ẞ"] {
            let old = html_document("Digest", &format!("<p>{shifty}</p>"));
            let joined = append_into_html(&old, "Digest", "<p>second</p>");
            // The block goes in exactly AT `</main>`, nowhere near it.
            let at = old.rfind("</main>").expect("fixture is a generated page");
            let expected = format!("{}\n<hr/>\n<p>second</p>\n{}", &old[..at], &old[at..]);
            assert_eq!(joined, expected, "{shifty}: spliced at the wrong offset");
            assert_eq!(joined.matches("</main>").count(), 1, "{shifty}");
            assert!(joined.contains(shifty), "{shifty}: old content was cut");
        }
    }

    #[test]
    fn validate_flags_bad_transform_and_script_mode() {
        let def = parse(serde_json::json!({
            "nodes": [
                { "id": "t", "kind": "transform", "op": "explode" },
                { "id": "s", "kind": "script_run", "file": "x.py", "mode": "sideways" }
            ],
            "edges": []
        }));
        let errs = validate_definition(&def).unwrap_err();
        assert!(
            errs.iter().any(|e| e.contains("unknown transform")),
            "{errs:?}"
        );
        assert!(
            errs.iter().any(|e| e.contains("unknown script mode")),
            "{errs:?}"
        );
    }

    #[test]
    fn compile_assigns_cpu_lane_to_deterministic_nodes() {
        let def = parse(serde_json::json!({
            "nodes": [
                { "id": "m", "kind": "merge", "mode": "concat" },
                { "id": "e", "kind": "extract", "fields": ["name"] }
            ],
            "edges": [ { "from": "m", "to": "e" } ]
        }));
        let models = vec!["qwen3.5:4b".to_string()];
        let steps = compile_workflow(&def, &None, &models).unwrap();
        let merge = steps
            .iter()
            .find(|s| s.params["node"]["id"] == "m")
            .unwrap();
        assert_eq!(merge.lane, Lane::Cpu, "merge is deterministic → CPU lane");
        let extract = steps
            .iter()
            .find(|s| s.params["node"]["id"] == "e")
            .unwrap();
        assert_eq!(extract.lane, Lane::LocalLlm, "extract calls the model");
    }

    // ------------------------------------------------------------------
    // Resume characterization: the REAL executor on a REAL room.
    //
    // Everything above this line is a pure-function test — not one of them
    // executes a workflow. These three drive `compile_workflow` →
    // `execute_workflow_step` → `run_plan` → `db::checkpoint_job` → reload →
    // resume, over the node kinds that need no sidecar (transform / condition /
    // merge / save_file, plus a summarize_file whose selector matches nothing).
    // They are the behavioural baseline the LangGraph port must reproduce.
    // Harness style follows `file_pass_end_to_end_with_real_model`; the
    // checkpoint closure is copied VERBATIM from `spawn_workflow_job` and the
    // resume seed VERBATIM from `queue::start_workflow_row`, so the two halves
    // of the resume contract are exercised against each other.
    // ------------------------------------------------------------------

    /// A mock Tauri app managing an in-memory room — the file_pass e2e harness
    /// minus the encrypted temp file (no node in these fixtures touches disk).
    fn wf_app(room_path: &str) -> tauri::App<tauri::test::MockRuntime> {
        use tauri::Manager;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = AppState::default();
        *state.room.lock().unwrap() = Some(Room {
            conn: db::mem(),
            path: room_path.to_string(),
            name: "wf-test".into(),
            password: "pw".into(),
        });
        app.manage(state);
        app
    }

    /// Compile a fixture def into the immutable plan snapshot a job row carries.
    fn wf_plan(def: WorkflowDef) -> WorkflowPlan {
        let steps = compile_workflow(&def, &None, &[]).expect("fixture def must compile");
        WorkflowPlan {
            workflow_id: "wf-1".into(),
            workflow_name: "Fixture".into(),
            trigger: "manual".into(),
            def,
            resolved_model: "qwen3.5:4b".into(),
            input_file_id: None,
            prev_run_at: None,
            script_consents: Default::default(),
            steps,
        }
    }

    fn create_wf_job(
        handle: &tauri::AppHandle<tauri::test::MockRuntime>,
        plan: &WorkflowPlan,
    ) -> String {
        use tauri::Manager;
        let state = handle.state::<AppState>();
        let guard = state.room.lock().unwrap();
        db::create_job(
            &guard.as_ref().unwrap().conn,
            "workflow",
            "Fixture",
            &serde_json::to_value(plan).unwrap(),
            plan.steps.len() as i64,
        )
        .unwrap()
    }

    fn wf_job_row(handle: &tauri::AppHandle<tauri::test::MockRuntime>, job_id: &str) -> db::Job {
        use tauri::Manager;
        let state = handle.state::<AppState>();
        let guard = state.room.lock().unwrap();
        db::get_job(&guard.as_ref().unwrap().conn, job_id).unwrap()
    }

    fn wf_step_artifact(
        handle: &tauri::AppHandle<tauri::test::MockRuntime>,
        job_id: &str,
        step: usize,
    ) -> WfArtifact {
        use tauri::Manager;
        let state = handle.state::<AppState>();
        let guard = state.room.lock().unwrap();
        load_wf_artifact(&guard.as_ref().unwrap().conn, job_id, step)
            .unwrap_or_else(|| panic!("step {step} has no artifact"))
    }

    /// EXACTLY how `queue::start_workflow_row` seeds a resume from the job row.
    fn persisted_done(job: &db::Job) -> HashSet<usize> {
        job.state
            .get("done")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_u64().map(|n| n as usize))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `spawn_workflow_job`'s wiring minus the tauri Window: the real `run_plan`
    /// driving the real `execute_workflow_step`, with the spawner's checkpoint
    /// closure verbatim. `stop_after` trips Stop the moment that step id
    /// finishes (the user pressing Stop mid-plan). Returns the outcome and the
    /// step ids that actually EXECUTED in this leg.
    async fn drive_workflow(
        handle: &tauri::AppHandle<tauri::test::MockRuntime>,
        job_id: &str,
        room_path: &str,
        plan: &WorkflowPlan,
        start_done: HashSet<usize>,
        stop_after: Option<usize>,
    ) -> (RunOutcome, Vec<usize>) {
        use tauri::Manager;
        let cancel = Arc::new(AtomicBool::new(false));
        let ran: Arc<std::sync::Mutex<Vec<usize>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let published: Arc<std::sync::Mutex<Option<FileMeta>>> =
            Arc::new(std::sync::Mutex::new(None));
        let agent_run: AgentRunFn = Arc::new(|_q: String| {
            Box::pin(async { Err::<String, String>("no agent node in this fixture".into()) })
        });
        let steps = plan.steps.clone();

        let outcome = run_plan(
            &steps,
            start_done,
            cancel.clone(),
            |s| {
                let app = handle.clone();
                let job_id = job_id.to_string();
                let room_path = room_path.to_string();
                let plan = plan.clone();
                let cancel = cancel.clone();
                let published = published.clone();
                let agent_run = agent_run.clone();
                let ran = ran.clone();
                async move {
                    let r = execute_workflow_step(
                        &app, &job_id, &room_path, &plan, &s, &cancel, &published, &agent_run,
                    )
                    .await;
                    ran.lock().unwrap().push(s.id);
                    if stop_after == Some(s.id) {
                        cancel.store(true, Ordering::SeqCst);
                    }
                    r
                }
            },
            |done| {
                // Verbatim from spawn_workflow_job: the cursor is the dense
                // prefix, the state blob is the whole sorted done-set.
                let cursor = dense_prefix(done);
                let done_vec: Vec<usize> = {
                    let mut v: Vec<usize> = done.iter().copied().collect();
                    v.sort_unstable();
                    v
                };
                let state = handle.state::<AppState>();
                let guard = state.room.lock().unwrap();
                if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                    db::checkpoint_job(
                        &r.conn,
                        &job_id.to_string(),
                        cursor as i64,
                        &serde_json::json!({ "done": done_vec }),
                    )
                    .unwrap();
                }
            },
            |_, _| {},
        )
        .await;
        let ids = ran.lock().unwrap().clone();
        (outcome, ids)
    }

    /// seed → gate(condition) →then hot, →else cold → cold2; hot + cold2 → join
    /// (merge) → out (save_file). The `else` arm is dead, so cold AND its child
    /// cold2 must both be skipped.
    fn branching_def() -> WorkflowDef {
        parse(serde_json::json!({
            "nodes": [
                { "id": "seed", "kind": "transform", "op": "append", "value": "alpha" },
                { "id": "gate", "kind": "condition", "op": "contains", "value": "alpha" },
                { "id": "hot",  "kind": "transform", "op": "append", "value": " HOT" },
                { "id": "cold", "kind": "transform", "op": "append", "value": " COLD" },
                { "id": "cold2","kind": "transform", "op": "append", "value": " COLD2" },
                { "id": "join", "kind": "merge", "mode": "concat", "separator": "||" },
                { "id": "out",  "kind": "save_file", "name_template": "wf-out",
                  "format": "md", "mode": "create" }
            ],
            "edges": [
                { "from": "seed",  "to": "gate" },
                { "from": "gate",  "to": "hot",  "branch": "then" },
                { "from": "gate",  "to": "cold", "branch": "else" },
                { "from": "cold",  "to": "cold2" },
                { "from": "hot",   "to": "join" },
                { "from": "cold2", "to": "join" },
                { "from": "join",  "to": "out" }
            ]
        }))
    }

    #[test]
    fn upstream_text_cannot_conjure_a_template_placeholder() {
        // Placeholders are what the workflow AUTHOR writes. Substituting
        // {{input}} FIRST meant a document — or an AI reply — that happened to
        // contain the marker {{files}} had the room's whole file inventory
        // pasted into the next step's prompt.
        use tauri::Manager;
        let room_path = "mem://wf-interpolate";
        let app = wf_app(room_path);
        let handle = app.handle().clone();
        {
            let state = handle.state::<AppState>();
            let guard = state.room.lock().unwrap();
            db::insert_file(
                &guard.as_ref().unwrap().conn,
                "quarterly-plan.md",
                "text/markdown",
                b"body",
                Some("body"),
                "upload",
            )
            .unwrap();
        }
        let hostile = "the model wrote: {{files}}";
        let out = interpolate(&handle, room_path, "Continue from:\n{{input}}", hostile);
        assert!(out.contains("{{files}}"), "the marker is left as literal text");
        assert!(
            !out.contains("quarterly-plan.md"),
            "upstream text must not expand into the file inventory: {out}"
        );
        // A placeholder the TEMPLATE itself carries still resolves.
        let real = interpolate(&handle, room_path, "Files:\n{{files}}\n\n{{input}}", "x");
        assert!(real.contains("quarterly-plan.md"));
        assert!(real.ends_with("x"));
    }

    #[test]
    fn a_paused_run_neither_blocks_the_next_one_nor_reads_as_running() {
        // Stopping a workflow (or quitting mid-run) parks its job. Counting a
        // parked job as "in flight" left the workflow stuck for good: every
        // scheduled tick skipped silently and Run answered "already running or
        // queued" for a job that was never going to move on its own.
        let conn = db::mem();
        let wf = db::create_workflow(&conn, "Digest", "", "", &serde_json::json!({}), "user",
            &serde_json::json!({"scope": "general"})).unwrap();
        let job = db::create_job(&conn, "workflow", "Workflow — Digest",
            &serde_json::json!({}), 3).unwrap();
        db::create_workflow_run(&conn, &wf, &job, "manual", None).unwrap();

        db::set_job_status(&conn, &job, "running", None).unwrap();
        assert!(has_inflight_run(&conn, &wf), "a live run blocks a duplicate");
        db::set_job_status(&conn, &job, "queued", None).unwrap();
        assert!(has_inflight_run(&conn, &wf), "so does a queued one");

        // Parked: resumable from the Activity panel, but not in flight.
        db::set_job_status(&conn, &job, "paused", None).unwrap();
        db::set_workflow_run_status_by_job(&conn, &job, "paused").unwrap();
        assert!(!has_inflight_run(&conn, &wf), "a parked run must not block forever");
        let runs = db::list_workflow_runs(&conn, &wf).unwrap();
        assert_eq!(runs[0].status, "paused", "and its history line says so");
        assert!(runs[0].finished_at.is_none(), "it is still resumable");
    }

    #[test]
    fn the_new_files_window_only_moves_on_a_run_that_finished() {
        // "Files added since the last run" measured from the last ATTEMPT, so
        // files that arrived before a failed or stopped run were quietly never
        // picked up again.
        let conn = db::mem();
        let wf = db::create_workflow(&conn, "Digest", "", "", &serde_json::json!({}), "user",
            &serde_json::json!({"scope": "general"})).unwrap();
        assert_eq!(previous_run_at(&conn, &wf), None, "never run → the whole room is new");

        let ok = db::create_job(&conn, "workflow", "w", &serde_json::json!({}), 1).unwrap();
        db::create_workflow_run(&conn, &wf, &ok, "schedule", None).unwrap();
        db::finish_workflow_run_by_job(&conn, &ok, "done", None).unwrap();
        let after_success = previous_run_at(&conn, &wf).expect("a finished run sets the window");

        // A LATER run that failed must not move the window past it.
        let bad = db::create_job(&conn, "workflow", "w", &serde_json::json!({}), 1).unwrap();
        db::create_workflow_run(&conn, &wf, &bad, "schedule", None).unwrap();
        db::finish_workflow_run_by_job(&conn, &bad, "error", Some("the model was down")).unwrap();
        assert_eq!(previous_run_at(&conn, &wf).as_deref(), Some(after_success.as_str()));

        // Nor a parked one.
        let stopped = db::create_job(&conn, "workflow", "w", &serde_json::json!({}), 1).unwrap();
        db::create_workflow_run(&conn, &wf, &stopped, "manual", None).unwrap();
        db::set_workflow_run_status_by_job(&conn, &stopped, "paused").unwrap();
        assert_eq!(previous_run_at(&conn, &wf).as_deref(), Some(after_success.as_str()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn workflow_runs_to_completion_and_skips_the_dead_branch_transitively() {
        use tauri::Manager;
        let room_path = "mem://wf-complete";
        let app = wf_app(room_path);
        let handle = app.handle().clone();
        let plan = wf_plan(branching_def());
        // Compiled ids are the topo order of the def above.
        assert_eq!(plan.steps.len(), 7);
        for (i, s) in plan.steps.iter().enumerate() {
            assert_eq!(s.id, i);
        }
        let job_id = create_wf_job(&handle, &plan);

        let (outcome, ran) =
            drive_workflow(&handle, &job_id, room_path, &plan, HashSet::new(), None).await;
        assert_eq!(outcome, RunOutcome::Done);
        let mut ran_sorted = ran.clone();
        ran_sorted.sort_unstable();
        assert_eq!(ran_sorted, (0..7).collect::<Vec<_>>(), "every step runs once");

        // The condition took `then`, and it is the ARTIFACT that records it.
        let gate = wf_step_artifact(&handle, &job_id, 1);
        assert_eq!(gate.branch.as_deref(), Some("then"));
        assert_eq!(gate.node_kind.as_deref(), Some("condition"));

        // The live arm ran on the gate's own artifact text (the condition's
        // `result` IS the downstream input — pin it, a port must not "pass
        // through" the condition's upstream value instead).
        let hot = wf_step_artifact(&handle, &job_id, 2);
        assert!(!hot.skipped);
        assert_eq!(hot.result, "branch: then HOT");

        // Skip propagates transitively: cold is dead by branch mismatch, cold2 is
        // dead because its only parent is skipped. Both still carry node labels
        // so the run-history view can name them.
        let cold = wf_step_artifact(&handle, &job_id, 3);
        let cold2 = wf_step_artifact(&handle, &job_id, 4);
        assert!(cold.skipped, "the else arm must be skipped");
        assert!(cold2.skipped, "skip must propagate to the arm's child");
        assert_eq!(cold2.node_kind.as_deref(), Some("transform"));
        assert!(cold.result.is_empty() && cold2.result.is_empty());

        // The merge saw ONLY the live branch — no empty slot, no separator.
        let join = wf_step_artifact(&handle, &job_id, 5);
        assert_eq!(join.result, "branch: then HOT");

        // save_file wrote the merged text into the room and recorded the file id.
        let out = wf_step_artifact(&handle, &job_id, 6);
        let file_id = out.file_id.clone().expect("save_file records its file id");
        {
            let state = handle.state::<AppState>();
            let guard = state.room.lock().unwrap();
            let conn = &guard.as_ref().unwrap().conn;
            let meta = db::get_file_meta(conn, &file_id).unwrap();
            assert_eq!(meta.name, "wf-out.md");
            assert_eq!(meta.source, "generated");
            assert_eq!(
                db::get_file_extracted_text(conn, &file_id).unwrap(),
                "branch: then HOT"
            );
        }

        // The job row ends fully checkpointed: cursor == total and the state
        // blob names every step.
        let job = wf_job_row(&handle, &job_id);
        assert_eq!(job.cursor, 7);
        assert_eq!(job.state, serde_json::json!({ "done": [0, 1, 2, 3, 4, 5, 6] }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn workflow_resume_seeds_from_the_persisted_done_set_not_the_cursor() {
        // The NON-DENSE resume. Two same-lane siblings (LocalLlm, 1 slot) plus a
        // Cpu sibling means a wave finishes {0,1,3} with step 2 still pending:
        // the cursor is 2 but three steps are done. Storing a scalar count (3)
        // would mark step 2 done though it never ran — its artifact would never
        // exist, so the merge below it would see a MISSING (= dead) parent and
        // silently drop a live branch. This is the exact trap a reimplementation
        // falls into by persisting "how many finished" instead of "which".
        let room_path = "mem://wf-resume";
        let app = wf_app(room_path);
        let handle = app.handle().clone();
        let def = parse(serde_json::json!({
            "nodes": [
                { "id": "seed", "kind": "transform", "op": "append", "value": "seed-value" },
                // Selector matches nothing, so these return their empty-set line
                // without ever calling a model — but they still ride LocalLlm.
                { "id": "s1", "kind": "summarize_file",
                  "select": { "type": "name_like", "pattern": "zzz-no-such-file" } },
                { "id": "s2", "kind": "summarize_file",
                  "select": { "type": "name_like", "pattern": "zzz-no-such-file" } },
                { "id": "t3", "kind": "transform", "op": "append", "value": " +t3" },
                { "id": "join", "kind": "merge", "mode": "concat", "separator": "||" }
            ],
            "edges": [
                { "from": "seed", "to": "s1" },
                { "from": "seed", "to": "s2" },
                { "from": "seed", "to": "t3" },
                { "from": "s1", "to": "join" },
                { "from": "s2", "to": "join" },
                { "from": "t3", "to": "join" }
            ]
        }));
        let plan = wf_plan(def);
        assert_eq!(plan.steps[1].lane, Lane::LocalLlm);
        assert_eq!(plan.steps[2].lane, Lane::LocalLlm);
        assert_eq!(plan.steps[3].lane, Lane::Cpu);
        let job_id = create_wf_job(&handle, &plan);

        // Leg 1: Stop the moment step 3 finishes — the wave that completes {0,1,3}.
        let (outcome, ran) =
            drive_workflow(&handle, &job_id, room_path, &plan, HashSet::new(), Some(3)).await;
        assert_eq!(outcome, RunOutcome::Paused, "Stop pauses, never errors");
        let mut ran1 = ran.clone();
        ran1.sort_unstable();
        assert_eq!(ran1, vec![0, 1, 3], "step 2 lost the serial lane slot");

        // The checkpoint is non-dense: cursor 2, done-set {0,1,3}.
        let job = wf_job_row(&handle, &job_id);
        assert_eq!(job.cursor, 2, "cursor is the dense prefix, not the count");
        assert_eq!(job.state, serde_json::json!({ "done": [0, 1, 3] }));
        assert!(
            (job.cursor as usize) < job.state["done"].as_array().unwrap().len(),
            "this fixture must produce a non-dense checkpoint"
        );

        // Leg 2: resume exactly the way queue::start_workflow_row does.
        let seed = persisted_done(&job);
        assert_eq!(seed, [0usize, 1, 3].into_iter().collect::<HashSet<_>>());
        let (outcome, ran) = drive_workflow(&handle, &job_id, room_path, &plan, seed, None).await;
        assert_eq!(outcome, RunOutcome::Done);
        let mut ran2 = ran.clone();
        ran2.sort_unstable();
        assert_eq!(
            ran2,
            vec![2, 4],
            "resume runs the hole and the tail — never a completed node again"
        );

        // The artifact channel carried leg 1's values across the boundary: the
        // merge's input for steps 1 and 3 can only have come from the DB.
        let join = wf_step_artifact(&handle, &job_id, 4);
        let empty_line = "No files matched — nothing to summarize.";
        assert_eq!(
            join.result,
            format!("{empty_line}||{empty_line}||seed-value +t3"),
            "live inputs arrive in incoming-edge order, from persisted artifacts"
        );

        let job = wf_job_row(&handle, &job_id);
        assert_eq!(job.cursor, 5);
        assert_eq!(job.state, serde_json::json!({ "done": [0, 1, 2, 3, 4] }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_branch_decided_before_the_pause_still_steers_the_resumed_run() {
        // The branch a condition took lives ONLY in its artifact. Resume after
        // the condition and before its children: the dead arm must still skip,
        // and the run must still publish the live arm's text. A port that keeps
        // branch state in memory (or re-evaluates the condition on resume with a
        // different input) passes leg 1 and fails here.
        use tauri::Manager;
        let room_path = "mem://wf-branch-resume";
        let app = wf_app(room_path);
        let handle = app.handle().clone();
        let plan = wf_plan(branching_def());
        let job_id = create_wf_job(&handle, &plan);

        // Leg 1: Stop right after the condition (step 1).
        let (outcome, ran) =
            drive_workflow(&handle, &job_id, room_path, &plan, HashSet::new(), Some(1)).await;
        assert_eq!(outcome, RunOutcome::Paused);
        assert_eq!(ran, vec![0, 1], "paused with the branch decided, nothing more");
        let job = wf_job_row(&handle, &job_id);
        assert_eq!(job.cursor, 2);
        assert_eq!(job.state, serde_json::json!({ "done": [0, 1] }));
        // Nothing downstream exists yet — no artifact, no file.
        {
            let state = handle.state::<AppState>();
            let guard = state.room.lock().unwrap();
            let conn = &guard.as_ref().unwrap().conn;
            assert!(load_wf_artifact(conn, &job_id, 2).is_none());
            let files: i64 = conn
                .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
                .unwrap();
            assert_eq!(files, 0, "save_file must not have run yet");
        }

        // Leg 2: resume from the persisted set.
        let (outcome, ran) = drive_workflow(
            &handle,
            &job_id,
            room_path,
            &plan,
            persisted_done(&job),
            None,
        )
        .await;
        assert_eq!(outcome, RunOutcome::Done);
        assert_eq!(
            ran,
            vec![2, 3, 4, 5, 6],
            "the resumed leg re-runs neither the seed nor the condition"
        );

        // The branch read back off disk still kills the else arm transitively…
        assert!(wf_step_artifact(&handle, &job_id, 3).skipped);
        assert!(wf_step_artifact(&handle, &job_id, 4).skipped);
        // …and the published file carries the pre-pause value, proving the
        // artifact channel — not process memory — is the workflow's dataflow.
        let out = wf_step_artifact(&handle, &job_id, 6);
        let file_id = out.file_id.clone().unwrap();
        let state = handle.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let conn = &guard.as_ref().unwrap().conn;
        assert_eq!(
            db::get_file_extracted_text(conn, &file_id).unwrap(),
            "branch: then HOT"
        );
        let files: i64 = conn
            .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(files, 1, "resume must not publish a second copy");
    }
}
