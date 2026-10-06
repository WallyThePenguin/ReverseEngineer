// A seeded Hearth to look at and time: the real server and built web app, on a throwaway database
// on the test cluster, with a fake Gmail holding a morning's worth of mail and development login
// (no passkey). Nothing here reaches Google or the database holding your data.
//
//   HEARTH_TEST_DATABASE_URL=postgres://hearth@localhost:5499/postgres HEARTH_PORT=4473 \
//     node apps/server/src/testing/preview.ts
//
// The database is dropped when it stops (Ctrl+C).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, migrateUp } from "@hearth/db";
import { adminUrl, withDatabase } from "@hearth/db/testing";
import { integrationCaller, Kernel, ownerCaller, Registry } from "@hearth/kernel";
import { ALL_MODULES, BLOB_SERVICE, BlobStore, GOOGLE_SERVICE, SCOPES } from "@hearth/modules";
import { FakeGoogle } from "@hearth/modules/google-testing";
import pg from "pg";
import { createApp } from "../app.ts";
import { listen } from "../listen.ts";

const ME = "owner@example.com";
const port = Number(process.env.HEARTH_PORT ?? 4473);
const name = `hearth_preview_${port}`;
const webDist = fileURLToPath(new URL("../../../web/dist", import.meta.url));

async function admin(sql: string) {
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await admin(`CREATE DATABASE ${name}`);
const database = connect(withDatabase(name));
await migrateUp(database.pool);

const kernel = new Kernel({ db: database.db, registry: new Registry(ALL_MODULES) });
const g = new FakeGoogle(ME);
g.grants = ["openid", "email", ...SCOPES.gmail, ...SCOPES.calendar];
kernel.services[GOOGLE_SERVICE] = g.client(database.db);
const blobs = await mkdtemp(join(tmpdir(), "hearth-preview-"));
kernel.services[BLOB_SERVICE] = new BlobStore(blobs);
const google = g.client(database.db);
const signIn = new URL(
  await google.startSignIn(database.db, [...SCOPES.gmail, ...SCOPES.calendar]),
);
await google.finishSignIn(database.db, signIn.searchParams.get("state")!, "the-code");

// A morning's mail: people who want an answer, a few newsletters, a receipt.
const people = [
  [
    "Ana Silva",
    "ana@friends.example",
    "Lunch on Friday?",
    "Are you free Friday at noon? The new place on 5th.",
  ],
  [
    "Sam Lee",
    "sam@work.example",
    "Q4 plan review",
    "Can you look over the Q4 plan before Thursday's meeting?",
  ],
  [
    "Priya Shah",
    "priya@landlord.example",
    "Lease renewal",
    "Your lease is up in November. Let me know by the 20th.",
  ],
  [
    "Dr. Patel's office",
    "front@dentist.example",
    "Appointment reminder",
    "You're booked for a cleaning next Tuesday at 3pm.",
  ],
  [
    "Marco Rossi",
    "marco@friends.example",
    "Photos from the trip",
    "Finally uploaded them, have a look when you can.",
  ],
  [
    "Jo Kim",
    "jo@work.example",
    "Interview loop for Friday",
    "Could you take the 2pm slot with the backend candidate?",
  ],
  [
    "Lena Park",
    "lena@school.example",
    "Field trip permission",
    "Please sign the form for the museum trip by Wednesday.",
  ],
  [
    "Chris Wu",
    "chris@work.example",
    "Re: deploy checklist",
    "Added two items to the checklist, see the doc.",
  ],
] as const;
const noise = [
  ["Shop", "deals@shop.example", "Your receipt", "Thanks for your order #4471."],
  ["The Weekly", "news@weekly.example", "This week: five things", "Our picks for the week."],
  ["Airline", "noreply@air.example", "Check in for your flight", "Check-in opens 24 hours before."],
] as const;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
people.forEach(([n, address, subject, text], i) => {
  g.gmail.deliver({ from: { name: n, address }, subject, text, date: minutesAgo(15 + i * 37) });
});
noise.forEach(([n, address, subject, text], i) => {
  g.gmail.deliver(
    {
      from: { name: n, address },
      subject,
      text,
      date: minutesAgo(20 + i * 50),
      headers: { "List-Id": `<${address}>` },
    },
    ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
  );
});
// Enough older mail and tasks that lists are full, as yours are.
for (let i = 0; i < 160; i++) {
  const n = i % 7;
  g.gmail.deliver(
    {
      from: { name: `Sender ${n}`, address: `sender${n}@older.example` },
      subject: `Older thread ${i}`,
      text: `Body of message ${i}.`,
      date: minutesAgo(600 + i * 90),
    },
    i % 3 ? ["INBOX", "CATEGORY_PERSONAL"] : ["CATEGORY_PERSONAL"],
  );
}
for (let more = true; more; ) {
  const r = await kernel.execute<{ more: boolean }>("mail.sync", {}, integrationCaller("google"));
  if (r.status !== "ok") throw new Error(`mail.sync: ${JSON.stringify(r)}`);
  more = r.result.more;
}
for (let i = 0; i < 40; i++) {
  const due =
    i % 4 === 0 ? { dueAt: new Date(Date.now() + (i - 10) * 86_400_000).toISOString() } : {};
  const r = await kernel.execute(
    "task.create",
    { title: `Task number ${i + 1}`, ...due },
    ownerCaller(),
  );
  if (r.status !== "ok") throw new Error(`task.create: ${JSON.stringify(r)}`);
}
// The fake account's calendars, so events can be added.
const cal = await kernel.execute("calendar.sync", {}, integrationCaller("google"));
if (cal.status !== "ok") throw new Error(`calendar.sync: ${JSON.stringify(cal)}`);

const server = createApp({
  kernel,
  pool: database.pool,
  config: {
    host: "127.0.0.1",
    port,
    origin: `http://localhost:${port}`,
    devAuth: true,
    webDist,
    chrome: { mode: "off", task: "", chromePath: null, profile: null, args: [] },
  },
});
server.start();
const http = await listen(server.app.fetch, "127.0.0.1", port);
server.attach(...http);
console.log(
  `Preview on http://localhost:${port} (database ${name}, ${people.length + noise.length + 160} emails, 40 tasks)`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    for (const h of http) h.closeAllConnections();
    await server.stop();
    await database.close();
    await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await rm(blobs, { recursive: true, force: true });
    process.exit(0);
  });
