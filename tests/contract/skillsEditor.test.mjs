/* WHAT THE SKILLS EDITOR IS ALLOWED TO THROW AWAY, AND WHAT IT MAY CLAIM.
 *
 * The editor holds the only copy of typed-but-unsaved work: the SKILL.md
 * fields and the open resource's text live in component state and nowhere
 * else. Four ways it lost that work, or lied about it:
 *
 *   • Saving, adding or removing a FILE called `load()`, which re-reads the
 *     skill and replaces the draft with the stored values. Typed instructions
 *     vanished, and the Save SKILL.md button greyed out, with no prompt.
 *   • Enabling a skill pre-saved it and then enabled REGARDLESS: a refused
 *     save (empty description, duplicate name) produced an error toast
 *     immediately followed by "Skill enabled…", advertising a version that is
 *     not the one on screen.
 *   • The save always sent `agent`, so a skill bound to a specialist this
 *     build no longer has ("Unknown owner", a state the UI itself draws) had
 *     every save refused over a field the edit never touched.
 *   • The assistant's `save_skill` on the open skill was invisible, and the
 *     next Save wrote the pre-existing text back over it with no warning.
 *
 * The handlers are SLICED out of the shipped component (they close over React
 * state and cannot be imported) and driven against fakes — the same technique
 * unsavedGuard/recSession use. The `let` bindings below stand in for the
 * useState pairs, which is enough to observe what each handler writes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = readFileSync(join(root, "apps/desktop/src/renderer/workspace/skills/SkillsView.tsx"), "utf8");

/** A whole function declaration, by brace matching from its signature. The
 * opening brace is taken at paren depth zero so a parameter's own type
 * annotation cannot be mistaken for the body. */
function fnSource(src, signature) {
  const at = src.indexOf(signature);
  assert.notEqual(at, -1, `${signature} is gone from the source`);
  let parens = 0;
  let open = -1;
  for (let i = at; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")") parens--;
    else if (src[i] === "{" && parens === 0) {
      open = i;
      break;
    }
  }
  assert.notEqual(open, -1, `no body found for ${signature}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unterminated body for ${signature}`);
}

const MODULE = [
  "export function makeEditor(env) {",
  "  const { api, s, a, confirm } = env;",
  "  let bundle = env.bundle ?? null;",
  "  let draft = env.draft ?? null;",
  "  let dirty = env.dirty ?? false;",
  "  let busy = false;",
  "  let isNew = false;",
  "  let deletedElsewhere = null;",
  "  let resource = env.resource ?? null;",
  "  let resourceText = env.resourceText ?? '';",
  "  let resourceDirty = env.resourceDirty ?? false;",
  "  let newResourcePath = env.newResourcePath ?? '';",
  "  const setBundle = (v) => { bundle = typeof v === 'function' ? v(bundle) : v; };",
  "  const setDraft = (v) => { draft = v; };",
  "  const setDirty = (v) => { dirty = v; };",
  "  const setBusy = (v) => { busy = v; };",
  "  const setIsNew = (v) => { isNew = v; };",
  "  const setDeletedElsewhere = (v) => { deletedElsewhere = v; };",
  "  const setResource = (v) => { resource = v; };",
  "  const setResourceText = (v) => { resourceText = v; };",
  "  const setResourceDirty = (v) => { resourceDirty = v; };",
  "  const setNewResourcePath = (v) => { newResourcePath = v; };",
  fnSource(SRC, "async function load("),
  fnSource(SRC, "async function reloadResources("),
  fnSource(SRC, "async function openResource("),
  fnSource(SRC, "async function confirmDiscard("),
  fnSource(SRC, "async function saveMetadata("),
  fnSource(SRC, "async function saveResource("),
  fnSource(SRC, "async function addResource("),
  fnSource(SRC, "async function toggleEnabled("),
  "  const state = () => ({ bundle, draft, dirty, resource, resourceText, resourceDirty });",
  "  return { saveMetadata, saveResource, addResource, toggleEnabled, state };",
  "}",
].join("\n");

const JS = ts.transpileModule(MODULE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { makeEditor } = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

const STORED = {
  id: "sk1",
  name: "review",
  description: "Review contracts. Use when…",
  instructions: "1. Read it.",
  agent: "",
  enabled: false,
};

/** The editor as it stands after opening `review` and typing into the
 * instructions box without saving. */
function open(overrides = {}) {
  const skill = { ...STORED, ...(overrides.skill ?? {}) };
  const s = {
    toasts: [],
    pushToast: (kind, text) => s.toasts.push({ kind, text }),
    setSelectedSkillId: () => {},
  };
  const env = {
    s,
    a: { refreshSkills: async () => {} },
    bundle: { skill, resources: overrides.resources ?? [{ path: "references/policy.md" }] },
    draft: {
      name: skill.name,
      description: skill.description,
      instructions: overrides.typed ?? "1. Read it.\n2. Say what is risky.",
      agent: overrides.draftAgent ?? skill.agent,
    },
    dirty: overrides.dirty ?? true,
    resource: overrides.resource ?? null,
    resourceText: overrides.resourceText ?? "",
    resourceDirty: overrides.resourceDirty ?? false,
    newResourcePath: overrides.newResourcePath ?? "",
    confirm: overrides.confirm ?? (async () => true),
    api: overrides.api ?? {},
  };
  return { env, s, editor: makeEditor(env) };
}

test("saving a file leaves the unsaved SKILL.md draft alone", async () => {
  const calls = [];
  const { editor, s } = open({
    resource: { path: "references/policy.md", kind: "reference", text: "old" },
    resourceText: "old + a line",
    resourceDirty: true,
    api: {
      saveSkillResource: async (id, path, body) => calls.push(["save", path, body.text]),
      // The folder listing has to come back fresh — that is what the reload is
      // FOR — but the SKILL.md draft is not the room's to replace.
      getSkill: async () => ({
        skill: STORED,
        resources: [{ path: "references/policy.md" }, { path: "scripts/x.py" }],
      }),
      getSkillResource: async () => ({ path: "references/policy.md", kind: "reference", text: "old + a line" }),
    },
  });
  await editor.saveResource();
  const st = editor.state();
  assert.equal(st.draft.instructions, "1. Read it.\n2. Say what is risky.");
  assert.equal(st.dirty, true, "Save SKILL.md must not grey out");
  assert.equal(st.bundle.resources.length, 2, "the folder listing still refreshes");
  assert.deepEqual(calls[0], ["save", "references/policy.md", "old + a line"]);
  assert.match(s.toasts.map((t) => t.text).join(" | "), /saved/);
});

test("adding a file leaves the unsaved SKILL.md draft alone", async () => {
  const { editor } = open({
    newResourcePath: "references/new.md",
    api: {
      saveSkillResource: async () => {},
      getSkill: async () => ({
        skill: STORED,
        resources: [{ path: "references/policy.md" }, { path: "references/new.md" }],
      }),
      getSkillResource: async () => ({ path: "references/new.md", kind: "reference", text: "" }),
    },
  });
  await editor.addResource();
  const st = editor.state();
  assert.equal(st.draft.instructions, "1. Read it.\n2. Say what is risky.");
  assert.equal(st.dirty, true);
  assert.equal(st.resource.path, "references/new.md", "the new file opens");
});

test("a refused save must not enable the skill", async () => {
  let enabled = null;
  const { editor, s } = open({
    api: {
      getSkill: async () => ({ skill: STORED, resources: [] }),
      updateSkill: async () => {
        throw new Error("Describe what the skill does and when the assistant should use it.");
      },
      setSkillEnabled: async (_id, on) => {
        enabled = on;
      },
    },
  });
  await editor.toggleEnabled(true);
  assert.equal(enabled, null, "nothing may be advertised to the model");
  const said = s.toasts.map((t) => t.text).join(" | ");
  assert.match(said, /Describe what the skill does/);
  assert.doesNotMatch(said, /Skill enabled/);
  // The typed text is still there to correct.
  assert.equal(editor.state().draft.instructions, "1. Read it.\n2. Say what is risky.");
  assert.equal(editor.state().dirty, true);
});

test("an owner the roster no longer has does not block an unrelated edit", async () => {
  const sent = [];
  const api = {
    getSkill: async () => ({ skill: { ...STORED, agent: "ghost" }, resources: [] }),
    updateSkill: async (_id, _n, _d, _i, agent) => sent.push(agent),
  };
  // Untouched picker: the owner does not travel at all, so the host leaves the
  // binding alone instead of refusing the whole save.
  const untouched = open({ skill: { agent: "ghost" }, draftAgent: "ghost", api });
  assert.equal(await untouched.editor.saveMetadata(), true);
  assert.equal(sent[0], undefined);
  // Corrected picker: the new owner is exactly what gets sent.
  const corrected = open({ skill: { agent: "ghost" }, draftAgent: "research", api });
  assert.equal(await corrected.editor.saveMetadata(), true);
  assert.equal(sent[1], "research");
});

test("saving a file does not adopt a foreign write as the baseline", async () => {
  // The reload after a file save re-reads the whole skill. Taking `skill` from
  // it too would move the copy the SKILL.md save compares against, so the very
  // next Save would find "nothing changed elsewhere" and overwrite the
  // assistant's version in the silence the conflict check exists to break.
  const asked = [];
  const sent = [];
  const { editor } = open({
    resource: { path: "references/policy.md", kind: "reference", text: "old" },
    resourceText: "old + a line",
    resourceDirty: true,
    confirm: async (m) => (asked.push(m), false),
    api: {
      saveSkillResource: async () => {},
      // The assistant rewrote SKILL.md while this editor was open.
      getSkill: async () => ({
        skill: { ...STORED, instructions: "1. Read it.\n2. The assistant's version." },
        resources: [{ path: "references/policy.md" }],
      }),
      // Unchanged on disk, so the file save itself goes through without a
      // question of its own — this test is about what it leaves behind.
      getSkillResource: async () => ({ path: "references/policy.md", kind: "reference", text: "old" }),
      updateSkill: async (_id, _n, _d, instructions) => sent.push(instructions),
    },
  });
  await editor.saveResource();
  assert.equal(await editor.saveMetadata(), false);
  assert.equal(sent.length, 0, "the assistant's version is still in the room");
  assert.match(asked[0] ?? "", /changed outside this editor/);
});

test("a write from elsewhere is not overwritten without asking", async () => {
  const asked = [];
  const sent = [];
  const api = {
    // The assistant rewrote the instructions while the editor was open.
    getSkill: async () => ({
      skill: { ...STORED, instructions: "1. Read it.\n2. The assistant's version." },
      resources: [],
    }),
    updateSkill: async (_id, _n, _d, instructions) => sent.push(instructions),
  };
  const declined = open({ api, confirm: async (m) => (asked.push(m), false) });
  assert.equal(await declined.editor.saveMetadata(), false);
  assert.equal(sent.length, 0, "the assistant's version is still in the room");
  assert.equal(declined.editor.state().dirty, true, "and the user's version is still on screen");
  assert.match(asked[0], /changed outside this editor/);
  // Saying yes is still allowed — it is the silence that was the defect.
  const accepted = open({ api, confirm: async () => true });
  assert.equal(await accepted.editor.saveMetadata(), true);
  assert.equal(sent[0], "1. Read it.\n2. Say what is risky.");
});
