use super::*;

fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || o[0] == 0 // "this network" 0.0.0.0/8
                || (o[0] == 100 && (o[1] & 0xc0) == 0x40) // CGNAT/Tailscale 100.64.0.0/10
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol 192.0.0.0/24
                || (o[0] == 198 && (o[1] & 0xfe) == 18) // benchmarking 198.18.0.0/15
                || o[0] >= 224) // multicast 224.0.0.0/4 + reserved 240.0.0.0/4
        }
        std::net::IpAddr::V6(v6) => {
            // Classify IPv4-mapped addresses (::ffff:a.b.c.d) by their
            // embedded IPv4, so e.g. ::ffff:192.168.1.1 can't slip through.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(std::net::IpAddr::V4(v4));
            }
            let seg = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (seg[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (seg[0] & 0xffc0) == 0xfe80) // link local fe80::/10
        }
    }
}

/// The fetch tool takes model-supplied URLs; keep it away from this Mac and
/// the local network (Ollama, routers, .local devices).
pub fn check_public_http_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("Invalid URL: {url}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http(s) URLs can be fetched.".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Invalid URL: no host.".to_string())?
        .to_lowercase();
    // A trailing dot is the DNS ROOT LABEL: "localhost." and "printer.local."
    // resolve exactly like the names without it, and every service on this Mac
    // answers them — but a literal comparison does not see that, so
    // `http://localhost.:11434/` walked straight through this check. Normalised
    // once, before every test below. (IP literals need no help: `url` already
    // rewrites "127.0.0.1." back to "127.0.0.1".)
    let host = host.trim_end_matches('.');
    // host_str() keeps the brackets on IPv6 literals ("[::1]"); strip them or
    // the IpAddr parse below never fires for V6 and the literal check is moot.
    let local = host == "localhost"
        || host.ends_with(".local")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .map_or(false, |ip| !is_public_ip(ip));
    if local {
        return Err("Local and private-network addresses cannot be fetched.".into());
    }
    Ok(parsed)
}

/// SEC-5: `check_public_http_url` only blocks *literal* private IPs and known
/// local names — a normal-looking hostname can still resolve to 192.168.x.x
/// (DNS rebinding). Resolve the host and confirm EVERY returned address is
/// public, returning one checked address to pin the connection to.
pub(crate) async fn resolve_public_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| format!("Could not resolve the address for {host}."))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("Could not resolve the address for {host}."));
    }
    if addrs.iter().any(|a| !is_public_ip(a.ip())) {
        return Err(PRIVATE_BLOCKED.into());
    }
    Ok(addrs[0])
}

/// Does this host resolve to an address inside this Mac or the local network?
///
/// Deliberately NOT [`resolve_public_addr`]'s error, which also covers "the
/// name does not resolve at all". The private browser's post-navigation
/// recheck needs the two apart: a name that cannot be resolved simply fails to
/// load on its own, and reporting that as a private-address block would put a
/// red banner and a permanent journal line on nothing at all.
///
/// `false` on any lookup failure — this answers one question, and "I could not
/// find out" is not "yes".
pub(crate) async fn host_resolves_private(host: &str, port: u16) -> bool {
    match tokio::net::lookup_host((host, port)).await {
        Ok(addrs) => {
            let addrs: Vec<SocketAddr> = addrs.collect();
            !addrs.is_empty() && addrs.iter().any(|a| !is_public_ip(a.ip()))
        }
        Err(_) => false,
    }
}

// A `hop_host_is_public` used to live here, called from reqwest's synchronous
// redirect policy. It was strictly weaker than the check the first hop gets:
// having approved a hop it could not PIN it, so reqwest resolved the redirect
// target a second time, unpinned, to open the connection — a hostile server
// could answer the check publicly and the connection privately. `guarded_get`
// now follows the chain itself and gives every hop the full treatment (literal
// check, resolve all addresses, pin the connection), so the weaker check has
// no caller and no reason to exist.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_local_and_private_urls() {
        for url in [
            "http://localhost:11434/api",
            "http://127.0.0.1/x",
            "https://192.168.1.1/admin",
            "http://10.0.0.5/",
            "http://100.64.1.1/",
            "http://0.0.0.0/",
            "http://192.0.0.8/",
            "http://198.18.0.1/",
            "http://224.0.0.251/",
            "http://255.255.255.255/",
            "http://[::ffff:192.168.1.1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://printer.local/",
            "ftp://example.com/",
            "file:///etc/passwd",
        ] {
            assert!(check_public_http_url(url).is_err(), "should block {url}");
        }
        assert!(check_public_http_url("https://example.com/page").is_ok());
        // Public neighbors of the newly blocked ranges stay reachable.
        for url in ["http://100.63.1.1/", "http://100.128.1.1/", "http://198.17.0.1/"] {
            assert!(check_public_http_url(url).is_ok(), "should allow {url}");
        }
    }

    /// A hostname's trailing dot is the root label — it names the SAME service
    /// and resolves to the same address, so the guard has to read it the same
    /// way. `http://localhost.:11434/api/tags` used to pass this check, and in
    /// `download_allowed` the literal check is the only layer there is.
    #[test]
    fn a_trailing_dot_does_not_smuggle_a_local_name_past_the_guard() {
        for url in [
            "http://localhost.:11434/api/tags",
            "http://localhost./",
            "https://LocalHost.:443/",
            "http://printer.local./",
            "http://printer.local.:631/",
            "http://localhost..:11434/",
        ] {
            assert!(check_public_http_url(url).is_err(), "should block {url}");
        }
        // A real name that merely ends in a dot is still fetchable, and a name
        // that only CONTAINS one of these labels was never local to begin with.
        assert!(check_public_http_url("https://example.com./page").is_ok());
        assert!(check_public_http_url("https://my-localhost.example.com/").is_ok());
    }

    /// What the removed `hop_host_is_public` used to assert, now asserted of
    /// the check every redirect hop actually gets: `guarded_get` re-runs
    /// `check_public_http_url` on each `Location` before resolving it.
    #[test]
    fn every_redirect_target_shape_the_hop_check_blocked_is_still_blocked() {
        for url in [
            "http://192.168.0.1/",
            "http://10.1.2.3/",
            "http://127.0.0.1/",
            "http://100.64.1.1/",
            "http://[::1]/",
            "http://[::ffff:10.0.0.5]/",
            "http://localhost/",
            "http://printer.local/",
            "ftp://example.com/",
        ] {
            assert!(check_public_http_url(url).is_err(), "hop should block {url}");
        }
        // Literal public IPs pass without touching the network.
        assert!(check_public_http_url("http://8.8.8.8/").is_ok());
        assert!(check_public_http_url("https://1.1.1.1/").is_ok());
    }

    #[tokio::test]
    async fn resolve_rejects_private_literal_hosts() {
        // These resolve locally (no real DNS) to loopback/private ranges.
        assert!(resolve_public_addr("127.0.0.1", 80).await.is_err());
        assert!(resolve_public_addr("192.168.1.1", 80).await.is_err());
        assert!(resolve_public_addr("::1", 80).await.is_err());
        // A literal public IP resolves to itself and is accepted.
        assert!(resolve_public_addr("8.8.8.8", 443).await.is_ok());
    }
}
