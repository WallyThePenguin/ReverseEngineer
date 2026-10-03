//! The speech-engine bake-off (Hearth PLAN.md section 7.1). Runs each engine over your recorded
//! samples and reports word error rate, accuracy on your vocabulary, and how long each takes.
//!
//!   bakeoff <samples folder> <label>=<model> [<label>=<model>...]
//!
//! A model is a GGUF file as Handy downloads it (run on the GPU when there is one; a label ending
//! in `-cpu` runs it on the CPU), or a folder holding an ONNX Parakeet model.
//!
//! The folder holds `name.wav` recordings with `name.txt` beside each (what was really said),
//! and optionally `vocabulary.txt` (one term per line: names, products, code words). Whisper is
//! primed with the vocabulary, as a Whisper setup would be; Parakeet can't be. Results are printed
//! and saved to `results-<time>.md` in the folder.

use handy_app_lib::hearth::bakeoff::{percentile, to_16k_mono, Tally};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Instant;
use transcribe_cpp::{
    Backend, Feature, Model, ModelOptions, RunExtension, RunOptions, WhisperRunOptions,
};
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity};
use transcribe_rs::onnx::Quantization;

type Run = Box<dyn FnMut(&[f32]) -> Result<String, String>>;

struct Sample {
    name: String,
    audio: Vec<f32>,
    reference: String,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: bakeoff <samples folder> parakeet=<model.gguf> whisper=<model.gguf> [parakeet-cpu=<model.gguf>]");
        std::process::exit(2);
    }
    let dir = PathBuf::from(&args[0]);
    let vocabulary = read_vocabulary(&dir);
    let samples = read_samples(&dir).unwrap_or_else(|e| fail(&e));
    if samples.is_empty() {
        fail("No samples: put name.wav with name.txt beside it in the folder.");
    }
    let total_s: f64 = samples
        .iter()
        .map(|s| s.audio.len() as f64 / 16_000.0)
        .sum();
    let mut report = format!(
        "# Speech bake-off\n\n{} samples, {:.1} minutes of audio, {} vocabulary terms.\n\n\
         | Engine | Word error rate | Your vocabulary right | Median time | Slowest 5% | Load | GPU memory |\n\
         |---|---|---|---|---|---|---|\n",
        samples.len(),
        total_s / 60.0,
        vocabulary.len()
    );
    let mut details = String::new();
    for spec in &args[1..] {
        let Some((kind, path)) = spec.split_once('=') else {
            fail(&format!("Not an engine: {spec}"));
        };
        eprintln!("Loading {kind} from {path}…");
        let started = Instant::now();
        let mut run = match load(kind, Path::new(path), &vocabulary) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("  {kind}: {e}");
                let _ = writeln!(report, "| {kind} | couldn't load: {e} | | | | | |");
                continue;
            }
        };
        let load_s = started.elapsed().as_secs_f64();
        // The first run warms caches and shaders; it isn't counted.
        let _ = run(&samples[0].audio);
        let mut tally = Tally::default();
        let mut worst: Vec<(usize, String, String, String)> = Vec::new();
        for s in &samples {
            let t = Instant::now();
            let heard = run(&s.audio).unwrap_or_else(|e| format!("[failed: {e}]"));
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            let before = tally.edits;
            tally.add(&s.reference, &heard, &vocabulary, ms);
            worst.push((
                tally.edits - before,
                s.name.clone(),
                s.reference.clone(),
                heard,
            ));
            eprintln!("  {} {:.0} ms", s.name, ms);
        }
        let _ = writeln!(
            report,
            "| {kind} | {:.1}% | {} | {:.0} ms | {:.0} ms | {:.1} s | {} |",
            tally.wer() * 100.0,
            tally
                .vocab_accuracy()
                .map(|a| format!(
                    "{:.0}% ({} of {})",
                    a * 100.0,
                    tally.vocab_got,
                    tally.vocab_wanted
                ))
                .unwrap_or_else(|| "no terms in the samples".into()),
            percentile(&tally.latencies_ms, 50.0),
            percentile(&tally.latencies_ms, 95.0),
            load_s,
            gpu_memory().unwrap_or_else(|| "not measured".into()),
        );
        worst.sort_by(|a, b| b.0.cmp(&a.0));
        let _ = writeln!(details, "\n## {kind}: the five worst samples\n");
        for (errs, name, reference, heard) in worst.iter().take(5) {
            let _ = writeln!(
                details,
                "- **{name}** ({errs} errors)\n  - said: {reference}\n  - heard: {heard}"
            );
        }
        if !tally.misheard.is_empty() {
            let mut terms: Vec<_> = tally.misheard.iter().collect();
            terms.sort_by(|a, b| b.1.cmp(a.1));
            let list: Vec<String> = terms.iter().map(|(t, n)| format!("{t} ({n})")).collect();
            let _ = writeln!(details, "\nMissed vocabulary: {}", list.join(", "));
        }
    }
    report.push_str(&details);
    println!("{report}");
    let out = dir.join(format!(
        "results-{}.md",
        chrono::Local::now().format("%Y%m%d-%H%M")
    ));
    match std::fs::write(&out, &report) {
        Ok(()) => eprintln!("Saved {}", out.display()),
        Err(e) => eprintln!("Couldn't save {}: {e}", out.display()),
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}

/// A model file (GGUF, as Handy downloads them) runs on transcribe-cpp: the GPU when there is
/// one, or the CPU when the label ends in `-cpu`. A folder is an ONNX Parakeet model.
fn load(label: &str, path: &Path, vocabulary: &[String]) -> Result<Run, String> {
    if path.is_dir() {
        let mut model =
            ParakeetModel::load(path, &Quantization::Int8).map_err(|e| e.to_string())?;
        let params = ParakeetParams {
            timestamp_granularity: Some(TimestampGranularity::Segment),
            ..Default::default()
        };
        return Ok(Box::new(move |audio| {
            model
                .transcribe_with(audio, &params)
                .map(|r| r.text)
                .map_err(|e| e.to_string())
        }));
    }
    transcribe_cpp::init_backends_default().map_err(|e| e.to_string())?;
    let backend = if label.ends_with("-cpu") {
        Backend::Cpu
    } else {
        Backend::Auto
    };
    let model = Model::load_with(
        path,
        &ModelOptions {
            backend,
            device: None,
        },
    )
    .map_err(|e| e.to_string())?;
    // Whisper can be primed with your words; Parakeet can't (the plan's one known gap).
    let primed = !vocabulary.is_empty()
        && model.arch() == "whisper"
        && model.supports(Feature::InitialPrompt);
    eprintln!(
        "  on {}{}",
        model.backend(),
        if primed {
            ", primed with your vocabulary"
        } else {
            ""
        }
    );
    let mut session = model.session().map_err(|e| e.to_string())?;
    let options = RunOptions {
        language: Some("en".into()),
        family: primed.then(|| {
            RunExtension::Whisper(WhisperRunOptions {
                initial_prompt: Some(vocabulary.join(", ")),
                ..Default::default()
            })
        }),
        ..Default::default()
    };
    Ok(Box::new(move |audio| {
        session
            .run(audio, &options)
            .map(|t| t.text)
            .map_err(|e| e.to_string())
    }))
}

fn read_vocabulary(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("vocabulary.txt"))
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect()
}

fn read_samples(dir: &Path) -> Result<Vec<Sample>, String> {
    let mut wavs: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("Can't read {}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("wav")))
        .collect();
    wavs.sort();
    let mut out = Vec::new();
    for wav in wavs {
        let Ok(reference) = std::fs::read_to_string(wav.with_extension("txt")) else {
            eprintln!("Skipping {} (no .txt beside it)", wav.display());
            continue;
        };
        let mut reader =
            hound::WavReader::open(&wav).map_err(|e| format!("{}: {e}", wav.display()))?;
        let spec = reader.spec();
        let samples: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Float => reader.samples::<f32>().filter_map(Result::ok).collect(),
            hound::SampleFormat::Int => {
                let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
                reader
                    .samples::<i32>()
                    .filter_map(Result::ok)
                    .map(|s| s as f32 / scale)
                    .collect()
            }
        };
        out.push(Sample {
            name: wav
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            audio: to_16k_mono(&samples, spec.channels as usize, spec.sample_rate),
            reference: reference.trim().to_string(),
        });
    }
    Ok(out)
}

/// This process's GPU memory, from nvidia-smi when there's an NVIDIA card.
fn gpu_memory() -> Option<String> {
    let out = std::process::Command::new("nvidia-smi")
        .args([
            "--query-compute-apps=pid,used_memory",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    let me = std::process::id().to_string();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.split_once(','))
        .find(|(pid, _)| pid.trim() == me)
        .map(|(_, mb)| format!("{} MB", mb.trim()))
}
