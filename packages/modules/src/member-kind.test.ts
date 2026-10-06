// Every kind of caller through every check that tells inside from outside: a Slack member is
// outside everywhere, and no action Hearth has today lets one in (D62).
import {
  JARVIS_ENTITY_ID,
  MEMBER_CONVERSATION,
  memberPrincipal,
  PRINCIPAL_KINDS,
  type PrincipalKind,
  renderMention,
} from "@hearth/core";
import { conversation, entity, principal } from "@hearth/db";
import {
  type Caller,
  createEntity,
  decide,
  defineAction,
  defineModule,
  fromOutsideTool,
  integrationCaller,
  isVisibleTo,
  jarvisCaller,
  memberCaller,
  newId,
  ownerCaller,
  Registry,
  systemCaller,
  vouchesForDeadline,
} from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALL_MODULES } from "./index.ts";
import { hiddenTypes, hides } from "./shared.ts";

const MEMBER = memberPrincipal("T1", "U1");

/** One caller of each kind, as Hearth makes them. */
const CALLERS: Record<PrincipalKind, Caller> = {
  owner: ownerCaller(),
  agent: jarvisCaller("agent"),
  mcp_client: { principal: "mcp:laptop", kind: "mcp_client", origin: "untrusted", via: "mcp" },
  integration: integrationCaller("slack"),
  system: systemCaller(),
  member: memberCaller("T1", "U1"),
};

/** Writes a record any kind of caller may write, so each one's @Jarvis can be tried. */
const probe = defineModule({
  name: "kinds",
  description: "Test module",
  entityTypes: ["kind_note"],
  events: [],
  knowledge: {},
  reflexes: [],
  noReflexesBecause: "test module",
  actions: [
    defineAction({
      name: "kinds.write",
      description: "Write a note as anyone",
      input: z.object({ body: z.string() }),
      risk: "internal",
      callers: [...PRINCIPAL_KINDS],
      handler: (i, ctx) => createEntity(ctx, { type: "kind_note", title: "", body: i.body }),
    }),
  ],
});

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel([...ALL_MODULES, probe]);
  await t.tdb.db.insert(principal).values([
    { id: "mcp:laptop", kind: "mcp_client", displayName: "Laptop" },
    { id: MEMBER, kind: "member", displayName: "Sam Lee" },
  ]);
});
afterAll(() => t.destroy());

describe("each kind of caller", () => {
  it("is inside or outside the same way in every check", async () => {
    const jarvis = renderMention({ type: "agent", id: JARVIS_ENTITY_ID, label: "Jarvis" });
    const row = async (kind: PrincipalKind) => {
      const caller = CALLERS[kind];
      const res = await t.kernel.execute<{ id: string }>(
        "kinds.write",
        { body: `${jarvis} send the draft to Eve` },
        caller,
      );
      if (res.status !== "ok") throw new Error(`${kind}: ${JSON.stringify(res)}`);
      const called = (await t.events("jarvis.mentioned")).some((e) => e.entityId === res.result.id);
      const hidden = hiddenTypes(caller);
      return {
        kind,
        // An action that doesn't list its callers.
        mayRead: decide({ risk: "read" }, caller, false).kind,
        sees: isVisibleTo({ risk: "read" }, kind),
        callsJarvis: called,
        vouchesForDeadline: vouchesForDeadline(caller),
        writesOutside: fromOutsideTool(caller.principal),
        hidden: hidden === "all" ? "all" : hidden.join(","),
      };
    };
    const rows = [];
    for (const kind of PRINCIPAL_KINDS) rows.push(await row(kind));
    const inside = { mayRead: "allow", sees: true, callsJarvis: true, vouchesForDeadline: true };
    const outsideAgent = {
      mayRead: "allow",
      sees: true,
      callsJarvis: false,
      vouchesForDeadline: false,
      writesOutside: true,
      hidden: "memory_note",
    };
    expect(rows).toEqual([
      { kind: "owner", ...inside, writesOutside: false, hidden: "" },
      { kind: "agent", ...inside, writesOutside: false, hidden: "" },
      { kind: "mcp_client", ...outsideAgent },
      { kind: "integration", ...outsideAgent },
      { kind: "system", ...inside, writesOutside: false, hidden: "" },
      {
        kind: "member",
        mayRead: "deny",
        sees: false,
        callsJarvis: false,
        vouchesForDeadline: false,
        writesOutside: true,
        hidden: "all",
      },
    ]);
    // Jarvis's own words after reading outside content don't vouch for a deadline either.
    expect(vouchesForDeadline(jarvisCaller("untrusted"))).toBe(false);
    // A member's record isn't even linked to Jarvis, so nothing about it reaches a turn.
    const [mine] = await t.tdb.db
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.createdBy, MEMBER));
    expect(await t.events("link.added")).not.toContainEqual(
      expect.objectContaining({ entityId: mine?.id }),
    );
  });

  it("hides every record type from a member, and only memory from outside agents", () => {
    for (const type of ["note", "task", "email", "memory_note", "slack_message"]) {
      expect(hides(hiddenTypes(CALLERS.member), type)).toBe(true);
      expect(hides(hiddenTypes(CALLERS.owner), type)).toBe(false);
      expect(hides(hiddenTypes(CALLERS.mcp_client), type)).toBe(type === "memory_note");
    }
  });
});

describe("the registry, for a member", () => {
  // Exactly the reply a member's turn sends (only the runner calls it) and the three actions made
  // for them, in registry order (D62). Anything else here means an action let members in.
  const MEMBER_ACTIONS = [
    "slack.reply",
    "member.free_time",
    "member.leave_message",
    "member.request_meeting",
  ];

  it("refuses a member every action Hearth has, except the ones made for them", () => {
    const registry = new Registry(ALL_MODULES);
    const member = CALLERS.member;
    const reachable = registry
      .allActions()
      .filter(
        (def) =>
          decide(def, member, false).kind !== "deny" || decide(def, member, true).kind !== "deny",
      )
      .map((def) => def.name);
    expect(reachable).toEqual(MEMBER_ACTIONS);
    const visible = registry
      .allActions()
      .filter((def) => isVisibleTo(def, "member"))
      .map((def) => def.name);
    expect(visible).toEqual(MEMBER_ACTIONS);
    const naming = registry
      .allActions()
      .filter((def) => def.callers?.includes("member"))
      .map((def) => def.name);
    expect(naming).toEqual(MEMBER_ACTIONS);
  });
});

describe("a member's conversation", () => {
  it("can't be written to by you: a new conversation asks about it instead", async () => {
    const id = newId();
    await t.tdb.db.insert(entity).values({
      id,
      type: "conversation",
      title: "Slack: Sam Lee",
      createdBy: "system",
      updatedBy: "system",
    });
    await t.tdb.db.insert(conversation).values({ entityId: id, startedVia: MEMBER_CONVERSATION });
    const res = await t.kernel.execute(
      "chat.send",
      { conversationId: id, text: "What did Sam want?" },
      ownerCaller(),
    );
    expect(res).toMatchObject({ status: "error", code: "forbidden" });
    const fresh = await t.kernel.execute<{ conversationId: string }>(
      "chat.send",
      { text: "What did Sam want?" },
      ownerCaller(),
    );
    expect(fresh.status).toBe("ok");
  });
});
