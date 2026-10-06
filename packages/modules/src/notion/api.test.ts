// httpNotion against a local server answering the way Notion's API (2025-09-03) does.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpNotion, NotionError } from "./api.ts";

const TOKEN = "ntn_test0123456789abcdefghijklmn";
const seen: { method: string; url: string; version?: string; body: unknown }[] = [];
let server: Server;
let base: string;

const text = (s: string) => [{ type: "text", plain_text: s }];
const REPLIES: Record<string, (body: Record<string, unknown>) => [number, unknown]> = {
  "GET /v1/users/me": () => [
    200,
    { object: "user", id: "bot-1", type: "bot", bot: { workspace_name: "Otopair" } },
  ],
  "GET /v1/users?page_size=100": () => [
    200,
    {
      results: [
        {
          object: "user",
          id: "u1",
          type: "person",
          name: "Wally",
          person: { email: "w@example.com" },
        },
        { object: "user", id: "b1", type: "bot", name: "Some bot" },
      ],
      has_more: false,
    },
  ],
  "POST /v1/search": () => [
    200,
    { results: [{ object: "data_source", id: "ds-1", title: text("Otopair") }], has_more: false },
  ],
  "GET /v1/data_sources/ds-1": () => [
    200,
    {
      object: "data_source",
      id: "ds-1",
      title: text("Otopair"),
      properties: {
        "Project name": { id: "title", name: "Project name", type: "title", title: {} },
        Assignee: { id: "a", name: "Assignee", type: "people", people: {} },
        Status: {
          id: "s",
          name: "Status",
          type: "status",
          status: {
            options: [
              { id: "o1", name: "Not started" },
              { id: "o2", name: "In progress" },
              { id: "o3", name: "Done" },
              { id: "o4", name: "Depricated" },
            ],
            groups: [
              { id: "g1", name: "To-do", option_ids: ["o1"] },
              { id: "g2", name: "In progress", option_ids: ["o2"] },
              { id: "g3", name: "Complete", option_ids: ["o3", "o4"] },
            ],
          },
        },
        "End date": { id: "e", name: "End date", type: "date", date: {} },
      },
    },
  ],
  "POST /v1/data_sources/ds-1/query": (body) => [
    200,
    body.start_cursor
      ? { results: [], has_more: false }
      : {
          results: [
            {
              object: "page",
              id: "p1",
              url: "https://www.notion.so/p1",
              last_edited_time: "2026-10-06T14:00:00.000Z",
              in_trash: false,
              properties: {
                "Project name": { type: "title", title: text("Fix checkout") },
                Assignee: { type: "people", people: [{ object: "user", id: "u1" }] },
                Status: { type: "status", status: { id: "o2", name: "In progress" } },
                "End date": { type: "date", date: { start: "2026-10-10", end: null } },
              },
            },
            { object: "page", id: "gone", in_trash: true, properties: {} },
          ],
          has_more: true,
          next_cursor: "c2",
        },
  ],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({
        method: req.method!,
        url: req.url!,
        version: req.headers["notion-version"] as string,
        body,
      });
      const reply = REPLIES[`${req.method} ${req.url}`];
      const [status, json] =
        req.headers.authorization !== `Bearer ${TOKEN}`
          ? [401, { object: "error", code: "unauthorized", message: "API token is invalid." }]
          : reply
            ? reply(body)
            : [404, { object: "error", code: "object_not_found", message: "Not shared." }];
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("httpNotion", () => {
  it("reads who it is, the people, the boards, a board's Complete group and its pages", async () => {
    const api = httpNotion(base);
    expect(await api.whoami(TOKEN)).toEqual({ botId: "bot-1", workspace: "Otopair" });
    expect(await api.people(TOKEN)).toEqual([{ id: "u1", name: "Wally", email: "w@example.com" }]);
    expect(await api.sources(TOKEN)).toEqual([{ id: "ds-1", title: "Otopair" }]);
    const schema = await api.schema(TOKEN, "ds-1");
    expect(schema.complete).toEqual({ Status: ["Done", "Depricated"] });
    expect(schema.columns.map((c) => c.type)).toEqual(["title", "people", "status", "date"]);
    const r = await api.pages(TOKEN, "ds-1", { person: { column: "Assignee", userId: "u1" } });
    expect(r.next).toBe("c2");
    expect(r.pages).toEqual([
      {
        id: "p1",
        url: "https://www.notion.so/p1",
        editedAt: new Date("2026-10-06T14:00:00.000Z"),
        values: {
          "Project name": { type: "title", text: "Fix checkout" },
          Assignee: { type: "people", ids: ["u1"] },
          Status: { type: "status", name: "In progress" },
          "End date": { type: "date", start: "2026-10-10", end: null },
        },
      },
    ]);
    const query = seen.find((s) => s.url === "/v1/data_sources/ds-1/query");
    expect(query?.version).toBe("2025-09-03");
    expect(query?.body).toMatchObject({
      filter: { property: "Assignee", people: { contains: "u1" } },
    });
  });

  it("says plainly when the secret is wrong or the board isn't shared", async () => {
    const api = httpNotion(base);
    await expect(api.whoami("ntn_nope")).rejects.toMatchObject({ kind: "revoked" });
    const err = await api.schema(TOKEN, "not-shared").catch((e: NotionError) => e);
    expect(err).toBeInstanceOf(NotionError);
    expect((err as NotionError).kind).toBe("refused");
    expect((err as NotionError).message).toContain("Connections");
  });
});
