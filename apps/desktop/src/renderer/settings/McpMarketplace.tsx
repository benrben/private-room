import {
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import type { CatalogEntry, InstallSpec, McpServerStatus, RuntimeStatus } from "../api";
import { hostOf, isUsableEndpoint } from "./marketplaceText";
import { MarketplaceControls, MarketplaceGate, MarketplaceGrid, MarketplaceStatus, needsKey } from "./McpMarketplaceChrome";
import { InstallDrawerContext, type InstallDrawerModel } from "./McpInstallContext";
import { InstallDrawerSurface } from "./McpInstallDrawerView";

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
    return <MarketplaceGate error={error} onTurnOn={() => void turnOn()} />;
  }

  // The opt-in answer has not come back yet: say nothing rather than render an
  // empty grid that reads as "the registry has no connectors".
  if (optedIn === null) {
    return <p className="mkt-status">Checking…</p>;
  }

  const shown = entries.filter(
    (e) =>
      (!verifiedOnly || e.verified) &&
      (!localOnly || !e.remote) &&
      (!noKeyOnly || !needsKey(e)),
  );
  const hidden = entries.length - shown.length;

  return (
    <div className="mkt">
      <MarketplaceControls
        localOnly={localOnly}
        noKeyOnly={noKeyOnly}
        query={query}
        verifiedOnly={verifiedOnly}
        onLocalOnly={setLocalOnly}
        onNoKeyOnly={setNoKeyOnly}
        onQuery={setQuery}
        onTurnOff={() => void turnOff()}
        onVerifiedOnly={setVerifiedOnly}
      />
      <MarketplaceStatus
        entries={entries}
        error={error}
        hidden={hidden}
        loading={loading}
        query={query}
        searched={searched}
        shown={shown}
        onRetry={() => void search(query)}
      />
      <MarketplaceGrid installedNames={installedNames} shown={shown} onSelect={setSelected} />
      <MarketplaceDrawer
        installServer={installServer}
        installedNames={installedNames}
        selected={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function MarketplaceDrawer({
  installServer,
  installedNames,
  selected,
  onClose,
}: {
  installServer: Props["installServer"];
  installedNames: string[];
  selected: CatalogEntry | null;
  onClose: () => void;
}) {
  if (!selected) return null;
  return <InstallDrawer entry={selected} installed={installedNames.includes(selected.name)} onClose={onClose} installServer={installServer} />;
}

// --------------------------------------------------------------- install drawer

function selectedInstallSpec(entry: CatalogEntry, useCloud: boolean): InstallSpec {
  if (useCloud && entry.altInstall) return entry.altInstall;
  return entry.install;
}

function installSecretKeys(spec: InstallSpec): string[] {
  return spec.kind === "stdio" ? spec.envKeys : spec.headerKeys;
}

function installCommand(spec: InstallSpec): string {
  return spec.kind === "stdio" ? spec.command : "";
}

function installEndpointDetails(spec: InstallSpec) {
  if (spec.kind !== "http") return { host: "", badEndpoint: false };
  return { host: hostOf(spec.url), badEndpoint: !isUsableEndpoint(spec.url) };
}

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
  const spec = selectedInstallSpec(entry, useCloud);
  const isRemote = spec.kind === "http";
  const secretKeys = installSecretKeys(spec);
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
  // What the connector itself reports once it has been added. Installing only
  // writes JSON and asks Rust to spawn; the drawer used to show a green tick for
  // that and sit over the Installed list, which is the only place a missing
  // program or a refusing endpoint is ever shown. `null` = nothing reported yet.
  const [connStatus, setConnStatus] = useState<McpServerStatus | null>(null);
  // What the two connector powers say RIGHT NOW. The cloud note below used to
  // promise redaction and a second ask flatly, at the exact moment the user
  // decides whether to install something that reaches the internet — and either
  // switch being on makes that promise false. `null` is "not answered yet" and
  // is never rendered as either answer.
  const [autoApprove, setAutoApprove] = useState<boolean | null>(null);
  const [outboundUnmask, setOutboundUnmask] = useState<boolean | null>(null);
  useEffect(() => {
    if (!isRemote) return;
    let live = true;
    api
      .getMcpAutoApprove()
      .then((v) => live && setAutoApprove(v))
      .catch(() => {});
    api
      .getMcpOutboundUnmask()
      .then((v) => live && setOutboundUnmask(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [isRemote]);

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
  const command = installCommand(spec);
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

  // `mcp_apply_config` answers with the statuses as they stand the instant it
  // spawns — almost always "connecting". Keep listening so what the drawer says
  // is where the connector ENDED up, not where it started.
  useEffect(() => {
    if (!done) return;
    let alive = true;
    let un: (() => void) | undefined;
    // Also asked outright, so reopening the drawer on a connector installed
    // earlier reads its state now instead of waiting for it to change.
    api
      .mcpStatus()
      .then((all) => alive && setConnStatus(all.find((s) => s.name === entry.name) ?? null))
      .catch(() => {});
    api
      .onMcpStatus((all) => setConnStatus(all.find((s) => s.name === entry.name) ?? null))
      .then((u) => {
        // A drawer closed while the subscription was still being set up would
        // otherwise leave it listening for the life of the app.
        if (alive) un = u;
        else u();
      });
    return () => {
      alive = false;
      un?.();
    };
  }, [done, entry.name]);

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
      const statuses = await installServer(entry.name, specToEntry(spec, secrets));
      setConnStatus(statuses.find((s) => s.name === entry.name) ?? null);
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
  const { host, badEndpoint } = installEndpointDetails(spec);

  const model: InstallDrawerModel = {
    authBusy,
    authUrl,
    autoApprove,
    badEndpoint,
    busy,
    confirming,
    connStatus,
    copied,
    done,
    entry,
    err,
    host,
    isRemote,
    outboundUnmask,
    runtime,
    runtimeBusy,
    runtimePct,
    secretKeys,
    secrets,
    signedIn,
    spec,
    useCloud,
    onClose,
    onCancelOauth: cancelOauth,
    onConfirming: setConfirming,
    onDoInstall: () => void doInstall(),
    onDoOauth: () => void doOauth(),
    onDoProvision: () => void doProvision(),
    onDoSignOut: () => void doSignOut(),
    onSecrets: setSecrets,
    onUseCloud: setUseCloud,
    onCopied: setCopied,
  };

  return (
    <InstallDrawerContext.Provider value={model}>
      <InstallDrawerSurface />
    </InstallDrawerContext.Provider>
  );
}

// -------------------------------------------------------------------- icons
// Decorative throughout: every one of these sits beside a word that says the
// same thing, so all of them are aria-hidden and none reaches a screen reader.
