// Samples of your voice for the speech engine bake-off (PLAN.md section 7.1): read each line
// aloud and it's saved, with the line as what you said. The desktop app's bake-off then scores
// each engine on them.

import { createResource, createSignal, onCleanup, Show } from "solid-js";
import { Badge, Button } from "../components/ui.tsx";
import { reportError, toast } from "../lib/live.ts";
import { useAction } from "../lib/query.ts";
import { toWav } from "../lib/wav.ts";

const LINES = [
  "Hey, can you send me the notes from this morning's call when you get a chance?",
  "I'll be about ten minutes late, start without me.",
  "Thanks for the quick turnaround, this looks great.",
  "Let's push the review to Thursday at two thirty.",
  "Could you double check the numbers in the second table before we send it?",
  "I'm not sure that's right, scratch that, it's fine as it is.",
  "Remind me to call the dentist tomorrow morning.",
  "The build is failing on the main branch again, can someone take a look?",
  "Please find the signed contract attached.",
  "I think we should ship the smaller version first and see how people use it.",
  "Can we move our one on one to next week?",
  "Rename the function to load settings and add a test for the empty case.",
  "Happy birthday! Hope you have a great one.",
  "What time does the pharmacy close on Saturdays?",
  "Draft a reply saying I can do Tuesday or Wednesday afternoon.",
  "The invoice total should be four hundred and twenty dollars, not four hundred.",
  "I pushed a fix, it should be green in a few minutes.",
  "Let me know if you need anything else from me.",
  "We're out of milk, eggs and coffee.",
  "Turn the meeting notes into tasks and assign the first one to me.",
  "Sorry for the slow reply, it's been a busy week.",
  "Add a line to the plan about backups and restoring them.",
  "Is the parking garage on Fifth Street still closed?",
  "Open a pull request and ask for a review when the tests pass.",
  "I'd rather keep it simple for now and revisit it next quarter.",
  "Book a table for four at seven on Friday.",
  "Thanks, that answers my question.",
  "Can you summarize this thread in three bullet points?",
  "The flight lands at six fifteen, I'll grab a cab from the airport.",
  "Please stop sending me these emails.",
];

/** Lines that use your own words, so the bake-off sees how each engine spells them. */
const withYourWords = (terms: string[]) =>
  terms
    .slice(0, 20)
    .map(
      (t, i) =>
        [
          `Can you send the ${t} update to the team today?`,
          `I talked to ${t} about it yesterday.`,
          `Let's add ${t} to the agenda for Monday.`,
          `The ${t} numbers look better than last month.`,
        ][i % 4]!,
    );

const nameOf = (i: number) => `dictation-${String(i + 1).padStart(2, "0")}`;

async function saved(): Promise<string[]> {
  const res = await fetch("/api/voice/samples", { credentials: "same-origin" });
  if (!res.ok) throw new Error("Couldn't list the samples.");
  return ((await res.json()) as { names: string[] }).names;
}

export function Samples() {
  const dict = useAction<{ write: string }[]>("dictionary.list");
  const lines = () => [...withYourWords((dict.data ?? []).map((d) => d.write)), ...LINES];
  const [names, { refetch }] = createResource(saved);
  const [at, setAt] = createSignal(0);
  const [recording, setRecording] = createSignal<MediaRecorder | null>(null);
  const release = (stream: MediaStream) => {
    for (const t of stream.getTracks()) t.stop();
  };
  onCleanup(() => {
    const rec = recording();
    if (rec) release(rec.stream);
  });

  const has = (i: number) => names()?.includes(nameOf(i)) ?? false;

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      const i = at();
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        release(stream);
        try {
          const wav = await toWav(new Blob(chunks, { type: rec.mimeType }));
          const res = await fetch(`/api/voice/samples/${nameOf(i)}`, {
            method: "PUT",
            credentials: "same-origin",
            headers: { "content-type": "audio/wav", "x-said": encodeURIComponent(lines()[i]!) },
            body: wav,
          });
          if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error);
          await refetch();
          setAt(Math.min(i + 1, lines().length - 1));
        } catch (err) {
          reportError(err);
        }
      };
      rec.start();
      setRecording(rec);
    } catch {
      toast.show("Hearth couldn't use the microphone. Allow it for this page and try again.");
    }
  };
  const stop = () => {
    recording()?.stop();
    setRecording(null);
  };

  return (
    <div class="space-y-4 px-4 py-4">
      <p class="text-sm text-muted">
        Read each line aloud the way you'd dictate it. Hearth keeps the recordings on this PC so the
        speech engines can be compared on your voice. About {lines().length} lines; any number
        helps.
      </p>
      <div class="rounded-md bg-sunk px-4 py-4">
        <p class="mb-1 text-xs text-faint">
          Line {at() + 1} of {lines().length}
          <Show when={has(at())}>
            {" "}
            <Badge tone="ok">recorded</Badge>
          </Show>
        </p>
        <p class="text-lg">{lines()[at()]}</p>
        <div class="mt-3 flex gap-2">
          <Show
            when={recording()}
            fallback={
              <Button kind="primary" onClick={() => void start()}>
                {has(at()) ? "Record again" : "Record"}
              </Button>
            }
          >
            <Button kind="primary" onClick={stop}>
              Stop and save
            </Button>
          </Show>
          <Button onClick={() => setAt(Math.max(0, at() - 1))} disabled={!!recording()}>
            Back
          </Button>
          <Button
            onClick={() => setAt(Math.min(lines().length - 1, at() + 1))}
            disabled={!!recording()}
          >
            Skip
          </Button>
        </div>
      </div>
      <p class="text-sm text-muted">{names()?.length ?? 0} recorded.</p>
    </div>
  );
}
