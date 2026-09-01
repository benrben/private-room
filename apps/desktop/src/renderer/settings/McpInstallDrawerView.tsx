import type { Dispatch, SetStateAction } from "react";
import type { McpServerStatus } from "../api";
import { CircleCheckIcon } from "../icons";
import { useInstallDrawer } from "./McpInstallContext";
import { MARKETPLACE_ICON as ICON } from "./marketplaceIcons";
import { label, Mono } from "./McpMarketplaceChrome";

export function InstallDrawerSurface() {
  const { entry, onClose } = useInstallDrawer();
  return (
    <div className="mkt-scrim" onClick={onClose}>
      <aside
        className="mkt-drawer"
        onClick={(event) => event.stopPropagation()}
        aria-label={`${label(entry)} details`}
      >
        <InstallDrawerHeader />
        <div className="mkt-dr-body">
          <InstallDrawerBody />
        </div>
        <InstallDrawerFooter />
      </aside>
    </div>
  );
}

function InstallDrawerHeader() {
  const { entry, isRemote, secretKeys, spec, onClose } = useInstallDrawer();
  return (
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
        <div className="mkt-dr-badges">
          <InstallTransportBadge remote={isRemote} />
          {secretKeys.length > 0 && (
            <span className="nb-tape mkt-badge nb-sem-saved">
              {ICON.key} Needs a key
            </span>
          )}
          <span className="mkt-badge mkt-badge-plain">{spec.kind}</span>
        </div>
      </div>
      <button className="mkt-dr-x" onClick={onClose} aria-label="Close">
        {ICON.x}
      </button>
    </div>
  );
}

function InstallTransportBadge({ remote }: { remote: boolean }) {
  if (remote) {
    return (
      <span className="nb-tape mkt-badge nb-sem-pending">
        {ICON.cloud} Remote · reaches internet
      </span>
    );
  }
  return (
    <span className="nb-tape mkt-badge nb-sem-done">
      {ICON.mac} Local · on your Mac
    </span>
  );
}

function InstallTransportPicker({
  hasAlternative,
  useCloud,
  onUseCloud,
}: {
  hasAlternative: boolean;
  useCloud: boolean;
  onUseCloud: Dispatch<SetStateAction<boolean>>;
}) {
  if (!hasAlternative) return null;
  return (
    <div className="mkt-transport" role="group" aria-label="How to run this connector">
      <button
        type="button"
        className={`mkt-tp-opt ${!useCloud ? "on" : ""}`}
        onClick={() => onUseCloud(false)}
      >
        {ICON.mac}
        <span><b>Run locally</b><small>on your Mac · private</small></span>
      </button>
      <button
        type="button"
        className={`mkt-tp-opt ${useCloud ? "on" : ""}`}
        onClick={() => onUseCloud(true)}
      >
        {ICON.cloud}
        <span><b>Use cloud</b><small>hosted · reaches internet</small></span>
      </button>
    </div>
  );
}

function InstallDrawerBody() {
  const { entry, useCloud, onUseCloud } = useInstallDrawer();
  return (
    <>
      <p className="mkt-dr-desc">{entry.description}</p>
      <InstallTransportPicker
        hasAlternative={Boolean(entry.altInstall)}
        useCloud={useCloud}
        onUseCloud={onUseCloud}
      />
      <InstallPrivacyNote />
      <InstallEndpoint />
      <InstallSecrets />
      <InstallRepository />
      <InstallRuntime />
      <InstallError />
    </>
  );
}

function InstallPrivacyNote() {
  const { autoApprove, host, isRemote, outboundUnmask, spec } = useInstallDrawer();
  if (!isRemote) {
    return (
      <p className="mkt-note mkt-note--flag nb-sem-done">
        {ICON.shield}
        <b>Runs on your Mac.</b> Arcelle starts <b>{spec.kind === "stdio" ? spec.command : ""}</b> as a local program — it only reaches the internet if the tool itself makes a request. You confirm below before it starts.
      </p>
    );
  }
  return (
    <p className="mkt-note mkt-note--flag nb-sem-pending">
      {ICON.warn}
      <b>This connector runs in the cloud.</b> When the assistant calls it, your prompt and the tool's arguments leave your Mac and reach <b>{host || "an address this catalogue entry did not spell out"}</b>. <InstallCloudDisclosure autoApprove={autoApprove} outboundUnmask={outboundUnmask} />
    </p>
  );
}

function InstallCloudDisclosure({
  autoApprove,
  outboundUnmask,
}: {
  autoApprove: boolean | null;
  outboundUnmask: boolean | null;
}) {
  if (autoApprove === null || outboundUnmask === null) {
    return <>Whether Arcelle asks you before a call runs, and whether it replaces this room's listed private details with placeholders first, are the two switches at the top of Connectors.</>;
  }
  const approval = autoApprove
    ? "runs connector tools without asking you"
    : "asks you before each call runs";
  const privacy = outboundUnmask
    ? "sends it this room's real values"
    : "replaces the private details listed under Cloud privacy with placeholders — anything not on that list goes as written";
  return <>Right now Arcelle {approval}, and {privacy}. Both are switches at the top of Connectors, and each is only the default: this connector can answer either one for itself once installed.</>;
}

function InstallEndpoint() {
  const { badEndpoint, isRemote, spec } = useInstallDrawer();
  const value = spec.kind === "http" ? spec.url : `${spec.command} ${spec.args.join(" ")}`;
  return (
    <div>
      <div className="mkt-label">{isRemote ? "Endpoint" : "Command that will run"}</div>
      <div className="mkt-code">{value}</div>
      {badEndpoint && (
        <div className="gate-error">
          This registry entry's address is not a usable http(s) URL, so connecting to it could only fail. Nothing was installed.
        </div>
      )}
    </div>
  );
}

function InstallSecrets() {
  const { secretKeys, secrets, spec, onSecrets } = useInstallDrawer();
  if (secretKeys.length === 0) return null;
  const heading = spec.kind === "stdio" ? "Settings" : "Auth headers";
  return (
    <div>
      <div className="mkt-label">{heading}</div>
      <div className="mkt-fields">
        {secretKeys.map((key) => (
          <label key={key} className="mkt-field">
            <span>{key}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secrets[key] ?? ""}
              placeholder={spec.kind === "http" ? "Bearer …" : `value for ${key}`}
              onChange={(event) => onSecrets((current) => ({ ...current, [key]: event.target.value }))}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function InstallRepository() {
  const { entry } = useInstallDrawer();
  if (!entry.repository) return null;
  return <a className="mkt-repo" href={entry.repository} target="_blank" rel="noreferrer">View source ↗</a>;
}

function InstallRuntime() {
  const { runtime, runtimeBusy, runtimePct, onDoProvision } = useInstallDrawer();
  if (!runtime || runtime.available) return null;
  return (
    <div className="mkt-note mkt-note--flag nb-sem-pending" role="status">
      <p className="mkt-note-text">{ICON.warn}{runtime.note}</p>
      {runtime.provisionable && (
        <button className="subtle mkt-note-action" disabled={runtimeBusy} onClick={onDoProvision}>
          {runtimeBusy ? `Downloading… ${runtimePct}%` : `Download ${runtime.kind} for me`}
        </button>
      )}
    </div>
  );
}

function InstallError() {
  const { err } = useInstallDrawer();
  if (!err) return null;
  return <div className="gate-error">{err}</div>;
}

function InstallDrawerFooter() {
  return (
    <div className="mkt-dr-foot">
      <InstallConfirmation />
      <InstallAction />
      <InstallConnectionStatus />
      <InstallCancelConfirmation />
      <InstallOauth />
      <InstallRoomOnlyNote />
    </div>
  );
}

function InstallConfirmation() {
  const { confirming, done, host, isRemote, spec } = useInstallDrawer();
  if (!confirming || done) return null;
  const question = isRemote
    ? <><b>Connect to {host || "this endpoint"} now?</b> Arcelle will add it to this room and start talking to it straight away.</>
    : <><b>Start this program on your Mac now?</b> Arcelle will run <code>{spec.kind === "stdio" ? spec.command : ""}</code> as soon as you confirm.</>;
  return <div className="mkt-note mkt-note--flag nb-sem-pending" role="alert"><p className="mkt-note-text">{ICON.warn}{question} Applying also (re)starts every other enabled connector in this room — including any you have not approved before.</p></div>;
}

function installActionLabel(
  done: boolean,
  busy: boolean,
  confirming: boolean,
  isRemote: boolean,
) {
  if (done) return <><CircleCheckIcon size={14} /> Added to this room</>;
  if (busy) return "Installing…";
  if (confirming) return isRemote ? "Yes, connect now" : "Yes, start it now";
  return isRemote ? "Review & connect" : "Install to this room";
}

function InstallAction() {
  const { badEndpoint, busy, confirming, done, isRemote, onConfirming, onDoInstall } = useInstallDrawer();
  return (
    <button
      className={`primary mkt-install btn-ic ${isRemote ? "remote" : ""}`}
      disabled={busy || done || badEndpoint}
      onClick={() => (confirming ? onDoInstall() : onConfirming(true))}
    >
      {installActionLabel(done, busy, confirming, isRemote)}
    </button>
  );
}

function InstallConnectionStatus() {
  const { connStatus, done } = useInstallDrawer();
  if (!done || !connStatus) return null;
  if (connStatus.status === "failed") return <div className="gate-error">{connStatus.error || "It didn't start."}</div>;
  return <p className="mkt-dr-note" role="status"><ConnectionStatusText status={connStatus} /></p>;
}

function ConnectionStatusText({ status }: { status: McpServerStatus }) {
  if (status.status === "connecting") return <>Connecting…</>;
  if (status.status === "connected") return <>Connected · {status.tools.length} tool{status.tools.length === 1 ? "" : "s"}</>;
  if (status.status === "disabled") return <>Added, but switched off.</>;
  return null;
}

function InstallCancelConfirmation() {
  const { busy, confirming, done, onConfirming } = useInstallDrawer();
  if (!confirming || done || busy) return null;
  return <button className="subtle" onClick={() => onConfirming(false)}>Not now</button>;
}

function oauthActionLabel(signedIn: boolean, authBusy: boolean) {
  if (signedIn) return <><CircleCheckIcon size={14} /> Signed in</>;
  return authBusy ? "Waiting for your browser…" : "Connect account (sign in)";
}

function InstallOauth() {
  const { authBusy, authUrl, copied, done, isRemote, signedIn, onCancelOauth, onCopied, onDoOauth, onDoSignOut } = useInstallDrawer();
  if (!isRemote || !done) return null;
  return (
    <div className="mkt-oauth">
      <button className="primary mkt-install btn-ic" disabled={authBusy || signedIn} onClick={onDoOauth}>
        {oauthActionLabel(signedIn, authBusy)}
      </button>
      {signedIn && <button className="btn-ic mkt-oauth-signout" disabled={authBusy} onClick={onDoSignOut} title="Forget this connector's saved sign-in and remove its token from this room">Sign out</button>}
      <InstallOauthWaiting busy={authBusy} onCancel={onCancelOauth} />
      <InstallOauthManual authUrl={authUrl} busy={authBusy} copied={copied} onCopied={onCopied} />
    </div>
  );
}

function InstallOauthWaiting({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  if (!busy) return null;
  return <div className="mkt-oauth-wait"><p className="mkt-oauth-hint">A browser tab should have opened — finish sign-in there. If this connector doesn't support in-app sign-in, cancel and add its token under Auth headers instead.</p><button className="btn-ic mkt-oauth-cancel" onClick={onCancel}>Cancel</button></div>;
}

function InstallOauthManual({
  authUrl,
  busy,
  copied,
  onCopied,
}: {
  authUrl: string;
  busy: boolean;
  copied: boolean;
  onCopied: Dispatch<SetStateAction<boolean>>;
}) {
  if (!busy || !authUrl) return null;
  const copy = () => navigator.clipboard?.writeText(authUrl).then(() => onCopied(true), () => {});
  return (
    <div className="mkt-oauth-manual">
      <span className="mkt-oauth-hint">Didn't open?</span>
      <a className="mkt-repo" href={authUrl} target="_blank" rel="noreferrer">Open sign-in page ↗</a>
      <button className="btn-ic" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
    </div>
  );
}

function InstallRoomOnlyNote() {
  const { isRemote } = useInstallDrawer();
  return <p className="mkt-dr-note">{isRemote ? "Added to this room only · sign-in opens your browser" : "Added to this room only · you confirm before it runs"}</p>;
}
