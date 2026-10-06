// A Slack member is refused everything that doesn't name them, and what does name them is held
// to their own rules, before and after you approve it (D62).
import { memberPrincipal, PRINCIPAL_KINDS, RISKS, type Risk } from "@hearth/core";
import {
  approval,
  audit,
  entity,
  notification,
  principal,
  standingRule,
  type Tx,
} from "@hearth/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { jarvisCaller, memberCaller, ownerCaller, systemCaller } from "./callers.ts";
import { ActionError } from "./errors.ts";
import { createEntity, updateEntity } from "./graph.ts";
import { newId } from "./ids.ts";
import { createNotification } from "./notify.ts";
import { decide, isVisibleTo } from "./policy.ts";
import { createTestKernel, type TestKernel } from "./testing.ts";
import { type ActionContext, type Caller, defineAction, defineModule } from "./types.ts";

/** Who each call ran as, by action. */
const ran: Record<string, Caller[]> = {};
const record = (name: string) => async (_i: unknown, ctx: ActionContext) => {
  ran[name] = [...(ran[name] ?? []), ctx.caller];
  return { ok: true };
};

/** Which guarded actions' snapshot and pin code ran: each reads your data in real actions. */
const looked: string[] = [];
/** Guarded like mail.send, whose snapshot loads your draft and fails with what it found. */
const guardedFor = (name: string, risk: Risk, callers?: Caller["kind"][]) =>
  defineAction({
    name,
    description: "Guarded: its snapshot and pin read your data",
    input: z.object({ id: z.string(), snapshot: z.string().optional() }),
    risk,
    ...(callers ? { callers } : {}),
    pin: async () => {
      looked.push(`${name} pin`);
      return null;
    },
    snapshot: async () => {
      looked.push(`${name} snapshot`);
      throw new ActionError("not_found", "No draft with that id.");
    },
    handler: record(name),
  });

const everyone = [...PRINCIPAL_KINDS];
const byRisk = RISKS.map((risk) =>
  defineAction({
    name: `probe.${risk}`,
    description: `A ${risk} action members may call`,
    input: z.object({ n: z.number().optional() }),
    risk,
    callers: everyone,
    handler: record(`probe.${risk}`),
  }),
);

const probe = defineModule({
  name: "probe",
  description: "Test module",
  entityTypes: ["probe_note"],
  events: [],
  knowledge: {},
  reflexes: [],
  noReflexesBecause: "test module",
  actions: [
    ...byRisk,
    guardedFor("probe.drafts", "outward", ["owner", "agent"]),
    guardedFor("probe.drafts_anyone", "outward"),
    guardedFor("probe.drafts_wipe", "destructive", everyone),
    defineAction({
      name: "probe.write",
      description: "Write a note as anyone",
      input: z.object({ body: z.string() }),
      risk: "internal",
      callers: everyone,
      handler: (i, ctx) => createEntity(ctx, { type: "probe_note", title: "", body: i.body }),
    }),
    defineAction({
      name: "probe.edit",
      description: "Edit a note as anyone",
      input: z.object({ id: z.string(), body: z.string() }),
      risk: "internal",
      callers: everyone,
      handler: (i, ctx) => updateEntity(ctx, i.id, { body: i.body }),
    }),
    defineAction({
      name: "probe.anyone",
      description: "No callers list: everyone but members",
      input: z.object({}),
      risk: "read",
      handler: record("probe.anyone"),
    }),
    defineAction({
      name: "probe.agents",
      description: "Only Jarvis",
      input: z.object({}),
      risk: "read",
      callers: ["agent"],
      handler: record("probe.agents"),
    }),
    defineAction({
      name: "probe.snap",
      description: "Captures what it will do before it runs",
      input: z.object({ to: z.string(), snapshot: z.string().optional() }),
      risk: "internal",
      callers: everyone,
      snapshot: async (i) => ({ snapshot: `checked ${i.to}` }),
      handler: async (i) => ({ snapshot: i.snapshot }),
    }),
    defineAction({
      name: "probe.nested",
      description: "Calls the guarded action from inside",
      input: z.object({}),
      risk: "internal",
      callers: everyone,
      handler: (_i, ctx) => ctx.call("probe.snap", { to: "x" }),
    }),
    defineAction({
      name: "probe.interrupt",
      description: "An interrupt with a deadline",
      input: z.object({ key: z.string() }),
      risk: "internal",
      callers: everyone,
      handler: (i, ctx) =>
        createNotification(ctx, {
          kind: "test",
          title: i.key,
          urgency: "interrupt",
          dedupeKey: i.key,
          deadline: new Date("2026-10-01T16:00:00Z"),
        }),
    }),
  ],
});

const OWN = memberPrincipal("T1", "U_OWN");
const WILD = memberPrincipal("T2", "U_WILD");
const NONE = memberPrincipal("T3", "U_NONE");
/** A member's caller as Hearth makes it, for one of the principals above. */
const member = (id: string, extra: Parameters<typeof memberCaller>[2] = {}): Caller => {
  const [, , team, user] = id.split(":");
  return memberCaller(team!, user!, extra);
};

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel([probe]);
  const members = [OWN, WILD, NONE, memberPrincipal("T2", "*")];
  await t.tdb.db
    .insert(principal)
    .values(members.map((id) => ({ id, kind: "member" as const, displayName: id })));
  // U_OWN may reply on their own; everyone in T2 may, through the team's wildcard.
  await t.tdb.db.insert(standingRule).values([
    { id: newId(), action: "probe.outward", principal: OWN },
    { id: newId(), action: "probe.outward", principal: memberPrincipal("T2", "*") },
  ]);
});
afterAll(() => t.destroy());

describe("decide, for a member", () => {
  it("refuses an action that doesn't name members, whatever its risk", () => {
    const m = member(OWN);
    for (const risk of RISKS) {
      expect(decide({ risk }, m, true).kind).toBe("deny");
      expect(decide({ risk, callers: ["owner", "agent"] }, m, true).kind).toBe("deny");
      expect(isVisibleTo({ risk }, "member")).toBe(false);
    }
  });

  it("allows reads and internal writes, asks for outward ones, and refuses the rest", () => {
    type Row = [Risk, standing: boolean, askFirst: boolean, expected: string];
    const rows: Row[] = [];
    for (const risk of RISKS)
      for (const standing of [false, true])
        for (const askFirst of [false, true]) {
          const expected =
            risk === "self_external" || risk === "destructive" || risk === "secret"
              ? "deny"
              : askFirst
                ? "ask"
                : risk === "outward" && !standing
                  ? "ask"
                  : "allow";
          rows.push([risk, standing, askFirst, expected]);
        }
    for (const [risk, standing, askFirst, expected] of rows) {
      const m = member(OWN, askFirst ? { askFirst: "On review." } : {});
      expect([
        risk,
        standing,
        askFirst,
        decide({ risk, callers: everyone }, m, standing).kind,
      ]).toEqual([risk, standing, askFirst, expected]);
    }
    const visible = RISKS.filter((risk) => isVisibleTo({ risk, callers: everyone }, "member"));
    expect(visible).toEqual(["read", "internal", "outward"]);
  });
});

describe("the kernel, for a member", () => {
  it("runs each risk as the matrix says, with standing rules of their own or their team's", async () => {
    const outcome = async (name: string, who: string, askFirst = false) =>
      (
        await t.kernel.execute(
          name,
          { n: Math.random() },
          member(who, askFirst ? { askFirst: "On review." } : {}),
        )
      ).status;
    // Own rule, the team's wildcard, and none (T3 has no rule; T2's wildcard isn't T3's).
    expect(await outcome("probe.outward", OWN)).toBe("ok");
    expect(await outcome("probe.outward", WILD)).toBe("ok");
    expect(await outcome("probe.outward", NONE)).toBe("pending_approval");
    // A member or channel on review: asked, even with a rule.
    expect(await outcome("probe.outward", OWN, true)).toBe("pending_approval");
    expect(await outcome("probe.read", NONE)).toBe("ok");
    expect(await outcome("probe.internal", NONE)).toBe("ok");
    expect(await outcome("probe.internal", NONE, true)).toBe("pending_approval");
    for (const risk of ["self_external", "destructive", "secret"])
      for (const who of [OWN, WILD, NONE])
        expect(await outcome(`probe.${risk}`, who)).toBe("denied");
    expect(await outcome("probe.anyone", OWN)).toBe("denied");
    expect(await outcome("probe.agents", OWN)).toBe("denied");
    expect(ran["probe.anyone"]).toBeUndefined();
    // Refusals are audited under the member's own name.
    const refused = await t.tdb.db
      .select()
      .from(audit)
      .where(and(eq(audit.action, "probe.anyone"), eq(audit.principal, OWN)));
    expect(refused[0]).toMatchObject({ outcome: "denied", via: "slack" });
  });

  it("runs a held call as the member once you approve it", async () => {
    const res = await t.kernel.execute(
      "probe.outward",
      { n: 7 },
      member(NONE, { turnId: newId() }),
    );
    if (res.status !== "pending_approval") throw new Error(JSON.stringify(res));
    const [card] = await t.tdb.db
      .select()
      .from(notification)
      .where(eq(notification.approvalId, res.approvalId));
    expect(card?.title).toContain(NONE);
    ran["probe.outward"] = [];
    const done = await t.kernel.decideApproval(res.approvalId, "approve", ownerCaller());
    expect(done).toEqual({ status: "ok", result: { ok: true } });
    // The kind comes from the principal row, so it's still the member's call, not Jarvis's.
    expect(ran["probe.outward"]).toMatchObject([{ principal: NONE, kind: "member" }]);
    const [a] = await t.tdb.db.select().from(approval).where(eq(approval.id, res.approvalId));
    expect(a).toMatchObject({ status: "executed", requestedBy: NONE, origin: "untrusted" });
  });

  it("captures what a member's call will do, as it does for Jarvis", async () => {
    const res = await t.kernel.execute(
      "probe.snap",
      { to: "sam", snapshot: "made up" },
      member(OWN),
    );
    expect(res).toEqual({ status: "ok", result: { snapshot: "checked sam" } });
    // A guarded action runs only as a step of its own, never from inside another call.
    expect(await t.kernel.execute("probe.nested", {}, member(OWN))).toMatchObject({
      status: "error",
      code: "forbidden",
    });
  });

  it("doesn't let a member's deadline break through the day's budget", async () => {
    for (let i = 0; i < 8; i++)
      await t.kernel.execute("probe.interrupt", { key: `day${i}` }, systemCaller());
    await t.kernel.execute("probe.interrupt", { key: "member" }, member(OWN));
    await t.kernel.execute("probe.interrupt", { key: "hearth" }, systemCaller());
    const rows = await t.tdb.db.select().from(notification).where(eq(notification.kind, "test"));
    const byKey = Object.fromEntries(rows.map((r) => [r.dedupeKey, r]));
    expect(byKey.member).toMatchObject({ deliveredAt: null, deferredReason: "budget_spent" });
    expect(byKey.member?.deadline).not.toBeNull();
    expect(byKey.hearth?.deliveredAt).not.toBeNull();
  });

  it("refuses a member before a guarded action's snapshot or pin reads anything", async () => {
    // Not naming members, by list or by having none, and naming them but too risky for them.
    // Bad input is refused the same way: what an action expects is no business of theirs.
    const names = ["probe.drafts", "probe.drafts_anyone", "probe.drafts_wipe"];
    for (const name of names)
      for (const input of [{ id: "d1" }, {}])
        expect(await t.kernel.execute(name, input, member(OWN))).toMatchObject({
          status: "denied",
        });
    expect(looked).toEqual([]);
    const refused = await t.tdb.db
      .select()
      .from(audit)
      .where(and(inArray(audit.action, names), eq(audit.principal, OWN)));
    expect(refused).toHaveLength(6);
    expect(refused.every((r) => r.outcome === "denied")).toBe(true);
    // Jarvis may call it, so its checks still run first, and their error is Jarvis's to see.
    expect(await t.kernel.execute("probe.drafts", { id: "d1" }, jarvisCaller("agent"))).toEqual({
      status: "error",
      code: "not_found",
      message: "No draft with that id.",
    });
    expect(looked).toEqual(["probe.drafts pin", "probe.drafts snapshot"]);
  });
});

describe("a member's origin", () => {
  it("is untrusted however the caller is made", () => {
    expect(memberCaller("T1", "U_OWN", { turnId: "turn" })).toEqual({
      principal: OWN,
      kind: "member",
      origin: "untrusted",
      via: "slack",
      turnId: "turn",
    });
    // Even if a runner forced its way past the types.
    const forced = { origin: "owner", kind: "agent" } as unknown as Parameters<
      typeof memberCaller
    >[2];
    expect(memberCaller("T1", "U_OWN", forced)).toMatchObject({
      kind: "member",
      origin: "untrusted",
    });
  });

  it("is held untrusted by the kernel when a caller is built by hand with another", async () => {
    // Built the way a slip in a runner would: a member, with Jarvis's or your own origin.
    const slipped = (id: string, origin: Caller["origin"]): Caller => ({ ...member(id), origin });
    const mine = await t.kernel.execute<{ id: string }>(
      "probe.write",
      { body: "Mine" },
      ownerCaller(),
    );
    if (mine.status !== "ok") throw new Error(JSON.stringify(mine));
    const edited = await t.kernel.execute(
      "probe.edit",
      { id: mine.result.id, body: "Theirs" },
      slipped(OWN, "agent"),
    );
    const made = await t.kernel.execute<{ id: string }>(
      "probe.write",
      { body: "New" },
      slipped(OWN, "owner"),
    );
    if (edited.status !== "ok" || made.status !== "ok") throw new Error("write failed");
    // Your record, once a member has written in it, is outside content; so is theirs.
    const rows = await t.tdb.db
      .select({ id: entity.id, outside: entity.outside })
      .from(entity)
      .where(inArray(entity.id, [mine.result.id, made.result.id]));
    expect(rows.map((r) => r.outside)).toEqual([true, true]);
    // What they did is stamped as outside, so a reflex's turn from it starts untrusted.
    const theirs = (await t.events()).filter(
      (e) => e.actor === OWN && e.kind.startsWith("entity."),
    );
    expect(theirs.map((e) => [e.kind, e.origin])).toEqual([
      ["entity.updated", "untrusted"],
      ["entity.created", "untrusted"],
    ]);
    // A held call waits, and runs once you say yes, as untrusted.
    ran["probe.outward"] = [];
    const held = await t.kernel.execute("probe.outward", { n: 9 }, slipped(NONE, "owner"));
    if (held.status !== "pending_approval") throw new Error(JSON.stringify(held));
    const [a] = await t.tdb.db.select().from(approval).where(eq(approval.id, held.approvalId));
    expect(a?.origin).toBe("untrusted");
    await t.kernel.decideApproval(held.approvalId, "approve", ownerCaller());
    expect(ran["probe.outward"]).toMatchObject([{ principal: NONE, origin: "untrusted" }]);
    // And a run or a context built straight from such a caller, as approvals and io do.
    const at = t.clock.now();
    const raw = { ...slipped(OWN, "agent"), correlationId: newId() };
    const ctx = t.kernel.context(t.tdb.db as unknown as Tx, raw, at, []);
    expect(ctx.caller.origin).toBe("untrusted");
    const def = t.kernel.registry.action("probe.read")!;
    await t.kernel.run(def, {}, raw);
    expect(ran["probe.read"]?.at(-1)).toMatchObject({ principal: OWN, origin: "untrusted" });
    const audited = await t.tdb.db.select().from(audit).where(eq(audit.principal, OWN));
    expect(audited.map((r) => r.origin)).not.toContain("agent");
    expect(audited.map((r) => r.origin)).not.toContain("owner");
  });
});
