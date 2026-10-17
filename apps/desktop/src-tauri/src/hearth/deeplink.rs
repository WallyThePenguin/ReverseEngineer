// hearth:// links (D53). Windows starts this app with the link; when it's already running, the
// second copy hands the link to this one (single-instance) and exits. Any website or program can
// open a hearth:// link, so every part of one is untrusted: links::parse checks it, a page only
// ever opens on the Hearth address in this app's settings, and connecting this PC asks you first
// and then talks only to that address, never to one from the link.

use super::client::redeem;
use super::links::{self, Link};
use super::{check_address, offline, tell, toast, window, DESKTOP_KEY};
use crate::settings::{get_settings, write_settings};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
use tauri_plugin_deep_link::DeepLinkExt;

/// A connect is waiting for your answer or running; another link to connect is ignored.
static CONNECTING: AtomicBool = AtomicBool::new(false);

/// Starts listening for links. True when the app was started by one (already handled).
///
/// Development builds aren't registered for hearth:// (the installer does that), on purpose: a
/// dev build registering itself would take the links away from the installed app.
pub fn init(app: &AppHandle) -> bool {
    let app2 = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle(&app2, url.as_str());
        }
    });
    match app.deep_link().get_current() {
        Ok(Some(urls)) if !urls.is_empty() => {
            for url in urls {
                handle(app, url.as_str());
            }
            true
        }
        _ => false,
    }
}

/// Whether a second copy's arguments are a link (handled by the deep-link plugin, not here).
pub fn is_link_arg(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| {
        a.get(..7)
            .is_some_and(|s| s.eq_ignore_ascii_case("hearth:"))
    })
}

/// Acts on a link: from a notification, a browser, another program or a Hearth page.
pub fn handle(app: &AppHandle, raw: &str) {
    match links::parse(raw) {
        Ok(Link::Open(path)) => window::open(app, &path),
        Ok(Link::Connect(nonce)) => connect(app, nonce),
        Ok(Link::Settings) => crate::show_main_window(app),
        Ok(Link::Retry) => offline::retry(app),
        // Only Hearth's small windows close themselves; a link from outside can't.
        Ok(Link::Close) => {}
        Err(e) => log::warn!("Ignored a hearth:// link: {e}"),
    }
}

fn connect(app: &AppHandle, nonce: String) {
    if CONNECTING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = connect_now(&app, &nonce).await {
            tell(&app, &e);
        }
        CONNECTING.store(false, Ordering::SeqCst);
    });
}

async fn connect_now(app: &AppHandle, nonce: &str) -> Result<(), String> {
    // The address in this app's settings: a link can't say where to connect.
    let home = check_address(get_settings(app).hearth_url.trim_end_matches('/'))
        .map_err(|_| "Set Nook's address in voice settings, then connect again.".to_string())?;
    let base = home.origin().ascii_serialization();
    if !confirm(app, &base).await {
        return Ok(());
    }
    let connected = redeem(&base, nonce).await?;
    if connected.token.trim().is_empty() || !links::is_code(&connected.code) {
        return Err("Nook's answer didn't make sense. Try connecting again.".into());
    }
    let mut s = get_settings(app);
    s.hearth_keys
        .insert(DESKTOP_KEY.to_string(), connected.token);
    write_settings(app, s);
    // The window signs in with the one-time code; Hearth sets its session and opens the inbox.
    window::open(
        app,
        &format!("/api/auth/desktop/window?code={}", connected.code),
    );
    toast::show(
        app,
        "This PC is connected",
        "Nook's window, notifications and voice now work here.",
        None,
    );
    Ok(())
}

/// Asks before connecting, so a link from some website can't do it unnoticed.
async fn confirm(app: &AppHandle, base: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "Connect this PC to Nook at {base}?\n\nChoose Connect only if you just \
             clicked \"Connect Nook on this PC\" in Nook's Settings."
        ))
        .title("Connect Nook")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Connect".into(),
            "Cancel".into(),
        ))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    rx.await.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::is_link_arg;

    #[test]
    fn spots_links_among_arguments() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_link_arg(&args(&["hearth.exe", "hearth://open/inbox"])));
        assert!(is_link_arg(&args(&["hearth.exe", "HEARTH://settings"])));
        assert!(!is_link_arg(&args(&["hearth.exe"])));
        assert!(!is_link_arg(&args(&["hearth.exe", "--start-hidden"])));
        assert!(!is_link_arg(&args(&["hearth:"])));
    }
}
