// Cuts one channel of a meeting (16 kHz mono) into pieces to transcribe: at a pause once a piece
// is a few seconds long, or at a hard limit. Quiet pieces are dropped, so the engine never
// "hears" words in silence.

pub const RATE: usize = 16_000;
const MIN_SAMPLES: usize = 4 * RATE;
const MAX_SAMPLES: usize = 20 * RATE;
const PAUSE_SAMPLES: usize = RATE * 2 / 5;
const PAUSE_RMS: f32 = 0.01;
const SPEECH_RMS: f32 = 0.006;

#[derive(Default)]
pub struct Chunker {
    pending: Vec<f32>,
    /// Where `pending` starts, in samples since recording began.
    start: usize,
}

/// A piece to transcribe: where it starts, in samples since recording began, and its audio.
pub struct Piece {
    pub start: usize,
    pub audio: Vec<f32>,
}

impl Piece {
    pub fn start_ms(&self) -> u64 {
        (self.start as u64 * 1000) / RATE as u64
    }
    pub fn end_ms(&self) -> u64 {
        ((self.start + self.audio.len()) as u64 * 1000) / RATE as u64
    }
}

fn rms(s: &[f32]) -> f32 {
    if s.is_empty() {
        return 0.0;
    }
    (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt()
}

impl Chunker {
    pub fn push(&mut self, samples: &[f32]) -> Vec<Piece> {
        self.pending.extend_from_slice(samples);
        let mut out = Vec::new();
        loop {
            let n = self.pending.len();
            let cut = if n >= MAX_SAMPLES {
                Some(MAX_SAMPLES)
            } else if n >= MIN_SAMPLES && rms(&self.pending[n - PAUSE_SAMPLES..]) < PAUSE_RMS {
                Some(n)
            } else {
                None
            };
            let Some(cut) = cut else { break };
            let audio: Vec<f32> = self.pending.drain(..cut).collect();
            let start = self.start;
            self.start += cut;
            if rms(&audio) >= SPEECH_RMS {
                out.push(Piece { start, audio });
            }
        }
        out
    }

    /// Whatever is left, when the recording stops.
    pub fn flush(&mut self) -> Option<Piece> {
        let audio = std::mem::take(&mut self.pending);
        let start = self.start;
        self.start += audio.len();
        (rms(&audio) >= SPEECH_RMS && audio.len() >= RATE / 2).then_some(Piece { start, audio })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(secs: f32) -> Vec<f32> {
        (0..(secs * RATE as f32) as usize)
            .map(|i| 0.3 * (i as f32 * 0.05).sin())
            .collect()
    }
    fn quiet(secs: f32) -> Vec<f32> {
        vec![0.0; (secs * RATE as f32) as usize]
    }

    #[test]
    fn cuts_at_a_pause_after_a_few_seconds() {
        let mut c = Chunker::default();
        assert!(c.push(&tone(3.0)).is_empty());
        assert!(c.push(&quiet(0.2)).is_empty());
        let pieces = c.push(&[tone(2.0), quiet(0.5)].concat());
        assert_eq!(pieces.len(), 1);
        assert_eq!(pieces[0].start_ms(), 0);
        assert_eq!(pieces[0].end_ms(), 5_700);
        let next = c.push(&[tone(5.0), quiet(0.5)].concat());
        assert_eq!(next[0].start_ms(), 5_700);
    }

    #[test]
    fn cuts_long_speech_at_the_limit() {
        let mut c = Chunker::default();
        let pieces = c.push(&tone(45.0));
        assert_eq!(pieces.len(), 2);
        assert_eq!(pieces[1].start_ms(), 20_000);
        assert_eq!(c.flush().map(|p| p.start_ms()), Some(40_000));
    }

    #[test]
    fn drops_silence() {
        let mut c = Chunker::default();
        assert!(c.push(&quiet(30.0)).is_empty());
        assert!(c.flush().is_none());
        // Time still moves on.
        let p = c.push(&[tone(5.0), quiet(0.5)].concat());
        assert_eq!(p[0].start_ms(), 30_000);
    }
}
