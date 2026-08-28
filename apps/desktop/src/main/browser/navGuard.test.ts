// Port of `an_iframe_going_to_about_blank_cannot_blank_the_page`,
// `app_links_are_not_treated_as_private_address_attempts`,
// `a_named_host_is_re_resolved_after_the_literal_check_lets_it_through` and
// `a_frame_cannot_retitle_a_background_page` in src-tauri/src/browser.rs.

import { describe, expect, it } from "vitest";
import {
  believableFor,
  isAppLinkScheme,
  isRecordableUrl,
  needsHostRecheck,
  portFor,
  sameSite,
  stripWww,
} from "./navGuard.js";

const u = (s: string) => new URL(s);

describe("an_iframe_going_to_about_blank_cannot_blank_the_page", () => {
  it("records real destinations", () => {
    expect(isRecordableUrl(u("https://www.youtube.com/"))).toBe(true);
    expect(isRecordableUrl(u("http://example.com/"))).toBe(true);
  });

  it("never records a frame's own idle state as where a page went", () => {
    // Google and YouTube both create about:blank iframes; recording one as the
    // PAGE's url made `isBlank` true for a page that had loaded perfectly, and
    // the browser area put the start screen back over it.
    for (const idle of ["about:blank", "about:srcdoc", "data:text/html,x"]) {
      expect(isRecordableUrl(u(idle)), `${idle} must never be recorded`).toBe(false);
    }
  });
});

describe("app_links_are_not_treated_as_private_address_attempts", () => {
  it("recognises the ordinary app-handoff schemes", () => {
    for (const scheme of ["mailto", "tel", "sms", "facetime", "facetime-audio", "callto", "webcal"]) {
      expect(isAppLinkScheme(scheme), `${scheme} is an ordinary link`).toBe(true);
      // URL.protocol carries the colon; both spellings must be accepted or the
      // gate would treat every "email us" click as a security incident again.
      expect(isAppLinkScheme(`${scheme}:`)).toBe(true);
    }
  });

  it("keeps the loud path for schemes that are NOT ordinary", () => {
    for (const scheme of ["file", "data", "javascript", "http", "https"]) {
      expect(isAppLinkScheme(scheme), `${scheme} must keep the loud path`).toBe(false);
    }
  });
});

describe("a_named_host_is_re_resolved_after_the_literal_check_lets_it_through", () => {
  it("flags NAMES — the whole point, since one of these may answer 127.0.0.1", () => {
    expect(needsHostRecheck(u("https://example.com/page"))).toBe(true);
    expect(needsHostRecheck(u("http://internal.example/"))).toBe(true);
  });

  it("does not flag IP literals, which the literal check already decided exactly", () => {
    for (const url of [
      "http://8.8.8.8/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://[2606:4700::1111]/",
    ]) {
      expect(needsHostRecheck(u(url)), `${url} is already decided`).toBe(false);
    }
  });

  it("does not flag a non-web destination at all", () => {
    expect(needsHostRecheck(u("about:blank"))).toBe(false);
    expect(needsHostRecheck(u("mailto:a@b.test"))).toBe(false);
  });

  it("resolves the port the way port_or_known_default does", () => {
    expect(portFor(u("https://example.com/"))).toBe(443);
    expect(portFor(u("http://example.com/"))).toBe(80);
    expect(portFor(u("http://example.com:8080/"))).toBe(8080);
  });
});

describe("a_frame_cannot_retitle_a_background_page", () => {
  it("believes a page's own redirects: path, http->https, and the www split", () => {
    expect(sameSite("https://example.com/a", u("https://example.com/b"))).toBe(true);
    expect(sameSite("http://example.com/", u("https://example.com/"))).toBe(true);
    expect(sameSite("https://www.example.com/", u("https://example.com/"))).toBe(true);
  });

  it("refuses a third-party frame — that is not where this page went", () => {
    expect(sameSite("https://example.com/", u("https://ads.example.net/f"))).toBe(false);
    expect(sameSite("https://example.com/", u("https://other.example.com/"))).toBe(false);
  });

  it("believes anything when the record has no host of its own to contradict it", () => {
    expect(sameSite("about:blank", u("https://example.com/"))).toBe(true);
    expect(sameSite("not a url at all", u("https://example.com/"))).toBe(true);
  });

  it("strips a repeated www. prefix, exactly as Rust's trim_start_matches does", () => {
    expect(stripWww("www.www.example.com")).toBe("example.com");
    expect(stripWww("example.com")).toBe("example.com");
    expect(sameSite("https://www.www.example.com/", u("https://example.com/"))).toBe(true);
  });

  it("always believes the SHOWING page's navigation", () => {
    // It self-heals from the info poll's own location.href a moment later.
    expect(believableFor(true, "https://example.com/", u("https://consent.example.net/wall"))).toBe(
      true,
    );
  });

  it("does not let a background page's row be retitled by a stray frame", () => {
    expect(believableFor(false, "https://example.com/", u("https://consent.example.net/wall"))).toBe(
      false,
    );
    expect(believableFor(false, "https://example.com/", u("https://example.com/next"))).toBe(true);
  });

  it("believes a background page's first destination when there is no record yet", () => {
    expect(believableFor(false, null, u("https://example.com/"))).toBe(true);
    expect(believableFor(false, undefined, u("https://example.com/"))).toBe(true);
  });
});
