import type { KeyboardEvent, RefObject } from "react";
import type { BrowserInfo, BrowserSearchResult } from "../apiTypes";
import { AlertIcon, LockIcon, ShieldIcon } from "../icons";
import type { ChromeAbilities } from "./browserChrome";
import { protectionAlert, type PrivacyClaim } from "./browserPrivacy";

export type ReaderToggleProps = {
  can: ChromeAbilities;
  readerOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
};

export function BrowserReaderToggle({
  can,
  readerOpen,
  onOpen,
  onClose,
}: ReaderToggleProps) {
  const toggle = () => (readerOpen ? onClose() : onOpen());
  return (
    <button
      className="browser-skip"
      type="button"
      title="The page is a separate native layer this app cannot put into the reading order. This shows its text here, where a screen reader and the keyboard can reach it."
      disabled={!can.read && !readerOpen}
      aria-pressed={readerOpen}
      onClick={toggle}
    >
      {readerOpen ? "Back to the page" : "Skip to this page as text"}
    </button>
  );
}

export type BrowserNavigationProps = {
  can: ChromeAbilities;
  loading: boolean;
  onNavigate: (action: "back" | "forward" | "reload" | "stop") => void;
};

export function BrowserNavigation({
  can,
  loading,
  onNavigate,
}: BrowserNavigationProps) {
  const refreshAction = loading ? "stop" : "reload";
  return (
    <div className="browser-nav">
      <button
        className="browser-btn browser-btn-ico"
        aria-label="Go back"
        disabled={!can.navigate}
        onClick={() => onNavigate("back")}
      >
        <span className="bico bico-back" aria-hidden />
      </button>
      <button
        className="browser-btn browser-btn-ico"
        aria-label="Go forward"
        disabled={!can.navigate}
        onClick={() => onNavigate("forward")}
      >
        <span className="bico bico-forward" aria-hidden />
      </button>
      <button
        className="browser-btn browser-btn-ico"
        aria-label={loading ? "Stop loading" : "Reload the page"}
        disabled={!can.navigate}
        onClick={() => onNavigate(refreshAction)}
      >
        <span
          className={`bico ${loading ? "bico-stop" : "bico-reload"}`}
          aria-hidden
        />
      </button>
    </div>
  );
}

export type BrowserAddressProps = {
  address: string;
  addressRef: RefObject<HTMLInputElement | null>;
  insecure: boolean;
  schemeLabel: string;
  secure: boolean;
  onAddressChange: (address: string) => void;
  onAddressBlur: () => void;
  onSubmit: () => void;
};

export function BrowserAddress({
  address,
  addressRef,
  insecure,
  schemeLabel,
  secure,
  onAddressChange,
  onAddressBlur,
  onSubmit,
}: BrowserAddressProps) {
  const hasConnectionStatus = secure || insecure;
  const connectionClass = `browser-scheme${insecure ? " insecure" : ""}`;
  return (
    <form
      className="browser-address"
      role="search"
      aria-label="Address and web search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {hasConnectionStatus ? (
        <span
          className={connectionClass}
          role="img"
          aria-label={schemeLabel}
          title={schemeLabel}
        >
          {secure ? <LockIcon size={14} /> : <AlertIcon size={14} />}
        </span>
      ) : (
        <span className="bico bico-search browser-scheme" aria-hidden />
      )}
      {insecure && <span className="browser-insecure">Not secure</span>}
      <input
        ref={addressRef}
        aria-label="Address — search the web, or type an address and press Enter"
        placeholder="Search or enter a web address"
        value={address}
        onChange={(event) => onAddressChange(event.target.value)}
        onBlur={onAddressBlur}
        spellCheck={false}
      />
    </form>
  );
}

export type BrowserJournalButtonProps = {
  claim: PrivacyClaim;
  journalOpen: boolean;
  onToggle: () => void;
};

export function BrowserJournalButton({
  claim,
  journalOpen,
  onToggle,
}: BrowserJournalButtonProps) {
  const label = `${journalOpen ? "Hide" : "Show"} the activity journal. ${claim.detail}`;
  return (
    <button
      className={`browser-shield ${claim.tone}`}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={journalOpen}
      onClick={onToggle}
    >
      <ShieldIcon size={14} />
      <span>{claim.chip}</span>
    </button>
  );
}

export type BrowserTakeoverProps = {
  can: ChromeAbilities;
  takeover: boolean | undefined;
  onToggle: () => void;
};

export function BrowserTakeover({ can, takeover, onToggle }: BrowserTakeoverProps) {
  const title = takeover
    ? "You have the wheel — the agent's browsing tools are paused until you hand it back."
    : "Drive this page yourself. The agent's browsing tools pause until you hand it back.";
  return (
    <button
      className={`browser-takeover${takeover ? " on" : ""}`}
      type="button"
      disabled={!can.takeover}
      title={title}
      aria-pressed={takeover === true}
      onClick={onToggle}
    >
      {takeover ? "Hand back to the agent" : "Take over"}
    </button>
  );
}

export type BrowserSaveButtonProps = {
  can: ChromeAbilities;
  saveOpen: boolean;
  saveRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
};

export function BrowserSaveButton({
  can,
  saveOpen,
  saveRef,
  onToggle,
}: BrowserSaveButtonProps) {
  return (
    <button
      className="browser-btn browser-save-btn"
      type="button"
      ref={saveRef}
      disabled={!can.save}
      aria-label="Save this page, a selection, the link, or its video into the room"
      aria-expanded={saveOpen}
      onClick={onToggle}
    >
      <span className="bico bico-save" aria-hidden />
      Save
    </button>
  );
}

export type BrowserChromeProps = {
  address: string;
  addressRef: RefObject<HTMLInputElement | null>;
  can: ChromeAbilities;
  claim: PrivacyClaim;
  info: BrowserInfo;
  insecure: boolean;
  journalOpen: boolean;
  loading: boolean;
  readerOpen: boolean;
  saveOpen: boolean;
  saveRef: RefObject<HTMLButtonElement | null>;
  schemeLabel: string;
  secure: boolean;
  onAddressBlur: () => void;
  onAddressChange: (address: string) => void;
  onGo: () => void;
  onJournalToggle: () => void;
  onNavigate: (action: "back" | "forward" | "reload" | "stop") => void;
  onOpenReader: () => void;
  onCloseReader: () => void;
  onSaveToggle: () => void;
  onTakeoverToggle: () => void;
};

export function BrowserChrome({
  address,
  addressRef,
  can,
  claim,
  info,
  insecure,
  journalOpen,
  loading,
  readerOpen,
  saveOpen,
  saveRef,
  schemeLabel,
  secure,
  onAddressBlur,
  onAddressChange,
  onGo,
  onJournalToggle,
  onNavigate,
  onOpenReader,
  onCloseReader,
  onSaveToggle,
  onTakeoverToggle,
}: BrowserChromeProps) {
  return (
    <div className="browser-chrome">
      <BrowserReaderToggle
        can={can}
        readerOpen={readerOpen}
        onOpen={onOpenReader}
        onClose={onCloseReader}
      />
      <BrowserNavigation can={can} loading={loading} onNavigate={onNavigate} />
      <BrowserAddress
        address={address}
        addressRef={addressRef}
        insecure={insecure}
        schemeLabel={schemeLabel}
        secure={secure}
        onAddressChange={onAddressChange}
        onAddressBlur={onAddressBlur}
        onSubmit={onGo}
      />
      <BrowserJournalButton
        claim={claim}
        journalOpen={journalOpen}
        onToggle={onJournalToggle}
      />
      <BrowserTakeover
        can={can}
        takeover={info.takeover}
        onToggle={onTakeoverToggle}
      />
      <BrowserSaveButton
        can={can}
        saveOpen={saveOpen}
        saveRef={saveRef}
        onToggle={onSaveToggle}
      />
      <button
        className="browser-btn"
        type="button"
        disabled={!can.read && !readerOpen}
        aria-pressed={readerOpen}
        title="The page as clean article text — selectable, copyable and reachable by keyboard, without the page's own layout."
        onClick={readerOpen ? onCloseReader : onOpenReader}
      >
        Read as text
      </button>
    </div>
  );
}

export function saveIsDisabled(saving: boolean, can: ChromeAbilities): boolean {
  return saving || !can.save;
}

export function selectionSaveIsDisabled(
  saving: boolean,
  can: ChromeAbilities,
  hasSelection: boolean | undefined,
): boolean {
  return saveIsDisabled(saving, can) || hasSelection !== true;
}

export type BrowserSaveRowProps = {
  can: ChromeAbilities;
  hasSelection: boolean | undefined;
  open: boolean;
  saveRef: RefObject<HTMLButtonElement | null>;
  saving: boolean;
  onClose: () => void;
  onDownloadVideo: () => void;
  onSaveLink: () => void;
  onSavePage: () => void;
  onSaveSelection: () => void;
};

export function BrowserSaveRow({
  can,
  hasSelection,
  open,
  saveRef,
  saving,
  onClose,
  onDownloadVideo,
  onSaveLink,
  onSavePage,
  onSaveSelection,
}: BrowserSaveRowProps) {
  if (!open) return null;
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    onClose();
    saveRef.current?.focus();
  };
  return (
    <div
      className="browser-banner browser-save-row"
      role="group"
      aria-label="Save into the room"
      onKeyDown={closeOnEscape}
    >
      <button
        className="browser-btn"
        disabled={saveIsDisabled(saving, can)}
        onClick={onSavePage}
      >
        Save page
      </button>
      <button
        className="browser-btn"
        disabled={selectionSaveIsDisabled(saving, can, hasSelection)}
        onClick={onSaveSelection}
      >
        Save selection
      </button>
      <button
        className="browser-btn"
        disabled={saveIsDisabled(saving, can)}
        onClick={onSaveLink}
      >
        Save link
      </button>
      <button
        className="browser-btn"
        disabled={saveIsDisabled(saving, can)}
        onClick={onDownloadVideo}
      >
        Download video
      </button>
      <span className="browser-save-hint">
        Everything lands in this room's files — nothing touches your Downloads folder.
      </span>
    </div>
  );
}

export function BrowserNotice({
  notice,
  onDismiss,
}: {
  notice: string | null;
  onDismiss: () => void;
}) {
  if (!notice) return null;
  return (
    <div className="browser-banner" role="status">
      {notice}
      <button className="browser-btn" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export type BrowserResultsBannerProps = {
  blank: boolean;
  info: BrowserInfo;
  readerOpen: boolean;
  search: BrowserSearchResult | null;
  searchOpen: boolean;
  onBackToPage: () => void;
  onReturnToResults: (query: string) => void;
};

export function BrowserResultsBanner({
  blank,
  info,
  readerOpen,
  search,
  searchOpen,
  onBackToPage,
  onReturnToResults,
}: BrowserResultsBannerProps) {
  return (
    <>
      <BrowserReturnToResults
        readerOpen={readerOpen}
        search={search}
        searchOpen={searchOpen}
        onReturn={onReturnToResults}
      />
      <BrowserReturnToPage
        blank={blank}
        info={info}
        searchOpen={searchOpen}
        onReturn={onBackToPage}
      />
    </>
  );
}

export function BrowserReturnToResults({
  readerOpen,
  search,
  searchOpen,
  onReturn,
}: {
  readerOpen: boolean;
  search: BrowserSearchResult | null;
  searchOpen: boolean;
  onReturn: (query: string) => void;
}) {
  if (search && !searchOpen && !readerOpen) {
    return (
      <div className="browser-banner browser-results-row" role="status">
        <button
          className="browser-btn"
          onClick={() => onReturn(search.query)}
        >
          ◂ Results
        </button>
        <span>
          for <b>{search.query}</b>
        </span>
      </div>
    );
  }
  return null;
}

export function BrowserReturnToPage({
  blank,
  info,
  searchOpen,
  onReturn,
}: {
  blank: boolean;
  info: BrowserInfo;
  searchOpen: boolean;
  onReturn: () => void;
}) {
  if (!searchOpen || !info.open || blank) return null;
  const title = info.title?.trim() || info.url;
  return (
    <div className="browser-banner browser-results-row" role="status">
      <button className="browser-btn" onClick={onReturn}>
        Page ▸
      </button>
      <span>
        back to <b dir="auto">{title}</b>
      </span>
    </div>
  );
}

export function canRetryProtection(
  claim: PrivacyClaim,
  protection: BrowserInfo["protection"],
): boolean {
  return claim.alert === protectionAlert(protection) && protection?.state === "failed";
}

export function BrowserProtectionBanner({
  claim,
  protection,
  retrying,
  onRetry,
}: {
  claim: PrivacyClaim;
  protection: BrowserInfo["protection"];
  retrying: boolean;
  onRetry: () => void;
}) {
  if (!claim.alert) return null;
  return (
    <div className="browser-banner error" role="status">
      {claim.alert}
      {canRetryProtection(claim, protection) && (
        <button className="browser-btn" disabled={retrying} onClick={onRetry}>
          {retrying ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}

export function BrowserStalledBanner({ stalled }: { stalled: string | null }) {
  if (!stalled) return null;
  return (
    <div className="browser-banner error" role="status">
      {stalled}
    </div>
  );
}

export function BrowserErrorBanner({
  error,
  failedInput,
  onDismiss,
  onSearch,
}: {
  error: string | null;
  failedInput: string | null;
  onDismiss: () => void;
  onSearch: (input: string) => void;
}) {
  if (!error) return null;
  return (
    <div className="browser-banner error" role="alert">
      {error}
      {failedInput && (
        <button className="browser-btn" onClick={() => onSearch(failedInput)}>
          Search the web for “{failedInput}” instead
        </button>
      )}
      <button className="browser-btn" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
