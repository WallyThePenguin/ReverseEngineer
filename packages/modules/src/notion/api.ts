// What Hearth needs from Notion's API: who the integration is, the people and task databases it
// can see, a database's columns, and its pages a hundred at a time. Read only. Pages are written
// by other people, so what comes back is outside content.

export const NOTION_SERVICE = "notion";
const VERSION = "2025-09-03";

export interface NotionPerson {
  id: string;
  name: string;
  email: string | null;
}

export interface NotionSource {
  id: string;
  title: string;
}

/** A database's columns, by name and kind; a status column also has its Complete group. */
export interface NotionSchema {
  id: string;
  title: string;
  columns: { name: string; type: string }[];
  /** Status columns' options in their Complete group, by column name. */
  complete: Record<string, string[]>;
}

export type NotionValue =
  | { type: "title"; text: string }
  | { type: "people"; ids: string[] }
  | { type: "status" | "select"; name: string | null }
  | { type: "date"; start: string | null; end: string | null }
  | { type: "checkbox"; checked: boolean }
  | { type: "other" };

export interface NotionPage {
  id: string;
  url: string;
  editedAt: Date;
  values: Record<string, NotionValue>;
}

export interface PageQuery {
  /** Only pages whose people column `column` includes `userId`. */
  person?: { column: string; userId: string };
  cursor?: string | null;
}

export interface NotionApi {
  whoami(token: string): Promise<{ botId: string; workspace: string | null }>;
  people(token: string): Promise<NotionPerson[]>;
  /** The databases the integration was added to in Notion. */
  sources(token: string): Promise<NotionSource[]>;
  schema(token: string, sourceId: string): Promise<NotionSchema>;
  pages(
    token: string,
    sourceId: string,
    q: PageQuery,
  ): Promise<{ pages: NotionPage[]; next: string | null }>;
}

/**
 * - revoked: Notion doesn't accept the token (401); polling stops until it's replaced.
 * - refused: the database isn't shared with the integration, or is gone (403, 404, 400).
 * - slow: Notion asked Hearth to slow down (429).
 * - transient: Notion couldn't be reached (status 0) or had trouble of its own (5xx).
 */
export type NotionErrorKind = "revoked" | "refused" | "slow" | "transient";

export class NotionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "NotionError";
  }
  get kind(): NotionErrorKind {
    if (this.status === 401) return "revoked";
    if (this.status === 429) return "slow";
    if (this.status === 400 || this.status === 403 || this.status === 404) return "refused";
    return "transient";
  }
}

type Raw = Record<string, unknown>;

const plain = (rich: unknown) =>
  Array.isArray(rich) ? rich.map((r) => String((r as Raw).plain_text ?? "")).join("") : "";

/** One page's column value, reduced to what Hearth reads. */
export function readValue(p: Raw): NotionValue {
  switch (p.type) {
    case "title":
      return { type: "title", text: plain(p.title) };
    case "people":
      return { type: "people", ids: ((p.people as Raw[]) ?? []).map((u) => String(u.id)) };
    case "status":
    case "select": {
      const o = p[p.type] as Raw | null;
      return { type: p.type, name: o ? String(o.name) : null };
    }
    case "date": {
      const d = p.date as Raw | null;
      return {
        type: "date",
        start: d ? String(d.start) : null,
        end: d?.end ? String(d.end) : null,
      };
    }
    case "checkbox":
      return { type: "checkbox", checked: p.checkbox === true };
    default:
      return { type: "other" };
  }
}

/** Notion allows about three requests a second; Hearth keeps its own a little under that. */
const SPACING_MS = 350;

export function httpNotion(
  base = "https://api.notion.com/v1",
  log: (line: string) => void = (line) => console.warn(`[notion] ${line}`),
): NotionApi {
  let last = 0;
  async function call(token: string, method: "GET" | "POST", path: string, body?: unknown) {
    const wait = last + SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "notion-version": VERSION,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new NotionError(0, "Notion couldn't be reached.");
    }
    if (res.status === 401) throw new NotionError(401, "Notion doesn't accept this token.");
    if (res.status === 429) throw new NotionError(429, "Notion asked Hearth to slow down.");
    if (res.status === 403 || res.status === 404)
      throw new NotionError(
        res.status,
        "Notion won't show Hearth that database. Add the Hearth integration to it in Notion (••• → Connections).",
      );
    const json = (await res.json().catch(() => null)) as Raw | null;
    // Notion's own message can quote the board's column names, which anyone who can edit it
    // chose: only its error code is kept, so a stored error holds none of their words (D58). The
    // message, which says what Notion refused, goes to the process's log, which only you read.
    if (!res.ok) {
      const code =
        typeof json?.code === "string" && /^[a-z_]{1,40}$/.test(json.code) ? json.code : null;
      const said = `Notion answered ${res.status}${code ? ` (${code})` : ""}`;
      const words = typeof json?.message === "string" ? json.message.slice(0, 500) : "";
      log(words ? `${said}: ${words}` : said);
      throw new NotionError(res.status, `${said}.`);
    }
    if (!json) throw new NotionError(502, "Notion sent back something Hearth can't read.");
    return json;
  }
  /** Every page of a list Notion pages through, up to `max` pages. */
  async function all(max: number, page: (cursor: string | null) => Promise<Raw>) {
    const out: Raw[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < max; n++) {
      const r = await page(cursor);
      out.push(...((r.results as Raw[]) ?? []));
      cursor = r.has_more ? String(r.next_cursor) : null;
      if (!cursor) break;
    }
    return out;
  }
  return {
    async whoami(token) {
      const me = await call(token, "GET", "/users/me");
      const bot = (me.bot as Raw | undefined) ?? {};
      return {
        botId: String(me.id),
        workspace: bot.workspace_name ? String(bot.workspace_name) : null,
      };
    },
    async people(token) {
      const users = await all(10, (c) =>
        call(
          token,
          "GET",
          `/users?page_size=100${c ? `&start_cursor=${encodeURIComponent(c)}` : ""}`,
        ),
      );
      return users
        .filter((u) => u.type === "person")
        .map((u) => ({
          id: String(u.id),
          name: String(u.name ?? ""),
          email: ((u.person as Raw | undefined)?.email as string | undefined) ?? null,
        }));
    },
    async sources(token) {
      const found = await all(5, (c) =>
        call(token, "POST", "/search", {
          filter: { property: "object", value: "data_source" },
          page_size: 100,
          ...(c ? { start_cursor: c } : {}),
        }),
      );
      return found.map((s) => ({ id: String(s.id), title: plain(s.title) || "Untitled" }));
    },
    async schema(token, sourceId) {
      const s = await call(token, "GET", `/data_sources/${encodeURIComponent(sourceId)}`);
      const props = Object.values((s.properties as Record<string, Raw>) ?? {});
      const complete: Record<string, string[]> = {};
      for (const p of props) {
        if (p.type !== "status") continue;
        const st = (p.status as Raw) ?? {};
        const options = new Map(
          ((st.options as Raw[]) ?? []).map((o) => [String(o.id), String(o.name)]),
        );
        const groups = (st.groups as Raw[]) ?? [];
        const done = groups.find((g) => /^complete/i.test(String(g.name))) ?? groups.at(-1);
        complete[String(p.name)] = ((done?.option_ids as string[]) ?? []).flatMap((id) => {
          const name = options.get(id);
          return name ? [name] : [];
        });
      }
      return {
        id: String(s.id),
        title: plain(s.title) || "Untitled",
        columns: props.map((p) => ({ name: String(p.name), type: String(p.type) })),
        complete,
      };
    },
    async pages(token, sourceId, q) {
      const r = await call(token, "POST", `/data_sources/${encodeURIComponent(sourceId)}/query`, {
        page_size: 100,
        // By when each was made, which an edit while Hearth reads doesn't change: sorted by the
        // last edit, a ticket edited mid-read moves past the page being read and is missed.
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        ...(q.person
          ? { filter: { property: q.person.column, people: { contains: q.person.userId } } }
          : {}),
        ...(q.cursor ? { start_cursor: q.cursor } : {}),
      });
      const pages = ((r.results as Raw[]) ?? [])
        .filter((p) => p.object === "page" && !p.in_trash && !p.archived)
        .map((p) => ({
          id: String(p.id),
          url: String(p.url ?? ""),
          editedAt: new Date(String(p.last_edited_time)),
          values: Object.fromEntries(
            Object.entries((p.properties as Record<string, Raw>) ?? {}).map(([k, v]) => [
              k,
              readValue(v),
            ]),
          ),
        }));
      return { pages, next: r.has_more ? String(r.next_cursor) : null };
    },
  };
}
