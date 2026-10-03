// /api/voice/transcribe: the phone or the web sends a recording and gets the text back.
// /api/voice/jobs: the desktop app takes recordings to transcribe and answers them (D46).
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireCaller } from "../auth/middleware.ts";
import type { AppEnv } from "../env.ts";
import type { SpeechRelay } from "../speech.ts";

const MAX_BYTES = 10 * 1024 * 1024;

const isWav = (b: Uint8Array) =>
  b.length > 44 &&
  String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
  String.fromCharCode(...b.subarray(8, 12)) === "WAVE";

export function speechRoutes(relay: SpeechRelay) {
  const app = new Hono<AppEnv>();
  app.use("*", requireCaller(["owner"]));
  const fromDevice = (c: { get(k: "caller"): { via: string } | null }) =>
    c.get("caller")?.via === "device";

  app.post(
    "/transcribe",
    bodyLimit({
      maxSize: MAX_BYTES,
      onError: (c) => c.json({ error: "That recording is too long." }, 413),
    }),
    async (c) => {
      if (fromDevice(c)) return c.json({ error: "Not allowed." }, 403);
      const audio = new Uint8Array(await c.req.arrayBuffer());
      if (!isWav(audio)) return c.json({ error: "Send a WAV recording." }, 400);
      if (!relay.available())
        return c.json(
          { error: "Speech runs on the desktop app, and it isn't running on your PC." },
          503,
        );
      try {
        return c.json({ text: await relay.transcribe(audio) });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 504);
      }
    },
  );

  app.get("/jobs/next", async (c) => {
    if (!fromDevice(c)) return c.json({ error: "Not allowed." }, 403);
    const job = await relay.next(25_000, c.req.raw.signal);
    if (!job) return c.body(null, 204);
    c.header("X-Job-Id", job.id);
    c.header("Content-Type", "audio/wav");
    c.header("Cache-Control", "no-store");
    return c.body(job.audio as Uint8Array<ArrayBuffer>);
  });

  app.post("/jobs/:id", async (c) => {
    if (!fromDevice(c)) return c.json({ error: "Not allowed." }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; error?: unknown };
    const r =
      typeof body.text === "string"
        ? { text: body.text.slice(0, 20_000) }
        : { error: String(body.error ?? "The desktop app couldn't transcribe it.").slice(0, 300) };
    return relay.answer(c.req.param("id"), r)
      ? c.json({ ok: true })
      : c.json({ error: "No such job." }, 404);
  });
  return app;
}
