// When Hearth's server doesn't answer, its windows show a built-in "Hearth isn't running" page
// (it works with the server down, in Hearth's own colours) and open the page they were asked for
// once it answers again.

use super::client::healthy;
use super::window::MAIN;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Url, WebviewWindow};

/// The windows waiting for Hearth to answer, with the page each will open then.
static WAITING: Mutex<Option<HashMap<String, Url>>> = Mutex::new(None);
static WATCHING: AtomicBool = AtomicBool::new(false);

/// Opens the page if Hearth answers, else the "isn't running" page until it does.
pub(super) async fn load(app: &AppHandle, window: &WebviewWindow, page: Url) {
    let label = window.label().to_string();
    if healthy(page.origin().ascii_serialization().as_str()).await {
        stop_waiting(&label);
        let _ = window.navigate(page);
    } else {
        start_waiting(app, &label, page);
        let _ = window.navigate(offline_page(&label));
    }
}

/// The "isn't running" page's Retry button: look again now.
pub fn retry(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        reopen_if_up(&app).await;
    });
}

pub(super) fn is_waiting(label: &str) -> bool {
    WAITING
        .lock()
        .ok()
        .and_then(|w| w.as_ref().map(|m| m.contains_key(label)))
        .unwrap_or(false)
}

pub(super) fn stop_waiting(label: &str) {
    if let Ok(mut w) = WAITING.lock() {
        if let Some(m) = w.as_mut() {
            m.remove(label);
        }
    }
}

fn start_waiting(app: &AppHandle, label: &str, page: Url) {
    if let Ok(mut w) = WAITING.lock() {
        w.get_or_insert_with(HashMap::new)
            .insert(label.to_string(), page);
    }
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if !reopen_if_up(&app).await {
                WATCHING.store(false, Ordering::SeqCst);
                // Something may have started waiting just now; if so, keep watching.
                if !waiting_pages().is_empty() && !WATCHING.swap(true, Ordering::SeqCst) {
                    continue;
                }
                break;
            }
        }
    });
}

fn waiting_pages() -> Vec<(String, Url)> {
    WAITING
        .lock()
        .ok()
        .and_then(|w| w.as_ref().map(|m| m.clone().into_iter().collect()))
        .unwrap_or_default()
}

/// Opens the waiting pages if Hearth answers now. False when nothing is waiting any more.
async fn reopen_if_up(app: &AppHandle) -> bool {
    let pages = waiting_pages();
    let Some((_, first)) = pages.first() else {
        return false;
    };
    if !healthy(&first.origin().ascii_serialization()).await {
        return true;
    }
    for (label, page) in pages {
        stop_waiting(&label);
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.navigate(page);
        }
    }
    false
}

/// The page shown while Hearth doesn't answer.
fn offline_page(label: &str) -> Url {
    let small = label != MAIN;
    let html = format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Hearth isn't running</title>
<style>
:root{{color-scheme:light dark;font-family:"Segoe UI",system-ui,sans-serif}}
body{{margin:0;display:grid;place-items:center;min-height:100vh;background:#faf8f5;color:#1f1b16}}
@media (prefers-color-scheme:dark){{body{{background:#15130f;color:#ece7df}}}}
main{{max-width:30rem;padding:{pad};text-align:center}}
h1{{font-size:{h}rem;font-weight:600;margin:0 0 .5rem}}
p{{margin:.25rem 0 1rem;opacity:.8;line-height:1.4}}
a{{display:inline-block;padding:.5rem 1.25rem;border-radius:.5rem;background:#c2410c;color:#fff;text-decoration:none;font-weight:600}}
</style></head><body><main>
<h1>Hearth isn't running</h1>
<p>Hearth's server on this PC didn't answer. This page tries again every few seconds.</p>
{more}
<a href="hearth://retry">Retry</a>
</main></body></html>"#,
        pad = if small { "1rem" } else { "2rem" },
        h = if small { "1.1" } else { "1.5" },
        more = if small {
            ""
        } else {
            "<p>If it doesn't come back, right-click the Hearth icon by the clock and choose \
             Restart Hearth services.</p>"
        },
    );
    format!("data:text/html;charset=utf-8,{}", percent_encode(&html))
        .parse()
        .expect("a data: address")
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::links::{self, Nav};
    use super::super::window::CAPTURE;
    use super::*;

    #[test]
    fn offline_page_is_a_data_address_with_retry() {
        let page = offline_page(MAIN);
        assert_eq!(page.scheme(), "data");
        let home: Url = "http://localhost:4400".parse().unwrap();
        assert_eq!(links::navigation(&page, &home), Nav::Stay);
        let text = page.as_str();
        assert!(text.contains("Hearth%20isn%27t%20running"));
        assert!(text.contains("hearth%3A%2F%2Fretry"));
        // Hearth's background, light and dark, as its window has before a page paints.
        assert!(text.contains("%23faf8f5") && text.contains("%2315130f"));
        assert!(!offline_page(CAPTURE).as_str().contains("Restart%20Hearth"));
    }

    #[test]
    fn encodes_everything_but_plain_characters() {
        assert_eq!(percent_encode("a b<\"é"), "a%20b%3C%22%C3%A9");
    }

    #[test]
    fn remembers_waiting_windows() {
        let page: Url = "http://localhost:4400/inbox".parse().unwrap();
        if let Ok(mut w) = WAITING.lock() {
            w.get_or_insert_with(HashMap::new)
                .insert("test_window".into(), page.clone());
        }
        assert!(is_waiting("test_window"));
        assert!(waiting_pages().contains(&("test_window".to_string(), page)));
        stop_waiting("test_window");
        assert!(!is_waiting("test_window"));
    }
}
