// Windows notifications from Hearth (D53): the inbox items your phone is told about (approvals,
// the morning brief, interruptions Jarvis may make) and Hearth's health changing. The app keeps
// one stream open to GET /api/desktop/notify and shows each message, unless Hearth's window is
// in front. Clicking one opens its page in Hearth's window. Nothing here can approve anything:
// the device token can't, and a notification only opens a page.

use super::client::Hearth;
use super::sse::Reader;
use super::{link, links, toast, window};
use futures_util::StreamExt;
use serde::Deserialize;
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// Not even a keep-alive (Hearth sends one every 20 s) for this long: the stream is dead.
const SILENCE: Duration = Duration::from_secs(70);
const FIRST_WAIT: Duration = Duration::from_secs(5);
const LONGEST_WAIT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Deserialize, PartialEq)]
pub struct Message {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub url: String,
}

/// Starts listening. Call once at startup; it waits quietly while the app isn't connected.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_id: Option<String> = None;
        let mut wait = FIRST_WAIT;
        loop {
            let Some(h) = link(&app) else {
                tokio::time::sleep(Duration::from_secs(15)).await;
                continue;
            };
            let started = Instant::now();
            if let Err(e) = listen(&app, &h, &mut last_id).await {
                log::debug!("Notifications: {e}");
            }
            wait = next_wait(wait, started.elapsed());
            tokio::time::sleep(wait).await;
        }
    });
}

/// How long to wait before connecting again: soon after a stream that ran a while, longer and
/// longer while Hearth keeps refusing or isn't there.
pub fn next_wait(previous: Duration, lasted: Duration) -> Duration {
    if lasted > Duration::from_secs(60) {
        FIRST_WAIT
    } else {
        (previous * 2).min(LONGEST_WAIT)
    }
}

async fn listen(app: &AppHandle, h: &Hearth, last_id: &mut Option<String>) -> Result<(), String> {
    let res = h.notify_feed(last_id.as_deref()).await?;
    let mut body = res.bytes_stream();
    let mut reader = Reader::default();
    loop {
        let chunk = match tokio::time::timeout(SILENCE, body.next()).await {
            Err(_) => return Err("the stream went quiet".into()),
            Ok(None) => return Ok(()),
            Ok(Some(Err(e))) => return Err(e.to_string()),
            Ok(Some(Ok(chunk))) => chunk,
        };
        for event in reader.push(&chunk) {
            if let Some(id) = &event.id {
                *last_id = Some(id.clone());
            }
            if event.event != "notify" {
                continue;
            }
            match serde_json::from_str::<Message>(&event.data) {
                Ok(m) if !window::main_focused(app) => {
                    toast::show(app, &m.title, &m.body, Some(&links::open_link(&m.url)))
                }
                Ok(_) => {}
                Err(e) => log::warn!("Notifications: odd message from Hearth: {e}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backs_off_while_hearth_is_away() {
        let quick = Duration::from_secs(1);
        assert_eq!(next_wait(FIRST_WAIT, quick), Duration::from_secs(10));
        assert_eq!(next_wait(Duration::from_secs(200), quick), LONGEST_WAIT);
        assert_eq!(
            next_wait(LONGEST_WAIT, Duration::from_secs(3600)),
            FIRST_WAIT
        );
    }

    #[test]
    fn reads_hearths_messages() {
        let m: Message = serde_json::from_str(
            r#"{"title":"Jarvis needs a yes","body":"Send it?","url":"/inbox","tag":"x"}"#,
        )
        .unwrap();
        assert_eq!(links::open_link(&m.url), "hearth://open/inbox");
        let bare: Message = serde_json::from_str(r#"{"title":"Hi"}"#).unwrap();
        assert_eq!(links::open_link(&bare.url), "hearth://open/inbox");
    }
}
