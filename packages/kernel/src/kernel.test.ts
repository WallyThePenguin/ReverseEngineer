import { PRINCIPAL } from "@hearth/core";
import { approval, audit, notification, standingRule } from "@hearth/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { jarvisCaller, ownerCaller } from "./callers.ts";
import { newId } from "./ids.ts";
import { createTestKernel, type TestKernel } from "./testing.ts";
import { defineAction, defineModule } from "./types.ts";

const sent: string[] = [];

const probe = defineModule({
  name: "probe",
  description: "Test module",
  entityTypes: [],
  events: [{ kind: "probe.done", description: "Probe ran" }],
  knowledge: {},
  reflexes: [],
  noReflexesBecause: "test module",
  actions: [
    defineAction({
      name: "probe.write",
      description: "Writes nothing, emits an event",
      input: z.object({ n: z.number() }),
      risk: "internal",
      async handler(input, ctx) {
        ctx.emit({ kind: "probe.done", payload: { n: input.n } });
        return { doubled: input.n * 2 };
      },
    }),
    defineAction({
      name: "probe.send",
      description: "Pretends to send something outward",
      input: z.object({ to: z.string() }),
      risk: "outward",
      summarize: (i) => `Send to ${i.to}`,
      async handler(input, ctx) {
        sent.push(input.to);
        ctx.emit({ kind: "probe.done", payload: { to: input.to } });
        return { sent: true };
      },
    }),
    defineAction({
      name: "probe.calendar",
      description: "Changes your own calendar",
      input: z.object({}),
      risk: "self_external",
      handler: async () => ({ ok: true }),
    }),
    defineAction({
      name: "probe.secret",
      description: "Touches a credential",
      input: z.object({}),
      risk: "secret",
      handler: async () => ({ token: "never" }),
    }),
    defineAction({
      name: "probe.bad_event",
      description: "Emits an undeclared event",
      input: z.object({}),
      risk: "internal",
      async handler(_i, ctx) {
        ctx.emit({ kind: "probe.undeclared" });
        return null;
      },
    }),
  ],
});

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel([probe]);
});
afterAll(() => t.destroy());

describe("kernel", () => {
  it("runs an allowed action, appends its events and audits it", async () => {
    const res = await t.kernel.execute("probe.write", { n: 21 }, ownerCaller());
    expect(res).toEqual({ status: "ok", result: { doubled: 42 } });
    const [e] = await t.events("probe.done");
    expect(e).toMatchObject({ actor: "owner", origin: "owner", payload: { n: 21 } });
    const rows = await t.tdb.db.select().from(audit).where(eq(audit.action, "probe.write"));
    expect(rows[0]).toMatchObject({ outcome: "ok", principal: "owner", via: "ui" });
  });

  it("rejects invalid input and unknown actions", async () => {
    expect(await t.kernel.execute("probe.write", { n: "x" }, ownerCaller())).toMatchObject({
      status: "error",
      code: "invalid_input",
    });
    expect(await t.kernel.execute("nope.nope", {}, ownerCaller())).toMatchObject({
      code: "unknown_action",
    });
  });

  it("fails an action that emits an undeclared event, and rolls it back", async () => {
    const res = await t.kernel.execute("probe.bad_event", {}, ownerCaller());
    expect(res).toMatchObject({ status: "error", code: "failed" });
  });

  it("makes Jarvis ask before acting outward, then runs it as Jarvis once approved", async () => {
    const res = await t.kernel.execute(
      "probe.send",
      { to: "ana@example.com" },
      jarvisCaller("owner"),
    );
    expect(res).toMatchObject({ status: "pending_approval", summary: "Send to ana@example.com" });
    if (res.status !== "pending_approval") throw new Error();
    expect(sent).toEqual([]);
    const [n] = await t.tdb.db
      .select()
      .from(notification)
      .where(eq(notification.approvalId, res.approvalId));
    expect(n).toMatchObject({
      kind: "approval",
      state: "unseen",
      title: "Jarvis asks: Send to ana@example.com",
    });

    expect(
      await t.kernel.decideApproval(res.approvalId, "approve", jarvisCaller("owner")),
    ).toMatchObject({
      status: "denied",
    });
    const done = await t.kernel.decideApproval(res.approvalId, "approve", ownerCaller());
    expect(done).toEqual({ status: "ok", result: { sent: true } });
    expect(sent).toEqual(["ana@example.com"]);

    const [a] = await t.tdb.db.select().from(approval).where(eq(approval.id, res.approvalId));
    expect(a).toMatchObject({ status: "executed", decidedBy: "owner", result: { sent: true } });
    const [n2] = await t.tdb.db
      .select()
      .from(notification)
      .where(eq(notification.approvalId, res.approvalId));
    expect(n2?.state).toBe("done");
    const resolved = (await t.events("approval.resolved")).at(-1);
    expect(resolved).toMatchObject({
      actor: "owner",
      payload: { decision: "approved", requestedBy: "jarvis" },
    });
    const sentEvent = (await t.events("probe.done")).at(-1);
    expect(sentEvent).toMatchObject({ actor: "jarvis", payload: { to: "ana@example.com" } });
    expect(await t.kernel.decideApproval(res.approvalId, "approve", ownerCaller())).toMatchObject({
      code: "conflict",
    });
  });

  it("denies cleanly", async () => {
    const res = await t.kernel.execute(
      "probe.send",
      { to: "bo@example.com" },
      jarvisCaller("owner"),
    );
    if (res.status !== "pending_approval") throw new Error();
    expect(await t.kernel.decideApproval(res.approvalId, "deny", ownerCaller())).toEqual({
      status: "ok",
      result: { decision: "denied" },
    });
    expect(sent).not.toContain("bo@example.com");
  });

  it("applies caller tiers", async () => {
    expect(await t.kernel.execute("probe.secret", {}, jarvisCaller("owner"))).toMatchObject({
      status: "denied",
    });
    expect(await t.kernel.execute("probe.calendar", {}, jarvisCaller("owner"))).toMatchObject({
      status: "ok",
    });
    expect(await t.kernel.execute("probe.calendar", {}, jarvisCaller("untrusted"))).toMatchObject({
      status: "pending_approval",
    });
    const mcp = {
      principal: PRINCIPAL.owner,
      kind: "mcp_client" as const,
      origin: "agent" as const,
      via: "mcp" as const,
    };
    expect(await t.kernel.execute("probe.send", { to: "x" }, mcp)).toMatchObject({
      status: "denied",
    });
    expect(await t.kernel.execute("probe.write", { n: 1 }, mcp)).toMatchObject({ status: "ok" });
  });

  it("honors standing rules, but never for outside-triggered work", async () => {
    await t.tdb.db
      .insert(standingRule)
      .values({ id: newId(), action: "probe.send", principal: "jarvis" });
    expect(await t.kernel.execute("probe.send", { to: "cy" }, jarvisCaller("owner"))).toMatchObject(
      {
        status: "ok",
      },
    );
    expect(
      await t.kernel.execute("probe.send", { to: "dee" }, jarvisCaller("untrusted")),
    ).toMatchObject({
      status: "pending_approval",
    });
  });
});
