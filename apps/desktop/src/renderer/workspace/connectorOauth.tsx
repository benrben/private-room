import { useEffect, useRef, useState } from "react";
import { api } from "../api";

/** OAuth belongs to an INSTALLED remote connector, not to the marketplace
 * drawer it may have come from. A connector pasted under Advanced (including
 * Datadog's official remote MCP URL) never had a marketplace drawer to reopen,
 * so its failed card used to offer only retry/remove even when the missing step
 * was explicitly an OAuth sign-in (GH #33). Keep the account door on the card
 * that owns the live connection state. */
export function RemoteOauthControls({ server }: { server: string }) {
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [authUrl, setAuthUrl] = useState("");
  const [error, setError] = useState("");
  // Cancelling stops this surface waiting; the backend's bounded OAuth attempt
  // is deliberately allowed to time out without writing anything.
  const authRun = useRef(0);

  useEffect(() => {
    let live = true;
    void api
      .mcpOauthStatus(server)
      .then((value) => live && setSignedIn(value))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [server]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let live = true;
    void api.onMcpOauthUrl((event) => {
      if (live && event.server === server) setAuthUrl(event.url);
    }).then((un) => {
      if (live) unlisten = un;
      else un();
    });
    return () => {
      live = false;
      unlisten?.();
    };
  }, [server]);

  async function connectAccount() {
    const run = ++authRun.current;
    setBusy(true);
    setAuthUrl("");
    setError("");
    try {
      await api.mcpOauthAuthorize(server);
      if (authRun.current === run) setSignedIn(true);
    } catch (e) {
      if (authRun.current === run) setError(String(e));
    } finally {
      if (authRun.current === run) setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      await api.mcpOauthSignOut(server);
    } catch (e) {
      setError(String(e));
    } finally {
      setSignedIn(await api.mcpOauthStatus(server).catch(() => false));
      setBusy(false);
    }
  }

  function cancel() {
    authRun.current += 1;
    setBusy(false);
    setAuthUrl("");
  }

  return (
    <div className="conn-oauth">
      <OauthPrimaryButton busy={busy} signedIn={signedIn} onConnect={() => void connectAccount()} />
      <OauthSignOutButton busy={busy} signedIn={signedIn} onSignOut={() => void signOut()} />
      <OauthBusyPrompt busy={busy} onCancel={cancel} />
      <OauthSignInLink busy={busy} authUrl={authUrl} />
      <OauthError error={error} />
    </div>
  );
}

function OauthPrimaryButton({ busy, signedIn, onConnect }: {
  busy: boolean;
  signedIn: boolean;
  onConnect: () => void;
}) {
  const text = signedIn
    ? "Account connected"
    : busy
      ? "Waiting for your browser…"
      : "Connect account (sign in)";
  return (
    <button
      className="btn-ic conn-oauth-connect"
      disabled={busy || signedIn}
      onClick={onConnect}
    >
      {text}
    </button>
  );
}

function OauthSignOutButton({ busy, signedIn, onSignOut }: {
  busy: boolean;
  signedIn: boolean;
  onSignOut: () => void;
}) {
  if (!signedIn) return null;
  return (
    <button
      className="btn-ic"
      disabled={busy}
      onClick={onSignOut}
      title="Forget this connector's saved sign-in and remove its token from this room"
    >
      Sign out
    </button>
  );
}

function OauthBusyPrompt({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  if (!busy) return null;
  return (
    <>
      <span className="conn-oauth-hint">
        Finish sign-in in your browser. Arcelle will reconnect this connector automatically.
      </span>
      <button className="btn-ic" onClick={onCancel}>Cancel</button>
    </>
  );
}

function OauthSignInLink({ busy, authUrl }: { busy: boolean; authUrl: string }) {
  if (!busy || !authUrl) return null;
  return (
    <a className="mkt-repo" href={authUrl} target="_blank" rel="noreferrer">
      Open sign-in page ↗
    </a>
  );
}

function OauthError({ error }: { error: string }) {
  if (!error) return null;
  return <p className="gate-error" role="alert">{error}</p>;
}
