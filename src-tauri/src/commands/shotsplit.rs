//! Cut a long script into a fixed number of shots.
//!
//! A five-minute episode cannot be one generation: the longest clip any model
//! in the catalogue will make is 20 seconds, and most stop at 15. So five
//! minutes is twenty shots, and the script has to be divided twenty ways.
//!
//! DONE HERE, IN PLAIN CODE, RATHER THAN BY A MODEL — deliberately, and the
//! reasons are not stylistic:
//!
//!   * **Nothing leaves the Mac.** Splitting a script is the sort of task a
//!     model is obviously good at, and sending a whole script to a provider to
//!     have it counted into twenty pieces would be a trip off this machine for
//!     a job that needs no intelligence at all.
//!   * **No text can go missing.** A model asked for twenty parts returns
//!     roughly twenty parts, drops a sentence it thought was redundant, and
//!     rewrites another. The invariant here is exact: put the parts back
//!     together and you have every word you started with. A test asserts it.
//!   * **It is free and instant**, on work the user is already paying for
//!     twenty times over downstream.
//!
//! The split prefers sentence boundaries, falls back to word boundaries when a
//! script has fewer sentences than shots, and always returns exactly the number
//! asked for.

/// The most shots one script may be cut into.
///
/// Twenty minutes of finished video at 15 seconds a shot, and eighty paid
/// generations. Far past any real episode, and low enough that a mistyped
/// number cannot queue a bill.
pub(crate) const MAX_PARTS: usize = 80;

/// Where a sentence may end. `…` is included because a script written by hand
/// uses it constantly, and `\n` because a line break in a script is a beat.
fn is_boundary(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '…' | '\n')
}

/// Break text into sentences, each keeping its own punctuation and spacing.
///
/// Nothing is trimmed away here: every character of the input lands in exactly
/// one piece, which is what makes the round-trip test possible.
fn sentences(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        current.push(c);
        if !is_boundary(c) {
            continue;
        }
        // Run on through the rest of a `?!` or `...` cluster and the space
        // after it, so the next sentence starts at a word rather than at a
        // stray space or a second full stop.
        while let Some(&next) = chars.peek() {
            if is_boundary(next) || next == ' ' || next == '\t' || next == '"' || next == '”' {
                current.push(next);
                chars.next();
            } else {
                break;
            }
        }
        out.push(std::mem::take(&mut current));
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Split one piece into `n` pieces on word boundaries.
///
/// The fallback for a script with fewer sentences than shots — one long
/// unpunctuated paragraph, which is a real way people write. Splitting mid-word
/// would be worse than any imbalance, so word boundaries win over evenness.
fn split_words(text: &str, n: usize) -> Vec<String> {
    if n <= 1 {
        return vec![text.to_string()];
    }
    let words: Vec<&str> = text.split_inclusive(char::is_whitespace).collect();
    if words.len() <= n {
        // Fewer words than pieces: give one word each and pad with blanks
        // rather than losing any. A blank shot is visible and editable; a
        // dropped line is neither.
        let mut out: Vec<String> = words.iter().map(|w| w.to_string()).collect();
        out.resize(n, String::new());
        return out;
    }
    let per = words.len() / n;
    let extra = words.len() % n;
    let mut out = Vec::with_capacity(n);
    let mut at = 0usize;
    for i in 0..n {
        // The first `extra` pieces take one more word, so the remainder is
        // spread rather than dumped on the last piece.
        let take = per + usize::from(i < extra);
        out.push(words[at..at + take].concat());
        at += take;
    }
    out
}

/// Cut `script` into exactly `parts` shots.
///
/// Sentences are packed greedily toward an even share of the total length, but
/// never at the cost of the count: if packing would leave fewer pieces than
/// asked for, the remaining sentences are split by words to make up the
/// difference. The concatenation of the result always equals the input.
pub(crate) fn split_script(script: &str, parts: usize) -> Vec<String> {
    let parts = parts.clamp(1, MAX_PARTS);
    if parts == 1 {
        return vec![script.trim().to_string()];
    }

    let pieces = sentences(script);
    if pieces.is_empty() {
        return vec![String::new(); parts];
    }

    let total: usize = pieces.iter().map(|p| p.chars().count()).sum();
    let target = (total / parts).max(1);

    // 1. Break up any sentence long enough to dominate a shot on its own.
    //
    // Every shot is the SAME number of seconds, so the text in each should be
    // about the same size. Left whole, a 400-character paragraph took one
    // 15-second shot while three ten-character lines took the other three —
    // the same screen time for forty times the content. Sentence integrity is
    // worth a lot, but not that.
    let mut units: Vec<String> = Vec::with_capacity(pieces.len());
    for piece in pieces {
        let length = piece.chars().count();
        let n = length.div_ceil(target.max(1));
        if n > 1 && length > target {
            units.extend(split_words(&piece, n.min(parts)));
        } else {
            units.push(piece);
        }
    }

    // 2. Still not enough to go round? Split the LONGEST repeatedly, so one
    //    enormous paragraph is broken up before a short aside is cut in half.
    while units.len() < parts {
        let (index, _) = units
            .iter()
            .enumerate()
            .max_by_key(|(_, p)| p.chars().count())
            .expect("non-empty");
        let longest = units.remove(index);
        for (offset, half) in split_words(&longest, 2).into_iter().enumerate() {
            units.insert(index + offset, half);
        }
    }

    // 3. Pack toward the ideal boundaries, choosing for each unit whether
    //    closing BEFORE it lands nearer the boundary than closing after it.
    //    Packing greedily "until full" instead overshot every time — a shot
    //    would close only once it was already past its share, so each one ran
    //    long and the last took whatever was left.
    let mut out: Vec<String> = Vec::with_capacity(parts);
    let mut current = String::new();
    let mut used = 0usize;

    for (index, unit) in units.iter().enumerate() {
        let remaining_units = units.len() - index;
        let remaining_slots = parts - out.len();
        if !current.is_empty() && remaining_slots > 1 {
            // Every remaining unit needs its own shot, or the count fails.
            let must_close = remaining_units == remaining_slots;
            let boundary = total * (out.len() + 1) / parts;
            let after = used + unit.chars().count();
            let closing_now = used.abs_diff(boundary);
            let closing_later = after.abs_diff(boundary);
            if must_close || closing_now <= closing_later {
                out.push(std::mem::take(&mut current));
            }
        }
        current.push_str(unit);
        used += unit.chars().count();
    }
    if !current.is_empty() || out.len() < parts {
        out.push(current);
    }
    // Belt and braces: the count is the contract the caller builds rows from.
    while out.len() > parts {
        let tail = out.pop().unwrap_or_default();
        if let Some(last) = out.last_mut() {
            last.push_str(&tail);
        }
    }
    while out.len() < parts {
        out.push(String::new());
    }
    out.into_iter().map(|p| p.trim().to_string()).collect()
}

/// One chunk the script itself declared, with the length it asked for.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Chunk {
    pub action: String,
    pub seconds: u32,
}

/// `12:34` at `i`, as seconds, plus where it ends.
fn read_clock(chars: &[char], i: usize) -> Option<(u32, usize)> {
    let mut at = i;
    let mut minutes = 0u32;
    let mut digits = 0;
    while at < chars.len() && chars[at].is_ascii_digit() && digits < 2 {
        minutes = minutes * 10 + chars[at].to_digit(10)?;
        at += 1;
        digits += 1;
    }
    if digits == 0 || at >= chars.len() || chars[at] != ':' {
        return None;
    }
    at += 1;
    let mut seconds = 0u32;
    let mut got = 0;
    while at < chars.len() && chars[at].is_ascii_digit() && got < 2 {
        seconds = seconds * 10 + chars[at].to_digit(10)?;
        at += 1;
        got += 1;
    }
    if got != 2 || seconds >= 60 {
        return None;
    }
    Some((minutes * 60 + seconds, at))
}

/// Is this the dash in `00:00–00:15`? Any of the three people actually type.
fn is_range_dash(c: char) -> bool {
    matches!(c, '-' | '–' | '—')
}

/// Is this line a scene heading rather than action?
///
/// Headings sit BETWEEN beats in a screenplay, and they are the single most
/// useful line for drawing the shot — `EXT. LUMINA — MARKET DISTRICT — DAY`
/// is the setting, stated exactly. So they are not discarded as markup; they
/// are carried down onto the beat that follows them.
fn is_heading(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    if t.starts_with('#') || t.chars().all(|c| c == '-' || c == '=' || c == '*') {
        return true;
    }
    let bare = t.trim_matches(|c| c == '*' || c == '#' || c == ' ');
    bare.starts_with("INT.") || bare.starts_with("EXT.") || bare.starts_with("INT/EXT")
}

/// Strip screenplay/markdown decoration from one beat's text.
/// A closing line about the document rather than a beat in it.
///
/// It rides on the LAST chunk, so without this the final shot's prompt ends
/// with "END OF EPISODE 1 — condensed to 5:00 (300 seconds)" — instructions to
/// a reader, sent to a model as though they were something to draw.
fn is_end_matter(line: &str) -> bool {
    let bare = line
        .trim_matches(|c: char| c == '*' || c == '#' || c == '_' || c == ' ')
        .to_ascii_uppercase();
    bare.starts_with("END OF ") || bare == "END" || bare.starts_with("FADE OUT.")
}

/// Does a marker at `i` START its line?
///
/// A real chunk marker opens a beat — `**00:00–00:15** — …` — possibly behind
/// bold stars, a bullet or a quote mark. A range written mid-sentence is
/// PROSE about the episode, not a beat in it: the reported script's own
/// preamble says "exactly 20 chunks of 15 seconds each (00:00–05:00)", which
/// counted as a twenty-first shot and shifted every scene heading onto the
/// wrong beat. Only what begins a line is a mark.
fn starts_line(chars: &[char], i: usize) -> bool {
    let mut at = i;
    while at > 0 {
        let c = chars[at - 1];
        if c == '\n' {
            return true;
        }
        if !matches!(c, '*' | '-' | '#' | '>' | '|' | ' ' | '\t' | '_' | '[' | '(') {
            return false;
        }
        at -= 1;
    }
    true
}

fn clean(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || is_heading(t) || is_end_matter(t) {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t);
    }
    let out = out.replace("**", "").replace("__", "");
    out.trim_start_matches(|c: char| is_range_dash(c) || c.is_whitespace() || c == ':')
        .trim()
        .to_string()
}

/// Read the chunks a script declared for itself, if it declared any.
///
/// A script written as `**00:00–00:15** — …` has already been broken into
/// shots BY ITS AUTHOR, with the lengths they chose. Re-cutting it by
/// character count would throw that away and produce boundaries in the middle
/// of their beats — which is exactly what makes a storyboard useless. So the
/// author's own marks win whenever there are any, and the length of each shot
/// comes from their own timestamps rather than from one number applied to all
/// twenty (a real script has a 10-second beat in it).
///
/// `None` when fewer than two markers are found — one stray `5:00` in a
/// sentence is not a shot list.
pub(crate) fn script_chunks(script: &str) -> Option<Vec<Chunk>> {
    let chars: Vec<char> = script.chars().collect();
    // (where the marker starts, where it ends, its duration)
    let mut marks: Vec<(usize, usize, u32)> = Vec::new();

    let mut i = 0usize;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        // A clock reached from mid-number ("1234:56") is not a timestamp.
        if i > 0 && chars[i - 1].is_ascii_digit() {
            i += 1;
            continue;
        }
        // And a range written mid-sentence is prose about the episode, not a
        // beat in it.
        if !starts_line(&chars, i) {
            i += 1;
            continue;
        }
        let Some((start, after_start)) = read_clock(&chars, i) else {
            i += 1;
            continue;
        };
        let mut at = after_start;
        while at < chars.len() && chars[at] == ' ' {
            at += 1;
        }
        if at >= chars.len() || !is_range_dash(chars[at]) {
            i = after_start;
            continue;
        }
        at += 1;
        while at < chars.len() && chars[at] == ' ' {
            at += 1;
        }
        let Some((end, after_end)) = read_clock(&chars, at) else {
            i = after_start;
            continue;
        };
        marks.push((i, after_end, end.saturating_sub(start)));
        i = after_end;
    }

    if marks.len() < 2 {
        return None;
    }

    let slice = |from: usize, to: usize| -> String { chars[from..to].iter().collect() };

    // Headings found at the END of one region belong to the NEXT beat: a
    // screenplay puts the scene line above the action it introduces.
    let mut pending = trailing_headings(&slice(0, marks[0].0));
    let mut out: Vec<Chunk> = Vec::with_capacity(marks.len());

    for (index, &(_, body_from, seconds)) in marks.iter().enumerate() {
        let body_to = marks.get(index + 1).map(|m| m.0).unwrap_or(chars.len());
        let region = slice(body_from, body_to);
        let carried = trailing_headings(&region);

        let mut action = String::new();
        if !pending.is_empty() {
            action.push_str(&pending);
            action.push_str(". ");
        }
        action.push_str(&clean(&region));
        pending = carried;

        out.push(Chunk {
            action: action.trim().trim_end_matches('.').trim().to_string(),
            // A malformed or zero-length range falls back to something usable
            // rather than refusing the whole script over one typo.
            seconds: seconds.clamp(1, 60),
        });
    }
    Some(out)
}

/// The heading lines at the end of a region, joined — the scene the NEXT beat
/// happens in.
fn trailing_headings(region: &str) -> String {
    let lines: Vec<&str> = region.lines().collect();
    let mut found: Vec<String> = Vec::new();
    for line in lines.iter().rev() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if !is_heading(t) {
            break;
        }
        let bare = t.trim_matches(|c: char| c == '#' || c == '*' || c == ' ');
        // A rule (`---`) is decoration, not a place.
        if !bare.is_empty() && !bare.chars().all(|c| c == '-' || c == '=') {
            found.push(bare.to_string());
        }
    }
    found.reverse();
    found.join(" — ")
}

/// How many shots a wanted runtime needs at a given shot length.
pub(crate) fn parts_for(total_seconds: u32, per_shot: u32) -> usize {
    let per = per_shot.max(1);
    // Rounded UP: twenty 15-second shots is 300 seconds, and asking for 305
    // should give twenty-one rather than quietly losing the last five.
    ((total_seconds as usize).div_ceil(per as usize)).clamp(1, MAX_PARTS)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The invariant the whole module exists for.
    fn words(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn every_word_of_the_script_survives_the_split() {
        // A model asked to do this drops a sentence it judged redundant and
        // rewrites another. This cannot: put the parts back together and the
        // words are the words.
        let script = "The harbour is empty. Mira walks the quay, counting. \
                      A light comes on in the chandlery! Doran is already there. \
                      He does not turn around… She asks him where the boat went. \
                      He says nothing at all. The tide turns.";
        for parts in [2usize, 3, 5, 8] {
            let shots = split_script(script, parts);
            assert_eq!(shots.len(), parts, "asked for {parts}");
            assert_eq!(
                words(&shots.join(" ")),
                words(script),
                "text lost or invented at {parts} parts"
            );
        }
    }

    #[test]
    fn a_five_minute_script_becomes_twenty_shots() {
        // The case this was built for: 300 seconds at 15 a shot.
        assert_eq!(parts_for(300, 15), 20);
        let script = (1..=40)
            .map(|n| format!("Beat number {n} happens here. "))
            .collect::<String>();
        let shots = split_script(&script, 20);
        assert_eq!(shots.len(), 20);
        assert!(shots.iter().all(|s| !s.is_empty()), "no empty shot");
        assert_eq!(words(&shots.join(" ")), words(&script));
        // Evenly spread — not nineteen crumbs and one monster. Every shot is
        // the same 15 seconds on screen, so they should carry the same load.
        let beats: Vec<usize> = shots.iter().map(|s| s.matches("Beat number").count()).collect();
        assert_eq!(beats.iter().sum::<usize>(), 40, "every beat placed once");
        assert!(
            beats.iter().all(|&n| (1..=3).contains(&n)),
            "one shot got far more than its share: {beats:?}"
        );
    }

    #[test]
    fn one_long_paragraph_still_makes_the_count() {
        // A real way people write: no full stops at all. Splitting on word
        // boundaries is the fallback, and it must not cut mid-word.
        let script = "she walks the length of the quay counting the moorings \
                      one by one until she reaches the empty berth where the \
                      boat used to be tied up every winter";
        let shots = split_script(script, 6);
        assert_eq!(shots.len(), 6);
        assert_eq!(words(&shots.join(" ")), words(script));
        assert!(shots.iter().all(|s| !s.is_empty()));
    }

    #[test]
    fn asking_for_more_shots_than_there_are_words_pads_rather_than_loses() {
        // A blank shot is visible and editable. A dropped line is neither.
        let shots = split_script("Two words", 5);
        assert_eq!(shots.len(), 5);
        assert_eq!(words(&shots.join(" ")), words("Two words"));
    }

    #[test]
    fn the_share_is_by_length_not_by_sentence_count() {
        // One long paragraph and several short lines must not put the
        // paragraph alone against a row of near-empty shots.
        let long = "x ".repeat(200);
        let script = format!("{long}. Short one. Short two. Short three.");
        let shots = split_script(&script, 4);
        assert_eq!(shots.len(), 4);
        let lengths: Vec<usize> = shots.iter().map(|s| s.chars().count()).collect();
        // The long paragraph is broken ACROSS shots rather than left whole
        // against three near-empty ones — same seconds, same share of text.
        assert!(
            lengths[0] < long.len() / 2,
            "the long paragraph was left as one shot: {lengths:?}"
        );
        let biggest = lengths.iter().max().copied().unwrap_or(0);
        let smallest = lengths.iter().min().copied().unwrap_or(0);
        assert!(
            biggest <= smallest * 4,
            "wildly uneven shots: {lengths:?}"
        );
        assert_eq!(words(&shots.join(" ")), words(&script));
    }

    #[test]
    fn a_runaway_count_is_clamped_rather_than_queued() {
        // Each shot is a paid generation. A mistyped runtime must not become
        // a thousand of them.
        assert_eq!(parts_for(u32::MAX, 1), MAX_PARTS);
        assert_eq!(split_script("A. B. C.", 10_000).len(), MAX_PARTS);
        // And rounding UP, so nothing at the end is quietly dropped.
        assert_eq!(parts_for(305, 15), 21);
        assert_eq!(parts_for(1, 15), 1);
    }


    /// A slice of the real episode the feature was reported against — the
    /// markers, the em/en dashes, the scene headings between beats, and the
    /// one beat that is 10 seconds rather than 15.
    const EPISODE: &str = "\
# Episode 1: The First Echo — 15-Second Chunk Breakdown

*Condensed ~5-minute pacing pass.*

---

## COLD OPEN — EXT. LUMINA — MARKET DISTRICT — DAY

**00:00–00:15** — Establishing Lumina: transit rings, terraced garden-blocks. Noa (12) weaves through the market stalls.

**00:15–00:30** — A fruit-seller's hand closes on empty air. NOA: \"Okay. That's new.\" SMASH CUT TO TITLE.

---

## ACT ONE

### EXT. LUMINA — MARKET DISTRICT — CONTINUOUS

**00:30–00:45** — Noa charges the shape — nothing works.

### INT. NOA & LIOR'S APARTMENT — NIGHT

**01:00–01:15** — Home, unsettled. Lior deflects Noa's questions.

**03:00–03:10** — As the memory frays, Sena's head tilts. The tunnel dissolves into golden static.
";

    #[test]
    fn a_script_that_already_declares_its_chunks_is_taken_at_its_word() {
        // The reported failure. This script was ALREADY broken into shots by
        // its author, with the lengths they chose — re-cutting it by character
        // count would put boundaries in the middle of their beats, which is
        // exactly what makes a storyboard useless.
        let chunks = script_chunks(EPISODE).expect("the markers are found");
        assert_eq!(chunks.len(), 5, "one shot per timestamp, not per paragraph");

        // Lengths come from the author's own timestamps — including the
        // 10-second beat, which a single "seconds each" number would have
        // silently made 15.
        let seconds: Vec<u32> = chunks.iter().map(|c| c.seconds).collect();
        assert_eq!(seconds, vec![15, 15, 15, 15, 10]);

        // The timestamp itself never reaches the prompt.
        assert!(chunks.iter().all(|c| !c.action.contains("00:")));
        assert!(chunks.iter().all(|c| !c.action.contains("**")));
    }

    #[test]
    fn the_scene_heading_travels_down_onto_the_beat_it_introduces() {
        // A screenplay puts the scene line ABOVE the action. It is also the
        // single most useful line for drawing the shot — the setting, stated
        // exactly — so it is carried onto the beat rather than discarded as
        // markup, and never left on the beat before it.
        let chunks = script_chunks(EPISODE).expect("parsed");
        assert!(
            chunks[0].action.starts_with("COLD OPEN — EXT. LUMINA — MARKET DISTRICT — DAY"),
            "first beat lost its scene: {:?}",
            chunks[0].action
        );
        assert!(
            chunks[2].action.contains("EXT. LUMINA — MARKET DISTRICT — CONTINUOUS"),
            "a heading between beats went to the wrong one: {:?}",
            chunks[2].action
        );
        assert!(
            chunks[3].action.contains("INT. NOA & LIOR'S APARTMENT — NIGHT"),
            "{:?}",
            chunks[3].action
        );
        // And the beat BEFORE a heading must not have swallowed it.
        assert!(!chunks[1].action.contains("ACT ONE"));
    }

    #[test]
    fn ordinary_prose_is_not_mistaken_for_a_shot_list() {
        // One stray clock in a sentence is not an author's shot list, and
        // must not switch off the length-based split.
        assert!(script_chunks("We start at 9:00 and finish when we finish.").is_none());
        assert!(script_chunks("No numbers here at all.").is_none());
        // A duration written as a range in prose, once, is still not a list.
        assert!(script_chunks("It runs 00:00-05:00 in total.").is_none());
    }

    #[test]
    fn a_dash_is_whichever_dash_the_writer_typed() {
        for dash in ["-", "–", "—"] {
            let script = format!("**00:00{dash}00:15** — One.\n\n**00:15{dash}00:30** — Two.");
            let chunks = script_chunks(&script).unwrap_or_else(|| panic!("dash {dash}"));
            assert_eq!(chunks.len(), 2);
            assert_eq!(chunks[0].seconds, 15);
        }
    }

    #[test]
    fn sentence_ends_keep_their_own_punctuation() {
        let pieces = sentences("One! Two? Three… Four.");
        assert_eq!(pieces.len(), 4);
        assert!(pieces[0].starts_with("One!"));
        assert!(pieces[1].trim().starts_with("Two?"));
        assert!(pieces[2].trim().starts_with("Three…"));
        assert_eq!(pieces.concat(), "One! Two? Three… Four.");
    }
}

#[cfg(test)]
mod episode_tests {
    use super::*;

    /// The real file, read from disk, cut the way the app cuts it.
    ///
    /// A unit test on a hand-trimmed excerpt proves the parser; this proves
    /// the SCRIPT — headings, rules, a preamble, an end-matter line carrying
    /// its own "5:00", and beats that are not all the same length.
    #[test]
    fn the_reported_episode_yields_its_own_twenty_chunks() {
        // Baked in rather than read at runtime, so the test cannot quietly
        // skip itself on a machine without the file.
        let script = include_str!("../../tests/fixtures/episode-chunks.md");
        let chunks = script_chunks(script).expect("the markers are found");

        // TWENTY-ONE, not twenty. The script's own heading says "20 chunks"
        // and its body contains 21 timestamped beats — they total exactly
        // 5:00, so the beats are right and the heading is off by one. What is
        // WRITTEN wins: silently dropping a beat to match a heading would
        // lose fifteen seconds of someone's episode.
        assert_eq!(chunks.len(), 21, "one shot per beat actually written");

        let total: u32 = chunks.iter().map(|c| c.seconds).sum();
        assert_eq!(total, 300, "five minutes exactly");

        // The three short beats keep their own length rather than being
        // flattened to fifteen.
        assert_eq!(chunks.iter().filter(|c| c.seconds == 10).count(), 3);

        // The closing "END OF EPISODE 1 — condensed to 5:00…" is a note to a
        // reader, not something to draw, and must not ride on the last shot.
        let last = &chunks.last().expect("last").action;
        assert!(last.contains("Reassign our star cadet"), "{last:?}");
        assert!(!last.contains("END OF"), "end matter reached a prompt: {last:?}");
        assert!(!last.contains("300 seconds"), "{last:?}");

        // Every beat carries its scene, and none carries a timestamp.
        assert!(chunks[0].action.contains("MARKET DISTRICT"));
        assert!(chunks.iter().all(|c| !c.action.contains("–")
            || !c.action.contains(":00–")));
        assert!(chunks.iter().all(|c| !c.action.is_empty()));
    }
}
