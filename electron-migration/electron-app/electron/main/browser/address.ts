/**
 * BROWSE-3c: what a piece of text was ADDRESSED at — a host, or a question.
 *
 * Port of `classify` in `src-tauri/src/commands/browse/address.rs`. This is
 * ONE rule with two callers: the address bar decides it before it navigates
 * anything, and the agent's `browse_open` decides it before it navigates
 * anything. The two must agree — typing `best pizza nyc` and asking the
 * Browser agent to look up best pizza nyc are the same request, and the room
 * answers both from its own engines.
 *
 * The Rust doc comment ties this case table to a SIBLING frontend test file
 * (`e2e/page-script/address.test.mjs`) so a rule that drifts on one side goes
 * red on that side. That file has no counterpart in this port yet (the address
 * bar itself is a later batch), so the case table below is ported from the
 * Rust `mod tests` faithfully: whichever batch builds the frontend twin has a
 * known-correct target to match rather than having to reverse it out of Rust.
 *
 * Deciding is not permitting: a `url` verdict still has to clear
 * `browseGuardUrl`, which is what actually refuses this Mac and private
 * networks by name.
 */

/** What the text meant. */
export type Address = { kind: "url"; url: string } | { kind: "search"; query: string };

function url(u: string): Address {
  return { kind: "url", url: u };
}

function search(q: string): Address {
  return { kind: "search", query: q };
}

/**
 * A single token that is really a host: `example.com`, `x.co/path`. The
 * 2-character floor on the last label is what keeps `node.j` a topic — counted
 * in CODE POINTS, matching Rust's `tld.chars().count()`, so a single astral
 * character is one character here too rather than the two UTF-16 units
 * `String.length` would report.
 */
function isHostish(text: string): boolean {
  const head = text.split(/[/:?#]/)[0] ?? "";
  const dot = head.lastIndexOf(".");
  if (dot === -1) return false;
  const name = head.slice(0, dot);
  const tld = head.slice(dot + 1);
  return name.length > 0 && [...tld].length >= 2 && !tld.includes(".");
}

/** `localhost:3000` — a host named by port rather than by dot. */
function isHostPort(text: string): boolean {
  const head = text.split(/[/?#]/)[0] ?? "";
  const colon = head.lastIndexOf(":");
  if (colon === -1) return false;
  const name = head.slice(0, colon);
  const port = head.slice(colon + 1);
  return name.length > 0 && /^[0-9]+$/.test(port);
}

/** `192.168.1.1`, with or without a port. The guard refuses it later, by
 *  name. */
function isIpv4(text: string): boolean {
  const head = (text.split(/[/?#]/)[0] ?? "").split(":")[0] ?? "";
  const parts = head.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => p.length <= 3 && /^[0-9]+$/.test(p));
}

/**
 * Decide what the text meant. `null` means "nothing to do" (empty input).
 *
 * Order matters, and it is the same order the address bar uses: the explicit
 * forms (`?` and a scheme) win over the guesses, so there is always a way to
 * force either behaviour on ambiguous text.
 */
export function classify(input: string): Address | null {
  const text = input.trim();
  if (text === "") {
    return null;
  }

  // "?query" — force a search for text that would otherwise look like a host.
  if (text.startsWith("?")) {
    const query = text.slice(1).trim();
    return query === "" ? null : search(query);
  }

  // An explicit scheme is a decision the caller already made.
  if (text.includes("://")) {
    return url(text);
  }

  // No URL has a space in it. This is the case that reached the agent as
  // `Invalid URL: https://best pizza nyc` and sent it hunting for a search box
  // on google.com.
  if (/\s/.test(text)) {
    return search(text);
  }

  if (isHostish(text) || isIpv4(text) || isHostPort(text)) {
    return url(`https://${text}`);
  }

  // A bare word: "weather", "בנק ישראל". Nothing about it addresses a host.
  return search(text);
}
