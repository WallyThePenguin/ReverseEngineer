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
            .map_err(|e| format!("Couldn't reach Hearth: {e}"))?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if status.as_u16() == 401 {
            return Err(
                "Hearth didn't accept the pairing code. Pair the app again in Hearth's Settings."
                    .into(),
            );
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

    #[test]
    fn clips_on_characters() {
        assert_eq!(clip("héllo", 2), "hé");
    }
}
