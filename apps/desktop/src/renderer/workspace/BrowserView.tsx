import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import type {
  BrowseClearScope,
  BrowseJournalRow,
  BrowserInfo,
  BrowserSearchResult,
  FileMeta,
} from "../apiTypes";
import { classifyAddress, needsFreshFetch } from "./address";
import {
  chromeAbilities,
  CLOSED_VIEW,
  pageIsParked,
  type ChromeView,
} from "./browserChrome";
import { privacyClaim } from "./browserPrivacy";
import { publishBrowserPage } from "./browserSignal";
import { type JournalFacet } from "./browserJournal";
import {
  POLL_MS,
  SETTLE_MS,
  pushNativeBrowserBounds,
  requestBrowserInfo,
  recordBrowserSession,
  announceBrowserInfo,
  returnBrowserFocus,
  updateBrowserAddress,
  verifyBrowserPrivacy,
  browserIsLoading,
  browserResultsAreInFront,
  cachedBrowserItemCount,
  browserJournalView,
  browserConnectionView,
} from "./browserRuntime";
import { BrowserChrome, BrowserErrorBanner, BrowserNotice, BrowserProtectionBanner, BrowserResultsBanner, BrowserSaveRow, BrowserStalledBanner } from "./BrowserViewChrome";
import { BrowserBody } from "./BrowserViewPanels";
export function BrowserView({
  parked,
  onAttach,
  onAsk,
}: {
  parked: boolean;
  onAttach?: (file: FileMeta) => void;
  onAsk?: (query: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [info, setInfo] = useState<BrowserInfo>({ open: false });
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ephemeral, setEphemeral] = useState<boolean | null>(null);
  const verifiedForRef = useRef<string | null>(null);
  const [journalOpen, setJournalOpen] = useState(false);
  const [journal, setJournal] = useState<BrowseJournalRow[]>([]);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearScope, setClearScope] = useState<BrowseClearScope | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const [facets, setFacets] = useState<JournalFacet[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [notice, setNoticeText] = useState<string | null>(null);
  const noticeTimer = useRef(0);
  const setNotice = useCallback((message: string | null, ms = 0) => {
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = ms > 0 ? window.setTimeout(() => setNoticeText(null), ms) : 0;
    setNoticeText(message);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  const [search, setSearch] = useState<BrowserSearchResult | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState("");
  const [failedInput, setFailedInput] = useState<string | null>(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [extracting, setExtracting] = useState(0);
  const [priming, setPriming] = useState(false);
  const borrowStage = useCallback((on: boolean) => {
    setExtracting((n) => Math.max(0, n + (on ? 1 : -1)));
    if (on) setPriming(false);
  }, []);
  const [announce, setAnnounce] = useState("");
  const lastInfoRef = useRef<BrowserInfo | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const saveRef = useRef<HTMLButtonElement | null>(null);
  const blank = info.blank === true;
  const loading = browserIsLoading(info, blank, busy);
  const resultsInFront = browserResultsAreInFront(searchOpen, searching);
  const chromeView: ChromeView = useMemo(
    () => ({
      parked,
      blank,
      searchOpen: resultsInFront,
      readerHasTheFloor:
        readerOpen && !comparing && extracting === 0 && !priming,
    }),
    [parked, blank, resultsInFront, readerOpen, comparing, extracting, priming],
  );
  const sentRef = useRef("");
  const pushBounds = useCallback(() => {
    pushNativeBrowserBounds(chromeView, stageRef, sentRef);
  }, [chromeView]);
  useEffect(() => {
    pushBounds();
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(pushBounds);
    ro.observe(el);
    window.addEventListener("resize", pushBounds);
    let raf = 0;
    const follow = () => {
      pushBounds();
      raf = window.requestAnimationFrame(follow);
    };
    const onDown = () => {
      if (!raf) raf = window.requestAnimationFrame(follow);
    };
    const onUp = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      window.setTimeout(pushBounds, 60);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    const settle = window.setInterval(pushBounds, 1000);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", pushBounds);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      if (raf) window.cancelAnimationFrame(raf);
      window.clearInterval(settle);
    };
  }, [pushBounds]);
  useEffect(() => {
    return () => {
      void api.browserSetBounds(0, 0, 1, 1).catch(() => {});
    };
  }, []);
  const missesRef = useRef(0);
  const wasOpenRef = useRef(false);
  const forgetThePage = useCallback((typing: boolean) => {
    if (!typing) {
      setAddress(CLOSED_VIEW.address);
      setEditing(false);
    }
    setSaveOpen(CLOSED_VIEW.saveOpen);
    setReaderOpen(CLOSED_VIEW.readerOpen);
    setComparing(CLOSED_VIEW.comparing);
    setExtracting(CLOSED_VIEW.extracting);
    setPriming(false);
    setSearchOpen(CLOSED_VIEW.searchOpen);
    setSearch(CLOSED_VIEW.search);
    setError(CLOSED_VIEW.error);
    setFailedInput(CLOSED_VIEW.failedInput);
    setNotice(CLOSED_VIEW.notice);
    setBusy(CLOSED_VIEW.busy);
    setEphemeral(CLOSED_VIEW.ephemeral);
    verifiedForRef.current = null;
  }, [setNotice]);
  const refresh = useCallback(async () => {
    const next = await requestBrowserInfo(
      missesRef,
      wasOpenRef,
      setInfo,
      forgetThePage,
      editing,
    );
    if (!next) return;
    recordBrowserSession(next, wasOpenRef, setInfo, forgetThePage, editing);
    announceBrowserInfo(next, lastInfoRef, setAnnounce);
    await returnBrowserFocus(next, addressRef, setAnnounce);
    updateBrowserAddress(next, editing, searchOpenRef, setAddress);
    await verifyBrowserPrivacy(next, verifiedForRef, setEphemeral);
  }, [editing, forgetThePage]);
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    publishBrowserPage(
      info.open === true && info.url
        ? {
            url: info.url,
            title: info.title ?? "",
            readable: !pageIsParked(chromeView),
            hasSelection:
              info.hasSelection === true && !pageIsParked(chromeView),
          }
        : null,
    );
  }, [info, chromeView]);
  useEffect(() => () => publishBrowserPage(null), []);
  const loadJournal = useCallback(async () => {
    try {
      setJournal(await api.browserJournal(300));
      setJournalError(null);
    } catch (e) {
      setJournalError(String(e));
    }
  }, []);
  const loadClearScope = useCallback(async () => {
    setClearScope(await api.browserClearScope().catch(() => null));
  }, []);
  useEffect(() => {
    if (!journalOpen) {
      setConfirmClear(false);
      setClearScope(null);
      return;
    }
    void loadJournal();
    void loadClearScope();
  }, [journalOpen, loadJournal, loadClearScope]);
  useEffect(() => {
    const offs = [
      api.onBrowserJournal(() => {
        if (journalOpen) void loadJournal();
      }),
      api.onBrowserNavigated(() => {
        setSearchOpen(false);
        void refresh();
        window.setTimeout(() => void refresh(), SETTLE_MS);
      }),
      api.onBrowserSearched((result) => {
        setSearch(result);
        setSearchOpen(true);
        setAddress(result.query);
        setEditing(false);
        setSearching(false);
        setError(null);
        setFailedInput(null);
      }),
      api.onBrowserBlocked((p) =>
        setError(
          `Blocked ${p.url} — that address points at this Mac or a private network.`,
        ),
      ),
    ];
    return () => {
      offs.forEach((p) => void p.then((off) => off()).catch(() => {}));
    };
  }, [journalOpen, loadJournal, refresh]);
  const runSearch = useCallback(async (query: string) => {
    setPending(query);
    setSearching(true);
    setError(null);
    setFailedInput(null);
    try {
      const page = await api.browserSearch(query);
      setSearch(page);
      setSearchOpen(true);
      setAddress(query);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }, []);
  async function go(target?: string) {
    const raw = (target ?? address).trim();
    const intent = classifyAddress(raw);
    if (!intent) return;
    if (intent.kind === "search") {
      await runSearch(intent.query);
      return;
    }
    setBusy(true);
    setError(null);
    setFailedInput(null);
    try {
      const settled = await api.browserNavigate(intent.url);
      setAddress(settled);
      setEditing(false);
      setSearchOpen(false);
      await refresh();
    } catch (e) {
      setError(String(e));
      setFailedInput(raw);
    } finally {
      setBusy(false);
    }
  }
  const openReader = useCallback(() => {
    setSearchOpen(false);
    setJournalOpen(false);
    setReaderOpen(true);
    setComparing(false);
    setPriming(true);
  }, []);
  const standDownReader = useCallback(() => {
    setReaderOpen(false);
    setComparing(false);
    setPriming(false);
  }, []);
  const closeReader = useCallback(() => {
    standDownReader();
    addressRef.current?.focus();
  }, [standDownReader]);
  const openResult = useCallback(
    async (url: string) => {
      setSearchOpen(false);
      setBusy(true);
      setError(null);
      setFailedInput(null);
      try {
        const settled = await api.browserNavigate(url);
        setAddress(settled);
        await refresh();
      } catch (e) {
        setError(String(e));
        if (search && !readerOpen) setSearchOpen(true);
      } finally {
        setBusy(false);
      }
    },
    [refresh, search, readerOpen],
  );
  const openResultInNewTab = useCallback(
    async (url: string) => {
      setBusy(true);
      setError(null);
      setFailedInput(null);
      setNotice("Opening in a new tab…");
      try {
        await api.browserNewTab(url);
        setSearchOpen(false);
        setNotice("Opened in a new tab.", 4000);
        await refresh();
      } catch (e) {
        setNotice(null);
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );
  async function nav(action: "back" | "forward" | "reload" | "stop") {
    if (action === "back" && searchOpen) {
      setSearchOpen(false);
      return;
    }
    try {
      await api.browserGo(action);
      window.setTimeout(() => void refresh(), 400);
    } catch (e) {
      setError(String(e));
    }
  }
  async function retryProtection() {
    setRetrying(true);
    try {
      await api.browserRetryProtection();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setRetrying(false);
    }
  }
  async function toggleTakeover() {
    const on = !info.takeover;
    await api.browserSetTakeover(on).catch((e) => setError(String(e)));
    await refresh();
  }
  async function runSave(action: () => Promise<string>) {
    setSaving(true);
    setError(null);
    try {
      const message = await action();
      setNotice(message, 6000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  const savePage = () => runSave(() => api.browserSavePage("page"));
  const saveSelection = () => runSave(() => api.browserSavePage("selection"));
  const saveLink = () =>
    runSave(async () => {
      if (!info.url) throw new Error("No page is open.");
      if (info.open && !blank && !needsFreshFetch(info.url)) {
        return api.browserSavePage("page");
      }
      const meta = await api.importLink(info.url);
      return `Saved "${meta.name}" into the room.`;
    });
  const downloadVideo = () =>
    runSave(async () => {
      if (!info.url) throw new Error("No page is open.");
      await api.startDownloadJob(info.url, "media");
      return "Downloading the video in the background — watch its card in the Activity view.";
    });
  const claim = privacyClaim(ephemeral, info.protection, info.open === true);
  const can = chromeAbilities(info, chromeView);
  const cached = cachedBrowserItemCount(clearScope);
  const nothingToErase = journal.length === 0 && cached === 0;
  const { sessions, earlier } = browserJournalView(
    journal,
    info.session,
    facets,
    showEarlier,
  );
  const { stalled, secure, insecure, schemeLabel } = browserConnectionView(
    info,
    resultsInFront,
    blank,
  );
  return (
    <div className="browser-area">
      <p className="browser-sr" role="status">
        {announce}
      </p>
      <BrowserChrome
        address={address}
        addressRef={addressRef}
        can={can}
        claim={claim}
        info={info}
        insecure={insecure}
        journalOpen={journalOpen}
        loading={loading}
        readerOpen={readerOpen}
        saveOpen={saveOpen}
        saveRef={saveRef}
        schemeLabel={schemeLabel}
        secure={secure}
        onAddressChange={(next) => {
          setAddress(next);
          setEditing(true);
        }}
        onAddressBlur={() => setEditing(address !== (info.url ?? ""))}
        onGo={() => void go()}
        onJournalToggle={() => {
          if (!journalOpen && readerOpen) standDownReader();
          setJournalOpen((open) => !open);
        }}
        onNavigate={(action) => void nav(action)}
        onOpenReader={openReader}
        onCloseReader={closeReader}
        onSaveToggle={() => setSaveOpen((open) => !open)}
        onTakeoverToggle={() => void toggleTakeover()}
      />
      <BrowserSaveRow
        can={can}
        hasSelection={info.hasSelection}
        open={saveOpen}
        saveRef={saveRef}
        saving={saving}
        onClose={() => setSaveOpen(false)}
        onDownloadVideo={() => void downloadVideo()}
        onSaveLink={() => void saveLink()}
        onSavePage={() => void savePage()}
        onSaveSelection={() => void saveSelection()}
      />
      <BrowserNotice notice={notice} onDismiss={() => setNotice(null)} />
      <BrowserResultsBanner
        blank={blank}
        info={info}
        readerOpen={readerOpen}
        search={search}
        searchOpen={searchOpen}
        onBackToPage={() => setSearchOpen(false)}
        onReturnToResults={(query) => {
          setSearchOpen(true);
          setAddress(query);
          setEditing(false);
        }}
      />
      <BrowserProtectionBanner
        claim={claim}
        protection={info.protection}
        retrying={retrying}
        onRetry={() => void retryProtection()}
      />
      <BrowserStalledBanner stalled={stalled} />
      <BrowserErrorBanner
        error={error}
        failedInput={failedInput}
        onDismiss={() => {
          setError(null);
          setFailedInput(null);
        }}
        onSearch={(input) => {
          setError(null);
          setFailedInput(null);
          void runSearch(input);
        }}
      />
      <BrowserBody
        blank={blank}
        borrowStage={borrowStage}
        comparing={comparing}
        confirmClear={confirmClear}
        clearScope={clearScope}
        earlier={earlier}
        extracting={extracting}
        facets={facets}
        info={info}
        journalError={journalError}
        journalOpen={journalOpen}
        nothingToErase={nothingToErase}
        onAttach={onAttach}
        onAsk={onAsk}
        pending={pending}
        readerOpen={readerOpen}
        search={search}
        searchOpen={searchOpen}
        searching={searching}
        sessions={sessions}
        showEarlier={showEarlier}
        stageRef={stageRef}
        onClear={() => {
          setConfirmClear(true);
          setClearScope(null);
          void loadClearScope();
        }}
        onConfirmClear={() => {
          setConfirmClear(false);
          void api
            .browserClearJournal()
            .catch((error) => {
              setError(String(error));
              setFailedInput(null);
              setConfirmClear(true);
            })
            .finally(() => {
              void loadJournal();
              void loadClearScope();
            });
        }}
        onKeepClear={() => setConfirmClear(false)}
        onLoadJournal={() => void loadJournal()}
        onNavigate={(url) => void openResult(url)}
        onOpenNewTab={(url) => void openResultInNewTab(url)}
        onSetComparing={setComparing}
        onSetFacets={setFacets}
        onToggleEarlier={() => setShowEarlier((visible) => !visible)}
        onCloseReader={closeReader}
      />
    </div>
  );
}
