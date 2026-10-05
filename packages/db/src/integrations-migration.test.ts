// 0032_integrations on a database with rows in it: calendars move to keys of their own and back,
// with their events still attached (D61).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb.destroy());

const q = (sql: string, params: unknown[] = []) => tdb.pool.query(sql, params);
const NAME = "0032_integrations";
/** This migration and the ones after it, oldest first: what going below it reverts, and applies
 * again. */
const SINCE = loadMigrations()
  .map((m) => m.name)
  .filter((n) => n >= NAME);
const down = async () =>
  expect(await migrateDown(tdb.pool, SINCE.length)).toEqual([...SINCE].reverse());
const up = async () => expect(await migrateUp(tdb.pool)).toEqual(SINCE);

async function addEvent(id: string, calendarId: string, googleId: string, title: string) {
  await q(
    "INSERT INTO entity (id, type, title, created_by, updated_by) VALUES ($1, 'event', $2, 'integration:google', 'integration:google')",
    [id, title],
  );
  await q(
    "INSERT INTO calendar_event (entity_id, calendar_id, google_id, starts_at, ends_at) VALUES ($1, $2, $3, '2026-10-05T14:00:00Z', '2026-10-05T15:00:00Z')",
    [id, calendarId, googleId],
  );
}

const eventsOf = async () =>
  (
    await q(
      "SELECT e.title, c.account, c.google_id FROM calendar_event ev JOIN entity e ON e.id = ev.entity_id JOIN calendar c ON c.id = ev.calendar_id ORDER BY e.title",
    )
  ).rows;

describe("0032_integrations", () => {
  it("gives each account's calendars their own keys, and takes them back", async () => {
    await down();
    // As before: one row per Google calendar, under Google's id.
    await q(
      "INSERT INTO google_account (email, refresh_token, connected_at) VALUES ('me@example.com', 'rt1', '2026-01-01'), ('work@example.com', 'rt2', '2026-06-01')",
    );
    await q(
      "INSERT INTO calendar (id, account, title, is_primary, can_write) VALUES ('me@example.com', 'me@example.com', 'Me', true, true), ('holidays', 'me@example.com', 'Holidays', false, false), ('work@example.com', 'work@example.com', 'Work', true, true)",
    );
    await addEvent("00000000-0000-7000-8000-000000000001", "me@example.com", "a1", "Dentist");
    await addEvent("00000000-0000-7000-8000-000000000002", "holidays", "h1", "New Year");
    await addEvent("00000000-0000-7000-8000-000000000003", "work@example.com", "w1", "Standup");

    await up();
    const cals = (await q("SELECT id, account, google_id, write_default FROM calendar")).rows;
    expect(cals).toHaveLength(3);
    for (const c of cals) {
      expect(c.id).not.toBe(c.google_id);
      expect(c.write_default).toBe(false);
    }
    expect(await eventsOf()).toEqual([
      { title: "Dentist", account: "me@example.com", google_id: "me@example.com" },
      { title: "New Year", account: "me@example.com", google_id: "holidays" },
      { title: "Standup", account: "work@example.com", google_id: "work@example.com" },
    ]);

    // Now the work account has the holiday calendar too, with its own copy of the event.
    await q(
      "INSERT INTO calendar (id, account, google_id, title) VALUES ('work-holidays', 'work@example.com', 'holidays', 'Holidays')",
    );
    await addEvent(
      "00000000-0000-7000-8000-000000000004",
      "work-holidays",
      "h1",
      "New Year (work)",
    );
    await q("UPDATE calendar SET write_default = true WHERE google_id = 'work@example.com'");
    await expect(
      q("UPDATE calendar SET write_default = true WHERE google_id = 'me@example.com'"),
    ).rejects.toThrow(/calendar_write_default/);

    // Back: Google's id is the key again, so the account connected first keeps the shared one.
    await down();
    expect((await q("SELECT id, account FROM calendar ORDER BY id")).rows).toEqual([
      { id: "holidays", account: "me@example.com" },
      { id: "me@example.com", account: "me@example.com" },
      { id: "work@example.com", account: "work@example.com" },
    ]);
    expect(
      (await q("SELECT calendar_id, google_id FROM calendar_event ORDER BY google_id")).rows,
    ).toEqual([
      { calendar_id: "me@example.com", google_id: "a1" },
      { calendar_id: "holidays", google_id: "h1" },
      { calendar_id: "work@example.com", google_id: "w1" },
    ]);
    expect((await q("SELECT title FROM entity WHERE title LIKE '%(work)'")).rows).toEqual([]);

    await up();
    expect(await eventsOf()).toHaveLength(3);
  });

  it("gives drafts written before it a Message-ID on their account's domain", async () => {
    await down();
    await q(
      "INSERT INTO mail_account (id, provider, address) VALUES ('gmail:me@example.com', 'gmail', 'me@example.com')",
    );
    await q(
      "INSERT INTO entity (id, type, title, created_by, updated_by) VALUES ('00000000-0000-7000-8000-0000000000d1', 'email_draft', 'Hi', 'owner', 'owner')",
    );
    await q(
      "INSERT INTO mail_draft (entity_id, account_id) VALUES ('00000000-0000-7000-8000-0000000000d1', 'gmail:me@example.com')",
    );
    await up();
    const [draft] = (await q("SELECT message_id FROM mail_draft")).rows;
    expect(draft.message_id).toMatch(/^[0-9a-f]{32}@example\.com$/);
    await down();
    await up();
  });
});
