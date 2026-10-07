import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entity, personEmail } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "../mail/blobs.ts";
import { companyDomain, companyName } from "./domains.ts";
import { peopleModule } from "./index.ts";
import type { PersonSummary, PersonView } from "./views.ts";

const ME = "owner@example.com";
const DAY = 24 * 3600_000;

let t: TestKernel;
let g: FakeGoogle;
let dir: string;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.grants = ["openid", "email", ...SCOPES.calendar, ...SCOPES.gmail];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar, ...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = async () => {
  await ok("calendar.sync", {}, integrationCaller("google"));
  await ok("mail.sync", {}, integrationCaller("google"));
};
// Everyone but you (the owner has a person record of their own).
const people = async () =>
  (await ok<PersonSummary[]>("person.list")).filter((p) => p.name !== "You");
const byName = async (name: string) => (await people()).find((p) => p.name === name)!;
const digest = () =>
  peopleModule.digest!({ db: t.tdb.db, now: t.clock.now(), since: t.clock.now() });

function write(to: { address: string; name?: string }[], subject = "Hello", date?: Date) {
  g.gmail.deliver({ from: { address: ME }, to, subject, text: "Hi", ...(date ? { date } : {}) }, [
    "SENT",
  ]);
}

describe("people and companies", () => {
  it("knows which domains are companies", () => {
    expect(companyDomain("ana@mail.eu.acme.co.uk")).toBe("acme.co.uk");
    expect(companyDomain("ana@Acme-Labs.example")).toBe("acme-labs.example");
    expect(companyDomain("bo@gmail.com")).toBeNull();
    expect(companyDomain("bo@yahoo.co.uk")).toBeNull();
    expect(companyDomain("info@acme.example")).toBeNull();
    expect(companyDomain("no-reply+x@acme.example")).toBeNull();
    expect(companyName("acme-labs.co.uk")).toBe("Acme Labs");
  });

  it("makes people and companies from mail you send, and knows when you last wrote", async () => {
    write([
      { address: "ana@acme.example", name: "Ana Silva" },
      { address: "bo@gmail.com", name: "Bo" },
    ]);
    g.gmail.deliver({ from: { address: "news@shop.example" }, subject: "Sale", text: "50% off" });
    await sync();
    const list = await people();
    expect(list.map((p) => [p.name, p.company, p.lastContact?.kind])).toEqual([
      ["Ana Silva", "Acme", "email"],
      ["Bo", null, "email"],
    ]);
    const ana = await ok<PersonView>("person.view", { id: list[0]!.id });
    expect(ana).toMatchObject({
      emails: ["ana@acme.example"],
      company: { name: "Acme", domain: "acme.example" },
      threads: [{ title: "Hello", messages: 1 }],
    });
    const companies = await ok<{ name: string; people: number }[]>("company.list");
    expect(companies).toMatchObject([{ name: "Acme", people: 1 }]);
    const acme = await ok<{ people: PersonSummary[] }>("company.view", { id: ana.company!.id });
    expect(acme.people.map((p) => p.name)).toEqual(["Ana Silva"]);
  });

  it("makes people from meetings you accepted, and only links strangers' invitations", async () => {
    g.put(ME, {
      summary: "Planning",
      start: { dateTime: "2026-09-29T15:00:00Z" },
      end: { dateTime: "2026-09-29T16:00:00Z" },
      attendees: [
        { email: ME, self: true, responseStatus: "accepted" },
        { email: "carol@beta.example", displayName: "Carol" },
      ],
    });
    g.put(ME, {
      summary: "Webinar",
      start: { dateTime: "2026-10-05T15:00:00Z" },
      end: { dateTime: "2026-10-05T16:00:00Z" },
      organizer: { email: "spam@promo.example" },
      attendees: [
        { email: ME, self: true, responseStatus: "needsAction" },
        { email: "spam@promo.example", organizer: true },
        { email: "carol@beta.example" },
      ],
    });
    await sync();
    const list = await people();
    expect(list.map((p) => [p.name, p.company, p.lastContact?.kind])).toEqual([
      ["Carol", "Beta", "meeting"],
    ]);
    const carol = await ok<PersonView>("person.view", { id: list[0]!.id });
    expect(carol.met.map((e) => e.title)).toEqual(["Planning"]);
    expect(carol.upcoming.map((e) => e.title)).toEqual(["Webinar"]);
  });

  it("reminds you when you haven't talked in a while", async () => {
    write([{ address: "ana@acme.example", name: "Ana" }]);
    await sync();
    const ana = await byName("Ana");
    await ok("person.follow_up", { id: ana.id, days: 30 });
    expect(await digest()).toEqual([]);
    t.clock.advance(31 * DAY);
    expect(await digest()).toEqual([
      {
        bucket: "today",
        text: "You haven't talked to Ana in 31 days.",
        entityId: ana.id,
        outside: true,
      },
    ]);
    expect((await byName("Ana")).overdueDays).toBe(31);
    write([{ address: "ana@acme.example" }], "Catching up", t.clock.now());
    await ok("mail.sync", {}, integrationCaller("google"));
    expect(await digest()).toEqual([]);
    const after = await ok<PersonView>("person.view", { id: ana.id });
    expect(after.threads.map((x) => x.title)).toEqual(["Catching up", "Hello"]);
    t.clock.advance(31 * DAY);
    expect(await digest()).toHaveLength(1);
    await ok("person.follow_up", { id: ana.id, days: null });
    expect(await digest()).toEqual([]);
  });

  it("doesn't count a stranger's mail or an unanswered invitation as talking", async () => {
    write([{ address: "ana@acme.example", name: "Ana" }]);
    await sync();
    const before = (await byName("Ana")).lastContact;
    g.gmail.deliver({
      from: { address: "x@evil.example" },
      cc: [{ address: "ana@acme.example" }],
      subject: "Hi all",
      text: "Hi",
      date: t.clock.now(),
    });
    g.put(ME, {
      summary: "Pitch",
      start: { dateTime: "2026-10-01T13:00:00Z" },
      end: { dateTime: "2026-10-01T13:30:00Z" },
      organizer: { email: "x@evil.example" },
      attendees: [
        { email: ME, self: true, responseStatus: "needsAction" },
        { email: "ana@acme.example" },
      ],
    });
    await sync();
    expect((await byName("Ana")).lastContact).toEqual(before);
  });

  it("asks before a turn that read outside content records whose address is whose", async () => {
    const eve = await ok<{ id: string }>("person.create", { name: "Eve" });
    const untrusted = { ...jarvisCaller("agent"), origin: "untrusted" as const };
    const res = await t.kernel.execute(
      "person.add_email",
      { id: eve.id, email: "attacker@evil.example" },
      untrusted,
    );
    expect(res.status).toBe("pending_approval");
    expect(await ok<PersonView>("person.view", { id: eve.id })).toMatchObject({ emails: [] });
    await ok("person.add_email", { id: eve.id, email: "eve@x.example" }, jarvisCaller("agent"));
  });

  it("gives people from before companies their company, and keeps addresses to one person", async () => {
    const [row] = await t.tdb.db
      .insert(entity)
      .values({
        id: "00000000-0000-7000-8000-000000000001",
        type: "person",
        title: "Dee",
        createdBy: "owner",
        updatedBy: "owner",
      })
      .returning();
    await t.tdb.db.insert(personEmail).values({ address: "dee@gamma.example", personId: row!.id });
    expect((await byName("Dee")).company).toBeNull();
    await ok("people.tidy");
    expect((await byName("Dee")).company).toBe("Gamma");

    const eve = await ok<{ id: string }>("person.create", { name: "Eve" });
    await ok("person.add_email", { id: eve.id, email: "Eve@Gamma.example" });
    expect((await byName("Eve")).company).toBe("Gamma");
    const taken = await t.kernel.execute(
      "person.add_email",
      { id: eve.id, email: "dee@gamma.example" },
      ownerCaller(),
    );
    expect(taken).toMatchObject({ status: "error", code: "conflict" });
    await ok("person.update", { id: eve.id, companyId: null, fields: { Birthday: "May 2" } });
    expect(await ok<PersonView>("person.view", { id: eve.id })).toMatchObject({
      company: null,
      fields: { Birthday: "May 2" },
      emails: ["eve@gamma.example"],
    });
  });
});

describe("who isn't a person", () => {
  it("makes none of a desk's address, and leaves someone you put in the trash there", async () => {
    write([
      { address: "support@acme.example", name: "Acme Support" },
      { address: "ana@acme.example", name: "Ana Silva" },
    ]);
    await sync();
    expect((await people()).map((p) => p.name)).toEqual(["Ana Silva"]);
    await ok("entity.trash", { id: (await byName("Ana Silva")).id });
    write([{ address: "ana@acme.example", name: "Ana Silva" }], "Again");
    g.gmail.deliver({ from: { address: "ana@acme.example" }, subject: "Re: Again", text: "Hi" });
    await sync();
    expect(await people()).toEqual([]);
    // Nor is she counted at Acme any more.
    expect(await ok("company.list")).toMatchObject([{ name: "Acme", people: 0 }]);
  });

  it("makes none of your own address on a meeting's guest list", async () => {
    g.put(ME, {
      summary: "Planning",
      start: { dateTime: "2026-09-29T15:00:00Z" },
      end: { dateTime: "2026-09-29T16:00:00Z" },
      attendees: [
        { email: ME, self: true, responseStatus: "accepted" },
        { email: "Owner+cal@example.com", displayName: "Me again" },
        { email: "carol@beta.example", displayName: "Carol" },
      ],
    });
    await sync();
    expect((await people()).map((p) => p.name)).toEqual(["Carol"]);
  });

  it("names someone known by their address with what they first call themselves", async () => {
    write([{ address: "cy@acme.example" }]);
    await sync();
    expect((await people()).map((p) => p.name)).toEqual(["cy@acme.example"]);
    const from = (name: string) =>
      g.gmail.deliver({ from: { address: "cy@acme.example", name }, subject: "Re", text: "Hi" });
    from("Cy Young");
    await sync();
    from("C. Y.");
    await sync();
    expect((await people()).map((p) => p.name)).toEqual(["Cy Young"]);
  });

  it("trashes the people Hearth made for your own or a desk's address, unless you kept them", async () => {
    let n = 0;
    const made = async (address: string, extra: Partial<typeof entity.$inferInsert> = {}) => {
      const id = `00000000-0000-7000-8000-0000000001${String(++n).padStart(2, "0")}`;
      await t.tdb.db.insert(entity).values({
        id,
        type: "person",
        title: address,
        body: `Email: ${address}`,
        createdBy: "integration:google",
        updatedBy: "integration:google",
        ...extra,
      });
      await t.tdb.db.insert(personEmail).values({ address, personId: id });
      return id;
    };
    const self = await made("owner+lists@example.com");
    // Made when you wrote to them from Hearth.
    const desk = await made("billing@vendor.example", { createdBy: "owner", updatedBy: "owner" });
    await made("help@vendor.example", { body: "Their desk: ask for Sam" });
    const kept = await made("sales@vendor.example");
    await ok("person.update", { id: kept, fields: { Rep: "Sam" } });
    const renamed = await made("orders@vendor.example");
    await ok("person.update", { id: renamed, name: "Vendor orders" });
    await made("ana@vendor.example");
    expect(await ok("people.tidy")).toMatchObject({ trashed: 2 });
    const gone = await t.tdb.db
      .select({ id: entity.id })
      .from(entity)
      .where(isNotNull(entity.deletedAt));
    expect(gone.map((r) => r.id).sort()).toEqual([self, desk].sort());
  });
});

describe("you", () => {
  const WORK = "sam@work.example";
  const names = async () => (await people()).map((p) => p.name).sort();
  const companies = async () =>
    (await ok<{ name: string }[]>("company.list")).map((c) => c.name).sort();

  it("aren't your account connected for its calendar only, as a guest or written to", async () => {
    g.addAccount(WORK);
    g.signingIn = WORK;
    g.grants = ["openid", "email", ...SCOPES.calendar];
    const client = g.client();
    const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
    await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
    write([{ address: WORK }, { address: "ana@acme.example", name: "Ana" }]);
    // Time blocked on your work calendar from your own.
    g.put(ME, {
      summary: "Focus",
      start: { dateTime: "2026-09-29T15:00:00Z" },
      end: { dateTime: "2026-09-29T16:00:00Z" },
      attendees: [
        { email: ME, self: true, responseStatus: "accepted" },
        { email: WORK },
        { email: "carol@beta.example", displayName: "Carol" },
      ],
    });
    await sync();
    expect(await names()).toEqual(["Ana", "Carol"]);
    expect(await companies()).toEqual(["Acme", "Beta"]);
  });

  it("aren't an address you've sent mail from", async () => {
    const ALIAS = "sam@alias.example";
    g.gmail.deliver(
      {
        from: { address: ALIAS },
        to: [{ address: "ana@acme.example", name: "Ana" }],
        subject: "From my other address",
        text: "Hi",
      },
      ["SENT"],
    );
    await sync();
    write([{ address: ALIAS }], "Note to self");
    await ok("mail.sync", {}, integrationCaller("google"));
    expect(await names()).toEqual(["Ana"]);
    expect(await companies()).toEqual(["Acme"]);
  });
});
