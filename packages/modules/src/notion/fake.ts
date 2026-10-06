// A Notion in memory, for tests: one workspace, its people, and databases of pages.
import {
  type NotionApi,
  NotionError,
  type NotionPage,
  type NotionPerson,
  type NotionSchema,
  type NotionValue,
} from "./api.ts";

/** A task database like the owner's Otopair board. */
export function taskBoard(id: string, title: string): NotionSchema {
  return {
    id,
    title,
    columns: [
      { name: "Project name", type: "title" },
      { name: "Assignee", type: "people" },
      { name: "Status", type: "status" },
      { name: "Priority", type: "select" },
      { name: "Start date", type: "date" },
      { name: "End date", type: "date" },
    ],
    complete: { Status: ["Done", "Reference Documents", "Depricated"] },
  };
}

export interface FakeTicket {
  id: string;
  title: string;
  assignees: string[];
  status: string | null;
  due?: string | null;
  editedAt?: Date;
}

export class FakeNotion {
  token = "ntn_test0123456789abcdefghijklmn";
  botId = "bot-1";
  workspace = "Otopair";
  people: NotionPerson[] = [
    { id: "user-me", name: "Wally", email: "wally@example.com" },
    { id: "user-sam", name: "Sam", email: "sam@example.com" },
  ];
  boards = new Map<string, { schema: NotionSchema; pages: NotionPage[] }>();
  /** Set to have every call fail with it (Notion unreachable, say). */
  failWith: NotionError | null = null;
  /** Answers as if Notion ignored the person filter, to test that Hearth checks it too. */
  ignoreFilter = false;
  /** The most it sends in one page (Notion's own is 100). */
  pageSize = 100;
  calls: string[] = [];

  board(id = "board-1", title = "Otopair") {
    const b = { schema: taskBoard(id, title), pages: [] as NotionPage[] };
    this.boards.set(id, b);
    return b;
  }

  /** Puts a ticket on a board, or changes it, as Notion's own query would show it. */
  put(boardId: string, t: FakeTicket) {
    const b = this.boards.get(boardId);
    if (!b) throw new Error(`no board ${boardId}`);
    const values: Record<string, NotionValue> = {
      "Project name": { type: "title", text: t.title },
      Assignee: { type: "people", ids: t.assignees },
      Status: { type: "status", name: t.status },
      "End date": { type: "date", start: t.due ?? null, end: null },
    };
    const page = {
      id: t.id,
      url: `https://www.notion.so/${t.id.replaceAll("-", "")}`,
      editedAt: t.editedAt ?? new Date(),
      values,
    };
    b.pages = [...b.pages.filter((p) => p.id !== t.id), page];
  }

  remove(boardId: string, id: string) {
    const b = this.boards.get(boardId);
    if (b) b.pages = b.pages.filter((p) => p.id !== id);
  }

  api(): NotionApi {
    const check = (token: string) => {
      if (this.failWith) throw this.failWith;
      if (token !== this.token) throw new NotionError(401, "Notion doesn't accept this token.");
    };
    const board = (id: string) => {
      const b = this.boards.get(id);
      if (!b) throw new NotionError(404, "Notion won't show Hearth that database.");
      return b;
    };
    return {
      whoami: async (token) => {
        this.calls.push("whoami");
        check(token);
        return { botId: this.botId, workspace: this.workspace };
      },
      people: async (token) => {
        this.calls.push("people");
        check(token);
        return this.people;
      },
      sources: async (token) => {
        this.calls.push("sources");
        check(token);
        return [...this.boards.values()].map((b) => ({ id: b.schema.id, title: b.schema.title }));
      },
      schema: async (token, id) => {
        this.calls.push(`schema ${id}`);
        check(token);
        return board(id).schema;
      },
      pages: async (token, id, q) => {
        this.calls.push(`pages ${id} ${q.cursor ?? ""}`.trim());
        check(token);
        const mine = board(id)
          .pages.filter((p) => {
            if (!q.person || this.ignoreFilter) return true;
            const v = p.values[q.person.column];
            return v?.type === "people" && v.ids.includes(q.person.userId);
          })
          .sort((a, b) => b.editedAt.getTime() - a.editedAt.getTime());
        const from = q.cursor ? Number(q.cursor) : 0;
        const next = from + this.pageSize < mine.length ? String(from + this.pageSize) : null;
        return { pages: mine.slice(from, from + this.pageSize), next };
      },
    };
  }
}
