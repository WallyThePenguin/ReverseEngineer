// Hearth's side of the desktop app (Hearth PLAN.md section 7). With a Hearth address and pairing
// code in Settings, three hotkeys go through Hearth:
// - dictation is cleaned with your dictionary, snippets and the app's style, and kept in your
//   history there (falling back to Handy's own processing when Hearth can't be reached);
// - command mode sends what you said, with the text you selected, to Jarvis and pastes its answer;
// - talk mode sends what you said to Jarvis and reads the answer aloud.

pub mod bakeoff;
pub mod capture;
pub mod chunker;
pub mod client;
pub mod foreground;
pub mod meeting;
pub mod relay;
pub mod selection;
pub mod speak;

use crate::actions::{process_transcription_output, ProcessedTranscription};
use crate::settings::{get_settings, write_settings};
use client::{replies, CommandResult, Hearth, Target};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const DESKTOP_KEY: &str = "desktop";
pub const COMMAND_BINDING: &str = "hearth_command";
pub const TALK_BINDING: &str = "hearth_talk";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Dictate,
    Command,
    Talk,
}

/// Where you were when you pressed the hotkey, and when.
static PRESSED: Mutex<Option<(Target, Instant)>> = Mutex::new(None);
/// The conversation talk mode is in, and when it was last used.
static TALKING: Mutex<Option<(String, Instant)>> = Mutex::new(None);
/// A pause this long starts a new conversation with Jarvis.
const NEW_CONVERSATION_AFTER: Duration = Duration::from_secs(10 * 60);

/// The link to Hearth, when an address and pairing code are set.
pub fn link(app: &AppHandle) -> Option<Hearth> {
    let s = get_settings(app);
    let token = s.hearth_keys.get(DESKTOP_KEY).cloned().unwrap_or_default();
    Hearth::new(&s.hearth_url, &token)
}

/// Call when the hotkey goes down, before the overlay takes focus. Jarvis stops talking.
pub fn pressed() {
    speak::stop();
    if let Ok(mut p) = PRESSED.lock() {
        *p = Some((foreground::current(), Instant::now()));
    }
}

fn take_pressed() -> (Target, Duration) {
    PRESSED
        .lock()
        .ok()
        .and_then(|mut p| p.take())
        .map(|(t, at)| (t, at.elapsed()))
        .unwrap_or_default()
}

fn tell(app: &AppHandle, message: &str) {
    log::warn!("{message}");
    let _ = app.emit("transcription-error", message.to_string());
}

fn nothing() -> ProcessedTranscription {
    pasted(String::new())
}

/// Text from Hearth, made safe to paste: no control characters but newlines and tabs, and not
/// endlessly long. It's never submitted with Enter.
fn pasted(text: String) -> ProcessedTranscription {
    let text = plain(&text);
    ProcessedTranscription {
        final_text: text.clone(),
        post_processed_text: (!text.is_empty()).then_some(text),
        post_process_prompt: None,
        no_submit: true,
    }
}

const MAX_PASTE: usize = 20_000;

fn plain(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(MAX_PASTE)
        .collect()
}

/// What to paste for this transcription.
pub(crate) async fn finish(
    app: &AppHandle,
    transcription: &str,
    post_process: bool,
    mode: Mode,
) -> ProcessedTranscription {
    let (target, held) = take_pressed();
    let hearth = link(app);
    match (mode, hearth) {
        (Mode::Dictate, Some(h)) => match h
            .clean(transcription, &target, held.as_millis() as u64)
            .await
        {
            Ok(text) => ProcessedTranscription {
                no_submit: false,
                ..pasted(text)
            },
            Err(e) => {
                log::warn!("Hearth cleanup failed, using Handy's own: {e}");
                process_transcription_output(app, transcription, post_process).await
            }
        },
        (Mode::Dictate, None) => {
            process_transcription_output(app, transcription, post_process).await
        }
        (_, None) => {
            tell(app, "Pair the app with Hearth in Settings to use Jarvis.");
            nothing()
        }
        (Mode::Command, Some(h)) => match command(app, &h, transcription, &target).await {
            // Pasted only where you asked; if you moved on, it waits on the clipboard.
            Ok(text) if foreground::current() == target => pasted(text),
            Ok(text) => {
                use tauri_plugin_clipboard_manager::ClipboardExt;
                let _ = app.clipboard().write_text(plain(&text));
                tell(
                    app,
                    "You switched windows, so Jarvis's answer is on the clipboard.",
                );
                nothing()
            }
            Err(e) => {
                tell(app, &e);
                nothing()
            }
        },
        (Mode::Talk, Some(h)) => {
            if let Err(e) = talk(h, transcription).await {
                tell(app, &e);
            }
            nothing()
        }
    }
}

async fn command(
    app: &AppHandle,
    h: &Hearth,
    instruction: &str,
    target: &Target,
) -> Result<String, String> {
    if instruction.trim().is_empty() {
        return Err("Didn't catch a command.".into());
    }
    let ah = app.clone();
    let program = target.app.clone();
    let selection = tauri::async_runtime::spawn_blocking(move || {
        selection::copy_selection(&ah, program.as_deref())
    })
    .await
    .unwrap_or_default();
    let at = Target {
        app: target.app.as_deref().and_then(foreground::safe_app),
        window: None,
    };
    let id = h.command(instruction, &selection, &at).await?;
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(300)).await;
        match h.command_result(&id).await? {
            CommandResult::Working => continue,
            CommandResult::Done { text } => return Ok(text),
            CommandResult::Failed { reason } => return Err(format!("Jarvis: {reason}")),
        }
    }
    Err("Jarvis took too long; nothing was pasted.".into())
}

/// Sends what you said, then reads Jarvis's answer aloud as it arrives.
async fn talk(h: Hearth, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let current = TALKING.lock().ok().and_then(|t| {
        t.as_ref()
            .filter(|(_, at)| at.elapsed() < NEW_CONVERSATION_AFTER)
            .map(|(id, _)| id.clone())
    });
    let sent = match h.send(text, current.as_deref()).await {
        Ok(s) => s,
        // The old conversation may be gone; start a new one.
        Err(_) if current.is_some() => h.send(text, None).await?,
        Err(e) => return Err(e),
    };
    if let Ok(mut t) = TALKING.lock() {
        *t = Some((sent.conversation_id.clone(), Instant::now()));
    }
    tauri::async_runtime::spawn(async move {
        let mut after = sent.idx;
        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let Ok(log) = h.log_after(&sent.conversation_id, after).await else {
                continue;
            };
            if let Some(last) = log.last() {
                after = last.idx;
            }
            let (said, done) = replies(&log);
            for line in said {
                speak::say(&line);
            }
            if done {
                break;
            }
        }
    });
    Ok(())
}

/// Saves Hearth's address and pairing code (blank keeps the saved code), then checks them.
#[tauri::command]
#[specta::specta]
pub async fn change_hearth_settings(
    app: AppHandle,
    url: String,
    code: String,
) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/').to_string();
    let parsed = check_address(&url)?;
    let mut s = get_settings(&app);
    // The code only goes to the Hearth it came from: a new address needs it entered again.
    let same = s
        .hearth_url
        .parse::<tauri::Url>()
        .is_ok_and(|old| old.origin() == parsed.origin());
    if !same {
        s.hearth_keys.remove(DESKTOP_KEY);
    }
    s.hearth_url = url;
    if !code.trim().is_empty() {
        s.hearth_keys
            .insert(DESKTOP_KEY.to_string(), code.trim().to_string());
    }
    write_settings(&app, s);
    let h =
        link(&app).ok_or("Enter the pairing code from Hearth's Settings, under Desktop app.")?;
    h.call(
        "voice.styles",
        serde_json::json!({}),
        Duration::from_secs(5),
    )
    .await
    .map(|_| "Connected to Hearth.".to_string())
}

/// Hearth's address: plain http only on this PC, https anywhere else.
fn check_address(url: &str) -> Result<tauri::Url, String> {
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|_| "That isn't a web address.".to_string())?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if local => Ok(parsed),
        _ => Err(
            "Use https:// for a Hearth on another computer (http:// only works for localhost)."
                .into(),
        ),
    }
}

/// Forgets the pairing code; dictation goes back to Handy's own processing.
#[tauri::command]
#[specta::specta]
pub fn unpair_hearth(app: AppHandle) -> Result<(), String> {
    let mut s = get_settings(&app);
    s.hearth_keys.remove(DESKTOP_KEY);
    write_settings(&app, s);
    Ok(())
}

/// Opens Hearth itself in its own window (from the tray). It's a web page like any other: it
/// gets none of this app's commands.
pub fn open_window(app: &AppHandle) {
    open_window_at(app, "/");
}

/// Opens Hearth's window at a page, like `/record/<id>`.
pub fn open_window_at(app: &AppHandle, path: &str) {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    let base = get_settings(app).hearth_url;
    let Ok(url) = base.parse::<tauri::Url>().and_then(|b| b.join(path)) else {
        tell(app, "Set Hearth's address in Settings first.");
        return;
    };
    if let Some(w) = app.get_webview_window("hearth") {
        if path != "/" {
            let _ = w.navigate(url);
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let home = url.origin();
    if let Err(e) = WebviewWindowBuilder::new(app, "hearth", WebviewUrl::External(url))
        // Links elsewhere open in the browser, not in this window.
        .on_navigation(move |to| {
            let ok = to.origin() == home;
            if !ok && matches!(to.scheme(), "http" | "https") {
                let _ = tauri_plugin_opener::open_url(to.as_str(), None::<&str>);
            }
            ok
        })
        .title("Hearth")
        .inner_size(1280.0, 860.0)
        .build()
    {
        tell(app, &format!("Couldn't open Hearth: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pastes_plain_text_only() {
        assert_eq!(plain("a\u{1b}[31mb\r\nc\td"), "a[31mb\nc\td");
        assert_eq!(plain(&"x".repeat(30_000)).len(), MAX_PASTE);
        assert!(pasted("hi".into()).no_submit);
    }

    #[test]
    fn needs_https_away_from_this_pc() {
        assert!(check_address("http://localhost:4400").is_ok());
        assert!(check_address("http://127.0.0.1:4400").is_ok());
        assert!(check_address("https://hearth.tail1234.ts.net").is_ok());
        assert!(check_address("http://192.168.1.20:4400").is_err());
        assert!(check_address("ftp://localhost").is_err());
        assert!(check_address("localhost:4400").is_err());
    }
}
