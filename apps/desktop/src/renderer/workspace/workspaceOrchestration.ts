import { useEffect, useLayoutEffect } from "react";
import { api, type RoomInfo } from "../api";
import { MEMORY_INTRO_SEEN } from "./constants";
import type { WSState } from "./state";
import type { WSActions } from "./actions";
import { useWorkspaceKeyboardShortcuts, runAutoLockTick } from "./effects";

export function useWorkspaceOrchestration(s: WSState, a: WSActions, info: RoomInfo, onLock: () => void | Promise<void>) {


  useEffect(() => {
    // Nothing to clear on the way in. The live overlay, the token reading and
    // the privacy receipt are all held per chat now (state.ts `runs`,
    // `usageByChat`, `privacyByChat`), so opening a conversation simply reads
    // ITS state: a fresh chat shows an empty bar because it has no run, and a
    // chat left mid-answer shows the answer still arriving. Before owner
    // replacement #4 this effect had to wipe a set of globals here, which is
    // also why the wipe could not distinguish "nothing to show" from "the
    // previous chat's leftovers".
    if (s.activeChatId) {
      api
        .getMessages(s.activeChatId)
        .then(s.setMessages)
        .catch((e) =>
          // An empty conversation and an unreadable one look identical —
          // never let the second pass for the first.
          s.pushToast(
            "error",
            `Could not read this conversation: ${String(e)}`,
          ),
        );
    } else {
      s.setMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.activeChatId]);

  useEffect(() => {
    const el = s.chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // `agentPlan` is in here because the agent graph GROWS: each dispatch adds
    // a row (and sometimes a band header) to the live bubble. Without it the
    // list stays pinned to where the bubble used to end and the newest
    // specialists render below the fold — the roster often grows in the gap
    // before any delta arrives, so `streamText` does not cover this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.messages, s.asking, s.streamText, s.agentPlan]);

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
      lastTick = runAutoLockTick(s, onLock, lastTick);
    }, 30_000);
    return () => {
      for (const ev of activityEvents) window.removeEventListener(ev, bump);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onLock]);

  useWorkspaceKeyboardShortcuts(s, a);

  useEffect(() => {
    if (!s.showSearch) return;
    const q = s.searchQuery.trim();
    if (!q) {
      s.setSearchResults(null);
      s.setSearchError("");
      return;
    }
    let stale = false;
    const t = window.setTimeout(() => {
      api
        .searchAll(q)
        .then((r) => {
          if (stale) return;
          s.setSearchResults(r);
          s.setSearchError("");
          s.setSearchSel(0);
        })
        .catch((e) => {
          if (stale) return;
          // The previous query's hits must not stay on screen under a query
          // that never ran — you would act on results for something else.
          s.setSearchResults(null);
          s.setSearchError(String(e));
          s.setSearchSel(0);
        });
    }, 200);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.searchQuery, s.showSearch]);

  useEffect(() => {
    s.setShowHistory(false);
    // Wave 1b (idea 10): a different file means a fresh buffer — clear the
    // stale-write banner and the dirty mirror so old state can't leak onto it.
    s.setStaleFile(null);
    s.editorDirtyRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.openFile?.id]);

  // Is the open file a podcast SCRIPT? One cheap indexed lookup per file open,
  // and it answers a question two surfaces ask: whether the Studio tab shows
  // the Voices panel at all, and whether the tab's own label mentions it.
  //
  // Held in state rather than fetched inside the panel so the ANSWER is
  // available before the panel exists — a panel that mounts on every file and
  // then hides itself would flash "no script attached" over every note in the
  // room on the way to rendering nothing.
  useEffect(() => {
    const id = s.openFile?.id;
    if (!id) {
      s.setOpenPodcast(null);
      return;
    }
    let alive = true;
    void api
      .getPodcast(id)
      .then((p) => {
        // Guard the id too, not only `alive`: two quick file opens can resolve
        // out of order, and the loser would paint its script over the winner's.
        if (alive && s.openFileRef.current?.id === id) s.setOpenPodcast(p);
      })
      .catch(() => alive && s.setOpenPodcast(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.openFile?.id]);

  useEffect(() => {
    s.ctxMenuRef.current = s.ctxMenu !== null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.ctxMenu]);

  useLayoutEffect(() => {
    if (s.ctxMenu)
      a.clampMenu(s.ctxMenuElRef.current, s.ctxMenu.x, s.ctxMenu.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.ctxMenu]);
  useLayoutEffect(() => {
    if (s.moveMenuFor)
      a.clampMenu(s.moveMenuElRef.current, s.moveMenuFor.x, s.moveMenuFor.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.moveMenuFor]);

  // Whether the memory introduction has been seen is a fact about THIS ROOM,
  // so it lives in the room's own settings. It used to be a localStorage key
  // built from the room's file name: renaming the file brought the intro back,
  // and two rooms with the same file name shared one marker.
  useEffect(() => {
    api
      .getSetting(MEMORY_INTRO_SEEN)
      .then((v) => {
        if (v !== "1") s.setShowMemoryIntro(true);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.path]);

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
