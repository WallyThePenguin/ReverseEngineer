// /api/voice/samples: recordings of your voice, each with what you really said, for the speech
// engine bake-off (PLAN.md section 7.1). They're files in Hearth's data folder, next to a
// vocabulary.txt made from your dictionary, which is what the desktop app's `bakeoff` reads.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dictionaryEntry } from "@hearth/db";
import { Hono } from "hono";
import { requireCaller } from "../auth/middleware.ts";
import type { AppEnv } from "../env.ts";

const NAME = /^[a-z0-9-]{1,40}$/;
const MAX_BYTES = 10 * 1024 * 1024;

export const samplesDir = (env = process.env) =>
  join(env.HEARTH_DATA_DIR ?? process.cwd(), "voice-samples");

/** A WAV file's header, so nothing else gets written into the folder. */
const isWav = (b: Uint8Array) =>
  b.length > 44 &&
  String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
  String.fromCharCode(...b.subarray(8, 12)) === "WAVE";

export function voiceRoutes(dir = samplesDir()) {
  const app = new Hono<AppEnv>();
  app.use("*", requireCaller(["owner"]));

  app.get("/samples", async (c) => {
    const files = await readdir(dir).catch(() => [] as string[]);
    const names = files.filter((f) => f.endsWith(".wav")).map((f) => f.slice(0, -4));
    return c.json({ names: names.sort(), folder: dir });
  });

  app.put("/samples/:name", async (c) => {
    const name = c.req.param("name");
    const said = (c.req.header("x-said") ?? "").trim();
    if (!NAME.test(name)) return c.json({ error: "Sample names are like dictation-01." }, 400);
    if (!said) return c.json({ error: "Say what was said in the X-Said header." }, 400);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.length > MAX_BYTES) return c.json({ error: "That recording is too long." }, 413);
    if (!isWav(body)) return c.json({ error: "Send a WAV recording." }, 400);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.wav`), body);
    await writeFile(join(dir, `${name}.txt`), `${decodeURIComponent(said)}\n`);
    // The bake-off scores how often your own words come out right.
    const words = await c
      .get("deps")
      .kernel.db.select({ write: dictionaryEntry.write })
      .from(dictionaryEntry);
    await writeFile(
      join(dir, "vocabulary.txt"),
      `# From your Hearth dictionary\n${[...new Set(words.map((w) => w.write))].join("\n")}\n`,
    );
    return c.json({ ok: true });
  });

  app.delete("/samples/:name", async (c) => {
    const name = c.req.param("name");
    if (!NAME.test(name)) return c.json({ error: "No such sample." }, 404);
    await rm(join(dir, `${name}.wav`), { force: true });
    await rm(join(dir, `${name}.txt`), { force: true });
    return c.json({ ok: true });
  });
  return app;
}
