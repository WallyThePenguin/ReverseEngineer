// Jarvis's answers read aloud, one message at a time, with the voice built into Windows (SAPI).
// Elsewhere it stays quiet; the answer still shows in Hearth.

use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};

static VOICE: OnceLock<Mutex<Sender<String>>> = OnceLock::new();

/// Queues text to be spoken after anything already queued.
pub fn say(text: &str) {
    let text = speakable(text);
    if text.is_empty() {
        return;
    }
    let tx = VOICE.get_or_init(|| {
        let (tx, rx) = channel::<String>();
        std::thread::spawn(move || run(rx));
        Mutex::new(tx)
    });
    if let Ok(tx) = tx.lock() {
        let _ = tx.send(text);
    }
}

#[cfg(windows)]
fn run(rx: std::sync::mpsc::Receiver<String>) {
    use windows::core::HSTRING;
    use windows::Win32::Media::Speech::{ISpVoice, SpVoice};
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
        for text in rx {
            if let Err(e) = voice.Speak(&HSTRING::from(text), 0, None) {
                log::warn!("Couldn't speak: {e}");
            }
        }
    }
}

#[cfg(not(windows))]
fn run(rx: std::sync::mpsc::Receiver<String>) {
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
