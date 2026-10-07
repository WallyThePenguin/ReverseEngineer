// Convex for data connectors (D73): a deployment's HTTP API, with plain fetch and the deploy key
// you give Hearth. Only reads go through here: queries, which Convex runs read-only whatever
// they're written to do (/api/query won't run a mutation or an action), and the tables' shapes.

export const CONVEX_SERVICE = "convex";

export interface ConvexApi {
  /** Runs one of the deployment's query functions with its args, and gives back its value. */
  query(
    address: string,
    key: string,
    path: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  /**
   * Each table's shape as a JSON schema, inferred from its documents, from the streaming export
   * (on Convex's paid plans); null where the deployment doesn't offer it.
   */
  shapes(address: string, key: string): Promise<Record<string, unknown> | null>;
}

export interface Limits {
  /** One call's time, answer included. */
  timeoutMs: number;
  /** What Convex may send back for one call before it's refused. */
  responseBytes: number;
  /** A string's length in characters before it's cut. */
  cell: number;
  /** All of a result, as JSON, before the rest is left out. */
  bytes: number;
}

export const LIMITS: Limits = {
  timeoutMs: 15_000,
  responseBytes: 4_000_000,
  cell: 2_000,
  bytes: 100_000,
};

/**
 * - refused: the key isn't accepted there (401, 403).
 * - failed: the function ran and threw, or the call was wrong; `message` is Convex's own words.
 * - unreachable: Convex couldn't be reached, took too long, or had trouble of its own.
 * - too_big: the answer was past Hearth's cap.
 */
export type ConvexErrorKind = "refused" | "failed" | "unreachable" | "too_big";

export class ConvexError extends Error {
  readonly kind: ConvexErrorKind;
  constructor(kind: ConvexErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "ConvexError";
  }
}

/** A deployment's address as Hearth calls it: https, or plain http on this PC (self-hosted). */
export function deploymentAddress(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new ConvexError("failed", "That isn't a deployment URL (https://….convex.cloud).");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    throw new ConvexError(
      "failed",
      "The deployment URL needs https://, so the key isn't sent in the clear.",
    );
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== ""))
    throw new ConvexError("failed", "Give just the deployment's URL, with nothing after its name.");
  if (u.hostname.endsWith(".convex.site"))
    throw new ConvexError(
      "failed",
      "That's the deployment's HTTP actions URL (.convex.site). Use its .convex.cloud one.",
    );
  return u.origin;
}

export interface KeyInfo {
  /** In plain words, for Settings. */
  kind: string;
  production: boolean;
  /** The deployment the key names, when it names one. */
  deployment: string | null;
}

/** What a deploy key is, from how Convex writes them ("prod:happy-otter-123|…"). */
export function describeKey(key: string): KeyInfo {
  const m = key.match(/^(prod|dev|preview):([^|]+)\|/);
  if (!m) return { kind: "admin key", production: false, deployment: null };
  const [, what, name = ""] = m;
  if (what === "prod") return { kind: "production deploy key", production: true, deployment: name };
  if (what === "dev")
    return { kind: "development deploy key", production: false, deployment: name };
  // A preview key names its team and project, not the deployment.
  return { kind: "preview deploy key", production: false, deployment: null };
}

/** The deployment an address is on Convex's cloud, by name, or null for any other address. */
export function deploymentName(address: string): string | null {
  const host = new URL(address).hostname;
  return host.endsWith(".convex.cloud") ? (host.split(".")[0] ?? null) : null;
}

type Raw = Record<string, unknown>;

/** Reads a response's body, refusing it once it's past `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const tooBig = new ConvexError(
    "too_big",
    `Convex sent back more than ${Math.round(max / 1_000_000)} MB. Ask for less.`,
  );
  if (Number(res.headers.get("content-length")) > max) {
    await res.body?.cancel().catch(() => {});
    throw tooBig;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooBig;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function httpConvex(limits: Limits = LIMITS): ConvexApi {
  const slow = `Convex took longer than ${limits.timeoutMs / 1000} seconds.`;
  /** One call with the key, its answer read under the cap. */
  async function send(url: string, key: string, body?: unknown) {
    try {
      const res = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Convex ${key}`,
          "user-agent": "Hearth",
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect elsewhere would take the key with it.
        redirect: "error",
        signal: AbortSignal.timeout(limits.timeoutMs),
      });
      return { res, text: await readCapped(res, limits.responseBytes) };
    } catch (err) {
      if (err instanceof ConvexError) throw err;
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new ConvexError("unreachable", timedOut ? slow : "Convex couldn't be reached.");
    }
  }
  return {
    async shapes(address, key) {
      try {
        const { res, text } = await send(`${address}/api/json_schemas?format=json`, key);
        const body = res.ok ? (JSON.parse(text) as unknown) : null;
        return body && typeof body === "object" && !Array.isArray(body) ? (body as Raw) : null;
      } catch {
        return null;
      }
    },
    async query(address, key, path, args) {
      const { res, text } = await send(`${address}/api/query`, key, { path, args, format: "json" });
      let body: Raw | null = null;
      try {
        body = JSON.parse(text) as Raw;
      } catch {}
      if (body?.status === "success") return body.value ?? null;
      if (body?.status === "error")
        throw new ConvexError("failed", String(body.errorMessage ?? "The function failed."));
      if (res.status === 401 || res.status === 403)
        throw new ConvexError("refused", "Convex doesn't accept this key for that deployment.");
      if (res.status === 404)
        throw new ConvexError("failed", "There's no Convex deployment at that URL.");
      if (res.status >= 500 || res.status === 429)
        throw new ConvexError("unreachable", `Convex answered ${res.status}. Try again soon.`);
      const said = typeof body?.message === "string" ? `: ${body.message}` : ".";
      throw new ConvexError("failed", `Convex answered ${res.status}${said}`);
    },
  };
}

/** One table in a FakeConvex: its documents, oldest first, and its declared shape, if any. */
interface FakeTable {
  documents: Raw[];
  schema?: unknown;
}

/** A Convex deployment in memory, for tests, with the system functions Hearth calls. */
export class FakeConvex {
  address = "https://happy-otter-123.convex.cloud";
  key = "dev:happy-otter-123|eyJ0ZXN0IjoidHJ1ZSJ9";
  tables = new Map<string, FakeTable>();
  /** What `_system/cli/modules:apiSpec` sends back, as Convex writes it. */
  functions: Raw[] = [];
  /** The deployment's own queries, by path. */
  queries = new Map<string, (args: Record<string, unknown>) => unknown>();
  /** What the streaming export sends back, on a deployment that has one. */
  exported: Record<string, unknown> | null = null;
  /** Set to have every call fail with it (Convex unreachable, say). */
  failWith: ConvexError | null = null;
  calls: { path: string; args: Record<string, unknown> }[] = [];

  api(): ConvexApi {
    return {
      query: async (address, key, path, args) => {
        this.calls.push({ path, args });
        if (this.failWith) throw this.failWith;
        if (address !== this.address)
          throw new ConvexError("failed", "There's no Convex deployment at that URL.");
        if (key !== this.key)
          throw new ConvexError("refused", "Convex doesn't accept this key for that deployment.");
        // JSON there and back, as the wire would.
        return JSON.parse(JSON.stringify(this.run(path, args) ?? null)) as unknown;
      },
      shapes: async (address, key) =>
        address === this.address && key === this.key && !this.failWith ? this.exported : null,
    };
  }

  private run(path: string, args: Record<string, unknown>): unknown {
    const page = <T>(all: T[]) => {
      const opts = args.paginationOpts as { numItems: number; cursor: string | null };
      const from = Number(opts.cursor ?? 0);
      const to = from + opts.numItems;
      return { page: all.slice(from, to), isDone: to >= all.length, continueCursor: String(to) };
    };
    if (path === "_system/cli/tables")
      return page([...this.tables.keys()].map((name) => ({ name })));
    if (path === "_system/cli/tableData") {
      const t = this.tables.get(String(args.table));
      if (!t) throw new ConvexError("failed", `Table ${String(args.table)} not found`);
      return page(args.order === "asc" ? t.documents : [...t.documents].reverse());
    }
    if (path === "_system/frontend/getSchemas") {
      const tables = [...this.tables]
        .filter(([, t]) => t.schema !== undefined)
        .map(([tableName, t]) => ({ tableName, indexes: [], documentType: t.schema }));
      return { active: tables.length ? JSON.stringify({ tables }) : undefined };
    }
    if (path === "_system/cli/modules:apiSpec") return this.functions;
    const fn = this.queries.get(path);
    if (!fn) throw new ConvexError("failed", `Could not find public function for '${path}'.`);
    return fn(args);
  }
}
