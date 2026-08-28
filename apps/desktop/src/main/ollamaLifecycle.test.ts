/**
 * Vitest port of `src-tauri/src/ollama_lifecycle.rs`'s `host_of`/
 * `base_is_local` pair — including the two "looks local but isn't" traps
 * `host_of`'s own doc comment calls out by name, and the third one this port
 * closes (see `isLoopbackIpv4` in the module under test).
 */

import { describe, expect, it } from "vitest";
import { baseIsLocal, hostOf } from "./ollamaLifecycle.js";

describe("hostOf", () => {
  it("strips scheme, port, path and credentials", () => {
    expect(hostOf("http://127.0.0.1:11434")).toBe("127.0.0.1");
    expect(hostOf("https://user:pw@example.com:8080/v1/models")).toBe("example.com");
    expect(hostOf("localhost:11434")).toBe("localhost");
    expect(hostOf("LOCALHOST")).toBe("localhost");
  });

  it("unbrackets an IPv6 literal", () => {
    expect(hostOf("http://[::1]:11434")).toBe("::1");
    expect(hostOf("[::]:11434")).toBe("::");
  });

  it("a bare host with no scheme still resolves", () => {
    expect(hostOf("192.168.1.20:11434")).toBe("192.168.1.20");
  });

  it("the LAST @ delimits the credentials, so a host smuggled into userinfo does not win", () => {
    expect(hostOf("http://127.0.0.1@evil.test:11434")).toBe("evil.test");
    expect(hostOf("http://user@evil.test@127.0.0.1:11434")).toBe("127.0.0.1");
  });

  it("folds ASCII case only — Rust's to_ascii_lowercase, not toLowerCase", () => {
    // U+212A KELVIN SIGN lowercases to ASCII "k" under full Unicode folding.
    // The Rust predicate this guards folds A-Z and nothing else, and this
    // string is about to decide whether room content may leave unredacted.
    expect(hostOf("http://Kelvin.test:11434")).toBe("Kelvin.test");
  });
});

describe("baseIsLocal", () => {
  it("every loopback spelling is local", () => {
    for (const base of [
      "http://127.0.0.1:11434",
      "http://127.5.5.5:11434",
      "http://127.0.0.1:1",
      "http://127.1:11434", // inet_aton shorthand — a real, reachable loopback
      "http://127.0.1:11434",
      "http://localhost:11434",
      "http://LOCALHOST:11434",
      "https://LOCALHOST:11434",
      "http://0.0.0.0:11434",
      "http://[::1]:11434",
      "http://[::]:11434",
    ]) {
      expect(baseIsLocal(base), base).toBe(true);
    }
  });

  // THE TRAP `host_of`'s own doc names: a substring match on the whole URL
  // would call both of these "local" because they CONTAIN a loopback spelling,
  // while neither actually names this machine.
  it("a hostname that merely CONTAINS a loopback spelling is not local", () => {
    expect(baseIsLocal("http://localhost-box.lan:11434")).toBe(false);
    expect(baseIsLocal("http://ollama.127.0.0.1.nip.io:11434")).toBe(false);
  });

  /**
   * The same trap at the other end of the name, which the Rust source's
   * `host.starts_with("127.")` does NOT catch: a hostname that BEGINS with a
   * loopback spelling belongs to whoever registered the domain. A "local"
   * verdict means the door attaches no policy at all, so this is the difference
   * between a redacted request and whole documents in the clear.
   */
  it("a hostname that merely BEGINS with a loopback spelling is not local either", () => {
    expect(baseIsLocal("http://127.0.0.1.evil.test:11434")).toBe(false);
    expect(baseIsLocal("http://127.0.0.1.nip.io.evil.test:11434")).toBe(false);
    expect(baseIsLocal("http://127x.evil.test:11434")).toBe(false);
    expect(baseIsLocal("http://localhost.evil.test:11434")).toBe(false);
  });

  it("a LAN box (the Closet override) is not local", () => {
    expect(baseIsLocal("http://192.168.1.20:11434")).toBe(false);
    expect(baseIsLocal("http://my-ollama-box.local:11434")).toBe(false);
    expect(baseIsLocal("https://api.example.com")).toBe(false);
  });
});
