import type { PluggableList } from "unified";

/**
 * The heavy half of Markdown rendering — maths, syntax highlighting and their
 * stylesheet — loaded on demand instead of at startup.
 *
 * WHY THIS EXISTS: `MarkdownView` renders every chat message, so it is eagerly
 * imported by the shell and cannot itself be lazy. Importing KaTeX (~260 KB
 * plus a stylesheet and its fonts) and highlight.js's common-language set
 * statically from there put both in the app's first chunk — paid for on every
 * cold start, by every user, before a single character appears, whether or not
 * anything on screen contains maths or code.
 *
 * So the plugins arrive in a second chunk. Markdown renders immediately with
 * GitHub-flavoured tables and lists (which were always there), then re-renders
 * with maths and highlighting once this resolves — typically before the user
 * has read the first line. The promise is cached module-wide, so the cost is
 * paid at most once per session no matter how many messages render.
 */
export interface RichPlugins {
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
}

let cached: RichPlugins | null = null;
let inFlight: Promise<RichPlugins> | null = null;

/** The plugins, if they are already here. Lets the first render of a later
 * message skip the un-highlighted pass entirely. */
export function richPluginsIfLoaded(): RichPlugins | null {
  return cached;
}

export function loadRichPlugins(): Promise<RichPlugins> {
  if (cached) return Promise.resolve(cached);
  if (!inFlight) {
    inFlight = (async () => {
      const [remarkMath, rehypeKatex, rehypeHighlight] = await Promise.all([
        import("remark-math"),
        import("rehype-katex"),
        import("rehype-highlight"),
        // The stylesheet rides along in this chunk rather than the entry one.
        import("katex/dist/katex.min.css"),
      ]);
      cached = {
        remarkPlugins: [remarkMath.default],
        rehypePlugins: [
          rehypeKatex.default,
          // `ignoreMissing` keeps an unknown ```lang from throwing the whole
          // document away — it renders as plain code instead.
          [rehypeHighlight.default, { ignoreMissing: true, detect: true }],
        ],
      };
      return cached;
    })();
  }
  return inFlight;
}

/** Start the fetch during idle time so the plugins are usually in place before
 * anything needs them. Safe to call repeatedly. */
export function warmRichPlugins(): void {
  if (cached || inFlight) return;
  const start = () => void loadRichPlugins().catch(() => {});
  if (typeof requestIdleCallback === "function") requestIdleCallback(start, { timeout: 3000 });
  else setTimeout(start, 1200);
}
