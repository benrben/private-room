// Every product area opens, and every viewer kind draws — the check that the
// regression suite did not have.
//
// The four `gh*` specs pin four fixed bugs and nothing else, so Workflows,
// Scripts, Skills, Memory, Connectors, the Room Map and EVERY file viewer had
// no interface check at all. That gap matters more here than in most apps
// because the failure is quiet: `ErrorBoundary` catches a pane that throws on
// mount and prints "couldn't be drawn" INSIDE the pane, and `ViewerRouter`
// does the same for a lazy viewer chunk that fails to load. The app keeps
// working, no test goes red, and only a person clicking that one rail button
// ever finds out.
//
// So each check below is the same three questions, asked of every screen:
//   1. did the place open (the breadcrumb names it)?
//   2. did anything crash into a boundary (`.crash-pane`)?
//   3. did the pane draw actual content, or is it a blank rectangle?
// Plus one the mock can now answer: did opening it reach a command nobody
// faked? `qa-mock` records those on `window.__qaUnhandled`, and a pane fed an
// unhandled command renders "successfully" from nothing at all.

import { openApp, openFile } from "./helpers.mjs";

/** `data-area` on the rail button -> the breadcrumb `AREA_CRUMBS` gives it.
 *
 * Areas stopped being TABS in the notebook pass: the rail is the app's one
 * primary navigation and the tab strip carries documents only, so "its tab is
 * the current tab" is no longer a question with an answer. The breadcrumb is
 * what names the place on screen now, so that is what this asserts. `home`
 * reads "Home" there rather than the old tab's "Room home"; every other
 * wording is unchanged. The notebook pass also added a `find` area — a
 * second, full-page search surface — which P1-2 retired once its filters and
 * result rows moved into ⌘K's own expanded state (SearchExpanded.tsx); ⌘K is
 * a floating overlay rather than a rail destination, so it has no row here. */
const AREAS = [
  ["home", "Home"],
  ["map", "Room Map"],
  ["recordings", "Recordings"],
  ["workflows", "Workflows"],
  ["scripts", "Scripts"],
  ["skills", "Skills"],
  ["memory", "Memory & scratch pad"],
  ["connectors", "Connectors"],
  ["create", "Create"],
  // The Browser area is here because it USED to be the one screen this list
  // could not include: `qa/qa-mock.js` answered none of the browser's
  // mutations, so the pane reached `browser_set_bounds` on mount and the
  // unhandled check below went red for a gap in the harness rather than a
  // defect in the app. The page itself is a native webview and can never
  // exist here — what this proves is that its chrome mounts, polls and draws
  // the start screen underneath.
  ["browser", "Private browser"],
];

/** Library row (the name WITHOUT its extension, as the list shows it) -> the
 *  root element of the viewer that has to take it. One per viewer kind. */
const VIEWERS = [
  ["Arcelle UX direction", ".md-body"],
  ["clean-code", ".pdf-view"],
  ["review-sample", ".docx-view"],
  ["Apollo missions", ".sheet-view"],
  ["prepare release", ".code-editor"],
  ["Product review", ".rec-view"],
];

/** Commands the mock had no fixture for, as a sorted list. */
const unhandled = () =>
  browser.execute(() => Object.keys(window.__qaUnhandled || {}).sort());

/** Nothing in the center pane fell into an error boundary, and the pane is
 * not an empty rectangle. Thrown rather than expect()ed so the failure can
 * carry the boundary's own message, which names what actually broke. */
async function paneDrewSomething(what) {
  const crash = await $(".crash-pane");
  if (await crash.isExisting()) {
    throw new Error(`${what} rendered into an error boundary: ${await crash.getText()}`);
  }
  const text = await (await $(".pane-center")).getText();
  if (!text.trim()) throw new Error(`${what} drew an empty pane`);
}

describe("every area opens and every viewer draws", () => {
  for (const [area, crumb] of AREAS) {
    it(`opens ${crumb}`, async () => {
      await openApp();
      const before = await unhandled();

      await (await $(`.rail-button[data-area="${area}"]`)).click();
      const current = await $(".editor-breadcrumb .crumb-title");
      await browser.waitUntil(async () => (await current.getText()) === crumb, {
        timeout: 10_000,
        timeoutMsg: `the ${area} rail button did not bring up its page`,
      });

      await paneDrewSomething(crumb);
      // Give the pane's own loaders a beat to land before asking what they hit.
      await browser.pause(400);
      const added = (await unhandled()).filter((c) => !before.includes(c));
      if (added.length) {
        throw new Error(
          `${crumb} called commands qa/qa-mock.js does not fake: ${added.join(", ")} — ` +
            `the pane rendered from nothing, so this check is the only sign`,
        );
      }
    });
  }

  for (const [file, viewer] of VIEWERS) {
    it(`draws ${file} in ${viewer}`, async () => {
      await openApp();
      await openFile(file);
      // PDF, docx and the recording view are lazy chunks that then parse real
      // bytes, so this is a wait rather than an immediate assertion.
      await $(viewer).waitForExist({
        timeout: 20_000,
        timeoutMsg: `${file} never reached ${viewer} — the viewer chunk or its parse failed`,
      });
      await paneDrewSomething(file);
    });
  }
});
