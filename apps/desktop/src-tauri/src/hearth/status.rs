// The first line of the tray menu, "Server ✓  Worker ✓  Jarvis ✓" (D53). Every 30 s the app asks
// Hearth's server if it's up (GET /api/health). Once this PC is connected, it also asks how the
// worker and Jarvis are (system.status, which the device token may read), but only every few
// minutes: Hearth records each of those calls as the PC's activity. The tray icon shows a warning
// when something is wrong, and a notification says so if the server stops answering.

use super::client::healthy;
use super::{link, toast, window};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const EVERY: Duration = Duration::from_secs(30);
/// How often system.status is asked; sooner when the server comes back, or after a restart.
const ASK_EVERY: Duration = Duration::from_secs(5 * 60);
/// Worker and Jarvis report in every minute; older than this and they've stopped.
const STALE_MINUTES: i64 = 5;
/// Checks in a row the server must miss before a notification says it's down.
const MISSES_BEFORE_TELLING: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    Ok,
    Trouble,
    Down,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub address_set: bool,
    pub server: Mark,
    pub worker: Mark,
    pub jarvis: Mark,
    pub jarvis_paused: bool,
    /// Something else Hearth watches (a sync, the disk, backups) is failing.
    pub other_failing: bool,
}

impl Status {
    fn unknown(server: Mark) -> Self {
        Status {
            address_set: true,
            server,
            worker: Mark::Unknown,
            jarvis: Mark::Unknown,
            jarvis_paused: false,
            other_failing: false,
        }
    }

    /// The tray's first line.
    pub fn line(&self) -> String {
        if !self.address_set {
            return "Set Nook's address in voice settings".into();
        }
        match self.server {
            Mark::Down => return "Server ✗  Nook isn't running".into(),
            Mark::Ok if self.worker == Mark::Unknown && self.jarvis == Mark::Unknown => {
                return "Server ✓  Connect this PC to see more".into()
            }
            _ => {}
        }
        let sign = |m: Mark| match m {
            Mark::Ok => "✓",
            Mark::Trouble => "!",
            Mark::Down => "✗",
            Mark::Unknown => "?",
        };
        let jarvis = if self.jarvis_paused && self.jarvis == Mark::Ok {
            "Pip paused".to_string()
        } else {
            format!("Pip {}", sign(self.jarvis))
        };
        format!(
            "Server {}  Worker {}  {jarvis}",
            sign(self.server),
            sign(self.worker)
        )
    }

    /// Whether the tray icon should show a warning.
    pub fn trouble(&self) -> bool {
        !self.address_set
            || self.other_failing
            || [self.server, self.worker, self.jarvis]
                .iter()
                .any(|m| matches!(m, Mark::Trouble | Mark::Down))
    }
}

/// Reads system.status's answer.
pub fn from_report(report: &Value, now: DateTime<Utc>) -> Status {
    let components = report["components"].as_object();
    let mark = |name: &str| -> Mark {
        let Some(c) = components.and_then(|m| m.get(name)) else {
            return Mark::Unknown;
        };
        let fresh = c["at"]
            .as_str()
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .is_some_and(|at| (now - at.with_timezone(&Utc)).num_minutes() < STALE_MINUTES);
        match c["status"].as_str() {
            Some("ok") if fresh => Mark::Ok,
            Some("degraded") => Mark::Trouble,
            Some(_) => Mark::Down,
            None => Mark::Unknown,
        }
    };
    let other_failing = components.is_some_and(|m| {
        m.iter()
            .any(|(name, c)| name != "worker" && name != "jarvis" && c["status"] == "failing")
    });
    Status {
        address_set: true,
        server: Mark::Ok,
        worker: mark("worker"),
        jarvis: mark("jarvis"),
        jarvis_paused: report["jarvisPaused"].as_bool().unwrap_or(false),
        other_failing,
    }
}

struct State {
    status: Option<Status>,
    misses: u32,
    told_down: bool,
}

static STATE: Mutex<State> = Mutex::new(State {
    status: None,
    misses: 0,
    told_down: false,
});

/// system.status's last answer, and when it came.
static REPORT: Mutex<Option<(Status, Instant)>> = Mutex::new(None);

/// The latest status, once the first check is done.
pub fn current() -> Option<Status> {
    STATE.lock().ok().and_then(|s| s.status.clone())
}

/// system.status's last answer, if it's recent enough to show again.
fn recent_report() -> Option<Status> {
    REPORT
        .lock()
        .ok()
        .and_then(|r| r.clone())
        .filter(|(_, at)| at.elapsed() < ASK_EVERY)
        .map(|(status, _)| status)
}

fn keep_report(report: Option<Status>) {
    if let Ok(mut r) = REPORT.lock() {
        *r = report.map(|status| (status, Instant::now()));
    }
}

/// Starts checking. Call once at startup.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            check(&app, false).await;
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// Checks again in a little while (after a restart, say), asking system.status afresh.
pub fn check_soon(app: &AppHandle, after: Duration) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(after).await;
        check(&app, true).await;
    });
}

async fn check(app: &AppHandle, fresh: bool) {
    let status = read(app, fresh).await;
    let (changed, tell_down, tell_back) = {
        let Ok(mut s) = STATE.lock() else { return };
        let changed = s.status.as_ref() != Some(&status);
        s.misses = if status.server == Mark::Down {
            s.misses + 1
        } else {
            0
        };
        let tell_down = s.misses == MISSES_BEFORE_TELLING && !s.told_down;
        let tell_back = status.server == Mark::Ok && s.told_down;
        if tell_down {
            s.told_down = true;
        }
        if tell_back {
            s.told_down = false;
        }
        s.status = Some(status);
        (changed, tell_down, tell_back)
    };
    if tell_down {
        toast::show(
            app,
            "Nook isn't running",
            "Its server stopped answering. Right-click the Nook icon by the clock and choose \
             Restart Nook services.",
            Some("hearth://open/"),
        );
    }
    if tell_back {
        toast::show(app, "Nook is running again", "", None);
    }
    if changed {
        crate::tray::update_tray_menu(app);
    }
}

async fn read(app: &AppHandle, fresh: bool) -> Status {
    let Some(home) = window::home(app) else {
        keep_report(None);
        return Status {
            address_set: false,
            ..Status::unknown(Mark::Unknown)
        };
    };
    if !healthy(&home.origin().ascii_serialization()).await {
        // Forgotten, so it's asked again as soon as the server answers.
        keep_report(None);
        return Status::unknown(Mark::Down);
    }
    let Some(h) = link(app) else {
        keep_report(None);
        return Status::unknown(Mark::Ok);
    };
    if !fresh {
        if let Some(status) = recent_report() {
            return status;
        }
    }
    match h
        .call(
            "system.status",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .await
    {
        Ok(report) => {
            let status = from_report(&report, Utc::now());
            keep_report(Some(status.clone()));
            status
        }
        Err(e) => {
            log::debug!("Hearth's status: {e}");
            Status::unknown(Mark::Ok)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        "2026-10-04T12:00:00Z".parse().unwrap()
    }

    #[test]
    fn all_well() {
        let s = from_report(
            &json!({ "jarvisPaused": false, "components": {
                "worker": { "status": "ok", "at": "2026-10-04T11:59:10Z" },
                "jarvis": { "status": "ok", "at": "2026-10-04T11:58:30Z" },
                "disk": { "status": "degraded", "at": "2026-10-04T11:59:00Z" }
            }}),
            now(),
        );
        assert_eq!(s.line(), "Server ✓  Worker ✓  Pip ✓");
        assert!(!s.trouble());
    }

    #[test]
    fn spots_trouble() {
        let s = from_report(
            &json!({ "jarvisPaused": true, "components": {
                // Stopped reporting ten minutes ago.
                "worker": { "status": "ok", "at": "2026-10-04T11:50:00Z" },
                "jarvis": { "status": "degraded", "at": "2026-10-04T11:59:00Z" },
                "google.sync": { "status": "failing", "at": "2026-10-04T11:59:00Z" }
            }}),
            now(),
        );
        assert_eq!(s.line(), "Server ✓  Worker ✗  Pip !");
        assert!(s.trouble() && s.other_failing);
    }

    #[test]
    fn says_paused_and_unknown() {
        let s = from_report(
            &json!({ "jarvisPaused": true, "components": {
                "jarvis": { "status": "ok", "at": "2026-10-04T11:59:00Z" }
            }}),
            now(),
        );
        assert_eq!(s.line(), "Server ✓  Worker ?  Pip paused");
        assert!(!s.trouble());
    }

    #[test]
    fn server_lines() {
        assert_eq!(
            Status::unknown(Mark::Down).line(),
            "Server ✗  Nook isn't running"
        );
        assert!(Status::unknown(Mark::Down).trouble());
        assert_eq!(
            Status::unknown(Mark::Ok).line(),
            "Server ✓  Connect this PC to see more"
        );
        assert!(!Status::unknown(Mark::Ok).trouble());
    }

    #[test]
    fn asks_system_status_again_after_a_while() {
        let status = Status::unknown(Mark::Ok);
        keep_report(Some(status.clone()));
        assert_eq!(recent_report(), Some(status.clone()));
        if let Some(long_ago) = Instant::now().checked_sub(ASK_EVERY) {
            *REPORT.lock().unwrap() = Some((status, long_ago));
            assert_eq!(recent_report(), None);
        }
        keep_report(None);
        assert_eq!(recent_report(), None);
    }
}
