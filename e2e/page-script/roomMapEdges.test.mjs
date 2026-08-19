/* Room Map — typed links and the density control.
 *
 * The map used to draw one violet hairline for every relationship, so "this
 * file was made from that one" and "these two share some words" were the same
 * picture, and a 19-file room drew 163 of its 171 possible lines. The backend
 * now types and sparsifies; this covers the frontend half — that the type
 * filter is honest (what it hides is not counted as shown), that the render cap
 * never eats a fact to make room for a guess, and that an unknown kind from a
 * newer backend degrades to the weakest thing it could be rather than being
 * presented as a fact.
 *
 * Runs against the REAL TypeScript source, type-stripped in memory — the same
 * trick viewerparse.test.mjs uses, so there is no compiled copy to drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

async function load(relPath) {
  const source = readFileSync(join(root, relPath), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

// edges.ts imports MAX_EDGES from constants.ts; the data URL import resolves it
// through the same in-memory transpile, so inline the constants module first.
const constants = await load("src/viewers/roomMap/constants.ts");
const edgesSource = readFileSync(join(root, "src/viewers/roomMap/edges.ts"), "utf8").replace(
  /import \{ MAX_EDGES \} from "\.\/constants";/,
  `const MAX_EDGES = ${constants.MAX_EDGES};`,
);
const { filterEdges, rankEdges, countByKind, edgeRank, styleFor, edgeLines, EDGE_KINDS } =
  await import(
    `data:text/javascript,${encodeURIComponent(
      ts.transpileModule(edgesSource, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    )}`
  );

const edge = (a, b, kind, weight = 0.5) => ({
  a,
  b,
  kind,
  weight,
  directed: false,
  shared: [],
});

const ids = (...names) => new Set(names);

test("the trust order puts facts ahead of the one inferred kind", () => {
  assert.equal(EDGE_KINDS[0], "derived");
  assert.equal(EDGE_KINDS[EDGE_KINDS.length - 1], "similar");
  assert.ok(edgeRank("derived") < edgeRank("similar"));
  assert.equal(styleFor("similar").fact, false);
  assert.equal(styleFor("derived").fact, true);
});

test("switching a kind off removes exactly that kind and nothing else", () => {
  const all = [
    edge("a", "b", "derived", 1),
    edge("b", "c", "similar", 0.6),
    edge("c", "d", "similar", 0.4),
    edge("a", "d", "cited", 0.7),
  ];
  const shown = filterEdges(all, { hidden: ["similar"], minWeight: 0 });
  assert.deepEqual(
    shown.map((e) => e.kind),
    ["derived", "cited"],
  );
  // …and switching it back on restores exactly the same list.
  assert.equal(filterEdges(all, { hidden: [], minWeight: 0 }).length, 4);
});

test("the strength bar hides the weakest links and keeps the rest", () => {
  const all = [
    edge("a", "b", "similar", 0.9),
    edge("b", "c", "similar", 0.5),
    edge("c", "d", "similar", 0.31),
  ];
  assert.equal(filterEdges(all, { hidden: [], minWeight: 0 }).length, 3);
  assert.equal(filterEdges(all, { hidden: [], minWeight: 0.5 }).length, 2);
  assert.equal(filterEdges(all, { hidden: [], minWeight: 0.9 }).length, 1);
  // The bar is inclusive: a link exactly AT the bar is still shown, so dragging
  // to a value a link displays as does not make that link vanish.
  assert.equal(filterEdges(all, { hidden: [], minWeight: 0.9 })[0].weight, 0.9);
});

test("the strength bar never takes a proven relation off the map", () => {
  // The backend gives each recorded kind a CONSTANT weight — same_site 0.45, a
  // memory's match 0.6 — while an inferred link is scored against the room's
  // own range and can sit near 1. One comparison across every kind therefore
  // hid the facts first and kept the guesses drawn.
  const all = [
    edge("a", "b", "same_site", 0.45),
    edge("mem:1", "c", "mentions", 0.6),
    edge("c", "d", "similar", 0.95),
    edge("d", "e", "similar", 0.2),
  ];
  const shown = filterEdges(all, { hidden: [], minWeight: 0.9 });
  assert.deepEqual(
    shown.map((e) => e.kind),
    ["same_site", "mentions", "similar"],
    "the facts stayed and only the weak guess went",
  );
  // Switching a kind off still removes it, strength bar or not.
  assert.equal(filterEdges(all, { hidden: ["same_site"], minWeight: 0.9 }).length, 2);
});

test("a memory's link does not claim the memory named the file", () => {
  // graph.rs matches a memory's two RAREST WORDS against a file's text and
  // files the edge under `mentions`, the kind whose lead describes a
  // file-to-file match on the file's own NAME. Borrowing that sentence told
  // the reader the memory names the file, with "zermatt" offered as proof.
  const memory = edgeLines({
    ...edge("mem:7", "trip.md", "mentions", 0.6),
    shared: ["zermatt", "february"],
  });
  assert.ok(!/names the other/.test(memory[0]), memory[0]);
  assert.equal(memory[0], "This memory's distinctive words appear in this file");
  assert.deepEqual(memory.slice(1), ["zermatt", "february"]);
  // A file naming a file really is a name match, and keeps saying so.
  assert.equal(
    edgeLines(edge("notes.md", "lease.pdf", "mentions", 0.8))[0],
    "This one names the other by name",
  );
});

test("the legend counts what EXISTS, not what is currently shown", () => {
  // A toggle whose count moved to 0 the moment you switched it off would give
  // the reader no way back that reads as sensible.
  const all = [edge("a", "b", "derived"), edge("b", "c", "similar"), edge("c", "d", "similar")];
  const counts = countByKind(all);
  assert.deepEqual(counts, { derived: 1, similar: 2 });
  assert.equal(counts.same_page, undefined, "a kind this room has none of is absent, not 0-faked");
});

test("the render cap drops guesses, never facts", () => {
  // A plain weight sort dropped a modest-weight "made from" before a noisy
  // "reads alike" — exactly backwards.
  const many = [];
  for (let i = 0; i < constants.MAX_EDGES + 50; i++) {
    many.push(edge(`n${i}`, `n${i + 1}`, "similar", 0.99));
  }
  many.push(edge("src", "out", "derived", 0.1));
  const nodes = ids("src", "out", ...many.flatMap((e) => [e.a, e.b]));
  const ranked = rankEdges(many, nodes);
  assert.ok(
    ranked.some((e) => e.kind === "derived"),
    "the fact survived a cap full of stronger-looking guesses",
  );
  assert.equal(ranked[0].kind, "derived", "and it is drawn first");
  assert.ok(ranked.length <= constants.MAX_EDGES);
});

test("an edge to a node that is not on the map is dropped", () => {
  const all = [edge("a", "b", "derived"), edge("a", "ghost", "derived"), edge("a", "a", "similar")];
  const ranked = rankEdges(all, ids("a", "b"));
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].b, "b");
});

test("a kind this build does not know is drawn as a guess, not as a fact", () => {
  // Forward compatibility that cannot lie: a newer backend inventing
  // "same_author" must not render with the authority of a recorded fact.
  const unknown = styleFor("same_author");
  assert.equal(unknown.fact, false);
  assert.equal(unknown, styleFor("similar"));
  const ranked = rankEdges([edge("a", "b", "same_author", 1)], ids("a", "b"));
  assert.equal(ranked.length, 1, "it is still drawn — it just claims less");
});

test("a link's tooltip says what it claims before it says its evidence", () => {
  const lines = edgeLines({
    ...edge("a", "b", "derived", 1),
    shared: ["lease.pdf", "x", "y", "dropped"],
  });
  assert.equal(lines[0], "Made from this file");
  assert.equal(lines.length, 4, "the lead line plus at most 3 pieces of evidence");
  // No bare "N% similar": after sparsification the weight is a position in this
  // room's own range, not a percentage of anything a reader could check.
  assert.ok(!lines.some((l) => /%/.test(l)));
});
