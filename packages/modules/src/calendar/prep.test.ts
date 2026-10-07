// A prep packet follows its meeting: moved to another day, its name and its "When" line say so.
// And the morning brief's "Prepared" list leaves out packets for meetings cancelled since.
import { entity } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { calendarModule } from "./index.ts";
import type { EventView } from "./store.ts";

const ME = "owner@example.com";

let t: TestKernel;
let g: FakeGoogle;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  t.clock.set("2026-10-01T12:00:00Z");
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  g.grants = ["openid", "email", ...SCOPES.calendar];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok("calendar.sync", {}, integrationCaller("google"));
const events = () =>
  ok<EventView[]>("calendar.events", { from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z" });
/** An hour with Sam, from 3 p.m. UTC (11 a.m. at home) on `day`. */
const withSam = (id: string, summary: string, day: string) =>
  g.put(ME, {
    id,
    summary,
    organizer: { email: ME, self: true },
    attendees: [{ email: ME, self: true }, { email: "sam@example.com" }],
    start: { dateTime: `2026-10-${day}T15:00:00Z` },
    end: { dateTime: `2026-10-${day}T16:00:00Z` },
  });
const preps = () => t.tdb.db.select().from(entity).where(eq(entity.type, "prep"));

describe("prep packets", () => {
  it("follow their meeting to another day", async () => {
    withSam("review", "Design review", "02");
    await sync();
    const [ev] = await events();
    const markdown = [
      "## Design review",
      "- When: 2026-10-02 11 a.m. to 12 p.m.",
      "",
      "Ask Sam about the budget.",
    ].join("\n");
    await ok("prep.publish", { eventId: ev!.id, markdown });
    expect(await preps()).toMatchObject([{ title: "Prep: Design review (2026-10-02)" }]);
    // Moved to Monday at Google.
    withSam("review", "Design review", "05");
    await sync();
    const [prep] = await preps();
    expect(prep?.title).toBe("Prep: Design review (2026-10-05)");
    expect(prep?.body).toBe(markdown.replace("2026-10-02", "2026-10-05"));
  });

  it("aren't listed as prepared once their meeting is cancelled", async () => {
    withSam("review", "Design review", "02");
    withSam("budget", "Budget", "02");
    await sync();
    const since = t.clock.now();
    for (const ev of await events())
      await ok("prep.publish", { eventId: ev.id, markdown: `Ready for ${ev.title}.` });
    g.remove(ME, "budget");
    await sync();
    const items = await calendarModule.digest!({ db: t.tdb.db, now: t.clock.now(), since });
    expect(items.filter((i) => i.bucket === "prepared").map((i) => i.text)).toEqual([
      "Prep: Design review (2026-10-02)",
    ]);
  });
});
