/**
 * The one predicate this migration's privacy door needs out of
 * `src-tauri/src/ollama_lifecycle.rs` (617 lines): is a resolved Ollama base
 * URL a LOCAL daemon? {@link hostOf}/{@link baseIsLocal} are that file's
 * lines 115-145, translated. Nothing else in it (the spawn / idle-sleep /
 * health-probe process management) is ported here; `engineRouting.ts` already
 * documents that gap for the daemon-lifecycle half and this file does not
 * reopen it.
 *
 * WHY THIS MATTERS TO PRIVACY, NOT JUST TO THE DAEMON MANAGER: the room's
 * trust badge, the vision pick, the job lanes and the privacy door's
 * `injectPolicy` all have to answer "does this content leave the Mac", and the
 * MODEL NAME cannot answer it — Settings' Closet field (a runtime base-URL
 * override, `engineRouting.ts`'s `setBaseUrlOverride`) points an
 * ordinary-looking `qwen3.5:4b` at a LAN box. `baseIsLocal` is the TRANSPORT
 * half of the answer; `privacy.ts`'s `ollamaRunsHere` is where it meets the
 * resolved base URL. One predicate for the daemon manager and the door, so the
 * two can never drift apart — the Rust source's own stated reason for putting
 * it here.
 */

/**
 * The HOST of a base URL, lowercased — scheme, credentials, port and path all
 * stripped, IPv6 literals unbracketed. Substring matching on the whole URL is
 * not good enough: `http://localhost-box.lan:11434` and
 * `http://ollama.127.0.0.1.nip.io` both CONTAIN a loopback spelling while
 * naming somebody else's machine. Ported verbatim from
 * `ollama_lifecycle::host_of`.
 */
export function hostOf(base: string): string {
  const afterScheme = afterLast(base, "://");
  const authority = afterScheme.split("/")[0] ?? afterScheme;
  // Credentials: the LAST "@" delimits userinfo from host (userinfo may not
  // contain an unencoded "@"), so `http://user@evil.test@127.0.0.1` names
  // 127.0.0.1 — which is what Rust's `rsplit('@').next()` says too.
  const hostport = afterLast(authority, "@");
  let host: string;
  if (hostport.startsWith("[")) {
    const v6 = hostport.slice(1);
    host = v6.split("]")[0] ?? v6;
  } else {
    host = hostport.split(":")[0] ?? hostport;
  }
  return asciiLowerCase(host.trim());
}

/** Rust's `s.rsplit(sep).next()`: everything after the LAST occurrence of
 * `sep`, or the whole string when `sep` does not occur. */
function afterLast(s: string, sep: string): string {
  const idx = s.lastIndexOf(sep);
  return idx === -1 ? s : s.slice(idx + sep.length);
}

/** ASCII-only lowercase — Rust's `str::to_ascii_lowercase()`, which folds A-Z
 * and NOTHING else. `String.prototype.toLowerCase()` would fold every script,
 * and this string is about to be compared against a fixed list that decides
 * whether room content may leave the Mac unredacted: a predicate that guards
 * that decision should fold exactly what the original folds and no more. */
function asciiLowerCase(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : s[i]!;
  }
  return out;
}

/**
 * An IPv4 loopback LITERAL: `127.0.0.1`, and the shorthands `inet_aton` (and
 * therefore every ordinary client) accepts — `127.1`, `127.0.1`.
 *
 * ONE DELIBERATE DIVERGENCE FROM THE RUST SOURCE, and the reason it is here:
 * `base_is_local` tests `host.starts_with("127.")`, which is a PREFIX test on
 * a HOSTNAME, so `http://127.0.0.1.evil.test:11434` reads as loopback. That is
 * the same class of hole the function's own doc comment was written to close
 * (it names `ollama.127.0.0.1.nip.io` as the reason a substring test on the
 * whole URL is not good enough) — it is just the other end of the name. On
 * this side of the migration the consequence is the worst one this module has:
 * a "local" verdict means `injectPolicy` attaches NO policy, so real names,
 * whole documents and transcripts go to that host in the clear under a chip
 * that reads "Local only".
 *
 * Requiring digits-only labels closes it without narrowing anything real: every
 * genuine loopback spelling still passes, and the only strings that stop
 * passing are ones with a non-numeric label after `127.`, which is to say
 * hostnames belonging to somebody else. The failure direction of being stricter
 * is fail-CLOSED anyway (the door engages for a host it cannot prove is local).
 */
function isLoopbackIpv4(host: string): boolean {
  return /^127(\.\d{1,10}){1,3}$/.test(host);
}

/**
 * Is the resolved base URL a local daemon — one this Mac may start and stop,
 * and one nothing leaves the machine to reach? Ported from
 * `ollama_lifecycle::base_is_local` (see {@link isLoopbackIpv4} for the single
 * hardening).
 */
export function baseIsLocal(base: string): boolean {
  const host = hostOf(base);
  return host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "::" || isLoopbackIpv4(host);
}
