# Hearth Desktop

Hearth's desktop app: dictation into any app, voice commands to Jarvis, and talking to Jarvis
out loud. It is a fork of [Handy](https://github.com/cjpais/Handy) (MIT, by CJ Pais), taken at
commit `ffbc9504cbf004ce4819d2ca872fcea92be0fddf`. Handy's own README is kept as
[README.handy.md](README.handy.md), and its license as [LICENSE](LICENSE).

## What Hearth adds

All of it lives in `src-tauri/src/hearth/` and `src/components/settings/HearthSettings.tsx`, with
small hooks into Handy's code (look for `hearth` in `actions.rs`, `settings.rs`, `lib.rs`,
`tray.rs` and `transcription_coordinator.rs`).

- **Pairing.** In Hearth, Settings → Desktop app makes a pairing code. Paste it, with Hearth's
  address, into this app's General settings under Hearth. The code may only run the voice
  actions (Hearth's decision D42).
- **Dictation** (Handy's hotkey) goes to Hearth's `voice.clean` with the program and window you
  were in. Hearth applies your dictionary, snippets and the app's style, and keeps it in your
  dictation history. If Hearth can't be reached, Handy's own processing is used.
- **Command Jarvis** (Ctrl+Alt+Space): select text, hold, say what to do with it. The selection
  is copied, Jarvis rewrites it in its fast lane, and the answer is pasted over it.
- **Talk to Jarvis** (Ctrl+Alt+J): hold and ask. The answer is read aloud with the Windows voice
  and stays in the conversation in Hearth.
- **Open Hearth** in the tray menu opens Hearth in its own window.
- Rebranded as "Hearth Desktop" (`dev.hearth.desktop`), with Handy's updater turned off so a
  Handy release never replaces it.

## Building

See [BUILD.md](BUILD.md); the steps are Handy's. On Windows you need Rust, Bun, the Vulkan SDK
and an ONNX Runtime (set `ORT_LIB_LOCATION` and `ORT_PREFER_DYNAMIC_LINK=1`). The `Desktop`
GitHub workflow builds the Windows installer whenever this folder changes.

This folder isn't part of the pnpm workspace; it uses Bun, like Handy.

## The speech bake-off

Hearth's plan picks the speech engine by testing them on your own voice (PLAN.md section 7.1).
Record samples on Hearth's Voice page, under Voice samples; they're saved in Hearth's data folder
under `voice-samples`, with `vocabulary.txt` made from your dictionary. Then, with the model files this app downloaded (Settings → Models):

    cargo run --release --bin bakeoff -- <data folder>\voice-samples ^
      parakeet=<models>\<Parakeet v3 .gguf> whisper=<models>\<Whisper large v3 turbo .gguf> ^
      parakeet-cpu=<models>\<Parakeet v3 .gguf>

Each `label=file` runs on the GPU when there is one; a label ending in `-cpu` runs on the CPU.
It prints word error rate, how often your vocabulary came out right (Whisper is primed with it;
Parakeet can't be), median and slowest-5% time per sample, load time and GPU memory (NVIDIA
only), and saves the table beside the samples.
