import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { CatalogEntry, InstallSpec, McpServerStatus } from "../api";
import { CircleCheckIcon } from "../icons";

interface Props {
  /** Merge a server entry into the room's mcpServers config and apply it
   * (routes through mcp_apply_config → SEC-1 approval). */
  installServer: (
    name: string,
    entry: Record<string, unknown>,
  ) => Promise<McpServerStatus[]>;
  /** Names already present in the room's config, so a card can read "Installed". */
  installedNames: string[];
}

/** Turn a registry InstallSpec + any secrets the user filled in into the
 * mcpServers entry that gets written to the config. Remote → {type,url,headers};
 * local → {command,args,env}. Empty secrets are omitted so we never write blanks. */
function specToEntry(
  spec: InstallSpec,
  secrets: Record<string, string>,
): Record<string, unknown> {
  const nonEmpty = (keys: string[]) =>
    Object.fromEntries(
      keys.map((k) => [k, (secrets[k] ?? "").trim()]).filter(([, v]) => v !== ""),
    );
  if (spec.kind === "stdio") {
    const env = nonEmpty(spec.envKeys);
    const entry: Record<string, unknown> = { command: spec.command, args: spec.args };
    if (Object.keys(env).length) entry.env = env;
    return entry;
  }
  const headers = nonEmpty(spec.headerKeys);
  const entry: Record<string, unknown> = { type: "http", url: spec.url };
  if (Object.keys(headers).length) entry.headers = headers;
  return entry;
}

const initials = (n: string) =>
  n
    .replace(/[^A-Za-z0-9 ]/g, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

/** A deterministic hue per publisher, so a card's monogram is stable. */
const hueFor = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 55%)`;
};

/** The registry's real title when it has one, else the slug name. */
const label = (e: CatalogEntry) => e.title || e.name;

/** True when an entry needs an API key/token to set up — its install spec
 * declares env vars (local) or auth headers (remote) the user must fill in.
 * Drives the "No API key" filter. (OAuth-only remote servers declare no header,
 * so they read as key-free — sign-in is a separate step.) */
const needsKey = (e: CatalogEntry) =>
  (e.install.kind === "stdio" ? e.install.envKeys : e.install.headerKeys).length > 0;

/** A server's real icon (backend-inlined data URI) when present, else a colored
 * monogram tile. Only ~1 in 12 registry servers ship an icon, so the monogram
 * is the common case. */
function Mono({ entry, lg }: { entry: CatalogEntry; lg?: boolean }) {
  const cls = `mkt-mono${lg ? " lg" : ""}`;
  if (entry.icon) return <img className={cls} src={entry.icon} alt="" />;
  return (
    <span
      className={cls}
      style={{
        background: `linear-gradient(145deg, ${hueFor(entry.publisher)}, color-mix(in srgb, ${hueFor(entry.publisher)} 62%, #000))`,
      }}
    >
      {initials(label(entry))}
    </span>
  );
}

export default function McpMarketplace({ installServer, installedNames }: Props) {
  const [optedIn, setOptedIn] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);
  const [noKeyOnly, setNoKeyOnly] = useState(false);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.mcpRegistryOptinStatus().then(setOptedIn).catch(() => setOptedIn(false));
  }, []);

  // Fetch (debounced) whenever the query changes and browsing is on.
  useEffect(() => {
    if (!optedIn) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void search(query), 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, optedIn]);

  async function search(q: string) {
    setLoading(true);
    setError("");
    try {
      setEntries(await api.mcpRegistrySearch(q || undefined, 80));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function turnOn() {
    setError("");
    try {
      await api.setMcpRegistryOptin(true);
      setOptedIn(true);
    } catch (e) {
      setError(String(e));
    }
  }

  // --- Opt-in gate: the marketplace's fetch is the app's one outbound call. ---
  if (optedIn === false) {
    return (
      <div className="mkt-gate">
        <div className="mkt-gate-icon" aria-hidden>
          {ICON.globe}
        </div>
        <div>
          <strong>Browse the connector marketplace</strong>
          <p className="settings-hint">
            To list connectors, Arcelle fetches the public MCP registry over
            the internet — the one time it reaches out on its own. Nothing from
            your room is sent; only the catalog comes back. Installing still asks
            before anything runs.
          </p>
          <button className="primary" onClick={turnOn}>
            Turn on registry browsing
          </button>
          {error && <div className="gate-error">{error}</div>}
        </div>
      </div>
    );
  }

  const shown = entries.filter(
    (e) =>
      (!verifiedOnly || e.verified) &&
      (!localOnly || !e.remote) &&
      (!noKeyOnly || !needsKey(e)),
  );

  return (
    <div className="mkt">
      <div className="mkt-controls">
        <div className="mkt-search">
          {ICON.search}
          <input
            type="text"
            placeholder="Search the marketplace — “search”, “github”, “postgres”…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.stopPropagation();
            }}
          />
        </div>
        <div className="mkt-toggles">
          <label className="mkt-tgl" title="Publishers that own their namespace">
            <input
              type="checkbox"
              checked={verifiedOnly}
              onChange={(e) => setVerifiedOnly(e.target.checked)}
            />
            <span className="mkt-sw" /> Verified
          </label>
          <label className="mkt-tgl" title="Hide connectors that reach the internet">
            <input
              type="checkbox"
              checked={localOnly}
              onChange={(e) => setLocalOnly(e.target.checked)}
            />
            <span className="mkt-sw" /> Local only
          </label>
          <label className="mkt-tgl" title="Hide connectors that need an API key or token to set up">
            <input
              type="checkbox"
              checked={noKeyOnly}
              onChange={(e) => setNoKeyOnly(e.target.checked)}
            />
            <span className="mkt-sw" /> No API key
          </label>
        </div>
      </div>

      {error && (
        <div className="gate-error mkt-error">
          <span>{error}</span>
          <button className="btn-ic" onClick={() => void search(query)} disabled={loading}>
            {loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {loading && !error && (
        <div className="settings-hint mkt-status">Fetching the catalog…</div>
      )}
      {!loading && !error && shown.length === 0 && (
        <div className="settings-hint mkt-status">
          No connectors match that. Try clearing a filter.
        </div>
      )}

      <div className="mkt-grid">
        {shown.map((e) => {
          const installed = installedNames.includes(e.name);
          return (
            <button
              key={e.id}
              className="mkt-card"
              onClick={() => setSelected(e)}
              aria-label={`${label(e)} by ${e.publisher}`}
            >
              <div className="mkt-card-head">
                <Mono entry={e} />
                <span className="mkt-id">
                  <span className="mkt-name">
                    {label(e)}
                    {e.verified && (
                      <span className="mkt-verified" title="Verified publisher">
                        {ICON.check}
                      </span>
                    )}
                  </span>
                  <span className="mkt-pub">{e.publisher || "community"}</span>
                </span>
              </div>
              <p className="mkt-desc">{e.description}</p>
              <div className="mkt-badges">
                {e.remote ? (
                  <span className="mkt-badge remote">{ICON.cloud} Remote · reaches internet</span>
                ) : (
                  <span className="mkt-badge local">{ICON.mac} Local · on your Mac</span>
                )}
                <span className="mkt-badge plain">{e.transport}</span>
                {installed && <span className="mkt-badge installed">Installed</span>}
              </div>
            </button>
          );
        })}
      </div>

      {selected && (
        <InstallDrawer
          entry={selected}
          installed={installedNames.includes(selected.name)}
          onClose={() => setSelected(null)}
          installServer={installServer}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------- install drawer

function InstallDrawer({
  entry,
  installed,
  onClose,
  installServer,
}: {
  entry: CatalogEntry;
  installed: boolean;
  onClose: () => void;
  installServer: Props["installServer"];
}) {
  // When a connector offers both, `install` is the local default and
  // `altInstall` is the cloud version; the user can switch between them.
  const [useCloud, setUseCloud] = useState(false);
  const spec = useCloud && entry.altInstall ? entry.altInstall : entry.install;
  const isRemote = spec.kind === "http";
  const secretKeys = spec.kind === "stdio" ? spec.envKeys : spec.headerKeys;
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(installed);
  // OAuth (remote only): whether a token is stored, and whether sign-in is busy.
  const [signedIn, setSignedIn] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  // The authorize URL, emitted when sign-in reaches the browser step — shown as
  // a manual open/copy fallback if the system browser doesn't come up on its own.
  const [authUrl, setAuthUrl] = useState("");
  const [copied, setCopied] = useState(false);
  // Bumped to orphan an in-flight sign-in the user gave up on, so a stuck
  // browser round-trip never traps the drawer on a spinner.
  const authRun = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (isRemote && done) {
      api.mcpOauthStatus(entry.name).then(setSignedIn).catch(() => {});
    }
  }, [isRemote, entry.name, done]);

  // The sign-in URL arrives once discovery + client registration succeed, just
  // before the browser is asked to open — capture it for this connector.
  useEffect(() => {
    if (!isRemote) return;
    let un: (() => void) | undefined;
    api
      .onMcpOauthUrl((p) => {
        if (p.server === entry.name) setAuthUrl(p.url);
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [isRemote, entry.name]);

  async function doInstall() {
    setBusy(true);
    setErr("");
    try {
      await installServer(entry.name, specToEntry(spec, secrets));
      setDone(true);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doOauth() {
    const run = ++authRun.current;
    setAuthBusy(true);
    setErr("");
    setAuthUrl("");
    setCopied(false);
    try {
      await api.mcpOauthAuthorize(entry.name);
      if (authRun.current === run) setSignedIn(true);
    } catch (e) {
      if (authRun.current === run) setErr(String(e));
    } finally {
      if (authRun.current === run) setAuthBusy(false);
    }
  }

  /** Stop *waiting* on a sign-in that isn't coming back (a non-standard OAuth
   * server, or the browser was closed). The backend attempt is orphaned — it
   * times out on its own — so the UI is never trapped on the spinner. */
  function cancelOauth() {
    authRun.current++;
    setAuthBusy(false);
    setAuthUrl("");
  }

  const host = spec.kind === "http" ? new URL(spec.url).host : "";

  return (
    <div className="mkt-scrim" onClick={onClose}>
      <aside
        className="mkt-drawer"
        onClick={(e) => e.stopPropagation()}
        aria-label={`${label(entry)} details`}
      >
        <div className="mkt-dr-head">
          <Mono entry={entry} lg />
          <div className="mkt-dr-id">
            <div className="mkt-dr-name">
              {label(entry)}
              {entry.verified && (
                <span className="mkt-verified" title="Verified publisher">
                  {ICON.check}
                </span>
              )}
            </div>
            <div className="mkt-pub">
              {entry.publisher || "community"}
              {entry.verified ? " · verified publisher" : ""}
            </div>
          </div>
          <button className="mkt-dr-x" onClick={onClose} aria-label="Close">
            {ICON.x}
          </button>
        </div>

        <div className="mkt-dr-body">
          <p className="mkt-dr-desc">{entry.description}</p>

          {entry.altInstall && (
            <div className="mkt-transport" role="group" aria-label="How to run this connector">
              <button
                type="button"
                className={`mkt-tp-opt ${!useCloud ? "on" : ""}`}
                onClick={() => setUseCloud(false)}
              >
                {ICON.mac}
                <span>
                  <b>Run locally</b>
                  <small>on your Mac · private</small>
                </span>
              </button>
              <button
                type="button"
                className={`mkt-tp-opt ${useCloud ? "on" : ""}`}
                onClick={() => setUseCloud(true)}
              >
                {ICON.cloud}
                <span>
                  <b>Use cloud</b>
                  <small>hosted · reaches internet</small>
                </span>
              </button>
            </div>
          )}

          {isRemote ? (
            <div className="mkt-wall warn">
              {ICON.warn}
              <div>
                <b>This connector runs in the cloud.</b> When the assistant calls
                it, your prompt and the tool's arguments leave your Mac and reach{" "}
                <b>{host}</b>. Arcelle redacts sensitive spans first and asks
                again the moment data is about to leave.
              </div>
            </div>
          ) : (
            <div className="mkt-wall safe">
              {ICON.shield}
              <div>
                <b>Runs on your Mac.</b> Arcelle starts{" "}
                <b>{spec.kind === "stdio" ? spec.command : ""}</b> as a local
                program — it only reaches the internet if the tool itself makes a
                request. You'll be asked before it starts.
              </div>
            </div>
          )}

          <div>
            <div className="mkt-label">
              {isRemote ? "Endpoint" : "Command that will run"}
            </div>
            <div className="mkt-code">
              {spec.kind === "http"
                ? spec.url
                : `${spec.command} ${spec.args.join(" ")}`}
            </div>
          </div>

          {secretKeys.length > 0 && (
            <div>
              <div className="mkt-label">
                {spec.kind === "stdio" ? "Settings" : "Auth headers"}
              </div>
              <div className="mkt-fields">
                {secretKeys.map((k) => (
                  <label key={k} className="mkt-field">
                    <span>{k}</span>
                    <input
                      type="text"
                      spellCheck={false}
                      value={secrets[k] ?? ""}
                      placeholder={
                        spec.kind === "http" ? "Bearer …" : `value for ${k}`
                      }
                      onChange={(ev) =>
                        setSecrets((s) => ({ ...s, [k]: ev.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          {entry.repository && (
            <a
              className="mkt-repo"
              href={entry.repository}
              target="_blank"
              rel="noreferrer"
            >
              View source ↗
            </a>
          )}
          {err && <div className="gate-error">{err}</div>}
        </div>

        <div className="mkt-dr-foot">
          <button
            className={`primary mkt-install btn-ic ${isRemote ? "remote" : ""}`}
            disabled={busy || done}
            onClick={doInstall}
          >
            {done
              ? (<><CircleCheckIcon size={13} /> Installed</>)
              : busy
                ? "Installing…"
                : isRemote
                  ? "Review & connect"
                  : "Install to this room"}
          </button>
          {isRemote && done && (
            <div className="mkt-oauth">
              <button
                className="primary mkt-install btn-ic"
                disabled={authBusy || signedIn}
                onClick={doOauth}
              >
                {signedIn
                  ? (<><CircleCheckIcon size={13} /> Signed in</>)
                  : authBusy
                    ? "Waiting for your browser…"
                    : "Connect account (sign in)"}
              </button>
              {authBusy && (
                <div className="mkt-oauth-wait">
                  <span className="settings-hint">
                    A browser tab should have opened — finish sign-in there. If
                    this connector doesn't support in-app sign-in, cancel and add
                    its token under Auth headers instead.
                  </span>
                  <button className="btn-ic mkt-oauth-cancel" onClick={cancelOauth}>
                    Cancel
                  </button>
                </div>
              )}
              {authBusy && authUrl && (
                <div className="mkt-oauth-manual">
                  <span className="settings-hint">Didn't open?</span>
                  <a
                    className="mkt-repo"
                    href={authUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open sign-in page ↗
                  </a>
                  <button
                    className="btn-ic"
                    onClick={() => {
                      navigator.clipboard?.writeText(authUrl).then(
                        () => setCopied(true),
                        () => {},
                      );
                    }}
                  >
                    {copied ? "Copied" : "Copy link"}
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="mkt-dr-note">
            {isRemote
              ? "Added to this room only · sign-in opens your browser"
              : "Added to this room only · you approve before it runs"}
          </div>
        </div>
      </aside>
    </div>
  );
}

// -------------------------------------------------------------------- icons
const ICON = {
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <circle cx="12" cy="12" r="9" fill="currentColor" opacity=".14" stroke="none" />
      <path d="M8 12.5l2.5 2.5 5-5.5" />
    </svg>
  ),
  cloud: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9.5 3.5 3.5 0 0 1 17.5 18z" />
    </svg>
  ),
  mac: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  ),
  warn: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M12 3l9.5 16.5H2.5z" />
      <path d="M12 10v4M12 17.5v.5" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  globe: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
};
