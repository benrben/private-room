//! First-party web access for the agent's web_search / fetch_page tools.
//! Only reached when the user has picked a provider in Settings — the tools
//! are not even offered to the model otherwise.

use crate::extraction;
use std::net::{SocketAddr, ToSocketAddrs};
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

pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}
