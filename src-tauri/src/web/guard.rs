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

/// Re-check one redirect hop's host. Runs inside reqwest's *synchronous*
/// redirect policy, so DNS is resolved with the blocking resolver — fine for a
/// desktop app and the only option the policy API allows. `false` = block.
pub(crate) fn hop_host_is_public(url: &reqwest::Url) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str().map(|h| h.to_lowercase()) else {
        return false;
    };
    if host == "localhost" || host.ends_with(".local") {
        return false;
    }
    // Same bracket-stripping as check_public_http_url, for IPv6 literals.
    if let Ok(ip) = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
    {
        return is_public_ip(ip);
    }
    let port = url.port_or_known_default().unwrap_or(80);
    match (host.as_str(), port).to_socket_addrs() {
        Ok(addrs) => {
            let mut any = false;
            for a in addrs {
                any = true;
                if !is_public_ip(a.ip()) {
                    return false;
                }
            }
            any
        }
        Err(_) => false,
    }
}

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

    #[test]
    fn hop_host_check_blocks_private_and_local() {
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
            let u = reqwest::Url::parse(url).unwrap();
            assert!(!hop_host_is_public(&u), "hop should block {url}");
        }
        // Literal public IPs pass without touching the network.
        assert!(hop_host_is_public(&reqwest::Url::parse("http://8.8.8.8/").unwrap()));
        assert!(hop_host_is_public(&reqwest::Url::parse("https://1.1.1.1/").unwrap()));
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
