//! The room's cast and its shot lists — the data behind telling a story.
//!
//! Two tables and one idea: **a character is a picture, not a description**.
//! Everything else here is bookkeeping around that. Asking a model twice for
//! "a woman with red hair" gets two different women; handing it the same
//! portrait twice gets the same woman. So `face_file_id` is the column that
//! makes the feature work, and the prose fields exist to write good prompts
//! and to remind the user who these people are.
//!
//! Shots keep BOTH the still and the clip. A shot is made in two paid steps —
//! draw the frame, then animate out of it — and holding on to the still means
//! a re-animation (longer, different model, different motion) does not pay to
//! draw the frame again.

use super::*;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

/// Someone the story is about.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CastMember {
    pub id: String,
    pub name: String,
    /// What they look like. Goes into the prompt.
    pub description: String,
    /// Who they are — history, wants, voice. The user's own writing; it is
    /// theirs to keep whether or not any model ever reads it.
    pub story: String,
    /// Their portrait, as a room file. THE thing that holds a face together
    /// across shots. `None` means they exist but have no face yet.
    pub face_file_id: Option<String>,
    pub ord: i64,
}

/// One shot list. Never called a "script" on screen — this app already uses
/// that word for runnable Python.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryList {
    pub id: String,
    pub title: String,
    pub logline: String,
    /// The frame shape for the WHOLE list, e.g. `"16:9"`. One value rather
    /// than one per shot, because a shot's still becomes its clip's literal
    /// first frame: a still drawn 1:1 and pinned to a 16:9 clip is pinned to a
    /// frame of the wrong shape. Empty = let each model's own default stand.
    pub aspect_ratio: String,
    /// Output size for the stills and for the clips. Two fields because the
    /// two catalogues publish different vocabularies — `"1K"`/`"2K"` for
    /// pictures, `"720p"`/`"1080p"`/`"4K"` for video.
    pub still_resolution: String,
    pub clip_resolution: String,
    pub shot_count: i64,
    pub updated_at: String,
}

/// One shot: what happens, who is in it, and what has been made of it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryShot {
    pub id: String,
    pub list_id: String,
    pub ord: i64,
    pub action: String,
    /// Cast ids present in this shot. Their portraits become the references.
    pub cast_ids: Vec<String>,
    /// Clip length. `None` = let the model's own default decide, which is the
    /// honest state before a video model has been chosen: legal lengths differ
    /// per model, so a number picked now may be illegal later.
    pub seconds: Option<u32>,
    pub image_model: String,
    pub video_model: String,
    pub still_file_id: Option<String>,
    pub clip_file_id: Option<String>,
}

// ---------------------------------------------------------------- cast

pub fn list_cast(conn: &Connection) -> Result<Vec<CastMember>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, story, face_file_id, ord
               FROM story_cast ORDER BY ord, created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CastMember {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                story: r.get(3)?,
                face_file_id: r.get(4)?,
                ord: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn add_cast_member(
    conn: &Connection,
    name: &str,
    description: &str,
    story: &str,
) -> Result<CastMember, String> {
    let id = Uuid::new_v4().to_string();
    // Appended, not inserted at the top: a cast is read as an order of
    // importance, and a new minor character should not displace the lead.
    let ord: i64 = conn
        .query_row("SELECT COALESCE(MAX(ord), -1) + 1 FROM story_cast", [], |r| r.get(0))
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO story_cast (id, name, description, story, ord) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name.trim(), description.trim(), story.trim(), ord],
    )
    .map_err(|e| e.to_string())?;
    Ok(CastMember {
        id,
        name: name.trim().to_string(),
        description: description.trim().to_string(),
        story: story.trim().to_string(),
        face_file_id: None,
        ord,
    })
}

pub fn update_cast_member(
    conn: &Connection,
    id: &str,
    name: &str,
    description: &str,
    story: &str,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE story_cast
                SET name = ?2, description = ?3, story = ?4,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
              WHERE id = ?1",
            params![id, name.trim(), description.trim(), story.trim()],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That character is no longer in this room.".into());
    }
    Ok(())
}

/// Give someone a face — or take it away with `None`.
pub fn set_cast_face(conn: &Connection, id: &str, file_id: Option<&str>) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE story_cast
                SET face_file_id = ?2,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
              WHERE id = ?1",
            params![id, file_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That character is no longer in this room.".into());
    }
    Ok(())
}

pub fn remove_cast_member(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM story_cast WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The portraits for a set of cast ids, in the order asked for, skipping
/// anyone who has no face yet.
///
/// Order is the caller's, not the table's: a shot naming the villain first
/// means the villain is the first reference, and models do weight them.
pub fn cast_faces(conn: &Connection, ids: &[String]) -> Result<Vec<String>, String> {
    let mut faces = Vec::new();
    for id in ids {
        let face: Option<String> = conn
            .query_row(
                "SELECT face_file_id FROM story_cast WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        if let Some(file_id) = face {
            faces.push(file_id);
        }
    }
    Ok(faces)
}

// ---------------------------------------------------------- shot lists

pub fn list_story_lists(conn: &Connection) -> Result<Vec<StoryList>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT l.id, l.title, l.logline, l.updated_at,
                    (SELECT COUNT(*) FROM story_shots s WHERE s.list_id = l.id),
                    l.aspect_ratio, l.still_resolution, l.clip_resolution
               FROM story_lists l ORDER BY l.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(StoryList {
                id: r.get(0)?,
                title: r.get(1)?,
                logline: r.get(2)?,
                updated_at: r.get(3)?,
                shot_count: r.get(4)?,
                aspect_ratio: r.get(5)?,
                still_resolution: r.get(6)?,
                clip_resolution: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn create_story_list(conn: &Connection, title: &str, logline: &str) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let title = if title.trim().is_empty() { "Untitled" } else { title.trim() };
    conn.execute(
        "INSERT INTO story_lists (id, title, logline) VALUES (?1, ?2, ?3)",
        params![id, title, logline.trim()],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn update_story_list(conn: &Connection, id: &str, title: &str, logline: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE story_lists
            SET title = ?2, logline = ?3,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ?1",
        params![id, title.trim(), logline.trim()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Set the frame shape and the two output sizes for a whole list.
///
/// Separate from `update_story_list` because the title and logline are typed
/// on every keystroke while the shape is chosen from a menu of values the
/// provider published — folding them together would have every character typed
/// in the title re-write three columns that nobody touched.
pub fn set_story_shape(
    conn: &Connection,
    id: &str,
    aspect_ratio: &str,
    still_resolution: &str,
    clip_resolution: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE story_lists
            SET aspect_ratio = ?2, still_resolution = ?3, clip_resolution = ?4,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ?1",
        params![id, aspect_ratio.trim(), still_resolution.trim(), clip_resolution.trim()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_story_list(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM story_lists WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// --------------------------------------------------------------- shots

/// The shot immediately after this one in its list, if any.
///
/// One query rather than a list walk because the caller is a finishing JOB —
/// it holds the room lock for the moment this takes, and the continuity chain
/// needs exactly one answer: whose first frame does my end frame become.
/// Ordered the same way `list_shots` orders, so "next" here is "next" there.
pub fn next_shot_id(conn: &Connection, shot_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT s2.id
           FROM story_shots s1
           JOIN story_shots s2 ON s2.list_id = s1.list_id
          WHERE s1.id = ?1
            AND (s2.ord > s1.ord OR (s2.ord = s1.ord AND s2.created_at > s1.created_at))
          ORDER BY s2.ord, s2.created_at
          LIMIT 1",
        params![shot_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The shot immediately BEFORE this one: its id, its clip if it has one, and
/// its clip model. The three facts the chain gate decides on.
pub struct PrevShot {
    pub id: String,
    pub clip_file_id: Option<String>,
    pub video_model: String,
}

pub fn prev_shot(conn: &Connection, shot_id: &str) -> Result<Option<PrevShot>, String> {
    conn.query_row(
        "SELECT s2.id, s2.clip_file_id, s2.video_model
           FROM story_shots s1
           JOIN story_shots s2 ON s2.list_id = s1.list_id
          WHERE s1.id = ?1
            AND (s2.ord < s1.ord OR (s2.ord = s1.ord AND s2.created_at < s1.created_at))
          ORDER BY s2.ord DESC, s2.created_at DESC
          LIMIT 1",
        params![shot_id],
        |r| {
            Ok(PrevShot {
                id: r.get(0)?,
                clip_file_id: r.get(1)?,
                video_model: r.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn list_shots(conn: &Connection, list_id: &str) -> Result<Vec<StoryShot>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, list_id, ord, action, cast_ids, seconds,
                    image_model, video_model, still_file_id, clip_file_id
               FROM story_shots WHERE list_id = ?1 ORDER BY ord, created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![list_id], |r| {
            let cast_json: String = r.get(4)?;
            Ok(StoryShot {
                id: r.get(0)?,
                list_id: r.get(1)?,
                ord: r.get(2)?,
                action: r.get(3)?,
                // A row whose JSON cannot be read is an empty cast, not a
                // failed page: one corrupt field must not hide the shot list.
                cast_ids: serde_json::from_str(&cast_json).unwrap_or_default(),
                seconds: r.get::<_, Option<i64>>(5)?.map(|n| n.max(0) as u32),
                image_model: r.get(6)?,
                video_model: r.get(7)?,
                still_file_id: r.get(8)?,
                clip_file_id: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn add_shot(conn: &Connection, list_id: &str, action: &str) -> Result<StoryShot, String> {
    let id = Uuid::new_v4().to_string();
    let ord: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(ord), -1) + 1 FROM story_shots WHERE list_id = ?1",
            params![list_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO story_shots (id, list_id, ord, action) VALUES (?1, ?2, ?3, ?4)",
        params![id, list_id, ord, action.trim()],
    )
    .map_err(|e| e.to_string())?;
    Ok(StoryShot {
        id,
        list_id: list_id.to_string(),
        ord,
        action: action.trim().to_string(),
        cast_ids: Vec::new(),
        seconds: None,
        image_model: String::new(),
        video_model: String::new(),
        still_file_id: None,
        clip_file_id: None,
    })
}

/// Save one shot's editable fields. The two file ids are NOT here: they are
/// written only by a finished generation (`set_shot_result`), so a stale form
/// cannot erase a picture the user paid for.
pub fn update_shot(
    conn: &Connection,
    id: &str,
    action: &str,
    cast_ids: &[String],
    seconds: Option<u32>,
    image_model: &str,
    video_model: &str,
) -> Result<(), String> {
    let cast_json = serde_json::to_string(cast_ids).unwrap_or_else(|_| "[]".into());
    let changed = conn
        .execute(
            "UPDATE story_shots
                SET action = ?2, cast_ids = ?3, seconds = ?4,
                    image_model = ?5, video_model = ?6,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
              WHERE id = ?1",
            params![
                id,
                action.trim(),
                cast_json,
                seconds.map(|n| n as i64),
                image_model.trim(),
                video_model.trim()
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That shot is no longer in this list.".into());
    }
    Ok(())
}

/// Record what a finished generation produced.
pub fn set_shot_result(
    conn: &Connection,
    id: &str,
    still_file_id: Option<&str>,
    clip_file_id: Option<&str>,
) -> Result<(), String> {
    // COALESCE, so filing a clip does not wipe the still it was animated from.
    conn.execute(
        "UPDATE story_shots
            SET still_file_id = COALESCE(?2, still_file_id),
                clip_file_id  = COALESCE(?3, clip_file_id),
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ?1",
        params![id, still_file_id, clip_file_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_shot(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM story_shots WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Re-order a whole list in one go, from the ids in their new order.
pub fn reorder_shots(conn: &Connection, list_id: &str, ids: &[String]) -> Result<(), String> {
    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE story_shots SET ord = ?3 WHERE id = ?1 AND list_id = ?2",
            params![id, list_id, index as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(crate::db::schema::SCHEMA).expect("schema");
        conn
    }

    #[test]
    fn a_new_character_lands_at_the_end_of_the_cast() {
        let conn = room();
        let lead = add_cast_member(&conn, "Mira", "tall, grey coat", "lost her ship").unwrap();
        let extra = add_cast_member(&conn, "Doran", "broad, scarred", "").unwrap();
        assert_eq!(lead.ord, 0);
        assert_eq!(extra.ord, 1, "a new minor part must not displace the lead");
        let all = list_cast(&conn).unwrap();
        assert_eq!(all.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Mira", "Doran"]);
        // Nobody has a face until one is made or chosen.
        assert!(all.iter().all(|c| c.face_file_id.is_none()));
    }

    #[test]
    fn faces_come_back_in_the_order_the_shot_names_them() {
        // Not the cast's order: a shot naming the villain first means the
        // villain is the first reference, and models do weight the order.
        let conn = room();
        let a = add_cast_member(&conn, "Mira", "", "").unwrap();
        let b = add_cast_member(&conn, "Doran", "", "").unwrap();
        let c = add_cast_member(&conn, "Nobody", "", "").unwrap();
        for (member, file) in [(&a, "file-a"), (&b, "file-b")] {
            conn.execute(
                "INSERT INTO files (id, name, mime_type, original_bytes, source) VALUES (?1, ?1, 'image/png', x'00', 'generated')",
                params![file],
            )
            .unwrap();
            set_cast_face(&conn, &member.id, Some(file)).unwrap();
        }
        let faces = cast_faces(&conn, &[b.id.clone(), a.id.clone(), c.id.clone()]).unwrap();
        assert_eq!(faces, vec!["file-b", "file-a"], "asked order, faceless skipped");
    }

    #[test]
    fn filing_a_clip_does_not_wipe_the_still_it_came_from() {
        // The still is what a re-animation reuses. Losing it means paying to
        // draw the same frame again.
        let conn = room();
        let list = create_story_list(&conn, "Harbour", "").unwrap();
        let shot = add_shot(&conn, &list, "the boat leaves").unwrap();
        for file in ["still-1", "clip-1"] {
            conn.execute(
                "INSERT INTO files (id, name, mime_type, original_bytes, source) VALUES (?1, ?1, 'image/png', x'00', 'generated')",
                params![file],
            )
            .unwrap();
        }
        set_shot_result(&conn, &shot.id, Some("still-1"), None).unwrap();
        set_shot_result(&conn, &shot.id, None, Some("clip-1")).unwrap();
        let shots = list_shots(&conn, &list).unwrap();
        assert_eq!(shots[0].still_file_id.as_deref(), Some("still-1"));
        assert_eq!(shots[0].clip_file_id.as_deref(), Some("clip-1"));
    }

    #[test]
    fn a_shot_survives_a_cast_field_that_cannot_be_read() {
        // One corrupt row must not take the whole shot list down with it.
        let conn = room();
        let list = create_story_list(&conn, "Harbour", "").unwrap();
        let shot = add_shot(&conn, &list, "the boat leaves").unwrap();
        conn.execute(
            "UPDATE story_shots SET cast_ids = 'not json' WHERE id = ?1",
            params![shot.id],
        )
        .unwrap();
        let shots = list_shots(&conn, &list).unwrap();
        assert_eq!(shots.len(), 1);
        assert!(shots[0].cast_ids.is_empty());
        assert_eq!(shots[0].action, "the boat leaves");
    }

    #[test]
    fn deleting_a_list_takes_its_shots_with_it() {
        let conn = room();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let list = create_story_list(&conn, "Harbour", "one night").unwrap();
        add_shot(&conn, &list, "one").unwrap();
        add_shot(&conn, &list, "two").unwrap();
        assert_eq!(list_shots(&conn, &list).unwrap().len(), 2);
        delete_story_list(&conn, &list).unwrap();
        assert!(list_shots(&conn, &list).unwrap().is_empty());
    }

    #[test]
    fn reordering_writes_the_positions_it_was_given() {
        let conn = room();
        let list = create_story_list(&conn, "Harbour", "").unwrap();
        let one = add_shot(&conn, &list, "one").unwrap();
        let two = add_shot(&conn, &list, "two").unwrap();
        let three = add_shot(&conn, &list, "three").unwrap();
        reorder_shots(&conn, &list, &[three.id, one.id, two.id]).unwrap();
        let actions: Vec<String> = list_shots(&conn, &list)
            .unwrap()
            .into_iter()
            .map(|s| s.action)
            .collect();
        assert_eq!(actions, ["three", "one", "two"]);
    }
}
