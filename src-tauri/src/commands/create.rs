//! The Create page's catalogue: which models in this room can actually make a
//! picture, and — just as load-bearing — why the rest cannot.
//!
//! The whole page turns on one rule: a model is offered ONLY when a live
//! catalog says it produces pixels. Nothing here matches on a name. "flux",
//! "image" and "vision" all appear in the ids of models that merely read
//! pictures, and the models that do draw are under no obligation to say so in
//! their slug — so a name test would both invite failures and hide capable
//! models. `architecture.output_modalities`, parsed in `providers.rs`, is the
//! only source.
//!
//! The exclusions are returned rather than silently dropped. "Claude isn't
//! here" is a question the user will have, and an empty shelf with no
//! explanation reads as a broken page; `qwen2.5vl` sitting in the list and then
//! failing mid-generation reads as a broken app.

use serde::Serialize;

use super::capabilities::DECLARED;
use super::media_limits::{ensure_media_limits, limits_for, media_table_loaded, MediaLimits};
use super::providers::openrouter_key;
use super::{list_provider_models, provider_connected};

/// One model the Create page may offer.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateModel {
    /// The full selection string a generation is started with, engine prefix
    /// included (`"openrouter::vendor/slug"`) — not the bare provider slug,
    /// which would lose which engine to route through.
    pub model: String,
    pub slug: String,
    pub label: String,
    pub engine: String,
    pub engine_label: String,
    pub local: bool,
    pub description: Option<String>,
    /// Both can be true: a model that makes stills and clips appears under
    /// both tabs rather than being forced into one.
    pub image: bool,
    pub video: bool,
    /// The provider's own per-token output price, verbatim. Deliberately not
    /// converted to a per-picture figure: image models are not all billed per
    /// token, and a made-up "$0.04 each" on screen would be a number the room
    /// invented.
    pub output_price: Option<String>,
    /// What this model will actually accept — legal lengths, sizes, and which
    /// ends of a clip a picture may be pinned to. Read from the provider's own
    /// media endpoints, so the page can offer 4/6/8 seconds for Veo and 3–15
    /// for Kling instead of one invented list that half the shelf rejects.
    /// Absent when the provider published nothing for this model.
    pub limits: Option<MediaLimits>,
}

/// One reason a set of models is not on the shelf.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateExclusion {
    pub engine_label: String,
    pub reason: String,
    pub count: usize,
    /// A few names, so the row is checkable rather than a bare count.
    pub examples: Vec<String>,
}

/// Everything the Create page needs to draw itself.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateCatalog {
    pub models: Vec<CreateModel>,
    /// How many models were considered in total — the denominator in
    /// "11 of 34 can make a picture".
    pub scanned: usize,
    pub excluded: Vec<CreateExclusion>,
    /// True when at least one provider with a catalog is connected. False means
    /// the page shows a "connect a provider" state rather than "nothing can
    /// draw", which are very different sentences.
    pub any_provider: bool,
    /// Set when a provider is connected but its catalog could not be read, so
    /// the page can say "couldn't reach OpenRouter" instead of showing an
    /// empty shelf that looks like a settled fact.
    pub error: Option<String>,
}

/// The engine's own display name, by id.
///
/// Looked up straight in the declaration table rather than through
/// `declared_for`, which resolves a MODEL string and falls back to Ollama for
/// anything it does not recognize — here an unknown id should name itself, not
/// quietly become "Ollama (this Mac)".
fn engine_label(id: &str) -> String {
    DECLARED
        .iter()
        .find(|d| d.id == id)
        .map(|d| d.label.to_string())
        .unwrap_or_else(|| id.to_string())
}

/// Is this a meta-model that ROUTES to another rather than drawing itself?
///
/// Matched on the vendor prefix, which is the one place a slug is authoritative
/// — `openrouter/*` is OpenRouter's own namespace for its routers, not a model
/// family. This is deliberately NOT the kind of name-matching the module
/// docstring forbids: it decides ORDER, never capability, and a wrong answer
/// costs a row's position rather than a failed paid call.
fn is_router(slug: &str) -> bool {
    slug.starts_with("openrouter/auto")
}

/// Remove the models the picture/video endpoints do not serve, returning their
/// labels so the page can say which and why.
///
/// `served` is asked only when `loaded` is true. That guard is the whole
/// safety of the rule: `/videos/models` and `/images/models` ARE the list of
/// what those endpoints answer for, so a slug absent from a table that LOADED
/// is a settled no — but a slug absent from a table that never arrived is not
/// evidence of anything, and acting on it would empty the Create page every
/// time the network hiccuped and then blame the models for it.
fn drop_unserved(
    models: &mut Vec<CreateModel>,
    loaded: bool,
    served: impl Fn(&str) -> bool,
) -> Vec<String> {
    if !loaded {
        return Vec::new();
    }
    let mut unreachable = Vec::new();
    models.retain(|m| {
        if served(&m.slug) {
            return true;
        }
        unreachable.push(m.label.clone());
        false
    });
    unreachable
}

/// Group the models an engine cannot generate with into one honest row.
fn exclusion(engine: &str, reason: &str, names: Vec<String>) -> Option<CreateExclusion> {
    if names.is_empty() {
        return None;
    }
    Some(CreateExclusion {
        engine_label: engine_label(engine),
        reason: reason.to_string(),
        count: names.len(),
        examples: names.into_iter().take(3).collect(),
    })
}

/// The Create page's model list.
///
/// Only OpenRouter publishes output modalities today, so it is the only engine
/// that can contribute models. The others contribute *exclusions* — which is
/// not a stub: "Claude reads pictures but cannot draw one" is the single most
/// likely question this page has to answer, and it is answered from the same
/// declaration table the rest of the app reasons about engines with.
#[tauri::command]
pub async fn list_create_models() -> Result<CreateCatalog, String> {
    let mut models: Vec<CreateModel> = Vec::new();
    let mut excluded: Vec<CreateExclusion> = Vec::new();
    let mut scanned = 0usize;
    let mut error: Option<String> = None;

    let any_provider = provider_connected("openrouter");
    if any_provider {
        // Before the shelf is built, not after: the limits decide what the
        // bench may offer, and a page that renders first and learns the legal
        // durations second would show a seconds picker that changes under the
        // user's hand.
        if let Some(key) = openrouter_key() {
            ensure_media_limits(&key).await;
        }
        match list_provider_models("openrouter").await {
            Ok(catalog) => {
                scanned += catalog.len();
                let mut text_only: Vec<String> = Vec::new();
                for model in catalog {
                    if model.image_output || model.video_output {
                        models.push(CreateModel {
                            model: format!("openrouter::{}", model.slug),
                            slug: model.slug.clone(),
                            label: model.label.clone(),
                            engine: "openrouter".into(),
                            engine_label: engine_label("openrouter"),
                            local: false,
                            description: model.description.clone(),
                            image: model.image_output,
                            video: model.video_output,
                            output_price: model.output_price.clone(),
                            limits: limits_for(&model.slug),
                        });
                    } else {
                        text_only.push(model.slug);
                    }
                }
                excluded.extend(exclusion(
                    "openrouter",
                    "Text output only, per the provider's own catalog.",
                    text_only,
                ));
            }
            Err(e) => error = Some(e),
        }
    }

    // The declared engines that cannot draw, whatever model rides them. These
    // are read off the same `EngineDecl` table `capabilities.rs` uses, so this
    // list cannot drift from what the rest of the app believes.
    for decl in DECLARED {
        match decl.id {
            "openrouter" => {}
            "claude-cli" | "codex-cli" => {
                scanned += 1;
                excluded.extend(exclusion(
                    decl.id,
                    "Reads pictures, cannot make them — vision in, no image out.",
                    vec![decl.label.to_string()],
                ));
            }
            "ollama" | "ollama-cloud" => {
                scanned += 1;
                excluded.extend(exclusion(
                    decl.id,
                    "Serves chat models. A drawing model is not reachable over \
                     its chat API at all, so nothing local can make a picture yet.",
                    vec![decl.label.to_string()],
                ));
            }
            _ => {}
        }
    }

    // A model the picture and video endpoints do not serve cannot make a
    // picture, whatever the chat catalogue says about its output modalities.
    //
    // THIS IS WHY `openrouter/auto` USED TO BE HERE AND IS NOT ANY MORE. It
    // declares image output honestly — it can route a CHAT call to a model
    // that draws — and back when generation went through `/chat/completions`
    // that made it usable. Generation moved to the dedicated `/images` and
    // `/videos` endpoints (31 of 42 image models refuse the chat door), and
    // nothing revisited the shelf. The router has no entry on either endpoint,
    // so every generation it was picked for came back "No endpoint found for
    // model openrouter/auto" — reported live.
    //
    // The test is the media catalogues themselves rather than the slug:
    // `/videos/models` and `/images/models` ARE the list of what those
    // endpoints serve. Only applied when a table actually loaded — otherwise
    // a network hiccup would empty the page and blame the models for it.
    {
        let unreachable = drop_unserved(&mut models, media_table_loaded(), |slug| {
            limits_for(slug).is_some()
        });
        if let Some(row) = exclusion(
            "openrouter",
            "Declares pictures on the chat API, but the provider's own picture \
             and video endpoints do not serve it — a call would come back \
             \"no endpoint found\". Routers like openrouter/auto are the usual \
             case: they route chat, and drawing does not go through chat.",
            unreachable,
        ) {
            excluded.push(row);
        }
    }

    // Routers last, then alphabetical — a belt-and-braces ordering for the
    // case where the media table did not load and the retain above was
    // skipped. Whoever reaches for a router is doing so deliberately; the
    // default should be a model that only knows how to draw.
    models.sort_by(|a, b| {
        is_router(&a.slug)
            .cmp(&is_router(&b.slug))
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
    });
    Ok(CreateCatalog {
        models,
        scanned,
        excluded,
        any_provider,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shelf(slugs: &[&str]) -> Vec<CreateModel> {
        slugs
            .iter()
            .map(|slug| CreateModel {
                model: format!("openrouter::{slug}"),
                slug: (*slug).to_string(),
                label: (*slug).to_string(),
                engine: "openrouter".into(),
                engine_label: "OpenRouter".into(),
                local: false,
                description: None,
                image: true,
                video: false,
                output_price: None,
                limits: None,
            })
            .collect()
    }

    #[test]
    fn a_model_the_picture_endpoint_does_not_serve_leaves_the_shelf() {
        // REPORTED LIVE: "No endpoint found for model openrouter/auto". The
        // router declares image output honestly — it can route a CHAT call to
        // a model that draws — but generation moved to the dedicated /images
        // and /videos endpoints, and no router has an entry on either. So the
        // declaration is true and useless, and only the media catalogues can
        // say so.
        let mut models = shelf(&["openrouter/auto", "qwen/qwen-image-3-pro"]);
        let dropped = drop_unserved(&mut models, true, |slug| slug != "openrouter/auto");
        assert_eq!(dropped, vec!["openrouter/auto"]);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].slug, "qwen/qwen-image-3-pro");
    }

    #[test]
    fn a_media_catalogue_that_never_loaded_excludes_nothing() {
        // The guard that keeps the rule safe. Without it, one failed fetch
        // would empty the Create page and blame every model on it — a much
        // worse error than leaving a router on the shelf.
        let mut models = shelf(&["openrouter/auto", "qwen/qwen-image-3-pro"]);
        let dropped = drop_unserved(&mut models, false, |_| {
            panic!("nothing may be judged against a table that never arrived")
        });
        assert!(dropped.is_empty());
        assert_eq!(models.len(), 2, "the shelf survives a failed fetch intact");
    }

    #[test]
    fn an_exclusion_row_keeps_a_few_names_to_check_the_count_against() {
        let row = exclusion(
            "openrouter",
            "Text output only.",
            vec!["a".into(), "b".into(), "c".into(), "d".into(), "e".into()],
        )
        .expect("a non-empty list makes a row");
        // The count is the truth; the examples are a sample, not the whole set.
        assert_eq!(row.count, 5);
        assert_eq!(row.examples, vec!["a", "b", "c"]);
    }

    #[test]
    fn nothing_excluded_makes_no_row_at_all() {
        // An engine with nothing to exclude must not draw an empty accusation.
        assert!(exclusion("openrouter", "Text output only.", vec![]).is_none());
    }

    #[test]
    fn a_router_never_lands_in_the_default_selection() {
        // The bench selects the FIRST model of the tab. Alphabetically that was
        // `openrouter/auto` — a router, which asked for a picture may route to
        // a model that answers in words and makes nothing. So the most likely
        // first generation in a fresh room was the one most likely to fail.
        assert!(is_router("openrouter/auto"));
        assert!(is_router("openrouter/auto-beta"));
        // Real picture models, including one whose vendor merely resembles it.
        assert!(!is_router("google/gemini-3-pro-image"));
        assert!(!is_router("openrouter-lookalike/auto"));
        assert!(!is_router("black-forest-labs/flux-3-video"));

        // Ordering is what the fix actually turns on.
        let mut slugs = ["openrouter/auto", "qwen/qwen-image-3", "google/gemini-3-pro-image"];
        slugs.sort_by(|a, b| is_router(a).cmp(&is_router(b)).then_with(|| a.cmp(b)));
        assert_eq!(slugs[0], "google/gemini-3-pro-image");
        assert_eq!(slugs[2], "openrouter/auto", "routers sink to the bottom");
    }

    #[test]
    fn engine_labels_come_from_the_one_declaration_table() {
        // Not a second hand-kept list — this is what keeps the "why not" rows
        // agreeing with Settings' own capability matrix.
        assert_eq!(engine_label("claude-cli"), "Claude Code");
        assert_eq!(engine_label("openrouter"), "OpenRouter");
        // An id nothing declares still names itself rather than panicking.
        assert_eq!(engine_label("nonesuch"), "nonesuch");
    }
}
