// Hearth's side of the desktop app (Hearth PLAN.md section 7). With a Hearth address and pairing
// code in Settings, three hotkeys go through Hearth:
// - dictation is cleaned with your dictionary, snippets and the app's style, and kept in your
//   history there (falling back to Handy's own processing when Hearth can't be reached);
// - command mode sends what you said, with the text you selected, to Jarvis and pastes its answer;
// - talk mode sends what you said to Jarvis and reads the answer aloud.

pub mod bakeoff;
pub mod client;
pub mod foreground;
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

/// Call when the hotkey goes down, before the overlay takes focus.
pub fn pressed() {
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
    ProcessedTranscription {
        final_text: String::new(),
        post_processed_text: None,
        post_process_prompt: None,
    }
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
                final_text: text.clone(),
                post_processed_text: Some(text),
                post_process_prompt: None,
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
            Ok(text) => ProcessedTranscription {
                final_text: text.clone(),
                post_processed_text: Some(text),
                post_process_prompt: None,
            },
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
    let selection = tauri::async_runtime::spawn_blocking(move || selection::copy_selection(&ah))
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
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Hearth's address starts with http:// or https://".into());
    }
    let mut s = get_settings(&app);
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
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window("hearth") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let base = get_settings(app).hearth_url;
    let Ok(url) = base.parse::<tauri::Url>() else {
        tell(app, "Set Hearth's address in Settings first.");
        return;
    };
    if let Err(e) = WebviewWindowBuilder::new(app, "hearth", WebviewUrl::External(url))
        .title("Hearth")
        .inner_size(1280.0, 860.0)
        .build()
    {
        tell(app, &format!("Couldn't open Hearth: {e}"));
    }
}
