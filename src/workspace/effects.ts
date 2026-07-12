import { useEffect, useLayoutEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { api, RoomInfo } from "../api";
import { stopMicTap } from "./liveRec";
import { handleAgentUiRequest } from "../agent/driver";
import { annotationTarget } from "./markup";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** All of Workspace's effects: the mount-time backend-event wiring (which
 * dispatches agent-open-file → viewFile, agent-annotate → the open viewer, MCP
 * approvals, sync warning), plus the smaller orchestration effects. Kept in one
 * place because they call across the hooks. Dependency arrays are unchanged. */
export function useWorkspaceEffects(
  s: WSState,
  a: WSActions,
  info: RoomInfo,
  onLock: () => void | Promise<void>,
) {
  useEffect(() => {
    if (s.initRef.current) return;
    s.initRef.current = true;
    getCurrentWindow()
      .setTitle(`${info.name} — Private Room`)
      .catch(() => {});
    api.listFiles().then(s.setFiles);
    api.listFolders().then(s.setFolders).catch(() => {});
    api.listMemories().then(s.setMemories);
    api.listChatCommands().then(s.setCommands).catch(() => {});
    void a.loadAiActions();
    a.refreshAi();
    a.loadFrontPage(true);
    api.warmModel().catch(() => {});
    api.listChats().then(async (cs) => {
      if (cs.length === 0) {
        const c = await api.createChat();
        s.setChats([c]);
        s.setActiveChatId(c.id);
      } else {
        s.setChats(cs);
        s.setActiveChatId(cs[0].id);
      }
    });
    const unlisten = api.onAskDelta((delta) => {
      s.setStreamText((t) => t + delta);
    });
    const unlistenStep = api.onAskStep((label) => {
      s.setSteps((st) => [...st, { label, ok: true }]);
    });
    const unlistenLane = api.onAskLane((label) => {
      s.setLane(label);
    });
    const unlistenStepStatus = api.onAskStepStatus(({ ok }) => {
      if (ok) return;
      s.setSteps((st) =>
        st.length ? [...st.slice(0, -1), { ...st[st.length - 1], ok: false }] : st,
      );
    });
    const unlistenRound = api.onAskRound(() => {
      s.setStreamText("");
    });
    const unlistenNotice = api.onAskNotice((text) => {
      s.pushToast("info", text);
    });
    const unlistenSummarize = api.onSummarizeProgress((text) => {
      s.setSummarizeProgress(text);
    });
    // ADD-31: named stage inside the Studio modal while it generates.
    const unlistenStudioStep = api.onStudioStep((text) => {
      s.setStudioStep(text);
    });
    // ADD-31: live import queue. The receipt toast comes from reportImport
    // (which knows names and errors) — this event only drives the strip.
    const unlistenImport = api.onImportProgress((p) => {
      s.setImportProgress(p.done >= p.total ? null : p);
    });
    // ADD-30: background-job cards — live counts, and on any terminal flag
    // re-read the job list so the card flips to Resume / disappears.
    void a.refreshJobs();
    const unlistenJobs = api.onJobProgress((p) => {
      if (p.finished || p.paused || p.failed) {
        s.setJobProgress((m) => {
          const next = { ...m };
          delete next[p.jobId];
          return next;
        });
        void a.refreshJobs();
        if (p.finished) {
          // The label names what finished ("Summary ready", "Full pass of …").
          s.pushToast("success", p.label || "Background job finished.");
          if (p.fileId) void a.viewFile(p.fileId);
        } else if (p.paused) {
          s.pushToast("info", "Paused — resume it any time from the sidebar.");
        }
      } else {
        s.setJobProgress((m) => ({
          ...m,
          [p.jobId]: { label: p.label, done: p.done, total: p.total },
        }));
      }
    });
    const unlistenPull = listen<{ status: string; percent: number | null }>(
      "pull-progress",
      (e) => {
        s.setPullStatus(e.payload.status);
        s.setPullPercent(e.payload.percent);
      },
    );
    const unlistenDrop = getCurrentWebview().onDragDropEvent(async (event) => {
      const p = event.payload;
      if (s.internalDragRef.current) return;
      if (p.type === "enter" || p.type === "over") {
        s.setDragOver(true);
      } else if (p.type === "leave") {
        s.setDragOver(false);
      } else if (p.type === "drop") {
        s.setDragOver(false);
        if (p.paths && p.paths.length > 0) {
          if (p.paths.length > 1) {
            s.setImportProgress({ done: 0, total: p.paths.length, name: "Starting…" });
          }
          try {
            const report = await api.importFiles(p.paths);
            s.setFiles(await api.listFiles());
            a.reportImport(report);
          } catch (e) {
            s.pushToast("error", String(e));
          } finally {
            s.setImportProgress(null);
          }
        }
      }
    });
    const unlistenMcpApprove = api.onMcpApproveRequest((req) => {
      s.setMcpApprovals((q) => [...q, req]);
    });
    // ADD-25: the agent↔UI bridge — the backend's ui_snapshot / ui_act /
    // view_screenshot / media_frame tools land here; the driver performs them
    // against the live DOM (enforcing the data-agent-blocked consent denylist)
    // and every outcome, including a thrown surprise, is answered so the
    // backend's oneshot never waits out its timeout.
    const unlistenAgentUi = api.onAgentUiRequest(async (req) => {
      const payload = await handleAgentUiRequest(req).catch((e) => ({
        error: String(e),
      }));
      api.resolveAgentUi(req.id, payload).catch(() => {});
    });
    a.refreshWebAccess();
    a.refreshAutolock();
    if (info.synced) {
      api
        .getSetting("hlt6_sync_dismissed")
        .then((v) => {
          if (v !== "1") s.setShowSyncWarn(true);
        })
        .catch(() => {});
    }
    const unlistenOpen = api.onAgentOpenFile((p) => {
      const id = typeof p === "string" ? p : p.id;
      const hint =
        typeof p === "string" ? undefined : (p.page ?? p.cell ?? p.find ?? undefined);
      const current = s.openFileRef.current;
      if (hint == null && current?.id === id && current.target) return;
      if (typeof p === "string" || hint == null) {
        a.viewFile(id);
      } else {
        a.viewFile(p.id, {
          page: p.page ?? undefined,
          cell: p.cell ?? undefined,
          range: p.cell ?? undefined,
          find: p.find ?? undefined,
          quote: p.find ?? undefined,
        });
      }
    });
    const unlistenAnnotate = api.onAgentAnnotate((payload) => {
      a.viewFile(payload.fileId, annotationTarget(payload));
    });
    const unlistenUpdated = api.onFileUpdated(async (fileId) => {
      s.editedRef.current.add(fileId);
      const current = s.openFileRef.current;
      if (current && current.id === fileId) {
        const content = await api.getFileContent(current.id);
        s.setOpenFile({ ...current, content });
        s.setViewerRev((r) => r + 1);
      }
    });
    const unlistenFiles = api.onRoomFilesChanged(() => {
      api.listFiles().then(s.setFiles);
      api.listFolders().then(s.setFolders).catch(() => {});
      a.loadFrontPage(false);
    });
    api.mcpStatus().then((st) => s.setMcpTools(a.connectedTools(st))).catch(() => {});
    const unlistenMcp = api.onMcpStatus((statuses) => {
      s.setMcpTools(a.connectedTools(statuses));
    });
    // ADD-27: keep the workspace-wide live-recording state in sync with the
    // engine (the TopBar chip + RecordingView both read s.recLive), re-attach
    // to a session that survived a reload, and refresh the open view when a
    // pause/stop lands fresh audio bytes.
    void api.recLiveStatus().then((r) => {
      if (r) s.setRecLive({ fileId: r.fileId, status: r.status });
    }).catch(() => {});
    const unlistenRecState = api.onRecState((p) => {
      if (p.status === "saved") {
        s.setRecLive(null);
        // The engine can stop ITSELF (3-hour limit, room closed under it) —
        // the microphone must never stay open past the session it fed.
        stopMicTap();
      } else {
        s.setRecLive({ fileId: p.fileId, status: p.status });
      }
      // The drain readout lives exactly as long as the save does.
      if (p.status !== "saving") s.setRecSave(null);
      if (
        (p.status === "paused" || p.status === "saved") &&
        s.openFileRef.current?.id === p.fileId
      ) {
        void a.viewFile(p.fileId);
      }
    });
    // Stop→saved drain progress. First event = the audio bytes are durable;
    // startedAt is kept from the first event so the card's clock measures the
    // whole drain, not the latest decode.
    const unlistenRecSave = api.onRecSaveProgress((p) => {
      s.setRecSave((prev) => ({
        stage: p.stage,
        remaining: p.remaining,
        startedAt: prev?.startedAt ?? new Date().toISOString(),
      }));
    });
    // ADD-18: imported audio/video transcribes itself in the background —
    // reflect that on the file (sidebar token + viewer status line) instead
    // of letting the transcript just "appear". Keyed by file name.
    const unlistenStt = api.onSttProgress(([name, stage]) => {
      s.setSttStatus((m) => ({
        ...m,
        [name]: stage === "started" ? "processing" : stage,
      }));
      if (stage === "done") void api.listFiles().then(s.setFiles);
    });
    const unlistenRecError = api.onRecError((p) => {
      s.pushToast("error", p.message);
    });
    // A capture lane dying must reach the user even when the recording's
    // view is closed (they're usually in Zoom, not here). One toast per
    // outage per source; the view's banner handles the on-screen case.
    const flaggedSources = new Set<string>();
    const unlistenRecSource = api.onRecSource((p) => {
      const key = `${p.fileId}:${p.source}`;
      if (p.status === "error") {
        if (flaggedSources.has(key)) return;
        flaggedSources.add(key);
        if (s.openFileRef.current?.id !== p.fileId) s.pushToast("error", p.message);
      } else {
        flaggedSources.delete(key);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
      unlistenStep.then((fn) => fn());
      unlistenLane.then((fn) => fn());
      unlistenStepStatus.then((fn) => fn());
      unlistenRound.then((fn) => fn());
      unlistenNotice.then((fn) => fn());
      unlistenSummarize.then((fn) => fn());
      unlistenStudioStep.then((fn) => fn());
      unlistenImport.then((fn) => fn());
      unlistenJobs.then((fn) => fn());
      unlistenPull.then((fn) => fn());
      unlistenDrop.then((fn) => fn());
      unlistenOpen.then((fn) => fn());
      unlistenAnnotate.then((fn) => fn());
      unlistenUpdated.then((fn) => fn());
      unlistenFiles.then((fn) => fn());
      unlistenMcp.then((fn) => fn());
      unlistenMcpApprove.then((fn) => fn());
      unlistenAgentUi.then((fn) => fn());
      unlistenRecState.then((fn) => fn());
      unlistenRecSave.then((fn) => fn());
      unlistenStt.then((fn) => fn());
      unlistenRecSource.then((fn) => fn());
      unlistenRecError.then((fn) => fn());
      window.clearInterval(s.recheckTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (s.activeChatId) {
      api.getMessages(s.activeChatId).then(s.setMessages);
    } else {
      s.setMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.activeChatId]);

  useEffect(() => {
    const el = s.chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.messages, s.asking, s.streamText]);

  useEffect(() => {
    if (s.prevAskingRef.current && !s.asking) {
      s.lastActivityRef.current = Date.now();
    }
    s.prevAskingRef.current = s.asking;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.asking]);

  useEffect(() => {
    const bump = () => {
      s.lastActivityRef.current = Date.now();
    };
    // Activity is ANY real interaction, not just mouse/keyboard hardware
    // events. VoiceOver and other assistive tech drive the app through AX
    // actions that surface as click/input/focus — without these, an active
    // assisted session idle-locks mid-use and ejects the user to the gate.
    const activityEvents = [
      "mousemove",
      "keydown",
      "pointerdown",
      "click",
      "input",
      "focusin",
      "wheel",
    ] as const;
    for (const ev of activityEvents) window.addEventListener(ev, bump);
    let lastTick = Date.now();
    const interval = window.setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;
      const setting = s.autolockRef.current;
      if (setting === "off") return;
      const limitMs = Number(setting) * 60_000;
      if (!Number.isFinite(limitMs) || limitMs <= 0) return;
      if (s.askingRef.current) return;
      // A live recording IS activity. During a meeting the user is in
      // Zoom/Meet, not here — locking would close the room and cut the
      // recording at exactly the idle limit (a real on-device casualty).
      if (s.recLiveRef.current) {
        s.lastActivityRef.current = now;
        return;
      }
      const idle = now - s.lastActivityRef.current;
      const slept = gap > 45_000;
      if (idle >= limitMs || (slept && gap >= limitMs)) {
        onLock();
      }
    }, 30_000);
    return () => {
      for (const ev of activityEvents) window.removeEventListener(ev, bump);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onLock]);

  useEffect(() => () => window.clearTimeout(s.confirmTimer.current), [s.confirmTimer]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (s.ctxMenuRef.current) {
          e.preventDefault();
          s.setCtxMenu(null);
          return;
        }
        if (s.showSearchRef.current) {
          e.preventDefault();
          s.setShowSearch(false);
          return;
        }
        if (s.showSettingsRef.current) return;
        if (s.showMapRef.current) {
          e.preventDefault();
          s.setShowMap(false);
          return;
        }
        const t = e.target as HTMLElement | null;
        const typing =
          t != null && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
        if (!typing && s.openFileRef.current) {
          e.preventDefault();
          s.setOpenFile(null);
        }
        return;
      }
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        a.newChat();
      } else if (k === "l") {
        e.preventDefault();
        a.handleLock();
      } else if (k === "f" || k === "k") {
        e.preventDefault();
        s.setSearchSel(0);
        s.setShowSearch(true);
      } else if (k === ",") {
        e.preventDefault();
        s.setShowSettings(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!s.showSearch) return;
    const q = s.searchQuery.trim();
    if (!q) {
      s.setSearchResults(null);
      return;
    }
    let stale = false;
    const t = window.setTimeout(() => {
      api
        .searchAll(q)
        .then((r) => {
          if (stale) return;
          s.setSearchResults(r);
          s.setSearchSel(0);
        })
        .catch(() => {});
    }, 200);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.searchQuery, s.showSearch]);

  useEffect(() => {
    s.setShowHistory(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.openFile?.id]);

  useEffect(() => {
    s.ctxMenuRef.current = s.ctxMenu !== null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.ctxMenu]);

  useLayoutEffect(() => {
    if (s.ctxMenu) a.clampMenu(s.ctxMenuElRef.current, s.ctxMenu.x, s.ctxMenu.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.ctxMenu]);
  useLayoutEffect(() => {
    if (s.moveMenuFor) a.clampMenu(s.moveMenuElRef.current, s.moveMenuFor.x, s.moveMenuFor.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.moveMenuFor]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(s.paneKey);
      if (raw) {
        const w = JSON.parse(raw);
        if (typeof w.sidebar === "number") s.setSidebarW(w.sidebar);
        if (typeof w.chat === "number") s.setChatW(w.chat);
      }
    } catch {
      /* ignore malformed saved widths */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.paneKey]);

  useEffect(() => {
    try {
      if (!localStorage.getItem(`memoryIntroSeen:${info.name}`)) {
        s.setShowMemoryIntro(true);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.name]);

  useEffect(() => {
    const prev = s.prevModelRef.current;
    if (prev && s.model && prev !== s.model && !s.userPickedModelRef.current) {
      s.pushToast("info", `Switched to ${a.engineLabelOf(s.model)}`);
    }
    s.prevModelRef.current = s.model;
    s.userPickedModelRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.model]);
}
