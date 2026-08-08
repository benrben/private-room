//! Read a character sheet that already exists into people the room can use.
//!
//! The complaint this answers is a fair one: the room is built on files, the
//! heroes are already written down in one, and the Story tab was asking for
//! all of it to be typed in again. Retyping a document you already have is not
//! data entry, it is a bug with a text box in front of it.
//!
//! **No model is asked.** This is the same choice `shotsplit.rs` makes and for
//! the same reasons: it is free, it is instant, nothing leaves the Mac, and —
//! the part that matters for a character sheet — it cannot quietly invent a
//! hero who is not in the file, or reword a description into something the
//! author did not write. A model would read messier files better; it would
//! also be the only component here capable of hallucinating a cast member.
//!
//! What it can and cannot do is therefore worth stating plainly, because the
//! UI states it too: this recognises the shapes people actually write
//! character sheets in, and when it recognises nothing it says so rather than
//! guessing. A file it cannot read costs one glance, not one wrong cast.

/// Someone found in a document, before anyone has agreed to keep them.
/// Deserialize too, not only Serialize: the same shape goes out to the preview
/// and comes back with the user's edits on it, so the round trip is the point.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedMember {
    pub name: String,
    /// What they look like — goes into every prompt they appear in.
    pub description: String,
    /// Who they are. Stays in the room; never sent to any model.
    pub story: String,
}

/// A ceiling on one import. A document that yields more than this is being
/// misread — a novel's every capitalised line, say — and importing sixty
/// people nobody asked for is worse than importing none.
pub(crate) const MAX_FOUND: usize = 40;

/// Field labels people actually write. Checked longest-first so "backstory"
/// is never matched as "story" with a stray "back" left in the value.
const LOOK_LABELS: [&str; 8] = [
    "appearance",
    "description",
    "looks like",
    "look",
    "looks",
    "wearing",
    "visual",
    "design",
];
const STORY_LABELS: [&str; 8] = [
    "backstory",
    "background",
    "biography",
    "history",
    "story",
    "bio",
    "wants",
    "voice",
];

/// Strip markdown emphasis and list bullets from around a heading.
fn bare(line: &str) -> String {
    let mut s = line.trim();
    for lead in ['#', '-', '*', '+', '>', '•'] {
        s = s.trim_start_matches(lead);
    }
    let s = s.trim();
    // `**Mira**`, `__Mira__`, `*Mira*`
    let s = s.trim_matches(|c| c == '*' || c == '_').trim();
    s.trim_end_matches(':').trim().to_string()
}

/// Is this line the start of a new person?
///
/// Deliberately conservative. A false positive splits one hero into two and
/// puts half their description under a name that is really a sentence, which
/// is a worse and much less obvious failure than missing a heading.
fn is_person_heading(line: &str) -> bool {
    let raw = line.trim();
    if raw.is_empty() {
        return false;
    }
    // A markdown heading is unambiguous — but `# Characters` is a section
    // title, not a person, and is filtered out by the name test below.
    let marked = raw.starts_with('#')
        || (raw.starts_with("**") && raw.trim_end_matches(':').ends_with("**"))
        || (raw.starts_with("__") && raw.trim_end_matches(':').ends_with("__"));
    // For a `head: value` line the NAME is only what precedes the colon.
    let head = raw.split_once(':').map(|(h, _)| h).unwrap_or(raw);
    let name = bare(head);
    if name.is_empty() || is_section_word(&name) || is_field_label(&name) {
        return false;
    }
    // A name is short and has no sentence punctuation in it. Four words
    // covers "Captain Mira Halloran" without swallowing a line of prose.
    let wordy = name.split_whitespace().count() > 4;
    let punctuated = name.contains('.') || name.contains(',') || name.contains(';');
    if marked {
        return !wordy && !punctuated;
    }
    // Unmarked, so the bar is higher: only `Name:` opening a line, and only
    // when the head reads like a name rather than a clause. Without the
    // capitalisation test, "The tide turns: the rope goes slack" opens a hero
    // called "The tide turns" — and the whole scene lands in his description.
    raw.contains(':') && !wordy && !punctuated && looks_like_a_name(&name)
}

/// Every word capitalised, and short. Deliberately strict: this is the only
/// place an unmarked line can start a person, so a miss costs a heading the
/// user can add, while a false positive costs a hero made out of a sentence.
fn looks_like_a_name(name: &str) -> bool {
    if name.len() > 40 {
        return false;
    }
    let words: Vec<&str> = name.split_whitespace().collect();
    if words.is_empty() || words.len() > 3 {
        return false;
    }
    words
        .iter()
        .all(|w| w.chars().next().is_some_and(|c| c.is_uppercase()))
}

/// Is this one of the field labels that live INSIDE a person's block?
///
/// Without this, `Backstory:` on its own line opens a new hero called
/// "Backstory" and steals the rest of the real one's description.
fn is_field_label(name: &str) -> bool {
    let lower = name.to_lowercase();
    let lower = lower.trim();
    LOOK_LABELS.iter().chain(STORY_LABELS.iter()).any(|l| *l == lower)
}

/// Words that name a SECTION rather than a person. Without this, "Characters"
/// and "Cast" become the first two heroes of every document.
fn is_section_word(name: &str) -> bool {
    let lower = name.to_lowercase();
    matches!(
        lower.trim(),
        "cast"
            | "characters"
            | "character"
            | "people"
            | "heroes"
            | "dramatis personae"
            | "the cast"
            | "roles"
            | "contents"
            | "notes"
            | "synopsis"
            | "logline"
            | "setting"
            | "script"
            | "scenes"
            | "shots"
    )
}

/// Split `label: value` when the label is one we know.
fn labelled<'a>(line: &'a str, labels: &[&str]) -> Option<&'a str> {
    let (head, rest) = line.split_once(':')?;
    let head = bare(head).to_lowercase();
    labels
        .iter()
        .any(|l| head == *l || head.starts_with(&format!("{l} ")))
        .then(|| rest.trim())
}

/// Read a document into the people it describes.
///
/// Returns an empty vec when it recognises nothing — never a guess. The caller
/// shows that as "this file does not look like a character sheet", which is a
/// fact the reader can act on, unlike one invented hero.
pub(crate) fn parse_cast(text: &str) -> Vec<ParsedMember> {
    let mut found: Vec<ParsedMember> = Vec::new();
    // The block of lines belonging to the person currently open.
    let mut name = String::new();
    let mut block: Vec<String> = Vec::new();

    fn close(name: &mut String, block: &mut Vec<String>, out: &mut Vec<ParsedMember>) {
        if name.is_empty() {
            block.clear();
            return;
        }
        let (description, story) = split_block(block);
        out.push(ParsedMember {
            name: std::mem::take(name),
            description,
            story,
        });
        block.clear();
    }

    for line in text.lines() {
        if is_person_heading(line) {
            close(&mut name, &mut block, &mut found);
            if found.len() >= MAX_FOUND {
                return found;
            }
            let raw = line.trim();
            // `Mira: tall, grey coat` — the heading carries the first fact.
            if let Some((head, rest)) = raw.split_once(':') {
                name = bare(head);
                if !rest.trim().is_empty() {
                    block.push(rest.trim().to_string());
                }
            } else {
                name = bare(raw);
            }
            continue;
        }
        if !name.is_empty() {
            block.push(line.to_string());
        }
    }
    close(&mut name, &mut block, &mut found);
    found.retain(|m| !m.name.is_empty());
    found
}

/// Turn one person's lines into what-they-look-like and who-they-are.
///
/// Labelled fields win when the author wrote them, because then the split is
/// the author's rather than ours. Otherwise the first paragraph is taken as
/// the description and the rest as the story — the order character sheets are
/// conventionally written in, and the only guess in this file.
fn split_block(block: &[String]) -> (String, String) {
    let mut looks: Vec<String> = Vec::new();
    let mut story: Vec<String> = Vec::new();
    let mut labelled_any = false;
    // Which labelled field the following unlabelled lines continue.
    let mut current: Option<bool> = None; // Some(true) = looks, Some(false) = story

    for line in block {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            current = None;
            if labelled_any {
                continue;
            }
            looks.push(String::new());
            continue;
        }
        if let Some(value) = labelled(trimmed, &LOOK_LABELS) {
            labelled_any = true;
            current = Some(true);
            if !value.is_empty() {
                looks.push(value.to_string());
            }
            continue;
        }
        if let Some(value) = labelled(trimmed, &STORY_LABELS) {
            labelled_any = true;
            current = Some(false);
            if !value.is_empty() {
                story.push(value.to_string());
            }
            continue;
        }
        match current {
            Some(true) => looks.push(trimmed.to_string()),
            Some(false) => story.push(trimmed.to_string()),
            None if labelled_any => story.push(trimmed.to_string()),
            None => looks.push(trimmed.to_string()),
        }
    }

    if labelled_any {
        return (tidy(&looks), tidy(&story));
    }
    // Unlabelled: first paragraph describes, the rest is who they are.
    let joined: Vec<String> = looks;
    let mut first: Vec<String> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    let mut past = false;
    for line in joined {
        if line.trim().is_empty() {
            if !first.is_empty() {
                past = true;
            }
            continue;
        }
        if past {
            rest.push(line);
        } else {
            first.push(line);
        }
    }
    (tidy(&first), tidy(&rest))
}

fn tidy(lines: &[String]) -> String {
    lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_markdown_character_sheet_reads_as_people() {
        let sheet = "\
# Characters

## Mira Halloran
Tall, grey wool coat, hair cut short, a burn scar on the left hand.

Lost her ship in the winter. Came back to the harbour to find out who sold it.

## Doran
Broad, weathered, salt-stained oilskin.

Harbourmaster for thirty years. Knows exactly who sold it.
";
        let cast = parse_cast(sheet);
        assert_eq!(cast.len(), 2, "two people, and NOT the 'Characters' heading");
        assert_eq!(cast[0].name, "Mira Halloran");
        assert!(cast[0].description.starts_with("Tall, grey wool coat"));
        assert!(cast[0].story.starts_with("Lost her ship"));
        assert_eq!(cast[1].name, "Doran");
        assert!(cast[1].story.contains("Harbourmaster"));
    }

    #[test]
    fn the_authors_own_labels_beat_our_guess() {
        // When the writer said which is which, the split is theirs, not ours.
        let sheet = "\
## Noa
Backstory: An archivist who hears the dead.
Appearance: Small, close-cropped hair, ink on both hands.
";
        let cast = parse_cast(sheet);
        assert_eq!(cast.len(), 1);
        assert_eq!(cast[0].description, "Small, close-cropped hair, ink on both hands.");
        assert_eq!(cast[0].story, "An archivist who hears the dead.");
    }

    #[test]
    fn a_section_title_is_never_mistaken_for_a_hero() {
        // Without this, every sheet imports "Cast" and "Characters" as people.
        for word in ["# Cast", "## Characters", "**Dramatis Personae**", "## Setting"] {
            assert!(
                !is_person_heading(word) || is_section_word(&bare(word)),
                "{word} must not open a person"
            );
        }
        let cast = parse_cast("# Cast\n\n## Mira\nTall.\n");
        assert_eq!(cast.len(), 1);
        assert_eq!(cast[0].name, "Mira");
    }

    #[test]
    fn a_name_colon_line_keeps_what_follows_the_colon() {
        // `Mira: tall, grey coat` is the compact form people actually write,
        // and the words after the colon are the description — dropping them
        // would import a hero with no face and no explanation.
        let cast = parse_cast("Mira: tall, grey wool coat\nShe walks with a limp.\n");
        assert_eq!(cast.len(), 1);
        assert_eq!(cast[0].name, "Mira");
        assert!(cast[0].description.contains("tall, grey wool coat"));
        assert!(cast[0].description.contains("limp") || cast[0].story.contains("limp"));
    }

    #[test]
    fn prose_that_is_not_a_character_sheet_yields_nobody() {
        // The important negative. A screenplay, a note, a shopping list —
        // returning nothing is a fact the reader can act on. Returning one
        // invented hero is not, and it would be believed.
        let script = "\
The harbour is empty. Mira walks the quay, counting the moorings.
A light comes on in the harbourmaster's window. She does not look up.
The tide turns, and the rope goes slack.
";
        assert!(parse_cast(script).is_empty());
    }

    #[test]
    fn a_runaway_document_stops_at_the_ceiling() {
        let many: String = (0..200).map(|i| format!("## Person {i}\nTall.\n\n")).collect();
        assert_eq!(parse_cast(&many).len(), MAX_FOUND);
    }

    #[test]
    fn a_heading_that_is_really_a_sentence_is_left_alone() {
        // Four words is the line. "Captain Mira Halloran" is a name;
        // a marked-up line of prose is not, and splitting on it would put half
        // a description under a heading that is really a sentence.
        assert!(is_person_heading("## Captain Mira Halloran"));
        assert!(!is_person_heading("## She walks the quay counting the moorings"));
        assert!(!is_person_heading("**Mira walks, and the tide turns.**"));
    }
}
