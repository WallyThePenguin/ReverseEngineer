// Windows notifications (D53). Clicking one goes through Windows: its launch address is a
// hearth:// link, which Windows hands to this app the same way as a link clicked anywhere else,
// so a click lands in deeplink.rs and is checked there like any other link.

use tauri::AppHandle;

const MAX_TITLE: usize = 120;
const MAX_BODY: usize = 300;

/// Shows a notification. `link` is a hearth:// link to open when it's clicked.
pub fn show(app: &AppHandle, title: &str, body: &str, link: Option<&str>) {
    let xml = toast_xml(title, body, link);
    #[cfg(windows)]
    {
        // Windows shows notifications for an app by its id, which the installer puts on the
        // Start menu shortcut: the app's identifier.
        let id = app.config().identifier.clone();
        std::thread::spawn(move || {
            if let Err(e) = show_on_windows(&id, &xml) {
                log::warn!("Couldn't show a notification: {e}");
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app, xml);
        log::info!("{title}: {body}");
    }
}

#[cfg(windows)]
fn show_on_windows(app_id: &str, xml: &str) -> windows::core::Result<()> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(xml))?;
    let toast = ToastNotification::CreateToastNotification(&doc)?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)
}

/// The notification, in the XML Windows reads.
pub fn toast_xml(title: &str, body: &str, link: Option<&str>) -> String {
    let launch = link
        .map(|l| format!(r#" launch="{}" activationType="protocol""#, escape(l)))
        .unwrap_or_default();
    format!(
        r#"<toast{launch}><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
        escape(&clip(title, MAX_TITLE)),
        escape(&clip(body, MAX_BODY)),
    )
}

fn clip(s: &str, max: usize) -> String {
    let s: String = s
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .collect();
    if s.chars().count() <= max {
        return s;
    }
    let mut out: String = s.chars().take(max - 1).collect();
    out.push('…');
    out
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if c.is_control() && c != '\n' => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_plain_text_safely() {
        let xml = toast_xml("Jarvis <needs> a \"yes\"", "Pay & go\u{7}", None);
        assert_eq!(
            xml,
            "<toast><visual><binding template=\"ToastGeneric\"><text>Jarvis &lt;needs&gt; a &quot;yes&quot;</text><text>Pay &amp; go</text></binding></visual></toast>"
        );
    }

    #[test]
    fn opens_a_link_when_clicked() {
        let xml = toast_xml("Hi", "There", Some("hearth://open/inbox?a=1&b=2"));
        assert!(xml.starts_with(
            "<toast launch=\"hearth://open/inbox?a=1&amp;b=2\" activationType=\"protocol\">"
        ));
    }

    #[test]
    fn keeps_it_short() {
        let xml = toast_xml(&"t".repeat(500), &"b".repeat(500), None);
        assert!(xml.contains(&format!("{}…", "t".repeat(MAX_TITLE - 1))));
        assert!(!xml.contains(&"b".repeat(MAX_BODY)));
    }
}
