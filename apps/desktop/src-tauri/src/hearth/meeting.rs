// The meeting recorder (Hearth PLAN.md section 7.3): your microphone and what this PC plays
// (WASAPI loopback) as two channels, "me" and "them", so the transcript knows who spoke without
// a diarization model. Each channel is cut at pauses, transcribed here with the same engine as
// dictation, and added to the meeting in Hearth. A segment's id is its channel and where it
// starts, so sending it again never duplicates it. When you stop, the meeting ends and Jarvis
// writes the summary.

use super::capture::{microphone, open};
use super::chunker::{Chunker, Piece, RATE};
use super::client::Hearth;
use super::{link, speak, tell};
use crate::audio_toolkit::audio::FrameResampler;
use crate::audio_toolkit::get_cpal_host;
use crate::managers::transcription::TranscriptionManager;
use cpal::traits::HostTrait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{
    channel, sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError,
};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// The longest a recording runs before it stops by itself.
const MAX_LENGTH: Duration = Duration::from_secs(4 * 60 * 60);
/// Pieces waiting to be transcribed (up to about ten minutes of audio); past that they're dropped.
const MAX_WAITING: usize = 40;
/// Segments kept for another try when Hearth can't be reached.
const MAX_UNSENT: usize = 2_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Me,
    Them,
}

impl Channel {
    fn name(self) -> &'static str {
        match self {
            Channel::Me => "me",
            Channel::Them => "them",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recording {
    id: String,
    title: String,
    offset_ms: u64,
}

/// Set while a recording runs; setting the flag stops it.
static RUNNING: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

pub fn recording() -> bool {
    RUNNING.lock().map(|r| r.is_some()).unwrap_or(false)
}

fn done(app: &AppHandle, stop: &Arc<AtomicBool>) {
    if let Ok(mut r) = RUNNING.lock() {
        if r.as_ref().is_some_and(|s| Arc::ptr_eq(s, stop)) {
            *r = None;
        }
    }
    crate::tray::update_tray_menu(app);
}

/// The tray item: starts recording the meeting you're in, or stops it.
pub fn toggle(app: &AppHandle) {
    let running = RUNNING.lock().ok().and_then(|mut r| r.take());
    if let Some(stop) = running {
        stop.store(true, Ordering::SeqCst);
        crate::tray::update_tray_menu(app);
        return;
    }
    let Some(h) = link(app) else {
        tell(
            app,
            "Pair the app with Nook in Settings to record meetings.",
        );
        return;
    };
    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut r) = RUNNING.lock() {
        *r = Some(stop.clone());
    }
    crate::tray::update_tray_menu(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let rec = match start(&h).await {
            Ok(rec) => rec,
            Err(e) => {
                tell(&app, &e);
                done(&app, &stop);
                return;
            }
        };
        app.state::<Arc<TranscriptionManager>>()
            .initiate_model_load();
        // Recording laws vary; the app reminds you to say so.
        speak::say(&format!(
            "Recording {}. Let everyone know you're taking notes.",
            rec.title
        ));
        super::window::open(&app, &format!("/record/{}", rec.id));
        std::thread::spawn(move || {
            if let Err(e) = record(&app, &h, &rec, &stop) {
                // Don't leave the meeting open: a later recording would join it.
                let _ = block(h.call(
                    "meeting.end",
                    json!({ "id": rec.id }),
                    Duration::from_secs(10),
                ));
                tell(&app, &format!("The meeting recording stopped: {e}"));
            }
            done(&app, &stop);
        });
    });
}

async fn start(h: &Hearth) -> Result<Recording, String> {
    let v = h
        .call("meeting.record", json!({}), Duration::from_secs(10))
        .await?;
    let rec: Recording = serde_json::from_value(v).map_err(|e| e.to_string())?;
    if !is_id(&rec.id) {
        return Err("Nook answered with an odd meeting id.".into());
    }
    Ok(rec)
}

fn is_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// One channel on its way to text: resampled to 16 kHz and cut into pieces.
type Pieces = SyncSender<(Channel, Piece)>;

struct Track {
    channel: Channel,
    resampler: FrameResampler,
    chunker: Chunker,
    /// 16 kHz samples so far, silence included.
    written: usize,
    /// Pieces left out because transcription fell too far behind.
    dropped: usize,
}

impl Track {
    fn new(channel: Channel, rate: u32) -> Self {
        Track {
            channel,
            resampler: FrameResampler::new(rate as usize, RATE, Duration::from_millis(100)),
            chunker: Chunker::default(),
            written: 0,
            dropped: 0,
        }
    }

    fn push(&mut self, samples: &[f32], out: &Pieces) {
        let mut audio = Vec::new();
        self.resampler.push(samples, |f| audio.extend_from_slice(f));
        self.feed(&audio, out);
    }

    fn feed(&mut self, audio: &[f32], out: &Pieces) {
        self.written += audio.len();
        for piece in self.chunker.push(audio) {
            self.send(piece, out);
        }
    }

    /// Loopback sends nothing while nothing plays; that's silence, and time still passes.
    fn catch_up(&mut self, elapsed: Duration, out: &Pieces) {
        let due = (elapsed.as_secs_f64() * RATE as f64) as usize;
        let behind = due.saturating_sub(self.written);
        if behind > RATE / 2 {
            self.feed(&vec![0.0; behind - RATE / 4], out);
        }
    }

    fn send(&mut self, piece: Piece, out: &Pieces) {
        if let Err(TrySendError::Full(_)) = out.try_send((self.channel, piece)) {
            self.dropped += 1;
        }
    }

    fn finish(mut self, out: &Pieces) -> usize {
        let mut audio = Vec::new();
        self.resampler.finish(|f| audio.extend_from_slice(f));
        self.feed(&audio, out);
        if let Some(piece) = self.chunker.flush() {
            self.send(piece, out);
        }
        self.dropped
    }
}

fn record(app: &AppHandle, h: &Hearth, rec: &Recording, stop: &AtomicBool) -> Result<(), String> {
    let host = get_cpal_host();
    let (tx, rx) = channel::<(Channel, Vec<f32>)>();
    let mic = microphone(app, &host).ok_or("no microphone was found")?;
    let (mic_stream, mic_rate) = open(&mic, Channel::Me, false, tx.clone())?;
    let mut tracks = vec![Track::new(Channel::Me, mic_rate)];
    // An input stream on the output device is WASAPI's loopback: what the other side says.
    let them = host
        .default_output_device()
        .ok_or_else(|| "no speakers or headphones were found".to_string())
        .and_then(|d| open(&d, Channel::Them, true, tx.clone()));
    let them_stream = match them {
        Ok((stream, rate)) => {
            tracks.push(Track::new(Channel::Them, rate));
            Some(stream)
        }
        Err(e) => {
            tell(app, &format!("Recording only your microphone: {e}"));
            None
        }
    };
    drop(tx);

    let (pieces, queue) = sync_channel::<(Channel, Piece)>(MAX_WAITING);
    let worker = {
        let (app, h, id) = (app.clone(), h.clone(), rec.id.clone());
        let offset = rec.offset_ms;
        std::thread::spawn(move || transcribe_all(&app, &h, &id, offset, queue))
    };
    let started = Instant::now();
    while !stop.load(Ordering::SeqCst) && started.elapsed() < MAX_LENGTH {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok((channel, samples)) => {
                if let Some(t) = tracks.iter_mut().find(|t| t.channel == channel) {
                    t.push(&samples, &pieces);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        for t in &mut tracks {
            t.catch_up(started.elapsed(), &pieces);
        }
    }
    drop(mic_stream);
    drop(them_stream);
    tell(app, "Stopped recording. Finishing the transcript…");
    let dropped: usize = tracks.into_iter().map(|t| t.finish(&pieces)).sum();
    drop(pieces);
    let unsent = worker
        .join()
        .map_err(|_| "transcribing the meeting failed".to_string())?;
    block(h.call(
        "meeting.end",
        json!({ "id": rec.id }),
        Duration::from_secs(10),
    ))?;
    if unsent + dropped > 0 {
        return Err(format!(
            "{} parts of the transcript are missing.",
            unsent + dropped
        ));
    }
    speak::say("Stopped recording. Pip is writing the summary.");
    Ok(())
}

fn block<T>(f: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(f)
}

/// Turns pieces into text and sends them to the meeting. Returns how many never got there.
fn transcribe_all(
    app: &AppHandle,
    h: &Hearth,
    id: &str,
    offset_ms: u64,
    queue: Receiver<(Channel, Piece)>,
) -> usize {
    let tm = app.state::<Arc<TranscriptionManager>>().inner().clone();
    let mut unsent: Vec<Value> = Vec::new();
    let mut lost = 0;
    let mut failing = 0;
    for (channel, piece) in queue {
        // Once the engine keeps failing, stop waiting on it for every piece.
        let tries = if failing >= 3 { 1 } else { 15 };
        let text = match transcribe(&tm, &piece, tries) {
            Ok(Some(text)) => {
                failing = 0;
                text
            }
            Ok(None) => continue,
            Err(()) => {
                failing += 1;
                lost += 1;
                continue;
            }
        };
        unsent.push(segment(channel, &piece, offset_ms, &text));
        if unsent.len() > MAX_UNSENT {
            unsent.remove(0);
            lost += 1;
        }
        if send(h, id, &unsent).is_ok() {
            unsent.clear();
        }
    }
    // One more try for whatever Hearth didn't take while it ran.
    if !unsent.is_empty() && send(h, id, &unsent).is_ok() {
        unsent.clear();
    }
    unsent.len() + lost
}

/// The piece's words (None if it held none), or Err when the engine failed every try.
fn transcribe(
    tm: &TranscriptionManager,
    piece: &Piece,
    tries: usize,
) -> Result<Option<String>, ()> {
    // The model may be loading, or unloaded after idling; give it a moment.
    for _ in 0..tries {
        match tm.transcribe(piece.audio.clone()) {
            Ok(text) => {
                let text = text.trim().to_string();
                return Ok((!text.is_empty()).then_some(text));
            }
            Err(e) => {
                log::warn!("Meeting transcription: {e}");
                if !tm.is_model_loaded() {
                    tm.initiate_model_load();
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    }
    Err(())
}

fn segment(channel: Channel, piece: &Piece, offset_ms: u64, text: &str) -> Value {
    let start = offset_ms + piece.start_ms();
    json!({
        "id": format!("{}:{start}", channel.name()),
        "channel": channel.name(),
        "startMs": start,
        "endMs": offset_ms + piece.end_ms(),
        "text": text.chars().take(5000).collect::<String>(),
    })
}

fn send(h: &Hearth, id: &str, segments: &[Value]) -> Result<(), String> {
    for part in segments.chunks(200) {
        block(h.call(
            "meeting.add_segments",
            json!({ "id": id, "segments": part }),
            Duration::from_secs(15),
        ))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_are_named_by_channel_and_start() {
        let piece = Piece {
            start: RATE * 3,
            audio: vec![0.0; RATE * 2],
        };
        let s = segment(Channel::Them, &piece, 60_000, "Hi");
        assert_eq!(s["id"], "them:63000");
        assert_eq!(s["startMs"], 63_000);
        assert_eq!(s["endMs"], 65_000);
    }

    #[test]
    fn checks_meeting_ids() {
        assert!(is_id("0b9d8f3e-1c2a-4e5f-9a7b-123456789abc"));
        assert!(!is_id("../../settings"));
    }
}
