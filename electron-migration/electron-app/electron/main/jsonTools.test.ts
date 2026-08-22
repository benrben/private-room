/**
 * Tests for `jsonTools.ts`, mirroring `src-tauri/src/commands/json.rs`'s own
 * `mod tests::plucks_fields_and_tolerates_junk` 1:1, plus the extra boundary
 * cases its own doc comments call out (a blank value stays present rather
 * than folding into "missing", non-object JSON tops, arrays indexed by a
 * string key, inherited-property reads).
 */

import { afterEach, describe, expect, it } from "vitest";
import { jsonArray, jsonStrField, valueStr } from "./jsonTools.js";

describe("jsonStrField / jsonArray / valueStr — direct port of json.rs's own test", () => {
  const raw = ' {"html": " <div/> ", "worth": true, "tags": ["a", " ", " B "], "cards": [{"q": "x"}]} ';

  it("plucks a present string field, trimmed", () => {
    expect(jsonStrField(raw, "html")).toBe("<div/>");
  });

  it("returns null for a missing field", () => {
    expect(jsonStrField(raw, "missing")).toBeNull();
  });

  it("plucks the trimmed string at a key of an already-parsed item", () => {
    expect(valueStr(jsonArray(raw, "cards")[0], "q")).toBe("x");
  });

  it("returns '' for a missing item key rather than throwing", () => {
    expect(valueStr(jsonArray(raw, "cards")[0], "a")).toBe("");
  });

  it("a non-JSON reply is missing data, not an error", () => {
    expect(jsonStrField("sorry, I can't", "html")).toBeNull();
    expect(jsonArray("sorry, I can't", "cards")).toEqual([]);
  });
});

describe("jsonStrField — boundary cases", () => {
  it("returns null when the value at key is not a string (number/bool/null/object/array)", () => {
    const raw = '{"n": 1, "b": true, "z": null, "o": {"x": 1}, "a": [1, 2]}';
    expect(jsonStrField(raw, "n")).toBeNull();
    expect(jsonStrField(raw, "b")).toBeNull();
    expect(jsonStrField(raw, "z")).toBeNull();
    expect(jsonStrField(raw, "o")).toBeNull();
    expect(jsonStrField(raw, "a")).toBeNull();
  });

  it("trims but never drops a value that is blank after trimming — '' stays '', not null", () => {
    // Matches json_str_field's own doc: callers that want blank-as-missing add
    // their own `.filter(|s| !s.is_empty())`; this function alone must not.
    expect(jsonStrField('{"html": "   "}', "html")).toBe("");
  });

  it("returns null when the top level isn't a JSON object", () => {
    expect(jsonStrField("[1, 2, 3]", "html")).toBeNull();
    expect(jsonStrField('"just a string"', "html")).toBeNull();
    expect(jsonStrField("42", "html")).toBeNull();
    expect(jsonStrField("null", "html")).toBeNull();
  });

  it("tolerates surrounding whitespace around the JSON, same as raw.trim() upstream", () => {
    expect(jsonStrField('  \n {"html": "hi"} \n  ', "html")).toBe("hi");
  });

  it("does not leak an inherited Object.prototype member as a string field", () => {
    expect(jsonStrField('{"a": 1}', "toString")).toBeNull();
    expect(jsonStrField('{"a": 1}', "constructor")).toBeNull();
  });
});

describe("jsonArray — boundary cases", () => {
  it("returns [] when the value at key is present but not an array", () => {
    expect(jsonArray('{"cards": "not an array"}', "cards")).toEqual([]);
    expect(jsonArray('{"cards": {"q": "x"}}', "cards")).toEqual([]);
    expect(jsonArray('{"cards": null}', "cards")).toEqual([]);
  });

  it("returns [] when the top level isn't a JSON object, even an array itself", () => {
    expect(jsonArray("[1, 2, 3]", "cards")).toEqual([]);
  });

  it("preserves array item order and non-object items untouched", () => {
    expect(jsonArray('{"tags": ["a", " ", " B "]}', "tags")).toEqual(["a", " ", " B "]);
  });
});

describe("valueStr — boundary cases", () => {
  it("returns '' when v itself is not a JSON object (array, primitive, null)", () => {
    expect(valueStr(["a", "b"], "q")).toBe("");
    expect(valueStr("plain string", "q")).toBe("");
    expect(valueStr(42, "q")).toBe("");
    expect(valueStr(null, "q")).toBe("");
    expect(valueStr(undefined, "q")).toBe("");
  });

  it("returns '' when the key's value isn't a string", () => {
    expect(valueStr({ q: 1 }, "q")).toBe("");
    expect(valueStr({ q: null }, "q")).toBe("");
    expect(valueStr({ q: { nested: true } }, "q")).toBe("");
  });

  it("trims the string, matching json_str_field's own trimming", () => {
    expect(valueStr({ label: "  Root  " }, "label")).toBe("Root");
  });
});

// ============================================================================
// ADVERSARIAL: a polluted Object.prototype must never fabricate a field.
//
// `serde_json::Value::get` resolves a `&str` index against the parsed object's
// OWN map, so Rust cannot hand back a value the model never sent. A plain
// `obj[key]` in JS can — and this app has shipped `Object.prototype`
// pollution twice (mcpConfig.ts, privacyRedact.ts), so this is a demonstrated
// bug class here, not a hypothetical one. The existing "inherited
// Object.prototype member" tests above pass either way, because every BUILT-IN
// prototype member is a function and the `typeof === "string"` guard excludes
// it; only an INJECTED member of the right type tells the two implementations
// apart. Each of these three failed before `ownValue` was introduced,
// returning the injected value as if a studio generator's model had produced it.
// ============================================================================

describe("a polluted Object.prototype never fabricates a field", () => {
  const polluted: string[] = [];
  function pollute(key: string, value: unknown): void {
    Object.defineProperty(Object.prototype, key, {
      value,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    polluted.push(key);
  }

  afterEach(() => {
    for (const key of polluted.splice(0)) {
      Reflect.deleteProperty(Object.prototype, key);
    }
  });

  it("jsonStrField answers null for an absent key even when the prototype carries a string there", () => {
    pollute("html", "FABRICATED");
    expect(jsonStrField('{"a": 1}', "html")).toBeNull();
    // …and an OWN value of the same name still wins, so the guard didn't
    // break the ordinary path.
    expect(jsonStrField('{"html": " real "}', "html")).toBe("real");
  });

  it("jsonArray answers [] for an absent key even when the prototype carries an array there", () => {
    pollute("cards", [{ q: "FABRICATED" }]);
    expect(jsonArray('{"a": 1}', "cards")).toEqual([]);
    expect(jsonArray('{"cards": [{"q": "real"}]}', "cards")).toEqual([{ q: "real" }]);
  });

  it("valueStr answers '' for an absent key even when the prototype carries a string there", () => {
    pollute("q", "FABRICATED");
    expect(valueStr({ other: 1 }, "q")).toBe("");
    expect(valueStr({ q: " real " }, "q")).toBe("real");
  });

  it("an own '__proto__' entry — which JSON.parse creates as plain data — is still read as data", () => {
    // JSON.parse does not invoke the `__proto__` setter, so this is an
    // ordinary own key and Rust would read it as one too.
    expect(jsonStrField('{"__proto__": "x"}', "__proto__")).toBe("x");
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
