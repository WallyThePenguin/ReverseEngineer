// Hearth's action API, as the desktop app uses it: POST /api/actions/<name> with the pairing
// code as a bearer token. The code may only run the few voice actions (Hearth's D42).

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone)]
pub struct Hearth {
    base: String,
    token: String,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CommandResult {
    Working,
    Done { text: String },
    Failed { reason: String },
}

#[derive(Debug, Deserialize)]
pub struct Sent {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    pub idx: i64,
}

#[derive(Debug, Deserialize)]
pub struct LogEntry {
    pub idx: i64,
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
}

/// Where you were typing when you pressed the hotkey.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Target {
    pub app: Option<String>,
    pub window: Option<String>,
}

impl Hearth {
    /// None unless both an address and a pairing code are set.
    pub fn new(base: &str, token: &str) -> Option<Self> {
        let base = base.trim().trim_end_matches('/');
        let token = token.trim();
        if base.is_empty() || token.is_empty() {
            return None;
        }
        Some(Self {
            base: base.to_string(),
            token: token.to_string(),
            http: reqwest::Client::new(),
        })
    }

    pub async fn call(&self, name: &str, input: Value, timeout: Duration) -> Result<Value, String> {
        let res = self
            .http
            .post(format!("{}/api/actions/{}", self.base, name))
            .bearer_auth(&self.token)
            .json(&input)
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| {
                // The details are for the log; what you see is what happened (it's a notification).
                log::warn!("Hearth's {name} didn't go through: {e}");
                unreachable(&e)
            })?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if status.as_u16() == 401 {
            return Err(SIGNED_OUT.into());
        }
        if !status.is_success() {
            let why = body["message"]
                .as_str()
                .or(body["reason"].as_str())
                .or(body["error"].as_str())
                .unwrap_or("unknown error");
            return Err(format!("Hearth refused {name}: {why}"));
        }
        Ok(body["result"].clone())
    }

    /// Waits for a recording from the phone to transcribe: its id and WAV bytes, or None when
    /// nothing came in a while (D46).
    pub async fn next_speech(&self) -> Result<Option<(String, Vec<u8>)>, String> {
        let res = self
            .http
            .get(format!("{}/api/voice/jobs/next", self.base))
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(40))
            .send()
            .await
            .map_err(|e| format!("Couldn't reach Hearth: {e}"))?;
        match res.status().as_u16() {
            204 => Ok(None),
            200 => {
                let id = res
                    .headers()
                    .get("x-job-id")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                let audio = res.bytes().await.map_err(|e| e.to_string())?;
                Ok((!id.is_empty()).then(|| (id, audio.to_vec())))
            }
            401 => Err("Hearth didn't accept the pairing code.".into()),
            s => Err(format!("Hearth answered {s} when asked for speech.")),
        }
    }

    /// Sends back the text for a recording, or why there's none.
    pub async fn answer_speech(
        &self,
        id: &str,
        text: Result<String, String>,
    ) -> Result<(), String> {
        let body = match text {
            Ok(t) => json!({ "text": t }),
            Err(e) => json!({ "error": e }),
        };
        self.http
            .post(format!("{}/api/voice/jobs/{}", self.base, id))
            .bearer_auth(&self.token)
            .json(&body)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| format!("Couldn't reach Hearth: {e}"))?;
        Ok(())
    }

    /// Cleans dictated text with your dictionary, snippets and the app's style.
    pub async fn clean(&self, raw: &str, at: &Target, duration_ms: u64) -> Result<String, String> {
        let mut input = json!({ "raw": raw, "durationMs": duration_ms.min(3_600_000) });
        if let Some(app) = &at.app {
            input["app"] = json!(clip(app, 200));
        }
        if let Some(window) = &at.window {
            input["window"] = json!(clip(window, 300));
        }
        let out = self
            .call("voice.clean", input, Duration::from_secs(3))
            .await?;
        out["text"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "Hearth's answer had no text".into())
    }

    /// Asks Jarvis to do what you said with the selected text; returns the command's id.
    pub async fn command(
        &self,
        instruction: &str,
        selection: &str,
        at: &Target,
    ) -> Result<String, String> {
        let mut input = json!({ "instruction": clip(instruction, 2_000), "selection": clip(selection, 20_000) });
        if let Some(app) = &at.app {
            input["app"] = json!(clip(app, 200));
        }
        let out = self
            .call("voice.command", input, Duration::from_secs(5))
            .await?;
        out["id"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "no command id".into())
    }

    pub async fn command_result(&self, id: &str) -> Result<CommandResult, String> {
        let out = self
            .call(
                "voice.command_result",
                json!({ "id": id }),
                Duration::from_secs(5),
            )
            .await?;
        serde_json::from_value(out).map_err(|e| format!("odd answer from Hearth: {e}"))
    }

    pub async fn send(&self, text: &str, conversation: Option<&str>) -> Result<Sent, String> {
        let mut input = json!({ "text": clip(text, 20_000) });
        if let Some(id) = conversation {
            input["conversationId"] = json!(id);
        }
        let out = self
            .call("chat.send", input, Duration::from_secs(5))
            .await?;
        serde_json::from_value(out).map_err(|e| format!("odd answer from Hearth: {e}"))
    }

    pub async fn log_after(&self, conversation: &str, idx: i64) -> Result<Vec<LogEntry>, String> {
        let out = self
            .call(
                "conversation.get",
                json!({ "id": conversation, "afterIdx": idx }),
                Duration::from_secs(5),
            )
            .await?;
        serde_json::from_value(out["log"].clone())
            .map_err(|e| format!("odd answer from Hearth: {e}"))
    }

    /// Hearth's notifications for this PC, as a live stream of server-sent events (D53).
    pub async fn notify_feed(&self, after: Option<&str>) -> Result<reqwest::Response, String> {
        let mut req = self
            .http
            .get(format!("{}/api/desktop/notify", self.base))
            .bearer_auth(&self.token)
            .header("accept", "text/event-stream");
        if let Some(id) = after {
            req = req.header("last-event-id", id);
        }
        let res = req
            .send()
            .await
            .map_err(|e| format!("Couldn't reach Hearth: {e}"))?;
        match res.status().as_u16() {
            200 => Ok(res),
            s => Err(format!("Hearth answered {s} when asked for notifications.")),
        }
    }
}

/// What a 401 from Hearth means for this app: its token was signed out (D53).
const SIGNED_OUT: &str = "Hearth signed this PC out. In Hearth's Settings, under Desktop app, \
                          choose Connect Hearth on this PC.";

/// A request that never got an answer, said plainly.
fn unreachable(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "Hearth took too long to answer. Try again in a moment.".into()
    } else {
        "Couldn't reach Hearth. Is it running?".into()
    }
}

fn http() -> &'static reqwest::Client {
    static HTTP: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    HTTP.get_or_init(reqwest::Client::new)
}

/// Whether Hearth's server answers at this address.
pub async fn healthy(base: &str) -> bool {
    http()
        .get(format!("{}/api/health", base.trim_end_matches('/')))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

/// What a connect link gets this PC: its device token, and a one-time code that signs Hearth's
/// window in (D53).
#[derive(Debug, Deserialize)]
pub struct Connected {
    pub token: String,
    pub code: String,
}

/// Trades the nonce from a connect link for this PC's token and a sign-in code, at the address
/// in this app's settings.
pub async fn redeem(base: &str, nonce: &str) -> Result<Connected, String> {
    let res = http()
        .post(format!(
            "{}/api/auth/desktop/redeem",
            base.trim_end_matches('/')
        ))
        .json(&json!({ "nonce": nonce }))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "Couldn't reach Hearth to connect this PC. Is it running?".to_string())?;
    match res.status().as_u16() {
        200 => res
            .json()
            .await
            .map_err(|_| "Hearth's answer didn't make sense. Try connecting again.".into()),
        400 | 404 | 410 => Err(
            "That connect link has run out or was used already. In Hearth's Settings, choose \
             Connect Hearth on this PC again."
                .into(),
        ),
        _ => Err("Hearth couldn't connect this PC. Try again in a minute.".into()),
    }
}

/// At most `max` characters, cut on a character boundary.
pub fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// What Jarvis said in these log entries, and whether its turn is over.
pub fn replies(log: &[LogEntry]) -> (Vec<String>, bool) {
    let said = log
        .iter()
        .filter(|l| l.kind == "assistant_message")
        .filter_map(|l| l.payload["text"].as_str().map(str::to_string))
        .collect();
    let done = log
        .iter()
        .any(|l| l.kind == "turn_finished" || l.kind == "error");
    (said, done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_an_address_and_a_code() {
        assert!(Hearth::new("", "abc").is_none());
        assert!(Hearth::new("http://localhost:4400", "  ").is_none());
        let h = Hearth::new(" http://localhost:4400/ ", " abc ").unwrap();
        assert_eq!(h.base, "http://localhost:4400");
        assert_eq!(h.token, "abc");
    }

    #[test]
    fn reads_command_results() {
        let r: CommandResult = serde_json::from_value(json!({ "status": "working" })).unwrap();
        assert_eq!(r, CommandResult::Working);
        let r: CommandResult =
            serde_json::from_value(json!({ "status": "done", "text": "Hi." })).unwrap();
        assert_eq!(r, CommandResult::Done { text: "Hi.".into() });
    }

    #[test]
    fn picks_out_what_jarvis_said() {
        let log: Vec<LogEntry> = serde_json::from_value(json!([
            { "idx": 2, "kind": "turn_started", "payload": {} },
            { "idx": 3, "kind": "assistant_message", "payload": { "text": "It's at 3." } },
            { "idx": 4, "kind": "turn_finished", "payload": {} }
        ]))
        .unwrap();
        assert_eq!(replies(&log), (vec!["It's at 3.".to_string()], true));
    }

    #[tokio::test]
    async fn says_plainly_when_hearth_is_away() {
        // Nothing listens on port 1; the request fails at once, with no raw error to show.
        let h = Hearth::new("http://127.0.0.1:1", "abc").unwrap();
        let err = h
            .call("voice.clean", json!({}), Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(err, "Couldn't reach Hearth. Is it running?");
    }

    #[test]
    fn clips_on_characters() {
        assert_eq!(clip("héllo", 2), "hé");
    }
}
