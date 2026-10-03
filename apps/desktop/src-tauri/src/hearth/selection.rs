// Command mode needs the text you selected: copy it with Ctrl+C, read it, and put the
// clipboard back the way it was.

use crate::input::EnigoState;
use enigo::{Direction, Key, Keyboard};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Programs where Ctrl+C stops what's running instead of copying.
const TERMINALS: &[&str] = &[
    "windowsterminal.exe",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "conhost.exe",
    "wezterm-gui.exe",
    "alacritty.exe",
    "mintty.exe",
    "putty.exe",
    "wsl.exe",
];

pub fn is_terminal(program: Option<&str>) -> bool {
    program.is_some_and(|p| TERMINALS.contains(&p.to_ascii_lowercase().as_str()))
}

/// The selected text in the focused app, or an empty string when nothing is selected or the app
/// is a terminal.
pub fn copy_selection(app: &AppHandle, program: Option<&str>) -> String {
    if is_terminal(program) {
        return String::new();
    }
    let clipboard = app.clipboard();
    // Text on the clipboard comes back afterwards. Anything else (an image, files) is left
    // alone unless something was selected, since copying replaces it.
    let before = clipboard.read_text().ok();
    if before.is_some() {
        // Cleared first, so "nothing selected" doesn't read back what was already there.
        let _ = clipboard.write_text(String::new());
    }
    if let Err(e) = send_copy(app) {
        log::warn!("Couldn't copy the selection: {e}");
    }
    std::thread::sleep(Duration::from_millis(150));
    let selected = clipboard.read_text().unwrap_or_default();
    if let Some(before) = before {
        let _ = clipboard.write_text(before);
    }
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

#[cfg(test)]
mod tests {
    #[test]
    fn leaves_terminals_alone() {
        assert!(super::is_terminal(Some("WindowsTerminal.exe")));
        assert!(!super::is_terminal(Some("slack.exe")));
        assert!(!super::is_terminal(None));
    }
}
