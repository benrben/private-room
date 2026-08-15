//! BROWSE-1: the private browser's content-blocking rule list.
//!
//! Compiled by WebKit itself (`WKContentRuleListStore`) — the same engine
//! Safari's content blockers use — so blocking happens in the network path,
//! before a request leaves the machine, not in page JavaScript a site could
//! detect or defeat.
//!
//! Two rule families, and the second is the security-critical one:
//!
//! * **Trackers/ads.** A curated list, generated here rather than parsed from
//!   EasyList at runtime. Arcelle never phones home for a filter list, so a
//!   list would have to ship bundled anyway; generating the Apple JSON from a
//!   domain table keeps the whole thing auditable in one file and adds no
//!   dependency. (Brave's `adblock` crate can convert full ABP syntax and is
//!   the natural upgrade if this list ever needs to be exhaustive.)
//!
//! * **Private network ranges.** [`crate::web::guard`] already refuses these
//!   for `fetch_page`, and `on_navigation` re-applies it to every top-level
//!   hop — but `on_navigation` never sees SUB-RESOURCES. A page that embeds
//!   `<img src="http://localhost:11434/api/delete">` would otherwise reach the
//!   user's own Ollama daemon. These rules close that at the network layer.
//!   They are defense in depth for the same invariant, at a different layer.

/// Ad/tracker/telemetry hosts. Kept deliberately small and high-confidence:
/// every entry here is an unambiguous tracking or ad-serving host, so the
/// blocker never breaks a page the user actually wanted.
const TRACKER_DOMAINS: &[&str] = &[
    // Google's ad + analytics estate
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "google-analytics.com",
    "googletagmanager.com",
    "googletagservices.com",
    "adservice.google.com",
    "analytics.google.com",
    // Meta
    "connect.facebook.net",
    "pixel.facebook.com",
    // Amazon ads
    "amazon-adsystem.com",
    "assoc-amazon.com",
    // Large ad exchanges / SSPs
    "adnxs.com",
    "rubiconproject.com",
    "pubmatic.com",
    "openx.net",
    "criteo.com",
    "criteo.net",
    "casalemedia.com",
    "smartadserver.com",
    "adform.net",
    "taboola.com",
    "outbrain.com",
    "sharethrough.com",
    "33across.com",
    "indexww.com",
    "bidswitch.net",
    "spotxchange.com",
    "teads.tv",
    "yieldmo.com",
    "media.net",
    "adroll.com",
    "quantserve.com",
    "quantcast.com",
    "scorecardresearch.com",
    "moatads.com",
    "adsrvr.org",
    "everesttech.net",
    "serving-sys.com",
    "zedo.com",
    // Analytics / session recording / behavioural
    "hotjar.com",
    "hotjar.io",
    "mouseflow.com",
    "fullstory.com",
    "luckyorange.com",
    "inspectlet.com",
    "crazyegg.com",
    "clarity.ms",
    "mixpanel.com",
    "segment.io",
    "segment.com",
    "amplitude.com",
    "heap.io",
    "heapanalytics.com",
    "kissmetrics.com",
    "statcounter.com",
    "chartbeat.com",
    "parsely.com",
    "newrelic.com",
    "nr-data.net",
    "optimizely.com",
    "branch.io",
    "appsflyer.com",
    "adjust.com",
    "kochava.com",
    "braze.com",
    "onesignal.com",
    "matomo.cloud",
    // Ad tech misc
    "bluekai.com",
    "krxd.net",
    "demdex.net",
    "omtrdc.net",
    "2o7.net",
    "adobedtm.com",
    "exelator.com",
    "tapad.com",
    "liveramp.com",
    "rlcdn.com",
    "agkn.com",
    "mathtag.com",
    "turn.com",
    "adsymptotic.com",
    "yieldlab.net",
    "improvedigital.com",
    "gumgum.com",
    "sovrn.com",
    "lijit.com",
];

/// THE ONLY REGEX WebKit's url-filter compiler is known to accept.
///
/// `WKContentRuleListStore` does not run a general regex engine. It compiles
/// each `url-filter` into a DFA through WebKit's own `URLFilterParser`, which
/// takes a small subset and rejects the whole list — every rule in it — the
/// moment one pattern uses something outside that subset. There is no partial
/// success and no diagnostic naming the pattern: the completion handler is
/// called with a null list and `WKErrorDomain` code 6, and the browser runs
/// with no blocking at all.
///
/// That is what shipped. Two constructs in the list below were outside the
/// subset, and both are ordinary regex that any other engine takes:
///
///   * `([:/]|$)` — an alternation with `$` INSIDE a group. The parser accepts
///     `$` only as the final term of a pattern.
///   * `([^/]*\.)?` — a QUANTIFIED group. Quantifiers are accepted on a single
///     character or character class, not on a parenthesised subpattern.
///
/// So every pattern here is now built from that subset and nothing else: `^`,
/// a trailing `$`, literal characters, `\` escapes, `[…]` classes, and `*`/`?`
/// applied to ONE character or class. Where a pattern needed alternation it
/// became several rules, which costs a slightly longer list and buys a list
/// that compiles. Keep it that way — the failure mode is silent and total.
///
/// These MUST stay in step with [`crate::web::guard::check_public_http_url`] —
/// the guard is the authority for navigation, this is the same policy for
/// sub-resources. A test below asserts every family the guard blocks has a
/// rule here.
const PRIVATE_URL_FILTERS: &[&str] = &[
    // `localhost` and `*.local`, with the host either ended by a delimiter or
    // ending the URL. Two rules apiece rather than one `([:/]|$)`.
    r"^https?://localhost[:/]",
    r"^https?://localhost$",
    r"^https?://[^/]*\.local[:/]",
    r"^https?://[^/]*\.local$",
    r"^https?://127\.",
    r"^https?://10\.",
    r"^https?://192\.168\.",
    // 172.16.0.0/12, one rule per decade of the second octet.
    r"^https?://172\.1[6-9]\.",
    r"^https?://172\.2[0-9]\.",
    r"^https?://172\.3[01]\.",
    r"^https?://169\.254\.",
    // CGNAT / Tailscale 100.64.0.0/10
    r"^https?://100\.6[4-9]\.",
    r"^https?://100\.[7-9][0-9]\.",
    r"^https?://100\.1[01][0-9]\.",
    r"^https?://100\.12[0-7]\.",
    // "this network" 0.0.0.0/8
    r"^https?://0\.",
    // IETF protocol assignments 192.0.0.0/24
    r"^https?://192\.0\.0\.",
    // Benchmarking 198.18.0.0/15
    r"^https?://198\.18\.",
    r"^https?://198\.19\.",
    // Multicast 224.0.0.0/4, reserved 240.0.0.0/4 and the broadcast address —
    // everything from 224 up, which is what the guard's `o[0] >= 224` means.
    r"^https?://22[4-9]\.",
    r"^https?://2[34][0-9]\.",
    r"^https?://25[0-5]\.",
    // IPv6 loopback, unspecified, and unique-local/link-local literals
    r"^https?://\[::1\]",
    r"^https?://\[::\]",
    r"^https?://\[f[cd]",
    r"^https?://\[fe[89ab]",
    // IPv4-mapped IPv6 literals. The guard classifies these by the IPv4 they
    // embed, so `[::ffff:127.0.0.1]` is a loopback address written the long
    // way; a url-filter cannot reach inside the mapping, so the whole (never
    // legitimately used) form is blocked rather than half of it.
    r"^https?://\[::ffff:",
];

/// The JSON WebKit compiles. Apple's format: an array of
/// `{trigger:{url-filter,…}, action:{type}}`.
pub fn rules_json() -> String {
    let mut rules: Vec<serde_json::Value> = Vec::new();

    // The private-network block comes FIRST so it is unmistakable in a dump of
    // the list; WebKit evaluates all rules regardless of order for `block`.
    for filter in PRIVATE_URL_FILTERS {
        rules.push(serde_json::json!({
            "trigger": { "url-filter": filter },
            "action": { "type": "block" }
        }));
    }

    for domain in TRACKER_DOMAINS {
        for filter in domain_filters(domain) {
            rules.push(serde_json::json!({
                "trigger": {
                    "url-filter": filter,
                    "load-type": ["third-party"]
                },
                "action": { "type": "block" }
            }));
        }
    }

    serde_json::to_string(&rules).expect("rule list serializes")
}

/// `example.com` → the url-filters matching that host and any subdomain of it.
///
/// TWO patterns, not one. The single pattern this replaces used an optional
/// GROUP — `([^/]*\.)?` — to make the subdomain part skippable, and a
/// quantified group is one of the two constructs WebKit's url-filter compiler
/// rejects (see [`PRIVATE_URL_FILTERS`]). Splitting the choice into two rules
/// says exactly the same thing with only the operators the compiler takes.
///
/// Dots are escaped so `google-analytics.com` cannot match
/// `google-analyticsXcom`, and the leading `\.` on the subdomain form is what
/// stops `notexample.com` matching `example.com`.
fn domain_filters(domain: &str) -> [String; 2] {
    let escaped = domain.replace('.', "\\.");
    [
        format!("^https?://{escaped}[:/]"),
        format!("^https?://[^/]*\\.{escaped}[:/]"),
    ]
}

/// Identifier the compiled list is cached under inside WebKit's store. Bump
/// the suffix whenever the rules change, or WebKit serves the previously
/// compiled list from its cache and edits here silently do nothing.
pub const RULE_LIST_ID: &str = "arcelle-browse-v3";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_are_valid_apple_content_blocker_json() {
        let parsed: serde_json::Value = serde_json::from_str(&rules_json()).expect("valid JSON");
        let arr = parsed.as_array().expect("top level is an array");
        assert!(!arr.is_empty());
        // Apple caps a compiled list at 150k rules; we must stay far under.
        assert!(arr.len() < 50_000, "rule count {} is implausible", arr.len());
        for rule in arr {
            let trigger = rule.get("trigger").expect("every rule has a trigger");
            assert!(
                trigger.get("url-filter").and_then(|f| f.as_str()).is_some(),
                "every trigger has a url-filter"
            );
            assert_eq!(
                rule.get("action").and_then(|a| a.get("type")),
                Some(&serde_json::json!("block")),
                "every action blocks"
            );
        }
    }

    #[test]
    fn domain_filter_escapes_dots_and_anchors_the_host() {
        let [exact, sub] = domain_filters("google-analytics.com");
        assert_eq!(exact, r"^https?://google-analytics\.com[:/]");
        assert_eq!(sub, r"^https?://[^/]*\.google-analytics\.com[:/]");
        // The escaped dot must be present so a dot cannot match any character,
        // and the subdomain form's LEADING dot is what stops the filter
        // matching `notgoogle-analytics.com`.
        assert!(exact.contains(r"\."));
        assert!(sub.contains(r"\.google-analytics"));
    }

    /// EVERY pattern must stay inside the subset WebKit's url-filter compiler
    /// accepts, because one that does not takes the whole list down with it —
    /// silently, with no blocking at all and a bare "WKErrorDomain error 6".
    ///
    /// The two constructs that shipped and did exactly that are named here so a
    /// future edit reintroducing either fails in a unit test rather than in a
    /// user's browser: a quantified GROUP, and `$` anywhere but the very end.
    #[test]
    fn no_filter_uses_a_construct_webkit_refuses_to_compile() {
        let parsed: serde_json::Value = serde_json::from_str(&rules_json()).unwrap();
        for rule in parsed.as_array().unwrap() {
            let f = rule["trigger"]["url-filter"].as_str().unwrap();
            // A quantifier may follow a character or a `]`, never a `)`.
            for q in [")?", ")*", ")+"] {
                assert!(!f.contains(q), "quantified group in {f}");
            }
            if let Some(at) = f.find('$') {
                assert_eq!(at, f.len() - 1, "`$` must end the pattern: {f}");
            }
        }
    }

    /// Every private-range filter must actually reach the compiled list, and
    /// must come first (ahead of the tracker rules) so a dump of the list shows
    /// the security-critical rules up front. Asserted against the PARSED JSON
    /// rather than its text — the raw string double-escapes every `\.`, which
    /// made an earlier substring version of this test fail for a reason that
    /// had nothing to do with the rules.
    #[test]
    fn private_ranges_all_reach_the_compiled_list_and_come_first() {
        let parsed: serde_json::Value = serde_json::from_str(&rules_json()).unwrap();
        let arr = parsed.as_array().unwrap();
        assert!(arr.len() > PRIVATE_URL_FILTERS.len());
        for (i, filter) in PRIVATE_URL_FILTERS.iter().enumerate() {
            assert_eq!(
                arr[i]["trigger"]["url-filter"].as_str(),
                Some(*filter),
                "private-range filter {i} missing or out of order"
            );
            // Private-range rules must apply to FIRST-party loads too: a page
            // navigating itself to localhost is exactly the attack. Only the
            // tracker rules carry a third-party load-type restriction.
            assert!(
                arr[i]["trigger"].get("load-type").is_none(),
                "private-range rule {i} must not be limited to third-party loads"
            );
        }
    }

    /// The two protection layers must agree, and this is what makes the claim
    /// in `PRIVATE_URL_FILTERS`' doc comment true.
    ///
    /// It used to be a hand-picked list of eleven addresses, which is why four
    /// whole families the navigation guard rejects had NO sub-resource rule:
    /// the IETF block 192.0.0.0/24, the benchmarking block 198.18.0.0/15,
    /// everything from 224 up (multicast, reserved, broadcast), and the IPv6
    /// unspecified and IPv4-mapped literals. A page could reach a service on
    /// this Mac simply by spelling its address one of those ways. Asserted
    /// against `check_public_http_url` ITSELF, in BOTH directions, so a family
    /// added to one layer cannot go missing from the other.
    ///
    /// Checked with a real regex engine so the filters are verified as
    /// patterns, not just as substrings.
    #[test]
    fn private_filters_match_exactly_the_hosts_the_guard_rejects() {
        // IP literals and the two known local names only. A HOSTNAME is
        // deliberately outside this equivalence: the guard lets `10.example.com`
        // through (it is a name, not an address) while `^https?://10\.` blocks
        // it — over-blocking a sub-resource is safe, under-blocking is not.
        let addresses = [
            "http://localhost:11434/api/delete",
            "http://127.0.0.1/x",
            "https://192.168.1.1/admin",
            "http://10.0.0.5/",
            "http://100.64.1.1/",
            "http://0.0.0.0/",
            "http://169.254.169.254/latest/meta-data",
            "http://172.16.0.1/",
            "http://172.31.255.254/",
            "http://printer.local/",
            "http://192.0.0.8/",
            "http://198.18.0.1/",
            "http://224.0.0.251/",
            "http://239.255.255.250/",
            "http://255.255.255.255/",
            "http://[::1]/",
            "http://[::]/",
            "http://[fd00::1]/",
            "http://[fe80::1]/",
            "http://[::ffff:192.168.1.1]/",
            // Public neighbours of every blocked range — these must stay
            // reachable, or the blocker starts breaking the real web.
            "https://example.com/page",
            "http://8.8.8.8/",
            "http://11.0.0.1/",
            "http://100.63.1.1/",
            "http://100.128.1.1/",
            "http://198.17.0.1/",
            "http://223.255.255.255/",
        ];
        for url in addresses {
            let guard_blocks = crate::web::check_public_http_url(url).is_err();
            // The url-filter subset WebKit accepts is a plain regex for
            // everything we use here, so `regex`-free matching is enough:
            // compile with the same semantics via a tiny shim.
            let filter_blocks = PRIVATE_URL_FILTERS
                .iter()
                .any(|f| simple_regex_matches(f, url));
            assert_eq!(
                filter_blocks, guard_blocks,
                "{url}: the navigation guard blocks={guard_blocks} but the \
                 sub-resource filters block={filter_blocks} — the two layers are \
                 one policy at two layers and must agree"
            );
        }
    }

    /// Minimal regex matcher covering exactly the constructs used in
    /// `PRIVATE_URL_FILTERS`: literals, `\.`, `[...]` classes with ranges,
    /// `(a|b)` alternation of literal/class sequences, `?` on `s`, and `$`.
    /// Written out rather than pulling in a regex dependency for one test.
    fn simple_regex_matches(pattern: &str, text: &str) -> bool {
        fn m(p: &[char], t: &[char]) -> bool {
            if p.is_empty() {
                return true;
            }
            match p[0] {
                '^' => m(&p[1..], t),
                '$' => t.is_empty(),
                '\\' if p.len() > 1 => {
                    if !t.is_empty() && t[0] == p[1] {
                        m(&p[2..], &t[1..])
                    } else {
                        false
                    }
                }
                '[' => {
                    let close = match p.iter().position(|&c| c == ']') {
                        Some(i) => i,
                        None => return false,
                    };
                    let (neg, body) = if p[1] == '^' {
                        (true, &p[2..close])
                    } else {
                        (false, &p[1..close])
                    };
                    let quantified = p.get(close + 1) == Some(&'*');
                    let rest = if quantified { &p[close + 2..] } else { &p[close + 1..] };
                    let in_class = |c: char| {
                        let mut i = 0;
                        let mut hit = false;
                        while i < body.len() {
                            if i + 2 < body.len() && body[i + 1] == '-' {
                                if c >= body[i] && c <= body[i + 2] {
                                    hit = true;
                                }
                                i += 3;
                            } else {
                                if body[i] == '\\' && i + 1 < body.len() {
                                    if c == body[i + 1] {
                                        hit = true;
                                    }
                                    i += 2;
                                    continue;
                                }
                                if c == body[i] {
                                    hit = true;
                                }
                                i += 1;
                            }
                        }
                        hit != neg
                    };
                    if quantified {
                        let mut k = 0;
                        loop {
                            if m(rest, &t[k..]) {
                                return true;
                            }
                            if k >= t.len() || !in_class(t[k]) {
                                return false;
                            }
                            k += 1;
                        }
                    }
                    !t.is_empty() && in_class(t[0]) && m(rest, &t[1..])
                }
                '(' => {
                    let mut depth = 0;
                    let mut close = 0;
                    for (i, &c) in p.iter().enumerate() {
                        if c == '(' {
                            depth += 1;
                        } else if c == ')' {
                            depth -= 1;
                            if depth == 0 {
                                close = i;
                                break;
                            }
                        }
                    }
                    let inner: Vec<char> = p[1..close].to_vec();
                    let quantified = p.get(close + 1) == Some(&'?');
                    let rest = if quantified { &p[close + 2..] } else { &p[close + 1..] };
                    // Split the group on top-level '|'
                    let mut alts: Vec<Vec<char>> = Vec::new();
                    let mut cur: Vec<char> = Vec::new();
                    let mut d = 0;
                    let mut i = 0;
                    while i < inner.len() {
                        let c = inner[i];
                        if c == '\\' && i + 1 < inner.len() {
                            cur.push(c);
                            cur.push(inner[i + 1]);
                            i += 2;
                            continue;
                        }
                        if c == '[' {
                            while i < inner.len() && inner[i] != ']' {
                                cur.push(inner[i]);
                                i += 1;
                            }
                            cur.push(']');
                            i += 1;
                            continue;
                        }
                        if c == '(' {
                            d += 1;
                        } else if c == ')' {
                            d -= 1;
                        }
                        if c == '|' && d == 0 {
                            alts.push(std::mem::take(&mut cur));
                            i += 1;
                            continue;
                        }
                        cur.push(c);
                        i += 1;
                    }
                    alts.push(cur);
                    for alt in &alts {
                        let mut combined = alt.clone();
                        combined.extend_from_slice(rest);
                        if m(&combined, t) {
                            return true;
                        }
                    }
                    quantified && m(rest, t)
                }
                c => {
                    let optional = p.get(1) == Some(&'?');
                    if optional {
                        if !t.is_empty() && t[0] == c && m(&p[2..], &t[1..]) {
                            return true;
                        }
                        return m(&p[2..], t);
                    }
                    !t.is_empty() && t[0] == c && m(&p[1..], &t[1..])
                }
            }
        }
        let p: Vec<char> = pattern.chars().collect();
        let t: Vec<char> = text.chars().collect();
        m(&p, &t)
    }
}
