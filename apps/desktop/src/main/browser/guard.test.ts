// Port of the #[cfg(test)] mod tests in src-tauri/src/web/guard.rs.

import { describe, expect, it } from "vitest";
import { checkPublicHttpUrl, hostResolvesPrivate, isPublicIp, resolvePublicAddr } from "./guard.js";

describe("blocks_local_and_private_urls", () => {
  it("blocks local and private-network URLs", () => {
    for (const url of [
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
    ]) {
      expect(() => checkPublicHttpUrl(url), `should block ${url}`).toThrow();
    }
    expect(() => checkPublicHttpUrl("https://example.com/page")).not.toThrow();
  });

  it("rejects malformed URLs before any hostname policy is evaluated", () => {
    expect(() => checkPublicHttpUrl("not a URL")).toThrow("Invalid URL: not a URL");
  });

  it("allows public neighbors of the newly blocked ranges", () => {
    for (const url of ["http://100.63.1.1/", "http://100.128.1.1/", "http://198.17.0.1/"]) {
      expect(() => checkPublicHttpUrl(url), `should allow ${url}`).not.toThrow();
    }
  });
});

// A hostname's trailing dot is the root label — it names the SAME service
// and resolves to the same address, so the guard has to read it the same
// way. "http://localhost.:11434/api/tags" used to pass this check, and in
// download_allowed the literal check is the only layer there is.
describe("a_trailing_dot_does_not_smuggle_a_local_name_past_the_guard", () => {
  it("blocks names with a trailing root-label dot", () => {
    for (const url of [
      "http://localhost.:11434/api/tags",
      "http://localhost./",
      "https://LocalHost.:443/",
      "http://printer.local./",
      "http://printer.local.:631/",
      "http://localhost..:11434/",
    ]) {
      expect(() => checkPublicHttpUrl(url), `should block ${url}`).toThrow();
    }
  });

  it("still fetches a real name that merely ends in a dot, or merely contains a local label", () => {
    // A real name that merely ends in a dot is still fetchable, and a name
    // that only CONTAINS one of these labels was never local to begin with.
    expect(() => checkPublicHttpUrl("https://example.com./page")).not.toThrow();
    expect(() => checkPublicHttpUrl("https://my-localhost.example.com/")).not.toThrow();
  });
});

// What the removed `hop_host_is_public` used to assert, now asserted of the
// check every redirect hop actually gets: `guarded_get` re-runs
// `checkPublicHttpUrl` on each `Location` before resolving it.
describe("every_redirect_target_shape_the_hop_check_blocked_is_still_blocked", () => {
  it("blocks every private/local redirect-target shape", () => {
    for (const url of [
      "http://192.168.0.1/",
      "http://10.1.2.3/",
      "http://127.0.0.1/",
      "http://100.64.1.1/",
      "http://[::1]/",
      "http://[::ffff:10.0.0.5]/",
      "http://localhost/",
      "http://printer.local/",
      "ftp://example.com/",
    ]) {
      expect(() => checkPublicHttpUrl(url), `hop should block ${url}`).toThrow();
    }
  });

  it("passes literal public IPs without touching the network", () => {
    expect(() => checkPublicHttpUrl("http://8.8.8.8/")).not.toThrow();
    expect(() => checkPublicHttpUrl("https://1.1.1.1/")).not.toThrow();
  });
});

describe("resolve_rejects_private_literal_hosts", () => {
  it("fails closed when DNS fails or returns no addresses", async () => {
    const unavailable = async () => {
      throw new Error("DNS unavailable");
    };
    const empty = async () => [];

    await expect(resolvePublicAddr("unavailable.example", 443, unavailable)).rejects.toThrow(
      "Could not resolve the address for unavailable.example.",
    );
    await expect(resolvePublicAddr("empty.example", 443, empty)).rejects.toThrow(
      "Could not resolve the address for empty.example.",
    );
  });

  it("rejects literal private/loopback hosts and accepts a literal public IP", async () => {
    // These resolve locally (no real DNS) to loopback/private ranges.
    await expect(resolvePublicAddr("127.0.0.1", 80)).rejects.toThrow();
    await expect(resolvePublicAddr("192.168.1.1", 80)).rejects.toThrow();
    await expect(resolvePublicAddr("::1", 80)).rejects.toThrow();
    // A literal public IP resolves to itself and is accepted.
    const resolved = await resolvePublicAddr("8.8.8.8", 443);
    expect(resolved.address).toBe("8.8.8.8");
    expect(resolved.port).toBe(443);
  });

  it("prefers IPv4 on a dual-stack host after checking every answer", async () => {
    const dualStack = async () => [
      { address: "2001:4860:4860::8888", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ];
    await expect(resolvePublicAddr("dual.example", 443, dualStack)).resolves.toEqual({
      address: "8.8.8.8",
      port: 443,
    });
  });

  it("still rejects the whole DNS answer when any address is private", async () => {
    const rebound = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(resolvePublicAddr("rebound.example", 443, rebound)).rejects.toThrow(
      /private network/i,
    );
  });
});

describe("hostResolvesPrivate", () => {
  it("reports a private literal and treats failed lookups as unknown rather than private", async () => {
    await expect(hostResolvesPrivate("127.0.0.1", 80)).resolves.toBe(true);
    await expect(hostResolvesPrivate("invalid..hostname", 80)).resolves.toBe(false);
  });
});

// Additional direct coverage of `isPublicIp`, exported per this port's
// contract though the Rust source only exercises the equivalent (private)
// `is_public_ip` indirectly through `check_public_http_url`.
describe("isPublicIp direct cases", () => {
  it("classifies IPv4 ranges", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("1.1.1.1")).toBe(true);
    expect(isPublicIp("10.0.0.5")).toBe(false);
    expect(isPublicIp("172.16.0.1")).toBe(false);
    expect(isPublicIp("172.31.255.255")).toBe(false);
    expect(isPublicIp("172.32.0.1")).toBe(true); // just outside 172.16.0.0/12
    expect(isPublicIp("192.168.1.1")).toBe(false);
    expect(isPublicIp("127.0.0.1")).toBe(false);
    expect(isPublicIp("169.254.1.1")).toBe(false);
    expect(isPublicIp("0.0.0.0")).toBe(false);
    expect(isPublicIp("255.255.255.255")).toBe(false);
    expect(isPublicIp("100.64.1.1")).toBe(false);
    expect(isPublicIp("100.63.1.1")).toBe(true);
    expect(isPublicIp("100.128.1.1")).toBe(true);
    expect(isPublicIp("192.0.0.8")).toBe(false);
    expect(isPublicIp("198.18.0.1")).toBe(false);
    expect(isPublicIp("198.17.0.1")).toBe(true);
    expect(isPublicIp("224.0.0.251")).toBe(false);
  });

  it("classifies IPv6 ranges, including IPv4-mapped addresses", () => {
    expect(isPublicIp("::1")).toBe(false);
    expect(isPublicIp("::")).toBe(false);
    expect(isPublicIp("fe80::1")).toBe(false);
    expect(isPublicIp("fc00::1")).toBe(false);
    expect(isPublicIp("fdff::1")).toBe(false);
    expect(isPublicIp("2001:4860:4860::8888")).toBe(true);
    expect(isPublicIp("::ffff:192.168.1.1")).toBe(false);
    expect(isPublicIp("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true);
  });

  it("fails closed (not public) for an unparseable literal, per this module's fail-closed posture", () => {
    // Mirrors `host_resolves_private`'s doctrine one function over: an
    // input this function cannot classify is treated the same as "found
    // nothing public" rather than thrown, so a caller that (should never,
    // but did) hand this a bad string still gets a safe verdict instead of
    // an uncaught exception standing in for a blocked/allowed answer.
    expect(isPublicIp("not-an-ip")).toBe(false);
    expect(isPublicIp("")).toBe(false);
  });
});
