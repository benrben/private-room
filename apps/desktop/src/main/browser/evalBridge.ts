// BROWSE-1: the agent's transport into a page.
//
// Port of the "Eval bridge" section of src-tauri/src/browser.rs: `eval_json`,
// `call`/`call_page`/`call_webview`, `mark_superseded`, `probe_ready`,
// `wait_ready`, `doc_id`, `call_async`.
//
// WHY AN INJECTED `EvalHost` AND NOT DIRECT ELECTRON CALLS. Every function here
// takes `{ evaluate(pageId, js): Promise<string> }` rather than reaching for
// `webContents.executeJavaScript` itself. That is the same "minimal injected
// interface" pattern menu.ts uses (`MainWindowLike`), and it is what keeps the
// genuine ORCHESTRATION — timeout handling, the ready-poll loop, the
// async-ticket poll and its navigation-vs-failure disambiguation — unit
// testable against a fake that can produce a timeout, a dropped call or a
// mid-batch navigation deterministically and on demand, which a real renderer
// cannot be made to do on a schedule inside a test. webviewManager.ts supplies
// the one real implementation.
//
// WHY THE WIRE IS RAW JSON TEXT. wry hands back the value serialized by
// `NSJSONSerialization`, and `eval_json` parses it. Electron's
// `executeJavaScript` instead structured-clones the JS value across the process
// boundary, which introduces a failure mode the Rust side never had (a
// non-cloneable value rejects the whole call). Keeping the wire as JSON text —
// the real host wraps the expression in `JSON.stringify(...)` and this module
// is the one place that parses it back — reproduces the Rust contract exactly,
// including its "an empty answer means the script is not there" branch.
//
// WHY THE TICKET POLL SURVIVES. `executeJavaScript` IS a real Promise, so a
// naive port could `await` a long-running expression instead. What happens to
// such a call when its frame navigates mid-flight is not behaviour this port
// can pin down, and `call_async`'s whole reason for existing is that a
// navigation mid-action is the COMMON case (clicking a link, submitting a form,
// accepting a consent wall). `begin` returns immediately, so there is no
// long-lived call to be orphaned; `take` is a cheap per-poll question answered
// either by the document that issued the ticket or by a new one that has never
// heard of it, and `DOC_ID` is what tells those two apart.

import {
  EVAL_LOST,
  EVAL_TIMED_OUT,
  EVAL_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  READY_BUDGET_NAV_MS,
  READY_POLL_MS,
  SCRIPT_REFUSED,
  classifyReady,
  readinessFromProbeError,
  type Readiness,
} from "./readiness.js";

/**
 * What a real (or fake) page-script transport looks like from here. `evaluate`
 * settles with the raw JSON text the page answered, or rejects when the
 * document underneath the call is gone. It must NOT apply a timeout of its own:
 * `evalJson` owns that budget so every caller gets the same wording.
 */
export interface EvalHost {
  evaluate(pageId: string, js: string): Promise<string>;
}

export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface BridgeOptions {
  /** Injected so a test can drive the poll loops without real time. */
  sleep?: Sleep;
  /** Injected so a test can bound a deliberately-hanging evaluate without
   *  waiting out the real 15s budget. */
  timeoutMs?: number;
}

/** Thrown internally by the timeout race; never leaks past `evalJson`, which
 *  always rethrows as the named `EVAL_TIMED_OUT`. */
const TIMEOUT_MARKER = Symbol("evalJson timeout");

/** One page-script round trip, JSON-decoded. Port of `eval_json`. */
export async function evalJson(
  host: EvalHost,
  pageId: string,
  js: string,
  opts: BridgeOptions = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? EVAL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raw: string;
  try {
    raw = await Promise.race([
      host.evaluate(pageId, js),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(TIMEOUT_MARKER), timeoutMs);
      }),
    ]);
  } catch (e) {
    if (e === TIMEOUT_MARKER) throw new Error(EVAL_TIMED_OUT);
    // Every other rejection reads as the document having gone away under the
    // call — the Electron analogue of wry's dropped completion handler. See
    // readiness.ts's header for why this port refuses to invent a third
    // reading of "the call never came back".
    throw new Error(EVAL_LOST);
  } finally {
    clearTimeout(timer);
  }
  if (raw === "" || raw === null || raw === undefined) {
    // The page script is written never to throw and always to answer an
    // object, so nothing at all means the script is not present on this
    // document (still loading, or a document that refused it).
    throw new Error(SCRIPT_REFUSED);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`The page answered with something unreadable: ${(e as Error).message}`);
  }
}

/** The expression every op is sent as. Always evaluates to an object: a page
 *  with no script yet answers `{ok:false,error:…}` rather than `undefined`.
 *  Port of `call_webview`'s `format!`. */
export function buildCallJs(op: string, args: unknown): string {
  return (
    `(window.__arcelleBrowse ? window.__arcelleBrowse.call(${JSON.stringify(op)}, ` +
    `${JSON.stringify(args ?? {})}) : {ok:false,error:"The page script isn't loaded on this page yet."})`
  );
}

/**
 * Call one page op by page id — never "whichever page happens to be showing".
 * A tab switch mid-batch is not news about the op. Port of
 * `call_webview`/`call_page`.
 */
export async function callPage(
  host: EvalHost,
  pageId: string,
  op: string,
  args: unknown,
  opts: BridgeOptions = {},
): Promise<unknown> {
  const v = await evalJson(host, pageId, buildCallJs(op, args), opts);
  if (v !== null && typeof v === "object" && (v as { ok?: unknown }).ok === false) {
    const err = (v as { error?: unknown }).error;
    throw new Error(typeof err === "string" ? err : "The page refused that.");
  }
  return v;
}

/**
 * The readiness probe. Checks BOTH that the script exists and that this
 * document was not superseded — without the first it would call into nothing;
 * without the second it would happily answer from the page being navigated AWAY
 * from, and the snapshot would describe the wrong page. `refused` is asked of
 * the DOCUMENT, so it still answers on a page that refused the script. Port of
 * `READY_JS`.
 */
export const READY_JS =
  '((window.__arcelleBrowse && !window.__arcelleSuperseded)' +
  ' ? window.__arcelleBrowse.call("ping", {})' +
  ' : { ok: false, refused: !window.__arcelleBrowse && document.readyState === "complete" })';

const INFO_JS = '(window.__arcelleBrowse ? window.__arcelleBrowse.call("info", {}) : { ok: false })';

/**
 * Stamp the CURRENT document as superseded, immediately before navigating it.
 * Port of `mark_superseded`.
 *
 * Without this, `waitReady` has a race it cannot see: navigating an already
 * open page leaves the OLD document fully loaded and answering for a moment, so
 * the probe succeeds instantly and the next snapshot describes the page we just
 * left. The mark cannot survive the navigation (a new document gets a fresh
 * global), so "the mark is gone" is exactly "the new document is up".
 * Best-effort, matching Rust's `let _ = wv.eval(...)`.
 */
export async function markSuperseded(host: EvalHost, pageId: string): Promise<void> {
  try {
    await host.evaluate(pageId, "window.__arcelleSuperseded = 1");
  } catch {
    /* best effort — see above */
  }
}

/** Is the page script live on the document we are actually waiting for? Port of
 *  `probe_ready`. `null` means the document answered NOTHING and never will. */
export async function probeReady(
  host: EvalHost,
  pageId: string,
  recordIsBlank: boolean,
  opts: BridgeOptions = {},
): Promise<Readiness | null> {
  try {
    return classifyReady(await evalJson(host, pageId, READY_JS, opts), recordIsBlank);
  } catch (e) {
    return readinessFromProbeError((e as Error).message);
  }
}

/**
 * Wait until the injected page script answers. Port of `wait_ready`.
 *
 * THE BUG THIS EXISTS FOR (live QA 2026-07-29): the script is a document-START
 * user script, so on a fresh navigation it does not exist for a few hundred
 * milliseconds — every first call came back "the page isn't ready yet", the
 * model retried, and the agent burned twenty rounds without ever reaching a
 * page. Readiness is deterministic code: a model must never be asked to decide
 * whether a page has loaded, and must never be handed a transient not-ready as
 * if it were a real failure.
 *
 * `isBlank` is polled FRESH each iteration (it reads live registry state), and
 * a page that gave no sign at all of loading is reported as refusing rather
 * than as slow — a PDF or a strict site used to burn the whole budget and then
 * be blamed for the load.
 */
export async function waitReady(
  host: EvalHost,
  pageId: string,
  isBlank: () => boolean,
  budgetMs: number,
  opts: BridgeOptions = {},
): Promise<void> {
  const sleep = opts.sleep ?? realSleep;
  const started = Date.now();
  let couldStillLoad = false;
  for (;;) {
    const readiness = await probeReady(host, pageId, isBlank(), opts);
    if (readiness === "ready") return;
    if (readiness === "refused") throw new Error(SCRIPT_REFUSED);
    if (readiness === "loading") couldStillLoad = true;
    if (Date.now() - started > budgetMs) {
      if (!couldStillLoad) throw new Error(SCRIPT_REFUSED);
      throw new Error(
        `The page did not finish loading within ${Math.round(budgetMs / 1000)}s. ` +
          `It may be very slow, or it may have refused to load.`,
      );
    }
    await sleep(READY_POLL_MS);
  }
}

/** Which document is answering on ONE page right now, by its per-document
 *  nonce, or `null` if the script cannot be reached at all. Port of `doc_id`. */
export async function docId(host: EvalHost, pageId: string): Promise<string | null> {
  try {
    const v = await evalJson(host, pageId, INFO_JS);
    const doc = (v as { doc?: unknown } | null)?.doc;
    return typeof doc === "string" ? doc : null;
  } catch {
    return null;
  }
}

export interface CallAsyncOptions extends BridgeOptions {
  /** How long to let a document that appeared MID-ACTION finish arriving. */
  navBudgetMs?: number;
  /**
   * Told that the op NAVIGATED the page out from under itself — Rust's
   * `journal(app, "act", "", "The page navigated while acting")`.
   *
   * A hook rather than a journal sink because this module knows nothing about
   * the room; browser.ts supplies the line. It is not optional decoration: an
   * agent action that moved the page is the most consequential thing that can
   * happen mid-batch, the model is told about it, and invariant #2 says the
   * user's own record must say so too.
   */
  onNavigated?(): void;
}

/**
 * Call an ASYNCHRONOUS page op (`act`, `settle`, `annotate`) by ticket. Port of
 * `call_async`.
 *
 * THE BUG THIS GREW FOR (owner report 2026-07-30): the ticket lives in the page
 * script's closure and the script is re-injected per DOCUMENT, so the moment an
 * action NAVIGATES — clicking a link, submitting a form, accepting a consent
 * wall, pressing Enter in a search box — the new document's ticket map is
 * empty, `take` answers "Unknown ticket", and the poll turned that into a hard
 * failure. The click had SUCCEEDED; the model was told it failed and gave up
 * mid-task.
 *
 * So a lost ticket is only an error if the SAME document is still up. Against a
 * new one it means "the op ran and took the page with it", reported as exactly
 * that — never as completion, because a batch interrupted by a navigation
 * genuinely did not finish its later steps.
 */
export async function callAsync(
  host: EvalHost,
  pageId: string,
  op: string,
  args: unknown,
  budgetMs: number,
  isBlank: () => boolean,
  opts: CallAsyncOptions = {},
): Promise<unknown> {
  const sleep = opts.sleep ?? realSleep;
  const navBudgetMs = opts.navBudgetMs ?? READY_BUDGET_NAV_MS;

  const docBefore = await docId(host, pageId);
  const begun = (await callPage(host, pageId, "begin", { op, args }, opts)) as { ticket?: unknown };
  const ticket = begun?.ticket;
  if (typeof ticket !== "string") {
    throw new Error("The page did not start that action.");
  }

  const started = Date.now();
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const taken = (await callPage(host, pageId, "take", { ticket }, opts)) as {
        done?: unknown;
        value?: unknown;
      };
      if (taken?.done === true) {
        return taken.value ?? null;
      }
    } catch (e) {
      // Either "Unknown ticket …" or the empty-answer "will not run the page
      // script" — both are what a document swap looks like from here. Let the
      // replacement document finish arriving before judging.
      await waitReady(host, pageId, isBlank, navBudgetMs, opts).catch(() => undefined);
      const docAfter = await docId(host, pageId);
      if (docAfter === null || docAfter === docBefore) throw e;
      // Journalled BEFORE the snapshot, as in Rust: the fact that the page
      // moved is what the record is for, and it must survive a snapshot that
      // fails.
      opts.onNavigated?.();
      let snapshot: unknown = null;
      try {
        snapshot = await callPage(host, pageId, "snapshot", {}, opts);
      } catch {
        snapshot = null;
      }
      return { ok: true, navigated: true, snapshot };
    }
    if (Date.now() - started > budgetMs) {
      throw new Error(
        `The page was still working after ${Math.round(budgetMs / 1000)}s — it may be stuck loading.`,
      );
    }
  }
}
