/* The type system's invariants — the ones that fail silently.
 *
 * Four things can go wrong here and none of them raises an error anywhere:
 *
 *   • A @font-face pointing at a file that is not bundled. CSP is
 *     `font-src 'self' data:`, so the request cannot even reach a CDN — the
 *     face just never loads and the whole app renders in the fallback tail.
 *   • A fallback tail collapsed to one family. Only latin + latin-ext are
 *     bundled; Hebrew and CJK resolve per-glyph through the system faces
 *     behind ours, and this app has shipped Hebrew PDF and Hebrew STT work.
 *     Delete the tails and Hebrew renders as tofu.
 *   • A display rung set without the display face, so a page title is merely
 *     bigger than its metadata rather than different from it.
 *   • A sans rule borrowing --fs-hand. That token is 15px because KALAM runs
 *     small for its nominal size; the same number in Figtree reads a tier
 *     larger, so the borrowed rung silently oversizes whatever took it.
 *
 * Read from source: these are facts about the stylesheets, and there is no
 * DOM in this suite to measure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const FONTS = read("src/styles/fonts.css");
const TOKENS = read("src/styles/tokens.css");
const FONT_DIR = "src/assets/fonts";

/** Every stylesheet the app ships, as [path, text]. */
function sheets() {
  const out = [];
  for (const dir of ["src/styles", "src/viewers"]) {
    for (const name of readdirSync(join(root, dir))) {
      if (name.endsWith(".css")) out.push([`${dir}/${name}`, read(`${dir}/${name}`)]);
    }
  }
  return out;
}

/** Split a stylesheet into its rule blocks: [selector, body]. Good enough for
 *  this codebase, which has no nested or @-scoped rules. */
function blocks(css) {
  return [...css.matchAll(/(^|\n)([^{}\n][^{}]*?)\{([^{}]*)\}/g)].map((m) => [
    m[2].trim(),
    m[3],
  ]);
}

test("every bundled face is declared, and every declared face is bundled", () => {
  const declared = [...FONTS.matchAll(/url\("\.\.\/assets\/fonts\/([^"]+)"\)/g)].map(
    (m) => m[1],
  );
  const onDisk = readdirSync(join(root, FONT_DIR)).filter((f) => f.endsWith(".woff2"));
  assert.deepEqual(
    [...new Set(declared)].sort(),
    onDisk.sort(),
    "fonts.css and src/assets/fonts disagree — a face named but not bundled " +
      "never loads (CSP blocks every remote font), and a file nobody declares " +
      "is dead weight in the app",
  );
});

test("faces.json describes what is actually bundled", () => {
  const faces = JSON.parse(read(`${FONT_DIR}/faces.json`));
  const onDisk = readdirSync(join(root, FONT_DIR)).filter((f) => f.endsWith(".woff2"));
  assert.deepEqual(faces.map((f) => f.file).sort(), onDisk.sort());
  for (const f of faces) {
    assert.match(f.range, /^U\+/, `${f.file} has no unicode-range`);
    assert.ok(f.bytes > 0, `${f.file} is empty`);
  }
});

test("the non-latin fallback tails survive", () => {
  // Each of these must keep at least one family BEHIND the bundled one, or
  // every glyph outside latin + latin-ext renders as a box.
  for (const [token, tail] of [
    ["--sans", /-apple-system/],
    ["--hand", /"Bradley Hand"/],
    ["--mono", /ui-monospace/],
  ]) {
    const value = new RegExp(`\\${token}:([^;]+);`).exec(TOKENS)?.[1];
    assert.ok(value, `${token} not found`);
    assert.match(
      value,
      tail,
      `${token} lost its system tail — Hebrew and CJK resolve through it`,
    );
  }
  // --display falls back to --sans rather than to a bare family, so a display
  // title in a script Space Grotesk does not bundle lands in the interface
  // face and then in ITS tail, instead of dropping straight to the browser
  // default.
  assert.match(/--display:([^;]+);/.exec(TOKENS)[1], /var\(--sans\)/);
});

test("nothing asks for Manrope any more", () => {
  // DECLARATIONS only, not prose. Two comments still name the face on purpose
  // — fonts.css explains what the swap replaced, and roomMap/constants.ts
  // records that Figtree measured to the same advance the label-collision
  // constant was tuned against — and erasing that history would cost a future
  // reader the reason those numbers are what they are.
  const asked = [];
  for (const [path, css] of [...sheets(), ["index.html", read("index.html")]]) {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const line of code.split("\n")) {
      if (/Manrope/.test(line)) asked.push(`${path}  ${line.trim()}`);
    }
  }
  assert.deepEqual(asked, [], "Manrope is not bundled any more — it would 404");
});

test("every display rung carries the display face", () => {
  // The one exception, by name and with its reason: this rule only overrides
  // the SIZE of `.gate-card h1`, which is already in the display face.
  const EXEMPT = new Set([".gate-card:has(> .gate-assurances) h1"]);
  const missing = [];
  for (const [path, css] of sheets()) {
    for (const [sel, body] of blocks(css)) {
      if (!/var\(--fs-(page|section)\)/.test(body)) continue;
      if (EXEMPT.has(sel)) continue;
      if (!/font-family: var\(--display\)/.test(body)) missing.push(`${path}  ${sel}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "a page or section title set at a display rung but left in the interface " +
      "face is only bigger than its metadata, not different from it",
  );
});

test("the hand's rungs are used only by the hand", () => {
  const borrowed = [];
  for (const [path, css] of sheets()) {
    if (path.endsWith("tokens.css")) continue; // where they are defined
    for (const [sel, body] of blocks(css)) {
      if (!/var\(--(fs-hand|fs-hand-lg|lh-hand)\)/.test(body)) continue;
      if (!/var\(--hand\)/.test(body)) borrowed.push(`${path}  ${sel}`);
    }
  }
  assert.deepEqual(
    borrowed,
    [],
    "--fs-hand is 15px because KALAM runs small for its nominal size. A rule " +
      "in the sans that borrows it is a tier too large and nothing says so",
  );
});

test("the hand is spent on words a person wrote, not on computed facts", () => {
  // Not a count for its own sake — the number is here so that adding the 28th
  // hand site is a deliberate act with a reason, which is exactly what stopped
  // happening on the way to 71. The rule it enforces is in paper.css §3.
  let uses = 0;
  for (const [, css] of sheets()) uses += (css.match(/var\(--hand\)/g) || []).length;
  uses += (read("src/icons/nav.tsx").match(/var\(--hand\)/g) || []).length;
  assert.equal(
    uses,
    27,
    "the hand's reserve changed. If that is deliberate, say why in paper.css §3 " +
      "and move this number; if it is not, a computed fact has just claimed a " +
      "face that says a person wrote it",
  );
});

test("…and the same census over the classes, not just the token", () => {
  /* THE HALF THE FIRST AUDIT MISSED. Sweeping `var(--hand)` finds every
   * STYLESHEET that reaches for the face and none of the components that wear
   * `.nb-hand` to get it — so a date on the Recordings page stayed handwritten
   * through a pass that was supposed to have moved every date, and only a
   * screenshot caught it. Both halves are counted now.
   *
   * The primitives are still the vocabulary, and they still mean what they
   * say; what this pins is how many places SPEAK it. */
  // `nb-hand` and `nb-hand-lg` are deliberately absent: the generic primitives
  // now have no wearers at all. Everything that kept the hand did so through a
  // named component class whose stylesheet says WHY, which is the shape the
  // reserve wants — "this label is in the hand because a person wrote it"
  // rather than "this label is in the hand".
  const WEARERS = { "nb-note": 3, "nb-annot": 1, "nb-subtitle": 10 };
  const found = {};
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) {
        for (const cls of Object.keys(WEARERS)) {
          // Word boundary on both sides: `nb-hand` must not also match
          // `nb-hand-lg`, and `nb-annot` must not match `nb-annot-l`.
          const hits = read(p).match(new RegExp(`\\b${cls}\\b(?!-)`, "g")) || [];
          if (hits.length) found[cls] = (found[cls] || 0) + hits.length;
        }
      }
    }
  };
  walk("src");
  assert.deepEqual(
    found,
    WEARERS,
    "a component started or stopped wearing the hand. If a computed fact just " +
      "put `.nb-hand` on, the rule it is breaking is in paper.css §3",
  );
});
