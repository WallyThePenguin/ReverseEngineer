// Command mode needs the text you selected: copy it with Ctrl+C, read it, and put the
// clipboard back the way it was.

use crate::input::EnigoState;
use enigo::{Direction, Key, Keyboard};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// The selected text in the focused app, or an empty string when nothing is selected.
pub fn copy_selection(app: &AppHandle) -> String {
    let clipboard = app.clipboard();
    let before = clipboard.read_text().ok();
    // Cleared first, so "nothing selected" doesn't read back what was already there.
    let _ = clipboard.write_text(String::new());
    if let Err(e) = send_copy(app) {
        log::warn!("Couldn't copy the selection: {e}");
    }
    std::thread::sleep(Duration::from_millis(150));
    let selected = clipboard.read_text().unwrap_or_default();
    let _ = clipboard.write_text(before.unwrap_or_default());
    selected
}

fn send_copy(app: &AppHandle) -> Result<(), String> {
    let state = app.try_state::<EnigoState>().ok_or("keyboard not ready")?;
    let mut enigo = state.0.lock().map_err(|e| e.to_string())?;
    // The hotkey's own modifiers may still be down; they'd turn Ctrl+C into something else.
    for key in [Key::Alt, Key::Shift, Key::Meta] {
        let _ = enigo.key(key, Direction::Release);
    }
    #[cfg(target_os = "macos")]
    let (modifier, c) = (Key::Meta, Key::Unicode('c'));
    #[cfg(target_os = "windows")]
    let (modifier, c) = (Key::Control, Key::Other(0x43)); // VK_C
    #[cfg(target_os = "linux")]
    let (modifier, c) = (Key::Control, Key::Unicode('c'));
    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| e.to_string())?;
    let clicked = enigo.key(c, Direction::Click).map_err(|e| e.to_string());
    std::thread::sleep(Duration::from_millis(30));
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| e.to_string())?;
    clicked
}
