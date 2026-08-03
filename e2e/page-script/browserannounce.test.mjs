/* Item #18: what a screen reader is told about the private browser.
 *
 * The page is a native child webview. It repaints without changing one node of
 * the host DOM, so assistive tech has no event to report and a screen-reader
 * user is simply never told they moved. `browserAnnounce.ts` turns the chrome's
 * existing 1200 ms `browser_info` poll into that missing event stream, and this
 * is where its two rules are held: never claim a page LOADED unless the page
 * said so, and never repeat yourself.
 *
 * Run by `npm run test:page` alongside the page-script tests. Same trick as
 * address.test.mjs: the module is TypeScript and these are plain Node, so it is
 * type-stripped with the `typescript` dev dependency and imported from memory.
 * There is no React renderer in this repo's harness, so what is tested here is
 * the decision, not the markup that carries it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(here, "../../src/workspace/browserAnnounce.ts"),
  "utf8",
);
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { announcement, hostOf, stalledBanner } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

const loaded = {
  open: true,
  url: "https://example.com/article",
  title: "An Article",
  ready: "complete",
};

test("a poll that changed nothing says nothing", () => {
  // The poll runs every 1.2 seconds for as long as the area is open. A live
  // region that re-announces the same sentence at that rate is not information.
  assert.equal(announcement(loaded, { ...loaded }), null);
});

test("the first sight of a loaded page names the title and where it is", () => {
  const said = announcement(null, loaded);
  assert.match(said, /An Article/);
  assert.match(said, /example\.com/);
});

test("a page that has not finished loading is never announced as loaded", () => {
  const said = announcement(loaded, {
    open: true,
    url: "https://other.example/next",
    title: "",
    ready: "loading",
  });
  assert.match(said, /^Loading other\.example\./);
  assert.doesNotMatch(said, /Loaded/);
});

test("the same URL going from loading to complete is announced", () => {
  // The single most important transition there is, and the one a URL-only diff
  // would swallow.
  const mid = { open: true, url: "https://example.com/a", title: "", ready: "loading" };
  const done = { open: true, url: "https://example.com/a", title: "A", ready: "complete" };
  assert.match(announcement(mid, done), /Loaded: A\./);
});

test("plain HTTP is said out loud, not left to a padlock icon", () => {
  const said = announcement(null, {
    open: true,
    url: "http://neighbour.example/login",
    title: "Sign in",
    ready: "complete",
  });
  assert.match(said, /Not encrypted/);
  assert.doesNotMatch(announcement(null, loaded), /Not encrypted/);
});

test("a page with no title says so rather than announcing an empty name", () => {
  const said = announcement(null, {
    open: true,
    url: "https://example.com/x",
    title: "",
    ready: "complete",
  });
  assert.match(said, /no title/);
});

test("a page that stopped answering outranks everything else", () => {
  // The one state where the address bar and the truth can disagree: the poll
  // still knows the last URL, and the page is not there any more.
  const said = announcement(loaded, {
    ...loaded,
    error: "This page will not run the assistant's page script.",
  });
  assert.match(said, /not answering/);
  assert.doesNotMatch(said, /^Loaded/);
});

test("a blank tab and a closed browser are different sentences", () => {
  assert.match(announcement(loaded, { open: true, blank: true }), /Nothing is loaded/);
  assert.match(announcement(loaded, { open: false }), /closed/);
  // ...and neither repeats on the next poll.
  assert.equal(announcement({ open: false }, { open: false }), null);
});

test("hostOf refuses to guess at an address that will not parse", () => {
  assert.equal(hostOf("not a url"), null);
  assert.equal(hostOf(null), null);
  assert.equal(hostOf("https://example.com:8443/x"), "example.com:8443");
});

test("a page that stopped answering says so ON SCREEN, not only to a screen reader", () => {
  // browser_info reports WHY a poll got no answer and the address bar then
  // falls back to Rust's own record of where the page was sent — so the chrome
  // looks completely normal over a page it can no longer see. The reason was
  // consumed by the live region and by nothing else, which left every sighted
  // user with a confident address bar and no page behind it.
  const said = stalledBanner({ ...loaded, error: "the page did not answer" });
  assert.match(said, /stopped answering/);
  assert.match(said, /the page did not answer/, "the reason itself must be shown");
  assert.match(said, /out of date/);
  // A healthy page, a blank tab and a closed browser carry no banner at all.
  assert.equal(stalledBanner(loaded), null);
  assert.equal(stalledBanner({ open: true, blank: true, error: "x" }), null);
  assert.equal(stalledBanner({ open: false, error: "x" }), null);
  // An empty reason is not a reason: say the fact without the parenthesis.
  const bare = stalledBanner({ ...loaded, error: "   " });
  assert.match(bare, /stopped answering, so/);
  assert.doesNotMatch(bare, /\(\)/);
});
