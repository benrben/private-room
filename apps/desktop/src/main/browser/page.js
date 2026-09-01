(function () {
  "use strict";
  if (window.__arcelleBrowse) return;
  var scope = window.__arcellePageScope;
  if (!scope) return;
  var DOC_ID = scope.DOC_ID;
  var MARK_CAP = scope.MARK_CAP;
  var capture = scope.capture;
  var doOne = scope.doOne;
  var drawBadges = scope.drawBadges;
  var find = scope.find;
  var hasSelection = scope.hasSelection;
  var isSecret = scope.isSecret;
  var labelFor = scope.labelFor;
  var leaveRequested = scope.leaveRequested;
  var lowSignal = scope.lowSignal;
  var pageHtml = scope.pageHtml;
  var read = scope.read;
  var readMarkdown = scope.readMarkdown;
  var regionFor = scope.regionFor;
  var registry = scope.registry;
  var removeBadges = scope.removeBadges;
  var resolve = scope.resolve;
  var roleFor = scope.roleFor;
  var snapshot = scope.snapshot;
  var takeLeaveRequest = scope.takeLeaveRequest;


  // ---------------------------------------------------------------- settle

  /** Resolve once the page has stopped moving: navigation complete, no new
   *  network resources for `netQuiet`, no DOM mutations for `domQuiet`. This
   *  exists so "waiting" is deterministic code and never a model turn — a 4B
   *  asked to decide when a page is ready will burn turns guessing. */
  function settleState() {
    var now = Date.now();
    return { lastNet: now, lastDom: now };
  }


  function observeNetwork(state) {
    try {
      var observer = new PerformanceObserver(function () {
        state.lastNet = Date.now();
      });
      observer.observe({ entryTypes: ["resource"] });
      return observer;
    } catch (e) {
      return null;
    }
  }


  function observeMutations(state) {
    try {
      var observer = new MutationObserver(function () {
        state.lastDom = Date.now();
      });
      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      return observer;
    } catch (e) {
      return null;
    }
  }


  function disconnectObserver(observer) {
    if (!observer) return;
    try {
      observer.disconnect();
    } catch (e) {}
  }


  function settleResult(state, started, budget) {
    var now = Date.now();
    var ready = document.readyState === "complete" || document.readyState === "interactive";
    var quiet = now - state.lastNet > 500 && now - state.lastDom > 350;
    var expired = now - started > budget;
    if (!((ready && quiet) || expired)) return null;
    return { settled: !expired, waitedMs: now - started };
  }


  function settle(budgetMs) {
    var budget = budgetMs || 5000;
    return new Promise(function (resolve) {
      var state = settleState();
      var po = observeNetwork(state);
      var mo = observeMutations(state);
      var started = Date.now();
      var timer = setInterval(function () {
        var result = settleResult(state, started, budget);
        if (!result) return;
        clearInterval(timer);
        disconnectObserver(po);
        disconnectObserver(mo);
        resolve(result);
      }, 60);
    });
  }


  function waitRefNumber(ref) {
    return Number(String(ref).replace(/^e/i, ""));
  }


  /** Did the numbering the model is holding ever hand out this number? */
  function issuedRef(ref) {
    var number = waitRefNumber(ref);
    return isFinite(number) && registry.has(number);
  }


  function liveWaitElement(ref) {
    var weak = registry.get(waitRefNumber(ref));
    var element = weak ? weak.deref() : null;
    return element && element.isConnected ? element : null;
  }


  function waitTextHit(text) {
    return (
      (document.body ? document.body.innerText || "" : "")
        .toLowerCase()
        .indexOf(String(text).toLowerCase()) >= 0
    );
  }


  function waitHit(spec) {
    try {
      if (spec.text) return waitTextHit(spec.text);
      if (spec.gone) return !liveWaitElement(spec.gone);
    } catch (e) {}
    return false;
  }


  function unknownGoneWait(spec) {
    return {
      found: false,
      waitedMs: 0,
      error:
        String(spec.gone) +
        " is not one of this page's refs, so there was nothing to wait for" +
        " — take a fresh browse_snapshot.",
    };
  }


  function waitFor(spec, budgetMs) {
    var budget = budgetMs || 8000;
    var started = Date.now();
    // "Gone" means it WENT away, so the number has to be one this page issued.
    // Without this a typo or a number from an older numbering resolved to
    // nothing on the first 100ms tick and reported a wait that never happened
    // — "wait until the spinner disappears" succeeding instantly against a
    // page still spinning.
    //
    // Asked of the REGISTRY, not of `resolve_`: a ref this numbering issued
    // whose element has since been detached IS gone, and the commonest batch
    // there is — click the banner's close button, then wait for the banner to
    // go — hands exactly that. Refusing it would call a batch that did what it
    // was asked a failure, word it "was not on the page to begin with" about
    // something that plainly was, and bill for a screenshot of it.
    if (spec.gone && !issuedRef(spec.gone)) return Promise.resolve(unknownGoneWait(spec));
    return new Promise(function (resolve) {
      var timer = setInterval(function () {
        var hit = waitHit(spec);
        if (!hit && Date.now() - started <= budget) return;
        clearInterval(timer);
        resolve({ found: hit, waitedMs: Date.now() - started });
      }, 100);
    });
  }


  function waitedActionResult(wait, waitFor) {
    if (wait.error) return { ok: false, error: wait.error };
    if (waitFor.gone) {
      return {
        ok: wait.found,
        did: wait.found ? "waited until it disappeared" : "waited, but it was still there",
      };
    }
    return {
      ok: wait.found,
      did: wait.found ? "waited until it appeared" : "waited, but it never appeared",
    };
  }


  async function actionResult(action) {
    if (action && action.wait_for) {
      var wait = await waitFor(action.wait_for, action.wait_for.timeout_ms);
      return waitedActionResult(wait, action.wait_for);
    }
    try {
      return doOne(action);
    } catch (e) {
      return { ok: false, error: "That action failed: " + (e && e.message ? e.message : e) };
    }
  }


  function actionSettleMs(action) {
    return action && action.settle_ms ? action.settle_ms : 2500;
  }


  function hasNavigated(beforeUrl, index, actions) {
    return location.href !== beforeUrl && index < actions.length - 1;
  }


  function actionList(args) {
    return (args && args.actions) || [];
  }


  function isActionList(actions) {
    return Array.isArray(actions) && actions.length > 0;
  }


  function failedActionRun(results, index) {
    return { results: results, stopped: index, cutShort: false };
  }


  function navigatedActionRun(results, index) {
    results.push({ ok: true, did: "page changed — remaining actions skipped" });
    return { results: results, stopped: index, cutShort: true };
  }


  function completedActionRun(results) {
    return { results: results, stopped: null, cutShort: false };
  }


  async function runActions(actions, beforeUrl) {
    var results = [];
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      var r = await actionResult(a);
      results.push(r);
      if (!r.ok) {
        // Stop on the first failure: the model's later actions were planned
        // against a page state that never happened.
        return failedActionRun(results, i);
      }
      await settle(actionSettleMs(a));
      // A same-document navigation invalidates every remaining ref; the rest
      // of the batch was planned against the old page, so stop and re-report.
      if (hasNavigated(beforeUrl, i, actions)) {
        return navigatedActionRun(results, i);
      }
    }
    return completedActionRun(results);
  }


  async function act(args) {
    var actions = actionList(args);
    if (!isActionList(actions)) return { ok: false, error: "act needs a non-empty actions array." };
    var beforeUrl = location.href;
    var run = await runActions(actions, beforeUrl);
    await settle(3000);
    var snap = snapshot({ badges: false });
    return {
      ok: run.stopped === null,
      // Same flag the cross-document path answers with (browser::call_async),
      // so ONE reading covers both: the batch was cut short by a navigation,
      // not by a failure. Without it every action had succeeded, `ok` was
      // false because the batch stopped, and the model was told "an action
      // failed" and billed for a screenshot of a page nothing had gone wrong
      // on.
      navigated: run.cutShort,
      results: run.results,
      stoppedAt: run.stopped,
      urlChanged: location.href !== beforeUrl,
      snapshot: snap,
    };
  }


  // ------------------------------------------------------- ticket plumbing

  var tickets = new Map();

  var ticketSeq = 0;


  function settledTicket(args) {
    return settle(args && args.budget_ms).then(function (settled) {
      return Object.assign({ ok: true }, settled, { snapshot: snapshot({ badges: false }) });
    });
  }


  var ASYNC_HANDLERS = { act: act, annotate: annotate };


  function asyncOperation(op, args) {
    if (op === "settle") return settledTicket(args);
    var handler = ASYNC_HANDLERS[op];
    if (!handler) return Promise.resolve({ ok: false, error: "Unknown async op: " + op });
    return handler(args);
  }


  function caughtAsyncOperation(op, args) {
    try {
      return asyncOperation(op, args);
    } catch (e) {
      return Promise.resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  }


  function ticketSucceeded(rec, value) {
    rec.value = value;
    rec.done = true;
  }


  function ticketFailed(rec, error) {
    rec.value = { ok: false, error: String(error && error.message ? error.message : error) };
    rec.done = true;
  }


  function begin(op, args) {
    var id = "t" + ++ticketSeq;
    var rec = { done: false, value: null };
    tickets.set(id, rec);
    var operation = caughtAsyncOperation(op, args);
    operation.then(
      function (v) {
        ticketSucceeded(rec, v);
      },
      function (e) {
        ticketFailed(rec, e);
      },
    );
    return { ok: true, ticket: id };
  }


  function take(id) {
    if (!tickets.has(id)) return { ok: false, error: "Unknown ticket " + id };
    var rec = tickets.get(id);
    if (!rec.done) return { ok: true, done: false };
    tickets.delete(id);
    return { ok: true, done: true, value: rec.value };
  }


  /** Paint (or clear) the mark badges and wait two frames, so a screenshot
   *  taken right after this call is guaranteed to contain them. */
  function annotate(args) {
    var on = !args || args.on !== false;
    return new Promise(function (resolve) {
      try {
        if (on) {
          if (registry.size > 0) {
            drawBadges();
          } else snapshot({ badges: true });
        } else removeBadges();
      } catch (e) {}
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          resolve({ ok: true, badges: on, marks: registry.size });
        });
      });
    });
  }


  /** How many sizeable video/3D areas are on screen.
   *
   *  `WKWebView`'s snapshot API composites the DOM, not the media layers: a
   *  playing `<video>` and a WebGL canvas come back as EMPTY rectangles in a
   *  screenshot, with no error and no clue that anything is missing. Counting
   *  them here is what lets `browse_look` say so, instead of leaving the model
   *  to describe a playing video as "nothing there". */
  function isMediaArea(node) {
    var rect = node.getBoundingClientRect();
    return rect.width >= 64 && rect.height >= 64 && rect.bottom > 0 && rect.top < window.innerHeight;
  }


  function mediaAreas() {
    var n = 0;
    try {
      var nodes = document.querySelectorAll("video, canvas");
      for (var i = 0; i < nodes.length; i++) {
        // Big enough to be a picture, and actually in the viewport a
        // screenshot would cover. A tracking pixel drawn on a 1×1 canvas is
        // not something the model would have described anyway.
        if (isMediaArea(nodes[i])) n++;
      }
    } catch (e) {}
    return n;
  }


  // ------------------------------------------------------------------ entry

  /** The single synchronous entry point. Total by construction: any throw
   *  becomes `{ok:false,error}` rather than the empty string an uncaught
   *  exception would hand the Rust side. */
  function ping() {
    return { ok: true, url: location.href, title: document.title || "", ready: document.readyState, doc: DOC_ID };
  }


  function beginCall(args) {
    return begin((args && args.op) || "", (args && args.args) || {});
  }


  function takeCall(args) {
    return take((args && args.ticket) || "");
  }


  function pageInfo() {
    return {
      ok: true,
      url: location.href,
      title: document.title || "",
      ready: document.readyState,
      mediaAreas: mediaAreas(),
      // Read-and-clear: the poll that sees this is the one that acts on
      // it, so a single double-Escape can never hand the keyboard back
      // twice.
      leaveRequested: takeLeaveRequest(),
      // Is there a passage selected right now? Rides on the poll that is
      // already running rather than costing a round trip of its own —
      // the assistant's scope strip has to know whether to OFFER a
      // "selected passage" scope, and a scope it offers for a selection
      // that does not exist can only refuse. Read the same way `capture`
      // reads it, so the two cannot disagree about what counts.
      hasSelection: hasSelection(),
      doc: DOC_ID,
    };
  }


  var CALL_HANDLERS = {
    "ping": ping,
    "snapshot": snapshot,
    "read": read,
    "capture": capture,
    "find": find,
    "begin": beginCall,
    "take": takeCall,
    "info": pageInfo,
  };


  function call(op, args) {
    try {
      var handler = CALL_HANDLERS[op];
      if (handler) return handler(args);
      return { ok: false, error: "Unknown op: " + op };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }


  var api = {
    call: call,
    // Exposed for the Node test harness; not part of the production contract —
    // only `call` crosses into Electron's main world (see the export footer).
    _internals: {
      snapshot: snapshot,
      read: read,
      capture: capture,
      find: find,
      doOne: doOne,
      resolve: resolve,
      isSecret: isSecret,
      labelFor: labelFor,
      roleFor: roleFor,
      regionFor: regionFor,
      lowSignal: lowSignal,
      readMarkdown: readMarkdown, pageHtml: pageHtml,
      registry: registry,
      MARK_CAP: MARK_CAP,
    },
  };


  /* THE ELECTRON EXPORT FOOTER — the one adaptation to this otherwise-unchanged
   * file. See the module header for the whole story.
   *
   * As a real preload under `contextIsolation`, this script's world is not the
   * page's, so a bare assignment would publish `__arcelleBrowse` somewhere the
   * host's main-world `executeJavaScript` can never see it. `contextBridge`
   * carries only `call` across, which is the sole entry point evalBridge.ts
   * uses in production and already takes and returns plain JSON-shaped values.
   *
   * The plain assignment stays as the fallback, taken by this file's own
   * Node/linkedom harness (pageScriptHarness.ts), where `require` does not
   * exist, and by any embedding running with contextIsolation off.
   */
  if (typeof require === "function") {
    try {
      require("electron").contextBridge.exposeInMainWorld("__arcelleBrowse", { call: call });
    } catch (e) {
      window.__arcelleBrowse = api;
    }
  } else {
    window.__arcelleBrowse = api;
  }
  Object.assign(scope, { settleState: settleState, observeNetwork: observeNetwork, observeMutations: observeMutations, disconnectObserver: disconnectObserver, settleResult: settleResult, settle: settle, waitRefNumber: waitRefNumber, issuedRef: issuedRef, liveWaitElement: liveWaitElement, waitTextHit: waitTextHit, waitHit: waitHit, unknownGoneWait: unknownGoneWait, waitFor: waitFor, waitedActionResult: waitedActionResult, actionResult: actionResult, actionSettleMs: actionSettleMs, hasNavigated: hasNavigated, actionList: actionList, isActionList: isActionList, failedActionRun: failedActionRun, navigatedActionRun: navigatedActionRun, completedActionRun: completedActionRun, runActions: runActions, act: act, tickets: tickets, ticketSeq: ticketSeq, settledTicket: settledTicket, ASYNC_HANDLERS: ASYNC_HANDLERS, asyncOperation: asyncOperation, caughtAsyncOperation: caughtAsyncOperation, ticketSucceeded: ticketSucceeded, ticketFailed: ticketFailed, begin: begin, take: take, annotate: annotate, isMediaArea: isMediaArea, mediaAreas: mediaAreas, ping: ping, beginCall: beginCall, takeCall: takeCall, pageInfo: pageInfo, CALL_HANDLERS: CALL_HANDLERS, call: call, api: api });
})();
