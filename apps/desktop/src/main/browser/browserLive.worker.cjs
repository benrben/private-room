// The REAL-Electron worker browserLive.test.ts spawns. See that file's header
// for why this is a subprocess rather than an in-process mock, and for the one
// environment gotcha that makes it possible at all.
//
// Deliberately plain CommonJS: this process is the real Electron binary running
// its own bundled Node, with no TypeScript loader. It re-states, in a few lines
// each, only the WIRING every scenario has to prove — it is not a second copy
// of any policy. The tracker list, the private-range classification and the
// third-party rule are exhaustively covered in rules.test.ts with no Electron
// involved; what cannot be covered there is whether registering a listener on a
// real session genuinely stops a request Chromium's network stack would
// otherwise have completed, and whether a real preload reaches a real page.

let app;
let session;
let net;
let BaseWindow;
let WebContentsView;
let http;
let workerProcess;
let workerSetTimeout;
let PAGE_SCRIPTS;
let EXTRA;

function respond(obj) {
  workerProcess.stdout.write("RESULT:" + JSON.stringify(obj) + "\n");
}

function wait(ms) {
  return new Promise((resolve) => workerSetTimeout(resolve, ms));
}

function netRequest(ses, url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const req = net.request({ url, session: ses });
      req.on("response", (res) => {
        res.on("data", () => {});
        res.on("end", () => done({ ok: true, status: res.statusCode }));
      });
      req.on("error", (e) => done({ ok: false, error: String(e && e.message) }));
      req.end();
    } catch (e) {
      done({ ok: false, error: String(e && e.message) });
    }
    workerSetTimeout(() => done({ ok: false, error: "timed out" }), 8000);
  });
}

/** A tiny local site: a page with an iframe, a 302, and a popup opener. */
function startSite() {
  let port = 0;
  const server = http.createServer((req, res) => {
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><body>" + body + "</body></html>");
    };
    if (req.url === "/frame") return html("<button id='fb'>In frame</button>");
    if (req.url === "/landing") return html("landed");
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:" + port + "/landing" });
      return res.end();
    }
    if (req.url === "/popup") {
      return html("<script>setTimeout(function () { window.open(); }, 30);</script>");
    }
    // The page's OWN first inline script records whether the bridge was already
    // there when it ran — the race the preload has to win.
    return html(
      "<script>window.__sawBridgeAtInline = typeof window.__arcelleBrowse;</script>" +
        "<button id='b'>Hello</button><iframe id='f' src='/frame'></iframe>",
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve({ server, port, base: "http://127.0.0.1:" + port });
    });
  });
}

function makeView(ses, extraPrefs) {
  return new WebContentsView({
    webPreferences: Object.assign(
      { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false },
      extraPrefs || {},
    ),
  });
}

async function runEphemeralScenario() {
    const ephemeral = session.fromPartition("arcelle-live-" + Date.now());
    const persistent = session.fromPartition("persist:arcelle-live-" + Date.now());
    respond({
      ephemeralIsPersistent: ephemeral.isPersistent(),
      ephemeralStoragePath: ephemeral.getStoragePath(),
      persistentIsPersistent: persistent.isPersistent(),
      persistentHasStoragePath: typeof persistent.getStoragePath() === "string",
      // Two different partition names must NOT be the same session object —
      // this is what makes a per-page session real isolation rather than one
      // store with several names.
      differentNamesAreDifferentSessions:
        session.fromPartition("arcelle-live-a") !== session.fromPartition("arcelle-live-b"),
      // …and the SAME name is the SAME session, for the life of the process:
      // the reason a page-id-derived partition name would hand a new room the
      // previous room's cookies.
      sameNameIsTheSameSession:
        session.fromPartition("arcelle-live-a") === session.fromPartition("arcelle-live-a"),
    });
    return;
}

async function runWebRequestBlockScenario() {
    const port = Number(EXTRA);
    const url = "http://127.0.0.1:" + port + "/";
    const blocking = session.fromPartition("arcelle-live-block-" + Date.now());
    blocking.webRequest.onBeforeRequest((details, callback) => {
      let isLocal = false;
      try {
        isLocal = new URL(details.url).hostname === "127.0.0.1";
      } catch (e) {
        isLocal = false;
      }
      callback({ cancel: isLocal });
    });
    const plain = session.fromPartition("arcelle-live-plain-" + Date.now());
    respond({
      blocked: await netRequest(blocking, url),
      allowed: await netRequest(plain, url),
    });
    return;
}

async function runViewsScenario() {
    const win = new BaseWindow({ show: false, width: 200, height: 200 });
    const views = [];
    for (let i = 0; i < 3; i++) {
      const ses = session.fromPartition("arcelle-live-tab-" + i + "-" + Date.now());
      const view = makeView(ses, {});
      win.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: 100, height: 100 });
      views.push({ id: view.webContents.id, sessionIsPersistent: ses.isPersistent() });
    }
    respond({
      views: views,
      allUnique: new Set(views.map((v) => v.id)).size === views.length,
    });
    return;
}

async function runPreloadScenario() {
    const site = await startSite();
    const win = new BaseWindow({ show: false, width: 400, height: 400 });
    const out = {};

    // (1) The real arrangement: preload registered on the session, sandboxed,
    // context-isolated, and loaded into every frame.
    const ses = session.fromPartition("arcelle-live-preload-" + Date.now());
    for (const filePath of PAGE_SCRIPTS) {
      ses.registerPreloadScript({ filePath, type: "frame" });
    }
    const view = makeView(ses, { nodeIntegrationInSubFrames: true });
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 400, height: 400 });
    const wc = view.webContents;
    const navEvents = [];
    wc.on("will-frame-navigate", (e) => navEvents.push({ url: e.url, isMainFrame: e.isMainFrame }));

    await wc.loadURL(site.base + "/");
    await wait(800);

    out.bridgeInMainWorld = await wc.executeJavaScript("typeof window.__arcelleBrowse");
    out.sawBridgeAtFirstInlineScript = await wc.executeJavaScript("window.__sawBridgeAtInline");
    out.ping = await wc.executeJavaScript('window.__arcelleBrowse.call("ping", {})');
    out.snapshotLabels = JSON.parse(
      await wc.executeJavaScript('JSON.stringify(window.__arcelleBrowse.call("snapshot", {}).elements.map(function (e) { return e.label; }))'),
    );
    const frames = wc.mainFrame.frames;
    out.frameCount = frames.length;
    if (frames.length) {
      out.subframeBridge = await frames[0].executeJavaScript("typeof window.__arcelleBrowse");
      out.subframeDoc = await frames[0].executeJavaScript(
        'window.__arcelleBrowse.call("info", {}).doc',
      );
    }
    out.mainDoc = out.ping && out.ping.doc;

    // The superseded mark, set through the host's own transport and read by the
    // exact readiness probe evalBridge.ts sends.
    await wc.executeJavaScript("window.__arcelleSuperseded = 1");
    out.readyProbeAfterSuperseded = await wc.executeJavaScript(
      '((window.__arcelleBrowse && !window.__arcelleSuperseded) ? window.__arcelleBrowse.call("ping", {}) : { ok: false, refused: !window.__arcelleBrowse && document.readyState === "complete" })',
    );

    // `loadURL` is a programmatic navigation: Electron documents that neither
    // navigation event fires for it, which is why browser.ts guards that path
    // itself. The only event above should be the IFRAME's own load.
    out.navEventsDuringLoadURL = navEvents;

    // (2) The same thing WITHOUT nodeIntegrationInSubFrames, to show the flag
    // is load-bearing rather than decorative.
    const ses2 = session.fromPartition("arcelle-live-preload-nosub-" + Date.now());
    for (const filePath of PAGE_SCRIPTS) {
      ses2.registerPreloadScript({ filePath, type: "frame" });
    }
    const view2 = makeView(ses2, {});
    win.contentView.addChildView(view2);
    view2.setBounds({ x: 0, y: 0, width: 400, height: 400 });
    await view2.webContents.loadURL(site.base + "/");
    await wait(800);
    out.withoutSubFrameFlag_main = await view2.webContents.executeJavaScript(
      "typeof window.__arcelleBrowse",
    );
    const frames2 = view2.webContents.mainFrame.frames;
    out.withoutSubFrameFlag_frameCount = frames2.length;
    if (frames2.length) {
      out.withoutSubFrameFlag_sub = await frames2[0].executeJavaScript(
        "typeof window.__arcelleBrowse",
      );
    }

    site.server.close();
    respond(out);
    return;
}

async function runNavigationEventsScenario() {
    const site = await startSite();
    const win = new BaseWindow({ show: false, width: 300, height: 300 });
    const out = {};

    // A server-side 302.
    const ses = session.fromPartition("arcelle-live-redirect-" + Date.now());
    const view = makeView(ses, {});
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 300, height: 300 });
    const seen = [];
    view.webContents.on("will-redirect", (e) =>
      seen.push({ event: "will-redirect", url: e.url, isMainFrame: e.isMainFrame }),
    );
    view.webContents.on("will-frame-navigate", (e) =>
      seen.push({ event: "will-frame-navigate", url: e.url, isMainFrame: e.isMainFrame }),
    );
    await view.webContents.loadURL(site.base + "/redirect");
    await wait(400);
    out.redirectEvents = seen;
    out.finalUrl = view.webContents.getURL();

    // A bare `window.open()`.
    const ses2 = session.fromPartition("arcelle-live-popup-" + Date.now());
    const view2 = makeView(ses2, {});
    win.contentView.addChildView(view2);
    view2.setBounds({ x: 0, y: 0, width: 300, height: 300 });
    const opens = [];
    view2.webContents.setWindowOpenHandler((d) => {
      opens.push({ url: d.url, disposition: d.disposition });
      return { action: "deny" };
    });
    await view2.webContents.loadURL(site.base + "/popup");
    await wait(600);
    out.windowOpenDetails = opens;

    // What a webRequest listener is actually told about a request's frame.
    const ses3 = session.fromPartition("arcelle-live-frames-" + Date.now());
    const requests = [];
    ses3.webRequest.onBeforeRequest((details, callback) => {
      let topUrl = null;
      let hasFrame = false;
      try {
        hasFrame = !!details.frame;
        if (details.frame) topUrl = details.frame.top ? details.frame.top.url : null;
      } catch (e) {
        topUrl = "THREW";
      }
      requests.push({ url: details.url, resourceType: details.resourceType, hasFrame, topUrl });
      callback({ cancel: false });
    });
    const view3 = makeView(ses3, {});
    win.contentView.addChildView(view3);
    view3.setBounds({ x: 0, y: 0, width: 300, height: 300 });
    await view3.webContents.loadURL(site.base + "/");
    await wait(600);
    out.webRequests = requests;

    site.server.close();
    respond(out);
    return;
}

async function run() {
  const scenario = workerProcess.argv[2];
  if (scenario === "ephemeral") return runEphemeralScenario();
  if (scenario === "webrequest-block") return runWebRequestBlockScenario();
  if (scenario === "views") return runViewsScenario();
  if (scenario === "preload") return runPreloadScenario();
  if (scenario === "navigation-events") return runNavigationEventsScenario();
  respond({ error: "unknown scenario: " + scenario });
}

function start() {
  return app
    .whenReady()
    .then(run)
    .then(
      () => app.exit(0),
      (e) => {
        respond({ error: "worker threw: " + String(e && e.stack ? e.stack : e) });
        app.exit(1);
      },
    );
}

function createWorker(deps) {
  ({ app, session, net, BaseWindow, WebContentsView } = deps.electron);
  http = deps.http;
  workerProcess = deps.process || process;
  workerSetTimeout = deps.setTimeout || setTimeout;
  try {
    const parsed = JSON.parse(workerProcess.argv[3]);
    PAGE_SCRIPTS = Array.isArray(parsed) ? parsed : [workerProcess.argv[3]];
  } catch (_error) {
    PAGE_SCRIPTS = [workerProcess.argv[3]];
  }
  EXTRA = workerProcess.argv[4];
  return { run, start };
}

function isWorkerEntrypoint(runtimeProcess = process) {
  return require.main === module || runtimeProcess.argv[1] === __filename;
}

if (isWorkerEntrypoint()) {
  createWorker({ electron: require("electron"), http: require("http"), process, setTimeout }).start();
}

module.exports = { createWorker, isWorkerEntrypoint };
