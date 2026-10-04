// Hearth's own windows (D53): the main one, and the two small ones the hotkeys open. Each loads
// Hearth from the address in this app's settings, so it's Hearth's web app with a few desktop
// manners: links elsewhere open in your browser, downloads go to Downloads, files can be dragged
// in, and when the server doesn't answer it says so and tries again.
//
// They're web pages like any other: none of them gets this app's commands. Tauri only lets the
// windows named in capabilities/*.json ("main" and "recording_overlay") call into the app, and
// remote pages never without a "remote" entry there. Keep it that way.

use super::links::{self, Nav};
use super::offline::{self, is_waiting, stop_waiting};
use super::{deeplink, tell, toast};
use crate::settings::get_settings;
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const MAIN: &str = "hearth";
pub const CAPTURE: &str = "hearth_capture";
pub const ASK: &str = "hearth_ask";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Which {
    Main,
    Capture,
    Ask,
}

impl Which {
    fn label(self) -> &'static str {
        match self {
            Which::Main => MAIN,
            Which::Capture => CAPTURE,
            Which::Ask => ASK,
        }
    }
}

/// Opens (or brings up) Hearth's window at a page, like "/" or "/record/<id>".
pub fn open(app: &AppHandle, path: &str) {
    spawn(app, Which::Main, path);
}

/// The quick capture box (Ctrl+Alt+N).
pub fn capture(app: &AppHandle) {
    spawn(app, Which::Capture, "/capture");
}

/// A small window to ask Jarvis by typing (Ctrl+Alt+K).
pub fn ask(app: &AppHandle) {
    spawn(app, Which::Ask, "/chat?compact=1");
}

/// Whether Hearth's main window is in front, so notifications can stay quiet.
pub fn main_focused(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}

/// The small windows tuck away when you click elsewhere.
pub fn blurred(window: &tauri::Window) {
    if matches!(window.label(), CAPTURE | ASK) {
        let _ = window.hide();
    }
}

/// Closes every Hearth window, e.g. when Hearth's address changes.
pub fn close_all(app: &AppHandle) {
    for label in [MAIN, CAPTURE, ASK] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
        stop_waiting(label);
    }
}

/// Hearth's address from settings, if it's a usable one.
pub fn home(app: &AppHandle) -> Option<Url> {
    super::check_address(get_settings(app).hearth_url.trim_end_matches('/')).ok()
}

fn spawn(app: &AppHandle, which: Which, path: &str) {
    let app = app.clone();
    let path = path.to_string();
    // Off the main thread: making a WebView2 window from inside an event handler can deadlock.
    tauri::async_runtime::spawn(async move { show(&app, which, &path).await });
}

async fn show(app: &AppHandle, which: Which, path: &str) {
    let Some(home) = home(app) else {
        tell(app, "Set Hearth's address in voice settings first.");
        crate::show_main_window(app);
        return;
    };
    let page = match links::page_url(&home, path) {
        Ok(p) => p,
        Err(e) => return log::warn!("{e}"),
    };
    let label = which.label();
    let existing = app.get_webview_window(label);
    // An open window keeps its page (and Jarvis's conversation) unless asked for another;
    // quick capture always starts empty.
    let keep = existing.is_some()
        && !is_waiting(label)
        && match which {
            Which::Main => path == "/",
            Which::Capture => false,
            Which::Ask => true,
        };
    let window = match existing {
        Some(w) => w,
        None => match build(app, which, &home) {
            Ok(w) => w,
            // Opened twice at once: the other one made it.
            Err(_) if app.get_webview_window(label).is_some() => {
                app.get_webview_window(label).unwrap()
            }
            Err(e) => {
                log::error!("Couldn't open Hearth's window: {e}");
                return tell(
                    app,
                    "Couldn't open Hearth's window. Try again from the tray.",
                );
            }
        },
    };
    if !keep {
        offline::load(app, &window, page).await;
    }
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn build(app: &AppHandle, which: Which, home: &Url) -> tauri::Result<WebviewWindow> {
    let label = which.label();
    let blank: Url = "about:blank".parse().expect("about:blank");
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::External(blank))
        .visible(false)
        // Files dragged onto Hearth reach the page (attachments, imports).
        .disable_drag_drop_handler();

    let (nav_app, nav_home) = (app.clone(), home.clone());
    b = b.on_navigation(move |to| match links::navigation(to, &nav_home) {
        Nav::Stay => true,
        Nav::Elsewhere => {
            browser(to);
            false
        }
        Nav::Link => {
            from_page(&nav_app, label, to.as_str());
            false
        }
        Nav::Refuse => {
            log::warn!("Hearth's window refused to open {}", to.scheme());
            false
        }
    });

    // Links that open a new window: Hearth's own pages open here, anything else in the browser.
    let (new_app, new_home) = (app.clone(), home.clone());
    b = b.on_new_window(move |to, _| {
        match links::navigation(&to, &new_home) {
            Nav::Stay if matches!(to.scheme(), "http" | "https") => {
                if let Some(w) = new_app.get_webview_window(label) {
                    let _ = w.navigate(to);
                }
            }
            Nav::Elsewhere => browser(&to),
            Nav::Link => from_page(&new_app, label, to.as_str()),
            _ => {}
        }
        NewWindowResponse::Deny
    });

    // Downloads from Hearth go straight to Downloads; anything else is the browser's job.
    let (dl_app, dl_home) = (app.clone(), home.clone());
    b = b.on_download(move |_, event| match event {
        DownloadEvent::Requested { url, .. } => {
            let ours = matches!(url.scheme(), "blob" | "data") || url.origin() == dl_home.origin();
            if !ours {
                browser(&url);
            }
            ours
        }
        DownloadEvent::Finished { path, success, .. } => {
            let name = path
                .as_ref()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_string());
            match (success, name) {
                (true, Some(name)) => toast::show(
                    &dl_app,
                    "Downloaded",
                    &format!("{name} is in your Downloads folder."),
                    None,
                ),
                _ => toast::show(
                    &dl_app,
                    "That download didn't finish",
                    "Try it again from Hearth.",
                    None,
                ),
            }
            true
        }
        _ => true,
    });

    if let Some(dir) = crate::portable::data_dir() {
        b = b.data_directory(dir.join("webview"));
    }

    b = match which {
        Which::Main => b
            .title("Hearth")
            .inner_size(1280.0, 860.0)
            .min_inner_size(480.0, 400.0)
            .center(),
        Which::Capture => b
            .title("Quick capture")
            .inner_size(560.0, 180.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .center(),
        Which::Ask => b
            .title("Ask Jarvis")
            .inner_size(480.0, 640.0)
            .min_inner_size(360.0, 320.0)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .center(),
    };

    let window = b.build()?;
    mark_user_agent(&window, &app.package_info().version.to_string());
    Ok(window)
}

/// A hearth:// link a Hearth page opened: the small windows close themselves with one, and
/// the "isn't running" page's Retry is one. The rest go where links from anywhere go.
fn from_page(app: &AppHandle, label: &str, link: &str) {
    match links::parse(link) {
        Ok(links::Link::Close) => {
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.hide();
            }
        }
        Ok(links::Link::Retry) => offline::retry(app),
        _ => deeplink::handle(app, link),
    }
}

/// Opens an address in the default browser (or mail app). Only web and mail addresses.
fn browser(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
            log::warn!("Couldn't open the browser: {e}");
        }
    }
}

/// Adds "HearthDesktop/<version>" to the window's user agent, so Hearth's web app can tell it's
/// in here (it hides "install this app" and phone-notification prompts).
fn mark_user_agent(window: &WebviewWindow, version: &str) {
    #[cfg(windows)]
    {
        let marker = format!("HearthDesktop/{version}");
        let _ = window.with_webview(move |webview| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings2;
            use windows::core::{Interface, HSTRING, PWSTR};

            let result = webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.Settings())
                .and_then(|s| s.cast::<ICoreWebView2Settings2>())
                .and_then(|s| {
                    let mut current = PWSTR::null();
                    s.UserAgent(&mut current)?;
                    let current = webview2_com::CoTaskMemPWSTR::from(current).to_string();
                    if current.contains("HearthDesktop/") {
                        return Ok(());
                    }
                    s.SetUserAgent(&HSTRING::from(format!("{current} {marker}")))
                });
            if let Err(e) = result {
                log::warn!("Couldn't mark Hearth's window as the desktop app: {e}");
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (window, version);
}
