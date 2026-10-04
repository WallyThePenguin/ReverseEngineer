// hearth:// links, and where Hearth's windows may go (D53). Any website can open a hearth:// link,
// so everything in one is checked here before the app acts on it: a page is only ever a path on
// the Hearth address set in this app's settings, never an address from the link.

use url::Url;

/// What a hearth:// link asks for.
#[derive(Debug, PartialEq, Eq)]
pub enum Link {
    /// `hearth://open/<path>`: a page of Hearth, like "/inbox" or "/task/<id>".
    Open(String),
    /// `hearth://connect?nonce=…`: connect this PC, with the one-time code Hearth's Settings made.
    Connect(String),
    /// `hearth://settings`: the voice settings window.
    Settings,
    /// `hearth://retry`: the "Hearth isn't running" page's Retry button.
    Retry,
    /// `hearth://close`: a small window (quick capture, ask Jarvis) closing itself.
    Close,
}

const MAX_PATH: usize = 2048;

pub fn parse(raw: &str) -> Result<Link, String> {
    if raw.len() > MAX_PATH + 64 {
        return Err("link too long".into());
    }
    let url = Url::parse(raw).map_err(|_| "not a link".to_string())?;
    if url.scheme() != "hearth" {
        return Err("not a hearth:// link".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err("odd link".into());
    }
    let what = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = url.path();
    match what.as_str() {
        "open" => {
            let mut page = if path.is_empty() { "/" } else { path }.to_string();
            if let Some(q) = url.query() {
                page.push('?');
                page.push_str(q);
            }
            // A link opens a page to look at, never one of Hearth's API addresses.
            let lower = page.to_ascii_lowercase();
            if lower.starts_with("/api/") || lower == "/api" || lower.starts_with("/mcp") {
                return Err(format!("not a page: {page}"));
            }
            relative_path(&page).map(Link::Open)
        }
        "connect" if path.is_empty() || path == "/" => {
            let mut nonces = url.query_pairs().filter(|(k, _)| k == "nonce");
            match (nonces.next(), nonces.next()) {
                (Some((_, n)), None) if is_code(&n) => Ok(Link::Connect(n.into_owned())),
                _ => Err("a connect link needs one nonce".into()),
            }
        }
        "settings" | "retry" | "close" if path.is_empty() || path == "/" => {
            Ok(match what.as_str() {
                "settings" => Link::Settings,
                "retry" => Link::Retry,
                _ => Link::Close,
            })
        }
        _ => Err(format!("unknown link: hearth://{what}")),
    }
}

/// A one-time code or nonce from Hearth: URL-safe base64, as Hearth makes them.
pub fn is_code(s: &str) -> bool {
    (16..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A path on Hearth's own address, like "/inbox" or "/chat?compact=1". It can't name another
/// site ("//evil.example"), climb out ("/../"), or smuggle either past the check encoded.
pub fn relative_path(path: &str) -> Result<String, String> {
    let bad = || Err::<String, String>(format!("not a Hearth page: {path}"));
    if path.is_empty() || path.len() > MAX_PATH || !path.starts_with('/') || path.starts_with("//")
    {
        return bad();
    }
    let allowed = |b: u8| b.is_ascii_alphanumeric() || b"/-_.~+?=&%,:".contains(&b);
    if !path.bytes().all(allowed) {
        return bad();
    }
    let (route, _) = path.split_once('?').unwrap_or((path, ""));
    let lower = path.to_ascii_lowercase();
    if route.contains("//")
        || route.split('/').any(|s| s == "." || s == "..")
        || ["%2e", "%2f", "%5c", "%00"]
            .iter()
            .any(|e| lower.contains(e))
        || route.contains(':')
    {
        return bad();
    }
    Ok(path.to_string())
}

/// The full address of a Hearth page, on Hearth's own address and nowhere else.
pub fn page_url(base: &Url, path: &str) -> Result<Url, String> {
    let path = relative_path(path)?;
    let url = base.join(&path).map_err(|e| e.to_string())?;
    if url.origin() != base.origin() {
        return Err(format!("not a Hearth page: {path}"));
    }
    Ok(url)
}

/// What a Hearth window does when its page tries to go somewhere.
#[derive(Debug, PartialEq, Eq)]
pub enum Nav {
    /// A Hearth page, the blank start, or the built-in "isn't running" page: go.
    Stay,
    /// Somewhere else on the web, or an email address: your browser or mail app opens it.
    Elsewhere,
    /// A hearth:// link: the app handles it.
    Link,
    /// Anything else (file:, javascript:, other apps' links): refused.
    Refuse,
}

pub fn navigation(to: &Url, home: &Url) -> Nav {
    match to.scheme() {
        "http" | "https" if to.origin() == home.origin() => Nav::Stay,
        "http" | "https" | "mailto" => Nav::Elsewhere,
        "about" if to.as_str() == "about:blank" => Nav::Stay,
        // Pages can't open data: addresses at the top of a window themselves (Chromium blocks it),
        // so a data: address here is the built-in page this app showed.
        "data" => Nav::Stay,
        "hearth" => Nav::Link,
        _ => Nav::Refuse,
    }
}

/// The address a hearth:// link uses to open a page, for notifications.
pub fn open_link(path: &str) -> String {
    match relative_path(path) {
        Ok(p) => format!("hearth://open{p}"),
        Err(_) => "hearth://open/inbox".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_hearth_pages() {
        assert_eq!(
            parse("hearth://open/inbox"),
            Ok(Link::Open("/inbox".into()))
        );
        assert_eq!(parse("hearth://open"), Ok(Link::Open("/".into())));
        assert_eq!(
            parse("HEARTH://OPEN/inbox"),
            Ok(Link::Open("/inbox".into()))
        );
        let id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
        assert_eq!(
            parse(&format!("hearth://open/inbox+task/{id}")),
            Ok(Link::Open(format!("/inbox+task/{id}")))
        );
        assert_eq!(
            parse("hearth://open/chat?compact=1"),
            Ok(Link::Open("/chat?compact=1".into()))
        );
        // Anything after # is dropped.
        assert_eq!(
            parse("hearth://open/inbox#<script>"),
            Ok(Link::Open("/inbox".into()))
        );
    }

    #[test]
    fn refuses_pages_elsewhere() {
        for bad in [
            "hearth://open//evil.example/x",
            "hearth://open/%2F%2Fevil.example",
            "hearth://open/..%2F..%2Fapi",
            "hearth://open/a%2e%2e%2fb",
            "hearth://open/a\\b",
            "hearth://open/https://evil.example",
            "hearth://open/javascript:alert(1)",
            "hearth://open/a%00b",
            "hearth://user@open/inbox",
            "hearth://open:99/inbox",
            "hearth:open/inbox",
            "https://open/inbox",
            "hearth://evil.example/inbox",
            "hearth://settings/x",
            "hearth://open/api/auth/desktop/window?code=abcdefghijklmnopqrstuvwx",
            "hearth://open/API/devices",
            "hearth://open/mcp",
        ] {
            assert!(!matches!(parse(bad), Ok(Link::Open(_))), "{bad}");
        }
        // A link's own ".." segments are resolved first, and can't climb above Hearth's root.
        assert_eq!(
            parse("hearth://open/%2e%2e/../inbox"),
            Ok(Link::Open("/inbox".into()))
        );
        assert!(relative_path("/../x").is_err());
        assert!(relative_path("/a/./b").is_err());
        assert!(relative_path("inbox").is_err());
        assert!(relative_path("/inbox x").is_err());
        assert!(relative_path(&format!("/{}", "a".repeat(3000))).is_err());
    }

    #[test]
    fn reads_connect_links() {
        let nonce = "AbCdEfGhIjKlMnOpQrStUv-_0123456789";
        assert_eq!(
            parse(&format!("hearth://connect?nonce={nonce}")),
            Ok(Link::Connect(nonce.into()))
        );
        assert!(parse("hearth://connect").is_err());
        assert!(parse("hearth://connect?nonce=short").is_err());
        assert!(parse("hearth://connect?nonce=has%20space%20in%20it-xxxxxxxx").is_err());
        assert!(parse(&format!("hearth://connect?nonce={nonce}&nonce={nonce}")).is_err());
        // The link never carries an address: anything else in it is ignored, not used.
        assert_eq!(
            parse(&format!(
                "hearth://connect?nonce={nonce}&server=https://evil.example"
            )),
            Ok(Link::Connect(nonce.into()))
        );
    }

    #[test]
    fn reads_the_small_links() {
        assert_eq!(parse("hearth://settings"), Ok(Link::Settings));
        assert_eq!(parse("hearth://settings/"), Ok(Link::Settings));
        assert_eq!(parse("hearth://retry"), Ok(Link::Retry));
        assert_eq!(parse("hearth://close"), Ok(Link::Close));
        assert!(parse("hearth://nope").is_err());
        assert!(parse("not a link").is_err());
    }

    #[test]
    fn page_urls_stay_on_hearth() {
        let base: Url = "http://localhost:4400".parse().unwrap();
        assert_eq!(
            page_url(&base, "/api/auth/desktop/window?code=abc")
                .unwrap()
                .as_str(),
            "http://localhost:4400/api/auth/desktop/window?code=abc"
        );
        assert!(page_url(&base, "//evil.example").is_err());
        assert!(page_url(&base, "https://evil.example").is_err());
    }

    #[test]
    fn decides_where_windows_go() {
        let home: Url = "http://localhost:4400".parse().unwrap();
        let nav = |s: &str| navigation(&s.parse().unwrap(), &home);
        assert_eq!(nav("http://localhost:4400/inbox"), Nav::Stay);
        assert_eq!(nav("about:blank"), Nav::Stay);
        assert_eq!(nav("data:text/html,hi"), Nav::Stay);
        assert_eq!(nav("http://127.0.0.1:4400/inbox"), Nav::Elsewhere);
        assert_eq!(nav("https://example.com/"), Nav::Elsewhere);
        assert_eq!(nav("mailto:a@example.com"), Nav::Elsewhere);
        assert_eq!(nav("hearth://close"), Nav::Link);
        assert_eq!(nav("file:///C:/Windows/win.ini"), Nav::Refuse);
        assert_eq!(nav("javascript:alert(1)"), Nav::Refuse);
        assert_eq!(nav("about:srcdoc"), Nav::Refuse);
    }

    #[test]
    fn notification_links_open_pages() {
        assert_eq!(open_link("/inbox"), "hearth://open/inbox");
        assert_eq!(open_link("//evil.example"), "hearth://open/inbox");
    }

    #[test]
    fn codes_are_url_safe() {
        assert!(is_code("abcdefghijklmnop"));
        assert!(!is_code("abc"));
        assert!(!is_code("abcdefghijklmnop/"));
    }
}
