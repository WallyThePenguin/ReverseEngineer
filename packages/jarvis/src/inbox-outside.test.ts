// An inbox item whose words came from outside content is still those words when Jarvis reads the
// inbox: a reminder an email set rings with its text as the title, and a turn of yours that lists
// the inbox afterwards ends untrusted, so no standing rule applies to what it does next. Your own
// reminder ringing leaves the turn as trusted as it was. A watch on what it rings reads it as outside
// content too, and a card that's only Hearth's words, though outside content set it off, isn't.
import { conversation, jarvisTurn, notification } from "@hearth/db";
import {
  type Caller,
  type HearthEvent,
  jarvisCaller,
  newId,
  ownerCaller,
  systemCaller,
} from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOutcomes } from "./outcomes.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thursday 10 a.m.
  h.brain.otherwise(() => [{ say: "OK." }]);
});
afterEach(() => h.destroy());

async function remind(text: string, caller: Caller) {
  const res = await h.kernel.execute("reminder.create", { text, at: "11:00" }, caller);
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
}
/** Rings what's due at 11. */
async function ring() {
  h.clock.set("2026-10-01T15:00:30Z");
  await h.settle();
}

/** Whether a turn of yours, in a new conversation, ends untrusted after listing the inbox. */
async function readsInbox() {
  h.brain.next([{ call: "inbox_list", input: {} }, { say: "Here's your inbox." }]);
  const res = await h.kernel.execute<{ conversationId: string }>(
    "chat.send",
    { text: "what's in my inbox?" },
    ownerCaller(),
  );
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  await h.settle();
  const [c] = await h.tdb.db
    .select()
    .from(conversation)
    .where(eq(conversation.entityId, res.result.conversationId));
  return c!.taintedAt !== null;
}

const rang = async () =>
  (await h.tdb.db.select().from(notification).where(eq(notification.kind, "reminder"))).map(
    (n) => ({ title: n.title, outside: n.outside }),
  );

describe("a reminder that rang, read back from the inbox", () => {
  it("makes your turn untrusted when an email set it", async () => {
    await remind("Pay now at https://pay.example", jarvisCaller("untrusted"));
    await ring();
    expect(await rang()).toEqual([{ title: "Pay now at https://pay.example", outside: true }]);
    expect(await readsInbox()).toBe(true);
  });

  it("leaves your turn trusted when it was yours", async () => {
    await remind("Call Sam", ownerCaller());
    await ring();
    expect(await rang()).toEqual([{ title: "Call Sam", outside: false }]);
    expect(await readsInbox()).toBe(false);
  });
});

describe("an inbox item from outside content", () => {
  it("is marked whoever made it, and its event says so", async () => {
    // A turn that read an email can't say its words are its own.
    const res = await h.kernel.execute(
      "inbox.notify",
      { title: "Wire the money", outside: false },
      jarvisCaller("untrusted"),
    );
    expect(res).toMatchObject({ status: "ok" });
    // Hearth's own, told because of an email: marked too.
    const event: HearthEvent = {
      seq: 0,
      id: newId(),
      at: h.clock.now(),
      kind: "mail.received",
      entityId: null,
      actor: "integration:google",
      origin: "untrusted",
      payload: {},
      correlationId: null,
      causationId: null,
    };
    await applyOutcomes(
      h.kernel,
      [{ kind: "tell", notification: { kind: "note", title: "Reply to Ana" } }],
      { event, name: "test.tell", mode: "always" },
    );
    // Hearth's own words, told because of a connector's event: not marked.
    const own = { kind: "system.alert", title: "Your token expires", outside: false };
    await applyOutcomes(h.kernel, [{ kind: "tell", notification: own }], {
      event,
      name: "test.own",
      mode: "always",
    });
    // A turn's tell can't say so: its caller read the email.
    const fromTurn = { ...own, title: "Nothing to see here" };
    await applyOutcomes(h.kernel, [{ kind: "tell", notification: fromTurn }], {
      event,
      name: "test.reactive",
      mode: "reactive",
    });
    // Yours stays yours.
    await h.kernel.execute("inbox.notify", { title: "Pick up milk" }, systemCaller());
    const rows = await h.tdb.db.select().from(notification);
    expect(Object.fromEntries(rows.map((n) => [n.title, n.outside]))).toEqual({
      "Wire the money": true,
      "Reply to Ana": true,
      "Your token expires": false,
      "Nothing to see here": true,
      "Pick up milk": false,
    });
    const created = await h.events("notification.created");
    expect(created.map((e) => e.payload.outside ?? false)).toEqual([
      true,
      true,
      false,
      true,
      false,
    ]);
  });
});

describe("what Hearth tells in outside content's words", () => {
  const watchFor = (kind: string) =>
    h.kernel.execute(
      "jarvis.watch",
      { description: `Tell me about ${kind}`, filter: { field: "kind", op: "eq", value: kind } },
      jarvisCaller("owner"),
    );
  /** The watch turns whose prompt names `text`, and how far each was trusted. */
  const watchTurns = async (text: string) =>
    (await h.tdb.db.select().from(jarvisTurn).where(eq(jarvisTurn.trigger, "watch")))
      .filter((t) => t.prompt?.includes(text))
      .map((t) => ({ origin: t.origin, marked: /<untrusted source="/.test(t.prompt ?? "") }));

  it("makes a watch on its ringing fire an untrusted turn, its words marked", async () => {
    await watchFor("notification.created");
    await watchFor("clock.fired");
    await remind("Pay now at https://pay.example", jarvisCaller("untrusted"));
    await ring();
    expect(await watchTurns("pay.example")).toEqual([
      { origin: "untrusted", marked: true },
      { origin: "untrusted", marked: true },
    ]);
  });

  it("leaves a watch on your own reminder as trusted as it was", async () => {
    await watchFor("notification.created");
    await watchFor("clock.fired");
    await remind("Call Sam", ownerCaller());
    await ring();
    const turns = await watchTurns("Call Sam");
    expect(turns).toHaveLength(2);
    for (const t of turns) expect(t).toMatchObject({ marked: false });
    expect(turns.some((t) => t.origin === "untrusted")).toBe(false);
  });

  it("says so when it goes out after quiet hours", async () => {
    h.clock.set("2026-10-02T03:00:00Z"); // Thursday 11 p.m.
    const res = await h.kernel.execute(
      "inbox.notify",
      { title: "Pay now at https://pay.example", urgency: "interrupt", outside: true },
      systemCaller(),
    );
    expect(res).toMatchObject({ status: "ok", result: { delivered: false } });
    h.clock.set("2026-10-02T12:00:30Z"); // Friday, just after quiet hours
    await h.settle();
    const [out] = await h.events("notification.delivered");
    expect(out?.payload).toMatchObject({ title: "Pay now at https://pay.example", outside: true });
  });
});
