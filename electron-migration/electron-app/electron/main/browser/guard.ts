// Port of src-tauri/src/web/guard.rs.
//
// SECURITY guard: decides whether a URL/host/IP is "public" (fetchable) or
// "local/private" (must be blocked — Ollama, routers, .local mdns devices,
// this Mac itself).

import { lookup } from "node:dns/promises";

type ResolvedAddress = { address: string; family: number };
type LookupAll = (host: string) => Promise<ResolvedAddress[]>;

const lookupAll: LookupAll = async (host) => await lookup(host, { all: true });

/** Same wording as web.rs's PRIVATE_BLOCKED constant. */
const PRIVATE_BLOCKED = "This address points to a private network and was blocked.";

type V4Octets = [number, number, number, number];
type V6Segments = [number, number, number, number, number, number, number, number];

// ---------------------------------------------------------------------------
// Literal-address parsing helpers.
//
// Rust's `is_public_ip` takes an already-parsed `std::net::IpAddr` — invalid
// strings never reach it. Our exported `isPublicIp` takes a raw string
// instead (there is no equivalent pre-validated type on this side), so these
// helpers do the parsing ourselves rather than relying on `node:net`'s
// `isIPv4`/`isIPv6` validators (which don't hand back the parsed
// octets/segments we need to classify the address).
// ---------------------------------------------------------------------------

/** Parses a dotted-decimal IPv4 literal. Rejects leading zeros (e.g. "01")
 * the way Rust's std parser does, to avoid octal/decimal ambiguity. */
function parseIPv4Octets(input: string): V4Octets | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    if (!/^[0-9]+$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as V4Octets;
}

/** Parses an IPv6 literal (no brackets, no zone id) to 8 16-bit segments.
 * Handles "::" compression and a trailing embedded IPv4 dotted-quad (e.g.
 * "::ffff:192.168.1.1"), which is how Node's dns module may render an
 * IPv4-mapped address (RFC 5952 §5 prefers dotted-quad notation there),
 * even though the WHATWG URL parser instead renders it as pure hex groups
 * (e.g. "::ffff:c0a8:101") — both shapes are handled here. */
function parseIPv6ToSegments(input: string): V6Segments | null {
  if (input.length === 0) return null;
  let str = input;
  let ipv4Tail: V4Octets | null = null;

  const lastColonIdx = str.lastIndexOf(":");
  if (lastColonIdx !== -1) {
    const afterLastColon = str.slice(lastColonIdx + 1);
    if (afterLastColon.includes(".")) {
      const octets = parseIPv4Octets(afterLastColon);
      if (!octets) return null;
      ipv4Tail = octets;
      // Replace the dotted-quad with two placeholder hex groups so the
      // "::" expansion below sees a uniform 8-group hex address; the real
      // value is patched in afterwards.
      str = str.slice(0, lastColonIdx) + ":0:0";
    }
  }

  let groups: string[];
  if (str.includes("::")) {
    const parts = str.split("::");
    if (parts.length !== 2) return null; // more than one "::" is invalid
    const leftStr = parts[0] ?? "";
    const rightStr = parts[1] ?? "";
    const left = leftStr.length ? leftStr.split(":") : [];
    const right = rightStr.length ? rightStr.split(":") : [];
    const filled = 8 - left.length - right.length;
    if (filled < 0) return null;
    groups = [...left, ...Array(filled).fill("0"), ...right];
  } else {
    groups = str.split(":");
  }

  if (groups.length !== 8) return null;

  const nums: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    nums.push(parseInt(g, 16));
  }

  if (ipv4Tail) {
    nums[6] = (ipv4Tail[0] << 8) | ipv4Tail[1];
    nums[7] = (ipv4Tail[2] << 8) | ipv4Tail[3];
  }

  return nums as V6Segments;
}

// ---------------------------------------------------------------------------
// Range classification — a line-for-line port of guard.rs's is_public_ip.
// ---------------------------------------------------------------------------

function isPublicIPv4(o: V4Octets): boolean {
  const isPrivate =
    o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
  const isLoopback = o[0] === 127;
  const isLinkLocal = o[0] === 169 && o[1] === 254;
  const isUnspecified = o[0] === 0 && o[1] === 0 && o[2] === 0 && o[3] === 0;
  const isBroadcast = o[0] === 255 && o[1] === 255 && o[2] === 255 && o[3] === 255;

  const local =
    isPrivate ||
    isLoopback ||
    isLinkLocal ||
    isUnspecified ||
    isBroadcast ||
    o[0] === 0 || // "this network" 0.0.0.0/8
    (o[0] === 100 && (o[1] & 0xc0) === 0x40) || // CGNAT/Tailscale 100.64.0.0/10
    (o[0] === 192 && o[1] === 0 && o[2] === 0) || // IETF protocol 192.0.0.0/24
    (o[0] === 198 && (o[1] & 0xfe) === 18) || // benchmarking 198.18.0.0/15
    o[0] >= 224; // multicast 224.0.0.0/4 + reserved 240.0.0.0/4
  return !local;
}

function isPublicIPv6(seg: V6Segments): boolean {
  // Classify IPv4-mapped addresses (::ffff:a.b.c.d, i.e. the ::ffff:0:0/96
  // range) by their embedded IPv4, so e.g. ::ffff:192.168.1.1 can't slip
  // through.
  if (seg[0] === 0 && seg[1] === 0 && seg[2] === 0 && seg[3] === 0 && seg[4] === 0 && seg[5] === 0xffff) {
    const v4: V4Octets = [(seg[6] >> 8) & 0xff, seg[6] & 0xff, (seg[7] >> 8) & 0xff, seg[7] & 0xff];
    return isPublicIPv4(v4);
  }
  const isLoopback =
    seg[0] === 0 &&
    seg[1] === 0 &&
    seg[2] === 0 &&
    seg[3] === 0 &&
    seg[4] === 0 &&
    seg[5] === 0 &&
    seg[6] === 0 &&
    seg[7] === 1;
  const isUnspecified = seg.every((s) => s === 0);
  const isUniqueLocal = (seg[0] & 0xfe00) === 0xfc00; // unique local fc00::/7
  const isLinkLocal = (seg[0] & 0xffc0) === 0xfe80; // link local fe80::/10
  const local = isLoopback || isUnspecified || isUniqueLocal || isLinkLocal;
  return !local;
}

/**
 * Is this IP address literal a publicly-routable address (as opposed to
 * loopback/private/link-local/etc)?
 *
 * Unlike the Rust original (which only ever receives an already-parsed
 * `IpAddr`), this takes a raw string. This module's security posture is
 * fail-closed throughout (see `hostResolvesPrivate` below: "I could not find
 * out is not yes"), so an input that doesn't parse as either an IPv4 or IPv6
 * literal is treated as NOT public rather than thrown — a caller that feeds
 * this an unresolved/garbage string (which should never happen: every real
 * caller here passes either a literal already matched by `checkPublicHttpUrl`
 * or an address string returned by DNS resolution) gets the safe answer
 * instead of an uncaught exception replacing a would-be "blocked" verdict.
 */
export function isPublicIp(ip: string): boolean {
  const v4 = parseIPv4Octets(ip);
  if (v4) return isPublicIPv4(v4);
  const v6 = parseIPv6ToSegments(ip);
  if (v6) return isPublicIPv6(v6);
  return false;
}

/** Does `host` parse as an IP literal that is a private/local address?
 * `false` both when the address is public AND when `host` isn't an IP
 * literal at all (a plain hostname) — mirroring Rust's
 * `host.parse::<IpAddr>().map_or(false, |ip| !is_public_ip(ip))`. */
function hostIsLiteralPrivateIp(host: string): boolean {
  const v4 = parseIPv4Octets(host);
  if (v4) return !isPublicIPv4(v4);
  const v6 = parseIPv6ToSegments(host);
  if (v6) return !isPublicIPv6(v6);
  return false;
}

function trimEndChar(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s.charAt(end - 1) === ch) end--;
  return s.slice(0, end);
}

function trimStartChar(s: string, ch: string): string {
  let start = 0;
  while (start < s.length && s.charAt(start) === ch) start++;
  return s.slice(start);
}

/**
 * The fetch tool takes model-supplied URLs; keep it away from this Mac and
 * the local network (Ollama, routers, .local devices).
 *
 * Throws with the same message strings as the Rust `Err` variants.
 */
export function checkPublicHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs can be fetched.");
  }
  if (!parsed.hostname) {
    throw new Error("Invalid URL: no host.");
  }
  // A trailing dot is the DNS ROOT LABEL: "localhost." and "printer.local."
  // resolve exactly like the names without it, and every service on this
  // Mac answers them — but a literal comparison does not see that, so
  // "http://localhost.:11434/" walked straight through this check.
  // Normalised once, before every check below. (IP literals need no help:
  // the URL parser already rewrites "127.0.0.1." back to "127.0.0.1".)
  const host = trimEndChar(parsed.hostname.toLowerCase(), ".");
  // `hostname` keeps the brackets on IPv6 literals ("[::1]"); strip them or
  // the IP-literal parse below never fires for v6 and the literal check is
  // moot.
  const bracketless = trimEndChar(trimStartChar(host, "["), "]");
  const local = host === "localhost" || host.endsWith(".local") || hostIsLiteralPrivateIp(bracketless);
  if (local) {
    throw new Error("Local and private-network addresses cannot be fetched.");
  }
  return parsed;
}

/**
 * SEC-5: `checkPublicHttpUrl` only blocks *literal* private IPs and known
 * local names — a normal-looking hostname can still resolve to 192.168.x.x
 * (DNS rebinding). Resolve the host and confirm EVERY returned address is
 * public, returning one checked address to pin the connection to.
 */
export async function resolvePublicAddr(
  host: string,
  port: number,
  resolveAll: LookupAll = lookupAll,
): Promise<{ address: string; port: number }> {
  let addrs: ResolvedAddress[];
  try {
    addrs = await resolveAll(host);
  } catch {
    throw new Error(`Could not resolve the address for ${host}.`);
  }
  if (addrs.length === 0) {
    throw new Error(`Could not resolve the address for ${host}.`);
  }
  if (addrs.some((a) => !isPublicIp(a.address))) {
    throw new Error(PRIVATE_BLOCKED);
  }
  // Pinning prevents DNS rebinding, but pinning the first answer verbatim is
  // stricter than a normal fetch in the wrong way: dual-stack hosts commonly
  // publish AAAA first, while many Macs and office/VPN networks have no usable
  // IPv6 route. A browser/curl falls back to IPv4; the pinned OAuth request
  // instead died at "fetch failed" before its sign-in page could open (GH #33,
  // reproduced against Datadog's official MCP endpoint). Every answer has
  // already passed the public-address check above, so prefer a public IPv4
  // address when one exists and retain IPv6 for IPv6-only hosts.
  const selected = addrs.find((a) => a.family === 4) ?? addrs[0];
  if (!selected) {
    throw new Error(`Could not resolve the address for ${host}.`);
  }
  return { address: selected.address, port };
}

/**
 * Does this host resolve to an address inside this Mac or the local network?
 *
 * Deliberately NOT `resolvePublicAddr`'s error, which also covers "the name
 * does not resolve at all". The private browser's post-navigation recheck
 * needs the two apart: a name that cannot be resolved simply fails to load
 * on its own, and reporting that as a private-address block would put a red
 * banner and a permanent journal line on nothing at all.
 *
 * `false` on any lookup failure — this answers one question, and "I could
 * not find out" is not "yes".
 */
export async function hostResolvesPrivate(host: string, port: number): Promise<boolean> {
  void port; // resolution is by hostname only; port is carried for API parity with the Rust signature.
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.some((a) => !isPublicIp(a.address));
  } catch {
    return false;
  }
}

// A `hopHostIsPublic` used to live here, called from reqwest's synchronous
// redirect policy. It was strictly weaker than the check the first hop gets:
// having approved a hop it could not PIN it, so reqwest resolved the redirect
// target a second time, unpinned, to open the connection — a hostile server
// could answer the check publicly and the connection privately. The
// redirect-following caller now re-runs `checkPublicHttpUrl` on every hop
// itself (literal check, resolve all addresses, pin the connection), so the
// weaker check has no caller and no reason to exist here either.
