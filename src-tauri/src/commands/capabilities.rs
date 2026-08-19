//! ONE declared capability record per engine/provider — the single place the
//! app answers "what can this AI actually do?".
//!
//! Before this module, capability was inferred ad hoc at every decision point:
//! `is_cli_engine` stood in for "cannot stream", an exact `:cloud` suffix stood
//! in for "ignores a JSON schema and leaks its tool calls inline", and the
//! vision area had a list of model NAMES. The vision half was already fixed —
//! `grounding_pick`/`chat_model_sees_images` ask the engine instead of reading
//! the name — and this module generalises exactly that move to the rest.
//!
//! Two layers, because only two layers are honest:
//!
//! * [`EngineDecl`] — what is true of the TRANSPORT, whatever model rides it.
//!   A cloud CLI is a one-shot subprocess: it cannot stream and there is no
//!   channel to hand it pixels, no matter how multimodal the model behind it
//!   is. That is a property of how we talk to it, so it is DECLARED here.
//! * [`EngineCapabilities`] — that declaration refined by what the live catalog
//!   says about the SPECIFIC model (Ollama's `/api/show`, the OpenRouter
//!   catalog, Codex's own `codex debug models`). Whether a given Ollama build
//!   can see or emit tool calls is not knowable from its name and never was.
//!
//! [`Support::Unknown`] is a first-class answer and the reason this module can
//! be trusted: an engine we could not reach must not be reported as capable OR
//! as incapable. Preflight refuses only on a declared/observed `No`; `Unknown`
//! is passed through as a caveat, never as a verdict.

use super::*;
use crate::room_mcp::ToolScope;

/// What one capability question can honestly be answered with.
///
/// The third arm is the load-bearing one. "The sidecar is down so `/api/show`
/// returned nothing" and "this model reports no vision capability" are
/// different facts, and collapsing them into `false` is how a broken engine
/// used to read as a deliberate product limit.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Support {
    Yes,
    No,
    Unknown,
}

impl Support {
    pub(crate) fn yes(v: bool) -> Self {
        if v {
            Support::Yes
        } else {
            Support::No
        }
    }
    /// True only for a definite yes — the caller wanted a `bool` and the honest
    /// collapse of "unknown" for a *permission* question is "not proven".
    pub(crate) fn is_yes(self) -> bool {
        self == Support::Yes
    }
}

/// The capability questions anything in the app is allowed to ask.
///
/// A closed enum on purpose: a new question has to be added here, to the
/// declaration table, and to [`EngineCapabilities::supports`] together, so a
/// caller cannot invent a capability nothing declares an answer for.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// Token-by-token deltas as the answer is produced.
    Streaming,
    /// Emits tool calls the agent loop can actually see and execute.
    ToolCalling,
    /// Can be handed an image and reason about the pixels.
    Vision,
    /// Honours a JSON-schema/grammar constraint on its output.
    StructuredOutput,
    /// Can hold a chat turn at all (an embedding-only model cannot).
    Chat,
    /// Hands back PIXELS, not a description of them. The mirror of `Vision`,
    /// and deliberately a separate question: every vision model in the app can
    /// read a picture and none of them can draw one.
    ImageGeneration,
    /// Hands back a clip. Separate from `ImageGeneration` because a model that
    /// draws a still is not thereby able to move it.
    VideoGeneration,
}

impl Capability {
    /// Plain words for the thing the user was trying to do, used in preflight
    /// messages. Kept beside the enum so a new capability cannot ship without
    /// a sentence a person can read.
    pub(crate) fn phrase(self) -> &'static str {
        match self {
            Capability::Streaming => "show its answer as it is written",
            Capability::ToolCalling => "use tools (open files, search, run jobs)",
            Capability::Vision => "look at an image",
            Capability::StructuredOutput => "return a strictly-shaped result",
            Capability::Chat => "hold a conversation",
            Capability::ImageGeneration => "make a picture",
            Capability::VideoGeneration => "make a video",
        }
    }
}

/// What is true of an ENGINE's transport, whatever model rides it.
///
/// Every `Unknown` below means "this varies per model — ask the catalog", and
/// [`capabilities_for`] is the only thing allowed to resolve it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct EngineDecl {
    /// Stable id, also the key the UI matrix is grouped by.
    pub id: &'static str,
    pub label: &'static str,
    /// Runs ON THIS MAC — nothing leaves the device.
    pub local: bool,
    pub streaming: Support,
    /// Is there a channel to hand this engine PIXELS at all? Distinct from
    /// whether the model can see: `generate_external` takes no images, so a
    /// cloud CLI is blind to us even when the model behind it is not.
    pub image_channel: bool,
    pub tool_calling: Support,
    pub structured_output: Support,
    /// The bridge tier this engine is served at (`room_mcp::ToolScope`), i.e.
    /// which tools it may ever be offered. Declared here so the provider ×
    /// agent matrix and `sidecar::bridge_scope_for` read the same field.
    pub tier: ToolScope,
}

/// A local Ollama build. The most capable tier and the only one whose pixels
/// never leave; what it can *do* is entirely per-model, so almost everything
/// here is answered by `/api/show`.
const OLLAMA: EngineDecl = EngineDecl {
    id: "ollama",
    label: "Ollama (this Mac)",
    local: true,
    streaming: Support::Yes,
    image_channel: true,
    tool_calling: Support::Unknown,
    structured_output: Support::Yes,
    tier: ToolScope::LocalEngine,
};

/// An Ollama tag relayed to ollama.com (`name:cloud`, and the `<size>-cloud`
/// spelling `runs_on_this_mac` also catches). Two hard limits, both observed
/// live and both previously encoded as a `:cloud` string test scattered across
/// the codebase: it leaks tool calls inline as `<tool_call>…` text that the
/// stream parser never sees, and it ignores the `format` grammar (which is why
/// `model_text.recover_json` exists at all).
const OLLAMA_CLOUD: EngineDecl = EngineDecl {
    id: "ollama-cloud",
    label: "Ollama cloud relay",
    local: false,
    streaming: Support::Yes,
    image_channel: true,
    tool_calling: Support::No,
    structured_output: Support::No,
    tier: primary_cli_scope(),
};

/// Claude Code as the room's engine. A one-shot `claude -p` subprocess: the
/// sidecar hands its whole reply back as ONE delta at the end (see
/// `chat_commands::COMMAND_STREAM_IDLE_CLI_SECS`, which exists for exactly
/// this), there is no image channel, and its structured replies are recovered
/// rather than constrained. It DOES call tools — through the room's MCP bridge,
/// which is why it is a `CloudEngine` and not an advisor.
const CLAUDE_CLI: EngineDecl = EngineDecl {
    id: "claude-cli",
    label: "Claude Code",
    local: false,
    streaming: Support::No,
    image_channel: false,
    tool_calling: Support::Yes,
    structured_output: Support::No,
    tier: primary_cli_scope(),
};

/// Codex as the room's engine — same transport shape as [`CLAUDE_CLI`].
const CODEX_CLI: EngineDecl = EngineDecl {
    id: "codex-cli",
    label: "Codex",
    local: false,
    streaming: Support::No,
    image_channel: false,
    tool_calling: Support::Yes,
    structured_output: Support::No,
    tier: primary_cli_scope(),
};

/// An API provider (OpenRouter today). A real HTTP chat API: it streams, it
/// takes images, and tools/vision/structured output are per-model facts the
/// live catalog already carries — the same catalog the model picker fetches.
const OPENROUTER: EngineDecl = EngineDecl {
    id: "openrouter",
    label: "OpenRouter",
    local: false,
    streaming: Support::Yes,
    image_channel: true,
    tool_calling: Support::Unknown,
    structured_output: Support::Unknown,
    tier: primary_cli_scope(),
};

/// Every engine the app can be pointed at, in the order the matrix shows them.
pub(crate) const DECLARED: &[EngineDecl] = &[OLLAMA, OLLAMA_CLOUD, CLAUDE_CLI, CODEX_CLI, OPENROUTER];

/// Which engine a model selection belongs to.
///
/// This is where the Ollama local/relayed split is DEFINED (`runs_on_this_mac`
/// is now a thin read of the record it produces). Strict on purpose: Ollama
/// tags its hosted entries BOTH ways — `minimax-m3:cloud` and the
/// `<size>-cloud` form `gpt-oss:120b-cloud` — and an exact `:cloud` suffix test
/// misses the second. The pair of name tests that used to stand in for this
/// question at a dozen call sites (`is_cloud_model(m) || is_external_engine(m)`)
/// missed it too, so `gpt-oss:120b-cloud` was told it ran on this Mac. The cost
/// of a false exclusion is one unnecessary "Cloud" label; the cost of a false
/// inclusion is the user's content leaving the machine under a promise that it
/// would not. Stated once, here.
pub(crate) fn engine_id_of(model: &str) -> &'static str {
    match split_external_model(model).0 {
        "claude-cli" => CLAUDE_CLI.id,
        "codex-cli" => CODEX_CLI.id,
        "openrouter" => OPENROUTER.id,
        // BOTH spellings, which is the whole point: `is_cloud_model` is the
        // exact `:cloud` tag, and Ollama ALSO writes the marker inside the tag
        // (`gpt-oss:120b-cloud`). Every call site that used `is_cloud_model`
        // alone to mean "runs off the Mac" was wrong about the second form.
        _ if is_cloud_model(model) => OLLAMA_CLOUD.id,
        _ if model
            .rsplit(':')
            .next()
            .is_some_and(|tag| tag.ends_with("-cloud")) =>
        {
            OLLAMA_CLOUD.id
        }
        _ => OLLAMA.id,
    }
}

/// Is the Ollama transport ACTUALLY this Mac right now?
///
/// [`engine_id_of`] answers "which engine", from the model NAME. That was taken
/// to also answer "does this content leave the machine", and it does not: the
/// Closet field (`set_ollama_url`) points the same `qwen3.5:4b` at another
/// computer, and every locality decision in the app — the privacy door's
/// `inject_policy`, whether pixels are held back, the trust badge, the vision
/// pick, the job lanes — read the name and said "local". So a room relaying to
/// a LAN box sent whole documents, transcripts and screenshots there in the
/// clear, with no redaction, under a chip that read "Local only — nothing leaves
/// the device".
///
/// Locality is `engine says local` AND `transport says this Mac`. The transport
/// half is [`crate::ollama_lifecycle::base_is_local`] — the same predicate the
/// daemon manager already uses to refuse to start a local daemon for a remote
/// override, so the two cannot drift apart.
///
/// Only the Ollama engines ride this transport; the rest are already declared
/// non-local, so callers can apply this unconditionally.
pub(crate) fn ollama_runs_here() -> bool {
    crate::ollama_lifecycle::base_is_local(&crate::ollama::resolved_base_url())
}

/// Is this tag served by the ORDINARY Ollama engine (as opposed to a relayed
/// `*-cloud` tag or an external CLI/provider)? A question about the MODEL only.
///
/// The distinction from [`runs_on_this_mac`](crate::commands::runs_on_this_mac)
/// matters: that one also asks where the transport points, which is right for
/// "does content leave the device" and WRONG for "which list entry do we pick".
/// Filtering a model list by the privacy question would, with the Closet set,
/// reject every installed tag and leave the app with no model to name.
pub(crate) fn served_by_ollama_engine(model: &str) -> bool {
    declared_for(model).local
}

/// The declared record for a model selection. Pure and synchronous — no engine
/// is contacted — so every caller that only needs transport facts (streaming,
/// locality, tier) stays cheap and unit-testable.
pub(crate) fn declared_for(model: &str) -> &'static EngineDecl {
    let id = engine_id_of(model);
    DECLARED
        .iter()
        .find(|d| d.id == id)
        // Unreachable by construction: `engine_id_of` only ever returns an id
        // from this table. Falling back to the local record rather than
        // panicking keeps a future engine id from taking the app down.
        .unwrap_or(&OLLAMA)
}

/// One resolved capability record: the declaration refined by whatever the live
/// catalog knows about this specific model.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilities {
    pub engine: String,
    pub label: String,
    /// The full selection string this record was resolved for.
    pub model: String,
    pub local: bool,
    pub streaming: Support,
    pub tool_calling: Support,
    pub vision: Support,
    pub structured_output: Support,
    pub chat: Support,
    /// Can it PRODUCE a picture / a clip. Only ever `Yes` because a live
    /// catalog said so — `Unknown` on every engine that publishes no modality
    /// list, which the Create page treats as "do not offer this", since an
    /// offered model that turns out not to draw fails after the user has
    /// already paid for the call.
    pub image_generation: Support,
    pub video_generation: Support,
    /// Real max context, when the engine publishes one. `None` is "we do not
    /// know", never a made-up default — the token-budget bar reads this.
    pub context_window: Option<u32>,
    /// The `ToolScope` tier, as a stable string for the UI.
    pub tier: String,
    /// Would PIXELS actually arrive? Capability is not the whole question: the
    /// room's privacy door strips images out of every non-local request and
    /// only COUNTS them. Kept separate from `vision` so the two facts stay
    /// distinguishable — "it cannot see" and "your privacy setting blinds it"
    /// need different sentences.
    pub image_reaches: bool,
}

pub(crate) fn tier_name(scope: ToolScope) -> &'static str {
    match scope {
        ToolScope::LocalEngine => "local-engine",
        ToolScope::CloudEngine => "cloud-engine",
        ToolScope::ExternalAgent => "external-agent",
        ToolScope::CloudAdvisor { .. } => "cloud-advisor",
    }
}

impl EngineCapabilities {
    /// The declaration alone, before any catalog lookup. This is what a
    /// PROVIDER-level row shows: everything per-model reads `Unknown`, which is
    /// the truth for a provider serving hundreds of different models.
    pub(crate) fn from_decl(model: &str, decl: &EngineDecl) -> Self {
        EngineCapabilities {
            engine: decl.id.to_string(),
            label: decl.label.to_string(),
            model: model.to_string(),
            // The declaration is about the ENGINE; locality is also about the
            // transport, which the Closet override can move off this Mac (see
            // `ollama_runs_here`). The UI matrix reads this field, so without
            // the second half it labelled a relayed room "runs on this Mac".
            local: decl.local && ollama_runs_here(),
            streaming: decl.streaming,
            tool_calling: decl.tool_calling,
            // Two independent reasons a model may not see, and only one of them
            // is per-model: no image channel is a flat No from the transport.
            vision: if decl.image_channel {
                Support::Unknown
            } else {
                Support::No
            },
            structured_output: decl.structured_output,
            chat: Support::Unknown,
            // Same shape as `vision`: no image channel is a flat No from the
            // transport, and everything else waits on the catalog.
            image_generation: if decl.image_channel {
                Support::Unknown
            } else {
                Support::No
            },
            video_generation: if decl.image_channel {
                Support::Unknown
            } else {
                Support::No
            },
            context_window: None,
            tier: tier_name(decl.tier).to_string(),
            image_reaches: decl.local && ollama_runs_here(),
        }
    }

    pub(crate) fn supports(&self, want: Capability) -> Support {
        match want {
            Capability::Streaming => self.streaming,
            Capability::ToolCalling => self.tool_calling,
            Capability::Vision => self.vision,
            Capability::StructuredOutput => self.structured_output,
            Capability::Chat => self.chat,
            Capability::ImageGeneration => self.image_generation,
            Capability::VideoGeneration => self.video_generation,
        }
    }
}

/// The resolved record for a model — the declaration plus every live fact we
/// can get without loading the model.
///
/// Costs at most one metadata round trip per engine family, and never loads a
/// model into memory: Ollama's `/api/show`, the provider catalog the picker
/// already fetched, and Codex's own catalog (cached for the process lifetime).
pub(crate) async fn capabilities_for(model: &str) -> EngineCapabilities {
    let decl = declared_for(model);
    let mut caps = EngineCapabilities::from_decl(model, decl);
    caps.image_reaches = image_reaches_model(model);
    match decl.id {
        "ollama" | "ollama-cloud" => {
            // An embedding-only model is answered WITHOUT a round trip, because
            // this is also the answer when nothing is reachable: picking one as
            // the chat model fails the turn with HTTP 400, and a name test is
            // the only signal available with the sidecar down. It is a floor,
            // not the source of truth — a reachable engine overwrites `chat`
            // below from what it actually reports.
            if is_embedding_model(model) {
                caps.chat = Support::No;
                caps.vision = Support::No;
                caps.tool_calling = Support::No;
                return caps;
            }
            let listed = ollama::capabilities(model).await;
            if !listed.is_empty() {
                let has = |name: &str| listed.iter().any(|c| c == name);
                caps.vision = Support::yes(has("vision"));
                caps.chat = Support::yes(has("completion"));
                // Ollama's capability vocabulary has no term for producing an
                // image — it serves chat models, and a diffusion checkpoint is
                // not reachable over /api/chat at all. So a listed local model
                // is a definite No here rather than an Unknown: the Create page
                // can then say WHY nothing local is on offer instead of
                // silently showing an empty shelf.
                caps.image_generation = Support::No;
                caps.video_generation = Support::No;
                // Only refine what the declaration left open: a `:cloud` relay
                // reports `tools` in its catalog and still leaks the calls
                // inline, so its declared No must survive the live answer.
                if decl.tool_calling == Support::Unknown {
                    caps.tool_calling = Support::yes(has("tools"));
                }
            }
            caps.context_window = ollama::native_context_length(model).await;
        }
        "openrouter" => {
            // The cache is in-memory and filled only by a catalog fetch, so
            // without this the first ask after every launch had nothing to read.
            ensure_provider_catalog(model).await;
            if let Some(facts) = provider_model_facts(model) {
                caps.context_window = facts.context_window;
                caps.tool_calling = Support::yes(facts.tools);
                caps.vision = Support::yes(facts.vision);
                caps.structured_output = Support::yes(facts.structured_outputs);
                caps.chat = Support::Yes;
                caps.image_generation = Support::yes(facts.image_output);
                caps.video_generation = Support::yes(facts.video_output);
            }
        }
        "codex-cli" => {
            let (engine, submodel, _) = split_external_model(model);
            caps.chat = Support::Yes;
            caps.context_window = Some(
                crate::commands::external::codex_context_window(submodel)
                    .await
                    .unwrap_or_else(|| crate::model_limits::external_max_context(engine)),
            );
        }
        _ => {
            caps.chat = Support::Yes;
            caps.context_window = Some(crate::model_limits::external_max_context(decl.id));
        }
    }
    caps
}

/// Just the vision column of the record, without the context-window round trip
/// the full [`capabilities_for`] also makes.
///
/// Split out because `grounding_pick` asks this of EVERY installed model in
/// turn: resolving a whole record per candidate would add one
/// `/context_length` call per model to a question that never reads the answer.
/// Same declaration, same live sources — only the fields it does not need are
/// skipped.
pub(crate) async fn vision_support(model: &str) -> Support {
    let decl = declared_for(model);
    if !decl.image_channel || is_embedding_model(model) {
        return Support::No;
    }
    match decl.id {
        "openrouter" => {
            ensure_provider_catalog(model).await;
            provider_model_vision(model).map_or(Support::Unknown, Support::yes)
        }
        _ => {
            let listed = ollama::capabilities(model).await;
            if listed.is_empty() {
                Support::Unknown
            } else {
                Support::yes(listed.iter().any(|c| c == "vision"))
            }
        }
    }
}

/// What a preflight check concluded, in a shape the UI can render verbatim.
///
/// Three states, not two, for the same reason [`Support`] has three: an engine
/// we could not reach is not a refusal. `Blocked` is the only state a caller
/// may turn into a failure, and it always carries the sentence to show.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Verdict {
    /// The engine declares it can do this.
    Ready,
    /// Nothing said otherwise, but nothing confirmed it either.
    Unknown { reason: String },
    /// It cannot. `reason` is user-facing prose, already complete; `code` is the
    /// machine-readable WHY, because two blocks that read alike need different
    /// offers. A caller that matched on the prose would be re-deriving the
    /// distinction the record already made — and the first one did: Settings
    /// treated every `Blocked` as "a download would not help" and hid the
    /// vision-helper download button in the one case a download IS the fix.
    Blocked { code: BlockCode, reason: String },
}

/// Why a preflight blocked, as a value rather than a sentence.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum BlockCode {
    /// The engine itself cannot do this. Changing a SETTING will not help;
    /// a different model (or, for vision, installing one) will.
    Capability,
    /// The engine can, but this room's privacy door removes what it would need.
    /// The fix is a switch the user owns, so it must not be answered with an
    /// offer to download anything.
    PrivacyDoor,
}

/// The privacy door's own answer to "could this model see the picture?",
/// separate from [`preflight`] so a caller can tell "this engine is blind" from
/// "your setting removes the pixels" WITHOUT matching on prose.
///
/// The door strips every image out of a request bound off this Mac and only
/// COUNTS what it blocked — it does not fail the call. So a capable cloud model
/// in a door-on room is handed a grounding prompt and no picture, answers with
/// nothing, and the viewer renders that empty answer as "The AI could not
/// locate that in this image": a false statement about the user's photograph,
/// caused by a switch three screens away. Naming the switch is the fix.
pub(crate) fn vision_door_block(caps: &EngineCapabilities) -> Option<String> {
    // Only a CONFIRMED yes earns this sentence. With the catalog unreadable the
    // record says `Unknown`, and answering that with "it can look at images"
    // asserts a capability of an engine we could not reach — the one thing this
    // module exists to stop. `preflight` then falls through to the Unknown arm,
    // which says what is actually true.
    if caps.image_reaches || caps.vision != Support::Yes {
        return None;
    }
    Some(format!(
        "{} can look at images, but this room's privacy door removes them from anything \
         sent off this Mac — so it would be answering about a picture it never received. \
         Use a model that runs on this Mac, or turn the door off for this room.",
        caps.label
    ))
}

/// PREFLIGHT: can this engine do what is about to be asked of it?
///
/// The point of declaring capability is that this question is answerable BEFORE
/// a run, so the user gets one plain sentence instead of a stream that dies
/// halfway or — worse — an empty result rendered as a fact about their data.
/// (`vision_locate` on a door-blinded cloud model returned `[]`, and the viewer
/// said "the AI could not locate that in this image" about a perfectly clear
/// photograph. That is the class of failure this exists to end.)
///
/// Pure: it reads a record and returns prose. Every test drives it directly.
pub(crate) fn preflight(caps: &EngineCapabilities, want: Capability) -> Verdict {
    // The door is checked first for vision because it is the more specific and
    // more actionable answer: "it can see, but your setting removes the pixels"
    // points at a switch the user owns, where "it cannot see" points nowhere.
    if want == Capability::Vision {
        if let Some(reason) = vision_door_block(caps) {
            return Verdict::Blocked {
                code: BlockCode::PrivacyDoor,
                reason,
            };
        }
    }
    match caps.supports(want) {
        Support::Yes => Verdict::Ready,
        Support::No => Verdict::Blocked {
            code: BlockCode::Capability,
            reason: format!(
                "{} cannot {} — the room is set to {}. Choose a different model in \
                 Settings → Model.",
                caps.label,
                want.phrase(),
                caps.model
            ),
        },
        Support::Unknown => Verdict::Unknown {
            reason: format!(
                "Could not confirm that {} can {} — its capabilities were not readable \
                 (the AI engine may be unreachable).",
                caps.label,
                want.phrase()
            ),
        },
    }
}

/// PREFLIGHT for the OPEN room's engine, so any surface can ask before it
/// starts a run instead of failing mid-stream.
#[tauri::command]
pub async fn engine_preflight(
    state: State<'_, AppState>,
    capability: Capability,
) -> Result<Verdict, String> {
    let explicit = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|room| model_setting(&room.conn))
    };
    let models = ollama::list_models().await.unwrap_or_default();
    let model = explicit.unwrap_or_else(|| best_default(&models));
    Ok(preflight(&capabilities_for(&model).await, capability))
}

/// The OPEN room's resolved capability record — one call, so no surface has to
/// re-derive what its engine can do.
#[tauri::command]
pub async fn engine_capabilities(state: State<'_, AppState>) -> Result<EngineCapabilities, String> {
    let explicit = {
        let guard = state.room.lock().unwrap();
        guard.as_ref().and_then(|room| model_setting(&room.conn))
    };
    let models = ollama::list_models().await.unwrap_or_default();
    let model = explicit.unwrap_or_else(|| best_default(&models));
    Ok(capabilities_for(&model).await)
}

// --- the provider × agent support matrix ------------------------------------

/// One provider's row in the published matrix.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRow {
    #[serde(flatten)]
    pub caps: EngineCapabilities,
    /// Is this engine usable on THIS Mac right now (installed / connected)?
    /// A row is shown either way — the matrix is a reference, not a menu — but
    /// an unavailable provider must not read as one the user could pick.
    pub available: bool,
    /// Agent ids this provider's tier can actually reach, derived from the
    /// sidecar's own registry. Empty here means "the sidecar did not answer",
    /// which `agentsKnown` distinguishes from "reaches nothing".
    pub agents: Vec<String>,
}

/// The published provider × agent matrix (owner decision #3).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SupportMatrix {
    /// Every agent, id + label, straight from the sidecar registry.
    pub agents: Vec<AgentRow>,
    pub providers: Vec<ProviderRow>,
    /// False when the sidecar could not be reached, or answered in a shape
    /// this version cannot read: the capability half of the matrix is still
    /// true (it is declared here), the agent half is simply not known, and the
    /// UI says so rather than drawing an empty grid that reads as "no agent
    /// works anywhere". A sidecar that answered with no agents at all is
    /// KNOWN — that is a real answer, and `agents_error` says why when it is
    /// not.
    pub agents_known: bool,
    /// Why the agent half is missing, when it is.
    pub agents_error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentRow {
    pub id: String,
    pub label: String,
}

/// Publish the matrix (owner decision #3: "surface it, do not hand-maintain
/// it").
///
/// DERIVED end to end, which is the whole requirement. The capability columns
/// come from [`DECLARED`]. The agent columns come from asking the sidecar which
/// workers its own registry considers reachable given the tool names each tier
/// actually serves (`room_mcp::tier_tool_names`) — so adding an agent, changing
/// a tier's tool list, or changing an engine's declaration all move this table
/// with no second copy to update. A hand-written matrix would have been stale
/// the first time any of those three changed.
#[tauri::command]
pub async fn engine_support_matrix(state: State<'_, AppState>) -> Result<SupportMatrix, String> {
    let installed = ollama::list_models().await.unwrap_or_default();
    let detected = detected_advisors(&state).await;

    // One request carrying every distinct tier, so the sidecar is asked once.
    let mut tiers = serde_json::Map::new();
    for decl in DECLARED {
        let key = tier_name(decl.tier);
        if !tiers.contains_key(key) {
            tiers.insert(
                key.to_string(),
                serde_json::json!(crate::room_mcp::tier_tool_names(true, decl.tier)),
            );
        }
    }
    let body = serde_json::json!({ "tiers": tiers, "web_enabled": true });
    // `agents_known` is "did the sidecar answer", NOT "did it name any agent".
    // Read off the list, an answer of `[]` — or one this version could not
    // decode — was reported as "the sidecar could not be reached", with no
    // reason beside it: a shape bug presented as a network problem.
    let (agents, per_tier, agents_known, agents_error) =
        match crate::sidecar::sidecar_json("/agent_support", &body).await {
            Ok(v) => {
                let per_tier: HashMap<String, Vec<String>> =
                    serde_json::from_value(v["tiers"].clone()).unwrap_or_default();
                let (agents, decode_error) = agent_rows(&v);
                (agents, per_tier, decode_error.is_none(), decode_error)
            }
            // `.error` and not `.sentinel(..)`: this string is shown next to a
            // half-drawn table, so it has to read as "why the agent columns are
            // missing", not as an `OLLAMA_DOWN` token the matrix UI has no
            // reason to know how to translate.
            Err(e) => (Vec::new(), HashMap::new(), false, Some(e.error)),
        };

    let providers = DECLARED
        .iter()
        .map(|decl| {
            let caps = EngineCapabilities::from_decl("", decl);
            let tier = tier_name(decl.tier);
            ProviderRow {
                available: engine_available(decl.id, &installed, &detected),
                agents: per_tier.get(tier).cloned().unwrap_or_default(),
                caps,
            }
        })
        .collect();

    Ok(SupportMatrix {
        agents,
        providers,
        agents_known,
        agents_error,
    })
}

/// The agent list out of a `/agent_support` answer, and — when the answer
/// carried a shape this version cannot read — the sentence that says so.
///
/// Decoding into an empty vec loses the distinction the matrix rests on: a
/// sidecar that answered `{"agents": {…}}` is REACHABLE, and telling the user
/// it could not be reached sends them looking at the network for a bug in here.
fn agent_rows(answer: &serde_json::Value) -> (Vec<AgentRow>, Option<String>) {
    match serde_json::from_value::<Vec<AgentRow>>(answer["agents"].clone()) {
        Ok(agents) => (agents, None),
        Err(e) => (
            Vec::new(),
            Some(format!(
                "The AI engine answered in a shape this version does not understand ({e})."
            )),
        ),
    }
}

/// Is this engine usable on this Mac right now? Read from real state only —
/// installed Ollama models, detected CLIs, a saved provider key — so the matrix
/// never claims an engine is ready when it is not.
pub(crate) fn engine_available(id: &str, installed: &[String], detected: &[String]) -> bool {
    match id {
        // Which ENGINE the tag belongs to — not where the transport points.
        // `runs_on_this_mac` would call the whole Ollama row unavailable the
        // moment the room used a remote Ollama, which is when it is most in use.
        "ollama" => installed.iter().any(|m| served_by_ollama_engine(m)),
        "ollama-cloud" => installed.iter().any(|m| !served_by_ollama_engine(m)),
        "openrouter" => provider_connected("openrouter"),
        other => detected.iter().any(|d| d == other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_caps() -> EngineCapabilities {
        EngineCapabilities::from_decl("qwen3.5:4b", &OLLAMA)
    }

    /// The record is ONE table, and every engine the app can be pointed at has
    /// a row in it. Pinned because `declared_for` silently falls back to the
    /// local record rather than panicking on an unknown id — that fallback must
    /// never be the thing that answers a real selection.
    #[test]
    fn every_selection_shape_resolves_to_a_declared_engine() {
        assert_eq!(engine_id_of("qwen3.5:4b"), "ollama");
        assert_eq!(engine_id_of("minimax-m3:cloud"), "ollama-cloud");
        // The `<size>-cloud` spelling an exact `:cloud` suffix test misses. This
        // is the strictness `runs_on_this_mac` was written for, and declaring
        // it once is why `bridge_scope_for` can now read the record.
        assert_eq!(engine_id_of("gpt-oss:120b-cloud"), "ollama-cloud");
        assert_eq!(engine_id_of("qwen3-vl:235b-cloud"), "ollama-cloud");
        assert_eq!(engine_id_of("claude-cli"), "claude-cli");
        assert_eq!(engine_id_of("codex-cli::gpt-5.6-sol::high"), "codex-cli");
        assert_eq!(engine_id_of("openrouter::vendor/model"), "openrouter");
        for model in [
            "qwen3.5:4b",
            "minimax-m3:cloud",
            "claude-cli",
            "codex-cli",
            "openrouter::vendor/model",
        ] {
            assert_eq!(declared_for(model).id, engine_id_of(model), "{model}");
        }
    }

    /// THE CONVERSION THIS PACKET EXISTS FOR: "can it stream?" used to be
    /// `is_cli_engine(model)` written out at the decision point. It is now a
    /// declared field, and the two engines that cannot stream say so once.
    #[test]
    fn streaming_is_declared_not_sniffed_from_the_name() {
        assert_eq!(declared_for("claude-cli").streaming, Support::No);
        assert_eq!(
            declared_for("codex-cli::gpt-5.6-sol::high").streaming,
            Support::No
        );
        // Everything that speaks a real chat API streams — including the two
        // non-local ones an `is_cli_engine` test happened to get right by
        // accident and a "is it cloud?" test would have got wrong.
        assert_eq!(declared_for("qwen3.5:4b").streaming, Support::Yes);
        assert_eq!(declared_for("minimax-m3:cloud").streaming, Support::Yes);
        assert_eq!(
            declared_for("openrouter::vendor/model").streaming,
            Support::Yes
        );
    }

    /// The `:cloud` relay's two real limits were encoded as a string test at
    /// every site that cared. They are declared once now.
    #[test]
    fn the_cloud_relays_limits_are_declared_once() {
        let relay = declared_for("minimax-m3:cloud");
        assert_eq!(relay.tool_calling, Support::No);
        assert_eq!(relay.structured_output, Support::No);
        // ...and a LOCAL model's tool calling is not guessed at all: it is the
        // per-model question `/api/show` answers.
        assert_eq!(declared_for("qwen3.5:4b").tool_calling, Support::Unknown);
    }

    /// The tier a model is served at is part of the record, so the bridge and
    /// the published matrix cannot disagree about it.
    #[test]
    fn the_tier_is_part_of_the_record() {
        assert_eq!(declared_for("qwen3.5:4b").tier, ToolScope::LocalEngine);
        for hosted in [
            "minimax-m3:cloud",
            "gpt-oss:120b-cloud",
            "claude-cli",
            "codex-cli",
            "openrouter::vendor/model",
        ] {
            assert_eq!(
                declared_for(hosted).tier,
                ToolScope::CloudEngine,
                "{hosted}"
            );
        }
    }

    /// A DIFFERENTIAL test against the name-matching this replaced.
    ///
    /// "Does this content leave the Mac?" was written at each site as
    /// `is_cloud_model(m) || is_external_engine(m)`. Both are false for
    /// `gpt-oss:120b-cloud` — Ollama's `<size>-cloud` spelling, which an exact
    /// `:cloud` suffix test misses — so the Studio's progress line told the user
    /// "a local model can take a few minutes" while their document was already
    /// on its way to ollama.com. The declared record says `local: false`, which
    /// is what `studios.rs` now reads. Asserting the OLD predicates here is
    /// deliberate: the test fails the moment anyone reverts the call site to
    /// them.
    #[test]
    fn locality_is_declared_where_the_old_name_tests_were_wrong() {
        for hosted in ["gpt-oss:120b-cloud", "qwen3-vl:235b-cloud"] {
            assert!(
                !is_cloud_model(hosted) && !is_external_engine(hosted),
                "{hosted}: the old pair of name tests is supposed to MISS this"
            );
            assert!(
                !declared_for(hosted).local,
                "{hosted}: the record must know this runs off the Mac"
            );
        }
        // ...and the spellings the old pair did catch still read as non-local.
        assert!(!declared_for("minimax-m3:cloud").local);
        assert!(!declared_for("claude-cli").local);
        assert!(!declared_for("openrouter::vendor/model").local);
        assert!(declared_for("qwen3.5:4b").local);
    }

    /// PREFLIGHT: an incapable provider is caught before the run, with a
    /// sentence naming the engine and what it cannot do.
    #[test]
    fn preflight_blocks_an_incapable_provider_before_the_run() {
        let cli = EngineCapabilities::from_decl("claude-cli", &CLAUDE_CLI);
        let verdict = preflight(&cli, Capability::Vision);
        match verdict {
            Verdict::Blocked { code, reason } => {
                assert!(reason.contains("Claude Code"), "{reason}");
                assert!(reason.contains("look at an image"), "{reason}");
                // The engine is the obstacle, not a setting — so a caller may
                // still offer "install/choose a model that can see".
                assert_eq!(code, BlockCode::Capability);
            }
            other => panic!("expected Blocked, got {other:?}"),
        }
        // The same engine CAN call tools, so preflight must not refuse that.
        assert_eq!(preflight(&cli, Capability::ToolCalling), Verdict::Ready);
    }

    /// An engine that answered nothing is NOT reported as incapable. This is
    /// the difference between "your model cannot do this" and "we could not
    /// reach the engine", and collapsing them is how a broken sidecar used to
    /// read as a product limit.
    #[test]
    fn unknown_is_never_turned_into_a_refusal() {
        let caps = local_caps();
        match preflight(&caps, Capability::ToolCalling) {
            Verdict::Unknown { reason } => assert!(reason.contains("not readable"), "{reason}"),
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    /// A capable cloud model behind a closed privacy door gets the SPECIFIC
    /// sentence, because the fix is a switch the user owns. Without this the
    /// door's image stripping was invisible: the call ran, returned nothing,
    /// and the viewer reported that as a fact about the user's photo.
    #[test]
    fn the_door_gets_its_own_sentence_not_a_generic_refusal() {
        let mut caps = EngineCapabilities::from_decl("openrouter::vendor/sees", &OPENROUTER);
        caps.vision = Support::Yes;
        caps.image_reaches = false;
        match preflight(&caps, Capability::Vision) {
            Verdict::Blocked { code, reason } => {
                assert!(reason.contains("privacy door"), "{reason}");
                assert!(reason.contains("never received"), "{reason}");
                // THE DISTINCTION THE UI RESTS ON. Both arms are `Blocked` and
                // both carry prose; only the code says which offer is honest.
                // Settings hides the "download a vision helper" button on this
                // one and keeps it on `Capability` — matching on the sentence
                // would have re-derived the record's own answer, and the first
                // version simply treated every block alike and hid the button
                // in the one case a download IS the fix.
                assert_eq!(code, BlockCode::PrivacyDoor);
            }
            other => panic!("expected Blocked, got {other:?}"),
        }
        // ...and a plain "this engine is blind" block is NOT the door: same
        // variant, different code, different offer.
        let blind = EngineCapabilities::from_decl("claude-cli", &CLAUDE_CLI);
        assert!(matches!(
            preflight(&blind, Capability::Vision),
            Verdict::Blocked {
                code: BlockCode::Capability,
                ..
            }
        ));
        // Door open → the declared capability answers, unblocked.
        caps.image_reaches = true;
        assert_eq!(preflight(&caps, Capability::Vision), Verdict::Ready);
    }

    /// UNKNOWN IS NOT A YES. The door sentence asserts the engine can see; with
    /// the provider catalog unreadable nothing established that, and claiming
    /// it about an engine we could not reach is precisely what this module
    /// exists to prevent.
    #[test]
    fn an_unconfirmed_vision_model_behind_the_door_is_not_told_it_can_see() {
        let mut caps = EngineCapabilities::from_decl("openrouter::vendor/anything", &OPENROUTER);
        caps.vision = Support::Unknown;
        caps.image_reaches = false;
        assert!(vision_door_block(&caps).is_none());
        match preflight(&caps, Capability::Vision) {
            Verdict::Unknown { reason } => assert!(reason.contains("unreachable"), "{reason}"),
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    /// A sidecar that answered is REACHABLE, whatever it said. Reading
    /// "reached" off the length of the list made an empty answer — and an
    /// answer in a shape this version cannot decode — read as a network
    /// failure, with no reason shown beside the half-drawn table.
    #[test]
    fn an_undecodable_agent_list_is_a_shape_problem_not_a_silence() {
        let (rows, err) = agent_rows(&serde_json::json!({
            "agents": [{ "id": "web", "label": "Web" }]
        }));
        assert_eq!(rows.len(), 1);
        assert!(err.is_none());
        // No agents at all is still an answer, and must not be reported as one.
        assert!(agent_rows(&serde_json::json!({ "agents": [] })).1.is_none());
        let (rows, err) = agent_rows(&serde_json::json!({ "agents": { "a": "b" } }));
        assert!(rows.is_empty());
        assert!(err.unwrap_or_default().contains("does not understand"));
        // A missing field is the same failure, not a crash.
        assert!(agent_rows(&serde_json::json!({})).1.is_some());
    }

    /// A provider row is only "available" when this Mac really has it. The
    /// matrix is published to the user, so a row that claims readiness it
    /// cannot evidence is exactly the fabrication the release was about.
    #[test]
    fn availability_comes_from_real_state() {
        let local = vec!["qwen3.5:4b".to_string()];
        let hosted = vec!["gpt-oss:120b-cloud".to_string()];
        assert!(engine_available("ollama", &local, &[]));
        assert!(!engine_available("ollama-cloud", &local, &[]));
        assert!(engine_available("ollama-cloud", &hosted, &[]));
        assert!(!engine_available("ollama", &hosted, &[]));
        assert!(!engine_available("claude-cli", &local, &[]));
        assert!(engine_available(
            "claude-cli",
            &local,
            &["claude-cli".to_string()]
        ));
        assert!(!engine_available(
            "codex-cli",
            &local,
            &["claude-cli".to_string()]
        ));
    }
}
