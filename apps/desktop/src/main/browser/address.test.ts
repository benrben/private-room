/**
 * Port of `src-tauri/src/commands/browse/address.rs`'s `#[cfg(test)] mod
 * tests`, case for case. Rust's own doc comment calls this table the contract
 * that both halves of the rule (Rust's and the frontend's) are held to, so it
 * is copied rather than paraphrased.
 */

import { describe, expect, it } from "vitest";
import { classify, type Address } from "./address.js";

function url(u: string): Address {
  return { kind: "url", url: u };
}
function search(q: string): Address {
  return { kind: "search", query: q };
}

describe("classify", () => {
  it("empty input does nothing", () => {
    expect(classify("")).toBeNull();
    expect(classify("   ")).toBeNull();
  });

  /** Before this existed the agent got `Invalid URL: https://best pizza nyc`. */
  it("anything with a space is a search", () => {
    expect(classify("best pizza nyc")).toEqual(search("best pizza nyc"));
    expect(classify("speaker diarization benchmarks")).toEqual(
      search("speaker diarization benchmarks"),
    );
  });

  it("a bare word is a search, not a hostname guess", () => {
    expect(classify("weather")).toEqual(search("weather"));
  });

  it("non-latin queries search", () => {
    expect(classify("בנק ישראל")).toEqual(search("בנק ישראל"));
  });

  it("an explicit scheme is always a url, verbatim", () => {
    expect(classify("https://example.com/x?y=1")).toEqual(url("https://example.com/x?y=1"));
    expect(classify("http://localhost:3000")).toEqual(url("http://localhost:3000"));
    // VERBATIM means the characters, not just the shape: a path, query or
    // fragment is case-sensitive on the far side, and normalizing here would
    // send the user somewhere they did not ask for. (The guard normalizes the
    // HOST later, on its own terms; this rule hands the text through
    // untouched.)
    expect(classify("HTTPS://Example.COM/Path?Q=Value#Frag")).toEqual(
      url("HTTPS://Example.COM/Path?Q=Value#Frag"),
    );
    // …including text a bare-host guess would have mangled: a scheme wins over
    // every rule below it, spaces included.
    expect(classify("https://example.com/a b")).toEqual(url("https://example.com/a b"));
  });

  it("host-shaped text navigates with https filled in", () => {
    expect(classify("example.com")).toEqual(url("https://example.com"));
    expect(classify("x.co/path")).toEqual(url("https://x.co/path"));
    expect(classify("en.wikipedia.org/wiki/Diarisation")).toEqual(
      url("https://en.wikipedia.org/wiki/Diarisation"),
    );
  });

  /** Classifying is not permitting: these reach `browseGuardUrl`, which is
   * what actually refuses private addresses with an honest message. */
  it("host:port and IP literals navigate", () => {
    expect(classify("localhost:3000")).toEqual(url("https://localhost:3000"));
    expect(classify("192.168.1.1")).toEqual(url("https://192.168.1.1"));
  });

  it("a question mark forces a search for host-shaped text", () => {
    expect(classify("?example.com")).toEqual(search("example.com"));
    expect(classify("?")).toBeNull();
    expect(classify("?   ")).toBeNull();
  });

  it("a trailing slash keeps host-shaped text a url", () => {
    expect(classify("arcelle.app/")).toEqual(url("https://arcelle.app/"));
  });

  /** The space rule fires before the host rule, which is what keeps "who wrote
   * hamlet.txt" from becoming a navigation. */
  it("a sentence with a dot in it is still a search", () => {
    expect(classify("who wrote hamlet.txt")).toEqual(search("who wrote hamlet.txt"));
  });

  /** "node.js" is a topic, not a host: the TLD rule needs 2+ characters. */
  it("a single-label dotted token with a one-char tld is a search", () => {
    expect(classify("node.j")).toEqual(search("node.j"));
  });

  it("trims surrounding whitespace before deciding, and keeps the trimmed text", () => {
    expect(classify("  example.com  ")).toEqual(url("https://example.com"));
    expect(classify("\tbest pizza nyc\n")).toEqual(search("best pizza nyc"));
  });

  /** The dotted-quad rule counts parts and digits rather than pattern-matching
   * the whole string, so a three- or five-part number is a topic and reaches
   * the engines instead of becoming `https://1.2.3.4.5`.
   *
   * `1.2.3.4444` is deliberately the other way: the IP rule rejects it (the
   * last group is four digits) and the HOST rule then accepts it, because
   * `4444` is a last label of two characters or more — exactly what Rust does,
   * and the guard is what refuses it afterwards if it goes nowhere. */
  it("counts the parts of a dotted quad rather than pattern-matching it", () => {
    expect(classify("1.2.3.4")).toEqual(url("https://1.2.3.4"));
    expect(classify("1.2.3.4:8080")).toEqual(url("https://1.2.3.4:8080"));
    expect(classify("1.2.3.4.5")).toEqual(search("1.2.3.4.5"));
    expect(classify("1.2.3")).toEqual(search("1.2.3"));
    expect(classify("1.2.3.4444")).toEqual(url("https://1.2.3.4444"));
  });
});
