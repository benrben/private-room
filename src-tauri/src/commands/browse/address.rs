//! What a piece of text was ADDRESSED at — a host, or a question.
//!
//! This is the Rust half of one rule. The address bar decides it in
//! `src/workspace/address.ts` before it calls anything; `browse_open` decides
//! it here, for the agent, before it navigates anything. The two must agree:
//! typing `best pizza nyc` and asking the Browser agent to look up best pizza
//! nyc are the same request, and the room answers both from its own engines.
//!
//! Keep the case table in [`tests`] and the one in `e2e/page-script/
//! address.test.mjs` in step — they are deliberately the same cases, so a rule
//! that drifts on one side goes red on that side.
//!
//! Deciding is not permitting: a `Url` verdict still has to clear
//! `browse_guard_url`, which is what actually refuses this Mac and private
//! networks by name.

/// What the text meant.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Address {
    /// Addressed at a host. Carries the text with a scheme filled in.
    Url(String),
    /// Not addressed at anything — search for it.
    Search(String),
}

/// A single token that is really a host: `example.com`, `x.co/path`.
/// The 2-character floor on the last label is what keeps `node.j` a topic.
fn is_hostish(text: &str) -> bool {
    let head = text.split(['/', ':', '?', '#']).next().unwrap_or_default();
    let (name, tld) = match head.rsplit_once('.') {
        Some(parts) => parts,
        None => return false,
    };
    !name.is_empty() && tld.chars().count() >= 2 && !tld.contains('.')
}

/// `localhost:3000` — a host named by port rather than by dot.
fn is_host_port(text: &str) -> bool {
    let head = text.split(['/', '?', '#']).next().unwrap_or_default();
    match head.rsplit_once(':') {
        Some((name, port)) => {
            !name.is_empty() && !port.is_empty() && port.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

/// `192.168.1.1`, with or without a port. The guard refuses it later, by name.
fn is_ipv4(text: &str) -> bool {
    let head = text.split(['/', '?', '#']).next().unwrap_or_default();
    let head = head.split(':').next().unwrap_or_default();
    let mut octets = 0;
    for part in head.split('.') {
        if part.is_empty() || part.len() > 3 || !part.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        octets += 1;
    }
    octets == 4
}

/// Decide what the text meant. `None` means "nothing to do" (empty input).
///
/// Order matters, and it is the same order the address bar uses: the explicit
/// forms (`?` and a scheme) win over the guesses, so there is always a way to
/// force either behavior on ambiguous text.
pub(crate) fn classify(input: &str) -> Option<Address> {
    let text = input.trim();
    if text.is_empty() {
        return None;
    }

    // "?query" — force a search for text that would otherwise look like a host.
    if let Some(rest) = text.strip_prefix('?') {
        let query = rest.trim();
        return (!query.is_empty()).then(|| Address::Search(query.to_string()));
    }

    // An explicit scheme is a decision the caller already made.
    if text.contains("://") {
        return Some(Address::Url(text.to_string()));
    }

    // No URL has a space in it. This is the case that reached the agent as
    // `Invalid URL: https://best pizza nyc` and sent it hunting for a search
    // box on google.com.
    if text.chars().any(char::is_whitespace) {
        return Some(Address::Search(text.to_string()));
    }

    if is_hostish(text) || is_ipv4(text) || is_host_port(text) {
        return Some(Address::Url(format!("https://{text}")));
    }

    // A bare word: "weather", "בנק ישראל". Nothing about it addresses a host.
    Some(Address::Search(text.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Address {
        Address::Url(text.to_string())
    }
    fn search(text: &str) -> Address {
        Address::Search(text.to_string())
    }

    #[test]
    fn empty_input_does_nothing() {
        assert_eq!(classify(""), None);
        assert_eq!(classify("   "), None);
    }

    /// Before this existed the agent got `Invalid URL: https://best pizza nyc`.
    #[test]
    fn anything_with_a_space_is_a_search() {
        assert_eq!(classify("best pizza nyc"), Some(search("best pizza nyc")));
        assert_eq!(
            classify("speaker diarization benchmarks"),
            Some(search("speaker diarization benchmarks"))
        );
    }

    #[test]
    fn a_bare_word_is_a_search_not_a_hostname_guess() {
        assert_eq!(classify("weather"), Some(search("weather")));
    }

    #[test]
    fn non_latin_queries_search() {
        assert_eq!(classify("בנק ישראל"), Some(search("בנק ישראל")));
    }

    #[test]
    fn an_explicit_scheme_is_always_a_url_verbatim() {
        assert_eq!(
            classify("https://example.com/x?y=1"),
            Some(url("https://example.com/x?y=1"))
        );
        assert_eq!(classify("http://localhost:3000"), Some(url("http://localhost:3000")));
    }

    #[test]
    fn host_shaped_text_navigates_with_https_filled_in() {
        assert_eq!(classify("example.com"), Some(url("https://example.com")));
        assert_eq!(classify("x.co/path"), Some(url("https://x.co/path")));
        assert_eq!(
            classify("en.wikipedia.org/wiki/Diarisation"),
            Some(url("https://en.wikipedia.org/wiki/Diarisation"))
        );
    }

    /// Classifying is not permitting: these reach `browse_guard_url`, which is
    /// what actually refuses private addresses with an honest message.
    #[test]
    fn host_port_and_ip_literals_navigate() {
        assert_eq!(classify("localhost:3000"), Some(url("https://localhost:3000")));
        assert_eq!(classify("192.168.1.1"), Some(url("https://192.168.1.1")));
    }

    #[test]
    fn question_mark_forces_a_search_for_host_shaped_text() {
        assert_eq!(classify("?example.com"), Some(search("example.com")));
        assert_eq!(classify("?"), None);
    }

    #[test]
    fn a_trailing_slash_keeps_host_shaped_text_a_url() {
        assert_eq!(classify("arcelle.app/"), Some(url("https://arcelle.app/")));
    }

    /// The space rule fires before the host rule, which is what keeps
    /// "who wrote hamlet.txt" from becoming a navigation.
    #[test]
    fn a_sentence_with_a_dot_in_it_is_still_a_search() {
        assert_eq!(
            classify("who wrote hamlet.txt"),
            Some(search("who wrote hamlet.txt"))
        );
    }

    /// "node.js" is a topic, not a host: the TLD rule needs 2+ characters.
    #[test]
    fn a_single_label_dotted_token_with_a_one_char_tld_is_a_search() {
        assert_eq!(classify("node.j"), Some(search("node.j")));
    }
}
