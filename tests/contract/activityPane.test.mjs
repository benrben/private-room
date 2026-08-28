/* The Activity PANE, not just the rule it obeys.
 *
 * `activity.test.mjs` pins `groupActivity` — the pure split of jobs into live
 * work and a finished record. That left a real hole: nothing proved AiPane put
 * the two groups in two different places on the screen. A regression that
 * rendered every history row inside the live section, buttons and all, would
 * have passed the whole suite while telling the user that finished work was
 * still running and offering them a Stop for it.
 *
 * So this renders the REAL `ActivityPanel` out of the REAL `AiPane.tsx`
 * (type-stripped in memory, same trick as the other page tests) with
 * `react-dom/server`, and asserts which SECTION each row landed in. Mixing the
 * two now fails here.
 *
 * It also pins the other half of the same failure mode: a control that renders
 * but does nothing. Every live-row button is clicked through the real
 * `makeStudioActions` and the real `api`, with only Tauri's `invoke` replaced
 * by a recorder — so the test says which backend command the click reaches, and
 * a button wired to nothing has no command to show.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../../apps/desktop/src/renderer");

/* ---------- loading real TSX under plain node ---------- */

// The app's own React, resolved to the file URL Node would use anyway, so the
// component and `react-dom/server` share one instance and hooks work.
const BARE = {
  react: import.meta.resolve("react"),
  "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
};

const asData = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

// `import … from "x";` and `export … from "x";` — api.ts re-exports its type
// module, and a missed re-export would leave a specifier node cannot resolve.
const FROM_RE = /(?:import|export)\s+([\s\S]*?)\s+from\s+"([^"]+)";/g;

/** The named/default bindings an import clause actually pulls in. Type-only
 *  imports are already gone — TypeScript elides them when it strips types. */
function bindingsOf(clause) {
  const names = [];
  const braced = clause.match(/\{([\s\S]*)\}/);
  if (braced) {
    for (const raw of braced[1].split(",")) {
      const n = raw.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.push(n);
    }
  }
  const head = clause.replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim();
  return { names, hasDefault: Boolean(head) };
}

/** A module that satisfies an import without pretending to do its job: every
 *  binding is an inert function, which is both a valid React component and a
 *  callable that returns nothing. `overrides` supplies the few bindings a test
 *  needs to be real (the invoke recorder). */
function stubModule(clause, overrides = {}) {
  const { names, hasDefault } = bindingsOf(clause);
  const body = [
    "const inert = () => null;",
    ...names.map((n) => `export const ${n} = ${overrides[n] ?? "inert"};`),
    hasDefault ? "export default inert;" : "",
  ].join("\n");
  return asData(body);
}

// Tauri is not present under `node --test`. `invoke` is the seam we care
// about: it records the command name a click ends up asking the host for.
const INVOKE_RECORDER =
  "(cmd, args) => { (globalThis.__invokeCalls ??= []).push([cmd, args]); return Promise.resolve(undefined); }";

/** Load a real .ts/.tsx file and everything it really imports, stubbing only
 *  what this environment cannot provide (Tauri) and what the caller names. */
function loadReal(absPath, stubbed, cache = new Map()) {
  const hit = cache.get(absPath);
  if (hit) return hit;
  const jsx = absPath.endsWith(".tsx");
  let js = ts.transpileModule(readFileSync(absPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    },
  }).outputText;

  js = js.replace(FROM_RE, (whole, clause, spec) => {
    const swap = (url) => whole.replace(`"${spec}"`, JSON.stringify(url));
    if (BARE[spec]) return swap(BARE[spec]);
    if (spec.startsWith("@tauri-apps/")) {
      return swap(
        stubModule(
          clause,
          spec === "@tauri-apps/api/core" ? { invoke: INVOKE_RECORDER } : {},
        ),
      );
    }
    if (spec.startsWith(".")) {
      const base = resolve(dirname(absPath), spec);
      const target = [".ts", ".tsx", "/index.ts"]
        .map((ext) => base + ext)
        .find(existsSync);
      assert.ok(target, `cannot resolve ${spec} from ${absPath}`);
      if (target.endsWith("/platform.ts")) {
        return swap(stubModule(clause, { invoke: INVOKE_RECORDER }));
      }
      if (stubbed.has(target)) return swap(stubModule(clause));
      return swap(loadReal(target, stubbed, cache));
    }
    // A bare dependency this test has no opinion about (none today) — stub it
    // rather than silently drop it, so a new one shows up as a failing test.
    return swap(stubModule(clause));
  });

  // ActivityPanel and JobRow are private to AiPane.tsx, and should stay that
  // way: nothing in the app renders them from outside. Re-exporting them here
  // keeps the test pointed at the shipped code instead of a copy of it.
  if (absPath.endsWith("AiPane.tsx")) js += "\nexport { ActivityPanel, JobRow };\n";

  const url = asData(js);
  cache.set(absPath, url);
  return url;
}

// AiPane's siblings (chat, the studio shelf, the icon set) are not what this
// test is about, and dragging them in would pull half the app.
const PANE_STUBS = new Set(
  ["workspace/ChatPane.tsx", "workspace/StudioShelf.tsx", "icons.tsx", "workspace/markup.ts"].map(
    (p) => join(SRC, p),
  ),
);
const { ActivityPanel, JobRow } = await import(
  loadReal(join(SRC, "workspace/AiPane.tsx"), PANE_STUBS)
);
const { makeStudioActions } = await import(
  loadReal(join(SRC, "workspace/studioActions.ts"), new Set())
);

/* ---------- fixtures ---------- */

const job = (id, status, title, extra = {}) => ({
  id,
  status,
  title,
  kind: "deep_summary",
  cursor: 1,
  total: 3,
  createdAt: "2026-08-03T10:00:00.000Z",
  updatedAt: "2026-08-03T10:05:00.000Z",
  ...extra,
});

const paneState = (jobs, organized = []) => ({
  jobs,
  // Library changes the assistant made. Not jobs — no duration, no steps, and
  // nothing to resume — so they are their own group and are counted as none.
  organized,
  jobProgress: {},
  scriptApprovals: [],
  mcpApprovals: [],
  browseConsents: [],
  editApprovals: [],
  summaryStarting: false,
  recSave: null,
  recLive: null,
  importProgress: null,
  // AUDIT 262: the two background lanes the pane now reports — a Studio run's
  // current step, and the scanned pages being read. Both were emitted by the
  // host from the first build with nothing listening.
  studioStep: "",
  ocrFiles: [],
});

const render = (s, a = {}) =>
  renderToStaticMarkup(createElement(ActivityPanel, { s, a }));

/** The markup of one `<section class="…">`, boundaries included. Sections do
 *  not nest in this pane, but the scan counts anyway so a future wrapper
 *  cannot silently hand back the wrong slice. */
function sectionHtml(html, className) {
  const open = html.indexOf(`<section class="${className}"`);
  if (open < 0) return null;
  let depth = 0;
  let i = open;
  for (;;) {
    const nextOpen = html.indexOf("<section", i);
    const nextClose = html.indexOf("</section>", i);
    if (nextClose < 0) return null;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + "<section".length;
    } else {
      depth -= 1;
      i = nextClose + "</section>".length;
      if (depth === 0) return html.slice(open, i);
    }
  }
}

/* ---------- the render, section by section ---------- */

test("the pane renders live work and the finished record in DIFFERENT sections", () => {
  const jobs = [
    job("r", "running", "RUNNING-ROW"),
    job("q", "queued", "QUEUED-ROW"),
    job("p", "paused", "PAUSED-ROW"),
    job("e", "error", "ERROR-ROW"),
    job("d", "done", "DONE-ROW"),
  ];
  const html = render(paneState(jobs));
  const live = sectionHtml(html, "activity-live");
  const history = sectionHtml(html, "activity-history");
  assert.ok(live, "the live section must exist");
  assert.ok(history, "a finished job must produce the history section");

  for (const title of ["RUNNING-ROW", "QUEUED-ROW", "PAUSED-ROW", "ERROR-ROW"]) {
    assert.ok(live.includes(title), `${title} belongs to the live manager`);
    assert.ok(
      !history.includes(title),
      `${title} is still actionable — filing it under History would say it finished`,
    );
  }
  assert.ok(history.includes("DONE-ROW"), "a finished job belongs to History");
  assert.ok(
    !live.includes("DONE-ROW"),
    "a finished job in the live section would offer a Stop for work that is over",
  );
});

test("every rendered row lands in exactly one of the two sections", () => {
  // The counting version of the test above: no row duplicated into both, none
  // rendered outside either (which is how a row would keep its buttons while
  // sitting under the History heading).
  const jobs = [
    job("r", "running", "ONLY-ONCE-A"),
    job("d1", "done", "ONLY-ONCE-B"),
    job("d2", "done", "ONLY-ONCE-C"),
  ];
  const html = render(paneState(jobs));
  const live = sectionHtml(html, "activity-live");
  const history = sectionHtml(html, "activity-history");
  const count = (hay, needle) => hay.split(needle).length - 1;
  for (const title of ["ONLY-ONCE-A", "ONLY-ONCE-B", "ONLY-ONCE-C"]) {
    assert.equal(count(html, title), 1, `${title} rendered more than once`);
    assert.equal(
      count(live, title) + count(history, title),
      1,
      `${title} rendered outside both sections`,
    );
  }
});

test("nothing in the history section is clickable", () => {
  // "A record, nothing to act on" is a promise the markup has to keep: a
  // finished job is not a thing you Stop, Resume or Retry.
  const html = render(paneState([job("d", "done", "FINISHED")]));
  const history = sectionHtml(html, "activity-history");
  assert.ok(history.includes("FINISHED"));
  assert.ok(!history.includes("<button"), "History must carry no controls");
});

test("a room with only finished jobs renders History and no live rows", () => {
  const html = render(paneState([job("d", "done", "LAST-WEEK")]));
  const live = sectionHtml(html, "activity-live");
  assert.ok(!live.includes("activity-row"), "nothing is running");
  assert.ok(sectionHtml(html, "activity-history").includes("LAST-WEEK"));
});

test("a room with only live jobs renders no history section at all", () => {
  const html = render(paneState([job("r", "running", "IN-FLIGHT")]));
  assert.equal(
    sectionHtml(html, "activity-history"),
    null,
    "an empty log must read as empty — no heading claiming a record exists",
  );
  assert.ok(sectionHtml(html, "activity-live").includes("IN-FLIGHT"));
});

/* ---------- the assistant's Library changes are part of the record ------- */

const promoted = (over = {}) => ({
  seq: 1,
  id: "f1",
  name: "Portfolio map.sketch",
  linked: true,
  ...over,
});

test("a Library change the assistant made is recorded, not only chatted", () => {
  // It used to exist solely inside the turn that made it: findable by
  // scrolling the transcript back to the right message, and absent from the
  // panel that offers itself as the room's record of what has been done to it.
  const html = render(paneState([], [promoted()]));
  const section = sectionHtml(html, "activity-organized");
  assert.ok(section, "the change must have a section of its own");
  assert.ok(section.includes("Portfolio map"), "it must name the object");
  assert.ok(section.includes("Added"), "and say which way it went");
  assert.ok(!section.includes("<button"), "a record carries no controls");
});

test("a demotion is recorded as what it is, and says nothing was deleted", () => {
  const section = sectionHtml(
    render(paneState([], [promoted({ linked: false })])),
    "activity-organized",
  );
  assert.ok(section.includes("Removed"));
  assert.ok(
    /untouched/.test(section),
    "the record must not read as a deletion — that is the whole fear it answers",
  );
});

test("Library changes are recorded beside jobs, never counted as one", () => {
  const html = render(paneState([], [promoted()]));
  assert.equal(
    sectionHtml(html, "activity-history"),
    null,
    "a promotion is not a finished job and must not conjure a job log",
  );
  const live = sectionHtml(html, "activity-live");
  assert.ok(!live.includes("activity-row"), "nor is it work in flight");
});

test("doing the same thing twice to one object is two rows, not one", () => {
  // Add, remove, add is three acts and two of them are identical — the record
  // has to keep them apart, which is what the arrival counter is for.
  const html = render(
    paneState([], [
      promoted({ seq: 3 }),
      promoted({ seq: 2, linked: false }),
      promoted({ seq: 1 }),
    ]),
  );
  const section = sectionHtml(html, "activity-organized");
  assert.equal(section.split("Portfolio map").length - 1, 3);
  assert.equal(section.split("Added").length - 1, 2);
  assert.equal(section.split("Removed").length - 1, 1);
});

test("a room whose only event was a promotion does not claim to be idle", () => {
  const html = render(paneState([], [promoted()]));
  assert.ok(
    !html.includes("The room is idle"),
    "something happened, and the pane's own empty state would deny it",
  );
  assert.ok(render(paneState([], [])).includes("The room is idle"));
});

test("the history section says how many of how many it is showing", () => {
  const many = Array.from({ length: 30 }, (_, i) => job(`d${i}`, "done", `OLD-${i}`));
  const history = sectionHtml(render(paneState(many)), "activity-history");
  assert.ok(history.includes("25"), "the cap");
  assert.ok(history.includes("30"), "the true total — the rest is not hidden silently");
});

/* ---------- the live section's controls actually do something ---------- */

/** Every `<button>` element in a rendered React tree, in document order. */
function buttonsIn(node, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) buttonsIn(n, out);
    return out;
  }
  if (node.type === "button") out.push(node);
  buttonsIn(node.props?.children, out);
  return out;
}

const labelOf = (btn) => {
  const kids = btn.props?.children;
  const text = typeof kids === "string" ? kids : "";
  return `${text} ${btn.props?.title ?? ""} ${btn.props?.["aria-label"] ?? ""}`;
};

/** JobRow takes no hooks, so it can be called directly and its element tree
 *  inspected — which is the only way to reach an onClick and prove it leads
 *  somewhere. */
const rowButtons = (j, a) =>
  buttonsIn(
    JobRow({ j, s: paneState([j]), a, elapsedOf: () => "0:03" }),
  );

/** The real action set, wired to the real `api`, with Tauri's `invoke`
 *  recording instead of calling. */
function realActions() {
  globalThis.__invokeCalls = [];
  const s = {
    jobs: [],
    pushToast: () => {},
    setJobs: () => {},
    setJobProgress: () => {},
    setSummaryStarting: () => {},
    setAiBusy: () => {},
    studioDefaults: null,
    setStudioDefaults: () => {},
    files: [],
    summaryStarting: false,
  };
  return makeStudioActions(s, {
    viewFile: async () => {},
    openOllamaApp: async () => {},
  });
}

const commands = () => globalThis.__invokeCalls.map(([cmd]) => cmd);

/** Press a control. The handlers are `() => void a.something(id)` — fire and
 *  forget, so there is no promise to await; nothing here does real I/O, so
 *  draining the microtask queue runs the whole chain to its end. */
async function click(btn) {
  btn.props.onClick();
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test("Stop on a running row reaches the backend's cancel_job", async () => {
  const a = realActions();
  const j = job("r", "running", "Reading");
  const stop = rowButtons(j, a).find((b) => labelOf(b).includes("Stop"));
  assert.ok(stop, "a running row must offer a Stop");
  await click(stop);
  assert.deepEqual(commands(), ["cancel_job"]);
  assert.equal(globalThis.__invokeCalls[0][1].id, "r", "and on THIS job");
});

test("Remove on a queued row reaches cancel_job", async () => {
  const a = realActions();
  const q = job("q", "queued", "Waiting");
  const remove = rowButtons(q, a).find((b) => labelOf(b).includes("Remove"));
  assert.ok(remove, "a queued row must offer a Remove");
  await click(remove);
  assert.deepEqual(commands(), ["cancel_job"]);
});

test("Resume on a paused row reaches resume_job, and refreshes the list", async () => {
  const a = realActions();
  const p = job("p", "paused", "Half done");
  const resume = rowButtons(p, a).find((b) => labelOf(b).includes("Resume"));
  assert.ok(resume, "a paused row must offer a Resume");
  await click(resume);
  // list_jobs is `refreshJobs` — without it the card would keep saying Paused
  // after the job restarted.
  assert.deepEqual(commands(), ["resume_job", "list_jobs"]);
  assert.equal(globalThis.__invokeCalls[0][1].id, "p");
});

test("Retry on a failed row reaches resume_job, not a fresh run", async () => {
  const a = realActions();
  const e = job("e", "error", "Broke", { error: "OLLAMA_DOWN" });
  const retry = rowButtons(e, a).find((b) => labelOf(b).includes("Retry"));
  assert.ok(retry, "an errored row must offer a Retry");
  await click(retry);
  assert.deepEqual(commands(), ["resume_job", "list_jobs"]);
});

test("Dismiss on a stopped row reaches delete_job", async () => {
  const a = realActions();
  const p = job("p", "paused", "Half done");
  const dismiss = rowButtons(p, a).find((b) => labelOf(b).includes("Dismiss"));
  assert.ok(dismiss, "a stopped row must offer a Dismiss");
  await click(dismiss);
  assert.deepEqual(commands(), ["delete_job", "list_jobs"]);
  assert.equal(globalThis.__invokeCalls[0][1].id, "p");
});

test("a running row offers no Dismiss — the only way out is Stop first", () => {
  // Dismiss deletes the row; on a running job that would drop the card while
  // the work carried on, which is the same lie as filing it under History.
  const labels = rowButtons(job("r", "running", "Reading"), realActions()).map(labelOf);
  assert.ok(!labels.some((l) => l.includes("Dismiss")), labels.join(" | "));
  assert.ok(labels.some((l) => l.includes("Stop")));
});

test("every live row rendered by the pane carries at least one control", () => {
  // The pane-level version: no live status renders as a dead card.
  for (const status of ["running", "queued", "paused", "error"]) {
    const a = realActions();
    const btns = rowButtons(job("x", status, "Row"), a);
    assert.ok(btns.length > 0, `${status} rendered with no controls`);
    for (const b of btns) {
      assert.equal(typeof b.props.onClick, "function", `${status}: dead control`);
    }
  }
});
