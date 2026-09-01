/**
 * Coverage for `mcpRegistry.ts` — the port of
 * `src-tauri/src/commands/mcp_registry.rs`.
 *
 * Its `#[cfg(test)]` module is the baseline for every pure case (the `sample()`
 * fixture below is that module's own payload). Everything network-shaped that
 * Rust could only test behind `#[ignore]` — the retry/backoff wrapper, the icon
 * fetch's guard/mime/size behavior, `mcp_registry_search`'s glue — is exercised
 * here instead: the registry call over an injected `fetch`, the icon path
 * against a REAL `node:http` server through the real `guardedGet`.
 *
 * THE ONE THING MOCKED is `resolvePublicAddr`, and only for the fake hostname
 * `safehost.example` → 127.0.0.1, so a local test server can look "public" to
 * the connection pin without touching real DNS — the same seam
 * `webFetch.test.ts` uses. `checkPublicHttpUrl` stays completely real, so every
 * refusal decision still runs the actual guard.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./browser/guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browser/guard.js")>();
  return {
    ...actual,
    resolvePublicAddr: vi.fn(async (host: string, port: number) => {
      if (host === "safehost.example") return { address: "127.0.0.1", port };
      return actual.resolvePublicAddr(host, port);
    }),
  };
});

import type { CatalogEntry, InstallSpec } from "../shared/apiTypes.js";
import {
  fetchIcon,
  ICON_CONCURRENCY,
  iconUrlAllowed,
  inlineIconsWith,
  isInstallableEndpoint,
  mcpRegistryOptinFile,
  mcpRegistryOptinStatus,
  mcpRegistrySearch,
  namespaceOwnsRepo,
  normalizeServers,
  REGISTRY_ATTEMPTS,
  REGISTRY_TIMEOUT_MS,
  REGISTRY_URL,
  type RegistryFetchFn,
  type RegistryHttpResponse,
  sendWithRetries,
  setMcpRegistryOptin,
  splitNamespace,
} from "./mcpRegistry.js";

const TEST_HOST = "safehost.example";

let server: http.Server | undefined;
const tmpDirs: string[] = [];

afterEach(async () => {
  if (server !== undefined) {
    const srv = server;
    server = undefined;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Start a real server on loopback, reachable through the guard as
 * `http://safehost.example:<port>` (see the module doc's DNS-pinning mock). */
async function listenOn(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://${TEST_HOST}:${port}`;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-registry-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * A representative slice of the LIVE registry payload: entries wrapped in
 * `server`, current camelCase package fields (`registryType`/`identifier`/
 * `runtimeHint`/`environmentVariables`) and `remotes[].type`. Entry [3] is the
 * older UNWRAPPED snake_case shape, kept to prove back-compat. Ported from the
 * Rust test module's own `sample()`.
 */
function sample(): unknown {
  return {
    servers: [
      {
        server: {
          name: "io.github.microsoft/playwright-mcp",
          title: "Playwright",
          description: "Drive a real browser.",
          icons: [{ src: "https://ex.com/pw.png", mimeType: "image/png" }],
          repository: { url: "https://github.com/microsoft/playwright-mcp", source: "github" },
          packages: [
            {
              registryType: "npm",
              identifier: "@playwright/mcp",
              version: "0.1.0",
              runtimeHint: "npx",
              transport: { type: "stdio" },
            },
          ],
        },
        _meta: {},
      },
      {
        server: {
          name: "io.github.someone/db-tools",
          description: "Query Postgres.",
          repository: { url: "https://github.com/otheruser/db-tools" },
          packages: [
            { registryType: "pypi", identifier: "db-tools-mcp", environmentVariables: [{ name: "DATABASE_URL" }] },
          ],
        },
      },
      {
        server: {
          name: "com.notion/notion",
          description: "Notion workspace.",
          remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }],
        },
      },
      // Older UNWRAPPED + snake_case entry — must still normalize.
      {
        name: "io.github.legacy/tool",
        description: "old shape",
        packages: [{ registry_name: "npm", name: "legacy-mcp", runtime_hint: "npx" }],
      },
      { server: { name: "broken.no-install/x", description: "no packages or remotes" } },
    ],
  };
}

function entryAt(i: number): CatalogEntry {
  const e = normalizeServers(sample())[i];
  if (e === undefined) throw new Error(`sample() has no entry ${i}`);
  return e;
}

// ------------------------------------------------------------------ constants

it("uses the registry's frozen API and allows slow reads", () => {
  expect(REGISTRY_URL.endsWith("/v0.1/servers")).toBe(true);
  expect(REGISTRY_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  expect(REGISTRY_ATTEMPTS).toBe(2);
});

// -------------------------------------------------------------- normalization

describe("normalizeServers", () => {
  it("normalizes a wrapped package with a verified owner", () => {
    const e = entryAt(0);
    expect(e.id).toBe("io.github.microsoft/playwright-mcp");
    expect(e.name).toBe("playwright-mcp");
    // `title` is surfaced separately from the slug `name`; the raw icon URL is
    // extracted here (mcpRegistrySearch later inlines it as a data URI).
    expect(e.title).toBe("Playwright");
    expect(e.icon).toBe("https://ex.com/pw.png");
    expect(e.publisher).toBe("microsoft");
    expect(e.remote).toBe(false);
    expect(e.transport).toBe("stdio");
    expect(e.altInstall).toBeNull(); // local-only → no cloud alternative
    expect(e.verified).toBe(true); // namespace owner "microsoft" == the github repo owner
    expect(e.install).toEqual({ kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp"], envKeys: [] });
  });

  it("maps pypi to uvx and surfaces env keys", () => {
    const e = entryAt(1);
    expect(e.verified).toBe(false); // "someone" != repo owner "otheruser"
    expect(e.install).toEqual({ kind: "stdio", command: "uvx", args: ["db-tools-mcp"], envKeys: ["DATABASE_URL"] });
  });

  it("maps OCI to docker and honors an explicit runner hint", () => {
    const entries = normalizeServers({
      servers: [
        { server: { name: "com.example/oci", packages: [{ registryType: "oci", identifier: "example/oci-mcp" }] } },
        { server: { name: "com.example/bun", packages: [{ registryType: "npm", identifier: "bun-mcp", runtimeHint: "bunx" }] } },
      ],
    });
    expect(entries[0]?.install).toEqual({ kind: "stdio", command: "docker", args: ["run", "-i", "--rm", "example/oci-mcp"], envKeys: [] });
    expect(entries[1]?.install).toEqual({ kind: "stdio", command: "bunx", args: ["bun-mcp"], envKeys: [] });
  });

  it("flags a remote endpoint as http", () => {
    const e = entryAt(2);
    expect(e.remote).toBe(true);
    expect(e.transport).toBe("http");
    expect(e.publisher).toBe("notion");
    expect(e.altInstall).toBeNull(); // remote-only → no local alternative
    expect(e.install).toEqual({ kind: "http", url: "https://mcp.notion.com/mcp", headerKeys: [] });
  });

  it("prefers local and offers the cloud alternative for a dual-transport record", () => {
    // Privacy-first: the primary install is the LOCAL package and the remote is
    // the alternative — the reverse of the old remote-first behavior that
    // installed a vendor's dead hosted server over a working local package.
    const payload = {
      servers: [
        {
          server: {
            name: "com.example/dual",
            description: "both transports",
            packages: [
              { registryType: "pypi", identifier: "dual-mcp", runtimeHint: "uvx", transport: { type: "stdio" } },
            ],
            remotes: [{ type: "streamable-http", url: "https://mcp.example.com/dual" }],
          },
        },
      ],
    };
    const e = normalizeServers(payload)[0];
    if (e === undefined) throw new Error("expected one entry");
    expect(e.remote).toBe(false); // nothing leaves the Mac by default
    expect(e.transport).toBe("stdio");
    expect(e.install).toEqual({ kind: "stdio", command: "uvx", args: ["dual-mcp"], envKeys: [] });
    expect(e.altInstall).toEqual({ kind: "http", url: "https://mcp.example.com/dual", headerKeys: [] });
  });

  it("still normalizes the old unwrapped snake_case shape", () => {
    const e = entryAt(3);
    expect(e.name).toBe("tool");
    expect(e.publisher).toBe("legacy");
    expect(e.install).toEqual({ kind: "stdio", command: "npx", args: ["-y", "legacy-mcp"], envKeys: [] });
  });

  it("skips undeployable records rather than failing the whole search", () => {
    // 5 entries, the last has neither packages nor remotes → dropped → 4.
    expect(normalizeServers(sample())).toHaveLength(4);
  });

  it("keeps malformed remote urls from ever reaching the drawer", () => {
    // The details drawer parses `install.url` with `new URL(...)`, so a registry
    // entry missing its scheme used to blank the whole window.
    expect(isInstallableEndpoint("https://mcp.example.com/mcp")).toBe(true);
    expect(isInstallableEndpoint("http://mcp.example.com")).toBe(true);
    expect(isInstallableEndpoint("mcp.example.com/mcp")).toBe(false); // no scheme
    expect(isInstallableEndpoint("/mcp")).toBe(false);
    expect(isInstallableEndpoint("")).toBe(false);
    expect(isInstallableEndpoint("javascript:alert(1)")).toBe(false);
    expect(isInstallableEndpoint("https://")).toBe(false); // no host

    const payload = {
      servers: [
        // Remote-only with a broken url → the whole record is skipped.
        { server: { name: "com.bad/only-remote", remotes: [{ type: "streamable-http", url: "mcp.bad.com/mcp" }] } },
        // Broken remote but a good local package → installs locally.
        {
          server: {
            name: "com.bad/has-local",
            packages: [{ registryType: "pypi", identifier: "ok-mcp" }],
            remotes: [{ url: "not a url" }],
          },
        },
      ],
    };
    const entries = normalizeServers(payload);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("com.bad/has-local");
    expect(entries[0]?.remote).toBe(false);
    expect(entries[0]?.altInstall).toBeNull(); // a malformed remote is not a cloud alternative either
  });

  it("dedupes repeated ids and prettifies generic names", () => {
    const payload = {
      servers: [
        { server: { name: "ac.inference.sh/mcp", remotes: [{ type: "streamable-http", url: "https://x" }] } },
        { server: { name: "ac.inference.sh/mcp", remotes: [{ type: "streamable-http", url: "https://x" }] } },
        { server: { name: "com.notion/notion", remotes: [{ type: "streamable-http", url: "https://n" }] } },
      ],
    };
    const entries = normalizeServers(payload);
    expect(entries).toHaveLength(2); // the two identical ids collapse to one card
    expect(entries[0]?.publisher).toBe("inference"); // generic "mcp" name → the publisher reads better
    expect(entries[0]?.name).toBe("inference");
    expect(entries[1]?.publisher).toBe("notion");
  });

  it("degrades to nothing on a payload that isn't a server list", () => {
    expect(normalizeServers(null)).toEqual([]);
    expect(normalizeServers({})).toEqual([]);
    expect(normalizeServers("not an object")).toEqual([]);
    expect(normalizeServers({ servers: "not an array" })).toEqual([]);
    expect(normalizeServers({ servers: [{ server: { description: "no name" } }] })).toEqual([]);
  });

  it("treats a present-but-null `server` key as an empty record, not as the old flat shape", () => {
    // Rust's `entry.get("server").is_some()` is TRUE for an explicit null, so
    // the record unwraps to nothing usable — it must not fall back to reading
    // the envelope's own fields, which here would otherwise yield a whole
    // installable card.
    const payload = {
      servers: [
        {
          server: null,
          name: "io.github.should-not/normalize",
          packages: [{ registryType: "npm", identifier: "should-not-install" }],
        },
      ],
    };
    expect(normalizeServers(payload)).toEqual([]);
  });

  it("reads only own record fields and rejects an explicit non-object server", () => {
    const inherited = Object.create({
      name: "io.github.should-not/inherit",
      packages: [{ registryType: "npm", identifier: "should-not-install" }],
    });
    const payload = {
      servers: [
        inherited,
        { server: [{ name: "io.github.should-not/array" }] },
      ],
    };

    expect(normalizeServers(payload)).toEqual([]);
  });

  it("splits namespaces and reads repo ownership case-insensitively", () => {
    expect(splitNamespace("io.github.acme/tool")).toEqual(["acme", "tool"]);
    expect(splitNamespace("com.notion/notion")).toEqual(["notion", "notion"]);
    expect(splitNamespace("bare")).toEqual(["", "bare"]);
    expect(namespaceOwnsRepo("acme", "https://github.com/acme/tool")).toBe(true);
    expect(namespaceOwnsRepo("acme", "https://github.com/ACME/tool")).toBe(true);
    expect(namespaceOwnsRepo("acme", "https://github.com/evil/tool")).toBe(false);
    expect(namespaceOwnsRepo("acme", null)).toBe(false);
    expect(namespaceOwnsRepo("", "https://github.com//tool")).toBe(false);
  });

  it("builds InstallSpecs in the shared apiTypes shape the install drawer reads", () => {
    // The frontend reads `envKeys`/`headerKeys`; a snake_case leak makes them
    // `undefined` and crashes the drawer. The type comes from
    // `../shared/apiTypes.ts` — the same declaration `ipc-contract.ts` types
    // `mcp_registry_search`'s result against — so this pins the payload's field
    // names against the contract itself, not against a local copy of it.
    const http: InstallSpec = { kind: "http", url: "https://x", headerKeys: ["Authorization"] };
    const stdio: InstallSpec = { kind: "stdio", command: "npx", args: ["-y", "x"], envKeys: ["TOKEN"] };
    expect(JSON.parse(JSON.stringify(entryAt(2).install))).toEqual({
      kind: "http",
      url: "https://mcp.notion.com/mcp",
      headerKeys: [],
    });
    expect(Object.keys(http)).toEqual(["kind", "url", "headerKeys"]);
    expect(Object.keys(stdio)).toEqual(["kind", "command", "args", "envKeys"]);
    const installed: InstallSpec = entryAt(0).install;
    expect(installed.kind === "stdio" && installed.envKeys).toEqual([]);
  });
});

// ------------------------------------------------------------------- icons

describe("icon fetching", () => {
  /** A registry record's `icons[].src` is a stranger's string; browsing must not
   * turn it into a GET against this Mac or the user's LAN. */
  it("refuses icon urls pointing inward", () => {
    for (const url of [
      "http://127.0.0.1:11434/api/tags",
      "http://localhost:8080/i.png",
      "http://192.168.1.1/logo.png",
      "http://10.0.0.5/logo.png",
      "http://[::1]/logo.png",
      "http://printer.local/logo.png",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(iconUrlAllowed(url), `should refuse ${url}`).toBe(false);
    }
    expect(iconUrlAllowed("https://icons.example.com/0.png")).toBe(true);
    expect(iconUrlAllowed("http://8.8.8.8/logo.png")).toBe(true);
  });

  it("never opens a connection for an inward icon url", async () => {
    let hits = 0;
    const base = await listenOn((_req, res) => {
      hits += 1;
      res.end();
    });
    const port = new URL(base).port;
    expect(await fetchIcon(`http://127.0.0.1:${port}/logo.png`)).toBeNull();
    expect(hits).toBe(0);
  });

  it("inlines a real image response as a data uri", async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(bytes);
    });
    expect(await fetchIcon(`${base}/pw.png`)).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
  });

  it("refuses a non-image response, an empty body, and a 404", async () => {
    const base = await listenOn((req, res) => {
      if (req.url === "/html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html></html>");
        return;
      }
      if (req.url === "/empty") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    expect(await fetchIcon(`${base}/html`)).toBeNull();
    expect(await fetchIcon(`${base}/empty`)).toBeNull();
    expect(await fetchIcon(`${base}/missing.png`)).toBeNull();
  });

  it("inlines up to the icon's own 300 KB cap, not the smaller preview-image budget", async () => {
    // 250 KB is over `webFetch.ts`'s 200 KB result-preview cap and under the
    // icon cap this file ports from Rust — an icon that size must still inline.
    const base = await listenOn((req, res) => {
      const size = req.url === "/huge.png" ? 300_001 : 250_000;
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.alloc(size, 7));
    });
    expect(await fetchIcon(`${base}/big.png`)).toBe(`data:image/png;base64,${Buffer.alloc(250_000, 7).toString("base64")}`);
    expect(await fetchIcon(`${base}/huge.png`)).toBeNull();
  });

  it("refuses a redirect that lands on a private address", async () => {
    // One hostile listing must not 302 its way to loopback: every hop is
    // re-checked (and re-pinned) by `guardedGet`.
    let hops = 0;
    const base = await listenOn((req, res) => {
      hops += 1;
      if (req.url === "/start.png") {
        res.writeHead(302, { location: "http://127.0.0.1:11434/api/tags" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([9]));
    });
    expect(await fetchIcon(`${base}/start.png`)).toBeNull();
    expect(hops).toBe(1); // the first hop really was made and the redirect really was refused
  });

  it("goes out in bounded waves and never mixes up an entry's icon", async () => {
    // The one place the app contacts many strangers at once: a 200-result browse
    // must not open 200 simultaneous connections to 200 different companies,
    // each of which then sees the user's IP.
    expect(ICON_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(ICON_CONCURRENCY).toBeLessThanOrEqual(8);
    const listings = 3 * ICON_CONCURRENCY + 1; // several full waves and a stub
    const entries = normalizeServers({
      servers: Array.from({ length: listings }, (_, i) => ({
        server: {
          name: `io.example/s${i}`,
          icons: [{ src: `https://icons.example.com/${i}.png` }],
          packages: [{ registryType: "npm", identifier: `s${i}` }],
        },
      })),
    });
    expect(entries).toHaveLength(listings);

    let live = 0;
    let peak = 0;
    await inlineIconsWith(entries, async (url) => {
      live += 1;
      peak = Math.max(peak, live);
      await Promise.resolve(); // stay in flight long enough for the rest of the wave to start
      live -= 1;
      return `data:image/png;${url}`;
    });

    expect(peak).toBe(ICON_CONCURRENCY); // a whole wave goes out together, and never more than one wave
    // Each listing keeps ITS OWN icon: a mis-paired chunk/zip write-back would
    // silently hand every card the wrong company's logo.
    entries.forEach((e, i) => {
      expect(e.icon).toBe(`data:image/png;https://icons.example.com/${i}.png`);
    });
  });

  it("leaves an entry with no icon url alone, without a fetch", async () => {
    const entries = normalizeServers({
      servers: [{ server: { name: "io.example/plain", packages: [{ registryType: "npm", identifier: "plain" }] } }],
    });
    let calls = 0;
    await inlineIconsWith(entries, async () => {
      calls += 1;
      return "data:x";
    });
    expect(calls).toBe(0);
    expect(entries[0]?.icon).toBeNull();
  });
});

// -------------------------------------------------------------- opt-in gate

describe("the per-Mac registry opt-in (real disk I/O)", () => {
  it("defaults to off, turns on, and turns back off by deleting the flag", () => {
    const dir = tempDir();
    expect(mcpRegistryOptinStatus(dir)).toBe(false);

    setMcpRegistryOptin(dir, true);
    expect(readFileSync(mcpRegistryOptinFile(dir), "utf8")).toBe("1"); // the literal byte, not a JSON boolean
    expect(mcpRegistryOptinStatus(dir)).toBe(true);

    setMcpRegistryOptin(dir, false);
    expect(existsSync(mcpRegistryOptinFile(dir))).toBe(false);
    expect(mcpRegistryOptinStatus(dir)).toBe(false);
  });

  it("does not read mcpConfig.ts's own flag format as an opt-in", () => {
    // `writeMcpFlag` stores JSON `true`; this file's gate wants the byte "1", so
    // borrowing that pair would have read one format and written the other.
    const dir = tempDir();
    writeFileSync(mcpRegistryOptinFile(dir), "true");
    expect(mcpRegistryOptinStatus(dir)).toBe(false);
    writeFileSync(mcpRegistryOptinFile(dir), "not-a-1");
    expect(mcpRegistryOptinStatus(dir)).toBe(false);
  });

  it("tolerates surrounding whitespace", () => {
    const dir = tempDir();
    writeFileSync(mcpRegistryOptinFile(dir), "1\n");
    expect(mcpRegistryOptinStatus(dir)).toBe(true);
  });

  it("turning off an already-off gate is a no-op, not a throw", () => {
    const dir = tempDir();
    expect(() => setMcpRegistryOptin(dir, false)).not.toThrow();
    expect(mcpRegistryOptinStatus(dir)).toBe(false);
  });

  it("reports a write failure on enable rather than silently staying off", () => {
    const dir = tempDir();
    const notADir = path.join(dir, "not-a-dir");
    writeFileSync(notADir, "x");
    expect(() => setMcpRegistryOptin(notADir, true)).toThrow();
  });
});

// ------------------------------------------------------------ sendWithRetries

describe("sendWithRetries", () => {
  it("returns the first successful attempt", async () => {
    let calls = 0;
    const fetchFn: RegistryFetchFn = () => {
      calls += 1;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    const resp = await sendWithRetries("https://x", {}, fetchFn);
    expect(resp.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("retries once after a failure and succeeds", async () => {
    let calls = 0;
    const fetchFn: RegistryFetchFn = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("connection reset"));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    expect((await sendWithRetries("https://x", {}, fetchFn)).ok).toBe(true);
    expect(calls).toBe(REGISTRY_ATTEMPTS);
  });

  it("throws the last attempt's error after exhausting REGISTRY_ATTEMPTS", async () => {
    let calls = 0;
    const fetchFn: RegistryFetchFn = () => {
      calls += 1;
      return Promise.reject(new Error(`fail ${calls}`));
    };
    await expect(sendWithRetries("https://x", {}, fetchFn)).rejects.toThrow("fail 2");
    expect(calls).toBe(REGISTRY_ATTEMPTS);
  });

  it("defaults to the real fetch and reads a real server's reply", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ servers: [] }));
    });
    const port = new URL(base).port;
    const resp = await sendWithRetries(`http://127.0.0.1:${port}/`, {});
    expect(resp.ok).toBe(true);
    expect(await resp.json()).toEqual({ servers: [] });
  });

  it("retries a real connection failure and can still succeed on the second attempt", async () => {
    // Nothing listens for the FIRST attempt; the server comes up during the
    // backoff, so it is the RETRY that succeeds against a real socket.
    let served = 0;
    const base = await listenOn((_req, res) => res.end("unused"));
    const port = Number(new URL(base).port);
    const dead = server!;
    server = undefined;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const relisten = new Promise<void>((resolve) => {
      setTimeout(() => {
        server = http.createServer((_req, res) => {
          served += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ servers: [] }));
        });
        server.listen(port, "127.0.0.1", () => resolve());
      }, 50);
    });
    const [resp] = await Promise.all([sendWithRetries(`http://127.0.0.1:${port}/`, {}), relisten]);
    expect(await resp.json()).toEqual({ servers: [] });
    expect(served).toBe(1);
  });
});

// -------------------------------------------------------------------- search

function jsonResponse(status: number, body: unknown): RegistryHttpResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

describe("mcpRegistrySearch", () => {
  const optedInDir = (): string => {
    const dir = tempDir();
    setMcpRegistryOptin(dir, true);
    return dir;
  };

  it("refuses before touching the network when the Mac has not opted in", async () => {
    const fetchFn: RegistryFetchFn = () => Promise.reject(new Error("must not be called"));
    await expect(mcpRegistrySearch(tempDir(), "anything", 10, { fetchFn })).rejects.toThrow(/reaches the internet/);
  });

  it("searches SERVER-SIDE, passing limit and search as query params", async () => {
    let seen = "";
    const fetchFn: RegistryFetchFn = (url) => {
      seen = url;
      return Promise.resolve(jsonResponse(200, sample()));
    };
    const entries = await mcpRegistrySearch(optedInDir(), "playwright", 5, { fetchFn, fetchIconFn: async () => null });
    expect(seen.startsWith(`${REGISTRY_URL}?`)).toBe(true);
    expect(seen).toContain("limit=5");
    expect(seen).toContain("search=playwright");
    expect(entries).toHaveLength(4);
  });

  it("omits the search param for a blank query and clamps the limit", async () => {
    let seen = "";
    const fetchFn: RegistryFetchFn = (url) => {
      seen = url;
      return Promise.resolve(jsonResponse(200, { servers: [] }));
    };
    const dir = optedInDir();
    await mcpRegistrySearch(dir, "   ", 9999, { fetchFn });
    expect(seen).not.toContain("search=");
    expect(seen).toContain("limit=200");

    await mcpRegistrySearch(dir, undefined, undefined, { fetchFn });
    expect(seen).toContain("limit=80"); // no limit → browse the newest 80

    await mcpRegistrySearch(dir, undefined, -5, { fetchFn });
    expect(seen).toContain("limit=0"); // Rust's usize can't go negative; neither can this
  });

  it("explains an exhausted-retry failure instead of leaking the raw error", async () => {
    const fetchFn: RegistryFetchFn = () => Promise.reject(new Error("ECONNRESET"));
    await expect(mcpRegistrySearch(optedInDir(), undefined, undefined, { fetchFn })).rejects.toThrow(
      /did not respond after two attempts \(ECONNRESET\)/
    );
  });

  it("surfaces a non-2xx registry status", async () => {
    const fetchFn: RegistryFetchFn = () => Promise.resolve(jsonResponse(503, {}));
    await expect(mcpRegistrySearch(optedInDir(), undefined, undefined, { fetchFn })).rejects.toThrow(/HTTP 503/);
  });

  it("surfaces an unreadable reply", async () => {
    const fetchFn: RegistryFetchFn = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) });
    await expect(mcpRegistrySearch(optedInDir(), undefined, undefined, { fetchFn })).rejects.toThrow(
      /couldn't read: bad json/
    );
  });

  it("inlines each listing's own icon", async () => {
    const fetchFn: RegistryFetchFn = () => Promise.resolve(jsonResponse(200, sample()));
    const seen: string[] = [];
    const entries = await mcpRegistrySearch(optedInDir(), undefined, undefined, {
      fetchFn,
      fetchIconFn: async (url) => {
        seen.push(url);
        return `data:image/png;${url}`;
      },
    });
    expect(seen).toEqual(["https://ex.com/pw.png"]); // the only listing with an icon url
    expect(entries[0]?.icon).toBe("data:image/png;https://ex.com/pw.png");
    expect(entries[1]?.icon).toBeNull();
  });
});
