/**
 * Vitest port of `src-tauri/src/commands/privacy.rs`'s `#[cfg(test)] mod
 * tests` — the redactor-only subset (the policy-cache/seam/command/scan-runner
 * half is in `privacy.test.ts`, the DB layer in `db-host/privacy.test.ts`):
 *
 *   - redact_longest_first_case_insensitive_counted
 *   - substring_matching_over_redacts_but_never_leaks
 *   - restore_roundtrip_with_case_drift
 *   - hebrew_exact_match_redacts
 *   - restore_value_walks_json
 *   - redact_value_masks_outbound_connector_args
 *   - accented_names_are_hidden_whatever_the_capitalisation
 *   - a_one_character_block_item_is_refused_not_silently_dropped
 *
 * PLUS the adversarial cases the Rust suite does not separately name:
 * leftmost-vs-longest resolution in both directions, insertion-order
 * independence, prefix collisions on the RESTORE table, Unicode normalization
 * (NFC/NFD do not cross-match — parity with byte-exact `aho-corasick`, not a
 * bug), a caseless script needing no case variant, and the `__proto__`
 * round-trip through `redactValue`/`restoreValue`.
 */

import { describe, expect, it } from "vitest";
import {
  emptyPrivacyReport,
  isProtectable,
  MIN_PROTECTED_CHARS,
  Redactor,
  type PrivacyRule,
} from "./privacyRedact.js";

/** The Rust test module's own `redactor()` fixture. */
function redactor(): Redactor {
  return new Redactor([
    ["Ben Reich", "[Person A]"],
    ["Ben", "[Person B]"],
    ["12 Herzl St", "[Address A]"],
  ]);
}

describe("Redactor.redact", () => {
  it("redact_longest_first_case_insensitive_counted", () => {
    const r = redactor();
    const report = emptyPrivacyReport();
    const out = r.redact("BEN REICH lives at 12 herzl st. Ben was here.", report);
    expect(out).toBe("[Person A] lives at [Address A]. [Person B] was here.");
    expect(report.replacements).toBe(3);
    expect(report.entitiesHidden).toBe(3);
  });

  /**
   * AUDIT (deliberately NOT "fixed"), ported verbatim: substring matching
   * over-redacts — "benchmark" comes out mangled when "Ben" is protected. What
   * this test actually guards is the other half: the two cases a word-boundary
   * "fix" would silently start LEAKING. If someone makes the first assertion
   * pass, the last two must still pass.
   */
  it("substring_matching_over_redacts_but_never_leaks", () => {
    const r = new Redactor([
      ["Ben Reich", "[Person A]"],
      ["Ben", "[Person B]"],
      ["5551234", "[Phone A]"],
    ]);
    const report = emptyPrivacyReport();
    expect(r.redact("the benchmark ran", report)).toBe("the [Person B]chmark ran");

    const report2 = emptyPrivacyReport();
    const out2 = r.redact("call +9725551234 now", report2);
    expect(out2.includes("5551234"), `a protected number leaked: ${out2}`).toBe(false);

    const report3 = emptyPrivacyReport();
    const out3 = r.redact("from BenReich@example.com", report3);
    expect(out3.toLowerCase().includes("ben"), `a protected name leaked unspaced: ${out3}`).toBe(false);
  });

  it("hebrew_exact_match_redacts", () => {
    const r = new Redactor([["בן רייך", "[Person A]"]]);
    const report = emptyPrivacyReport();
    expect(r.redact("החוזה של בן רייך", report)).toBe("החוזה של [Person A]");
  });

  it("accented_names_are_hidden_whatever_the_capitalisation", () => {
    // The two halves of the door folded case differently: `ascii_case_insensitive`
    // folds A-Z only, while the sidecar's `re.I` folds every script — so this
    // side (the "what the cloud sees" preview and the outbound connector
    // masking) let a differently-cased accented or Hebrew name through.
    const r = new Redactor([
      ["José Muñoz", "[Person A]"],
      ["Ürün", "[Org A]"],
    ]);
    const report = emptyPrivacyReport();
    const out = r.redact("JOSÉ MUÑOZ and josé muñoz both work at ÜRÜN", report);
    expect(out.includes("MUÑOZ"), out).toBe(false);
    expect(out.includes("muñoz"), out).toBe(false);
    expect(out.includes("ÜRÜN"), out).toBe(false);
    expect(out).toBe("[Person A] and [Person A] both work at [Org A]");
    // Two distinct entities hidden, not four patterns.
    expect(report.entitiesHidden).toBe(2);
    expect(report.replacements).toBe(3);
    // A placeholder still restores to the room's OWN spelling, not a variant.
    expect(r.restore("[Person A]")).toBe("José Muñoz");
  });

  it("a caseless script (Hebrew) adds no case variant and still counts one entity", () => {
    const r = new Redactor([["ירושלים", "[City A]"]]);
    const report = emptyPrivacyReport();
    expect(r.redact("גר בירושלים כעת", report)).toBe("גר ב[City A] כעת");
    expect(report.entitiesHidden).toBe(1);
    expect(report.replacements).toBe(1);
  });
});

describe("Redactor.stream", () => {
  it("redacts a longest protected value split across arbitrary deltas", () => {
    const report = emptyPrivacyReport();
    const stream = redactor().stream(report);
    const visible = [
      stream.feed("Call BEN "),
      stream.feed("RE"),
      stream.feed("ICH at 12 her"),
      stream.feed("zl st today."),
      stream.flush(),
    ].join("");

    expect(visible).toBe("Call [Person A] at [Address A] today.");
    expect(visible.toLowerCase()).not.toContain("ben");
    expect(visible.toLowerCase()).not.toContain("herzl");
    expect(report).toEqual({ entitiesHidden: 2, replacements: 2, imagesBlocked: 0 });
  });

  it("reset drops the undecidable suffix from a replaced model round", () => {
    const stream = redactor().stream(emptyPrivacyReport());
    expect(stream.feed("Ben Re")).toBe("");
    stream.reset();
    const visible = stream.feed("final plain answer") + stream.flush();
    expect(visible).toBe("final plain answer");
    expect(visible).not.toContain("Ben Re");
  });
});

describe("leftmost-longest, non-overlapping", () => {
  it("a shorter rule that PREFIXES a longer one never wins", () => {
    const r = new Redactor([
      ["Ben", "[Person B]"],
      ["Ben Reich", "[Person A]"],
    ]);
    const report = emptyPrivacyReport();
    expect(r.redact("Ben Reich signed the lease", report)).toBe("[Person A] signed the lease");
    expect(report.entitiesHidden).toBe(1);
  });

  it("longest wins at the same start REGARDLESS of insertion order", () => {
    for (const rules of [
      [
        ["ab", "[SHORT]"],
        ["abcdef", "[LONG]"],
      ],
      [
        ["abcdef", "[LONG]"],
        ["ab", "[SHORT]"],
      ],
    ] as PrivacyRule[][]) {
      const report = emptyPrivacyReport();
      expect(new Redactor(rules).redact("abcdef", report)).toBe("[LONG]");
      expect(report.replacements).toBe(1);
    }
  });

  it("the leftmost START wins, and the search resumes after the match it took", () => {
    // "abc" starts at index 1 and is consumed whole; "bcd" starts INSIDE it, so
    // it never gets a chance — leftmost, then non-overlapping continuation,
    // exactly like `find_iter`.
    const r = new Redactor([
      ["abc", "[X]"],
      ["bcd", "[Y]"],
    ]);
    const report = emptyPrivacyReport();
    expect(r.redact("xabcdx", report)).toBe("x[X]dx");
    expect(report.replacements).toBe(1);
  });

  it("overlapping rules leave no dangling fragment and are not double-counted", () => {
    const r = new Redactor([
      ["Reich family", "[Family A]"],
      ["Ben Reich", "[Person A]"],
    ]);
    const report = emptyPrivacyReport();
    expect(r.redact("Ben Reich family lives here", report)).toBe("[Person A] family lives here");
    expect(report.replacements).toBe(1);
  });

  it("an NFC and an NFD spelling of the same accent do not cross-match (byte-exact, matching Rust)", () => {
    const name = "Renée";
    const nfc = name.normalize("NFC"); // precomposed é, one code point
    const nfd = name.normalize("NFD"); // "e" + combining acute, two code points
    expect(nfc).not.toBe(nfd);
    const r = new Redactor([[nfc, "[Person A]"]]);

    const reportNfc = emptyPrivacyReport();
    expect(r.redact(`met ${nfc} today`, reportNfc)).toBe("met [Person A] today");
    expect(reportNfc.replacements).toBe(1);

    // The NFD spelling is a different sequence of code points. Rust's byte-exact
    // matcher would not match it either, and this module deliberately does not
    // normalize text nobody asked it to normalize.
    const reportNfd = emptyPrivacyReport();
    expect(r.redact(`met ${nfd} today`, reportNfd)).toBe(`met ${nfd} today`);
    expect(reportNfd.replacements).toBe(0);
  });

  it("an astral character (outside the BMP) matches whole, never half a surrogate pair", () => {
    // The matcher indexes UTF-16 code units; a pattern and its haystack are
    // walked the same way, so a 4-byte character is simply two units on both
    // sides — and a lone half can never open a match.
    const r = new Redactor([["Ben 🎯 Reich", "[Person A]"]]);
    const report = emptyPrivacyReport();
    expect(r.redact("from Ben 🎯 Reich today", report)).toBe("from [Person A] today");
    const report2 = emptyPrivacyReport();
    expect(r.redact("from 🎯 alone", report2)).toBe("from 🎯 alone");
  });
});

describe("Redactor.restore", () => {
  it("restore_roundtrip_with_case_drift", () => {
    const r = redactor();
    expect(r.restore("[person a] met [Person B]")).toBe("Ben Reich met Ben");
  });

  it("restore_value_walks_json", () => {
    const r = redactor();
    const v = { q: "[Person A]", n: 3, list: ["[Address A]"] };
    const restored = r.restoreValue(v) as { q: string; n: number; list: string[] };
    expect(restored.q).toBe("Ben Reich");
    expect(restored.list[0]).toBe("12 Herzl St");
    expect(restored.n).toBe(3);
  });

  it("a placeholder whose text prefixes another's still restores exactly", () => {
    const r = new Redactor([
      ["Ben Reich", "[Person A]"],
      ["Dana Levi", "[Person AB]"],
    ]);
    expect(r.restore("[Person A] met [Person AB]")).toBe("Ben Reich met Dana Levi");
  });
});

describe("Redactor.redactValue", () => {
  // PRIV: the outbound remote-connector seam masks real entities in a tool
  // call's args (real -> placeholder) before they leave, walking nested JSON and
  // leaving non-strings untouched. Round-trips with restoreValue.
  it("redact_value_masks_outbound_connector_args", () => {
    const r = redactor();
    const args = {
      query: "email from Ben Reich about 12 Herzl St",
      limit: 5,
      tags: ["Ben", "urgent"],
    };
    const report = emptyPrivacyReport();
    const sent = r.redactValue(args, report) as { query: string; tags: string[]; limit: number };
    expect(sent.query).toBe("email from [Person A] about [Address A]");
    expect(sent.tags[0]).toBe("[Person B]");
    expect(sent.tags[1]).toBe("urgent");
    expect(sent.limit).toBe(5);
    expect(report.replacements).toBeGreaterThanOrEqual(3);
    // What leaves carries no real name/address.
    const leaving = JSON.stringify(sent);
    expect(leaving.includes("Ben Reich")).toBe(false);
    expect(leaving.includes("12 Herzl St")).toBe(false);
    // And the placeholders restore on the way back.
    expect((r.restoreValue(sent) as { query: string }).query).toBe("email from Ben Reich about 12 Herzl St");
  });

  it("leaves null, booleans and nested numbers exactly as they were", () => {
    const r = redactor();
    const report = emptyPrivacyReport();
    const out = r.redactValue({ a: null, b: true, c: [1, 2.5, false, null] }, report);
    expect(out).toEqual({ a: null, b: true, c: [1, 2.5, false, null] });
    expect(report.replacements).toBe(0);
  });

  /**
   * The MCP marketplace batch found a real prototype-pollution bug in adjacent
   * code (a naive `map[name] = value` on a plain object, which invokes
   * `Object.prototype`'s `__proto__` SETTER, stores nothing, and drops the
   * key). This engine's redact/restore round-trip is exactly the same shape —
   * walk untrusted JSON, rebuild objects — over exactly the untrusted input the
   * door exists for, so it gets the same suspicion.
   */
  it("a __proto__ key survives the round trip as data, and pollutes nothing", () => {
    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "safe": "Ben Reich"}') as Record<
      string,
      unknown
    >;
    // Sanity: JSON.parse itself defines it as an ordinary own property, so the
    // attack surface is specifically how this engine REBUILDS the object.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(malicious, "__proto__")).toBe(true);

    const r = redactor();
    const report = emptyPrivacyReport();
    const redacted = r.redactValue(malicious, report) as Record<string, unknown>;

    expect(({} as Record<string, unknown>).polluted, "Object.prototype must be untouched").toBeUndefined();
    // The key survived as an ordinary readable OWN property — not silently
    // dropped, and not smuggled into the rebuilt object's prototype slot.
    expect(Object.prototype.hasOwnProperty.call(redacted, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(redacted))["__proto__"]).toEqual({ polluted: true });
    // …and the genuinely protected string still redacted alongside it.
    expect(redacted.safe).toBe("[Person A]");

    const restored = r.restoreValue(malicious) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(restored, "__proto__")).toBe(true);
  });

  it("every string leaf under a __proto__-bearing structure is still redacted", () => {
    const malicious = JSON.parse(
      '{"__proto__": {"names": ["Ben Reich", "12 Herzl St"]}, "list": [{"__proto__": "Ben"}]}'
    ) as Record<string, unknown>;
    const r = redactor();
    const report = emptyPrivacyReport();
    const out = r.redactValue(malicious, report) as Record<string, unknown>;
    const nested = out["__proto__"] as Record<string, unknown>;
    expect(nested.names).toEqual(["[Person A]", "[Address A]"]);
    const list = out.list as Array<Record<string, unknown>>;
    expect(list[0]!["__proto__"]).toBe("[Person B]");
    expect(({} as Record<string, unknown>).names).toBeUndefined();
    // Nothing real leaves, which is the whole point of the seam.
    expect(JSON.stringify(out).includes("Ben Reich")).toBe(false);
  });

  it("a constructor/toString key is data here too, not a lookup into Object.prototype", () => {
    const args = JSON.parse('{"constructor": "Ben Reich", "toString": "Ben"}') as Record<string, unknown>;
    const r = redactor();
    const report = emptyPrivacyReport();
    const out = r.redactValue(args, report) as Record<string, unknown>;
    expect(out.constructor).toBe("[Person A]");
    expect(out.toString).toBe("[Person B]");
  });
});

describe("a protected entity whose TEXT is an Object.prototype member name", () => {
  // The cases below the `redactValue` ones above cover the OTHER half of the
  // same suspicion. Those pin `__proto__` as a KEY of the untrusted JSON being
  // walked; these pin it as the PATTERN — a room may protect any string, and a
  // person really can be listed under `constructor`, an ID under `toString`.
  // Every table this engine builds (the trie's children, the terminal
  // replacements, the `seen` set that counts distinct entities) is therefore
  // keyed by attacker-influenceable text, and a plain object anywhere among
  // them would resolve these names against `Object.prototype` instead: the
  // rule would silently never match, and the name would leave in the clear.
  const POISON = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "prototype"];

  it("redacts, counts and restores each of them as ordinary text", () => {
    for (const name of POISON) {
      const r = new Redactor([[name, "[Private A]"]]);
      expect(r.isEmpty(), `${name}: the rule must survive the floor`).toBe(false);
      const report = emptyPrivacyReport();
      expect(r.redact(`the ${name} field`, report)).toBe("the [Private A] field");
      expect(report.replacements).toBe(1);
      expect(report.entitiesHidden).toBe(1);
      expect(r.restore("[Private A] here")).toBe(`${name} here`);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("all of them at once, many occurrences each, with no cross-talk between rules", () => {
    const rules: PrivacyRule[] = POISON.map((n, i) => [n, `[Private ${i}]`] as const);
    const r = new Redactor(rules);
    const report = emptyPrivacyReport();
    const text = [...POISON, ...POISON].join(" ");
    const out = r.redact(text, report);
    for (const n of POISON) {
      expect(out.includes(n), `${n} leaked: ${out}`).toBe(false);
    }
    expect(report.replacements).toBe(POISON.length * 2);
    expect(report.entitiesHidden, "each name is ONE entity, seen twice").toBe(POISON.length);
    expect(r.restore(out)).toBe(text);
  });

  it("a PLACEHOLDER with one of those names round-trips too", () => {
    const r = new Redactor([["Ben Reich", "__proto__"]]);
    const report = emptyPrivacyReport();
    expect(r.redact("from Ben Reich", report)).toBe("from __proto__");
    expect(r.restore("from __proto__")).toBe("from Ben Reich");
  });
});

/**
 * The named cases above pin the behaviours the Rust suite names. This pins the
 * SEMANTICS whole, against an independent implementation: a brute-force
 * leftmost-longest scanner with no trie in it — for every position, the longest
 * pattern in the (already case-widened) list that starts there, `String.prototype
 * .startsWith` and nothing cleverer. It is the only check in this file that
 * would catch a trie whose tie-breaking, ASCII folding or resume-point is subtly
 * wrong in a shape nobody thought to write a case for, which is exactly the risk
 * of hand-rolling a matcher in place of `aho-corasick`.
 */
describe("the trie agrees with a brute-force leftmost-longest oracle", () => {
  function oracle(rules: readonly PrivacyRule[], text: string): { out: string; reps: number; ents: number } {
    const ascii = (s: string) => [...s].every((c) => c.charCodeAt(0) <= 0x7f);
    const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const pats: Array<[string, string]> = [];
    for (const [real, ph] of rules) {
      if ([...real.trim()].length < MIN_PROTECTED_CHARS || ph.trim() === "") continue;
      pats.push([fold(real), ph]);
      if (!ascii(real)) {
        for (const v of [real.toLowerCase(), real.toUpperCase()]) {
          if (v !== real) pats.push([fold(v), ph]);
        }
      }
    }
    const folded = fold(text);
    let out = "";
    let i = 0;
    let reps = 0;
    const seen = new Set<string>();
    while (i < text.length) {
      let bestLen = 0;
      let best: string | null = null;
      for (const [p, ph] of pats) {
        if (p.length > bestLen && folded.startsWith(p, i)) {
          bestLen = p.length;
          best = ph;
        }
      }
      if (best === null) {
        out += text[i];
        i += 1;
        continue;
      }
      out += best;
      reps += 1;
      seen.add(best);
      i += bestLen;
    }
    return { out, reps, ents: seen.size };
  }

  it("on 4000 generated rule sets and haystacks, output and both counters agree", () => {
    // Deliberately drawn from an alphabet where every property this module
    // claims is reachable: ASCII case pairs, an accented Latin pair needing an
    // explicit case variant, a CASELESS script needing none, the bracket
    // characters placeholders are made of, and a space so multi-word rules and
    // prefix collisions occur.
    const alphabet = "abABcéÉבן 5_[]";
    let seed = 20260822;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const word = (n: number): string =>
      Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]!).join("");

    for (let t = 0; t < 4000; t++) {
      const rules: PrivacyRule[] = [];
      for (let k = 0, n = 1 + Math.floor(rnd() * 4); k < n; k++) {
        rules.push([word(1 + Math.floor(rnd() * 5)), `[Private ${k}]`] as const);
      }
      const text = word(Math.floor(rnd() * 24));
      const report = emptyPrivacyReport();
      const got = new Redactor(rules).redact(text, report);
      const want = oracle(rules, text);
      const same =
        got === want.out && report.replacements === want.reps && report.entitiesHidden === want.ents;
      // One assertion carrying the counterexample, rather than 12000 passing
      // ones: a failure here has to be readable enough to debug from.
      expect(
        same,
        `rules=${JSON.stringify(rules)} text=${JSON.stringify(text)}\n` +
          `  got  ${JSON.stringify(got)} reps=${report.replacements} ents=${report.entitiesHidden}\n` +
          `  want ${JSON.stringify(want.out)} reps=${want.reps} ents=${want.ents}`
      ).toBe(true);
    }
  });
});

describe("the character floor", () => {
  it("a_one_character_block_item_is_refused_not_silently_dropped", () => {
    expect(isProtectable("B")).toBe(false);
    expect(isProtectable("  x ")).toBe(false);
    expect(isProtectable("Ben")).toBe(true);
    // …and the redactor's own floor is the same rule, not a second one.
    expect(new Redactor([["B", "[Person A]"]]).isEmpty()).toBe(true);
    expect(redactor().isEmpty()).toBe(false);
  });

  it("counts CODE POINTS, not UTF-16 units and not bytes", () => {
    expect(MIN_PROTECTED_CHARS).toBe(2);
    expect(isProtectable("א")).toBe(false); // one Hebrew letter, two UTF-8 bytes
    expect(isProtectable("אב")).toBe(true);
    expect(isProtectable("🎯"), "one astral char is TWO UTF-16 units but ONE character").toBe(false);
  });

  it("an empty placeholder is dropped the same way an unprotectable real text is", () => {
    const rules: PrivacyRule[] = [["Ben Reich", "   "]];
    const r = new Redactor(rules);
    expect(r.isEmpty()).toBe(true);
    const report = emptyPrivacyReport();
    expect(r.redact("Ben Reich", report)).toBe("Ben Reich");
  });
});
