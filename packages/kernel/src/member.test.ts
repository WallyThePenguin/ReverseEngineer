// A Slack member is refused everything that doesn't name them, and what does name them is held
// to their own rules, before and after you approve it (D62).
import { memberPrincipal, PRINCIPAL_KINDS, RISKS, type Risk } from "@hearth/core";
import { approval, audit, notification, principal, standingRule } from "@hearth/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ownerCaller, systemCaller } from "./callers.ts";
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
  entityTypes: [],
  events: [],
  knowledge: {},
  reflexes: [],
  noReflexesBecause: "test module",
  actions: [
    ...byRisk,
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
const member = (id: string, extra: Partial<Caller> = {}): Caller => ({
  principal: id,
  kind: "member",
  origin: "untrusted",
  via: "slack",
  ...extra,
});

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
});
