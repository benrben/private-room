/* Two things the Story tab did that nothing in the tree can catch.
 *
 * The cast strip drew one <HeroFace> per member and each one fetched the
 * room's thumbnails for itself — and `story_pictures` builds the WHOLE list
 * every call, so eight heroes on a cold cache meant eight concurrent
 * decode-and-shrink passes over every picture in the room before the first
 * face appeared. And the "shots cannot be joined" hint was rendered from
 * `board.shots.length > 0`, so a one-shot list — which has no receiving shot
 * to look at — was told a capability fact about "the clip model chosen here"
 * that nothing had evaluated, and that most video models contradict.
 *
 * Source-level on purpose: both are about how many calls a render makes and
 * on what a sentence is conditioned, and nothing here renders React.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const story = readFileSync(join(root, "apps/desktop/src/renderer/workspace/create/StoryTab.tsx"), "utf8");

/** One top-level `function Name(` declaration's source, up to the next one. */
function declaration(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from StoryTab.tsx`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("one portrait does not fetch the room's thumbnails for itself", () => {
  const heroFace = declaration(story, "HeroFace");
  assert.ok(
    !heroFace.includes("storyPictures"),
    "HeroFace is rendered once per cast member, and story_pictures rebuilds " +
      "the room's WHOLE thumbnail list on every call — a fetch in here is N " +
      "passes over every picture in the room to draw one 64px square",
  );
  assert.ok(
    !heroFace.includes("useEffect"),
    "and nothing else may be fetched from inside it either",
  );
  // The strip above it does the one read the whole row is drawn from.
  assert.ok(declaration(story, "CastStrip").includes("storyPictures"));
});

test("no clip model is called incapable without one having been looked at", () => {
  // Split so this needle cannot be satisfied by a scan of this file itself.
  const claim = "The clip model chosen here" + " takes no starting picture";
  assert.ok(
    !story.includes(claim),
    "a fixed sentence about the chosen model's frame slots, rendered whenever " +
      "the list had any shots at all — including a one-shot list, which hands " +
      "no shot a starting frame and so evaluates no model's support for one",
  );
});
