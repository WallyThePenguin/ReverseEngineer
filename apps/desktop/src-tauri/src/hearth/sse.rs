// Reads a server-sent event stream (text/event-stream) as it arrives, in pieces of any size.

/// One event from the stream.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Event {
    pub event: String,
    pub data: String,
    pub id: Option<String>,
}

/// More than this without a line break isn't a stream Hearth sends; it's dropped.
const MAX_LINE: usize = 1 << 20;

#[derive(Default)]
pub struct Reader {
    buf: Vec<u8>,
    event: String,
    data: String,
    id: Option<String>,
    has_data: bool,
}

impl Reader {
    /// Adds what just arrived; returns the events it completed.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Event> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(end) = self.buf.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = self.buf.drain(..=end).collect();
            let line = String::from_utf8_lossy(&raw[..raw.len() - 1]);
            let line = line.strip_suffix('\r').unwrap_or(&line);
            if line.is_empty() {
                if let Some(e) = self.dispatch() {
                    out.push(e);
                }
                continue;
            }
            if line.starts_with(':') {
                continue; // a comment: Hearth's keep-alive
            }
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => self.event = value.to_string(),
                "data" => {
                    if self.has_data {
                        self.data.push('\n');
                    }
                    self.data.push_str(value);
                    self.has_data = true;
                }
                "id" if !value.contains('\0') => self.id = Some(value.to_string()),
                _ => {}
            }
        }
        if self.buf.len() > MAX_LINE {
            self.buf.clear();
        }
        out
    }

    fn dispatch(&mut self) -> Option<Event> {
        let event = std::mem::take(&mut self.event);
        if !std::mem::take(&mut self.has_data) {
            return None;
        }
        Some(Event {
            event: if event.is_empty() {
                "message".into()
            } else {
                event
            },
            data: std::mem::take(&mut self.data),
            id: self.id.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_events_split_anywhere() {
        let stream = b": keep-alive\n\nevent: notify\nid: 7\ndata: {\"title\":\"Hi\"}\n\nevent: ready\r\ndata: a\r\ndata: b\r\n\r\n";
        for split in 0..stream.len() {
            let mut r = Reader::default();
            let mut got = r.push(&stream[..split]);
            got.extend(r.push(&stream[split..]));
            assert_eq!(
                got,
                vec![
                    Event {
                        event: "notify".into(),
                        data: "{\"title\":\"Hi\"}".into(),
                        id: Some("7".into())
                    },
                    Event {
                        event: "ready".into(),
                        data: "a\nb".into(),
                        id: Some("7".into())
                    },
                ],
                "split at {split}"
            );
        }
    }

    #[test]
    fn ignores_events_without_data() {
        let mut r = Reader::default();
        assert!(r.push(b"event: notify\n\n").is_empty());
        assert_eq!(r.push(b"data: x\n\n")[0].event, "message");
    }

    #[test]
    fn drops_runaway_lines() {
        let mut r = Reader::default();
        r.push(&vec![b'x'; MAX_LINE + 1]);
        assert_eq!(r.push(b"\ndata: ok\n\n")[0].data, "ok");
    }
}
