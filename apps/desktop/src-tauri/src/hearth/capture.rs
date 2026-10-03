// The meeting recorder's two sources: your microphone, and what this PC plays through a WASAPI
// loopback stream, each as mono samples at the device's own rate.

use super::meeting::Channel;
use crate::settings::get_settings;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::mpsc::Sender;
use tauri::AppHandle;

/// The microphone chosen in Settings, else the default one.
pub fn microphone(app: &AppHandle, host: &cpal::Host) -> Option<cpal::Device> {
    if let Some(name) = get_settings(app).selected_microphone {
        let chosen = host
            .input_devices()
            .ok()
            .and_then(|mut all| all.find(|d| d.name().ok().as_deref() == Some(name.as_str())));
        if chosen.is_some() {
            return chosen;
        }
    }
    host.default_input_device()
}

pub fn open(
    device: &cpal::Device,
    channel: Channel,
    loopback: bool,
    tx: Sender<(Channel, Vec<f32>)>,
) -> Result<(cpal::Stream, u32), String> {
    let config = if loopback {
        device.default_output_config()
    } else {
        device.default_input_config()
    }
    .map_err(|e| e.to_string())?;
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    let stream = match format {
        cpal::SampleFormat::F32 => build::<f32>(device, &config, channels, channel, tx),
        cpal::SampleFormat::I16 => build::<i16>(device, &config, channels, channel, tx),
        cpal::SampleFormat::I32 => build::<i32>(device, &config, channels, channel, tx),
        cpal::SampleFormat::U16 => build::<u16>(device, &config, channels, channel, tx),
        other => return Err(format!("unsupported audio format {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, rate))
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    channel: Channel,
    tx: Sender<(Channel, Vec<f32>)>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let mono: Vec<f32> = data
                .chunks(channels.max(1))
                .map(|f| f.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / f.len() as f32)
                .collect();
            let _ = tx.send((channel, mono));
        },
        move |e| log::warn!("Meeting audio ({channel:?}): {e}"),
        None,
    )
}
