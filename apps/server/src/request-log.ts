// One log line for each request that didn't go well, so "it said not found" or "the phone got
// signed out" can be traced afterwards. Requests that worked aren't logged: the app makes a lot
// of them and they'd bury the rest.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.ts";

export interface RequestLogOptions {
  log?: (line: string) => void;
  now?: () => number;
}

/** Statuses that are part of things going right, so not worth a line. */
const QUIET = new Set([101, 304]);

/**
 * Logs method, path, status, time taken and who was calling, for any answer outside 2xx (a 304
 * from the cache aside). The query string is left out: it can carry a search or an address.
 */
export function requestLog(opts: RequestLogOptions = {}): MiddlewareHandler<AppEnv> {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const now = opts.now ?? (() => performance.now());
  return async (c, next) => {
    const start = now();
    await next();
    const status = c.res.status;
    if ((status >= 200 && status < 300) || QUIET.has(status)) return;
    const caller = c.get("caller");
    const who = caller ? caller.kind : "signed out";
    const ms = Math.round(now() - start);
    log(`[http] ${c.req.method} ${c.req.path} ${status} ${ms} ms (${who})`);
  };
}
