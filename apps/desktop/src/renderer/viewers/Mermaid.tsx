import { useEffect, useRef, useState } from "react";
import { useFrameTheme } from "./frameTheme";

/** One id per diagram on the page — mermaid needs a unique DOM id per render
 * and reusing one makes the second diagram overwrite the first. */
let nextId = 0;

/** Mermaid renders to inline SVG entirely on-device. It is a heavy module
 * (~3 MB), so it is imported the first time a ```mermaid fence is actually
 * seen rather than at startup, and the promise is cached so a note with a
 * dozen diagrams loads it once. */
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

/** mermaid keeps ONE global configuration for the whole module, so the palette
 * is set immediately before each render rather than once when the module
 * arrives. Configuring at import time meant every diagram of the session was
 * drawn in whichever palette the FIRST fence happened to load under, and no
 * theme change afterwards could reach it. */
function configure(mermaid: Awaited<ReturnType<typeof loadMermaid>>, dark: boolean) {
  mermaid.initialize({
    startOnLoad: false,
    // "base" plus CSS variables would need a full theme map; mermaid's own two
    // palettes track the APP's light/dark setting, which is what the diagram
    // sits on — the Mac's setting is not it, and pinning the app opposite to
    // the Mac used to give dark node fills on ivory paper.
    theme: dark ? "dark" : "default",
    // A diagram in a note is untrusted input like any other file content:
    // strict blocks click handlers and raw HTML labels.
    securityLevel: "strict",
    fontFamily: "inherit",
  });
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
  const theme = useFrameTheme();

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
        configure(mermaid, theme === "dark");
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
    // `theme` is a dependency, not a read: a diagram already on screen has to
    // be drawn again when the room changes theme, or it keeps the old palette.
  }, [source, theme]);

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
