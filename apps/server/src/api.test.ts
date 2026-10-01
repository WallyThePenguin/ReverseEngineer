import { latestSeq } from "@hearth/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiToken, revokeApiTokens } from "./auth/tokens.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ devAuth: true });
});
afterEach(() => t.destroy());

const MCP_HEADERS = { accept: "application/json, text/event-stream" };

async function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await t.api("/mcp", token, {
    method: "POST",
    headers: MCP_HEADERS,
    json: { jsonrpc: "2.0", id: 1, method, params },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result: Record<string, unknown> & { content?: { text: string }[]; isError?: boolean };
  };
}

describe("action API", () => {
  it("runs actions as you and maps results to HTTP statuses", async () => {
    const created = await t.browser("/api/actions/task.create", {
      method: "POST",
      json: { title: "Pay rent" },
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { status: string; result: { id: string; key: string } };
    expect(body.result.key).toBe("T-1");

    expect((await t.browser("/api/actions/task.create", { method: "POST", json: {} })).status).toBe(
      400,
    );
    expect(
      (await t.browser("/api/actions/nope.nothing", { method: "POST", json: {} })).status,
    ).toBe(404);
    const bad = await t.browser("/api/actions/task.list", { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);

    const list = (await (await t.browser("/api/actions")).json()) as {
      actions: { name: string; input: object }[];
    };
    const create = list.actions.find((a) => a.name === "task.create");
    expect(create?.input).toMatchObject({ type: "object" });
  });
});

describe("MCP", () => {
  it("lets an outside agent read and add, under its own name", async () => {
    const { token } = await createApiToken(t.kernel.db, "claude-desktop");
    const init = await mcp(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.result).toMatchObject({ serverInfo: { name: "hearth" } });

    const tools = (await mcp(token, "tools/list")).result.tools as { name: string }[];
    const names = tools.map((x) => x.name);
    expect(names).toContain("task_create");
    expect(names).toContain("record_read");
    expect(names).not.toContain("chat_send"); // only you chat with Jarvis

    const made = await mcp(token, "tools/call", {
      name: "task_create",
      arguments: { title: "From outside" },
    });
    expect(made.result.isError).toBe(false);
    const id = (JSON.parse(made.result.content![0]!.text) as { id: string }).id;
    const read = await mcp(token, "tools/call", { name: "record_read", arguments: { id } });
    expect(read.result.content![0]!.text).toContain("From outside");
    // Records outside agents made are marked as outside content when Jarvis reads them.
    expect(read.result.content![0]!.text).toContain("mcp:claude-desktop");
    const [created] = await t.events("entity.created");
    expect(created?.actor).toBe("mcp:claude-desktop");
  });

  it("makes risky calls wait for your approval, which you give over the API", async () => {
    const { token } = await createApiToken(t.kernel.db, "helper");
    const made = await mcp(token, "tools/call", {
      name: "task_create",
      arguments: { title: "Old idea" },
    });
    const id = (JSON.parse(made.result.content![0]!.text) as { id: string }).id;
    const trash = await mcp(token, "tools/call", { name: "entity_trash", arguments: { id } });
    const text = trash.result.content![0]!.text;
    expect(text).toContain("Waiting for the owner's approval");
    const approvalId = /approval ([0-9a-f-]{36})/.exec(text)![1]!;

    const decided = await t.browser(`/api/approvals/${approvalId}`, {
      method: "POST",
      json: { decision: "approve" },
    });
    expect(decided.status).toBe(200);
    const [trashed] = await t.events("entity.deleted");
    expect(trashed?.actor).toBe("mcp:helper");
  });

  it("refuses revoked tokens and browser cookies", async () => {
    const { token } = await createApiToken(t.kernel.db, "old");
    await revokeApiTokens(t.kernel.db, "old");
    const res = await t.api("/mcp", token, {
      method: "POST",
      headers: MCP_HEADERS,
      json: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.status).toBe(401);
    // The owner's own session (dev login here) isn't an MCP client.
    const owner = await t.browser("/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      json: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(owner.status).toBe(403);
  });
});

describe("live events", () => {
  it("replays what you missed, then streams new events", async () => {
    await t.browser("/api/actions/task.create", { method: "POST", json: { title: "Before" } });
    const res = await t.browser("/api/events?after=0");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let seen = "";
    const readUntil = async (needle: string) => {
      while (!seen.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        seen += value;
      }
    };
    await readUntil('"title":"Before"');

    await t.browser("/api/actions/task.create", { method: "POST", json: { title: "After" } });
    t.server.hub.publish(await latestSeq(t.kernel.db));
    await readUntil('"title":"After"');

    expect(seen).toContain("event: ready");
    expect(seen).toMatch(/id: \d+/);
    await reader.cancel();
  });
});
