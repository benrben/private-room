import { useEffect, useRef, useState } from "react";

/** One id per diagram on the page — mermaid needs a unique DOM id per render
 * and reusing one makes the second diagram overwrite the first. */
let nextId = 0;

/** Mermaid renders to inline SVG entirely on-device. It is a heavy module
 * (~3 MB), so it is imported the first time a ```mermaid fence is actually
 * seen rather than at startup, and the promise is cached so a note with a
 * dozen diagrams loads it once. */
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        // The app has a light and a dark theme; "base" plus CSS variables
        // would need a full theme map, so follow the OS setting, which is
        // what the app's own theme follows by default.
        theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "default",
        // A diagram in a note is untrusted input like any other file content:
        // strict blocks click handlers and raw HTML labels.
        securityLevel: "strict",
        fontFamily: "inherit",
      });
      return m.default;
    });
  }
  return mermaidPromise;
}

/** A ```mermaid code fence, drawn as a diagram.
 *
 * A failed parse shows the source and the reason rather than an empty box —
 * a half-typed diagram is the normal state while writing one.
 */
export default function Mermaid({ source }: { source: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const idRef = useRef(`mmd-${nextId++}`);

  useEffect(() => {
    let alive = true;
    const body = source.trim();
    if (!body) {
      setSvg("");
      setError("");
      return;
    }
    (async () => {
      try {
        const mermaid = await loadMermaid();
        // `parse` throws on a syntax error before anything is injected, which
        // keeps a broken diagram from leaving mermaid's error graphic behind.
        await mermaid.parse(body);
        const { svg: out } = await mermaid.render(idRef.current, body);
        if (alive) {
          setSvg(out);
          setError("");
        }
      } catch (e) {
        if (alive) {
          setSvg("");
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [source]);

  if (error) {
    return (
      <div className="mermaid-error">
        <div className="viewer-status">This diagram could not be drawn: {error}</div>
        <pre>{source}</pre>
      </div>
    );
  }
  if (!svg) return <pre className="mermaid-pending">{source}</pre>;
  // mermaid's own output, from source already inside this room. `strict`
  // security level above is what sanitizes the labels.
  return <div className="mermaid-figure" dangerouslySetInnerHTML={{ __html: svg }} />;
}
