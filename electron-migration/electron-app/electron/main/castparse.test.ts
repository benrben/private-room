/**
 * Vitest port of `src-tauri/src/commands/castparse.rs`'s `mod tests`:
 *
 *   - a_markdown_character_sheet_reads_as_people
 *   - the_authors_own_labels_beat_our_guess
 *   - a_section_title_is_never_mistaken_for_a_hero
 *   - a_name_colon_line_keeps_what_follows_the_colon
 *   - prose_that_is_not_a_character_sheet_yields_nobody
 *   - a_runaway_document_stops_at_the_ceiling
 *   - a_heading_that_is_really_a_sentence_is_left_alone
 *
 * plus cases for this port's own `rustLines` helper, which has no Rust
 * counterpart (JS's `String.prototype.split("\n")` disagrees with Rust's
 * `str::lines()` on a trailing newline — see that helper's doc).
 */

import { describe, expect, it } from "vitest";
import { bare, isPersonHeading, isSectionWord, MAX_FOUND, parseCast } from "./castparse.js";

describe("parseCast", () => {
  it("a markdown character sheet reads as people", () => {
    const sheet = `# Characters

## Mira Halloran
Tall, grey wool coat, hair cut short, a burn scar on the left hand.

Lost her ship in the winter. Came back to the harbour to find out who sold it.

## Doran
Broad, weathered, salt-stained oilskin.

Harbourmaster for thirty years. Knows exactly who sold it.
`;
    const cast = parseCast(sheet);
    expect(cast, "two people, and NOT the 'Characters' heading").toHaveLength(2);
    expect(cast[0]?.name).toBe("Mira Halloran");
    expect(cast[0]?.description.startsWith("Tall, grey wool coat")).toBe(true);
    expect(cast[0]?.story.startsWith("Lost her ship")).toBe(true);
    expect(cast[1]?.name).toBe("Doran");
    expect(cast[1]?.story).toContain("Harbourmaster");
  });

  it("the author's own labels beat our guess", () => {
    // When the writer said which is which, the split is theirs, not ours.
    const sheet = `## Noa
Backstory: An archivist who hears the dead.
Appearance: Small, close-cropped hair, ink on both hands.
`;
    const cast = parseCast(sheet);
    expect(cast).toHaveLength(1);
    expect(cast[0]?.description).toBe("Small, close-cropped hair, ink on both hands.");
    expect(cast[0]?.story).toBe("An archivist who hears the dead.");
  });

  it("a section title is never mistaken for a hero", () => {
    // Without this, every sheet imports "Cast" and "Characters" as people.
    for (const word of ["# Cast", "## Characters", "**Dramatis Personae**", "## Setting"]) {
      expect(!isPersonHeading(word) || isSectionWord(bare(word)), `${word} must not open a person`).toBe(
        true
      );
    }
    const cast = parseCast("# Cast\n\n## Mira\nTall.\n");
    expect(cast).toHaveLength(1);
    expect(cast[0]?.name).toBe("Mira");
  });

  it("a name-colon line keeps what follows the colon", () => {
    // `Mira: tall, grey coat` is the compact form people actually write, and
    // the words after the colon are the description — dropping them would
    // import a hero with no face and no explanation.
    const cast = parseCast("Mira: tall, grey wool coat\nShe walks with a limp.\n");
    expect(cast).toHaveLength(1);
    expect(cast[0]?.name).toBe("Mira");
    expect(cast[0]?.description).toContain("tall, grey wool coat");
    expect(cast[0]!.description.includes("limp") || cast[0]!.story.includes("limp")).toBe(true);
  });

  it("prose that is not a character sheet yields nobody", () => {
    // The important negative. A screenplay, a note, a shopping list — returning
    // nothing is a fact the reader can act on. Returning one invented hero is
    // not, and it would be believed.
    const script = `The harbour is empty. Mira walks the quay, counting the moorings.
A light comes on in the harbourmaster's window. She does not look up.
The tide turns, and the rope goes slack.
`;
    expect(parseCast(script)).toEqual([]);
  });

  it("a runaway document stops at the ceiling", () => {
    let many = "";
    for (let i = 0; i < 200; i++) {
      many += `## Person ${i}\nTall.\n\n`;
    }
    expect(parseCast(many)).toHaveLength(MAX_FOUND);
  });

  it("a heading that is really a sentence is left alone", () => {
    // Four words is the line. "Captain Mira Halloran" is a name; a marked-up
    // line of prose is not, and splitting on it would put half a description
    // under a heading that is really a sentence.
    expect(isPersonHeading("## Captain Mira Halloran")).toBe(true);
    expect(isPersonHeading("## She walks the quay counting the moorings")).toBe(false);
    expect(isPersonHeading("**Mira walks, and the tide turns.**")).toBe(false);
  });
});

describe("rustLines (this port's own dependency, no Rust counterpart)", () => {
  it("a character sheet ending in a trailing newline reads no differently than one that does not", () => {
    expect(parseCast("## Mira\nTall.\n")).toEqual(parseCast("## Mira\nTall."));
  });

  it("a blank line in the MIDDLE of a block is still a real, separate line", () => {
    // Only the trailing artifact of a final newline is ever dropped.
    const cast = parseCast("## Mira\nTall, grey coat.\n\nLost her ship.\n");
    expect(cast).toHaveLength(1);
    expect(cast[0]?.description).toBe("Tall, grey coat.");
    expect(cast[0]?.story).toBe("Lost her ship.");
  });

  it("CRLF line endings read the same as LF", () => {
    // `str::lines()` strips a trailing `\r` from every line; a sheet saved on
    // Windows must not gain a stray carriage return inside a name.
    expect(parseCast("## Mira\r\nTall.\r\n")).toEqual(parseCast("## Mira\nTall.\n"));
  });
});
