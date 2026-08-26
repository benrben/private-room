/* The visual register's invariants.
 *
 * The palette half of this file is the one that has already gone wrong once,
 * and expensively: a previous solve tuned the marker inks against `--raised`,
 * shipped 4.15:1 values, and stated in a comment that they cleared 4.5. An
 * invariant asserted as verified fact in prose is worth less than nothing —
 * a reader builds on it. So the ratios are computed here, from the values the
 * stylesheet actually holds, against every ground of both themes.
 *
 * --hover is the floor in BOTH themes and that is the whole trap: it is the
 * lightest ground in dark mode and the darkest in light, so a value solved
 * against the page passes on the page and fails on a hovered row — which is
 * most rows, most of the time.
 *
 * The shape half guards the two sweeps the visual pass made, both of which
 * are the kind that rot one call site at a time: a new rule hand-writing a
 * four-corner radius, or a new icon at a size nobody else uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");
const TOKENS = read("src/styles/tokens.css");

/* ---------- contrast ---------- */

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function ratio(a, b) {
  const [x, y] = [lum(hex2rgb(a)), lum(hex2rgb(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The token values of one theme, read out of tokens.css. */
function theme(which) {
  const body =
    which === "dark"
      ? TOKENS.slice(TOKENS.indexOf(":root {"), TOKENS.indexOf(':root[data-theme="light"]'))
      : TOKENS.slice(TOKENS.indexOf(':root[data-theme="light"]'));
  const out = {};
  for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    out[name] = value;
  }
  return out;
}

const THEMES = { dark: theme("dark"), light: theme("light") };
// Light mode declares only what it overrides, so its grounds are complete but
// its marker track is read from its own block — assert that rather than
// silently falling back to dark values and testing the wrong palette.
const GROUNDS = ["--page", "--surface", "--raised", "--hover"];

test("every marker ink clears 4.6:1 on every ground of its own theme", () => {
  const INKS = [
    "--mk-berry-ink",
    "--mk-yellow-ink",
    "--mk-green-ink",
    "--mk-blue-ink",
    "--mk-red-ink",
  ];
  const failures = [];
  for (const [name, t] of Object.entries(THEMES)) {
    for (const ink of INKS) {
      assert.ok(t[ink], `${name} does not define ${ink}`);
      for (const ground of GROUNDS) {
        assert.ok(t[ground], `${name} does not define ${ground}`);
        const r = ratio(t[ink], t[ground]);
        if (r < 4.6) failures.push(`${name} ${ink} on ${ground}: ${r.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(failures, [], "solve against --hover, not --raised");
});

test("the lifted pen clears it too", () => {
  // --accent-2 carries words (hover on an accent-coloured label), so it owes
  // the same floor as the ink track it belongs to.
  for (const [name, t] of Object.entries(THEMES)) {
    for (const ground of GROUNDS) {
      const r = ratio(t["--accent-2"], t[ground]);
      assert.ok(r >= 4.6, `${name} --accent-2 on ${ground}: ${r.toFixed(2)}`);
    }
  }
});

test("the accent is a berry, and it is nowhere near the danger red", () => {
  // Accent and danger used to sit four degrees of hue apart and were told
  // apart by TREATMENT alone. Treatment is still the rule; this is the belt
  // that stops a future palette edit from quietly walking them back together,
  // where a selection reads as an error.
  const hue = (h) => {
    const [r, g, b] = hex2rgb(h);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    const x =
      max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((x * 60) % 360 + 360) % 360;
  };
  for (const [name, t] of Object.entries(THEMES)) {
    const berry = hue(t["--mk-berry-ink"]);
    const red = hue(t["--mk-red-ink"]);
    const apart = Math.min(Math.abs(berry - red), 360 - Math.abs(berry - red));
    assert.ok(
      berry > 270 && berry < 330,
      `${name} --mk-berry-ink is at hue ${berry.toFixed(0)}, which is not a berry`,
    );
    assert.ok(apart > 40, `${name}: accent and danger are ${apart.toFixed(0)}° apart`);
  }
});

test("the two hardcoded copies of the palette still match the tokens", () => {
  /* THE PALETTE IS WRITTEN DOWN THREE TIMES, because two of the consumers
   * cannot read a stylesheet:
   *
   *   tokens.css                       the source
   *   viewers/monacoSetup.ts           a JS object handed to monaco
   *   commands/docs_html.rs            a standalone exported document, which
   *                                    carries no bundle and no CSS of ours
   *
   * Both copies say in their own comments to change them together, and one of
   * them had already drifted before anyone noticed: the export template's ink
   * track had wandered off tokens.css by a few points per channel, and its
   * dark inks had been copied from the FILL values outright. A rename made it
   * worse — the comments said `--mk-berry-ink` over a pink hex — which is the
   * failure this test exists to make loud.
   */
  const monaco = read("src/viewers/monacoSetup.ts");
  const docs = read("electron-migration/electron-app/electron/main/docsHtml.ts");
  const wrong = [];

  // monaco writes hex without the '#', and names the token in a trailing note.
  for (const [, value, token] of monaco.matchAll(/"([0-9a-f]{6})", \/\/ (--[a-z0-9-]+)\./g)) {
    // Whichever theme block it is in, it must equal that theme's token.
    const ok = [THEMES.dark[token], THEMES.light[token]].includes(`#${value}`);
    if (!ok) wrong.push(`monacoSetup.ts: ${token} = #${value}`);
  }

  // The export template declares light first, then dark. Its PRINT override
  // is deliberately darker — a printed sheet is a different target — so the
  // comparison stops there.
  const printBlock = docs.indexOf("/* PRINT.");
  assert.ok(printBlock > 0, "the print block moved; this slice is now wrong");
  const upToContrast = docs.slice(0, printBlock);
  for (const [, token, value] of upToContrast.matchAll(/(--mk-[a-z-]+):(#[0-9a-f]{6})/g)) {
    const ok = [THEMES.dark[token], THEMES.light[token]].includes(value);
    if (!ok) wrong.push(`docsHtml.ts: ${token} = ${value}`);
  }

  assert.deepEqual(wrong, [], "a hardcoded copy has drifted from tokens.css");
});

/* ---------- shape ---------- */

function sheets() {
  const out = [];
  for (const dir of ["src/styles", "src/viewers"]) {
    for (const name of readdirSync(join(root, dir))) {
      if (name.endsWith(".css")) out.push([`${dir}/${name}`, read(`${dir}/${name}`)]);
    }
  }
  return out;
}

test("box corners are symmetric; only the frames are drawn", () => {
  // A four-corner radius on a box is what the visual pass took out of 90
  // rules. Marks keep theirs — a strip of tape, an underline, a bar — and so
  // do paper.css's four frame signatures, which are now the entire drawn
  // identity rather than one wobble among many.
  const stray = [];
  for (const [path, css] of sheets()) {
    if (path === "src/styles/paper.css") continue;
    for (const [, value] of css.matchAll(/border-radius:\s*([^;]+);/g)) {
      if (/var\(|%|999px/.test(value)) continue;
      const nums = [...value.matchAll(/([\d.]+)px/g)].map((m) => Number(m[1]));
      if (nums.length < 2) continue;
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      if (mean >= 5.2) stray.push(`${path}: ${value.trim()}`);
    }
  }
  assert.deepEqual(stray, [], "use a --radius-* token; the frames are paper.css's job");
});

test("the frame signatures stay within 1px of --radius", () => {
  // They are literals rather than calc() off the token — eight nested calc()s
  // per rule costs every future reader more than the tie is worth — so this
  // is where the tie actually lives.
  const paper = read("src/styles/paper.css");
  const within = (label, selector, tokenName) => {
    const base = Number(new RegExp(`${tokenName}:\\s*(\\d+)px`).exec(TOKENS)[1]);
    const rules = [
      ...paper.matchAll(new RegExp(`${selector}[^{]*\\{[^}]*?border-radius:\\s*([^;]+);`, "g")),
    ];
    assert.ok(rules.length >= 1, `${label}: no rules matched`);
    for (const [, value] of rules) {
      for (const [, n] of value.matchAll(/([\d.]+)px/g)) {
        assert.ok(
          Math.abs(Number(n) - base) <= 1,
          `${label}: ${value.trim()} strays more than 1px from ${tokenName} (${base}px)`,
        );
      }
    }
    return rules.length;
  };
  // The pen frame and its three sibling signatures, plus the three the
  // container rotates by position: seven rules, one radius.
  const drawn =
    within("frame", "\\.nb-frame(?:--[bcd])?(?=\\s*\\{)", "--radius") +
    within("frame-set", "\\.nb-frame-set", "--radius");
  assert.equal(drawn, 7, `expected 7 frame signatures, found ${drawn}`);
  // The pencil-weight frame is a tier down and tracks the smaller rung.
  within("frame-soft", "\\.nb-frame-soft", "--radius-sm");
});

test("the stroke is one device pixel", () => {
  // 1.5px lands on a half pixel at 2x and WebKit smears it across two, so 58
  // frames read as slightly out of focus rather than as drawn.
  assert.match(TOKENS, /--stroke-w: 1px;/);
});

test("icons come from the scale", () => {
  const off = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = `${dir}/${name.name}`;
      if (name.isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) {
        for (const [, n] of read(p).matchAll(/size=\{(\d+)\}/g)) {
          const v = Number(n);
          // 12 / 14 / 16 is chrome; 20 and up is art, drawn for its size.
          if (v < 20 && ![12, 14, 16].includes(v)) off.push(`${p}: ${v}`);
        }
      }
    }
  };
  walk("src");
  assert.deepEqual(off, [], "see the size scale in src/icons/base.tsx");
});
