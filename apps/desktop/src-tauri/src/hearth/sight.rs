// Hearth's main window coming into sight and going out of it. It comes up once its page is there,
// never as an empty white frame: it's Hearth's own background until then, and it's never more
// than a moment after you asked, however slow Hearth's server is (unless a link opens a page over
// one it already has: window.rs). When the app starts with Windows it loads out of sight, so the
// first open is warm.
//
// Out of sight (in the tray or minimized), its page knows it is, as a page in a background tab
// does: it rests (the checks Hearth's pages skip while hidden, timers slowed down), and it looks
// again when you're back. Hiding the window alone doesn't tell it: WebView2 keeps the page
// "visible" until it's told.

use super::window::{ASK, MAIN};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::window::Color;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_window_state::{StateFlags, WindowExt};

/// Asked for while its page is still loading, the main window comes up this long after you asked
/// anyway.
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

/// A window's page is about to load.
pub(super) fn loading(label: &'static str) {
    page(label, Page::start);
}

/// A window's page started loading or has loaded: the "isn't running" page counts. If you opened
/// the window while it was loading, it comes up now. Every window starts on about:blank, which
/// doesn't count. Hidden pages load all the same (WebView2 still says when they're there).
pub(super) fn page_load(label: &'static str, window: WebviewWindow, load: PageLoadPayload<'_>) {
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
}

/// The main window was just made, out of sight: back where you left it, and maximized as it
/// comes up (see MAXIMIZE_ON_SHOW).
pub(super) fn made(window: &WebviewWindow) {
    MAXIMIZE_ON_SHOW.store(true, Ordering::SeqCst);
    restore(window, StateFlags::SIZE | StateFlags::POSITION);
}

/// A window was closed for good (Hearth's address changed).
pub(super) fn forget(label: &str) {
    PAGES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(label);
    if label == MAIN {
        MAXIMIZE_ON_SHOW.store(false, Ordering::SeqCst);
    }
}

/// The app is quitting. A main window that never came up was never maximized (see
/// MAXIMIZE_ON_SHOW), so the window-state plugin doesn't get to save it: it would forget that you
/// left Hearth maximized. What it saved last time stays.
pub fn quitting(app: &AppHandle) {
    if MAXIMIZE_ON_SHOW.load(Ordering::SeqCst) && !app.remove_plugin(WINDOW_STATE) {
        log::warn!("No {WINDOW_STATE} plugin to take out before quitting");
    }
}

/// Brings the window up, `asked` being when you asked for it. The main one waits for its page
/// (see page_load), but never past SHOW_WITHIN from then, whatever Hearth's server is doing; the
/// small ones come up at once, since you're about to type.
pub(super) async fn show(window: WebviewWindow, asked: Instant) {
    let waits = window.label() == MAIN && !window.is_visible().unwrap_or(false);
    if waits && !page(MAIN, Page::ask) {
        tokio::time::sleep(left(asked, Instant::now())).await;
        if !page(MAIN, Page::waited) {
            // It came up when the page loaded.
            return;
        }
    }
    bring_up(&window);
}

/// How much longer a window you asked for at `asked` may wait for its page.
fn left(asked: Instant, now: Instant) -> Duration {
    (asked + SHOW_WITHIN).saturating_duration_since(now)
}

/// Brings the window up with its page on screen, all in one go on the main thread: a window
/// going out of sight at the same moment (out_of_sight) can't leave it up with its page hidden.
fn bring_up(window: &WebviewWindow) {
    let maximize = window.label() == MAIN && MAXIMIZE_ON_SHOW.swap(false, Ordering::SeqCst);
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        on_screen(&w, true);
        if maximize {
            let _ = w.restore_state(StateFlags::MAXIMIZED);
        }
        // Windows may have changed between light and dark since the window was made.
        let _ = w.set_background_color(Some(backdrop()));
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    });
}

/// A window is out of sight (the main one just made, or put away, or the Ask window put away): its
/// page is told, unless the window has come up meanwhile.
pub(super) fn out_of_sight(window: &WebviewWindow) {
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        if !w.is_visible().unwrap_or(true) {
            on_screen(&w, false);
        }
    });
}

/// A window was closed to the tray (lib.rs). Hearth's main window's page rests until it's back.
/// The Ask window's, put away with Alt+F4, is told too, as when it's put away otherwise
/// (window.rs): it moves itself on to a new Hearth then.
pub fn hidden(window: &tauri::Window) {
    if matches!(window.label(), MAIN | ASK) {
        if let Some(w) = window.app_handle().get_webview_window(window.label()) {
            out_of_sight(&w);
        }
    }
}

/// A window was resized, minimized or put back (lib.rs). Hearth's main window's page rests while
/// it's minimized too, and looks again when it's back. One out of sight is left as it is.
pub fn resized(window: &tauri::Window) {
    if window.label() != MAIN || !window.is_visible().unwrap_or(false) {
        return;
    }
    if let Some(w) = window.app_handle().get_webview_window(MAIN) {
        on_screen(&w, !window.is_minimized().unwrap_or(false));
    }
}

/// Tells the window's page whether it's on screen (document.visibilityState).
fn on_screen(window: &WebviewWindow, seen: bool) {
    #[cfg(windows)]
    {
        let _ = window.with_webview(move |webview| unsafe {
            if let Err(e) = webview.controller().SetIsVisible(seen) {
                log::warn!("Couldn't tell Hearth's page whether it's on screen: {e}");
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (window, seen);
}

/// Puts the main window back as you left it, from the window-state plugin's record. On the main
/// thread, as the plugin does: it holds its lock across calls that wait for that thread.
fn restore(window: &WebviewWindow, flags: StateFlags) {
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        let _ = w.restore_state(flags);
    });
}

/// What a Hearth window shows until its page paints: Hearth's own background, light or dark as
/// Windows has apps now.
pub(super) fn backdrop() -> Color {
    background(dark())
}

/// Hearth's page background (--color-bg in apps/web/src/index.css).
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
    fn the_wait_counts_from_your_click() {
        let asked = Instant::now();
        assert_eq!(left(asked, asked), SHOW_WITHIN);
        let later = asked + Duration::from_millis(120);
        assert_eq!(left(asked, later), SHOW_WITHIN - Duration::from_millis(120));
        // Hearth's server took seconds to answer, or making the window did: no more waiting.
        assert_eq!(left(asked, asked + Duration::from_secs(3)), Duration::ZERO);
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
