// Port of src-tauri/src/browser/rules.rs's #[cfg(test)] module, adapted to this
// port's intent-not-regex design (rules.ts's header).
//
// The tests that pinned WebKit's url-filter subset and its digest-keyed compile
// cache have no equivalent here — there is no compiler to reject a pattern and
// no cache key to go stale. The tests that assert the POLICY are ported
// directly, including the guard equivalence in both directions.

import { describe, expect, it } from "vitest";
import { checkPublicHttpUrl } from "./guard.js";
import {
  TRACKER_DOMAINS,
  classifyRequest,
  isPrivateHost,
  isThirdParty,
  isTrackerHost,
  type BlockReason,
  type ClassifyRequestInput,
} from "./rules.js";

function classify(
  url: string,
  resourceType: ClassifyRequestInput["resourceType"] = "xhr",
  topLevelUrl: string | null = "https://top-level.example/",
): BlockReason | null {
  return classifyRequest({ url, resourceType, topLevelUrl });
}

function guardBlocks(url: string): boolean {
  try {
    checkPublicHttpUrl(url);
    return false;
  } catch {
    return true;
  }
}

describe("domain_filter_escapes_dots_and_anchors_the_host", () => {
  it("matches the exact domain and any subdomain of it, never a look-alike", () => {
    expect(isTrackerHost("google-analytics.com")).toBe(true);
    expect(isTrackerHost("www.google-analytics.com")).toBe(true);
    expect(isTrackerHost("sub.www.google-analytics.com")).toBe(true);
    // Dot-anchored suffix, not a bare substring: the leading dot is what stops
    // `notexample.com` matching `example.com`.
    expect(isTrackerHost("notgoogle-analytics.com")).toBe(false);
    expect(isTrackerHost("google-analyticsXcom")).toBe(false);
  });

  it("is case- and trailing-dot-insensitive, like every other host comparison here", () => {
    expect(isTrackerHost("DoubleClick.NET")).toBe(true);
    expect(isTrackerHost("doubleclick.net.")).toBe(true);
  });
});

describe("rules_are_a_plausible_size_and_every_tracker_domain_is_present", () => {
  it("carries a non-trivial, bounded, duplicate-free list", () => {
    expect(TRACKER_DOMAINS.length).toBeGreaterThan(50);
    expect(TRACKER_DOMAINS.length).toBeLessThan(1000);
    expect(new Set(TRACKER_DOMAINS).size).toBe(TRACKER_DOMAINS.length);
  });

  it("recognises every listed domain", () => {
    for (const domain of TRACKER_DOMAINS) {
      expect(isTrackerHost(domain), domain).toBe(true);
    }
  });
});

describe("private_filters_match_exactly_the_hosts_the_guard_rejects", () => {
  // IP literals and the two known local names only — see the divergence test
  // below for the one case deliberately outside this equivalence.
  const addresses = [
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
    // Public neighbours of every blocked range — these must stay reachable, or
    // the blocker starts breaking the real web.
    "https://example.com/page",
    "http://8.8.8.8/",
    "http://11.0.0.1/",
    "http://100.63.1.1/",
    "http://100.128.1.1/",
    "http://198.17.0.1/",
    "http://223.255.255.255/",
  ];

  it("agrees with checkPublicHttpUrl in BOTH directions, for every address", () => {
    // The two layers are one policy at two layers and must agree. Here that is
    // a property of sharing `isPublicIp`, not of two hand-maintained lists.
    for (const url of addresses) {
      const blocked = guardBlocks(url);
      expect(isPrivateHost(new URL(url).hostname), `${url}: guard blocks=${blocked}`).toBe(blocked);
      expect(classify(url, "image", "https://news.example/") !== null, url).toBe(blocked);
    }
  });

  it("closes the trailing-dot hole the Rust regex left open", () => {
    // `localhost.` is the DNS ROOT LABEL spelling and resolves exactly like
    // `localhost` — but `^https?://localhost[:/]` does not match it. guard.ts
    // records closing the same hole on the navigation side; the two layers stay
    // in step only if this one closes it too.
    expect(guardBlocks("http://localhost.:11434/")).toBe(true);
    expect(isPrivateHost("localhost.")).toBe(true);
    expect(isPrivateHost("printer.local.")).toBe(true);
    expect(classify("http://localhost.:11434/api/delete", "xhr", null)).toBe("private-network");
  });

  it("DIVERGES on purpose for a hostname that merely LOOKS like a private prefix", () => {
    // rules.rs matches URL text, so `^https?://10\.` also blocks the NAME
    // `10.example.com`; its own comment accepts that as a side effect of having
    // no way to ask "is this an IP literal". Classifying the parsed host does
    // not reproduce it — and that is what lets this layer agree with
    // `checkPublicHttpUrl`, which lets the same name through, in both
    // directions instead of only one.
    expect(guardBlocks("http://10.example.com/")).toBe(false);
    expect(isPrivateHost("10.example.com")).toBe(false);
    expect(classify("http://10.example.com/pixel.gif", "image", "https://news.example/")).toBeNull();
  });
});

describe("private_ranges_all_reach_the_compiled_list_and_come_first", () => {
  it("blocks a private-network sub-resource even on the page's OWN first-party host", () => {
    // The private-range rules carry no third-party restriction: a page
    // navigating ITSELF to localhost is exactly the attack.
    expect(classify("http://127.0.0.1/x", "xhr", "http://127.0.0.1/")).toBe("private-network");
  });

  it("blocks a private-network MAIN FRAME navigation too", () => {
    // Defense in depth behind the navigation gate, which also refuses it.
    expect(classify("http://127.0.0.1/x", "mainFrame", null)).toBe("private-network");
  });

  it("beats the tracker rules — a private host is reported as the private one", () => {
    expect(classify("http://127.0.0.1/doubleclick.net", "image", null)).toBe("private-network");
  });
});

describe("websocket_urls_to_private_hosts_are_blocked_and_public_ones_are_not", () => {
  it("blocks a private-network WebSocket, which no navigation hook ever sees", () => {
    // Script with no rule here can open ws://127.0.0.1:PORT/ against every port
    // on this Mac and time the failures to enumerate what is listening.
    for (const url of [
      "ws://127.0.0.1:11434/",
      "wss://127.0.0.1:8443/socket",
      "ws://localhost:6379/",
      "ws://[::1]:9229/",
      "ws://192.168.1.1/ws",
      "wss://printer.local/stream",
      "ws://169.254.169.254/",
    ]) {
      expect(classify(url, "webSocket", null), `${url} must be blocked`).toBe("private-network");
    }
  });

  it("still connects a public WebSocket", () => {
    for (const url of ["wss://example.com/socket", "ws://8.8.8.8/", "wss://chat.example.com:443/ws"]) {
      expect(classify(url, "webSocket", null), `${url} must still connect`).toBeNull();
    }
  });

  it("does not apply the TRACKER rules over ws(s), matching domain_filters' ^https?:// anchor", () => {
    expect(classify("wss://doubleclick.net/socket", "webSocket", "https://news.example/")).toBeNull();
  });
});

describe("tracker rules only ever apply to THIRD-PARTY loads", () => {
  it("blocks a tracker domain embedded as a third-party resource", () => {
    expect(classify("https://doubleclick.net/pixel.gif", "image", "https://news.example/article")).toBe(
      "tracker",
    );
  });

  it("does not block a tracker's own first-party resources", () => {
    expect(classify("https://doubleclick.net/pixel.gif", "image", "https://doubleclick.net/")).toBeNull();
    expect(classify("https://doubleclick.net/px", "image", "https://www.doubleclick.net/")).toBeNull();
  });

  it("never blocks a mainFrame load of a tracker's own site", () => {
    // Typing a tracker's domain into the address bar must not be refused by an
    // ad rule meant for OTHER pages embedding it — and a live probe showed the
    // frame tree reports an EMPTY top URL for exactly this request, so without
    // the mainFrame exemption every such navigation would be cancelled.
    expect(classify("https://doubleclick.net/", "mainFrame", null)).toBeNull();
    expect(classify("https://doubleclick.net/", "mainFrame", "")).toBeNull();
    expect(classify("https://doubleclick.net/", "mainFrame", "https://news.example/")).toBeNull();
  });

  it("treats an unknown top-level URL as third-party, so blocking does not go quiet", () => {
    expect(isThirdParty("doubleclick.net", null)).toBe(true);
    expect(isThirdParty("doubleclick.net", "")).toBe(true);
    expect(isThirdParty("doubleclick.net", "not a url")).toBe(true);
    expect(classify("https://doubleclick.net/pixel.gif", "image", null)).toBe("tracker");
  });

  it("uses same_site's own comparison — www. is not a different party", () => {
    expect(isThirdParty("example.com", "https://www.example.com/")).toBe(false);
    expect(isThirdParty("www.example.com", "https://example.com/")).toBe(false);
    expect(isThirdParty("ads.example.net", "https://example.com/")).toBe(true);
  });
});

describe("classifyRequest ignores what it was never meant to see", () => {
  it("leaves non-network schemes alone", () => {
    expect(classify("data:text/plain,hello", "image", null)).toBeNull();
    expect(classify("blob:https://example.com/abc-123", "image", null)).toBeNull();
    expect(classify("file:///etc/passwd", "image", null)).toBeNull();
  });

  it("does not throw on garbage input", () => {
    expect(classify("not a url", "xhr", null)).toBeNull();
    expect(classify("", "xhr", null)).toBeNull();
  });

  it("does not block an ordinary public request", () => {
    expect(classify("https://example.com/style.css", "stylesheet", "https://example.com/")).toBeNull();
    expect(classify("https://cdn.example.net/x.js", "script", "https://example.com/")).toBeNull();
  });
});
