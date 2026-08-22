/**
 * Coverage of `browseGuard.ts` — port of `browse_guard_url`
 * (`src-tauri/src/commands/browse.rs`). Rust has no dedicated `mod tests` for
 * it (it is exercised through the commands that call it); this file pins the
 * composition directly: the literal check first, a real DNS resolve second.
 *
 * THESE THREE RESOLVE FOR REAL. `resolvePublicAddr` is `dns.lookup`, so the
 * cases below that get past the literal check need working DNS — deliberately,
 * because the whole point of the second half is that it asks the resolver, and
 * a faked resolver would prove only that this file calls a function. The
 * refusal cases never reach the network at all.
 */

import { describe, expect, it } from "vitest";
import { browseGuardUrl } from "./browseGuard.js";

describe("browseGuardUrl", () => {
  it("resolves a real public address and answers it normalized", async () => {
    await expect(browseGuardUrl("https://example.com")).resolves.toBe("https://example.com/");
  });

  it("refuses a literal private address before ever touching DNS", async () => {
    await expect(browseGuardUrl("http://192.168.1.1/")).rejects.toThrow(
      "Local and private-network addresses cannot be fetched.",
    );
    await expect(browseGuardUrl("http://localhost:11434/")).rejects.toThrow(
      "Local and private-network addresses cannot be fetched.",
    );
  });

  it("refuses a non-http(s) scheme and unparseable text", async () => {
    await expect(browseGuardUrl("about:blank")).rejects.toThrow("Only http(s) URLs can be fetched.");
    await expect(browseGuardUrl("file:///etc/passwd")).rejects.toThrow(
      "Only http(s) URLs can be fetched.",
    );
    await expect(browseGuardUrl("not a url")).rejects.toThrow("Invalid URL: not a url");
  });

  it("refuses a hostname that does not resolve at all", async () => {
    await expect(
      browseGuardUrl("https://this-domain-should-not-exist-arcelle-test.invalid/"),
    ).rejects.toThrow(/Could not resolve/);
  });
});
