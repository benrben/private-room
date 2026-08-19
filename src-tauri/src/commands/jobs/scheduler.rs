//! Wave 4a (M4): the workflow scheduler tick loop. Generation-pinned exactly
//! like `backfill.rs`: `open_room`/`create_room` bump `sched_generation` and
//! spawn one loop carrying the new stamp; a loop whose stamp is stale exits, so
//! at most one scheduler is ever live.
//!
//! Honest semantics: schedules fire ONLY while the app is open and the room is
//! unlocked. A run missed while the app was closed/locked performs AT MOST ONE
//! catch-up at unlock (never a backlog of N), and only if the schedule opted in.
//! Approval gates never apply — a scheduled workflow was pre-consented when the
//! user activated it, so a headless run never hangs on a 180s prompt.

use super::*;
use chrono::{DateTime, Datelike, Duration, Local, NaiveTime, TimeZone, Utc};
use std::sync::atomic::Ordering;

const TICK_SECS: u64 = 30;

/// Now as the UTC ISO8601 string the DB timestamps use (strftime %Y-%m-%dT…Z).
fn utc_now_string() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Convert a local run time to the stored UTC string.
fn to_utc_string(dt: DateTime<Local>) -> String {
    dt.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    let (h, m) = s.trim().split_once(':')?;
    NaiveTime::from_hms_opt(h.trim().parse().ok()?, m.trim().parse().ok()?, 0)
}

/// "D HH:MM" where D is 0=Sunday..6=Saturday.
fn parse_dow_hhmm(s: &str) -> Option<(u32, NaiveTime)> {
    let (d, rest) = s.trim().split_once(char::is_whitespace)?;
    let dow: u32 = d.trim().parse().ok()?;
    if dow > 6 {
        return None;
    }
    Some((dow, parse_hhmm(rest)?))
}

/// The next local run time strictly after `after`. Pure — unit-tested including
/// a DST-gap day (a spring-forward 02:00 that does not exist is skipped to the
/// next valid day). Returns None on a malformed param.
pub fn next_run_after(kind: &str, param: &str, after: DateTime<Local>) -> Option<DateTime<Local>> {
    match kind {
        "interval" => {
            let mins: i64 = param.trim().parse().ok().filter(|&m| m > 0)?;
            Some(after + Duration::minutes(mins))
        }
        "daily" => next_at_time(after, parse_hhmm(param)?, None),
        "weekly" => {
            let (dow, t) = parse_dow_hhmm(param)?;
            next_at_time(after, t, Some(dow))
        }
        _ => None,
    }
}

fn next_at_time(
    after: DateTime<Local>,
    t: NaiveTime,
    dow: Option<u32>,
) -> Option<DateTime<Local>> {
    let mut day = after.date_naive();
    for _ in 0..14 {
        let matches = dow.is_none_or(|d| day.weekday().num_days_from_sunday() == d);
        if matches {
            let naive = day.and_time(t);
            // DST: a nonexistent local time (spring-forward gap) yields None —
            // skip that day. An ambiguous time (fall-back) takes the earliest.
            if let Some(cand) = Local.from_local_datetime(&naive).earliest() {
                if cand > after {
                    return Some(cand);
                }
            }
        }
        day = day.succ_opt()?;
    }
    None
}

/// The next run time as a stored UTC string, computed from NOW.
pub(crate) fn next_run_from_now(kind: &str, param: &str) -> Option<String> {
    next_run_after(kind, param, Local::now()).map(to_utc_string)
}

/// Spawn the generation-pinned scheduler for the open room. Runs a one-shot
/// catch-up pass at unlock, then ticks every 30 s until the generation moves or
/// the room closes.
pub fn spawn_workflow_scheduler(app: &tauri::AppHandle) {
    use tauri::Manager;
    let generation = {
        let state = app.state::<AppState>();
        state.sched_generation.fetch_add(1, Ordering::SeqCst) + 1
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        catch_up_pass(&app, generation).await;
        // Everything already overdue has just been settled, so the loop's watch
        // starts here: a slot older than this one was not skipped by us.
        let mut watching_since = utc_now_string();
        loop {
            {
                let state = app.state::<AppState>();
                if state.sched_generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                if state.room.lock().unwrap().is_none() {
                    return;
                }
            }
            let looked_at = utc_now_string();
            tick(&app, generation, &watching_since).await;
            watching_since = looked_at;
            tokio::time::sleep(std::time::Duration::from_secs(TICK_SECS)).await;
        }
    });
}

/// Was this schedule's slot passed while the loop was already watching and did
/// NOT fire it? Then nothing was ever going to: at that moment the workflow was
/// a draft or the schedule was off, which is the same missed run "Catch up at
/// unlock" governs.
///
/// `watching_since` is the START of the PREVIOUS tick, deliberately — not a
/// grace period measured from now. A slot that fell after it (the machine was
/// asleep, the clock jumped, a tick was slow) was never looked at, so it is
/// merely LATE, and a late run still runs. A lateness threshold cannot tell
/// those apart and would silently drop a run the user was owed.
///
/// Both timestamps are the stored UTC strings; an unreadable one is not
/// evidence of a miss.
fn is_missed(next_run_at: Option<&str>, watching_since: &str) -> bool {
    let Some(due) = next_run_at.and_then(|s| DateTime::parse_from_rfc3339(s).ok()) else {
        return false;
    };
    let Ok(since) = DateTime::parse_from_rfc3339(watching_since) else {
        return false;
    };
    due < since
}

/// Read the currently-due schedules (under the lock, then drop it) and fire each.
async fn tick(app: &tauri::AppHandle, generation: u64, watching_since: &str) {
    use tauri::Manager;
    let now = utc_now_string();
    let due: Vec<(db::Schedule, db::Workflow)> = {
        let state = app.state::<AppState>();
        state
            .with_room(|room| db::due_schedules(&room.conn, &now))
            .unwrap_or_default()
    };
    for (sched, wf) in due {
        {
            let state = app.state::<AppState>();
            if state.sched_generation.load(Ordering::SeqCst) != generation {
                return;
            }
        }
        // A slot missed while the workflow was a draft is governed by "Catch up
        // at unlock" exactly as one missed while the app was closed is —
        // otherwise activating a workflow starts a full pass within 30 s.
        if !sched.catch_up && is_missed(sched.next_run_at.as_deref(), watching_since) {
            skip_missed_run(app, &sched);
            continue;
        }
        fire(app, &sched, &wf, "schedule").await;
    }
}

/// Skip a missed run: advance `next_run_at` past now without firing, so the
/// schedule resumes at its next slot instead of running late.
fn skip_missed_run(app: &tauri::AppHandle, sched: &db::Schedule) {
    use tauri::Manager;
    let next = next_run_from_now(&sched.kind, &sched.param);
    let state = app.state::<AppState>();
    let _ = state
        .with_room(|room| db::set_schedule_next_run(&room.conn, &sched.id, next.as_deref()));
}

/// The one-shot catch-up at unlock: for every enabled schedule of an active
/// workflow whose next run is already past, fire AT MOST ONE catch-up (if the
/// schedule opted in), then advance `next_run_at` past now — never a backlog.
async fn catch_up_pass(app: &tauri::AppHandle, generation: u64) {
    use tauri::Manager;
    let now = utc_now_string();
    let overdue: Vec<(db::Schedule, db::Workflow)> = {
        let state = app.state::<AppState>();
        state
            .with_room(|room| db::due_schedules(&room.conn, &now))
            .unwrap_or_default()
    };
    for (sched, wf) in overdue {
        {
            let state = app.state::<AppState>();
            if state.sched_generation.load(Ordering::SeqCst) != generation {
                return;
            }
        }
        if sched.catch_up {
            fire(app, &sched, &wf, "catchup").await;
        } else {
            skip_missed_run(app, &sched);
        }
    }
}

/// Start one scheduled run and advance the schedule's next run.
async fn fire(app: &tauri::AppHandle, sched: &db::Schedule, wf: &db::Workflow, trigger: &str) {
    use tauri::Manager;
    let Some(window) = crate::main_window(app) else { return };
    let state = app.state::<AppState>();
    let next = next_run_from_now(&sched.kind, &sched.param);
    match start_workflow_run(&window, &state, &wf.id, trigger, None, &std::collections::HashSet::new()).await {
        // An empty id means the run was skipped (already in flight, or the queue
        // is full) — advance the schedule without recording a phantom run.
        Ok(job_id) if job_id.is_empty() => {
            let _ = state.with_room(|room| {
                db::set_schedule_next_run(&room.conn, &sched.id, next.as_deref())
            });
        }
        Ok(job_id) => {
            let _ = state.with_room(|room| {
                db::mark_schedule_run(&room.conn, &sched.id, &job_id, next.as_deref())
            });
        }
        Err(_) => {
            // A failed start (e.g. a broken def) still advances the schedule so
            // the loop doesn't hammer it every tick.
            let _ = state.with_room(|room| {
                db::set_schedule_next_run(&room.conn, &sched.id, next.as_deref())
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Local, TimeZone};

    #[test]
    fn interval_adds_minutes() {
        let after = Local.with_ymd_and_hms(2026, 7, 18, 10, 0, 0).unwrap();
        let next = next_run_after("interval", "30", after).unwrap();
        assert_eq!(next, Local.with_ymd_and_hms(2026, 7, 18, 10, 30, 0).unwrap());
        // A bad/zero interval is rejected.
        assert!(next_run_after("interval", "0", after).is_none());
        assert!(next_run_after("interval", "abc", after).is_none());
    }

    #[test]
    fn daily_picks_today_then_tomorrow() {
        // Before 08:00 today → today 08:00.
        let after = Local.with_ymd_and_hms(2026, 7, 18, 6, 0, 0).unwrap();
        let next = next_run_after("daily", "08:00", after).unwrap();
        assert_eq!(next, Local.with_ymd_and_hms(2026, 7, 18, 8, 0, 0).unwrap());
        // After 08:00 today → tomorrow 08:00.
        let after = Local.with_ymd_and_hms(2026, 7, 18, 9, 0, 0).unwrap();
        let next = next_run_after("daily", "08:00", after).unwrap();
        assert_eq!(next, Local.with_ymd_and_hms(2026, 7, 19, 8, 0, 0).unwrap());
    }

    #[test]
    fn weekly_finds_the_next_matching_weekday() {
        // 2026-07-18 is a Saturday (num_days_from_sunday = 6). Ask for Friday (5).
        let after = Local.with_ymd_and_hms(2026, 7, 18, 12, 0, 0).unwrap();
        let next = next_run_after("weekly", "5 16:00", after).unwrap();
        // Next Friday is 2026-07-24.
        assert_eq!(next, Local.with_ymd_and_hms(2026, 7, 24, 16, 0, 0).unwrap());
        assert_eq!(next.weekday().num_days_from_sunday(), 5);
    }

    #[test]
    fn same_weekday_later_time_is_today_earlier_is_next_week() {
        // Saturday 12:00, ask Saturday (6) 16:00 → today.
        let after = Local.with_ymd_and_hms(2026, 7, 18, 12, 0, 0).unwrap();
        let next = next_run_after("weekly", "6 16:00", after).unwrap();
        assert_eq!(next, Local.with_ymd_and_hms(2026, 7, 18, 16, 0, 0).unwrap());
        // Saturday 18:00, ask Saturday 16:00 → next Saturday.
        let after = Local.with_ymd_and_hms(2026, 7, 18, 18, 0, 0).unwrap();
        let next = next_run_after("weekly", "6 16:00", after).unwrap();
        assert_eq!(next, Local.with_ymd_and_hms(2026, 7, 25, 16, 0, 0).unwrap());
    }

    #[test]
    fn dst_gap_day_still_resolves() {
        // On a US spring-forward day (2026-03-08, clocks jump 02:00→03:00),
        // a 02:30 daily target doesn't exist locally — the resolver must still
        // return SOME future run (either that day at a valid instant, or the
        // next day), never panic or return None on a well-formed schedule.
        let after = Local.with_ymd_and_hms(2026, 3, 7, 12, 0, 0).unwrap();
        let next = next_run_after("daily", "02:30", after);
        assert!(next.is_some(), "a valid daily schedule must always resolve");
        assert!(next.unwrap() > after);
    }

    #[test]
    fn a_slot_missed_while_the_workflow_was_a_draft_counts_as_missed() {
        // The repro: daily 08:00, left in draft across it, activated at 10:00.
        // The loop was watching at 09:59:30 and did not fire it, so nothing was
        // ever going to.
        assert!(is_missed(Some("2026-08-18T08:00:00Z"), "2026-08-18T09:59:30Z"));
        // One second before the previous look is still on the missed side.
        assert!(is_missed(Some("2026-08-18T09:59:29Z"), "2026-08-18T09:59:30Z"));
    }

    #[test]
    fn a_slot_the_loop_never_looked_at_is_late_not_missed() {
        // The machine slept from 07:30 to 11:00 with the room unlocked: the
        // 08:00 slot fell while nothing was watching, so it is owed a late run.
        // A lateness threshold would have called it missed and dropped it.
        assert!(!is_missed(Some("2026-08-18T08:00:00Z"), "2026-08-18T07:30:00Z"));
        // The boundary: due exactly at the previous look — that tick would have
        // fired it, so err towards running.
        assert!(!is_missed(Some("2026-08-18T09:59:30Z"), "2026-08-18T09:59:30Z"));
        // An ordinary live schedule, half a tick behind.
        assert!(!is_missed(Some("2026-08-18T09:59:45Z"), "2026-08-18T09:59:30Z"));
        // A future slot is never a miss (due_schedules wouldn't return it).
        assert!(!is_missed(Some("2026-08-18T11:00:00Z"), "2026-08-18T09:59:30Z"));
        // Nothing to judge, or an unreadable stamp: not evidence of a miss.
        assert!(!is_missed(None, "2026-08-18T09:59:30Z"));
        assert!(!is_missed(Some("whenever"), "2026-08-18T09:59:30Z"));
        assert!(!is_missed(Some("2026-08-18T08:00:00Z"), "whenever"));
    }

    #[test]
    fn unknown_kind_is_none() {
        let after = Local.with_ymd_and_hms(2026, 7, 18, 10, 0, 0).unwrap();
        assert!(next_run_after("monthly", "1", after).is_none());
    }
}
