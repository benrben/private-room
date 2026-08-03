//! First-party web access for the agent's web_search / fetch_page tools.
//! Only reached when the user has picked a provider in Settings — the tools
//! are not even offered to the model otherwise.

use crate::extraction;
use std::net::SocketAddr;
use std::time::Duration;

mod fetch;
mod guard;
mod search;

pub use fetch::*;
pub use guard::*;
pub use search::*;

/// Shown whenever a fetch target (or a redirect hop) resolves onto this Mac
/// or the home network. Actionable and safe to surface to the model/UI.
pub(crate) const PRIVATE_BLOCKED: &str = "This address points to a private network and was blocked.";

/// One fused web result, structurally — the shape the sidecar's fusion actually
/// produces, kept whole instead of being flattened into a provenance sentence at
/// this boundary (BROWSE-3).
///
/// The agent still reads a numbered text list (see [`render_hits`]), but the
/// browser's results page needs the parts separately: which engines agreed (the
/// consensus dial), the engine's own snippet, the fused score. One struct feeds
/// both, so the model and the user are looking at the same search.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebHit {
    pub title: String,
    pub url: String,
    /// Every engine that returned this URL, in the fusion's priority order.
    /// Cross-engine agreement is the ranking signal we can show and Google
    /// cannot — one engine listing a page twice never lands here twice.
    #[serde(default)]
    pub engines: Vec<String>,
    #[serde(default)]
    pub date: Option<String>,
    /// The engine's own result snippet, when it gave one. Replaced by the
    /// page's `meta description` once the enrich pass runs (BROWSE-3b).
    #[serde(default)]
    pub snippet: Option<String>,
    #[serde(default)]
    pub score: f64,
}

impl WebHit {
    /// The engine that surfaced this hit first, for the one-line provenance the
    /// model reads. Never empty — a hit with no engines is a malformed row, and
    /// "web" is the honest fallback.
    pub fn source(&self) -> &str {
        self.engines.first().map(String::as_str).unwrap_or("web")
    }
}

/// A whole search, as the browser's results page consumes it (BROWSE-3).
/// `merged` and `took_ms` are what make the header's consensus line true
/// ("31 hits merged into 12 · 1.8s") rather than decorative.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub hits: Vec<WebHit>,
    pub merged: u32,
    pub took_ms: u32,
    /// Served from this Mac's 15-minute cache without touching the network.
    pub cached: bool,
    /// The engines that could not answer at all — blocked (HTTP 403), rate
    /// limited (429), unreachable, or slower than the fan-out budget.
    ///
    /// This is the difference between the two ways a search comes back empty,
    /// and the sidecar has always computed it; this boundary used to drop it.
    /// No hits and nothing failed means the web really had nothing. No hits and
    /// every engine failed means the search never happened — and reporting that
    /// as "No results found." tells the model, and then the user, that a subject
    /// does not exist on the web because a scraper got a 429.
    #[serde(default)]
    pub failed: Vec<String>,
}

impl SearchPage {
    /// A sentence naming the engines that could not answer, or `None` when the
    /// whole fan-out answered. Appended to what the model reads so a thin result
    /// set is never mistaken for a thorough one.
    pub fn blocked_note(&self) -> Option<String> {
        if self.failed.is_empty() {
            return None;
        }
        Some(format!(
            "Note: {} could not be reached for this search (blocked, rate limited or too slow), \
             so these results are only part of the web.",
            crate::web::join_names(&self.failed)
        ))
    }
}
