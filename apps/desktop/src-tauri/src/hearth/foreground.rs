// Which program and window you were typing in when you pressed the hotkey, so Hearth can pick
// that app's style (casual in Slack, formal in email).

use super::client::Target;

#[cfg(windows)]
pub fn current() -> Target {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return Target::default();
        }
        let mut title = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut title).max(0) as usize;
        let window = String::from_utf16_lossy(&title[..n]);

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let path = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .ok()
            .and_then(|process| {
                let mut buf = [0u16; 1024];
                let mut len = buf.len() as u32;
                let ok = QueryFullProcessImageNameW(
                    process,
                    PROCESS_NAME_WIN32,
                    PWSTR(buf.as_mut_ptr()),
                    &mut len,
                )
                .is_ok();
                let _ = CloseHandle(process);
                ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
            });
        Target {
            app: path.as_deref().and_then(program_name),
            window: (!window.trim().is_empty()).then_some(window),
        }
    }
}

#[cfg(not(windows))]
pub fn current() -> Target {
    Target::default()
}

#[cfg_attr(not(windows), allow(dead_code))]
/// The program's file name from its path, like `slack.exe`.
pub fn program_name(path: &str) -> Option<String> {
    path.rsplit(['\\', '/'])
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The name in the form Hearth accepts for voice commands (letters, digits, space, `.`, `-`, `_`).
pub fn safe_app(app: &str) -> Option<String> {
    let kept: String = app
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_'))
        .take(64)
        .collect();
    let kept = kept.trim().to_string();
    (!kept.is_empty()).then_some(kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_program() {
        assert_eq!(
            program_name(r"C:\Users\w\AppData\Local\slack\slack.exe").as_deref(),
            Some("slack.exe")
        );
        assert_eq!(program_name(""), None);
    }

    #[test]
    fn keeps_app_names_plain() {
        assert_eq!(
            safe_app("Code - Insiders.exe").as_deref(),
            Some("Code - Insiders.exe")
        );
        assert_eq!(safe_app("\"evil\"\nname").as_deref(), Some("evilname"));
        assert_eq!(safe_app("日本"), None);
    }
}
