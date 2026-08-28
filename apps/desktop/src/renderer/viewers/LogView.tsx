import { useDeferredValue, useMemo, useState } from "react";
import "./log.css";

/** Severities recognised anywhere in a line, most severe first so a line
 * mentioning both is classified by the worse one. */
const LEVELS = [
  { key: "error", test: /\b(ERROR|ERR|FATAL|CRITICAL|PANIC|SEVERE)\b/ },
  { key: "warn", test: /\b(WARN|WARNING)\b/ },
  { key: "info", test: /\b(INFO|NOTICE)\b/ },
  { key: "debug", test: /\b(DEBUG|TRACE|VERBOSE)\b/ },
] as const;

type Level = (typeof LEVELS)[number]["key"] | "plain";

function levelOf(line: string): Level {
  for (const l of LEVELS) if (l.test.test(line)) return l.key;
  return "plain";
}

/** How many lines are rendered at once. A build log runs to hundreds of
 * thousands of lines; the newest are the ones anyone opens it for, so the
 * TAIL is shown first and the rest is one click away. */
const PAGE = 2000;

/**
 * A log file, read as a log.
 *
 * A `.log` used to open in the code editor with a "plaintext" language — no
 * severity colours, no filtering, no way to get to the end except scrolling.
 * Everything here is what you actually do with a log: jump to the tail, filter
 * to the errors, and search.
 */
export default function LogView({ text }: { text: string }) {
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<Level | "all">("all");
  const [limit, setLimit] = useState(PAGE);
  // Typing in the filter box must not block on re-classifying 200,000 lines.
  const deferredQuery = useDeferredValue(query);

  const lines = useMemo(() => {
    const raw = text.split("\n");
    // A trailing newline is not a final empty line anyone wants to see.
    if (raw.length && raw[raw.length - 1] === "") raw.pop();
    return raw.map((content, i) => ({ n: i + 1, content, level: levelOf(content) }));
  }, [text]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const l of lines) out[l.level] = (out[l.level] ?? 0) + 1;
    return out;
  }, [lines]);

  const matched = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return lines.filter(
      (l) =>
        (only === "all" || l.level === only) &&
        (!needle || l.content.toLowerCase().includes(needle)),
    );
  }, [lines, deferredQuery, only]);

  // The TAIL, not the head — the end of a log is where the answer is.
  const shown = matched.slice(Math.max(0, matched.length - limit));
  const hidden = matched.length - shown.length;

  return (
    <div className="log-view">
      <div className="log-bar">
        <input
          className="log-search"
          type="search"
          placeholder="Filter lines…"
          value={query}
          aria-label="Filter log lines"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="log-levels" role="group" aria-label="Severity">
          <button
            type="button"
            className={only === "all" ? "active" : ""}
            onClick={() => setOnly("all")}
          >
            All {lines.length.toLocaleString()}
          </button>
          {LEVELS.filter((l) => counts[l.key]).map((l) => (
            <button
              key={l.key}
              type="button"
              className={`log-lvl-${l.key}${only === l.key ? " active" : ""}`}
              onClick={() => setOnly(only === l.key ? "all" : l.key)}
            >
              {l.key} {counts[l.key]?.toLocaleString()}
            </button>
          ))}
        </div>
      </div>
      {hidden > 0 && (
        <button className="log-more" onClick={() => setLimit((n) => n + PAGE * 5)}>
          Show earlier lines — {hidden.toLocaleString()} above this point
        </button>
      )}
      <div className="log-body">
        {shown.map((l) => (
          <div key={l.n} className={`log-line log-lvl-${l.level}`}>
            <span className="log-n">{l.n}</span>
            <span className="log-text">{l.content || " "}</span>
          </div>
        ))}
      </div>
      {matched.length === 0 && (
        <div className="empty-hint">No lines match this filter.</div>
      )}
    </div>
  );
}
