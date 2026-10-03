// Speech for the phone (Hearth's D46): Hearth has no speech engine, so this app takes the
// recordings you make on your phone or in a browser, transcribes them with the engine it already
// has loaded, and sends the text back. It runs whenever the app is paired; nothing is kept.

use super::bakeoff::to_16k_mono;
use super::link;
use crate::managers::transcription::TranscriptionManager;
use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The longest recording it takes, so one clip can't hold the engine for long.
const MAX_SECONDS: usize = 5 * 60;

/// Starts the loop that waits for recordings. Call once at startup.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let Some(h) = link(&app) else {
                tokio::time::sleep(Duration::from_secs(15)).await;
                continue;
            };
            match h.next_speech().await {
                Ok(Some((id, wav))) => {
                    let tm = app.state::<Arc<TranscriptionManager>>().inner().clone();
                    let text = tauri::async_runtime::spawn_blocking(move || transcribe(&tm, &wav))
                        .await
                        .unwrap_or_else(|e| Err(e.to_string()));
                    if let Err(e) = h.answer_speech(&id, text).await {
                        log::warn!("Phone speech: {e}");
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    log::debug!("Phone speech: {e}");
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
            }
        }
    });
}

/// 16 kHz mono samples from a WAV file's bytes.
pub fn samples(wav: &[u8]) -> Result<Vec<f32>, String> {
    let reader = hound::WavReader::new(Cursor::new(wav)).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err("Send 16-bit WAV audio.".into());
    }
    let raw: Vec<f32> = reader
        .into_samples::<i16>()
        .take(MAX_SECONDS * spec.sample_rate as usize * spec.channels as usize)
        .map(|s| s.map(|v| v as f32 / i16::MAX as f32))
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(to_16k_mono(&raw, spec.channels as usize, spec.sample_rate))
}

fn transcribe(tm: &TranscriptionManager, wav: &[u8]) -> Result<String, String> {
    let audio = samples(wav)?;
    if !tm.is_model_loaded() {
        tm.initiate_model_load();
    }
    // The model may still be loading; give it a moment.
    for _ in 0..15 {
        match tm.transcribe(audio.clone()) {
            Ok(text) => return Ok(text.trim().to_string()),
            Err(e) if tm.is_model_loaded() => return Err(e.to_string()),
            Err(_) => std::thread::sleep(Duration::from_secs(2)),
        }
    }
    Err("The speech model on the PC didn't load.".into())
}

#[cfg(test)]
mod tests {
    use super::samples;

    fn wav(rate: u32, channels: u16, n: usize) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        let spec = hound::WavSpec {
            channels,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::new(&mut out, spec).unwrap();
        for i in 0..n * channels as usize {
            w.write_sample((i % 100) as i16).unwrap();
        }
        w.finalize().unwrap();
        out.into_inner()
    }
    use std::io::Cursor;

    #[test]
    fn reads_wav_into_16k_mono() {
        assert_eq!(samples(&wav(16_000, 1, 16_000)).unwrap().len(), 16_000);
        assert_eq!(samples(&wav(48_000, 2, 48_000)).unwrap().len(), 16_000);
        assert!(samples(b"not a wav").is_err());
    }
}
