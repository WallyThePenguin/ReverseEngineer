// "Restart Hearth services" and "Update Hearth…" in the tray (D53). Hearth's server, worker and
// Jarvis run as Windows services and a scheduled task whether or not this app is open; the app
// only offers what you'd otherwise type into PowerShell, in a PowerShell window you can watch.
// Both ask first. Hearth's folder is the one its installed service runs from.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// Where install.ps1 puts the server's service definition.
const SERVICE_XML: &str = r"Hearth\services\hearth-server.xml";

/// Hearth's folder on this PC, when Hearth is installed here as a service.
pub fn hearth_folder() -> Option<PathBuf> {
    static CACHE: Mutex<Option<(Instant, Option<PathBuf>)>> = Mutex::new(None);
    let mut cache = CACHE.lock().ok()?;
    if let Some((at, folder)) = cache.as_ref() {
        if at.elapsed() < Duration::from_secs(60) {
            return folder.clone();
        }
    }
    let folder = find_folder();
    *cache = Some((Instant::now(), folder.clone()));
    folder
}

fn find_folder() -> Option<PathBuf> {
    let data = std::env::var_os("ProgramData")?;
    let xml = std::fs::read_to_string(Path::new(&data).join(SERVICE_XML)).ok()?;
    let folder = PathBuf::from(folder_in_service_xml(&xml)?);
    folder
        .join(r"apps\cli\src\main.ts")
        .is_file()
        .then_some(folder)
}

/// The <workingdirectory> of a WinSW service definition.
pub fn folder_in_service_xml(xml: &str) -> Option<String> {
    let start = xml.find("<workingdirectory>")? + "<workingdirectory>".len();
    let end = start + xml[start..].find("</workingdirectory>")?;
    let raw = xml[start..end].trim();
    let folder = raw
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    let absolute = folder.len() > 3 && folder.as_bytes()[1] == b':' && folder.contains('\\');
    (absolute && !folder.contains(['"', '\n', '\r'])).then_some(folder)
}

/// A path inside single quotes, for PowerShell.
fn quoted(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "''"))
}

/// What restarting runs: `hearth restart all` where Hearth has it, else the steps from
/// docs/setup-windows.md (restart both services, then Jarvis's task).
pub fn restart_script(folder: &Path, has_restart_command: bool) -> String {
    let steps: Vec<String> = if has_restart_command {
        vec![
            format!("Set-Location -LiteralPath {}", quoted(folder)),
            "pnpm hearth restart all".into(),
        ]
    } else {
        vec![
            "Write-Host 'Restarting Hearth...'".into(),
            "Restart-Service hearth-server, hearth-worker".into(),
            "$pidFile = Join-Path $env:ProgramData 'Hearth\\services\\hearth-jarvis.pid'".into(),
            "Stop-ScheduledTask -TaskName 'Hearth Jarvis' -ErrorAction SilentlyContinue".into(),
            // Stopping the task can leave Jarvis's node running; the pid it wrote finds it. The
            // file outlives a Jarvis that crashed, so only a process older than it is Jarvis.
            "if (Test-Path $pidFile) { $p = Get-Process -Id ([int](Get-Content $pidFile -Raw).Trim()) -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node' -and $p.StartTime -and $p.StartTime -le (Get-Item $pidFile).LastWriteTime.AddSeconds(5)) { Stop-Process -Id $p.Id -Force } }".into(),
            "Start-ScheduledTask -TaskName 'Hearth Jarvis'".into(),
        ]
    };
    let mut all = steps;
    all.push("Write-Host 'Done. You can close this window.'".into());
    all.join("; ")
}

fn has_restart_command(folder: &Path) -> bool {
    std::fs::read_to_string(folder.join(r"apps\cli\src\main.ts"))
        .is_ok_and(|src| src.contains("case \"restart\""))
}

/// Restarts Hearth's services, after asking.
pub fn restart(app: &AppHandle) {
    let Some(folder) = hearth_folder() else {
        return super::tell(app, "Hearth isn't installed as a service on this PC.");
    };
    let app = app.clone();
    ask(
        &app.clone(),
        "Restart Hearth?",
        "This restarts Hearth's server, worker and Jarvis. Anything Jarvis is doing right now stops.",
        "Restart",
        move || {
            let script = restart_script(&folder, has_restart_command(&folder));
            if let Err(e) = powershell(&["-Command", &script]) {
                log::error!("Couldn't start PowerShell: {e}");
                return super::tell(&app, "Couldn't open PowerShell to restart Hearth.");
            }
            super::status::check_soon(&app, Duration::from_secs(20));
        },
    );
}

/// Runs Hearth's updater in a PowerShell window, after asking.
pub fn update(app: &AppHandle) {
    let Some(script) = hearth_folder()
        .map(|f| f.join(r"ops\windows\update.ps1"))
        .filter(|p| p.is_file())
    else {
        return super::tell(app, "Couldn't find Hearth's updater on this PC.");
    };
    let app = app.clone();
    ask(
        &app.clone(),
        "Update Hearth?",
        "Hearth stops for a minute or two while it updates, and goes back to this version if \
         anything goes wrong. A window shows how it's going.",
        "Update",
        move || {
            let path = script.display().to_string();
            if let Err(e) = powershell(&["-File", &path]) {
                log::error!("Couldn't start PowerShell: {e}");
                return super::tell(&app, "Couldn't open PowerShell to update Hearth.");
            }
            super::status::check_soon(&app, Duration::from_secs(90));
        },
    );
}

fn ask(app: &AppHandle, title: &str, text: &str, yes: &str, then: impl FnOnce() + Send + 'static) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    app.dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            yes.into(),
            "Cancel".into(),
        ))
        .show(move |ok| {
            if ok {
                then();
            }
        });
}

/// Starts PowerShell in its own window, which stays open when it's done.
fn powershell(args: &[&str]) -> std::io::Result<()> {
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass"])
        .args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    cmd.spawn().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_folder_from_the_service() {
        let xml = r#"<service><id>hearth-server</id>
  <workingdirectory>C:\Users\me\Hearth &amp; Co</workingdirectory>
  <arguments>"C:\Users\me\Hearth &amp; Co\apps\cli\src\main.ts" serve</arguments></service>"#;
        assert_eq!(
            folder_in_service_xml(xml).as_deref(),
            Some(r"C:\Users\me\Hearth & Co")
        );
        assert_eq!(folder_in_service_xml("<service></service>"), None);
        assert_eq!(
            folder_in_service_xml("<workingdirectory>{{ROOT}}</workingdirectory>"),
            None
        );
        assert_eq!(
            folder_in_service_xml("<workingdirectory>relative\\x</workingdirectory>"),
            None
        );
    }

    #[test]
    fn restart_scripts_quote_the_folder() {
        let s = restart_script(Path::new(r"D:\It's Hearth"), true);
        assert_eq!(
            s,
            "Set-Location -LiteralPath 'D:\\It''s Hearth'; pnpm hearth restart all; Write-Host 'Done. You can close this window.'"
        );
        let fallback = restart_script(Path::new(r"D:\Hearth"), false);
        assert!(fallback.contains("Restart-Service hearth-server, hearth-worker"));
        assert!(fallback.contains("Start-ScheduledTask -TaskName 'Hearth Jarvis'"));
        // A stale pid file's pid, now some other node.exe, is left alone.
        assert!(fallback.contains("$p.StartTime -le (Get-Item $pidFile).LastWriteTime"));
        // No double quotes: the script goes to PowerShell as one quoted argument.
        assert!(!s.contains('"') && !fallback.contains('"'));
    }
}
