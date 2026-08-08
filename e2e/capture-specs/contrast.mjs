/* The rendered contrast audit (§30).
 *
 * Token maths cannot answer this question. A token pair can measure 5:1 on
 * paper and still fail on the page, because what a run of text is actually
 * drawn ON is whatever ancestor last painted a background — a hovered row, a
 * raised card, a marker wash — and that is only knowable once it is rendered.
 * So this walks every text node the app has actually drawn, resolves the real
 * backdrop by climbing until something is opaque, and measures.
 *
 * Reports rather than asserts on the app's own text, because the QA mock puts
 * its own banner on the page and a harness fixture must not be able to fail a
 * product gate. Read the summary: `app failures` is the number that matters.
 *
 *   SKIP_BUILD=1 npx wdio run e2e/wdio.capture.conf.mjs --spec e2e/capture-specs/contrast.mjs
 */

const AREAS = [
  "home",
  "map",
  "recordings",
  "workflows",
  "scripts",
  "skills",
  "memory",
  "connectors",
  "create",
  "browser",
];

const FILES = [
  "Arcelle UX direction.md",
  "review-sample.docx",
  "prepare_release.py",
  "Apollo missions.csv",
  "Product review.m4a",
];

/** Anything the harness itself draws. Not the app, so not the app's failure. */
const HARNESS = [".qa-banner", "[data-qa-mock]"];

const AUDIT = String.raw`
const HARNESS = __HARNESS__;
const px = (v) => parseFloat(v) || 0;

function parse(c) {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
const lin = (c) => {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});
const ratio = (a, b) => {
  const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return (hi + 0.05) / (lo + 0.05);
};

/** The colour actually painted behind an element: climb until opaque, mixing
 *  every translucent layer on the way, and fall back to the page. */
function backdrop(el) {
  const stack = [];
  let n = el;
  while (n && n !== document.documentElement) {
    const c = parse(getComputedStyle(n).backgroundColor);
    if (c && c.a > 0) {
      stack.push(c);
      if (c.a >= 0.999) break;
    }
    n = n.parentElement;
  }
  let base = parse(getComputedStyle(document.documentElement).backgroundColor) ||
    { r: 255, g: 255, b: 255, a: 1 };
  if (base.a < 1) base = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
  return base;
}

const out = [];
const seen = new Set();
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
let node;
while ((node = walker.nextNode())) {
  const text = node.nodeValue.trim();
  if (!text) continue;
  const el = node.parentElement;
  if (!el || seen.has(el)) continue;
  seen.add(el);
  if (HARNESS.some((sel) => el.closest(sel))) continue;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) continue;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none") continue;
  if (px(cs.opacity) < 0.15) continue;
  const fg = parse(cs.color);
  if (!fg || fg.a < 0.15) continue;
  const bg = backdrop(el);
  const solid = fg.a < 1 ? over(fg, bg) : fg;
  const size = px(cs.fontSize);
  const weight = parseInt(cs.fontWeight, 10) || 400;
  // WCAG 1.4.3: 3:1 for large text (>=24px, or >=18.66px bold), else 4.5:1.
  const large = size >= 24 || (size >= 18.66 && weight >= 700);
  const need = large ? 3 : 4.5;
  const got = ratio(solid, bg);
  if (got + 0.005 < need) {
    out.push({
      text: text.slice(0, 60),
      cls: String(el.className).slice(0, 50),
      size: Math.round(size),
      got: Math.round(got * 100) / 100,
      need,
    });
  }
}
return out;
`;

async function audit() {
  return browser.execute(
    new Function(AUDIT.replace("__HARNESS__", JSON.stringify(HARNESS))),
  );
}

async function open(theme) {
  const url = browser.options.baseUrl;
  await browser.url(url);
  await browser.execute((t) => localStorage.setItem("prTheme", t), theme);
  await browser.url(url);
  await $(".activity-rail").waitForExist({ timeout: 20_000 });
  await browser.pause(500);
}

describe("rendered contrast, both themes", () => {
  for (const theme of ["dark", "light"]) {
    it(`walks every drawn surface — ${theme}`, async () => {
      const failures = [];
      const note = (where, rows) =>
        rows.forEach((r) => failures.push({ where, ...r }));

      await open(theme);
      note("start", await audit());

      for (const area of AREAS) {
        const btn = await $(`.rail-button[data-area="${area}"]`);
        if (!(await btn.isExisting())) continue;
        await btn.click();
        await browser.pause(400);
        note(`area:${area}`, await audit());
      }

      await open(theme);
      for (const file of FILES) {
        const row = await $(`.file-name[title="${file}"]`);
        if (!(await row.isExisting())) continue;
        await row.click();
        await browser.pause(1400);
        note(`file:${file}`, await audit());
      }

      // Settings is a modal, so it is only reachable from its own control.
      await open(theme);
      const settings = await $('button[aria-label="Settings"], .rail-settings');
      if (await settings.isExisting()) {
        await settings.click();
        await browser.pause(700);
        note("settings", await audit());
      }

      const uniq = new Map();
      for (const f of failures) uniq.set(`${f.cls}|${f.text}|${f.got}`, f);
      const rows = [...uniq.values()];
      console.log(
        `\n=== ${theme}: ${rows.length} under-contrast text node(s) ===`,
      );
      for (const r of rows) {
        console.log(
          `  ${r.got}:1 (needs ${r.need}) ${r.size}px  [${r.where}] .${r.cls}  “${r.text}”`,
        );
      }
      if (!rows.length) console.log("  none");
    });
  }
});
