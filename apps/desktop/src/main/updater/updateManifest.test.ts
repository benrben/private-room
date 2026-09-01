import { describe, expect, it } from "vitest";
import {
  DARWIN_AARCH64_TARGET_KEYS,
  ManifestParseError,
  compareSemVer,
  isUpdateAvailable,
  isValidRfc3339,
  macosTargetKeys,
  parseSemVer,
  parseUpdateManifest,
  selectPlatformEntry,
  trimLeadingV,
} from "./updateManifest.js";

/** The live v0.25.0 manifest's shape, with the notes and signature abridged. */
const REAL_SHAPED_MANIFEST = JSON.stringify({
  version: "0.25.0",
  notes: "## What's new\n\n- YouTube downloads\n",
  pub_date: "2026-08-21T21:42:18Z",
  platforms: {
    "darwin-aarch64": {
      signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=",
      url: "https://github.com/benrben/private-room/releases/download/v0.25.0/Arcelle.app.tar.gz",
    },
  },
});

describe("parseUpdateManifest — the shipped shape", () => {
  it("parses the real manifest shape", () => {
    const m = parseUpdateManifest(REAL_SHAPED_MANIFEST);
    expect(m.version).toBe("0.25.0");
    expect(m.pubDate).toBe("2026-08-21T21:42:18Z");
    expect(m.form).toBe("static");
    const entry = selectPlatformEntry(m);
    expect(entry?.url).toContain("Arcelle.app.tar.gz");
    expect(entry?.signature).toBe("dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=");
  });

  it("keeps notes verbatim, including markdown newlines", () => {
    expect(parseUpdateManifest(REAL_SHAPED_MANIFEST).notes).toContain("- YouTube downloads");
  });
});

describe("parseUpdateManifest — version", () => {
  it("accepts the 'name' alias", () => {
    const m = parseUpdateManifest('{"name":"1.2.3","platforms":{}}');
    expect(m.version).toBe("1.2.3");
  });

  it("trims EVERY leading v, matching trim_start_matches('v')", () => {
    expect(trimLeadingV("vv1.2.3")).toBe("1.2.3");
    expect(parseUpdateManifest('{"version":"vv1.2.3","platforms":{}}').version).toBe("1.2.3");
  });

  it("fails the whole manifest on a non-semver version", () => {
    for (const bad of ['"1.2"', '"1.2.3.4"', '"01.2.3"', '"1.2.3-"', '"latest"', "42", "null"]) {
      expect(() => parseUpdateManifest(`{"version":${bad},"platforms":{}}`)).toThrow(ManifestParseError);
    }
  });

  it("requires a version at all", () => {
    expect(() => parseUpdateManifest('{"platforms":{}}')).toThrow(/requires a string 'version'/);
  });
});

describe("parseUpdateManifest — pub_date is a HARD failure", () => {
  it("accepts the release script's format and RFC 3339 variants", () => {
    for (const good of [
      "2026-08-21T21:42:18Z",
      "2026-08-21t21:42:18z",
      "2026-08-21T21:42:18.500Z",
      "2026-08-21T21:42:18+02:00",
      "2024-02-29T00:00:00Z",
    ]) {
      expect(isValidRfc3339(good), good).toBe(true);
    }
  });

  it("rejects shapes and impossible calendar dates alike", () => {
    for (const bad of [
      "2026-08-21 21:42:18Z", // space instead of T
      "2026-08-21", // date only
      "2026-13-01T00:00:00Z", // month 13
      "2026-02-30T00:00:00Z", // Date.parse would silently roll this to Mar 2
      "2023-02-29T00:00:00Z", // not a leap year
      "2026-08-21T24:00:00Z",
      "2026-08-21T00:60:00Z",
      "2026-08-21T00:00:00+24:00",
      "2026-08-21T21:42:18", // no offset
    ]) {
      expect(isValidRfc3339(bad), bad).toBe(false);
    }
  });

  it("a malformed pub_date fails the WHOLE manifest, it is not dropped", () => {
    expect(() =>
      parseUpdateManifest('{"version":"1.0.0","pub_date":"21/08/2026","platforms":{}}'),
    ).toThrow(/pub_date/);
  });

  it("rejects a non-string pub_date instead of silently treating it as absent", () => {
    expect(() => parseUpdateManifest('{"version":"1.0.0","pub_date":42,"platforms":{}}')).toThrow(
      /pub_date/,
    );
  });

  it("an omitted or null pub_date is fine", () => {
    expect(parseUpdateManifest('{"version":"1.0.0","platforms":{}}').pubDate).toBeUndefined();
    expect(parseUpdateManifest('{"version":"1.0.0","pub_date":null,"platforms":{}}').pubDate).toBeUndefined();
  });
});

describe("parseUpdateManifest — Static vs Dynamic", () => {
  it("platforms present ⇒ Static, and top-level url/signature are ignored", () => {
    const m = parseUpdateManifest(
      JSON.stringify({
        version: "1.0.0",
        url: "https://example.test/ignored.tar.gz",
        signature: "ignored",
        platforms: { "darwin-aarch64": { url: "https://example.test/real.tar.gz", signature: "s" } },
      }),
    );
    expect(m.form).toBe("static");
    expect(selectPlatformEntry(m)?.url).toBe("https://example.test/real.tar.gz");
  });

  it("platforms absent ⇒ Dynamic, and BOTH top-level fields become required", () => {
    const m = parseUpdateManifest(
      '{"version":"1.0.0","url":"https://example.test/a.tar.gz","signature":"s"}',
    );
    expect(m.form).toBe("dynamic");
    expect(selectPlatformEntry(m)?.signature).toBe("s");
    expect(() => parseUpdateManifest('{"version":"1.0.0","url":"https://example.test/a"}')).toThrow(
      /`signature` field was not set/,
    );
    expect(() => parseUpdateManifest('{"version":"1.0.0","signature":"s"}')).toThrow(
      /`url` field was not set/,
    );
  });

  it("platforms: null is 'absent' (serde Option), not 'present and wrong'", () => {
    const m = parseUpdateManifest(
      '{"version":"1.0.0","platforms":null,"url":"https://example.test/a","signature":"s"}',
    );
    expect(m.form).toBe("dynamic");
  });

  it("a non-string notes fails, because Rust types it as Option<String>", () => {
    expect(() => parseUpdateManifest('{"version":"1.0.0","notes":42,"platforms":{}}')).toThrow(
      /'notes' must be a string/,
    );
    expect(parseUpdateManifest('{"version":"1.0.0","notes":null,"platforms":{}}').notes).toBeUndefined();
  });

  it("rejects a non-string top-level signature before selecting the manifest form", () => {
    expect(() => parseUpdateManifest('{"version":"1.0.0","signature":42,"platforms":{}}')).toThrow(
      /'signature' must be a string/,
    );
  });

  it("rejects a present platforms value that is not an object", () => {
    expect(() => parseUpdateManifest('{"version":"1.0.0","platforms":[]}')).toThrow(
      /'platforms' must be an object/,
    );
  });

  it("an unparseable url fails, even at the top level of a Static manifest", () => {
    expect(() =>
      parseUpdateManifest('{"version":"1.0.0","url":"not a url","platforms":{}}'),
    ).toThrow(/not a parseable url/);
    expect(() =>
      parseUpdateManifest('{"version":"1.0.0","platforms":{"darwin-aarch64":{"url":"nope","signature":"s"}}}'),
    ).toThrow(/not a parseable url/);
  });

  it("a platform entry missing signature or url fails", () => {
    expect(() =>
      parseUpdateManifest('{"version":"1.0.0","platforms":{"darwin-aarch64":{"url":"https://a.test/x"}}}'),
    ).toThrow(/signature must be a string/);
    expect(() =>
      parseUpdateManifest('{"version":"1.0.0","platforms":{"darwin-aarch64":{"signature":"s"}}}'),
    ).toThrow(/url must be a string/);
  });

  it("ignores unknown fields, so additive manifest fields stay safe", () => {
    const m = parseUpdateManifest(
      '{"version":"1.0.0","futureField":true,"platforms":{"darwin-aarch64":{"url":"https://a.test/x","signature":"s","extra":1}}}',
    );
    expect(selectPlatformEntry(m)?.signature).toBe("s");
  });

  it("rejects non-JSON and non-object bodies", () => {
    expect(() => parseUpdateManifest("<html>404</html>")).toThrow(/not valid JSON/);
    expect(() => parseUpdateManifest("[]")).toThrow(/must be a JSON object/);
    expect(() => parseUpdateManifest("null")).toThrow(/must be a JSON object/);
  });
});

describe("parseUpdateManifest — hostile keys", () => {
  it("a __proto__ platform key does not touch any prototype", () => {
    // On a plain {} this assignment would set the object's PROTOTYPE rather
    // than an own entry. A Map has no such behaviour.
    const m = parseUpdateManifest(
      '{"version":"1.0.0","platforms":{"__proto__":{"url":"https://evil.test/x","signature":"s"}}}',
    );
    expect(m.form === "static" && m.platforms.get("__proto__")?.url).toBe("https://evil.test/x");
    expect(selectPlatformEntry(m)).toBeNull();
    expect(({} as Record<string, unknown>)["url"]).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("a 'constructor' platform key does not resolve to a function", () => {
    const m = parseUpdateManifest(
      '{"version":"1.0.0","platforms":{"constructor":{"url":"https://evil.test/x","signature":"s"}}}',
    );
    expect(selectPlatformEntry(m, ["constructor"])?.url).toBe("https://evil.test/x");
    expect(selectPlatformEntry(m, ["toString"])).toBeNull();
  });

  it("a manifest whose own __proto__ key claims a version is still rejected", () => {
    expect(() => parseUpdateManifest('{"__proto__":{"version":"9.9.9"},"platforms":{}}')).toThrow(
      /requires a string 'version'/,
    );
  });
});

describe("target key selection", () => {
  const manifest = (keys: Record<string, unknown>) =>
    parseUpdateManifest(JSON.stringify({ version: "1.0.0", platforms: keys }));

  it("builds ['darwin-<arch>-app', 'darwin-<arch>'] in that order", () => {
    expect(macosTargetKeys("arm64")).toEqual(["darwin-aarch64-app", "darwin-aarch64"]);
    expect(macosTargetKeys("x64")).toEqual(["darwin-x86_64-app", "darwin-x86_64"]);
    expect(DARWIN_AARCH64_TARGET_KEYS).toEqual(["darwin-aarch64-app", "darwin-aarch64"]);
  });

  it("resolves the plain darwin-aarch64 key the shipped manifest actually carries", () => {
    const m = manifest({ "darwin-aarch64": { url: "https://a.test/plain", signature: "s" } });
    expect(selectPlatformEntry(m)?.url).toBe("https://a.test/plain");
  });

  it("prefers -app when both are present, so adding it is a deliberate act", () => {
    const m = manifest({
      "darwin-aarch64": { url: "https://a.test/plain", signature: "s" },
      "darwin-aarch64-app": { url: "https://a.test/app", signature: "s" },
    });
    expect(selectPlatformEntry(m)?.url).toBe("https://a.test/app");
  });

  it("returns null — not an error — when no key matches", () => {
    // This is the silent-stranding failure mode: dropping darwin-aarch64 from a
    // release means clients see "no update", not an error.
    expect(selectPlatformEntry(manifest({ "linux-x86_64": { url: "https://a.test/x", signature: "s" } }))).toBeNull();
  });

  it("a Dynamic manifest returns its single server-resolved entry", () => {
    const m = parseUpdateManifest('{"version":"1.0.0","url":"https://a.test/d","signature":"s"}');
    expect(selectPlatformEntry(m, ["anything"])?.url).toBe("https://a.test/d");
  });
});

describe("semver comparison", () => {
  it("decides updates by strict greater-than", () => {
    expect(isUpdateAvailable("0.26.0", "0.25.0")).toBe(true);
    expect(isUpdateAvailable("0.25.0", "0.25.0")).toBe(false);
    expect(isUpdateAvailable("0.25.0", "0.26.0")).toBe(false);
    expect(isUpdateAvailable("1.0.0", "0.99.99")).toBe(true);
    expect(isUpdateAvailable("0.25.1", "0.25.0")).toBe(true);
  });

  it("compares numerically, not lexically", () => {
    expect(isUpdateAvailable("0.10.0", "0.9.0")).toBe(true);
    expect(isUpdateAvailable("0.9.0", "0.10.0")).toBe(false);
  });

  it("orders prereleases below their release, per SemVer §11.3", () => {
    expect(isUpdateAvailable("1.0.0-alpha", "0.9.9")).toBe(true);
    expect(isUpdateAvailable("1.0.0-alpha", "1.0.0")).toBe(false);
    expect(isUpdateAvailable("1.0.0", "1.0.0-alpha")).toBe(true);
  });

  it("orders prerelease identifiers per SemVer §11.4", () => {
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 0; i + 1 < order.length; i++) {
      expect(compareSemVer(parseSemVer(order[i]!), parseSemVer(order[i + 1]!)), `${order[i]} < ${order[i + 1]}`).toBe(-1);
    }
    // The inverse proves the shorter RIGHT side takes the higher-precedence
    // branch; both directions matter after the comparator's loop was split.
    expect(compareSemVer(parseSemVer("1.0.0-alpha.1"), parseSemVer("1.0.0-alpha"))).toBe(1);
  });

  it("ignores build metadata", () => {
    expect(compareSemVer(parseSemVer("1.0.0+a"), parseSemVer("1.0.0+b"))).toBe(0);
    expect(isUpdateAvailable("1.0.0+build.9", "1.0.0")).toBe(false);
  });

  it("trims a leading v on both sides", () => {
    expect(isUpdateAvailable("v0.26.0", "v0.25.0")).toBe(true);
  });

  it("throws rather than guessing on a non-semver input", () => {
    expect(() => isUpdateAvailable("0.26", "0.25.0")).toThrow(ManifestParseError);
    expect(() => isUpdateAvailable("0.26.0", "not-a-version")).toThrow(ManifestParseError);
  });
});
