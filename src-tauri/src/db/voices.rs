//! The room's saved voices — who it has been told the names of.
//!
//! Naming a speaker in one recording saves that person's voiceprint here, and
//! every later recording is matched against this table (see
//! `diarize::recognize_groups`), so a returning speaker gets their name back
//! instead of a fresh "Speaker 2".
//!
//! ## Where this lives, and why it is not anywhere else
//!
//! A voiceprint is biometric data about a real person, so it stays inside the
//! room: this is a table in the SQLCipher-encrypted room file, on this device,
//! never sent to a model — local or cloud — and never written anywhere a room
//! is not. Deleting the room deletes the voices with it, because they were
//! only ever part of it.
//!
//! Per ROOM, not per app, deliberately. The room file is the encryption
//! boundary and the unit the user shares, backs up and deletes; a library that
//! outlived it would mean a person named in a private room could be recognised
//! — by name — inside an unrelated one, which is the opposite of what a room
//! is for. The cost is real and accepted: the same colleague has to be named
//! once in each room they appear in.

use super::*;
use crate::recording::diarize::{KnownVoice, VoicePrint};
use serde::Serialize;

/// How many enrollments may still move a saved centroid. Past this the voice
/// is settled and one odd recording — a cold, a bad headset, a noisy café —
/// cannot drag it away from everything it was built from. The same freeze
/// `SpeakerBook` applies to a live centroid, for the same reason.
const MAX_MERGE_WEIGHT: f32 = 20.0;

/// One saved voice, for the Settings list. The embedding is deliberately NOT
/// here: nothing outside this module and the diarizer has any business with
/// it, and it must not be one refactor away from crossing an IPC boundary.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SavedVoice {
    pub name: String,
    /// Seconds of speech behind the saved centroid — what the room is judging
    /// this person by, in a unit a human can weigh.
    pub seconds: f64,
    /// How many separate namings have been folded into it.
    pub takes: i64,
    /// How many voices the user has said are NOT this person.
    pub corrections: i64,
    pub updated_at: String,
}

fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

/// A stored embedding back into floats. A blob whose length is not a whole
/// number of f32s is corrupt, not a short vector — it is dropped rather than
/// silently truncated into a print that would be compared against real ones.
fn from_blob(b: &[u8]) -> Option<Vec<f32>> {
    if b.is_empty() || b.len() % 4 != 0 {
        return None;
    }
    Some(b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

/// Every voice this room can recognise, with the corrections the user has made
/// to each. Read once at the start of a recording (and again for a rebuild) —
/// the whole table is a handful of 192-float rows.
pub fn known_voices(conn: &Connection) -> Result<Vec<KnownVoice>, String> {
    let mut out: Vec<KnownVoice> = query_rows(
        conn,
        "SELECT name, emb FROM voice_ids ORDER BY name",
        [],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)),
    )?
    .into_iter()
    .filter_map(|(name, emb)| Some(KnownVoice { name, vec: from_blob(&emb)?, rejects: Vec::new() }))
    .collect();
    for (name, emb) in
        query_rows(conn, "SELECT name, emb FROM voice_rejects", [], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
        })?
    {
        let Some(vec) = from_blob(&emb) else { continue };
        if let Some(v) = out.iter_mut().find(|v| v.name == name) {
            v.rejects.push(vec);
        }
    }
    Ok(out)
}

/// The list behind Settings → saved voices.
pub fn saved_voices(conn: &Connection) -> Result<Vec<SavedVoice>, String> {
    query_rows(
        conn,
        "SELECT v.name, v.frames, v.takes, v.updated_at,
                (SELECT COUNT(*) FROM voice_rejects r WHERE r.name = v.name)
         FROM voice_ids v ORDER BY v.name",
        [],
        |r| {
            Ok(SavedVoice {
                name: r.get(0)?,
                // Voiced frames are the diarizer's 16 ms hop (see
                // `VoicePrint::voiced_frames`).
                seconds: (r.get::<_, i64>(1)? as f64) * 0.016,
                takes: r.get(2)?,
                updated_at: r.get(3)?,
                corrections: r.get(4)?,
            })
        },
    )
}

/// Remember `name`'s voice, or refine what is already remembered.
///
/// Refining is a weighted running mean frozen at [`MAX_MERGE_WEIGHT`], the
/// same shape `SpeakerBook` uses live: hearing someone in a tenth meeting
/// should sharpen the centroid, not restart it, and should never be able to
/// redefine a person on its own.
///
/// A stored centroid of a DIFFERENT width is from another embedding
/// generation (a room recorded before the neural model, or with it missing).
/// The two spaces share no geometry, so they cannot be averaged — the new
/// print replaces the old one outright, which is the only comparable thing to
/// have.
pub fn enroll_voice(conn: &Connection, name: &str, print: &VoicePrint) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || print.is_silent() {
        return Ok(());
    }
    let prior: Option<(Vec<u8>, i64, i64)> = query_opt(
        conn,
        "SELECT emb, frames, takes FROM voice_ids WHERE name = ?1",
        [name],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let (vec, frames, takes) = match prior {
        Some((emb, frames, takes)) => match from_blob(&emb).filter(|v| v.len() == print.vec.len()) {
            Some(old) => {
                let w = (takes as f32).min(MAX_MERGE_WEIGHT);
                let mut merged: Vec<f32> =
                    old.iter().zip(&print.vec).map(|(a, b)| (a * w + b) / (w + 1.0)).collect();
                let norm = merged.iter().map(|x| x * x).sum::<f32>().sqrt();
                if norm < 1e-6 {
                    return Ok(()); // the two prints cancel: keep what we had
                }
                merged.iter_mut().for_each(|x| *x /= norm);
                (merged, frames + print.voiced_frames as i64, takes + 1)
            }
            None => (print.vec.clone(), print.voiced_frames as i64, 1),
        },
        None => (print.vec.clone(), print.voiced_frames as i64, 1),
    };
    execute_one(
        conn,
        "INSERT INTO voice_ids(name, emb, frames, takes, updated_at)
         VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(name) DO UPDATE SET
           emb = excluded.emb, frames = excluded.frames,
           takes = excluded.takes, updated_at = excluded.updated_at",
        params![name, to_blob(&vec), frames, takes],
    )?;
    // A voice can stop being a counter-example: the user has just said this
    // print IS this person, which overrules an older "not them". Matched by
    // SIMILARITY, not by an identical blob — the centroid behind a correction
    // and the centroid behind the naming that overrules it come from different
    // recordings and are never byte-identical, so an exact match would leave
    // the denial standing and the user's newest word losing to their oldest.
    let stale: Vec<Vec<u8>> =
        query_rows(conn, "SELECT emb FROM voice_rejects WHERE name = ?1", [name], |r| r.get(0))?
            .into_iter()
            .filter(|emb: &Vec<u8>| {
                from_blob(emb).is_some_and(|r| {
                    let other = VoicePrint { vec: r, voiced_frames: print.voiced_frames };
                    crate::recording::diarize::raw_similarity(print, &other)
                        .is_some_and(|s| s >= crate::recording::diarize::KNOWN_SAME)
                })
            })
            .collect();
    for emb in stale {
        execute_one(
            conn,
            "DELETE FROM voice_rejects WHERE name = ?1 AND emb = ?2",
            params![name, emb],
        )?;
    }
    Ok(())
}

/// Record that `print` is NOT `name` — the user corrected a guess.
///
/// Without this a wrong match is wrong again in every future recording,
/// because the correction only ever taught the OTHER name. Stored against the
/// name that was wrong, which is the claim being denied.
pub fn reject_voice(conn: &Connection, name: &str, print: &VoicePrint) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || print.is_silent() {
        return Ok(());
    }
    execute_one(
        conn,
        "INSERT OR IGNORE INTO voice_rejects(name, emb) VALUES (?1, ?2)",
        params![name, to_blob(&print.vec)],
    )
}

/// Forget a voice completely — the centroid and every correction attached to
/// it. Transcripts already written keep the name they show: this is the room
/// forgetting how to recognise someone, not a retraction of what was said.
pub fn forget_voice(conn: &Connection, name: &str) -> Result<(), String> {
    in_transaction(conn, || {
        execute_one(conn, "DELETE FROM voice_rejects WHERE name = ?1", [name])?;
        execute_one(conn, "DELETE FROM voice_ids WHERE name = ?1", [name])
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn
    }

    fn print(vec: Vec<f32>, frames: usize) -> VoicePrint {
        let norm = vec.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
        VoicePrint { vec: vec.iter().map(|x| x / norm).collect(), voiced_frames: frames }
    }

    /// A NEURAL-width print — the only width `raw_similarity` compares, and so
    /// the only one the reject sweep can reason about.
    fn neural(dir: usize, tilt: f32, frames: usize) -> VoicePrint {
        let mut v = vec![0.0f32; 192];
        v[dir] = 1.0;
        v[191] = tilt;
        print(v, frames)
    }

    #[test]
    fn a_saved_voice_survives_the_blob_round_trip() {
        let c = conn();
        let p = print(vec![0.3, -0.4, 0.5, 0.7], 200);
        enroll_voice(&c, "Dana", &p).unwrap();
        let known = known_voices(&c).unwrap();
        assert_eq!(known.len(), 1);
        assert_eq!(known[0].name, "Dana");
        for (a, b) in known[0].vec.iter().zip(&p.vec) {
            assert!((a - b).abs() < 1e-6, "{a} != {b}");
        }
    }

    /// Hearing someone again must SHARPEN the saved voice, never restart it —
    /// otherwise the last recording is the only one that ever counted.
    #[test]
    fn re_enrolling_refines_the_centroid_instead_of_replacing_it() {
        let c = conn();
        let first = print(vec![1.0, 0.0, 0.0, 0.0], 200);
        let second = print(vec![0.0, 1.0, 0.0, 0.0], 200);
        enroll_voice(&c, "Dana", &first).unwrap();
        enroll_voice(&c, "Dana", &second).unwrap();
        let v = &known_voices(&c).unwrap()[0].vec;
        assert!(v[0] > 0.5 && v[1] > 0.5, "one take won outright: {v:?}");
        let saved = &saved_voices(&c).unwrap()[0];
        assert_eq!(saved.takes, 2);
        assert!((saved.seconds - 400.0 * 0.016).abs() < 1e-6, "{}", saved.seconds);
    }

    /// A print from another embedding generation cannot be averaged with this
    /// one — the spaces share no geometry. It replaces it.
    #[test]
    fn a_print_of_another_generation_replaces_rather_than_averages() {
        let c = conn();
        enroll_voice(&c, "Dana", &print(vec![1.0, 0.0], 200)).unwrap();
        let neural = print(vec![0.0, 0.0, 1.0, 0.0], 200);
        enroll_voice(&c, "Dana", &neural).unwrap();
        assert_eq!(known_voices(&c).unwrap()[0].vec.len(), 4);
    }

    #[test]
    fn a_correction_is_kept_against_the_name_it_denies_and_dies_with_it() {
        let c = conn();
        let dana = print(vec![1.0, 0.0, 0.0, 0.0], 200);
        let other = print(vec![0.9, 0.4, 0.0, 0.0], 200);
        enroll_voice(&c, "Dana", &dana).unwrap();
        reject_voice(&c, "Dana", &other).unwrap();
        assert_eq!(known_voices(&c).unwrap()[0].rejects.len(), 1);
        assert_eq!(saved_voices(&c).unwrap()[0].corrections, 1);

        // Naming that same voice Dana after all overrules the older denial —
        // and it has to work for the voice as heard in ANOTHER recording, not
        // only for a byte-identical repeat of the print that was denied.
        let c2 = conn();
        enroll_voice(&c2, "Dana", &neural(0, 0.0, 400)).unwrap();
        reject_voice(&c2, "Dana", &neural(5, 0.0, 400)).unwrap();
        enroll_voice(&c2, "Dana", &neural(5, 0.2, 400)).unwrap();
        assert!(
            known_voices(&c2).unwrap()[0].rejects.is_empty(),
            "the user's newest word lost to their oldest"
        );
        // A denial about somebody ELSE still stands.
        reject_voice(&c2, "Dana", &neural(9, 0.0, 400)).unwrap();
        enroll_voice(&c2, "Dana", &neural(5, 0.1, 400)).unwrap();
        assert_eq!(known_voices(&c2).unwrap()[0].rejects.len(), 1);

        reject_voice(&c, "Dana", &other).unwrap();
        forget_voice(&c, "Dana").unwrap();
        assert!(known_voices(&c).unwrap().is_empty());
        assert_eq!(
            query_one::<i64, _, _>(&c, "SELECT COUNT(*) FROM voice_rejects", [], |r| r.get(0))
                .unwrap(),
            0,
            "the corrections outlived the voice they were about"
        );
    }

    /// The background sweep's set: recordings nobody has read yet.
    ///
    /// Read through `json_extract`, not a LIKE on the blob — a note whose text
    /// happens to contain "readOf" must not make a recording look read, and a
    /// recording with nothing said in it is not worth a model call.
    #[test]
    fn the_unread_set_is_exact_about_what_has_been_read() {
        let c = conn();
        let add = |name: &str, meta: &str| {
            let f =
                crate::db::insert_file(&c, name, "audio/wav", b"", Some("(live recording)"), "recording")
                    .unwrap();
            crate::db::set_rec_meta(&c, &f.id, meta).unwrap();
            f.id
        };
        let seg = r#"{"id":"s","source":"sys","speaker":"Speaker 1","t0":0,"t1":10,"text":"hi","words":[]}"#;
        let unread = add("unread.wav", &format!(r#"{{"durationCs":10,"segments":[{seg}],"cuts":[]}}"#));
        let read = add(
            "read.wav",
            &format!(r#"{{"durationCs":10,"segments":[{seg}],"cuts":[],"readOf":{{"turns":1,"chars":2}}}}"#),
        );
        let silent = add("silent.wav", r#"{"durationCs":10,"segments":[],"cuts":[]}"#);
        // A note that merely MENTIONS the key must not count as having been read.
        let tricky = add(
            "tricky.wav",
            &format!(
                r#"{{"durationCs":10,"segments":[{seg}],"cuts":[],"notes":[{{"id":"n","t0":0,"kind":"point","text":"we discussed readOf today","by":"room"}}]}}"#
            ),
        );

        let missing = recordings_missing_read(&c, 10).unwrap();
        assert!(missing.contains(&unread));
        assert!(missing.contains(&tricky), "a LIKE on the blob would have skipped this one");
        assert!(!missing.contains(&read), "an already-read recording was queued again");
        assert!(!missing.contains(&silent), "a recording with nothing said was queued");

        // Trash takes it out of the sweep, like every other room listing.
        crate::db::trash_file(&c, &unread, crate::db::TrashActor::User).unwrap();
        assert!(!recordings_missing_read(&c, 10).unwrap().contains(&unread));
    }

    /// A corrupt blob must not become a short vector that gets compared
    /// against real prints — it is not a voice, so it is not offered as one.
    #[test]
    fn a_truncated_blob_is_dropped_not_truncated() {
        let c = conn();
        execute_one(
            &c,
            "INSERT INTO voice_ids(name, emb, frames, takes) VALUES ('Broken', ?1, 200, 1)",
            params![vec![1u8, 2, 3]],
        )
        .unwrap();
        assert!(known_voices(&c).unwrap().is_empty());
    }
}
