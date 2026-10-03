// Scoring for the speech-engine bake-off (Hearth PLAN.md section 7.1): word error rate, how often
// your own vocabulary comes out right, and latency. The `bakeoff` binary runs the engines.

use std::collections::HashMap;

/// Lowercase words, with punctuation dropped (apostrophes inside words kept).
pub fn words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| {
            w.chars()
                .filter(|c| c.is_alphanumeric() || *c == '\'')
                .collect::<String>()
                .trim_matches('\'')
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

/// Word-level edit distance between the reference and what the engine heard.
pub fn edits(reference: &[String], heard: &[String]) -> usize {
    let mut prev: Vec<usize> = (0..=heard.len()).collect();
    for (i, r) in reference.iter().enumerate() {
        let mut row = vec![i + 1; heard.len() + 1];
        for (j, h) in heard.iter().enumerate() {
            let swap = prev[j] + usize::from(r != h);
            row[j + 1] = swap.min(prev[j + 1] + 1).min(row[j] + 1);
        }
        prev = row;
    }
    prev[heard.len()]
}

/// How many times each vocabulary term appears in the reference, and how many of those the
/// engine got right (matched as a phrase, case and punctuation ignored).
pub fn vocabulary_hits(reference: &str, heard: &str, terms: &[String]) -> (usize, usize) {
    let r = format!(" {} ", words(reference).join(" "));
    let h = format!(" {} ", words(heard).join(" "));
    let mut wanted = 0;
    let mut got = 0;
    for term in terms {
        let t = words(term).join(" ");
        if t.is_empty() {
            continue;
        }
        let needle = format!(" {t} ");
        let n = r.matches(&needle).count();
        wanted += n;
        got += n.min(h.matches(&needle).count());
    }
    (wanted, got)
}

/// The value at a percentile (0-100) of the samples, nearest rank.
pub fn percentile(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    let rank = ((p / 100.0) * v.len() as f64).ceil().max(1.0) as usize;
    v[rank.min(v.len()) - 1]
}

/// Mono 16 kHz samples, as both engines want: channels averaged, then linearly resampled.
pub fn to_16k_mono(samples: &[f32], channels: usize, rate: u32) -> Vec<f32> {
    let channels = channels.max(1);
    let mono: Vec<f32> = samples
        .chunks(channels)
        .map(|c| c.iter().sum::<f32>() / c.len() as f32)
        .collect();
    if rate == 16_000 || mono.is_empty() {
        return mono;
    }
    let step = rate as f64 / 16_000.0;
    let n = (mono.len() as f64 / step).floor() as usize;
    (0..n)
        .map(|i| {
            let x = i as f64 * step;
            let k = x.floor() as usize;
            let frac = (x - k as f64) as f32;
            let a = mono[k];
            let b = *mono.get(k + 1).unwrap_or(&a);
            a + (b - a) * frac
        })
        .collect()
}

/// One engine's results over every sample.
#[derive(Default)]
pub struct Tally {
    pub edits: usize,
    pub reference_words: usize,
    pub vocab_wanted: usize,
    pub vocab_got: usize,
    pub latencies_ms: Vec<f64>,
    pub misheard: HashMap<String, usize>,
}

impl Tally {
    pub fn add(&mut self, reference: &str, heard: &str, terms: &[String], ms: f64) {
        let r = words(reference);
        let h = words(heard);
        self.edits += edits(&r, &h);
        self.reference_words += r.len();
        let (wanted, got) = vocabulary_hits(reference, heard, terms);
        self.vocab_wanted += wanted;
        self.vocab_got += got;
        if got < wanted {
            for term in terms {
                let (w, g) = vocabulary_hits(reference, heard, std::slice::from_ref(term));
                if g < w {
                    *self.misheard.entry(term.clone()).or_default() += w - g;
                }
            }
        }
        self.latencies_ms.push(ms);
    }

    pub fn wer(&self) -> f64 {
        if self.reference_words == 0 {
            0.0
        } else {
            self.edits as f64 / self.reference_words as f64
        }
    }

    pub fn vocab_accuracy(&self) -> Option<f64> {
        (self.vocab_wanted > 0).then(|| self.vocab_got as f64 / self.vocab_wanted as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(s: &str) -> Vec<String> {
        words(s)
    }

    #[test]
    fn counts_word_errors() {
        assert_eq!(
            edits(&w("open the OtoPair app"), &w("Open the auto pair app.")),
            2
        );
        assert_eq!(edits(&w("a b c"), &w("a b c")), 0);
        assert_eq!(edits(&w("a b c"), &w("")), 3);
        assert_eq!(edits(&w(""), &w("x y")), 2);
    }

    #[test]
    fn scores_vocabulary() {
        let terms = vec!["OtoPair".to_string(), "Hearth".to_string()];
        assert_eq!(
            vocabulary_hits(
                "Ship OtoPair to Hearth, then OtoPair docs",
                "ship auto pair to hearth then otopair docs",
                &terms
            ),
            (3, 2)
        );
    }

    #[test]
    fn takes_percentiles() {
        let v = [5.0, 1.0, 3.0, 2.0, 4.0];
        assert_eq!(percentile(&v, 50.0), 3.0);
        assert_eq!(percentile(&v, 95.0), 5.0);
        assert_eq!(percentile(&[], 50.0), 0.0);
    }

    #[test]
    fn makes_16k_mono() {
        let stereo = [1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0];
        assert_eq!(to_16k_mono(&stereo, 2, 16_000), vec![0.5; 4]);
        assert_eq!(to_16k_mono(&[0.0; 48_000], 1, 48_000).len(), 16_000);
    }

    #[test]
    fn tallies() {
        let mut t = Tally::default();
        t.add(
            "open OtoPair",
            "open auto pair",
            &["OtoPair".to_string()],
            300.0,
        );
        assert_eq!(t.reference_words, 2);
        assert_eq!(t.edits, 2);
        assert_eq!(t.vocab_accuracy(), Some(0.0));
        assert_eq!(t.misheard.get("OtoPair"), Some(&1));
    }
}
