// Hearth's own windows (D53): the main one, and the two small ones the hotkeys open. Each loads
// Hearth from the address in this app's settings, so it's Hearth's web app with a few desktop
// manners: links elsewhere open in your browser, downloads go to Downloads, files can be dragged
// in, and when the server doesn't answer it says so and tries again.
//
// They're web pages like any other: none of them gets this app's commands. Tauri only lets the
// windows named in capabilities/*.json ("main" and "recording_overlay") call into the app, and
// remote pages never without a "remote" entry there. Keep it that way.
//
// Hearth's main window comes up once its page is there, never as an empty white frame: it's
// Hearth's own background until then, and when the app starts with Windows it loads out of sight
// so the first open is warm.

use super::links::{self, Nav};
use super::offline::{self, is_waiting, stop_waiting};
use super::{deeplink, tell, toast};
use crate::settings::get_settings;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_window_state::{StateFlags, WindowExt};

pub const MAIN: &str = "hearth";
pub const CAPTURE: &str = "hearth_capture";
pub const ASK: &str = "hearth_ask";

/// Opened while its page is still loading, the main window comes up after this anyway.
const SHOW_WITHIN: Duration = Duration::from_millis(300);

/// Set while the main window hasn't come up since it was made. It goes back where you left it
/// as it's made, but maximized only as it comes up: maximizing a window shows it, so loading out
/// of sight at login it would blink up and take focus.
static MAXIMIZE_ON_SHOW: AtomicBool = AtomicBool::new(false);

/// The window-state plugin's name (lib.rs), to take it out when quitting.
const WINDOW_STATE: &str = "window-state";

/// Each window's page, by label.
static PAGES: Mutex<BTreeMap<&'static str, Page>> = Mutex::new(BTreeMap::new());

/// Whether a window's page is still loading, and whether you're waiting to see it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Page {
    loading: bool,
    wanted: bool,
}

impl Page {
    fn start(&mut self) {
        self.loading = true;
    }

    /// You opened the window. True when it can come up now; else it waits for the page.
    fn ask(&mut self) -> bool {
        self.wanted = self.loading;
        !self.loading
    }

    /// The page is there. True when you're waiting for it.
    fn loaded(&mut self) -> bool {
        self.loading = false;
        std::mem::take(&mut self.wanted)
    }

    /// You've waited long enough. True when the window hasn't come up yet.
    fn waited(&mut self) -> bool {
        std::mem::take(&mut self.wanted)
    }
}

fn page<T>(label: &'static str, f: impl FnOnce(&mut Page) -> T) -> T {
    let mut pages = PAGES.lock().unwrap_or_else(|e| e.into_inner());
    f(pages.entry(label).or_default())
}

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

/// Loads Hearth into its window without showing it, for a start with Windows: the app waits in
/// the tray, and Hearth is already there the first time you open it.
pub fn preload(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if home(&app).is_some() {
            ready(&app, Which::Main, "/").await;
        }
    });
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
        PAGES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
    }
    MAXIMIZE_ON_SHOW.store(false, Ordering::SeqCst);
}

/// The app is quitting. A main window that never came up was never maximized (see
/// MAXIMIZE_ON_SHOW), so the window-state plugin doesn't get to save it: it would forget that you
/// left Hearth maximized. What it saved last time stays.
pub fn quitting(app: &AppHandle) {
    if MAXIMIZE_ON_SHOW.load(Ordering::SeqCst) && !app.remove_plugin(WINDOW_STATE) {
        log::warn!("No {WINDOW_STATE} plugin to take out before quitting");
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
    tauri::async_runtime::spawn(async move {
        if let Some(window) = ready(&app, which, &path).await {
            show(window, which).await;
        }
    });
}

/// Brings the window up. The main one waits for its page (see on_page_load in build), but
/// never longer than SHOW_WITHIN; the small ones come up at once, since you're about to type.
async fn show(window: WebviewWindow, which: Which) {
    let label = which.label();
    let waits = which == Which::Main && !window.is_visible().unwrap_or(false);
    if waits && !page(label, Page::ask) {
        tokio::time::sleep(SHOW_WITHIN).await;
        if !page(label, Page::waited) {
            // It came up when the page loaded.
            return;
        }
    }
    bring_up(&window);
}

fn bring_up(window: &WebviewWindow) {
    if window.label() == MAIN && MAXIMIZE_ON_SHOW.swap(false, Ordering::SeqCst) {
        restore(window, StateFlags::MAXIMIZED);
    }
    // Windows may have changed between light and dark since the window was made.
    let _ = window.set_background_color(Some(background(dark())));
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Puts the main window back as you left it, from the window-state plugin's record. On the main
/// thread, as the plugin does: it holds its lock across calls that wait for that thread.
fn restore(window: &WebviewWindow, flags: StateFlags) {
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        let _ = w.restore_state(flags);
    });
}

/// Hearth's window at a page: made if need be, and loading it, but not shown.
async fn ready(app: &AppHandle, which: Which, path: &str) -> Option<WebviewWindow> {
    let Some(home) = home(app) else {
        tell(app, "Set Hearth's address in voice settings first.");
        crate::show_main_window(app);
        return None;
    };
    let to = match links::page_url(&home, path) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("{e}");
            return None;
        }
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
                tell(
                    app,
                    "Couldn't open Hearth's window. Try again from the tray.",
                );
                return None;
            }
        },
    };
    if !keep {
        page(label, Page::start);
        offline::load(app, &window, to).await;
    }
    Some(window)
}

/// Hearth's page background (--color-bg in apps/web/src/index.css), which the window shows until
/// the page paints.
fn background(dark: bool) -> Color {
    if dark {
        Color(0x15, 0x13, 0x0f, 0xff)
    } else {
        Color(0xfa, 0xf8, 0xf5, 0xff)
    }
}

/// Whether Windows has apps in dark mode, which Hearth's pages follow.
fn dark() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
            .and_then(|k| k.get_value::<u32, _>("AppsUseLightTheme"))
            .is_ok_and(|light| light == 0)
    }
    #[cfg(not(windows))]
    false
}

fn build(app: &AppHandle, which: Which, home: &Url) -> tauri::Result<WebviewWindow> {
    let label = which.label();
    let blank: Url = "about:blank".parse().expect("about:blank");
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::External(blank))
        .visible(false)
        .background_color(background(dark()))
        // Files dragged onto Hearth reach the page (attachments, imports).
        .disable_drag_drop_handler();

    // A page has loaded: the "isn't running" page counts. If you opened the window while it was
    // loading, it comes up now. Every window starts on about:blank, which doesn't count.
    b = b.on_page_load(move |window, load| {
        if load.url().scheme() == "about" {
            return;
        }
        match load.event() {
            PageLoadEvent::Started => page(label, Page::start),
            PageLoadEvent::Finished => {
                if page(label, Page::loaded) {
                    tauri::async_runtime::spawn(async move { bring_up(&window) });
                }
            }
        }
    });

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
    if which == Which::Main {
        // Where you left it, and maximized as it comes up (see MAXIMIZE_ON_SHOW).
        MAXIMIZE_ON_SHOW.store(true, Ordering::SeqCst);
        restore(&window, StateFlags::SIZE | StateFlags::POSITION);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comes_up_once_its_page_is_there() {
        let mut p = Page::default();
        // Nothing loading: at once.
        assert!(p.ask());
        // Opened while loading: when it loads, and only then.
        p.start();
        assert!(!p.ask());
        assert!(p.loaded());
        assert!(!p.waited());
        assert!(!p.loaded());
        assert!(p.ask());
    }

    #[test]
    fn comes_up_anyway_when_the_page_is_slow() {
        let mut p = Page::default();
        p.start();
        assert!(!p.ask());
        assert!(p.waited());
        // Already up: the page arriving later doesn't bring it up again.
        assert!(!p.loaded());
    }

    #[test]
    fn loading_out_of_sight_never_brings_it_up() {
        let mut p = Page::default();
        p.start();
        assert!(!p.loaded());
        assert!(!p.waited());
        assert!(p.ask());
    }

    #[test]
    fn background_is_hearths_own() {
        let css = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../web/src/index.css"
        ))
        .expect("Hearth's web app beside the desktop app");
        let set: Vec<&str> = css
            .lines()
            .filter_map(|l| l.trim().strip_prefix("--color-bg:"))
            .map(|v| v.trim().trim_end_matches(';'))
            .collect();
        let hex = |c: Color| format!("#{:02x}{:02x}{:02x}", c.0, c.1, c.2);
        assert_eq!(set, [hex(background(false)), hex(background(true))]);
    }
}
