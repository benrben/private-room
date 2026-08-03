import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { CatalogEntry, InstallSpec, McpServerStatus, RuntimeStatus } from "../api";
import { CircleCheckIcon } from "../icons";
import { hostOf, initials, isUsableEndpoint } from "./marketplaceText";

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
  // Has a fetch ever COMPLETED? Without this the page said "No connectors match
  // that. Try clearing a filter." before it had started fetching — while the
  // opt-in status was still being read, and again through the 250 ms debounce —
  // sending the user hunting for a filter to turn off when nothing was wrong.
  const [searched, setSearched] = useState(false);
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
      setSearched(true);
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

  /** Put the app back to air-gapped. Browsing the catalogue is the one time
   * Arcelle reaches out on its own, and an opt-in with no way back is not a
   * choice — it was a one-way door, with nothing anywhere in the app to close
   * it. Clears what was already fetched too, so the page does not keep showing
   * a catalogue it is no longer allowed to refresh. */
  async function turnOff() {
    setError("");
    try {
      await api.setMcpRegistryOptin(false);
      setEntries([]);
      setSearched(false);
      setSelected(null);
      setOptedIn(false);
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
            before anything runs, and you can turn browsing back off at any time.
          </p>
          <button className="primary" onClick={turnOn}>
            Turn on registry browsing
          </button>
          {error && <div className="gate-error">{error}</div>}
        </div>
      </div>
    );
  }

  // The opt-in answer has not come back yet: say nothing rather than render an
  // empty grid that reads as "the registry has no connectors".
  if (optedIn === null) {
    return <div className="settings-hint mkt-status">Checking…</div>;
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
          {/* The way back out of the one outbound feature in the app. */}
          <button
            type="button"
            className="subtle mkt-optout"
            title="Stop Arcelle fetching the public connector registry"
            onClick={() => void turnOff()}
          >
            Turn off browsing
          </button>
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
      {/* Only once a fetch has actually come back is an empty grid a fact about
          the catalogue rather than about the app not having asked yet. */}
      {!loading && !error && searched && shown.length === 0 && (
        <div className="settings-hint mkt-status">
          {entries.length === 0
            ? "The registry returned nothing for that search."
            : "No connectors match that. Try clearing a filter."}
        </div>
      )}
      {!loading && !error && !searched && (
        <div className="settings-hint mkt-status">Fetching the catalog…</div>
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
  // The panel promised "You'll be asked before it starts" and nothing asked:
  // Install wrote the config, recorded the approval and launched the program in
  // one click. This is that ask — an explicit second step naming what runs.
  const [confirming, setConfirming] = useState(false);
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
  // A local connector runs through `uvx` or `npx`. On a Mac without them the
  // install used to "succeed" and the connector then failed with the launcher's
  // raw "No such file or directory" and no way to fix it from inside the app.
  // `null` means "not asked yet" — never rendered as "it's fine".
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimePct, setRuntimePct] = useState(0);

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

  // Ask about the command this connector actually needs, whenever it changes
  // (the local/cloud toggle swaps the whole spec).
  const command = spec.kind === "stdio" ? spec.command : "";
  useEffect(() => {
    if (!command) {
      setRuntime(null);
      return;
    }
    let live = true;
    api
      .mcpRuntimeForCommand(command)
      .then((r) => live && setRuntime(r))
      // An unanswered question stays unanswered: showing nothing is honest,
      // claiming "ready" is not.
      .catch(() => live && setRuntime(null));
    return () => {
      live = false;
    };
  }, [command, runtimeBusy]);

  useEffect(() => {
    let un: (() => void) | undefined;
    api
      .onRuntimeProgress((p) => {
        setRuntimePct(p.total > 0 ? Math.round((p.got / p.total) * 100) : 0);
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, []);

  async function doProvision() {
    if (!runtime?.kind) return;
    setRuntimeBusy(true);
    setErr("");
    setRuntimePct(0);
    try {
      await api.mcpProvisionRuntime(runtime.kind);
    } catch (e) {
      setErr(String(e));
    } finally {
      setRuntimeBusy(false);
    }
  }

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
      setConfirming(false);
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

  /** AUDIT 506: hand the saved sign-in back.
   *
   * `mcp_oauth_sign_out` has worked the whole time — it clears the stored token
   * AND strips the bearer header — but nothing on screen called it, so the
   * drawer said "Signed in" forever and the only way to drop a connector's
   * account was to delete the connector and set it up again from scratch.
   * `signedIn` is re-read from the backend rather than assumed, so a sign-out
   * that failed cannot leave the button telling the user it worked. */
  async function doSignOut() {
    setAuthBusy(true);
    setErr("");
    try {
      await api.mcpOauthSignOut(entry.name);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSignedIn(await api.mcpOauthStatus(entry.name).catch(() => false));
      setAuthBusy(false);
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

  // NEVER `new URL(...)` bare here: these addresses come straight off the public
  // registry unchecked, and one entry missing its "https://" threw during render
  // and took the whole app window blank.
  const host = spec.kind === "http" ? hostOf(spec.url) : "";
  const badEndpoint = spec.kind === "http" && !isUsableEndpoint(spec.url);

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
                <b>{host || "an address this catalogue entry did not spell out"}</b>.
                Arcelle redacts sensitive spans first and asks again the moment
                data is about to leave.
              </div>
            </div>
          ) : (
            <div className="mkt-wall safe">
              {ICON.shield}
              <div>
                <b>Runs on your Mac.</b> Arcelle starts{" "}
                <b>{spec.kind === "stdio" ? spec.command : ""}</b> as a local
                program — it only reaches the internet if the tool itself makes a
                request. You confirm below before it starts.
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
            {badEndpoint && (
              <div className="gate-error">
                This registry entry's address is not a usable http(s) URL, so
                connecting to it could only fail. Nothing was installed.
              </div>
            )}
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
                    {/* Masked like the AI-provider key box beside it. The
                        Connectors screen is not fenced off from the app-driving
                        agent's "look at the screen" step, so a key shown in the
                        clear is a key it can read half-way through being typed. */}
                    <input
                      type="password"
                      autoComplete="off"
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
          {/* Only when we ASKED and the answer was "it cannot run". A missing
              answer shows nothing rather than a reassurance we do not have. */}
          {runtime && !runtime.available && (
            <div className="mkt-wall warn" role="status">
              {ICON.warn}
              <div>
                {runtime.note}
                {runtime.provisionable && (
                  <>
                    {" "}
                    <button
                      className="subtle"
                      disabled={runtimeBusy}
                      onClick={() => void doProvision()}
                    >
                      {runtimeBusy
                        ? `Downloading… ${runtimePct}%`
                        : `Download ${runtime.kind} for me`}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {err && <div className="gate-error">{err}</div>}
        </div>

        <div className="mkt-dr-foot">
          {confirming && !done && (
            <div className="mkt-wall warn mkt-confirm" role="alert">
              {ICON.warn}
              <div>
                {isRemote ? (
                  <>
                    <b>Connect to {host || "this endpoint"} now?</b> Arcelle will
                    add it to this room and start talking to it straight away.
                  </>
                ) : (
                  <>
                    <b>Start this program on your Mac now?</b> Arcelle will run{" "}
                    <code>{spec.kind === "stdio" ? spec.command : ""}</code> as
                    soon as you confirm.
                  </>
                )}{" "}
                Applying also (re)starts every other enabled connector in this
                room — including any you have not approved before.
              </div>
            </div>
          )}
          <button
            className={`primary mkt-install btn-ic ${isRemote ? "remote" : ""}`}
            disabled={busy || done || badEndpoint}
            onClick={() => (confirming ? void doInstall() : setConfirming(true))}
          >
            {done
              ? (<><CircleCheckIcon size={13} /> Installed</>)
              : busy
                ? "Installing…"
                : confirming
                  ? isRemote
                    ? "Yes, connect now"
                    : "Yes, start it now"
                  : isRemote
                    ? "Review & connect"
                    : "Install to this room"}
          </button>
          {confirming && !done && !busy && (
            <button className="subtle" onClick={() => setConfirming(false)}>
              Not now
            </button>
          )}
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
              {/* AUDIT 506: the way back out. Without it the panel said
                  "Signed in" forever and dropping a saved account meant
                  deleting the whole connector and setting it up again. */}
              {signedIn && (
                <button
                  className="btn-ic mkt-oauth-signout"
                  disabled={authBusy}
                  onClick={doSignOut}
                  title="Forget this connector's saved sign-in and remove its token from this room"
                >
                  Sign out
                </button>
              )}
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
              : "Added to this room only · you confirm before it runs"}
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
