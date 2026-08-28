/* The composer's "*" specialist tag (owner feature, 2026-08-03).
 *
 * Typing "*" opens a menu of the agents THIS ROOM can dispatch to, and picking
 * one tags the message so that specialist runs. The rules worth pinning are the
 * pure ones, and they live in `src/workspace/composer.ts` beside the "#", "/"
 * and "@" parsers this reuses wholesale — same trigger shape, same item shape,
 * same first-token discipline.
 *
 * Two of them exist because of the anti-fabrication doctrine rather than for
 * convenience: an empty menu must never stand in for "we haven't looked yet"
 * (`specialistNote`), and a tag typed after a file reference must be HOISTED to
 * the front (`hoistTag`) or the backend, which reads it from the first token
 * only, silently runs an ordinary turn instead of the one that was asked for.
 *
 * Runs against the REAL TypeScript source, type-stripped in memory — the same
 * trick filelabel.test.mjs uses, so there is no compiled copy to drift.
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

const {
  tokenAtCaret,
  specialistItems,
  specialistNote,
  specialistErrorMessage,
  parseComposer,
  hoistTag,
} = await load("apps/desktop/src/renderer/workspace/composer.ts");

/** The roster the sidecar returns for a local-engine room with the web on. */
const ROSTER = [
  {
    key: "file",
    tool: "ask_file_agent",
    label: "File agent",
    area: "this room's own content",
    description: "Ask the File agent to work with this room's content.",
  },
  {
    key: "web",
    tool: "ask_web_agent",
    label: "Web agent",
    area: "the internet and browsing sites",
    description: "Ask the Web agent about anything on the internet.",
  },
];

const NO_COMMANDS = [];
const NO_SKILLS = [];
const NO_FILES = [];
const NO_FOLDERS = [];

// ---- the trigger -------------------------------------------------------

test("typing * opens the specialist menu", () => {
  assert.deepEqual(tokenAtCaret("*", 1), { kind: "agent", start: 0, query: "" });
});

test("what follows the * is the filter query", () => {
  assert.deepEqual(tokenAtCaret("*we", 3), {
    kind: "agent",
    start: 0,
    query: "we",
  });
});

test("a * anywhere but the first token is left alone", () => {
  // Multiplication, a footnote marker and a markdown bullet all live here.
  assert.equal(tokenAtCaret("2 * ", 4), null);
  assert.equal(tokenAtCaret("cost * 3", 8), null);
  assert.equal(tokenAtCaret("*web then *fi", 13), null);
});

test("the menu closes once the tag is complete and a space is typed", () => {
  assert.equal(tokenAtCaret("*web ", 5), null);
});

// ---- filtering ---------------------------------------------------------

test("an empty query lists every specialist the room has", () => {
  const items = specialistItems(ROSTER, "");
  assert.deepEqual(
    items.map((i) => i.label),
    ["*file", "*web"],
  );
});

test("the query filters by key", () => {
  const items = specialistItems(ROSTER, "we");
  assert.deepEqual(
    items.map((i) => i.label),
    ["*web"],
  );
});

test("the query also matches the label and the area", () => {
  // Someone hunting for the browser types what they want, not the domain key.
  assert.equal(specialistItems(ROSTER, "browsing")[0].key, "ag-web");
  assert.equal(specialistItems(ROSTER, "file agent")[0].key, "ag-file");
});

test("each row carries what the popover draws", () => {
  const [row] = specialistItems(ROSTER, "web");
  assert.equal(row.label, "*web");
  assert.equal(row.usage, "Web agent");
  assert.equal(row.hint, "the internet and browsing sites");
  assert.equal(row.insert, "*web ");
});

test("Cloud Privacy labels inspect-only specialists and disables unavailable ones", () => {
  const reason = "Cloud Privacy blocks this action. Switch to On this Mac to use it.";
  const items = specialistItems([
    { ...ROSTER[0], capability: "unavailable", capabilityReason: reason, localHandoff: true },
    { ...ROSTER[1], capability: "inspect-only", capabilityReason: reason, localHandoff: true },
  ], "");
  assert.equal(items[0].disabled, true);
  assert.match(items[0].usage, /On this Mac/);
  assert.equal(items[0].hint, reason);
  assert.equal(items[1].disabled, false);
  assert.match(items[1].usage, /Inspect only/);
});

test("prerequisite-disabled specialists do not falsely tell users to switch models", () => {
  const reason = "Turn on room internet";
  const [item] = specialistItems([
    { ...ROSTER[1], capability: "unavailable", capabilityReason: reason, localHandoff: false },
  ], "");
  assert.equal(item.disabled, true);
  assert.equal(item.usage, "Web agent · Unavailable");
  assert.equal(item.hint, reason);
  assert.doesNotMatch(item.usage, /On this Mac/);
});

// ---- the honest empty state -------------------------------------------

test("a roster that has not been read yet says so, not 'none'", () => {
  assert.match(specialistNote(null, "", ""), /Looking up/);
});

test("a roster that could not be read names the reason", () => {
  assert.match(
    specialistNote(null, "the AI sidecar is not running", ""),
    /couldn't be loaded: the AI sidecar is not running/,
  );
});

test("a room with genuinely no specialists says THAT", () => {
  assert.match(specialistNote([], "", ""), /no specialists/);
});

test("a query matching nothing is a third, different sentence", () => {
  assert.match(specialistNote(ROSTER, "", "banana"), /matches "banana"/);
});

test("there is no note at all while there are rows to show", () => {
  assert.equal(specialistNote(ROSTER, "", "we"), "");
});

// ---- selecting one tags the message ------------------------------------

test("a tagged message parses to that specialist plus the request", () => {
  const parsed = parseComposer(
    "*web what is the weather",
    NO_COMMANDS,
    NO_SKILLS,
    NO_FILES,
    NO_FOLDERS,
    ROSTER,
  );
  assert.equal(parsed.specialist, "web");
  assert.equal(parsed.args, "what is the weather");
  assert.equal(parsed.specialistError, undefined);
});

test("an untagged message names no specialist", () => {
  const parsed = parseComposer(
    "what is the weather",
    NO_COMMANDS,
    NO_SKILLS,
    NO_FILES,
    NO_FOLDERS,
    ROSTER,
  );
  assert.equal(parsed.specialist, undefined);
});

/* A '*' only opens a tag when a NAME and then whitespace-or-end follow it —
 * exactly the sidecar's `agents._TAG_RE` lookahead. Markdown emphasis is the
 * common case and it used to be refused outright: "*important* note" ended the
 * token on the closing star, which a plain `\b` accepts, so the composer
 * answered an ordinary sentence with "*important isn't a specialist this room
 * has" and would not send it — while the sidecar, asked the same question,
 * would have found no tag at all. Two parsers, one string, opposite answers. */
for (const emphasised of [
  "*important* note about the lease",
  "*emphasis*",
  "*web*side by side",
]) {
  test(`markdown emphasis is text, not a tag: ${emphasised}`, () => {
    const parsed = parseComposer(
      emphasised,
      NO_COMMANDS,
      NO_SKILLS,
      NO_FILES,
      NO_FOLDERS,
      ROSTER,
    );
    assert.equal(parsed.specialist, undefined);
    assert.equal(parsed.specialistError, undefined);
    assert.equal(parsed.args, emphasised);
  });
}

/* ONE policy on a tag that names no specialist this room has, on both sides of
 * the wire — the packet the sidecar's `test_specialist_tag.py` was rewritten
 * for on the same day. It is refused BY NAME, exactly as a "#cmd" or "/skill"
 * typo is, and never treated as ordinary prose: the sidecar used to do the
 * latter (`agents.tagged_specialist` returned "no tag" for a name it did not
 * know), so the same message was refused here and quietly run as an untagged
 * turn there.
 *
 * The three cases below are one case to the person typing — the app cannot
 * serve what they named — and they get one sentence. */
for (const [text, name, why] of [
  ["*jobs schedule it", "jobs", "a real specialist this room cannot serve"],
  ["*banana do the thing", "banana", "a name no specialist answers to"],
  ["*webbing is a thing", "webbing", "a word that merely starts like one"],
]) {
  test(`a tag this room has no specialist for is refused, not run anyway: ${why}`, () => {
    const parsed = parseComposer(
      text,
      NO_COMMANDS,
      NO_SKILLS,
      NO_FILES,
      NO_FOLDERS,
      ROSTER,
    );
    assert.equal(parsed.specialist, undefined, text);
    assert.equal(parsed.specialistError, name, text);
  });
}

test("the refusal names the tags that would have worked", () => {
  // Mirrors `prompts.TAG_UNAVAILABLE_NOTE`, which tells the model the same
  // thing when a tag reaches the sidecar anyway.
  const msg = specialistErrorMessage("banana", ROSTER);
  assert.match(msg, /\*banana isn't a specialist this room has/);
  assert.match(msg, /\*file/);
  assert.match(msg, /\*web/);
});

test("a room with no specialists says THAT rather than 'Try: '", () => {
  assert.match(specialistErrorMessage("web", []), /no specialists right now/);
  assert.doesNotMatch(specialistErrorMessage("web", []), /Try:/);
});

test("an unavailable specialist is refused before dispatch with its local handoff", () => {
  const reason = "Cloud Privacy blocks *file actions. Switch to On this Mac to use this specialist.";
  const roster = [{ ...ROSTER[0], capability: "unavailable", capabilityReason: reason }];
  const parsed = parseComposer("*file organize this", NO_COMMANDS, NO_SKILLS, NO_FILES, NO_FOLDERS, roster);
  assert.equal(parsed.specialist, undefined);
  assert.equal(parsed.specialistError, "file");
  assert.equal(specialistErrorMessage("file", roster), reason);
});

/* The sidecar's `agents._TAG_RE` once also matched "_" and "." so a MODEL's
 * spellings of a domain resolved as tags. This parser cannot lex those, so it
 * sent them as prose — and the sidecar dispatched the Web agent for a turn the
 * composer had shown as untagged. Same grammar on both sides now; pinned here
 * and in `test_the_tag_vocabulary_is_the_MENUS_and_only_the_menus`. */
for (const modelSpelling of ["*ask_web_agent find X", "*chat.browse open it"]) {
  test(`a model's spelling of a domain is not a tag: ${modelSpelling}`, () => {
    const parsed = parseComposer(
      modelSpelling,
      NO_COMMANDS,
      NO_SKILLS,
      NO_FILES,
      NO_FOLDERS,
      ROSTER,
    );
    assert.equal(parsed.specialist, undefined);
    assert.equal(parsed.specialistError, undefined);
    assert.equal(parsed.args, modelSpelling);
  });
}

test("with the roster unknown the tag still travels — the sidecar re-checks it", () => {
  const parsed = parseComposer(
    "*jobs schedule it",
    NO_COMMANDS,
    NO_SKILLS,
    NO_FILES,
    NO_FOLDERS,
    null,
  );
  assert.equal(parsed.specialist, "jobs");
  assert.equal(parsed.specialistError, undefined);
});

test("a tag plus a skill or an action is refused rather than half-honoured", () => {
  // All three are read from the first token, so one of them would be dropped
  // with nothing on screen saying which.
  for (const text of ["*web /lease-review go", "*web #summary go"]) {
    const parsed = parseComposer(
      text,
      NO_COMMANDS,
      NO_SKILLS,
      NO_FILES,
      NO_FOLDERS,
      ROSTER,
    );
    assert.equal(parsed.tagConflict, true, text);
    assert.equal(parsed.specialist, undefined, text);
  }
});

test("a tag after an @reference is read, because refs are lifted out first", () => {
  const files = [
    { id: "f1", name: "lease.pdf", folderId: null, mimeType: "application/pdf" },
  ];
  const parsed = parseComposer(
    "@lease.pdf *file summarize it",
    NO_COMMANDS,
    NO_SKILLS,
    files,
    NO_FOLDERS,
    ROSTER,
  );
  assert.equal(parsed.specialist, "file");
  assert.deepEqual(parsed.refIds, ["f1"]);
});

test("a nested file reference consumes its full folder/file spelling", () => {
  const commands = [{ name: "extract" }];
  const folders = [{ id: "research", name: "Research" }];
  const files = [
    { id: "notes", name: "notes.md", folderId: null, mimeType: "text/markdown" },
    { id: "findings", name: "findings.md", folderId: "research", mimeType: "text/markdown" },
    { id: "other", name: "other.md", folderId: "research", mimeType: "text/markdown" },
  ];
  const parsed = parseComposer(
    "#extract Project codename, expected quantity total from @notes.md @Research/findings.md",
    commands,
    NO_SKILLS,
    files,
    folders,
  );
  assert.equal(parsed.command, "extract");
  assert.equal(parsed.args, "Project codename, expected quantity total from");
  assert.deepEqual(parsed.refIds, ["notes", "findings"]);
});

test("a folder reference ending at the slash still attaches the whole folder", () => {
  const folders = [{ id: "research", name: "Research" }];
  const files = [
    { id: "one", name: "one.md", folderId: "research", mimeType: "text/markdown" },
    { id: "two", name: "two.md", folderId: "research", mimeType: "text/markdown" },
  ];
  const parsed = parseComposer(
    "summarize @Research/",
    NO_COMMANDS,
    NO_SKILLS,
    files,
    folders,
  );
  assert.equal(parsed.args, "summarize");
  assert.deepEqual(parsed.refIds, ["one", "two"]);
});

// ---- and it reaches the backend where the backend looks ----------------

test("a buried tag is hoisted to the first token before sending", () => {
  // `agents.tagged_specialist` reads the FIRST token only; unhoisted, this
  // message would run as an ordinary turn and nothing would say so.
  assert.equal(
    hoistTag("@lease.pdf *file summarize it", "file"),
    "*file @lease.pdf summarize it",
  );
});

test("a tag already at the front is left exactly where it is", () => {
  assert.equal(hoistTag("*web what is the weather", "web"), "*web what is the weather");
});

test("a bare tag survives the hoist", () => {
  assert.equal(hoistTag("*web", "web"), "*web");
});
