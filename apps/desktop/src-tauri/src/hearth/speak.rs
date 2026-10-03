// Jarvis's answers read aloud, one message at a time, with the voice built into Windows (SAPI).
// Elsewhere it stays quiet; the answer still shows in Hearth.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};

static VOICE: OnceLock<Mutex<Sender<(u64, String)>>> = OnceLock::new();
/// Bumped to stop talking: anything queued before it is dropped.
static HUSH: AtomicU64 = AtomicU64::new(0);
/// The most read aloud from one message.
const MAX_SPOKEN: usize = 2_000;

/// Queues text to be spoken after anything already queued.
pub fn say(text: &str) {
    let text: String = speakable(text).chars().take(MAX_SPOKEN).collect();
    if text.is_empty() {
        return;
    }
    let tx = VOICE.get_or_init(|| {
        let (tx, rx) = channel::<(u64, String)>();
        std::thread::spawn(move || run(rx));
        Mutex::new(tx)
    });
    if let Ok(tx) = tx.lock() {
        let _ = tx.send((HUSH.load(Ordering::SeqCst), text));
    }
}

/// Stops talking now and drops what's queued (any hotkey press).
pub fn stop() {
    HUSH.fetch_add(1, Ordering::SeqCst);
}

#[cfg_attr(not(windows), allow(dead_code))]
fn hushed(since: u64) -> bool {
    HUSH.load(Ordering::SeqCst) != since
}

#[cfg(windows)]
fn run(rx: std::sync::mpsc::Receiver<(u64, String)>) {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Media::Speech::{
        ISpVoice, SpVoice, SPF_ASYNC, SPF_IS_NOT_XML, SPF_PURGEBEFORESPEAK,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let voice: ISpVoice = match CoCreateInstance(&SpVoice, None, CLSCTX_ALL) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("No Windows voice: {e}");
                return;
            }
        };
        // Plain text, never SAPI markup, so a reply can't change the voice or volume.
        let flags = (SPF_ASYNC.0 | SPF_IS_NOT_XML.0) as u32;
        for (at, text) in rx {
            if hushed(at) {
                continue;
            }
            if let Err(e) = voice.Speak(&HSTRING::from(text), flags, None) {
                log::warn!("Couldn't speak: {e}");
                continue;
            }
            // Wait in short steps so a hotkey press can cut it off. The raw call, because the
            // wrapper turns "still speaking" (S_FALSE) into Ok.
            let wait = || {
                (windows::core::Interface::vtable(&voice).WaitUntilDone)(
                    windows::core::Interface::as_raw(&voice),
                    100,
                )
            };
            while wait() == windows::Win32::Foundation::S_FALSE {
                if hushed(at) {
                    let _ = voice.Speak(PCWSTR::null(), SPF_PURGEBEFORESPEAK.0 as u32, None);
                    break;
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn run(rx: std::sync::mpsc::Receiver<(u64, String)>) {
    for _ in rx {}
}

/// Markdown and links read badly; keep the words.
pub fn speakable(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let line = line.trim_start_matches(['#', '>', '-', '*', ' ']);
        out.push_str(line);
        out.push(' ');
    }
    let out = out.replace(['*', '`', '_'], "");
    let re = regex::Regex::new(r"\[([^\]]*)\]\([^)]*\)|https?://\S+").unwrap();
    let out = re.replace_all(&out, |c: &regex::Captures| {
        c.get(1)
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| "a link".into())
    });
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::speakable;

    #[test]
    fn reads_words_not_markdown() {
        assert_eq!(
            speakable(
                "## Today\n- **Dentist** at 3, see [the invite](https://x.y/z)\n- https://a.b"
            ),
            "Today Dentist at 3, see the invite a link"
        );
    }
}
