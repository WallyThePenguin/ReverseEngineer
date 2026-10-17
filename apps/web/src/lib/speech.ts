// Talking instead of typing, on the phone or in a browser: record, have the PC transcribe it
// (through the desktop app, D46), and read Jarvis's answers aloud with the device's own voice.

import { createRoot, createSignal } from "solid-js";
import { reportError, toast } from "./live.ts";
import { toWav } from "./wav.ts";

/** What the recorder is doing: idle, listening, or waiting for the text. */
export type MicState = "idle" | "listening" | "working";

function createMic() {
  const [state, setState] = createSignal<MicState>("idle");
  let recorder: MediaRecorder | null = null;
  let finish: ((text: string | null) => void) | null = null;

  const stopTracks = (r: MediaRecorder) => {
    for (const t of r.stream.getTracks()) t.stop();
  };

  return {
    state,
    /** Starts listening; the promise gets the text once `stop` is called (null if nothing). */
    async listen(): Promise<string | null> {
      if (recorder) return null;
      unlockVoice();
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast.show("Nook couldn't use the microphone. Allow it and try again.");
        return null;
      }
      const r = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise<string | null>((resolve) => {
        finish = resolve;
      });
      r.onstop = async () => {
        stopTracks(r);
        recorder = null;
        setState("working");
        try {
          finish?.(await transcribe(new Blob(chunks, { type: r.mimeType })));
        } catch (err) {
          reportError(err);
          finish?.(null);
        } finally {
          setState("idle");
        }
      };
      recorder = r;
      r.start();
      setState("listening");
      return done;
    },
    stop() {
      recorder?.stop();
    },
  };
}

export const mic = createRoot(createMic);

/** The phone's tab bar asks Jarvis's pane to start listening (it may not be open yet). */
const [talkWanted, setTalkWanted] = createSignal(false);

export { talkWanted };
export function askToTalk() {
  unlockVoice();
  setTalkWanted(true);
}
export const talkTaken = () => setTalkWanted(false);

async function transcribe(recording: Blob): Promise<string | null> {
  const res = await fetch("/api/voice/transcribe", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "audio/wav" },
    body: await toWav(recording),
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? "Couldn't transcribe that.");
  return body.text?.trim() || null;
}

/** Markdown and links read badly aloud; keep the words. */
export function speakable(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/^[#>\-*\s]+/, ""))
    .join(" ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Phones only let a page speak after a tap; this, called from one, allows it from then on. */
function unlockVoice() {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
}

export function say(text: string) {
  const words = speakable(text).slice(0, 2000);
  if (!words || !("speechSynthesis" in window)) return;
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(words));
}

export function hush() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** Puts dictated text where the cursor was: an input, a text box, or the note editor. */
export function insertAt(target: Element | null, text: string): boolean {
  if (!(target instanceof HTMLElement) || !target.isConnected) return false;
  target.focus();
  // Fires the same input events as typing, so every field picks it up.
  return document.execCommand("insertText", false, text);
}
