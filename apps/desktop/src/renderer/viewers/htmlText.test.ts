import { DOMParser, parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHiddenMarkup, textOf } from "./htmlText";

const globalKeys = ["DOMParser", "Node"] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

class TestDomParser {
  parseFromString(source: string, _mime: DOMParserSupportedType): Document {
    return new DOMParser().parseFromString(
      `<html><body>${source}</body></html>`,
      "text/html",
    ) as unknown as Document;
  }
}

beforeEach(() => {
  const { window } = parseHTML("<html><body></body></html>");
  Reflect.set(globalThis, "DOMParser", TestDomParser);
  Reflect.set(globalThis, "Node", window.Node);
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("htmlText", () => {
  it("keeps readable text in document order with browser-like blocks and breaks", () => {
    expect(
      textOf("<p>First</p><!-- source-only --><p>Second<br>Third</p>"),
    ).toBe("First\n\nSecond\nThird");
    expect(textOf("<div>A \n <span> B </span> C</div>")).toBe("A  B  C");
  });

  it("preserves preformatted text without collapsing the author spacing", () => {
    expect(textOf("<div>Start<pre>  unchanged\n  gaps  </pre>End</div>")).toBe(
      "Start\n  unchanged\n  gaps  \nEnd",
    );
  });

  it("omits hidden markup and non-reader source while keeping visible text", () => {
    const markup = [
      "<p>Seen <b>in order</b></p>",
      "<script>not a word</script><style>.word { color: red; }</style>",
      "<div hidden>secret</div><span style='display: none'>also secret</span>",
      "<span style='visibility: hidden'>still secret</span>",
      "<span style='visibility: collapse'>collapsed secret</span>",
      "<noscript>not readable</noscript><template>not readable</template>",
      "<p>Last</p>",
    ].join("");

    expect(textOf(markup)).toBe("Seen in order\n\nLast");
  });

  it("recognizes the directly-written hidden markers", () => {
    const document = new DOMParser().parseFromString(
      "<div id='visible'></div><div id='hidden' hidden></div><div id='styled' style=' DISPLAY: none '></div>",
      "text/html",
    );
    const visible = document.getElementById("visible");
    const hidden = document.getElementById("hidden");
    const styled = document.getElementById("styled");
    if (!visible || !hidden || !styled) throw new Error("test markup missing");

    expect(isHiddenMarkup(visible)).toBe(false);
    expect(isHiddenMarkup(hidden)).toBe(true);
    expect(isHiddenMarkup(styled)).toBe(true);
  });

  it("returns an empty string when DOM parsing itself fails", () => {
    class ThrowingDomParser {
      parseFromString(): never {
        throw new Error("DOM unavailable");
      }
    }
    Reflect.set(globalThis, "DOMParser", ThrowingDomParser);

    expect(textOf("<p>Cannot parse</p>")).toBe("");
  });
});
