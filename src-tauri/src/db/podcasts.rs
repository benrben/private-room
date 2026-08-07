use super::*;
use serde::{Deserialize, Serialize};

/// One speaker in a podcast, and the voice that reads them.
///
/// The cast is written once from the script the model produced, then belongs to
/// the user: picking a voice, renaming a host, nudging rate or pitch. That is
/// why it is stored rather than derived — deriving it again on every open would
/// throw away every choice the moment anything upstream changed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PodcastHost {
    /// The speaker name as it appears in the turns. This is the JOIN KEY
    /// between a line and a voice, which is why the script's own normalization
    /// matters so much: "Ada" in turn 1 and "Ada Lovelace" in turn 7 would be
    /// two hosts, and one of them would have no voice.
    pub name: String,
    /// A neural voice id from the live catalog (`tts.list_neural_voices`).
    /// Empty = the sidecar's product default, the same meaning it has in the
    /// Settings picker.
    #[serde(default)]
    pub voice: String,
    /// Edge prosody strings, e.g. "+22%" and "-2Hz". Empty = the service
    /// default for that voice. Per HOST, because two hosts reading at the
    /// identical rate is most of what makes a two-voice script still sound
    /// like one narrator.
    #[serde(default)]
    pub rate: String,
    #[serde(default)]
    pub pitch: String,
}

/// One line of the episode.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PodcastTurn {
    pub speaker: String,
    pub line: String,
}

/// A podcast script as data: what was written, who says it, and how it sounds.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Podcast {
    /// The SCRIPT page's file id — the row's identity.
    pub file_id: String,
    pub title: String,
    pub turns: Vec<PodcastTurn>,
    pub cast: Vec<PodcastHost>,
    /// The rendered episode, when one has been made. An ordinary room file.
    pub audio_file_id: Option<String>,
    pub created_at: String,
}

/// Decoration a model wraps a speaker label in: `**Ada:**`, `[Ada]:`, `> Ada:`.
const DECOR: &[char] = &['*', '_', '[', ']', '#', '>', '"', '\'', '“', '”', ' ', '\t'];

/// Drop a leading `Speaker:` label from a line.
///
/// THE BUG THIS EXISTS FOR. Models write dialogue the way dialogue looks in
/// their training data — `{"speaker": "Ada", "line": "Ada: welcome in"}` — so
/// the name ends up stated twice: once as the field, once inside the text. The
/// field is the one everything joins on, and the copy inside the text is what
/// gets handed to the voice service. The result is a host who reads their own
/// name aloud before every line ("Ada: welcome in"), a page that prints the
/// name in the margin AND again in the sentence, and a transcript that reads
/// `Ada: Ada: welcome in`. One strip at the boundary fixes all three, because
/// all three read this one string.
///
/// WHY IT ONLY EVER STRIPS A NAME IT ALREADY KNOWS. The prefix must match this
/// turn's own speaker exactly (ignoring case and any decoration), or that
/// speaker's first word so `Ada Lovelace` still matches `Ada:`. A rule like
/// "cut at the first colon" would eat the start of every ordinary sentence
/// that happens to contain one — *"Here's the thing: it works"* — which is a
/// far worse failure than the one being fixed, and a silent one.
///
/// A line that is ONLY a label strips to empty; callers decide what that
/// means (ingest drops the turn, the read path keeps the original rather than
/// handing empty text to a speech service).
pub fn strip_speaker_label(line: &str, speaker: &str) -> String {
    let mut text = line.trim_start();
    // Bounded, not `while`: `Ada: Ada: hi` is real (a re-generated script fed
    // its own previous output), but an unbounded loop on adversarial input is
    // not worth the two lines it saves.
    for _ in 0..2 {
        match label_len(text, speaker) {
            Some(n) => text = text[n..].trim_start_matches(DECOR),
            None => break,
        }
    }
    text.to_string()
}

/// Byte length of a leading `Name:` run, or `None` if the line doesn't open
/// with this speaker's own name.
fn label_len(text: &str, speaker: &str) -> Option<usize> {
    /// A speaker label is short. Past this, a colon belongs to prose.
    const MAX_LABEL: usize = 48;
    let name = speaker.trim();
    if name.is_empty() {
        return None;
    }
    let colon = text
        .char_indices()
        .take_while(|(i, _)| *i <= MAX_LABEL)
        .find(|(_, c)| *c == ':')?
        .0;
    let prefix = text[..colon].trim_matches(DECOR);
    if prefix.is_empty() {
        return None;
    }
    let first_word = name.split_whitespace().next().unwrap_or(name);
    (prefix.eq_ignore_ascii_case(name) || prefix.eq_ignore_ascii_case(first_word))
        .then_some(colon + 1)
}

/// Strip every turn's own speaker label, in place.
///
/// A line that is nothing BUT a label keeps its original text: it is degenerate
/// either way, and empty text is the one thing the speech service cannot be
/// handed.
pub fn strip_speaker_labels(turns: &mut [PodcastTurn]) {
    for t in turns.iter_mut() {
        let cleaned = strip_speaker_label(&t.line, &t.speaker);
        if !cleaned.is_empty() {
            t.line = cleaned;
        }
    }
}

fn podcast_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Podcast> {
    let turns: String = r.get(2)?;
    let cast: String = r.get(3)?;
    // A row whose JSON will not parse is treated as an EMPTY script rather
    // than as a failed read. The page is still in the library and still
    // opens; what is lost is the ability to record it, and the panel says
    // so. Failing the whole query would take the working half down too.
    let mut turns: Vec<PodcastTurn> = serde_json::from_str(&turns).unwrap_or_default();
    // On the way OUT as well as in, so scripts written before the label strip
    // existed are fixed where they are read instead of needing a migration —
    // and so a re-record of an old episode stops speaking the names.
    strip_speaker_labels(&mut turns);
    Ok(Podcast {
        file_id: r.get(0)?,
        title: r.get(1)?,
        turns,
        cast: serde_json::from_str(&cast).unwrap_or_default(),
        audio_file_id: r.get(4)?,
        created_at: r.get(5)?,
    })
}

/// The podcast belonging to a script page, if it has one.
///
/// `None` covers two real cases the caller must not conflate with an error: a
/// file that is not a podcast at all, and a podcast PAGE generated before this
/// table existed (or by the old HTML-authoring path), which has no turns to
/// record.
pub fn get_podcast(conn: &Connection, file_id: &str) -> Option<Podcast> {
    conn.query_row(
        "SELECT file_id, title, turns, cast_json, audio_file_id, created_at
         FROM podcasts WHERE file_id = ?1",
        [file_id],
        podcast_row,
    )
    .ok()
}

/// Store (or replace) a script's structure. Called by the studio's `after_save`
/// hook with the model's own JSON already parsed.
pub fn save_podcast(
    conn: &Connection,
    file_id: &str,
    title: &str,
    turns: &[PodcastTurn],
    cast: &[PodcastHost],
) -> Result<(), String> {
    let turns = serde_json::to_string(turns).map_err(|e| e.to_string())?;
    let cast = serde_json::to_string(cast).map_err(|e| e.to_string())?;
    execute_one(
        conn,
        "INSERT INTO podcasts(file_id, title, turns, cast_json, audio_file_id)
         VALUES (?1, ?2, ?3, ?4, NULL)
         ON CONFLICT(file_id) DO UPDATE SET title = ?2, turns = ?3, cast_json = ?4",
        params![file_id, title, turns, cast],
    )
}

/// Replace the cast — the user re-casting a host, or changing a voice.
///
/// Deliberately does NOT clear `audio_file_id`. The previously rendered episode
/// is still a real file the user may be listening to; silently unlinking it
/// would make it look deleted. The UI compares the two and offers a re-record,
/// which is a choice rather than a surprise.
pub fn set_podcast_cast(
    conn: &Connection,
    file_id: &str,
    cast: &[PodcastHost],
) -> Result<(), String> {
    let cast = serde_json::to_string(cast).map_err(|e| e.to_string())?;
    execute_one(
        conn,
        "UPDATE podcasts SET cast_json = ?2 WHERE file_id = ?1",
        params![file_id, cast],
    )
}

/// Point a script at the episode that was rendered from it.
pub fn set_podcast_audio(
    conn: &Connection,
    file_id: &str,
    audio_file_id: &str,
) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE podcasts SET audio_file_id = ?2 WHERE file_id = ?1",
        params![file_id, audio_file_id],
    )
}

/// Build the opening cast from a script's turns.
///
/// TWO THINGS THIS FIXES, both of which break voices rather than looking wrong:
///
///   * SPEAKER DRIFT. Names are matched case- and whitespace-insensitively, so
///     "ada", "Ada" and "Ada " are one host with one voice, not three.
///   * VOICE COLLISION. Two hosts reading in the same voice is not a
///     two-voice podcast, so distinct voices are handed out in order and a
///     voice is never reused while an unused one remains.
///
/// `available` is the catalog to draw from, best-first — the caller decides
/// what "best" means (multilingual for a non-English script, alternating
/// genders when the catalog reports them). An empty catalog yields hosts with
/// empty voice ids, which means "the product default" everywhere else, so an
/// offline first-open still produces a usable cast the user can edit.
pub fn cast_from_turns(turns: &[PodcastTurn], available: &[String]) -> Vec<PodcastHost> {
    let mut hosts: Vec<PodcastHost> = Vec::new();
    for t in turns {
        let name = t.speaker.trim();
        if name.is_empty() {
            continue;
        }
        if hosts.iter().any(|h| h.name.eq_ignore_ascii_case(name)) {
            continue;
        }
        let voice = available.get(hosts.len()).cloned().unwrap_or_default();
        hosts.push(PodcastHost {
            name: name.to_string(),
            voice,
            rate: String::new(),
            pitch: String::new(),
        });
    }
    hosts
}

/// Fold every turn's speaker onto the cast's spelling of that name.
///
/// Called on the way IN, so the stored turns and the stored cast agree
/// letter-for-letter. Everything downstream — the voice lookup, the rendered
/// transcript's "Name:" labels, the panel's per-host preview — joins on this
/// string, and a mismatch is not a cosmetic difference: it is a line that gets
/// the default voice while the panel shows it assigned to someone else.
pub fn normalize_turn_speakers(turns: &mut [PodcastTurn], cast: &[PodcastHost]) {
    for t in turns.iter_mut() {
        if let Some(host) = cast
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(t.speaker.trim()))
        {
            t.speaker = host.name.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(speaker: &str, line: &str) -> PodcastTurn {
        PodcastTurn {
            speaker: speaker.into(),
            line: line.into(),
        }
    }

    #[test]
    fn a_cast_has_one_host_per_speaker_however_it_was_spelled() {
        let turns = vec![
            turn("Ada", "Welcome in."),
            turn("Bo", "Glad to be here."),
            turn("ada ", "Let's start."),
        ];
        let cast = cast_from_turns(&turns, &["v1".into(), "v2".into(), "v3".into()]);
        assert_eq!(cast.len(), 2, "case and spacing do not make a third host");
        assert_eq!(cast[0].name, "Ada");
        assert_eq!(cast[1].name, "Bo");
    }

    #[test]
    fn no_two_hosts_share_a_voice() {
        // Two hosts in one voice is not a two-voice podcast — it is one
        // narrator reading a dialogue, which is the thing this feature exists
        // to stop being.
        let turns = vec![turn("Ada", "a"), turn("Bo", "b"), turn("Cy", "c")];
        let cast = cast_from_turns(&turns, &["v1".into(), "v2".into(), "v3".into()]);
        let voices: Vec<&str> = cast.iter().map(|h| h.voice.as_str()).collect();
        assert_eq!(voices, vec!["v1", "v2", "v3"]);
    }

    #[test]
    fn an_empty_catalog_still_produces_an_editable_cast() {
        // Offline on first open: the hosts exist with the product-default
        // voice, so the panel has rows the user can change rather than nothing.
        let turns = vec![turn("Ada", "a"), turn("Bo", "b")];
        let cast = cast_from_turns(&turns, &[]);
        assert_eq!(cast.len(), 2);
        assert!(cast.iter().all(|h| h.voice.is_empty()));
    }

    #[test]
    fn turn_speakers_are_folded_onto_the_casts_spelling() {
        // The join key. Left unfolded, "ada" gets the default voice while the
        // panel shows Ada assigned to a chosen one.
        let mut turns = vec![turn("ada", "a"), turn("BO", "b"), turn("Ada", "c")];
        let cast = cast_from_turns(&turns, &["v1".into(), "v2".into()]);
        normalize_turn_speakers(&mut turns, &cast);
        assert_eq!(
            turns.iter().map(|t| t.speaker.as_str()).collect::<Vec<_>>(),
            vec!["ada", "BO", "ada"],
            "every line uses the cast's own spelling of its speaker",
        );
    }

    #[test]
    fn a_script_round_trips_through_the_room() {
        let conn = open_in_memory_schema();
        let file = insert_file(&conn, "ep.html", "text/html", b"<p>x</p>", None, "generated")
            .unwrap();
        let turns = vec![turn("Ada", "Welcome."), turn("Bo", "Hello.")];
        let cast = cast_from_turns(&turns, &["v1".into(), "v2".into()]);
        save_podcast(&conn, &file.id, "Episode 1", &turns, &cast).unwrap();

        let got = get_podcast(&conn, &file.id).unwrap();
        assert_eq!(got.title, "Episode 1");
        assert_eq!(got.turns, turns);
        assert_eq!(got.cast, cast);
        assert!(got.audio_file_id.is_none(), "nothing recorded yet");

        // Re-casting keeps the rendered audio linked — the old episode is a
        // real file the user may still be playing.
        let audio =
            insert_file(&conn, "ep.m4a", "audio/mp4", b"\0", None, "generated").unwrap();
        set_podcast_audio(&conn, &file.id, &audio.id).unwrap();
        let mut recast = cast.clone();
        recast[0].voice = "other".into();
        set_podcast_cast(&conn, &file.id, &recast).unwrap();
        let got = get_podcast(&conn, &file.id).unwrap();
        assert_eq!(got.cast[0].voice, "other");
        assert_eq!(got.audio_file_id.as_deref(), Some(audio.id.as_str()));
    }

    #[test]
    fn a_host_does_not_read_their_own_name_aloud() {
        // The reported bug: the model states the name as the field AND again
        // inside the text, so the voice service is handed "Alex: welcome in".
        assert_eq!(strip_speaker_label("Alex: welcome in", "Alex"), "welcome in");
        assert_eq!(strip_speaker_label("ALEX:  welcome in", "Alex"), "welcome in");
        assert_eq!(strip_speaker_label("**Jordan:** sure", "Jordan"), "sure");
        assert_eq!(strip_speaker_label("[Jordan]: sure", "Jordan"), "sure");
        // `Ada Lovelace` labelled as `Ada:` — the first word still matches.
        assert_eq!(strip_speaker_label("Ada: hello", "Ada Lovelace"), "hello");
        // Doubled, which a re-generated script really does produce.
        assert_eq!(strip_speaker_label("Alex: Alex: hi", "Alex"), "hi");
        // Already clean: unchanged, so the strip is safe to run on every read.
        assert_eq!(strip_speaker_label("welcome in", "Alex"), "welcome in");
    }

    #[test]
    fn an_ordinary_sentence_containing_a_colon_survives() {
        // THE RISK THIS FIX INTRODUCES. "cut at the first colon" would eat the
        // start of real sentences — a worse bug than the one being fixed, and a
        // silent one. Only a prefix that IS this speaker's name may go.
        assert_eq!(
            strip_speaker_label("Here's the thing: it works", "Alex"),
            "Here's the thing: it works",
        );
        // Another host's name is left alone — that is a mislabelled turn, and
        // guessing at it would rewrite what the script says.
        assert_eq!(strip_speaker_label("Jordan: no", "Alex"), "Jordan: no");
        // A colon far into prose is prose, not a label.
        let long = "One thing I keep coming back to about all of this is: it works";
        assert_eq!(strip_speaker_label(long, "Alex"), long);
        // A line that is ONLY a label strips to empty; callers decide.
        assert_eq!(strip_speaker_label("Alex:", "Alex"), "");
    }

    #[test]
    fn a_script_stored_before_the_strip_existed_is_fixed_when_it_is_read() {
        // No migration: the rows already in people's rooms are cleaned where
        // they are read, so re-recording an old episode stops speaking names.
        let conn = open_in_memory_schema();
        let file =
            insert_file(&conn, "ep.html", "text/html", b"<p>x</p>", None, "generated").unwrap();
        let dirty = vec![
            turn("Alex", "Alex: welcome in"),
            turn("Jordan", "Jordan: glad to be here"),
        ];
        let cast = cast_from_turns(&dirty, &["v1".into(), "v2".into()]);
        save_podcast(&conn, &file.id, "Episode 1", &dirty, &cast).unwrap();

        let got = get_podcast(&conn, &file.id).unwrap();
        assert_eq!(
            got.turns.iter().map(|t| t.line.as_str()).collect::<Vec<_>>(),
            vec!["welcome in", "glad to be here"],
        );
        // The speakers themselves are untouched — they are the join key.
        assert_eq!(got.turns[0].speaker, "Alex");
    }

    #[test]
    fn a_file_that_is_not_a_podcast_reads_as_none_not_an_error() {
        let conn = open_in_memory_schema();
        assert!(get_podcast(&conn, "no-such-file").is_none());
    }

    #[test]
    fn trashing_the_script_for_good_takes_its_podcast_row() {
        // ON DELETE CASCADE — a destroyed script must not leave a row pointing
        // at a file id that no longer resolves.
        let conn = open_in_memory_schema();
        let file =
            insert_file(&conn, "ep.html", "text/html", b"<p>x</p>", None, "generated").unwrap();
        save_podcast(&conn, &file.id, "t", &[turn("A", "x")], &[]).unwrap();
        delete_file(&conn, &file.id).unwrap();
        assert!(get_podcast(&conn, &file.id).is_none());
    }
}
